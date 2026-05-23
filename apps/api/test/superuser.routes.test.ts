import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
const { mockDb, mockSetActiveOrgId, mockClearActiveOrgId, mockLogSuperuserAction } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    },
    mockSetActiveOrgId: vi.fn().mockResolvedValue(undefined),
    mockClearActiveOrgId: vi.fn().mockResolvedValue(undefined),
    mockLogSuperuserAction: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../src/services/session.service.js', () => ({
  setActiveOrgId: mockSetActiveOrgId,
  clearActiveOrgId: mockClearActiveOrgId,
}));

vi.mock('../src/services/superuser-audit.service.js', () => ({
  logSuperuserAction: mockLogSuperuserAction,
}));

// Stub the real requireAuth plugin so routes still reference it, but we
// attach our own auth preHandler below that populates request.user based on
// a synthetic x-test-user header.
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }
  },
}));

// ---------- imports (after mocks) ----------
import superuserRoutes from '../src/routes/superuser.routes.js';

// ---------- test app builder ----------
interface TestUser {
  id: string;
  is_superuser: boolean;
}

const SUPERUSER: TestUser = { id: 'su-user-1', is_superuser: true };
const NORMAL_USER: TestUser = { id: 'normal-user-1', is_superuser: false };

const VALID_ORG_ID = '11111111-1111-1111-1111-111111111111';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Wave E test scaffolding: decorate a synthetic requireCan that gates
  // every superuser.* route on request.user.is_superuser. Real permission
  // decisions are exercised by the resolver tests; here we only care about
  // route plumbing and the SuperUser-vs-normal split.
  (app as any).decorate(
    'requireCan',
    () =>
      async (request: any, reply: any) => {
        if (!request.user) {
          return reply.status(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        if (!request.user.is_superuser) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'SuperUser required' },
          });
        }
      },
  );

  // Synthetic auth: read x-test-user header to populate request.user.
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-test-user'];
    if (header === 'superuser') {
      (request as any).user = SUPERUSER;
      (request as any).sessionId = 'test-session-su';
    } else if (header === 'normal') {
      (request as any).user = NORMAL_USER;
      (request as any).sessionId = 'test-session-normal';
    }
    // else leave as null -> requireAuth returns 401
  });

  await app.register(superuserRoutes, { prefix: '/superuser' });
  return app;
}

// ---------- drizzle query-chain mocks ----------
// Used by /superuser/organizations — a single `select().from().where().orderBy().limit()` chain.
function mockOrgListQuery(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where, orderBy });
  mockDb.select.mockReturnValue({ from });
}

// Used by /superuser/overview — many parallel count queries. Each follows
// `select({c}).from(table)` or `select({c}).from(table).where(...)`.
function mockOverviewQueries(counts: number[]) {
  let i = 0;
  mockDb.select.mockImplementation(() => {
    const idx = i++;
    const result = [{ c: counts[idx] ?? 0 }];
    const where = vi.fn().mockResolvedValue(result);
    // allow the .from().where() chain as well as awaiting .from() directly
    const from: any = vi.fn().mockReturnValue(
      Object.assign(Promise.resolve(result), { where }),
    );
    return { from };
  });
  // banter_channels is via db.execute()
  mockDb.execute.mockResolvedValue([{ c: counts[6] ?? 0 }]);
}

// Used by /superuser/context/switch — `select({id}).from(organizations).where().limit()`.
function mockOrgLookup(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValue({ from });
}

