import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as activityService from '../services/activity.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const activityTypes = [
  'note', 'email_sent', 'email_received', 'call', 'meeting', 'task',
  'stage_change', 'deal_created', 'deal_won', 'deal_lost', 'contact_created',
  'form_submission', 'campaign_sent', 'campaign_opened', 'campaign_clicked', 'custom',
] as const;

const createActivitySchema = z.object({
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  activity_type: z.enum(activityTypes),
  subject: z.string().max(255).optional(),
  body: z.string().max(10000).optional(),
  metadata: z.record(z.unknown()).optional(),
  performed_at: z.string().datetime().optional(),
});

const updateActivitySchema = z.object({
  subject: z.string().max(255).optional(),
  body: z.string().max(10000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  activity_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function activityRoutes(fastify: FastifyInstance) {
  // GET /activities — List activities
  fastify.get(
    '/activities',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await activityService.listActivities({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /activities — Create activity
  fastify.post(
    '/activities',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.activity.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createActivitySchema.parse(request.body);
      const activity = await activityService.createActivity(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: activity });
    },
  );

  // GET /activities/:id — Get activity detail
  fastify.get<{ Params: { id: string } }>(
    '/activities/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const activity = await activityService.getActivity(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: activity });
    },
  );

  // PATCH /activities/:id — Update activity
  fastify.patch<{ Params: { id: string } }>(
    '/activities/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.activity.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateActivitySchema.parse(request.body);
      const activity = await activityService.updateActivity(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: activity });
    },
  );

  // DELETE /activities/:id — Delete activity
  fastify.delete<{ Params: { id: string } }>(
    '/activities/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.activity.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await activityService.deleteActivity(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );
}
