import type { FastifyInstance } from 'fastify';
import { eq, and, inArray, isNull, desc } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { agentPolicies } from '../db/schema/agent-policies.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { requireAuth } from '../plugins/auth.js';
import { getOrgPermissions, isOrgPrivileged } from '../services/org-permissions.js';
import { setUserOrgRole } from '../services/role-resolver.js';
import * as orgService from '../services/org.service.js';
import { shadowOnly } from '../middleware/dual-read.js';

const DEFAULT_ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function getRotationGraceMs(): number {
  const raw = process.env.API_KEY_ROTATION_GRACE_MS;
  if (!raw) return DEFAULT_ROTATION_GRACE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROTATION_GRACE_MS;
}

/**
 * Service-account REST routes.
 *
 *   GET    /auth/service-accounts                  (list caller-visible service accounts)
 *   POST   /auth/service-accounts                  (mint a new one + return key ONCE)
 *   DELETE /auth/service-accounts/:id              (soft-disable: user + policy + key)
 *
 * Delegation model: the same gate that governs POST /auth/api-keys governs
 * this route. A caller that can mint themselves a `bbam_` key with scope X
 * can mint a `bbam_svc_` key with scope X attached to a locked service-
 * account user they "own" (created_by = caller). Admin-scope agents still
 * require org owner or SuperUser, session callers capped at their role,
 * api-key callers capped at their own api_key_scope, members gated by
 * org-level members_can_create_api_keys + allowed_api_key_scopes.
 *
 * Tools: the agent's allowed_tools is freeform and stored as-is. Runtime
 * enforcement happens at tool-call time (the tool's own role/scope gate),
 * so a viewer-created agent with ['*'] simply gets 403 on tools the viewer
 * couldn't have called themselves. The UI field is advisory.
 */

