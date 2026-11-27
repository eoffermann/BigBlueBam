import type { FastifyRequest } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { requestRlsBinding } from '@bigbluebam/rls-connection';
import { queryClient, rlsStorage, schema } from '../db/index.js';
import { env } from '../env.js';
// Type-only: brings the FastifyContextConfig.rlsOrgScope augmentation into scope.
import type {} from '../lib/rls-org-scope.js';

/**
 * Row-level security plugin (Wave 1.A, Platform G1; binding fix issue #87; transactions #364/#365).
 *
 * RLS policies (0116_rls_foundation.sql) gate rows by `current_setting('app.current_org_id')`.
 * That GUC must be set on the SAME connection the request's queries run on; a standalone
 * set_config on the pool binds nothing. Under BBB_RLS_ENFORCE=1 each request reserves one
 * connection with the org bound and the global `db` proxy routes every query in the request onto
 * it; it is released (and the GUC reset) on response, error, or timeout. Enforce mode pins one
 * pooled connection per in-flight request, so size the pool for peak concurrency when enabling it.
 * The reserve/bind/transaction/release mechanics live once in @bigbluebam/rls-connection
 * (requestRlsBinding), shared with basis-api, braid-api and bulwark-api.
 *
 * Under the advisory default the role has BYPASSRLS, app-level `WHERE org_id = ...` filters do the
 * real scoping, and nothing is reserved.
 */

/**
 * The org comes from the signed-in user. A request with no user (server-to-server and webhook
 * routes) binds the org its route declares through config.rlsOrgScope (#338,
 * lib/rls-org-scope.ts); with neither, nothing is bound and org-gated tables stay empty.
 */
async function resolveOrgId(request: FastifyRequest): Promise<string | null> {
  if (request.user) return request.user.active_org_id ?? null;
  const resolve = request.routeOptions.config?.rlsOrgScope;
  if (!resolve) return null;
  try {
    return await resolve(request);
  } catch (err) {
    request.log.warn({ err }, 'rls: route org resolver failed; binding no org');
    return null;
  }
}

const rlsPlugin = requestRlsBinding({
  service: 'api',
  enforce: env.BBB_RLS_ENFORCE === true,
  storage: rlsStorage,
  writeClient: queryClient,
  bindDb: (conn) => drizzle(conn, { schema }),
  resolveOrgId,
});

export default rlsPlugin;
