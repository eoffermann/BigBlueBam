import { randomUUID } from 'node:crypto';
import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { binAssets, binAssetVersions } from '../db/schema/index.js';
import { getMediaDriver, buildBinObjectKey } from '../lib/storage.js';
import { env } from '../env.js';
import { NotFoundError } from './folder.service.js';

export { NotFoundError } from './folder.service.js';

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface CreateAssetInput {
  name: string;
  content_type: string;
  folder_id?: string | null;
  project_id?: string | null;
  visibility?: 'organization' | 'project' | 'private';
  tags?: string[];
}

export interface UpdateAssetInput {
  name?: string;
  folder_id?: string | null;
  tags?: string[];
}

const VISIBILITIES = new Set(['organization', 'project', 'private']);

export async function listAssets(
  orgId: string,
  opts: {
    folder_id?: string | null;
    project_id?: string;
    include_archived?: boolean;
    tag?: string;
  } = {},
) {
  const conditions = [eq(binAssets.org_id, orgId)];
  if (opts.folder_id === null) {
    conditions.push(isNull(binAssets.folder_id));
  } else if (typeof opts.folder_id === 'string') {
    conditions.push(eq(binAssets.folder_id, opts.folder_id));
  }
  if (opts.project_id) {
    conditions.push(eq(binAssets.project_id, opts.project_id));
  }
  if (opts.tag) {
    conditions.push(sql`${binAssets.tags} @> ARRAY[${opts.tag}]::text[]`);
  }
  if (!opts.include_archived) {
    conditions.push(isNull(binAssets.archived_at));
  }
  return db
    .select()
    .from(binAssets)
    .where(and(...conditions))
    .orderBy(desc(binAssets.created_at));
}

