import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseRateLimitMultiplier, registerGlobalRateLimit, resolveGlobalRateLimit } from './index.js';

// #411: the one global rate-limit registration and its e2e relaxation rule.

describe('resolveGlobalRateLimit', () => {
  const base = { max: 100, timeWindow: 60_000 };

  it('stays strict in production when the flag is unset', () => {
    const r = resolveGlobalRateLimit({ ...base, nodeEnv: 'production', env: {} });
    expect(r).toMatchObject({ max: 100, permissive: false, explicitFlag: false });
  });

  it('stays strict in production when the flag is explicitly false', () => {
    for (const v of ['false', '0', 'no', 'off', '']) {
      const r = resolveGlobalRateLimit({ ...base, nodeEnv: 'production', env: { BBB_E2E_PERMISSIVE_RATE_LIMIT: v } });
      expect(r.max).toBe(100);
    }
  });

  it('relaxes production only when the flag is set to a true value', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      const r = resolveGlobalRateLimit({ ...base, nodeEnv: 'production', env: { BBB_E2E_PERMISSIVE_RATE_LIMIT: v } });
      expect(r).toMatchObject({ max: 10_000, permissive: true, explicitFlag: true, multiplier: 100 });
    }
  });

  it('relaxes every non-production NODE_ENV without the flag', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      const r = resolveGlobalRateLimit({ ...base, nodeEnv, env: {} });
      expect(r).toMatchObject({ max: 10_000, permissive: true, explicitFlag: false });
    }
  });

  it('honours RATE_LIMIT_E2E_MULTIPLIER', () => {
    const r = resolveGlobalRateLimit({
      ...base,
      nodeEnv: 'production',
      env: { BBB_E2E_PERMISSIVE_RATE_LIMIT: '1', RATE_LIMIT_E2E_MULTIPLIER: '7' },
    });
    expect(r.max).toBe(700);
  });

  it('refuses a misspelled flag or a bad multiplier instead of picking a side', () => {
    expect(() =>
      resolveGlobalRateLimit({ ...base, nodeEnv: 'production', env: { BBB_E2E_PERMISSIVE_RATE_LIMIT: 'enabled' } }),
    ).toThrow(/BBB_E2E_PERMISSIVE_RATE_LIMIT/);
    expect(() => parseRateLimitMultiplier('0')).toThrow(/RATE_LIMIT_E2E_MULTIPLIER/);
    expect(() => parseRateLimitMultiplier('2.5')).toThrow(/RATE_LIMIT_E2E_MULTIPLIER/);
    expect(parseRateLimitMultiplier(undefined)).toBe(100);
    expect(parseRateLimitMultiplier('')).toBe(100);
  });
});

describe('registerGlobalRateLimit', () => {
  async function hit(app: ReturnType<typeof Fastify>, url: string, n: number) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await app.inject({ method: 'GET', url })).statusCode);
    return codes;
  }

  it('enforces the strict ceiling in production and leaves per-route limits as they are', async () => {
    const app = Fastify();
    await registerGlobalRateLimit(app, { max: 3, timeWindow: 60_000, nodeEnv: 'production', env: {} });
    app.get('/global', async () => ({ ok: true }));
    app.get('/route', { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, async () => ({ ok: true }));
    await app.ready();
    expect(await hit(app, '/global', 4)).toEqual([200, 200, 200, 429]);
    expect(await hit(app, '/route', 2)).toEqual([200, 429]);
    await app.close();
  });

  it('raises the global ceiling under the flag but keeps per-route limits', async () => {
    const app = Fastify();
    await registerGlobalRateLimit(app, {
      max: 3,
      timeWindow: 60_000,
      nodeEnv: 'production',
      env: { BBB_E2E_PERMISSIVE_RATE_LIMIT: '1', RATE_LIMIT_E2E_MULTIPLIER: '2' },
    });
    app.get('/global', async () => ({ ok: true }));
    app.get('/route', { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, async () => ({ ok: true }));
    await app.ready();
    expect(await hit(app, '/global', 7)).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(await hit(app, '/route', 2)).toEqual([200, 429]);
    await app.close();
  });

  it('passes extra options such as keyGenerator through', async () => {
    const app = Fastify();
    await registerGlobalRateLimit(app, {
      max: 1,
      timeWindow: 60_000,
      nodeEnv: 'production',
      env: {},
      extra: { keyGenerator: (req) => String(req.headers['x-who'] ?? 'anon') },
    });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();
    const a = await app.inject({ method: 'GET', url: '/x', headers: { 'x-who': 'a' } });
    const b = await app.inject({ method: 'GET', url: '/x', headers: { 'x-who': 'b' } });
    const a2 = await app.inject({ method: 'GET', url: '/x', headers: { 'x-who': 'a' } });
    expect([a.statusCode, b.statusCode, a2.statusCode]).toEqual([200, 200, 429]);
    await app.close();
  });
});
