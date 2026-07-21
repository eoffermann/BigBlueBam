import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { queryClient, rlsStorage, schema, type RlsStore } from '../db/index.js';

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
  const enforce = process.env.BBB_RLS_ENFORCE === '1';

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
    const user = request.user;
    if (!user?.active_org_id) return;
    const store = rlsStorage.getStore();
    if (!store || store.reserved) return;

    const reserved = await queryClient.reserve();
    try {
      // Session-level (is_local=false) is correct here: the connection is exclusive to this
      // request and the GUC is cleared before it returns to the pool in `release`.
      await reserved`select set_config('app.current_org_id', ${user.active_org_id}, false)`;
    } catch (err) {
      reserved.release();
      throw err;
    }
    store.reserved = reserved;
    store.db = drizzle(reserved, { schema });
  });

  const release = async (): Promise<void> => {
    const store = rlsStorage.getStore();
    if (!store?.reserved) return;
    const reserved = store.reserved;
    store.reserved = null;
    store.db = null;
    try {
      // Clear the org before the connection returns to the pool so a later reuse cannot inherit it.
      await reserved`select set_config('app.current_org_id', '', false)`;
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
