import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// The one internal-route guard (#226, #233): secret + direct private-network peer, read from the
// TCP socket, never from X-Forwarded-For (the api runs with trustProxy: true).

const SERVICE = 'svc-secret-0123456789abcdef0123456789';
const HELPDESK = 'helpdesk-secret-0123456789abcdef01234';

const envMock = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    INTERNAL_SERVICE_SECRET: '' as string | undefined,
    INTERNAL_HELPDESK_SECRET: '' as string,
  },
}));
vi.mock('../src/env.js', () => envMock);

const lib = await import('../src/lib/internal-secret.js');
const { requireServiceAuth } = await import('../src/middleware/require-service-auth.js');

describe('isPrivateNetworkAddress (real CIDR, not prefixes)', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['172.200.1.1', false],
    ['192.168.1.1', true],
    ['192.169.1.1', false],
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:10.0.0.2', true],
    ['::ffff:172.20.0.2', true],
    ['::ffff:172.40.0.2', false],
    ['::ffff:8.8.8.8', false],
    ['fd12:3456::1', true],
    ['fc00::1', true],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['8.8.8.8', false],
    ['', false],
    [undefined, false],
    ['not-an-ip', false],
  ])('%s -> %s', (addr, expected) => {
    expect(lib.isPrivateNetworkAddress(addr as string | undefined)).toBe(expected);
  });
});

function build(handler: (req: never, reply: never) => unknown): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  app.post('/t', { preHandler: [handler as never] }, async () => ({ ok: true }));
  return app;
}

describe('requireInternalSecret', () => {
  beforeEach(() => {
    envMock.env.INTERNAL_SERVICE_SECRET = SERVICE;
    envMock.env.INTERNAL_HELPDESK_SECRET = HELPDESK;
  });

  it('admits the secret from a direct private peer', async () => {
    const app = build(lib.requireInternalSecret);
    const res = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-service-secret': SERVICE }, remoteAddress: '172.18.0.7' });
    expect(res.statusCode).toBe(200);
    const legacy = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-secret': SERVICE }, remoteAddress: 'fd12::7' });
    expect(legacy.statusCode).toBe(200);
  });

  it('refuses a spoofed X-Forwarded-For from a public peer (the #226 bypass)', async () => {
    const app = build(lib.requireInternalSecret);
    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'x-internal-service-secret': SERVICE, 'x-forwarded-for': '10.0.0.1' },
      remoteAddress: '198.51.100.20',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('refuses a request relayed by the edge proxy even though the proxy is a private peer', async () => {
    const app = build(lib.requireInternalSecret);
    for (const header of ['x-forwarded-for', 'x-real-ip']) {
      const res = await app.inject({
        method: 'POST',
        url: '/t',
        headers: { 'x-internal-service-secret': SERVICE, [header]: '10.0.0.1' },
        remoteAddress: '172.18.0.2',
      });
      expect(res.statusCode, header).toBe(403);
    }
  });

  it('refuses a public peer in the non-private part of 172/8', async () => {
    const app = build(lib.requireInternalSecret);
    const res = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-service-secret': SERVICE }, remoteAddress: '172.64.1.1' });
    expect(res.statusCode).toBe(403);
  });

  it('answers 401 before the network check, and fails closed when unset', async () => {
    const app = build(lib.requireInternalSecret);
    const wrong = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-service-secret': 'nope' }, remoteAddress: '8.8.8.8' });
    expect(wrong.statusCode).toBe(401);
    envMock.env.INTERNAL_SERVICE_SECRET = undefined;
    const unset = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-service-secret': SERVICE } });
    expect(unset.statusCode).toBe(401);
  });

  it('does not accept the helpdesk secret or the x-internal-token header', async () => {
    const app = build(lib.requireInternalSecret);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-secret': HELPDESK } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-token': SERVICE } })).statusCode).toBe(401);
  });
});

describe('requireInternalSecretOrToken / OrHelpdeskToken', () => {
  beforeEach(() => {
    envMock.env.INTERNAL_SERVICE_SECRET = SERVICE;
    envMock.env.INTERNAL_HELPDESK_SECRET = HELPDESK;
  });

  it('OrToken reads x-internal-token but only for the service secret', async () => {
    const app = build(lib.requireInternalSecretOrToken);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-token': SERVICE } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-token': HELPDESK } })).statusCode).toBe(401);
  });

  it('OrHelpdeskToken accepts either secret and still enforces the peer check', async () => {
    const app = build(lib.requireInternalSecretOrHelpdeskToken);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-token': HELPDESK } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-secret': SERVICE } })).statusCode).toBe(200);
    const spoofed = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'x-internal-token': HELPDESK, 'x-forwarded-for': '127.0.0.1' },
      remoteAddress: '203.0.113.1',
    });
    expect(spoofed.statusCode).toBe(403);
  });
});

describe('requireServiceAuth (helpdesk) uses the same peer check', () => {
  beforeEach(() => {
    envMock.env.INTERNAL_HELPDESK_SECRET = HELPDESK;
  });

  it('refuses a spoofed X-Forwarded-For from a public peer', async () => {
    const app = build(requireServiceAuth);
    const res = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'x-internal-token': HELPDESK, 'x-forwarded-for': '172.17.0.1' },
      remoteAddress: '198.51.100.1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('admits a direct private peer', async () => {
    const app = build(requireServiceAuth);
    const res = await app.inject({ method: 'POST', url: '/t', headers: { 'x-internal-token': HELPDESK }, remoteAddress: '10.4.0.9' });
    expect(res.statusCode).toBe(200);
  });
});
