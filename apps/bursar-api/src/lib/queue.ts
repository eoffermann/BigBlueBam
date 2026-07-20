import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BURSAR_DERIVE_SCOPE_QUEUE,
  BURSAR_PARSE_OFFER_QUEUE,
  type BursarDeriveScopeJobData,
  type BursarParseOfferJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

/**
 * BullMQ producer for the Bursar engine queues (spec 3.2, 18.6). bursar-api is the PRODUCER;
 * the worker (apps/worker) is the consumer, whose registration lands in M8. A dedicated ioredis
 * connection is used so the producer does not contend with the request-path fastify.redis client.
 *
 * Lazy singleton: the Queue (and its Redis connection) is created on first enqueue so a boot with
 * Redis briefly unavailable does not crash, and tests that never enqueue pay nothing. Enqueue is
 * best-effort - a failure returns false so the route can log it. The run row already exists and
 * scope_status is 'deriving', so a dropped enqueue is recovered by the reaper (it reverts the
 * wedged run + request), never a silent permanent hang.
 */

let deriveQueue: Queue<BursarDeriveScopeJobData> | null = null;
let parseOfferQueue: Queue<BursarParseOfferJobData> | null = null;
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getDeriveQueue(): Queue<BursarDeriveScopeJobData> {
  if (!deriveQueue) {
    deriveQueue = new Queue<BursarDeriveScopeJobData>(BURSAR_DERIVE_SCOPE_QUEUE, {
      connection: getConnection(),
    });
  }
  return deriveQueue;
}

function getParseOfferQueue(): Queue<BursarParseOfferJobData> {
  if (!parseOfferQueue) {
    parseOfferQueue = new Queue<BursarParseOfferJobData>(BURSAR_PARSE_OFFER_QUEUE, {
      connection: getConnection(),
    });
  }
  return parseOfferQueue;
}

export async function enqueueDerivation(data: BursarDeriveScopeJobData): Promise<boolean> {
  try {
    await getDeriveQueue().add('derive', data, {
      deduplication: { id: `bursar:derive:${data.organization_id}:${data.run_id}`, ttl: 30_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enqueue the deterministic offer parse (spec 4.1, M4). Event-triggered from the ingest route; the
 * worker consumer registration lands in M8. Best-effort: a dropped enqueue leaves the offer at its
 * pre-parse status and the reaper never needs to intervene (nothing is 'parsing' yet), so a manual
 * reparse recovers it. Deduplicated per offer so a double-submit does not double-parse.
 */
export async function enqueueOfferParse(data: BursarParseOfferJobData): Promise<boolean> {
  try {
    await getParseOfferQueue().add('parse', data, {
      deduplication: { id: `bursar:parse:${data.organization_id}:${data.offer_id}`, ttl: 30_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function closeBursarQueues(): Promise<void> {
  await deriveQueue?.close().catch(() => {});
  await parseOfferQueue?.close().catch(() => {});
  deriveQueue = null;
  parseOfferQueue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
