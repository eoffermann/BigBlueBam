import type { FastifyInstance } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { requireAuth, requireMinRole } from '../plugins/auth.js';
import * as orgService from '../services/org.service.js';
import { getOrgPermissions, isOrgPrivileged } from '../services/org-permissions.js';

export default async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/auth/api-keys',
    { preHandler: [requireAuth] },
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
    { preHandler: [requireAuth, requireMinRole('member')] },
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
          // Wave 1 fix: api_keys.org_id is NOT NULL since migration 0007
          // but the previous insert omitted it, leaving the field at its
          // Drizzle `.notNull()` constraint violation. Bind the new key
          // to the caller's currently active org.
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

  // Wave 1 / Platform §3.14 — API key rotation. Creates a successor key
  // that clones the predecessor's org/scope/project restrictions and
  // marks the predecessor with a 7-day grace window. The auth plugin
  // already accepts any api_keys row whose expires_at is null or in the
  // future, so the predecessor keeps working until an operator purges
  // it (a future sweep job will honor rotation_grace_expires_at).
  fastify.post<{ Params: { id: string } }>(
    '/v1/api-keys/:id/rotate',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const [predecessor] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, request.params.id))
        .limit(1);

      if (!predecessor) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'API key not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Callers may only rotate their own keys. SuperUsers get the same
      // across-the-board access they already have elsewhere.
      if (!request.user!.is_superuser && predecessor.user_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only rotate your own API keys',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Reject rotation of an already-rotated key — the expected shape is
      // rotate the successor, not chain indefinitely off the original.
      if (predecessor.rotated_at) {
        return reply.status(409).send({
          error: {
            code: 'ALREADY_ROTATED',
            message: 'This API key has already been rotated',
            details: [],
            request_id: request.id,
          },
        });
      }

      const now = new Date();
      const graceExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const rawKey = randomBytes(32).toString('base64url');
      const newPrefix = rawKey.slice(0, 8);
      const newHash = await argon2.hash(rawKey);

      const successor = await db.transaction(async (tx) => {
        await tx
          .update(apiKeys)
          .set({
            rotated_at: now,
            rotation_grace_expires_at: graceExpiresAt,
          })
          .where(eq(apiKeys.id, predecessor.id));

        const [created] = await tx
          .insert(apiKeys)
          .values({
            user_id: predecessor.user_id,
            org_id: predecessor.org_id,
            name: `${predecessor.name} (rotated)`,
            key_hash: newHash,
            key_prefix: newPrefix,
            scope: predecessor.scope,
            project_ids: predecessor.project_ids,
            expires_at: predecessor.expires_at,
            predecessor_id: predecessor.id,
          })
          .returning();

        return created!;
      });

      return reply.status(201).send({
        data: {
          id: successor.id,
          name: successor.name,
          // Returned exactly once — the raw token never appears in a
          // later GET /auth/api-keys listing.
          key: rawKey,
          key_prefix: newPrefix,
          scope: successor.scope,
          project_ids: successor.project_ids,
          expires_at: successor.expires_at,
          created_at: successor.created_at,
          predecessor_id: predecessor.id,
          predecessor_grace_expires_at: graceExpiresAt.toISOString(),
        },
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/auth/api-keys/:id',
    { preHandler: [requireAuth, requireMinRole('member')] },
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
