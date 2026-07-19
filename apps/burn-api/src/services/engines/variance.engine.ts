import { sql } from 'drizzle-orm';
import type { DbTx } from '../../db/index.js';
import { runInOrgScope } from '../../plugins/rls.js';
import { tryOrgSweepLock } from '../../lib/advisory-lock.js';
import { allBurnOrgIds } from './rollup.engine.js';
import { publishBoltEvent } from '@bigbluebam/shared';

/**
 * Variance engine (spec 4.3). Every 30 minutes, per org, inside a transaction holding the per-org
 * sweep advisory lock (SQL-only, no HTTP - spec 4.0). Raises findings keyed on `dedup_key` so a
 * re-run is idempotent. Two concurrent sweeps for one org: one proceeds, the other skips with a
 * counted log line (spec 4.0 point 3).
 *
 * Unpriced deliverables are EXCLUDED from envelope_overrun and consumption_erosion (spec 2.2.2).
 * The published `variance.detected` event carries refs + severity only, never the amount.
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface Finding {
  variance_kind: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  dedup_key: string;
  engagement_id: string | null;
  chain_root_id: string | null;
  deliverable_id: string | null;
  amount: number | null;
  detail: Record<string, unknown>;
}

async function upsertFindings(tx: DbTx, orgId: string, findings: Finding[], sweepMarker: Date): Promise<number> {
  let n = 0;
  for (const f of findings) {
    await tx.execute(sql`
      INSERT INTO burn_variances (
        organization_id, engagement_id, chain_root_id, deliverable_id, variance_kind, severity,
        dedup_key, amount, detail, status, detected_at, sweep_marker
      ) VALUES (
        ${orgId}, ${f.engagement_id}, ${f.chain_root_id}, ${f.deliverable_id}, ${f.variance_kind},
        ${f.severity}, ${f.dedup_key}, ${f.amount}, ${JSON.stringify(f.detail)}::jsonb, 'open',
        ${sweepMarker}, ${sweepMarker}
      )
      ON CONFLICT (organization_id, dedup_key) DO UPDATE SET
        severity = EXCLUDED.severity, amount = EXCLUDED.amount, detail = EXCLUDED.detail,
        sweep_marker = EXCLUDED.sweep_marker, updated_at = now()
      WHERE burn_variances.status = 'open'
    `);
    n += 1;
  }
  return n;
}

/** Detect findings for one org (SQL-only). Runs inside the caller's org-scoped, lock-holding tx. */
async function detectForOrg(tx: DbTx, orgId: string, floor: number): Promise<Finding[]> {
  const findings: Finding[] = [];

  // envelope_overrun: priced deliverables whose attributed billable exceeds effective envelope.
  const overruns = rows<{ deliverable_id: string; engagement_id: string; chain_root_id: string; envelope: number; consumed: number }>(
    await tx.execute(sql`
      SELECT d.id AS deliverable_id, d.engagement_id, e.chain_root_id,
             (d.envelope_amount + COALESCE((SELECT SUM(ad.envelope_amount_delta) FROM burn_deliverables ad WHERE ad.amends_deliverable_id = d.id AND ad.delta_confirmed_at IS NOT NULL), 0)) AS envelope,
             COALESCE(SUM(wi.billable_amount), 0) AS consumed
        FROM burn_deliverables d
        JOIN burn_engagements e ON e.id = d.engagement_id
        LEFT JOIN burn_attributions a ON a.deliverable_id = d.id AND a.superseded_at IS NULL
        LEFT JOIN burn_work_items wi ON wi.id = a.work_item_id AND wi.attribution_state = 'attributed'
       WHERE d.organization_id = ${orgId}
         AND d.envelope_amount IS NOT NULL
         AND d.amends_deliverable_id IS NULL
         AND d.is_active = true
       GROUP BY d.id, d.engagement_id, e.chain_root_id, d.envelope_amount
      HAVING COALESCE(SUM(wi.billable_amount), 0) > (d.envelope_amount + COALESCE((SELECT SUM(ad.envelope_amount_delta) FROM burn_deliverables ad WHERE ad.amends_deliverable_id = d.id AND ad.delta_confirmed_at IS NOT NULL), 0))
    `),
  );
  for (const o of overruns) {
    const over = o.consumed - o.envelope;
    findings.push({
      variance_kind: 'envelope_overrun', severity: over > o.envelope ? 'critical' : 'high',
      dedup_key: `envelope_overrun:${o.deliverable_id}`,
      engagement_id: o.engagement_id, chain_root_id: o.chain_root_id, deliverable_id: o.deliverable_id,
      amount: over, detail: { deliverable_id: o.deliverable_id },
    });
  }

  // unscoped_work: chains with above-floor unscoped billable (the "sold by nobody" bucket).
  const unscoped = rows<{ chain_root_id: string; total: number }>(
    await tx.execute(sql`
      SELECT a.chain_root_id, COALESCE(SUM(wi.billable_amount), 0) AS total
        FROM burn_work_items wi
        JOIN burn_attributions a ON a.work_item_id = wi.id AND a.superseded_at IS NULL
       WHERE wi.organization_id = ${orgId} AND wi.attribution_state = 'unscoped'
         AND a.unscoped_reason = 'no_matching_deliverable' AND a.chain_root_id IS NOT NULL
       GROUP BY a.chain_root_id
      HAVING COALESCE(SUM(wi.billable_amount), 0) >= ${floor}
    `),
  );
  for (const u of unscoped) {
    findings.push({
      variance_kind: 'unscoped_work', severity: 'medium', dedup_key: `unscoped_work:${u.chain_root_id}`,
      engagement_id: null, chain_root_id: u.chain_root_id, deliverable_id: null, amount: u.total,
      detail: { chain_root_id: u.chain_root_id },
    });
  }

  // ungated_charge: a money-out expense work item with no burn_prechecks row (the catch-all that
  // makes coverage gaps visible - spec 4.3).
  const ungated = rows<{ work_item_id: string; source_id: string }>(
    await tx.execute(sql`
      SELECT wi.id AS work_item_id, wi.source_id
        FROM burn_work_items wi
       WHERE wi.organization_id = ${orgId} AND wi.source_type = 'bill.expense'
         AND wi.billable_amount IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM burn_prechecks p WHERE p.organization_id = ${orgId} AND p.work_ref_id = wi.source_id)
       LIMIT 200
    `),
  );
  for (const g of ungated) {
    findings.push({
      variance_kind: 'ungated_charge', severity: 'medium', dedup_key: `ungated_charge:${g.work_item_id}`,
      engagement_id: null, chain_root_id: null, deliverable_id: null, amount: null,
      detail: { work_item_id: g.work_item_id, source_id: g.source_id },
    });
  }

  return findings;
}

