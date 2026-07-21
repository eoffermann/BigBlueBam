import { describe, it, expect, vi } from 'vitest';

// Parseable URLs so db/index.ts can construct the (lazy) postgres-js clients without connecting.
// With no separate DATABASE_READ_URL, read and write share one client (the common deployment).
vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    DATABASE_READ_URL: undefined,
    NODE_ENV: 'test',
  },
}));

const { db, readDb, rlsStorage, readSharesWriteClient } = await import('../src/db/index.js');

describe('basis RLS db proxy (issue #87)', () => {
  it('read and write share one client when no read replica is configured', () => {
    expect(readSharesWriteClient).toBe(true);
  });

  it('db and readDb use the pools when no request store is active', () => {
    expect(typeof db.select).toBe('function');
    expect(typeof readDb.select).toBe('function');
  });

  it('routes db and readDb to their request-scoped instances inside a store', () => {
    const w = Symbol('write');
    const r = Symbol('read');
    const scopedW = { select: () => w } as unknown as typeof db;
    const scopedR = { select: () => r } as unknown as typeof readDb;

    rlsStorage.run(
      { db: scopedW, readDb: scopedR, reserved: null, readReserved: null },
      () => {
        expect((db.select as () => unknown)()).toBe(w);
        expect((readDb.select as () => unknown)()).toBe(r);
      },
    );
  });

  it('falls back to the pools once the store leaves scope', () => {
    const w = Symbol('write');
    const scopedW = { select: () => w } as unknown as typeof db;
    rlsStorage.run({ db: scopedW, readDb: null, reserved: null, readReserved: null }, () => {
      expect((db.select as () => unknown)()).toBe(w);
      // readDb is null in the store -> proxy falls back to the read pool, not the write marker.
      expect((readDb.select as () => unknown)()).not.toBe(w);
    });
    expect((db.select as () => unknown)()).not.toBe(w);
  });

  it('isolates concurrent request stores (no org bleed between contexts)', async () => {
    const a = Symbol('A');
    const b = Symbol('B');
    const run = (marker: symbol) =>
      new Promise<void>((resolve) => {
        const scoped = { select: () => marker } as unknown as typeof db;
        rlsStorage.run({ db: scoped, readDb: scoped, reserved: null, readReserved: null }, async () => {
          await new Promise((res) => setTimeout(res, 1));
          expect((db.select as () => unknown)()).toBe(marker);
          resolve();
        });
      });
    await Promise.all([run(a), run(b)]);
  });
});
