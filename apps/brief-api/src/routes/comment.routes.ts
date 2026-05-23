import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as commentService from '../services/comment.service.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

const createCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
  parent_id: z.string().uuid().nullable().optional(),
  anchor_start: z.record(z.unknown()).nullable().optional(),
  anchor_end: z.record(z.unknown()).nullable().optional(),
  anchor_text: z.string().max(1000).nullable().optional(),
});

const updateCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
});

const addReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export default async function commentRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/comments — List threaded comments
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/comments',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_comment.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const comments = await commentService.listComments(doc.id);
      return reply.send({ data: comments });
    },
  );

  // POST /documents/:id/comments — Create a comment
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/comments',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_comment.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createCommentSchema.parse(request.body);
      const doc = (request as any).document;
      const comment = await commentService.createComment(
        doc.id,
        data,
        request.user!.id,
      );
      return reply.status(201).send({ data: comment });
    },
  );

  // PATCH /comments/:commentId — Edit comment body
  fastify.patch<{ Params: { commentId: string } }>(
    '/comments/:commentId',
    { preHandler: [requireAuth, shadowOnly('brief.comment.update'), requireScope('read_write')] },
    async (request, reply) => {
      const { body } = updateCommentSchema.parse(request.body);
      const comment = await commentService.updateComment(
        request.params.commentId,
        body,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: comment });
    },
  );

  // DELETE /comments/:commentId — Delete a comment
  fastify.delete<{ Params: { commentId: string } }>(
    '/comments/:commentId',
    { preHandler: [requireAuth, shadowOnly('brief.comment.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const isAdmin =
        request.user!.is_superuser || roleLevel(request.user!.role) >= roleLevel('admin');
      const deleted = await commentService.deleteComment(
        request.params.commentId,
        request.user!.id,
        isAdmin,
        request.user!.org_id,
      );
      return reply.send({ data: deleted });
    },
  );

  // POST /comments/:commentId/resolve — Toggle resolve
  fastify.post<{ Params: { commentId: string } }>(
    '/comments/:commentId/resolve',
    { preHandler: [requireAuth, shadowOnly('brief.comment_resolve.create'), requireScope('read_write')] },
    async (request, reply) => {
      const comment = await commentService.toggleResolve(
        request.params.commentId,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: comment });
    },
  );

  // POST /comments/:commentId/reactions — Add a reaction
  fastify.post<{ Params: { commentId: string } }>(
    '/comments/:commentId/reactions',
    { preHandler: [requireAuth, shadowOnly('brief.comment_reaction.create')] },
    async (request, reply) => {
      const { emoji } = addReactionSchema.parse(request.body);
      const reaction = await commentService.addReaction(
        request.params.commentId,
        request.user!.id,
        emoji,
        request.user!.org_id,
      );
      if (!reaction) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'Reaction already exists',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.status(201).send({ data: reaction });
    },
  );

  // DELETE /comments/:commentId/reactions/:emoji — Remove a reaction
  fastify.delete<{ Params: { commentId: string; emoji: string } }>(
    '/comments/:commentId/reactions/:emoji',
    { preHandler: [requireAuth, shadowOnly('brief.comment_reaction.delete')] },
    async (request, reply) => {
      const deleted = await commentService.removeReaction(
        request.params.commentId,
        request.user!.id,
        request.params.emoji,
        request.user!.org_id,
      );
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Reaction not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: deleted });
    },
  );
}
