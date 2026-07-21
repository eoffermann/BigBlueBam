import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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

export const connection = queryClient;
export { queryClient, schema };
