/**
 * Receipt upload and download for bill expenses.
 *
 * Issue #145: receipts are stored through @bigbluebam/storage with the
 * configured S3_* bucket and credentials (lib/receipt-storage.ts) under
 * bill/receipts/<expense-id> (issue #157; earlier receipts at
 * bill/receipts/<expense-id><ext> are still read), and served only by the authorized
 * GET /v1/expenses/:id/receipt route. The expense row's receipt_url is that
 * route's path, never a /files/... URL.
 */

import { eq, and } from 'drizzle-orm';
import path from 'node:path';
import { db } from '../db/index.js';
import { billExpenses } from '../db/schema/index.js';
import {
  RECEIPT_TYPES,
  getReceiptDriver,
  legacyReceiptKey,
  receiptDownloadPath,
  receiptKey,
} from '../lib/receipt-storage.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function billError(statusCode: number, code: string, msg: string): Error {
  const err = new Error(msg) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  err.name = 'BillError';
  return err;
}

const badRequest = (msg: string) => billError(400, 'BAD_REQUEST', msg);
const notFound = (msg: string) => billError(404, 'NOT_FOUND', msg);
const storageNotConfigured = () =>
  billError(
    503,
    'STORAGE_NOT_CONFIGURED',
    'Receipt storage is not configured on this server (S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY are required)',
  );

function requireDriver() {
  const driver = getReceiptDriver();
  if (!driver) throw storageNotConfigured();
  return driver;
}

// ---------------------------------------------------------------------------
// Upload receipt
// ---------------------------------------------------------------------------

export async function uploadReceipt(
  expenseId: string,
  orgId: string,
  file: {
    filename: string;
    mimetype: string;
    file: NodeJS.ReadableStream;
  },
): Promise<{
  receipt_url: string;
  receipt_filename: string;
  receipt_mime_type: string;
  receipt_size_bytes: number;
}> {
  // 1. Verify the expense exists and belongs to this org
  const [expense] = await db
    .select({ id: billExpenses.id })
    .from(billExpenses)
    .where(and(eq(billExpenses.id, expenseId), eq(billExpenses.organization_id, orgId)))
    .limit(1);

  if (!expense) throw notFound('Expense not found');

  // 2. Validate file extension
  const ext = path.extname(file.filename).toLowerCase();
  const contentType = RECEIPT_TYPES[ext];
  if (!contentType) {
    throw badRequest(`Unsupported file type: ${ext}. Allowed: ${Object.keys(RECEIPT_TYPES).join(', ')}`);
  }

  const driver = requireDriver();

  // 3. Read file into buffer (with size limit)
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of file.file) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    totalSize += buf.length;
    if (totalSize > MAX_FILE_SIZE) {
      throw badRequest(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`);
    }
    chunks.push(buf);
  }
  const buffer = Buffer.concat(chunks);

  // 4. Store it and point the expense at it, serialized per expense (issue #157).
  //    The object key has no extension, so a replacement is one overwrite of the
  //    same key and nothing is deleted on the way. The expense row is locked
  //    (SELECT ... FOR UPDATE) across the put and the UPDATE, so two overlapping
  //    uploads run one after the other and the row always describes the bytes
  //    that were written last.
  const receiptUrl = receiptDownloadPath(expenseId);
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: billExpenses.id })
      .from(billExpenses)
      .where(and(eq(billExpenses.id, expenseId), eq(billExpenses.organization_id, orgId)))
      .for('update')
      .limit(1);
    if (!locked) throw notFound('Expense not found');

    await driver.put(receiptKey(expenseId), buffer, { contentType, size: buffer.length });

    await tx
      .update(billExpenses)
      .set({
        receipt_url: receiptUrl,
        receipt_filename: file.filename,
        receipt_mime_type: contentType,
        receipt_size_bytes: buffer.length,
        receipt_uploaded_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(billExpenses.id, expenseId));
  });

  // 5. Only after the row names the extensionless key: drop any pre-#157
  //    `<id><ext>` object, which nothing references any more. Best effort.
  for (const legacyExt of Object.keys(RECEIPT_TYPES)) {
    await driver.delete(legacyReceiptKey(expenseId, legacyExt)).catch(() => undefined);
  }

  return {
    receipt_url: receiptUrl,
    receipt_filename: file.filename,
    receipt_mime_type: contentType,
    receipt_size_bytes: buffer.length,
  };
}

// ---------------------------------------------------------------------------
// Download receipt
// ---------------------------------------------------------------------------

/**
 * Open the stored receipt for an expense the caller may see. The expense is
 * looked up org-scoped (another org's expense is a 404), and the object key is
 * derived from that row, so only this expense's own receipt can be read.
 */
export async function openReceipt(
  expenseId: string,
  orgId: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; filename: string }> {
  const [expense] = await db
    .select({
      id: billExpenses.id,
      receipt_filename: billExpenses.receipt_filename,
      receipt_mime_type: billExpenses.receipt_mime_type,
      receipt_uploaded_at: billExpenses.receipt_uploaded_at,
    })
    .from(billExpenses)
    .where(and(eq(billExpenses.id, expenseId), eq(billExpenses.organization_id, orgId)))
    .limit(1);

  if (!expense) throw notFound('Expense not found');
  if (!expense.receipt_uploaded_at || !expense.receipt_filename) {
    throw billError(404, 'RECEIPT_NOT_FOUND', 'This expense has no uploaded receipt');
  }

  const ext = path.extname(expense.receipt_filename).toLowerCase();
  const allowed = new Set(Object.values(RECEIPT_TYPES));

  const driver = requireDriver();
  let obj: { stream: NodeJS.ReadableStream; size: number; contentType: string };
  try {
    obj = await driver.getStream(receiptKey(expense.id));
  } catch {
    // Pre-#157 receipts live at `<id><ext>`, derived from the row's filename.
    if (!RECEIPT_TYPES[ext]) throw billError(404, 'RECEIPT_NOT_FOUND', 'This expense has no uploaded receipt');
    try {
      obj = await driver.getStream(legacyReceiptKey(expense.id, ext));
    } catch {
      throw billError(404, 'RECEIPT_NOT_FOUND', 'The receipt file is missing from storage');
    }
  }
  // Serve the type stored with the bytes when it is one we accept, so the
  // Content-Type always matches what was written; else fall back to the row.
  const contentType = allowed.has(obj.contentType)
    ? obj.contentType
    : (expense.receipt_mime_type && allowed.has(expense.receipt_mime_type) ? expense.receipt_mime_type : RECEIPT_TYPES[ext]);
  if (!contentType) throw billError(404, 'RECEIPT_NOT_FOUND', 'This expense has no uploaded receipt');
  return { stream: obj.stream, contentType, size: obj.size, filename: expense.receipt_filename };
}
