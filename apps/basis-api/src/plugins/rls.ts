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
 * Row-level security plugin for basis-api (mirrors apps/api/src/plugins/rls.ts; binding fix #87).
 *
 * RLS policies (migrations 0226/0227) gate basis_* rows by `current_setting('app.current_org_id')`,
 * which must be set on the SAME connection the request's queries run on. The previous standalone
 * `set_config(..., true)` on the shared pool never bound (is_local scopes to the autocommit
 * statement's own transaction, which commits immediately), so under enforce mode every basis query
 * returned zero rows.
 *
 * Modes (env `BBB_RLS_ENFORCE`):
 *   - unset/`0` (default, soft): role has BYPASSRLS, policies advisory, app-level `WHERE org_id`
 *     filters enforce. We do not bind the GUC or pin a connection - behavior/throughput unchanged.
 *   - `1` (enforce): per request we reserve the write connection (and the read connection too, when
 *     a separate read replica is configured) and set the org GUC on it, then route the `db`/`readDb`
 *     proxies to drizzle instances bound to the reserved connection(s). Released on response, error,
 *     or timeout. Enforce mode pins a pooled connection per in-flight request; size the pool for
 *     peak concurrency when enabling it.
 */
const rlsPlugin = fp(async (fastify: FastifyInstance) => {
  const enforce = process.env.BBB_RLS_ENFORCE === '1';

  if (!enforce) {
    fastify.log.info(
      { enforce: false },
      'basis-api rls plugin registered (advisory mode, BYPASSRLS; org GUC not bound)',
    );
    return;
  }

  fastify.addHook('onRequest', (_request, _reply, done) => {
    const store: RlsStore = { db: null, readDb: null, reserved: null, readReserved: null };
    rlsStorage.run(store, done);
  });

  fastify.addHook('preHandler', async (request: FastifyRequest) => {
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
      // Read and write share one client: the single reserved connection serves both.
      store.readDb = store.db;
    } else {
      const readReserved = await readClient.reserve();
      try {
        await readReserved`select set_config('app.current_org_id', ${orgId}, false)`;
      } catch {
        readReserved.release();
        // Leave the write binding in place; readDb falls back to the pool for this request.
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
        await conn`select set_config('app.current_org_id', '', false)`;
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
    'basis-api rls plugin registered (NOBYPASSRLS enforce mode; per-request reserved connection binds app.current_org_id)',
  );
});

export default rlsPlugin;
