import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 1 / Platform §3.3 — RLS plugin tests.
//
// These tests exercise `request.withRls` under the two BBB_RLS_ENFORCE
// modes without touching a real Postgres. We mock db.transaction and
// db.execute so we can verify:
//
//   * BBB_RLS_ENFORCE=0 (default): withRls runs the callback inside a
//     transaction WITHOUT calling SELECT set_config(...) — the bypass
//     strategy from D-016. Queries still return rows because the DB
//     role is BYPASSRLS.
//   * BBB_RLS_ENFORCE=1: withRls sets app.current_org_id via set_config
//     before running the callback.
//
// The ALTER ROLE boot-time toggle is best-effort; we only assert that
// it is attempted (or skipped cleanly on failure).

const { mockDb, mockTx, envStore } = vi.hoisted(() => {
  const mockTx = {
    execute: vi.fn().mockResolvedValue(undefined),
  };
  const mockDb = {
    execute: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
  const envStore = {
    value: {
      BBB_RLS_ENFORCE: '0' as '0' | '1',
      DATABASE_URL: 'postgres://bigbluebam:secret@localhost:5432/bigbluebam',
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
      SESSION_TTL_SECONDS: 604800,
    },
  };
  return { mockDb, mockTx, envStore };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  get env() {
    return envStore.value;
  },
}));

// Import the plugin AFTER the mocks are wired.
const { default: rlsPlugin } = await import('../src/plugins/rls.js');

function makeFastifyStub() {
  const decorated: Record<string, unknown> = {};
  const hooks: Record<string, Array<(...args: any[]) => any>> = {};
  const logs: Array<{ level: string; payload: unknown; message: string }> = [];
  const stub = {
    log: {
      info: (payload: unknown, message: string) => logs.push({ level: 'info', payload, message }),
      warn: (payload: unknown, message: string) => logs.push({ level: 'warn', payload, message }),
      error: (payload: unknown, message: string) => logs.push({ level: 'error', payload, message }),
    },
    decorateRequest: (name: string, value: unknown) => {
      decorated[name] = value;
    },
    addHook: (event: string, fn: (...args: any[]) => any) => {
      (hooks[event] ||= []).push(fn);
    },
  };
  return { stub, decorated, hooks, logs };
}

describe('rls plugin', () => {
  beforeEach(() => {
    mockDb.execute.mockClear();
    mockDb.transaction.mockClear();
    mockTx.execute.mockClear();
    envStore.value.BBB_RLS_ENFORCE = '0';
  });

  // fastify-plugin returns the inner function itself with symbols attached,
  // so calling `(rlsPlugin as any)(stub, {})` invokes the registered body.
  async function invokePlugin(stub: unknown) {
    await (rlsPlugin as unknown as (app: unknown, opts: unknown) => Promise<void>)(stub, {});
  }

  it('with BBB_RLS_ENFORCE=0 returns rows without setting app.current_org_id', async () => {
    envStore.value.BBB_RLS_ENFORCE = '0';
    const { stub, hooks } = makeFastifyStub();
    await invokePlugin(stub);

    // Boot-time role toggle: ALTER ROLE ... BYPASSRLS should have been
    // attempted once against db.execute (or silently swallowed).
    expect(mockDb.execute).toHaveBeenCalled();

    // Now invoke the onRequest hook with a fake request carrying an
    // authenticated user context and verify withRls runs the callback
    // without a set_config call.
    const onRequest = (hooks['onRequest'] ?? [])[0];
    expect(onRequest).toBeTypeOf('function');

    const fakeRequest: Record<string, unknown> = {
      user: { active_org_id: '00000000-0000-0000-0000-000000000001' },
    };
    await onRequest!(fakeRequest);
    expect(typeof (fakeRequest as any).withRls).toBe('function');

    const rows = [{ id: 'task-1' }, { id: 'task-2' }];
    const result = await (fakeRequest as any).withRls(async () => rows);
    expect(result).toEqual(rows);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // set_config must NOT have been invoked in bypass mode.
    expect(mockTx.execute).not.toHaveBeenCalled();
  });

  it('with BBB_RLS_ENFORCE=1 calls set_config before running the callback', async () => {
    envStore.value.BBB_RLS_ENFORCE = '1';
    const { stub, hooks } = makeFastifyStub();
    await invokePlugin(stub);

    const onRequest = (hooks['onRequest'] ?? [])[0];
    const fakeRequest: Record<string, unknown> = {
      user: { active_org_id: '11111111-1111-1111-1111-111111111111' },
    };
    await onRequest!(fakeRequest);

    await (fakeRequest as any).withRls(async () => [1, 2, 3]);
    expect(mockTx.execute).toHaveBeenCalledTimes(1);
  });
});
