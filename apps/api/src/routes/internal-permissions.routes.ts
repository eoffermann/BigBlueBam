// Internal-only endpoint for the MCP server's Wave B dual-read.
//
// The MCP register-tool wrapper needs to call the new resolver after the
// agent_policies decision is known so divergences land in the same
// telemetry table the api uses. Rather than reimplement the resolver +
// context loader inside apps/mcp-server (which would mean duplicate
// caches, a duplicate Redis subscriber, and divergence in the resolver's
// behavior), the api exposes this single endpoint and MCP just POSTs.
//
// The endpoint is gated by the INTERNAL_SERVICE_SECRET / INTERNAL_HELPDESK_SECRET
// shared secrets so only trusted in-cluster services (mcp-server, worker,
// helpdesk-api) can call it.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  resolve as resolvePermission,
  type PermissionContext,
  type PermissionScope,
} from '@bigbluebam/permissions';
import { db } from '../db/index.js';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import {
  accountGroupMemberships,
  accountPermissions,
  agentPolicies,
  permissionGroupDefaults,
  users,
} from '../db/schema/index.js';
import { recordDivergence } from '../services/permissions-telemetry.service.js';
import { env } from '../env.js';

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function requireInternalAuth(request: FastifyRequest, reply: FastifyReply) {
  const secretHeader = request.headers['x-internal-secret'];
  const tokenHeader = request.headers['x-internal-token'];
  const provided =
    (Array.isArray(secretHeader) ? secretHeader[0] : secretHeader) ??
    (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader);
  if (!provided || typeof provided !== 'string') {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Missing internal service token' },
    });
  }
  const secrets = [env.INTERNAL_HELPDESK_SECRET];
  if (env.INTERNAL_SERVICE_SECRET) secrets.push(env.INTERNAL_SERVICE_SECRET);
  if (!secrets.some((s) => timingSafeStringEqual(provided, s))) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid internal service token' },
    });
  }
}

const dualReadBodySchema = z.object({
  user_id: z.string().uuid(),
  permission_id: z.string(),
  agent_policy_decision: z.enum(['allow', 'deny', 'unknown']).default('unknown'),
  scope: z
    .object({
      org_id: z.string().uuid().nullable().default(null),
      project_id: z.string().uuid().nullable().default(null),
    })
    .default({ org_id: null, project_id: null }),
  request_id: z.string().optional(),
  tool_name: z.string().optional(),
});

/**
 * Builds a PermissionContext for a given user_id by querying the same
 * tables apps/api/src/services/permissions.service.ts does, but bypasses
 * its request-bound cache (this endpoint is called by service accounts
 * that don't have a Fastify request scope). The api's main resolution
 * path stays unaffected.
 */
async function buildContextForUser(userId: string, scope: PermissionScope): Promise<PermissionContext | null> {
  const [user] = await db
    .select({
      id: users.id,
      is_superuser: users.is_superuser,
      kind: users.kind,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const orgId = scope.org_id ?? null;

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
        eq(accountGroupMemberships.user_id, userId),
        or(
          eq(accountGroupMemberships.scope_type, 'global'),
          and(
            eq(accountGroupMemberships.scope_type, 'org'),
            orgId
              ? eq(accountGroupMemberships.scope_id, orgId)
              : isNull(accountGroupMemberships.scope_id),
          ),
          eq(accountGroupMemberships.scope_type, 'project'),
        ),
      ),
    );

  const groupIds = memberships.map((m) => m.group_id);
  const defaults = groupIds.length
    ? await db
        .select({
          group_id: permissionGroupDefaults.group_id,
          permission_id: permissionGroupDefaults.permission_id,
          granted: permissionGroupDefaults.granted,
        })
        .from(permissionGroupDefaults)
        .where(inArray(permissionGroupDefaults.group_id, groupIds))
    : [];

  const overrides = await db
    .select({
      scope_type: accountPermissions.scope_type,
      scope_id: accountPermissions.scope_id,
      permission_id: accountPermissions.permission_id,
      granted: accountPermissions.granted,
      is_snapshot: accountPermissions.is_snapshot,
    })
    .from(accountPermissions)
    .where(eq(accountPermissions.user_id, userId));

  let agentPolicy: PermissionContext['agent_policy'];
  if (user.kind === 'agent' || user.kind === 'service') {
    const [policy] = await db
      .select({
        enabled: agentPolicies.enabled,
        allowed_tools: agentPolicies.allowed_tools,
      })
      .from(agentPolicies)
      .where(eq(agentPolicies.agent_user_id, userId))
      .limit(1);
    agentPolicy = policy
      ? { enabled: policy.enabled, allowed_tools: policy.allowed_tools }
      : { enabled: false, allowed_tools: [] };
  }

  const groupDefaults = new Map<string, boolean>();
  for (const d of defaults) {
    groupDefaults.set(`${d.group_id}:${d.permission_id}`, d.granted);
  }

  return {
    subject: {
      id: user.id,
      is_superuser: user.is_superuser,
      kind: user.kind as 'human' | 'agent' | 'service',
      api_key_scope: null,
    },
    memberships: memberships.map((m) => ({
      group_id: m.group_id,
      scope_type: m.scope_type as 'global' | 'org' | 'project',
      scope_id: m.scope_id,
      detached_at: m.detached_at?.toISOString() ?? null,
    })),
    account_overrides: overrides.map((o) => ({
      scope_type: o.scope_type as 'global' | 'org' | 'project',
      scope_id: o.scope_id,
      permission_id: o.permission_id,
      granted: o.granted,
      is_snapshot: o.is_snapshot,
    })),
    group_defaults: groupDefaults,
    agent_policy: agentPolicy,
  };
}

export default async function internalPermissionsRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/internal/permissions/dual-read',
    {
      preHandler: requireInternalAuth,
      config: { rateLimit: { max: 10000, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = dualReadBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid dual-read body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { user_id, permission_id, agent_policy_decision, scope, request_id, tool_name } =
        parsed.data;
      const ctx = await buildContextForUser(user_id, scope);
      if (!ctx) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'No such user_id' },
        });
      }

      const result = resolvePermission(ctx, permission_id, scope);

      // Fire-and-forget telemetry — failures don't block the response.
      void recordDivergence({
        request_id: request_id ?? request.id,
        user_id,
        org_id: scope.org_id ?? null,
        permission_id,
        scope_type: scope.project_id ? 'project' : scope.org_id ? 'org' : 'global',
        scope_id: scope.project_id ?? scope.org_id ?? null,
        legacy_decision: agent_policy_decision,
        resolved: result,
        route_method: 'MCP',
        route_path: tool_name ? `tool:${tool_name}` : null,
        logger: { warn: (obj, msg) => fastify.log.warn(obj, msg) },
      });

      return reply.send({
        data: {
          decision: result.decision,
          reason: result.reason,
          group_id: result.group_id,
        },
      });
    },
  );
}
