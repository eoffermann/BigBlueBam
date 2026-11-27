import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';

// #142: a helpdesk/ upload records its owning org so the Bam api's GET /files can refuse every
// other org (it used to serve the key to any signed-in user of any org).
// #334: a portal customer with no org and no tenant context used to get a 201 with no owner row,
// so the returned URL 404'd for everyone. The owner is now resolved before the object is stored
// (customer org, tenant org, then the helpdesk_settings fallback ticket creation uses), and the
// upload is refused when none exists.

const { execute, uploadFile } = vi.hoisted(() => ({ execute: vi.fn(), uploadFile: vi.fn(async () => {}) }));

vi.mock('../src/db/index.js', () => ({ db: { execute }, connection: { end: vi.fn() } }));
vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', S3_BUCKET: 'bigbluebam-uploads' } }));
vi.mock('../src/services/upload.service.js', () => ({ uploadFile }));
vi.mock('../src/plugins/auth.js', () => ({
  requireHelpdeskAuth: async (request: any) => {
    request.helpdeskUser = { id: '44444444-4444-4444-4444-444444444444', email: 'c@x.example', display_name: 'C' };
  },
}));

import helpdeskUploadRoutes from '../src/routes/upload.routes.js';

const ORG = '33333333-3333-3333-3333-333333333333';
const queryText = (call: number) =>
  JSON.stringify((execute.mock.calls[call]![0] as unknown as { queryChunks: unknown[] }).queryChunks);

async function upload(tenantOrgId: string | null) {
  const app = Fastify({ logger: false });
  await app.register(multipart);
  app.decorateRequest('tenantContext', null as unknown as FastifyRequest['tenantContext']);
  app.addHook('onRequest', async (req: any) => {
    req.tenantContext = { orgId: tenantOrgId, projectId: null };
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
  await app.close();
  return res;
}

describe('POST /helpdesk/upload', () => {
  beforeEach(() => {
    execute.mockReset();
    uploadFile.mockClear();
  });

  it('stores the object and records its owner row', async () => {
    execute.mockResolvedValueOnce([{ org_id: ORG }]).mockResolvedValueOnce([]);
    const res = await upload(ORG);
    expect(res.statusCode).toBe(201);
    const key = res.json().data.key as string;
    expect(key).toMatch(/^helpdesk\/[0-9a-f-]{36}-note\.txt$/);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryText(1)).toContain('file_upload_owners');
    expect(queryText(1)).toContain(key);
    expect(queryText(1)).toContain(ORG);
  });

  it('resolves a no-org, no-tenant customer through the helpdesk_settings fallback', async () => {
    execute.mockResolvedValueOnce([{ org_id: ORG }]).mockResolvedValueOnce([]);
    const res = await upload(null);
    expect(res.statusCode).toBe(201);
    expect(queryText(0)).toContain('helpdesk_settings');
    expect(queryText(1)).toContain('file_upload_owners');
    expect(queryText(1)).toContain(ORG);
  });

  it('refuses the upload, storing nothing, when no owning org can be determined', async () => {
    execute.mockResolvedValueOnce([{ org_id: null }]);
    const res = await upload(null);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('NO_OWNING_ORG');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
