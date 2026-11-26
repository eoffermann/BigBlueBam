import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

// Pool capped at 10 (spec 9.1): the shared Postgres runs max_connections=200 and every API
// opens a write pool plus a read pool.
const POOL_MAX = 10;

const queryClient = postgres(env.DATABASE_URL, {
  max: POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Probes run on DATABASE_READ_URL when it is set (spec 9.5, M4).
const readUrl = env.DATABASE_READ_URL ?? env.DATABASE_URL;
const readClient =
  readUrl !== env.DATABASE_URL
    ? postgres(readUrl, { max: POOL_MAX, idle_timeout: 20, connect_timeout: 10 })
    : queryClient;

export const db = drizzle(queryClient, { schema });
export const readDb = drizzle(readClient, { schema });

export const connection = queryClient;
export const readConnection = readClient;

export type Db = typeof db;
/** The transaction handle drizzle hands to the `db.transaction()` callback. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
