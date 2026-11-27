import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { queryClient, rlsStorage, schema, type RlsStore } from '../db/index.js';
import { env } from '../env.js';
import { withReservedTransactions } from '../db/reserved-transactions.js';
// Type-only: brings the FastifyContextConfig.rlsOrgScope augmentation into scope.
import type {} from '../lib/rls-org-scope.js';

/**
 * Row-level security plugin (Wave 1.A, Platform G1; binding fix issue #87).
 *
 * RLS policies (0116_rls_foundation.sql) gate rows by `current_setting('app.current_org_id')`.
 * That GUC must be set on the SAME connection the request's queries run on. Because the DB
 * client is a connection pool, the previous implementation - a standalone
 * `SELECT set_config('app.current_org_id', <uuid>, true)` via the shared pool - never bound:
 * `is_local=true` scopes the value to the autocommit statement's own implicit transaction, which
 * commits immediately, and the request's real queries then execute on other pooled connections
 * with no org set. Under enforce mode that made every policy-gated query return zero rows.
 *
 * Modes (env `BBB_RLS_ENFORCE`):
 *   - unset/`0` (default, soft): the app role has BYPASSRLS, so policies are advisory and
 *     application-level `WHERE org_id = ...` filters do the real scoping. We do NOT set the GUC
 *     (it never bound and is unnecessary here) and we do NOT pin a connection, so throughput and
 *     behavior are exactly as before.
 *   - `1` (enforce): the boot hook flips the role to NOBYPASSRLS. For each request we reserve one
 *     connection, set the org GUC on it, and stash a drizzle instance bound to that reserved
 *     connection in AsyncLocalStorage so the global `db` proxy routes every query in the request
 *     onto it. The connection is released (and the GUC cleared) on response, error, or timeout.
 *     Note: enforce mode pins one pooled connection per in-flight request, so size the pool for
 *     peak concurrency when enabling it.
 */
const rlsPlugin = fp(async (fastify: FastifyInstance) => {
  const enforce = env.BBB_RLS_ENFORCE === true;

  if (!enforce) {
    fastify.log.info(
      { enforce: false },
      'rls plugin registered (advisory mode, BYPASSRLS; org GUC not bound - app-level filters enforce)',
    );
    return;
  }

  // Establish a mutable per-request store for the WHOLE request lifecycle. The callback-style
  // onRequest hook runs the rest of the request inside rlsStorage's async context, so the store
  // populated in preHandler is visible to the route handler and the release hooks below.
  fastify.addHook('onRequest', (_request, _reply, done) => {
    const store: RlsStore = { db: null, reserved: null };
    rlsStorage.run(store, done);
  });

  // Reserve a connection and bind the org GUC once the authenticated user is known.
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    // WebSocket upgrades never fire onResponse/onError/onTimeout, so a connection reserved here
    // would never be released - leaking one pooled connection per WS connect until the pool is
    // exhausted (issue #102). WS connections also must not hold a pooled connection for their whole
    // (potentially long-lived) lifetime. Skip the reserve for upgrades; WS handlers that need org
    // scope must bind it per-operation (the runInOrgScope transaction model) rather than rely on
    // this request-wide pin.
    if (request.headers.upgrade?.toLowerCase() === 'websocket') return;

    const store = rlsStorage.getStore();
    if (!store || store.reserved) return;

    // The org comes from the signed-in user. A request with no user (server-to-server and
    // webhook routes) binds the org its route declares through config.rlsOrgScope (#338,
    // lib/rls-org-scope.ts); with neither, nothing is bound and org-gated tables stay empty.
    let orgId: string | null = request.user?.active_org_id ?? null;
    if (!orgId && !request.user) {
      const resolve = request.routeOptions.config?.rlsOrgScope;
      if (resolve) {
        try {
          orgId = await resolve(request);
        } catch (err) {
          request.log.warn({ err }, 'rls: route org resolver failed; binding no org');
          orgId = null;
        }
      }
    }
    if (!orgId) return;

    const reserved = await queryClient.reserve();
    try {
      // Session-level (is_local=false) is correct here: the connection is exclusive to this
      // request and the GUC is cleared before it returns to the pool in `release`.
      await reserved`select set_config('app.current_org_id', ${orgId}, false)`;
    } catch (err) {
      reserved.release();
      throw err;
    }
    store.reserved = reserved;
    // drizzle's postgres-js driver reads and patches `client.options.parsers/serializers`, which
    // a ReservedSql does not carry, so drizzle(reserved) threw "Cannot read properties of
    // undefined (reading 'parsers')" and every enforce-mode request 500'd (found by the #105
    // DB-backed test). A reserved connection runs with its parent pool's options, which drizzle
    // already patched when the pool instance was created, so hand it those.
    // withReservedTransactions: a reserved connection has no begin()/savepoint(), so without it
    // every db.transaction in an org-bound request failed (#364).
    store.db = drizzle(Object.assign(withReservedTransactions(reserved), { options: queryClient.options }), { schema });
  });

  const release = async (): Promise<void> => {
    const store = rlsStorage.getStore();
    if (!store?.reserved) return;
    const reserved = store.reserved;
    store.reserved = null;
    store.db = null;
    try {
      // Reset the org to the nil-UUID sentinel (not '') before the connection returns to the pool.
      // A custom GUC cannot be truly unset to NULL - RESET and set_config(NULL) both leave '',
      // and ''::uuid throws 22P02 in the policies, so a later unreserved pool query on this
      // connection would 500 (issue #104). The nil UUID casts cleanly and matches no real org
      // (orgs use gen_random_uuid()), so a fallback query fails closed to zero rows instead.
      await reserved`select set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', false)`;
    } catch {
      // Best-effort; the connection is released regardless so the pool never leaks.
    }
    reserved.release();
  };

  fastify.addHook('onResponse', release);
  fastify.addHook('onError', release);
  fastify.addHook('onTimeout', release);

  fastify.log.info(
    { enforce: true },
    'rls plugin registered (NOBYPASSRLS enforce mode; per-request reserved connection binds app.current_org_id)',
  );
});

export default rlsPlugin;
