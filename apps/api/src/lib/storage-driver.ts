/**
 * The api's single object-storage path (issue #176).
 *
 * Task attachments, uploads, backups and presigned download URLs all go through
 * the shared env-driven @bigbluebam/storage bootstrap driver, built from the
 * api's validated S3_* settings. There are no default credentials: without
 * S3_ACCESS_KEY / S3_SECRET_KEY the driver is null and callers answer 503
 * STORAGE_NOT_CONFIGURED.
 */
import {
  StorageNotConfiguredError,
  __setEnvBootstrapDriverForTests,
  getEnvBootstrapDriver,
  requireEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { env } from '../env.js';

export { StorageNotConfiguredError };

export const getApiStorageDriver = (): StorageDriver | null => getEnvBootstrapDriver(env);
export const requireApiStorageDriver = (): StorageDriver => requireEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setApiStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}
