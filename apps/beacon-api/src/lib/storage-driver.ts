/**
 * beacon-api's single object-storage path (issue #176).
 *
 * Beacon attachments go through the shared env-driven @bigbluebam/storage
 * bootstrap driver, built from beacon-api's validated S3_* settings. The driver
 * is bound to env.S3_BUCKET and creates it on first write. There are no default
 * credentials: without S3_ACCESS_KEY / S3_SECRET_KEY every function here throws
 * StorageNotConfiguredError, which the error handler answers as 503
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

export const requireBeaconStorageDriver = (): StorageDriver => requireEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setBeaconStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}

export async function uploadFile(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await requireBeaconStorageDriver().put(key, buffer, { contentType, size: buffer.length });
}

/**
 * Best-effort delete: the DB row is the source of truth, so a missing object
 * (or one never fully uploaded, or storage that is not configured) must not
 * stop the caller dropping the row.
 */
export async function deleteFile(key: string): Promise<void> {
  try {
    await getEnvBootstrapDriver(env)?.delete(key);
  } catch {
    // swallow
  }
}

export async function getPresignedGetUrl(key: string, expirySeconds = 24 * 60 * 60): Promise<string> {
  const driver = requireBeaconStorageDriver();
  if (!driver.presignGet) throw new Error('The storage driver cannot presign downloads');
  return driver.presignGet(key, expirySeconds);
}
