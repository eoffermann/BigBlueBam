import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { preflightAccess, preflightMany } from '@bigbluebam/shared/visibility-client';
import type {
  BurnEngagementCreate,
  BurnEngagementUpdate,
  BurnRevenueBasis,
  BurnStoredMetricBasis,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  burnEngagements,
  burnEngagementProjects,
  burnEngagementRollups,
  burnDeliverables,
  projectMemberships,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ProjectScopeError, ValidationFailure } from '../lib/errors.js';
import {
  assertEngagementAccess,
  canAccessEngagement,
  engagementScopePredicate,
} from '../lib/project-scope.js';
import { decodeCursor, keysetOrder, keysetPredicate, pageOf } from '../lib/pagination.js';
import { engagementLinkSpecs, upsertEntityLinks } from '../lib/entity-links.js';
import { resolveAccountGoldenId } from '../lib/braid-resolve.client.js';
import { buildMoneyBlock } from '../lib/redact-financial-fields.js';
import type { ViewerCaps } from '../lib/viewer-caps.js';
import { revenueBasisFor } from './engines/valuation.js';
import { loadSettings } from './settings.service.js';
import { env } from '../env.js';
import { isAdminViewer, type Viewer } from './types.js';

const visibilityConfig = {
  apiInternalUrl: env.BBB_API_INTERNAL_URL,
  internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
  timeoutMs: env.UPSTREAM_TIMEOUT_MS,
};

export interface ListEngagementsParams {
  cursor?: string;
  limit: number;
  status?: string;
  accountId?: string;
  chainRootId?: string;
}

export async function listEngagements(viewer: Viewer, params: ListEngagementsParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cursor = decodeCursor(params.cursor);
    const where = and(
      eq(burnEngagements.organization_id, viewer.org_id),
      // Spec 2.4 point 6: reachability through burn_engagement_projects, with NO null
      // fallback, so a zero-project chain is invisible to a plain member by construction.
      engagementScopePredicate(viewer, burnEngagements.id),
      params.status ? eq(burnEngagements.status, params.status) : undefined,
      params.accountId ? eq(burnEngagements.account_id, params.accountId) : undefined,
      params.chainRootId ? eq(burnEngagements.chain_root_id, params.chainRootId) : undefined,
      keysetPredicate(burnEngagements.created_at, burnEngagements.id, cursor),
    );
    const rows = await tx
      .select()
      .from(burnEngagements)
      .where(where)
      .orderBy(...keysetOrder(burnEngagements.created_at, burnEngagements.id))
      .limit(params.limit + 1);
    const page = pageOf(rows, params.limit);
    return { data: page.rows, next_cursor: page.next_cursor };
  });
}

/** Chain members: the root plus every amendment/restatement hanging off it. */
async function chainIds(tx: DbTx, orgId: string, chainRootId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: burnEngagements.id })
    .from(burnEngagements)
    .where(
      and(
        eq(burnEngagements.organization_id, orgId),
        eq(burnEngagements.chain_root_id, chainRootId),
      ),
    );
  return rows.map((r) => r.id);
}

export async function linkedProjectIds(
  tx: DbTx,
  orgId: string,
  engagementId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ project_id: burnEngagementProjects.project_id })
    .from(burnEngagementProjects)
    .where(
      and(
        eq(burnEngagementProjects.organization_id, orgId),
        eq(burnEngagementProjects.engagement_id, engagementId),
      ),
    );
  return rows.map((r) => r.project_id);
}

export async function loadScopedEngagement(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnEngagements)
      .where(and(eq(burnEngagements.organization_id, viewer.org_id), eq(burnEngagements.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Engagement not found');
    if (!(await canAccessEngagement(viewer, id))) {
      // 404 rather than 403 on a READ path: a 403 confirms the chain exists, which on a
      // surface whose row titles are client contract names is itself a disclosure.
      throw new NotFoundError('Engagement not found');
    }
    return row;
  });
}

