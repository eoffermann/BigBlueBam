import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publishBoltEvent } from '../src/bolt-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function installFetchMock(impl: (input: string, init: RequestInit) => Promise<Response>) {
  const captured: CapturedFetch[] = [];
  const mock = vi.fn(async (input: any, init: any) => {
    captured.push({ url: String(input), init });
    return impl(String(input), init);
  });
  // @ts-expect-error: overriding global for the test
  globalThis.fetch = mock;
  return { captured, mock };
}

function createLogger() {
  return { warn: vi.fn() };
}

const ORIG_FETCH = globalThis.fetch;
const ORIG_BOLT_URL = process.env.BOLT_API_INTERNAL_URL;
const ORIG_INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET;

beforeEach(() => {
  delete process.env.BOLT_API_INTERNAL_URL;
  delete process.env.INTERNAL_SERVICE_SECRET;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_BOLT_URL === undefined) {
    delete process.env.BOLT_API_INTERNAL_URL;
  } else {
    process.env.BOLT_API_INTERNAL_URL = ORIG_BOLT_URL;
  }
  if (ORIG_INTERNAL_SECRET === undefined) {
    delete process.env.INTERNAL_SERVICE_SECRET;
  } else {
    process.env.INTERNAL_SERVICE_SECRET = ORIG_INTERNAL_SECRET;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publishBoltEvent', () => {
  it('POSTs the canonical event envelope to the configured ingest endpoint', async () => {
    const { captured } = installFetchMock(async () => new Response('{}', { status: 200 }));

    await publishBoltEvent(
      'task.created',
      'bam',
      { task: { id: 't-1' } },
      'org-1',
      'user-1',
      'user',
      { boltApiUrl: 'http://test-bolt:4006', internalSecret: 'shh' },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('http://test-bolt:4006/v1/events/ingest');
    expect(captured[0].init.method).toBe('POST');
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Internal-Secret']).toBe('shh');

    const body = JSON.parse(String(captured[0].init.body));
    expect(body).toEqual({
      event_type: 'task.created',
      source: 'bam',
      payload: { task: { id: 't-1' } },
      org_id: 'org-1',
      actor_id: 'user-1',
      actor_type: 'user',
    });
  });

  it("defaults actor_type to 'system' when actorId is omitted", async () => {
    const { captured } = installFetchMock(async () => new Response('{}', { status: 200 }));

    await publishBoltEvent(
      'deal.rotting',
      'bond',
      { deal: { id: 'd-1' } },
      'org-2',
      undefined,
      undefined,
      { boltApiUrl: 'http://test-bolt:4006' },
    );

    const body = JSON.parse(String(captured[0].init.body));
    expect(body.actor_id).toBeUndefined();
    expect(body.actor_type).toBe('system');
    expect(body.source).toBe('bond');
  });

  it("defaults actor_type to 'user' when actorId is set", async () => {
    const { captured } = installFetchMock(async () => new Response('{}', { status: 200 }));

    await publishBoltEvent(
      'task.updated',
      'bam',
      {},
      'org-3',
      'user-9',
      undefined,
      { boltApiUrl: 'http://test-bolt:4006' },
    );

    const body = JSON.parse(String(captured[0].init.body));
    expect(body.actor_id).toBe('user-9');
    expect(body.actor_type).toBe('user');
  });

  it('logs and swallows non-2xx responses without throwing', async () => {
    installFetchMock(async () => new Response('boom', { status: 500 }));
    const logger = createLogger();

    await expect(
      publishBoltEvent(
        'task.created',
        'bam',
        {},
        'org-1',
        'user-1',
        'user',
        { boltApiUrl: 'http://test-bolt:4006', logger },
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0];
    expect(call[0]).toMatchObject({ eventType: 'task.created', source: 'bam', orgId: 'org-1', status: 500 });
    expect(call[1]).toMatch(/non-2xx/);
  });

  it('logs and swallows network errors without throwing', async () => {
    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    const logger = createLogger();

    await expect(
      publishBoltEvent(
        'task.created',
        'bam',
        {},
        'org-1',
        undefined,
        'system',
        { boltApiUrl: 'http://test-bolt:4006', logger },
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0];
    expect(call[0]).toMatchObject({ eventType: 'task.created', source: 'bam', orgId: 'org-1' });
    expect(String((call[0] as { err: string }).err)).toMatch(/connection refused/);
    expect(call[1]).toMatch(/swallowed/);
  });

  it('respects BOLT_API_INTERNAL_URL and INTERNAL_SERVICE_SECRET env defaults', async () => {
    process.env.BOLT_API_INTERNAL_URL = 'http://env-bolt:4006';
    process.env.INTERNAL_SERVICE_SECRET = 'env-secret';
    const { captured } = installFetchMock(async () => new Response('{}', { status: 200 }));

    await publishBoltEvent('task.created', 'bam', {}, 'org-1');

    expect(captured[0].url).toBe('http://env-bolt:4006/v1/events/ingest');
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers['X-Internal-Secret']).toBe('env-secret');
  });
});
