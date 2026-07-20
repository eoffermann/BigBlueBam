import type { FastifyInstance } from 'fastify';
import { bursarDraftCreateSchema, bursarDraftDecisionSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import * as drafts from '../services/drafts.service.js';

// Draft routes (spec 5.7, M8). CONFIDENTIAL: bursar.draft.read is NOT a viewer permission (M9
// grants), and reads are additionally owner-scoped in the service. draft.approve is floored. There
// is NO outbound transport in v1; the only externalization is the content-free agent_proposals row.
export default async function draftRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/drafts', { preHandler: [requireAuth, can('bursar.draft.read')] }, async (request) => {
    const q = request.query as { filter?: Record<string, string> };
    return drafts.listDrafts(viewerOf(request), q.filter?.status);
  });

  fastify.get('/drafts/:id', { preHandler: [requireAuth, can('bursar.draft.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await drafts.getDraft(viewerOf(request), id);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/drafts/clarification', { preHandler: [requireAuth, can('bursar.draft.create')] }, async (request, reply) => {
    const parsed = bursarDraftCreateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await drafts.createDraft(viewerOf(request), 'clarification', parsed.data);
      reply.status(201);
      return result;
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/drafts/negotiation-brief', { preHandler: [requireAuth, can('bursar.draft.create')] }, async (request, reply) => {
    const parsed = bursarDraftCreateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await drafts.createDraft(viewerOf(request), 'negotiation_brief', parsed.data);
      reply.status(201);
      return result;
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/drafts/:id/approve', { preHandler: [requireAuth, can('bursar.draft.approve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarDraftDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await drafts.approveDraft(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/drafts/:id/reject', { preHandler: [requireAuth, can('bursar.draft.approve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarDraftDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await drafts.rejectDraft(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}