/**
 * Detail plus the chain rollup, with cited records `can_access`-filtered PER READER.
 *
 * "Per reader" is the load-bearing phrase (spec 2.4 point 5). The registrant's own
 * visibility is not a proxy for anyone else's: Bin's `visibility='private'` is owner-only
 * with no org-admin bypass, so an engagement registered from a private asset must not
 * surface that asset to every project member merely because the person who registered it
 * could see it. Denied items are DROPPED and reported as a count.
 */
export async function getEngagement(viewer: Viewer, id: string) {
  const row = await loadScopedEngagement(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const projectIds = await linkedProjectIds(tx, viewer.org_id, id);
    const [rollup] = await tx
      .select()
      .from(burnEngagementRollups)
      .where(
        and(
          eq(burnEngagementRollups.organization_id, viewer.org_id),
          eq(burnEngagementRollups.chain_root_id, row.chain_root_id ?? row.id),
        ),
      )
      .limit(1);

    let binAssetId: string | null = row.bin_asset_id;
    let hiddenByPermissions = 0;
    if (binAssetId) {
      const allowed = await preflightAccess(viewer.id, 'bin.asset', binAssetId, visibilityConfig);
      if (!allowed) {
        binAssetId = null;
        hiddenByPermissions += 1;
      }
    }

    return {
      data: {
        ...row,
        bin_asset_id: binAssetId,
        project_ids: projectIds,
        rollup: rollup ?? null,
        hidden_by_permissions: hiddenByPermissions,
      },
    };
  });
}

export interface CreateEngagementResult {
  data: typeof burnEngagements.$inferSelect;
  project_ids: string[];
  braid_profile_id: string | null;
}

export async function createEngagement(
  viewer: Viewer,
  body: BurnEngagementCreate,
  askerUserId: string | null,
): Promise<CreateEngagementResult> {
  // The bin.asset preflight runs BEFORE the transaction opens: it is an outbound HTTP call,
  // and the hard rule in this build is that no lock-holding or long transaction contains
  // one. It is also the correct order semantically -- there is no point writing a row we are
  // about to reject.
  if (body.bin_asset_id) {
    const allowed = await preflightAccess(
      askerUserId ?? viewer.id,
      'bin.asset',
      body.bin_asset_id,
      visibilityConfig,
    );
    if (!allowed) {
      throw new ProjectScopeError('You do not have access to the source document for this engagement');
    }
  }

  // Braid resolution is a SOFT dependency (spec 8.5): a null here is normal and the raw
  // bond.company id is stored. It never fails the create.
  let braidProfileId: string | null = null;
  if (body.account_id && body.account_type === 'bond.company') {
    braidProfileId = await resolveAccountGoldenId({
      orgId: viewer.org_id,
      sourceType: 'bond.company',
      sourceId: body.account_id,
      askerUserId: askerUserId ?? viewer.id,
    });
  }

  return runInOrgScope(viewer.org_id, async (tx) => {
    // A non-admin may only link projects they are a member of. Without this a member could
    // link an arbitrary project id and then read the chain back through their own predicate,
    // manufacturing reachability to a chain they were never meant to see.
    await assertLinkableProjects(tx, viewer, body.project_ids);

    let amendsRoot: string | null = null;
    if (body.amends_engagement_id) {
      const [parent] = await tx
        .select({ id: burnEngagements.id, chain_root_id: burnEngagements.chain_root_id })
        .from(burnEngagements)
        .where(
          and(
            eq(burnEngagements.organization_id, viewer.org_id),
            eq(burnEngagements.id, body.amends_engagement_id),
          ),
        )
        .limit(1);
      if (!parent) throw new ValidationFailure('amends_engagement_id does not resolve to an engagement in this organization');
      amendsRoot = parent.chain_root_id ?? parent.id;
    }

    // The chain root is the row's OWN id unless it amends something. `chain_root_id` is NOT
    // NULL with no default, so the id is minted here rather than by the database: a two-step
    // insert-then-update would leave a window in which the row exists with the wrong root,
    // and every envelope, rollup and precheck query keys off chain_root_id.
    const newId = randomUUID();
    const [created] = await tx
      .insert(burnEngagements)
      .values({
        id: newId,
        chain_root_id: amendsRoot ?? newId,
        organization_id: viewer.org_id,
        title: body.title,
        engagement_kind: body.engagement_kind,
        amends_engagement_id: body.amends_engagement_id ?? null,
        supersedes_engagement_id: body.supersedes_engagement_id ?? null,
        contract_value: body.contract_value ?? null,
        contract_value_delta: body.contract_value_delta ?? null,
        currency: body.currency,
        envelope_basis: body.envelope_basis,
        period_length_days: body.period_length_days ?? null,
        budget_hours: body.budget_hours != null ? String(body.budget_hours) : null,
        bin_asset_id: body.bin_asset_id ?? null,
        account_type: body.account_type ?? null,
        account_id: body.account_id ?? null,
        braid_profile_id: braidProfileId,
        bill_client_id: body.bill_client_id ?? null,
        start_date: body.start_date ?? null,
        end_date: body.end_date ?? null,
        timezone: body.timezone,
        created_by: viewer.id,
      })
      .returning();

    if (body.project_ids.length > 0) {
      await tx
        .insert(burnEngagementProjects)
        .values(
          body.project_ids.map((pid) => ({
            organization_id: viewer.org_id,
            engagement_id: newId,
            project_id: pid,
          })),
        )
        .onConflictDoNothing();
    }

    await upsertEntityLinks(
      tx,
      viewer.org_id,
      viewer.id,
      engagementLinkSpecs({
        engagementId: newId,
        accountType: body.account_type ?? null,
        accountId: body.account_id ?? null,
        binAssetId: body.bin_asset_id ?? null,
        billClientId: body.bill_client_id ?? null,
      }),
    );

    return { data: created!, project_ids: body.project_ids, braid_profile_id: braidProfileId };
  });
}

