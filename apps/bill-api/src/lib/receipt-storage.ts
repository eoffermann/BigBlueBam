/**
 * Expense receipt object storage (issue #145).
 *
 * Receipts used to go to a hard-coded `bigbluebam` bucket with `minioadmin`
 * fallback credentials, while everything else (including the `/files/*` proxy
 * that was supposed to serve them) used S3_BUCKET. They now go through
 * @bigbluebam/storage's bootstrap driver with the configured S3_* settings, the
 * same bucket and credentials the worker and the invoice PDF download use, and
 * are served only by the authorized GET /v1/expenses/:id/receipt route.
 *
 * Keys are pinned to the expense: `bill/receipts/<expense-id><ext>`. The route
 * derives the key from the expense row it has already authorized, so no
 * client-supplied value ever selects which object is read.
 */
// The driver itself lives in ./storage-driver.ts, shared with the invoice PDF
// download (issue #148); these aliases keep the receipt call sites unchanged.
export {
  getBillStorageDriver as getReceiptDriver,
  __setBillStorageDriverForTests as __setReceiptDriverForTests,
} from './storage-driver.js';

export const RECEIPT_PREFIX = 'bill/receipts';

/** Allowed receipt extensions and the MIME type each is stored and served as. */
export const RECEIPT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function receiptKey(expenseId: string, ext: string): string {
  return `${RECEIPT_PREFIX}/${expenseId}${ext}`;
}

/** The authorized download path the SPA and API consumers use for a receipt. */
export function receiptDownloadPath(expenseId: string): string {
  return `/bill/api/v1/expenses/${expenseId}/receipt`;
}
