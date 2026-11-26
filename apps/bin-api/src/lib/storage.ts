// Bin DAM storage access (Bin master §9.2/§9.3).
//
// In this DAM-core slice Bin uses the bootstrap `local` driver built from the
// S3_* env via @bigbluebam/storage's createBootstrapDriver. The per-org binding
// resolver (binding_id -> active provider) is a later slice; until then every
// asset/version is written through this single bootstrap driver and binding_id
// is left null on the rows.
//
// Object keys are namespaced under the `bin/` scope via buildStorageKey so Bin
// objects never collide with Bam/Blank attachments in the shared bucket.

import { buildStorageKey, requireEnvBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

/** The active (bootstrap) media driver: the shared, memoized env-driven helper
 *  (issue #164). Throws StorageNotConfiguredError (503) if storage is not configured. */
export function getMediaDriver(): StorageDriver {
  return requireEnvBootstrapDriver(env);
}

/** Read a stored object fully into a Buffer (structured-editor reads/commits).
 *  Streams from the active driver and concatenates. */
export async function readObject(objectKey: string): Promise<Buffer> {
  const { stream } = await getMediaDriver().getStream(objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Build the canonical object key for a Bin asset version. */
export function buildBinObjectKey(
  orgId: string,
  assetId: string,
  versionUuid: string,
  filename: string,
): string {
  return buildStorageKey(orgId, 'bin', assetId, versionUuid, filename);
}
