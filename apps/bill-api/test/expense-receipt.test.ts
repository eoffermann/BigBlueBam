import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import type { StorageDriver } from '@bigbluebam/storage';

// Issue #145: receipts are stored through @bigbluebam/storage in the configured
// bucket and served only by the authorized GET /v1/expenses/:id/receipt route.
// The round trip below uploads a receipt and downloads it again against an
// in-memory storage driver and an in-memory expense table.

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';
const EXPENSE_A = '11111111-1111-1111-1111-111111111111';
const EXPENSE_B = '22222222-2222-2222-2222-222222222222';

// ---- in-memory expense table + a drizzle-shaped fake db ----
type Row = Record<string, unknown>;
const rows = new Map<string, Row>();

type Cond = { op: 'eq'; col: string; v: unknown } | { op: 'and'; a: Cond[] };
function matches(row: Row, c: Cond): boolean {
  if (c.op === 'and') return c.a.every((x) => matches(row, x));
  return row[c.col] === c.v;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (col: { name: string }, v: unknown) => ({ op: 'eq', col: col.name, v }),
    and: (...a: unknown[]) => ({ op: 'and', a }),
  };
});

vi.mock('../src/db/index.js', () => ({
  connection: { end: vi.fn() },
  db: {
    select: () => ({
      from: () => ({
        where: (c: Cond) => ({
          limit: async () => [...rows.values()].filter((r) => matches(r, c)).slice(0, 1),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: async (c: Cond) => {
          for (const r of rows.values()) if (matches(r, c)) Object.assign(r, patch);
        },
      }),
    }),
  },
}));

vi.mock('../src/env.js', () => ({
  env: { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost', S3_BUCKET: 'bigbluebam-uploads', S3_REGION: 'us-east-1' },
}));
vi.mock('../src/lib/bolt-events.js', () => ({ publishBoltEvent: vi.fn() }));
vi.mock('../src/lib/bolt-event-enrich.js', () => ({ loadActor: vi.fn(), loadOrg: vi.fn() }));
vi.mock('../src/services/expense.service.js', () => ({}));
vi.mock('../src/lib/burn-precheck.hook.js', () => ({
  burnPrecheck: () => async () => {},
  expenseApproveCharge: vi.fn(),
  expenseCreateCharge: vi.fn(),
  expenseUpdateCharge: vi.fn(),
}));

let currentOrg = ORG_A;
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-test-user'] !== 'yes') {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'no session' } });
    }
    (request as unknown as { user: unknown }).user = { id: 'u1', org_id: currentOrg };
  },
  requireScope: () => async () => {},
}));

// ---- in-memory storage driver ----
const objects = new Map<string, { body: Buffer; contentType: string }>();
const memDriver = {
  kind: 'local',
  capabilities: {},
  healthCheck: async () => ({ ok: true, latencyMs: 0 }),
  put: vi.fn(async (key: string, body: Buffer, opts?: { contentType?: string }) => {
    objects.set(key, { body, contentType: opts?.contentType ?? 'application/octet-stream' });
    return { key, size: body.length, integrity: 'etag' };
  }),
  getStream: vi.fn(async (key: string) => {
    const o = objects.get(key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    return { stream: Readable.from([o.body]), contentType: o.contentType, size: o.body.length };
  }),
  stat: async (key: string) => {
    const o = objects.get(key);
    return o ? { key, size: o.body.length, integrity: 'etag', modifiedAt: new Date() } : null;
  },
  delete: vi.fn(async (key: string) => {
    objects.delete(key);
  }),
  list: async () => ({ objects: [] }),
} as unknown as StorageDriver;

const canCalls: string[] = [];
let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  a.decorate('requireCan', (action: string) => async () => {
    canCalls.push(action);
  });
  a.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: { code: err.code, message: err.message } });
  });
  const { default: expenseRoutes } = await import('../src/routes/expenses.routes.js');
  await a.register(expenseRoutes, { prefix: '/v1' });
  await a.ready();
  return a;
}

function multipartBody(filename: string, content: Buffer, contentType: string) {
  const boundary = '----receipttestboundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(id: string, filename: string, content: Buffer, type = 'image/png') {
  const { payload, contentType } = multipartBody(filename, content, type);
  return app.inject({
    method: 'POST',
    url: `/v1/expenses/${id}/receipt`,
    headers: { 'x-test-user': 'yes', 'content-type': contentType },
    payload,
  });
}

const download = (id: string) =>
  app.inject({ method: 'GET', url: `/v1/expenses/${id}/receipt`, headers: { 'x-test-user': 'yes' } });

