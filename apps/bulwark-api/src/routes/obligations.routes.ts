import type { FastifyInstance } from 'fastify';
import {
  bulwarkPatchObligationSchema,
  bulwarkTriggerObligationSchema,
  bulwarkListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import * as obligations from '../services/obligations.service.js';

export default async function obligationRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/obligations',
    { preHandler: [requireAuth, can('bulwark.obligation.read')] },
    async (request) => {
      const q = request.query as {
        cursor?: string;
        limit?: string;
        sort?: string;
        filter?: Record<string, string>;
      };
      const parsed = bulwarkListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      return obligations.listObligations(readViewer(request), {
        cursor: q.cursor,
        limit,
        reviewStatus: q.filter?.review_status,
        obligationType: q.filter?.obligation_type,
        contractId: q.filter?.contract_id,
        sortByConfidenceDesc: q.sort === '-confidence',
      });
    },
  );

  fastify.get(
    '/obligations/:id',
    { preHandler: [requireAuth, can('bulwark.obligation.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const data = await obligations.getObligation(readViewer(request), id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/obligations/:id',
    { preHandler: [requireAuth, can('bulwark.obligation.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bulwarkPatchObligationSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const data = await obligations.patchObligation(viewerOf(request), id, parsed.data);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/obligations/:id/trigger',
    { preHandler: [requireAuth, can('bulwark.deadline.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bulwarkTriggerObligationSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const data = await obligations.triggerObligation(
          viewerOf(request),
          id,
          parsed.data.occurred_at,
        );
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
