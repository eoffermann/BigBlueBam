-- 0164_banter_channels_project_id.sql
-- Why: Slack import (docs/plans/slack-import-design.md §4a). Mirror of 0163 on
--   banter_channels: each individual channel also carries the project FK so
--   "show all channels for project X" is a single-table scan (no group join)
--   and a channel survives being un-grouped without losing its project link.
--   ON DELETE SET NULL preserves chat history when a project is deleted.
-- Client impact: additive. Existing channels stay NULL (un-linked). The
--   partial composite index on (project_id, is_archived) WHERE project_id IS
--   NOT NULL accelerates the project-scoped channel browser without bloating
--   the index for non-project channels.

ALTER TABLE banter_channels
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS banter_channels_project_id_idx
  ON banter_channels (project_id, is_archived) WHERE project_id IS NOT NULL;
