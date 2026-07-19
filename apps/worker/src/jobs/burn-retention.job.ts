/** Burn burn-retention (spec 8.1). Thin caller to burn-api's engine route. */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BurnSweepJobData } from '@bigbluebam/shared';
import { runBurnSweep } from './burn-sweep-runner.js';

export async function processBurnRetentionJob(job: Job<BurnSweepJobData>, logger: Logger): Promise<void> {
  await runBurnSweep('burn-retention', '/v1/internal/engines/retention', job, logger);
}
