import { and, eq, inArray, sql } from 'drizzle-orm';
import { preflightMany } from '@bigbluebam/shared/visibility-client';
import type { BurnBulkConfirmUnpriced, BurnConfirmEnvelope, BurnDeliverableUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { burnDeliverables, burnEngagements, agentProposals } from '../db/schema/index.js';
import { NotFoundError, ProjectScopeError, ValidationFailure } from '../lib/errors.js';
import { canAccessEngagement, engagementScopePredicate } from '../lib/project-scope.js';
import { decodeCursor, keysetOrder, keysetPredicate, pageOf } from '../lib/pagination.js';
import { env } from '../env.js';
import { isAdminViewer, type Viewer } from './types.js';

const visibilityConfig = {
  apiInternalUrl: env.BBB_API_INTERNAL_URL,
  internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
  timeoutMs: env.UPSTREAM_TIMEOUT_MS,
};

export interface ListDeliverablesParams {
  cursor?: string;
  limit: number;
  engagementId?: string;
  reviewStatus?: string;
  lifecycleStatus?: string;
  q?: string;
}

/**
 * THE SEARCH ORACLE DEFENSE. Spec 2.4 point 5, round-3 blocker R3-S4.
 *
 * `description` and `cited_span->>'quote'` are floored to burn.financials.read_all in the
 * RESPONSE. But both are inside the GIN-indexed generated `search_tsv` column on a table
 * members can list with the suite's standard ?filter[field]=value convention.
 *
 * The obvious implementation -- a `filter[q]` that runs against `search_tsv`, which both the
 * FTS index and 2.3.4's lexical retrieval actively invite -- would let a member confirm the
 * presence of ANY term in the floored clause text one probe at a time. Twenty probes
 * reconstruct a rate schedule. Forty reconstruct an exclusivity clause. The member never
 * reads a floored field, so every field-level test still passes, and the disclosure is total.
 *
 * A FLOORED FIELD THAT STAYS SEARCHABLE IS NOT FLOORED.
 *
 * Therefore, for a caller without read_all, `q` matches `title` ONLY, through the separate
 * trigram index. `search_tsv` is reserved for internal candidate assembly and for read_all
 * callers. No member-reachable endpoint may filter, sort, rank, or highlight on `search_tsv`
 * or on any read_all-floored column, and there is a negative test for exactly this.
 */
function searchPredicate(q: string, canReadAll: boolean) {
  if (!canReadAll) {
    // Trigram over the member-visible handle. Nothing else.
    return sql`${burnDeliverables.title} ILIKE ${'%' + q + '%'}`;
  }
  return sql`(${burnDeliverables.search_tsv} @@ plainto_tsquery('english', ${q}) OR ${burnDeliverables.title} ILIKE ${'%' + q + '%'})`;
}

export async function listDeliverables(
  viewer: Viewer,
  params: ListDeliverablesParams,
  canReadAll: boolean,
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cursor = decodeCursor(params.cursor);
    const where = and(
      eq(burnDeliverables.organization_id, viewer.org_id),
      engagementScopePredicate(viewer, burnDeliverables.engagement_id),
      params.engagementId ? eq(burnDeliverables.engagement_id, params.engagementId) : undefined,
      params.reviewStatus ? eq(burnDeliverables.review_status, params.reviewStatus) : undefined,
      params.lifecycleStatus
        ? eq(burnDeliverables.lifecycle_status, params.lifecycleStatus)
        : undefined,
      params.q ? searchPredicate(params.q, canReadAll) : undefined,
      keysetPredicate(burnDeliverables.created_at, burnDeliverables.id, cursor),
    );
    const rows = await tx
      .select()
      .from(burnDeliverables)
      .where(where)
      .orderBy(...keysetOrder(burnDeliverables.created_at, burnDeliverables.id))
      .limit(params.limit + 1);
    const page = pageOf(rows, params.limit);

    // Re-preflight the SOURCE ASSET PER READER (spec 2.4 point 5). A deliverable extracted
    // from a Bin asset the READER cannot open is dropped with a hidden count, even though
    // the registrant could open it. Bin's visibility='private' is owner-only with no
    // org-admin bypass, so the registrant's access is not a proxy for anyone else's.
    const filtered = await filterByAssetVisibility(tx, viewer, page.rows);

    return {
      data: filtered.rows,
      next_cursor: page.next_cursor,
      hidden_by_permissions: filtered.hidden,
    };
  });
}

