/**
 * Bastion -> Bam internal routes (APP_DESIGN_bastion.md 2.5, 2.8, 8.4). Mount prefix:
 * /internal/bastion. Called only by bastion-api's outbox drainer with INTERNAL_SERVICE_SECRET;
 * every write is attributed to the Bastion System service user (BASTION_SYSTEM_USER_ID).
 *
 *   POST /tasks/upsert          one task per control by external_id, reopen-to-start-phase
 *   POST /tasks/comment         a comment addressed by external_id, deduplicated on its key
 *   POST /proposals/:id/close   close an owning_app = 'bastion' proposal for a human member
 *                               decider; emits the platform proposal.decided event
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bastionBamTaskCommentSchema, bastionBamTaskUpsertSchema, bastionProposalCloseSchema } from '@bigbluebam/shared';
import { requireInternalServiceSecret } from '../middleware/require-internal-service-secret.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import {
  BastionInternalError,
  closeBastionProposal,
  commentOnBastionTask,
  upsertBastionTask,
} from '../services/bastion-internal.service.js';

function send(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, details: unknown[] = []) {
  return reply.status(status).send({ error: { code, message, details, request_id: request.id } });
}

function invalid(request: FastifyRequest, reply: FastifyReply, err: z.ZodError) {
  return send(
    request,
    reply,
    400,
    'VALIDATION_ERROR',
    err.errors[0]?.message ?? 'Invalid request',
    err.errors.map((e) => ({ field: e.path.join('.'), issue: e.message })),
  );
}

async function guarded<T>(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BastionInternalError) return send(request, reply, err.status, err.code, err.message);
    throw err;
  }
}

export default async function internalBastionRoutes(fastify: FastifyInstance) {
  fastify.post('/tasks/upsert', { preHandler: [requireInternalServiceSecret] }, async (request, reply) => {
    const parsed = bastionBamTaskUpsertSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(request, reply, parsed.error);
    return guarded(request, reply, async () => {
      const data = await upsertBastionTask(parsed.data);
      request.log.info({ caller: 'bastion-api', task_id: data.task_id, outcome: data.outcome }, 'internal-bastion: task upserted');
      return reply.status(data.outcome === 'created' ? 201 : 200).send({ data });
    });
  });

  fastify.post('/tasks/comment', { preHandler: [requireInternalServiceSecret] }, async (request, reply) => {
    const parsed = bastionBamTaskCommentSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(request, reply, parsed.error);
    return guarded(request, reply, async () => {
      const data = await commentOnBastionTask(parsed.data);
      return reply.status(data.outcome === 'posted' ? 201 : 200).send({ data });
    });
  });

  fastify.post('/proposals/:id/close', { preHandler: [requireInternalServiceSecret] }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) return send(request, reply, 404, 'NOT_FOUND', 'Proposal not found');
    const parsed = bastionProposalCloseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(request, reply, parsed.error);
    return guarded(request, reply, async () => {
      const closed = await closeBastionProposal(id.data, parsed.data);
      if (closed.event) {
        await publishBoltEvent('proposal.decided', 'platform', closed.event, parsed.data.org_id, parsed.data.decided_by, 'user');
      }
      return reply.send({ data: closed.result });
    });
  });
}
