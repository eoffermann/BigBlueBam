import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBeaconReadAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as commentService from '../services/comment.service.js';
import { CommentError } from '../services/comment.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { buildBeaconEventPayload } from '../lib/enrich-beacon-event.js';

const createCommentSchema = z.object({
  body_markdown: z.string().min(1).max(20_000),
  parent_id: z.string().uuid().nullable().optional(),
});

const updateCommentSchema = z.object({
  body_markdown: z.string().min(1).max(20_000),
});

function isAdminRole(role: string, isSuperuser: boolean): boolean {
  return isSuperuser || role === 'admin' || role === 'owner';
}

export default async function commentsRoutes(fastify: FastifyInstance) {
  // GET /beacons/:id/comments — list all comments on a beacon
  fastify.get<{ Params: { id: string } }>(
    '/beacons/:id/comments',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_comment.get')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const comments = await commentService.listComments(beacon.id);
      return reply.send({ data: comments });
    },
  );

  // POST /beacons/:id/comments — create a new comment (optionally as a reply)
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/comments',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_comment.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createCommentSchema.parse(request.body);
      const beacon = (request as any).beacon;

      try {
        const comment = await commentService.createComment(
          beacon.id,
          request.user!.id,
          {
            body_markdown: data.body_markdown,
            parent_id: data.parent_id ?? null,
          },
        );

        // Fire-and-forget Bolt event emission. Never block the HTTP response.
        buildBeaconEventPayload(beacon, request.user!.id, {
          comment: {
            id: comment.id,
            parent_id: comment.parent_id,
            author_id: comment.author_id,
            body_markdown: comment.body_markdown,
            created_at:
              comment.created_at instanceof Date
                ? comment.created_at.toISOString()
                : comment.created_at,
          },
        })
          .then((payload) =>
            publishBoltEvent(
              'comment.created',
              'beacon',
              payload,
              request.user!.org_id,
              request.user!.id,
            ),
          )
          .catch(() => {});

        return reply.status(201).send({ data: comment });
      } catch (err) {
        if (err instanceof CommentError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // PUT /beacons/:id/comments/:commentId — update own comment
  fastify.put<{ Params: { id: string; commentId: string } }>(
    '/beacons/:id/comments/:commentId',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_comment.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateCommentSchema.parse(request.body);
      try {
        const updated = await commentService.updateComment(
          request.params.commentId,
          request.user!.id,
          { body_markdown: data.body_markdown },
        );
        return reply.send({ data: updated });
      } catch (err) {
        if (err instanceof CommentError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // DELETE /beacons/:id/comments/:commentId — author or admin only
  fastify.delete<{ Params: { id: string; commentId: string } }>(
    '/beacons/:id/comments/:commentId',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_comment.delete'), requireScope('read_write')] },
    async (request, reply) => {
      try {
        // Cross-beacon safety: confirm the comment belongs to the beacon
        // in the URL before we trust the outer requireBeaconReadAccess
        // check. Without this a reader of beacon A could target a
        // comment id from beacon B by guessing.
        const withBeacon = await commentService.getCommentWithBeacon(
          request.params.commentId,
        );
        if (!withBeacon) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Comment not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        const beacon = (request as any).beacon;
        if (withBeacon.comment.beacon_id !== beacon.id) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Comment not found on this beacon',
              details: [],
              request_id: request.id,
            },
          });
        }

        const isAdmin = isAdminRole(request.user!.role, request.user!.is_superuser);
        const deleted = await commentService.deleteComment(
          request.params.commentId,
          request.user!.id,
          isAdmin,
        );
        return reply.send({ data: deleted });
      } catch (err) {
        if (err instanceof CommentError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );
}
