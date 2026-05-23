import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
const { mockDb, preflightSpy } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    preflightSpy: vi.fn(),
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
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }
  },
  requireScope: () => async (request: any, reply: any) => {
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

vi.mock('../src/services/visibility.service.js', () => ({
  SUPPORTED_ENTITY_TYPES: [
    'bam.task',
    'bam.project',
    'bam.sprint',
    'helpdesk.ticket',
    'bond.deal',
    'bond.contact',
    'bond.company',
    'brief.document',
    'beacon.entry',
  ] as const,
  preflightAccess: preflightSpy,
}));

import entityLinksRoutes from '../src/routes/entity-links.routes.js';

// ---------- test helpers ----------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '88888888-8888-8888-8888-888888888888';

const TASK_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TASK_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DEAL_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Wave E test scaffolding: decorate a pass-through requireCan so route
  // bindings don't throw at registration time. Real permission decisions
  // are exercised by the resolver tests; here we only care about route
  // plumbing and auth gating.
  (app as any).decorate('requireCan', () => async () => undefined);
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user'] === 'human') {
      (request as any).user = {
        id: USER_A,
        active_org_id: ORG_A,
        kind: 'human',
        role: 'member',
        is_superuser: false,
        org_id: ORG_A,
      };
    }
  });
  await app.register(entityLinksRoutes);
  return app;
}

// Drizzle-style chain mock helpers.

