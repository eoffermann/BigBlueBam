// Bin asset access - checked at attach AND at read (spec 5.8).
//
// bin_assets uses org_id, and org-scoping ALONE is insufficient: Bin has private and
// project-scoped assets, so a member who cannot see a private asset could still put its uuid
// in bin_asset_id and get its verbatim text into Bursar as cited spans. So every read of a Bin
// asset by Bursar passes FOUR checks, and any failure is a 404 (never 403) so existence is not
// confirmable:
//
//   1. can_access('bin.asset', asker, asset) via the shared visibility-client (fail-closed);
//   2. asset.org_id === the acting org (defence in depth);
//   3. asset.scan_status === 'clean';
//   4. the asset exists at all.
//
// AT ATTACH, assertBinAssetReadable resolves and PINS the current_version_id onto the
// referencing bursar_requests row, so the exact bytes are frozen.
//
// AT READ (the worker, later milestones), reassertBinAssetReadableForRead re-checks
// scan_status='clean' and org_id IMMEDIATELY before the byte read and reads THE PINNED
// version. Parsing is async, so between attach and parse scan_status can flip to infected,
// visibility can flip to private, and current_version_id can advance to different bytes. A
// failed re-assertion lands `blocked` and never parses.
//
// The module is dependency-injected (asset loader + access checker) so the five refusal cases
// are unit-testable without a live DB or a live can_access endpoint. This file is deliberately
// PURE - it imports neither env nor db - so the unit test can load it without booting the env
// (which process.exits when the service env vars are absent). The production factories that
// need db + env + the visibility client live in bin-asset-access.db.ts.

import { AssetAccessError } from './errors.js';

export interface BinAssetRow {
  id: string;
  org_id: string;
  scan_status: string;
  current_version_id: string | null;
}

/** Loads a bin_assets row by id, WITHOUT an org predicate, so a cross-org row is still
 *  returned and then rejected on the org-equality check (which is what proves the cross-org
 *  case fails rather than silently 404ing as "not found in my org"). */
export type BinAssetLoader = (assetId: string) => Promise<BinAssetRow | null>;

/** Confirms the asker may see (entityType, entityId). Fail-closed. */
export type AccessChecker = (
  askerUserId: string,
  entityType: string,
  entityId: string,
) => Promise<boolean>;

export interface BinAssetAccessDeps {
  loadAsset: BinAssetLoader;
  canAccess: AccessChecker;
}

/**
 * The pure four-check gate. Returns the resolved current_version_id to PIN on success; throws
 * AssetAccessError (mapped to 404) on ANY failure. Writes nothing.
 *
 * Order is deliberate: existence, then org equality, then can_access, then scan_status. The
 * can_access probe is the network hop, so the two cheap local rejections (missing / wrong-org)
 * short-circuit before it, and no cross-tenant asker/asset pair is ever sent to the resolver.
 */
export async function assertBinAssetReadable(
  deps: BinAssetAccessDeps,
  actingUserId: string,
  orgId: string,
  assetId: string,
): Promise<{ bin_asset_version_id: string }> {
  const asset = await deps.loadAsset(assetId);
  // 4. exists
  if (!asset) throw new AssetAccessError();
  // 2. org equality (defence in depth) - the cross-org case dies here.
  if (asset.org_id !== orgId) throw new AssetAccessError();
  // 1. visibility preflight - the private-same-org case dies here.
  const allowed = await deps.canAccess(actingUserId, 'bin.asset', assetId);
  if (!allowed) throw new AssetAccessError();
  // 3. scan status - the unscanned / infected case dies here.
  if (asset.scan_status !== 'clean') throw new AssetAccessError();
  // A clean asset with no materialized version cannot be read: refuse rather than pin null.
  if (!asset.current_version_id) throw new AssetAccessError();
  return { bin_asset_version_id: asset.current_version_id };
}

/**
 * The read-time re-assertion for the worker (used by later milestones). Re-checks org equality
 * and scan_status='clean' immediately before the byte read, and confirms THE PINNED version is
 * still the one to read. Returns the version id to read; throws on any failure so the caller
 * lands `blocked` and never parses.
 *
 * The pinned version is authoritative: even if current_version_id has advanced, this returns
 * the pinned id (the bytes Bursar was granted access to and froze at attach), never the newer
 * bytes. If scan_status has flipped away from clean, or the org no longer matches, it refuses.
 */
export async function reassertBinAssetReadableForRead(
  deps: BinAssetAccessDeps,
  orgId: string,
  assetId: string,
  pinnedVersionId: string,
): Promise<{ bin_asset_version_id: string }> {
  const asset = await deps.loadAsset(assetId);
  if (!asset) throw new AssetAccessError();
  if (asset.org_id !== orgId) throw new AssetAccessError();
  if (asset.scan_status !== 'clean') throw new AssetAccessError();
  if (!pinnedVersionId) throw new AssetAccessError();
  // Read the pinned bytes, NOT current_version_id, even if the asset has since advanced.
  return { bin_asset_version_id: pinnedVersionId };
}
