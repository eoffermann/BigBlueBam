// Wave F.1.a group CRUD route tests.
//
// These are smoke + auth-gating tests that exercise the route registration
// and the SU-only preHandler. Deeper integration coverage (clone semantics,
// glob expansion against the real catalog, the reset endpoint reading
// permission_group_defaults_baseline) is exercised end-to-end against the
// live stack in the docs/wave-d-audit/wave-f-1a-groups-backend.md smoke
// section — Drizzle's transaction + sql.execute chains are difficult to
// mock convincingly without re-implementing a SQL planner here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ─── Hoisted mocks ────────────────────────────────────────────────
const {
  mockDb,
  mockInvalidatePermissionsForUser,
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

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }
  },
}));

vi.mock('../src/services/superuser-audit.service.js', () => ({
  logSuperuserAction: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (after mocks) ────────────────────────────────────────
import permissionsAdminRoutes from '../src/routes/permissions-admin.routes.js';

// ─── Test scaffolding ─────────────────────────────────────────────
const SUPERUSER = { id: 'su-user-1', is_superuser: true };
const NORMAL_USER = { id: 'normal-user-1', is_superuser: false };

const MEMBER_GROUP_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOM_GROUP_ID = '99999999-9999-4999-8999-999999999999';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Synthetic requireCan: SU bypass mirrors the real resolver, non-SU 403s.
  (app as any).decorate('requireCan', () => async (request: any, reply: any) => {
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
  });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-test-user'];
    if (header === 'superuser') (request as any).user = SUPERUSER;
    else if (header === 'normal') (request as any).user = NORMAL_USER;
  });

  await app.register(permissionsAdminRoutes);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────
describe('Wave F.1.a — permissions-admin group routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  // ── Auth gating ─────────────────────────────────────────────────
  describe('auth gating', () => {
    it('returns 401 on GET /superuser/permissions/groups without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/superuser/permissions/groups' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 on GET /superuser/permissions/groups for non-SU (avery-style)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'normal' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('returns 403 on POST /superuser/permissions/groups for non-SU', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'normal' },
        payload: { name: 'X', scope_type: 'global' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on DELETE for non-SU', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}`,
        headers: { 'x-test-user': 'normal' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on PUT defaults for non-SU', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}/defaults`,
        headers: { 'x-test-user': 'normal' },
        payload: { set_true: ['bam.task.create'] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on reset for non-SU', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}/reset`,
        headers: { 'x-test-user': 'normal' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── GET /groups (SU) ────────────────────────────────────────────
  describe('GET /superuser/permissions/groups as SU', () => {
    it('returns the 5 built-in groups with member/grant/deny counts', async () => {
      const rows = [
        { id: 'owner-id', name: 'Owner', is_builtin: true, legacy_role: 'owner',
          scope_type: 'global', scope_id: null,
          member_count: 1, grant_count: 1060, deny_count: 0 },
        { id: 'admin-id', name: 'Admin', is_builtin: true, legacy_role: 'admin',
          scope_type: 'global', scope_id: null,
          member_count: 2, grant_count: 1056, deny_count: 4 },
        { id: MEMBER_GROUP_ID, name: 'Member', is_builtin: true, legacy_role: 'member',
          scope_type: 'global', scope_id: null,
          member_count: 12, grant_count: 600, deny_count: 460 },
        { id: 'viewer-id', name: 'Viewer', is_builtin: true, legacy_role: 'viewer',
          scope_type: 'global', scope_id: null,
          member_count: 3, grant_count: 430, deny_count: 630 },
        { id: 'guest-id', name: 'Guest', is_builtin: true, legacy_role: 'guest',
          scope_type: 'global', scope_id: null,
          member_count: 0, grant_count: 200, deny_count: 860 },
      ];
      mockDb.execute.mockResolvedValueOnce(rows);

      const res = await app.inject({
        method: 'GET',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(5);
      expect(body.data[2].name).toBe('Member');
      expect(body.data[2].member_count).toBe(12);
      expect(body.data[2].grant_count).toBe(600);
    });
  });

  // ── DELETE /groups/:id ──────────────────────────────────────────
  describe('DELETE /superuser/permissions/groups/:id', () => {
    it('returns 422 FORBIDDEN_BUILTIN on built-in delete attempt', async () => {
      // First select returns the built-in group.
      const groupRow = {
        id: MEMBER_GROUP_ID, name: 'Member', is_builtin: true,
        legacy_role: 'member', deleted_at: null,
        scope_type: 'global', scope_id: null,
        created_at: new Date(), updated_at: new Date(),
      };
      const limit = vi.fn().mockResolvedValue([groupRow]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockDb.select.mockReturnValueOnce({ from });

      const res = await app.inject({
        method: 'DELETE',
        url: `/superuser/permissions/groups/${MEMBER_GROUP_ID}`,
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('FORBIDDEN_BUILTIN');
    });

    it('returns 409 GROUP_HAS_MEMBERS when live memberships remain', async () => {
      const groupRow = {
        id: CUSTOM_GROUP_ID, name: 'Channel Moderator', is_builtin: false,
        legacy_role: null, deleted_at: null,
        scope_type: 'project', scope_id: '11111111-1111-4111-8111-111111111111',
        created_at: new Date(), updated_at: new Date(),
      };
      const limit = vi.fn().mockResolvedValue([groupRow]);
      const where1 = vi.fn().mockReturnValue({ limit });
      const from1 = vi.fn().mockReturnValue({ where: where1 });
      // First select: group lookup.
      mockDb.select.mockReturnValueOnce({ from: from1 });
      // Second select: live memberships — 3 rows.
      const where2 = vi.fn().mockResolvedValue([
        { user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' },
      ]);
      const from2 = vi.fn().mockReturnValue({ where: where2 });
      mockDb.select.mockReturnValueOnce({ from: from2 });

      const res = await app.inject({
        method: 'DELETE',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}`,
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('GROUP_HAS_MEMBERS');
      expect(res.json().error.details[0].member_count).toBe(3);
    });

    it('returns 404 NOT_FOUND for an unknown group id', async () => {
      const limit = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockDb.select.mockReturnValueOnce({ from });

      const res = await app.inject({
        method: 'DELETE',
        url: '/superuser/permissions/groups/00000000-0000-4000-8000-000000000000',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  // ── PATCH /groups/:id ───────────────────────────────────────────
  describe('PATCH /superuser/permissions/groups/:id', () => {
    it('returns 422 FORBIDDEN_BUILTIN when renaming a built-in group', async () => {
      const groupRow = {
        id: MEMBER_GROUP_ID, name: 'Member', is_builtin: true,
        legacy_role: 'member', deleted_at: null,
        scope_type: 'global', scope_id: null,
        created_at: new Date(), updated_at: new Date(),
      };
      const limit = vi.fn().mockResolvedValue([groupRow]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockDb.select.mockReturnValueOnce({ from });

      const res = await app.inject({
        method: 'PATCH',
        url: `/superuser/permissions/groups/${MEMBER_GROUP_ID}`,
        headers: { 'x-test-user': 'superuser' },
        payload: { name: 'NotMember' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('FORBIDDEN_BUILTIN');
    });

    it('allows description-only edits on a built-in group', async () => {
      const groupRow = {
        id: MEMBER_GROUP_ID, name: 'Member', is_builtin: true,
        legacy_role: 'member', deleted_at: null,
        scope_type: 'global', scope_id: null,
        description: 'old',
        created_at: new Date(), updated_at: new Date(),
      };
      const limit = vi.fn().mockResolvedValue([groupRow]);
      const where1 = vi.fn().mockReturnValue({ limit });
      const from1 = vi.fn().mockReturnValue({ where: where1 });
      mockDb.select.mockReturnValueOnce({ from: from1 });

      const returning = vi.fn().mockResolvedValue([
        { ...groupRow, description: 'new description' },
      ]);
      const where2 = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where: where2 });
      mockDb.update.mockReturnValueOnce({ set });

      const res = await app.inject({
        method: 'PATCH',
        url: `/superuser/permissions/groups/${MEMBER_GROUP_ID}`,
        headers: { 'x-test-user': 'superuser' },
        payload: { description: 'new description' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.description).toBe('new description');
    });

    it('rejects an empty body via Zod refine', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}`,
        headers: { 'x-test-user': 'superuser' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── POST /groups (validation) ───────────────────────────────────
  describe('POST /superuser/permissions/groups validation', () => {
    it('rejects scope_id on global scope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          name: 'Bad',
          scope_type: 'global',
          scope_id: '11111111-1111-4111-8111-111111111111',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects missing scope_id on org scope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'superuser' },
        payload: { name: 'OrgGroup', scope_type: 'org' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/permissions/groups',
        headers: { 'x-test-user': 'superuser' },
        payload: { name: '', scope_type: 'global' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── PUT /defaults (validation) ──────────────────────────────────
  describe('PUT /superuser/permissions/groups/:id/defaults validation', () => {
    it('returns 422 PERMISSION_NOT_IN_CATALOG for unknown explicit id', async () => {
      // Group lookup returns a custom group.
      const groupRow = {
        id: CUSTOM_GROUP_ID, name: 'Channel Moderator', is_builtin: false,
        legacy_role: null, deleted_at: null,
        scope_type: 'global', scope_id: null,
        created_at: new Date(), updated_at: new Date(),
      };
      const limit = vi.fn().mockResolvedValue([groupRow]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockDb.select.mockReturnValueOnce({ from });

      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}/defaults`,
        headers: { 'x-test-user': 'superuser' },
        payload: { set_true: ['bam.bogus_id.create'] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('PERMISSION_NOT_IN_CATALOG');
      expect(res.json().error.details[0].permission_id).toBe('bam.bogus_id.create');
    });

    it('rejects empty body via Zod refine', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/superuser/permissions/groups/${CUSTOM_GROUP_ID}/defaults`,
        headers: { 'x-test-user': 'superuser' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });
});
