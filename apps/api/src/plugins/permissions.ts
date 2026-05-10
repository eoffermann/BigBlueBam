// Permissions plugin wiring.
//
// Wave A (off):  plugin loads, requireCan no-ops to ALLOW. Behavior unchanged.
// Wave B (warn): real contextLoader fetches PermissionContext from postgres,
//                resolver runs alongside the legacy gate on annotated routes,
//                divergences land in permissions_divergence_log.
// Wave C (on):   resolver is canonical, legacy gates retired.

import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionsPlugin } from '@bigbluebam/permissions';
import type { PermissionScope } from '@bigbluebam/permissions';
import { env } from '../env.js';
import {
  bindPermissionsCache,
  invalidatePermissionsForUser,
  loadPermissionContext,
} from '../services/permissions.service.js';
import { recordDivergence } from '../services/permissions-telemetry.service.js';

/**
 * scopeLoader: pull project_id out of the request when it's available.
 * Routes that follow the standard Fastify param shape (`:projectId` or
 * `:project_id`) get auto-detected; legacy routes that derive the project
 * from a different param can override via request.permissionScopeOverride.
 */
function loadScopeFromRequest(request: FastifyRequest): PermissionScope {
  const user = (request as unknown as { user?: { active_org_id?: string } }).user;
  const params = (request as unknown as { params?: Record<string, string> }).params ?? {};
  const overrideRaw = (request as unknown as { permissionScopeOverride?: PermissionScope }).permissionScopeOverride;
  if (overrideRaw) return overrideRaw;

  const projectId =
    params['projectId'] ??
    params['project_id'] ??
    params['projId'] ??
    null;

  return {
    org_id: user?.active_org_id ?? null,
    project_id: projectId,
  };
}

export const permissionsApiPlugin = fp(
  async (fastify: FastifyInstance) => {
    // Bind the cache to the running Redis client. The redis plugin runs
    // before this one, so fastify.redis is already available. Falls back
    // to in-process Map when redis is unreachable.
    const redisClient = (fastify as unknown as { redis?: unknown }).redis;
    bindPermissionsCache(buildRedisAdapter(redisClient), {
      warn: (obj, msg) => fastify.log.warn(obj, msg),
    });

    await fastify.register(permissionsPlugin, {
      mode: env.BBB_PERMISSIONS_ENFORCE,
      contextLoader: loadPermissionContext,
      scopeLoader: loadScopeFromRequest,
      reportDivergence: ({ permission_id, request, legacy, resolved }) => {
        const user = (request as unknown as { user?: { id: string; active_org_id?: string } }).user;
        const scope = loadScopeFromRequest(request);
        // Fire-and-forget; failures swallowed inside recordDivergence.
        void recordDivergence({
          request_id: request.id,
          user_id: user?.id ?? null,
          org_id: user?.active_org_id ?? null,
          permission_id,
          scope_type: scope.project_id ? 'project' : scope.org_id ? 'org' : 'global',
          scope_id: scope.project_id ?? scope.org_id ?? null,
          legacy_decision: legacy ?? 'unknown',
          resolved,
          route_method: request.method,
          route_path: (request.routeOptions as unknown as { url?: string })?.url ?? request.url,
          logger: fastify.log,
        });
      },
    });
    // Wave B follow-up: subscribe to Redis pubsub for cache invalidation.
    // The cache lives behind a per-user/org key and TTLs at 5 minutes; the
    // subscriber lets a write on one replica push invalidation to every
    // other replica's cache so a permission edit takes effect within
    // milliseconds instead of waiting for TTL. Mirrors the agent_policies
    // pattern in apps/mcp-server/src/server.ts:130.
    //
    // Channels (defined in @bigbluebam/permissions::INVALIDATION_CHANNELS):
    //   perms:invalidate:user:<userId>  — clear one user's cached context
    //   perms:invalidate:org:<orgId>    — clear every cached context in an org
    //   perms:invalidate:group:<groupId> — clear every member of one group
    //
    // The pattern subscription `perms:invalidate:*` covers all three.
    let permsSubscriber: Redis | null = null;
    try {
      permsSubscriber = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      await permsSubscriber.connect();
      await permsSubscriber.psubscribe('perms:invalidate:*');
      permsSubscriber.on('pmessage', async (_pattern: string, channel: string, message: string) => {
        // channel form: perms:invalidate:{kind}:{id}
        const parts = channel.split(':');
        const kind = parts[2];
        const id = parts[3];
        if (!kind || !id) return;
        try {
          if (kind === 'user') {
            await invalidatePermissionsForUser(id, message || undefined);
          } else if (kind === 'org' || kind === 'group') {
            // Org / group invalidations require enumerating affected
            // user keys. Wave D's editor publishes a per-user message
            // alongside, so we keep this listener simple and let the
            // writer fan out. If a writer publishes only the org/group
            // form, we fall back to letting the 5-min TTL clean up.
            fastify.log.info(
              { kind, id },
              'perms-invalidate: org/group event observed (TTL fallback)',
            );
          }
        } catch (err) {
          fastify.log.warn(
            { err, channel },
            'perms-invalidate: handler failed; relying on TTL',
          );
        }
      });
      fastify.log.info('Subscribed to perms:invalidate:*');
    } catch (err) {
      fastify.log.warn(
        { err },
        'perms:invalidate subscription unavailable; falling back to TTL-only cache',
      );
      permsSubscriber = null;
    }

    fastify.addHook('onClose', async () => {
      if (permsSubscriber) {
        try {
          await permsSubscriber.quit();
        } catch {
          // shutdown best-effort
        }
      }
    });

    fastify.log.info(
      { mode: env.BBB_PERMISSIONS_ENFORCE },
      'permissions plugin registered',
    );
  },
  { name: 'permissions-api' },
);

// ─────────────────────────────────────────────────────────────────────
// Redis adapter
// ─────────────────────────────────────────────────────────────────────
//
// The @bigbluebam/permissions cache expects a small CacheClient interface;
// ioredis exposes a slightly larger surface. Adapt at the boundary so the
// package stays redis-implementation-agnostic.

interface IORedisLike {
  get(key: string): Promise<string | null>;
  setex?(key: string, ttl: number, value: string): Promise<unknown>;
  set?(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  publish?(channel: string, message: string): Promise<number>;
  subscribe?(channel: string): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

function buildRedisAdapter(redis: unknown) {
  if (!redis) return null;
  const client = redis as IORedisLike;
  return {
    async get(key: string) {
      return client.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number) {
      if (client.setex) {
        await client.setex(key, ttlSeconds, value);
      } else if (client.set) {
        await client.set(key, value, 'EX', ttlSeconds);
      }
    },
    async del(keys: readonly string[]) {
      if (keys.length === 0) return;
      await client.del(...keys);
    },
    async publish(channel: string, message: string) {
      await client.publish?.(channel, message);
    },
  };
}
