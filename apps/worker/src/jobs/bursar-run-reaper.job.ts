/**
 * Bursar run-reaper driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's internal
 * engine dispatcher, which recovers wedged/stale derivation & leveling runs across every org. All
 * engine logic + locks live in bursar-api; this file just fires the frequent tick.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarRunReaperJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-run-reaper: starting');
  const res = await postBursar(
    '/v1/internal/engines/run-reaper',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-run-reaper: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-run-reaper: complete',
  );
}
