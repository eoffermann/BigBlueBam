import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as senderDomainService from '../services/sender-domain.service.js';

const addDomainSchema = z.object({
  domain: z.string().min(3).max(255).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Invalid domain format'),
});

export default async function senderDomainRoutes(fastify: FastifyInstance) {
  // GET /sender-domains
  fastify.get(
    '/sender-domains',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const domains = await senderDomainService.listSenderDomains(request.user!.org_id);
      return reply.send({ data: domains });
    },
  );

  // POST /sender-domains
  fastify.post(
    '/sender-domains',
    { preHandler: [requireAuth, fastify.requireCan('blast.sender_domain.create'), requireScope('admin')] },
    async (request, reply) => {
      const body = addDomainSchema.parse(request.body);
      const domain = await senderDomainService.addSenderDomain(
        request.user!.org_id,
        body.domain,
      );
      return reply.status(201).send({ data: domain });
    },
  );

  // POST /sender-domains/:id/verify
  fastify.post<{ Params: { id: string } }>(
    '/sender-domains/:id/verify',
    { preHandler: [requireAuth, fastify.requireCan('blast.sender_domain.verify')] },
    async (request, reply) => {
      const result = await senderDomainService.verifySenderDomain(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // DELETE /sender-domains/:id
  fastify.delete<{ Params: { id: string } }>(
    '/sender-domains/:id',
    { preHandler: [requireAuth, fastify.requireCan('blast.sender_domain.delete'), requireScope('admin')] },
    async (request, reply) => {
      await senderDomainService.removeSenderDomain(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: { deleted: true } });
    },
  );
}
