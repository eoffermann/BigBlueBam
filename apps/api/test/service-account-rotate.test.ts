import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
const { mockDb, mockArgon2 } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  const mockArgon2 = {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed-key'),
  };
  return { mockDb, mockArgon2 };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

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
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('argon2', () => ({ default: mockArgon2 }));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: [], request_id: request.id },
      });
    }
  },
  requireMinRole: (_role: string) => async (_request: any, _reply: any) => {},
}));

import serviceAccountRoutes from '../src/routes/service-account.routes.js';

// ---------- constants ----------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const SVC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const KEY_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREATOR_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADMIN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MEMBER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: CREATOR_ID,
    active_org_id: ORG_A,
    role: 'member',
    is_superuser: false,
    kind: 'human',
    ...overrides,
  };
}

async function buildApp(user?: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    if (user !== undefined) {
      (request as any).user = user;
    }
  });
  await app.register(serviceAccountRoutes);
  return app;
}

// ---------- db mock helpers ----------

// Single select().from().where().orderBy().limit() chain
function mockSelectChain(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// select().from().where() chain (no orderBy — used for the service-account lookup)
function mockSelectSimple(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// Simulate the transaction: insert successor, update predecessor. The callback
// receives a scripted tx and we return the inserted row as the successor.
function mockRotateTransaction(successorRow: unknown) {
  mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
    const returning = vi.fn().mockResolvedValueOnce([successorRow]);
    const values = vi.fn().mockReturnValue({ returning });
    const txInsert = vi.fn().mockReturnValue({ values });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: updateSet });

    return cb({ insert: txInsert, update: txUpdate });
  });
}

// ---------- fixture rows ----------
const svcRow = {
  id: SVC_ID,
  org_id: ORG_A,
  kind: 'service',
  display_name: 'My Bot',
  created_by: CREATOR_ID,
};

const activeKeyRow = {
  id: KEY_ID,
  user_id: SVC_ID,
  org_id: ORG_A,
  name: 'my-bot-key',
  key_hash: '$argon2id$old-hash',
  key_prefix: 'bbam_svc_xx',
  scope: 'read_write',
  project_ids: [],
  expires_at: null,
  predecessor_id: null,
  rotated_at: null,
  created_at: new Date(),
};

const successorRow = {
  id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  user_id: SVC_ID,
  org_id: ORG_A,
  name: 'my-bot-key',
  key_prefix: 'bbam_svc_',
  scope: 'read_write',
  predecessor_id: KEY_ID,
  created_at: new Date(),
};

// ---------- tests ----------

describe('POST /auth/service-accounts/:id/rotate-key', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 with no auth', async () => {
    app = await buildApp(undefined);
    const res = await app.inject({ method: 'POST', url: `/auth/service-accounts/${SVC_ID}/rotate-key` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the service account does not exist', async () => {
    app = await buildApp(makeUser());
    mockSelectSimple([]); // no user row
    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when the service account belongs to a different org', async () => {
    app = await buildApp(makeUser({ active_org_id: ORG_B }));
    mockSelectSimple([{ ...svcRow, org_id: ORG_A }]); // svc is in ORG_A, caller is in ORG_B
    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when caller is a plain member who did not create the account', async () => {
    app = await buildApp(makeUser({ id: MEMBER_ID, role: 'member', is_superuser: false }));
    mockSelectSimple([svcRow]); // svc created_by = CREATOR_ID, caller is MEMBER_ID
    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when the service account has no active key', async () => {
    app = await buildApp(makeUser()); // caller is creator
    mockSelectSimple([svcRow]);
    mockSelectChain([]); // no active key
    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 409 when the active key has already been rotated', async () => {
    app = await buildApp(makeUser()); // caller is creator
    mockSelectSimple([svcRow]);
    mockSelectChain([{ ...activeKeyRow, rotated_at: new Date() }]);
    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_ROTATED');
  });

  it('returns 201 with a new bbam_svc_ token when the creator rotates', async () => {
    app = await buildApp(makeUser()); // caller is the creator
    mockSelectSimple([svcRow]);
    mockSelectChain([activeKeyRow]);
    mockRotateTransaction(successorRow);

    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.key).toMatch(/^bbam_svc_/);
    expect(data.name).toBe('My Bot');
    expect(data.predecessor_grace_expires_at).toBeTruthy();
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 201 when an org admin (not the creator) rotates the key', async () => {
    app = await buildApp(makeUser({ id: ADMIN_ID, role: 'admin', is_superuser: false }));
    mockSelectSimple([svcRow]); // svc created_by = CREATOR_ID, caller is ADMIN_ID
    mockSelectChain([activeKeyRow]);
    mockRotateTransaction(successorRow);

    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.key).toMatch(/^bbam_svc_/);
  });

  it('returns 201 when a SuperUser rotates the key', async () => {
    app = await buildApp(makeUser({ id: MEMBER_ID, role: 'member', is_superuser: true }));
    mockSelectSimple([svcRow]);
    mockSelectChain([activeKeyRow]);
    mockRotateTransaction(successorRow);

    const res = await app.inject({
      method: 'POST',
      url: `/auth/service-accounts/${SVC_ID}/rotate-key`,
    });
    expect(res.statusCode).toBe(201);
  });
});
