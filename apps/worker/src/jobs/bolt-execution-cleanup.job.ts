/**
 * Bolt execution cleanup worker -- daily job.
 *
 * Deletes bolt_execution_steps and bolt_executions older than a configurable
 * retention period (default 90 days, override via BOLT_EXECUTION_RETENTION_DAYS
 * env var).
 *
 * Steps are deleted first (FK cascade would handle it, but explicit deletion
 * lets us log counts), then parent execution rows.
 *
 * Runs daily at 03:30 UTC (offset from other daily jobs).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoltExecutionCleanupJobData {
  /** Override retention days for this run (for testing). */
  retention_days?: number;
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

export async function processBoltExecutionCleanupJob(
  job: Job<BoltExecutionCleanupJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const retentionDays =
    job.data.retention_days ??
    parseInt(process.env.BOLT_EXECUTION_RETENTION_DAYS ?? '90', 10);

  if (isNaN(retentionDays) || retentionDays < 1) {
    logger.warn({ retentionDays }, 'bolt-execution-cleanup: invalid retention days, defaulting to 90');
  }

  const effectiveDays = (isNaN(retentionDays) || retentionDays < 1) ? 90 : retentionDays;
  const cutoff = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000);
  // postgres-js prepared-statement bind requires string | Buffer |
  // ArrayBuffer for text/timestamp params — passing the raw Date trips
  // ERR_INVALID_ARG_TYPE at the protocol layer and never reaches the
  // server. ISO strings always round-trip as timestamptz cleanly.
  const cutoffIso = cutoff.toISOString();

  logger.info(
    { retentionDays: effectiveDays, cutoff: cutoffIso },
    'bolt-execution-cleanup: starting cleanup',
  );

  // 1. Delete steps for old executions
  const stepsResult: any[] = await db.execute(sql`
    DELETE FROM bolt_execution_steps
    WHERE execution_id IN (
      SELECT id FROM bolt_executions
      WHERE created_at < ${cutoffIso}
    )
    RETURNING id
  `);
  const stepsDeleted = Array.isArray(stepsResult) ? stepsResult.length : 0;

  // 2. Delete old executions
  const execResult: any[] = await db.execute(sql`
    DELETE FROM bolt_executions
    WHERE created_at < ${cutoffIso}
    RETURNING id
  `);
  const execsDeleted = Array.isArray(execResult) ? execResult.length : 0;

  logger.info(
    {
      stepsDeleted,
      execsDeleted,
      retentionDays: effectiveDays,
      cutoff: cutoffIso,
    },
    'bolt-execution-cleanup: completed',
  );
}
