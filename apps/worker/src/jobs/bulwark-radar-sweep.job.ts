/**
 * Bulwark deadline-radar sweep (Bulwark spec §4.3). Repeatable cron every 15 min.
 *
 * A THIN caller (spec §9.2): it POSTs /v1/internal/radar-sweep to bulwark-api, which runs the
 * engine over every org under a per-org advisory lock - pending-inbox drain (STJ2), risk
 * detection, CAS-guarded capped auto-draft, missed detection, calendar/recurring arming, and
 * the compliance validity sweep. Progress is logged at start + completion with elapsed.
 *
 * Idempotent: the arm keys + risk unique index make re-running a no-op; last_radar_sweep_at
 * advances only after a fully-successful org tick. Retry/backoff via BullMQ attempts.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BulwarkSweepJobData } from '@bigbluebam/shared';
import { postBulwark } from './bulwark-shared.js';

export async function processBulwarkRadarSweepJob(
  job: Job<BulwarkSweepJobData>,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  logger.info({ jobId: job.id, scope }, 'bulwark-radar-sweep: starting (POST /internal/radar-sweep)');
  const res = await postBulwark('/internal/radar-sweep', scope ? { organization_id: scope } : {}, 120_000);
  logger.info(
    { jobId: job.id, summary: res.data, elapsedMs: Date.now() - started },
    'bulwark-radar-sweep: done',
  );
}
