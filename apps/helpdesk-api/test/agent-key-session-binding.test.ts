import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';

// #173: an X-Agent-Key plus a Bam session cookie must belong to the same
// person. Before the fix, holding agent key X (owner A) and user B's session
// read B's org's tickets and posted as B, and a session scoped the request to
// the user's HOME org rather than the org they had switched to.

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

const findSimilarTickets = vi.fn();
vi.mock('../src/services/similar-tickets.service.js', () => ({
  findSimilarTickets: (...args: unknown[]) => findSimilarTickets(...args),
  SimilarTicketsError: class extends Error {},
}));

const KEY_OWNER = '11111111-1111-4111-8111-111111111111'; // Skipper
const OTHER_USER = '22222222-2222-4222-8222-222222222222'; // Mr. Howell
const HOME_ORG = '33333333-3333-4333-8333-333333333333';
const ACTIVE_ORG = '44444444-4444-4444-8444-444444444444';
const TICKET = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'hdagSKIPPERminnowAgentKey0123456789';
const URL = `/helpdesk/agents/tickets/${TICKET}/similar`;

let keyHash = '';

beforeAll(async () => {
  keyHash = await argon2.hash(TOKEN, { type: argon2.argon2id });
});

/** db.select chain for verifyAgentApiKey's candidate lookup (ends in .limit). */
function keyCandidates() {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      {
        id: 'key-1',
        bbb_user_id: KEY_OWNER,
        key_hash: keyHash,
        expires_at: null,
        revoked_at: null,
        user_is_active: true,
      },
    ]),
  };
}

/** db.select chain for the key owner's home-org fallback. */
function homeOrgRow() {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ org_id: HOME_ORG }]),
  };
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

describe('X-Agent-Key is bound to the accompanying Bam session (#173)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const fn of Object.values(dbMock)) (fn as ReturnType<typeof vi.fn>).mockReset();
    dbMock.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    findSimilarTickets.mockResolvedValue({ data: [] });
    app = await buildApp();
  });

  it("another user's session alongside the key is 403 and reads nothing", async () => {
    dbMock.select.mockReturnValueOnce(keyCandidates());
    dbMock.execute.mockResolvedValueOnce([{ user_id: OTHER_USER, active_org_id: ACTIVE_ORG, org_id: HOME_ORG }]);

    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { 'x-agent-key': TOKEN },
      cookies: { session: 'howell-session' },
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('AGENT_SESSION_MISMATCH');
    expect(findSimilarTickets).not.toHaveBeenCalled();
  });

  it("the key owner's own session scopes to the session's ACTIVE org, not the home org", async () => {
    dbMock.select.mockReturnValueOnce(keyCandidates());
    dbMock.execute
      .mockResolvedValueOnce([{ user_id: KEY_OWNER, active_org_id: ACTIVE_ORG, org_id: HOME_ORG }])
      .mockResolvedValueOnce([{ id: KEY_OWNER }]); // membership in ACTIVE_ORG

    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { 'x-agent-key': TOKEN },
      cookies: { session: 'skipper-session' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: ACTIVE_ORG }));
  });

  it("the owner's session in an org they no longer belong to is 403", async () => {
    dbMock.select.mockReturnValueOnce(keyCandidates());
    dbMock.execute
      .mockResolvedValueOnce([{ user_id: KEY_OWNER, active_org_id: ACTIVE_ORG, org_id: HOME_ORG }])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { 'x-agent-key': TOKEN },
      cookies: { session: 'skipper-session' },
    });

    expect(res.statusCode).toBe(403);
    expect(findSimilarTickets).not.toHaveBeenCalled();
  });

  it('an expired or unknown session is ignored and the key owner home org applies', async () => {
    dbMock.select.mockReturnValueOnce(keyCandidates()).mockReturnValueOnce(homeOrgRow());
    dbMock.execute.mockResolvedValueOnce([]); // no live session

    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { 'x-agent-key': TOKEN },
      cookies: { session: 'stale' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: HOME_ORG }));
  });

  it('a key with no session scopes to the key owner home org', async () => {
    dbMock.select.mockReturnValueOnce(keyCandidates()).mockReturnValueOnce(homeOrgRow());

    const res = await app.inject({ method: 'GET', url: URL, headers: { 'x-agent-key': TOKEN } });

    expect(res.statusCode, res.body).toBe(200);
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(findSimilarTickets).toHaveBeenCalledWith(expect.objectContaining({ org_id: HOME_ORG }));
  });
});
