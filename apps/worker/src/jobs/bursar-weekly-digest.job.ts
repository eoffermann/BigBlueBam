/**
 * Bursar weekly-digest driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's internal
 * engine dispatcher, which composes the weekly digest per org. The digest channel decision is IN-APP
 * notifications (resolved in the WIP doc), delivered inside bursar-api. All engine logic + locks live
 * in bursar-api; this file just fires the Monday tick.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarWeeklyDigestJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-weekly-digest: starting');
  const res = await postBursar(
    '/v1/internal/engines/weekly-digest',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-weekly-digest: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-weekly-digest: complete',
  );
}
