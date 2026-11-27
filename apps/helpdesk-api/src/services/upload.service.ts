// Helpdesk ticket attachments and uploads in env.S3_BUCKET, through the shared
// @bigbluebam/storage driver (issue #176). The driver is bound to the bucket and
// creates it on first write. There are no default credentials: without
// S3_ACCESS_KEY / S3_SECRET_KEY every function throws StorageNotConfiguredError,
// which the error handler answers as 503 STORAGE_NOT_CONFIGURED.
import {
  StorageNotConfiguredError,
  __setEnvBootstrapDriverForTests,
  requireEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { env } from '../env.js';

export { StorageNotConfiguredError };

/** Presigned download URLs live for 24 hours. */
const DOWNLOAD_URL_TTL_SECONDS = 24 * 60 * 60;

export const requireHelpdeskStorageDriver = (): StorageDriver => requireEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setHelpdeskStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}

export async function uploadFile(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await requireHelpdeskStorageDriver().put(key, buffer, { contentType, size: buffer.length });
}

export async function getFileUrl(key: string): Promise<string> {
  const driver = requireHelpdeskStorageDriver();
  if (!driver.presignGet) throw new Error('The storage driver cannot presign downloads');
  return driver.presignGet(key, DOWNLOAD_URL_TTL_SECONDS);
}

export async function deleteFile(key: string): Promise<void> {
  await requireHelpdeskStorageDriver().delete(key);
}
