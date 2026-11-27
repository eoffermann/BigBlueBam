import { afterEach, describe, expect, it, vi } from 'vitest';

// #283: bulwark's client sends LLM_TIMEOUT_MS to the proxy as timeout_ms (before: never sent, so
// the proxy cut at 60 s whatever the setting) and tells a timeout apart from other failures,
// while still answering null so extraction and drafting degrade the same way.

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 's'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000', LLM_TIMEOUT_MS: 75_000 },
}));

const { internalLlmChat } = await import('../src/lib/internal-llm.client.js');

describe('bulwark internalLlmChat deadline (#283)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends timeout_ms, answers null on a 504 and reports it as a timeout', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kinds: string[] = [];
    const r = await internalLlmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }], onFailure: (k) => kinds.push(k) });
    expect(r).toBeNull();
    expect(kinds).toEqual(['timeout']);
    expect(warn.mock.calls[0]?.[0]).toContain('raise LLM_TIMEOUT_MS');
    const [, init] = f.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).timeout_ms).toBe(75_000);
    expect(init.headers['X-Internal-Service']).toBe('bulwark');
    warn.mockRestore();
  });

  it('a provider failure is an error, not a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_ERROR' } }) })));
    const kinds: string[] = [];
    expect(await internalLlmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }], onFailure: (k) => kinds.push(k) })).toBeNull();
    expect(kinds).toEqual(['error']);
  });
});
