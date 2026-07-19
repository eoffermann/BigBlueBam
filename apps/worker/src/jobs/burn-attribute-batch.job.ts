/**
 * Burn continuous-attribution drain (spec 4.2). Event-driven (on ingest) + scheduled every 2 min.
 * Thin caller: POSTs /v1/internal/engines/attribute-batch, which claims a batch of pending ingest
 * rows and classifies them. The correctness mechanism is row claims + lease renewal inside
 * burn-api, NOT a lock and NOT worker single-threading, so the queue runs at
 * concurrency: BURN_ATTRIBUTE_CONCURRENCY (2). A 429 from the LLM cap defers to
 * pending_attribution inside the engine, never unscoped (spec 9.7.1).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BurnSweepJobData } from '@bigbluebam/shared';
import { postBurn } from './burn-shared.js';

export async function processBurnAttributeBatchJob(job: Job<BurnSweepJobData>, logger: Logger): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  const claimedBy = `worker:${process.pid}:${job.id ?? 'adhoc'}`;
  logger.info({ jobId: job.id, scope, claimedBy }, 'burn-attribute-batch: starting (row-claim drain, no lock)');
  const res = await postBurn('/v1/internal/engines/attribute-batch', scope ? { organization_id: scope, claimed_by: claimedBy } : { claimed_by: claimedBy });
  logger.info({ jobId: job.id, summary: res.data, elapsedMs: Date.now() - started }, 'burn-attribute-batch: done');
}
