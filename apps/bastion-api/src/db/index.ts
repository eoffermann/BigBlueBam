import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

// Connections capped at 10 per URL (spec 9.1): the shared Postgres runs max_connections=200 and
// every API opens a write pool plus a read pool.
//
// Two clients per URL, deliberately. drizzle's postgres-js driver installs pass-through
// serializers and parsers on the client it wraps (dates and json travel as raw strings), so a
// raw tagged-template query on that client cannot bind a Date or an object and reads timestamps
// back as strings. The evidence engines (src/engine/*) speak raw SQL, so they get their own
// client that drizzle never touches (`engineConnection`), carved out of the same budget:
// 6 for drizzle, 4 for the engines. Found by the M4 live rehearsal; pinned by
// test/db/m4-restore.test.ts against the production clients.
const DRIZZLE_POOL_MAX = 6;
const ENGINE_POOL_MAX = 4;
const opts = (max: number) => ({ max, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });

const queryClient = postgres(env.DATABASE_URL, opts(DRIZZLE_POOL_MAX));
const engineClient = postgres(env.DATABASE_URL, opts(ENGINE_POOL_MAX));

// Probes run on DATABASE_READ_URL when it is set (spec 9.5, M4).
const readUrl = env.DATABASE_READ_URL ?? env.DATABASE_URL;
const separateRead = readUrl !== env.DATABASE_URL;
const readClient = separateRead ? postgres(readUrl, opts(DRIZZLE_POOL_MAX)) : queryClient;
const engineReadClient = separateRead ? postgres(readUrl, opts(ENGINE_POOL_MAX)) : engineClient;

export const db = drizzle(queryClient, { schema });
export const readDb = drizzle(readClient, { schema });

/** Drizzle's clients. Do not run raw tagged-template SQL with Date or object params on these. */
export const connection = queryClient;
export const readConnection = readClient;

/** Raw postgres.js clients for the engines, with postgres.js's own (de)serialization intact. */
export const engineConnection = engineClient;
export const engineReadConnection = engineReadClient;

/** Every client this process opened, for shutdown. */
export function allConnections(): postgres.Sql[] {
  return [...new Set([queryClient, readClient, engineClient, engineReadClient])];
}

export type Db = typeof db;
/** The transaction handle drizzle hands to the `db.transaction()` callback. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
