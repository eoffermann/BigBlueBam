// Wave F.1.b user-permissions route tests.
//
// Same pattern as F.1.a's group-CRUD tests: smoke + auth-gating that
// exercises the route registration and the SU-only preHandler. The deeper
// integration coverage (resolver-driven effective_matrix, the detach
// trigger snapshot logic, the reattach cascade) is exercised end-to-end
// against the live stack in the docs/wave-d-audit/wave-f-1b-users-backend.md
// smoke section, because mocking Drizzle's transaction + composite-PK
// upsert chains convincingly here would be reimplementing a SQL planner.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ─── Hoisted mocks ────────────────────────────────────────────────
const {
  mockDb,
  mockInvalidatePermissionsForUser,
  mockLogSuperuserAction,
} = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  mockInvalidatePermissionsForUser: vi.fn().mockResolvedValue(undefined),
  mockLogSuperuserAction: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../src/services/permissions.service.js', () => ({
  invalidatePermissionsForUser: mockInvalidatePermissionsForUser,
}));

vi.mock('../src/services/superuser-audit.service.js', () => ({
  logSuperuserAction: mockLogSuperuserAction,
}));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────
import permissionsAdminRoutes from '../src/routes/permissions-admin.routes.js';

// ─── Fixtures ─────────────────────────────────────────────────────
const SUPERUSER = { id: 'su-user-1', is_superuser: true };
const NORMAL_USER = { id: 'normal-user-1', is_superuser: false };

// Real avery uuid from the seeded test stack; using it keeps the smoke
// transcript and the unit-test logs aligned.
const AVERY_USER_ID = '969d36a7-a10d-4a64-99dc-f2a95fe2b038';
const ORG_ID = '57158e52-227d-4903-b0d8-d9f3c4910f61';
const MEMBER_GROUP_ID = '33333333-3333-4333-8333-333333333333';
const VIEWER_GROUP_ID = '44444444-4444-4444-4444-444444444444';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Synthetic requireCan: SU bypass mirrors the real resolver; non-SU 403s.
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
          error: { code: 'PERMISSION_DENIED', message: 'SuperUser required' },
        });
      }
    },
  );

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-test-user'];
    if (header === 'superuser') (request as any).user = SUPERUSER;
    else if (header === 'normal') (request as any).user = NORMAL_USER;
  });

  await app.register(permissionsAdminRoutes);
  return app;
}

// ─── Drizzle chain helpers ────────────────────────────────────────
// The GET /users/:id handler issues five sequential `.select(...)` calls
// (user row, org memberships, account_group_memberships join, account
// _permissions, permission_group_defaults). We orchestrate them by
// queueing per-call resolutions.
function queueSelect(resultsInOrder: any[][]) {
  let i = 0;
  mockDb.select.mockImplementation(() => {
    const idx = i++;
    const rows = resultsInOrder[idx] ?? [];
    // The simplest chain shape — select().from().where().limit() — needs
    // to resolve to `rows` at both .limit() and .where() leaves. We give
    // .where() a dual shape so `.limit()` and direct `.where()` both
    // resolve, and .innerJoin() returns the same `from` chain.
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => {
      const inner = Object.assign(Promise.resolve(rows), { limit });
      return inner;
    });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ where, innerJoin });
    return { from };
  });
}