async function filterByAssetVisibility<T extends { engagement_id: string }>(
  tx: DbTx,
  viewer: Viewer,
  rows: T[],
): Promise<{ rows: T[]; hidden: number }> {
  if (rows.length === 0) return { rows, hidden: 0 };
  const engagementIds = [...new Set(rows.map((r) => r.engagement_id))];
  const parents = await tx
    .select({ id: burnEngagements.id, bin_asset_id: burnEngagements.bin_asset_id })
    .from(burnEngagements)
    .where(
      and(
        eq(burnEngagements.organization_id, viewer.org_id),
        inArray(burnEngagements.id, engagementIds),
      ),
    );
  const assetByEngagement = new Map(parents.map((p) => [p.id, p.bin_asset_id]));
  const assetIds = [...new Set(parents.map((p) => p.bin_asset_id).filter((a): a is string => !!a))];
  if (assetIds.length === 0) return { rows, hidden: 0 };

  const allowed = await preflightMany(viewer.id, 'bin.asset', assetIds, visibilityConfig);
  const kept = rows.filter((r) => {
    const asset = assetByEngagement.get(r.engagement_id);
    // A deliverable whose engagement cites NO asset is not gated by this rule: there is
    // nothing to be denied access to.
    return !asset || allowed.has(asset);
  });
  return { rows: kept, hidden: rows.length - kept.length };
}

export async function getDeliverable(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnDeliverables)
      .where(and(eq(burnDeliverables.organization_id, viewer.org_id), eq(burnDeliverables.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Deliverable not found');
    if (!(await canAccessEngagement(viewer, row.engagement_id))) {
      throw new NotFoundError('Deliverable not found');
    }
    const filtered = await filterByAssetVisibility(tx, viewer, [row]);
    if (filtered.rows.length === 0) throw new NotFoundError('Deliverable not found');
    return { data: filtered.rows[0] };
  });
}

/**
 * PATCH: content, review_status, lifecycle_status. NOTHING ELSE.
 *
 * `envelope_amount` and `is_active` are structurally unreachable here: the Zod schema is
 * `.strict()` and carries neither key, so an attempt to smuggle one is a 400 rather than a
 * silent no-op. `is_active` is written by EXACTLY ONE code path in the whole application
 * (confirmEnvelope below), which is the invariant spec 2.2.1 rests on and which the test
 * suite asserts by counting the write sites.
 */
export async function updateDeliverable(viewer: Viewer, id: string, patch: BurnDeliverableUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnDeliverables)
      .where(and(eq(burnDeliverables.organization_id, viewer.org_id), eq(burnDeliverables.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Deliverable not found');
    if (!(await canAccessEngagement(viewer, row.engagement_id))) throw new ProjectScopeError();

    const values: Record<string, unknown> = { ...patch, updated_at: new Date() };
    if (patch.review_status) {
      values.reviewed_by = viewer.id;
      values.reviewed_at = new Date();
    }
    const [updated] = await tx
      .update(burnDeliverables)
      .set(values)
      .where(and(eq(burnDeliverables.organization_id, viewer.org_id), eq(burnDeliverables.id, id)))
      .returning();
    return { data: updated };
  });
}

export interface ConfirmEnvelopeResult {
  data: unknown;
  proposal_id?: string;
  mode: 'applied' | 'proposed';
}

/**
 * POST /v1/deliverables/:id/confirm-envelope. The ONLY writer of `is_active`.
 *
 * Spec 2.2.1: envelope confirmation is NOT agent-reachable. A service-account caller does
 * not get a 403 -- it gets an `agent_proposals` row, and `is_active` flips only when a human
 * decides that proposal. That distinction matters: a 403 teaches an agent to stop trying,
 * whereas a proposal routes the intent to a person who can actually approve it, which is the
 * behavior the platform's HITL queue exists for.
 *
 * `isServiceAccount` is derived from the API key prefix, not from a claim in the body.
 */
export async function confirmEnvelope(
  viewer: Viewer,
  id: string,
  body: BurnConfirmEnvelope,
  isServiceAccount: boolean,
): Promise<ConfirmEnvelopeResult> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnDeliverables)
      .where(and(eq(burnDeliverables.organization_id, viewer.org_id), eq(burnDeliverables.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Deliverable not found');
    if (!(await canAccessEngagement(viewer, row.engagement_id))) throw new ProjectScopeError();

    if (isServiceAccount) {
      const expires = new Date(Date.now() + 7 * 86_400_000);
      const [proposal] = await tx
        .insert(agentProposals)
        .values({
          org_id: viewer.org_id,
          actor_id: viewer.id,
          proposer_kind: 'service',
          proposed_action: 'burn.envelope.confirm',
          // Refs and a magnitude the approver needs to decide, and nothing else. No clause
          // text, no client name (spec 12.1's proposal-payload assertion).
          proposed_payload: {
            deliverable_id: id,
            envelope_amount: body.envelope_amount,
            envelope_hours: body.envelope_hours ?? null,
            envelope_source: body.envelope_source,
          },
          subject_type: 'burn.deliverable',
          subject_id: id,
          expires_at: expires,
        })
        .returning();
      return { data: row, proposal_id: proposal!.id, mode: 'proposed' };
    }

    const [updated] = await tx
      .update(burnDeliverables)
      .set({
        envelope_amount: body.envelope_amount,
        envelope_hours: body.envelope_hours != null ? String(body.envelope_hours) : null,
        envelope_source: body.envelope_source,
        is_active: true,
        envelope_confirmed_by: viewer.id,
        envelope_confirmed_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(burnDeliverables.organization_id, viewer.org_id), eq(burnDeliverables.id, id)))
      .returning();
    return { data: updated, mode: 'applied' };
  });
}

