-- 0214_bay_review_links_bin_asset.sql
-- Why: Unify the model — Bin is the single file store + hierarchy; Bay is the
--      review surface over Bin media. A Bay review asset now links 1:1 to the
--      Bin asset it reviews (bin_asset_id), so opening a media file in Bin opens
--      its review in Bay (find-or-create by bin_asset_id).
-- Client impact: additive only. One nullable column + a partial unique index.
--      Existing bay_assets keep bin_asset_id NULL (standalone reviews). Re-runs
--      are safe (IF NOT EXISTS).

ALTER TABLE bay_assets ADD COLUMN IF NOT EXISTS bin_asset_id UUID;

-- At most one review per (org, bin asset): find-or-create resolves to it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bay_assets_org_bin_asset
  ON bay_assets(org_id, bin_asset_id)
  WHERE bin_asset_id IS NOT NULL;
