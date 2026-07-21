import { describe, it, expect, vi } from 'vitest';

// Provide a parseable DATABASE_URL so db/index.ts can construct the (lazy) postgres-js client
// without a live connection. postgres-js does not connect until the first query runs, and these
// tests only exercise the Proxy routing, never a query.
vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
  },
}));

const { db, rlsStorage } = await import('../src/db/index.js');

describe('RLS db proxy (issue #87)', () => {
  it('routes db access to the pool when no request store is active', () => {
    // Outside any rlsStorage context, the proxy forwards to the real pool drizzle instance.
    expect(typeof db.select).toBe('function');
    expect(typeof db.transaction).toBe('function');
  });

  it('routes db access to the request-scoped instance inside a store', () => {
    const marker = Symbol('scoped-select-result');
    const scoped = {
      select: () => marker,
      transaction: () => 'scoped-tx',
    } as unknown as (typeof db);

    rlsStorage.run({ db: scoped, reserved: null }, () => {
      // Every db.* access is transparently served by the request-scoped instance.
      expect((db.select as () => unknown)()).toBe(marker);
      expect((db.transaction as () => unknown)()).toBe('scoped-tx');
    });
  });

  it('falls back to the pool once the store leaves scope', () => {
    const marker = Symbol('scoped');
    const scoped = { select: () => marker } as unknown as (typeof db);
    rlsStorage.run({ db: scoped, reserved: null }, () => {
      expect((db.select as () => unknown)()).toBe(marker);
    });
    // Back outside the context: the pool builder is returned, not the scoped marker.
    expect((db.select as () => unknown)()).not.toBe(marker);
  });

  it('a store with a null db (reserved not yet bound) still uses the pool', () => {
    // preHandler sets store.db only after reserving; before that, db must fall back to the pool.
    rlsStorage.run({ db: null, reserved: null }, () => {
      expect(typeof db.select).toBe('function');
    });
  });

  it('isolates concurrent request stores (no org bleed between contexts)', async () => {
    const a = Symbol('A');
    const b = Symbol('B');
    const scopedA = { select: () => a } as unknown as (typeof db);
    const scopedB = { select: () => b } as unknown as (typeof db);

    const run = (scoped: typeof db, expected: symbol) =>
      new Promise<void>((resolve) => {
        rlsStorage.run({ db: scoped, reserved: null }, async () => {
          // Yield so the two contexts interleave; each must still see only its own db.
          await new Promise((r) => setTimeout(r, 1));
          expect((db.select as () => unknown)()).toBe(expected);
          resolve();
        });
      });

    await Promise.all([run(scopedA, a), run(scopedB, b)]);
  });
});
