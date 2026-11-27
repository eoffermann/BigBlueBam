import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { logTicketActivity } from '../src/lib/ticket-activity.js';
import { publishBoltEvent } from '../src/lib/bolt-events.js';

// ---------------------------------------------------------------------------
// Mocks — these must be hoisted by vitest via vi.mock().
// ---------------------------------------------------------------------------

// `db` is a mutable object whose .select / .update are re-stubbed per-test.
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
  },
}));

// Stub realtime broadcasts — tests don't exercise the Redis publisher.
vi.mock('../src/services/realtime.js', () => ({
  broadcastTicketMessage: vi.fn(async () => {}),
  broadcastTicketStatusChanged: vi.fn(async () => {}),
  broadcastTicketUpdated: vi.fn(async () => {}),
}));

// Side-effect helpers reached by the reopen and agent-message routes. Mocked
// so the HB-4 / HB-14 tests can assert on them (no audit row / no Bolt event
// when a protection rejects the request) without Redis, HTTP, or DB writes.
vi.mock('../src/lib/broadcast.js', () => ({
  broadcastTaskCreated: vi.fn(async () => {}),
  broadcastTicketStatusChanged: vi.fn(async () => {}),
  broadcastTicketMessage: vi.fn(async () => {}),
}));

vi.mock('../src/lib/task-sync.js', () => ({
  mirrorTicketMessageToTask: vi.fn(async () => {}),
  mirrorTicketClosedToTask: vi.fn(async () => {}),
}));

vi.mock('../src/lib/ticket-activity.js', () => ({
  logTicketActivity: vi.fn(async () => {}),
}));

vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// A token of the form `hdag_<base64url>`. The first 8 chars (`hdag_tes`) are
// the key_prefix that requireAgentAuth indexes on.
const VALID_TOKEN = 'hdag_testtoken_abcdefghijklmnopqrstuv';
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_KEY_ID = '22222222-2222-2222-2222-222222222222';

let validKeyHash: string;
// Pre-computed argon2 hash of a DIFFERENT token — used to simulate "token
// presented didn't match this candidate row" without rehashing per test.
let otherKeyHash: string;

beforeAll(async () => {
  // Argon2id is expensive; compute once up-front and reuse.
  validKeyHash = await argon2.hash(VALID_TOKEN, { type: argon2.argon2id });
  otherKeyHash = await argon2.hash('hdag_someOtherTokenThatWontMatch', {
    type: argon2.argon2id,
  });
}, 30_000);

// Build a candidate row matching the select projection in requireAgentAuth.
function makeCandidate(overrides: Partial<{
  id: string;
  bbb_user_id: string;
  key_hash: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  user_is_active: boolean;
}> = {}) {
  return {
    id: TEST_KEY_ID,
    bbb_user_id: TEST_USER_ID,
    key_hash: validKeyHash,
    expires_at: null,
    revoked_at: null,
    user_is_active: true,
    ...overrides,
  };
}

// Fake Drizzle fluent chain for the agent-key lookup:
// db.select({...}).from(x).innerJoin(...).where(...).limit(n) → rows
function makeAgentKeySelectChain(rows: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

// Fake .update().set().where() chain used for the fire-and-forget
// last_used_at write — must be thenable (has .catch()).
function stubUpdateLastUsed() {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      catch: vi.fn().mockReturnThis(),
    }),
  };
  dbMock.update.mockReturnValue(chain);
  return chain;
}

// Fake chain for the tickets list fetch that runs AFTER auth passes:
// db.select().from(tickets).innerJoin(projects).where(...).orderBy(...) → [].
function makeTicketsSelectChain() {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
  };
}

// Fake chain for the org-id resolution in resolveAgentOrgId (HB-6):
// db.select({ org_id }).from(users).where(...).limit(1) → [{ org_id }].
// Sits between the agent-key lookup and the tickets list in the select-call
// sequence of any GET /tickets request that passes auth.
function makeOrgLookupChain(orgId: string = '33333333-3333-3333-3333-333333333333') {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ org_id: orgId }]),
  };
}

