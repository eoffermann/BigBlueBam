import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  billRecurringInvoices,
  billRecurringLineItems,
  billInvoices,
  billLineItems,
  billClients,
  billSettings,
} from '../db/schema/index.js';
import type {
  BillRecurringCadence,
  BillRecurringStatus,
} from '../db/schema/bill-recurring-invoices.js';
import { notFound, badRequest } from '../lib/utils.js';
import { reserveInvoiceNumber } from './sequence.service.js';
import { recalculateInvoiceTotals } from './invoice.service.js';
import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Cadence math
// ---------------------------------------------------------------------------

export const CADENCES: BillRecurringCadence[] = ['weekly', 'monthly', 'quarterly', 'annually'];

/**
 * Advance a date by one cadence step. Pure and deterministic. Month/quarter/
 * year steps use calendar arithmetic (so a monthly schedule on the 15th lands
 * on the 15th of each month); weekly adds 7 days. Day-of-month overflow (e.g.
 * Jan 31 + 1 month) clamps to the last valid day of the target month, matching
 * how most billing systems behave.
 */
export function advanceByCadence(from: Date, cadence: BillRecurringCadence): Date {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case 'monthly':
      return addMonthsClamped(d, 1);
    case 'quarterly':
      return addMonthsClamped(d, 3);
    case 'annually':
      return addMonthsClamped(d, 12);
    default:
      // Exhaustive — TS guarantees this is unreachable, but keep a safe default.
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
  }
}

function addMonthsClamped(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetMonthIndex = d.getUTCMonth() + months;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = d.getUTCDate();
  // Last day of the target month (day 0 of next month).
  const lastDayOfTarget = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);
  d.setUTCFullYear(targetYear, normalizedMonth, clampedDay);
  return d;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecurringLineItemInput {
  description: string;
  quantity?: number;
  unit?: string;
  unit_price: number;
}

export interface CreateRecurringInput {
  client_id: string;
  project_id?: string;
  name: string;
  cadence: BillRecurringCadence;
  auto_finalize?: boolean;
  currency?: string;
  tax_rate?: number;
  discount_amount?: number;
  payment_terms_days?: number;
  payment_instructions?: string;
  notes?: string;
  footer_text?: string;
  terms_text?: string;
  start_date?: string;
  end_date?: string;
  next_run_at?: string;
  line_items?: RecurringLineItemInput[];
}

export interface UpdateRecurringInput {
  client_id?: string;
  project_id?: string;
  name?: string;
  cadence?: BillRecurringCadence;
  auto_finalize?: boolean;
  currency?: string;
  tax_rate?: number;
  discount_amount?: number;
  payment_terms_days?: number;
  payment_instructions?: string;
  notes?: string;
  footer_text?: string;
  terms_text?: string;
  start_date?: string;
  end_date?: string;
  next_run_at?: string;
  line_items?: RecurringLineItemInput[];
}

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

export async function listRecurring(orgId: string, status?: string) {
  const conditions = [eq(billRecurringInvoices.organization_id, orgId)];
  if (status) conditions.push(eq(billRecurringInvoices.status, status));

  const rows = await db
    .select()
    .from(billRecurringInvoices)
    .where(and(...conditions))
    .orderBy(desc(billRecurringInvoices.created_at));

  return { data: rows };
}

