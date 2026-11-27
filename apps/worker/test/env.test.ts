import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Worker env validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadEnvFresh() {
    const mod = await import('../src/env.js');
    return mod.loadEnv;
  }

  it('parses valid env correctly', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/db');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.WORKER_CONCURRENCY).toBe(5);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('has one name for the api private base: BBB_API_INTERNAL_URL, never API_INTERNAL_URL (#192)', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.BBB_API_INTERNAL_URL = 'http://api.railway.internal:8080';
    const loadEnv = await loadEnvFresh();
    const env = loadEnv() as Record<string, unknown>;
    expect(env.BBB_API_INTERNAL_URL).toBe('http://api.railway.internal:8080');
    expect('API_INTERNAL_URL' in env).toBe(false);

    // No worker source may read the second name again.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const srcDir = join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && /(?<![A-Z_])API_INTERNAL_URL/.test(readFileSync(p, 'utf8').replace(/\/\/.*$/gm, ''))) offenders.push(p);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('fails validation when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';

    const loadEnv = await loadEnvFresh();

    expect(() => loadEnv()).toThrow('Invalid environment variables');
  });

  it('uses default when REDIS_URL is missing', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    delete process.env.REDIS_URL;

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('defaults WORKER_CONCURRENCY to 5', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    delete process.env.WORKER_CONCURRENCY;

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.WORKER_CONCURRENCY).toBe(5);
  });

  it('overrides WORKER_CONCURRENCY when provided', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.WORKER_CONCURRENCY = '10';

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.WORKER_CONCURRENCY).toBe(10);
  });

  it('defaults LOG_LEVEL to info', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    delete process.env.LOG_LEVEL;

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.LOG_LEVEL).toBe('info');
  });

  it('accepts valid LOG_LEVEL values', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.LOG_LEVEL = 'debug';

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('coerces SMTP_PORT to number', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.SMTP_PORT = '465';

    const loadEnv = await loadEnvFresh();
    const env = loadEnv();

    expect(env.SMTP_PORT).toBe(465);
  });
});
