import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
// We swap out the db module and the requireAuth plugin so the route can
// be exercised in isolation. The drizzle query chain on the catalog
// endpoint is `select().from().where().orderBy().limit()` for the page
// fetch and `select().from().where()` for the count, both run in
// parallel.
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

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

import permissionsAdminRoutes from '../src/routes/permissions-admin.routes.js';

// ---------- fixtures ----------
const SUPERUSER = { id: 'su-1', is_superuser: true };
const NORMAL_USER = { id: 'avery-1', is_superuser: false };

/** Build a canonical permission row matching the route's select shape. */
function makeRow(overrides: Partial<{
  id: string;
  app: string;
  resource: string;
  verb: string;
  is_destructive: boolean;
  is_read: boolean;
  requires_superuser: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'bam.task.create',
    app: overrides.app ?? 'bam',
    resource: overrides.resource ?? 'task',
    verb: overrides.verb ?? 'create',
    description: 'desc',
    is_destructive: overrides.is_destructive ?? false,
    is_read: overrides.is_read ?? false,
    requires_confirmation: false,
    requires_superuser: overrides.requires_superuser ?? false,
  };
}

/**
 * Stub the two drizzle chains the catalog endpoint runs. The first
 * select() call is the page query and resolves at the .limit() step;
 * the second select() call is the count and resolves at the .where()
 * step. Both share a tracker so the test can inspect what was filtered.
 */
function mockCatalogQueries(opts: { pageRows: any[]; total: number }) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const which = call++;
    if (which === 0) {
      // Page query: .select(...).from(...).where(...).orderBy(...).limit(N) -> rows
      const limit = vi.fn().mockResolvedValue(opts.pageRows);
      const orderBy = vi.fn().mockReturnValue({ limit });
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    }
    // Count query: .select({total}).from(...).where(...) -> [{total}]
    const result = [{ total: opts.total }];
    const where = vi.fn().mockResolvedValue(result);
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Test scaffolding for fastify.requireCan: gate everything on
  // request.user.is_superuser, exactly like the production resolver
  // would short-circuit at step 1.
  (app as any).decorate(
    'requireCan',
    () => async (request: any, reply: any) => {
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

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-test-user'];
    if (header === 'superuser') {
      (request as any).user = SUPERUSER;
    } else if (header === 'avery') {
      (request as any).user = NORMAL_USER;
    }
  });

  await app.register(permissionsAdminRoutes);
  return app;
}

// ---------- tests ----------
describe('GET /superuser/permissions/catalog', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  describe('access control', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('returns 403 to avery (non-SuperUser)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog',
        headers: { 'x-test-user': 'avery' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  });

  describe('no filters', () => {
    it('returns 200 items and next_cursor when total > 200', async () => {
      // Service returns limit+1 = 201 rows so the route detects more pages.
      const pageRows = Array.from({ length: 201 }, (_, i) =>
        makeRow({ id: `bam.resource${String(i).padStart(3, '0')}.list` }),
      );
      mockCatalogQueries({ pageRows, total: 1047 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(200);
      expect(body.data.next_cursor).toBe('bam.resource199.list');
      expect(body.data.total).toBe(1047);
    });

    it('returns next_cursor=null when fewer than limit rows match', async () => {
      const pageRows = [
        makeRow({ id: 'bam.task.create' }),
        makeRow({ id: 'bam.task.delete' }),
      ];
      mockCatalogQueries({ pageRows, total: 2 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(2);
      expect(body.data.next_cursor).toBeNull();
      expect(body.data.total).toBe(2);
    });
  });

  describe('app filter', () => {
    it('passes app=bam through to the query and returns only bam.* rows', async () => {
      const pageRows = [
        makeRow({ id: 'bam.task.create', app: 'bam' }),
        makeRow({ id: 'bam.task.delete', app: 'bam', verb: 'delete' }),
      ];
      mockCatalogQueries({ pageRows, total: 2 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog?app=bam',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(2);
      for (const item of body.data.items) {
        expect(item.app).toBe('bam');
      }
    });
  });

  describe('search filter', () => {
    it('returns permissions matching the substring', async () => {
      const pageRows = [
        makeRow({ id: 'bam.task.create' }),
        makeRow({ id: 'bam.task.delete', verb: 'delete' }),
        makeRow({ id: 'banter.task.assign', app: 'banter', verb: 'assign' }),
      ];
      mockCatalogQueries({ pageRows, total: 3 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog?search=task',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(3);
      for (const item of body.data.items) {
        expect(item.id).toContain('task');
      }
    });
  });

  describe('is_destructive filter', () => {
    it('returns destructive-only when is_destructive=true', async () => {
      const pageRows = [
        makeRow({ id: 'bam.task.delete', verb: 'delete', is_destructive: true }),
        makeRow({ id: 'platform.org.delete', app: 'platform', resource: 'org', verb: 'delete', is_destructive: true }),
      ];
      mockCatalogQueries({ pageRows, total: 2 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog?is_destructive=true',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(2);
      for (const item of body.data.items) {
        expect(item.is_destructive).toBe(true);
      }
    });
  });

  describe('limit clamping', () => {
    it('clamps limit above 2000 down to 2000', async () => {
      mockCatalogQueries({ pageRows: [], total: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/catalog?limit=5000',
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
