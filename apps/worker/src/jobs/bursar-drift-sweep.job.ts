/**
 * Bursar drift-sweep driver (spec 15). Scheduled thin HTTP caller: POSTs to bursar-api's internal
 * engine dispatcher, which sweeps every org with drift to reconcile. All engine logic + locks live
 * in bursar-api; this file just fires the tick. Bounded sweep (worker limiter set at registration).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BursarSweepJobData } from '@bigbluebam/shared';
import { postBursar } from './bursar-shared.js';

export async function processBursarDriftSweepJob(job: Job<BursarSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bursar-drift-sweep: starting');
  const res = await postBursar(
    '/v1/internal/engines/drift-sweep',
    job.data?.organization_id ? { organization_id: job.data.organization_id } : {},
  );
  if (!res.ok) throw new Error(`bursar-drift-sweep: engine returned ${res.status}`);
  logger.info(
    { jobId: job.id, elapsedMs: Date.now() - started, summary: (res.data as { data?: unknown })?.data },
    'bursar-drift-sweep: complete',
  );
}
