/**
 * Bill PDF generation worker job (Bill_Plan.md G1).
 *
 * Picks up a `bill_worker_jobs` row where `job_type = 'pdf_generate'` and
 * `status = 'pending'`, marks it processing, renders a real PDF for the
 * invoice with pdf-lib, uploads it through @bigbluebam/storage under
 * billInvoicePdfKey(invoice id) (`bill/invoices/<invoice-id>.pdf`, the one
 * definition bill-api's download route also uses), and records the key on
 * `bill_invoices.pdf_url`.
 *
 * Invocation model. The Bill API does not push jobs to a BullMQ queue
 * today, it only inserts a row into `bill_worker_jobs`. This job supports
 * two entry points: an explicit `{ workerJobId }` payload (for when a
 * caller does push to BullMQ later) and the recurring "sweep" mode where
 * the worker polls for pending rows on a timer. Both paths funnel through
 * `processWorkerJobRow`.
 *
 * Idempotency. On success we flip status to 'completed' and stamp
 * `pdf_url`. On failure we flip to 'failed' with an error message but
 * leave the invoice untouched so a retry can try again. The sweep mode
 * claims rows with a compare-and-set UPDATE so concurrent workers never
 * process the same row twice.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  __setEnvBootstrapDriverForTests,
  billInvoicePdfKey,
  getEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import type { Env } from '../env.js';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface BillPdfGenerateJobData {
  /** Direct invocation: the id of a `bill_worker_jobs` row to process. */
  workerJobId?: string;
  /** Sweep mode: scan for pending rows and process them in a batch. */
  sweep?: boolean;
  /** Max rows per sweep. Defaults to 25 to keep each tick bounded. */
  limit?: number;
}

interface WorkerJobRow {
  id: string;
  organization_id: string;
  invoice_id: string | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  organization_id: string;
  invoice_date: Date | string;
  due_date: Date | string;
  status: string;
  subtotal: string | number | bigint;
  tax_rate: string | null;
  tax_amount: string | number | bigint;
  discount_amount: string | number | bigint;
  total: string | number | bigint;
  currency: string;
  from_name: string | null;
  from_email: string | null;
  from_address: string | null;
  from_tax_id: string | null;
  to_name: string | null;
  to_email: string | null;
  to_address: string | null;
  to_tax_id: string | null;
  payment_instructions: string | null;
  notes: string | null;
  footer_text: string | null;
  terms_text: string | null;
}

interface LineItemRow {
  description: string;
  quantity: string;
  unit: string | null;
  unit_price: string | number | bigint;
  amount: string | number | bigint;
}

function toCents(value: string | number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and cannot render codepoints
 * outside that range. Normalize strings to their best ASCII equivalents so
 * long dashes, typographic quotes, and non-latin glyphs never cause
 * WinAnsiEncoding mapping failures mid-render.
 */
export function sanitizeForWinAnsi(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[^\x20-\x7E\t\n\r]/g, '?');
}

/**
 * Render a real invoice PDF. US Letter (612 x 792 pt), single page.
 * Line items past row 24 get truncated with a "+N more" indicator.
 */
