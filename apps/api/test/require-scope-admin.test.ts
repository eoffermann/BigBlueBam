import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// requireScope('admin') is the org-admin gate on the org, guest and priority
// routes. Under session auth it used to pass every caller (no key scope), and
// requireCan is a no-op unless BBB_PERMISSIONS_ENFORCE=on, so a member could
// rewrite org SMTP settings or mint API keys for other members.

vi.mock('../src/env.js', () => ({
  env: { NODE_ENV: 'test', SESSION_TTL_SECONDS: 604800, LOG_LEVEL: 'silent' },
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));

import { requireScope } from '../src/plugins/auth.js';

type Identity = { role: string; api_key_scope: string | null; is_superuser?: boolean };

describe("requireScope('admin')", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (req) => {
      const raw = req.headers['x-identity'];
      if (typeof raw === 'string') {
        const who = JSON.parse(raw) as Identity;
        (req as unknown as { user: unknown }).user = { id: 'u1', is_superuser: false, ...who };
      }
    });
    app.patch('/org', { preHandler: [requireScope('admin')] }, async () => ({ ok: true }));
    app.patch('/tasks/x', { preHandler: [requireScope('read_write')] }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(() => app.close());

  const call = (url: string, who: Identity) =>
    app.inject({ method: 'PATCH', url, headers: { 'x-identity': JSON.stringify(who) } });

  it.each(['member', 'viewer', 'guest'])('refuses a %s session', async (role) => {
    const res = await call('/org', { role, api_key_scope: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it.each(['admin', 'owner'])('allows an %s session', async (role) => {
    expect((await call('/org', { role, api_key_scope: null })).statusCode).toBe(200);
  });

  it('allows a SuperUser whatever the org role', async () => {
    expect((await call('/org', { role: 'member', api_key_scope: null, is_superuser: true })).statusCode).toBe(200);
  });

  it('still decides API-key callers by key scope', async () => {
    expect((await call('/org', { role: 'member', api_key_scope: 'admin' })).statusCode).toBe(200);
    expect((await call('/org', { role: 'owner', api_key_scope: 'read_write' })).statusCode).toBe(403);
  });

  it('leaves read_write gates open to member sessions', async () => {
    expect((await call('/tasks/x', { role: 'member', api_key_scope: null })).statusCode).toBe(200);
  });
});
