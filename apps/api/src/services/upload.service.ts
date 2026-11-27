// Task attachments and uploads in the platform bucket (env.S3_BUCKET), through the
// shared @bigbluebam/storage driver (issue #176). The driver is bound to the bucket
// and creates it on first write, so there is no bucket argument and no ensureBucket.
// Every function throws StorageNotConfiguredError (503) when storage is not configured.
import { requireApiStorageDriver } from '../lib/storage-driver.js';

/** Presigned download URLs live for 24 hours. */
const DOWNLOAD_URL_TTL_SECONDS = 24 * 60 * 60;

export async function uploadFile(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await requireApiStorageDriver().put(key, buffer, { contentType, size: buffer.length });
}

export async function getFileUrl(key: string): Promise<string> {
  const driver = requireApiStorageDriver();
  if (!driver.presignGet) throw new Error('The storage driver cannot presign downloads');
  return driver.presignGet(key, DOWNLOAD_URL_TTL_SECONDS);
}

export async function getFileStream(key: string) {
  return requireApiStorageDriver().getStream(key);
}

export async function deleteFile(key: string): Promise<void> {
  await requireApiStorageDriver().delete(key);
}

export function buildStorageKey(
  orgId: string,
  projectId: string,
  taskId: string,
  uuid: string,
  filename: string,
): string {
  return `${orgId}/${projectId}/${taskId}/${uuid}-${filename}`;
}
