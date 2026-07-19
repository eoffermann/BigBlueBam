import { and, eq, sql } from 'drizzle-orm';
import type { BurnCostRateCreate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { burnCostRates } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import type { Viewer } from './types.js';

/**
 * Cost rates: per-person compensation. Spec 6.1, 2.4 point 1.
 *
 * ── WHY THIS SURFACE IS NOT SERIALIZER-FLOORED ────────────────────────────────────────
 *
 * `/v1/cost-rates` is deliberately NOT one of the eight `redactFinancialFields` surfaces.
 * `cost_amount` is not a field on this payload -- it IS the payload. Flooring it would return
 * a list of empty objects, which is a worse answer than a 403.
 *
 * So the protection here is entirely at the route: `burn.costrate.read` / `burn.costrate.write`
 * PLUS the second, independent in-route org-role guard (lib/http.ts requireOrgAdmin), which
 * reads the role directly off request.user so that a permission-resolver outage cannot open
 * it. `viewerCaps.costrate_read` is resolved and already on the request for audit and for the
 * SPA's control gating, but the ROUTE is what denies.
 *
 * ── PRECEDENCE, AND THE INCLUSIVE BOUND ───────────────────────────────────────────────
 *
 * user+project > user > project > org, and `effective_to` is INCLUSIVE, matching bill-api's
 * rate.service.ts:117. The parity test asserts Burn's resolver and Bill's agree across a
 * fixture matrix; an off-by-one on the inclusive bound is the classic way two rate resolvers
 * silently disagree on exactly one day per rate change, which then shows up as an
 * unreproducible penny difference in a margin report months later.
 */

export async function listCostRates(
  viewer: Viewer,
  params: { userId?: string; projectId?: string },
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(burnCostRates)
      .where(
        and(
          eq(burnCostRates.organization_id, viewer.org_id),
          params.userId ? eq(burnCostRates.user_id, params.userId) : undefined,
          params.projectId ? eq(burnCostRates.project_id, params.projectId) : undefined,
        ),
      )
      .orderBy(sql`${burnCostRates.effective_from} DESC`);
    return { data: rows };
  });
}

export async function createCostRate(viewer: Viewer, body: BurnCostRateCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [created] = await tx
      .insert(burnCostRates)
      .values({
        organization_id: viewer.org_id,
        project_id: body.project_id ?? null,
        user_id: body.user_id ?? null,
        cost_amount: body.cost_amount,
        rate_type: body.rate_type,
        currency: body.currency,
        effective_from: body.effective_from,
        effective_to: body.effective_to ?? null,
        note: body.note ?? null,
        created_by: viewer.id,
      })
      .returning();
    // The caller enqueues burn-revalue (M6). Adding a rate must revalue the EXISTING work
    // items that had none, otherwise the margin label flips to "Margin" while the history
    // behind it is still valued at zero cost.
    return { data: created, revalue_required: true };
  });
}

export async function updateCostRate(
  viewer: Viewer,
  id: string,
  patch: Partial<BurnCostRateCreate>,
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [updated] = await tx
      .update(burnCostRates)
      .set({ ...patch, updated_at: new Date() })
      .where(and(eq(burnCostRates.organization_id, viewer.org_id), eq(burnCostRates.id, id)))
      .returning();
    if (!updated) throw new NotFoundError('Cost rate not found');
    return { data: updated, revalue_required: true };
  });
}

export async function deleteCostRate(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const deleted = await tx
      .delete(burnCostRates)
      .where(and(eq(burnCostRates.organization_id, viewer.org_id), eq(burnCostRates.id, id)))
      .returning({ id: burnCostRates.id });
    if (deleted.length === 0) throw new NotFoundError('Cost rate not found');
    return { data: { id, deleted: true }, revalue_required: true };
  });
}

/**
 * Resolve the effective cost rate for (user, project, date).
 *
 * Precedence is expressed as an ORDER BY over a computed specificity rank rather than four
 * sequential queries: four queries can straddle a concurrent rate write and return a
 * less-specific rate than the one that exists, and the whole point of a precedence rule is
 * that it is evaluated atomically.
 */
export async function resolveCostRate(
  viewer: Viewer,
  args: { userId: string; projectId: string | null; on: string },
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(burnCostRates)
      .where(
        and(
          eq(burnCostRates.organization_id, viewer.org_id),
          sql`${burnCostRates.effective_from} <= ${args.on}::date`,
          // INCLUSIVE upper bound. `<=`, not `<`.
          sql`(${burnCostRates.effective_to} IS NULL OR ${burnCostRates.effective_to} >= ${args.on}::date)`,
          sql`(${burnCostRates.user_id} = ${args.userId} OR ${burnCostRates.user_id} IS NULL)`,
          args.projectId
            ? sql`(${burnCostRates.project_id} = ${args.projectId} OR ${burnCostRates.project_id} IS NULL)`
            : sql`${burnCostRates.project_id} IS NULL`,
        ),
      )
      .orderBy(
        sql`(CASE
              WHEN ${burnCostRates.user_id} IS NOT NULL AND ${burnCostRates.project_id} IS NOT NULL THEN 0
              WHEN ${burnCostRates.user_id} IS NOT NULL THEN 1
              WHEN ${burnCostRates.project_id} IS NOT NULL THEN 2
              ELSE 3
            END) ASC`,
        sql`${burnCostRates.effective_from} DESC`,
      )
      .limit(1);
    return { data: rows[0] ?? null };
  });
}
