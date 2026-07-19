import { sql } from 'drizzle-orm';
import type { DbTx } from '../../db/index.js';
import { runInOrgScope } from '../../plugins/rls.js';
import { tryOrgSweepLock } from '../../lib/advisory-lock.js';
import {
  revenueBasisFor,
  recognizedRevenue,
  marginFrom,
  type EnvelopeBasis,
} from './valuation.js';

/**
 * Per-chain financial rollup refresh (spec 4.3 / 8.1 rollup-refresh). One idempotent upsert per
 * chain; a `frozen_at IS NOT NULL` row is NEVER recomputed (R2-T5). Held under the per-org sweep
 * advisory lock (SQL-only work, no HTTP - spec 4.0). Also used synchronously by GET /v1/financials
 * for a missing chain and by burn-retention (which passes `computeOnly` to get the pre-purge
 * figure it then freezes).
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface ComputedRollup {
  chain_root_id: string;
  contract_value: number | null;
  attributed_billable: number;
  attributed_cost: number | null;
  unscoped_sold_by_nobody: number;
  unscoped_unclassified: number;
  unscoped_outside_contract: number;
  pending_review_amount: number;
  awaiting_valuation_amount: number;
  non_billable_amount: number;
  consumption_pct: number | null;
  margin_amount: number | null;
  margin_pct: number | null;
  cost_rate_coverage_pct: number | null;
  priced_deliverable_coverage_pct: number | null;
  distinct_contributor_count: number;
  metric_basis: 'true_margin' | 'contract_consumption';
  revenue_basis: string;
  work_item_count: number;
}

/**
 * Compute (never persist) the rollup for one chain from live rows. Pure-ish: reads the DB but
 * writes nothing, so retention can freeze the exact figure it computed (R3-T5 asserts the frozen
 * figure equals the pre-purge computed figure).
 */