const SCOPE_HIERARCHY = ['read', 'read_write', 'admin'] as const;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scope: z.enum(['read', 'read_write', 'admin']).default('read_write'),
  allowed_tools: z.array(z.string().min(1).max(200)).max(512).optional(),
  project_ids: z.array(z.string().uuid()).max(100).optional(),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export default async function serviceAccountRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // GET /auth/service-accounts
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/auth/service-accounts',
    { preHandler: [requireAuth, shadowOnly('bam.auth_service_account.list')] },
    async (request, reply) => {
      const caller = request.user!;
      const orgId = caller.active_org_id;
      const canSeeAll = caller.is_superuser || isOrgPrivileged(caller.role);

      // Base rows: all service-kind users in the active org.
      const rows = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          email: users.email,
          created_at: users.created_at,
          created_by: users.created_by,
          disabled_at: users.disabled_at,
        })
        .from(users)
        .where(
          and(
            eq(users.org_id, orgId),
            eq(users.kind, 'service'),
            canSeeAll ? undefined : eq(users.created_by, caller.id),
          ),
        );

      if (rows.length === 0) {
        return reply.send({ data: [] });
      }

      const userIds = rows.map((r) => r.id);

      const keyRows = await db
        .select({
          user_id: apiKeys.user_id,
          id: apiKeys.id,
          name: apiKeys.name,
          key_prefix: apiKeys.key_prefix,
          scope: apiKeys.scope,
          project_ids: apiKeys.project_ids,
          created_at: apiKeys.created_at,
          last_used_at: apiKeys.last_used_at,
          rotated_at: apiKeys.rotated_at,
        })
        .from(apiKeys)
        .where(inArray(apiKeys.user_id, userIds));

      const policyRows = await db
        .select({
          agent_user_id: agentPolicies.agent_user_id,
          enabled: agentPolicies.enabled,
          allowed_tools: agentPolicies.allowed_tools,
        })
        .from(agentPolicies)
        .where(inArray(agentPolicies.agent_user_id, userIds));

      // Creator display names, one query for the creator_ids we actually need.
      const creatorIds = Array.from(
        new Set(rows.map((r) => r.created_by).filter((v): v is string => v !== null)),
      );
      const creators = creatorIds.length
        ? await db
            .select({ id: users.id, display_name: users.display_name })
            .from(users)
            .where(inArray(users.id, creatorIds))
        : [];
      const creatorMap = new Map(creators.map((c) => [c.id, c.display_name]));

      const data = rows.map((r) => {
        const keys = keyRows.filter((k) => k.user_id === r.id);
        const activeKey = keys.find((k) => k.rotated_at === null) ?? keys[0];
        const policy = policyRows.find((p) => p.agent_user_id === r.id);
        return {
          id: r.id,
          name: r.display_name,
          email: r.email,
          created_at: r.created_at,
          disabled_at: r.disabled_at,
          created_by: r.created_by
            ? { id: r.created_by, display_name: creatorMap.get(r.created_by) ?? null }
            : null,
          policy: policy
            ? {
                enabled: policy.enabled,
                allowed_tool_count: (policy.allowed_tools as string[]).length,
              }
            : null,
          api_key: activeKey
            ? {
                id: activeKey.id,
                name: activeKey.name,
                key_hint: `${activeKey.key_prefix}...`,
                scope: activeKey.scope,
                project_ids: activeKey.project_ids,
                last_used_at: activeKey.last_used_at,
                rotated_at: activeKey.rotated_at,
              }
            : null,
        };
      });

      return reply.send({ data });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /auth/service-accounts
  // ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/auth/service-accounts',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_service_account.create')] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid service-account create payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const body = parsed.data;
      const caller = request.user!;

      // Delegation gates — mirror api-key.routes.ts.
      if (body.scope === 'admin' && !caller.is_superuser && caller.role !== 'owner') {
        return reply.status(403).send({
          error: {
            code: 'ADMIN_SCOPE_OWNER_ONLY',
            message: 'Admin-scope service accounts can only be created by an organization owner.',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (caller.api_key_scope !== null) {
        const callerLevel = SCOPE_HIERARCHY.indexOf(
          caller.api_key_scope as (typeof SCOPE_HIERARCHY)[number],
        );
        const requestedLevel = SCOPE_HIERARCHY.indexOf(body.scope);
        if (callerLevel < 0 || requestedLevel > callerLevel) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Cannot create service account with '${body.scope}' scope — your API key only has '${caller.api_key_scope}' scope.`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      if (!caller.is_superuser && !isOrgPrivileged(caller.role)) {
        const org = await orgService.getOrganizationCached(fastify.redis, caller.active_org_id);
        const perms = getOrgPermissions(org?.settings as Record<string, unknown> | null);
        if (!perms.members_can_create_api_keys) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to create API keys or service accounts.',
              details: [],
              request_id: request.id,
            },
          });
        }
        const allowed = perms.allowed_api_key_scopes || ['read', 'read_write'];
        if (!allowed.includes(body.scope)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Scope '${body.scope}' is not allowed for your role in this organization.`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // Build a deterministic-ish email so the UI can show who each account
      // is (svc+<slug>-<org-id-prefix>@system.local). A short random suffix
      // prevents name collisions inside the same org.
      const safeSlug = slugify(body.name) || 'agent';
      const orgPrefix = caller.active_org_id.slice(0, 8);
      const rand = randomBytes(3).toString('hex');
      const email = `svc+${safeSlug}-${orgPrefix}-${rand}@system.local`;

      const lockedPassword = randomBytes(32).toString('base64url');
      const passwordHash = await argon2.hash(lockedPassword);

      const randomToken = randomBytes(32).toString('base64url');
      const fullToken = `bbam_svc_${randomToken}`;
      const prefix = fullToken.slice(0, 8);
      const keyHash = await argon2.hash(fullToken);

      const result = await db.transaction(async (tx) => {
        const [svc] = await tx
          .insert(users)
          .values({
            org_id: caller.active_org_id,
            email,
            display_name: body.name,
            password_hash: passwordHash,
            is_superuser: false,
            kind: 'service',
            created_by: caller.id,
          })
          .returning();

        await tx.insert(organizationMemberships).values({
          user_id: svc!.id,
          org_id: caller.active_org_id,
          is_default: true,
        });
        // Wave E.F: role lives in account_group_memberships.
        await setUserOrgRole(svc!.id, caller.active_org_id, 'member', { grantedBy: caller.id }, tx);

        await tx.insert(agentPolicies).values({
          agent_user_id: svc!.id,
          org_id: caller.active_org_id,
          enabled: true,
          allowed_tools: body.allowed_tools ?? ['*'],
          channel_subscriptions: [],
          updated_by: caller.id,
        });

        const [key] = await tx
          .insert(apiKeys)
          .values({
            user_id: svc!.id,
            org_id: caller.active_org_id,
            name: `${body.name} (service account)`,
            key_hash: keyHash,
            key_prefix: prefix,
            scope: body.scope,
            project_ids: body.project_ids ?? null,
            expires_at: null,
          })
          .returning();

        return { user: svc!, key: key! };
      });

      return reply.status(201).send({
        data: {
          id: result.user.id,
          name: result.user.display_name,
          email: result.user.email,
          created_at: result.user.created_at,
          api_key: {
            id: result.key.id,
            name: result.key.name,
            key: fullToken,
            key_prefix: prefix,
            scope: result.key.scope,
            project_ids: result.key.project_ids,
          },
          policy: {
            enabled: true,
            allowed_tools: body.allowed_tools ?? ['*'],
          },
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /auth/service-accounts/:id/rotate-key
  // Rotates the active key for a service account. Requires the caller to
  // be the creator, an org admin/owner, or a SuperUser — the same gate as
  // DELETE /auth/service-accounts/:id. Returns the new plaintext token
  // (shown once) and the grace expiry so callers know how long the old
  // key remains valid.
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/auth/service-accounts/:id/rotate-key',
    { preHandler: [requireAuth, requireMinRole('member')] },
    async (request, reply) => {
      const caller = request.user!;

      const [svc] = await db
        .select({
          id: users.id,
          org_id: users.org_id,
          kind: users.kind,
          display_name: users.display_name,
          created_by: users.created_by,
        })
        .from(users)
        .where(eq(users.id, request.params.id))
        .limit(1);

      if (!svc || svc.kind !== 'service') {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Service account not found', details: [], request_id: request.id },
        });
      }
      if (svc.org_id !== caller.active_org_id) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Service account not found', details: [], request_id: request.id },
        });
      }

      const canRotate =
        caller.is_superuser ||
        isOrgPrivileged(caller.role) ||
        svc.created_by === caller.id;
      if (!canRotate) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the creator or an org admin can rotate this service account key.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.user_id, svc.id), isNull(apiKeys.rotated_at)))
        .orderBy(desc(apiKeys.created_at))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'No active key found for this service account', details: [], request_id: request.id },
        });
      }

      if (existing.rotated_at !== null) {
        return reply.status(409).send({
          error: {
            code: 'ALREADY_ROTATED',
            message: 'This key has already been rotated; rotate its successor instead.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rawKey = randomBytes(32).toString('base64url');
      const fullToken = `bbam_svc_${rawKey}`;
      const prefix = fullToken.slice(0, 12);
      const keyHash = await argon2.hash(fullToken);
      const now = new Date();
      const graceExpires = new Date(now.getTime() + getRotationGraceMs());

      const successor = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(apiKeys)
          .values({
            user_id: existing.user_id,
            org_id: existing.org_id,
            name: existing.name,
            key_hash: keyHash,
            key_prefix: prefix,
            scope: existing.scope,
            project_ids: existing.project_ids,
            expires_at: existing.expires_at,
            predecessor_id: existing.id,
          })
          .returning();

        await tx
          .update(apiKeys)
          .set({ rotated_at: now, rotation_grace_expires_at: graceExpires })
          .where(eq(apiKeys.id, existing.id));

        return inserted;
      });

      return reply.status(201).send({
        data: {
          id: successor!.id,
          name: svc.display_name,
          key: fullToken,
          key_prefix: prefix,
          scope: successor!.scope,
          predecessor_grace_expires_at: graceExpires,
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // DELETE /auth/service-accounts/:id  (soft-disable)
  // ────────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/auth/service-accounts/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_service_account.delete')] },
    async (request, reply) => {
      const caller = request.user!;
      const [svc] = await db
        .select({
          id: users.id,
          org_id: users.org_id,
          kind: users.kind,
          created_by: users.created_by,
        })
        .from(users)
        .where(eq(users.id, request.params.id))
        .limit(1);

      if (!svc || svc.kind !== 'service') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Service account not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (svc.org_id !== caller.active_org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Service account not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Creator OR org admin/owner/SuperUser can revoke.
      const canRevoke =
        caller.is_superuser ||
        isOrgPrivileged(caller.role) ||
        svc.created_by === caller.id;
      if (!canRevoke) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the creator or an org admin can revoke this service account.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const now = new Date();
      const redis = (fastify as unknown as { redis?: import('ioredis').Redis }).redis ?? null;

      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ disabled_at: now, disabled_by: caller.id, is_active: false })
          .where(eq(users.id, svc.id));

        await tx
          .update(agentPolicies)
          .set({ enabled: false, updated_at: now, updated_by: caller.id })
          .where(eq(agentPolicies.agent_user_id, svc.id));

        // Hard-delete the keys so the token can't authenticate even if the
        // caller-or-admin later flips is_active back on. Same behavior as
        // user-facing DELETE /auth/api-keys.
        await tx.delete(apiKeys).where(eq(apiKeys.user_id, svc.id));
      });

      if (redis) {
        try {
          await redis.publish('agent_policies:invalidate', svc.id);
        } catch {
          // Best-effort — Redis outage degrades to TTL-only cache expiry.
        }
      }

      return reply.status(204).send();
    },
  );
}

