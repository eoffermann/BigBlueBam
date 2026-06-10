/**
 * Bureau knock-timeout queue helper (Agent B, workstream 5).
 *
 * Owns the single BullMQ Queue handle the bureau-api uses to schedule
 * `bureau-knock-timeout` jobs 30 seconds after a knock is created. The
 * worker consuming this queue lives in apps/worker/src/jobs/bureau-knock-
 * timeout.ts and processes the job by reading the knock row, flipping it
 * to `timed_out` if still pending, notifying the visitor on their Redis
 * channel, and emitting a `knock.resolved` Bolt event.
 *
 * Why a singleton:
 *   BullMQ Queue instances hold a persistent Redis connection — we do NOT
 *   want to create one per request. Lazy-init on first use so importing
 *   this module is side-effect-free for test harnesses that never knock.
 *
 * Why a dedicated ioredis client (rather than fastify.redis):
 *   BullMQ requires `maxRetriesPerRequest: null` on its connection (any
 *   other value triggers a deprecation warning, then a hard error in
 *   future versions). The fastify.redis client is configured for short
 *   command timeouts; sharing it would break either the queue or the
 *   request-path Redis calls.
 *
 * Failure mode:
 *   `scheduleKnockTimeout` is fire-and-forget. If Redis is unreachable the
 *   knock still persists and the owner can still resolve it manually; we
 *   just miss the 30s auto-timeout for this one knock. The caller logs.
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../env.js';

/** Match the consumer-side queue name in apps/worker/src/worker.ts. */
export const KNOCK_TIMEOUT_QUEUE = 'bureau-knock-timeout';

/** Match the §4.3 spec: 30 seconds. */
const KNOCK_TIMEOUT_MS = 30_000;

let queue: Queue | null = null;
let connection: Redis | null = null;

function getQueue(): Queue {
  if (!queue) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(KNOCK_TIMEOUT_QUEUE, { connection });
  }
  return queue;
}

/**
 * Enqueue a delayed timeout job for the given knock. Resolves once the
 * job is on the queue (not when the job fires); on failure logs and
 * swallows so the originating request never fails because of a queue
 * hiccup.
 */
export async function scheduleKnockTimeout(knockId: string): Promise<void> {
  try {
    await getQueue().add(
      'timeout',
      { knock_id: knockId },
      {
        // jobId keys the dedup so a double-submit from a buggy client only
        // produces one timeout job per knock.
        jobId: `knock-${knockId}`,
        delay: KNOCK_TIMEOUT_MS,
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  } catch (err) {
    console.error(
      `[bureau-knock-queue] failed to enqueue timeout for knock ${knockId}:`,
      err,
    );
  }
}

/** Test-only: tear down the singleton between test runs. */
export async function _resetKnockQueueForTests(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
