import type { FastifyInstance } from 'fastify';
import {
  bulwarkPatchObligationSchema,
  bulwarkTriggerObligationSchema,
  bulwarkListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
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
        // Layer the asker preflight on top of the bearer's project-scope guard (SH1, Braid #60):
        // when an agent acts for a human, the source-scoped project-membership narrowing must
        // run against the ASKER too, not just the admin-bearer. A denied asker fails closed
        // (NotFound -> 404), exactly as the read plane resolves nothing.
        const asker = askerViewer(request);
        if (asker) await obligations.loadScopedObligation(asker, id);
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
        // Asker preflight layered on top of the bearer guard (SH1, Braid #60): fail closed
        // against the acting human, not just the admin-bearer.
        const asker = askerViewer(request);
        if (asker) await obligations.loadScopedObligation(asker, id);
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
