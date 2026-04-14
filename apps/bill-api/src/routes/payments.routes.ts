import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import * as paymentService from '../services/payment.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  buildInvoiceUrl,
  buildInvoicePdfUrl,
  buildPaymentUrl,
  loadActor,
  loadCustomer,
  loadInvoiceById,
  loadOrg,
} from '../lib/bolt-event-enrich.js';

const recordPaymentSchema = z.object({
  amount: z.number().int().positive(),
  payment_method: z
    .enum(['bank_transfer', 'credit_card', 'check', 'cash', 'stripe', 'paypal', 'other'])
    .optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export default async function paymentRoutes(fastify: FastifyInstance) {
  // POST /invoices/:id/payments
  fastify.post<{ Params: { id: string } }>(
    '/invoices/:id/payments',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      const body = recordPaymentSchema.parse(request.body);
      const payment = await paymentService.recordPayment(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
        body,
      );
      // Reload the invoice to capture post-payment totals/status and fetch
      // related entities in parallel for the enriched event payload.
      const [invoice, actor, org] = await Promise.all([
        loadInvoiceById(request.params.id),
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
      ]);
      const customer = invoice
        ? await loadCustomer(invoice.client_id, request.user!.org_id)
        : { id: '', name: null, email: null, company_id: null };
      const remainingBalance = invoice
        ? Math.max(0, Number(invoice.total) - Number(invoice.amount_paid))
        : 0;
      const isFullPayment = invoice ? Number(invoice.amount_paid) >= Number(invoice.total) : false;
      publishBoltEvent(
        'payment.recorded',
        'bill',
        {
          payment: {
            id: payment.id,
            invoice_id: request.params.id,
            amount: payment.amount,
            currency: invoice?.currency ?? 'USD',
            method: payment.payment_method ?? null,
            reference: payment.reference ?? null,
            received_at: payment.paid_at,
            is_full_payment: isFullPayment,
            remaining_balance: remainingBalance,
            url: buildPaymentUrl(request.params.id, payment.id),
          },
          invoice: invoice
            ? {
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
                total: invoice.total,
                amount_paid: invoice.amount_paid,
                currency: invoice.currency,
                due_date: invoice.due_date,
                url: buildInvoiceUrl(invoice.id),
                pdf_url: buildInvoicePdfUrl(invoice.public_view_token),
              }
            : { id: request.params.id },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
        'user',
      );
      return reply.status(201).send({ data: payment });
    },
  );

  // DELETE /payments/:id
  fastify.delete<{ Params: { id: string } }>(
    '/payments/:id',
    { preHandler: [requireAuth, requireMinRole('admin'), requireScope('read_write')] },
    async (request, reply) => {
      await paymentService.deletePayment(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );
}
