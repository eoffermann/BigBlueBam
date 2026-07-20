/**
 * Bursar mismatch-reconcile driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's
 * internal engine dispatcher, which reconciles scope/offer mismatches across every org. All engine
 * logic + locks live in bursar-api; this file just fires the tick (offset to run after drift-sweep).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarMismatchReconcileJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-mismatch-reconcile: starting');
  const res = await postBursar(
    '/v1/internal/engines/mismatch-reconcile',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-mismatch-reconcile: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-mismatch-reconcile: complete',
  );
}
