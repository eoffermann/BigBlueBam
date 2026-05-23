import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, inArray, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { getEffectiveBanterPermissions } from '../services/org-permissions-bridge.js';

const createDmSchema = z.object({
  user_id: z.string().uuid(),
});

const createGroupDmSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(2).max(7),
});

export default async function dmRoutes(fastify: FastifyInstance) {
  // POST /v1/dm — create or retrieve DM
  fastify.post(
    '/v1/dm',
    { preHandler: [requireAuth, fastify.requireCan('banter.dm.create'), requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const body = createDmSchema.parse(request.body);

      if (body.user_id === user.id) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Cannot create DM with yourself',
            details: [],
            request_id: request.id,
          },
        });
      }

      // P2-9: Validate target exists, is active, and belongs to the same org.
      const [targetUser] = await db
        .select({ id: users.id, is_active: users.is_active, org_id: users.org_id })
        .from(users)
        .where(eq(users.id, body.user_id))
        .limit(1);

      if (!targetUser || !targetUser.is_active || targetUser.org_id !== user.org_id) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid DM target',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check if DM already exists between these two users
      const existingDms = await db
        .select({ channel_id: banterChannelMemberships.channel_id })
        .from(banterChannelMemberships)
        .where(eq(banterChannelMemberships.user_id, user.id))
        .innerJoin(
          banterChannels,
          and(
            eq(banterChannelMemberships.channel_id, banterChannels.id),
            eq(banterChannels.type, 'dm'),
            eq(banterChannels.org_id, user.org_id),
          ),
        );

      for (const dm of existingDms) {
        const otherMember = await db
          .select()
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, dm.channel_id),
              eq(banterChannelMemberships.user_id, body.user_id),
            ),
          )
          .limit(1);

        if (otherMember.length > 0) {
          const [channel] = await db
            .select()
            .from(banterChannels)
            .where(eq(banterChannels.id, dm.channel_id))
            .limit(1);

          return reply.send({ data: channel });
        }
      }

      // Get the other user's info for the channel name
      const [otherUser] = await db
        .select({ id: users.id, display_name: users.display_name })
        .from(users)
        .where(eq(users.id, body.user_id))
        .limit(1);

      if (!otherUser) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Create new DM channel. The stored `name` is a best-effort
      // fallback label (other user's display_name at creation time).
      // The UI resolves the actual display via `dm_other_participant`
      // returned by GET /v1/channels — that handles the case where
      // the viewing user is the OTHER participant (whose name we'd
      // never want them to see as their own DM label).
      const slug = `dm-${[user.id, body.user_id].sort().join('-')}`.slice(0, 80);

      const [channel] = await db
        .insert(banterChannels)
        .values({
          org_id: user.org_id,
          name: otherUser.display_name,
          slug,
          type: 'dm',
          created_by: user.id,
          member_count: 2,
        })
        .returning();

      if (!channel) {
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'DM channel insert returned no row',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.insert(banterChannelMemberships).values([
        { channel_id: channel.id, user_id: user.id, role: 'member' },
        { channel_id: channel.id, user_id: body.user_id, role: 'member' },
      ]);

      return reply.status(201).send({ data: channel });
    },
  );

  // POST /v1/group-dm — create group DM
  fastify.post(
    '/v1/group-dm',
    { preHandler: [requireAuth, fastify.requireCan('banter.group_dm.create'), requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const body = createGroupDmSchema.parse(request.body);

      // Enforce org-level permission: members_can_create_group_dms.
      // Admins/owners/superusers always allowed.
      const isPrivileged = user.role === 'admin' || user.role === 'owner' || user.is_superuser;
      if (!isPrivileged) {
        // Cached + normalized via the bridge. See
        // services/org-permissions-bridge.ts for the full mapping.
        const perms = await getEffectiveBanterPermissions(user.org_id);
        if (!perms.members_can_create_group_dms) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to create group DMs',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const allUserIds = [...new Set([user.id, ...body.user_ids])];

      if (allUserIds.length < 3 || allUserIds.length > 8) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Group DM requires 3-8 total participants',
            details: [],
            request_id: request.id,
          },
        });
      }

      // P2-9: Validate all targets exist, are active, and belong to the same org.
      const targets = await db
        .select({ id: users.id, is_active: users.is_active, org_id: users.org_id })
        .from(users)
        .where(inArray(users.id, body.user_ids));

      for (const userId of body.user_ids) {
        const target = targets.find((t) => t.id === userId);
        if (!target || !target.is_active || target.org_id !== user.org_id) {
          return reply.status(400).send({
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid DM target',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // Get display names for channel name
      const groupUsers = await db
        .select({ display_name: users.display_name })
        .from(users)
        .where(inArray(users.id, allUserIds));

      const channelName = groupUsers
        .map((u) => u.display_name)
        .slice(0, 3)
        .join(', ')
        + (groupUsers.length > 3 ? ` +${groupUsers.length - 3}` : '');

      const slug = `gdm-${allUserIds.sort().join('-').slice(0, 60)}`;

      const [channel] = await db
        .insert(banterChannels)
        .values({
          org_id: user.org_id,
          name: channelName.slice(0, 80),
          slug: slug.slice(0, 80),
          type: 'group_dm',
          created_by: user.id,
          member_count: allUserIds.length,
        })
        .returning();

      if (!channel) {
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Group DM channel insert returned no row',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.insert(banterChannelMemberships).values(
        allUserIds.map((uid) => ({
          channel_id: channel.id,
          user_id: uid,
          role: 'member' as const,
        })),
      );

      return reply.status(201).send({ data: channel });
    },
  );

  // GET /v1/dm — list user's DMs and group DMs
  fastify.get(
    '/v1/dm',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const rows = await db
        .select({
          channel: banterChannels,
          membership: banterChannelMemberships,
        })
        .from(banterChannelMemberships)
        .innerJoin(
          banterChannels,
          eq(banterChannelMemberships.channel_id, banterChannels.id),
        )
        .where(
          and(
            eq(banterChannelMemberships.user_id, user.id),
            sql`${banterChannels.type} IN ('dm', 'group_dm')`,
          ),
        )
        .orderBy(desc(banterChannels.last_message_at));

      const channels = rows.map((row) => ({
        ...row.channel,
        role: row.membership.role,
        last_read_message_id: row.membership.last_read_message_id,
      }));

      return reply.send({ data: channels });
    },
  );
}
