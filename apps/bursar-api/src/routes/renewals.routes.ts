import type { FastifyInstance } from 'fastify';
import { bursarRenewalDecideSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import * as renewals from '../services/renewals.service.js';

// Renewal radar routes (spec 8 detector 4, 11, M8). Read is bursar.renewal.read; decide is
// bursar.renewal.decide. No money fields, so no financial floor projection is needed.
export default async function renewalRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/renewals', { preHandler: [requireAuth, can('bursar.renewal.read')] }, async (request) => {
    const q = request.query as { filter?: Record<string, string> };
    return renewals.listRenewals(viewerOf(request), q.filter?.status);
  });

  fastify.post('/renewals/:id/decide', { preHandler: [requireAuth, can('bursar.renewal.decide')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarRenewalDecideSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await renewals.decideRenewal(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}
