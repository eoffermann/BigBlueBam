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
  mockDb: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
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
vi.mock('../src/services/notification-queue.js', () => ({
  extractMentions: () => [],
  resolveMentionsToUsers: async () => [],
}));
vi.mock('../src/services/feed-queue.js', () => ({ enqueueFeedFanin: vi.fn() }));
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

// Issue #156: attachment keys are claimed against upload grants before the insert.
const { claimAttachmentKeys } = vi.hoisted(() => ({ claimAttachmentKeys: vi.fn() }));
vi.mock('../src/lib/upload-grants.js', () => ({
  claimAttachmentKeys: (...a: unknown[]) => claimAttachmentKeys(...a),
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
    selWhere([]);                                       // attachments for the page

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

describe('malformed :id is rejected with 400 (not a 500 from Postgres 22P02)', () => {
  // A non-UUID id, if passed straight into a uuid-typed query, raises
  // "invalid input syntax for type uuid" (SQLSTATE 22P02) and a 500. The
  // requireUuidParam guard short-circuits with a 400 before any DB call.
  it('GET /v1/messages/:id returns 400 and never touches the DB', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/messages/not-a-uuid', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockDb.select).not.toHaveBeenCalled();
    await app.close();
  });

  it('PATCH /v1/messages/:id returns 400 for a malformed id', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/v1/messages/123', headers: auth, payload: { content: 'edited' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockDb.select).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /v1/messages/:id returns 400 for a malformed id', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/messages/xxxx', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockDb.select).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST refuses an attachment key Banter did not write (issue #142)', async () => {
    // This harness has no error handler, so the schema's ZodError surfaces as a
    // 500 here (the server's handler maps it to 400 VALIDATION_ERROR); what
    // matters is that the key refinement rejects it before any insert.
    const app = await buildApp();
    for (const key of [`${ORG}/bin/assets/secret.pdf`, 'uploads/abc-x.png', 'banter/uploads/../../avatars/x']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/channels/${CH}/messages`,
        headers: auth,
        payload: { content: 'see file', attachments: [{ key, filename: 'x', content_type: 'image/png', size_bytes: 1 }] },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).toContain('attachment key must come from POST /v1/files/upload');
    }
    expect(mockDb.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST refuses a well-formed key the poster was not issued (issue #156 re-attach)', async () => {
    const app = await buildApp();
    const key = 'banter/uploads/4f1c-board-minutes.pdf';
    claimAttachmentKeys.mockResolvedValueOnce({ ok: false, rejected: [key] });
    const tx = makeTx();
    selWhereLimit([{ id: CH, org_id: ORG, quiet_hours_policy: null }]); // channel lookup
    const res = await app.inject({
      method: 'POST',
      url: `/v1/channels/${CH}/messages`,
      headers: auth,
      payload: { content: 'look', attachments: [{ key, filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 1 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ATTACHMENT_NOT_ALLOWED');
    expect(res.json().error.details[0].key).toBe(key);
    // The claim runs on the post transaction (issue #168), and the rejection
    // aborts it, which rolls back any grant the claim consumed.
    expect(claimAttachmentKeys).toHaveBeenCalledWith({ keys: [key], orgId: ORG, userId: USER, channelId: CH }, tx.handle);
    expect(tx.outcome).toBe('rolled_back');
    // Nothing is written: no message, no attachment row.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(tx.handle.insert).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * A stand-in for db.transaction: runs the callback with a distinct tx handle and
 * records whether it committed (callback resolved) or rolled back (threw). Writes
 * that land on `mockDb` instead of the handle would be outside the transaction.
 */
function makeTx(opts: { failAttachmentInsert?: boolean; failChannelUpdate?: boolean } = {}) {
  const state: { outcome: 'none' | 'committed' | 'rolled_back'; handle: any; values: unknown[] } = {
    outcome: 'none',
    handle: null,
    values: [],
  };
  let insertCall = 0;
  state.handle = {
    execute: vi.fn(async () => []),
    insert: vi.fn(() => {
      const n = insertCall++;
      return {
        values: (v: unknown) => {
          state.values.push(v);
          return {
            returning: async () => {
              if (n === 0) return [{ ...msgRow(M1).message, attachment_count: 0 }];
              if (opts.failAttachmentInsert) throw new Error('connection terminated');
              return [{ id: 'att-1', filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 1 }];
            },
          };
        },
      };
    }),
    update: vi.fn(() => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          if (opts.failChannelUpdate && 'message_count' in v) throw new Error('deadlock detected');
        },
      }),
    })),
  };
  mockDb.transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
    try {
      const r = await cb(state.handle);
      state.outcome = 'committed';
      return r;
    } catch (err) {
      state.outcome = 'rolled_back';
      throw err;
    }
  });
  return state;
}

describe('POST message is one transaction: grant claim + message + attachments (issue #168)', () => {
  const key = 'banter/uploads/0d1e-minutes.pdf';
  const payload = { content: 'minutes', attachments: [{ key, filename: 'x.pdf', content_type: 'application/pdf', size_bytes: 1 }] };

  beforeEach(async () => {
    claimAttachmentKeys.mockReset();
    mockDb.insert.mockReset();
    mockDb.transaction.mockReset();
    const rt = await import('../src/services/realtime.js');
    (rt.broadcastToChannel as any).mockClear();
  });

  it('an attachment insert failure after the message insert rolls everything back and broadcasts nothing', async () => {
    claimAttachmentKeys.mockResolvedValueOnce({ ok: true });
    const tx = makeTx({ failAttachmentInsert: true });
    selWhereLimit([{ id: CH, org_id: ORG, quiet_hours_policy: null }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/channels/${CH}/messages`, headers: auth, payload });
    expect(res.statusCode).toBe(500);
    // Claim, message insert and attachment insert all ran on the tx handle, and
    // the transaction rolled back: the grant DELETE and the message row are undone
    // together, so the retry is not refused and leaves no stray text-only copy.
    expect(claimAttachmentKeys.mock.calls[0]![1]).toBe(tx.handle);
    expect(tx.handle.insert).toHaveBeenCalledTimes(2);
    expect(tx.outcome).toBe('rolled_back');
    expect(mockDb.insert).not.toHaveBeenCalled();
    const rt = await import('../src/services/realtime.js');
    expect(rt.broadcastToChannel).not.toHaveBeenCalled();
    await app.close();
  });

  it('a denormalization failure also rolls back the message and its attachments', async () => {
    claimAttachmentKeys.mockResolvedValueOnce({ ok: true });
    const tx = makeTx({ failChannelUpdate: true });
    selWhereLimit([{ id: CH, org_id: ORG, quiet_hours_policy: null }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/channels/${CH}/messages`, headers: auth, payload });
    expect(res.statusCode).toBe(500);
    expect(tx.outcome).toBe('rolled_back');
    expect(mockDb.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('the success path commits once, stamps attachment_count inside it, then broadcasts', async () => {
    claimAttachmentKeys.mockResolvedValueOnce({ ok: true });
    const tx = makeTx();
    selWhereLimit([{ id: CH, org_id: ORG, quiet_hours_policy: null }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/channels/${CH}/messages`, headers: auth, payload });
    expect(res.statusCode).toBe(201);
    expect(tx.outcome).toBe('committed');
    expect(tx.handle.update).toHaveBeenCalledTimes(2); // attachment_count + channel denormalization
    expect(mockDb.insert).not.toHaveBeenCalled();
    const rt = await import('../src/services/realtime.js');
    expect(rt.broadcastToChannel).toHaveBeenCalledOnce();
    await app.close();
  });

  it('does not store a client-supplied thumbnail_key (issue #162)', async () => {
    claimAttachmentKeys.mockResolvedValueOnce({ ok: true });
    const tx = makeTx();
    selWhereLimit([{ id: CH, org_id: ORG, quiet_hours_policy: null }]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/channels/${CH}/messages`,
      headers: auth,
      payload: { ...payload, attachments: [{ ...payload.attachments[0], thumbnail_key: 'banter/uploads/someone-elses-file.png' }] },
    });
    expect(res.statusCode).toBe(201);
    const attachmentRows = tx.values[1] as Array<Record<string, unknown>>;
    expect(attachmentRows).toHaveLength(1);
    expect(attachmentRows[0]!.storage_key).toBe(key);
    expect(attachmentRows[0]!.thumbnail_key ?? null).toBeNull();
    expect(JSON.stringify(tx.values)).not.toContain('someone-elses-file');
    await app.close();
  });
});
