import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Session-authenticated agent proxies on /internal/helpdesk: the Bam SPA
// reads and answers tickets through these, and they forward to
// helpdesk-api with the internal token plus the acting user and org.

const SECRET = 'test-internal-helpdesk-secret-1234567890';

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    COOKIE_SECURE: false,
    INTERNAL_HELPDESK_SECRET: 'test-internal-helpdesk-secret-1234567890',
    HELPDESK_API_INTERNAL_URL: 'http://helpdesk-api:4001',
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  connection: { end: vi.fn() },
}));

vi.mock('../src/services/activity.service.js', () => ({ logActivity: vi.fn() }));

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '33333333-3333-3333-3333-333333333333';
const TICKET_ID = '44444444-4444-4444-4444-444444444444';

// Signed-in unless the test sends `x-test-anon: 1`.
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (request.headers['x-test-anon']) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'no session' } });
    }
    request.user = { id: USER_ID, org_id: ORG_ID };
  },
}));

const { default: internalHelpdeskRoutes } = await import('../src/routes/internal-helpdesk.routes.js');

const fetchMock = vi.fn();

function upstream(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('internal-helpdesk agent proxies', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    app = Fastify({ logger: false });
    await app.register(internalHelpdeskRoutes, { prefix: '/internal/helpdesk' });
    await app.ready();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /tickets/:id forwards to the agent route with token + acting user/org', async () => {
    fetchMock.mockResolvedValueOnce(upstream(200, { data: { id: TICKET_ID, messages: [] } }));

    const res = await app.inject({ method: 'GET', url: `/internal/helpdesk/tickets/${TICKET_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id: TICKET_ID, messages: [] } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://helpdesk-api:4001/helpdesk/agents/tickets/${TICKET_ID}`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-internal-token']).toBe(SECRET);
    expect(init.headers['x-acting-user-id']).toBe(USER_ID);
    expect(init.headers['x-acting-org-id']).toBe(ORG_ID);
  });

  it('GET /tickets/:id rejects a non-UUID id without calling upstream', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/helpdesk/tickets/..%2F..%2Fadmin' });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /tickets/:id/messages forwards only body + is_internal', async () => {
    fetchMock.mockResolvedValueOnce(upstream(201, { data: { id: 'm1' } }));

    const res = await app.inject({
      method: 'POST',
      url: `/internal/helpdesk/tickets/${TICKET_ID}/messages`,
      payload: { body: 'On it', is_internal: true, author_id: 'forged', author_name: 'Someone Else' },
    });

    expect(res.statusCode).toBe(201);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://helpdesk-api:4001/helpdesk/agents/tickets/${TICKET_ID}/messages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'On it', is_internal: true });
  });

  it('POST /tickets/:id/messages rejects an empty body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/internal/helpdesk/tickets/${TICKET_ID}/messages`,
      payload: { body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /queue hits the real agent queue path and forwards filters', async () => {
    fetchMock.mockResolvedValueOnce(upstream(200, { data: [] }));

    const res = await app.inject({ method: 'GET', url: '/internal/helpdesk/queue?status=open&sla_state=breached' });

    expect(res.statusCode).toBe(200);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/helpdesk/agents/agents/queue');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('sla_state')).toBe('breached');
  });

  it('passes through the upstream error envelope and status', async () => {
    fetchMock.mockResolvedValueOnce(
      upstream(404, { error: { code: 'NOT_FOUND', message: 'Ticket not found' } }),
    );
    const res = await app.inject({ method: 'GET', url: `/internal/helpdesk/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Ticket not found');
  });

  it('returns 502 when helpdesk-api is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await app.inject({ method: 'GET', url: `/internal/helpdesk/tickets/${TICKET_ID}` });
    expect(res.statusCode).toBe(502);
  });

  it('requires a Bam session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/helpdesk/tickets/${TICKET_ID}`,
      headers: { 'x-test-anon': '1' },
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
