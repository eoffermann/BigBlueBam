-- 0223_bin_model_media_meta.sql
-- Why: Bay FBX 3D review (BigBlueBam_Bay_FBX_3D_Review_Design_Document.md §3, §10.1).
--   The model-process worker probes a converted GLB and records bounds, counts,
--   skeleton, animation clips, and source up-axis/unit. That probe describes the
--   bytes, so it lives on bin_assets next to the canonical asset (any future
--   consumer gets it free); Bay copies it forward to bay_asset_versions.media_meta.
-- Client impact: additive only (one nullable jsonb column).

ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS media_meta JSONB;
