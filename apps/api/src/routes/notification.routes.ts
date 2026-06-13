import type { FastifyInstance } from 'fastify';
import { eq, and, lt, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { notifications } from '../db/schema/notifications.js';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      'filter[is_read]'?: string;
      category?: string;
      unread_only?: string;
      source_app?: string;
    };
  }>(
    '/me/notifications',
    { preHandler: [requireAuth, shadowOnly('bam.me_notification.list')] },
    async (request, reply) => {
      const limit = Math.min(request.query.limit ? Number.parseInt(request.query.limit, 10) : 50, 200);
      const conditions = [eq(notifications.user_id, request.user!.id)];

      // Legacy filter — kept for backwards compat.
      if (request.query['filter[is_read]'] !== undefined) {
        conditions.push(
          eq(notifications.is_read, request.query['filter[is_read]'] === 'true'),
        );
      }

      // Newer `?unread_only=true` — simpler alias favored by the bell UI.
      if (request.query.unread_only === 'true') {
        conditions.push(eq(notifications.is_read, false));
      }

      // Comma-separated category list: ?category=mention,dm
      if (request.query.category) {
        const cats = request.query.category
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        if (cats.length > 0) {
          conditions.push(inArray(notifications.category, cats));
        }
      }

      // Comma-separated source app filter: ?source_app=banter,bbb
      if (request.query.source_app) {
        const apps = request.query.source_app
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        if (apps.length > 0) {
          conditions.push(inArray(notifications.source_app, apps));
        }
      }

      if (request.query.cursor) {
        conditions.push(lt(notifications.created_at, new Date(request.query.cursor)));
      }

      const result = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.created_at))
        .limit(limit + 1);

      const hasMore = result.length > limit;
      const data = hasMore ? result.slice(0, limit) : result;
      const nextCursor =
        hasMore && data.length > 0
          ? data[data.length - 1]!.created_at.toISOString()
          : null;

      // Unread count is cheap and the bell always wants it.
      const [countRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.user_id, request.user!.id),
            eq(notifications.is_read, false),
          ),
        );

      return reply.send({
        data,
        meta: {
          next_cursor: nextCursor,
          has_more: hasMore,
          unread_count: countRow?.c ?? 0,
        },
      });
    },
  );

  fastify.post(
    '/me/notifications/mark-read',
    { preHandler: [requireAuth, shadowOnly('bam.me_notification_mark_read.create')] },
    async (request, reply) => {
      const schema = z.union([
        z.object({ notification_ids: z.array(z.string().uuid()) }),
        z.object({ all: z.literal(true) }),
      ]);
      const data = schema.parse(request.body);

      if ('all' in data && data.all) {
        await db
          .update(notifications)
          .set({ is_read: true })
          .where(
            and(
              eq(notifications.user_id, request.user!.id),
              eq(notifications.is_read, false),
            ),
          );
      } else if ('notification_ids' in data) {
        await db
          .update(notifications)
          .set({ is_read: true })
          .where(
            and(
              eq(notifications.user_id, request.user!.id),
              inArray(notifications.id, data.notification_ids),
            ),
          );
      }

      return reply.send({ data: { success: true } });
    },
  );

  // Explicit mark-all-read endpoint. Friendlier for the bell UI than
  // posting {all: true} to /mark-read.
  fastify.post(
    '/me/notifications/mark-all-read',
    { preHandler: [requireAuth, shadowOnly('bam.me_notification_mark_all_read.create')] },
    async (request, reply) => {
      await db
        .update(notifications)
        .set({ is_read: true })
        .where(
          and(
            eq(notifications.user_id, request.user!.id),
            eq(notifications.is_read, false),
          ),
        );
      return reply.send({ data: { success: true } });
    },
  );

  // Mark a single notification read by id. Matches the URL the
  // frontend bell wants to POST to when the user clicks a row.
  fastify.post<{ Params: { id: string } }>(
    '/me/notifications/:id/read',
    { preHandler: [requireAuth, shadowOnly('bam.me_notification_read.create')] },
    async (request, reply) => {
      await db
        .update(notifications)
        .set({ is_read: true })
        .where(
          and(
            eq(notifications.id, request.params.id),
            eq(notifications.user_id, request.user!.id),
          ),
        );
      return reply.send({ data: { success: true } });
    },
  );
}
