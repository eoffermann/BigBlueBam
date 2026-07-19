/**
 * Bulwark state-reconcile (Bulwark spec §4.5 / STJ1, the braid-rescan analog). Cron every 30 min.
 *
 * A THIN caller (spec §9.2): it POSTs /v1/internal/state-reconcile to bulwark-api, which for
 * every armed state-reflecting binding (bam:task.overdue is the beachhead) re-queries the
 * SOURCE table for currently-satisfying rows and re-computes the SAME deterministic event arm
 * key (uuid5(obligation || entity || state epoch)) as the live fire-on-event drain. Because the
 * key is identical, a dropped-then-reconciled event and a delivered event converge on ONE
 * deadline (ON CONFLICT DO NOTHING); a discharged deadline is not re-armed while the source
 * condition is unchanged; a changed source due date (new epoch) arms a fresh clock. It also
 * rebuilds the Redis dispatch gate on the same cadence (STJ3). This is the durability backstop
 * for the transient-event gap (Open Q1) across all state-reflecting bindings.
 *
 * Idempotent by construction (the deterministic key, not a watermark). Retry/backoff via BullMQ.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BulwarkSweepJobData } from '@bigbluebam/shared';
import { postBulwark } from './bulwark-shared.js';

export async function processBulwarkStateReconcileJob(
  job: Job<BulwarkSweepJobData>,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  logger.info({ jobId: job.id, scope }, 'bulwark-state-reconcile: starting (POST /internal/state-reconcile)');
  const res = await postBulwark('/internal/state-reconcile', scope ? { organization_id: scope } : {}, 120_000);
  logger.info(
    { jobId: job.id, summary: res.data, elapsedMs: Date.now() - started },
    'bulwark-state-reconcile: done',
  );
}