async function renderInvoicePdf(
  invoice: InvoiceRow,
  lines: LineItemRow[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.1, 0.13);
  const sub = rgb(0.4, 0.42, 0.47);
  const accent = rgb(0.25, 0.41, 0.88);

  let y = 740;

  // Header
  page.drawText('INVOICE', {
    x: 50,
    y,
    size: 28,
    font: fontBold,
    color: accent,
  });
  page.drawText(`#${sanitizeForWinAnsi(invoice.invoice_number)}`, {
    x: 50,
    y: y - 22,
    size: 12,
    font: fontRegular,
    color: sub,
  });

  // Status badge, right-aligned
  const statusText = invoice.status.toUpperCase();
  const statusWidth = fontBold.widthOfTextAtSize(statusText, 10);
  page.drawRectangle({
    x: 562 - statusWidth - 16,
    y: y + 4,
    width: statusWidth + 16,
    height: 22,
    color:
      invoice.status === 'paid'
        ? rgb(0.86, 0.96, 0.88)
        : invoice.status === 'overdue'
        ? rgb(0.98, 0.89, 0.88)
        : rgb(0.93, 0.95, 0.98),
  });
  page.drawText(statusText, {
    x: 562 - statusWidth - 8,
    y: y + 10,
    size: 10,
    font: fontBold,
    color:
      invoice.status === 'paid'
        ? rgb(0.15, 0.55, 0.28)
        : invoice.status === 'overdue'
        ? rgb(0.75, 0.15, 0.15)
        : ink,
  });

  y -= 52;

  // From / To blocks side by side
  page.drawText('FROM', { x: 50, y, size: 9, font: fontBold, color: sub });
  page.drawText('BILL TO', { x: 316, y, size: 9, font: fontBold, color: sub });
  y -= 14;

  const drawLines = (rawText: string, startX: number, startY: number): number => {
    const text = sanitizeForWinAnsi(rawText);
    const ls = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    let cy = startY;
    for (const line of ls) {
      page.drawText(line, { x: startX, y: cy, size: 10, font: fontRegular, color: ink });
      cy -= 12;
    }
    return cy;
  };

  const fromY = drawLines(
    [
      invoice.from_name ?? '',
      invoice.from_email ?? '',
      invoice.from_address ?? '',
      invoice.from_tax_id ? `Tax ID: ${invoice.from_tax_id}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    50,
    y,
  );

  const toY = drawLines(
    [
      invoice.to_name ?? '',
      invoice.to_email ?? '',
      invoice.to_address ?? '',
      invoice.to_tax_id ? `Tax ID: ${invoice.to_tax_id}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    316,
    y,
  );

  y = Math.min(fromY, toY) - 20;

  // Date block
  page.drawText('Issue date', { x: 50, y, size: 9, font: fontBold, color: sub });
  page.drawText(formatDate(invoice.invoice_date), {
    x: 50,
    y: y - 12,
    size: 10,
    font: fontRegular,
    color: ink,
  });
  page.drawText('Due date', { x: 180, y, size: 9, font: fontBold, color: sub });
  page.drawText(formatDate(invoice.due_date), {
    x: 180,
    y: y - 12,
    size: 10,
    font: fontRegular,
    color: ink,
  });

  y -= 36;

  // Line items header
  page.drawRectangle({
    x: 50,
    y: y - 4,
    width: 512,
    height: 20,
    color: rgb(0.96, 0.97, 0.98),
  });
  page.drawText('DESCRIPTION', { x: 56, y, size: 9, font: fontBold, color: sub });
  page.drawText('QTY', { x: 356, y, size: 9, font: fontBold, color: sub });
  page.drawText('UNIT PRICE', { x: 408, y, size: 9, font: fontBold, color: sub });
  page.drawText('AMOUNT', { x: 512, y, size: 9, font: fontBold, color: sub });
  y -= 20;

  const maxRows = 24;
  const renderable = lines.slice(0, maxRows);
  for (const li of renderable) {
    const desc = sanitizeForWinAnsi(li.description).slice(0, 60);
    page.drawText(desc, { x: 56, y, size: 10, font: fontRegular, color: ink });
    page.drawText(String(Number(li.quantity).toFixed(2)), {
      x: 356,
      y,
      size: 10,
      font: fontRegular,
      color: ink,
    });
    page.drawText(formatMoney(toCents(li.unit_price), invoice.currency), {
      x: 408,
      y,
      size: 10,
      font: fontRegular,
      color: ink,
    });
    page.drawText(formatMoney(toCents(li.amount), invoice.currency), {
      x: 512,
      y,
      size: 10,
      font: fontRegular,
      color: ink,
    });
    y -= 14;
  }
  if (lines.length > maxRows) {
    page.drawText(`+ ${lines.length - maxRows} more line items`, {
      x: 56,
      y,
      size: 9,
      font: fontRegular,
      color: sub,
    });
    y -= 14;
  }

  y -= 12;

  // Totals block (right-aligned)
  const totalsX = 400;
  const drawTotalLine = (label: string, amount: number, opts: { bold?: boolean } = {}) => {
    const font = opts.bold ? fontBold : fontRegular;
    page.drawText(label, { x: totalsX, y, size: 10, font, color: opts.bold ? ink : sub });
    page.drawText(formatMoney(amount, invoice.currency), {
      x: 512,
      y,
      size: 10,
      font,
      color: ink,
    });
    y -= 14;
  };
  drawTotalLine('Subtotal', toCents(invoice.subtotal));
  if (toCents(invoice.discount_amount) !== 0) {
    drawTotalLine('Discount', -toCents(invoice.discount_amount));
  }
  if (toCents(invoice.tax_amount) !== 0) {
    drawTotalLine(
      `Tax (${invoice.tax_rate ?? '0'}%)`,
      toCents(invoice.tax_amount),
    );
  }
  page.drawLine({
    start: { x: totalsX, y: y + 4 },
    end: { x: 562, y: y + 4 },
    color: sub,
    thickness: 0.5,
  });
  y -= 4;
  drawTotalLine('Total', toCents(invoice.total), { bold: true });

  y -= 20;

  // Footer: payment instructions, notes, terms
  const footerBlocks: Array<{ label: string; text: string | null }> = [
    { label: 'Payment instructions', text: invoice.payment_instructions },
    { label: 'Notes', text: invoice.notes },
    { label: 'Terms', text: invoice.terms_text },
  ];
  for (const block of footerBlocks) {
    if (!block.text) continue;
    page.drawText(block.label.toUpperCase(), {
      x: 50,
      y,
      size: 9,
      font: fontBold,
      color: sub,
    });
    y -= 12;
    y = drawLines(block.text.slice(0, 400), 50, y);
    y -= 6;
  }

  if (invoice.footer_text) {
    const footer = sanitizeForWinAnsi(invoice.footer_text);
    const footerWidth = fontRegular.widthOfTextAtSize(footer, 9);
    page.drawText(footer, {
      x: Math.max(50, (612 - footerWidth) / 2),
      y: 40,
      size: 9,
      font: fontRegular,
      color: sub,
    });
  }

  return doc.save();
}

// ───────────────────────────────────────────────────────────────────────────
// MinIO upload
// ───────────────────────────────────────────────────────────────────────────

// Issue #148: writes go through @bigbluebam/storage's bootstrap driver (which
// creates the bucket on first put), the same substrate bill-api reads with.
// Issue #164: the driver comes from the shared env-driven helper over the
// worker's validated env (apps/worker/src/env.ts), so the "configured" rule, the
// bucket and the region are the same facts bill-api uses, not inline fallbacks.
const getStorageDriver = (env: Env): StorageDriver | null => getEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setBillPdfStorageDriverForTests(env: Env, d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}

async function uploadPdfToMinio(
  storageKey: string,
  pdfBytes: Uint8Array,
  logger: Logger,
  env: Env,
): Promise<{ uploaded: boolean; reason?: string }> {
  let driver: StorageDriver | null;
  try {
    driver = getStorageDriver(env);
  } catch (err) {
    // A malformed S3_ENDPOINT: report it like any other upload failure.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storageKey, err: message }, 'bill-pdf-generate: object storage misconfigured');
    return { uploaded: false, reason: message };
  }
  if (!driver) {
    logger.warn('bill-pdf-generate: object storage not configured; skipping upload');
    return { uploaded: false, reason: 'storage not configured' };
  }
  try {
    const bytes = Buffer.from(pdfBytes);
    await driver.put(storageKey, bytes, { contentType: 'application/pdf', size: bytes.length });
    return { uploaded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ storageKey, err: message }, 'bill-pdf-generate: MinIO upload failed');
    return { uploaded: false, reason: message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// DB helpers
// ───────────────────────────────────────────────────────────────────────────

async function fetchWorkerJob(id: string): Promise<WorkerJobRow | null> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT id, organization_id, invoice_id
    FROM bill_worker_jobs
    WHERE id = ${id} AND job_type = 'pdf_generate'
    LIMIT 1
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as WorkerJobRow) ?? null;
}

async function fetchInvoice(invoiceId: string): Promise<InvoiceRow | null> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT id, invoice_number, organization_id, invoice_date, due_date, status,
           subtotal, tax_rate, tax_amount, discount_amount, total, currency,
           from_name, from_email, from_address, from_tax_id,
           to_name, to_email, to_address, to_tax_id,
           payment_instructions, notes, footer_text, terms_text
    FROM bill_invoices
    WHERE id = ${invoiceId}
    LIMIT 1
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as InvoiceRow) ?? null;
}

