import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BRAID_MATCH_ON_INGEST_QUEUE,
  type BraidMatchOnIngestJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

// BullMQ producer for the braid-match-on-ingest queue (spec §6, IN3). braid-api is the
// PRODUCER (the /internal/events route fed by bolt-api dispatch, and the lazy resolve path);
// the worker (apps/worker) is the consumer. A dedicated ioredis connection is used so the
// producer does not contend with the request-path fastify.redis client.
//
// Lazy singleton: the Queue (and its Redis connection) is created on first enqueue so a
// braid-api boot with Redis briefly unavailable does not crash, and tests that never enqueue
// pay nothing. Enqueue is best-effort from the caller's perspective: a failure is logged and
// swallowed because the nightly braid-rescan source-diff is the durable fallback (spec §6).

let queue: Queue<BraidMatchOnIngestJobData> | null = null;
let connection: IORedis | null = null;

function getQueue(): Queue<BraidMatchOnIngestJobData> {
  if (!queue) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BraidMatchOnIngestJobData>(BRAID_MATCH_ON_INGEST_QUEUE, { connection });
  }
  return queue;
}

export interface EnqueueIngestArgs {
  orgId: string;
  sourceType: string;
  sourceId: string;
  seeded?: boolean;
}

// Enqueue a refs-only match-on-ingest job. Idempotent jobId collapses duplicate enqueues for
// the same (org, type, id) within the BullMQ retention window (a live dispatch racing the
// nightly diff). Bounded attempts + exponential backoff; on final give-up the worker DLQs by
// flagging braid_identities.needs_rescan (spec §4.6 / ST-r2-7).
export async function enqueueBraidIngest(args: EnqueueIngestArgs): Promise<boolean> {
  try {
    await getQueue().add(
      'ingest',
      {
        org_id: args.orgId,
        source_type: args.sourceType,
        source_id: args.sourceId,
        seeded: args.seeded,
      },
      {
        jobId: `braid:${args.orgId}:${args.sourceType}:${args.sourceId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
    return true;
  } catch {
    // Fire-and-forget: the nightly rescan source-diff is the durable fallback (spec §6).
    return false;
  }
}

export async function closeBraidQueue(): Promise<void> {
  if (queue) {
    await queue.close().catch(() => {});
    queue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
