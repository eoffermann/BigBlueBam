// createHttpPermissionChecker (issue #166): the boolean probe the Bureau
// WebSocket hub uses. Same resolver call and mode semantics as requireCan.
import { describe, expect, it, vi } from 'vitest';
import { createHttpPermissionChecker } from '../index.js';

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
