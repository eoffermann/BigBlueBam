/**
 * GitHub delivery retry (issue #186).
 *
 * Queue name: 'github-delivery-retry' (GITHUB_DELIVERY_RETRY_QUEUE, enqueue-driven, no cron).
 * Producer:   apps/api/src/routes/github-webhook.routes.ts, via
 *             apps/api/src/services/github-delivery-queue.ts, when a VERIFIED delivery could
 *             not be applied inline (GitHub never redelivers a failed delivery on its own).
 *
 * A THIN caller: it POSTs the spooled delivery to the api's
 * POST /internal/github/deliveries/process, which runs the same processGithubDelivery the
 * webhook runs inline, so the github_pr_events append and the task linking live in one place.
 * Any non-2xx throws, and BullMQ retries with the producer's exponential backoff (12 attempts,
 * 30 s doubling). The api side is idempotent, so a replay after a partial attempt is safe.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { GithubDeliveryRetryJobData } from '@bigbluebam/shared';

/**
 * BBB_API_INTERNAL_URL, not API_INTERNAL_URL: the worker's deploy catalog entry lists (and
 * Railway computes) only BBB_API_INTERNAL_URL, so API_INTERNAL_URL falls back to
 * http://api:4000 there, which is the wrong host and port on Railway.
 */
export interface GithubDeliveryRetryEnv {
  BBB_API_INTERNAL_URL: string;
  INTERNAL_SERVICE_SECRET: string;
}

export async function processGithubDeliveryRetryJob(
  job: Job<GithubDeliveryRetryJobData>,
  env: GithubDeliveryRetryEnv,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<{ processed: number }> {
  const { integration_id, event, delivery_id } = job.data;
  if (!env.INTERNAL_SERVICE_SECRET) {
    // Throw rather than skip: a skipped job would complete and the delivery would be lost.
    throw new Error('github-delivery-retry: INTERNAL_SERVICE_SECRET is not set');
  }
  const started = Date.now();
  logger.info(
    { jobId: job.id, attempt: job.attemptsMade + 1, integration_id, event, delivery_id },
    'github-delivery-retry: replaying spooled delivery',
  );
  const res = await fetchImpl(`${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/github/deliveries/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_SERVICE_SECRET },
    body: JSON.stringify(job.data),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`github-delivery-retry: api answered ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { processed?: number; skipped?: string } };
  logger.info(
    {
      jobId: job.id,
      integration_id,
      delivery_id,
      processed: json.data?.processed ?? 0,
      skipped: json.data?.skipped,
      ms: Date.now() - started,
    },
    'github-delivery-retry: delivery applied',
  );
  return { processed: json.data?.processed ?? 0 };
}
