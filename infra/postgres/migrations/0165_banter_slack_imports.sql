-- 0165_banter_slack_imports.sql
-- Why: Slack import (docs/plans/slack-import-design.md §4b). The
--   banter_slack_imports table is the durable per-upload audit + status row
--   used by the upload endpoint, the worker, the polling status endpoint, and
--   the abort/cleanup flow. One row per upload; aborted imports retain their
--   row, re-runs create a fresh row.
-- Client impact: additive only. No existing readers/writers.

CREATE TABLE IF NOT EXISTS banter_slack_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  channel_group_id    uuid REFERENCES banter_channel_groups(id) ON DELETE SET NULL,
  initiated_by        uuid NOT NULL REFERENCES users(id),
  workspace_name      text NOT NULL,
  workspace_url       text,
  source_filename     text NOT NULL,
  source_size_bytes   bigint NOT NULL,
  source_minio_key    text NOT NULL,
  mapping             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  phase               text,
  progress_total      integer NOT NULL DEFAULT 0,
  progress_done       integer NOT NULL DEFAULT 0,
  totals_imported     jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals_skipped      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message       text,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS banter_slack_imports_org_id_idx
  ON banter_slack_imports (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS banter_slack_imports_status_idx
  ON banter_slack_imports (status)
  WHERE status NOT IN ('done', 'failed', 'aborted');
