import { AsyncLocalStorage } from 'node:async_hooks';
import Fastify from 'fastify';
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { requestRlsBinding, type RequestRlsStore } from './index.js';

// Fake postgres.js pool whose reserve() is controllable: 'ok' resolves at once, 'hang' never
// settles until released by the test, 'fail' rejects.
function fakePool(name: string) {
  let mode: 'ok' | 'hang' | 'fail' = 'ok';
  let reserves = 0;
  let released = 0;
  const hung: Array<(conn: postgres.ReservedSql) => void> = [];
  const makeConn = () => {
    const tag = async () => [];
    return Object.assign(tag, {
      via: name,
      unsafe: async () => [],
      release: () => {
        released += 1;
      },
    }) as unknown as postgres.ReservedSql;
  };
  const pool = {
    options: {},
    reserve: () => {
      reserves += 1;
      if (mode === 'fail') return Promise.reject(new Error(`${name} down`));
      if (mode === 'hang') return new Promise<postgres.ReservedSql>((resolve) => hung.push(resolve));
      return Promise.resolve(makeConn());
    },
  } as unknown as postgres.Sql;
  return {
    pool,
    setMode: (m: typeof mode) => {
      mode = m;
    },
    reserves: () => reserves,
    released: () => released,
    resolveHung: () => {
      for (const r of hung.splice(0)) r(makeConn());
    },
  };
}

type Db = { via: string };
type Store = RequestRlsStore<Db>;

async function makeApp(opts: { now: () => number; timeoutMs?: number }) {
  const write = fakePool('write');
  const read = fakePool('read');
  const storage = new AsyncLocalStorage<Store>();
  const app = Fastify();
  await app.register(
    requestRlsBinding<Store>({
      service: 'test-api',
      enforce: true,
      storage,
      writeClient: write.pool,
      readClient: read.pool,
      bindDb: (conn) => ({ via: (conn as unknown as { via: string }).via }),
      resolveOrgId: () => '11111111-1111-1111-1111-111111111111',
      readReserveTimeoutMs: opts.timeoutMs ?? 50,
      readBreakerCooldownMs: 1_000,
      now: opts.now,
    }),
  );
  app.get('/', async () => ({ read: storage.getStore()?.readDb?.via, write: storage.getStore()?.db?.via }));
  return { app, write, read };
}

describe('requestRlsBinding read-replica outage (#377)', () => {
  it('gives up on a hanging replica within the reserve budget and reads on the write connection', async () => {
    const { app, read } = await makeApp({ now: () => 0 });
    read.setMode('hang');
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.json()).toEqual({ read: 'write', write: 'write' });
    // A reserve that completes after the deadline goes straight back to the replica pool.
    read.resolveHung();
    await new Promise((r) => setTimeout(r, 10));
    expect(read.released()).toBe(1);
    await app.close();
  });

  it('skips the replica while the circuit is open, probes once after the cooldown, and closes on success', async () => {
    let clock = 0;
    const { app, read, write } = await makeApp({ now: () => clock });
    read.setMode('fail');

    expect((await app.inject({ method: 'GET', url: '/' })).json().read).toBe('write');
    expect(read.reserves()).toBe(1);

    // Open: no replica attempts, no waiting.
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/' })).json().read).toBe('write');
    }
    expect(read.reserves()).toBe(1);

    // Cooldown elapsed, replica still down: one probe, circuit re-opens.
    clock = 1_500;
    await app.inject({ method: 'GET', url: '/' });
    await app.inject({ method: 'GET', url: '/' });
    expect(read.reserves()).toBe(2);

    // Replica back: the next probe closes the circuit and reads go to the replica again.
    read.setMode('ok');
    clock = 3_000;
    expect((await app.inject({ method: 'GET', url: '/' })).json().read).toBe('read');
    expect((await app.inject({ method: 'GET', url: '/' })).json().read).toBe('read');
    expect(read.reserves()).toBe(4);

    // Every reserved connection was released at the end of its request.
    expect(write.released()).toBe(write.reserves());
    expect(read.released()).toBe(2);
    await app.close();
  });
});
