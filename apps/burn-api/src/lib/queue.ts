import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BURN_EXTRACT_DELIVERABLES_QUEUE,
  type BurnExtractDeliverablesJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

/**
 * BullMQ producer for the Burn engine queues (spec 4 / 8.1). burn-api is the PRODUCER; the
 * worker (apps/worker) is the consumer. A dedicated ioredis connection is used so the producer
 * does not contend with the request-path fastify.redis client.
 *
 * Lazy singleton: the Queue (and its Redis connection) is created on first enqueue so a
 * burn-api boot with Redis briefly unavailable does not crash, and tests that never enqueue pay
 * nothing. Enqueue is best-effort from the caller's perspective - a failure is swallowed and the
 * route still returns, but is reported so the caller can log it. The retry/backoff/DLQ options
 * here match the worker-side registration so a transient extraction failure is retried rather
 * than dropped.
 */

let extractQueue: Queue<BurnExtractDeliverablesJobData> | null = null;
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getExtractQueue(): Queue<BurnExtractDeliverablesJobData> {
  if (!extractQueue) {
    extractQueue = new Queue<BurnExtractDeliverablesJobData>(BURN_EXTRACT_DELIVERABLES_QUEUE, {
      connection: getConnection(),
    });
  }
  return extractQueue;
}

/**
 * Enqueue a deliverable-extraction run for an engagement. Deduped via a short TTL window so a
 * rapid double-register (create-with-asset + an immediate /extract) collapses to one job; a
 * genuine re-extract after the window enqueues again. The engine hash-skips an unchanged doc
 * after a succeeded run, so a redundant job is cheap.
 */
export async function enqueueExtraction(data: BurnExtractDeliverablesJobData): Promise<boolean> {
  try {
    await getExtractQueue().add('extract', data, {
      deduplication: { id: `burn:extract:${data.organization_id}:${data.engagement_id}`, ttl: 30_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function closeBurnQueues(): Promise<void> {
  await extractQueue?.close().catch(() => {});
  extractQueue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
