import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// #339: the MCP helpdesk ticket tools forward the caller's Bam API key as
// `Authorization: Bearer bbam_...`. The agent surface (/helpdesk/agents/*)
// accepted only X-Agent-Key or the Bam proxy token, so every tool call was 401.
// requireAgentAuth (lib/agent-auth.ts) now verifies a bbam_ Bearer key with
// lib/bam-api-key.ts, pins the request to the key's org, requires the owner to
// belong to it, and lets a 'read' key only read.

const dbMock: any = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../src/db/index.js', () => ({ db: dbMock, connection: { end: vi.fn() } }));

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

const verifyBamApiKey = vi.fn();
vi.mock('../src/lib/bam-api-key.js', async (orig) => ({
  ...((await orig()) as object),
  verifyBamApiKey: (...args: unknown[]) => verifyBamApiKey(...args),
}));

const findSimilarTickets = vi.fn();
vi.mock('../src/services/similar-tickets.service.js', () => ({
  findSimilarTickets: (...args: unknown[]) => findSimilarTickets(...args),
  SimilarTicketsError: class extends Error {},
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ORG = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'bbam_skipperKeyForTheMinnow';
const bearer = { authorization: `Bearer ${TOKEN}` };

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
  const agentRoutes: any = await import('../src/routes/agent.routes.js');
  const dedupeRoutes: any = await import('../src/routes/dedupe.routes.js');
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'a'.repeat(32) });
  await app.register(agentRoutes.default, { prefix: '/helpdesk/agents' });
  await app.register(dedupeRoutes.default);
  await app.ready();
  return app;
}

function caller(scope: string, keyOrgId: string | null = KEY_ORG) {
  return { userId: USER_ID, keyOrgId, scope, isSuperuser: false };
}

describe('agent routes accept a Bam API key as Bearer (#339)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('a valid key whose owner belongs to its org lists tickets scoped to that org', async () => {
    verifyBamApiKey.mockResolvedValueOnce(caller('read'));
    dbMock.execute.mockResolvedValueOnce([{ id: USER_ID }]); // membership check
    const list = ticketsListChain();
    dbMock.select.mockReturnValueOnce(list);

    const res = await app.inject({ method: 'GET', url: '/helpdesk/agents/tickets', headers: bearer });

    expect(res.statusCode, res.body).toBe(200);
    expect(verifyBamApiKey).toHaveBeenCalledWith(expect.anything(), TOKEN);
    // The org came from the key, so no session or users.org_id lookup ran.
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('an invalid key is 401 (and never falls through to X-Agent-Key)', async () => {
    verifyBamApiKey.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/helpdesk/agents/tickets', headers: bearer });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/API key/);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('a key whose owner is not a member of the key org is 403', async () => {
    verifyBamApiKey.mockResolvedValueOnce(caller('read'));
    dbMock.execute.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/helpdesk/agents/tickets', headers: bearer });
    expect(res.statusCode).toBe(403);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("a 'read' key cannot write (scope error the MCP server recognizes)", async () => {
    verifyBamApiKey.mockResolvedValueOnce(caller('read'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/helpdesk/agents/tickets/44444444-4444-4444-8444-444444444444',
      headers: bearer,
      payload: { status: 'resolved' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/scope/);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('a non-bbam Bearer token is ignored, so the X-Agent-Key requirement still applies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/helpdesk/agents/tickets',
      headers: { authorization: 'Bearer some.customer.jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/X-Agent-Key/);
    expect(verifyBamApiKey).not.toHaveBeenCalled();
  });

  it('the similar-tickets route (dedupe.routes.ts) takes the same Bearer key and the key org', async () => {
    verifyBamApiKey.mockResolvedValueOnce(caller('read'));
    dbMock.execute.mockResolvedValueOnce([{ id: USER_ID }]);
    findSimilarTickets.mockResolvedValueOnce({ data: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/helpdesk/agents/tickets/44444444-4444-4444-8444-444444444444/similar',
      headers: bearer,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: KEY_ORG }));
  });

  // #351: the org pin is @bigbluebam/auth-core's. A SuperUser key and a NULL-org
  // key are not pinned, so they act in the owner's home org (this surface has no
  // org selector), and a SuperUser passes the scope gate.
  const HOME_ORG = '66666666-6666-4666-8666-666666666666';
  const similar = (method: 'GET' = 'GET') =>
    app.inject({ method, url: '/helpdesk/agents/tickets/44444444-4444-4444-8444-444444444444/similar', headers: bearer });

  it('a SuperUser key is not pinned to its key org: it acts in the home org', async () => {
    verifyBamApiKey.mockResolvedValueOnce({ ...caller('read'), isSuperuser: true });
    dbMock.execute.mockResolvedValueOnce([{ org_id: HOME_ORG }]).mockResolvedValueOnce([{ id: USER_ID }]);
    findSimilarTickets.mockResolvedValueOnce({ data: [] });
    const res = await similar();
    expect(res.statusCode, res.body).toBe(200);
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: HOME_ORG }));
  });

  it('a NULL-org key acts in the home org', async () => {
    verifyBamApiKey.mockResolvedValueOnce(caller('read', null));
    dbMock.execute.mockResolvedValueOnce([{ org_id: HOME_ORG }]).mockResolvedValueOnce([{ id: USER_ID }]);
    findSimilarTickets.mockResolvedValueOnce({ data: [] });
    const res = await similar();
    expect(res.statusCode, res.body).toBe(200);
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: HOME_ORG }));
  });

  it("a SuperUser's 'read' key may write, as requireScope passes SuperUsers", async () => {
    verifyBamApiKey.mockResolvedValueOnce({ ...caller('read'), isSuperuser: true });
    dbMock.execute.mockResolvedValueOnce([{ org_id: HOME_ORG }]).mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/helpdesk/agents/tickets/44444444-4444-4444-8444-444444444444',
      headers: bearer,
      payload: { status: 'resolved' },
    });
    // Past the scope gate: it reaches the org/membership step (mocked to refuse),
    // not the scope refusal a non-SuperUser 'read' key gets.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).not.toMatch(/scope/);
    expect(dbMock.execute).toHaveBeenCalled();
  });
});
