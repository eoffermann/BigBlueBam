import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';

// #142: a helpdesk/ upload records its owning org so the Bam api's GET /files can refuse every
// other org (it used to serve the key to any signed-in user of any org).

const { execute, uploadFile } = vi.hoisted(() => ({ execute: vi.fn(async () => []), uploadFile: vi.fn(async () => {}) }));

vi.mock('../src/db/index.js', () => ({ db: { execute }, connection: { end: vi.fn() } }));
vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', S3_BUCKET: 'bigbluebam-uploads' } }));
vi.mock('../src/services/upload.service.js', () => ({ uploadFile }));
vi.mock('../src/plugins/auth.js', () => ({
  requireHelpdeskAuth: async (request: any) => {
    request.helpdeskUser = { id: '44444444-4444-4444-4444-444444444444', email: 'c@x.example', display_name: 'C' };
  },
}));

import helpdeskUploadRoutes from '../src/routes/upload.routes.js';

describe('POST /helpdesk/upload', () => {
  it('stores the object and records its owner row', async () => {
    const app = Fastify({ logger: false });
    await app.register(multipart);
    app.decorateRequest('tenantContext', null as unknown as FastifyRequest['tenantContext']);
    app.addHook('onRequest', async (req: any) => {
      req.tenantContext = { orgId: '33333333-3333-3333-3333-333333333333', projectId: null };
    });
    await app.register(helpdeskUploadRoutes);

    const boundary = '----hdboundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from('the radio only plays static'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/helpdesk/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const key = res.json().data.key as string;
    expect(key).toMatch(/^helpdesk\/[0-9a-f-]{36}-note\.txt$/);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = (execute.mock.calls[0] as unknown[])[0] as { queryChunks: unknown[] };
    expect(JSON.stringify(query.queryChunks)).toContain('file_upload_owners');
    expect(JSON.stringify(query.queryChunks)).toContain(key);
    await app.close();
  });
});