export async function computeChainRollup(
  tx: DbTx,
  orgId: string,
  chainRootId: string,
): Promise<ComputedRollup> {
  // Chain-level contract value and the governing basis (the root's basis governs the chain).
  const eng = rows<{
    envelope_basis: EnvelopeBasis;
    contract_value: number | null;
    is_root: boolean;
  }>(
    await tx.execute(sql`
      SELECT envelope_basis,
             COALESCE(contract_value_delta, contract_value) AS contract_value,
             (id = chain_root_id) AS is_root
        FROM burn_engagements
       WHERE organization_id = ${orgId} AND chain_root_id = ${chainRootId}
         AND status <> 'superseded'
    `),
  );
  const contractValue = eng.reduce((s, e) => s + (e.contract_value ?? 0), 0) || null;
  const basis: EnvelopeBasis = eng.find((e) => e.is_root)?.envelope_basis ?? eng[0]?.envelope_basis ?? 'fixed';

  // Aggregate work items by attribution state, joining through burn_attributions (which carries
  // NO money - amounts come from burn_work_items, R3-T2).
  const agg = rows<{
    attributed_billable: number | null;
    attributed_cost: number | null;
    cost_covered_billable: number | null;
    non_billable_amount: number | null;
    pending_review_amount: number | null;
    awaiting_valuation_amount: number | null;
    sold_by_nobody: number | null;
    unclassified: number | null;
    outside_contract: number | null;
    distinct_contributors: number | null;
    work_item_count: number | null;
  }>(
    await tx.execute(sql`
      SELECT
        SUM(CASE WHEN wi.attribution_state = 'attributed' THEN wi.billable_amount ELSE 0 END) AS attributed_billable,
        SUM(CASE WHEN wi.attribution_state = 'attributed' THEN wi.cost_amount ELSE 0 END) AS attributed_cost,
        SUM(CASE WHEN wi.attribution_state = 'attributed' AND wi.cost_amount IS NOT NULL THEN wi.billable_amount ELSE 0 END) AS cost_covered_billable,
        SUM(CASE WHEN wi.attribution_state = 'excluded_non_billable' THEN wi.cost_amount ELSE 0 END) AS non_billable_amount,
        SUM(CASE WHEN wi.attribution_state = 'pending_review' THEN wi.billable_amount ELSE 0 END) AS pending_review_amount,
        SUM(CASE WHEN wi.valuation_basis = 'unrated' THEN 0 ELSE 0 END) AS awaiting_valuation_amount,
        SUM(CASE WHEN wi.attribution_state = 'unscoped' AND a.unscoped_reason = 'no_matching_deliverable' THEN wi.billable_amount ELSE 0 END) AS sold_by_nobody,
        SUM(CASE WHEN wi.attribution_state IN ('unscoped','pending') AND (a.unscoped_reason = 'low_confidence' OR a.id IS NULL) THEN wi.billable_amount ELSE 0 END) AS unclassified,
        SUM(CASE WHEN wi.attribution_state = 'unscoped' AND a.unscoped_reason IN ('no_active_engagement','outside_engagement_window') THEN wi.billable_amount ELSE 0 END) AS outside_contract,
        COUNT(DISTINCT wi.actor_id) FILTER (WHERE wi.attribution_state = 'attributed') AS distinct_contributors,
        COUNT(*) AS work_item_count
      FROM burn_attributions a
      RIGHT JOIN burn_work_items wi ON wi.id = a.work_item_id AND a.superseded_at IS NULL
      WHERE wi.organization_id = ${orgId} AND a.chain_root_id = ${chainRootId}
    `),
  )[0];

  const attributed_billable = agg?.attributed_billable ?? 0;
  const attributed_cost = agg?.attributed_cost ?? null;
  const costCoveredBillable = agg?.cost_covered_billable ?? 0;

  // Awaiting-valuation count of dollars is not a dollar total (unrated rows have null amount); it
  // is reported as a count in queue-health. Here it is zero by construction.
  const revenue_basis = revenueBasisFor(basis);
  const revenue = recognizedRevenue({
    envelope_basis: basis,
    contract_value: contractValue,
    attributed_billable,
    cap_amount: contractValue,
  });
  const cost_rate_coverage_pct =
    attributed_billable > 0 ? Number(((costCoveredBillable / attributed_billable) * 100).toFixed(2)) : null;
  const hasCostCoverage = (cost_rate_coverage_pct ?? 0) > 0;
  const metric_basis = hasCostCoverage ? 'true_margin' : 'contract_consumption';
  const margin_amount = hasCostCoverage ? marginFrom(revenue, attributed_cost) : null;
  const margin_pct =
    margin_amount != null && revenue > 0 ? Number(((margin_amount / revenue) * 100).toFixed(2)) : null;
  const consumption_pct =
    contractValue && contractValue > 0
      ? Number(((attributed_billable / contractValue) * 100).toFixed(2))
      : null;

  // Priced-deliverable coverage gates promotion to blocking (spec 5.4).
  const delivCov = rows<{ total: number; priced: number }>(
    await tx.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE envelope_amount IS NOT NULL)::int AS priced
        FROM burn_deliverables
       WHERE organization_id = ${orgId}
         AND engagement_id IN (SELECT id FROM burn_engagements WHERE organization_id = ${orgId} AND chain_root_id = ${chainRootId})
         AND amends_deliverable_id IS NULL
         AND review_status <> 'superseded'
    `),
  )[0];
  const priced_deliverable_coverage_pct =
    delivCov && delivCov.total > 0 ? Number(((delivCov.priced / delivCov.total) * 100).toFixed(2)) : null;

  return {
    chain_root_id: chainRootId,
    contract_value: contractValue,
    attributed_billable,
    attributed_cost,
    unscoped_sold_by_nobody: agg?.sold_by_nobody ?? 0,
    unscoped_unclassified: agg?.unclassified ?? 0,
    unscoped_outside_contract: agg?.outside_contract ?? 0,
    pending_review_amount: agg?.pending_review_amount ?? 0,
    awaiting_valuation_amount: 0,
    non_billable_amount: agg?.non_billable_amount ?? 0,
    consumption_pct,
    margin_amount,
    margin_pct,
    cost_rate_coverage_pct,
    priced_deliverable_coverage_pct,
    distinct_contributor_count: agg?.distinct_contributors ?? 0,
    metric_basis,
    revenue_basis,
    work_item_count: agg?.work_item_count ?? 0,
  };
}

/**
 * Upsert one computed rollup, skipping a frozen row. `marginState` is 'in_progress' for a live
 * refresh; retention passes 'final'.
 */
export async function upsertRollup(
  tx: DbTx,
  orgId: string,
  r: ComputedRollup,
  marginState: 'in_progress' | 'final',
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO burn_engagement_rollups (
      organization_id, chain_root_id, contract_value, attributed_billable, attributed_cost,
      unscoped_sold_by_nobody, unscoped_unclassified, unscoped_outside_contract,
      pending_review_amount, awaiting_valuation_amount, non_billable_amount, consumption_pct,
      margin_amount, margin_pct, cost_rate_coverage_pct, priced_deliverable_coverage_pct,
      distinct_contributor_count, metric_basis, revenue_basis, margin_state, work_item_count,
      computed_at
    ) VALUES (
      ${orgId}, ${r.chain_root_id}, ${r.contract_value}, ${r.attributed_billable}, ${r.attributed_cost},
      ${r.unscoped_sold_by_nobody}, ${r.unscoped_unclassified}, ${r.unscoped_outside_contract},
      ${r.pending_review_amount}, ${r.awaiting_valuation_amount}, ${r.non_billable_amount}, ${r.consumption_pct},
      ${r.margin_amount}, ${r.margin_pct}, ${r.cost_rate_coverage_pct}, ${r.priced_deliverable_coverage_pct},
      ${r.distinct_contributor_count}, ${r.metric_basis}, ${r.revenue_basis}, ${marginState}, ${r.work_item_count},
      now()
    )
    ON CONFLICT (organization_id, chain_root_id) DO UPDATE SET
      contract_value = EXCLUDED.contract_value,
      attributed_billable = EXCLUDED.attributed_billable,
      attributed_cost = EXCLUDED.attributed_cost,
      unscoped_sold_by_nobody = EXCLUDED.unscoped_sold_by_nobody,
      unscoped_unclassified = EXCLUDED.unscoped_unclassified,
      unscoped_outside_contract = EXCLUDED.unscoped_outside_contract,
      pending_review_amount = EXCLUDED.pending_review_amount,
      awaiting_valuation_amount = EXCLUDED.awaiting_valuation_amount,
      non_billable_amount = EXCLUDED.non_billable_amount,
      consumption_pct = EXCLUDED.consumption_pct,
      margin_amount = EXCLUDED.margin_amount,
      margin_pct = EXCLUDED.margin_pct,
      cost_rate_coverage_pct = EXCLUDED.cost_rate_coverage_pct,
      priced_deliverable_coverage_pct = EXCLUDED.priced_deliverable_coverage_pct,
      distinct_contributor_count = EXCLUDED.distinct_contributor_count,
      metric_basis = EXCLUDED.metric_basis,
      revenue_basis = EXCLUDED.revenue_basis,
      margin_state = EXCLUDED.margin_state,
      work_item_count = EXCLUDED.work_item_count,
      computed_at = now()
    WHERE burn_engagement_rollups.frozen_at IS NULL
  `);
}

