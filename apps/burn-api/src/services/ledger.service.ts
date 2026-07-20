import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { preflightMany } from '@bigbluebam/shared/visibility-client';
import type {
  BurnAttributionBulk,
  BurnAttributionCreate,
  BurnAttributionUpdate,
  BurnBulkResult,
  BurnUnscopedBucket,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  burnAttributions,
  burnDeliverables,
  burnEngagements,
  burnWorkItems,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ProjectScopeError } from '../lib/errors.js';
import { canAccessRowProject, memberProjectIds, rowProjectScopePredicate } from '../lib/project-scope.js';
import { decodeCursor, keysetOrder, keysetPredicate, pageOf } from '../lib/pagination.js';
import { attributionLinkSpec, upsertEntityLinks } from '../lib/entity-links.js';
import { loadSettings } from './settings.service.js';
import { env } from '../env.js';
import { isAdminViewer, type Viewer } from './types.js';

const visibilityConfig = {
  apiInternalUrl: env.BBB_API_INTERNAL_URL,
  internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
  timeoutMs: env.UPSTREAM_TIMEOUT_MS,
};

/**
 * ── THE ROW-LEVEL SCOPE, WHICH IS NOT CHAIN REACHABILITY ────────────────────────────
 *
 * Work items and attributions are scoped by THE ROW'S OWN project_id (spec 2.4 point 6),
 * not by whether the viewer can reach the chain. In a two-project chain, a member of the
 * low-sensitivity project A must NOT read items sourced from project B. Chain reachability
 * would grant exactly that, and the Gilligan seed exercises the case deliberately.
 *
 * Both list paths below therefore resolve the viewer's OWN project ids and filter on
 * burn_work_items.project_id. There is no null fallback.
 */
async function scopeContext(viewer: Viewer) {
  if (isAdminViewer(viewer)) return { memberProjects: [] as string[], admin: true };
  return { memberProjects: await memberProjectIds(viewer.id), admin: false };
}

export interface ListWorkItemsParams {
  cursor?: string;
  limit: number;
  attributionState?: string;
  projectId?: string;
  sourceType?: string;
}

export async function listWorkItems(viewer: Viewer, params: ListWorkItemsParams) {
  const { memberProjects, admin } = await scopeContext(viewer);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cursor = decodeCursor(params.cursor);
    const rows = await tx
      .select()
      .from(burnWorkItems)
      .where(
        and(
          eq(burnWorkItems.organization_id, viewer.org_id),
          admin ? undefined : rowProjectScopePredicate(viewer, burnWorkItems.project_id, memberProjects),
          params.attributionState
            ? eq(burnWorkItems.attribution_state, params.attributionState)
            : undefined,
          params.projectId ? eq(burnWorkItems.project_id, params.projectId) : undefined,
          params.sourceType ? eq(burnWorkItems.source_type, params.sourceType) : undefined,
          keysetPredicate(burnWorkItems.created_at, burnWorkItems.id, cursor),
        ),
      )
      .orderBy(...keysetOrder(burnWorkItems.created_at, burnWorkItems.id))
      .limit(params.limit + 1);
    const page = pageOf(rows, params.limit);
    return { data: page.rows, next_cursor: page.next_cursor };
  });
}

/* ------------------------------------------------------------------ */
/*  The unscoped queue: THREE buckets, never summed                   */
/* ------------------------------------------------------------------ */

/**
 * The three buckets (spec 2.3.8) answer three different questions and are NEVER merged in
 * any query, response, or screen:
 *
 *   sold_by_nobody     work inside a tracked contract that no deliverable covers -- the
 *                      headline "we did work nobody sold" figure;
 *   unclassified       work the classifier could not place, which may or may not be sold;
 *   outside_contract   work on a project with no active engagement at all.
 *
 * Summing them produces a number that means nothing, and an operator who sees one total
 * cannot tell "we over-delivered on a signed SOW" from "we have not registered the SOW yet",
 * which are opposite problems with opposite remedies.
 */
function bucketOf(row: {
  unscoped_reason: string | null;
  engagement_id: string | null;
}): BurnUnscopedBucket {
  if (row.unscoped_reason === 'no_active_engagement') return 'outside_contract';
  if (row.unscoped_reason === 'no_matching_deliverable' && row.engagement_id) return 'sold_by_nobody';
  return 'unclassified';
}

