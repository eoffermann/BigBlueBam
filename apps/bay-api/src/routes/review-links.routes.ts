import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as reviewLinkService from '../services/review-link.service.js';
import { NotFoundError, ConflictError } from '../services/errors.js';

const createLinkSchema = z.object({
  asset_id: z.string().uuid(),
  expires_in_days: z.number().int().positive().max(365).nullable().optional(),
  allow_comments: z.boolean().optional(),
});

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof ConflictError) {
    return reply.status(409).send({
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

export default async function reviewLinkRoutes(fastify: FastifyInstance) {
  // POST /review-links — mint a public share link for a review
  fastify.post(
    '/review-links',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.review_link.create')] },
    async (request, reply) => {
      const body = createLinkSchema.parse(request.body);
      try {
        const link = await reviewLinkService.createReviewLink(
          request.user!.org_id,
          request.user!.id,
          body,
        );
        return reply.status(201).send({ data: link });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /review-links?asset_id=... — list a review's share links
  fastify.get<{ Querystring: { asset_id?: string } }>(
    '/review-links',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const assetId = (request.query as { asset_id?: string }).asset_id;
      if (!assetId) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'asset_id is required', details: [], request_id: request.id },
        });
      }
      const links = await reviewLinkService.listReviewLinks(request.user!.org_id, assetId);
      return reply.send({ data: links });
    },
  );

  // DELETE /review-links/:id — revoke (soft-disable) a share link. Kept as a
  // soft revoke (sets revoked_at) so view stats/audit survive.
  fastify.delete<{ Params: { id: string } }>(
    '/review-links/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.review_link.delete')] },
    async (request, reply) => {
      try {
        const link = await reviewLinkService.revokeReviewLink(request.params.id, request.user!.org_id);
        return reply.send({ data: link });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