/** A non-admin may only link projects they are a member of. */
async function assertLinkableProjects(tx: DbTx, viewer: Viewer, projectIds: string[]) {
  if (projectIds.length === 0 || isAdminViewer(viewer)) return;
  const rows = await tx
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.user_id, viewer.id),
        inArray(projectMemberships.project_id, projectIds),
      ),
    );
  const found = new Set<string>(rows.map((r) => r.project_id));
  const missing = projectIds.filter((p) => !found.has(p));
  if (missing.length > 0) {
    throw new ProjectScopeError(
      `You are not a member of every project you are linking: ${missing.join(', ')}`,
    );
  }
}

export async function updateEngagement(viewer: Viewer, id: string, patch: BurnEngagementUpdate) {
  await assertEngagementAccess(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const values: Record<string, unknown> = { ...patch, updated_at: new Date() };
    delete values.project_ids;
    if (patch.budget_hours !== undefined && patch.budget_hours !== null) {
      values.budget_hours = String(patch.budget_hours);
    }
    const [updated] = await tx
      .update(burnEngagements)
      .set(values)
      .where(and(eq(burnEngagements.organization_id, viewer.org_id), eq(burnEngagements.id, id)))
      .returning();
    if (!updated) throw new NotFoundError('Engagement not found');
    return { data: updated };
  });
}

/**
 * Delete. Refused when the row is a chain ROOT that still has live amendments (spec 6.1):
 * deleting it would orphan every amendment's `chain_root_id` and silently detach their
 * consumption from any rollup, which reads to the operator as "the money vanished".
 */
