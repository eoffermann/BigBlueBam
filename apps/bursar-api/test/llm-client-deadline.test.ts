import { afterEach, describe, expect, it, vi } from 'vitest';

// #283: bursar's LLM client sends BURSAR_LLM_TIMEOUT_MS to the proxy as timeout_ms (before, it
// only aborted on its own side, so the proxy still cut every call at 60 s) and reads a 504 as a
// typed timeout that is still an LlmError for the derivation engine.

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 's'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000', BURSAR_LLM_TIMEOUT_MS: 120_000 },
}));

const { llmChat, LlmError, LlmTimeoutError } = await import('../src/lib/llm-client.js');

describe('bursar llmChat deadline (#283)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends timeout_ms and the bursar service header, and maps 504 to LlmTimeoutError', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 504, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }) }));
    vi.stubGlobal('fetch', f);
    const err = await llmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err).toBeInstanceOf(LlmError);
    const [, init] = f.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body).timeout_ms).toBe(120_000);
    expect(init.headers['X-Internal-Service']).toBe('bursar');
  });
});