export async function getAsset(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(binAssets)
    .where(and(eq(binAssets.id, id), eq(binAssets.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Asset not found');
  return rows[0]!;
}

export async function createAsset(input: CreateAssetInput, orgId: string, userId: string) {
  const visibility = input.visibility && VISIBILITIES.has(input.visibility) ? input.visibility : 'organization';
  // An asset is created with no version yet; the first POST /assets/:id/versions
  // + complete mints version 1 and advances current_version_id. object_key on
  // the asset row mirrors the active version's key (empty until first complete).
  const rows = await db
    .insert(binAssets)
    .values({
      org_id: orgId,
      project_id: input.project_id ?? null,
      folder_id: input.folder_id ?? null,
      name: input.name,
      content_type: input.content_type,
      object_key: '',
      size: 0,
      scan_status: 'pending',
      visibility,
      tags: input.tags ?? [],
      created_by: userId,
    })
    .returning();
  return rows[0]!;
}

/**
 * Patch an asset's mutable metadata (name, folder, tags). Org-scoped; only the
 * fields present in `input` are written. folder_id may be set to null to move
 * the asset back to root. Throws NotFoundError if the asset does not exist in
 * this org.
 */
export async function updateAsset(id: string, orgId: string, input: UpdateAssetInput) {
  const updates: Partial<typeof binAssets.$inferInsert> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.folder_id !== undefined) updates.folder_id = input.folder_id;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (Object.keys(updates).length === 0) {
    // Nothing to change — return the current row (still org-scoped).
    return getAsset(id, orgId);
  }
  const rows = await db
    .update(binAssets)
    .set(updates)
    .where(and(eq(binAssets.id, id), eq(binAssets.org_id, orgId)))
    .returning();
  if (rows.length === 0) throw new NotFoundError('Asset not found');
  return rows[0]!;
}

/**
 * Distinct tags applied across all non-archived assets in the org, sorted
 * alphabetically. Powers tag-filter pickers.
 */
export async function listTags(orgId: string): Promise<string[]> {
  const result = await db.execute<{ t: string }>(
    sql`SELECT DISTINCT unnest(tags) AS t FROM bin_assets WHERE org_id = ${orgId} AND archived_at IS NULL ORDER BY t`,
  );
  // db.execute returns an array-like RowList directly (postgres-js); fall back to
  // a { rows } envelope defensively to match the rest of the codebase.
  const rows = Array.isArray(result)
    ? (result as unknown as { t: string }[])
    : ((result as { rows?: { t: string }[] })?.rows ?? []);
  return rows.map((r) => r.t);
}

export async function archiveAsset(id: string, orgId: string) {
  const rows = await db
    .update(binAssets)
    .set({ archived_at: new Date() })
    .where(and(eq(binAssets.id, id), eq(binAssets.org_id, orgId), isNull(binAssets.archived_at)))
    .returning();
  if (rows.length === 0) {
    // Either not found or already archived — disambiguate.
    await getAsset(id, orgId);
    throw new ConflictError('Asset is already archived');
  }
  return rows[0]!;
}

export async function listVersions(assetId: string, orgId: string) {
  await getAsset(assetId, orgId);
  return db
    .select()
    .from(binAssetVersions)
    .where(eq(binAssetVersions.asset_id, assetId))
    .orderBy(desc(binAssetVersions.version_number));
}

export async function getVersion(versionId: string, orgId: string) {
  const rows = await db
    .select({ version: binAssetVersions, asset_org: binAssets.org_id })
    .from(binAssetVersions)
    .innerJoin(binAssets, eq(binAssets.id, binAssetVersions.asset_id))
    .where(eq(binAssetVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row || row.asset_org !== orgId) throw new NotFoundError('Version not found');
  return row.version;
}

// ---------------------------------------------------------------------------
// Upload flow (Bin master §9.2)
// ---------------------------------------------------------------------------

export interface PresignedVersionUpload {
  version_id: string;
  object_key: string;
  upload_url: string;
  expires_in: number;
  method: 'PUT';
}

/**
 * Step 1 of upload: reserve a version row in a `pending` storage state and hand
 * back a presigned PUT so the browser uploads bytes directly to the provider
 * (bytes skip the API). The row is finalized by completeVersion() after the PUT.
 * In this slice we use the bootstrap `local` driver (binding_id stays null).
 */
export async function presignVersionUpload(
  assetId: string,
  orgId: string,
  userId: string,
  opts: { filename?: string; content_type?: string } = {},
): Promise<PresignedVersionUpload> {
  const asset = await getAsset(assetId, orgId);
  const driver = getMediaDriver();
  if (!driver.presignPut) {
    throw new StorageError('Active media provider does not support presigned uploads');
  }
  const contentType = opts.content_type ?? asset.content_type ?? 'application/octet-stream';
  const filename = opts.filename ?? asset.name;
  const versionUuid = randomUUID();
  const objectKey = buildBinObjectKey(orgId, assetId, versionUuid, filename);

  const nextNumber = await nextVersionNumber(assetId);
  const inserted = await db
    .insert(binAssetVersions)
    .values({
      id: versionUuid,
      asset_id: assetId,
      version_number: nextNumber,
      binding_id: null,
      object_key: objectKey,
      size: 0,
      content_type: contentType,
      uploaded_by: userId,
    })
    .returning();

  const url = await driver.presignPut(objectKey, env.PRESIGN_PUT_TTL_SECONDS, { contentType });
  return {
    version_id: inserted[0]!.id,
    object_key: objectKey,
    upload_url: url,
    expires_in: env.PRESIGN_PUT_TTL_SECONDS,
    method: 'PUT',
  };
}

async function nextVersionNumber(assetId: string): Promise<number> {
  const rows = await db
    .select({ n: binAssetVersions.version_number })
    .from(binAssetVersions)
    .where(eq(binAssetVersions.asset_id, assetId))
    .orderBy(desc(binAssetVersions.version_number))
    .limit(1);
  return (rows[0]?.n ?? 0) + 1;
}

/**
 * Step 2 of upload: the client confirms the PUT landed. stat() the object to
 * verify size/integrity, finalize the version row, advance the asset's
 * current_version_id + active reference shape, and (re)set scan_status='pending'
 * so the (net-new, later slice) AV scan job gates serving.
 */
export async function completeVersion(versionId: string, orgId: string) {
  const version = await getVersion(versionId, orgId);
  const driver = getMediaDriver();
  const stat = await driver.stat(version.object_key);
  if (!stat) {
    throw new ConflictError('Uploaded object not found in storage — was the PUT completed?');
  }

  const finalizedVersion = await db
    .update(binAssetVersions)
    .set({ size: stat.size, integrity: stat.integrity })
    .where(eq(binAssetVersions.id, versionId))
    .returning();

  const updatedAsset = await db
    .update(binAssets)
    .set({
      current_version_id: versionId,
      object_key: version.object_key,
      size: stat.size,
      integrity: stat.integrity,
      content_type: version.content_type,
      scan_status: 'pending',
    })
    .where(eq(binAssets.id, version.asset_id))
    .returning();

  return { version: finalizedVersion[0]!, asset: updatedAsset[0]! };
}

// ---------------------------------------------------------------------------
// Proxied upload/serve (Bin master §9.2/§9.3 fallback path)
//
// Presigned PUT/GET hands the browser a URL pointing straight at the storage
// provider. That only works when the provider endpoint is reachable from the
// browser. The bundled local MinIO is on the internal docker network with no
// public/host-mapped endpoint (S3_ENDPOINT=http://minio:9000), so the suite has
// always proxied bytes through the service for the bootstrap provider — see
// apps/api POST /upload + GET /files/* (AB-2, D-7). Bin mirrors that: these are
// the default upload/serve paths the SPA uses; the presigned routes above stay
// for deployments that configure a browser-reachable provider endpoint.
// ---------------------------------------------------------------------------

/**
 * Proxied upload: stream bytes through the service to the active driver, then
 * finalize the version (stat + advance current_version_id + scan_status pending)
 * in one call. Equivalent to presignVersionUpload + the client PUT +
 * completeVersion, but the bytes traverse the API so no browser-reachable
 * provider endpoint is required.
 */
export async function uploadVersionBytes(
  assetId: string,
  orgId: string,
  userId: string,
  body: Buffer,
  opts: { filename?: string; content_type?: string } = {},
) {
  const asset = await getAsset(assetId, orgId);
  const driver = getMediaDriver();
  const contentType = opts.content_type ?? asset.content_type ?? 'application/octet-stream';
  const filename = opts.filename ?? asset.name;
  const versionUuid = randomUUID();
  const objectKey = buildBinObjectKey(orgId, assetId, versionUuid, filename);

  await driver.put(objectKey, body, { contentType, size: body.length });
  const stat = await driver.stat(objectKey);
  if (!stat) {
    throw new StorageError('Upload did not land in storage');
  }

  const nextNumber = await nextVersionNumber(assetId);
  const inserted = await db
    .insert(binAssetVersions)
    .values({
      id: versionUuid,
      asset_id: assetId,
      version_number: nextNumber,
      binding_id: null,
      object_key: objectKey,
      size: stat.size,
      integrity: stat.integrity,
      content_type: contentType,
      uploaded_by: userId,
    })
    .returning();

  const updatedAsset = await db
    .update(binAssets)
    .set({
      current_version_id: versionUuid,
      object_key: objectKey,
      size: stat.size,
      integrity: stat.integrity,
      content_type: contentType,
      scan_status: 'pending',
    })
    .where(eq(binAssets.id, assetId))
    .returning();

  return { version: inserted[0]!, asset: updatedAsset[0]! };
}

/**
 * Proxied serve: stream an asset's current version through the service. Gated on
 * scan_status exactly like presignAssetDownload (§9.3): only `clean`/`skipped`
 * assets are served.
 */
export async function streamAssetDownload(
  assetId: string,
  orgId: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; filename: string }> {
  const asset = await getAsset(assetId, orgId);
  if (!asset.current_version_id || !asset.object_key) {
    throw new NotFoundError('Asset has no uploaded content yet');
  }
  if (asset.scan_status !== 'clean' && asset.scan_status !== 'skipped') {
    throw new ConflictError(`Asset is not servable (scan status: ${asset.scan_status})`);
  }
  const driver = getMediaDriver();
  const { stream, contentType, size } = await driver.getStream(asset.object_key);
  return { stream, contentType, size, filename: asset.name };
}

/** Whether the active media driver can serve byte ranges (video/audio seeking). */
export function hasRangeSupport(): boolean {
  return typeof getMediaDriver().getRange === 'function';
}

/** Total size + content type of an asset's current version (scan-gated), used to
 *  compute Range windows without buffering the object. */
export async function statServable(
  assetId: string,
  orgId: string,
): Promise<{ total: number; contentType: string; filename: string }> {
  const asset = await getAsset(assetId, orgId);
  if (!asset.current_version_id || !asset.object_key) {
    throw new NotFoundError('Asset has no uploaded content yet');
  }
  if (asset.scan_status !== 'clean' && asset.scan_status !== 'skipped') {
    throw new ConflictError(`Asset is not servable (scan status: ${asset.scan_status})`);
  }
  const stat = await getMediaDriver().stat(asset.object_key);
  if (!stat) throw new NotFoundError('Object not found in storage');
  return {
    total: stat.size,
    contentType: asset.content_type ?? 'application/octet-stream',
    filename: asset.name,
  };
}

/**
 * Partial (HTTP Range) serve of an asset's current version, for media seeking.
 * Same scan gate as streamAssetDownload (§9.3). Returns the byte range plus the
 * object's total size so the route can emit a 206 with Content-Range.
 */
export async function streamAssetRange(
  assetId: string,
  orgId: string,
  start: number,
  end: number,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; total: number; filename: string }> {
  const asset = await getAsset(assetId, orgId);
  if (!asset.current_version_id || !asset.object_key) {
    throw new NotFoundError('Asset has no uploaded content yet');
  }
  if (asset.scan_status !== 'clean' && asset.scan_status !== 'skipped') {
    throw new ConflictError(`Asset is not servable (scan status: ${asset.scan_status})`);
  }
  const driver = getMediaDriver();
  if (!driver.getRange) {
    throw new StorageError('Active media provider does not support range reads');
  }
  const r = await driver.getRange(asset.object_key, start, end);
  return { ...r, filename: asset.name };
}

export interface PresignedDownload {
  object_key: string;
  download_url: string;
  expires_in: number;
}

/**
 * Presigned GET for an asset's current version. Serving is gated on scan_status
 * (Bin master §9.3): only `clean` / `skipped` assets are served; a `pending` /
 * `infected` / `error` asset returns a scan-state error instead of a URL.
 */
export async function presignAssetDownload(assetId: string, orgId: string): Promise<PresignedDownload> {
  const asset = await getAsset(assetId, orgId);
  if (!asset.current_version_id || !asset.object_key) {
    throw new NotFoundError('Asset has no uploaded content yet');
  }
  if (asset.scan_status !== 'clean' && asset.scan_status !== 'skipped') {
    throw new ConflictError(`Asset is not servable (scan status: ${asset.scan_status})`);
  }
  const driver = getMediaDriver();
  if (!driver.presignGet) {
    throw new StorageError('Active media provider does not support presigned reads');
  }
  const url = await driver.presignGet(asset.object_key, env.PRESIGN_GET_TTL_SECONDS);
  return {
    object_key: asset.object_key,
    download_url: url,
    expires_in: env.PRESIGN_GET_TTL_SECONDS,
  };
}
