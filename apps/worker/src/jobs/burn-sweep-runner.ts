import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BurnSweepJobData } from '@bigbluebam/shared';
import { postBurn } from './burn-shared.js';

/**
 * Shared thin-caller body for the Burn scheduled sweeps (spec 8.1). Each burn-* sweep job is a
 * thin HTTP caller that POSTs its burn-api internal engine route; all engine logic (locks,
 * progress logging, org iteration) lives in burn-api. Progress is logged at start + completion
 * with elapsed so a multi-minute sweep is never a silent phase (CLAUDE.md progress rule).
 */
export async function runBurnSweep(
  queue: string,
  path: string,
  job: Job<BurnSweepJobData>,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  logger.info({ jobId: job.id, queue, scope }, `${queue}: starting (POST ${path})`);
  const res = await postBurn(path, scope ? { organization_id: scope } : {});
  logger.info({ jobId: job.id, queue, summary: res.data, elapsedMs: Date.now() - started }, `${queue}: done`);
}
