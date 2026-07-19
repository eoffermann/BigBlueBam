/**
 * Bulwark retention sweep (Bulwark spec §4.5 / D3 / STJ7). Repeatable cron daily 04:50.
 *
 * A THIN caller (spec §9.2): it POSTs /v1/internal/retention to bulwark-api, which per org purges
 * ONLY discharged deadlines older than discharged_deadline_retention_days and inbox rows older
 * than inbox_retention_days, computing the discharged cutoff from the (larger) inbox floor in the
 * SAME run so a late redelivery can never re-arm a purged clock. missed/waived/voided deadlines
 * and ALL waiver_risks are kept indefinitely (the dispute record); extraction runs, contracts,
 * and obligations are never purged.
 *
 * Idempotent (bounded ranged DELETEs). Retry/backoff via BullMQ attempts.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BulwarkSweepJobData } from '@bigbluebam/shared';
import { postBulwark } from './bulwark-shared.js';

export async function processBulwarkRetentionJob(
  job: Job<BulwarkSweepJobData>,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  logger.info({ jobId: job.id, scope }, 'bulwark-retention: starting (POST /internal/retention)');
  const res = await postBulwark('/internal/retention', scope ? { organization_id: scope } : {}, 120_000);
  logger.info(
    { jobId: job.id, summary: res.data, elapsedMs: Date.now() - started },
    'bulwark-retention: done',
  );
}
