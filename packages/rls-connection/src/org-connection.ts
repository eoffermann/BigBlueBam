import type postgres from 'postgres';
import { withReservedTransactions } from './reserved-transactions.js';

/**
 * The value app.current_org_id is reset to before a reserved connection returns to its pool.
 *
 * A custom GUC cannot be unset to NULL (RESET and set_config(NULL) both leave ''), and ''::uuid
 * used to throw 22P02 in the policies, so a later unreserved pool query on that connection would
 * 500 (issue #104). The nil UUID casts cleanly and matches no real org (orgs use
 * gen_random_uuid()), so a query that lands on the connection afterwards fails closed to zero rows.
 */
export const NIL_ORG_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Reserve one connection from `pool`, bind app.current_org_id to `orgId` on it for the session,
 * and return it ready for drizzle.
 *
 * Ready for drizzle means two things the bare postgres.js ReservedSql lacks:
 *  - begin()/savepoint(), so db.transaction(...) and nested tx.transaction(...) run on this
 *    connection (withReservedTransactions; #364, #365);
 *  - `options`, which drizzle's postgres-js driver reads and patches (parsers/serializers). Without
 *    it drizzle(reserved) threw "Cannot read properties of undefined (reading 'parsers')". A
 *    reserved connection runs with its pool's options, which drizzle already patched when the
 *    pool's own drizzle instance was created, so it gets those.
 *
 * If binding the GUC fails the connection is released before the error is rethrown.
 */
export async function reserveOrgConnection(pool: postgres.Sql, orgId: string): Promise<postgres.ReservedSql> {
  const reserved = await pool.reserve();
  try {
    // Session-level (is_local=false) is correct: the connection is exclusive to its holder and
    // releaseOrgConnection resets the GUC before it returns to the pool.
    await reserved`select set_config('app.current_org_id', ${orgId}, false)`;
  } catch (err) {
    reserved.release();
    throw err;
  }
  return Object.assign(withReservedTransactions(reserved), { options: pool.options });
}

/**
 * Reset app.current_org_id to NIL_ORG_ID and return the connection to its pool. The reset is
 * best-effort; the release always happens, so the pool never leaks.
 */
export async function releaseOrgConnection(reserved: postgres.ReservedSql): Promise<void> {
  try {
    await reserved`select set_config('app.current_org_id', ${NIL_ORG_ID}, false)`;
  } catch {
    // Best-effort; released regardless.
  }
  reserved.release();
}
