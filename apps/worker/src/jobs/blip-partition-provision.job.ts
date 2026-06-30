/**
 * Blip partition provisioning (Blip §5, §17).
 *
 * blip_entries is monthly range-partitioned by received_at (migration 0220
 * pre-creates 2 months back through 12 months ahead). This scheduled job keeps
 * the leading edge topped up so the live-tail write loop never lands a row in a
 * month with no partition (which would hit the catch-all default partition and
 * defeat the cheap "drop a month" purge path).
 *
 * Logic is ported from apps/banter-api/src/services/partition-manager.ts
 * (computePartitionInfo / partitionExists / ensureNextMonthPartition) — this is
 * the first such job actually wired into the worker.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BlipPartitionProvisionJobData {
  /** How many months ahead to ensure exist. Defaults to 3. */
  monthsAhead?: number;
}

interface PartitionInfo {
  name: string;
  from: string;
  to: string;
}

/** Partition name + [from, to) bounds for a 1-indexed year/month. */
function computePartitionInfo(year: number, month: number): PartitionInfo {
  const name = `blip_entries_${year}_${String(month).padStart(2, '0')}`;
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const to = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { name, from, to };
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function processBlipPartitionProvisionJob(
  job: Job<BlipPartitionProvisionJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const monthsAhead = job.data?.monthsAhead ?? 3;

  // Confirm the parent is actually partitioned before issuing PARTITION OF DDL
  // (defensive: a hand-built env could have a plain table).
  const partitioned = rows<{ one: number }>(
    await db.execute(sql`
      SELECT 1 AS one
      FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      WHERE c.relname = 'blip_entries'
      LIMIT 1
    `),
  );
  if (partitioned.length === 0) {
    logger.warn('blip-partition-provision: blip_entries is not partitioned, skipping');
    return;
  }

  const now = new Date();
  const created: string[] = [];
  for (let ahead = 1; ahead <= monthsAhead; ahead++) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
    const info = computePartitionInfo(target.getUTCFullYear(), target.getUTCMonth() + 1);

    const exists = rows<{ one: number }>(
      await db.execute(sql`
        SELECT 1 AS one FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ${info.name}
        LIMIT 1
      `),
    );
    if (exists.length > 0) continue;

    // sql.raw is safe: info is built from numeric year/month we control.
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${info.name} PARTITION OF blip_entries ` +
          `FOR VALUES FROM ('${info.from}') TO ('${info.to}')`,
      ),
    );
    created.push(info.name);
  }

  logger.info(
    { jobId: job.id, created, monthsAhead },
    created.length > 0
      ? 'blip-partition-provision: created partitions'
      : 'blip-partition-provision: all partitions present',
  );
}
