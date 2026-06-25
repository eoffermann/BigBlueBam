import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bayAssets } from '../db/schema/index.js';
import * as versionService from './version.service.js';
import { NotFoundError, ConflictError } from './errors.js';

export { NotFoundError, ConflictError } from './errors.js';

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'model']);

export type MediaKind = 'image' | 'video' | 'audio' | 'model';

export interface CreateAssetInput {
  name: string;
  media_kind: MediaKind;
  project_id?: string | null;
  folder_id?: string | null;
  tags?: string[];
  bin_asset_id?: string | null;
}

/**
 * Map an HTTP content type to a Bay media kind. image/* -> image, video/* ->
 * video, audio/* -> audio; anything else (incl. empty/unknown) -> model.
 */
export function mediaKindFromContentType(ct: string): MediaKind {
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'model';
}

export async function listAssets(
  orgId: string,
  opts: { project_id?: string; include_archived?: boolean; folder_id?: string | null; tag?: string } = {},
) {
  const conditions = [eq(bayAssets.org_id, orgId)];
  if (opts.project_id) {
    conditions.push(eq(bayAssets.project_id, opts.project_id));
  }
  if (opts.folder_id === null) {
    conditions.push(isNull(bayAssets.folder_id));
  } else if (typeof opts.folder_id === 'string') {
    conditions.push(eq(bayAssets.folder_id, opts.folder_id));
  }
  if (opts.tag) {
    conditions.push(sql`${bayAssets.tags} @> ARRAY[${opts.tag}]::text[]`);
  }
  if (!opts.include_archived) {
    conditions.push(isNull(bayAssets.archived_at));
  }
  return db
    .select()
    .from(bayAssets)
    .where(and(...conditions))
    .orderBy(desc(bayAssets.created_at));
}

export async function getAsset(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(bayAssets)
    .where(and(eq(bayAssets.id, id), eq(bayAssets.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Asset not found');
  return rows[0]!;
}

export async function createAsset(input: CreateAssetInput, orgId: string, userId: string) {
  if (!MEDIA_KINDS.has(input.media_kind)) {
    throw new ConflictError(`Unsupported media_kind: ${input.media_kind}`);
  }
  // A Bay asset is created with no version yet; the first POST
  // /assets/:id/versions mints version 1 and advances current_version_id.
  const rows = await db
    .insert(bayAssets)
    .values({
      org_id: orgId,
      project_id: input.project_id ?? null,
      folder_id: input.folder_id ?? null,
      name: input.name,
      media_kind: input.media_kind,
      tags: input.tags ?? [],
      bin_asset_id: input.bin_asset_id ?? null,
      created_by: userId,
    })
    .returning();
  return rows[0]!;
}

export interface ResolveReviewInput {
  bin_asset_id: string;
  bin_version_id?: string | null;
  name?: string;
  media_kind?: MediaKind;
  content_type?: string;
}

/**
 * Idempotently resolve the Bay review surface for a Bin asset. If a bay_asset
 * already links to the given bin_asset_id (in this org), return it as-is.
 * Otherwise create one and mint an initial version referencing the Bin
 * asset/version, then return the bay_asset.
 */
export async function resolveReviewByBinAsset(
  orgId: string,
  userId: string,
  input: ResolveReviewInput,
) {
  const existing = await db
    .select()
    .from(bayAssets)
    .where(and(eq(bayAssets.org_id, orgId), eq(bayAssets.bin_asset_id, input.bin_asset_id)))
    .limit(1);
  if (existing.length > 0) return existing[0]!;

  const mediaKind = input.media_kind ?? mediaKindFromContentType(input.content_type ?? '');
  const created = await createAsset(
    {
      name: input.name || 'Untitled',
      media_kind: mediaKind,
      bin_asset_id: input.bin_asset_id,
    },
    orgId,
    userId,
  );

  // Mint version 1 referencing the Bin bytes (advances current_version_id).
  await versionService.createVersion(created.id, orgId, userId, {
    bin_asset_id: input.bin_asset_id,
    bin_version_id: input.bin_version_id ?? null,
  });

  // Re-read so the returned row carries the advanced current_version_id.
  return getAsset(created.id, orgId);
}

export async function archiveAsset(id: string, orgId: string) {
  const rows = await db
    .update(bayAssets)
    .set({ archived_at: new Date() })
    .where(and(eq(bayAssets.id, id), eq(bayAssets.org_id, orgId), isNull(bayAssets.archived_at)))
    .returning();
  if (rows.length === 0) {
    // Either not found or already archived — disambiguate.
    await getAsset(id, orgId);
    throw new ConflictError('Asset is already archived');
  }
  return rows[0]!;
}
