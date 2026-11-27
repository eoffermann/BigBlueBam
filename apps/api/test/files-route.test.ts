import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';

// Issue #123: GET /files/* serves only allowlisted prefixes; an org-prefixed key 404s
// without touching storage, and only avatars are publicly cacheable.

const { getFileStream, uploadOwnerOrg, recordUploadOwner } = vi.hoisted(() => ({
  getFileStream: vi.fn(),
  uploadOwnerOrg: vi.fn(),
  recordUploadOwner: vi.fn(),
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    S3_BUCKET: 'bigbluebam-uploads',
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    LOG_LEVEL: 'silent',
  },
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));
vi.mock('../src/services/upload.service.js', () => ({ uploadFile: vi.fn(), getFileStream }));
vi.mock('../src/services/auth.service.js', () => ({ updateProfile: vi.fn() }));
vi.mock('../src/services/file-ownership.service.js', () => ({ uploadOwnerOrg, recordUploadOwner }));
vi.mock('../src/middleware/dual-read.js', () => ({ shadowOnly: () => async () => {} }));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) return reply.status(401).send({ error: { code: 'UNAUTHORIZED' } });
  },
}));

import uploadRoutes, { classifyFilesKey } from '../src/routes/upload.routes.js';

const ORG = '11111111-1111-1111-1111-111111111111';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('requireCan', () => async () => {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req: any) => {
    req.user = { id: '22222222-2222-2222-2222-222222222222', org_id: ORG, active_org_id: ORG };
  });
  await app.register(uploadRoutes);
  return app;
}

describe('classifyFilesKey', () => {
  it('avatars are public, legacy capability prefixes are private', () => {
    expect(classifyFilesKey('avatars/u-1.png')).toBe('public');
    expect(classifyFilesKey('uploads/abc-file.pdf')).toBe('private');
    expect(classifyFilesKey('helpdesk/abc-x.png')).toBe('private');
  });

  it('prefixes moved to their app routes are no longer served (issues #142, #145)', () => {
    // Banter attachments: banter-api GET /v1/channels/:id/attachments/:attId.
    expect(classifyFilesKey('banter/uploads/abc-x.png')).toBeNull();
    // Expense receipts: bill-api GET /v1/expenses/:id/receipt.
    expect(classifyFilesKey('bill/receipts/abc.pdf')).toBeNull();
  });

  it('org-prefixed, unknown and traversal keys are refused', () => {
    expect(classifyFilesKey(`${ORG}/bin/asset/original.png`)).toBeNull();
    expect(classifyFilesKey('bill/invoices/x.pdf')).toBeNull();
    expect(classifyFilesKey('bastion/evidence/x')).toBeNull();
    expect(classifyFilesKey('avatars/../11111111/secret')).toBeNull();
    expect(classifyFilesKey('avatars//x')).toBeNull();
    expect(classifyFilesKey('/avatars/x')).toBeNull();
    expect(classifyFilesKey('')).toBeNull();
  });
});

describe('GET /files/*', () => {
  beforeEach(() => {
    getFileStream.mockReset();
    uploadOwnerOrg.mockReset();
    uploadOwnerOrg.mockResolvedValue(ORG);
    getFileStream.mockImplementation(async () => ({
      stream: Readable.from([Buffer.from('bytes')]),
      contentType: 'image/png',
      size: 5,
    }));
  });

  it('404s an org-prefixed key and never reads storage', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/files/${ORG}/bin/asset/original.png` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(getFileStream).not.toHaveBeenCalled();
    expect(res.headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('404s an encoded traversal out of avatars/', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/files/avatars/%2E%2E/${ORG}/secret.png` });
    expect(res.statusCode).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('serves an avatar with public caching', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/files/avatars/u-1.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(getFileStream).toHaveBeenCalledWith('bigbluebam-uploads', 'avatars/u-1.png');
    await app.close();
  });

  it('serves a legacy attachment key to its owning org, without public caching', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/files/uploads/abc-x.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(uploadOwnerOrg).toHaveBeenCalledWith('uploads/abc-x.png');
    await app.close();
  });

  // #142: a legacy key used to be readable by any signed-in user of any org.
  it('404s a legacy key owned by another org, or owned by no one, without reading storage', async () => {
    const app = await build();
    uploadOwnerOrg.mockResolvedValueOnce('99999999-9999-9999-9999-999999999999');
    const other = await app.inject({ method: 'GET', url: '/files/uploads/abc-x.png' });
    expect(other.statusCode).toBe(404);
    uploadOwnerOrg.mockResolvedValueOnce(null);
    const orphan = await app.inject({ method: 'GET', url: '/files/helpdesk/abc-x.png' });
    expect(orphan.statusCode).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /upload records the uploader\'s active org as the owner (#142)', async () => {
    const app = await build();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const boundary = '----fix14boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const key = res.json().data.key as string;
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}-shot\.png$/);
    expect(recordUploadOwner).toHaveBeenCalledWith(key, ORG, 'bam', '22222222-2222-2222-2222-222222222222');
    await app.close();
  });

  it('never consults ownership for a public avatar', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/files/avatars/u-1.png' });
    expect(uploadOwnerOrg).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s a Banter attachment or expense receipt key without reading storage (#142)', async () => {
    const app = await build();
    for (const key of ['banter/uploads/abc-x.png', 'bill/receipts/abc.pdf']) {
      const res = await app.inject({ method: 'GET', url: `/files/${key}` });
      expect(res.statusCode).toBe(404);
    }
    expect(getFileStream).not.toHaveBeenCalled();
    await app.close();
  });
});
