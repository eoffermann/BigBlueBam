import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, lt, gt, desc, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterMessages,
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { broadcastToChannel } from '../services/realtime.js';
import { extractMentions, resolveMentionsToUsers } from '../services/notification-queue.js';
import { emitNotification, threadDeepLink } from '../lib/notify.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { requireUuidParam } from '../lib/params.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import {
  loadEnrichedChannel,
  loadEnrichedActor,
  loadEnrichedOrg,
  buildMessageUrl,
} from '../lib/bolt-enrich.js';

const createReplySchema = z.object({
  content: z.string().min(1).max(40000),
  content_format: z.enum(['html', 'markdown', 'plain']).default('html'),
  also_send_to_channel: z.boolean().optional().default(false),
});

export default async function threadRoutes(fastify: FastifyInstance) {
  // GET /v1/messages/:id/thread — list thread replies
  fastify.get(
    '/v1/messages/:id/thread',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const id = requireUuidParam(request, reply, 'id');
      if (id === null) return reply;
      const user = request.user!;
      const query = request.query as {
        before?: string;
        after?: string;
        limit?: string;
      };

      const limit = Math.min(Number.parseInt(query.limit || '50', 10), 100);

      // Verify parent message exists
      const [parent] = await db
        .select()
        .from(banterMessages)
        .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
        .limit(1);

      if (!parent) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify the user is a member of the parent message's channel
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(eq(banterChannels.id, parent.channel_id))
        .limit(1);

      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, parent.channel_id),
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

      const conditions = [
        eq(banterMessages.thread_parent_id, id),
        eq(banterMessages.is_deleted, false),
      ];

      if (query.before) {
        conditions.push(
          lt(
            banterMessages.created_at,
            sql`(SELECT created_at FROM banter_messages WHERE id = ${query.before})`,
          ),
        );
      }

      if (query.after) {
        conditions.push(
          gt(
            banterMessages.created_at,
            sql`(SELECT created_at FROM banter_messages WHERE id = ${query.after})`,
          ),
        );
      }

      const orderDir = query.after ? asc(banterMessages.created_at) : desc(banterMessages.created_at);

      const replies = await db
        .select({
          message: banterMessages,
          author: {
            id: users.id,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
          },
        })
        .from(banterMessages)
        .innerJoin(users, eq(banterMessages.author_id, users.id))
        .where(and(...conditions))
        .orderBy(orderDir)
        .limit(limit);

      if (query.after) {
        replies.reverse();
      }

      // Shape must match the channel listing (apps/banter-api/src/routes/message.routes.ts),
      // because the frontend renders both lists through the same MessageItem
      // component, which accesses message.attachments.length and
      // message.reactions.length directly. Returning raw DB rows (which
      // have no attachments/reactions arrays) crashes the thread panel
      // with "Cannot read properties of undefined (reading 'length')".
      const data = replies.map((row) => ({
        ...row.message,
        author_id: row.message.author_id,
        author_display_name: row.author.display_name,
        author_avatar_url: row.author.avatar_url,
        is_bot: row.message.is_bot ?? false,
        is_pinned: false,
        is_edited: row.message.is_edited ?? false,
        thread_reply_count: row.message.reply_count ?? 0,
        thread_latest_reply_at: row.message.last_reply_at ?? null,
        reactions: [],
        attachments: [],
      }));

      return reply.send({
        data,
        meta: {
          has_more: replies.length === limit,
          count: replies.length,
          parent_id: id,
        },
      });
    },
  );

  // POST /v1/messages/:id/thread — post reply
  fastify.post(
    '/v1/messages/:id/thread',
    { preHandler: [requireAuth, fastify.requireCan('banter.message_thread.create'), requireScope('read_write')] },
    async (request, reply) => {
      const id = requireUuidParam(request, reply, 'id');
      if (id === null) return reply;
      const user = request.user!;
      const body = createReplySchema.parse(request.body);

      // Verify parent message exists
      const [parent] = await db
        .select()
        .from(banterMessages)
        .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
        .limit(1);

      if (!parent) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Parent message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify membership
      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, parent.channel_id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (!membership) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Must be a member of this channel to reply',
            details: [],
            request_id: request.id,
          },
        });
      }

      const sanitizedReplyContent = sanitizeContent(body.content);
      const contentPlain = sanitizedReplyContent.replace(/<[^>]*>/g, '').slice(0, 500);

      const [message] = await db
        .insert(banterMessages)
        .values({
          channel_id: parent.channel_id,
          author_id: user.id,
          thread_parent_id: id,
          content: sanitizedReplyContent,
          content_plain: contentPlain,
          content_format: body.content_format,
          also_sent_to_channel: body.also_send_to_channel,
        })
        .returning();

      // Update parent: reply_count, last_reply_at, reply_user_ids (cap 5)
      await db
        .update(banterMessages)
        .set({
          reply_count: sql`${banterMessages.reply_count} + 1`,
          last_reply_at: new Date(),
          reply_user_ids: sql`(
            SELECT COALESCE(
              (SELECT array_agg(uid) FROM (
                SELECT DISTINCT unnest(
                  array_append(reply_user_ids, ${user.id}::uuid)
                ) AS uid
                FROM banter_messages WHERE id = ${id}
              ) sub LIMIT 5),
              ARRAY[${user.id}::uuid]
            )
          )`,
        })
        .where(eq(banterMessages.id, id));

      broadcastToChannel(parent.channel_id, {
        type: 'thread.reply',
        data: {
          parent_id: id,
          message: {
            ...message,
            author: {
              id: user.id,
              display_name: user.display_name,
              avatar_url: user.avatar_url,
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      // When "Also send to channel" is checked, the reply is also surfaced
      // in the channel's top-level message list. Emit message.created so
      // live channel views append it without a refetch; the row itself is
      // already persisted with also_sent_to_channel=true, and the channel
      // listing query unions on that flag so reloads pick it up too.
      if (body.also_send_to_channel && message) {
        broadcastToChannel(parent.channel_id, {
          type: 'message.created',
          data: {
            message: {
              ...message,
              author: {
                id: user.id,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
              },
            },
          },
          timestamp: new Date().toISOString(),
        });
      }

      // ── Dispatch notifications (async, non-blocking) ─────────────
      (async () => {
        try {
          if (!message) return;
          const [ch] = await db
            .select({
              name: banterChannels.name,
              slug: banterChannels.slug,
              org_id: banterChannels.org_id,
            })
            .from(banterChannels)
            .where(eq(banterChannels.id, parent.channel_id))
            .limit(1);
          if (!ch) return;

          const notified = new Set<string>([user.id]);

          // @mentions first
          const mentionedNames = extractMentions(body.content);
          if (mentionedNames.length > 0) {
            const mentionedUsers = await resolveMentionsToUsers(ch.org_id, mentionedNames);
            for (const mu of mentionedUsers) {
              if (notified.has(mu.id)) continue;
              notified.add(mu.id);
              await emitNotification({
                user_id: mu.id,
                org_id: ch.org_id,
                title: `${user.display_name} mentioned you in #${ch.name}`,
                body: contentPlain,
                category: 'mention',
                deep_link: threadDeepLink(ch.slug, id, message.id),
                metadata: {
                  channel_id: parent.channel_id,
                  channel_name: ch.name,
                  channel_slug: ch.slug,
                  message_id: message.id,
                  thread_parent_id: id,
                },
              });
            }
          }

          // Thread reply fanout: parent author + all prior repliers.
          const priorPosters = await db
            .select({ author_id: banterMessages.author_id })
            .from(banterMessages)
            .where(
              and(
                eq(banterMessages.thread_parent_id, id),
                eq(banterMessages.is_deleted, false),
              ),
            );
          const recipients = new Set<string>([parent.author_id]);
          for (const p of priorPosters) recipients.add(p.author_id);

          for (const rid of recipients) {
            if (notified.has(rid)) continue;
            notified.add(rid);
            await emitNotification({
              user_id: rid,
              org_id: ch.org_id,
              title: `${user.display_name} replied to a thread in #${ch.name}`,
              body: contentPlain,
              category: 'thread_reply',
              deep_link: threadDeepLink(ch.slug, id, message.id),
              metadata: {
                channel_id: parent.channel_id,
                channel_name: ch.name,
                channel_slug: ch.slug,
                message_id: message.id,
                thread_parent_id: id,
              },
            });
          }
        } catch {
          // Non-critical
        }
      })();

      // Bolt workflow event (fire-and-forget) — thread replies are still
      // messages and fire message.posted / message.mentioned. Payload shape
      // must match apps/bolt-api/src/services/event-catalog.ts banterEvents.
      (async () => {
        try {
          if (!message) return;
          const [enrichedChannel, enrichedActor, enrichedOrg] = await Promise.all([
            loadEnrichedChannel(parent.channel_id),
            loadEnrichedActor(user.id),
            loadEnrichedOrg(user.org_id),
          ]);

          const mentions = extractMentions(body.content);
          const messageUrl = buildMessageUrl(
            enrichedChannel,
            message.id,
            message.thread_parent_id,
          );

          await publishBoltEvent(
            'message.posted',
            'banter',
            {
              message: {
                id: message.id,
                content: message.content_plain ?? message.content,
                content_html: message.content,
                url: messageUrl,
                thread_parent_id: message.thread_parent_id,
                is_reply: true,
                mentions,
                // TODO: include attachments — not yet attached at this point
                attachments: [],
                created_at: message.created_at,
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

          if (mentions.length > 0) {
            const mentionedUsers = await resolveMentionsToUsers(user.org_id, mentions);
            for (const mu of mentionedUsers) {
              await publishBoltEvent(
                'message.mentioned',
                'banter',
                {
                  message: {
                    id: message.id,
                    content: message.content_plain ?? message.content,
                    url: messageUrl,
                  },
                  mentioned_user: {
                    id: mu.id,
                    name: mu.display_name,
                    email: mu.email,
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
            }
          }
        } catch {
          // Fire-and-forget — never affect thread reply delivery
        }
      })();

      return reply.status(201).send({ data: message });
    },
  );
}
