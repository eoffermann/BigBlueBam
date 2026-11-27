import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { releaseOrgConnection, reserveOrgConnection } from './org-connection.js';

/**
 * The per-request store a service keeps in AsyncLocalStorage. Its global `db` (and `readDb`)
 * proxies route to these instances while they are set. `readDb`/`readReserved` exist only for a
 * service that passes `readClient`.
 */
export interface RequestRlsStore<D> {
  db: D | null;
  reserved: postgres.ReservedSql | null;
  readDb?: D | null;
  readReserved?: postgres.ReservedSql | null;
}

/** The two AsyncLocalStorage methods the binding uses (structural, so no node typings needed). */
export interface RlsStorage<S> {
  run<R>(store: S, callback: () => R): R;
  getStore(): S | undefined;
}

export interface RequestRlsBindingOptions<S extends RequestRlsStore<unknown>> {
  /** Service name, for the registration log line. */
  service: string;
  /** env.BBB_RLS_ENFORCE === true. When false nothing is reserved and no hook is added. */
  enforce: boolean;
  storage: RlsStorage<S>;
  /** The write pool. */
  writeClient: postgres.Sql;
  /**
   * The read pool, for a service with a `readDb` proxy. Omit it when the service has none. When it
   * is the same client as `writeClient` the one reserved connection serves both.
   */
  readClient?: postgres.Sql;
  /**
   * Build the service's drizzle instance on a reserved connection, for example
   * `(conn) => drizzle(conn, { schema })`. The connection it receives already carries the org GUC,
   * transaction support and the pool's options.
   */
  bindDb: (conn: postgres.Sql) => NonNullable<S['db']>;
  /** The org to bind for this request, or null to bind none (org-gated tables then stay empty). */
  resolveOrgId: (request: FastifyRequest) => string | null | Promise<string | null>;
}

/**
 * Row-level security request binding (#87), shared by every service whose policies read
 * current_setting('app.current_org_id') through a transparent `db` proxy (#365).
 *
 * The GUC must be set on the SAME connection the request's queries run on; with a pool, a
 * standalone set_config(..., true) commits with its own statement and binds nothing. So:
 *   - enforce off (default): the role has BYPASSRLS, app-level `WHERE org_id` filters scope rows,
 *     and nothing is reserved. Throughput and behavior are unchanged.
 *   - enforce on: per request, once the org is known, reserve one write connection (and one read
 *     connection when a separate read replica is configured) with the org bound, and set the store
 *     so the service's proxies route onto them. Released on response, error, or timeout. This pins
 *     one pooled connection per in-flight request; size the pool for peak concurrency.
 *
 * WebSocket upgrades never fire onResponse/onError/onTimeout, so a connection reserved for one
 * would never be released (issue #102). Upgrades are skipped; WS handlers bind org scope
 * per operation instead.
 */
export function requestRlsBinding<S extends RequestRlsStore<unknown>>(
  opts: RequestRlsBindingOptions<S>,
): FastifyPluginAsync {
  const { service, enforce, storage, writeClient, readClient, bindDb, resolveOrgId } = opts;
  const hasRead = readClient !== undefined;

  return fp(async (fastify: FastifyInstance) => {
    if (!enforce) {
      fastify.log.info(
        { enforce: false },
        `${service} rls plugin registered (advisory mode, BYPASSRLS; org GUC not bound - app-level filters enforce)`,
      );
      return;
    }

    // A mutable store for the WHOLE request lifecycle. The callback-style onRequest hook runs the
    // rest of the request inside storage's async context, so the store populated in preHandler is
    // visible to the route handler and to the release hooks.
    fastify.addHook('onRequest', (_request, _reply, done) => {
      const store = (hasRead
        ? { db: null, reserved: null, readDb: null, readReserved: null }
        : { db: null, reserved: null }) as S;
      storage.run(store, done);
    });

    fastify.addHook('preHandler', async (request: FastifyRequest) => {
      if (request.headers.upgrade?.toLowerCase() === 'websocket') return;
      // Widened view: the store's db type is the service's own; here it is only moved around.
      const store = storage.getStore() as RequestRlsStore<unknown> | undefined;
      if (!store || store.reserved) return;

      const orgId = await resolveOrgId(request);
      if (!orgId) return;

      const reserved = await reserveOrgConnection(writeClient, orgId);
      store.reserved = reserved;
      store.db = bindDb(reserved);
      if (!hasRead) return;

      if (readClient === writeClient) {
        store.readDb = store.db;
        return;
      }
      try {
        const readReserved = await reserveOrgConnection(readClient, orgId);
        store.readReserved = readReserved;
        store.readDb = bindDb(readReserved);
      } catch (err) {
        // Degrade reads to the (already org-bound) write connection rather than leaving readDb on
        // an unbound pool connection that would return empty results as success (issue #106).
        request.log.warn({ err }, `${service} rls: read connection bind failed; reads use the write connection`);
        store.readDb = store.db;
      }
    });

    const release = async (): Promise<void> => {
      const store = storage.getStore() as RequestRlsStore<unknown> | undefined;
      if (!store) return;
      const { reserved, readReserved } = store;
      store.reserved = null;
      store.db = null;
      if (hasRead) {
        store.readReserved = null;
        store.readDb = null;
      }
      for (const conn of [reserved, readReserved]) {
        if (conn) await releaseOrgConnection(conn);
      }
    };

    fastify.addHook('onResponse', release);
    fastify.addHook('onError', release);
    fastify.addHook('onTimeout', release);

    fastify.log.info(
      { enforce: true },
      `${service} rls plugin registered (NOBYPASSRLS enforce mode; per-request reserved connection binds app.current_org_id)`,
    );
  });
}
