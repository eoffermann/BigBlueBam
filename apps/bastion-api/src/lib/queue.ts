import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BASTION_EVALUATE_RUN_QUEUE,
  bastionEvaluateRunJobId,
  type BastionEvaluateRunJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

/**
 * BullMQ producer for bastion-evaluate-run (spec 7). bastion-api enqueues a run the moment it is
 * created (POST /evaluations); the worker's evaluate-tick re-enqueues any `queued` run idle for
 * more than two minutes, so a dropped enqueue only delays a run, it never orphans one.
 *
 * Every add passes a jobId (the run id plus resume_count, spec 7.3) and the scheduled-job
 * retention, so a re-enqueue after a release is never deduplicated against a retained job and
 * Redis never fills with finished-job records. Lazy singleton: no Redis connection until first use.
 */

export const EVALUATE_RUN_JOB_RETENTION = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const;

let queue: Queue<BastionEvaluateRunJobData> | null = null;
let connection: IORedis | null = null;

function getQueue(): Queue<BastionEvaluateRunJobData> {
  if (!queue) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BastionEvaluateRunJobData>(BASTION_EVALUATE_RUN_QUEUE, { connection });
  }
  return queue;
}

/** Best effort: false when Redis refused; the tick recovers the run within minutes. */
export async function enqueueEvaluationRun(data: BastionEvaluateRunJobData): Promise<boolean> {
  try {
    await getQueue().add('run', data, {
      jobId: bastionEvaluateRunJobId(data.run_id, data.resume_count),
      ...EVALUATE_RUN_JOB_RETENTION,
    });
    return true;
  } catch {
    return false;
  }
}

export async function closeBastionQueues(): Promise<void> {
  await queue?.close().catch(() => {});
  queue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