export async function listUnscoped(
  viewer: Viewer,
  params: { cursor?: string; limit: number; bucket?: BurnUnscopedBucket },
) {
  const { memberProjects, admin } = await scopeContext(viewer);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select({
        attribution: burnAttributions,
        work_item: burnWorkItems,
      })
      .from(burnAttributions)
      .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
      .where(
        and(
          eq(burnAttributions.organization_id, viewer.org_id),
          eq(burnAttributions.state, 'unscoped'),
          isNull(burnAttributions.superseded_at),
          admin
            ? undefined
            : rowProjectScopePredicate(viewer, burnWorkItems.project_id, memberProjects),
        ),
      )
      .orderBy(sql`${burnAttributions.created_at} DESC`)
      .limit(params.limit + 1);

    const withBuckets = rows.map((r) => ({
      ...r.attribution,
      bucket: bucketOf({
        unscoped_reason: r.attribution.unscoped_reason,
        engagement_id: r.attribution.engagement_id,
      }),
      work_item: r.work_item,
    }));
    const filtered = params.bucket
      ? withBuckets.filter((r) => r.bucket === params.bucket)
      : withBuckets;

    // can_access per cited SOURCE record, PER READER, with a hidden count (spec 2.4 point 4).
    // A work item cites a bam.task / bam.time_entry / bill.expense the reader may not be
    // entitled to see even though they are in the project; denied items are DROPPED, and the
    // count is reported rather than silently swallowed, because "3 hidden by permissions" is
    // an answer and a short list with no explanation is a bug report.
    //
    // This is a MEMBER disclosure control. An org admin / owner (the `admin` branch, which
    // also skips project scoping above) is entitled to every cited record in the org, so the
    // per-record preflight is bypassed for them - otherwise a source type can_access cannot
    // resolve would fail-closed even the owner's own queue. Members get the fail-closed filter.
    const visible = admin
      ? { rows: filtered, hidden: 0 }
      : await filterCitedSources(viewer.id, filtered);

    const page = visible.rows.slice(0, params.limit);
    return {
      data: page,
      next_cursor: null,
      hidden_by_permissions: visible.hidden,
    };
  });
}

/**
 * Work-item source types that map onto a REGISTERED can_access visibility entity type
 * (apps/api/src/services/visibility.service.ts SUPPORTED_ENTITY_TYPES). Burn cites five
 * source types; the two that are registered map 1:1 and can be preflighted per reader.
 *
 * `bam.time_entry`, `bill.expense` and `bill.invoice_line` are NOT in
 * SUPPORTED_ENTITY_TYPES, and their ids are not resolvable by can_access (a time-entry id is
 * not a task id, an expense id is not an invoice id), so there is no meaningful preflight for
 * them. Per the per-reader / hidden-count contract (spec 2.4 point 4) an un-preflightable
 * cited record must NEVER be surfaced to a member, so a row whose source type is absent here
 * FAILS CLOSED for a member: it is dropped and counted in `hidden_by_permissions`, exactly
 * like a record the reader was explicitly denied. (Admins bypass this filter entirely at the
 * call site, so this only ever drops member-visible rows.)
 */
const CITED_ENTITY_TYPES: Record<string, string> = {
  'bam.task': 'bam.task',
  'helpdesk.ticket': 'helpdesk.ticket',
};

async function filterCitedSources<T extends { work_item: { source_type: string; source_id: string } }>(
  askerUserId: string,
  rows: T[],
): Promise<{ rows: T[]; hidden: number }> {
  if (rows.length === 0) return { rows, hidden: 0 };
  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const entityType = CITED_ENTITY_TYPES[r.work_item.source_type];
    // A source type with no registered visibility entity type cannot be preflighted. It is
    // NOT batched here and, below, is dropped rather than kept: showing an un-preflighted
    // cited record to a member is the exact hole this filter closes.
    if (!entityType) continue;
    const list = byType.get(entityType) ?? [];
    list.push(r.work_item.source_id);
    byType.set(entityType, list);
  }

  const allowedByType = new Map<string, Set<string>>();
  for (const [entityType, ids] of byType) {
    allowedByType.set(entityType, await preflightMany(askerUserId, entityType, ids, visibilityConfig));
  }
  const kept = rows.filter((r) => {
    const entityType = CITED_ENTITY_TYPES[r.work_item.source_type];
    // Fail closed: an unmapped (un-preflightable) cited source is never kept for a member.
    if (!entityType) return false;
    return allowedByType.get(entityType)?.has(r.work_item.source_id) ?? false;
  });
  return { rows: kept, hidden: rows.length - kept.length };
}

