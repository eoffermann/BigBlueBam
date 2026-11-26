import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callInternalLlm,
  internalLlmClientWaitMs,
  LlmError,
  LlmThrottledError,
  LlmTimeoutError,
} from './internal-llm-client.js';
import { LLM_CALL_TIMEOUT_DEFAULT_MS, LLM_CALL_TIMEOUT_MAX_MS, LLM_CLIENT_GRACE_MS } from './llm-deadline.js';
import { internalLlmChatRequestSchema, llmTimeoutEnvSchema } from './schemas/internal-llm.js';

// #283: one client for POST /internal/llm/chat. Every caller sends its deadline as timeout_ms,
// waits the shared grace past it, and reads a 504 as a timeout.

const base = {
  apiBaseUrl: 'http://api:4000/',
  secret: 's'.repeat(32),
  service: 'test',
  providerId: '22222222-2222-4222-8222-222222222222',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as unknown as Response);
}

describe('callInternalLlm (#283)', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the caller deadline as timeout_ms, clamped like the proxy, with the service header', async () => {
    const f = reply(200, { data: { content: 'ok', finish_reason: 'stop', usage: null } });
    const r = await callInternalLlm({ ...base, timeoutMs: 120_000, maxTokens: 50, temperature: 0, fetchImpl: f });
    expect(r).toEqual({ content: 'ok', finish_reason: 'stop', usage: null });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api:4000/internal/llm/chat');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ timeout_ms: 120_000, max_tokens: 50, temperature: 0 });
    // The body the client builds is one the proxy's own schema accepts.
    expect(internalLlmChatRequestSchema.safeParse(sent).success).toBe(true);
    expect((init.headers as Record<string, string>)['X-Internal-Service']).toBe('test');

    const g = reply(200, { data: { content: 'ok' } });
    await callInternalLlm({ ...base, timeoutMs: 10 * LLM_CALL_TIMEOUT_MAX_MS, fetchImpl: g });
    expect(JSON.parse(String((g.mock.calls[0] as unknown as [string, RequestInit])[1].body)).timeout_ms).toBe(LLM_CALL_TIMEOUT_MAX_MS);
    const h = reply(200, { data: { content: 'ok' } });
    await callInternalLlm({ ...base, fetchImpl: h });
    expect(JSON.parse(String((h.mock.calls[0] as unknown as [string, RequestInit])[1].body)).timeout_ms).toBe(LLM_CALL_TIMEOUT_DEFAULT_MS);
  });

  it('maps 504 UPSTREAM_TIMEOUT to LlmTimeoutError, 429 to LlmThrottledError, anything else to LlmError', async () => {
    const t = await callInternalLlm({ ...base, timeoutMs: 90_000, fetchImpl: reply(504, { error: { code: 'UPSTREAM_TIMEOUT' } }) }).catch((e) => e);
    expect(t).toBeInstanceOf(LlmTimeoutError);
    expect(t).toBeInstanceOf(LlmError);
    expect(t.timeoutMs).toBe(90_000);
    const th = await callInternalLlm({ ...base, fetchImpl: reply(429, {}, { 'retry-after': '7' }) }).catch((e) => e);
    expect(th).toBeInstanceOf(LlmThrottledError);
    expect(th.retryAfterSeconds).toBe(7);
    const e = await callInternalLlm({ ...base, fetchImpl: reply(502, { error: { code: 'UPSTREAM_ERROR' } }) }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e).not.toBeInstanceOf(LlmTimeoutError);
    expect(e.code).toBe('UPSTREAM_ERROR');
  });

  it('aborts on its own side only after the deadline plus the shared grace', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const p = callInternalLlm({ ...base, timeoutMs: 30_000, fetchImpl: hang as unknown as typeof fetch }).catch((x) => x);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LLM_CLIENT_GRACE_MS);
    expect(await p).toBeInstanceOf(LlmTimeoutError);
    expect(internalLlmClientWaitMs(30_000)).toBe(30_000 + LLM_CLIENT_GRACE_MS);
  });

  it('refuses to call without the internal secret', async () => {
    const f = reply(200, {});
    await expect(callInternalLlm({ ...base, secret: '', fetchImpl: f })).rejects.toBeInstanceOf(LlmError);
    expect(f).not.toHaveBeenCalled();
  });

  it('a service LLM deadline env var is refused outside the proxy bounds', () => {
    expect(llmTimeoutEnvSchema().parse(undefined)).toBe(LLM_CALL_TIMEOUT_DEFAULT_MS);
    expect(llmTimeoutEnvSchema().parse('120000')).toBe(120_000);
    expect(llmTimeoutEnvSchema().safeParse(String(LLM_CALL_TIMEOUT_MAX_MS + 1)).success).toBe(false);
    expect(llmTimeoutEnvSchema().safeParse('0').success).toBe(false);
  });
});
