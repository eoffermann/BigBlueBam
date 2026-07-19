import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { runInOrgScope } from '../../plugins/rls.js';
import { tryOrgSweepLock } from '../../lib/advisory-lock.js';
import { allBurnOrgIds } from './rollup.engine.js';
import { publishBoltEvent } from '@bigbluebam/shared';

/**
 * The SQL-only maintenance sweeps that are small enough to share a file: the inverse check
 * (silent-deliverable), the claim reaper, and the calibration/demotion recompute. Each is per-org
 * and takes the per-org sweep advisory lock (spec 4.0). None calls an LLM.
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// ── 4.4 Inverse check: silent deliverables ────────────────────────────────────

export async function runSilentDeliverableSweep(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
  leadWindowDays = 14,
): Promise<{ orgs: number; raised: number; skipped_locked: number }> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let raised = 0;
  let skipped = 0;
  log.info({ orgs: orgIds.length }, 'burn silent-deliverable-sweep: starting');
  for (const oid of orgIds) {
    const emitted: Array<{ deliverable_id: string; engagement_id: string; due_date: string; days_remaining: number }> = [];
    const res = await runInOrgScope(oid, async (tx) => {
      if (!(await tryOrgSweepLock(tx, oid))) return { skipped: true, count: 0 };
      const silent = rows<{ id: string; engagement_id: string; due_date: string; days_remaining: number }>(
        await tx.execute(sql`
          SELECT d.id, d.engagement_id, d.due_date::text AS due_date,
                 (d.due_date - CURRENT_DATE) AS days_remaining
            FROM burn_deliverables d
           WHERE d.organization_id = ${oid} AND d.is_active = true
             AND d.lifecycle_status = 'open'
             AND d.due_date IS NOT NULL
             AND d.due_date <= CURRENT_DATE + ${leadWindowDays}
             AND d.amends_deliverable_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM burn_attributions a
                WHERE a.deliverable_id = d.id AND a.organization_id = ${oid} AND a.superseded_at IS NULL
             )
        `),
      );
      let n = 0;
      const sweepMarker = new Date();
      for (const s of silent) {
        await tx.execute(sql`
          INSERT INTO burn_variances (organization_id, engagement_id, deliverable_id, variance_kind, severity, dedup_key, detail, status, detected_at, sweep_marker)
          VALUES (${oid}, ${s.engagement_id}, ${s.id}, 'silent_deliverable', 'high', ${`silent_deliverable:${s.id}`}, ${JSON.stringify({ deliverable_id: s.id, due_date: s.due_date })}::jsonb, 'open', ${sweepMarker}, ${sweepMarker})
          ON CONFLICT (organization_id, dedup_key) DO UPDATE SET sweep_marker = EXCLUDED.sweep_marker, updated_at = now()
          WHERE burn_variances.status = 'open'
        `);
        emitted.push({ deliverable_id: s.id, engagement_id: s.engagement_id, due_date: s.due_date, days_remaining: s.days_remaining });
        n += 1;
      }
      return { skipped: false, count: n };
    });
    if (res.skipped) { skipped += 1; continue; }
    raised += res.count;
    for (const e of emitted) {
      await publishBoltEvent('deliverable.silent', 'burn', {
        'deliverable.id': e.deliverable_id, 'engagement.id': e.engagement_id, due_date: e.due_date, days_remaining: e.days_remaining, 'org.id': oid,
      }, oid).catch(() => {});
    }
  }
  log.info({ orgs: orgIds.length, raised, skipped, elapsedMs: Date.now() - started }, 'burn silent-deliverable-sweep: done');
  return { orgs: orgIds.length, raised, skipped_locked: skipped };
}

// ── Claim reaper: return genuinely cold claims to pending ──────────────────────

export async function runClaimReaper(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
): Promise<{ orgs: number; reclaimed: number }> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let reclaimed = 0;
  log.info({ orgs: orgIds.length }, 'burn claim-reaper: starting (per-org GUC set; only genuinely cold claims)');
  for (const oid of orgIds) {
    // The reaper iterates orgs and sets the GUC per org so it works under BBB_RLS_ENFORCE=1
    // (a global scan with no GUC set returns zero rows - spec ingest-events schema note).
    const n = await runInOrgScope(oid, async (tx) => {
      const lease = rows<{ claim_lease_seconds: number }>(
        await tx.execute(sql`SELECT claim_lease_seconds FROM burn_org_settings WHERE organization_id = ${oid}`),
      )[0]?.claim_lease_seconds ?? 300;
      const res = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE burn_ingest_events
             SET status = 'pending', claimed_by = NULL, claimed_at = NULL
           WHERE organization_id = ${oid} AND status = 'claimed'
             AND claimed_at < now() - (${lease} * interval '1 second')
          RETURNING id
        `),
      );
      return res.length;
    });
    reclaimed += n;
  }
  log.info({ orgs: orgIds.length, reclaimed, elapsedMs: Date.now() - started }, 'burn claim-reaper: done');
  return { orgs: orgIds.length, reclaimed };
}

// ── Calibration / demotion recompute (spec 5.4 / 5.6) ──────────────────────────

export async function runCalibrationRecompute(
  orgId: string | null,
  redis: Redis,
  log: { info: (o: unknown, m?: string) => void },
): Promise<{ orgs: number; demoted: number; degraded: number }> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let demoted = 0;
  let degraded = 0;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  log.info({ orgs: orgIds.length }, 'burn calibration-recompute: starting (drains coverage counters; both demotion triggers)');
  for (const oid of orgIds) {
    // Drain the coverage counters (best-effort; Redis is non-throwing here - spec 5.5.3).
    let gateCalls = 0;
    let gateUnavailable = 0;
    try {
      gateCalls = Number((await redis.get(`burn:gate_calls:${oid}:${day}`)) ?? '0');
      gateUnavailable = Number((await redis.get(`burn:gate_unavailable:${oid}:${day}`)) ?? '0');
    } catch { /* fail-open: no demotion on a Redis hiccup */ }

    const settings = await runInOrgScope(oid, async (tx) => {
      if (!(await tryOrgSweepLock(tx, oid))) return null;
      return rows<{ gate_mode: string; min_gate_coverage_pct: string; min_gate_unavailable_days: number; max_false_positive_rate: string; min_gate_wrong_count: number; min_gate_wrong_distinct_users: number }>(
        await tx.execute(sql`
          SELECT gate_mode, min_gate_coverage_pct, min_gate_unavailable_days, max_false_positive_rate, min_gate_wrong_count, min_gate_wrong_distinct_users
            FROM burn_org_settings WHERE organization_id = ${oid}
        `),
      )[0] ?? null;
    });
    if (!settings) continue;

    const coverage = gateCalls > 0 ? (gateCalls - gateUnavailable) / gateCalls : 1;
    // Coverage demotion: only when the gate is in blocking mode and coverage dips below the floor.
    if (settings.gate_mode === 'blocking' && coverage < Number(settings.min_gate_coverage_pct)) {
      await runInOrgScope(oid, async (tx) => {
        await tx.execute(sql`UPDATE burn_org_settings SET gate_mode = 'advisory', gate_demoted_at = now() WHERE organization_id = ${oid} AND gate_mode = 'blocking'`);
      });
      await publishBoltEvent('gate.demoted', 'burn', { 'org.id': oid, from_mode: 'blocking', to_mode: 'advisory', trigger: 'coverage', window_days: settings.min_gate_unavailable_days }, oid).catch(() => {});
      demoted += 1;
    }
    // Coverage-degraded signal (fired whether or not blocking, so operators see the gap).
    if (coverage < Number(settings.min_gate_coverage_pct)) {
      await publishBoltEvent('gate.coverage_degraded', 'burn', {
        'org.id': oid, coverage_pct_band: coverage < 0.5 ? 'below_50' : coverage < 0.9 ? '50_90' : '90_plus',
        window_days: 1, cause: gateCalls === 0 ? 'not_configured' : 'unavailable',
      }, oid).catch(() => {});
      degraded += 1;
    }
  }
  log.info({ orgs: orgIds.length, demoted, degraded, elapsedMs: Date.now() - started }, 'burn calibration-recompute: done');
  return { orgs: orgIds.length, demoted, degraded };
}
