import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM_CALL_TIMEOUT_MAX_MS, llmHoldWindowMs } from '@bigbluebam/shared';
import { COMPILE_SLICE_LOCK_MS, cutOffAdvice, takeSliceLock, timeoutAdvice } from '../src/services/compile-ai.service.js';
import { LlmError, LlmTimeoutError } from '../src/lib/llm-errors.js';
import { LLM_SLICE_START_CUTOFF_MS, RUN_LEASE_MS } from '../src/engine/budgets.js';

vi.mock('../src/env.js', () => ({
  env: { INTERNAL_SERVICE_SECRET: 's'.repeat(32), BBB_API_INTERNAL_URL: 'http://api:4000', BASTION_LLM_TIMEOUT_MS: 120_000 },
}));
import { PROBE_CATALOG } from '../src/library/probe-catalog.js';
import { decide, probeDefinition } from '../src/probes/definitions.js';
import { RELEASE_IF_OWNER_LUA, redisSliceLock, type SliceLockRedis } from '../src/lib/slice-lock.js';

/** A tiny Redis: SET PX NX and the compare-and-delete script, or every call failing. */
function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis: SliceLockRedis & { store: Map<string, string> } = {
    store,
    async set(key, value) {
      if (opts.down) throw new Error('ECONNREFUSED');
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(script, _n, key, token) {
      if (opts.down) throw new Error('ECONNREFUSED');
      expect(script).toBe(RELEASE_IF_OWNER_LUA);
      if (store.get(key!) === token) {
        store.delete(key!);
        return 1;
      }
      return 0;
    },
  };
  return redis;
}

const log = { lines: [] as string[], warn(_o: object, m?: string) { if (m) this.lines.push(m); } };

describe('policy.attested v2 decides on the article state (#244)', () => {
  const def = probeDefinition('policy.attested')!;
  const result = (summary: Record<string, unknown>) =>
    ({ probe_key: 'policy.attested', probe_version: 2, as_of: new Date().toISOString(), summary, cited_refs: [], cited_count: 0, overflow_count: 0 }) as never;
  it('a retired or expired article fails, a missing one is unprovable, a current one is judged on who read it', () => {
    expect(decide(def, result({ policy_found: true, article_state: 'retired', required_people: 3, not_attested: 0 }), {})).toEqual({ outcome: 'fail' });
    expect(decide(def, result({ policy_found: true, article_state: 'expired', required_people: 3, not_attested: 0 }), {})).toEqual({ outcome: 'fail' });
    expect(decide(def, result({ policy_found: true, article_state: 'missing', required_people: 3, not_attested: 0 }), {})).toEqual({
      outcome: 'unprovable',
      reason: 'no_evidence_source',
    });
    expect(decide(def, result({ policy_found: true, article_state: 'current', required_people: 3, not_attested: 0 }), {})).toEqual({ outcome: 'pass' });
    expect(decide(def, result({ policy_found: true, article_state: 'current', required_people: 3, not_attested: 1 }), {})).toEqual({ outcome: 'fail' });
    expect(def.explain(result({ policy_found: true, article_state: 'retired' }), false)).toContain('retired');
  });
  it('the catalog runs v2', () => {
    expect(PROBE_CATALOG.find((p) => p.key === 'policy.attested')?.version).toBe(2);
  });
});

describe('one LLM deadline (#257)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the client sends its deadline to the proxy and reads a 504 as a timeout, not a provider failure', async () => {
    const { llmChat } = await import('../src/lib/llm-client.js');
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 504,
      headers: new Headers(),
      json: async () => ({ error: { code: 'UPSTREAM_TIMEOUT' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await llmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err).toBeInstanceOf(LlmError);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body));
    expect(sent.timeout_ms).toBe(120_000);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({ error: { code: 'UPSTREAM_ERROR' } }) })));
    const other = await llmChat({ providerId: 'p', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 }).catch((e) => e);
    expect(other).toBeInstanceOf(LlmError);
    expect(other).not.toBeInstanceOf(LlmTimeoutError);
  });

  it('hold windows and the slice lock outlive the longest allowed call; one call fits in the run lease', () => {
    expect(llmHoldWindowMs(120_000)).toBeGreaterThan(120_000);
    expect(COMPILE_SLICE_LOCK_MS).toBeGreaterThan(LLM_SLICE_START_CUTOFF_MS + LLM_CALL_TIMEOUT_MAX_MS);
    expect(LLM_CALL_TIMEOUT_MAX_MS).toBeLessThan(RUN_LEASE_MS);
  });

  it('the operator advice names the right knob for each case', () => {
    const t = timeoutAdvice({ maxTokens: 8192, llmTimeoutMs: 60_000 });
    expect(t).toContain('raise BASTION_LLM_TIMEOUT_MS (now 60 s');
    expect(t).toContain('Do not raise BASTION_LLM_MAX_TOKENS');
    expect(timeoutAdvice({ maxTokens: 8192, llmTimeoutMs: LLM_CALL_TIMEOUT_MAX_MS })).toContain('lower BASTION_LLM_MAX_TOKENS');
    const c = cutOffAdvice({ maxTokens: 8192, llmTimeoutMs: 60_000 });
    expect(c).toContain('raise BASTION_LLM_MAX_TOKENS AND raise BASTION_LLM_TIMEOUT_MS');
  });
});

describe('slice lock (#242)', () => {
  it('a slice that outlived its TTL cannot delete the next slice lock (compare-and-delete)', async () => {
    const redis = fakeRedis();
    const lock = redisSliceLock(redis);
    const a = await lock.acquire('run-1', 1000);
    expect(a).toBeTruthy();
    expect(await lock.acquire('run-1', 1000)).toBeNull();
    // A's TTL lapses; B takes the lock.
    redis.store.delete('bastion:compile:slice:run-1');
    const b = await lock.acquire('run-1', 1000);
    expect(b).toBeTruthy();
    // A finally finishes and releases with its own (stale) token: B keeps the lock.
    await lock.release('run-1', a!);
    expect(redis.store.get('bastion:compile:slice:run-1')).toBe(b);
    await lock.release('run-1', b!);
    expect(redis.store.has('bastion:compile:slice:run-1')).toBe(false);
  });

  it('a Redis error is never "acquired": acquire throws and the caller falls back to the Postgres fence', async () => {
    const lock = redisSliceLock(fakeRedis({ down: true }));
    await expect(lock.acquire('run-1', 1000)).rejects.toThrow('ECONNREFUSED');
    expect(await takeSliceLock(lock, 'run-1', 1000, log)).toBe('unavailable');
    expect(log.lines.some((l) => l.includes('slice_token alone fences'))).toBe(true);
    // Held elsewhere is a plain null (report the slice running), not 'unavailable'.
    const up = redisSliceLock(fakeRedis());
    await up.acquire('run-2', 1000);
    expect(await takeSliceLock(up, 'run-2', 1000, log)).toBeNull();
  });
});
