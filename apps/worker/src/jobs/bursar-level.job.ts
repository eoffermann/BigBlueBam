/**
 * Bursar leveling driver (spec 3.4-3.9, 18.6, M5). Event-driven queue consumer, enqueued by
 * bursar-api's POST /v1/requests/:id/level. The worker REGISTRATION lands in M8; this file is the
 * thin driver it will register, mirroring bursar-derive-scope.job.ts.
 *
 * The job POLLS bursar-api's async-start leveling engine one OFFER per call until the run is `done`.
 * "Bounded to one offer per invocation" is enforced server-side; the poll loop here just re-drives
 * the same run_id. A 409 (claimed by another worker) or a lost run ends this attempt; a 429
 * (throttled) throws so BullMQ backs off and resumes from the checkpoint; the reaper recovers a
 * wedged run. NO bytes and NO LLM here: all engine logic lives in bursar-api.
 *
 * A BullMQ limiter sized under the proxy's 120/min is applied at worker registration (M8), not here.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarLevelJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

const MAX_POLLS = 200; // hard cap so a bug cannot spin forever; 8 offers chunk well under this.

export async function processBursarLevelJob(job: Job<BursarLevelJobData>, logger: Logger): Promise<void> {
  const { organization_id, request_id, run_id } = job.data;
  const started = Date.now();
  const claimant = `worker:${job.id ?? 'unknown'}`;
  logger.info(
    { jobId: job.id, organization_id, request_id, run_id, attempt: job.attemptsMade + 1 },
    'bursar-level: starting',
  );

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const res = await postBursar('/v1/internal/run-leveling', { organization_id, request_id, run_id, claimant });
    if (res.status === 409) {
      logger.info({ jobId: job.id, run_id }, 'bursar-level: run claimed by another worker; ending this attempt');
      return;
    }
    if (res.status === 429) {
      // Throttled: let BullMQ back off and retry, resuming from the checkpoint.
      throw new Error('bursar-level: LLM throttled; will retry from checkpoint');
    }
    if (res.status === 404) {
      logger.warn({ jobId: job.id, run_id }, 'bursar-level: run not found; ending');
      return;
    }
    if (!res.ok) throw new Error(`bursar-level: run-leveling returned ${res.status}`);
    const data = (res.data as { data?: { done?: boolean; status?: string; processedOffer?: number | null } } | undefined)?.data;
    logger.info(
      { jobId: job.id, run_id, poll, offer: data?.processedOffer, status: data?.status, elapsedMs: Date.now() - started },
      'bursar-level: slice done',
    );
    if (data?.done) {
      logger.info({ jobId: job.id, run_id, status: data.status, elapsedMs: Date.now() - started }, 'bursar-level: complete');
      return;
    }
  }
  throw new Error('bursar-level: exceeded max polls without completing');
}
