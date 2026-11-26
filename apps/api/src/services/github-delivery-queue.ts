/**
 * Producer side of the GitHub delivery spool (issue #186).
 *
 * Queue name: 'github-delivery-retry' (GITHUB_DELIVERY_RETRY_QUEUE in @bigbluebam/shared)
 * Consumer:   apps/worker/src/jobs/github-delivery-retry.job.ts, which POSTs each job to
 *             POST /internal/github/deliveries/process.
 *
 * Unlike the fire-and-forget title fetch, this enqueue is NOT best-effort: the caller only
 * answers GitHub with a 2xx once the job is durably in Redis, and rethrows (so GitHub shows the
 * delivery as failed) when the enqueue itself fails. Redis is a different failure domain from
 * Postgres, which is what the inline attempt just failed against.
 */
import { createHash } from 'node:crypto';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { GITHUB_DELIVERY_RETRY_QUEUE, type GithubDeliveryRetryJobData } from '@bigbluebam/shared';
import { env } from '../env.js';

/** 12 attempts, 30 s doubling: the last retry lands about 17 hours after the first failure. */
export const GITHUB_DELIVERY_RETRY_ATTEMPTS = 12;
export const GITHUB_DELIVERY_RETRY_BASE_DELAY_MS = 30_000;

let _queue: Queue<GithubDeliveryRetryJobData> | null = null;

function getQueue(): Queue<GithubDeliveryRetryJobData> {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    _queue = new Queue(GITHUB_DELIVERY_RETRY_QUEUE, { connection });
  }
  return _queue;
}

/**
 * Deterministic job id, so a GitHub "Redeliver" of a delivery that is already spooled does not
 * enqueue it twice. Falls back to a hash of the raw body when X-GitHub-Delivery is absent.
 */
export function githubDeliveryJobId(integrationId: string, deliveryId: string | null, rawBody: Buffer): string {
  const key = deliveryId ?? `sha256-${createHash('sha256').update(rawBody).digest('hex')}`;
  return `gh-delivery:${integrationId}:${key}`;
}

export async function enqueueGithubDeliveryRetry(
  data: GithubDeliveryRetryJobData,
  jobId: string,
): Promise<void> {
  await getQueue().add('process', data, {
    jobId,
    attempts: GITHUB_DELIVERY_RETRY_ATTEMPTS,
    backoff: { type: 'exponential', delay: GITHUB_DELIVERY_RETRY_BASE_DELAY_MS },
    removeOnComplete: 1000,
    // Keep exhausted jobs so an operator can inspect and replay them.
    removeOnFail: 5000,
  });
}
