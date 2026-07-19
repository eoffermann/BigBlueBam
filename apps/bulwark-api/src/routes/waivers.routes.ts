import type { FastifyInstance } from 'fastify';
import { bulwarkListQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { readViewer } from '../lib/http.js';
import * as waivers from '../services/waivers.service.js';

export default async function waiverRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/waiver-risks',
    { preHandler: [requireAuth, can('bulwark.deadline.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = bulwarkListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      return waivers.listWaiverRisks(readViewer(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
        contractId: q.filter?.contract_id,
      });
    },
  );
}
