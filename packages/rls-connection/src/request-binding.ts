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
  /**
   * How long a request waits to reserve and bind a read-replica connection before it gives up and
   * reads on the write connection (#377). Default 500 ms, far below the pools' 10 s connect_timeout.
   */
  readReserveTimeoutMs?: number;
  /**
   * After a read bind fails or times out, the replica is skipped for this long (reads go to the
   * write connection) before one request probes it again (#377). Default 30 s.
   */
  readBreakerCooldownMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export const DEFAULT_READ_RESERVE_TIMEOUT_MS = 500;
export const DEFAULT_READ_BREAKER_COOLDOWN_MS = 30_000;

class ReadReserveTimeout extends Error {
  constructor(ms: number) {
    super(`read connection reserve timed out after ${ms} ms`);
    this.name = 'ReadReserveTimeout';
  }
}

/**
 * Reserve and bind a read connection, but give up after `ms`. A reserve that completes after the
 * deadline is released straight back to its pool, so a slow replica never leaks connections.
 */
async function reserveWithin(
  pool: postgres.Sql,
  orgId: string,
  ms: number,
): Promise<postgres.ReservedSql> {
  const pending = reserveOrgConnection(pool, orgId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadReserveTimeout(ms)), ms);
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (err) {
    if (err instanceof ReadReserveTimeout) {
      pending.then(
        (late) => releaseOrgConnection(late),
        () => undefined,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const separateRead = hasRead && readClient !== writeClient;
  const readTimeoutMs = opts.readReserveTimeoutMs ?? DEFAULT_READ_RESERVE_TIMEOUT_MS;
  const cooldownMs = opts.readBreakerCooldownMs ?? DEFAULT_READ_BREAKER_COOLDOWN_MS;
  const now = opts.now ?? Date.now;

  // Read-replica circuit breaker (#377), process-wide for this service. Closed (0): every request
  // tries the replica. Open (now < openUntil): reads go straight to the write connection. After
  // the cooldown, exactly one request probes; success closes it, failure re-opens it.
  let breakerOpenUntil = 0;
  let probing = false;

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

      // The replica first, under a short budget, so a slow or dead replica never holds one of the
      // write pool's connections while it times out (#377).
      let readReserved: postgres.ReservedSql | null = null;
      if (separateRead && readClient) {
        const open = breakerOpenUntil !== 0;
        const skip = open && (now() < breakerOpenUntil || probing);
        if (!skip) {
          if (open) probing = true;
          try {
            readReserved = await reserveWithin(readClient, orgId, readTimeoutMs);
            if (open) {
              breakerOpenUntil = 0;
              fastify.log.info(`${service} rls: read replica reachable again; read circuit closed`);
            }
          } catch (err) {
            breakerOpenUntil = now() + cooldownMs;
            if (open) {
              request.log.warn({ err }, `${service} rls: read replica probe failed; read circuit stays open`);
            } else {
              fastify.log.warn(
                { err, cooldownMs },
                `${service} rls: read connection bind failed; read circuit open, reads use the write connection`,
              );
            }
          } finally {
            if (open) probing = false;
          }
        }
      }

      let reserved: postgres.ReservedSql;
      try {
        reserved = await reserveOrgConnection(writeClient, orgId);
      } catch (err) {
        if (readReserved) await releaseOrgConnection(readReserved);
        throw err;
      }
      store.reserved = reserved;
      store.db = bindDb(reserved);
      if (!hasRead) return;

      if (readReserved) {
        store.readReserved = readReserved;
        store.readDb = bindDb(readReserved);
      } else {
        // Same client, or the replica is unavailable: reads use the (already org-bound) write
        // connection rather than an unbound pool connection that would return empty results as
        // success (issue #106).
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