// select().from().where().orderBy().limit()  -> rows
function mockSelectOrdered(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// select().from().where()  -> rows   (no limit / orderBy)
function mockSelectNoLimit(rows: any[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// select().from().where().limit()  -> rows
function mockSelectLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// insert().values().onConflictDoNothing().returning()  -> rows
function mockInsertReturning(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mockDb.insert.mockReturnValueOnce({ values });
}

// delete().where()
function mockDelete() {
  const where = vi.fn().mockResolvedValue(undefined);
  mockDb.delete.mockReturnValueOnce({ where });
}

function linkRow(overrides: Partial<any> = {}) {
  return {
    id: '99999999-9999-9999-9999-999999999999',
    org_id: ORG_A,
    src_type: 'bam.task',
    src_id: TASK_A,
    dst_type: 'bam.task',
    dst_id: TASK_B,
    link_kind: 'related_to',
    created_by: USER_A,
    created_at: new Date('2026-04-18T00:00:00Z'),
    ...overrides,
  };
}

// ---------- tests ----------

describe('entity-links routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  // =============================================================
  // POST /v1/entity-links
  // =============================================================
  describe('POST /v1/entity-links', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 on unsupported src_type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bill.invoice', // not in the Wave 2 allowlist
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNSUPPORTED_ENTITY_TYPE');
    });

    it('returns 400 on unsupported dst_type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'book.booking_page', // not in Wave 2 allowlist
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNSUPPORTED_ENTITY_TYPE');
    });

    it('returns 403 when caller cannot access src', async () => {
      preflightSpy.mockResolvedValueOnce({ allowed: false, reason: 'not_project_member' });
      preflightSpy.mockResolvedValueOnce({ allowed: true, reason: 'ok' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect(res.json().error.preflight.side).toBe('src');
    });

    it('returns 403 when caller cannot access dst', async () => {
      preflightSpy.mockResolvedValueOnce({ allowed: true, reason: 'ok' });
      preflightSpy.mockResolvedValueOnce({ allowed: false, reason: 'not_project_member' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bond.deal',
          dst_id: DEAL_A,
          link_kind: 'references',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.preflight.side).toBe('dst');
    });

    it('creates a link with created: true when the insert returns a row', async () => {
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      mockInsertReturning([linkRow()]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.created).toBe(true);
      expect(body.data.link_kind).toBe('related_to');
    });

    it('is idempotent: re-create returns created: false', async () => {
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      // First chain: insert returns empty because of ON CONFLICT DO NOTHING.
      mockInsertReturning([]);
      // Second chain: the follow-up select returns the existing row.
      mockSelectLimit([linkRow()]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_B,
          link_kind: 'related_to',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.created).toBe(false);
      expect(body.data.id).toBe(linkRow().id);
    });

    it('rejects a parent_of write that would close a cycle', async () => {
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      // Cycle walk: starting at TASK_A (dst), one forward edge to TASK_B
      // (which is the src of the proposed edge). That is: TASK_A parent_of
      // TASK_B already exists, so adding TASK_B parent_of TASK_A closes a cycle.
      mockSelectNoLimit([
        { dst_type: 'bam.task', dst_id: TASK_B },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_B,
          dst_type: 'bam.task',
          dst_id: TASK_A,
          link_kind: 'parent_of',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CYCLE_DETECTED');
    });

    it('rejects a trivial self parent_of cycle', async () => {
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/entity-links',
        headers: { 'x-test-user': 'human' },
        payload: {
          src_type: 'bam.task',
          src_id: TASK_A,
          dst_type: 'bam.task',
          dst_id: TASK_A,
          link_kind: 'parent_of',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CYCLE_DETECTED');
    });
  });

  // =============================================================
  // GET /v1/entity-links
  // =============================================================
  describe('GET /v1/entity-links', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/entity-links?type=bam.task&id=${TASK_A}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('lists outbound-only with direction=src', async () => {
      const row = linkRow({ src_type: 'bam.task', src_id: TASK_A, dst_type: 'bam.task', dst_id: TASK_B });
      mockSelectOrdered([row]);
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/entity-links?type=bam.task&id=${TASK_A}&direction=src`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].direction).toBe('outbound');
      expect(body.filtered_count).toBe(0);
    });

    it('lists inbound-only with direction=dst', async () => {
      const row = linkRow({ src_type: 'bam.task', src_id: TASK_B, dst_type: 'bam.task', dst_id: TASK_A });
      mockSelectOrdered([row]);
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/entity-links?type=bam.task&id=${TASK_A}&direction=dst`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].direction).toBe('inbound');
    });

    it('lists both directions by default', async () => {
      const outbound = linkRow({ id: 'out', src_type: 'bam.task', src_id: TASK_A, dst_type: 'bam.task', dst_id: TASK_B });
      const inbound = linkRow({ id: 'in', src_type: 'bam.task', src_id: TASK_C, dst_type: 'bam.task', dst_id: TASK_A });
      mockSelectOrdered([outbound, inbound]);
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/entity-links?type=bam.task&id=${TASK_A}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(2);
      const dirs = body.data.map((r: any) => r.direction).sort();
      expect(dirs).toEqual(['inbound', 'outbound']);
    });

    it('silently drops rows whose far side the caller cannot see', async () => {
      // Two rows; caller can only see the first.
      const row1 = linkRow({ id: 'v', src_type: 'bam.task', src_id: TASK_A, dst_type: 'bam.task', dst_id: TASK_B });
      const row2 = linkRow({ id: 'h', src_type: 'bam.task', src_id: TASK_A, dst_type: 'bam.task', dst_id: TASK_C });
      mockSelectOrdered([row1, row2]);
      // First preflight: allowed. Second: denied.
      preflightSpy.mockResolvedValueOnce({ allowed: true, reason: 'ok' });
      preflightSpy.mockResolvedValueOnce({ allowed: false, reason: 'not_project_member' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/entity-links?type=bam.task&id=${TASK_A}&direction=src`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.filtered_count).toBe(1);
    });
  });

  // =============================================================
  // DELETE /v1/entity-links/:id
  // =============================================================
  describe('DELETE /v1/entity-links/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/entity-links/${linkRow().id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the row is not in the caller org', async () => {
      mockSelectLimit([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/entity-links/${linkRow().id}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 200 { ok: true } on success', async () => {
      mockSelectLimit([linkRow()]);
      preflightSpy.mockResolvedValue({ allowed: true, reason: 'ok' });
      mockDelete();
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/entity-links/${linkRow().id}`,
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });
  });
});
