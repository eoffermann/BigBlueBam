import { describe, it, expect, vi } from 'vitest';
import {
  assertBinAssetReadable,
  reassertBinAssetReadableForRead,
  type BinAssetAccessDeps,
  type BinAssetRow,
} from '../src/lib/bin-asset-access.js';
import { AssetAccessError } from '../src/lib/errors.js';

// §5.8: a Bin asset is readable by Bursar only if it exists, belongs to the acting org, passes
// can_access, and is scan_status='clean'. Any failure is a 404 (AssetAccessError), and NOTHING
// is written (no version is pinned). The five cases below are the ones spec 5.8 / M2 enumerate.

const ORG = 'org-1111-1111-1111-111111111111';
const OTHER_ORG = 'org-2222-2222-2222-222222222222';
const USER = 'usr-3333-3333-3333-333333333333';
const ASSET = 'ast-4444-4444-4444-444444444444';
const V1 = 'ver-1111-1111-1111-111111111111';
const V2 = 'ver-2222-2222-2222-222222222222';

function deps(asset: BinAssetRow | null, canAccess = true): {
  d: BinAssetAccessDeps;
  loadAsset: ReturnType<typeof vi.fn>;
  canAccessFn: ReturnType<typeof vi.fn>;
} {
  const loadAsset = vi.fn(async () => asset);
  const canAccessFn = vi.fn(async () => canAccess);
  return { d: { loadAsset, canAccess: canAccessFn }, loadAsset, canAccessFn };
}

/**
 * The attach flow as the request service performs it: assert, and ONLY on success pin the
 * resolved version. The pin spy proves nothing is written on a refusal.
 */
async function attachFlow(d: BinAssetAccessDeps, pin: (versionId: string) => void) {
  const { bin_asset_version_id } = await assertBinAssetReadable(d, USER, ORG, ASSET);
  pin(bin_asset_version_id);
  return bin_asset_version_id;
}

describe('assertBinAssetReadable (attach)', () => {
  it('CASE 1 cross-org: refuses (404) and writes nothing', async () => {
    const { d, canAccessFn } = deps({
      id: ASSET,
      org_id: OTHER_ORG,
      scan_status: 'clean',
      current_version_id: V1,
    });
    const pin = vi.fn();
    await expect(attachFlow(d, pin)).rejects.toBeInstanceOf(AssetAccessError);
    expect(pin).not.toHaveBeenCalled();
    // Cross-org dies before the network hop: can_access is never consulted for another
    // tenant's asset.
    expect(canAccessFn).not.toHaveBeenCalled();
  });

  it('CASE 2 private-same-org: refuses (404) and writes nothing', async () => {
    const { d } = deps(
      { id: ASSET, org_id: ORG, scan_status: 'clean', current_version_id: V1 },
      /* canAccess */ false,
    );
    const pin = vi.fn();
    await expect(attachFlow(d, pin)).rejects.toBeInstanceOf(AssetAccessError);
    expect(pin).not.toHaveBeenCalled();
  });

  it('CASE 3 unscanned: refuses (404) and writes nothing', async () => {
    const { d } = deps({
      id: ASSET,
      org_id: ORG,
      scan_status: 'pending',
      current_version_id: V1,
    });
    const pin = vi.fn();
    await expect(attachFlow(d, pin)).rejects.toBeInstanceOf(AssetAccessError);
    expect(pin).not.toHaveBeenCalled();
  });

  it('a clean, same-org, visible asset attaches and pins its current version', async () => {
    const { d } = deps({ id: ASSET, org_id: ORG, scan_status: 'clean', current_version_id: V1 });
    const pin = vi.fn();
    const pinned = await attachFlow(d, pin);
    expect(pinned).toBe(V1);
    expect(pin).toHaveBeenCalledWith(V1);
  });

  it('refuses a missing asset', async () => {
    const { d } = deps(null);
    const pin = vi.fn();
    await expect(attachFlow(d, pin)).rejects.toBeInstanceOf(AssetAccessError);
    expect(pin).not.toHaveBeenCalled();
  });

  it('refuses a clean asset with no materialized version rather than pinning null', async () => {
    const { d } = deps({ id: ASSET, org_id: ORG, scan_status: 'clean', current_version_id: null });
    const pin = vi.fn();
    await expect(attachFlow(d, pin)).rejects.toBeInstanceOf(AssetAccessError);
    expect(pin).not.toHaveBeenCalled();
  });
});

describe('reassertBinAssetReadableForRead (worker read)', () => {
  it('CASE 4 flipped-after-attach: scan_status flips to infected, read refuses and never parses', async () => {
    // Attach saw it clean and pinned V1; by read time the AV scan flipped it to infected.
    const { d } = deps({
      id: ASSET,
      org_id: ORG,
      scan_status: 'infected',
      current_version_id: V1,
    });
    const parse = vi.fn();
    await expect(
      reassertBinAssetReadableForRead(d, ORG, ASSET, V1).then((r) => parse(r.bin_asset_version_id)),
    ).rejects.toBeInstanceOf(AssetAccessError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('CASE 4b flipped-to-other-org after attach: read refuses', async () => {
    const { d } = deps({
      id: ASSET,
      org_id: OTHER_ORG,
      scan_status: 'clean',
      current_version_id: V1,
    });
    await expect(reassertBinAssetReadableForRead(d, ORG, ASSET, V1)).rejects.toBeInstanceOf(
      AssetAccessError,
    );
  });

  it('CASE 5 version-advanced-after-attach: reads the PINNED version, never the advanced bytes', async () => {
    // current_version_id has advanced to V2, but the request pinned V1 at attach.
    const { d } = deps({
      id: ASSET,
      org_id: ORG,
      scan_status: 'clean',
      current_version_id: V2,
    });
    const { bin_asset_version_id } = await reassertBinAssetReadableForRead(d, ORG, ASSET, V1);
    expect(bin_asset_version_id).toBe(V1);
    expect(bin_asset_version_id).not.toBe(V2);
  });
});