/**
 * Queue health. Three bucket figures, pending_review, awaiting valuation, inflow vs
 * resolution, oldest age -- and the sentence that makes it honest.
 */
export async function queueHealth(viewer: Viewer) {
  const { memberProjects, admin } = await scopeContext(viewer);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await loadSettings(tx, viewer.org_id);
    const scope = admin
      ? undefined
      : rowProjectScopePredicate(viewer, burnWorkItems.project_id, memberProjects);

    const rows = await tx
      .select({
        state: burnAttributions.state,
        unscoped_reason: burnAttributions.unscoped_reason,
        engagement_id: burnAttributions.engagement_id,
        billable_amount: burnWorkItems.billable_amount,
        created_at: burnAttributions.created_at,
      })
      .from(burnAttributions)
      .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
      .where(
        and(
          eq(burnAttributions.organization_id, viewer.org_id),
          isNull(burnAttributions.superseded_at),
          scope,
        ),
      );

    let soldByNobody = 0;
    let unclassified = 0;
    let outsideContract = 0;
    let pendingReviewAmount = 0;
    let pendingReviewCount = 0;
    let oldest: Date | null = null;

    for (const r of rows) {
      const amount = Number(r.billable_amount ?? 0) || 0;
      if (r.state === 'unscoped') {
        const bucket = bucketOf(r);
        if (bucket === 'sold_by_nobody') soldByNobody += amount;
        else if (bucket === 'outside_contract') outsideContract += amount;
        else unclassified += amount;
        const at = new Date(r.created_at);
        if (!oldest || at < oldest) oldest = at;
      }
      if (r.state === 'pending_review') {
        pendingReviewAmount += amount;
        pendingReviewCount += 1;
      }
    }

    const [awaiting] = await tx
      .select({ n: count(), total: sql<string | null>`coalesce(sum(${burnWorkItems.billable_amount}), 0)` })
      .from(burnWorkItems)
      .where(
        and(
          eq(burnWorkItems.organization_id, viewer.org_id),
          eq(burnWorkItems.valuation_basis, 'unrated'),
          scope,
        ),
      );

    return {
      data: {
        // The three figures are three separate keys. There is deliberately no `total`.
        unscoped_sold_by_nobody: soldByNobody,
        unscoped_unclassified: unclassified,
        unscoped_outside_contract: outsideContract,
        pending_review_amount: pendingReviewAmount,
        pending_review_count: pendingReviewCount,
        awaiting_valuation_amount: Number(awaiting?.total ?? 0) || 0,
        awaiting_valuation_count: Number(awaiting?.n ?? 0) || 0,
        oldest_unscoped_at: oldest,
        unscoped_alert_floor: settings.unscoped_alert_floor,
        // The statement spec 6.1 requires this surface to carry. It is the difference
        // between a queue that looks like housekeeping and a queue that looks like money.
        statement:
          'These dollars are not in any envelope. Until each item is attributed to a deliverable or marked non-billable, no engagement rollup includes it and no gate verdict enforces against it.',
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Attributions                                                      */
/* ------------------------------------------------------------------ */

export async function listAttributions(
  viewer: Viewer,
  params: { cursor?: string; limit: number; state?: string; deliverableId?: string },
) {
  const { memberProjects, admin } = await scopeContext(viewer);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cursor = decodeCursor(params.cursor);
    const rows = await tx
      .select({ attribution: burnAttributions, work_item: burnWorkItems })
      .from(burnAttributions)
      .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
      .where(
        and(
          eq(burnAttributions.organization_id, viewer.org_id),
          params.state ? eq(burnAttributions.state, params.state) : undefined,
          params.deliverableId ? eq(burnAttributions.deliverable_id, params.deliverableId) : undefined,
          admin
            ? undefined
            : rowProjectScopePredicate(viewer, burnWorkItems.project_id, memberProjects),
          keysetPredicate(burnAttributions.created_at, burnAttributions.id, cursor),
        ),
      )
      .orderBy(...keysetOrder(burnAttributions.created_at, burnAttributions.id))
      .limit(params.limit + 1);

    const flat = rows.map((r) => ({ ...r.attribution, work_item: r.work_item }));
    const page = pageOf(flat, params.limit);
    return { data: page.rows, next_cursor: page.next_cursor };
  });
}

export async function createAttribution(viewer: Viewer, body: BurnAttributionCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [workItem] = await tx
      .select()
      .from(burnWorkItems)
      .where(
        and(
          eq(burnWorkItems.organization_id, viewer.org_id),
          eq(burnWorkItems.id, body.work_item_id),
        ),
      )
      .limit(1);
    if (!workItem) throw new NotFoundError('Work item not found');
    if (!(await canAccessRowProject(viewer, workItem.project_id))) throw new ProjectScopeError();

    let engagementId: string | null = null;
    let chainRootId: string | null = null;
    if (body.deliverable_id) {
      const [deliverable] = await tx
        .select({
          id: burnDeliverables.id,
          engagement_id: burnDeliverables.engagement_id,
          chain_root_id: burnEngagements.chain_root_id,
        })
        .from(burnDeliverables)
        .innerJoin(burnEngagements, eq(burnEngagements.id, burnDeliverables.engagement_id))
        .where(
          and(
            eq(burnDeliverables.organization_id, viewer.org_id),
            eq(burnDeliverables.id, body.deliverable_id),
          ),
        )
        .limit(1);
      if (!deliverable) throw new NotFoundError('Deliverable not found');
      engagementId = deliverable.engagement_id;
      chainRootId = deliverable.chain_root_id ?? deliverable.engagement_id;
    }

    const [created] = await tx
      .insert(burnAttributions)
      .values({
        organization_id: viewer.org_id,
        work_item_id: body.work_item_id,
        deliverable_id: body.deliverable_id,
        engagement_id: engagementId,
        chain_root_id: chainRootId,
        state: body.state,
        non_billable_reason: body.non_billable_reason ?? null,
        rationale: body.rationale ?? null,
        method: 'human',
        confidence: '1',
        decided_by: viewer.id,
        decided_at: new Date(),
      })
      .returning();

    await tx
      .update(burnWorkItems)
      .set({ attribution_state: mapWorkItemState(body.state), updated_at: new Date() })
      .where(eq(burnWorkItems.id, body.work_item_id));

    // entity_links on a CONFIRMED attribution (spec 8.4).
    if (body.state === 'confirmed' && body.deliverable_id) {
      await upsertEntityLinks(tx, viewer.org_id, viewer.id, [
        attributionLinkSpec({
          deliverableId: body.deliverable_id,
          sourceType: workItem.source_type,
          sourceId: workItem.source_id,
        }),
      ]);
    }

    return { data: created, work_item: workItem };
  });
}

