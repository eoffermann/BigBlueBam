/**
 * Basis snapshot retention sweep (Basis design spec section 6), two-tier,
 * modeled on blip-retention-sweep.
 *
 * basis_metric_snapshots is a SINGLE set of monthly partitions shared across all
 * orgs, so a partition DROP is global. Therefore:
 *   1. Coarse tier: drop a whole month partition only when its upper bound is
 *      past the PLATFORM-WIDE MAX retention across all orgs, and skip the coarse
 *      tier entirely if ANY org is unbounded (snapshot_max_age_days IS NULL).
 *      The DEFAULT partition (no upper bound) is never droppable.
 *   2. Per-org shorter windows are enforced by bounded ranged DELETEs within
 *      live partitions - never a partition drop - so one org's short window can
 *      never delete another org's rows in a shared month.
 * Also ages out expired basis_explanations. No hour->day rollup (spec).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BasisRetentionSweepJobData {
  defaultExplanationTtlSeconds?: number;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function processBasisRetentionSweepJob(
  job: Job<BasisRetentionSweepJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const start = Date.now();

  // --- Per-org retention windows -----------------------------------------
  const policies = rows<{ organization_id: string; snapshot_max_age_days: number | null }>(
    await db.execute(sql`
      SELECT organization_id, snapshot_max_age_days FROM basis_org_settings
    `),
  );
  const anyUnbounded =
    policies.length === 0 || policies.some((p) => p.snapshot_max_age_days == null);

  // Per-org bounded ranged DELETEs (safe within shared partitions).
  let deletedRows = 0;
  for (const p of policies) {
    if (p.snapshot_max_age_days == null) continue;
    const res = await db.execute(sql`
      DELETE FROM basis_metric_snapshots
      WHERE organization_id = ${p.organization_id}
        AND captured_at < now() - (${p.snapshot_max_age_days} || ' days')::interval
    `);
    deletedRows += (res as { count?: number }).count ?? 0;
  }

  // --- Coarse tier: drop whole month partitions past the platform-wide MAX --
  let droppedPartitions: string[] = [];
  if (!anyUnbounded && policies.length > 0) {
    const maxDays = Math.max(...policies.map((p) => p.snapshot_max_age_days as number));
    const parts = rows<{ child: string; upper: string | null }>(
      await db.execute(sql`
        SELECT c.relname AS child,
               pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'basis_metric_snapshots'
      `),
    ) as unknown as { child: string; bound: string | null }[];
    const floor = new Date(Date.now() - maxDays * 86400_000);
    for (const part of parts) {
      // Never drop DEFAULT (its bound expression is 'DEFAULT', no upper bound).
      if (!part.bound || part.bound.includes('DEFAULT')) continue;
      const m = part.bound.match(/TO \('([^']+)'\)/);
      if (!m) continue;
      const upper = new Date(m[1]!);
      if (upper < floor) {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${part.child}`));
        droppedPartitions.push(part.child);
      }
    }
  }

  // --- Expire cached explanations ----------------------------------------
  const ttl = job.data?.defaultExplanationTtlSeconds ?? 3600;
  await db.execute(sql`
    DELETE FROM basis_explanations
    WHERE computed_at < now() - (${ttl} || ' seconds')::interval
  `);

  logger.info(
    {
      jobId: job.id,
      anyUnbounded,
      deletedRows,
      droppedPartitions,
      durationMs: Date.now() - start,
    },
    'basis-retention-sweep: done',
  );
}
