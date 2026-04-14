import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 1 / Platform §3.14 — API key rotation route tests.
//
// We do not spin up a real Fastify instance; instead we exercise the
// route-handler logic by pulling the inner function out via the Fastify
// stub below. The rotate path runs inside db.transaction(...) so the
// test controls which rows the "predecessor" lookup returns and asserts
// that:
//
//   * A predecessor that is already rotated yields 409 ALREADY_ROTATED.
//   * A happy-path rotation inserts a new row with the cloned scope /
//     org / project_ids and returns the raw token exactly once.
//   * The predecessor row is updated with rotated_at + a 7-day
//     rotation_grace_expires_at.

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    update: vi.fn(),
    insert: vi.fn(),
  };
  const mockDb = {
    select: vi.fn(),
    transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
  return { mockDb, mockTx };
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
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed-rotated-key'),
    verify: vi.fn(),
  },
}));

vi.mock('../src/services/org.service.js', () => ({
  getOrganizationCached: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/services/org-permissions.js', () => ({
  getOrgPermissions: vi.fn().mockReturnValue({
    members_can_create_api_keys: true,
    allowed_api_key_scopes: ['read', 'read_write', 'admin'],
  }),
  isOrgPrivileged: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: vi.fn(),
  requireMinRole: vi.fn(() => vi.fn()),
}));

const { default: apiKeyRoutes } = await import('../src/routes/api-key.routes.js');

interface RouteRecord {
  method: string;
  path: string;
  handler: (req: unknown, reply: unknown) => Promise<unknown>;
}

function makeFastifyStub(): {
  routes: RouteRecord[];
  fastifyStub: {
    get: (...args: unknown[]) => void;
    post: (...args: unknown[]) => void;
    delete: (...args: unknown[]) => void;
    redis: unknown;
  };
} {
  const routes: RouteRecord[] = [];
  const capture = (method: string) => (...args: unknown[]) => {
    // Fastify route form: (path, opts, handler) OR (path, handler)
    const [path, maybeOpts, maybeHandler] = args as [string, unknown, unknown];
    const handler = (typeof maybeHandler === 'function' ? maybeHandler : maybeOpts) as RouteRecord['handler'];
    routes.push({ method, path, handler });
  };
  const fastifyStub = {
    get: capture('GET') as any,
    post: capture('POST') as any,
    delete: capture('DELETE') as any,
    redis: {},
  };
  return { routes, fastifyStub };
}

function makeReply() {
  const state: { status: number; body: unknown } = { status: 200, body: null };
  return {
    status(code: number) {
      state.status = code;
      return this;
    },
    send(body: unknown) {
      state.body = body;
      return state;
    },
    _state: state,
  };
}

describe('api-key rotation', () => {
  let routes: RouteRecord[];
  let rotateRoute: RouteRecord | undefined;

  beforeEach(async () => {
    mockDb.select.mockReset();
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockTx.update.mockReset();
    mockTx.insert.mockReset();

    const stub = makeFastifyStub();
    routes = stub.routes;
    await apiKeyRoutes(stub.fastifyStub as any);
    rotateRoute = routes.find((r) => r.method === 'POST' && r.path === '/v1/api-keys/:id/rotate');
    expect(rotateRoute).toBeDefined();
  });

  it('rejects rotation of a non-existent key with 404', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    });
    const reply = makeReply();
    const req = {
      params: { id: 'missing' },
      user: { id: 'u-1', is_superuser: false, active_org_id: 'org-1' },
      id: 'req-1',
    };
    const result = (await rotateRoute!.handler(req, reply)) as { body: { error: { code: string } }; status: number };
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects rotating an already-rotated key with 409', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{
            id: 'k-1',
            user_id: 'u-1',
            org_id: 'org-1',
            name: 'old key',
            key_hash: 'hash',
            key_prefix: 'prefix12',
            scope: 'read',
            project_ids: null,
            expires_at: null,
            rotated_at: new Date('2025-01-01'),
            rotation_grace_expires_at: new Date('2025-01-08'),
            predecessor_id: null,
            created_at: new Date('2024-12-01'),
            last_used_at: null,
          }],
        }),
      }),
    });
    const reply = makeReply();
    const req = {
      params: { id: 'k-1' },
      user: { id: 'u-1', is_superuser: false, active_org_id: 'org-1' },
      id: 'req-2',
    };
    const result = (await rotateRoute!.handler(req, reply)) as { body: { error: { code: string } }; status: number };
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('ALREADY_ROTATED');
  });

  it('rotates a key, returning the new token exactly once and marking the predecessor with a 7-day grace', async () => {
    const predecessor = {
      id: 'k-1',
      user_id: 'u-1',
      org_id: 'org-1',
      name: 'prod deploy',
      key_hash: 'old-hash',
      key_prefix: 'abcd1234',
      scope: 'read_write',
      project_ids: ['proj-1'],
      expires_at: null,
      rotated_at: null,
      rotation_grace_expires_at: null,
      predecessor_id: null,
      created_at: new Date('2025-01-01'),
      last_used_at: null,
    };
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [predecessor],
        }),
      }),
    });

    const updateCalls: Array<{ set: Record<string, unknown>; whereArg: unknown }> = [];
    mockTx.update.mockImplementation((_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (whereArg: unknown) => {
          updateCalls.push({ set: patch, whereArg });
          return Promise.resolve();
        },
      }),
    }));
    const insertCalls: Array<Record<string, unknown>> = [];
    mockTx.insert.mockImplementation((_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          insertCalls.push(vals);
          return [{
            id: 'k-2',
            name: vals.name,
            scope: vals.scope,
            project_ids: vals.project_ids,
            expires_at: vals.expires_at,
            created_at: new Date(),
          }];
        },
      }),
    }));

    const reply = makeReply();
    const req = {
      params: { id: 'k-1' },
      user: { id: 'u-1', is_superuser: false, active_org_id: 'org-1' },
      id: 'req-3',
    };
    const result = (await rotateRoute!.handler(req, reply)) as { status: number; body: any };
    expect(result.status).toBe(201);
    expect(result.body.data.key).toBeTypeOf('string');
    expect(result.body.data.key.length).toBeGreaterThan(20);
    expect(result.body.data.predecessor_id).toBe('k-1');
    // Predecessor grace window is roughly 7 days from now.
    const grace = new Date(result.body.data.predecessor_grace_expires_at).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(grace - (Date.now() + sevenDays))).toBeLessThan(60_000);

    // Predecessor was updated with rotated_at + grace.
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]!.set.rotated_at).toBeInstanceOf(Date);
    expect(updateCalls[0]!.set.rotation_grace_expires_at).toBeInstanceOf(Date);

    // Successor cloned scope/org/project_ids/expires_at and name suffixed.
    expect(insertCalls.length).toBe(1);
    const vals = insertCalls[0]!;
    expect(vals.org_id).toBe('org-1');
    expect(vals.user_id).toBe('u-1');
    expect(vals.scope).toBe('read_write');
    expect(vals.project_ids).toEqual(['proj-1']);
    expect(vals.name).toBe('prod deploy (rotated)');
    expect(vals.predecessor_id).toBe('k-1');
  });
});
