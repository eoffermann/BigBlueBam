/**
 * Basis snapshot partition provisioning (Basis design spec section 6).
 *
 * basis_metric_snapshots is monthly range-partitioned by captured_at (migration
 * 0227 pre-creates current-1..+12 plus a DEFAULT catch-all). This job keeps the
 * leading edge topped up. DEFAULT recovery is a manual runbook (a month whose
 * rows already spilled into DEFAULT cannot be auto-provisioned) - see the spec;
 * this job only creates absent forward partitions and alarms on failure.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BasisPartitionProvisionJobData {
  monthsAhead?: number;
}

function partitionInfo(year: number, month: number) {
  const name = `basis_metric_snapshots_${year}${String(month).padStart(2, '0')}`;
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const to = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { name, from, to };
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function processBasisPartitionProvisionJob(
  job: Job<BasisPartitionProvisionJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const monthsAhead = job.data?.monthsAhead ?? 3;

  const partitioned = rows<{ one: number }>(
    await db.execute(sql`
      SELECT 1 AS one FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      WHERE c.relname = 'basis_metric_snapshots' LIMIT 1
    `),
  );
  if (partitioned.length === 0) {
    logger.warn('basis-partition-provision: basis_metric_snapshots is not partitioned, skipping');
    return;
  }

  const now = new Date();
  const created: string[] = [];
  const failed: string[] = [];
  for (let ahead = 1; ahead <= monthsAhead; ahead++) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
    const info = partitionInfo(target.getUTCFullYear(), target.getUTCMonth() + 1);
    const exists = rows<{ one: number }>(
      await db.execute(sql`
        SELECT 1 AS one FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ${info.name} LIMIT 1
      `),
    );
    if (exists.length > 0) continue;
    try {
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS ${info.name} PARTITION OF basis_metric_snapshots ` +
            `FOR VALUES FROM ('${info.from}') TO ('${info.to}')`,
        ),
      );
      created.push(info.name);
    } catch (err) {
      // Likely the DEFAULT-already-holds-rows case (manual runbook). Alarm.
      failed.push(info.name);
      logger.error(
        { jobId: job.id, partition: info.name, err: (err as Error).message },
        'basis-partition-provision: FAILED to create partition (manual runbook may be required)',
      );
    }
  }

  // Detect real spillover: rows that landed in the DEFAULT catch-all because a
  // month partition was missing. These are NOT reclaimable by the coarse
  // retention tier and require the manual detach/create/redistribute/re-attach
  // runbook, so alarm (ERROR) rather than let it rot silently (stability #51).
  let defaultRows = 0;
  try {
    const occ = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM basis_metric_snapshots_default`),
    );
    defaultRows = occ[0]?.n ?? 0;
  } catch {
    /* DEFAULT partition may not exist in a hand-built env */
  }
  if (defaultRows > 0) {
    logger.error(
      { jobId: job.id, defaultRows },
      'basis-partition-provision: DEFAULT partition holds rows (spillover) - a month partition was missing; ' +
        'manual runbook required (detach DEFAULT, create the month partition, redistribute, re-attach). ' +
        'The coarse retention tier cannot reclaim DEFAULT-resident rows.',
    );
  }

  logger.info(
    { jobId: job.id, created, failed, monthsAhead, defaultRows },
    'basis-partition-provision: done',
  );
}
