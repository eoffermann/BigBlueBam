import type { FastifyInstance } from 'fastify';
import { bulwarkCreateVendorTierSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import * as vendorTiers from '../services/vendor-tiers.service.js';

export default async function vendorTierRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/vendor-tiers',
    { preHandler: [requireAuth, can('bulwark.compliance.read')] },
    async (request) => {
      const q = request.query as { filter?: Record<string, string> };
      const data = await vendorTiers.listVendorTiers(readViewer(request), {
        contractId: q.filter?.contract_id,
        chaseStatus: q.filter?.chase_status,
      });
      return { data };
    },
  );

  fastify.post(
    '/vendor-tiers',
    { preHandler: [requireAuth, can('bulwark.compliance.chase')] },
    async (request, reply) => {
      const parsed = bulwarkCreateVendorTierSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const data = await vendorTiers.createVendorTier(viewerOf(request), parsed.data);
        return reply.status(201).send({ data });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