export async function deleteEngagement(viewer: Viewer, id: string) {
  await assertEngagementAccess(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(burnEngagements)
      .where(and(eq(burnEngagements.organization_id, viewer.org_id), eq(burnEngagements.id, id)))
      .limit(1);
    if (!row) throw new NotFoundError('Engagement not found');

    const isRoot = (row.chain_root_id ?? row.id) === row.id;
    if (isRoot) {
      const live = await tx
        .select({ id: burnEngagements.id })
        .from(burnEngagements)
        .where(
          and(
            eq(burnEngagements.organization_id, viewer.org_id),
            eq(burnEngagements.chain_root_id, row.id),
            ne(burnEngagements.id, row.id),
            ne(burnEngagements.status, 'superseded'),
          ),
        )
        .limit(1);
      if (live.length > 0) {
        throw new ConflictError(
          'This engagement is a chain root with live amendments. Delete or supersede the amendments first, otherwise their consumption detaches from every rollup.',
          { chain_root_id: row.id },
        );
      }
    }

    await tx
      .delete(burnEngagements)
      .where(and(eq(burnEngagements.organization_id, viewer.org_id), eq(burnEngagements.id, id)));
    return { data: { id, deleted: true } };
  });
}

export async function linkProject(viewer: Viewer, id: string, projectId: string) {
  await assertEngagementAccess(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    // Project-scoped on BOTH sides (spec 6.1): the caller must reach the engagement AND be a
    // member of the project being attached, otherwise linking is a way to widen your own
    // visibility one project at a time.
    await assertLinkableProjects(tx, viewer, [projectId]);
    await tx
      .insert(burnEngagementProjects)
      .values({ organization_id: viewer.org_id, engagement_id: id, project_id: projectId })
      .onConflictDoNothing();
    return { data: { engagement_id: id, project_id: projectId, linked: true } };
  });
}

export async function unlinkProject(viewer: Viewer, id: string, projectId: string) {
  await assertEngagementAccess(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    await assertLinkableProjects(tx, viewer, [projectId]);
    await tx
      .delete(burnEngagementProjects)
      .where(
        and(
          eq(burnEngagementProjects.organization_id, viewer.org_id),
          eq(burnEngagementProjects.engagement_id, id),
          eq(burnEngagementProjects.project_id, projectId),
        ),
      );
    return { data: { engagement_id: id, project_id: projectId, linked: false } };
  });
}

/**
 * The burn-down series with engagement AND deliverable dated step-ups (spec 6.1).
 *
 * Every money-bearing point carries a DISCRIMINATED money block built by `buildMoneyBlock`,
 * exactly like every other financial surface (spec 1.2.2). This is what stops the burn-down
 * from emitting a bare cost or a bare consumption percentage with no `metric_basis`: for a
 * non-read_all caller `buildMoneyBlock` returns the `suppressed` variant, which has no cost,
 * margin, or coverage key at all and cannot be mistaken for margin. For a read_all caller it
 * returns `true_margin` / `contract_consumption` with the figures.
 *
 * The step-ups still carry raw `contract_value*` / `envelope_amount*` magnitudes; those are
 * BURN_READ_ALL_FLOORED_KEYS, so the shared serializer strips them for a member. Spec 2.4
 * point 17 (R3-S5): the time series is the sharpest disclosure surface, since a per-day
 * per-person hour vector plus one aggregate cost scalar per day solves the cost-rate vector
 * by least squares in a handful of snapshots.
 */
