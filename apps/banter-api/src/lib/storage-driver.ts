/**
 * banter-api's single object-storage path (issue #159).
 *
 * File uploads, presigned uploads, the channel-authorized attachment download,
 * and the Slack-import zip stash all go through this one @bigbluebam/storage
 * bootstrap driver, built from the configured S3_* settings, instead of
 * hand-built MinIO clients. There are no default credentials: without
 * S3_ACCESS_KEY / S3_SECRET_KEY the driver is null and callers answer 503
 * STORAGE_NOT_CONFIGURED instead of failing obscurely (mirrors bill-api).
 */
import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

let driver: StorageDriver | null | undefined;

export function getBanterStorageDriver(): StorageDriver | null {
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

/** Thrown where storage is required but not configured; routes map it to 503. */
export class StorageNotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly code = 'STORAGE_NOT_CONFIGURED';
  constructor() {
    super('File storage is not configured on this server (S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY are required)');
    this.name = 'StorageNotConfiguredError';
  }
}

export function requireBanterStorageDriver(): StorageDriver {
  const d = getBanterStorageDriver();
  if (!d) throw new StorageNotConfiguredError();
  return d;
}

/** Whether a storage error means the object does not exist (vs. storage trouble). */
export function isNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject';
}

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setBanterStorageDriverForTests(d: StorageDriver | null | undefined): void {
  driver = d;
}