beforeEach(async () => {
  vi.clearAllMocks();
  canCalls.length = 0;
  currentOrg = ORG_A;
  objects.clear();
  rows.clear();
  rows.set(EXPENSE_A, { id: EXPENSE_A, organization_id: ORG_A, receipt_filename: null, receipt_uploaded_at: null });
  rows.set(EXPENSE_B, { id: EXPENSE_B, organization_id: ORG_B, receipt_filename: null, receipt_uploaded_at: null });
  const storage = await import('../src/lib/receipt-storage.js');
  storage.__setReceiptDriverForTests(memDriver);
  if (!app) app = await buildApp();
});

afterAll(async () => {
  const storage = await import('../src/lib/receipt-storage.js');
  storage.__setReceiptDriverForTests(undefined);
  await app?.close();
});

const PNG = Buffer.from('\x89PNG fake receipt bytes', 'binary');

describe('expense receipts (issue #145)', () => {
  it('round trip: upload stores under the pinned key, download returns the same bytes', async () => {
    const up = await upload(EXPENSE_A, 'lunch receipt.png', PNG);
    expect(up.statusCode).toBe(200);
    expect(up.json().data.receipt_url).toBe(`/bill/api/v1/expenses/${EXPENSE_A}/receipt`);
    expect([...objects.keys()]).toEqual([`bill/receipts/${EXPENSE_A}.png`]);
    expect(rows.get(EXPENSE_A)!.receipt_url).toBe(`/bill/api/v1/expenses/${EXPENSE_A}/receipt`);

    const down = await download(EXPENSE_A);
    expect(down.statusCode).toBe(200);
    expect(down.rawPayload.equals(PNG)).toBe(true);
    expect(down.headers['content-type']).toBe('image/png');
    expect(down.headers['content-disposition']).toBe('attachment; filename="lunch_receipt.png"');
    expect(down.headers['x-content-type-options']).toBe('nosniff');
    expect(down.headers['cache-control']).toBe('private, no-store');
  });

  it('download checks bill.expense.list; upload checks bill.expense_receipt.create', async () => {
    await upload(EXPENSE_A, 'r.png', PNG);
    await download(EXPENSE_A);
    expect(canCalls).toEqual(['bill.expense_receipt.create', 'bill.expense.list']);
  });

  it("another org cannot download an expense's receipt (404, storage untouched)", async () => {
    await upload(EXPENSE_A, 'r.png', PNG);
    currentOrg = ORG_B;
    const down = await download(EXPENSE_A);
    expect(down.statusCode).toBe(404);
    expect(memDriver.getStream).not.toHaveBeenCalled();
  });

  it('another org cannot upload onto an expense it does not own', async () => {
    currentOrg = ORG_B;
    const up = await upload(EXPENSE_A, 'r.png', PNG);
    expect(up.statusCode).toBe(404);
    expect(objects.size).toBe(0);
  });

  it('404 RECEIPT_NOT_FOUND when the expense has no uploaded receipt', async () => {
    const down = await download(EXPENSE_A);
    expect(down.statusCode).toBe(404);
    expect(down.json().error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/expenses/${EXPENSE_A}/receipt` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unsupported file type', async () => {
    const up = await upload(EXPENSE_A, 'evil.html', Buffer.from('<script>'), 'text/html');
    expect(up.statusCode).toBe(400);
    expect(objects.size).toBe(0);
  });

  it('a replacement with another extension removes the old object', async () => {
    await upload(EXPENSE_A, 'r.png', PNG);
    await upload(EXPENSE_A, 'r.pdf', Buffer.from('%PDF-1.7'), 'application/pdf');
    expect([...objects.keys()]).toEqual([`bill/receipts/${EXPENSE_A}.pdf`]);
    const down = await download(EXPENSE_A);
    expect(down.headers['content-type']).toBe('application/pdf');
  });

  it('503 STORAGE_NOT_CONFIGURED when no storage is configured (no default credentials)', async () => {
    const storage = await import('../src/lib/receipt-storage.js');
    storage.__setReceiptDriverForTests(null);
    const up = await upload(EXPENSE_A, 'r.png', PNG);
    expect(up.statusCode).toBe(503);
    expect(up.json().error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('without S3 endpoint/credentials in env, the driver is null', async () => {
    const storage = await import('../src/lib/receipt-storage.js');
    storage.__setReceiptDriverForTests(undefined);
    expect(storage.getReceiptDriver()).toBeNull();
  });
});
