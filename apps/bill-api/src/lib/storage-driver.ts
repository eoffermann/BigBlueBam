/**
 * bill-api's single object-storage path (issues #145, #148).
 *
 * Expense receipts and stored invoice PDFs are both read and written through
 * this one @bigbluebam/storage bootstrap driver, built from the configured
 * S3_* settings, so bill-api has no hand-rolled MinIO client and uses the same
 * bucket and credentials as the bill-pdf-generate worker job.
 */
import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

let driver: StorageDriver | null | undefined;

/** The storage driver, or null when S3_ENDPOINT / credentials are not configured. */
export function getBillStorageDriver(): StorageDriver | null {
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

/** Test hook: inject a driver (or null for "not configured"), or reset to env with undefined. */
export function __setBillStorageDriverForTests(d: StorageDriver | null | undefined): void {
  driver = d;
}
