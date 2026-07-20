/**
 * Bursar draft-reconcile driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's internal
 * engine dispatcher, which reconciles drafted proposals/notices against reality across every org. All
 * engine logic + locks live in bursar-api; this file just fires the tick.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarDraftReconcileJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-draft-reconcile: starting');
  const res = await postBursar(
    '/v1/internal/engines/draft-reconcile',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-draft-reconcile: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-draft-reconcile: complete',
  );
}
