import { drizzle } from 'drizzle-orm/postgres-js';
import { requestRlsBinding } from '@bigbluebam/rls-connection';
import { queryClient, readClient, rlsStorage, schema } from '../db/index.js';
import { env } from '../env.js';

/**
 * Row-level security plugin for basis-api (binding fix #87; transactions #365).
 *
 * RLS policies (migrations 0226/0227) gate basis_* rows by `current_setting('app.current_org_id')`.
 * Under BBB_RLS_ENFORCE=1 each request reserves the write connection (and the read connection
 * when a separate read replica is configured) with the signed-in user's org bound, and the
 * `db`/`readDb` proxies route onto them. The reserve/bind/transaction/release mechanics live once
 * in @bigbluebam/rls-connection (requestRlsBinding); see it for the modes and their trade-offs.
 */
const rlsPlugin = requestRlsBinding({
  service: 'basis-api',
  enforce: env.BBB_RLS_ENFORCE === true,
  storage: rlsStorage,
  writeClient: queryClient,
  readClient,
  bindDb: (conn) => drizzle(conn, { schema }),
  resolveOrgId: (request) => request.user?.active_org_id ?? null,
});

export default rlsPlugin;
