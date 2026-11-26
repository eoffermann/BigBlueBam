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
import { requireEnvBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { env } from '../env.js';

/** The shared, memoized env-driven driver (issue #164). Throws
 *  StorageNotConfiguredError (503) if storage is not configured. */
export function getDriver(): StorageDriver {
  return requireEnvBootstrapDriver(env);
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
