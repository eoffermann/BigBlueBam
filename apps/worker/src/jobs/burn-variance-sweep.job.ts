/** Burn burn-variance-sweep (spec 8.1). Thin caller to burn-api's engine route. */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BurnSweepJobData } from '@bigbluebam/shared';
import { runBurnSweep } from './burn-sweep-runner.js';

export async function processBurnVarianceSweepJob(job: Job<BurnSweepJobData>, logger: Logger): Promise<void> {
  await runBurnSweep('burn-variance-sweep', '/v1/internal/engines/variance-sweep', job, logger);
}
