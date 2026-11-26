import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// Bam-proxied agent auth: the Bam API calls helpdesk-api's agent routes
// with the shared internal token plus the acting user and org it has
// already authenticated (apps/api internal-helpdesk.routes.ts).

const dbMock: any = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../src/db/index.js', () => ({
  db: dbMock,
  connection: { end: vi.fn() },
}));

const SECRET = 's'.repeat(40);

vi.mock('../src/env.js', () => ({
  env: {
    PORT: 4001,
    DATABASE_URL: 'postgres://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    HELPDESK_URL: 'http://localhost:8080',
    CORS_ORIGIN: 'http://localhost:8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_TTL_SECONDS: 604800,
    INTERNAL_HELPDESK_SECRET: 's'.repeat(40),
  },
}));

vi.mock('../src/services/realtime.js', () => ({
  broadcastTicketMessage: vi.fn(async () => {}),
  broadcastTicketStatusChanged: vi.fn(async () => {}),
  broadcastTicketUpdated: vi.fn(async () => {}),
}));

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '33333333-3333-3333-3333-333333333333';

function ticketsListChain() {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
  };
  return chain;
}

async function buildApp(): Promise<FastifyInstance> {
  const mod: any = await import('../src/routes/agent.routes.js');
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'a'.repeat(32) });
  await app.register(mod.default);
  await app.ready();
  return app;
}

function proxyHeaders(overrides: Record<string, string | undefined> = {}) {
  const h: Record<string, string> = {};
  const base: Record<string, string | undefined> = {
    'x-internal-token': SECRET,
    'x-acting-user-id': USER_ID,
    'x-acting-org-id': ORG_ID,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) h[k] = v;
  return h;
}

describe('Bam-proxied agent auth (internal token + acting user/org)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('valid token + active member → 200, scoped to the acting org without an org lookup', async () => {
    dbMock.execute.mockResolvedValueOnce([{ id: USER_ID }]); // membership check
    const list = ticketsListChain();
    dbMock.select.mockReturnValueOnce(list);

    const res = await app.inject({ method: 'GET', url: '/tickets', headers: proxyHeaders() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
    // Only the tickets list hit db.select: no agent-key lookup and no
    // users.org_id fallback, because the acting org was supplied.
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it('wrong internal token → 401 without touching the DB', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: proxyHeaders({ 'x-internal-token': 'x'.repeat(40) }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/Invalid internal service token/);
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('missing acting user → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: proxyHeaders({ 'x-acting-user-id': undefined }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/acting user and org/);
  });

  it('malformed acting org id → 401 without a DB query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: proxyHeaders({ 'x-acting-org-id': "'; drop table users; --" }),
    });
    expect(res.statusCode).toBe(401);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('acting user not a member of the acting org (or inactive) → 401', async () => {
    dbMock.execute.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/tickets', headers: proxyHeaders() });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/not an active member/);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('no internal token → falls through to X-Agent-Key (still 401 when absent)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tickets' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/X-Agent-Key/);
  });
});