function mapWorkItemState(state: string): string {
  switch (state) {
    case 'confirmed':
    case 'auto_attributed':
      return 'attributed';
    case 'unscoped':
      return 'unscoped';
    case 'pending_review':
      return 'pending_review';
    case 'excluded_non_billable':
      return 'excluded_non_billable';
    case 'rejected':
      return 'excluded';
    default:
      return 'pending';
  }
}

/**
 * Confirm / reclassify / unscope / mark non-billable.
 *
 * SUPERSEDE-THEN-INSERT under FOR UPDATE, never UPDATE in place. The attribution history is
 * the audit trail for where money was booked; overwriting the previous decision destroys the
 * record of what the system thought before a human corrected it, which is the input the
 * calibration sample is built from.
 *
 * A stale `updated_at` returns 409 WITH THE CURRENT STATE so a concurrent triage can
 * re-render without a second round trip.
 */
export async function updateAttribution(viewer: Viewer, id: string, patch: BurnAttributionUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [current] = await tx
      .select({ attribution: burnAttributions, work_item: burnWorkItems })
      .from(burnAttributions)
      .innerJoin(burnWorkItems, eq(burnWorkItems.id, burnAttributions.work_item_id))
      .where(and(eq(burnAttributions.organization_id, viewer.org_id), eq(burnAttributions.id, id)))
      .limit(1)
      .for('update');
    if (!current) throw new NotFoundError('Attribution not found');
    if (!(await canAccessRowProject(viewer, current.work_item.project_id))) {
      throw new ProjectScopeError();
    }
    if (current.attribution.superseded_at) {
      throw new ConflictError('This attribution has already been superseded', current.attribution);
    }
    if (patch.updated_at) {
      const seen = new Date(patch.updated_at).getTime();
      const actual = new Date(current.attribution.created_at).getTime();
      if (Number.isFinite(seen) && seen < actual) {
        throw new ConflictError(
          'This attribution changed since you loaded it',
          current.attribution,
        );
      }
    }

    let engagementId = current.attribution.engagement_id;
    let chainRootId = current.attribution.chain_root_id;
    if (patch.deliverable_id) {
      const [deliverable] = await tx
        .select({
          engagement_id: burnDeliverables.engagement_id,
          chain_root_id: burnEngagements.chain_root_id,
        })
        .from(burnDeliverables)
        .innerJoin(burnEngagements, eq(burnEngagements.id, burnDeliverables.engagement_id))
        .where(
          and(
            eq(burnDeliverables.organization_id, viewer.org_id),
            eq(burnDeliverables.id, patch.deliverable_id),
          ),
        )
        .limit(1);
      if (!deliverable) throw new NotFoundError('Deliverable not found');
      engagementId = deliverable.engagement_id;
      chainRootId = deliverable.chain_root_id ?? deliverable.engagement_id;
    }

    const [inserted] = await tx
      .insert(burnAttributions)
      .values({
        organization_id: viewer.org_id,
        work_item_id: current.attribution.work_item_id,
        deliverable_id:
          patch.deliverable_id !== undefined ? patch.deliverable_id : current.attribution.deliverable_id,
        engagement_id: engagementId,
        chain_root_id: chainRootId,
        state: patch.state ?? current.attribution.state,
        unscoped_reason: patch.unscoped_reason ?? null,
        non_billable_reason: patch.non_billable_reason ?? null,
        rationale: patch.rationale ?? current.attribution.rationale,
        method: 'human',
        confidence: '1',
        decided_by: viewer.id,
        decided_at: new Date(),
      })
      .returning();

    await tx
      .update(burnAttributions)
      .set({ superseded_at: new Date(), superseded_by: inserted!.id })
      .where(eq(burnAttributions.id, id));

    await tx
      .update(burnWorkItems)
      .set({
        attribution_state: mapWorkItemState(inserted!.state),
        updated_at: new Date(),
      })
      .where(eq(burnWorkItems.id, current.attribution.work_item_id));

    if (inserted!.state === 'confirmed' && inserted!.deliverable_id) {
      await upsertEntityLinks(tx, viewer.org_id, viewer.id, [
        attributionLinkSpec({
          deliverableId: inserted!.deliverable_id,
          sourceType: current.work_item.source_type,
          sourceId: current.work_item.source_id,
        }),
      ]);
    }

    return { data: inserted!, superseded_id: id, work_item: current.work_item };
  });
}

