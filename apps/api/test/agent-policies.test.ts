import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
const { mockDb, mockRedis } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockRedis: {
      publish: vi.fn(),
    },
  };
});

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [], request_id: request.id },
      });
    }
  },
  requireScope: () => async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [], request_id: request.id },
      });
    }
  },
}));

import {
  checkPolicy,
  getPolicy,
  isToolAllowed,
  listPolicies,
  matchesAllowlist,
  setPolicy,
} from '../src/services/agent-policy.service.js';
import agentPoliciesRoutes from '../src/routes/agent-policies.routes.js';

// ---------- helpers ----------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const HUMAN_USER = '88888888-8888-8888-8888-888888888888';
const AGENT_USER = '99999999-9999-9999-9999-999999999999';
const AGENT_USER_2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.decorate('redis', mockRedis as any);
  app.addHook('preHandler', async (request) => {
    const who = request.headers['x-test-user'];
    if (who === 'human') {
      (request as any).user = {
        id: HUMAN_USER,
        active_org_id: ORG_A,
        kind: 'human',
        role: 'member',
        is_superuser: false,
        org_id: ORG_A,
      };
    } else if (who === 'superuser') {
      (request as any).user = {
        id: HUMAN_USER,
        active_org_id: ORG_A,
        kind: 'human',
        role: 'admin',
        is_superuser: true,
        org_id: ORG_A,
      };
    }
  });
  await app.register(agentPoliciesRoutes);
  return app;
}

// getPolicy chain: select().from().leftJoin().where().limit()  -> rows
function mockSelectLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  mockDb.select.mockReturnValueOnce({ from });
}

// listPolicies chain: select().from().leftJoin().leftJoin().where().orderBy() -> rows
function mockSelectListPolicies(rows: any[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  // Service chains three leftJoins: users (agent), agentRunners (heartbeat),
  // and a self-join on users (creator for created_by provenance). Added with
  // migration 0141; see apps/api/src/services/agent-policy.service.ts.
  const leftJoin3 = vi.fn().mockReturnValue({ where });
  const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 });
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 });
  const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 });
  mockDb.select.mockReturnValueOnce({ from });
}

// select().from().where().limit() — simple (for users lookup)
function mockSelectUsersLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

function mockUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValueOnce({ set });
}

function mockInsertValues() {
  const values = vi.fn().mockResolvedValue(undefined);
  mockDb.insert.mockReturnValueOnce({ values });
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_user_id: AGENT_USER,
    org_id: ORG_A,
    enabled: true,
    allowed_tools: ['*'],
    channel_subscriptions: [],
    rate_limit_override: null,
    notes: null,
    updated_at: new Date('2026-04-18T00:00:00Z'),
    updated_by: HUMAN_USER,
    ...overrides,
  };
}

// ---------- matchesAllowlist / isToolAllowed ----------
describe('agent-policy allowlist matcher', () => {
  it('matches literal "*" against every tool name', () => {
    expect(matchesAllowlist('*', 'banter_post_message')).toBe(true);
    expect(matchesAllowlist('*', 'any_tool_here')).toBe(true);
  });

  it('treats "banter.*" as a prefix alias for the banter namespace', () => {
    expect(matchesAllowlist('banter.*', 'banter_post_message')).toBe(true);
    expect(matchesAllowlist('banter.*', 'banter_list_messages')).toBe(true);
    expect(matchesAllowlist('banter.*', 'banter')).toBe(true); // bare prefix hit
    expect(matchesAllowlist('banter.*', 'bond_get_deal')).toBe(false);
    expect(matchesAllowlist('banter.*', 'banterfoo')).toBe(false);
  });

  it('treats "banter_*" as a prefix match', () => {
    expect(matchesAllowlist('banter_*', 'banter_post_message')).toBe(true);
    expect(matchesAllowlist('banter_*', 'bond_get_deal')).toBe(false);
  });

  it('exact match for entries without a wildcard', () => {
    expect(matchesAllowlist('get_me', 'get_me')).toBe(true);
    expect(matchesAllowlist('get_me', 'get_my_tasks')).toBe(false);
  });

  it('isToolAllowed fails closed on empty list', () => {
    expect(isToolAllowed([], 'banter_post_message')).toBe(false);
  });

  it('isToolAllowed honors a mix of patterns', () => {
    const allow = ['banter_*', 'get_me', 'bond_get_*'];
    expect(isToolAllowed(allow, 'banter_post_message')).toBe(true);
    expect(isToolAllowed(allow, 'get_me')).toBe(true);
    expect(isToolAllowed(allow, 'bond_get_deal')).toBe(true);
    expect(isToolAllowed(allow, 'bond_create_deal')).toBe(false);
  });
});