/**
 * The bulk fast path: confirm N deliverables as UNPRICED (spec 2.2.2).
 *
 * NEVER an even split. An even split invents a number the contract does not contain and then
 * DENIES CHARGES AGAINST IT -- the gate would be enforcing a figure no human ever agreed to,
 * on a document that says nothing of the kind. `envelope_amount` stays null; those
 * deliverables return `allow_with_note/envelope_unpriced` from the gate forever, and they are
 * excluded from `envelope_overrun` and `consumption_erosion`. That is the honest behavior:
 * the org has confirmed the deliverable EXISTS without claiming to know its price.
 */
export async function bulkConfirmUnpriced(
  viewer: Viewer,
  body: BurnBulkConfirmUnpriced,
  isServiceAccount: boolean,
) {
  if (isServiceAccount) {
    throw new ProjectScopeError(
      'Envelope confirmation is not agent-reachable. Use the single-deliverable route, which routes a service-account caller through the approval queue.',
    );
  }
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select({ id: burnDeliverables.id, engagement_id: burnDeliverables.engagement_id })
      .from(burnDeliverables)
      .where(
        and(
          eq(burnDeliverables.organization_id, viewer.org_id),
          inArray(burnDeliverables.id, body.deliverable_ids),
        ),
      );
    if (rows.length === 0) throw new NotFoundError('No deliverables matched');

    if (!isAdminViewer(viewer)) {
      for (const engagementId of new Set(rows.map((r) => r.engagement_id))) {
        if (!(await canAccessEngagement(viewer, engagementId))) throw new ProjectScopeError();
      }
    }

    const updated = await tx
      .update(burnDeliverables)
      .set({
        envelope_amount: null,
        envelope_source: 'unpriced',
        is_active: true,
        envelope_confirmed_by: viewer.id,
        envelope_confirmed_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(burnDeliverables.organization_id, viewer.org_id),
          inArray(
            burnDeliverables.id,
            rows.map((r) => r.id),
          ),
        ),
      )
      .returning({ id: burnDeliverables.id });

    return { data: { confirmed: updated.length, deliverable_ids: updated.map((u) => u.id) } };
  });
}

/** Active, confirmed, priced-or-unpriced deliverables on a chain. The gate's candidate set. */
export async function activeDeliverablesForChain(
  tx: DbTx,
  orgId: string,
  chainRootId: string,
): Promise<(typeof burnDeliverables.$inferSelect)[]> {
  return tx
    .select()
    .from(burnDeliverables)
    .innerJoin(burnEngagements, eq(burnEngagements.id, burnDeliverables.engagement_id))
    .where(
      and(
        eq(burnDeliverables.organization_id, orgId),
        eq(burnEngagements.chain_root_id, chainRootId),
        eq(burnDeliverables.is_active, true),
        eq(burnDeliverables.review_status, 'confirmed'),
        // An amendment deliverable never appears in a candidate set (spec 12.1): post-
        // amendment work attributes to the BASE row, and the amendment carries only a delta.
        sql`${burnDeliverables.amends_deliverable_id} IS NULL`,
      ),
    )
    .then((rows) => rows.map((r) => (r as Record<string, unknown>).burn_deliverables as typeof burnDeliverables.$inferSelect));
}

export function assertNoEnvelopeKeys(body: unknown) {
  const keys = Object.keys((body ?? {}) as Record<string, unknown>);
  const forbidden = keys.filter((k) => k === 'envelope_amount' || k === 'is_active');
  if (forbidden.length > 0) {
    throw new ValidationFailure(
      `PATCH /v1/deliverables/:id cannot set ${forbidden.join(', ')}. The envelope is set only by POST /v1/deliverables/:id/confirm-envelope under burn.envelope.confirm.`,
      'ENVELOPE_NOT_PATCHABLE',
    );
  }
}
