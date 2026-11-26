// Bin asset access for manual evidence (spec 3.3), modeled on Bursar's four-check gate
// (apps/bursar-api/src/lib/bin-asset-access.ts):
//
//   1. the asset exists;
//   2. it belongs to the acting org (defence in depth; bin_assets has no RLS);
//   3. can_access('bin.asset', asker, asset) through the shared visibility client (fail-closed);
//   4. it has a materialized current version to pin.
//
// Any failure is a 404 ("We could not find that file in Bin"), so existence is not confirmable.
// Unlike Bursar, scan state is NOT a refusal here: Bastion maps it (spec 3.3 table) to copy now,
// wait, or block, and the caller records the outcome on the manual-evidence row.
//
// Pure and dependency-injected: no env, no db, so the refusal cases are unit-testable.

import { BASTION_BIN_SCAN_OUTCOME, type BastionBinScanStatus } from '@bigbluebam/shared';
import { NotFoundError } from './errors.js';

export interface BinAssetRow {
  id: string;
  org_id: string;
  scan_status: string;
  current_version_id: string | null;
}

export interface BinVersionRow {
  id: string;
  asset_id: string;
  object_key: string;
  size: number;
  content_type: string;
}

export interface BinAccessDeps {
  /** bin_assets by id with NO org predicate (the org check below must see a foreign row). */
  loadAsset(assetId: string): Promise<BinAssetRow | null>;
  loadVersion(versionId: string): Promise<BinVersionRow | null>;
  /** can_access through the platform resolver. Fail-closed. */
  canAccess(askerUserId: string, entityType: string, entityId: string): Promise<boolean>;
}

export type ScanDecision =
  | { action: 'copy'; scan_label: 'clean' | 'not_scanned' }
  | { action: 'wait' }
  | { action: 'block'; blocked_reason: 'infected' | 'scan_failed' };

/** The spec 3.3 scan-state table. An unknown status waits (it never copies unscanned bytes). */
export function scanDecision(scanStatus: string): ScanDecision {
  const row = (BASTION_BIN_SCAN_OUTCOME as Record<string, (typeof BASTION_BIN_SCAN_OUTCOME)[BastionBinScanStatus]>)[scanStatus];
  if (!row) return { action: 'wait' };
  if (row.action === 'copy') return { action: 'copy', scan_label: row.scan_label };
  if (row.action === 'block') return { action: 'block', blocked_reason: row.blocked_reason };
  return { action: 'wait' };
}

const NOT_FOUND = 'We could not find that file in Bin. Upload it to Bin first, then attach it here.';

/**
 * The attach-time gate. Returns the asset, the version to PIN, and the scan decision. Order is
 * deliberate: the two cheap local refusals run before the network hop, so no cross-tenant pair
 * is ever sent to the resolver.
 */
export async function resolveBinAssetForEvidence(
  deps: BinAccessDeps,
  actingUserId: string,
  orgId: string,
  assetId: string,
): Promise<{ asset: BinAssetRow; version: BinVersionRow; decision: ScanDecision }> {
  const asset = await deps.loadAsset(assetId);
  if (!asset) throw new NotFoundError(NOT_FOUND);
  if (asset.org_id !== orgId) throw new NotFoundError(NOT_FOUND);
  if (!(await deps.canAccess(actingUserId, 'bin.asset', assetId))) throw new NotFoundError(NOT_FOUND);
  if (!asset.current_version_id) throw new NotFoundError(NOT_FOUND);
  const version = await deps.loadVersion(asset.current_version_id);
  if (!version || version.asset_id !== asset.id) throw new NotFoundError(NOT_FOUND);
  return { asset, version, decision: scanDecision(asset.scan_status) };
}

/**
 * The retry-time re-check for a `pending_scan` item (the evidence-ingest engine). The pinned
 * version stays authoritative: if Bin has moved on to a newer version before the pinned one was
 * copied, the item is blocked `changed_before_scan` (spec 3.3), never silently re-pinned.
 */
export async function recheckPinnedAsset(
  deps: Pick<BinAccessDeps, 'loadAsset' | 'loadVersion'>,
  orgId: string,
  assetId: string,
  pinnedVersionId: string,
): Promise<
  | { kind: 'gone' }
  | { kind: 'changed' }
  | { kind: 'decided'; version: BinVersionRow; decision: ScanDecision }
> {
  const asset = await deps.loadAsset(assetId);
  if (!asset || asset.org_id !== orgId) return { kind: 'gone' };
  if (asset.current_version_id !== pinnedVersionId) return { kind: 'changed' };
  const version = await deps.loadVersion(pinnedVersionId);
  if (!version || version.asset_id !== asset.id) return { kind: 'gone' };
  return { kind: 'decided', version, decision: scanDecision(asset.scan_status) };
}
