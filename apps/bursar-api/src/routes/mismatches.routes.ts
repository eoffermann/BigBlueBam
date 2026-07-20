import type { FastifyInstance } from 'fastify';
import { bursarMismatchDecisionSchema, bursarMarkWrongSchema, bursarListQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as mismatches from '../services/mismatches.service.js';

// Mismatch inbox routes (spec 8, 11, M8). Reads project through the financial floor (a finding's
// dollars_at_stake is a money field). Write verbs are bursar.mismatch.resolve; read is
// bursar.mismatch.read.
export default async function mismatchRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/mismatches', { preHandler: [requireAuth, can('bursar.mismatch.read')] }, async (request) => {
    const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
    const parsed = bursarListQuerySchema.safeParse(q);
    const limit = parsed.success ? parsed.data.limit : 25;
    const result = await mismatches.listMismatches(viewerOf(request), {
      cursor: q.cursor,
      limit,
      status: q.filter?.status,
      detector: q.filter?.detector,
      vendorId: q.filter?.vendor_id,
    });
    return redactFinancialFields(result, await request.viewerCaps());
  });

  fastify.get('/mismatches/:id', { preHandler: [requireAuth, can('bursar.mismatch.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await mismatches.getMismatch(viewerOf(request), id);
      return redactFinancialFields(result, await request.viewerCaps());
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/mismatches/:id/resolve', { preHandler: [requireAuth, can('bursar.mismatch.resolve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarMismatchDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await mismatches.resolveMismatch(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/mismatches/:id/dismiss', { preHandler: [requireAuth, can('bursar.mismatch.resolve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarMismatchDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await mismatches.dismissMismatch(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.post('/mismatches/:id/mark-wrong', { preHandler: [requireAuth, can('bursar.mismatch.resolve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarMarkWrongSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await mismatches.markWrong(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}
