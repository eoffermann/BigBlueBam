// createHttpPermissionChecker (issue #166): the boolean probe the Bureau
// WebSocket hub uses. Same resolver call and mode semantics as requireCan.
import { describe, expect, it, vi } from 'vitest';
import { createHttpPermissionChecker, DEFAULT_RESOLVER_TIMEOUT_MS, resolveViaHttp } from '../index.js';

function fakeFetch(decision: 'allow' | 'deny' | 'error' | 'throw') {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    if (decision === 'throw') throw new Error('ECONNREFUSED');
    if (decision === 'error') return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ data: { decision } }), { status: 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const base = { apiInternalUrl: 'http://api:4000/', internalSecret: 's' };
const caller = { user_id: 'u', org_id: 'o' };

describe('createHttpPermissionChecker', () => {
  it('posts to the dual-read endpoint with the internal secret and scope', async () => {
    const f = fakeFetch('allow');
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f });
    expect(await check(caller, 'bureau.summon.create')).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api:4000/internal/permissions/dual-read');
    expect((init!.headers as Record<string, string>)['X-Internal-Secret']).toBe('s');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      user_id: 'u',
      permission_id: 'bureau.summon.create',
      scope: { org_id: 'o', project_id: null },
    });
  });

  it('denies on an explicit deny in on mode', async () => {
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'allow', fetchImpl: fakeFetch('deny') });
    expect(await check(caller, 'x.y.z')).toBe(false);
  });

  it('fails closed on resolver errors when onUnknown is deny, open when allow', async () => {
    for (const d of ['error', 'throw'] as const) {
      expect(await createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: fakeFetch(d) })(caller, 'x.y.z')).toBe(false);
      expect(await createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'allow', fetchImpl: fakeFetch(d) })(caller, 'x.y.z')).toBe(true);
    }
  });

  it('off never calls the resolver; warn calls it but allows', async () => {
    const off = fakeFetch('deny');
    expect(await createHttpPermissionChecker({ ...base, mode: 'off', onUnknown: 'deny', fetchImpl: off })(caller, 'x.y.z')).toBe(true);
    expect(off).not.toHaveBeenCalled();
    const warn = fakeFetch('deny');
    expect(await createHttpPermissionChecker({ ...base, mode: 'warn', onUnknown: 'deny', fetchImpl: warn })(caller, 'x.y.z')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('memoizes decisions for the TTL but never caches an unknown', async () => {
    let t = 0;
    const f = fakeFetch('allow');
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f, cacheTtlMs: 1000, now: () => t });
    await check(caller, 'a.b.c');
    await check(caller, 'a.b.c');
    expect(f).toHaveBeenCalledTimes(1);
    t = 1001;
    await check(caller, 'a.b.c');
    expect(f).toHaveBeenCalledTimes(2);

    const flaky = fakeFetch('throw');
    const c2 = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: flaky, now: () => 0 });
    await c2(caller, 'a.b.c');
    await c2(caller, 'a.b.c');
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

// Issue #183: an api that accepts the connection and never answers.
function hangingFetch(opts: { honorSignal: boolean }) {
  const signals: AbortSignal[] = [];
  const f = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (signal) signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (opts.honorSignal && signal) signal.addEventListener('abort', () => reject(signal.reason));
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { f, signals };
}

describe('resolver timeout, single-flight and eviction (issue #183)', () => {
  it('a resolver that never answers denies within the timeout in on/deny mode, and aborts the request', async () => {
    const { f, signals } = hangingFetch({ honorSignal: true });
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f, timeoutMs: 50 });
    const started = Date.now();
    expect(await check(caller, 'bureau.knock.create')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signals[0]!.aborted).toBe(true);
  });

  it('settles even when the fetch implementation ignores the abort signal', async () => {
    const { f } = hangingFetch({ honorSignal: false });
    const warn = vi.fn();
    expect(await resolveViaHttp({ ...base, fetchImpl: f, timeoutMs: 30 }, 'u', 'x.y.z', { org_id: 'o', project_id: null }, { warn })).toBe('unknown');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ timeout_ms: 30 }), expect.any(String));
  });

  it('onUnknown allow passes through on a timeout (unchanged pass-through posture)', async () => {
    const { f } = hangingFetch({ honorSignal: true });
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'allow', fetchImpl: f, timeoutMs: 20 });
    expect(await check(caller, 'x.y.z')).toBe(true);
  });

  it('the timeout defaults to BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS, then 3000', async () => {
    const { f } = hangingFetch({ honorSignal: true });
    const prev = process.env.BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS;
    process.env.BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS = '25';
    try {
      const started = Date.now();
      expect(await resolveViaHttp({ ...base, fetchImpl: f }, 'u', 'x.y.z', { org_id: 'o', project_id: null })).toBe('unknown');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      if (prev === undefined) delete process.env.BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS;
      else process.env.BBB_PERMISSIONS_RESOLVER_TIMEOUT_MS = prev;
    }
    expect(DEFAULT_RESOLVER_TIMEOUT_MS).toBe(3000);
  });

  it('concurrent misses for the same key share one POST', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: { decision: 'allow' } }), { status: 200 });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f });
    const results = Promise.all(Array.from({ length: 20 }, () => check(caller, 'bureau.chat.create')));
    const other = check(caller, 'bureau.knock.create');
    release();
    expect(await results).toEqual(Array(20).fill(true));
    expect(await other).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('concurrent misses during a stall share one timed-out POST, and the next miss retries', async () => {
    const { f } = hangingFetch({ honorSignal: true });
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f, timeoutMs: 30 });
    expect(await Promise.all([check(caller, 'a.b.c'), check(caller, 'a.b.c'), check(caller, 'a.b.c')])).toEqual([false, false, false]);
    expect(f).toHaveBeenCalledTimes(1);
    await check(caller, 'a.b.c');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('at the size cap evicts the least recently used decision, not the whole cache', async () => {
    const f = fakeFetch('allow');
    const check = createHttpPermissionChecker({ ...base, mode: 'on', onUnknown: 'deny', fetchImpl: f, maxCacheEntries: 3, now: () => 0 });
    await check(caller, 'p.1.x');
    await check(caller, 'p.2.x');
    await check(caller, 'p.3.x');
    await check(caller, 'p.1.x'); // hit: p.1 becomes most recently used
    expect(f).toHaveBeenCalledTimes(3);
    await check(caller, 'p.4.x'); // evicts p.2 only
    expect(f).toHaveBeenCalledTimes(4);
    await check(caller, 'p.1.x');
    await check(caller, 'p.3.x');
    await check(caller, 'p.4.x');
    expect(f).toHaveBeenCalledTimes(4);
    await check(caller, 'p.2.x');
    expect(f).toHaveBeenCalledTimes(5);
  });
});
