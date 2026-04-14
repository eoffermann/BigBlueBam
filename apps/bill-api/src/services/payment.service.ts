import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billPayments, billInvoices } from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { recalculateInvoiceTotals } from './invoice.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  buildInvoiceUrl,
  buildInvoicePdfUrl,
  countLineItems,
  loadActor,
  loadCustomer,
  loadOrg,
} from '../lib/bolt-event-enrich.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  amount: number;
  payment_method?: string;
  reference?: string;
  notes?: string;
  paid_at?: string;
}

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

export async function recordPayment(
  invoiceId: string,
  orgId: string,
  userId: string,
  input: RecordPaymentInput,
) {
  const [invoice] = await db
    .select()
    .from(billInvoices)
    .where(and(eq(billInvoices.id, invoiceId), eq(billInvoices.organization_id, orgId)))
    .limit(1);

  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status === 'draft') throw badRequest('Cannot record payment on a draft invoice');
  if (invoice.status === 'void') throw badRequest('Cannot record payment on a voided invoice');

  // BILL-004: Validate that payment does not exceed remaining balance
  const remaining = Number(invoice.total) - Number(invoice.amount_paid);
  if (input.amount > remaining) {
    throw badRequest(
      `Payment amount (${input.amount}) exceeds remaining balance (${remaining})`,
    );
  }

  const [payment] = await db
    .insert(billPayments)
    .values({
      invoice_id: invoiceId,
      organization_id: orgId,
      amount: input.amount,
      payment_method: input.payment_method,
      reference: input.reference,
      notes: input.notes,
      paid_at: input.paid_at ?? new Date().toISOString().split('T')[0]!,
      recorded_by: userId,
    })
    .returning();

  // Recalculate and update invoice status
  await recalculateInvoiceTotals(invoiceId);

  // Reload invoice to check if fully paid
  const [updated] = await db
    .select()
    .from(billInvoices)
    .where(eq(billInvoices.id, invoiceId))
    .limit(1);

  if (updated && updated.amount_paid >= updated.total) {
    const paidAt = new Date();
    await db
      .update(billInvoices)
      .set({ status: 'paid', paid_at: paidAt, updated_at: paidAt })
      .where(eq(billInvoices.id, invoiceId));
    // Fetch related entities in parallel for enriched event payload.
    const [actor, org, customer, lineItemCount] = await Promise.all([
      loadActor(userId),
      loadOrg(orgId),
      loadCustomer(updated.client_id, orgId),
      countLineItems(invoiceId),
    ]);
    publishBoltEvent(
      'invoice.paid',
      'bill',
      {
        invoice: {
          id: invoiceId,
          number: updated.invoice_number,
          status: 'paid',
          customer_id: updated.client_id,
          customer_name: customer.name,
          customer_email: customer.email,
          company_id: customer.company_id,
          company_name: customer.name,
          project_id: updated.project_id,
          deal_id: updated.bond_deal_id,
          total: updated.total,
          amount_paid: updated.amount_paid,
          currency: updated.currency,
          issue_date: updated.invoice_date,
          due_date: updated.due_date,
          line_item_count: lineItemCount,
          url: buildInvoiceUrl(invoiceId),
          pdf_url: buildInvoicePdfUrl(updated.public_view_token),
          paid_at: paidAt.toISOString(),
        },
        actor: { id: actor.id, name: actor.name, email: actor.email },
        org: { id: org.id, name: org.name, slug: org.slug },
      },
      orgId,
      userId,
      'user',
    );
  } else if (updated && updated.amount_paid > 0) {
    await db
      .update(billInvoices)
      .set({ status: 'partially_paid', updated_at: new Date() })
      .where(eq(billInvoices.id, invoiceId));
  }

  return payment!;
}

// ---------------------------------------------------------------------------
// Delete payment
// ---------------------------------------------------------------------------

export async function deletePayment(paymentId: string, orgId: string) {
  const [payment] = await db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, paymentId), eq(billPayments.organization_id, orgId)))
    .limit(1);

  if (!payment) throw notFound('Payment not found');

  const [deleted] = await db
    .delete(billPayments)
    .where(eq(billPayments.id, paymentId))
    .returning({ id: billPayments.id, invoice_id: billPayments.invoice_id });

  if (!deleted) throw notFound('Payment not found');

  await recalculateInvoiceTotals(deleted.invoice_id);

  return deleted;
}
