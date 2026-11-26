import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #251: BIN_ALLOW_UNSCANNED_ACCESS gates serving files whose AV scan has not finished
// (services/scan.service.ts). It was z.coerce.boolean().default(false), so the value
// .env.example ships, BIN_ALLOW_UNSCANNED_ACCESS=false, parsed as TRUE and failed open.

const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 's'.repeat(32),
};

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE, ...vars })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../src/env.js');
  return mod.env;
}

describe('bin-api env flags', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("BIN_ALLOW_UNSCANNED_ACCESS=false means false (it fails CLOSED, as .env.example intends)", async () => {
    expect((await loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: 'false' })).BIN_ALLOW_UNSCANNED_ACCESS).toBe(false);
    expect((await loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: '0' })).BIN_ALLOW_UNSCANNED_ACCESS).toBe(false);
    expect((await loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: '' })).BIN_ALLOW_UNSCANNED_ACCESS).toBe(false);
    expect((await loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: undefined })).BIN_ALLOW_UNSCANNED_ACCESS).toBe(false);
  });

  it('BIN_ALLOW_UNSCANNED_ACCESS=true opts in', async () => {
    expect((await loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: 'true' })).BIN_ALLOW_UNSCANNED_ACCESS).toBe(true);
  });

  it('an unrecognised value refuses to boot instead of guessing', async () => {
    await expect(loadEnv({ BIN_ALLOW_UNSCANNED_ACCESS: 'nope' })).rejects.toThrow('process.exit(1)');
  });

  it('COOKIE_SECURE=false means false', async () => {
    expect((await loadEnv({ COOKIE_SECURE: 'false' })).COOKIE_SECURE).toBe(false);
  });
});