// ---------- checkPolicy ----------
describe('checkPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns AGENT_DISABLED when no policy row exists', async () => {
    mockSelectLimit([]); // getPolicy sees no rows
    const r = await checkPolicy(AGENT_USER, 'banter_post_message');
    expect(r.allowed).toBe(false);
    if (r.allowed === false) {
      expect(r.reason).toBe('AGENT_DISABLED');
      expect(r.contact).toBeNull();
    }
  });

  it('returns AGENT_DISABLED when policy.enabled is false', async () => {
    mockSelectLimit([
      {
        policy: policyRow({ enabled: false }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);
    const r = await checkPolicy(AGENT_USER, 'banter_post_message');
    expect(r.allowed).toBe(false);
    if (r.allowed === false) {
      expect(r.reason).toBe('AGENT_DISABLED');
      expect(r.contact).toBe('Eddie');
      expect(r.disabled_at).toBe(new Date('2026-04-18T00:00:00Z').toISOString());
    }
  });

  it('returns TOOL_NOT_ALLOWED when tool is not in the list', async () => {
    mockSelectLimit([
      {
        policy: policyRow({ allowed_tools: ['banter_*'] }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);
    const r = await checkPolicy(AGENT_USER, 'bond_get_deal');
    expect(r.allowed).toBe(false);
    if (r.allowed === false) {
      expect(r.reason).toBe('TOOL_NOT_ALLOWED');
      expect(r.contact).toBe('Eddie');
    }
  });

  it('returns allowed:true when tool matches glob', async () => {
    mockSelectLimit([
      {
        policy: policyRow({ allowed_tools: ['banter_*'] }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);
    const r = await checkPolicy(AGENT_USER, 'banter_post_message');
    expect(r.allowed).toBe(true);
  });

  it('returns allowed:true when allowed_tools contains "*"', async () => {
    mockSelectLimit([
      {
        policy: policyRow({ allowed_tools: ['*'] }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);
    const r = await checkPolicy(AGENT_USER, 'any_random_tool');
    expect(r.allowed).toBe(true);
  });
});

// ---------- getPolicy ----------
describe('getPolicy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no row', async () => {
    mockSelectLimit([]);
    expect(await getPolicy(AGENT_USER)).toBeNull();
  });

  it('joins the updater display_name', async () => {
    mockSelectLimit([
      {
        policy: policyRow({ allowed_tools: ['banter_*', 'get_me'] }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);
    const r = await getPolicy(AGENT_USER);
    expect(r).not.toBeNull();
    expect(r!.updated_by_user).toEqual({ id: HUMAN_USER, name: 'Eddie' });
    expect(r!.allowed_tools).toEqual(['banter_*', 'get_me']);
  });
});

// ---------- setPolicy ----------
describe('setPolicy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-agent targets', async () => {
    mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'human' }]);
    const r = await setPolicy(AGENT_USER, { enabled: false }, { id: HUMAN_USER, org_id: ORG_A }, null);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('NOT_AN_AGENT');
  });

  it('rejects cross-org targets', async () => {
    mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_B, kind: 'service' }]);
    const r = await setPolicy(AGENT_USER, { enabled: false }, { id: HUMAN_USER, org_id: ORG_A }, null);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('CROSS_ORG');
  });

  it('returns confirmation_required:true when flipping enabled=true to false', async () => {
    // 1. users lookup
    mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'service' }]);
    // 2. getPolicy (pre-write) — returns enabled:true
    mockSelectLimit([
      { policy: policyRow({ enabled: true }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
    ]);
    // 3. update
    mockUpdate();
    // 4. getPolicy (post-write) — returns enabled:false
    mockSelectLimit([
      { policy: policyRow({ enabled: false }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
    ]);

    const r = await setPolicy(
      AGENT_USER,
      { enabled: false },
      { id: HUMAN_USER, org_id: ORG_A },
      mockRedis as any,
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.confirmation_required).toBe(true);
      expect(r.enabled).toBe(false);
    }
    expect(mockRedis.publish).toHaveBeenCalledWith('agent_policies:invalidate', AGENT_USER);
  });

  it('does NOT set confirmation_required when patch only tweaks allowed_tools', async () => {
    mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'service' }]);
    mockSelectLimit([
      { policy: policyRow({ enabled: true }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
    ]);
    mockUpdate();
    mockSelectLimit([
      {
        policy: policyRow({ enabled: true, allowed_tools: ['banter_*'] }),
        updater_id: HUMAN_USER,
        updater_name: 'Eddie',
      },
    ]);

    const r = await setPolicy(
      AGENT_USER,
      { allowed_tools: ['banter_*'] },
      { id: HUMAN_USER, org_id: ORG_A },
      null,
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.confirmation_required).toBe(false);
      expect(r.allowed_tools).toEqual(['banter_*']);
    }
  });

  it('inserts a new row when the policy did not exist', async () => {
    mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'agent' }]);
    // Pre-write getPolicy returns empty
    mockSelectLimit([]);
    // insert
    mockInsertValues();
    // Post-write getPolicy returns the new row
    mockSelectLimit([
      { policy: policyRow({ allowed_tools: ['banter_*'] }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
    ]);

    const r = await setPolicy(
      AGENT_USER,
      { allowed_tools: ['banter_*'] },
      { id: HUMAN_USER, org_id: ORG_A },
      null,
    );
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      // No flip from enabled:true -> enabled:false because there was no existing
      // row; new rows default to enabled:true, so confirmation_required is false.
      expect(r.confirmation_required).toBe(false);
    }
  });
});

