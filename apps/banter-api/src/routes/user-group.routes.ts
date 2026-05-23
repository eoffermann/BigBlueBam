import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterUserGroups,
  banterUserGroupMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { broadcastToOrg } from '../services/realtime.js';

const createUserGroupSchema = z.object({
  name: z.string().min(1).max(80),
  handle: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens'),
  description: z.string().max(500).optional(),
});

const updateUserGroupSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  handle: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().max(500).nullable().optional(),
});

const addMembersSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

export default async function userGroupRoutes(fastify: FastifyInstance) {
  // Wave D Phase 3: factory wraps the org admin/owner role gate with the
  // dual-read resolver for each route's specific permission_id.
  const adminPreHandler = (permission: string) => [
    requireAuth,
    fastify.requireCan(permission),
    requireScope('admin'),
  ];

  // GET /v1/user-groups
  fastify.get(
    '/v1/user-groups',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const groups = await db
        .select()
        .from(banterUserGroups)
        .where(eq(banterUserGroups.org_id, user.org_id))
        .orderBy(banterUserGroups.name);

      return reply.send({ data: groups });
    },
  );

  // POST /v1/user-groups
  fastify.post(
    '/v1/user-groups',
    { preHandler: adminPreHandler('banter.user_group.create') },
    async (request, reply) => {
      const user = request.user!;
      const body = createUserGroupSchema.parse(request.body);

      const [group] = await db
        .insert(banterUserGroups)
        .values({
          org_id: user.org_id,
          name: body.name,
          handle: body.handle,
          description: body.description ?? null,
          created_by: user.id,
        })
        .returning();

      broadcastToOrg(user.org_id, {
        type: 'user_group.created',
        data: { group },
        timestamp: new Date().toISOString(),
      });

      return reply.status(201).send({ data: group });
    },
  );

  // GET /v1/user-groups/by-handle/:handle — resolve a group by its @handle
  //
  // Read-only resolver used by MCP tooling to translate @engineering
  // into a stable group id. Caller strips the leading '@'. Scoped to
  // the authenticated user's active org. Returns `{ data: null }` if
  // no match (not 404) so callers can treat it uniformly.
  fastify.get(
    '/v1/user-groups/by-handle/:handle',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const user = request.user!;

      const cleaned = (handle ?? '').replace(/^@/, '').trim().toLowerCase();
      if (!cleaned || cleaned.length > 80) {
        return reply.send({ data: null });
      }

      const [group] = await db
        .select({
          id: banterUserGroups.id,
          name: banterUserGroups.name,
          handle: banterUserGroups.handle,
          description: banterUserGroups.description,
        })
        .from(banterUserGroups)
        .where(
          and(
            eq(banterUserGroups.org_id, user.org_id),
            eq(banterUserGroups.handle, cleaned),
          ),
        )
        .limit(1);

      if (!group) {
        return reply.send({ data: null });
      }

      // Include a member_count derived from the memberships table so
      // callers don't have to make a second round-trip.
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(banterUserGroupMemberships)
        .where(eq(banterUserGroupMemberships.group_id, group.id));

      return reply.send({
        data: {
          ...group,
          member_count: countRow?.count ?? 0,
        },
      });
    },
  );

  // PATCH /v1/user-groups/:id
  fastify.patch(
    '/v1/user-groups/:id',
    { preHandler: adminPreHandler('banter.user_group.update') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [existing] = await db
        .select()
        .from(banterUserGroups)
        .where(and(eq(banterUserGroups.id, id), eq(banterUserGroups.org_id, user.org_id)))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const body = updateUserGroupSchema.parse(request.body);

      const updateData: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.handle !== undefined) updateData.handle = body.handle;
      if (body.description !== undefined) updateData.description = body.description;

      const [updated] = await db
        .update(banterUserGroups)
        .set(updateData)
        .where(eq(banterUserGroups.id, id))
        .returning();

      broadcastToOrg(user.org_id, {
        type: 'user_group.updated',
        data: { group: updated },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/user-groups/:id
  fastify.delete(
    '/v1/user-groups/:id',
    { preHandler: adminPreHandler('banter.user_group.delete') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const deleted = await db
        .delete(banterUserGroups)
        .where(and(eq(banterUserGroups.id, id), eq(banterUserGroups.org_id, user.org_id)))
        .returning();

      if (deleted.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      broadcastToOrg(user.org_id, {
        type: 'user_group.deleted',
        data: { id },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: { success: true } });
    },
  );

  // POST /v1/user-groups/:id/members
  fastify.post(
    '/v1/user-groups/:id/members',
    { preHandler: adminPreHandler('banter.user_group_member.create') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = addMembersSchema.parse(request.body);

      // Verify group belongs to org
      const [group] = await db
        .select()
        .from(banterUserGroups)
        .where(and(eq(banterUserGroups.id, id), eq(banterUserGroups.org_id, user.org_id)))
        .limit(1);

      if (!group) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      let addedCount = 0;
      for (const userId of body.user_ids) {
        try {
          await db
            .insert(banterUserGroupMemberships)
            .values({
              group_id: id,
              user_id: userId,
            })
            .onConflictDoNothing();
          addedCount++;
        } catch {
          // Skip invalid user IDs
        }
      }

      return reply.send({ data: { added: addedCount } });
    },
  );

  // GET /v1/user-groups/:id/members
  fastify.get(
    '/v1/user-groups/:id/members',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      // Verify group belongs to org
      const [group] = await db
        .select()
        .from(banterUserGroups)
        .where(and(eq(banterUserGroups.id, id), eq(banterUserGroups.org_id, user.org_id)))
        .limit(1);

      if (!group) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const members = await db
        .select({
          id: banterUserGroupMemberships.id,
          user_id: users.id,
          display_name: users.display_name,
          email: users.email,
          avatar_url: users.avatar_url,
          added_at: banterUserGroupMemberships.added_at,
        })
        .from(banterUserGroupMemberships)
        .innerJoin(users, eq(banterUserGroupMemberships.user_id, users.id))
        .where(eq(banterUserGroupMemberships.group_id, id))
        .orderBy(banterUserGroupMemberships.added_at);

      return reply.send({ data: members });
    },
  );

  // DELETE /v1/user-groups/:id/members/:userId
  fastify.delete(
    '/v1/user-groups/:id/members/:userId',
    { preHandler: adminPreHandler('banter.user_group_member.delete') },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const user = request.user!;

      // Verify group belongs to org
      const [group] = await db
        .select()
        .from(banterUserGroups)
        .where(and(eq(banterUserGroups.id, id), eq(banterUserGroups.org_id, user.org_id)))
        .limit(1);

      if (!group) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const deleted = await db
        .delete(banterUserGroupMemberships)
        .where(
          and(
            eq(banterUserGroupMemberships.group_id, id),
            eq(banterUserGroupMemberships.user_id, userId),
          ),
        )
        .returning();

      if (deleted.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User is not a member of this group',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
