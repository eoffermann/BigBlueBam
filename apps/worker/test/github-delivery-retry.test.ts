import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { GithubDeliveryRetryJobData } from '@bigbluebam/shared';
import { processGithubDeliveryRetryJob } from '../src/jobs/github-delivery-retry.job.js';

// Issue #186: the worker replays a spooled GitHub delivery through the api's internal route and
// throws on any non-2xx, so BullMQ retries it with backoff instead of completing and losing it.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const env = { BBB_API_INTERNAL_URL: 'http://api.internal:8080/', INTERNAL_SERVICE_SECRET: 's'.repeat(40) };

const data: GithubDeliveryRetryJobData = {
  integration_id: '33333333-3333-3333-3333-333333333333',
  event: 'pull_request',
  delivery_id: 'delivery-43',
  payload: { action: 'closed', pull_request: { number: 43, merged: true } },
  received_at: '2026-11-21T10:00:01.000Z',
};
const job = { id: 'gh-delivery:x:delivery-43', attemptsMade: 0, data } as unknown as Job<GithubDeliveryRetryJobData>;

describe('github-delivery-retry job', () => {
  it('POSTs the spooled delivery to the internal route with the shared secret', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { processed: 1 } }), { status: 200 }));
    const out = await processGithubDeliveryRetryJob(job, env, logger, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ processed: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.internal:8080/internal/github/deliveries/process');
    expect((init.headers as Record<string, string>)['x-internal-secret']).toBe(env.INTERNAL_SERVICE_SECRET);
    expect(JSON.parse(init.body as string)).toEqual(data);
  });

  it('throws on a non-2xx so BullMQ retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('db down', { status: 500 }));
    await expect(
      processGithubDeliveryRetryJob(job, env, logger, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/api answered 500/);
  });

  it('throws (never silently completes) when the internal secret is unset', async () => {
    const fetchImpl = vi.fn();
    await expect(
      processGithubDeliveryRetryJob(job, { ...env, INTERNAL_SERVICE_SECRET: '' }, logger, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/INTERNAL_SERVICE_SECRET/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
