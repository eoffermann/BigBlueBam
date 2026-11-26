import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';

// Issue #123: GET /files/* serves only allowlisted prefixes; an org-prefixed key 404s
// without touching storage, and only avatars are publicly cacheable.

const { getFileStream } = vi.hoisted(() => ({ getFileStream: vi.fn() }));

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
    req.user = { id: '22222222-2222-2222-2222-222222222222', org_id: ORG };
  });
  await app.register(uploadRoutes);
  return app;
}

describe('classifyFilesKey', () => {
  it('avatars are public, legacy capability prefixes are private', () => {
    expect(classifyFilesKey('avatars/u-1.png')).toBe('public');
    expect(classifyFilesKey('uploads/abc-file.pdf')).toBe('private');
    expect(classifyFilesKey('banter/uploads/abc-x.png')).toBe('private');
    expect(classifyFilesKey('helpdesk/abc-x.png')).toBe('private');
    expect(classifyFilesKey('bill/receipts/abc.pdf')).toBe('private');
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

  it('serves a legacy attachment key without public caching', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/files/banter/uploads/abc-x.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });
});
