/**
 * Bill recurring-invoice generation sweep (Bill task #60).
 *
 * Runs daily (wired in worker.ts) and finds active recurring schedules whose
 * next_run_at <= now() and whose end_date (if set) has not passed. For each
 * one it:
 *   1. Claims the row with a compare-and-set on next_run_at so two concurrent
 *      sweeps never generate the same period twice.
 *   2. Generates a bill_invoices row from the schedule template + its
 *      bill_recurring_line_items, leaving it as a draft unless auto_finalize
 *      is set (in which case it reserves a real invoice number and marks it
 *      sent).
 *   3. Advances next_run_at by one cadence step (from the prior next_run_at,
 *      so a schedule that fell behind catches up one period at a time rather
 *      than skipping ahead), bumps last_run_at + invoices_generated.
 *   4. Emits a `recurring.invoice_generated` Bolt event (source 'bill').
 *
 * This mirrors the bill-api recurring-invoice.service.ts generation logic; the
 * worker cannot import bill-api so the SQL is replicated here. The cadence math
 * is identical to advanceByCadence in that service.
 *
 * Idempotency. The claim UPDATE (... WHERE next_run_at = <observed>) only
 * succeeds for the worker that read the row first; a loser's UPDATE affects 0
 * rows and it skips the schedule. Because the claim advances next_run_at, a
 * crash AFTER the claim but BEFORE the invoice insert loses one period rather
 * than duplicating one — the safer failure mode for billing.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface BillRecurringGenerateJobData {
  /** Optional: constrain the sweep to a single org. */
  organization_id?: string;
  /** Max schedules per run. Defaults to 200. */
  limit?: number;
}

type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annually';

interface ScheduleRow {
  id: string;
  organization_id: string;
  client_id: string;
  project_id: string | null;
  name: string;
  cadence: Cadence;
  auto_finalize: boolean;
  currency: string;
  tax_rate: string | null;
  discount_amount: number;
  payment_terms_days: number;
  payment_instructions: string | null;
  notes: string | null;
  footer_text: string | null;
  terms_text: string | null;
  next_run_at: string; // ISO from postgres
  invoices_generated: number;
}

// ---------------------------------------------------------------------------
// Cadence math (mirrors recurring-invoice.service.ts::advanceByCadence)
// ---------------------------------------------------------------------------

function addMonthsClamped(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetMonthIndex = d.getUTCMonth() + months;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = d.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);
  d.setUTCFullYear(targetYear, normalizedMonth, clampedDay);
  return d;
}

function advanceByCadence(from: Date, cadence: Cadence): Date {
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
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
  }
}

function asRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-schedule processing
// ---------------------------------------------------------------------------

