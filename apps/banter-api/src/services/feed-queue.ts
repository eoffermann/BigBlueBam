import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../env.js';
import { BANTER_FEED_FANIN_QUEUE, type BanterFeedFaninJobData } from '@bigbluebam/shared';

/**
 * Producer side of the Banter Feed fan-in (banter-feed-design-document.md §10).
 * banter-api enqueues one job per surfacing event; the worker resolves
 * concerned users and upserts banter_feed_entries. Fire-and-forget: a queueing
 * failure must never break message delivery.
 */

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(BANTER_FEED_FANIN_QUEUE, { connection });
  }
  return queue;
}

export async function enqueueFeedFanin(data: BanterFeedFaninJobData): Promise<void> {
  try {
    await getQueue().add('fanin', data, {
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  } catch {
    // Non-critical: feed fan-in is best-effort relative to message delivery.
  }
}
