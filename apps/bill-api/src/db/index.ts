import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

const queryClient = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
  // Issue #169: no request may wait on a row lock, or sit idle inside an open
  // transaction, long enough to drain this 20-connection pool. lock_timeout fails
  // a blocked statement with SQLSTATE 55P03; idle_in_transaction_session_timeout
  // makes the server end a session left idle mid-transaction (e.g. a handler
  // stuck on outside I/O), returning its locks and its connection.
  connection: {
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  },
});

export const db = drizzle(queryClient, { schema });

export const connection = queryClient;
