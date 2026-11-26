import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { buildFastifyOptions } from '../src/lib/fastify-options.js';
import { resolveTrustProxy } from '../src/lib/trust-proxy.js';

// Spec 5.2: per-route limits key on the resolved client IP, so a spoofed leftmost
// X-Forwarded-For entry must never be the one trusted.

async function ipFor(hops: number, xff?: string): Promise<string> {
  const app = Fastify({
    ...buildFastifyOptions({ LOG_LEVEL: 'silent', NODE_ENV: 'test', BASTION_TRUST_PROXY_HOPS: hops }),
    logger: false,
  });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress: '10.0.0.5',
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('BASTION_TRUST_PROXY_HOPS -> Fastify trustProxy', () => {
  it('maps hops to a number and 0 to false; never `true`', () => {
    expect(resolveTrustProxy(1)).toBe(1);
    expect(resolveTrustProxy(2)).toBe(2);
    expect(resolveTrustProxy(0)).toBe(false);
    expect(() => resolveTrustProxy(-1)).toThrow(/whole number/);
    expect(() => resolveTrustProxy(1.5)).toThrow(/whole number/);
    expect(buildFastifyOptions({ LOG_LEVEL: 'info', NODE_ENV: 'production', BASTION_TRUST_PROXY_HOPS: 1 }).trustProxy).toBe(1);
  });

  it('compose (1 hop, nginx): the client IP is the entry nginx appended, not a spoofed one', async () => {
    // Client sent "X-Forwarded-For: 6.6.6.6"; nginx appended the real peer 203.0.113.9.
    expect(await ipFor(1, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('Railway (2 hops): skips exactly two proxies', async () => {
    expect(await ipFor(2, '6.6.6.6, 203.0.113.9, 100.64.0.2')).toBe('203.0.113.9');
  });

  it('0 hops ignores X-Forwarded-For entirely', async () => {
    expect(await ipFor(0, '6.6.6.6')).toBe('10.0.0.5');
  });
});
