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

const readUrl = env.DATABASE_READ_URL ?? env.DATABASE_URL;
const readClient =
  readUrl !== env.DATABASE_URL
    ? postgres(readUrl, { max: 20, idle_timeout: 20, connect_timeout: 10 })
    : queryClient;

/** True when read and write share one client (no separate read replica configured). */
export const readSharesWriteClient = readClient === queryClient;

const poolDb = drizzle(queryClient, { schema });
const poolReadDb = drizzle(readClient, { schema });

/**
 * Per-request Row-Level-Security context (issue #87).
 *
 * The org GUC (`app.current_org_id`) that RLS policies read must be set on the SAME connection
 * the request's queries run on. With a connection pool, a standalone `set_config(..., true)` is
 * discarded before the request's real queries execute (they land on other pooled connections),
 * so the previous binding was inert - every policy-gated query returned zero rows under enforce
 * mode. In enforce mode the RLS plugin now reserves a connection per request (both the write and,
 * when a separate read replica is configured, the read client), sets the GUC on it, and stores
 * drizzle instances bound to the reserved connection(s) here. The exported `db`/`readDb` proxies
 * transparently route to those instances, so existing route code needs no changes.
 *
 * In soft mode (default) the store is never populated, so the proxies always use the pools -
 * no connection pinning, no behavior change.
 */
export interface RlsStore {
  db: PostgresJsDatabase<typeof schema> | null;
  readDb: PostgresJsDatabase<typeof schema> | null;
  reserved: postgres.ReservedSql | null;
  readReserved: postgres.ReservedSql | null;
}

export const rlsStorage = new AsyncLocalStorage<RlsStore>();

function rlsProxy(
  pool: PostgresJsDatabase<typeof schema>,
  key: 'db' | 'readDb',
): PostgresJsDatabase<typeof schema> {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      const active = rlsStorage.getStore()?.[key] ?? target;
      const value = Reflect.get(active, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(active) : value;
    },
  }) as PostgresJsDatabase<typeof schema>;
}

export const db: PostgresJsDatabase<typeof schema> = rlsProxy(poolDb, 'db');
export const readDb: PostgresJsDatabase<typeof schema> = rlsProxy(poolReadDb, 'readDb');

export const connection = queryClient;
export const readConnection = readClient;
export { queryClient, readClient, schema };