export async function getRecurring(id: string, orgId: string) {
  const [row] = await db
    .select()
    .from(billRecurringInvoices)
    .where(
      and(eq(billRecurringInvoices.id, id), eq(billRecurringInvoices.organization_id, orgId)),
    )
    .limit(1);

  if (!row) throw notFound('Recurring schedule not found');

  const lineItems = await db
    .select()
    .from(billRecurringLineItems)
    .where(eq(billRecurringLineItems.recurring_invoice_id, id))
    .orderBy(billRecurringLineItems.sort_order);

  return { ...row, line_items: lineItems };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRecurring(
  input: CreateRecurringInput,
  orgId: string,
  userId: string,
) {
  if (!CADENCES.includes(input.cadence)) {
    throw badRequest(`Invalid cadence. Use one of: ${CADENCES.join(', ')}`);
  }

  const [client] = await db
    .select()
    .from(billClients)
    .where(and(eq(billClients.id, input.client_id), eq(billClients.organization_id, orgId)))
    .limit(1);
  if (!client) throw badRequest('Client not found');

  const [settings] = await db
    .select()
    .from(billSettings)
    .where(eq(billSettings.organization_id, orgId))
    .limit(1);

  const startDate = input.start_date ?? new Date().toISOString().split('T')[0]!;
  // next_run_at defaults to the start date at 00:00 UTC unless explicitly set.
  const nextRunAt = input.next_run_at
    ? new Date(input.next_run_at)
    : new Date(`${startDate}T00:00:00.000Z`);

  const paymentDays =
    input.payment_terms_days ??
    client.default_payment_terms_days ??
    settings?.default_payment_terms_days ??
    30;

  const [row] = await db
    .insert(billRecurringInvoices)
    .values({
      organization_id: orgId,
      client_id: input.client_id,
      project_id: input.project_id,
      name: input.name,
      status: 'active',
      cadence: input.cadence,
      auto_finalize: input.auto_finalize ?? false,
      currency: input.currency ?? settings?.default_currency ?? 'USD',
      tax_rate: String(input.tax_rate ?? settings?.default_tax_rate ?? 0),
      discount_amount: input.discount_amount ?? 0,
      payment_terms_days: paymentDays,
      payment_instructions:
        input.payment_instructions ??
        client.default_payment_instructions ??
        settings?.default_payment_instructions,
      notes: input.notes,
      footer_text: input.footer_text ?? settings?.default_footer_text,
      terms_text: input.terms_text ?? settings?.default_terms_text,
      start_date: startDate,
      end_date: input.end_date,
      next_run_at: nextRunAt,
      created_by: userId,
    })
    .returning();

  if (input.line_items && input.line_items.length > 0) {
    await db.insert(billRecurringLineItems).values(
      input.line_items.map((li, idx) => ({
        recurring_invoice_id: row!.id,
        sort_order: idx,
        description: li.description,
        quantity: String(li.quantity ?? 1),
        unit: li.unit ?? 'units',
        unit_price: li.unit_price,
      })),
    );
  }

  return getRecurring(row!.id, orgId);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateRecurring(id: string, orgId: string, input: UpdateRecurringInput) {
  const existing = await getRecurring(id, orgId);
  if (existing.status === 'cancelled') {
    throw badRequest('Cannot edit a cancelled schedule');
  }
  if (input.cadence && !CADENCES.includes(input.cadence)) {
    throw badRequest(`Invalid cadence. Use one of: ${CADENCES.join(', ')}`);
  }

  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (input.client_id !== undefined) updateData.client_id = input.client_id;
  if (input.project_id !== undefined) updateData.project_id = input.project_id;
  if (input.name !== undefined) updateData.name = input.name;
  if (input.cadence !== undefined) updateData.cadence = input.cadence;
  if (input.auto_finalize !== undefined) updateData.auto_finalize = input.auto_finalize;
  if (input.currency !== undefined) updateData.currency = input.currency;
  if (input.tax_rate !== undefined) updateData.tax_rate = String(input.tax_rate);
  if (input.discount_amount !== undefined) updateData.discount_amount = input.discount_amount;
  if (input.payment_terms_days !== undefined)
    updateData.payment_terms_days = input.payment_terms_days;
  if (input.payment_instructions !== undefined)
    updateData.payment_instructions = input.payment_instructions;
  if (input.notes !== undefined) updateData.notes = input.notes;
  if (input.footer_text !== undefined) updateData.footer_text = input.footer_text;
  if (input.terms_text !== undefined) updateData.terms_text = input.terms_text;
  if (input.start_date !== undefined) updateData.start_date = input.start_date;
  if (input.end_date !== undefined) updateData.end_date = input.end_date;
  if (input.next_run_at !== undefined) updateData.next_run_at = new Date(input.next_run_at);

  await db
    .update(billRecurringInvoices)
    .set(updateData)
    .where(
      and(eq(billRecurringInvoices.id, id), eq(billRecurringInvoices.organization_id, orgId)),
    );

  // Replace line-item template when explicitly provided.
  if (input.line_items !== undefined) {
    await db
      .delete(billRecurringLineItems)
      .where(eq(billRecurringLineItems.recurring_invoice_id, id));
    if (input.line_items.length > 0) {
      await db.insert(billRecurringLineItems).values(
        input.line_items.map((li, idx) => ({
          recurring_invoice_id: id,
          sort_order: idx,
          description: li.description,
          quantity: String(li.quantity ?? 1),
          unit: li.unit ?? 'units',
          unit_price: li.unit_price,
        })),
      );
    }
  }

  return getRecurring(id, orgId);
}

// ---------------------------------------------------------------------------
// Lifecycle: pause / resume / cancel
// ---------------------------------------------------------------------------

async function setStatus(id: string, orgId: string, status: BillRecurringStatus) {
  const [row] = await db
    .update(billRecurringInvoices)
    .set({ status, updated_at: new Date() })
    .where(
      and(eq(billRecurringInvoices.id, id), eq(billRecurringInvoices.organization_id, orgId)),
    )
    .returning();
  if (!row) throw notFound('Recurring schedule not found');
  return row;
}

export async function pauseRecurring(id: string, orgId: string) {
  const existing = await getRecurring(id, orgId);
  if (existing.status === 'cancelled') throw badRequest('Schedule is cancelled');
  return setStatus(id, orgId, 'paused');
}

export async function resumeRecurring(id: string, orgId: string) {
  const existing = await getRecurring(id, orgId);
  if (existing.status === 'cancelled') throw badRequest('Schedule is cancelled');
  return setStatus(id, orgId, 'active');
}

export async function cancelRecurring(id: string, orgId: string) {
  await getRecurring(id, orgId);
  return setStatus(id, orgId, 'cancelled');
}

// ---------------------------------------------------------------------------
// Generate an invoice from a schedule (shared by generate-now + the worker)
// ---------------------------------------------------------------------------

export interface GenerateResult {
  invoice_id: string;
  invoice_number: string;
  status: string;
  next_run_at: Date;
}

/**
 * Materialise one invoice from a recurring schedule, then advance next_run_at
 * by one cadence step and bump bookkeeping counters. Returns the new invoice
 * id + the advanced next_run_at. Optionally reserves a real invoice number and
 * finalizes when the schedule is auto_finalize.
 *
 * `redis` is optional — passed through to reserveInvoiceNumber for the org lock
 * (graceful fallback to the SQL path when null).
 */
export async function generateInvoiceFromSchedule(
  id: string,
  orgId: string,
  userId: string,
  redis: Redis | null = null,
): Promise<GenerateResult> {
  const schedule = await getRecurring(id, orgId);
  if (schedule.status === 'cancelled') {
    throw badRequest('Cannot generate from a cancelled schedule');
  }

  const [client] = await db
    .select()
    .from(billClients)
    .where(
      and(eq(billClients.id, schedule.client_id), eq(billClients.organization_id, orgId)),
    )
    .limit(1);
  if (!client) throw badRequest('Client not found for schedule');

  const issueDate = new Date().toISOString().split('T')[0]!;
  const dueDate = new Date(Date.now() + schedule.payment_terms_days * 86400000)
    .toISOString()
    .split('T')[0]!;

  const toAddress = [
    client.address_line1,
    client.address_line2,
    [client.city, client.state_region, client.postal_code].filter(Boolean).join(', '),
    client.country,
  ]
    .filter(Boolean)
    .join('\n');

  const [settings] = await db
    .select()
    .from(billSettings)
    .where(eq(billSettings.organization_id, orgId))
    .limit(1);

  // Reserve a real number when auto-finalizing; otherwise leave it as DRAFT.
  let invoiceNumber = 'DRAFT';
  let status = 'draft';
  let sentAt: Date | null = null;
  if (schedule.auto_finalize) {
    const reservation = await reserveInvoiceNumber(redis, orgId);
    invoiceNumber = reservation.invoice_number;
    status = 'sent';
    sentAt = new Date();
  }

  const [invoice] = await db
    .insert(billInvoices)
    .values({
      organization_id: orgId,
      client_id: schedule.client_id,
      project_id: schedule.project_id,
      invoice_number: invoiceNumber,
      invoice_date: issueDate,
      due_date: dueDate,
      status,
      tax_rate: schedule.tax_rate ?? '0',
      discount_amount: schedule.discount_amount,
      payment_terms_days: schedule.payment_terms_days,
      currency: schedule.currency,
      payment_instructions: schedule.payment_instructions ?? settings?.default_payment_instructions,
      notes: schedule.notes,
      footer_text: schedule.footer_text ?? settings?.default_footer_text,
      terms_text: schedule.terms_text ?? settings?.default_terms_text,
      from_name: settings?.company_name,
      from_email: settings?.company_email,
      from_address: settings?.company_address,
      from_logo_url: settings?.company_logo_url,
      from_tax_id: settings?.company_tax_id,
      to_name: client.name,
      to_email: client.email,
      to_address: toAddress || null,
      to_tax_id: client.tax_id,
      sent_at: sentAt,
      created_by: userId,
    })
    .returning();

  if (schedule.line_items.length > 0) {
    await db.insert(billLineItems).values(
      schedule.line_items.map((li, idx) => {
        const qty = Number(li.quantity);
        return {
          invoice_id: invoice!.id,
          sort_order: idx,
          description: li.description,
          quantity: String(qty),
          unit: li.unit,
          unit_price: li.unit_price,
          amount: Math.round(qty * li.unit_price),
        };
      }),
    );
  }

  await recalculateInvoiceTotals(invoice!.id);

  // Advance the schedule. next_run_at moves forward by one cadence step from
  // the prior next_run_at (not from "now"), so a schedule that was due in the
  // past catches up one period at a time instead of skipping ahead.
  const advanced = advanceByCadence(
    new Date(schedule.next_run_at),
    schedule.cadence as BillRecurringCadence,
  );

  await db
    .update(billRecurringInvoices)
    .set({
      next_run_at: advanced,
      last_run_at: new Date(),
      invoices_generated: schedule.invoices_generated + 1,
      updated_at: new Date(),
    })
    .where(eq(billRecurringInvoices.id, id));

  return {
    invoice_id: invoice!.id,
    invoice_number: invoiceNumber,
    status,
    next_run_at: advanced,
  };
}
