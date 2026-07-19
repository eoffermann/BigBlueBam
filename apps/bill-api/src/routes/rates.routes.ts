import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as rateService from '../services/rate.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { loadActor, loadOrg } from '../lib/bolt-event-enrich.js';

/**
 * Bill rates are the ONE input Burn's valuation shares with Bill's own invoices, so a rate
 * write has to be observable: `burn-revalue` reprices existing work items on it. Publishing
 * the event here (rather than having Burn poll) is what makes revaluation event-driven.
 * Payload carries the rate row's own figures, which are already Bill-tier data.
 */
async function publishRateEvent(
  eventType: 'rate.created' | 'rate.updated',
  rate: {
    id: string;
    project_id: string | null;
    user_id: string | null;
    rate_amount: number;
    rate_type: string | null;
    currency: string | null;
    effective_from: string;
    effective_to: string | null;
  },
  orgId: string,
  actorId: string,
): Promise<void> {
  const [actor, org] = await Promise.all([loadActor(actorId), loadOrg(orgId)]);
  publishBoltEvent(
    eventType,
    'bill',
    {
      rate: {
        id: rate.id,
        project_id: rate.project_id,
        user_id: rate.user_id,
        rate_amount: rate.rate_amount,
        rate_type: rate.rate_type,
        currency: rate.currency,
        effective_from: rate.effective_from,
        effective_to: rate.effective_to,
      },
      actor: { id: actor.id, name: actor.name, email: actor.email },
      org: { id: org.id, name: org.name, slug: org.slug },
    },
    orgId,
    actorId,
  );
}

const createRateSchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  rate_amount: z.number().int().positive(),
  rate_type: z.enum(['hourly', 'daily', 'fixed']).optional(),
  currency: z.string().length(3).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const updateRateSchema = z.object({
  rate_amount: z.number().int().positive().optional(),
  rate_type: z.enum(['hourly', 'daily', 'fixed']).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const listQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

const resolveQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export default async function rateRoutes(fastify: FastifyInstance) {
  // GET /rates
  fastify.get(
    '/rates',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await rateService.listRates({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /rates
  fastify.post(
    '/rates',
    { preHandler: [requireAuth, fastify.requireCan('bill.rate.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createRateSchema.parse(request.body);
      const rate = await rateService.createRate(body, request.user!.org_id);
      await publishRateEvent('rate.created', rate, request.user!.org_id, request.user!.id);
      return reply.status(201).send({ data: rate });
    },
  );

  // PATCH /rates/:id
  fastify.patch<{ Params: { id: string } }>(
    '/rates/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.rate.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateRateSchema.parse(request.body);
      const rate = await rateService.updateRate(request.params.id, request.user!.org_id, body);
      await publishRateEvent('rate.updated', rate, request.user!.org_id, request.user!.id);
      return reply.send({ data: rate });
    },
  );

  // DELETE /rates/:id
  fastify.delete<{ Params: { id: string } }>(
    '/rates/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.rate.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await rateService.deleteRate(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // GET /rates/resolve
  fastify.get(
    '/rates/resolve',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = resolveQuerySchema.parse(request.query);
      const result = await rateService.resolveRate(
        request.user!.org_id,
        query.project_id,
        query.user_id,
        query.date,
      );
      return reply.send(result);
    },
  );
}
