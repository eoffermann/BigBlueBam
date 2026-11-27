import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// #305: POST /helpdesk/internal/tickets lets a sibling service (Blank form routing) open a ticket
// with the internal secret. Blank used to POST the session-authenticated customer route instead,
// which refused every call.

const SECRET = 's'.repeat(40);
const ORG_ID = '33333333-3333-3333-3333-333333333333';

const existingUser = { id: 'u-existing', email: 'castaway@island.example', display_name: 'Gilligan' };
let selectResult: unknown[] = [];

vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => selectResult }) }),
    })),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: { NODE_ENV: 'test', INTERNAL_SERVICE_SECRET: SECRET, INTERNAL_HELPDESK_SECRET: 'h'.repeat(40) },
}));

const upsert = vi.fn(async (input: { email: string; display_name: string }) => ({
  data: { id: 'u-new', email: input.email, display_name: input.display_name },
  created: true,
  idempotency_key: 'k',
}));
vi.mock('../src/services/user-upsert.service.js', () => ({ upsertHelpdeskUserByEmail: upsert }));

const createTicket = vi.fn(async () => ({
  kind: 'created',
  ticket: {
    id: 't1',
    ticket_number: 7,
    subject: 'Radio broken',
    description: 'It only plays static',
    status: 'open',
    priority: 'medium',
    category: null,
    task_id: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  },
  taskId: 'task-1',
}));
vi.mock('../src/services/ticket-create.service.js', async () => {
  const real = await vi.importActual<typeof import('../src/services/ticket-create.service.js')>(
    '../src/services/ticket-create.service.js',
  );
  return { ...real, createHelpdeskTicket: createTicket };
});

async function buildApp(): Promise<FastifyInstance> {
  const mod = await import('../src/routes/internal.routes.js');
  const app = Fastify({ logger: false });
  await app.register(mod.default);
  await app.ready();
  return app;
}

const body = {
  org_id: ORG_ID,
  requester_email: 'Castaway@Island.example',
  requester_name: 'Gilligan',
  subject: 'Radio broken',
  description: 'It only plays static',
};

describe('POST /helpdesk/internal/tickets', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    selectResult = [];
    app = await buildApp();
  });

  it('creates the ticket for a new requester of the org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/helpdesk/internal/tickets',
      headers: { 'x-internal-service-secret': SECRET },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ id: 't1', task_id: 'task-1' });
    expect(upsert).toHaveBeenCalledWith({ email: 'castaway@island.example', display_name: 'Gilligan' }, ORG_ID);
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, subject: 'Radio broken', requester: expect.objectContaining({ id: 'u-new' }) }),
      expect.anything(),
    );
  });

  it('reuses an existing requester without touching their account', async () => {
    selectResult = [existingUser];
    const res = await app.inject({
      method: 'POST',
      url: '/helpdesk/internal/tickets',
      headers: { 'x-internal-service-secret': SECRET },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(upsert).not.toHaveBeenCalled();
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ requester: existingUser }), expect.anything());
  });

  it('refuses a wrong secret (401) and an edge-relayed caller (403)', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/helpdesk/internal/tickets',
      headers: { 'x-internal-service-secret': 'nope' },
      payload: body,
    });
    expect(wrong.statusCode).toBe(401);
    const relayed = await app.inject({
      method: 'POST',
      url: '/helpdesk/internal/tickets',
      headers: { 'x-internal-service-secret': SECRET, 'x-forwarded-for': '203.0.113.9' },
      payload: body,
    });
    expect(relayed.statusCode).toBe(403);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('rejects a body without a requester email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/helpdesk/internal/tickets',
      headers: { 'x-internal-service-secret': SECRET },
      payload: { ...body, requester_email: undefined },
    });
    expect(res.statusCode).toBe(400);
  });
});
