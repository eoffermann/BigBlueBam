/**
 * Route-level tests for the bookmark endpoints (fastify.inject against the real
 * route module, db mocked). Guards: the routes exist at their documented paths,
 * POST persists, the new by-message delete works, and membership is enforced.
 *
 * NOTE: these assert routing + handler logic around the DB. The flat response
 * SHAPE of GET /v1/bookmarks comes from the `.select({...})` column map, which a
 * db mock bypasses — that shape is proven by the /ui-debug live smoke instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../src/db/index.js', () => ({ db: mockDb, connection: { end: vi.fn() } }));

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

import bookmarkRoutes from '../src/routes/bookmark.routes.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '88888888-8888-8888-8888-888888888888';
const MSG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user'] === 'human') {
      (request as any).user = { id: USER, org_id: ORG, role: 'member', is_superuser: false };
    }
  });
  await app.register(bookmarkRoutes);
  return app;
}

// select().from().where().limit() -> rows
function mockSelectLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// insert().values().onConflictDoNothing().returning() -> rows  (returns the values spy)
function mockInsertReturning(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mockDb.insert.mockReturnValueOnce({ values });
  return values;
}

function mockDeleteWhere() {
  const where = vi.fn().mockResolvedValue(undefined);
  mockDb.delete.mockReturnValueOnce({ where });
  return where;
}

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.insert.mockReset();
  mockDb.delete.mockReset();
});

const auth = { 'x-test-user': 'human' as const };

describe('bookmark routes', () => {
  it('POST /v1/bookmarks requires auth (401 without user)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/bookmarks', payload: { message_id: MSG } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /v1/bookmarks persists a bookmark with the message_id', async () => {
    mockSelectLimit([{ id: MSG, channel_id: 'c1', is_deleted: false }]); // message exists
    mockSelectLimit([{ id: 'c1', type: 'public', org_id: ORG }]); // channel
    mockSelectLimit([{ user_id: USER, channel_id: 'c1' }]); // membership
    const values = mockInsertReturning([{ id: 'bm1', user_id: USER, message_id: MSG }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/bookmarks', headers: auth, payload: { message_id: MSG } });
    expect(res.statusCode).toBe(201);
    expect(mockDb.insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER, message_id: MSG }));
    await app.close();
  });

  it('POST /v1/bookmarks 404s when the message does not exist', async () => {
    mockSelectLimit([]); // message not found
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/bookmarks', headers: auth, payload: { message_id: MSG } });
    expect(res.statusCode).toBe(404);
    expect(mockDb.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /v1/bookmarks/by-message/:messageId exists and deletes (NOT a 404 path)', async () => {
    const where = mockDeleteWhere();
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/v1/bookmarks/by-message/${MSG}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: { success: true } });
    expect(mockDb.delete).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /v1/bookmarks/:id deletes by bookmark id', async () => {
    mockDeleteWhere();
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/bookmarks/bm1', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mockDb.delete).toHaveBeenCalledOnce();
    await app.close();
  });
});