// Spin up a minimal Fastify app with the real agent routes registered. We
// issue GET /tickets as the "does auth pass" probe because it is the
// cheapest route guarded by requireAgentAuth.
async function buildApp(): Promise<FastifyInstance> {
  const agentRoutesModule: any = await import('../src/routes/agent.routes.js');
  const agentRoutes = agentRoutesModule.default;

  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'a'.repeat(32) });
  await app.register(agentRoutes);
  await app.ready();
  return app;
}

describe('HB-28 + HB-49: per-agent X-Agent-Key authentication', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('missing X-Agent-Key header → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/tickets' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toMatch(/Missing or malformed X-Agent-Key/i);
    // DB should NEVER be consulted when the header is absent.
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('token too short (<9 chars) → 401 without DB lookup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': 'short' },
    });
    expect(res.statusCode).toBe(401);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('valid key → 200; agentUserId populated and last_used_at updated', async () => {
    const authChain = makeAgentKeySelectChain([makeCandidate()]);
    const updateChain = stubUpdateLastUsed();
    dbMock.execute.mockResolvedValue({ rows: [] });
    dbMock.select
      .mockReturnValueOnce(authChain) // 1st call: agent key lookup
      .mockReturnValueOnce(makeOrgLookupChain()) // 2nd call: resolveAgentOrgId
      .mockReturnValueOnce(makeTicketsSelectChain()); // 3rd call: tickets list

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });

    // Auth lookup used the fluent chain we provided.
    expect(authChain.where).toHaveBeenCalled();
    expect(authChain.limit).toHaveBeenCalledWith(10);

    // last_used_at update was fired.
    expect(dbMock.update).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ last_used_at: expect.any(Date) }),
    );
  });

  it('no rows match prefix → 401', async () => {
    dbMock.select.mockReturnValueOnce(makeAgentKeySelectChain([]));
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(res.json().error.message).toMatch(/Invalid agent API key/);
  });

  it('candidate with wrong hash → argon2.verify fails → 401', async () => {
    dbMock.select.mockReturnValueOnce(
      makeAgentKeySelectChain([makeCandidate({ key_hash: otherKeyHash })]),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('garbage key_hash (not a valid argon2 encoded string) → 401 (throw treated as !valid)', async () => {
    // A corrupted/truncated key_hash row makes argon2.verify throw
    // ("pchstr must contain a $ as first char"). requireAgentAuth wraps
    // verify in try/catch and treats any throw as a verification failure,
    // so one bad row cannot 500 every request that happens to share its
    // prefix — the caller just gets a clean 401 like for any other invalid
    // token. Logged at warn level for operator visibility.
    dbMock.select.mockReturnValueOnce(
      makeAgentKeySelectChain([makeCandidate({ key_hash: 'not-a-real-argon2-hash' })]),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expired key (expires_at in the past) → 401 even though hash matches', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    dbMock.select.mockReturnValueOnce(
      makeAgentKeySelectChain([makeCandidate({ expires_at: yesterday })]),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/Invalid agent API key/);
  });

  it('revoked key (revoked_at in the past) → 401', async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    dbMock.select.mockReturnValueOnce(
      makeAgentKeySelectChain([makeCandidate({ revoked_at: earlier })]),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('inactive user (is_active=false) → 401 even though hash matches', async () => {
    dbMock.select.mockReturnValueOnce(
      makeAgentKeySelectChain([makeCandidate({ user_is_active: false })]),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(401);
  });

  it('future expires_at is fine → 200', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    stubUpdateLastUsed();
    dbMock.execute.mockResolvedValue({ rows: [] });
    dbMock.select
      .mockReturnValueOnce(
        makeAgentKeySelectChain([makeCandidate({ expires_at: tomorrow })]),
      )
      .mockReturnValueOnce(makeOrgLookupChain())
      .mockReturnValueOnce(makeTicketsSelectChain());

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('>3 candidates past the DoS cap → only first candidate verified', async () => {
    // Build 5 candidates. Only the LAST one has a hash that would verify
    // successfully against VALID_TOKEN — so if the middleware verified all
    // of them, we'd get a 200. Since the cap slices to the FIRST candidate
    // only (candidates.slice(0, 1) when length > 3), none of the first-
    // candidate verification should succeed → 401.
    const candidates = [
      makeCandidate({ id: 'k1', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k2', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k3', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k4', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k5', key_hash: validKeyHash }), // the "real" one
    ];
    dbMock.select.mockReturnValueOnce(makeAgentKeySelectChain(candidates));

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });

    // First candidate's hash is otherKeyHash → argon2.verify fails → 401,
    // and the trailing valid candidate is NEVER consulted because of the
    // cap's slice(0, 1) behavior.
    expect(res.statusCode).toBe(401);
  });

  it('>3 candidates where the FIRST one is the valid key → 200', async () => {
    // Mirror image of the previous test: puts the valid hash first so we
    // confirm the cap preserves the "verify first candidate only" contract
    // (rather than, say, silently rejecting all when candidates > 3).
    const candidates = [
      makeCandidate({ id: 'k1', key_hash: validKeyHash }), // the real one
      makeCandidate({ id: 'k2', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k3', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k4', key_hash: otherKeyHash }),
    ];
    stubUpdateLastUsed();
    dbMock.execute.mockResolvedValue({ rows: [] });
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain(candidates))
      .mockReturnValueOnce(makeOrgLookupChain())
      .mockReturnValueOnce(makeTicketsSelectChain());

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });

    expect(res.statusCode).toBe(200);
  });

  it('exactly 3 candidates (at the cap boundary) → all verified normally', async () => {
    // At exactly 3 candidates the cap does NOT engage (candidates.length > 3
    // is the trigger). Put the valid one last to prove all three are checked.
    const candidates = [
      makeCandidate({ id: 'k1', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k2', key_hash: otherKeyHash }),
      makeCandidate({ id: 'k3', key_hash: validKeyHash }),
    ];
    stubUpdateLastUsed();
    dbMock.execute.mockResolvedValue({ rows: [] });
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain(candidates))
      .mockReturnValueOnce(makeOrgLookupChain())
      .mockReturnValueOnce(makeTicketsSelectChain());

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================================
// HB-4 / HB-6 / HB-14 regression tests. These used to be `it.todo`
// placeholders waiting on a postgres harness; they now drive the real routes
// through app.inject with the same dbMock pattern as the HB-28 + HB-49 block.
// Ownership and org protections live in Drizzle WHERE clauses, so the tests
// render each captured WHERE with PgDialect and assert on the SQL text and
// bound params. Where a fake row store is used, it applies that rendered
// WHERE to its stored row, so removing a clause from the route changes the
// outcome (and fails the test) rather than only changing a string.
// ============================================================================

const dialect = new PgDialect();

function renderWhere(cond: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
}

const CUSTOMER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const TICKET_ID = 'cccccccc-0000-4000-8000-00000000000c';
const KEY_USER_ORG = '33333333-3333-3333-3333-333333333333';
const SESSION_USER = '44444444-0000-4000-8000-000000000044';
const SESSION_ORG = '44444444-4444-4444-4444-444444444444';
const TICKET_ORG = '55555555-5555-5555-5555-555555555555';
const OTHER_ORG = '66666666-6666-6666-6666-666666666666';
const REAL_AUTHOR = '77777777-0000-4000-8000-000000000077';
const FORGED_AUTHOR = '88888888-0000-4000-8000-000000000088';

interface FakeTicketRow {
  id: string;
  helpdesk_user_id: string;
  status: string;
  resolved_at: Date | null;
  closed_at: Date | null;
}

function makeResolvedTicket(ownerId: string): FakeTicketRow {
  return {
    id: TICKET_ID,
    helpdesk_user_id: ownerId,
    status: 'resolved',
    resolved_at: new Date('2026-01-01T00:00:00Z'),
    closed_at: null,
  };
}

// Apply a rendered tickets WHERE to one stored row: it must pin tickets.id to
// the row's id, and if it constrains helpdesk_user_id that must be the owner.
function ticketRowMatches(cond: unknown, row: FakeTicketRow): boolean {
  const { sql, params } = renderWhere(cond);
  if (!sql.includes('"tickets"."id" = ') || !params.includes(row.id)) return false;
  if (sql.includes('"tickets"."helpdesk_user_id" = ') && !params.includes(row.helpdesk_user_id)) {
    return false;
  }
  return true;
}

// Customer session lookup done by the real helpdesk-auth plugin preHandler:
// db.select({session, user}).from().innerJoin().where().limit(1).
function makeHelpdeskSessionChain(userId: string) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      {
        session: {
          id: 'hs-session',
          user_id: userId,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
        user: {
          id: userId,
          email: 'castaway@example.com',
          display_name: 'Castaway',
          email_verified: true,
          is_active: true,
        },
      },
    ]),
  };
}

// db.select().from(tickets).where(...).limit(1) backed by one stored row.
function makeFilteringTicketSelectChain(row: FakeTicketRow) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn(async () => {
    const cond = chain.where.mock.calls[0]?.[0];
    return ticketRowMatches(cond, row) ? [row] : [];
  });
  return chain;
}

// db.update(tickets).set(...).where(...).returning() backed by one stored row.
function makeFilteringTicketUpdateChain(row: FakeTicketRow) {
  const chain: any = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn(async () => {
    const cond = chain.where.mock.calls[0]?.[0];
    return ticketRowMatches(cond, row) ? [{ ...row, ...chain.set.mock.calls[0]?.[0] }] : [];
  });
  return chain;
}

// resolveTicketOrgId after a successful reopen; [] means "no org, skip Bolt".
function makeEmptyJoinLimitChain() {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
}

async function buildCustomerApp(): Promise<FastifyInstance> {
  const { default: helpdeskAuthPlugin } = await import('../src/plugins/auth.js');
  const { default: ticketRoutes } = await import('../src/routes/ticket.routes.js');
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'a'.repeat(32) });
  await app.register(helpdeskAuthPlugin);
  await app.register(ticketRoutes);
  await app.ready();
  return app;
}

