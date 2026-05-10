// Permissions plugin wiring.
//
// Wave A (off):  plugin loads, requireCan no-ops to ALLOW. Behavior unchanged.
// Wave B (warn): real contextLoader fetches PermissionContext from postgres,
//                resolver runs alongside the legacy gate on annotated routes,
//                divergences land in permissions_divergence_log.
// Wave C (on):   resolver is canonical, legacy gates retired.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionsPlugin } from '@bigbluebam/permissions';
import type { PermissionScope } from '@bigbluebam/permissions';
import { env } from '../env.js';
import { bindPermissionsCache, loadPermissionContext } from '../services/permissions.service.js';
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
