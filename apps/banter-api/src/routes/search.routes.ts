import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterMessages,
  banterChannels,
  banterChannelMemberships,
} from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { escapeLike } from '../lib/escape-like.js';

const searchMessagesSchema = z.object({
  q: z.string().min(1).max(500),
  channel_id: z.string().uuid().optional(),
  author_id: z.string().uuid().optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  has_attachments: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchTranscriptsSchema = z.object({
  q: z.string().min(1).max(500),
  channel_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchChannelsSchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export default async function searchRoutes(fastify: FastifyInstance) {
  // GET /v1/search/messages — full-text search using PostgreSQL tsvector
  fastify.get(
    '/v1/search/messages',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const params = searchMessagesSchema.parse(request.query);

      // Build dynamic WHERE conditions
      const conditions: ReturnType<typeof sql>[] = [];

      // User must be member of the channel
      conditions.push(
        sql`${banterMessages.channel_id} IN (
          SELECT ${banterChannelMemberships.channel_id}
          FROM ${banterChannelMemberships}
          WHERE ${banterChannelMemberships.user_id} = ${user.id}
        )`,
      );

      // Channel must belong to org
      conditions.push(
        sql`${banterMessages.channel_id} IN (
          SELECT ${banterChannels.id}
          FROM ${banterChannels}
          WHERE ${banterChannels.org_id} = ${user.org_id}
        )`,
      );

      // Not deleted
      conditions.push(sql`${banterMessages.is_deleted} = false`);

      // Full-text search using PostgreSQL to_tsvector / plainto_tsquery
      conditions.push(
        sql`to_tsvector('english', ${banterMessages.content_plain}) @@ plainto_tsquery('english', ${params.q})`,
      );

      // Optional filters
      if (params.channel_id) {
        conditions.push(sql`${banterMessages.channel_id} = ${params.channel_id}`);
      }
      if (params.author_id) {
        conditions.push(sql`${banterMessages.author_id} = ${params.author_id}`);
      }
      if (params.before) {
        conditions.push(sql`${banterMessages.created_at} < ${params.before}`);
      }
      if (params.after) {
        conditions.push(sql`${banterMessages.created_at} > ${params.after}`);
      }
      if (params.has_attachments !== undefined) {
        if (params.has_attachments) {
          conditions.push(sql`${banterMessages.attachment_count} > 0`);
        } else {
          conditions.push(sql`${banterMessages.attachment_count} = 0`);
        }
      }

      const whereClause = sql.join(conditions, sql` AND `);

      // Query with ts_headline for highlighted snippets.
      //
      // NOTE: the dynamic `conditions` above are built with Drizzle column
      // refs (e.g. ${banterMessages.channel_id}), which render as the
      // fully-qualified "banter_messages"."channel_id". We therefore must NOT
      // alias banter_messages in the FROM clause — an alias (e.g. `m`) makes
      // those qualified refs an "invalid reference to FROM-clause entry" and
      // the whole query 500s. The banter_channels/users joins keep their c/u
      // aliases because the conditions only reference those tables inside
      // self-contained subqueries, never at this query's top level.
      const results = await db.execute(sql`
        SELECT
          banter_messages.id,
          banter_messages.channel_id,
          banter_messages.author_id,
          banter_messages.thread_parent_id,
          banter_messages.created_at,
          banter_messages.attachment_count,
          banter_messages.content,
          ts_headline(
            'english',
            banter_messages.content_plain,
            plainto_tsquery('english', ${params.q}),
            'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
          ) AS snippet,
          c.name AS channel_name,
          c.slug AS channel_slug,
          u.display_name AS author_display_name,
          u.avatar_url AS author_avatar_url,
          ts_rank(
            to_tsvector('english', banter_messages.content_plain),
            plainto_tsquery('english', ${params.q})
          ) AS rank
        FROM banter_messages
        INNER JOIN banter_channels c ON c.id = banter_messages.channel_id
        INNER JOIN users u ON u.id = banter_messages.author_id
        WHERE ${whereClause}
        ORDER BY rank DESC, banter_messages.created_at DESC
        LIMIT ${params.limit}
        OFFSET ${params.offset}
      `);

      // Get total count
      const countResult = await db.execute(sql`
        SELECT count(*)::int AS total
        FROM banter_messages
        WHERE ${whereClause}
      `);

      const total = (countResult[0] as any)?.total ?? 0;

      return reply.send({
        data: results,
        pagination: {
          total,
          limit: params.limit,
          offset: params.offset,
        },
      });
    },
  );

  // GET /v1/search/channels — search by name/topic
  fastify.get(
    '/v1/search/channels',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const params = searchChannelsSchema.parse(request.query);

      const searchPattern = `%${escapeLike(params.q)}%`;

      // SuperUsers see all channels; otherwise hide private channels the user isn't a member of.
      const visibilityCondition = user.is_superuser
        ? sql`TRUE`
        : sql`(
            ${banterChannels.type} = 'public'
            OR EXISTS (
              SELECT 1 FROM ${banterChannelMemberships}
              WHERE ${banterChannelMemberships.channel_id} = ${banterChannels.id}
                AND ${banterChannelMemberships.user_id} = ${user.id}
            )
          )`;

      const channels = await db
        .select()
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.org_id, user.org_id),
            eq(banterChannels.is_archived, false),
            sql`(
              ${banterChannels.name} ILIKE ${searchPattern}
              OR ${banterChannels.display_name} ILIKE ${searchPattern}
              OR ${banterChannels.topic} ILIKE ${searchPattern}
              OR ${banterChannels.description} ILIKE ${searchPattern}
            )`,
            visibilityCondition,
          ),
        )
        .orderBy(banterChannels.name)
        .limit(params.limit)
        .offset(params.offset);

      return reply.send({ data: channels });
    },
  );

  // GET /v1/search/transcripts — full-text search on call transcript segments
  fastify.get(
    '/v1/search/transcripts',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const params = searchTranscriptsSchema.parse(request.query);

      // Build WHERE conditions
      const conditions: ReturnType<typeof sql>[] = [];

      // Only search transcripts from calls in channels the user is a member of, within their org
      conditions.push(
        sql`t.call_id IN (
          SELECT c.id FROM banter_calls c
          INNER JOIN banter_channels ch ON ch.id = c.channel_id
          INNER JOIN banter_channel_memberships cm ON cm.channel_id = ch.id
          WHERE cm.user_id = ${user.id} AND ch.org_id = ${user.org_id}
        )`,
      );

      // Full-text search on content
      conditions.push(
        sql`to_tsvector('english', t.content) @@ plainto_tsquery('english', ${params.q})`,
      );

      // Optional channel filter
      if (params.channel_id) {
        conditions.push(
          sql`t.call_id IN (
            SELECT id FROM banter_calls WHERE channel_id = ${params.channel_id}
          )`,
        );
      }

      const whereClause = sql.join(conditions, sql` AND `);

      const results = await db.execute(sql`
        SELECT
          t.id,
          t.call_id,
          t.speaker_id,
          t.content,
          t.started_at,
          t.ended_at,
          t.confidence,
          t.is_final,
          ts_headline(
            'english',
            t.content,
            plainto_tsquery('english', ${params.q}),
            'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
          ) AS snippet,
          c.channel_id,
          c.type AS call_type,
          c.title AS call_title,
          c.started_at AS call_started_at,
          u.display_name AS speaker_name,
          u.avatar_url AS speaker_avatar_url,
          ts_rank(
            to_tsvector('english', t.content),
            plainto_tsquery('english', ${params.q})
          ) AS rank
        FROM banter_call_transcripts t
        INNER JOIN banter_calls c ON c.id = t.call_id
        INNER JOIN users u ON u.id = t.speaker_id
        WHERE ${whereClause}
        ORDER BY rank DESC, t.started_at DESC
        LIMIT ${params.limit}
        OFFSET ${params.offset}
      `);

      // Get total count
      const countResult = await db.execute(sql`
        SELECT count(*)::int AS total
        FROM banter_call_transcripts t
        WHERE ${whereClause}
      `);

      const total = (countResult[0] as any)?.total ?? 0;

      return reply.send({
        data: results,
        pagination: {
          total,
          limit: params.limit,
          offset: params.offset,
        },
      });
    },
  );
}