/**
 * Cluster action, capped at 200, returning `{ applied, conflicted, failed }` PER ITEM.
 *
 * Per-item results rather than an all-or-nothing transaction: a bulk triage over a cluster
 * of 80 items where two were concurrently edited must apply the 78 and report the 2, not
 * roll back the operator's whole afternoon.
 */
export async function bulkUpdateAttributions(
  viewer: Viewer,
  body: BurnAttributionBulk,
): Promise<{ data: BurnBulkResult }> {
  const items: BurnBulkResult['items'] = [];
  let applied = 0;
  let conflicted = 0;
  let failed = 0;

  for (const id of body.attribution_ids) {
    try {
      await updateAttribution(viewer, id, body.action);
      items.push({ id, status: 'applied' });
      applied += 1;
    } catch (err) {
      if (err instanceof ConflictError) {
        items.push({ id, status: 'conflicted', message: err.message });
        conflicted += 1;
      } else {
        items.push({ id, status: 'failed', message: (err as Error).message });
        failed += 1;
      }
    }
  }
  return { data: { applied, conflicted, failed, items } };
}

/** Projects linked to a chain, for the realtime fan-out. */
export async function projectsForChain(
  tx: DbTx,
  orgId: string,
  chainRootId: string | null,
): Promise<string[]> {
  if (!chainRootId) return [];
  const rows = await tx.execute(
    sql`SELECT DISTINCT ep.project_id FROM burn_engagement_projects ep
        JOIN burn_engagements e ON e.id = ep.engagement_id
        WHERE ep.organization_id = ${orgId} AND e.chain_root_id = ${chainRootId}`,
  );
  return (rows as unknown as { project_id: string }[]).map((r) => r.project_id);
}
