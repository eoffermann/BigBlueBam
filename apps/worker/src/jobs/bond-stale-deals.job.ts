/**
 * Bond stale-deal sweep job — daily cron (Bond design doc §7).
 *
 * Finds open deals whose time-in-stage has exceeded `bond_pipeline_stages.rotting_days`
 * and which have not yet been alerted for the current stage entry, emits a
 * `bond.deal.rotting` event to Bolt for each one, and marks the deal with
 * `rotting_alerted_at = NOW()` so the same stage-entry is not re-alerted.
 *
 * Idempotency model:
 *   - A deal is considered newly stale if either
 *       rotting_alerted_at IS NULL, or
 *       rotting_alerted_at < stage_entered_at.
 *     The second clause naturally resets every time a deal moves stage, because
 *     the stage-change path on bond-api bumps stage_entered_at.
 *
 * Ordering decision (update-AFTER-emission):
 *   We emit the event first, THEN update rotting_alerted_at. A crash between
 *   those two steps will cause the SAME deal to retry on the next daily run —
 *   that is the intended behavior, since bolt-api might genuinely have been
 *   down. The trade-off is that a successful POST followed by a crash before
 *   the UPDATE produces one duplicate alert on the next run; duplicates are
 *   preferable to silent drops for rotting deals. `publishBoltEvent` is
 *   fire-and-forget, so a single bad event never blocks the rest of the batch
 *   and never throws out of the loop.
 *
 * Runs at 02:00 UTC (offset from beacon-expiry-sweep @ 03:00 and bearing-snapshot @ 00:00).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BondStaleDealsJobData {
  /** Optional: scope the sweep to a single organization for targeted runs. */
  organization_id?: string;
}

interface StaleDealRow {
  id: string;
  organization_id: string;
  stage_id: string;
  days_in_stage: number;
  rotting_days: number;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processBondStaleDealsJob(
  job: Job<BondStaleDealsJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id } = job.data ?? {};
  logger.info(
    { jobId: job.id, organization_id },
    'Starting bond stale-deals sweep',
  );

  const db = getDb();

  // Select newly-stale deals. The idempotency filter lives in the query so the
  // loop body only handles rows that actually need alerting — no per-row skip
  // logic required.
  const rowsRaw = await db.execute(sql`
    SELECT
      d.id,
      d.organization_id,
      d.stage_id,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400)::int AS days_in_stage,
      s.rotting_days AS rotting_days
    FROM bond_deals d
    INNER JOIN bond_pipeline_stages s ON s.id = d.stage_id
    WHERE d.closed_at IS NULL
      AND s.rotting_days IS NOT NULL
      AND EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400 > s.rotting_days
      AND (
        d.rotting_alerted_at IS NULL
        OR d.rotting_alerted_at < d.stage_entered_at
      )
      ${organization_id ? sql`AND d.organization_id = ${organization_id}` : sql``}
    ORDER BY days_in_stage DESC
  `);

  // drizzle-orm's `db.execute` returns an array-like on postgres-js and a
  // `{ rows }` wrapper on some other drivers. Normalise both shapes, matching
  // the pattern used in deal.service.ts::detectStaleDeals.
  const rows: StaleDealRow[] = (
    Array.isArray(rowsRaw)
      ? rowsRaw
      : ((rowsRaw as { rows?: unknown[] }).rows ?? [])
  ) as StaleDealRow[];

  logger.info({ count: rows.length }, 'Bond stale-deals: candidates found');

  if (rows.length === 0) {
    logger.info({ jobId: job.id }, 'Bond stale-deals sweep complete (no-op)');
    return;
  }

  let alerted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Fire-and-forget event emission. publishBoltEvent never throws, so
      // this await will resolve cleanly whether the POST succeeded or not.
      // event name normalized in wave 0.4
      await publishBoltEvent(
        'bond.deal.rotting',
        'bond',
        {
          deal_id: row.id,
          stage_id: row.stage_id,
          days_in_stage: row.days_in_stage,
          rotting_days_threshold: row.rotting_days,
        },
        row.organization_id,
        undefined,
        'system',
        { logger },
      );

      // Update marker AFTER emit. A genuine bolt-api outage means publishBoltEvent
      // logged a warning and returned — the UPDATE below still runs, which means
      // we will NOT retry that deal tomorrow. That is acceptable because rotting
      // thresholds are coarse (days) and the deal stays stale; the NEXT stage
      // move or threshold change will re-arm the alert. If we skipped the UPDATE
      // on emit-failure, a down bolt-api would cause the sweep to re-emit every
      // deal every day until it came back up, which floods the queue on recovery.
      await db.execute(sql`
        UPDATE bond_deals
        SET rotting_alerted_at = NOW()
        WHERE id = ${row.id}
      `);

      alerted += 1;
    } catch (err) {
      // Belt-and-braces: publishBoltEvent swallows its own errors, but the
      // UPDATE can still fail (e.g. connection reset). Log per-deal and keep
      // going so one bad row never kills the batch.
      failed += 1;
      logger.error(
        {
          dealId: row.id,
          orgId: row.organization_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Bond stale-deals: failed to process deal',
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      found: rows.length,
      alerted,
      failed,
    },
    'Bond stale-deals sweep complete',
  );
}
