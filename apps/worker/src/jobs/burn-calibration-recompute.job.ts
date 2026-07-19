/** Burn burn-calibration-recompute (spec 8.1). Thin caller to burn-api's engine route. */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BurnSweepJobData } from '@bigbluebam/shared';
import { runBurnSweep } from './burn-sweep-runner.js';

export async function processBurnCalibrationRecomputeJob(job: Job<BurnSweepJobData>, logger: Logger): Promise<void> {
  await runBurnSweep('burn-calibration-recompute', '/v1/internal/engines/calibration-recompute', job, logger);
}
