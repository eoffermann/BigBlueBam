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

import { createBootstrapDriver, buildStorageKey, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

let driver: StorageDriver | null = null;

/** The active (bootstrap) media driver. Memoized — construction is cheap but
 *  there is no reason to rebuild it per request. */
export function getMediaDriver(): StorageDriver {
  if (!driver) {
    driver = createBootstrapDriver({
      S3_ENDPOINT: env.S3_ENDPOINT,
      S3_REGION: env.S3_REGION,
      S3_BUCKET: env.S3_BUCKET,
      S3_ACCESS_KEY: env.S3_ACCESS_KEY,
      S3_SECRET_KEY: env.S3_SECRET_KEY,
    });
  }
  return driver;
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