// ---------- listPolicies ----------
describe('listPolicies', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shapes rows with display_name and last_heartbeat_at', async () => {
    const heartbeat = new Date('2026-04-18T10:00:00Z');
    mockSelectListPolicies([
      {
        agent_user_id: AGENT_USER,
        agent_name: 'banter-listener',
        enabled: true,
        allowed_tools: ['banter_*', 'get_me'],
        updated_at: new Date('2026-04-18T00:00:00Z'),
        last_heartbeat_at: heartbeat,
      },
      {
        agent_user_id: AGENT_USER_2,
        agent_name: 'intake-worker',
        enabled: false,
        allowed_tools: ['*'],
        updated_at: new Date('2026-04-17T00:00:00Z'),
        last_heartbeat_at: null,
      },
    ]);

    const rows = await listPolicies(ORG_A);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent_name).toBe('banter-listener');
    expect(rows[0]!.allowed_tool_count).toBe(2);
    expect(rows[0]!.last_heartbeat_at).toBe(heartbeat.toISOString());
    expect(rows[1]!.last_heartbeat_at).toBeNull();
  });
});

// ---------- routes smoke ----------
describe('agent-policy routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  describe('GET /v1/agent-policies/:id', () => {
    it('401 unauth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/agent-policies/${AGENT_USER}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('404 when no row', async () => {
      mockSelectLimit([]);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404 cross-org', async () => {
      mockSelectLimit([
        { policy: policyRow({ org_id: ORG_B }), updater_id: HUMAN_USER, updater_name: 'x' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('200 with the row shape', async () => {
      mockSelectLimit([
        {
          policy: policyRow({ allowed_tools: ['banter_*'] }),
          updater_id: HUMAN_USER,
          updater_name: 'Eddie',
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.agent_user_id).toBe(AGENT_USER);
      expect(body.data.allowed_tools).toEqual(['banter_*']);
      expect(body.data.updated_by_user).toEqual({ id: HUMAN_USER, name: 'Eddie' });
    });
  });

  describe('POST /v1/agent-policies/:id/check', () => {
    it('returns { allowed: true } when tool matches', async () => {
      mockSelectLimit([
        { policy: policyRow({ allowed_tools: ['banter_*'] }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}/check?tool=banter_post_message`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.allowed).toBe(true);
    });

    it('returns TOOL_NOT_ALLOWED when mismatch', async () => {
      mockSelectLimit([
        { policy: policyRow({ allowed_tools: ['banter_*'] }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}/check?tool=bond_get_deal`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.allowed).toBe(false);
      expect(body.data.reason).toBe('TOOL_NOT_ALLOWED');
    });

    it('400 when tool query missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}/check`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/agent-policies/:id (upsert)', () => {
    it('400 on invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
        payload: { enabled: 'not-a-boolean' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('400 NOT_AN_AGENT when target user is human', async () => {
      mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'human' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NOT_AN_AGENT');
    });

    it('200 with confirmation_required on disable flip', async () => {
      // users lookup
      mockSelectUsersLimit([{ id: AGENT_USER, org_id: ORG_A, kind: 'service' }]);
      // pre-write getPolicy
      mockSelectLimit([
        { policy: policyRow({ enabled: true }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
      ]);
      // update
      mockUpdate();
      // post-write getPolicy
      mockSelectLimit([
        { policy: policyRow({ enabled: false }), updater_id: HUMAN_USER, updater_name: 'Eddie' },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-policies/${AGENT_USER}`,
        headers: { 'x-test-user': 'human' },
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.confirmation_required).toBe(true);
      expect(body.data.enabled).toBe(false);
    });
  });
});

// #367: the MCP policy gate calls the check route about its own caller before every tool call,
// so a project-restricted agent key must be allowed to ask about itself, and only itself.
describe('POST /v1/agent-policies/:id/check keyProjectExempt (#367)', () => {
  it('declares a self-only exemption from the project-restriction gate', async () => {
    const a = Fastify({ logger: false });
    a.decorateRequest('user', null);
    a.decorate('redis', mockRedis as any);
    let cfg: any;
    a.addHook('onRoute', (r) => {
      if (r.url === '/v1/agent-policies/:agent_user_id/check') cfg = r.config;
    });
    await a.register(agentPoliciesRoutes);
    await a.ready();
    expect(typeof cfg?.keyProjectExempt).toBe('function');
    expect(cfg.keyProjectExempt({ params: { agent_user_id: AGENT_USER }, user: { id: AGENT_USER } })).toBe(true);
    expect(cfg.keyProjectExempt({ params: { agent_user_id: AGENT_USER_2 }, user: { id: AGENT_USER } })).toBe(false);
    await a.close();
  });
});
