import { and, eq, desc, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bayAssets } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from './errors.js';

export { NotFoundError, ConflictError } from './errors.js';

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'model']);

export interface CreateAssetInput {
  name: string;
  media_kind: 'image' | 'video' | 'audio' | 'model';
  project_id?: string | null;
}

export async function listAssets(
  orgId: string,
  opts: { project_id?: string; include_archived?: boolean } = {},
) {
  const conditions = [eq(bayAssets.org_id, orgId)];
  if (opts.project_id) {
    conditions.push(eq(bayAssets.project_id, opts.project_id));
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
      name: input.name,
      media_kind: input.media_kind,
      created_by: userId,
    })
    .returning();
  return rows[0]!;
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
