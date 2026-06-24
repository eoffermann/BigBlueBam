// @bigbluebam/storage — the pluggable storage-driver substrate (Bin master §4).
// One driver implementation shared by api, bin-api, worker, and bay-api,
// consolidating the previously triplicated MinIO clients.

export * from './driver.js';
export * from './config.js';
export * from './secrets.js';
export { S3Driver, type S3DriverOptions } from './s3-driver.js';
export { createDriver, createBootstrapDriver, type ProviderRow } from './factory.js';

/** Build a canonical object key. Mirrors the legacy upload.service helper so the
 *  attachment substrate can repoint at the package without changing key shapes. */
export function buildStorageKey(
  orgId: string,
  scope: string,
  entityId: string,
  uuid: string,
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${orgId}/${scope}/${entityId}/${uuid}-${safe}`;
}
