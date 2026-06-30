import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bayAssets, bayAssetVersions } from '../db/schema/index.js';
import { getAsset } from './asset.service.js';
import { NotFoundError } from './errors.js';

export interface CreateVersionInput {
  bin_asset_id?: string | null;
  bin_version_id?: string | null;
  media_meta?: Record<string, unknown>;
}

export async function listVersions(assetId: string, orgId: string) {
  await getAsset(assetId, orgId);
  return db
    .select()
    .from(bayAssetVersions)
    .where(eq(bayAssetVersions.asset_id, assetId))
    .orderBy(desc(bayAssetVersions.version_number));
}

/**
 * Resolve a version by id, org-scoped via a join through bay_assets. Throws
 * NotFoundError if the version does not exist or belongs to another org.
 */
export async function getVersion(versionId: string, orgId: string) {
  const rows = await db
    .select({ version: bayAssetVersions, asset_org: bayAssets.org_id })
    .from(bayAssetVersions)
    .innerJoin(bayAssets, eq(bayAssets.id, bayAssetVersions.asset_id))
    .where(eq(bayAssetVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row || row.asset_org !== orgId) throw new NotFoundError('Version not found');
  return row.version;
}

async function nextVersionNumber(assetId: string): Promise<number> {
  const rows = await db
    .select({ n: bayAssetVersions.version_number })
    .from(bayAssetVersions)
    .where(eq(bayAssetVersions.asset_id, assetId))
    .orderBy(desc(bayAssetVersions.version_number))
    .limit(1);
  return (rows[0]?.n ?? 0) + 1;
}

/**
 * Mint a new immutable version for an asset. Assigns the next monotonic
 * version_number, records the Bin asset/version holding the canonical bytes,
 * and advances the asset's denormalized current_version_id.
 */
export async function createVersion(
  assetId: string,
  orgId: string,
  userId: string,
  input: CreateVersionInput,
) {
  await getAsset(assetId, orgId);
  const nextNumber = await nextVersionNumber(assetId);

  // Copy forward the Bin probe metadata (Bay FBX §3, §9). When the bin asset has
  // already been probed (e.g. re-versioning a model), merge its media_meta as the
  // base so the player reads bounds/counts/animations without a byte round-trip;
  // any client-supplied fields win. On first upload the probe usually has not run
  // yet, so this is empty and the bin-model-process worker propagates it later.
  let baseMeta: Record<string, unknown> = {};
  if (input.bin_asset_id) {
    try {
      const r = await db.execute(
        sql`SELECT media_meta FROM bin_assets WHERE id = ${input.bin_asset_id} LIMIT 1`,
      );
      const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
      const bm = (rows[0] as { media_meta?: Record<string, unknown> } | undefined)?.media_meta;
      if (bm && typeof bm === 'object') baseMeta = bm;
    } catch {
      // best-effort; the worker propagation is the backstop
    }
  }

  const inserted = await db
    .insert(bayAssetVersions)
    .values({
      asset_id: assetId,
      version_number: nextNumber,
      bin_asset_id: input.bin_asset_id ?? null,
      bin_version_id: input.bin_version_id ?? null,
      media_meta: { ...baseMeta, ...(input.media_meta ?? {}) },
      uploaded_by: userId,
    })
    .returning();
  const version = inserted[0]!;

  const updatedAsset = await db
    .update(bayAssets)
    .set({ current_version_id: version.id })
    .where(eq(bayAssets.id, assetId))
    .returning();

  return { version, asset: updatedAsset[0]! };
}
