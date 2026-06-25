import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as decisionService from '../services/decision.service.js';
import { NotFoundError, ConflictError } from '../services/errors.js';
import { broadcastToVersion } from '../lib/broadcast.js';

const setDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'changes_requested', 'pending']),
  comment: z.string().nullable().optional(),
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

export default async function decisionRoutes(fastify: FastifyInstance) {
  // GET /versions/:id/decisions — list review decisions on a version
  fastify.get<{ Params: { id: string } }>(
    '/versions/:id/decisions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const decisions = await decisionService.listDecisions(
          request.params.id,
          request.user!.org_id,
        );
        return reply.send({ data: decisions });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PUT /versions/:id/decision — upsert the caller's review decision
  fastify.put<{ Params: { id: string } }>(
    '/versions/:id/decision',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.version_decision.update')] },
    async (request, reply) => {
      const body = setDecisionSchema.parse(request.body);
      try {
        const decision = await decisionService.setDecision(
          request.params.id,
          request.user!.org_id,
          request.user!.id,
          body,
        );
        await broadcastToVersion(fastify.redis, request.params.id, {
          type: 'bay.decision.set',
          version_id: request.params.id,
        });
        return reply.send({ data: decision });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
