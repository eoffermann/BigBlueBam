// Real PermissionContext loader for the @bigbluebam/permissions resolver.
// Wave B replaces the stub from apps/api/src/plugins/permissions.ts; the
// resolver now has actual data to chew on. Decisions are still advisory
// in mode='warn' (the legacy gate is canonical until Wave C flips to 'on').

import { eq, and, isNull, or, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type {
  AccountGroupMembership,
  AccountPermissionRow,
  PermissionContext,
} from '@bigbluebam/permissions';
import { PermissionsCache, CACHE_KEYS, DEFAULT_TTL_SECONDS } from '@bigbluebam/permissions';

import { db } from '../db/index.js';
import {
  accountGroupMemberships,
  accountPermissions,
  agentPolicies,
  permissionGroupDefaults,
} from '../db/schema/index.js';

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: readonly string[]): Promise<void>;
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(channel: string, handler: (message: string) => void): Promise<void>;
}

/**
 * Module-level cache. The Redis client is wired in by
 * apps/api/src/plugins/permissions.ts after the redis plugin loads.
 * Falls back to an in-process Map when redis is unavailable.
 */
let cache: PermissionsCache | null = null;

export function bindPermissionsCache(redis: RedisLike | null, logger?: { warn: (obj: unknown, msg?: string) => void }) {
  cache = new PermissionsCache(redis, logger);
}

/**
 * Load (and cache) the PermissionContext for the current request.
 *
 * Schema queried in 3 small SELECTs (typically <2 ms total at scale):
 *   1. account_group_memberships joined to permission_groups (1 round-trip).
 *   2. permission_group_defaults for those group_ids (1 round-trip).
 *   3. account_permissions for (user, scope) (1 round-trip).
 * Plus, for service/agent users, agent_policies (1 round-trip).
 *
 * Cached at the (user_id, org_id) granularity for 5 minutes. Invalidation
 * fires from the Redis pubsub listener registered alongside the redis
 * plugin (perms:invalidate:user:{id} clears the user's entry).
 */
