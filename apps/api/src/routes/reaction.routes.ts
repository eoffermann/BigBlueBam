import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { commentReactions } from '../db/schema/comment-reactions.js';
import { comments } from '../db/schema/comments.js';
import { users } from '../db/schema/users.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireProjectAccessForEntity } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

export default async function reactionRoutes(fastify: FastifyInstance) {
  // ── POST /comments/:id/reactions ──────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/comments/:id/reactions',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.comment_reaction.create' }), requireScope('read_write'), requireProjectAccessForEntity('comment')] },
    async (request, reply) => {
      const bodySchema = z.object({
        emoji: z.string().min(1).max(50),
      });

      const { emoji } = bodySchema.parse(request.body);
      const commentId = request.params.id;
      const userId = request.user!.id;

      // Verify comment exists
      const [comment] = await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1);

      if (!comment) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Comment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Toggle: check if reaction exists
      const [existing] = await db
        .select()
        .from(commentReactions)
        .where(
          and(
            eq(commentReactions.comment_id, commentId),
            eq(commentReactions.user_id, userId),
            eq(commentReactions.emoji, emoji),
          ),
        )
        .limit(1);

      if (existing) {
        // Remove reaction
        await db
          .delete(commentReactions)
          .where(eq(commentReactions.id, existing.id));
      } else {
        // Add reaction
        await db.insert(commentReactions).values({
          comment_id: commentId,
          user_id: userId,
          emoji,
        });
      }

      // Return updated reaction counts
      const counts = await db
        .select({
          emoji: commentReactions.emoji,
          count: sql<number>`count(*)::int`,
        })
        .from(commentReactions)
        .where(eq(commentReactions.comment_id, commentId))
        .groupBy(commentReactions.emoji);

      return reply.send({ data: counts });
    },
  );

  // ── GET /comments/:id/reactions ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/comments/:id/reactions',
    { preHandler: [requireAuth, requireProjectAccessForEntity('comment')] },
    async (request, reply) => {
      const commentId = request.params.id;

      const reactions = await db
        .select({
          emoji: commentReactions.emoji,
          user_id: commentReactions.user_id,
          display_name: users.display_name,
        })
        .from(commentReactions)
        .innerJoin(users, eq(commentReactions.user_id, users.id))
        .where(eq(commentReactions.comment_id, commentId));

      // Group by emoji
      const emojiMap = new Map<string, {
        emoji: string;
        count: number;
        users: Array<{ id: string; display_name: string }>;
      }>();

      for (const r of reactions) {
        if (!emojiMap.has(r.emoji)) {
          emojiMap.set(r.emoji, { emoji: r.emoji, count: 0, users: [] });
        }
        const entry = emojiMap.get(r.emoji)!;
        entry.count++;
        entry.users.push({ id: r.user_id, display_name: r.display_name });
      }

      return reply.send({ data: Array.from(emojiMap.values()) });
    },
  );
}