export interface RollupRefreshResult {
  orgs: number;
  chains: number;
  skipped_locked: number;
}

/**
 * Refresh rollups for one org (or all orgs when orgId is omitted). Each org runs in its own
 * org-scoped transaction holding the per-org sweep lock; a contended org is skipped with a
 * counted log line (spec 4.0 point 3).
 */
export async function refreshRollups(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
): Promise<RollupRefreshResult> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let chains = 0;
  let skipped = 0;
  log.info({ orgs: orgIds.length }, 'burn rollup-refresh: starting (SQL-only, per-org locked)');
  for (const oid of orgIds) {
    const res = await runInOrgScope(oid, async (tx) => {
      if (!(await tryOrgSweepLock(tx, oid))) {
        log.info({ org_id: oid }, 'burn rollup-refresh: skipped, org sweep lock held by another sweep');
        return { skipped: true, chains: 0 };
      }
      const chainRoots = rows<{ chain_root_id: string }>(
        await tx.execute(sql`
          SELECT DISTINCT chain_root_id FROM burn_engagements
           WHERE organization_id = ${oid} AND status <> 'superseded'
        `),
      );
      let n = 0;
      for (const c of chainRoots) {
        const computed = await computeChainRollup(tx, oid, c.chain_root_id);
        await upsertRollup(tx, oid, computed, 'in_progress');
        n += 1;
      }
      return { skipped: false, chains: n };
    });
    if (res.skipped) skipped += 1;
    else chains += res.chains;
  }
  log.info({ orgs: orgIds.length, chains, skipped, elapsedMs: Date.now() - started }, 'burn rollup-refresh: done');
  return { orgs: orgIds.length, chains, skipped_locked: skipped };
}

/** All org ids that have any burn engagement. Runs unscoped (org-iterating job, spec 2.4 p14). */
export async function allBurnOrgIds(): Promise<string[]> {
  const { db } = await import('../../db/index.js');
  const raw = await db.execute(sql`SELECT DISTINCT organization_id FROM burn_engagements`);
  return rows<{ organization_id: string }>(raw).map((r) => r.organization_id);
}
