import type { FastifyInstance } from 'fastify';
import { eq, asc, and } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { requireAuth } from '../plugins/auth.js';
import * as orgService from '../services/org.service.js';
import { getOrgPermissions, isOrgPrivileged } from '../services/org-permissions.js';

// Wave 1.A: rotation grace period in milliseconds (7 days by default).
// Override with API_KEY_ROTATION_GRACE_MS for shorter windows in tests.
const DEFAULT_ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function getRotationGraceMs(): number {
  const raw = process.env.API_KEY_ROTATION_GRACE_MS;
  if (!raw) return DEFAULT_ROTATION_GRACE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROTATION_GRACE_MS;
}

export default async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/auth/api-keys',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_api_key.list')] },
    async (request, reply) => {
      const result = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          key_prefix: apiKeys.key_prefix,
          scope: apiKeys.scope,
          project_ids: apiKeys.project_ids,
          expires_at: apiKeys.expires_at,
          created_at: apiKeys.created_at,
          last_used_at: apiKeys.last_used_at,
        })
        .from(apiKeys)
        .where(eq(apiKeys.user_id, request.user!.id))
        .orderBy(asc(apiKeys.created_at));

      // Show prefix + last 4 chars hint
      const data = result.map((k) => ({
        ...k,
        key_hint: `${k.key_prefix}...`,
      }));

      return reply.send({ data });
    },
  );

  fastify.post(
    '/auth/api-keys',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_api_key.create')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255),
        scope: z.enum(['read', 'read_write', 'admin']).default('read'),
        project_ids: z.array(z.string().uuid()).optional(),
        expires_at: z.string().datetime().optional(),
      });
      const body = schema.parse(request.body);

      // Admin-scope keys may only be created by org owners or SuperUsers.
      // Org admins, members, and all other roles are blocked — this is stricter
      // than the org-level `allowed_api_key_scopes` setting which only applies
      // to members (not admins). Applies to session *and* API-key auth callers.
      if (
        body.scope === 'admin' &&
        !request.user!.is_superuser &&
        request.user!.role !== 'owner'
      ) {
        return reply.status(403).send({
          error: {
            code: 'ADMIN_SCOPE_OWNER_ONLY',
            message: "Admin-scope API keys can only be created by an organization owner.",
            details: [],
            request_id: request.id,
          },
        });
      }

      // If using API key auth, the caller's API key scope must be >= the requested scope
      if (request.user!.api_key_scope !== null) {
        const scopeHierarchy = ['read', 'read_write', 'admin'];
        const callerLevel = scopeHierarchy.indexOf(request.user!.api_key_scope);
        const requestedLevel = scopeHierarchy.indexOf(body.scope);
        if (requestedLevel > callerLevel) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Cannot create API key with '${body.scope}' scope — your API key only has '${request.user!.api_key_scope}' scope`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // Enforce org-level permissions for non-admin members
      if (!request.user!.is_superuser && !isOrgPrivileged(request.user!.role)) {
        const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
        const perms = getOrgPermissions(org?.settings as Record<string, unknown> | null);

        if (!perms.members_can_create_api_keys) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to create API keys',
              details: [],
              request_id: request.id,
            },
          });
        }

        const allowedScopes = perms.allowed_api_key_scopes || ['read', 'read_write'];
        if (!allowedScopes.includes(body.scope)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Scope '${body.scope}' is not allowed for your role in this organization`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const data = body;

      // Generate a random API key
      const rawKey = randomBytes(32).toString('base64url');
      const prefix = rawKey.slice(0, 8);
      const keyHash = await argon2.hash(rawKey);

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          user_id: request.user!.id,
          org_id: request.user!.active_org_id,
          name: data.name,
          key_hash: keyHash,
          key_prefix: prefix,
          scope: data.scope,
          project_ids: data.project_ids ?? null,
          expires_at: data.expires_at ? new Date(data.expires_at) : null,
        })
        .returning();

      return reply.status(201).send({
        data: {
          id: apiKey!.id,
          name: apiKey!.name,
          key: rawKey,
          key_prefix: prefix,
          scope: apiKey!.scope,
          project_ids: apiKey!.project_ids,
          expires_at: apiKey!.expires_at,
          created_at: apiKey!.created_at,
        },
      });
    },
  );

  // Wave 1.A: rotate an API key. Generates a new key that shares the same
  // scope/project binding/org as the predecessor. Both keys work until
  // rotation_grace_expires_at. The predecessor is marked rotated_at=now()
  // and rotation_grace_expires_at=now()+7d (or override). predecessor_id
  // on the new key points at the predecessor so we can clean up later.
  fastify.post<{ Params: { id: string } }>(
    '/auth/api-keys/:id/rotate',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_api_key.rotate')] },
    async (request, reply) => {
      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, request.params.id),
            eq(apiKeys.user_id, request.user!.id),
          ),
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'API key not found',
            details: [],
            request_id: request.id,
          },
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
      const fullToken = `bbam_${rawKey}`;
      const prefix = fullToken.slice(0, 8);
      const keyHash = await argon2.hash(fullToken);
      const now = new Date();
      const graceExpires = new Date(now.getTime() + getRotationGraceMs());

      // Transactional swap: insert the successor, then mark the predecessor.
      // Postgres-js driver autocommits per statement, so we wrap in a db
      // transaction for atomicity.
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
          .set({
            rotated_at: now,
            rotation_grace_expires_at: graceExpires,
          })
          .where(eq(apiKeys.id, existing.id));

        return inserted;
      });

      return reply.status(201).send({
        data: {
          id: successor!.id,
          name: successor!.name,
          key: fullToken,
          key_prefix: prefix,
          scope: successor!.scope,
          project_ids: successor!.project_ids,
          expires_at: successor!.expires_at,
          created_at: successor!.created_at,
          predecessor_id: existing.id,
          predecessor_grace_expires_at: graceExpires,
        },
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/auth/api-keys/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.auth_api_key.delete')] },
    async (request, reply) => {
      // Ensure the key belongs to the current user
      const [existing] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'API key not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.user_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only revoke your own API keys',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.delete(apiKeys).where(eq(apiKeys.id, request.params.id));

      return reply.send({ data: { success: true } });
    },
  );
}
