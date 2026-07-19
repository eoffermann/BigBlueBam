import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BULWARK_EXTRACT_OBLIGATIONS_QUEUE,
  BULWARK_FIRE_ON_EVENT_QUEUE,
  type BulwarkExtractObligationsJobData,
  type BulwarkFireOnEventJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

// BullMQ producers for the Bulwark engine queues (spec §4 / §9.2). bulwark-api is the
// PRODUCER; the worker (apps/worker, landed in a later milestone) is the consumer. A
// dedicated ioredis connection is used so the producer does not contend with the
// request-path fastify.redis client.
//
// Lazy singletons: the Queue (and its Redis connection) is created on first enqueue so a
// bulwark-api boot with Redis briefly unavailable does not crash, and tests that never
// enqueue pay nothing. Enqueue is best-effort from the caller's perspective: a failure is
// logged and swallowed because the durable inbox + the radar pending-drain + the
// state-reconcile job are the firing guarantees (spec §4.3 / §4.5).

let extractQueue: Queue<BulwarkExtractObligationsJobData> | null = null;
let fireQueue: Queue<BulwarkFireOnEventJobData> | null = null;
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getExtractQueue(): Queue<BulwarkExtractObligationsJobData> {
  if (!extractQueue) {
    extractQueue = new Queue<BulwarkExtractObligationsJobData>(
      BULWARK_EXTRACT_OBLIGATIONS_QUEUE,
      { connection: getConnection() },
    );
  }
  return extractQueue;
}

function getFireQueue(): Queue<BulwarkFireOnEventJobData> {
  if (!fireQueue) {
    fireQueue = new Queue<BulwarkFireOnEventJobData>(BULWARK_FIRE_ON_EVENT_QUEUE, {
      connection: getConnection(),
    });
  }
  return fireQueue;
}

// Enqueue an extraction run for a contract. Dedup via a short TTL window so a rapid
// double-register collapses; a genuine re-extract (a new /extract call) enqueues again.
export async function enqueueExtraction(
  data: BulwarkExtractObligationsJobData,
): Promise<boolean> {
  try {
    await getExtractQueue().add('extract', data, {
      deduplication: { id: `bulwark:extract:${data.org_id}:${data.contract_id}`, ttl: 30_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
    return true;
  } catch {
    return false; // durable inbox / reconcile are the fallbacks
  }
}

// Enqueue an inbox-drain job for a durably-persisted event row. Redelivery within the TTL
// is harmless (the drain is idempotent via the deterministic arm key).
export async function enqueueFireOnEvent(data: BulwarkFireOnEventJobData): Promise<boolean> {
  try {
    await getFireQueue().add('fire', data, {
      deduplication: { id: `bulwark:fire:${data.org_id}:${data.ingest_event_id}`, ttl: 60_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
    return true;
  } catch {
    return false; // the radar pending-inbox drain recovers a lost enqueue (spec §4.3)
  }
}

export async function closeBulwarkQueues(): Promise<void> {
  await extractQueue?.close().catch(() => {});
  await fireQueue?.close().catch(() => {});
  extractQueue = null;
  fireQueue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
