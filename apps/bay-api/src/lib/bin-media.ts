// Bay public-review media serving.
//
// The authenticated Bay player streams Bin media through Bin's own scan-gated
// /raw proxy (which requires a session). Public guests have no session, so for
// the /bay/r/:token surface Bay streams the canonical bytes itself: it reads the
// bin_assets row (shared DB) for the object key + scan status, then streams from
// the same object store via the shared @bigbluebam/storage driver. Access is
// authorized upstream by a valid, unexpired, unrevoked review-link token.
//
// Only clean/skipped assets are ever served (mirrors Bin's §9.3 gate).

import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../env.js';

export type ServeVariant = 'original' | 'proxy' | 'poster';

let driver: StorageDriver | null = null;
function getDriver(): StorageDriver {
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

interface BinAssetMediaRow {
  object_key: string;
  content_type: string | null;
  scan_status: string;
  scan_override_at: string | null;
  proxy_object_key: string | null;
  poster_object_key: string | null;
  proxy_content_type: string | null;
}

async function getBinAssetMedia(binAssetId: string): Promise<BinAssetMediaRow | null> {
  const raw = await db.execute(sql`
    SELECT object_key, content_type, scan_status, scan_override_at,
           proxy_object_key, poster_object_key, proxy_content_type
    FROM bin_assets WHERE id = ${binAssetId} LIMIT 1
  `);
  const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as BinAssetMediaRow[];
  return list[0] ?? null;
}

/** Resolve the object key + content type for a variant, applying the scan gate.
 *  Returns null when the asset is missing, not servable, or the variant artifact
 *  doesn't exist (the caller maps null to 404). */
function resolveTarget(
  row: BinAssetMediaRow,
  variant: ServeVariant,
): { objectKey: string; contentType: string } | null {
  // Guest links are anonymous (no session/role/policy), so only the two
  // safe-by-default states OR a persistent per-file override (false-positive
  // clear, set by an admin/SuperUser) extend servability here. Risk-ack and
  // admin-inspect deliberately do NOT apply on the guest path.
  const servable =
    row.scan_status === 'clean' || row.scan_status === 'skipped' || row.scan_override_at != null;
  if (!servable) return null;
  if (variant === 'proxy') {
    if (!row.proxy_object_key) return null;
    return {
      objectKey: row.proxy_object_key,
      contentType: row.proxy_content_type ?? 'application/octet-stream',
    };
  }
  if (variant === 'poster') {
    if (!row.poster_object_key) return null;
    return {
      objectKey: row.poster_object_key,
      contentType: row.poster_object_key.endsWith('.png') ? 'image/png' : 'image/jpeg',
    };
  }
  if (!row.object_key) return null;
  return { objectKey: row.object_key, contentType: row.content_type ?? 'application/octet-stream' };
}

export function hasRangeSupport(): boolean {
  return typeof getDriver().getRange === 'function';
}

export async function statBinMedia(
  binAssetId: string,
  variant: ServeVariant,
): Promise<{ total: number; contentType: string } | null> {
  const row = await getBinAssetMedia(binAssetId);
  if (!row) return null;
  const target = resolveTarget(row, variant);
  if (!target) return null;
  const stat = await getDriver().stat(target.objectKey);
  if (!stat) return null;
  return { total: stat.size, contentType: target.contentType };
}

export async function streamBinMedia(
  binAssetId: string,
  variant: ServeVariant,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number } | null> {
  const row = await getBinAssetMedia(binAssetId);
  if (!row) return null;
  const target = resolveTarget(row, variant);
  if (!target) return null;
  const r = await getDriver().getStream(target.objectKey);
  return { stream: r.stream, contentType: target.contentType || r.contentType, size: r.size };
}

export async function rangeBinMedia(
  binAssetId: string,
  variant: ServeVariant,
  start: number,
  end: number,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; total: number } | null> {
  const row = await getBinAssetMedia(binAssetId);
  if (!row) return null;
  const target = resolveTarget(row, variant);
  if (!target) return null;
  const driver = getDriver();
  if (!driver.getRange) return null;
  const r = await driver.getRange(target.objectKey, start, end);
  return { stream: r.stream, contentType: target.contentType || r.contentType, size: r.size, total: r.total };
}
