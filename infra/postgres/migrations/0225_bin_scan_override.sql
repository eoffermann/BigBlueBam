-- 0225_bin_scan_override.sql
-- Why: A virus scan can false-positive (or a transient scan error) and leave a
--      known-good Bin asset permanently unservable. This adds a persistent
--      per-file override so an admin/SuperUser can clear a specific file's scan
--      prohibition for everyone (incl. Bay guest review links), with a who/when/
--      why audit trail. Serving treats scan_override_at IS NOT NULL as servable
--      regardless of scan_status.
-- Client impact: additive only. Three new nullable columns on bin_assets, no
--      data migration. Re-running is safe (ADD COLUMN IF NOT EXISTS).

ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS scan_override_at TIMESTAMPTZ;
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS scan_overridden_by UUID;
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS scan_override_reason TEXT;
