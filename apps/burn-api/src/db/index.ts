import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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

export const db = drizzle(queryClient, { schema });
export const readDb = drizzle(readClient, { schema });

export const connection = queryClient;
export const readConnection = readClient;

export type Db = typeof db;
/** The transaction handle drizzle hands to the `db.transaction()` callback. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
