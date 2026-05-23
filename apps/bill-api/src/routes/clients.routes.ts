import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as clientService from '../services/client.service.js';

const createClientSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  tax_id: z.string().max(50).optional(),
  bond_company_id: z.string().uuid().optional(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_payment_instructions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
});

const updateClientSchema = createClientSchema.partial();

const listQuerySchema = z.object({
  search: z.string().optional(),
});

export default async function clientRoutes(fastify: FastifyInstance) {
  // GET /clients
  fastify.get(
    '/clients',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await clientService.listClients({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /clients
  fastify.post(
    '/clients',
    { preHandler: [requireAuth, fastify.requireCan('bill.client.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createClientSchema.parse(request.body);
      const client = await clientService.createClient(body, request.user!.org_id, request.user!.id);
      return reply.status(201).send({ data: client });
    },
  );

  // GET /clients/:id
  fastify.get<{ Params: { id: string } }>(
    '/clients/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const client = await clientService.getClient(request.params.id, request.user!.org_id);
      return reply.send({ data: client });
    },
  );

  // PATCH /clients/:id
  fastify.patch<{ Params: { id: string } }>(
    '/clients/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.client.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateClientSchema.parse(request.body);
      const client = await clientService.updateClient(request.params.id, request.user!.org_id, body);
      return reply.send({ data: client });
    },
  );

  // DELETE /clients/:id
  fastify.delete<{ Params: { id: string } }>(
    '/clients/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.client.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await clientService.deleteClient(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );
}
