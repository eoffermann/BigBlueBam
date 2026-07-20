/**
 * Bursar renewal-radar driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's internal
 * engine dispatcher, which sweeps every org for upcoming renewal deadlines. All engine logic + locks
 * live in bursar-api; this file just fires the daily tick.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarRenewalRadarJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-renewal-radar: starting');
  const res = await postBursar(
    '/v1/internal/engines/renewal-radar',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-renewal-radar: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-renewal-radar: complete',
  );
}
