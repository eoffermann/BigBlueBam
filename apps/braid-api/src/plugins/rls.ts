import { drizzle } from 'drizzle-orm/postgres-js';
import { requestRlsBinding } from '@bigbluebam/rls-connection';
import { queryClient, readClient, rlsStorage, schema } from '../db/index.js';
import { env } from '../env.js';

/**
 * Row-level security plugin for braid-api (binding fix #87; transactions #365).
 *
 * RLS policies (migrations 0230/0231) gate braid_* rows by `current_setting('app.current_org_id')`.
 * Under BBB_RLS_ENFORCE=1 each request reserves the write connection (and the read connection
 * when a separate read replica is configured) with the signed-in user's org bound, and the
 * `db`/`readDb` proxies route onto them. The reserve/bind/transaction/release mechanics live once
 * in @bigbluebam/rls-connection (requestRlsBinding); see it for the modes and their trade-offs.
 *
 * (burn-api and bursar-api solve the same problem with an explicit `runInOrgScope` transaction;
 * this service uses the transparent proxy so its many existing query call sites need no per-call
 * retrofit. Reserving fresh per request and re-binding the org before any query runs makes a
 * missed reset fail closed - the pool path returns zero rows under NOBYPASSRLS - rather than bleed
 * a prior org.)
 */
const rlsPlugin = requestRlsBinding({
  service: 'braid-api',
  enforce: env.BBB_RLS_ENFORCE === true,
  storage: rlsStorage,
  writeClient: queryClient,
  readClient,
  bindDb: (conn) => drizzle(conn, { schema }),
  resolveOrgId: (request) => request.user?.active_org_id ?? null,
});

export default rlsPlugin;
