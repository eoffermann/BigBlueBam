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
import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

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

let driver: StorageDriver | null | undefined;

/** The storage driver, or null when S3_ENDPOINT / credentials are not configured. */
export function getReceiptDriver(): StorageDriver | null {
  if (driver !== undefined) return driver;
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    driver = null;
    return driver;
  }
  driver = createBootstrapDriver({
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
  });
  return driver;
}

/** Test hook: inject a driver (or null for "not configured"), or reset to env. */
export function __setReceiptDriverForTests(d: StorageDriver | null | undefined): void {
  driver = d;
}