async function fetchLineItems(invoiceId: string): Promise<LineItemRow[]> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT description, quantity, unit, unit_price, amount
    FROM bill_line_items
    WHERE invoice_id = ${invoiceId}
    ORDER BY sort_order ASC, created_at ASC
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return rows as LineItemRow[];
}

async function claimWorkerJob(id: string): Promise<boolean> {
  const db = getDb();
  const resultRaw = await db.execute(sql`
    UPDATE bill_worker_jobs
    SET status = 'processing', updated_at = NOW()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `);
  const rows = Array.isArray(resultRaw) ? resultRaw : ((resultRaw as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Main worker entry
// ───────────────────────────────────────────────────────────────────────────

async function processWorkerJobRow(
  workerJobId: string,
  logger: Logger,
  env: Env,
): Promise<{ processed: boolean; failed: boolean }> {
  const db = getDb();
  const claimed = await claimWorkerJob(workerJobId);
  if (!claimed) {
    logger.debug({ workerJobId }, 'bill-pdf-generate: row already claimed, skipping');
    return { processed: false, failed: false };
  }

  const jobRow = await fetchWorkerJob(workerJobId);
  if (!jobRow) {
    logger.warn({ workerJobId }, 'bill-pdf-generate: row disappeared after claim');
    return { processed: false, failed: true };
  }

  if (!jobRow.invoice_id) {
    await db.execute(sql`
      UPDATE bill_worker_jobs
      SET status = 'failed', error_message = 'missing invoice_id', updated_at = NOW()
      WHERE id = ${workerJobId}
    `);
    return { processed: false, failed: true };
  }

  try {
    const invoice = await fetchInvoice(jobRow.invoice_id);
    if (!invoice) {
      await db.execute(sql`
        UPDATE bill_worker_jobs
        SET status = 'failed', error_message = 'invoice not found', updated_at = NOW()
        WHERE id = ${workerJobId}
      `);
      return { processed: false, failed: true };
    }

    const lines = await fetchLineItems(invoice.id);
    const pdfBytes = await renderInvoicePdf(invoice, lines);
    const storageKey = billInvoicePdfKey(invoice.id);

    const uploadResult = await uploadPdfToMinio(storageKey, pdfBytes, logger, env);
    if (!uploadResult.uploaded) {
      logger.warn(
        { invoiceId: invoice.id, storageKey, reason: uploadResult.reason },
        'bill-pdf-generate: PDF generated but MinIO upload skipped',
      );
    }

    await db.execute(sql`
      UPDATE bill_invoices
      SET pdf_url = ${storageKey}, updated_at = NOW()
      WHERE id = ${invoice.id}
    `);

    await db.execute(sql`
      UPDATE bill_worker_jobs
      SET status = 'completed', error_message = NULL, updated_at = NOW()
      WHERE id = ${workerJobId}
    `);

    await publishBoltEvent(
      'invoice.pdf_generated',
      'bill',
      {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        storage_key: storageKey,
        size_bytes: pdfBytes.length,
        uploaded: uploadResult.uploaded,
      },
      invoice.organization_id,
      undefined,
      'system',
    );

    logger.info(
      {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        storageKey,
        sizeBytes: pdfBytes.length,
        uploaded: uploadResult.uploaded,
      },
      'bill-pdf-generate: PDF generated',
    );

    return { processed: true, failed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ workerJobId, err: message }, 'bill-pdf-generate: job failed');
    await db.execute(sql`
      UPDATE bill_worker_jobs
      SET status = 'failed', error_message = ${message.slice(0, 500)}, updated_at = NOW()
      WHERE id = ${workerJobId}
    `);
    return { processed: false, failed: true };
  }
}

async function sweepPendingJobs(limit: number, logger: Logger, env: Env): Promise<void> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT id FROM bill_worker_jobs
    WHERE job_type = 'pdf_generate' AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);
  const rows = (
    Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ id: string }>;

  if (rows.length === 0) {
    logger.debug('bill-pdf-generate: sweep found no pending rows');
    return;
  }

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await processWorkerJobRow(row.id, logger, env);
    if (result.processed) processed += 1;
    if (result.failed) failed += 1;
  }
  logger.info(
    { candidates: rows.length, processed, failed },
    'bill-pdf-generate: sweep complete',
  );
}

export async function processBillPdfGenerateJob(
  job: Job<BillPdfGenerateJobData>,
  logger: Logger,
  env: Env,
): Promise<void> {
  const data = job.data ?? {};

  if (data.workerJobId) {
    logger.info({ jobId: job.id, workerJobId: data.workerJobId }, 'bill-pdf-generate: direct job');
    await processWorkerJobRow(data.workerJobId, logger, env);
    return;
  }

  const limit = data.limit ?? 25;
  logger.info({ jobId: job.id, limit }, 'bill-pdf-generate: sweep tick');
  await sweepPendingJobs(limit, logger, env);
}
