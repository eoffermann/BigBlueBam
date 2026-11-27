import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { NIL_ORG_ID, releaseOrgConnection, reserveOrgConnection, withReservedTransactions } from './index.js';

// A stand-in for a postgres.js ReservedSql: records every statement, tagged-template or unsafe.
function fakeReserved(opts: { failGuc?: boolean } = {}) {
  const log: string[] = [];
  let released = 0;
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `<${String(values[i])}>` : ''), '');
    if (opts.failGuc && text.includes('set_config') && !values.includes(NIL_ORG_ID)) throw new Error('guc failed');
    log.push(text);
    return [];
  };
  const reserved = Object.assign(tag, {
    unsafe: async (text: string) => {
      log.push(text);
      return [];
    },
    release: () => {
      released += 1;
    },
  });
  return { reserved: reserved as unknown as postgres.ReservedSql, log, released: () => released };
}

describe('withReservedTransactions', () => {
  it('commits a transaction and turns a nested one into a savepoint', async () => {
    const f = fakeReserved();
    const c = withReservedTransactions(f.reserved) as unknown as {
      begin: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      savepoint: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    };
    const out = await c.begin(async () => {
      await c.savepoint(async () => 1);
      return 'done';
    });
    expect(out).toBe('done');
    expect(f.log).toEqual(['BEGIN', 'SAVEPOINT bbb_sp_1', 'RELEASE SAVEPOINT bbb_sp_1', 'COMMIT']);
  });

  it('rolls back to the savepoint on an inner throw and rolls back everything on an outer throw', async () => {
    const f = fakeReserved();
    const c = withReservedTransactions(f.reserved) as unknown as {
      begin: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    };
    await expect(
      c.begin(async () => {
        await c.begin(async () => {
          throw new Error('inner');
        }).catch(() => undefined);
        throw new Error('outer');
      }),
    ).rejects.toThrow('outer');
    expect(f.log).toEqual(['BEGIN', 'SAVEPOINT bbb_sp_1', 'ROLLBACK TO SAVEPOINT bbb_sp_1', 'ROLLBACK']);
  });
});

describe('reserveOrgConnection / releaseOrgConnection', () => {
  it('binds the org, adds begin/savepoint and the pool options, and resets to the nil org on release', async () => {
    const f = fakeReserved();
    const options = { parsers: {}, serializers: {} };
    const pool = { reserve: async () => f.reserved, options } as unknown as postgres.Sql;
    const conn = await reserveOrgConnection(pool, 'org-1');
    expect(typeof (conn as unknown as { begin: unknown }).begin).toBe('function');
    expect(typeof (conn as unknown as { savepoint: unknown }).savepoint).toBe('function');
    expect((conn as unknown as { options: unknown }).options).toBe(options);
    expect(f.log).toEqual(["select set_config('app.current_org_id', <org-1>, false)"]);
    await releaseOrgConnection(conn);
    expect(f.log[1]).toBe(`select set_config('app.current_org_id', <${NIL_ORG_ID}>, false)`);
    expect(f.released()).toBe(1);
  });

  it('releases the connection when binding the org fails', async () => {
    const f = fakeReserved({ failGuc: true });
    const pool = { reserve: async () => f.reserved, options: {} } as unknown as postgres.Sql;
    await expect(reserveOrgConnection(pool, 'org-1')).rejects.toThrow('guc failed');
    expect(f.released()).toBe(1);
  });
});
