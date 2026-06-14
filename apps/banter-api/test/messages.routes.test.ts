/**
 * Route-level tests for the message endpoints (fastify.inject, db mocked).
 * Focus:
 *  - GET /v1/channels/:id/messages computes per-row is_bookmarked (per-user)
 *    and is_pinned (channel-wide) — the mapping that, when hardcoded false,
 *    hid bookmark/pin state on revisit.
 *  - PATCH/DELETE /v1/messages/:id exist at those paths (NOT channel-scoped)
 *    and perform the update — guards the wrong-URL regression at the server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn() },
}));

vi.mock('../src/db/index.js', () => ({ db: mockDb, connection: { end: vi.fn() } }));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'x', details: [], request_id: request.id } });
  },
  requireScope: () => async (request: any, reply: any) => {
    if (!request.user) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'x', details: [], request_id: request.id } });
  },
}));
vi.mock('../src/middleware/channel-auth.js', () => ({
  requireChannelMember: async () => undefined,
}));
vi.mock('../src/services/realtime.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcastToOrg: vi.fn(),
  broadcastToUser: vi.fn(),
  setRedisPublisher: vi.fn(),
}));
vi.mock('../src/services/notification-queue.js', () => ({ extractMentions: () => [] }));
vi.mock('../src/lib/notify.js', () => ({
  emitNotification: vi.fn(),
  channelDeepLink: () => '',
  dmDeepLink: () => '',
  threadDeepLink: () => '',
}));
vi.mock('../src/lib/sanitize.js', () => ({ sanitizeContent: (s: string) => s }));
vi.mock('../src/lib/bolt-events.js', () => ({ publishBoltEvent: vi.fn() }));
vi.mock('../src/lib/bolt-enrich.js', () => ({
  loadEnrichedChannel: async () => ({ id: 'c1', name: 'general', handle: 'general', type: 'public', url: '' }),
  loadEnrichedActor: async () => ({}),
  loadEnrichedOrg: async () => ({}),
  buildMessageUrl: () => '',
}));
vi.mock('../src/services/quiet-hours.service.js', () => ({
  coercePolicy: () => ({}),
  isInsideQuietHours: () => false,
  nextAllowedTime: () => new Date('2026-01-01T00:00:00Z'),
}));
vi.mock('../src/services/scheduled-post.service.js', () => ({
  scheduleMessage: vi.fn(),
  ScheduledPostError: class extends Error {},
}));

import messageRoutes from '../src/routes/message.routes.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '88888888-8888-8888-8888-888888888888';
const CH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const M1 = 'a1111111-1111-1111-1111-111111111111';
const M2 = 'a2222222-2222-2222-2222-222222222222';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).decorate('requireCan', () => async () => undefined);
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user'] === 'human') {
      (request as any).user = { id: USER, org_id: ORG, role: 'member', is_superuser: false };
    }
  });
  await app.register(messageRoutes);
  return app;
}

const auth = { 'x-test-user': 'human' as const };

// select().from().where().limit() -> rows
function selWhereLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}
// select().from().innerJoin().where().orderBy().limit() -> rows
function selJoinOrderLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  mockDb.select.mockReturnValueOnce({ from });
}
// select().from().where() -> rows  (awaited at where, no limit)
function selWhere(rows: any[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}
// select().from().innerJoin().where().limit().then() -> rows (edit/delete existing lookup)
function selJoinLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  mockDb.select.mockReturnValueOnce({ from });
}
// update().set().where().returning() -> rows
function updReturning(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValueOnce({ set });
}

function msgRow(id: string) {
  return {
    message: {
      id, channel_id: CH, author_id: USER, thread_parent_id: null,
      content: 'hi', is_bot: false, is_edited: false, is_deleted: false,
      reply_count: 0, last_reply_at: null, edit_permission: 'own',
      content_plain: 'hi', created_at: new Date('2026-01-01T00:00:00Z'),
    },
    author: { id: USER, display_name: 'Alex', avatar_url: null },
  };
}

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
});

describe('GET /v1/channels/:id/messages — is_bookmarked / is_pinned mapping', () => {
  it('marks each row from the per-user bookmark set and channel-wide pin set', async () => {
    selWhereLimit([{ id: CH, org_id: ORG }]);          // channel existence
    selJoinOrderLimit([msgRow(M1), msgRow(M2)]);       // messages page
    selWhere([{ message_id: M1 }]);                     // bookmarks for this user
    selWhere([{ message_id: M2 }]);                     // pins for this channel

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/channels/${CH}/messages`, headers: auth });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data as Array<{ id: string; is_bookmarked: boolean; is_pinned: boolean }>;
    const m1 = data.find((m) => m.id === M1)!;
    const m2 = data.find((m) => m.id === M2)!;
    expect(m1.is_bookmarked).toBe(true);
    expect(m1.is_pinned).toBe(false);
    expect(m2.is_bookmarked).toBe(false);
    expect(m2.is_pinned).toBe(true);
    await app.close();
  });
});

describe('message edit/delete routes exist at /v1/messages/:id (NOT channel-scoped)', () => {
  it('PATCH /v1/messages/:id edits an own message', async () => {
    selJoinLimit([msgRow(M1)]);                         // existing lookup (.then maps to message)
    updReturning([{ id: M1, content: 'edited', is_edited: true, channel_id: CH }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `/v1/messages/${M1}`, headers: auth, payload: { content: 'edited' } });
    expect(res.statusCode).toBe(200);
    expect(mockDb.update).toHaveBeenCalledOnce();
    await app.close();
  });

  it('DELETE /v1/messages/:id soft-deletes an own message', async () => {
    selJoinLimit([msgRow(M1)]);                         // existing lookup
    updReturning([{ id: M1, is_deleted: true, channel_id: CH }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/v1/messages/${M1}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(mockDb.update).toHaveBeenCalledOnce(); // soft delete = update is_deleted
    await app.close();
  });
});
