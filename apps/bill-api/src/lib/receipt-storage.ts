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
 * Keys are pinned to the expense: new uploads go to
 * `bill/receipts/v2/<expense-id>/<version>` (#169, #182); older layouts
 * (`bill/receipts/<expense-id>/<version>`, the #157 `bill/receipts/<expense-id>`,
 * the pre-#157 `bill/receipts/<expense-id><ext>`) are still read. The route
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

/**
 * Issue #157-era key: one extensionless key per expense, overwritten in place.
 * Still read for receipts uploaded before #169 (rows with no receipt_storage_key).
 */
export function receiptKey(expenseId: string): string {
  return `${RECEIPT_PREFIX}/${expenseId}`;
}

/**
 * Issue #169: each upload writes its own key BEFORE any transaction opens, and
 * the expense row then records which key is current
 * (bill_expenses.receipt_storage_key). The object PUT never runs under a row
 * lock, and because every upload has a distinct key, the last upload to commit
 * wins and deletes only the key it replaced, never another upload's key.
 *
 * Issue #182: versioned keys live under their own `bill/receipts/v2/` subtree,
 * `bill/receipts/v2/<expense-id>/<version>`. The first #169 shape,
 * `bill/receipts/<expense-id>/<version>`, nested under the #157 object
 * `bill/receipts/<expense-id>`, and MinIO refuses a key whose parent path is an
 * object (XMinioParentIsObject), so a #157-era receipt could never be replaced.
 * No other key layout (#157, pre-#157, first #169) is a path prefix of a v2 key,
 * and no v2 key is a path prefix of any of them.
 */
export const RECEIPT_VERSION_PREFIX = `${RECEIPT_PREFIX}/v2`;

export function receiptVersionKey(expenseId: string, version: string): string {
  return `${RECEIPT_VERSION_PREFIX}/${expenseId}/${version}`;
}

/**
 * True when `key` is one of this expense's versioned receipt keys: the current
 * v2 shape, or the first #169 shape `bill/receipts/<expense-id>/<version>`,
 * which rows written before #182 still name and which stays readable.
 */
export function isReceiptVersionKeyFor(expenseId: string, key: string): boolean {
  for (const prefix of [`${RECEIPT_VERSION_PREFIX}/${expenseId}/`, `${RECEIPT_PREFIX}/${expenseId}/`]) {
    if (key.startsWith(prefix) && /^[A-Za-z0-9-]+$/.test(key.slice(prefix.length))) return true;
  }
  return false;
}

/** Pre-#157 key shape (`<expense-id><ext>`), still read as a fallback for old receipts. */
export function legacyReceiptKey(expenseId: string, ext: string): string {
  return `${RECEIPT_PREFIX}/${expenseId}${ext}`;
}

/** The authorized download path the SPA and API consumers use for a receipt. */
export function receiptDownloadPath(expenseId: string): string {
  return `/bill/api/v1/expenses/${expenseId}/receipt`;
}
