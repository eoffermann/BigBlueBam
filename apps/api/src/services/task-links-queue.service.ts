/**
 * Producer side of the worker's task-link title-fetch job
 * (docs/plans/bam-csv-import-plan.md §4.3 item 3, Phase 0).
 *
 * Queue name: 'task-link-title-fetch'
 * Payload:    { task_id: string; link_id: string; url: string }
 * Consumer:   apps/worker/src/jobs/task-link-title-fetch.job.ts
 *
 * Fire-and-forget: title resolution is best-effort. If the enqueue (or the
 * fetch downstream) fails, the link simply keeps title null and the UI
 * falls back to hostname display — never block or fail the task mutation
 * that added the link.
 */

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import {
  TASK_LINK_TITLE_FETCH_QUEUE,
  type TaskLinkTitleFetchJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

// Re-export the shared contract so existing importers of this module keep
// working (single source of truth now lives in @bigbluebam/shared/queues).
export { TASK_LINK_TITLE_FETCH_QUEUE, type TaskLinkTitleFetchJobData };

let _queue: Queue<TaskLinkTitleFetchJobData> | null = null;

function getQueue(): Queue<TaskLinkTitleFetchJobData> {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _queue = new Queue(TASK_LINK_TITLE_FETCH_QUEUE, { connection });
  }
  return _queue;
}

export async function enqueueTaskLinkTitleFetch(
  taskId: string,
  linkId: string,
  url: string,
): Promise<void> {
  try {
    await getQueue().add(
      'fetch-title',
      { task_id: taskId, link_id: linkId, url },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  } catch {
    // Best-effort: a lost enqueue leaves the link untitled, which the UI
    // already handles (hostname display). Never propagate to the caller.
  }
}
