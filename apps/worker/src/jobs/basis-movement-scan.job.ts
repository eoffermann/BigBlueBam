/**
 * Basis movement scan (Basis design spec section 6).
 *
 * Compares only snapshots sharing the SAME version_id (a definition change
 * re-baselines). Fires metric.threshold_breached ONCE per crossing via the
 * last_breach_* marker (cleared on recovery). Payload is magnitude only - no
 * entity refs (leak-safety, spec 7.1).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

export interface BasisMovementScanJobData {
  grain?: 'hour' | 'day';
}

interface ScanRow {
  id: string;
  organization_id: string;
  target: { value: number; comparison: 'gte' | 'lte' | 'gt' | 'lt' } | null;
  last_breach_direction: string | null;
  latest: string | null;
  prior: string | null;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function breached(value: number, target: { value: number; comparison: string }): boolean {
  switch (target.comparison) {
    case 'gte':
      return value < target.value; // want >=, breach when below
    case 'gt':
      return value <= target.value;
    case 'lte':
      return value > target.value; // want <=, breach when above
    case 'lt':
      return value >= target.value;
    default:
      return false;
  }
}

export async function processBasisMovementScanJob(
  job: Job<BasisMovementScanJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const grain = job.data?.grain ?? 'day';

  // Latest + prior snapshot per metric, sharing the metric's current version.
  const scan = rows<ScanRow>(
    await db.execute(sql`
      SELECT m.id, m.organization_id, m.target, m.last_breach_direction,
             (SELECT s.value FROM basis_metric_snapshots s
                WHERE s.metric_id = m.id AND s.version_id = m.current_version_id AND s.grain = ${grain}
                ORDER BY s.captured_at DESC LIMIT 1) AS latest,
             (SELECT s.value FROM basis_metric_snapshots s
                WHERE s.metric_id = m.id AND s.version_id = m.current_version_id AND s.grain = ${grain}
                ORDER BY s.captured_at DESC OFFSET 1 LIMIT 1) AS prior
      FROM basis_metrics m
      WHERE m.certification = 'certified' AND m.target IS NOT NULL
    `),
  );

  let fired = 0;
  let recovered = 0;
  for (const r of scan) {
    if (r.latest == null || r.target == null) continue;
    const latest = Number(r.latest);
    const prior = r.prior == null ? null : Number(r.prior);
    const isBreached = breached(latest, r.target);

    if (isBreached && !r.last_breach_direction) {
      // New crossing -> fire once.
      const deltaAbs = prior == null ? 0 : latest - prior;
      const deltaPct = prior && prior !== 0 ? (deltaAbs / prior) * 100 : null;
      const direction = deltaAbs >= 0 ? 'up' : 'down';
      await db.execute(sql`
        UPDATE basis_metrics SET last_breach_at = now(), last_breach_direction = ${direction}
        WHERE id = ${r.id}
      `);
      void publishBoltEvent(
        'metric.threshold_breached',
        'basis',
        { metric: { id: r.id }, delta_abs: deltaAbs, delta_pct: deltaPct, direction },
        r.organization_id,
      );
      fired++;
    } else if (!isBreached && r.last_breach_direction) {
      // Recovered -> clear the marker so the next crossing fires again.
      await db.execute(sql`
        UPDATE basis_metrics SET last_breach_direction = NULL WHERE id = ${r.id}
      `);
      recovered++;
    }
  }

  logger.info({ jobId: job.id, grain, fired, recovered, scanned: scan.length }, 'basis-movement-scan: done');
}
