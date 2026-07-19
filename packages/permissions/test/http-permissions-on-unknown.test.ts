import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { httpPermissionsPlugin } from '../src/index.js';

/**
 * Fail-closed behavior of httpPermissionsPlugin on the resolver ERROR path (issue #89).
 *
 * Enforcement mode 'on' is not by itself fail-closed. The plugin returns 'unknown' when
 * the resolver answers non-2xx, returns a body it cannot read a decision out of, or the
 * fetch throws, and historically 'unknown' fell through the preHandler and the route ran.
 * That is correct for satellites with a legacy requireAuth plus org-role gate behind
 * requireCan, and wrong for an app where requireCan is the only gate.
 *
 * These tests pin BOTH halves: the default stays pass-through so the 21 existing
 * satellites are unaffected, and onUnknown: 'deny' turns every unresolvable decision into
 * a 403.
 */

const USER_ID = '44444444-4444-4444-8444-444444444444';

async function buildApp(onUnknown?: 'allow' | 'deny') {
  const app = Fastify({ logger: false });
  await app.register(httpPermissionsPlugin, {
    mode: 'on',
    apiInternalUrl: 'http://api:4000',
    internalSecret: 'x'.repeat(32),
    getCaller: () => ({ user_id: USER_ID, org_id: 'org-a' }),
    ...(onUnknown ? { onUnknown } : {}),
  });
  app.get(
    '/guarded',
    { preHandler: app.requireCan('burn.costrate.read') },
    async () => ({ data: { cost_amount: 19_500 } }),
  );
  return app;
}

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => body });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpPermissionsPlugin onUnknown', () => {
  it('denies on a non-2xx resolver response when onUnknown is deny', async () => {
    stubFetch(() => jsonResponse({}, false, 401));
    const app = await buildApp('deny');
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('denies when the resolver fetch throws and onUnknown is deny', async () => {
    stubFetch(() => Promise.reject(new Error('connect ECONNREFUSED api:4000')));
    const app = await buildApp('deny');
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('denies on a resolver body with no usable decision when onUnknown is deny', async () => {
    stubFetch(() => jsonResponse({ data: { decision: 'maybe' } }));
    const app = await buildApp('deny');
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('still allows an explicit allow decision under onUnknown deny', async () => {
    stubFetch(() => jsonResponse({ data: { decision: 'allow' } }));
    const app = await buildApp('deny');
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cost_amount).toBe(19_500);
    await app.close();
  });

  it('denies an explicit deny decision regardless of onUnknown', async () => {
    stubFetch(() => jsonResponse({ data: { decision: 'deny' } }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // The two below are the compatibility guarantee for the 21 satellites that do not pass
  // onUnknown. If either starts returning 403, this change stopped being additive.
  it('DEFAULTS to pass-through on a non-2xx resolver response', async () => {
    stubFetch(() => jsonResponse({}, false, 500));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('DEFAULTS to pass-through when the resolver fetch throws', async () => {
    stubFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api')));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still 401s an unauthenticated caller before consulting the resolver', async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ data: { decision: 'allow' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const app = Fastify({ logger: false });
    await app.register(httpPermissionsPlugin, {
      mode: 'on',
      apiInternalUrl: 'http://api:4000',
      internalSecret: 'x'.repeat(32),
      onUnknown: 'deny',
      getCaller: () => ({ user_id: null, org_id: null }),
    });
    app.get('/guarded', { preHandler: app.requireCan('burn.costrate.read') }, async () => ({
      data: {},
    }));
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