async function processSchedule(
  schedule: ScheduleRow,
  logger: Logger,
): Promise<{ generated: boolean }> {
  const db = getDb();
  const observedNextRun = schedule.next_run_at;
  const advanced = advanceByCadence(new Date(observedNextRun), schedule.cadence);

  // 1. Claim by compare-and-set on next_run_at. Only the first worker wins.
  const claimRaw = await db.execute(sql`
    UPDATE bill_recurring_invoices
    SET next_run_at = ${advanced.toISOString()},
        last_run_at = NOW(),
        invoices_generated = invoices_generated + 1,
        updated_at = NOW()
    WHERE id = ${schedule.id}
      AND status = 'active'
      AND next_run_at = ${observedNextRun}
    RETURNING id
  `);
  if (asRows<{ id: string }>(claimRaw).length === 0) {
    logger.debug({ scheduleId: schedule.id }, 'bill-recurring-generate: row already claimed, skipping');
    return { generated: false };
  }

  // 2. Load client + settings for the invoice snapshot.
  const client = asRows<{
    name: string | null;
    email: string | null;
    tax_id: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state_region: string | null;
    postal_code: string | null;
    country: string | null;
    bond_company_id: string | null;
  }>(
    await db.execute(sql`
      SELECT name, email, tax_id, address_line1, address_line2, city,
             state_region, postal_code, country, bond_company_id
      FROM bill_clients
      WHERE id = ${schedule.client_id} AND organization_id = ${schedule.organization_id}
      LIMIT 1
    `),
  )[0];

  if (!client) {
    logger.warn(
      { scheduleId: schedule.id, clientId: schedule.client_id },
      'bill-recurring-generate: client missing, skipping generation (next_run_at already advanced)',
    );
    return { generated: false };
  }

  const settings = asRows<{
    company_name: string | null;
    company_email: string | null;
    company_address: string | null;
    company_logo_url: string | null;
    company_tax_id: string | null;
    default_payment_instructions: string | null;
    default_footer_text: string | null;
    default_terms_text: string | null;
  }>(
    await db.execute(sql`
      SELECT company_name, company_email, company_address, company_logo_url,
             company_tax_id, default_payment_instructions, default_footer_text,
             default_terms_text
      FROM bill_settings
      WHERE organization_id = ${schedule.organization_id}
      LIMIT 1
    `),
  )[0] ?? null;

  const toAddress =
    [
      client.address_line1,
      client.address_line2,
      [client.city, client.state_region, client.postal_code].filter(Boolean).join(', '),
      client.country,
    ]
      .filter(Boolean)
      .join('\n') || null;

  const issueDate = ymd(new Date());
  const dueDate = ymd(new Date(Date.now() + schedule.payment_terms_days * 86400000));

  // 3. Reserve an invoice number when auto-finalizing; otherwise leave DRAFT.
  let invoiceNumber = 'DRAFT';
  let status = 'draft';
  let sentAt: string | null = null;
  if (schedule.auto_finalize) {
    invoiceNumber = await reserveInvoiceNumber(schedule.organization_id);
    status = 'sent';
    sentAt = new Date().toISOString();
  }

  // Created_by: schedules carry a creator, reuse it as the system actor for the
  // generated invoice so created_by NOT NULL is satisfied.
  const createdByRows = asRows<{ created_by: string }>(
    await db.execute(sql`
      SELECT created_by FROM bill_recurring_invoices WHERE id = ${schedule.id} LIMIT 1
    `),
  );
  const createdBy = createdByRows[0]?.created_by;

  // 4. Insert the invoice.
  const invoiceRows = asRows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO bill_invoices (
        organization_id, client_id, project_id, invoice_number, invoice_date,
        due_date, status, tax_rate, discount_amount, payment_terms_days, currency,
        payment_instructions, notes, footer_text, terms_text,
        from_name, from_email, from_address, from_logo_url, from_tax_id,
        to_name, to_email, to_address, to_tax_id, sent_at, created_by
      ) VALUES (
        ${schedule.organization_id}, ${schedule.client_id}, ${schedule.project_id},
        ${invoiceNumber}, ${issueDate}, ${dueDate}, ${status},
        ${schedule.tax_rate ?? '0'}, ${schedule.discount_amount}, ${schedule.payment_terms_days},
        ${schedule.currency},
        ${schedule.payment_instructions ?? settings?.default_payment_instructions ?? null},
        ${schedule.notes ?? null},
        ${schedule.footer_text ?? settings?.default_footer_text ?? null},
        ${schedule.terms_text ?? settings?.default_terms_text ?? null},
        ${settings?.company_name ?? null}, ${settings?.company_email ?? null},
        ${settings?.company_address ?? null}, ${settings?.company_logo_url ?? null},
        ${settings?.company_tax_id ?? null},
        ${client.name}, ${client.email}, ${toAddress}, ${client.tax_id},
        ${sentAt}, ${createdBy}
      )
      RETURNING id
    `),
  );
  const invoiceId = invoiceRows[0]?.id;
  if (!invoiceId) {
    logger.error({ scheduleId: schedule.id }, 'bill-recurring-generate: invoice insert returned no id');
    return { generated: false };
  }

  // 5. Copy line-item template -> invoice line items (with computed amount).
  await db.execute(sql`
    INSERT INTO bill_line_items (invoice_id, sort_order, description, quantity, unit, unit_price, amount)
    SELECT ${invoiceId}, sort_order, description, quantity, unit, unit_price,
           ROUND(quantity * unit_price)::bigint
    FROM bill_recurring_line_items
    WHERE recurring_invoice_id = ${schedule.id}
  `);

  // 6. Recalculate invoice totals from the line items + tax/discount.
  await db.execute(sql`
    UPDATE bill_invoices i
    SET subtotal = sub.subtotal,
        tax_amount = ROUND(sub.subtotal * COALESCE(i.tax_rate, 0) / 100)::bigint,
        total = sub.subtotal
                + ROUND(sub.subtotal * COALESCE(i.tax_rate, 0) / 100)::bigint
                - i.discount_amount,
        updated_at = NOW()
    FROM (
      SELECT COALESCE(SUM(amount), 0)::bigint AS subtotal
      FROM bill_line_items WHERE invoice_id = ${invoiceId}
    ) sub
    WHERE i.id = ${invoiceId}
  `);

  // 7. Emit the Bolt event.
  await publishBoltEvent(
    'recurring.invoice_generated',
    'bill',
    {
      schedule: { id: schedule.id, name: schedule.name },
      invoice: {
        id: invoiceId,
        number: invoiceNumber,
        status,
        customer_id: schedule.client_id,
        customer_name: client.name,
        customer_email: client.email,
      },
      next_run_at: advanced.toISOString(),
    },
    schedule.organization_id,
    undefined,
    'system',
  );

  logger.info(
    { scheduleId: schedule.id, invoiceId, invoiceNumber, status, nextRunAt: advanced.toISOString() },
    'bill-recurring-generate: invoice generated',
  );
  return { generated: true };
}

/**
 * Reserve the next invoice number for an org via an atomic upsert + increment.
 * Mirrors bill-api sequence.service.ts without the Redis lock (the single
 * UPDATE ... RETURNING is itself race-safe).
 */
async function reserveInvoiceNumber(orgId: string): Promise<string> {
  const db = getDb();
  // Ensure a sequence row exists, seeding the prefix from settings.
  await db.execute(sql`
    INSERT INTO bill_invoice_sequences (organization_id, prefix, next_number)
    SELECT ${orgId}, COALESCE(s.invoice_prefix, 'INV'), 1
    FROM (SELECT 1) one
    LEFT JOIN bill_settings s ON s.organization_id = ${orgId}
    ON CONFLICT (organization_id) DO NOTHING
  `);
  const rows = asRows<{ prefix: string; number: number }>(
    await db.execute(sql`
      UPDATE bill_invoice_sequences
      SET next_number = next_number + 1
      WHERE organization_id = ${orgId}
      RETURNING prefix, (next_number - 1) AS number
    `),
  );
  const row = rows[0];
  if (!row) return 'DRAFT';
  return `${row.prefix}-${String(row.number).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Sweep entry
// ---------------------------------------------------------------------------

export async function processBillRecurringGenerateJob(
  job: Job<BillRecurringGenerateJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id, limit } = job.data ?? {};
  const cap = limit ?? 200;
  logger.info({ jobId: job.id, organization_id, limit: cap }, 'bill-recurring-generate: sweep start');

  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT id, organization_id, client_id, project_id, name, cadence, auto_finalize,
           currency, tax_rate, discount_amount, payment_terms_days,
           payment_instructions, notes, footer_text, terms_text,
           next_run_at, invoices_generated
    FROM bill_recurring_invoices
    WHERE status = 'active'
      AND next_run_at <= NOW()
      AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      ${organization_id ? sql`AND organization_id = ${organization_id}` : sql``}
    ORDER BY next_run_at ASC
    LIMIT ${cap}
  `);

  const schedules = asRows<ScheduleRow>(rowsRaw);
  if (schedules.length === 0) {
    logger.info({ jobId: job.id }, 'bill-recurring-generate: no due schedules, sweep complete');
    return;
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const schedule of schedules) {
    try {
      const result = await processSchedule(schedule, logger);
      if (result.generated) generated += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        {
          scheduleId: schedule.id,
          orgId: schedule.organization_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'bill-recurring-generate: failed to process schedule',
      );
    }
  }

  logger.info(
    { jobId: job.id, found: schedules.length, generated, skipped, failed },
    'bill-recurring-generate: sweep complete',
  );
}
