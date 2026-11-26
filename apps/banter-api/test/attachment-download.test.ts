/**
 * Issue #142: Banter message attachments are served by the channel-authorized
 * GET /v1/channels/:id/attachments/:attachmentId instead of the api's /files/
 * proxy, and a message may only attach keys Banter's own upload routes wrote.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ZodError } from 'zod';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '88888888-8888-8888-8888-888888888888';
const CH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_CH = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ATT = 'a1111111-1111-1111-1111-111111111111';
const BYTES = Buffer.from('\x89PNG attachment bytes', 'binary');

// ---- drizzle-shaped fake: evaluates eq/and over an in-memory joined row set ----
type Cond = { op: 'eq'; col: string; v: unknown } | { op: 'and'; a: Cond[] };
const matches = (row: Record<string, unknown>, c: Cond): boolean =>
  c.op === 'and' ? c.a.every((x) => matches(row, x)) : row[c.col] === c.v;

vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (col: { name: string; table?: unknown }, v: unknown) => ({ op: 'eq', col: col.name, v }),
    and: (...a: unknown[]) => ({ op: 'and', a }),
  };
});

// Joined attachment+message rows; `id` is the attachment id.
let joined: Array<Record<string, unknown>> = [];
vi.mock('../src/db/index.js', () => ({
  connection: { end: vi.fn() },
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (c: Cond) => ({ limit: async () => joined.filter((r) => matches(r, c)).slice(0, 1) }),
        }),
      }),
    }),
  },
}));

vi.mock('../src/env.js', () => ({
  env: { S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'bigbluebam-uploads', S3_REGION: 'us-east-1', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' },
}));
vi.mock('../src/services/settings-cache.js', () => ({ getBanterSettingsCached: async () => null }));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-test-user'] !== 'yes') {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'x' } });
    }
    (request as unknown as { user: unknown }).user = { id: USER, org_id: ORG, role: 'member', is_superuser: false };
  },
  requireScope: () => async () => undefined,
}));

// Issue #156: the channel a key was ORIGINALLY attached in (oldest row).
let originalChannel: string | null = CH;
const recordUploadGrant = vi.fn();
vi.mock('../src/lib/upload-grants.js', () => ({
  originalChannelForKey: async () => originalChannel,
  recordUploadGrant: (...a: unknown[]) => recordUploadGrant(...a),
}));

// The real channel read rule is covered elsewhere; here it is a switch.
let channelReadable = true;
vi.mock('../src/middleware/channel-auth.js', () => ({
  requireChannelMember: async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!channelReadable) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
  },
}));

// Issue #159: reads go through the shared @bigbluebam/storage driver.
const getObject = vi.fn();
const fakeDriver = {
  getStream: async (key: string) => {
    const stream = await getObject(key);
    return { stream, contentType: 'application/octet-stream', size: BYTES.length };
  },
};

import fileRoutes from '../src/routes/file.routes.js';
import { attachmentDownloadUrl, isServableAttachmentKey, dispositionFor } from '../src/lib/attachment-download.js';

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: ATT,
    channel_id: CH,
    is_deleted: false,
    filename: 'site photo.png',
    content_type: 'image/png',
    storage_key: 'banter/uploads/0000-site_photo.png',
    is_stub: false,
    ...overrides,
  };
}

let app: FastifyInstance;
async function buildApp() {
  const a = Fastify({ logger: false });
  a.decorate('requireCan', () => async () => undefined);
  a.decorateRequest('user', null);
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: err.message } });
  });
  await a.register(fileRoutes);
  await a.ready();
  return a;
}

const get = (channel: string, att: string) =>
  app.inject({ method: 'GET', url: `/v1/channels/${channel}/attachments/${att}`, headers: { 'x-test-user': 'yes' } });

beforeEach(async () => {
  vi.clearAllMocks();
  channelReadable = true;
  originalChannel = CH;
  joined = [attachment()];
  getObject.mockImplementation(async () => Readable.from([BYTES]));
  const storage = await import('../src/lib/storage-driver.js');
  storage.__setBanterStorageDriverForTests(fakeDriver as never);
  if (!app) app = await buildApp();
});

describe('GET /v1/channels/:id/attachments/:attachmentId (issue #142)', () => {
  it('streams the attachment to a reader of the channel', async () => {
    const res = await get(CH, ATT);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline; filename="site_photo.png"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(getObject).toHaveBeenCalledWith('banter/uploads/0000-site_photo.png');
    expect(res.headers['content-length']).toBe(String(BYTES.length));
  });

  it('404s once the caller can no longer read the channel, without touching storage', async () => {
    channelReadable = false;
    const res = await get(CH, ATT);
    expect(res.statusCode).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('404s for an attachment that belongs to a different channel', async () => {
    const res = await get(OTHER_CH, ATT);
    expect(res.statusCode).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('404s for an attachment on a deleted message', async () => {
    joined = [attachment({ is_deleted: true })];
    expect((await get(CH, ATT)).statusCode).toBe(404);
  });

  it('404s for a Slack-import stub', async () => {
    joined = [attachment({ is_stub: true })];
    expect((await get(CH, ATT)).statusCode).toBe(404);
  });

  it("404s for a key Banter did not write (another app's object)", async () => {
    joined = [attachment({ storage_key: `${ORG}/bin/assets/secret.pdf` })];
    expect((await get(CH, ATT)).statusCode).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('serves an HTML-typed file as a download, never inline', async () => {
    joined = [attachment({ content_type: 'text/html', filename: 'page.html' })];
    const res = await get(CH, ATT);
    expect(res.headers['content-disposition']).toBe('attachment; filename="page.html"');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/channels/${CH}/attachments/${ATT}` });
    expect(res.statusCode).toBe(401);
  });

  it('404s when the object is missing from storage (issue #159)', async () => {
    getObject.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 'NoSuchKey' }));
    expect((await get(CH, ATT)).statusCode).toBe(404);
  });

  it('503 STORAGE_NOT_CONFIGURED when storage is not configured, not a silent 404 (issue #159)', async () => {
    const storage = await import('../src/lib/storage-driver.js');
    storage.__setBanterStorageDriverForTests(null);
    const res = await get(CH, ATT);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('502 STORAGE_ERROR, logged, when storage fails for another reason (issue #159)', async () => {
    getObject.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const res = await get(CH, ATT);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STORAGE_ERROR');
  });

  it('404s a key re-attached outside the channel it was originally posted in (issue #156)', async () => {
    // The attacker's row sits on a live message in a channel they can read (CH),
    // but the key was first attached in a private channel they were removed from.
    originalChannel = OTHER_CH;
    const res = await get(CH, ATT);
    expect(res.statusCode).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe('attachment helpers (issue #142)', () => {
  it('builds the channel-scoped download URL', () => {
    expect(attachmentDownloadUrl(CH, ATT)).toBe(`/banter/api/v1/channels/${CH}/attachments/${ATT}`);
  });

  it('serves only Banter-written keys and this org\'s Slack imports', () => {
    expect(isServableAttachmentKey('banter/uploads/abc-x.png', ORG)).toBe(true);
    expect(isServableAttachmentKey(`attachments/${ORG}/slack-imports/i1/F1`, ORG)).toBe(true);
    expect(isServableAttachmentKey('attachments/other-org/slack-imports/i1/F1', ORG)).toBe(false);
    expect(isServableAttachmentKey('uploads/abc-x.png', ORG)).toBe(false);
    expect(isServableAttachmentKey('banter/uploads/../../avatars/x', ORG)).toBe(false);
  });

  it('inline only for safe media types', () => {
    expect(dispositionFor('video/mp4', 'a.mp4')).toMatch(/^inline/);
    expect(dispositionFor('image/svg+xml', 'a.svg')).toMatch(/^attachment/);
    expect(dispositionFor('application/zip', 'a.zip')).toMatch(/^attachment/);
  });
});
