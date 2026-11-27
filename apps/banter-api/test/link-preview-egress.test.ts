import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// GET /v1/link-preview fetches a user-supplied URL server-side. It used to
// refuse only localhost, 127.0.0.1 and 0.0.0.0, so any other private or
// metadata address (and any DNS name or redirect leading to one) was fetched.

vi.mock('../src/plugins/auth.js', () => ({ requireAuth: async () => {} }));

const fetchSpy = vi.fn(async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }));

import linkPreviewRoutes from '../src/routes/link-preview.routes.js';

describe('GET /v1/link-preview egress', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    app = Fastify({ logger: false });
    await app.register(linkPreviewRoutes);
    await app.ready();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it.each([
    'http://127.1/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://192.168.1.10/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:10.0.0.1]/',
  ])('refuses %s', async (target) => {
    const res = await app.inject({ method: 'GET', url: `/v1/link-preview?url=${encodeURIComponent(target)}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Cannot preview internal URLs');
  });

  it('never hands a private target to fetch', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
