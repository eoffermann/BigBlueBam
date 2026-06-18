import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as recurringService from '../services/recurring-invoice.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { loadActor, loadCustomer, loadOrg, buildInvoiceUrl } from '../lib/bolt-event-enrich.js';

const cadenceEnum = z.enum(['weekly', 'monthly', 'quarterly', 'annually']);

const lineItemSchema = z.object({
  description: z.string().min(1).max(1000),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int().min(0),
});

const createSchema = z.object({
  client_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  cadence: cadenceEnum,
  auto_finalize: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  discount_amount: z.number().int().min(0).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  payment_instructions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  footer_text: z.string().max(2000).optional(),
  terms_text: z.string().max(5000).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  next_run_at: z.string().optional(),
  line_items: z.array(lineItemSchema).optional(),
});

const updateSchema = createSchema.partial();

const listQuerySchema = z.object({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
});

/**
 * Publish the recurring.invoice_generated Bolt event for a freshly-materialised
 * invoice. Best-effort enrichment, fire-and-forget — never blocks the route.
 */
async function emitGeneratedEvent(
  orgId: string,
  actorId: string,
  actorType: 'user' | 'system',
  scheduleId: string,
  scheduleName: string,
  clientId: string,
  result: recurringService.GenerateResult,
) {
  const [actor, org, customer] = await Promise.all([
    loadActor(actorId),
    loadOrg(orgId),
    loadCustomer(clientId, orgId),
  ]);
  publishBoltEvent(
    'recurring.invoice_generated',
    'bill',
    {
      schedule: { id: scheduleId, name: scheduleName },
      invoice: {
        id: result.invoice_id,
        number: result.invoice_number,
        status: result.status,
        customer_id: clientId,
        customer_name: customer.name,
        customer_email: customer.email,
        url: buildInvoiceUrl(result.invoice_id),
      },
      next_run_at: result.next_run_at,
      actor: { id: actor.id, name: actor.name, email: actor.email },
      org: { id: org.id, name: org.name, slug: org.slug },
    },
    orgId,
    actorType === 'user' ? actorId : undefined,
    actorType,
  );
}

export default async function recurringInvoiceRoutes(fastify: FastifyInstance) {
  // GET /recurring-invoices
  fastify.get(
    '/recurring-invoices',
    { preHandler: [requireAuth, fastify.requireCan('bill.recurring_invoice.list')] },
    async (request, reply) => {
      const { status } = listQuerySchema.parse(request.query);
      const result = await recurringService.listRecurring(request.user!.org_id, status);
      return reply.send(result);
    },
  );

  // POST /recurring-invoices
  fastify.post(
    '/recurring-invoices',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.create'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const schedule = await recurringService.createRecurring(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: schedule });
    },
  );

  // GET /recurring-invoices/:id
  fastify.get<{ Params: { id: string } }>(
    '/recurring-invoices/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.recurring_invoice.get')] },
    async (request, reply) => {
      const schedule = await recurringService.getRecurring(request.params.id, request.user!.org_id);
      return reply.send({ data: schedule });
    },
  );

  // PATCH /recurring-invoices/:id
  fastify.patch<{ Params: { id: string } }>(
    '/recurring-invoices/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.update'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const body = updateSchema.parse(request.body);
      const schedule = await recurringService.updateRecurring(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: schedule });
    },
  );

  // POST /recurring-invoices/:id/pause
  fastify.post<{ Params: { id: string } }>(
    '/recurring-invoices/:id/pause',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.pause'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const schedule = await recurringService.pauseRecurring(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: schedule });
    },
  );

  // POST /recurring-invoices/:id/resume
  fastify.post<{ Params: { id: string } }>(
    '/recurring-invoices/:id/resume',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.resume'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const schedule = await recurringService.resumeRecurring(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: schedule });
    },
  );

  // POST /recurring-invoices/:id/cancel
  fastify.post<{ Params: { id: string } }>(
    '/recurring-invoices/:id/cancel',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.cancel'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const schedule = await recurringService.cancelRecurring(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: schedule });
    },
  );

  // POST /recurring-invoices/:id/generate-now
  fastify.post<{ Params: { id: string } }>(
    '/recurring-invoices/:id/generate-now',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.recurring_invoice.generate_now'),
        requireScope('read_write'),
      ],
    },
    async (request, reply) => {
      const schedule = await recurringService.getRecurring(
        request.params.id,
        request.user!.org_id,
      );
      const result = await recurringService.generateInvoiceFromSchedule(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
        fastify.redis,
      );
      await emitGeneratedEvent(
        request.user!.org_id,
        request.user!.id,
        'user',
        schedule.id,
        schedule.name,
        schedule.client_id,
        result,
      );
      return reply.status(201).send({ data: result });
    },
  );
}
