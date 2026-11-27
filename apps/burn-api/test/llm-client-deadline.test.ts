import { afterEach, describe, expect, it, vi } from 'vitest';

// #283: burn's LLM client sends LLM_TIMEOUT_MS to the proxy as timeout_ms and reads a 504 as a
// typed timeout (still an LlmError, so extraction and attribution defer it the same way).

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 's'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000', LLM_TIMEOUT_MS: 90_000 },
}));

const { llmChat, LlmError, LlmTimeoutError } = await import('../src/lib/llm-client.js');

describe('burn llmChat deadline (#283)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends timeout_ms and maps 504 to LlmTimeoutError', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    const err = await llmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err).toBeInstanceOf(LlmError);
    const [, init] = f.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).timeout_ms).toBe(90_000);
    expect(init.headers['X-Internal-Service']).toBe('burn');
  });

  it('returns the text on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { content: 'hello' } }) })));
    expect(await llmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }] })).toBe('hello');
  });
});
