import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as invoiceService from '../services/invoice.service.js';
import * as lineItemService from '../services/line-item.service.js';
import * as pdfService from '../services/pdf.service.js';
import * as workerJobService from '../services/worker-job.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import {
  buildInvoiceUrl,
  buildInvoicePdfUrl,
  countLineItems,
  loadActor,
  loadCustomer,
  loadOrg,
} from '../lib/bolt-event-enrich.js';

const createInvoiceSchema = z.object({
  client_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  discount_amount: z.number().int().min(0).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  payment_instructions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  footer_text: z.string().max(2000).optional(),
  terms_text: z.string().max(5000).optional(),
  bond_deal_id: z.string().uuid().optional(),
});

const updateInvoiceSchema = createInvoiceSchema.partial();

const listQuerySchema = z.object({
  status: z.string().optional(),
  client_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

const createLineItemSchema = z.object({
  description: z.string().min(1).max(1000),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int().min(0),
  sort_order: z.number().int().optional(),
  time_entry_ids: z.array(z.string().uuid()).optional(),
  task_id: z.string().uuid().optional(),
});

const updateLineItemSchema = z.object({
  description: z.string().min(1).max(1000).optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int().min(0).optional(),
  sort_order: z.number().int().optional(),
});

export default async function invoiceRoutes(fastify: FastifyInstance) {
  // GET /invoices
  fastify.get(
    '/invoices',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await invoiceService.listInvoices({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /invoices
  fastify.post(
    '/invoices',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createInvoiceSchema.parse(request.body);
      const invoice = await invoiceService.createInvoice(body, request.user!.org_id, request.user!.id);
      // Fetch related entities in parallel for enriched event payload.
      const [actor, org, customer, lineItemCount] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadCustomer(invoice.client_id, request.user!.org_id),
        countLineItems(invoice.id),
      ]);
      publishBoltEvent(
        'invoice.created',
        'bill',
        {
          invoice: {
            id: invoice.id,
            number: invoice.invoice_number,
            status: invoice.status,
            customer_id: invoice.client_id,
            customer_name: customer.name,
            customer_email: customer.email,
            company_id: customer.company_id,
            company_name: customer.name,
            project_id: invoice.project_id,
            deal_id: invoice.bond_deal_id,
            subtotal: invoice.subtotal,
            tax_amount: invoice.tax_amount,
            discount_amount: invoice.discount_amount,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            issue_date: invoice.invoice_date,
            due_date: invoice.due_date,
            payment_terms_days: invoice.payment_terms_days,
            line_item_count: lineItemCount,
            url: buildInvoiceUrl(invoice.id),
            pdf_url: buildInvoicePdfUrl(invoice.public_view_token),
            source: 'manual',
            created_at: invoice.created_at,
          },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.status(201).send({ data: invoice });
    },
  );

  // GET /invoices/:id
  fastify.get<{ Params: { id: string } }>(
    '/invoices/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const invoice = await invoiceService.getInvoice(request.params.id, request.user!.org_id);
      return reply.send({ data: invoice });
    },
  );

  // PATCH /invoices/:id
  fastify.patch<{ Params: { id: string } }>(
    '/invoices/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateInvoiceSchema.parse(request.body);
      const invoice = await invoiceService.updateInvoice(request.params.id, request.user!.org_id, body);
      return reply.send({ data: invoice });
    },
  );

  // DELETE /invoices/:id
  fastify.delete<{ Params: { id: string } }>(
    '/invoices/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await invoiceService.deleteInvoice(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /invoices/:id/line-items
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/line-items',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_line_item.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createLineItemSchema.parse(request.body);
      const item = await lineItemService.addLineItem(request.params.id, request.user!.org_id, body);
      return reply.status(201).send({ data: item });
    },
  );

  // PATCH /invoices/:id/line-items/:itemId
  fastify.patch<{ Params: { id: string; itemId: string } }>(
    '/invoices/:id/line-items/:itemId',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_line_item.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateLineItemSchema.parse(request.body);
      const item = await lineItemService.updateLineItem(
        request.params.id,
        request.params.itemId,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: item });
    },
  );

  // DELETE /invoices/:id/line-items/:itemId
  fastify.delete<{ Params: { id: string; itemId: string } }>(
    '/invoices/:id/line-items/:itemId',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_line_item.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await lineItemService.deleteLineItem(request.params.id, request.params.itemId, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /invoices/:id/finalize
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/finalize',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.finalize'), requireScope('read_write')] },
    async (request, reply) => {
      const invoice = await invoiceService.finalizeInvoice(
        request.params.id,
        request.user!.org_id,
        fastify.redis,
      );
      // G1: enqueue async PDF generation. Worker handler lives in
      // apps/worker/src/jobs/bill-pdf-generate.job.ts (deferred). Until it
      // lands the row remains in 'pending' status and the SPA surfaces
      // that via latestJobForInvoice so users see "PDF generating...".
      const pdfJob = await workerJobService
        .enqueueWorkerJob({
          organization_id: request.user!.org_id,
          invoice_id: invoice.id,
          job_type: 'pdf_generate',
        })
        .catch(() => null);
      // Fetch related entities in parallel for enriched event payload.
      const [actor, org, customer, lineItemCount] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadCustomer(invoice.client_id, request.user!.org_id),
        countLineItems(invoice.id),
      ]);
      publishBoltEvent(
        'invoice.finalized',
        'bill',
        {
          invoice: {
            id: invoice.id,
            number: invoice.invoice_number,
            status: invoice.status,
            customer_id: invoice.client_id,
            customer_name: customer.name,
            customer_email: customer.email,
            company_id: customer.company_id,
            company_name: customer.name,
            project_id: invoice.project_id,
            deal_id: invoice.bond_deal_id,
            subtotal: invoice.subtotal,
            tax_amount: invoice.tax_amount,
            discount_amount: invoice.discount_amount,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            issue_date: invoice.invoice_date,
            due_date: invoice.due_date,
            payment_terms_days: invoice.payment_terms_days,
            line_item_count: lineItemCount,
            url: buildInvoiceUrl(invoice.id),
            pdf_url: buildInvoicePdfUrl(invoice.public_view_token),
            finalized_at: invoice.sent_at ?? invoice.updated_at,
          },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.send({
        data: invoice,
        pdf_job: pdfJob
          ? { id: pdfJob.id, status: pdfJob.status, job_type: pdfJob.job_type }
          : null,
      });
    },
  );

  // POST /invoices/:id/send
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/send',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.send'), requireScope('read_write')] },
    async (request, reply) => {
      const invoice = await invoiceService.sendInvoice(
        request.params.id,
        request.user!.org_id,
      );
      // G2: enqueue async email delivery. Worker handler lives in
      // apps/worker/src/jobs/bill-email-send.job.ts (deferred). Row sits in
      // 'pending' until the handler picks it up.
      const emailJob = await workerJobService
        .enqueueWorkerJob({
          organization_id: request.user!.org_id,
          invoice_id: invoice.id,
          job_type: 'email_send',
        })
        .catch(() => null);
      // Fetch related entities in parallel for enriched event payload.
      const [actor, org, customer, lineItemCount] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadCustomer(invoice.client_id, request.user!.org_id),
        countLineItems(invoice.id),
      ]);
      publishBoltEvent(
        'invoice.sent',
        'bill',
        {
          invoice: {
            id: invoice.id,
            number: invoice.invoice_number,
            status: invoice.status,
            customer_id: invoice.client_id,
            customer_name: customer.name,
            customer_email: customer.email,
            company_id: customer.company_id,
            company_name: customer.name,
            project_id: invoice.project_id,
            deal_id: invoice.bond_deal_id,
            subtotal: invoice.subtotal,
            tax_amount: invoice.tax_amount,
            discount_amount: invoice.discount_amount,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            issue_date: invoice.invoice_date,
            due_date: invoice.due_date,
            payment_terms_days: invoice.payment_terms_days,
            line_item_count: lineItemCount,
            url: buildInvoiceUrl(invoice.id),
            pdf_url: buildInvoicePdfUrl(invoice.public_view_token),
            sent_at: invoice.sent_at,
          },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.send({
        data: invoice,
        email_job: emailJob
          ? { id: emailJob.id, status: emailJob.status, job_type: emailJob.job_type }
          : null,
      });
    },
  );

  // POST /invoices/:id/void
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/void',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_void.create'), requireScope('read_write')] },
    async (request, reply) => {
      const invoice = await invoiceService.voidInvoice(request.params.id, request.user!.org_id);
      return reply.send({ data: invoice });
    },
  );

  // POST /invoices/:id/duplicate
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/duplicate',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice.duplicate'), requireScope('read_write')] },
    async (request, reply) => {
      const invoice = await invoiceService.duplicateInvoice(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: invoice });
    },
  );

  // GET /invoices/:id/jobs — return the latest async job state for this
  // invoice so the SPA can render "PDF generating..." or "Email queued..."
  // status chips without having to poll BullMQ directly. Callers read both
  // rows in a single request to keep the wire chat low.
  fastify.get<{ Params: { id: string } }>(
    '/invoices/:id/jobs',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const [pdf, email] = await Promise.all([
        workerJobService.latestJobForInvoice(
          request.user!.org_id,
          request.params.id,
          'pdf_generate',
        ),
        workerJobService.latestJobForInvoice(
          request.user!.org_id,
          request.params.id,
          'email_send',
        ),
      ]);
      return reply.send({
        data: {
          pdf_generate: pdf,
          email_send: email,
        },
      });
    },
  );

  // GET /invoices/:id/pdf — generate and return invoice PDF
  fastify.get<{ Params: { id: string } }>(
    '/invoices/:id/pdf',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const pdfBytes = await pdfService.generateInvoicePdf(
        request.params.id,
        request.user!.org_id,
      );

      // Fetch invoice for the filename
      const invoice = await invoiceService.getInvoice(request.params.id, request.user!.org_id);
      const filename = `${invoice.invoice_number === 'DRAFT' ? 'DRAFT' : invoice.invoice_number}.pdf`;

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${filename}"`)
        .header('Content-Length', pdfBytes.length)
        .send(Buffer.from(pdfBytes));
    },
  );

  // POST /invoices/from-time-entries — create invoice from Bam time entries
  const fromTimeEntriesSchema = z.object({
    project_id: z.string().uuid(),
    time_entry_ids: z.array(z.string().uuid()).min(1),
    client_id: z.string().uuid(),
  });

  fastify.post(
    '/invoices/from-time-entries',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_from_time_entry.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = fromTimeEntriesSchema.parse(request.body);
      const invoice = await invoiceService.createInvoiceFromTimeEntries(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: invoice });
    },
  );

  // POST /invoices/from-deal — create draft invoice from a Bond CRM deal
  const fromDealSchema = z.object({
    deal_id: z.string().uuid(),
    client_id: z.string().uuid(),
  });

  fastify.post(
    '/invoices/from-deal',
    { preHandler: [requireAuth, fastify.requireCan('bill.invoice_from_deal.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = fromDealSchema.parse(request.body);
      const invoice = await invoiceService.createInvoiceFromDeal(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      // Fetch related entities in parallel for enriched event payload.
      const [actor, org, customer, lineItemCount] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
        loadCustomer(invoice.client_id, request.user!.org_id),
        countLineItems(invoice.id),
      ]);
      publishBoltEvent(
        'invoice.created',
        'bill',
        {
          invoice: {
            id: invoice.id,
            number: invoice.invoice_number,
            status: invoice.status,
            customer_id: invoice.client_id,
            customer_name: customer.name,
            customer_email: customer.email,
            company_id: customer.company_id,
            company_name: customer.name,
            project_id: invoice.project_id,
            deal_id: invoice.bond_deal_id ?? body.deal_id,
            subtotal: invoice.subtotal,
            tax_amount: invoice.tax_amount,
            discount_amount: invoice.discount_amount,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            issue_date: invoice.invoice_date,
            due_date: invoice.due_date,
            payment_terms_days: invoice.payment_terms_days,
            line_item_count: lineItemCount,
            url: buildInvoiceUrl(invoice.id),
            pdf_url: buildInvoicePdfUrl(invoice.public_view_token),
            source: 'deal',
            created_at: invoice.created_at,
          },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.status(201).send({ data: invoice });
    },
  );
}
