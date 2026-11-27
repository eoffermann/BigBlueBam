import type postgres from 'postgres';

type TxFn<T> = (client: postgres.ReservedSql) => Promise<T> | T;

/**
 * Give a reserved postgres.js connection the begin/savepoint pair drizzle needs (#364, #365).
 *
 * Under BBB_RLS_ENFORCE=1 the request rls binding pins one connection per request with
 * pool.reserve() and binds a drizzle instance to it. postgres.js gives a reserved connection no
 * begin() and no savepoint(), and drizzle's postgres-js session runs db.transaction(...) as
 * client.begin(...) and tx.transaction(...) as client.savepoint(...), so every transaction in an
 * org-bound request failed with "this.client.begin is not a function".
 *
 * The transaction runs on the reserved connection itself, so the org GUC bound on it stays in
 * force inside the transaction. A begin() issued while a transaction is already open on the
 * connection (a nested call through a global db proxy rather than through tx) becomes a
 * savepoint instead of a second BEGIN, which Postgres would ignore and then commit early.
 * A throw rolls back to where the block started and rethrows.
 *
 * Services do not call this directly: reserveOrgConnection applies it to every connection it
 * reserves, and scripts/lib/rls-reserved-connection.test.mjs fails if a service reserves one
 * itself.
 */
export function withReservedTransactions(reserved: postgres.ReservedSql): postgres.ReservedSql {
  let depth = 0;
  let savepoints = 0;

  const run = async <T>(fn: TxFn<T>): Promise<T> => {
    const nested = depth > 0;
    const name = nested ? `bbb_sp_${++savepoints}` : '';
    await reserved.unsafe(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    depth += 1;
    try {
      const out = await fn(client);
      await reserved.unsafe(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return out;
    } catch (err) {
      try {
        await reserved.unsafe(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
      throw err;
    } finally {
      depth -= 1;
    }
  };

  // begin([options], fn) / savepoint([name], fn): drizzle passes only fn; options are ignored.
  const pickFn = <T>(a: unknown, b: unknown): TxFn<T> => (typeof a === 'function' ? a : b) as TxFn<T>;
  const client = Object.assign(reserved, {
    begin: <T>(a: unknown, b?: unknown) => run(pickFn<T>(a, b)),
    savepoint: <T>(a: unknown, b?: unknown) => run(pickFn<T>(a, b)),
  });
  return client;
}
