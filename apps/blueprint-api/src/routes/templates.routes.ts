import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import * as svc from '../services/template.service.js';

export default async function templateRoutes(fastify: FastifyInstance) {
  fastify.get('/templates', { preHandler: [requireAuth] }, async (request, reply) => {
    const rows = await svc.listTemplates(request.user!.org_id);
    return reply.send({ data: rows });
  });
}
