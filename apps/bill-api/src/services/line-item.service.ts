import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billLineItems, billInvoices } from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { recalculateInvoiceTotals } from './invoice.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateLineItemInput {
  description: string;
  quantity?: number;
  unit?: string;
  unit_price: number;
  sort_order?: number;
  time_entry_ids?: string[];
  task_id?: string;
  /**
   * The human authority a SERVICE-TO-SERVICE write acted under (Burn spec 2.4 point 11).
   * Set only by POST /internal/invoices/:id/line-items. NULL on the session path, where
   * request.user is already the recorded actor. Arrives in the request body, never in a
   * header: a trusted acting-user header would turn one leaked internal secret into
   * impersonation of every user in the org.
   */
  acting_user_id?: string;
}

export interface UpdateLineItemInput {
  description?: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
  sort_order?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDraftInvoice(invoiceId: string, orgId: string) {
  const [invoice] = await db
    .select({ status: billInvoices.status, organization_id: billInvoices.organization_id })
    .from(billInvoices)
    .where(and(eq(billInvoices.id, invoiceId), eq(billInvoices.organization_id, orgId)))
    .limit(1);

  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status !== 'draft') {
    throw badRequest('Can only modify line items on draft invoices');
  }
}

// ---------------------------------------------------------------------------
// Add line item
// ---------------------------------------------------------------------------

export async function addLineItem(
  invoiceId: string,
  orgId: string,
  input: CreateLineItemInput,
) {
  await ensureDraftInvoice(invoiceId, orgId);

  const quantity = input.quantity ?? 1;
  const amount = Math.round(quantity * input.unit_price);

  const [item] = await db
    .insert(billLineItems)
    .values({
      invoice_id: invoiceId,
      sort_order: input.sort_order ?? 0,
      description: input.description,
      quantity: String(quantity),
      unit: input.unit ?? 'hours',
      unit_price: input.unit_price,
      amount,
      time_entry_ids: input.time_entry_ids,
      task_id: input.task_id,
      acting_user_id: input.acting_user_id ?? null,
    })
    .returning();

  await recalculateInvoiceTotals(invoiceId);

  return item!;
}

// ---------------------------------------------------------------------------
// Update line item
// ---------------------------------------------------------------------------

export async function updateLineItem(
  invoiceId: string,
  itemId: string,
  orgId: string,
  input: UpdateLineItemInput,
) {
  await ensureDraftInvoice(invoiceId, orgId);

  const [existing] = await db
    .select()
    .from(billLineItems)
    .where(and(eq(billLineItems.id, itemId), eq(billLineItems.invoice_id, invoiceId)))
    .limit(1);

  if (!existing) throw notFound('Line item not found');

  const quantity = input.quantity ?? Number(existing.quantity);
  const unitPrice = input.unit_price ?? existing.unit_price;
  const amount = Math.round(quantity * unitPrice);

  const updateData: Record<string, unknown> = { amount };
  if (input.description !== undefined) updateData.description = input.description;
  if (input.quantity !== undefined) updateData.quantity = String(input.quantity);
  if (input.unit !== undefined) updateData.unit = input.unit;
  if (input.unit_price !== undefined) updateData.unit_price = input.unit_price;
  if (input.sort_order !== undefined) updateData.sort_order = input.sort_order;

  const [updated] = await db
    .update(billLineItems)
    .set(updateData)
    .where(and(eq(billLineItems.id, itemId), eq(billLineItems.invoice_id, invoiceId)))
    .returning();

  if (!updated) throw notFound('Line item not found');

  await recalculateInvoiceTotals(invoiceId);

  return updated;
}

// ---------------------------------------------------------------------------
// Delete line item
// ---------------------------------------------------------------------------

export async function deleteLineItem(invoiceId: string, itemId: string, orgId: string) {
  await ensureDraftInvoice(invoiceId, orgId);

  const [deleted] = await db
    .delete(billLineItems)
    .where(and(eq(billLineItems.id, itemId), eq(billLineItems.invoice_id, invoiceId)))
    .returning({ id: billLineItems.id });

  if (!deleted) throw notFound('Line item not found');

  await recalculateInvoiceTotals(invoiceId);

  return deleted;
}
