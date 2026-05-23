import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as dealService from '../services/deal.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createDealSchema = z.object({
  name: z.string().min(1).max(255),
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  description: z.string().max(5000).optional(),
  value: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  expected_close_date: z.string().optional(), // ISO date string
  probability_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const updateDealSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  value: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  expected_close_date: z.string().optional(),
  probability_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const moveStageSchema = z.object({
  stage_id: z.string().uuid(),
});

const closeWonSchema = z.object({
  close_reason: z.string().max(2000).optional(),
});

const closeLostSchema = z.object({
  close_reason: z.string().max(2000).optional(),
  lost_to_competitor: z.string().max(255).optional(),
});

const addContactSchema = z.object({
  contact_id: z.string().uuid(),
  role: z.string().max(60).optional(),
});

const listQuerySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  value_min: z.coerce.number().int().optional(),
  value_max: z.coerce.number().int().optional(),
  expected_close_after: z.string().optional(),
  expected_close_before: z.string().optional(),
  stale: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function dealRoutes(fastify: FastifyInstance) {
  // GET /deals — List deals
  fastify.get(
    '/deals',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      // "Own only" visibility: members and viewers only see deals they own
      const role = request.user!.role;
      const isRestrictedRole = role === 'member' || role === 'viewer';
      const result = await dealService.listDeals({
        organization_id: request.user!.org_id,
        ...query,
        include_deleted: query.include_deleted === 'true',
        visibility_owner_id: isRestrictedRole ? request.user!.id : undefined,
      });
      return reply.send(result);
    },
  );

  // POST /deals — Create deal
  fastify.post(
    '/deals',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.deal.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createDealSchema.parse(request.body);
      const deal = await dealService.createDeal(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: deal });
    },
  );

  // GET /deals/:id — Get deal detail
  fastify.get<{ Params: { id: string } }>(
    '/deals/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const role = request.user!.role;
      const isRestrictedRole = role === 'member' || role === 'viewer';
      const deal = await dealService.getDeal(
        request.params.id,
        request.user!.org_id,
        isRestrictedRole ? request.user!.id : undefined,
      );
      return reply.send({ data: deal });
    },
  );

  // PATCH /deals/:id — Update deal
  fastify.patch<{ Params: { id: string } }>(
    '/deals/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateDealSchema.parse(request.body);
      const deal = await dealService.updateDeal(
        request.params.id,
        request.user!.org_id,
        body,
        request.user!.id,
      );
      return reply.send({ data: deal });
    },
  );

  // DELETE /deals/:id — Delete deal (soft-delete via deleted_at)
  fastify.delete<{ Params: { id: string } }>(
    '/deals/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await dealService.deleteDeal(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /deals/:id/restore — Undelete a soft-deleted deal (G4)
  fastify.post<{ Params: { id: string } }>(
    '/deals/:id/restore',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const deal = await dealService.restoreDeal(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: deal });
    },
  );

  // PATCH /deals/:id/stage — Move deal to new stage
  fastify.patch<{ Params: { id: string } }>(
    '/deals/:id/stage',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal_stage.move'), requireScope('read_write')] },
    async (request, reply) => {
      const body = moveStageSchema.parse(request.body);
      const deal = await dealService.moveDealStage(
        request.params.id,
        request.user!.org_id,
        body.stage_id,
        request.user!.id,
      );
      return reply.send({ data: deal });
    },
  );

  // POST /deals/:id/won — Close deal won
  fastify.post<{ Params: { id: string } }>(
    '/deals/:id/won',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal_won.close'), requireScope('read_write')] },
    async (request, reply) => {
      const body = closeWonSchema.parse(request.body ?? {});
      const deal = await dealService.closeDealWon(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
        body.close_reason,
      );
      return reply.send({ data: deal });
    },
  );

  // POST /deals/:id/lost — Close deal lost
  fastify.post<{ Params: { id: string } }>(
    '/deals/:id/lost',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal_lost.close'), requireScope('read_write')] },
    async (request, reply) => {
      const body = closeLostSchema.parse(request.body ?? {});
      const deal = await dealService.closeDealLost(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
        body.close_reason,
        body.lost_to_competitor,
      );
      return reply.send({ data: deal });
    },
  );

  // POST /deals/:id/duplicate — Duplicate deal
  fastify.post<{ Params: { id: string } }>(
    '/deals/:id/duplicate',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal.duplicate'), requireScope('read_write')] },
    async (request, reply) => {
      const deal = await dealService.duplicateDeal(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: deal });
    },
  );

  // GET /deals/:id/contacts — List deal contacts
  fastify.get<{ Params: { id: string } }>(
    '/deals/:id/contacts',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const contacts = await dealService.listDealContacts(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: contacts });
    },
  );

  // POST /deals/:id/contacts — Add contact to deal
  fastify.post<{ Params: { id: string } }>(
    '/deals/:id/contacts',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal_contact.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = addContactSchema.parse(request.body);
      const link = await dealService.addDealContact(
        request.params.id,
        body.contact_id,
        request.user!.org_id,
        body.role,
      );
      return reply.status(201).send({ data: link });
    },
  );

  // DELETE /deals/:id/contacts/:contactId — Remove contact from deal
  fastify.delete<{ Params: { id: string; contactId: string } }>(
    '/deals/:id/contacts/:contactId',
    { preHandler: [requireAuth, fastify.requireCan('bond.deal_contact.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await dealService.removeDealContact(
        request.params.id,
        request.params.contactId,
        request.user!.org_id,
      );
      return reply.send({ data: { deleted: true } });
    },
  );

  // GET /deals/:id/stage-history — Stage transition history
  fastify.get<{ Params: { id: string } }>(
    '/deals/:id/stage-history',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const role = request.user!.role;
      const isRestrictedRole = role === 'member' || role === 'viewer';
      const history = await dealService.getDealStageHistory(
        request.params.id,
        request.user!.org_id,
        isRestrictedRole ? request.user!.id : undefined,
      );
      return reply.send({ data: history });
    },
  );

  // GET /deals/:id/activities — Activity timeline for a deal
  fastify.get<{ Params: { id: string } }>(
    '/deals/:id/activities',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      // Import activity service inline to avoid circular deps
      const { listActivities } = await import('../services/activity.service.js');
      const result = await listActivities({
        organization_id: request.user!.org_id,
        deal_id: request.params.id,
      });
      return reply.send(result);
    },
  );

  // GET /deals/:id/related — Cross-product links for a deal
  // Aggregates related records from Bill (invoices), Book (events), and
  // Bam (tasks). Each source is best-effort: if an internal service call
  // fails, that section returns an empty array.
  fastify.get<{ Params: { id: string } }>(
    '/deals/:id/related',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const dealId = request.params.id;
      const orgId = request.user!.org_id;
      const role = request.user!.role;
      const isRestrictedRole = role === 'member' || role === 'viewer';

      // Verify the deal exists and belongs to the caller's org. Restricted
      // roles (member/viewer/guest) only see deals they own; the same rule
      // the list endpoint enforces via visibility_owner_id.
      const deal = await dealService.getDeal(
        dealId,
        orgId,
        isRestrictedRole ? request.user!.id : undefined,
      );
      if (!deal) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Deal not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const { env } = await import('../env.js');
      const cookieHeader = request.headers.cookie ?? '';
      const internalHeaders: Record<string, string> = {
        cookie: cookieHeader,
      };
      if (env.INTERNAL_SERVICE_SECRET) {
        internalHeaders['x-internal-secret'] = env.INTERNAL_SERVICE_SECRET;
      }

      // Fetch related invoices from Bill API
      const invoicesPromise = (async () => {
        try {
          const url = `${env.BBB_API_INTERNAL_URL}/internal/bill/invoices?bond_deal_id=${dealId}`;
          const res = await fetch(url, {
            headers: internalHeaders,
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [];
          const body = (await res.json()) as { data?: unknown[] };
          return body.data ?? [];
        } catch {
          return [];
        }
      })();

      // Fetch related Book events via internal query
      const eventsPromise = (async () => {
        try {
          const url = `${env.BBB_API_INTERNAL_URL}/internal/book/events?linked_entity_type=bond_deal&linked_entity_id=${dealId}`;
          const res = await fetch(url, {
            headers: internalHeaders,
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [];
          const body = (await res.json()) as { data?: unknown[] };
          return body.data ?? [];
        } catch {
          return [];
        }
      })();

      // Fetch related Bam tasks (custom_fields->>'bond_deal_id' = dealId)
      const tasksPromise = (async () => {
        try {
          const url = `${env.BBB_API_INTERNAL_URL}/internal/bond/tasks?bond_deal_id=${dealId}`;
          const res = await fetch(url, {
            headers: internalHeaders,
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [];
          const body = (await res.json()) as { data?: unknown[] };
          return body.data ?? [];
        } catch {
          return [];
        }
      })();

      const [invoices, events, tasks] = await Promise.all([
        invoicesPromise,
        eventsPromise,
        tasksPromise,
      ]);

      return reply.send({
        data: { invoices, events, tasks },
      });
    },
  );
}
