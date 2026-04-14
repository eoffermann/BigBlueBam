import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, lt, gt, desc, asc, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterChannels,
  banterChannelMemberships,
  banterMessages,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireChannelMember } from '../middleware/channel-auth.js';
import { broadcastToChannel } from '../services/realtime.js';
import { extractMentions } from '../services/notification-queue.js';
import {
  emitNotification,
  channelDeepLink,
  dmDeepLink,
  threadDeepLink,
} from '../lib/notify.js';
import { sanitizeContent } from '../lib/sanitize.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  loadEnrichedChannel,
  loadEnrichedActor,
  loadEnrichedOrg,
  buildMessageUrl,
} from '../lib/bolt-enrich.js';

const createMessageSchema = z.object({
  content: z.string().min(1).max(40000),
  content_format: z.enum(['html', 'markdown', 'plain']).default('html'),
  thread_parent_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateMessageSchema = z.object({
  content: z.string().min(1).max(40000),
});

export default async function messageRoutes(fastify: FastifyInstance) {
  // GET /v1/channels/:id/messages — cursor-based pagination
  fastify.get(
    '/v1/channels/:id/messages',
    { preHandler: [requireAuth, requireChannelMember] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const query = request.query as {
        before?: string;
        after?: string;
        cursor?: string;
        limit?: string;
      };

      // `cursor` is an alias for `before` (used by frontend's infinite query)
      const beforeCursor = query.before || query.cursor;

      const limit = Math.min(parseInt(query.limit || '50', 10), 100);

      // Verify membership or public channel
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(and(eq(banterChannels.id, id), eq(banterChannels.org_id, user.org_id)))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const conditions = [
        eq(banterMessages.channel_id, id),
        eq(banterMessages.is_deleted, false),
        isNull(banterMessages.thread_parent_id),
      ];

      if (beforeCursor) {
        conditions.push(
          lt(
            banterMessages.created_at,
            sql`(SELECT created_at FROM banter_messages WHERE id = ${beforeCursor})`,
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

      const messages = await db
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

      // If fetching with ?after, reverse to get newest-last ordering
      if (query.after) {
        messages.reverse();
      }

      const data = messages.map((row) => ({
        ...row.message,
        author_id: row.message.author_id,
        author_display_name: row.author.display_name,
        author_avatar_url: row.author.avatar_url,
        is_bot: row.message.is_bot ?? false,
        is_pinned: row.message.is_pinned ?? false,
        is_edited: row.message.is_edited ?? false,
        thread_reply_count: row.message.reply_count ?? 0,
        thread_latest_reply_at: row.message.last_reply_at ?? null,
        reactions: [],
        attachments: [],
      }));

      // Cursor for pagination: use the last message's ID
      const nextCursor = messages.length === limit && data.length > 0
        ? data[data.length - 1]!.id
        : null;

      return reply.send({
        data,
        next_cursor: nextCursor,
        has_more: messages.length === limit,
      });
    },
  );

  // POST /v1/channels/:id/messages — post message
  fastify.post(
    '/v1/channels/:id/messages',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireChannelMember] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = createMessageSchema.parse(request.body);

      // Sanitize content with DOMPurify (allowlisted tags/attributes only)
      const sanitizedContent = sanitizeContent(body.content);

      // Strip HTML tags for plain text
      const contentPlain = sanitizedContent.replace(/<[^>]*>/g, '').slice(0, 500);

      const [message] = await db
        .insert(banterMessages)
        .values({
          channel_id: id,
          author_id: user.id,
          thread_parent_id: body.thread_parent_id ?? null,
          content: sanitizedContent,
          content_plain: contentPlain,
          content_format: body.content_format,
          metadata: body.metadata ?? {},
        })
        .returning();

      // Update channel denormalized fields
      await db
        .update(banterChannels)
        .set({
          last_message_at: new Date(),
          last_message_preview: contentPlain.slice(0, 200),
          message_count: sql`${banterChannels.message_count} + 1`,
        })
        .where(eq(banterChannels.id, id));

      // If this is a thread reply, update the parent message
      if (body.thread_parent_id) {
        await db
          .update(banterMessages)
          .set({
            reply_count: sql`${banterMessages.reply_count} + 1`,
            last_reply_at: new Date(),
            reply_user_ids: sql`(
              SELECT array_agg(DISTINCT uid) FROM (
                SELECT unnest(reply_user_ids) AS uid FROM banter_messages WHERE id = ${body.thread_parent_id}
                UNION SELECT ${user.id}::uuid
              ) sub LIMIT 5
            )`,
          })
          .where(eq(banterMessages.id, body.thread_parent_id));
      }

      broadcastToChannel(id, {
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

      // ── Dispatch notifications (async, non-blocking) ─────────────
      (async () => {
        try {
          if (!message) return;
          // Get channel info for notification context
          const [ch] = await db
            .select({
              name: banterChannels.name,
              slug: banterChannels.slug,
              type: banterChannels.type,
              org_id: banterChannels.org_id,
            })
            .from(banterChannels)
            .where(eq(banterChannels.id, id))
            .limit(1);
          if (!ch) return;

          // Track everyone we notified so thread-reply doesn't double-fire
          // on top of an @mention.
          const notified = new Set<string>([user.id]);

          // ── @mention notifications (highest priority) ──
          const mentionedNames = extractMentions(body.content);
          if (mentionedNames.length > 0) {
            const mentionedUsers = await db
              .select({ id: users.id, display_name: users.display_name })
              .from(users)
              .where(
                and(
                  eq(users.org_id, ch.org_id),
                  sql`lower(${users.display_name}) = ANY(${mentionedNames.map((n) => n.toLowerCase())})`,
                ),
              );
            for (const mu of mentionedUsers) {
              if (notified.has(mu.id)) continue;
              notified.add(mu.id);
              const deep_link = body.thread_parent_id
                ? threadDeepLink(ch.slug, body.thread_parent_id, message.id)
                : ch.type === 'dm' || ch.type === 'group_dm'
                  ? dmDeepLink(id, message.id)
                  : channelDeepLink(ch.slug, message.id);
              await emitNotification({
                user_id: mu.id,
                org_id: ch.org_id,
                title: `${user.display_name} mentioned you in #${ch.name}`,
                body: contentPlain,
                category: 'mention',
                deep_link,
                metadata: {
                  channel_id: id,
                  channel_name: ch.name,
                  channel_slug: ch.slug,
                  message_id: message.id,
                  thread_parent_id: body.thread_parent_id ?? null,
                },
              });
            }
          }

          // ── DM notifications ──
          if (ch.type === 'dm' || ch.type === 'group_dm') {
            const members = await db
              .select({ user_id: banterChannelMemberships.user_id })
              .from(banterChannelMemberships)
              .where(eq(banterChannelMemberships.channel_id, id));
            for (const m of members) {
              if (notified.has(m.user_id)) continue;
              notified.add(m.user_id);
              await emitNotification({
                user_id: m.user_id,
                org_id: ch.org_id,
                title: `New message from ${user.display_name}`,
                body: contentPlain,
                category: 'dm',
                deep_link: dmDeepLink(id, message.id),
                metadata: {
                  channel_id: id,
                  message_id: message.id,
                },
              });
            }
          }

          // ── Thread reply notifications ──
          // Notify the thread STARTER plus everyone who has already
          // posted in the thread (minus the current author and anyone
          // already notified via @mention above).
          if (body.thread_parent_id) {
            const [parentMsg] = await db
              .select({ author_id: banterMessages.author_id })
              .from(banterMessages)
              .where(eq(banterMessages.id, body.thread_parent_id))
              .limit(1);
            if (!parentMsg) return;

            // Prior posters in the thread (distinct authors).
            const priorPosters = await db
              .select({ author_id: banterMessages.author_id })
              .from(banterMessages)
              .where(
                and(
                  eq(banterMessages.thread_parent_id, body.thread_parent_id),
                  eq(banterMessages.is_deleted, false),
                ),
              );

            const recipients = new Set<string>([parentMsg.author_id]);
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
                deep_link: threadDeepLink(ch.slug, body.thread_parent_id, message.id),
                metadata: {
                  channel_id: id,
                  channel_name: ch.name,
                  channel_slug: ch.slug,
                  message_id: message.id,
                  thread_parent_id: body.thread_parent_id,
                },
              });
            }
          }
        } catch {
          // Non-critical: don't let notification failures affect message delivery
        }
      })();

      // Bolt workflow event (fire-and-forget) — payload shape must match the
      // catalog declared in apps/bolt-api/src/services/event-catalog.ts so that
      // rule templates like {{ event.channel.handle }} or
      // {{ event.actor.email }} resolve correctly.
      (async () => {
        try {
          if (!message) return;
          const [enrichedChannel, enrichedActor, enrichedOrg] = await Promise.all([
            loadEnrichedChannel(id),
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
                is_reply: !!message.thread_parent_id,
                mentions,
                // TODO: include attachments — banterMessageAttachments are
                // written separately after the message insert, so they
                // aren't yet attached when this producer fires.
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

          // Fan out message.mentioned — once per successfully-resolved
          // mentioned user. We reuse the same extractMentions() names and
          // resolve them against users.display_name (same matching the
          // notification path uses above).
          if (mentions.length > 0) {
            const mentionedUsers = await db
              .select({
                id: users.id,
                display_name: users.display_name,
                email: users.email,
              })
              .from(users)
              .where(
                and(
                  eq(users.org_id, user.org_id),
                  sql`lower(${users.display_name}) = ANY(${mentions.map((n) => n.toLowerCase())})`,
                ),
              );
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
          // Fire-and-forget — never affect message delivery
        }
      })();

      return reply.status(201).send({ data: message });
    },
  );

  // GET /v1/messages/:id — single message with thread summary
  fastify.get(
    '/v1/messages/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [row] = await db
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
        .where(and(eq(banterMessages.id, id), eq(banterMessages.is_deleted, false)))
        .limit(1);

      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify the user is a member of the message's channel
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(eq(banterChannels.id, row.message.channel_id))
        .limit(1);

      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, row.message.channel_id),
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

      return reply.send({
        data: {
          ...row.message,
          author: row.author,
        },
      });
    },
  );

  // PATCH /v1/messages/:id — edit (own only)
  fastify.patch(
    '/v1/messages/:id',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = updateMessageSchema.parse(request.body);

      const [existing] = await db
        .select({ message: banterMessages })
        .from(banterMessages)
        .innerJoin(banterChannels, eq(banterChannels.id, banterMessages.channel_id))
        .where(
          and(
            eq(banterMessages.id, id),
            eq(banterMessages.is_deleted, false),
            eq(banterChannels.org_id, user.org_id),
          ),
        )
        .limit(1)
        .then((rows) => rows.map((r) => r.message));

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.author_id !== user.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Can only edit your own messages',
            details: [],
            request_id: request.id,
          },
        });
      }

      const sanitizedEditContent = sanitizeContent(body.content);
      const contentPlain = sanitizedEditContent.replace(/<[^>]*>/g, '').slice(0, 500);

      const [updated] = await db
        .update(banterMessages)
        .set({
          content: sanitizedEditContent,
          content_plain: contentPlain,
          is_edited: true,
          edited_at: new Date(),
        })
        .where(eq(banterMessages.id, id))
        .returning();

      broadcastToChannel(existing.channel_id, {
        type: 'message.updated',
        data: { message: updated },
        timestamp: new Date().toISOString(),
      });

      // Bolt workflow event (fire-and-forget) — payload shape must match the
      // catalog declared in apps/bolt-api/src/services/event-catalog.ts.
      (async () => {
        try {
          if (!updated) return;
          const [enrichedChannel, enrichedActor, enrichedOrg] = await Promise.all([
            loadEnrichedChannel(existing.channel_id),
            loadEnrichedActor(user.id),
            loadEnrichedOrg(user.org_id),
          ]);
          const messageUrl = buildMessageUrl(
            enrichedChannel,
            updated.id,
            updated.thread_parent_id,
          );
          await publishBoltEvent(
            'message.edited',
            'banter',
            {
              message: {
                id: updated.id,
                content: updated.content_plain ?? updated.content,
                content_html: updated.content,
                previous_content: existing.content_plain ?? existing.content,
                url: messageUrl,
                is_edited: updated.is_edited,
                edited_at: updated.edited_at,
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
          // Fire-and-forget — never affect message edit
        }
      })();

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/messages/:id — soft delete (own or admin)
  fastify.delete(
    '/v1/messages/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [existing] = await db
        .select({ message: banterMessages })
        .from(banterMessages)
        .innerJoin(banterChannels, eq(banterChannels.id, banterMessages.channel_id))
        .where(
          and(
            eq(banterMessages.id, id),
            eq(banterMessages.is_deleted, false),
            eq(banterChannels.org_id, user.org_id),
          ),
        )
        .limit(1)
        .then((rows) => rows.map((r) => r.message));

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Message not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check permission: own message or admin/owner
      if (existing.author_id !== user.id && !['owner', 'admin'].includes(user.role)) {
        // Also check channel-level role
        const [membership] = await db
          .select()
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, existing.channel_id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership || !['owner', 'admin'].includes(membership.role)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Insufficient permissions to delete this message',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const [deleted] = await db
        .update(banterMessages)
        .set({
          is_deleted: true,
          deleted_at: new Date(),
          deleted_by: user.id,
        })
        .where(eq(banterMessages.id, id))
        .returning();

      broadcastToChannel(existing.channel_id, {
        type: 'message.deleted',
        data: { message_id: id, channel_id: existing.channel_id },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: deleted });
    },
  );
}