export async function loadPermissionContext(
  request: FastifyRequest,
): Promise<PermissionContext | null> {
  const user = (request as unknown as { user?: {
    id: string;
    is_superuser: boolean;
    kind: 'human' | 'agent' | 'service';
    api_key_scope: 'read' | 'read_write' | 'admin' | null;
    active_org_id?: string;
  } }).user;
  if (!user) return null;

  const orgId = user.active_org_id ?? '';
  const cacheKey = CACHE_KEYS.context(user.id, orgId || 'global');

  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as PermissionContextSerialized;
        return deserialize(parsed, user);
      } catch {
        // Fall through to refetch on parse error.
      }
    }
  }

  // 1. Memberships at every scope for this user. Filtered to global +
  //    current org + projects-in-current-org so we don't pull rows the
  //    resolver couldn't possibly use.
  const memberships = await db
    .select({
      group_id: accountGroupMemberships.group_id,
      scope_type: accountGroupMemberships.scope_type,
      scope_id: accountGroupMemberships.scope_id,
      detached_at: accountGroupMemberships.detached_at,
    })
    .from(accountGroupMemberships)
    .where(
      and(
        eq(accountGroupMemberships.user_id, user.id),
        or(
          eq(accountGroupMemberships.scope_type, 'global'),
          and(
            eq(accountGroupMemberships.scope_type, 'org'),
            orgId ? eq(accountGroupMemberships.scope_id, orgId) : isNull(accountGroupMemberships.scope_id),
          ),
          eq(accountGroupMemberships.scope_type, 'project'),
        ),
      ),
    );

  // 2. Defaults for every group the user is in.
  const groupIds = memberships.map((m) => m.group_id);
  const defaultRows = groupIds.length
    ? await db
        .select({
          group_id: permissionGroupDefaults.group_id,
          permission_id: permissionGroupDefaults.permission_id,
          granted: permissionGroupDefaults.granted,
        })
        .from(permissionGroupDefaults)
        .where(inArray(permissionGroupDefaults.group_id, groupIds))
    : [];

  // 3. Per-account overrides at every scope this user has a membership at.
  //    We fetch all overrides for the user; the resolver narrows by scope.
  const overrides = await db
    .select({
      scope_type: accountPermissions.scope_type,
      scope_id: accountPermissions.scope_id,
      permission_id: accountPermissions.permission_id,
      granted: accountPermissions.granted,
      is_snapshot: accountPermissions.is_snapshot,
    })
    .from(accountPermissions)
    .where(eq(accountPermissions.user_id, user.id));

  // 4. Agent policy for service/agent users.
  let agentPolicy: PermissionContext['agent_policy'] | undefined;
  if (user.kind === 'agent' || user.kind === 'service') {
    const [policy] = await db
      .select({
        enabled: agentPolicies.enabled,
        allowed_tools: agentPolicies.allowed_tools,
      })
      .from(agentPolicies)
      .where(eq(agentPolicies.agent_user_id, user.id))
      .limit(1);
    agentPolicy = policy ? { enabled: policy.enabled, allowed_tools: policy.allowed_tools } : { enabled: false, allowed_tools: [] };
  }

  const groupDefaults = new Map<string, boolean>();
  for (const d of defaultRows) {
    groupDefaults.set(`${d.group_id}:${d.permission_id}`, d.granted);
  }

  const ctx: PermissionContext = {
    subject: {
      id: user.id,
      is_superuser: user.is_superuser,
      kind: user.kind,
      api_key_scope: user.api_key_scope,
    },
    memberships: memberships.map((m): AccountGroupMembership => ({
      group_id: m.group_id,
      scope_type: m.scope_type as 'global' | 'org' | 'project',
      scope_id: m.scope_id,
      detached_at: m.detached_at?.toISOString() ?? null,
    })),
    account_overrides: overrides.map((o): AccountPermissionRow => ({
      scope_type: o.scope_type as 'global' | 'org' | 'project',
      scope_id: o.scope_id,
      permission_id: o.permission_id,
      granted: o.granted,
      is_snapshot: o.is_snapshot,
    })),
    group_defaults: groupDefaults,
    agent_policy: agentPolicy,
  };

  if (cache) {
    await cache.set(cacheKey, serialize(ctx), DEFAULT_TTL_SECONDS).catch(() => {});
  }

  return ctx;
}

/** Invalidation entry point — call after writing account_permissions /
 *  account_group_memberships / permission_group_defaults. */
export async function invalidatePermissionsForUser(userId: string, orgId?: string): Promise<void> {
  if (!cache) return;
  const keys: string[] = [CACHE_KEYS.context(userId, orgId ?? 'global')];
  await cache.del(keys).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────
// Serialization for Redis. Maps don't survive JSON.stringify cleanly.
// ─────────────────────────────────────────────────────────────────────
interface PermissionContextSerialized {
  memberships: AccountGroupMembership[];
  account_overrides: AccountPermissionRow[];
  group_defaults: [string, boolean][];
  agent_policy?: PermissionContext['agent_policy'];
}

function serialize(ctx: PermissionContext): string {
  const payload: PermissionContextSerialized = {
    memberships: [...ctx.memberships],
    account_overrides: [...ctx.account_overrides],
    group_defaults: Array.from(ctx.group_defaults.entries()),
    agent_policy: ctx.agent_policy,
  };
  return JSON.stringify(payload);
}

function deserialize(
  payload: PermissionContextSerialized,
  subject: { id: string; is_superuser: boolean; kind: 'human' | 'agent' | 'service'; api_key_scope: 'read' | 'read_write' | 'admin' | null },
): PermissionContext {
  return {
    subject: {
      id: subject.id,
      is_superuser: subject.is_superuser,
      kind: subject.kind,
      api_key_scope: subject.api_key_scope,
    },
    memberships: payload.memberships,
    account_overrides: payload.account_overrides,
    group_defaults: new Map(payload.group_defaults),
    agent_policy: payload.agent_policy,
  };
}
