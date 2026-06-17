import { eq, and, desc, sql, gte, lte, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { db } from '../db/index.js';
import {
  billInvoices,
  billLineItems,
  billPayments,
  billSettings,
  billClients,
  timeEntries,
  tasks,
  users,
  bondDeals,
} from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { resolveRate } from './rate.service.js';
import { reserveInvoiceNumber } from './sequence.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceFilters {
  organization_id: string;
  status?: string;
  client_id?: string;
  project_id?: string;
  date_from?: string;
  date_to?: string;
}

export interface CreateInvoiceInput {
  client_id: string;
  project_id?: string;
  invoice_date?: string;
  due_date?: string;
  tax_rate?: number;
  discount_amount?: number;
  payment_terms_days?: number;
  payment_instructions?: string;
  notes?: string;
  footer_text?: string;
  terms_text?: string;
  bond_deal_id?: string;
}

export interface UpdateInvoiceInput {
  client_id?: string;
  project_id?: string;
  invoice_date?: string;
  due_date?: string;
  tax_rate?: number;
  discount_amount?: number;
  payment_terms_days?: number;
  payment_instructions?: string;
  notes?: string;
  footer_text?: string;
  terms_text?: string;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listInvoices(filters: InvoiceFilters) {
  const conditions: any[] = [eq(billInvoices.organization_id, filters.organization_id)];

  if (filters.status) conditions.push(eq(billInvoices.status, filters.status));
  if (filters.client_id) conditions.push(eq(billInvoices.client_id, filters.client_id));
  if (filters.project_id) conditions.push(eq(billInvoices.project_id, filters.project_id));
  if (filters.date_from) conditions.push(gte(billInvoices.invoice_date, filters.date_from));
  if (filters.date_to) conditions.push(lte(billInvoices.invoice_date, filters.date_to));

  const rows = await db
    .select()
    .from(billInvoices)
    .where(and(...conditions))
    .orderBy(desc(billInvoices.created_at));

  return { data: rows };
}

// ---------------------------------------------------------------------------
// Get with line items and payments
// ---------------------------------------------------------------------------

export async function getInvoice(id: string, orgId: string) {
  const [invoice] = await db
    .select()
    .from(billInvoices)
    .where(and(eq(billInvoices.id, id), eq(billInvoices.organization_id, orgId)))
    .limit(1);

  if (!invoice) throw notFound('Invoice not found');

  const lineItems = await db
    .select()
    .from(billLineItems)
    .where(eq(billLineItems.invoice_id, id))
    .orderBy(billLineItems.sort_order);

  const payments = await db
    .select()
    .from(billPayments)
    .where(eq(billPayments.invoice_id, id))
    .orderBy(desc(billPayments.created_at));

  return { ...invoice, line_items: lineItems, payments };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createInvoice(input: CreateInvoiceInput, orgId: string, userId: string) {
  // Load settings for defaults
  const [settings] = await db
    .select()
    .from(billSettings)
    .where(eq(billSettings.organization_id, orgId))
    .limit(1);

  // Load client for snapshot
  const [client] = await db
    .select()
    .from(billClients)
    .where(and(eq(billClients.id, input.client_id), eq(billClients.organization_id, orgId)))
    .limit(1);

  if (!client) throw badRequest('Client not found');

  const paymentDays = input.payment_terms_days ?? client.default_payment_terms_days ?? settings?.default_payment_terms_days ?? 30;
  const invoiceDate = input.invoice_date ?? new Date().toISOString().split('T')[0]!;
  const dueDate = input.due_date ?? new Date(Date.now() + paymentDays * 86400000).toISOString().split('T')[0]!;

  // Build client address
  const toAddress = [client.address_line1, client.address_line2, [client.city, client.state_region, client.postal_code].filter(Boolean).join(', '), client.country].filter(Boolean).join('\n');

  const [invoice] = await db
    .insert(billInvoices)
    .values({
      organization_id: orgId,
      client_id: input.client_id,
      project_id: input.project_id,
      invoice_number: 'DRAFT',
      invoice_date: invoiceDate,
      due_date: dueDate,
      status: 'draft',
      tax_rate: String(input.tax_rate ?? settings?.default_tax_rate ?? 0),
      discount_amount: input.discount_amount ?? 0,
      payment_terms_days: paymentDays,
      payment_instructions: input.payment_instructions ?? client.default_payment_instructions ?? settings?.default_payment_instructions,
      notes: input.notes,
      footer_text: input.footer_text ?? settings?.default_footer_text,
      terms_text: input.terms_text ?? settings?.default_terms_text,
      from_name: settings?.company_name,
      from_email: settings?.company_email,
      from_address: settings?.company_address,
      from_logo_url: settings?.company_logo_url,
      from_tax_id: settings?.company_tax_id,
      to_name: client.name,
      to_email: client.email,
      to_address: toAddress || null,
      to_tax_id: client.tax_id,
      bond_deal_id: input.bond_deal_id,
      created_by: userId,
    })
    .returning();

  return invoice!;
}

// ---------------------------------------------------------------------------
// Update (draft only)
// ---------------------------------------------------------------------------

export async function updateInvoice(id: string, orgId: string, input: UpdateInvoiceInput) {
  const existing = await getInvoice(id, orgId);
  if (existing.status !== 'draft') {
    throw badRequest('Can only edit invoices in draft status');
  }

  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (input.client_id !== undefined) updateData.client_id = input.client_id;
  if (input.project_id !== undefined) updateData.project_id = input.project_id;
  if (input.invoice_date !== undefined) updateData.invoice_date = input.invoice_date;
  if (input.due_date !== undefined) updateData.due_date = input.due_date;
  if (input.tax_rate !== undefined) updateData.tax_rate = String(input.tax_rate);
  if (input.discount_amount !== undefined) updateData.discount_amount = input.discount_amount;
  if (input.payment_terms_days !== undefined) updateData.payment_terms_days = input.payment_terms_days;
  if (input.payment_instructions !== undefined) updateData.payment_instructions = input.payment_instructions;
  if (input.notes !== undefined) updateData.notes = input.notes;
  if (input.footer_text !== undefined) updateData.footer_text = input.footer_text;
  if (input.terms_text !== undefined) updateData.terms_text = input.terms_text;

  const [updated] = await db
    .update(billInvoices)
    .set(updateData)
    .where(and(eq(billInvoices.id, id), eq(billInvoices.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Invoice not found');

  // Recalculate totals
  await recalculateInvoiceTotals(id);

  return getInvoice(id, orgId);
}

// ---------------------------------------------------------------------------
// Delete (draft only)
// ---------------------------------------------------------------------------

export async function deleteInvoice(id: string, orgId: string) {
  const existing = await getInvoice(id, orgId);
  if (existing.status !== 'draft') {
    throw badRequest('Can only delete invoices in draft status');
  }

  const [deleted] = await db
    .delete(billInvoices)
    .where(and(eq(billInvoices.id, id), eq(billInvoices.organization_id, orgId)))
    .returning({ id: billInvoices.id });

  if (!deleted) throw notFound('Invoice not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Finalize (assign number, lock edits)
// ---------------------------------------------------------------------------

export async function finalizeInvoice(
  id: string,
  orgId: string,
  redis: Redis | null = null,
) {
  const existing = await getInvoice(id, orgId);
  if (existing.status !== 'draft') {
    throw badRequest('Invoice is already finalized');
  }

  // G3: Reserve the invoice number under a Redis lock scoped to the org.
  // The lock is best-effort and gracefully falls through to the SQL path
  // if Redis is unavailable, so finalize never fails just because the
  // cache is down. See services/sequence.service.ts for the full story.
  const reservation = await reserveInvoiceNumber(redis, orgId);

  // Recalculate totals
  await recalculateInvoiceTotals(id);

  // Finalize moves draft to "sent" as the historical behavior: the current
  // status enum in the SPA and bill_invoices CHECK constraint do not have a
  // distinct "finalized" state. sendInvoice is a no-op state-wise for
  // already-sent invoices and remains useful for re-triggering delivery.
  const [finalized] = await db
    .update(billInvoices)
    .set({
      invoice_number: reservation.invoice_number,
      status: 'sent',
      sent_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(billInvoices.id, id))
    .returning();

  return finalized!;
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export async function voidInvoice(id: string, orgId: string) {
  const existing = await getInvoice(id, orgId);
  if (existing.status === 'void') {
    throw badRequest('Invoice is already voided');
  }
  if (existing.status === 'draft') {
    throw badRequest('Cannot void a draft invoice — delete it instead');
  }

  const [voided] = await db
    .update(billInvoices)
    .set({ status: 'void', updated_at: new Date() })
    .where(and(eq(billInvoices.id, id), eq(billInvoices.organization_id, orgId)))
    .returning();

  if (!voided) throw notFound('Invoice not found');
  return voided;
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

export async function duplicateInvoice(id: string, orgId: string, userId: string) {
  const existing = await getInvoice(id, orgId);

  const [newInvoice] = await db
    .insert(billInvoices)
    .values({
      organization_id: orgId,
      client_id: existing.client_id,
      project_id: existing.project_id,
      invoice_number: 'DRAFT',
      invoice_date: new Date().toISOString().split('T')[0]!,
      due_date: new Date(Date.now() + existing.payment_terms_days * 86400000).toISOString().split('T')[0]!,
      status: 'draft',
      tax_rate: existing.tax_rate,
      discount_amount: existing.discount_amount,
      payment_terms_days: existing.payment_terms_days,
      payment_instructions: existing.payment_instructions,
      notes: existing.notes,
      footer_text: existing.footer_text,
      terms_text: existing.terms_text,
      from_name: existing.from_name,
      from_email: existing.from_email,
      from_address: existing.from_address,
      from_logo_url: existing.from_logo_url,
      from_tax_id: existing.from_tax_id,
      to_name: existing.to_name,
      to_email: existing.to_email,
      to_address: existing.to_address,
      to_tax_id: existing.to_tax_id,
      created_by: userId,
    })
    .returning();

  // Duplicate line items
  if (existing.line_items.length > 0) {
    await db.insert(billLineItems).values(
      existing.line_items.map((li, idx) => ({
        invoice_id: newInvoice!.id,
        sort_order: idx,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unit_price: li.unit_price,
        amount: li.amount,
      })),
    );
  }

  await recalculateInvoiceTotals(newInvoice!.id);

  return getInvoice(newInvoice!.id, orgId);
}

// ---------------------------------------------------------------------------
// Send (mark as sent)
// ---------------------------------------------------------------------------

export async function sendInvoice(id: string, orgId: string) {
  const existing = await getInvoice(id, orgId);
  if (existing.status === 'draft') {
    throw badRequest('Finalize the invoice before sending');
  }
  if (existing.status === 'void') {
    throw badRequest('Cannot send a voided invoice');
  }

  const [sent] = await db
    .update(billInvoices)
    .set({ status: 'sent', sent_at: new Date(), updated_at: new Date() })
    .where(and(eq(billInvoices.id, id), eq(billInvoices.organization_id, orgId)))
    .returning();

  if (!sent) throw notFound('Invoice not found');
  return sent;
}

// ---------------------------------------------------------------------------
// Public view by token
// ---------------------------------------------------------------------------

export async function getInvoiceByToken(token: string) {
  // Select only safe public-facing fields — exclude organization_id, created_by,
  // bond_deal_id, from_tax_id, to_tax_id, and other internal metadata
  const [invoice] = await db
    .select({
      id: billInvoices.id,
      invoice_number: billInvoices.invoice_number,
      status: billInvoices.status,
      currency: billInvoices.currency,
      subtotal: billInvoices.subtotal,
      tax_rate: billInvoices.tax_rate,
      tax_amount: billInvoices.tax_amount,
      discount_amount: billInvoices.discount_amount,
      total: billInvoices.total,
      amount_paid: billInvoices.amount_paid,
      due_date: billInvoices.due_date,
      issue_date: billInvoices.invoice_date,
      from_name: billInvoices.from_name,
      from_email: billInvoices.from_email,
      from_address: billInvoices.from_address,
      from_logo_url: billInvoices.from_logo_url,
      to_name: billInvoices.to_name,
      to_email: billInvoices.to_email,
      to_address: billInvoices.to_address,
      notes: billInvoices.notes,
      footer_text: billInvoices.footer_text,
      terms_text: billInvoices.terms_text,
      payment_instructions: billInvoices.payment_instructions,
      payment_terms_days: billInvoices.payment_terms_days,
      viewed_at: billInvoices.viewed_at,
    })
    .from(billInvoices)
    .where(eq(billInvoices.public_view_token, token))
    .limit(1);

  if (!invoice) throw notFound('Invoice not found');

  // Mark as viewed
  if (!invoice.viewed_at) {
    await db
      .update(billInvoices)
      .set({ viewed_at: new Date(), status: sql`CASE WHEN ${billInvoices.status} = 'sent' THEN 'viewed' ELSE ${billInvoices.status} END` })
      .where(eq(billInvoices.id, invoice.id));
  }

  const lineItems = await db
    .select({
      id: billLineItems.id,
      sort_order: billLineItems.sort_order,
      description: billLineItems.description,
      quantity: billLineItems.quantity,
      unit: billLineItems.unit,
      unit_price: billLineItems.unit_price,
      amount: billLineItems.amount,
    })
    .from(billLineItems)
    .where(eq(billLineItems.invoice_id, invoice.id))
    .orderBy(billLineItems.sort_order);

  return { ...invoice, line_items: lineItems };
}

// ---------------------------------------------------------------------------
// Create from time entries
// ---------------------------------------------------------------------------

export interface CreateFromTimeEntriesInput {
  project_id: string;
  client_id: string;
  // Either an explicit list of entry IDs, or a date range to resolve against
  // the project. The route enforces that at least one form is supplied.
  time_entry_ids?: string[];
  date_from?: string;
  date_to?: string;
}

export async function createInvoiceFromTimeEntries(
  input: CreateFromTimeEntriesInput,
  orgId: string,
  userId: string,
) {
  // 1. Fetch the candidate time entries joined with tasks to verify project
  //    ownership. When explicit IDs are supplied we look those up; otherwise
  //    we resolve all entries on the project's tasks within the date range.
  const baseSelect = {
    id: timeEntries.id,
    task_id: timeEntries.task_id,
    user_id: timeEntries.user_id,
    minutes: timeEntries.minutes,
    date: timeEntries.date,
    description: timeEntries.description,
    task_title: tasks.title,
    task_project_id: tasks.project_id,
  };

  const useExplicitIds = !!(input.time_entry_ids && input.time_entry_ids.length > 0);

  let entries;
  if (useExplicitIds) {
    entries = await db
      .select(baseSelect)
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.task_id))
      .where(inArray(timeEntries.id, input.time_entry_ids!));
  } else {
    if (!input.date_from || !input.date_to) {
      throw badRequest('Provide either time_entry_ids or both date_from and date_to');
    }
    entries = await db
      .select(baseSelect)
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.task_id))
      .where(
        and(
          eq(tasks.project_id, input.project_id),
          gte(timeEntries.date, input.date_from),
          lte(timeEntries.date, input.date_to),
        ),
      );
  }

  if (entries.length === 0) {
    throw badRequest(
      useExplicitIds
        ? 'No time entries found for the given IDs'
        : 'No time entries found for the project in the given date range',
    );
  }

  // Verify all entries belong to the specified project (explicit-ID path may
  // include entries from other projects; the range path is already scoped).
  const wrongProject = entries.filter((e) => e.task_project_id !== input.project_id);
  if (wrongProject.length > 0) {
    throw badRequest(
      `${wrongProject.length} time entries do not belong to the specified project`,
    );
  }

  // 2. Group time entries by user + task for line item generation
  const groupKey = (e: { user_id: string; task_id: string }) => `${e.user_id}::${e.task_id}`;
  const groups = new Map<
    string,
    {
      user_id: string;
      task_id: string;
      task_title: string;
      totalMinutes: number;
      entryIds: string[];
      descriptions: string[];
    }
  >();

  for (const entry of entries) {
    const key = groupKey(entry);
    const existing = groups.get(key);
    if (existing) {
      existing.totalMinutes += entry.minutes;
      existing.entryIds.push(entry.id);
      if (entry.description) existing.descriptions.push(entry.description);
    } else {
      groups.set(key, {
        user_id: entry.user_id,
        task_id: entry.task_id,
        task_title: entry.task_title,
        totalMinutes: entry.minutes,
        entryIds: [entry.id],
        descriptions: entry.description ? [entry.description] : [],
      });
    }
  }

  // 3. Resolve billing rates and build line items
  const lineItemValues: Array<{
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    amount: number;
    time_entry_ids: string[];
    task_id: string;
    sort_order: number;
  }> = [];

  // Fetch user display names for line item descriptions
  const userIds = [...new Set([...groups.values()].map((g) => g.user_id))];
  const userRows = userIds.length > 0
    ? await db
        .select({ id: users.id, display_name: users.display_name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userNameMap = new Map(userRows.map((u) => [u.id, u.display_name]));

  let sortOrder = 0;
  for (const group of groups.values()) {
    // Resolve rate: most specific match wins (user+project > user > project > org)
    const rateResult = await resolveRate(orgId, input.project_id, group.user_id);
    if (!rateResult.data) {
      throw badRequest(
        `No billing rate configured for user ${userNameMap.get(group.user_id) ?? group.user_id} on this project. Configure a rate first.`,
      );
    }

    const rate = rateResult.data;
    const hours = group.totalMinutes / 60;
    const quantity = Math.round(hours * 100) / 100; // 2 decimal places
    const amount = Math.round(quantity * rate.rate_amount);

    const userName = userNameMap.get(group.user_id) ?? 'Unknown';
    const description = `${group.task_title} - ${userName} (${quantity}h)`;

    lineItemValues.push({
      description,
      quantity,
      unit: 'hours',
      unit_price: rate.rate_amount,
      amount,
      time_entry_ids: group.entryIds,
      task_id: group.task_id,
      sort_order: sortOrder++,
    });
  }

  // 4. Create the draft invoice
  const invoice = await createInvoice(
    {
      client_id: input.client_id,
      project_id: input.project_id,
    },
    orgId,
    userId,
  );

  // 5. Insert line items
  if (lineItemValues.length > 0) {
    await db.insert(billLineItems).values(
      lineItemValues.map((li) => ({
        invoice_id: invoice.id,
        sort_order: li.sort_order,
        description: li.description,
        quantity: String(li.quantity),
        unit: li.unit,
        unit_price: li.unit_price,
        amount: li.amount,
        time_entry_ids: li.time_entry_ids,
        task_id: li.task_id,
      })),
    );
  }

  // 6. Recalculate totals
  await recalculateInvoiceTotals(invoice.id);

  // 7. Return the full invoice with line items
  return getInvoice(invoice.id, orgId);
}

// ---------------------------------------------------------------------------
// Create from Bond deal
// ---------------------------------------------------------------------------

export interface CreateFromDealInput {
  deal_id: string;
  client_id: string;
}

export async function createInvoiceFromDeal(
  input: CreateFromDealInput,
  orgId: string,
  userId: string,
) {
  // 1. Look up the deal from Bond's deals table (shared database)
  const [deal] = await db
    .select()
    .from(bondDeals)
    .where(and(eq(bondDeals.id, input.deal_id), eq(bondDeals.organization_id, orgId)))
    .limit(1);

  if (!deal) {
    throw notFound('Deal not found');
  }

  // 2. Create the draft invoice linked to the deal
  const invoice = await createInvoice(
    {
      client_id: input.client_id,
      bond_deal_id: input.deal_id,
    },
    orgId,
    userId,
  );

  // 3. Add the deal value as a single line item
  const dealValue = deal.value ?? 0;
  await db.insert(billLineItems).values({
    invoice_id: invoice.id,
    sort_order: 0,
    description: deal.name,
    quantity: '1',
    unit: 'unit',
    unit_price: dealValue,
    amount: dealValue,
  });

  // 4. Recalculate totals
  await recalculateInvoiceTotals(invoice.id);

  // 5. Return the full invoice
  return getInvoice(invoice.id, orgId);
}

// ---------------------------------------------------------------------------
// Recalculate totals
// ---------------------------------------------------------------------------

export async function recalculateInvoiceTotals(invoiceId: string) {
  // Sum line items
  const [result] = await db
    .select({
      subtotal: sql<number>`COALESCE(SUM(${billLineItems.amount}), 0)::bigint`,
    })
    .from(billLineItems)
    .where(eq(billLineItems.invoice_id, invoiceId));

  const subtotal = Number(result?.subtotal ?? 0);

  // Get current invoice for tax_rate and discount
  const [inv] = await db
    .select()
    .from(billInvoices)
    .where(eq(billInvoices.id, invoiceId))
    .limit(1);

  if (!inv) return;

  const taxRate = Number(inv.tax_rate ?? 0);
  const discountAmount = Number(inv.discount_amount ?? 0);
  const taxAmount = Math.round(subtotal * taxRate / 100);
  const total = subtotal + taxAmount - discountAmount;

  // Sum payments
  const [payResult] = await db
    .select({
      total_paid: sql<number>`COALESCE(SUM(${billPayments.amount}), 0)::bigint`,
    })
    .from(billPayments)
    .where(eq(billPayments.invoice_id, invoiceId));

  const amountPaid = Number(payResult?.total_paid ?? 0);

  await db
    .update(billInvoices)
    .set({
      subtotal,
      tax_amount: taxAmount,
      total,
      amount_paid: amountPaid,
      updated_at: new Date(),
    })
    .where(eq(billInvoices.id, invoiceId));
}
