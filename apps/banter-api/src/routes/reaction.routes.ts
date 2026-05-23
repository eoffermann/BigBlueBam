import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterMessages,
  banterMessageReactions,
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { broadcastToChannel } from '../services/realtime.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import {
  loadEnrichedChannel,
  loadEnrichedActor,
  loadEnrichedOrg,
  buildMessageUrl,
} from '../lib/bolt-enrich.js';

const toggleReactionSchema = z.object({
  emoji: z.string().min(1).max(50),
});

export default async function reactionRoutes(fastify: FastifyInstance) {
  // POST /v1/messages/:id/reactions — toggle reaction
  fastify.post(
    '/v1/messages/:id/reactions',
    { preHandler: [requireAuth, fastify.requireCan('banter.message_reaction.create'), requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = toggleReactionSchema.parse(request.body);

      // Verify message exists
      const [message] = await db
        .select()
        .from(banterMessages)
        .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
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

      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, message.channel_id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (!membership) {
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

      // Check if reaction already exists (toggle)
      const [existing] = await db
        .select()
        .from(banterMessageReactions)
        .where(
          and(
            eq(banterMessageReactions.message_id, id),
            eq(banterMessageReactions.user_id, user.id),
            eq(banterMessageReactions.emoji, body.emoji),
          ),
        )
        .limit(1);

      if (existing) {
        // Remove reaction
        await db
          .delete(banterMessageReactions)
          .where(eq(banterMessageReactions.id, existing.id));

        // Update reaction_counts JSONB
        await db
          .update(banterMessages)
          .set({
            reaction_counts: sql`
              CASE
                WHEN (reaction_counts->${body.emoji})::int <= 1
                THEN reaction_counts - ${body.emoji}
                ELSE jsonb_set(reaction_counts, ARRAY[${body.emoji}], to_jsonb(((reaction_counts->${body.emoji})::int - 1)))
              END
            `,
          })
          .where(eq(banterMessages.id, id));

        broadcastToChannel(message.channel_id, {
          type: 'reaction.removed',
          data: {
            message_id: id,
            user_id: user.id,
            emoji: body.emoji,
          },
          timestamp: new Date().toISOString(),
        });

        return reply.send({ data: { action: 'removed', emoji: body.emoji } });
      } else {
        // Add reaction
        await db.insert(banterMessageReactions).values({
          message_id: id,
          user_id: user.id,
          emoji: body.emoji,
        });

        // Update reaction_counts JSONB
        await db
          .update(banterMessages)
          .set({
            reaction_counts: sql`
              jsonb_set(
                reaction_counts,
                ARRAY[${body.emoji}],
                to_jsonb(COALESCE((reaction_counts->${body.emoji})::int, 0) + 1)
              )
            `,
          })
          .where(eq(banterMessages.id, id));

        broadcastToChannel(message.channel_id, {
          type: 'reaction.added',
          data: {
            message_id: id,
            user_id: user.id,
            display_name: user.display_name,
            emoji: body.emoji,
          },
          timestamp: new Date().toISOString(),
        });

        // Bolt workflow event (fire-and-forget) — payload shape must match
        // the catalog declared in apps/bolt-api/src/services/event-catalog.ts.
        (async () => {
          try {
            const [enrichedChannel, enrichedActor, enrichedOrg, authorRow] = await Promise.all([
              loadEnrichedChannel(message.channel_id),
              loadEnrichedActor(user.id),
              loadEnrichedOrg(user.org_id),
              db
                .select({
                  id: users.id,
                  display_name: users.display_name,
                })
                .from(users)
                .where(eq(users.id, message.author_id))
                .limit(1),
            ]);
            const author = authorRow[0];
            const messageUrl = buildMessageUrl(
              enrichedChannel,
              message.id,
              message.thread_parent_id,
            );
            await publishBoltEvent(
              'reaction.added',
              'banter',
              {
                message: {
                  id: message.id,
                  author_id: message.author_id,
                  author_name: author?.display_name ?? null,
                  url: messageUrl,
                },
                reaction: {
                  emoji: body.emoji,
                },
                channel: {
                  id: enrichedChannel.id,
                  name: enrichedChannel.name,
                  handle: enrichedChannel.handle,
                  type: enrichedChannel.type,
                  url: enrichedChannel.url,
                },
                actor: enrichedActor,
                org: enrichedOrg,
              },
              user.org_id,
              user.id,
              'user',
            );
          } catch {
            // Fire-and-forget — never affect reaction toggling
          }
        })();

        return reply.send({ data: { action: 'added', emoji: body.emoji } });
      }
    },
  );

  // GET /v1/messages/:id/reactions — list reactions with users
  fastify.get(
    '/v1/messages/:id/reactions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      // Verify the message exists and the user is a member of its channel
      const [message] = await db
        .select()
        .from(banterMessages)
        .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
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

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(eq(banterChannels.id, message.channel_id))
        .limit(1);

      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, message.channel_id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (!membership) {
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

      const reactions = await db
        .select({
          id: banterMessageReactions.id,
          emoji: banterMessageReactions.emoji,
          user_id: users.id,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          created_at: banterMessageReactions.created_at,
        })
        .from(banterMessageReactions)
        .innerJoin(users, eq(banterMessageReactions.user_id, users.id))
        .where(eq(banterMessageReactions.message_id, id))
        .orderBy(banterMessageReactions.created_at);

      // Group by emoji
      const grouped: Record<string, { emoji: string; count: number; users: Array<{ id: string; display_name: string; avatar_url: string | null }> }> = {};
      for (const r of reactions) {
        const bucket = grouped[r.emoji] ?? { emoji: r.emoji, count: 0, users: [] };
        bucket.count++;
        bucket.users.push({
          id: r.user_id,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
        });
        grouped[r.emoji] = bucket;
      }

      return reply.send({ data: Object.values(grouped) });
    },
  );
}
