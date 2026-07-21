import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  queryClient,
  readClient,
  readSharesWriteClient,
  rlsStorage,
  schema,
  type RlsStore,
} from '../db/index.js';

/**
 * Row-level security plugin for bulwark-api (binding fix issue #87).
 *
 * RLS policies (migrations 0234/0235) gate bulwark_* rows by `current_setting('app.current_org_id')`,
 * which must be set on the SAME connection the request's queries run on. The previous standalone
 * `set_config(..., true)` on the shared pool never bound (is_local scopes to the autocommit
 * statement's own transaction, which commits immediately), so under enforce mode every bulwark
 * query returned zero rows.
 *
 * Modes (env `BBB_RLS_ENFORCE`):
 *   - unset/`0` (default, soft): role has BYPASSRLS, policies advisory, app-level `WHERE org_id`
 *     filters enforce. We do not bind the GUC or pin a connection - behavior/throughput unchanged.
 *   - `1` (enforce): per request we reserve the write connection (and the read connection too, when
 *     a separate read replica is configured) and set the org GUC on it, then route the `db`/`readDb`
 *     proxies to drizzle instances bound to the reserved connection(s). Released on response, error,
 *     or timeout. Enforce mode pins a pooled connection per in-flight request; size the pool for
 *     peak concurrency when enabling it.
 *
 * (burn-api and bursar-api solve the same problem with an explicit `runInOrgScope` transaction;
 * the legacy services here use this transparent proxy so their many existing query call sites need
 * no per-call retrofit. Reserving fresh per request and re-binding the org before any query runs
 * makes a missed reset fail closed - the pool path returns zero rows under NOBYPASSRLS - rather than
 * bleed a prior org.)
 */
const rlsPlugin = fp(async (fastify: FastifyInstance) => {
  const enforce = process.env.BBB_RLS_ENFORCE === '1';

  if (!enforce) {
    fastify.log.info(
      { enforce: false },
      'bulwark-api rls plugin registered (advisory mode, BYPASSRLS; org GUC not bound)',
    );
    return;
  }

  fastify.addHook('onRequest', (_request, _reply, done) => {
    const store: RlsStore = { db: null, readDb: null, reserved: null, readReserved: null };
    rlsStorage.run(store, done);
  });

  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    // WebSocket upgrades never fire onResponse/onError/onTimeout, so a connection reserved here
    // would never be released - leaking one pooled connection per WS connect until the pool is
    // exhausted (issue #102). Skip the reserve for upgrades; WS handlers that need org scope must
    // bind it per-operation (the runInOrgScope transaction model) rather than rely on this pin.
    if (request.headers.upgrade?.toLowerCase() === 'websocket') return;

    const user = request.user;
    if (!user?.active_org_id) return;
    const store = rlsStorage.getStore();
    if (!store || store.reserved) return;

    const orgId = user.active_org_id;
    const reserved = await queryClient.reserve();
    try {
      await reserved`select set_config('app.current_org_id', ${orgId}, false)`;
    } catch (err) {
      reserved.release();
      throw err;
    }
    store.reserved = reserved;
    store.db = drizzle(reserved, { schema });

    if (readSharesWriteClient) {
      store.readDb = store.db;
    } else {
      const readReserved = await readClient.reserve();
      try {
        await readReserved`select set_config('app.current_org_id', ${orgId}, false)`;
      } catch {
        readReserved.release();
        // Degrade reads to the (already org-bound) write connection rather than leaving readDb on
        // an unbound pool connection that would return empty results as success (issue #106).
        store.readDb = store.db;
        return;
      }
      store.readReserved = readReserved;
      store.readDb = drizzle(readReserved, { schema });
    }
  });

  const release = async (): Promise<void> => {
    const store = rlsStorage.getStore();
    if (!store) return;
    const { reserved, readReserved } = store;
    store.reserved = null;
    store.readReserved = null;
    store.db = null;
    store.readDb = null;
    for (const conn of [reserved, readReserved]) {
      if (!conn) continue;
      try {
        // Nil-UUID sentinel, not '': a custom GUC cannot be unset to NULL (RESET/set_config(NULL)
        // both leave ''), and ''::uuid throws 22P02 in the policies, so a later unreserved pool
        // query on this connection would 500 (issue #104). The nil UUID casts cleanly and matches
        // no real org, so a fallback query fails closed to zero rows instead.
        await conn`select set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', false)`;
      } catch {
        // Best-effort; release regardless so the pool never leaks.
      }
      conn.release();
    }
  };

  fastify.addHook('onResponse', release);
  fastify.addHook('onError', release);
  fastify.addHook('onTimeout', release);

  fastify.log.info(
    { enforce: true },
    'bulwark-api rls plugin registered (NOBYPASSRLS enforce mode; per-request reserved connection binds app.current_org_id)',
  );
});

export default rlsPlugin;