function resetDbMock() {
  vi.clearAllMocks();
  // mockReset also drops any queued mockReturnValueOnce values a previous
  // test left unconsumed, so select-call sequences cannot leak across tests.
  for (const fn of Object.values(dbMock)) (fn as ReturnType<typeof vi.fn>).mockReset();
}

describe('HB-4: reopen ownership enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetDbMock();
    app = await buildCustomerApp();
  });

  function reopenAs(customerId: string) {
    return app.inject({
      method: 'POST',
      url: `/helpdesk/tickets/${TICKET_ID}/reopen`,
      cookies: { helpdesk_session: `hs-${customerId}` },
    });
  }

  it('control: customer reopens their own resolved ticket → 200, status open, audited', async () => {
    const row = makeResolvedTicket(CUSTOMER_A);
    const updateChain = makeFilteringTicketUpdateChain(row);
    dbMock.select
      .mockReturnValueOnce(makeHelpdeskSessionChain(CUSTOMER_A))
      .mockReturnValueOnce(makeFilteringTicketSelectChain(row))
      .mockReturnValueOnce(makeEmptyJoinLimitChain());
    dbMock.update.mockReturnValue(updateChain);

    const res = await reopenAs(CUSTOMER_A);

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('open');
    expect(logTicketActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: CUSTOMER_A, action: 'ticket.reopened' }),
    );
  });

  it("customer A cannot reopen customer B's ticket: UPDATE WHERE must include helpdesk_user_id", async () => {
    // Race window: A's SELECT saw the ticket as A's, but by the time the
    // UPDATE runs the stored row belongs to B. Only the ownership predicate
    // in the UPDATE's WHERE stops the write.
    const selectSeen = makeResolvedTicket(CUSTOMER_A);
    const storedAtUpdate = makeResolvedTicket(CUSTOMER_B);
    const updateChain = makeFilteringTicketUpdateChain(storedAtUpdate);
    dbMock.select
      .mockReturnValueOnce(makeHelpdeskSessionChain(CUSTOMER_A))
      .mockReturnValueOnce(makeFilteringTicketSelectChain(selectSeen))
      .mockReturnValueOnce(makeEmptyJoinLimitChain());
    dbMock.update.mockReturnValue(updateChain);

    const res = await reopenAs(CUSTOMER_A);

    expect(updateChain.where).toHaveBeenCalledTimes(1);
    const { sql, params } = renderWhere(updateChain.where.mock.calls[0][0]);
    expect(sql).toContain('"tickets"."id" = ');
    expect(sql).toContain('"tickets"."helpdesk_user_id" = ');
    expect(params).toEqual(expect.arrayContaining([TICKET_ID, CUSTOMER_A]));

    // The guarded UPDATE matched nothing: no reopened row comes back and no
    // audit row or Bolt event claims a reopen happened.
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeUndefined();
    expect(logTicketActivity).not.toHaveBeenCalled();
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) when a ticket exists but is owned by a different helpdesk_user', async () => {
    const row = makeResolvedTicket(CUSTOMER_B);
    const selectChain = makeFilteringTicketSelectChain(row);
    dbMock.select
      .mockReturnValueOnce(makeHelpdeskSessionChain(CUSTOMER_A))
      .mockReturnValueOnce(selectChain);

    const res = await reopenAs(CUSTOMER_A);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    const { sql, params } = renderWhere(selectChain.where.mock.calls[0][0]);
    expect(sql).toContain('"tickets"."helpdesk_user_id" = ');
    expect(params).toContain(CUSTOMER_A);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(logTicketActivity).not.toHaveBeenCalled();
  });

  it('unauthenticated reopen → 401 and the tickets table is never read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/helpdesk/tickets/${TICKET_ID}/reopen`,
    });
    expect(res.statusCode).toBe(401);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('HB-6: agent org scoping', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetDbMock();
    stubUpdateLastUsed();
    app = await buildApp();
  });

  it('agent with valid BBB session sees only tickets whose project belongs to session.org_id', async () => {
    dbMock.execute.mockResolvedValue({
      rows: [{ user_id: SESSION_USER, display_name: 'Sam Session', org_id: SESSION_ORG }],
    });
    const ticketsChain = makeTicketsSelectChain();
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain([makeCandidate()]))
      .mockReturnValueOnce(ticketsChain);

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
      cookies: { session: 'bam-session-id' },
    });

    expect(res.statusCode).toBe(200);
    // Session org wins: the key user's org lookup is never consulted.
    expect(dbMock.select).toHaveBeenCalledTimes(2);
    expect(ticketsChain.innerJoin).toHaveBeenCalled();
    const { sql, params } = renderWhere(ticketsChain.where.mock.calls[0]![0]);
    expect(sql).toContain('"projects"."org_id" = ');
    expect(params).toEqual([SESSION_ORG]);
  });

  // Supersedes "agent without session sees all tickets (known limitation of
  // shared X-Agent-Key trust model)": HB-28/HB-49 replaced the shared key with
  // per-agent keys, and a key-only caller is now scoped to its own user's org.
  it("agent without session is scoped to its own key user's org (no unscoped listing)", async () => {
    const ticketsChain = makeTicketsSelectChain();
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain([makeCandidate()]))
      .mockReturnValueOnce(makeOrgLookupChain(KEY_USER_ORG))
      .mockReturnValueOnce(ticketsChain);

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(dbMock.execute).not.toHaveBeenCalled();
    const { sql, params } = renderWhere(ticketsChain.where.mock.calls[0]![0]);
    expect(sql).toContain('"projects"."org_id" = ');
    expect(params).toEqual([KEY_USER_ORG]);
  });

  it('agent without session whose key user has no org → 403 ORG_CONTEXT_REQUIRED, no ticket query', async () => {
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain([makeCandidate()]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { 'x-agent-key': VALID_TOKEN },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORG_CONTEXT_REQUIRED');
    // Only the key lookup and the org lookup ran; the tickets list never did.
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
});

describe('HB-14: message author_id forgery prevention', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetDbMock();
    stubUpdateLastUsed();
    app = await buildApp();
  });

  // db.select({...}).from(tickets).where(...).limit(1): the "ticket exists" probe.
  function makeTicketExistsChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        { id: TICKET_ID, task_id: null, first_response_at: new Date(), status: 'open' },
      ]),
    };
  }

  // tickets JOIN projects → org_id; used by ticketBelongsToOrg and by the
  // key-only author org check.
  function makeTicketOrgChain(orgId: string) {
    return {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ org_id: orgId }]),
    };
  }

  function stubMessageInsert() {
    const chain: any = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([
        {
          id: 'msg-1',
          ticket_id: TICKET_ID,
          body: 'hello',
          is_internal: false,
          created_at: new Date(),
        },
      ]),
    };
    dbMock.insert.mockReturnValue(chain);
    return chain;
  }

  // Key-only select sequence up to and including the author org lookup.
  function queueKeyOnlySelects() {
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain([makeCandidate()]))
      .mockReturnValueOnce(makeOrgLookupChain(TICKET_ORG))
      .mockReturnValueOnce(makeTicketExistsChain())
      .mockReturnValueOnce(makeTicketOrgChain(TICKET_ORG))
      .mockReturnValueOnce(makeTicketOrgChain(TICKET_ORG));
  }

  function postMessage(body: Record<string, unknown>, cookies?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/tickets/${TICKET_ID}/messages`,
      headers: { 'x-agent-key': VALID_TOKEN },
      payload: body,
      ...(cookies ? { cookies } : {}),
    });
  }

  it('when a BBB session accompanies the request, author_id is taken from the session and cannot be overridden by the request body', async () => {
    dbMock.execute.mockResolvedValue({
      rows: [{ user_id: SESSION_USER, display_name: 'Sam Session', org_id: TICKET_ORG }],
    });
    dbMock.select
      .mockReturnValueOnce(makeAgentKeySelectChain([makeCandidate()]))
      .mockReturnValueOnce(makeTicketExistsChain())
      .mockReturnValueOnce(makeTicketOrgChain(TICKET_ORG));
    const insertChain = stubMessageInsert();

    const res = await postMessage(
      { body: 'hello', author_id: FORGED_AUTHOR },
      { session: 'bam-session-id' },
    );

    expect(res.statusCode).toBe(201);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ author_id: SESSION_USER, author_type: 'agent' }),
    );
    expect(insertChain.values.mock.calls[0][0].author_id).not.toBe(FORGED_AUTHOR);
    expect(logTicketActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: SESSION_USER, action: 'message.posted' }),
    );
    // Two session lookups (org scope + author identity); no body-author lookup.
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it('X-Agent-Key-only caller must supply author_id → 400 AUTHOR_REQUIRED, nothing written', async () => {
    queueKeyOnlySelects();
    const insertChain = stubMessageInsert();

    const res = await postMessage({ body: 'hello' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AUTHOR_REQUIRED');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(insertChain.values).not.toHaveBeenCalled();
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });

  it('X-Agent-Key-only caller: author_id must resolve to a real user row → 400 AUTHOR_NOT_FOUND, nothing written', async () => {
    queueKeyOnlySelects();
    dbMock.execute.mockResolvedValue({ rows: [] });
    stubMessageInsert();

    const res = await postMessage({ body: 'hello', author_id: FORGED_AUTHOR });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AUTHOR_NOT_FOUND');
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(logTicketActivity).not.toHaveBeenCalled();
  });

  it("X-Agent-Key-only caller cannot forge author_id belonging to a user in a different org than the ticket's project → 403", async () => {
    queueKeyOnlySelects();
    dbMock.execute.mockResolvedValue({
      rows: [{ id: FORGED_AUTHOR, display_name: 'Mallory', org_id: OTHER_ORG }],
    });
    stubMessageInsert();

    const res = await postMessage({ body: 'hello', author_id: FORGED_AUTHOR });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHOR_ORG_MISMATCH');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(logTicketActivity).not.toHaveBeenCalled();
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });

  it("control: X-Agent-Key-only caller with an author_id in the ticket's org → 201 attributed to that user", async () => {
    queueKeyOnlySelects();
    dbMock.execute.mockResolvedValue({
      rows: [{ id: REAL_AUTHOR, display_name: 'Pat Agent', org_id: TICKET_ORG }],
    });
    const insertChain = stubMessageInsert();

    const res = await postMessage({ body: 'hello', author_id: REAL_AUTHOR });

    expect(res.statusCode).toBe(201);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ author_id: REAL_AUTHOR, author_name: 'Pat Agent' }),
    );
  });
});
