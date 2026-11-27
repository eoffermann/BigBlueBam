import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  carriesInternalToken,
  createInternalSecretGuard,
  internalSecretPreHandler,
  isPrivateNetworkAddress,
  sameSecret,
} from './index.js';

// #252: the shared internal-route guard every service uses.

const SECRET = 's'.repeat(40);

function app(secret: string | undefined, opts: { acceptTokenHeader?: boolean; tokenHeaderOnly?: boolean } = {}) {
  const f = Fastify();
  const guard = createInternalSecretGuard({ secrets: () => [secret], ...opts });
  f.post('/internal/inline', async (request, reply) => {
    if (!guard(request, reply)) return reply;
    return { ok: true };
  });
  f.post('/internal/hook', { preHandler: [internalSecretPreHandler(guard)] }, async () => ({ ok: true }));
  return f;
}

describe('createInternalSecretGuard', () => {
  it('accepts the right secret in either header name, inline and as a preHandler', async () => {
    const f = app(SECRET);
    for (const url of ['/internal/inline', '/internal/hook']) {
      for (const header of ['x-internal-secret', 'x-internal-service-secret']) {
        const res = await f.inject({ method: 'POST', url, headers: { [header]: SECRET } });
        expect(res.statusCode, `${url} ${header}`).toBe(200);
      }
    }
  });

  it('refuses a wrong or missing secret with 401', async () => {
    const f = app(SECRET);
    expect((await f.inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-secret': 'nope' } })).statusCode).toBe(401);
    expect((await f.inject({ method: 'POST', url: '/internal/hook' })).statusCode).toBe(401);
  });

  it('fails CLOSED when no secret is configured (never "unprotected")', async () => {
    for (const configured of [undefined, '']) {
      const f = app(configured);
      const res = await f.inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-secret': '' } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('refuses a request relayed by the edge nginx (X-Forwarded-For) with 403, even with the right secret', async () => {
    const f = app(SECRET);
    const res = await f.inject({
      method: 'POST',
      url: '/internal/inline',
      headers: { 'x-internal-secret': SECRET, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a caller whose socket peer is public', async () => {
    const f = app(SECRET);
    const res = await f.inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-secret': SECRET }, remoteAddress: '203.0.113.9' });
    expect(res.statusCode).toBe(403);
  });

  it('reads x-internal-token only when asked to', async () => {
    expect((await app(SECRET).inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-token': SECRET } })).statusCode).toBe(401);
    expect(
      (await app(SECRET, { acceptTokenHeader: true }).inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-token': SECRET } }))
        .statusCode,
    ).toBe(200);
  });

  // #306: the HB-7 helpdesk pair reads only x-internal-token, through this guard.
  it('tokenHeaderOnly reads x-internal-token and ignores the secret headers', async () => {
    const f = app(SECRET, { tokenHeaderOnly: true });
    expect((await f.inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-token': SECRET } })).statusCode).toBe(200);
    expect((await f.inject({ method: 'POST', url: '/internal/inline', headers: { 'x-internal-secret': SECRET } })).statusCode).toBe(401);
    const relayed = await f.inject({
      method: 'POST',
      url: '/internal/inline',
      headers: { 'x-internal-token': SECRET, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(relayed.statusCode).toBe(403);
  });
});

describe('carriesInternalToken', () => {
  it('reports only a non-empty x-internal-token header', async () => {
    const f = Fastify();
    f.get('/probe', async (request) => ({ carries: carriesInternalToken(request) }));
    expect((await f.inject({ url: '/probe', headers: { 'x-internal-token': 't' } })).json().carries).toBe(true);
    expect((await f.inject({ url: '/probe', headers: { 'x-internal-token': '' } })).json().carries).toBe(false);
    expect((await f.inject({ url: '/probe', headers: { 'x-internal-secret': 't' } })).json().carries).toBe(false);
  });
});

describe('isPrivateNetworkAddress', () => {
  it('admits compose, loopback and the Railway fc00::/7 private network; refuses public addresses', () => {
    for (const a of ['172.18.0.12', '10.1.2.3', '192.168.1.5', '127.0.0.1', '::1', '::ffff:172.18.0.4', 'fd12:3456::1']) {
      expect(isPrivateNetworkAddress(a), a).toBe(true);
    }
    for (const a of ['172.32.0.1', '8.8.8.8', '2001:db8::1', '', undefined]) {
      expect(isPrivateNetworkAddress(a as string), String(a)).toBe(false);
    }
  });
});

describe('sameSecret', () => {
  it('is plain equality, in constant time', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});
