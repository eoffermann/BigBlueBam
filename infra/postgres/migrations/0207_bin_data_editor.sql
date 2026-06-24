-- 0207_bin_data_editor.sql
-- Why: Bin structured-data editor (Bin master §10/§11). Adds the three tables
--      backing the grid/tree editor: live CRDT editing sessions over an asset
--      (a buffer between immutable versions, D-3), confirmed/pinned schemas, and
--      anchored review comments. The session holds the Yjs binary so a session
--      survives reconnects without minting a version per keystroke.
-- Client impact: additive only. Three new tables + indexes + FKs. No data
--      migration. Re-running is safe (IF NOT EXISTS + guarded constraints).

-- ── Editing sessions (live CRDT buffer over an asset) ───────────────────────
CREATE TABLE IF NOT EXISTS bin_data_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID NOT NULL REFERENCES bin_assets(id) ON DELETE CASCADE,
  base_version_id  UUID NOT NULL,
  branch           TEXT NOT NULL DEFAULT 'main',
  shape            TEXT NOT NULL CHECK (shape IN ('record', 'tree')),
  yjs_state        BYTEA,
  dialect          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_source    TEXT NOT NULL CHECK (schema_source IN ('sidecar', 'pinned', 'inferred')),
  schema_json      JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flushed_at  TIMESTAMPTZ
);

-- One active session per (asset, branch) — the editor resumes rather than forks.
CREATE UNIQUE INDEX IF NOT EXISTS bin_data_sessions_one_active
  ON bin_data_sessions(asset_id, branch);

-- ── Schemas (confirmed/pinned or sidecar-linked) ────────────────────────────
CREATE TABLE IF NOT EXISTS bin_data_schemas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID NOT NULL REFERENCES bin_assets(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('pinned', 'sidecar')),
  schema_json      JSONB NOT NULL,
  sidecar_asset_id UUID,
  pinned_by        UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bin_data_schemas_asset ON bin_data_schemas(asset_id);
-- At most one pinned schema per asset (sidecars may be many).
CREATE UNIQUE INDEX IF NOT EXISTS bin_data_schemas_one_pinned
  ON bin_data_schemas(asset_id) WHERE source = 'pinned';

-- ── Anchored review comments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bin_data_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id          UUID NOT NULL REFERENCES bin_assets(id) ON DELETE CASCADE,
  version_id        UUID NOT NULL,
  shape             TEXT NOT NULL CHECK (shape IN ('record', 'tree')),
  anchor            JSONB NOT NULL,
  body              TEXT NOT NULL,
  author_id         UUID REFERENCES users(id),
  thread_parent_id  UUID,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bin_data_comments_asset ON bin_data_comments(asset_id);
CREATE INDEX IF NOT EXISTS idx_bin_data_comments_thread ON bin_data_comments(thread_parent_id);
