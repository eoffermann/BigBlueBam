import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../env.js';
import * as schema from './schema/index.js';

const queryClient = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
});

const poolDb = drizzle(queryClient, { schema });

/**
 * Per-request Row-Level-Security context (issue #87).
 *
 * The org GUC (`app.current_org_id`) that RLS policies read is a session/transaction
 * setting, so it MUST live on the same physical connection as the request's queries.
 * With a connection pool, a `set_config(..., true)` issued as a standalone statement is
 * discarded the instant its implicit transaction commits, and the request's real queries
 * then run on other pooled connections with no GUC set. To bind correctly, the RLS plugin
 * (enforce mode only) reserves one connection for the whole request, sets the GUC on it,
 * and stores a drizzle instance bound to that reserved connection here. The exported `db`
 * is a Proxy that transparently routes to the request-scoped instance when one is present,
 * so existing route code that imports the global `db` needs no changes.
 *
 * In soft mode (default, `BBB_RLS_ENFORCE` unset) the store is never populated, so `db`
 * always uses the pool exactly as before - no connection pinning, no behavior change.
 */
export interface RlsStore {
  db: PostgresJsDatabase<typeof schema> | null;
  reserved: postgres.ReservedSql | null;
}

export const rlsStorage = new AsyncLocalStorage<RlsStore>();

export const db: PostgresJsDatabase<typeof schema> = new Proxy(poolDb, {
  get(target, prop, receiver) {
    const active = rlsStorage.getStore()?.db ?? target;
    const value = Reflect.get(active, prop, receiver);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(active) : value;
  },
}) as PostgresJsDatabase<typeof schema>;

type OrgScopeTx = Parameters<Parameters<typeof poolDb.transaction>[0]>[0];

/**
 * Run `fn` with `app.current_org_id` bound to `orgId`, for work that has no
 * authenticated user to bind it (#338): creating an org at register/bootstrap,
 * a token-authenticated feed, a guest accepting an invite, server-to-server
 * routes acting on one org's rows.
 *
 * The rls plugin binds the org per request only once `request.user` is known;
 * a request without one gets no binding, and under BBB_RLS_ENFORCE=1 every
 * org-gated read returns nothing and every org-gated write fails its policy
 * check. This opens a transaction on the pool, sets the GUC transaction-locally
 * (it ends with the transaction, so the pooled connection never carries it),
 * and routes the global `db` proxy onto that transaction for the duration of
 * `fn` through the same AsyncLocalStorage the rls plugin uses. Code inside
 * `fn` may use either the `tx` argument or the global `db`; nested
 * `db.transaction(...)` calls become savepoints.
 *
 * Runs the same way in both postures. Under the advisory default the role
 * bypasses RLS, so the GUC changes nothing and `fn` simply runs in one
 * transaction.
 */
export async function runInOrgScope<T>(orgId: string, fn: (tx: OrgScopeTx) => Promise<T>): Promise<T> {
  return poolDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    const store: RlsStore = { db: tx as unknown as PostgresJsDatabase<typeof schema>, reserved: null };
    return rlsStorage.run(store, () => fn(tx));
  });
}

export const connection = queryClient;
export { queryClient, schema };
