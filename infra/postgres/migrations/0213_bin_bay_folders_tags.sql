-- 0213_bin_bay_folders_tags.sql
-- Why: Organization + searchability for media. Adds arbitrary tags to Bin and
--      Bay assets (text[] + GIN index) and gives Bay the same folder hierarchy
--      Bin already has (bay_folders + bay_assets.folder_id). Bin folders already
--      exist (0205); this only adds Bin tags.
-- Client impact: additive only. New column(s), one new table, indexes. No data
--      migration. Re-running is safe (IF NOT EXISTS + guarded ADDs).

-- ── Bin: arbitrary tags ─────────────────────────────────────────────────────
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_bin_assets_tags ON bin_assets USING GIN (tags);

-- ── Bay: folder hierarchy (mirrors bin_folders) ─────────────────────────────
CREATE TABLE IF NOT EXISTS bay_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES bay_folders(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bay_folders_org ON bay_folders(org_id);
CREATE INDEX IF NOT EXISTS idx_bay_folders_parent ON bay_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_bay_folders_project ON bay_folders(project_id);

-- ── Bay: folder placement + tags on review assets ───────────────────────────
ALTER TABLE bay_assets ADD COLUMN IF NOT EXISTS folder_id UUID;
ALTER TABLE bay_assets ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  ALTER TABLE bay_assets
    ADD CONSTRAINT bay_assets_folder_fk
    FOREIGN KEY (folder_id) REFERENCES bay_folders(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bay_assets_folder ON bay_assets(folder_id);
CREATE INDEX IF NOT EXISTS idx_bay_assets_tags ON bay_assets USING GIN (tags);