export interface VarianceSweepResult {
  orgs: number;
  findings: number;
  skipped_locked: number;
}

export async function runVarianceSweep(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
): Promise<VarianceSweepResult> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let findingsTotal = 0;
  let skipped = 0;
  log.info({ orgs: orgIds.length }, 'burn variance-sweep: starting (SQL-only, per-org locked)');
  for (const oid of orgIds) {
    const settings = rows<{ unscoped_alert_floor: number }>(
      await (await import('../../db/index.js')).db.execute(sql`SELECT unscoped_alert_floor FROM burn_org_settings WHERE organization_id = ${oid}`),
    )[0] ?? { unscoped_alert_floor: 10000 };
    const emitted: Finding[] = [];
    const res = await runInOrgScope(oid, async (tx) => {
      if (!(await tryOrgSweepLock(tx, oid))) {
        log.info({ org_id: oid }, 'burn variance-sweep: skipped, org sweep lock held');
        return { skipped: true, count: 0 };
      }
      const sweepMarker = new Date();
      const findings = await detectForOrg(tx, oid, settings.unscoped_alert_floor);
      const n = await upsertFindings(tx, oid, findings, sweepMarker);
      emitted.push(...findings);
      await tx.execute(sql`UPDATE burn_org_settings SET last_variance_sweep_at = ${sweepMarker} WHERE organization_id = ${oid}`);
      return { skipped: false, count: n };
    });
    if (res.skipped) { skipped += 1; continue; }
    findingsTotal += res.count;
    // Emit refs-only variance.detected AFTER the transaction commits.
    for (const f of emitted) {
      await publishBoltEvent('variance.detected', 'burn', {
        'engagement.id': f.engagement_id, variance_kind: f.variance_kind, severity: f.severity, 'org.id': oid,
      }, oid).catch(() => {});
    }
  }
  log.info({ orgs: orgIds.length, findings: findingsTotal, skipped, elapsedMs: Date.now() - started }, 'burn variance-sweep: done');
  return { orgs: orgIds.length, findings: findingsTotal, skipped_locked: skipped };
}
