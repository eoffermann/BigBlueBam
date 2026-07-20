import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

// Pool cap is 10, NOT the 20 the sibling services use (spec 18.5). The shared Postgres is
// already oversubscribed: each API opens a write pool plus a read pool, and Bursar adds
// background jobs and long-held advisory locks on top. The headroom migration raises
// max_connections to 200, but a service that also takes 20 here just moves the ceiling
// rather than raising it, and the failure surfaces as a "too many clients" outage in Bond
// or Bill rather than in Bursar.
const POOL_MAX = 10;

const queryClient = postgres(env.DATABASE_URL, {
  max: POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
});

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
