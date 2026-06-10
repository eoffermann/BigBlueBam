-- 0175_project_calling_settings.sql
--
-- Why: Bureau prerequisite P-4 from docs/plans/bureau-calling-audit.md.
-- Per-project calling overrides so a project owner can disable calling, or
-- forbid recording/transcription, on a sensitive project even when the org
-- has those features turned on. Read-time inheritance walks project -> org
-- (banter_settings) -> platform (system_settings). NULL on any column means
-- "inherit"; a non-NULL value is an explicit override.
--
-- Client impact: additive only. No existing rows or behavior change. The
-- table is opt-in per project — projects without a row inherit org/platform
-- defaults exactly as they do today.

CREATE TABLE IF NOT EXISTS project_calling_settings (
  project_id              uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL on any of these four = inherit from org; non-NULL = override.
  calling_enabled         boolean,
  allow_recording         boolean,
  allow_transcription     boolean,
  -- Reserved for Bureau (per-room default privacy). Free-form short label
  -- so we don't have to ship an enum migration when Bureau lands.
  default_office_privacy  varchar(16),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_calling_settings_org_id
  ON project_calling_settings(org_id);
