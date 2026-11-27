import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// POST /org/smtp-settings/test connects to the org admin's own SMTP host and
// reports the outcome, which let an org admin probe the platform's internal
// network. An org-supplied host must not be private or internal; the
// operator-configured platform relay may be.

const { createTransport, orgSettings } = vi.hoisted(() => ({
  createTransport: vi.fn(() => ({ verify: vi.fn(async () => true), sendMail: vi.fn(async () => ({})) })),
  orgSettings: { value: {} as Record<string, unknown> },
}));

vi.mock('../src/env.js', () => ({
  env: { NODE_ENV: 'test', SESSION_TTL_SECONDS: 604800, LOG_LEVEL: 'silent', SMTP_HOST: undefined },
}));
vi.mock('../src/db/index.js', () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = async () => [];
  return { db: chain, connection: { end: vi.fn() } };
});
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async () => {},
  requireScope: () => async () => {},
}));
vi.mock('../src/services/org.service.js', () => ({
  getOrganizationCached: async () => ({ id: 'org-1', settings: orgSettings.value }),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import orgRoutes from '../src/routes/org.routes.js';

describe('POST /org/smtp-settings/test egress', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    app = Fastify({ logger: false });
    app.decorate('requireCan', () => async () => {});
    app.decorate('redis', {});
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (req) => {
      (req as unknown as { user: unknown }).user = { id: 'u1', org_id: 'org-1', role: 'admin', is_superuser: false };
    });
    await app.register(orgRoutes);
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => createTransport.mockClear());

  const smtp = (host: string) => ({ smtp: { host, port: 25, from: 'ops@acme.example' } });

  it.each(['10.0.0.12', '127.0.0.1', '169.254.169.254', 'localhost', 'redis.internal'])(
    'refuses an org relay at %s without connecting',
    async (host) => {
      orgSettings.value = smtp(host);
      const res = await app.inject({ method: 'POST', url: '/org/smtp-settings/test', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().data.error).toMatch(/not an allowed destination/);
      expect(createTransport).not.toHaveBeenCalled();
    },
  );

  it('connects to a public org relay', async () => {
    orgSettings.value = smtp('203.0.114.10');
    await app.inject({ method: 'POST', url: '/org/smtp-settings/test', payload: {} });
    expect(createTransport).toHaveBeenCalledTimes(1);
  });
});
