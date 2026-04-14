import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import * as campaignService from '../services/campaign.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { buildCampaignEventPayload } from '../lib/enrich-campaign-event.js';

const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  template_id: z.string().uuid().optional(),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  plain_text_body: z.string().optional(),
  segment_id: z.string().uuid().optional(),
  from_name: z.string().max(100).regex(/^[^\r\n]*$/, 'from_name must not contain line breaks').optional(),
  from_email: z.string().email().max(255).optional(),
  reply_to_email: z.string().email().max(255).optional(),
});

const updateCampaignSchema = createCampaignSchema.partial();

const scheduleCampaignSchema = z.object({
  scheduled_at: z.string().datetime(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const recipientsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export default async function campaignRoutes(fastify: FastifyInstance) {
  // GET /campaigns
  fastify.get(
    '/campaigns',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await campaignService.listCampaigns({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /campaigns
  fastify.post(
    '/campaigns',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createCampaignSchema.parse(request.body);
      const campaign = await campaignService.createCampaign(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1).
      buildCampaignEventPayload({
        campaign,
        orgId: request.user!.org_id,
        actorId: request.user!.id,
      })
        .then((payload) =>
          publishBoltEvent(
            'campaign.created',
            'blast',
            payload,
            request.user!.org_id,
            request.user!.id,
            'user',
          ),
        )
        .catch(() => {
          // Fire-and-forget — never break campaign creation if enrichment fails.
        });
      return reply.status(201).send({ data: campaign });
    },
  );

  // GET /campaigns/:id
  fastify.get<{ Params: { id: string } }>(
    '/campaigns/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const campaign = await campaignService.getCampaign(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: campaign });
    },
  );

  // PATCH /campaigns/:id
  fastify.patch<{ Params: { id: string } }>(
    '/campaigns/:id',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateCampaignSchema.parse(request.body);
      const campaign = await campaignService.updateCampaign(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: campaign });
    },
  );

  // DELETE /campaigns/:id
  fastify.delete<{ Params: { id: string } }>(
    '/campaigns/:id',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      await campaignService.deleteCampaign(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /campaigns/:id/send
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/send',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      const result = await campaignService.sendCampaign(
        request.params.id,
        request.user!.org_id,
      );
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1).
      buildCampaignEventPayload({
        campaign: result,
        orgId: request.user!.org_id,
        actorId: request.user!.id,
      })
        .then((payload) =>
          publishBoltEvent(
            'campaign.sent',
            'blast',
            payload,
            request.user!.org_id,
            request.user!.id,
            'user',
          ),
        )
        .catch(() => {
          // Fire-and-forget — never break campaign send if enrichment fails.
        });
      return reply.send({ data: result });
    },
  );

  // POST /campaigns/:id/schedule
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/schedule',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      const body = scheduleCampaignSchema.parse(request.body);
      const result = await campaignService.scheduleCampaign(
        request.params.id,
        request.user!.org_id,
        body.scheduled_at,
      );
      return reply.send({ data: result });
    },
  );

  // POST /campaigns/:id/pause
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/pause',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      const result = await campaignService.pauseCampaign(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /campaigns/:id/cancel
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/cancel',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      const result = await campaignService.cancelCampaign(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // GET /campaigns/:id/analytics
  fastify.get<{ Params: { id: string } }>(
    '/campaigns/:id/analytics',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await campaignService.getCampaignAnalytics(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // GET /campaigns/:id/recipients
  fastify.get<{ Params: { id: string } }>(
    '/campaigns/:id/recipients',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = recipientsQuerySchema.parse(request.query);
      const result = await campaignService.getCampaignRecipients(
        request.params.id,
        request.user!.org_id,
        query.limit,
        query.offset,
      );
      return reply.send(result);
    },
  );
}
