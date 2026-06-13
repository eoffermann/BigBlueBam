import type { FastifyInstance } from 'fastify';
import { eq, and, asc, desc, gt, sql, inArray } from 'drizzle-orm';
import { createCommentSchema, updateCommentSchema } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { comments } from '../db/schema/comments.js';
import { commentReactions } from '../db/schema/comment-reactions.js';
import { commentRevisions } from '../db/schema/comment-revisions.js';
import { tasks } from '../db/schema/tasks.js';
import { users } from '../db/schema/users.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccessForEntity } from '../middleware/authorize.js';
import * as projectService from '../services/project.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichTask, loadActor, loadOrg } from '../services/bolt-event-enricher.service.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function commentRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    '/tasks/:id/comments',
    { preHandler: [requireAuth, requireProjectAccessForEntity('task'), shadowOnly('bam.task_comment.get')] },
    async (request, reply) => {
      const limit = Math.min(request.query.limit ? Number.parseInt(request.query.limit, 10) : 50, 200);
      const conditions = [eq(comments.task_id, request.params.id)];

      if (request.query.cursor) {
        conditions.push(gt(comments.created_at, new Date(request.query.cursor)));
      }

      const result = await db
        .select({
          id: comments.id,
          task_id: comments.task_id,
          author_id: comments.author_id,
          body: comments.body,
          created_at: comments.created_at,
          edited_at: comments.edited_at,
          author: {
            id: users.id,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
          },
        })
        .from(comments)
        .innerJoin(users, eq(comments.author_id, users.id))
        .where(and(...conditions))
        .orderBy(asc(comments.created_at))
        .limit(limit + 1);

      const hasMore = result.length > limit;
      const data = hasMore ? result.slice(0, limit) : result;
      const nextCursor =
        hasMore && data.length > 0 ? data[data.length - 1]!.created_at.toISOString() : null;

      // Fetch reactions for all returned comments
      const commentIds = data.map((c) => c.id);
      const reactionsMap = new Map<string, Array<{ emoji: string; count: number; reacted: boolean }>>();

      if (commentIds.length > 0) {
        const allReactions = await db
          .select({
            comment_id: commentReactions.comment_id,
            emoji: commentReactions.emoji,
            user_id: commentReactions.user_id,
          })
          .from(commentReactions)
          .where(inArray(commentReactions.comment_id, commentIds));

        // Group by comment_id + emoji
        const grouped = new Map<string, Map<string, { count: number; reacted: boolean }>>();
        for (const r of allReactions) {
          if (!grouped.has(r.comment_id)) {
            grouped.set(r.comment_id, new Map());
          }
          const emojiMap = grouped.get(r.comment_id)!;
          if (!emojiMap.has(r.emoji)) {
            emojiMap.set(r.emoji, { count: 0, reacted: false });
          }
          const entry = emojiMap.get(r.emoji)!;
          entry.count++;
          if (r.user_id === request.user!.id) {
            entry.reacted = true;
          }
        }

        for (const [commentId, emojiMap] of grouped) {
          reactionsMap.set(
            commentId,
            Array.from(emojiMap.entries()).map(([emoji, info]) => ({
              emoji,
              count: info.count,
              reacted: info.reacted,
            })),
          );
        }
      }

      const dataWithReactions = data.map((c) => ({
        ...c,
        reactions: reactionsMap.get(c.id) ?? [],
      }));

      return reply.send({
        data: dataWithReactions,
        meta: {
          next_cursor: nextCursor,
          has_more: hasMore,
        },
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/comments',
    { preHandler: [requireAuth, fastify.requireCan('bam.task_comment.create'), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const data = createCommentSchema.parse(request.body);

      // Verify task exists and user is a member of its project
      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, request.params.id))
        .limit(1);

      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          task.project_id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Task not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const [comment] = await db
        .insert(comments)
        .values({
          task_id: request.params.id,
          author_id: request.user!.id,
          body: data.body,
        })
        .returning();

      // Increment comment count on task
      await db
        .update(tasks)
        .set({
          comment_count: sql`${tasks.comment_count} + 1`,
          updated_at: new Date(),
        })
        .where(eq(tasks.id, request.params.id));

      // Bolt workflow event (fire-and-forget)
      //
      // TODO: include comment.mentions[] once we parse @-mentions from
      // comment bodies at write time (currently bodies are plain text and
      // mentions are not extracted).
      (async () => {
        try {
          const [enriched, actor, org] = await Promise.all([
            enrichTask(task),
            loadActor(request.user!.id),
            loadOrg(request.user!.org_id),
          ]);
          await publishBoltEvent(
            'comment.created',
            'bam',
            {
              comment: {
                id: comment!.id,
                body: comment!.body,
                task_id: comment!.task_id,
                author_id: comment!.author_id,
                mentions: [] as string[],
                url: enriched.task.url,
              },
              task: enriched.task,
              task_id: request.params.id,
              project_id: task.project_id,
              project: enriched.project,
              assignee: enriched.assignee,
              actor,
              org,
            },
            request.user!.org_id,
            request.user!.id,
            'user',
          );
        } catch {
          // fire-and-forget
        }
      })();

      return reply.status(201).send({ data: comment });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.comment.update'), requireScope('read_write'), requireProjectAccessForEntity('comment')] },
    async (request, reply) => {
      const data = updateCommentSchema.parse(request.body);

      // Check ownership
      const [existing] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Comment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.author_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only edit your own comments',
            details: [],
            request_id: request.id,
          },
        });
      }

      // No-op edits don't burn a revision or flip the edited badge.
      if (data.body === existing.body) {
        return reply.send({ data: existing });
      }

      // Preserve the superseded text BEFORE the update so the comment's
      // history is reconstructable ("(edited)" badge + history viewer).
      await db.insert(commentRevisions).values({
        comment_id: existing.id,
        body: existing.body,
        revised_by: request.user!.id,
      });

      const [comment] = await db
        .update(comments)
        .set({
          body: data.body,
          edited_at: new Date(),
        })
        .where(eq(comments.id, request.params.id))
        .returning();

      return reply.send({ data: comment });
    },
  );

  // Edit history for a comment: every prior body, newest first. Readable
  // by anyone who can read the comment (same project-access gate as the
  // list endpoint) — history is transparency, not a private draft.
  fastify.get<{ Params: { id: string } }>(
    '/comments/:id/revisions',
    { preHandler: [requireAuth, requireProjectAccessForEntity('comment')] },
    async (request, reply) => {
      const [existing] = await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.id, request.params.id))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Comment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rows = await db
        .select({
          id: commentRevisions.id,
          body: commentRevisions.body,
          revised_at: commentRevisions.revised_at,
          revised_by: commentRevisions.revised_by,
          revised_by_name: users.display_name,
        })
        .from(commentRevisions)
        .leftJoin(users, eq(commentRevisions.revised_by, users.id))
        .where(eq(commentRevisions.comment_id, request.params.id))
        .orderBy(desc(commentRevisions.revised_at));

      return reply.send({ data: rows });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.comment.delete'), requireScope('read_write'), requireProjectAccessForEntity('comment')] },
    async (request, reply) => {
      const [existing] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Comment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.author_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only delete your own comments',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.delete(comments).where(eq(comments.id, request.params.id));

      // Decrement comment count on task
      await db
        .update(tasks)
        .set({
          comment_count: sql`greatest(${tasks.comment_count} - 1, 0)`,
          updated_at: new Date(),
        })
        .where(eq(tasks.id, existing.task_id));

      return reply.send({ data: { success: true } });
    },
  );
}
