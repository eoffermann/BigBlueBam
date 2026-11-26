import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM_CALL_TIMEOUT_DEFAULT_MS } from '@bigbluebam/shared';

// #283: Bolt's AI assist reaches the LLM proxy through the shared client: the deadline is the
// proxy's own default sent as timeout_ms (before: a literal 30 s client abort), the session cookie
// is still forwarded, and a 504 is logged as a timeout before falling back to the sample (null).

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 's'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000' },
}));

const { callLlmProxy } = await import('../src/routes/ai-assist.routes.js');

describe('bolt callLlmProxy (#283)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends timeout_ms with the cookie, and a 504 is a logged timeout that falls back', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    const warn = vi.fn();
    const request = { headers: { cookie: 'session=abc' }, log: { warn } } as never;
    const r = await callLlmProxy(request, [{ role: 'user', content: 'x' }], '22222222-2222-4222-8222-222222222222');
    expect(r).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [, init] = f.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).timeout_ms).toBe(LLM_CALL_TIMEOUT_DEFAULT_MS);
    expect(init.headers.cookie).toBe('session=abc');
    expect(init.headers['X-Internal-Service']).toBe('bolt');
  });
});
