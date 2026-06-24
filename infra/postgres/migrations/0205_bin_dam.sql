-- 0205_bin_dam.sql
-- Why: Bin DAM core (Bin master §5/§9). Creates the asset library substrate —
--      folders, assets, and immutable asset versions — backing the universal
--      media interface for the suite. Assets store the active-version reference
--      shape (binding_id, object_key, size, integrity, content_type) and a
--      denormalized current_version_id; versions are immutable and monotonic
--      per asset. scan_status gates serving (pending until the AV scan, a later
--      slice, marks an object clean).
-- Client impact: additive only. Three new tables + indexes + FKs. No data
--      migration. Re-running is safe (IF NOT EXISTS + guarded constraint adds).

-- ── Folders ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bin_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES bin_folders(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bin_folders_org ON bin_folders(org_id);
CREATE INDEX IF NOT EXISTS idx_bin_folders_parent ON bin_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_bin_folders_project ON bin_folders(project_id);

-- ── Assets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bin_assets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,
  folder_id           UUID REFERENCES bin_folders(id) ON DELETE SET NULL,
  name                VARCHAR(512) NOT NULL,
  content_type        VARCHAR(255) NOT NULL,
  current_version_id  UUID,
  binding_id          UUID,
  object_key          VARCHAR(1024) NOT NULL,
  size                BIGINT NOT NULL DEFAULT 0,
  integrity           VARCHAR(255),
  scan_status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (scan_status IN ('pending', 'clean', 'infected', 'error', 'skipped')),
  visibility          VARCHAR(20) NOT NULL DEFAULT 'organization',
  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bin_assets_org ON bin_assets(org_id);
CREATE INDEX IF NOT EXISTS idx_bin_assets_folder ON bin_assets(folder_id);
CREATE INDEX IF NOT EXISTS idx_bin_assets_project ON bin_assets(project_id);

-- ── Asset versions (immutable, monotonic per asset) ─────────────────────────
CREATE TABLE IF NOT EXISTS bin_asset_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID NOT NULL REFERENCES bin_assets(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  binding_id      UUID,
  object_key      VARCHAR(1024) NOT NULL,
  size            BIGINT NOT NULL DEFAULT 0,
  integrity       VARCHAR(255),
  content_type    VARCHAR(255) NOT NULL,
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bin_asset_versions_asset_number
  ON bin_asset_versions(asset_id, version_number);
CREATE INDEX IF NOT EXISTS idx_bin_asset_versions_asset
  ON bin_asset_versions(asset_id);

-- ── Denormalized current_version_id FK ──────────────────────────────────────
-- Added after both tables exist (chicken-and-egg: the version references the
-- asset, the asset points back at its active version). Guarded so re-runs are
-- a no-op. ON DELETE SET NULL keeps the asset row when a version is purged.
DO $$
BEGIN
  ALTER TABLE bin_assets
    ADD CONSTRAINT bin_assets_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES bin_asset_versions(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