export async function getBurndown(viewer: Viewer, id: string, caps: ViewerCaps) {
  const row = await loadScopedEngagement(viewer, id);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rootId = row.chain_root_id ?? row.id;
    const ids = await chainIds(tx, viewer.org_id, rootId);
    const settings = await loadSettings(tx, viewer.org_id);

    const stepUps = await tx
      .select({
        at: burnEngagements.start_date,
        kind: sql<string>`'engagement'`,
        engagement_id: burnEngagements.id,
        contract_value: burnEngagements.contract_value,
        contract_value_delta: burnEngagements.contract_value_delta,
      })
      .from(burnEngagements)
      .where(
        and(
          eq(burnEngagements.organization_id, viewer.org_id),
          eq(burnEngagements.chain_root_id, rootId),
        ),
      )
      .orderBy(asc(burnEngagements.start_date));

    const deliverableSteps = ids.length
      ? await tx
          .select({
            at: burnDeliverables.delta_confirmed_at,
            kind: sql<string>`'deliverable'`,
            deliverable_id: burnDeliverables.id,
            envelope_amount: burnDeliverables.envelope_amount,
            envelope_amount_delta: burnDeliverables.envelope_amount_delta,
          })
          .from(burnDeliverables)
          .where(
            and(
              eq(burnDeliverables.organization_id, viewer.org_id),
              inArray(burnDeliverables.engagement_id, ids),
              or(
                sql`${burnDeliverables.envelope_amount_delta} IS NOT NULL`,
                sql`${burnDeliverables.delta_confirmed_at} IS NOT NULL`,
              ),
            ),
          )
          .orderBy(asc(burnDeliverables.delta_confirmed_at))
      : [];

    const [rollup] = await tx
      .select()
      .from(burnEngagementRollups)
      .where(
        and(
          eq(burnEngagementRollups.organization_id, viewer.org_id),
          eq(burnEngagementRollups.chain_root_id, rootId),
        ),
      )
      .limit(1);

    const revenueBasis =
      (rollup?.revenue_basis as BurnRevenueBasis) ??
      revenueBasisFor(row.envelope_basis as Parameters<typeof revenueBasisFor>[0]);
    const minContributors = Number(settings.min_contributors_for_cost_aggregate ?? 3);

    // One basis-aware money block per snapshot, built the SAME way as /v1/financials so a
    // member gets `suppressed` and a read_all caller gets the figures with a discriminator.
    const moneyFor = (r: typeof rollup | undefined) => {
      const computedAt = r?.computed_at ? new Date(r.computed_at) : new Date();
      return buildMoneyBlock(
        {
          metric_basis: (r?.metric_basis as BurnStoredMetricBasis) ?? 'contract_consumption',
          revenue_basis: revenueBasis,
          currency: row.currency,
          as_of: computedAt.toISOString(),
          revenue_amount: r ? Number(r.attributed_billable ?? 0) : null,
          contract_value: r ? Number(r.contract_value ?? 0) : Number(row.contract_value ?? 0),
          attributed_billable: r ? Number(r.attributed_billable ?? 0) : null,
          attributed_cost: r ? Number(r.attributed_cost ?? 0) : null,
          margin_amount: r?.margin_amount == null ? null : Number(r.margin_amount),
          margin_pct: r?.margin_pct == null ? null : Number(r.margin_pct),
          contract_consumption_pct: r?.consumption_pct == null ? null : Number(r.consumption_pct),
          cost_rate_coverage_pct:
            r?.cost_rate_coverage_pct == null ? null : Number(r.cost_rate_coverage_pct),
          margin_state: (r?.margin_state as 'in_progress' | 'final' | null) ?? null,
          distinct_contributor_count: Number(r?.distinct_contributor_count ?? 0),
          min_contributors_for_cost_aggregate: minContributors,
        },
        caps,
      );
    };

    return {
      data: {
        chain_root_id: rootId,
        currency: row.currency,
        step_ups: [...stepUps, ...deliverableSteps],
        as_of: rollup?.computed_at ?? new Date(),
        // Chain-level basis-aware money block, so the surface as a whole carries a
        // discriminator and never a bare cost or a bare percentage.
        money: moneyFor(rollup),
        // The series itself is materialized by the rollup worker (M6). Until then the
        // endpoint returns the step-ups and the current point, which is honest about what it
        // knows rather than synthesizing a curve. Each point carries its OWN money block.
        points: rollup ? [{ at: rollup.computed_at, money: moneyFor(rollup) }] : [],
      },
    };
  });
}

/** Ids of every source record cited by a chain, for a per-reader can_access filter. */
export async function filterCitedRecords(
  askerUserId: string,
  entityType: string,
  ids: string[],
): Promise<{ visible: string[]; hidden: number }> {
  if (ids.length === 0) return { visible: [], hidden: 0 };
  const allowed = await preflightMany(askerUserId, entityType, ids, visibilityConfig);
  const visible = ids.filter((id) => allowed.has(id));
  return { visible, hidden: ids.length - visible.length };
}
