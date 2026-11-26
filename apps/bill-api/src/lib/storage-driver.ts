/**
 * bill-api's single object-storage path (issues #145, #148).
 *
 * Expense receipts and stored invoice PDFs are both read and written through
 * the shared env-driven @bigbluebam/storage bootstrap driver (issue #164), built
 * from bill-api's validated S3_* settings, so bill-api uses the same "configured"
 * rule, bucket and credentials as the bill-pdf-generate worker job.
 */
import {
  __setEnvBootstrapDriverForTests,
  getEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { env } from '../env.js';

/** The storage driver, or null when S3_ENDPOINT / credentials are not configured. */
export const getBillStorageDriver = (): StorageDriver | null => getEnvBootstrapDriver(env);

/** Test hook: inject a driver (or null for "not configured"), or reset to env with undefined. */
export function __setBillStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}