// ---------- tests ----------
describe('SuperUser routes (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  // 1. Unauthenticated -> 401
  describe('unauthenticated requests', () => {
    it('returns 401 on GET /superuser/organizations without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/organizations',
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 on GET /superuser/overview without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/superuser/overview' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 on POST /superuser/context/switch without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        payload: { org_id: VALID_ORG_ID },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 on POST /superuser/context/clear without auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/superuser/context/clear' });
      expect(res.statusCode).toBe(401);
    });
  });

  // 2. Authenticated non-SuperUser -> 403
  describe('non-SuperUser requests', () => {
    const headers = { 'x-test-user': 'normal' };

    it('returns 403 on GET /superuser/organizations', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/organizations',
        headers,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toMatch(/SuperUser/i);
    });

    it('returns 403 on GET /superuser/organizations/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/superuser/organizations/${VALID_ORG_ID}`,
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on GET /superuser/overview', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/overview',
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on POST /superuser/context/switch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        headers,
        payload: { org_id: VALID_ORG_ID },
      });
      expect(res.statusCode).toBe(403);
      // Middleware must block BEFORE any side effect runs.
      expect(mockSetActiveOrgId).not.toHaveBeenCalled();
    });

    it('returns 403 on POST /superuser/context/clear', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/clear',
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect(mockClearActiveOrgId).not.toHaveBeenCalled();
    });
  });

  // 3. SuperUser -> 200 on /organizations
  describe('SuperUser GET /superuser/organizations', () => {
    it('returns 200 and an org list', async () => {
      const now = new Date();
      mockOrgListQuery([
        {
          id: VALID_ORG_ID,
          name: 'Acme',
          slug: 'acme',
          created_at: now,
          member_count: 3,
          project_count: 2,
          task_count: 17,
          last_activity_at: now.toISOString(),
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/organizations',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(VALID_ORG_ID);
      expect(body.data[0].name).toBe('Acme');
      expect(body).toHaveProperty('next_cursor');
    });
  });

  // 4. SuperUser -> 200 on /overview
  describe('SuperUser GET /superuser/overview', () => {
    it('returns 200 and a stats object', async () => {
      // Order matches route: orgs, users, sessions, projects, tasks, tickets, banter(execute), new_users_7, new_users_30, new_orgs_7, new_orgs_30
      mockOverviewQueries([5, 42, 7, 9, 123, 4, 11, 2, 8, 1, 3]);

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/overview',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('total_orgs');
      expect(body).toHaveProperty('total_users');
      expect(body).toHaveProperty('total_active_sessions');
      expect(body).toHaveProperty('total_projects');
      expect(body).toHaveProperty('total_tasks');
      expect(body).toHaveProperty('total_tickets');
      expect(body).toHaveProperty('total_banter_channels');
      expect(body).toHaveProperty('new_users_7d');
      expect(body).toHaveProperty('new_users_30d');
      expect(body).toHaveProperty('new_orgs_7d');
      expect(body).toHaveProperty('new_orgs_30d');
      expect(typeof body.total_orgs).toBe('number');
    });
  });

  // 5. SuperUser POST /context/switch -> 200, sets active_org_id
  describe('SuperUser POST /superuser/context/switch', () => {
    it('returns 200 and calls setActiveOrgId with the target org_id', async () => {
      mockOrgLookup([{ id: VALID_ORG_ID }]);

      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        headers: { 'x-test-user': 'superuser' },
        payload: { org_id: VALID_ORG_ID },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.active_org_id).toBe(VALID_ORG_ID);
      expect(mockSetActiveOrgId).toHaveBeenCalledTimes(1);
      expect(mockSetActiveOrgId).toHaveBeenCalledWith('test-session-su', VALID_ORG_ID);
    });

    it('returns 404 when org does not exist', async () => {
      mockOrgLookup([]);

      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        headers: { 'x-test-user': 'superuser' },
        payload: { org_id: VALID_ORG_ID },
      });

      expect(res.statusCode).toBe(404);
      expect(mockSetActiveOrgId).not.toHaveBeenCalled();
    });

    it('returns 400 when org_id is not a uuid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        headers: { 'x-test-user': 'superuser' },
        payload: { org_id: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockSetActiveOrgId).not.toHaveBeenCalled();
    });
  });

  // 6. SuperUser POST /context/clear -> clears active_org_id
  describe('SuperUser POST /superuser/context/clear', () => {
    it('returns 200 and calls clearActiveOrgId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/context/clear',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockClearActiveOrgId).toHaveBeenCalledTimes(1);
      expect(mockClearActiveOrgId).toHaveBeenCalledWith('test-session-su');
    });
  });

  // 7. Audit log rows on every /superuser/* call
  describe('superuser_audit_log emission', () => {
    it('writes an audit row with action=org.list on /organizations', async () => {
      mockOrgListQuery([]);
      await app.inject({
        method: 'GET',
        url: '/superuser/organizations',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(mockLogSuperuserAction).toHaveBeenCalledTimes(1);
      expect(mockLogSuperuserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          superuserId: SUPERUSER.id,
          action: 'org.list',
        }),
      );
    });

    it('writes an audit row with action=overview.view on /overview', async () => {
      mockOverviewQueries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      await app.inject({
        method: 'GET',
        url: '/superuser/overview',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(mockLogSuperuserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          superuserId: SUPERUSER.id,
          action: 'overview.view',
        }),
      );
    });

    it('writes an audit row with action=context.switch on successful switch', async () => {
      mockOrgLookup([{ id: VALID_ORG_ID }]);
      await app.inject({
        method: 'POST',
        url: '/superuser/context/switch',
        headers: { 'x-test-user': 'superuser' },
        payload: { org_id: VALID_ORG_ID },
      });
      expect(mockLogSuperuserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          superuserId: SUPERUSER.id,
          action: 'context.switch',
          targetType: 'org',
          targetId: VALID_ORG_ID,
        }),
      );
    });

    it('writes an audit row with action=context.clear on clear', async () => {
      await app.inject({
        method: 'POST',
        url: '/superuser/context/clear',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(mockLogSuperuserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          superuserId: SUPERUSER.id,
          action: 'context.clear',
        }),
      );
    });

    it('does NOT write an audit row when a non-SuperUser is rejected', async () => {
      await app.inject({
        method: 'GET',
        url: '/superuser/organizations',
        headers: { 'x-test-user': 'normal' },
      });
      expect(mockLogSuperuserAction).not.toHaveBeenCalled();
    });
  });
});
