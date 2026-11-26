/**
 * banter-api's single object-storage path (issue #159).
 *
 * File uploads, presigned uploads, the channel-authorized attachment download,
 * and the Slack-import zip stash all go through the shared env-driven
 * @bigbluebam/storage bootstrap driver (issue #164), built from banter-api's
 * validated S3_* settings. There are no default credentials: without
 * S3_ACCESS_KEY / S3_SECRET_KEY the driver is null and callers answer 503
 * STORAGE_NOT_CONFIGURED.
 */
import {
  StorageNotConfiguredError,
  __setEnvBootstrapDriverForTests,
  getEnvBootstrapDriver,
  isStorageNotFoundError,
  requireEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { env } from '../env.js';

export { StorageNotConfiguredError, isStorageNotFoundError as isNotFoundError };

export const getBanterStorageDriver = (): StorageDriver | null => getEnvBootstrapDriver(env);
export const requireBanterStorageDriver = (): StorageDriver => requireEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setBanterStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}