// ─── Tests ────────────────────────────────────────────────────────
describe('Wave F.1.b — permissions-admin user routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  // ── Auth gating ────────────────────────────────────────────────
  describe('auth gating', () => {
    it('returns 401 on GET /users/:id without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/superuser/permissions/users/${AVERY_USER_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 on GET /users/:id for non-SU', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/superuser/permissions/users/${AVERY_USER_ID}`,
        headers: { 'x-test-user': 'normal' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('returns 403 on PUT /users/:id/membership for non-SU', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/membership`,
        headers: { 'x-test-user': 'normal' },
        payload: { scope_type: 'org', scope_id: ORG_ID, group_id: VIEWER_GROUP_ID },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on PUT override for non-SU', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/overrides/bam.audit_log.list`,
        headers: { 'x-test-user': 'normal' },
        payload: { scope_type: 'org', scope_id: ORG_ID, granted: true },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on DELETE override for non-SU', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/overrides/bam.audit_log.list`,
        headers: { 'x-test-user': 'normal' },
        payload: { scope_type: 'org', scope_id: ORG_ID },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on POST reattach for non-SU', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/reattach`,
        headers: { 'x-test-user': 'normal' },
        payload: { scope_type: 'org', scope_id: ORG_ID },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Input validation ───────────────────────────────────────────
  describe('input validation', () => {
    it('returns 400 on GET when user id is not a UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/users/not-a-uuid',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 on PUT membership when scope_id missing for scope_type=org', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/membership`,
        headers: { 'x-test-user': 'superuser' },
        payload: { scope_type: 'org', group_id: VIEWER_GROUP_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 on PUT override when notes exceeds 1000 chars', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/overrides/bam.audit_log.list`,
        headers: { 'x-test-user': 'superuser' },
        payload: {
          scope_type: 'org',
          scope_id: ORG_ID,
          granted: true,
          notes: 'a'.repeat(1001),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET happy-path shape ───────────────────────────────────────
  describe('GET /users/:id', () => {
    it('returns 404 when user does not exist', async () => {
      // The first .select() (user row) resolves to [].
      queueSelect([[]]);
      const res = await app.inject({
        method: 'GET',
        url: `/superuser/permissions/users/${AVERY_USER_ID}`,
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('returns 200 with the full picture for a known user', async () => {
      // Five selects in order:
      //   1) user row
      //   2) org memberships
      //   3) account_group_memberships join permission_groups
      //   4) account_permissions
      //   5) permission_group_defaults (only when there are membership rows)
      queueSelect([
        [
          {
            id: AVERY_USER_ID,
            email: 'avery@example.com',
            display_name: 'Avery',
            is_superuser: false,
            kind: 'human',
          },
        ],
        [{ org_id: ORG_ID, is_default: true }],
        [
          {
            scope_type: 'org',
            scope_id: ORG_ID,
            detached_at: null,
            detached_by: null,
            group_id: MEMBER_GROUP_ID,
            group_name: 'Member',
            group_legacy_role: 'member',
            group_is_builtin: true,
          },
        ],
        [],
        [
          // Minimal default — `bam.task.create` granted to Member.
          { group_id: MEMBER_GROUP_ID, permission_id: 'bam.task.create', granted: true },
        ],
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/superuser/permissions/users/${AVERY_USER_ID}`,
        headers: { 'x-test-user': 'superuser' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.user.id).toBe(AVERY_USER_ID);
      expect(body.data.user.primary_org_id).toBe(ORG_ID);
      expect(body.data.memberships).toHaveLength(1);
      expect(body.data.memberships[0].group.name).toBe('Member');
      // effective_matrix should include every catalog permission, and the
      // single granted default we wired must resolve to allow/group_default.
      expect(body.data.effective_matrix['bam.task.create']).toMatchObject({
        granted: true,
        source: 'group_default',
        group_id: MEMBER_GROUP_ID,
      });
    });
  });

  // ── DELETE override 404 ────────────────────────────────────────
  describe('DELETE /users/:id/overrides/:permission_id', () => {
    it('returns 404 when no matching override exists', async () => {
      // db.transaction returns whatever the callback resolves to; the
      // callback uses tx.delete(...).returning(), so we mock the inner
      // chain to resolve to [] and the count is therefore 0.
      mockDb.transaction.mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([]),
            })),
          })),
        };
        return fn(tx);
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/overrides/bam.audit_log.list`,
        headers: { 'x-test-user': 'superuser' },
        payload: { scope_type: 'org', scope_id: ORG_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
      // Cache invalidation must NOT fire on a no-op delete.
      expect(mockInvalidatePermissionsForUser).not.toHaveBeenCalled();
    });
  });

  // ── Reattach cache-invalidation contract ───────────────────────
  describe('POST /users/:id/reattach', () => {
    it('invokes invalidatePermissionsForUser + logs the audit row', async () => {
      // User exists.
      queueSelect([[{ id: AVERY_USER_ID }]]);

      mockDb.transaction.mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi
                .fn()
                .mockResolvedValue([
                  { permission_id: 'bam.audit_log.list' },
                  { permission_id: 'bam.task.create' },
                ]),
            })),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(undefined),
            })),
          })),
        };
        return fn(tx);
      });

      const res = await app.inject({
        method: 'POST',
        url: `/superuser/permissions/users/${AVERY_USER_ID}/reattach`,
        headers: { 'x-test-user': 'superuser' },
        payload: { scope_type: 'org', scope_id: ORG_ID },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.dropped_overrides).toBe(2);
      expect(mockInvalidatePermissionsForUser).toHaveBeenCalledWith(
        AVERY_USER_ID,
      );
      expect(mockLogSuperuserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'permissions.user.reattach',
          targetId: AVERY_USER_ID,
        }),
      );
    });
  });
});
