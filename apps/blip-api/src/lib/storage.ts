/**
 * Blip object-storage helpers (Blip §23.2). Capture images + thumbnails and
 * compiled timelapse videos go to the same MinIO/S3 the rest of the suite uses,
 * through @bigbluebam/storage's bootstrap driver (the per-org `media` binding is
 * not yet implemented, so binding_id stays null like bin-api today).
 *
 * Keys are org-prefixed so a future per-org binding migration is clean:
 *   <orgId>/blip/<tracked_app_id>/<YYYY-MM>/<seq>/<index>.jpg
 *   <orgId>/blip/<tracked_app_id>/<YYYY-MM>/<seq>/<index>.thumb.jpg
 */
import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

let driver: StorageDriver | null = null;

export function getDriver(): StorageDriver {
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

export function monthSegment(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function captureKey(
  orgId: string,
  trackedAppId: string,
  month: string,
  seq: string | bigint,
  index: number,
  thumb = false,
): string {
  const suffix = thumb ? `${index}.thumb.jpg` : `${index}.jpg`;
  return `${orgId}/blip/${trackedAppId}/${month}/${seq}/${suffix}`;
}

export function timelapseKey(orgId: string, trackedAppId: string, jobId: string): string {
  return `${orgId}/blip/${trackedAppId}/timelapse/${jobId}.mp4`;
}
