-- 0210_bay_core.sql
-- Why: Bay media review & approval core (Bay master). Creates the review
--      substrate — assets, immutable per-asset versions, anchored annotations,
--      and per-reviewer decisions. Bay federates on top of Bin for canonical
--      bytes: a Bay version references a Bin asset/version (bin_asset_id /
--      bin_version_id) rather than storing bytes. Versions are immutable and
--      monotonic per asset; a denormalized current_version_id points at the
--      active version. Review decisions are one-per-reviewer-per-version (upsert).
-- Client impact: additive only. Four new tables + indexes + FKs. No data
--      migration. Re-running is safe (IF NOT EXISTS + guarded constraint adds).

-- ── Assets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bay_assets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
  name                VARCHAR(512) NOT NULL,
  media_kind          TEXT NOT NULL
                        CHECK (media_kind IN ('image', 'video', 'audio', 'model')),
  current_version_id  UUID,
  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bay_assets_org ON bay_assets(org_id);
CREATE INDEX IF NOT EXISTS idx_bay_assets_project ON bay_assets(project_id);

-- ── Asset versions (immutable, monotonic per asset) ─────────────────────────
CREATE TABLE IF NOT EXISTS bay_asset_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID NOT NULL REFERENCES bay_assets(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  bin_asset_id    UUID,
  bin_version_id  UUID,
  media_meta      JSONB NOT NULL DEFAULT '{}',
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bay_asset_versions_asset_number
  ON bay_asset_versions(asset_id, version_number);
CREATE INDEX IF NOT EXISTS idx_bay_asset_versions_asset
  ON bay_asset_versions(asset_id);

-- ── Annotations (time/frame/region/viewpoint-anchored comments) ─────────────
CREATE TABLE IF NOT EXISTS bay_annotations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id        UUID NOT NULL REFERENCES bay_asset_versions(id) ON DELETE CASCADE,
  author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  anchor            JSONB NOT NULL DEFAULT '{}',
  body              TEXT NOT NULL,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  thread_parent_id  UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bay_annotations_version ON bay_annotations(version_id);

-- ── Review decisions (one per reviewer per version) ─────────────────────────
CREATE TABLE IF NOT EXISTS bay_review_decisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id   UUID NOT NULL REFERENCES bay_asset_versions(id) ON DELETE CASCADE,
  reviewer_id  UUID NOT NULL REFERENCES users(id),
  decision     TEXT NOT NULL
                 CHECK (decision IN ('approved', 'rejected', 'changes_requested', 'pending')),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bay_review_decisions_version_reviewer
  ON bay_review_decisions(version_id, reviewer_id);
CREATE INDEX IF NOT EXISTS idx_bay_review_decisions_version
  ON bay_review_decisions(version_id);

-- ── Denormalized current_version_id FK ──────────────────────────────────────
-- Added after both tables exist (chicken-and-egg: the version references the
-- asset, the asset points back at its active version). Guarded so re-runs are
-- a no-op. ON DELETE SET NULL keeps the asset row when a version is purged.
DO $$
BEGIN
  ALTER TABLE bay_assets
    ADD CONSTRAINT bay_assets_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES bay_asset_versions(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
