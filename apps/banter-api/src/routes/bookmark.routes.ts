import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterBookmarks,
  banterMessages,
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';

const createBookmarkSchema = z.object({
  message_id: z.string().uuid(),
  note: z.string().max(500).optional(),
});

export default async function bookmarkRoutes(fastify: FastifyInstance) {
  // GET /v1/bookmarks — list user's bookmarks
  fastify.get(
    '/v1/bookmarks',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      // Flat, page-ready shape: the Bookmarks SPA renders channel name/slug
      // (for navigation), the message preview, and the author — so join all
      // three here rather than make the client stitch a nested payload.
      const data = await db
        .select({
          id: banterBookmarks.id,
          message_id: banterBookmarks.message_id,
          note: banterBookmarks.note,
          created_at: banterBookmarks.created_at,
          channel_id: banterChannels.id,
          channel_name: banterChannels.name,
          channel_slug: banterChannels.slug,
          message_content: banterMessages.content,
          message_author_display_name: users.display_name,
        })
        .from(banterBookmarks)
        .innerJoin(banterMessages, eq(banterBookmarks.message_id, banterMessages.id))
        .innerJoin(banterChannels, eq(banterChannels.id, banterMessages.channel_id))
        .innerJoin(users, eq(banterMessages.author_id, users.id))
        .where(eq(banterBookmarks.user_id, user.id))
        .orderBy(desc(banterBookmarks.created_at));

      return reply.send({ data });
    },
  );

  // POST /v1/bookmarks — create bookmark
  fastify.post(
    '/v1/bookmarks',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const body = createBookmarkSchema.parse(request.body);

      // Verify message exists
      const [message] = await db
        .select()
        .from(banterMessages)
        .where(and(eq(banterMessages.id, body.message_id), eq(banterMessages.is_deleted, false)))
        .limit(1);

      if (!message) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify user is a member of the message's channel
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(eq(banterChannels.id, message.channel_id))
        .limit(1);

      const [channelMembership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, message.channel_id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (!channelMembership) {
        const isDm = channel && (channel.type === 'dm' || channel.type === 'group_dm');
        const hasOrgOverride =
          !isDm &&
          channel &&
          channel.org_id === user.org_id &&
          (user.is_superuser || ['owner', 'admin'].includes(user.role));

        if (!hasOrgOverride) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Message not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const [bookmark] = await db
        .insert(banterBookmarks)
        .values({
          user_id: user.id,
          message_id: body.message_id,
          note: body.note ?? null,
        })
        .onConflictDoNothing()
        .returning();

      return reply.status(201).send({ data: bookmark ?? { already_bookmarked: true } });
    },
  );

  // DELETE /v1/bookmarks/by-message/:messageId — remove the current user's
  // bookmark for a message, identified by message id (the message row knows
  // its own id but not the bookmark id, so this powers toggle-off from a
  // message's Bookmark control without threading bookmark ids through the
  // message payload). Registered BEFORE /:id so "by-message" isn't captured
  // as an :id.
  fastify.delete(
    '/v1/bookmarks/by-message/:messageId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { messageId } = request.params as { messageId: string };
      const user = request.user!;

      await db
        .delete(banterBookmarks)
        .where(
          and(
            eq(banterBookmarks.message_id, messageId),
            eq(banterBookmarks.user_id, user.id),
          ),
        );

      return reply.send({ data: { success: true } });
    },
  );

  // DELETE /v1/bookmarks/:id — remove bookmark
  fastify.delete(
    '/v1/bookmarks/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      await db
        .delete(banterBookmarks)
        .where(
          and(
            eq(banterBookmarks.id, id),
            eq(banterBookmarks.user_id, user.id),
          ),
        );

      return reply.send({ data: { success: true } });
    },
  );
}
