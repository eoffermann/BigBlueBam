import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { LLM_CALL_TIMEOUT_DEFAULT_MS, LLM_CALL_TIMEOUT_MAX_MS, llmCallDeadlineMs, llmHoldWindowMs } from '@bigbluebam/shared';

// #257: the internal LLM proxy's upstream deadline is per request (clamped to a cap), and a call
// that runs past it answers 504 UPSTREAM_TIMEOUT instead of a generic 502, so callers can count
// timeouts apart from provider failures.

vi.mock('../src/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', INTERNAL_SERVICE_SECRET: 's'.repeat(32) },
}));

const PROVIDER = {
  id: '22222222-2222-4222-8222-222222222222',
  enabled: true,
  provider_type: 'openai',
  api_endpoint: 'https://llm.example.test',
  api_key_encrypted: 'enc',
  model_id: 'm',
  max_tokens: 1024,
  temperature: null,
};

vi.mock('../src/db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [PROVIDER] }) }) }),
  },
  connection: { end: vi.fn() },
}));
vi.mock('../src/services/llm-provider.service.js', () => ({ decryptApiKey: () => 'key' }));
vi.mock('../src/lib/internal-secret.js', () => ({ requireInternalSecretOrHelpdeskToken: async () => {} }));

const { default: internalLlmRoutes } = await import('../src/routes/internal-llm.routes.js');

const timeouts: number[] = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);

describe('internal LLM proxy deadline (#257)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    timeouts.length = 0;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    app = Fastify({ logger: false });
    await app.register(internalLlmRoutes, { prefix: '/internal/llm' });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await app.close();
  });

  const chat = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/internal/llm/chat',
      headers: { 'x-internal-service': 'bastion' },
      payload: { provider_id: PROVIDER.id, messages: [{ role: 'user', content: 'hi' }], ...extra },
    });

  it('applies the caller deadline, the default without one, and refuses one above the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) })));
    expect((await chat({ timeout_ms: 150_000 })).statusCode).toBe(200);
    expect((await chat()).statusCode).toBe(200);
    expect(timeouts).toEqual([150_000, LLM_CALL_TIMEOUT_DEFAULT_MS]);
    expect((await chat({ timeout_ms: LLM_CALL_TIMEOUT_MAX_MS + 1 })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an upstream call past its deadline answers 504 UPSTREAM_TIMEOUT, not a provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }),
    );
    const res = await chat({ timeout_ms: 90_000 });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect((await chat()).statusCode).toBe(502);
  });

  it('the deadline clamps, and every hold window outlives its call', () => {
    expect(llmCallDeadlineMs(undefined)).toBe(LLM_CALL_TIMEOUT_DEFAULT_MS);
    expect(llmCallDeadlineMs(10 * LLM_CALL_TIMEOUT_MAX_MS)).toBe(LLM_CALL_TIMEOUT_MAX_MS);
    for (const t of [1_000, 60_000, 120_000, LLM_CALL_TIMEOUT_MAX_MS]) expect(llmHoldWindowMs(t)).toBeGreaterThan(t);
  });
});
