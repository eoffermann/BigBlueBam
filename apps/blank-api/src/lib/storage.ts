// Object storage for Blank form-submission file uploads, through the shared
// @bigbluebam/storage driver (issue #176), in the platform bucket (env.S3_BUCKET).
// Blank objects are namespaced under a `blank/` key prefix so they never collide
// with Bam task attachments (`uploads/...`). The driver creates the bucket on
// first write. There are no default credentials: without S3_ACCESS_KEY /
// S3_SECRET_KEY every function here throws StorageNotConfiguredError, which the
// error handler answers as 503 STORAGE_NOT_CONFIGURED.
//
// Downloads are NOT served by the shared /files/ Bam route (that route enforces
// Bam auth + bam.file.list). Blank submission files are served by an
// org-scoped, authenticated blank-api route (GET /v1/submissions/:id/files/:idx)
// that streams from storage after confirming the caller owns the submission.

import {
  StorageNotConfiguredError,
  __setEnvBootstrapDriverForTests,
  requireEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { env } from '../env.js';

export { StorageNotConfiguredError };

export const requireBlankStorageDriver = (): StorageDriver => requireEnvBootstrapDriver(env);

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setBlankStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(env, d);
}

export async function uploadFile(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await requireBlankStorageDriver().put(key, buffer, { contentType, size: buffer.length });
}

export async function getFileStream(key: string) {
  return requireBlankStorageDriver().getStream(key);
}

/**
 * Build the object key for a Blank submission upload. The submission id
 * is not known at upload time (the file is uploaded before the response is
 * submitted), so we namespace by org + form + a fresh uuid.
 */
export function buildBlankStorageKey(
  orgId: string,
  formId: string,
  uuid: string,
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `blank/${orgId}/${formId}/${uuid}-${safe}`;
}
