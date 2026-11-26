import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

// Issue #134: GET /v1/invoices/:id/pdf/download is the authorized invoice PDF
// download that replaced the SPA's broken /files/bigbluebam-uploads/... link.

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_INVOICE = '22222222-2222-2222-2222-222222222222';
const STORED = Buffer.from('%PDF-1.7 stored copy');
const RENDERED = new Uint8Array(Buffer.from('%PDF-1.7 rendered copy'));

vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));
vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost' } }));
vi.mock('../src/lib/bolt-events.js', () => ({ publishBoltEvent: vi.fn() }));
vi.mock('../src/lib/bolt-event-enrich.js', () => ({
  buildInvoiceUrl: vi.fn(),
  buildInvoicePdfUrl: vi.fn(),
  countLineItems: vi.fn(),
  loadActor: vi.fn(),
  loadCustomer: vi.fn(),
  loadOrg: vi.fn(),
}));
vi.mock('../src/services/line-item.service.js', () => ({}));
vi.mock('../src/services/worker-job.service.js', () => ({}));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-test-user'] !== 'yes') {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'no session' } });
    }
    (request as unknown as { user: unknown }).user = { id: 'u1', org_id: ORG_A };
  },
  requireScope: () => async () => {},
}));

const getInvoice = vi.fn();
vi.mock('../src/services/invoice.service.js', () => ({
  getInvoice: (...args: unknown[]) => getInvoice(...args),
}));

const generateInvoicePdf = vi.fn();
vi.mock('../src/services/pdf.service.js', () => ({
  generateInvoicePdf: (...args: unknown[]) => generateInvoicePdf(...args),
}));

// Issue #148: reads go through bill-api's shared @bigbluebam/storage driver.
const getObject = vi.fn();
const fakeDriver = {
  getStream: async (key: string) => ({ stream: await getObject(key), contentType: 'application/pdf', size: 0 }),
};

const canCalls: string[] = [];
let denied = false;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('requireCan', (action: string) => {
    return async (_request: FastifyRequest, reply: FastifyReply) => {
      canCalls.push(action);
      if (denied) return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'denied' } });
    };
  });
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: { code: err.code, message: err.message } });
  });
  const { default: invoiceRoutes } = await import('../src/routes/invoices.routes.js');
  await app.register(invoiceRoutes, { prefix: '/v1' });
  await app.ready();
  return app;
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    organization_id: ORG_A,
    invoice_number: 'INV-00042',
    pdf_url: `bill/invoices/${INVOICE_ID}.pdf`,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  canCalls.length = 0;
  denied = false;
  const storage = await import('../src/lib/storage-driver.js');
  storage.__setBillStorageDriverForTests(fakeDriver as never);
  getInvoice.mockImplementation(async (id: string, orgId: string) => {
    if (id === INVOICE_ID && orgId === ORG_A) return invoiceRow();
    const { BillError } = await import('../src/lib/utils.js');
    throw new BillError(404, 'NOT_FOUND', 'Invoice not found');
  });
  generateInvoicePdf.mockResolvedValue(RENDERED);
  getObject.mockImplementation(async () => Readable.from([STORED]));
  if (!app) app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

const url = (id: string) => `/v1/invoices/${id}/pdf/download`;

describe('GET /v1/invoices/:id/pdf/download (issue #134)', () => {
  it('streams the stored PDF as an attachment', async () => {
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-00042.pdf"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.equals(STORED)).toBe(true);
    expect(getObject).toHaveBeenCalledWith(`bill/invoices/${INVOICE_ID}.pdf`);
    expect(generateInvoicePdf).not.toHaveBeenCalled();
  });

  it('checks bill.invoice.get', async () => {
    await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(canCalls).toContain('bill.invoice.get');
  });

  it('returns 403 when the permission check denies', async () => {
    denied = true;
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(403);
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID) });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for another org's invoice and never touches storage", async () => {
    const res = await app.inject({ method: 'GET', url: url(OTHER_ORG_INVOICE), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(404);
    expect(getInvoice).toHaveBeenCalledWith(OTHER_ORG_INVOICE, ORG_A);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await app.inject({ method: 'GET', url: url('not-a-uuid'), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(404);
  });

  it('renders from the database when the stored object is missing', async () => {
    getObject.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }));
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.equals(Buffer.from(RENDERED))).toBe(true);
    expect(generateInvoicePdf).toHaveBeenCalledWith(INVOICE_ID, ORG_A);
  });

  it('never reads a pdf_url that is not this invoice\'s own storage key', async () => {
    getInvoice.mockResolvedValue(invoiceRow({ pdf_url: 'bill/invoices/someone-else.pdf' }));
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(200);
    expect(getObject).not.toHaveBeenCalled();
    expect(generateInvoicePdf).toHaveBeenCalled();
  });

  it('renders from the database when storage is not configured', async () => {
    const storage = await import('../src/lib/storage-driver.js');
    storage.__setBillStorageDriverForTests(null);
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.statusCode).toBe(200);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('pins pdf_url to the one shared key builder the worker also uses', async () => {
    const { billInvoicePdfKey } = await import('@bigbluebam/storage');
    const { invoicePdfKey } = await import('../src/lib/invoice-pdf-storage.js');
    expect(invoicePdfKey).toBe(billInvoicePdfKey);
  });

  it('sanitizes the filename', async () => {
    getInvoice.mockResolvedValue(invoiceRow({ invoice_number: 'INV"/../x', pdf_url: null }));
    const res = await app.inject({ method: 'GET', url: url(INVOICE_ID), headers: { 'x-test-user': 'yes' } });
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV__.._x.pdf"');
  });
});
