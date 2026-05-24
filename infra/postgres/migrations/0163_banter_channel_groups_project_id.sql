-- 0163_banter_channel_groups_project_id.sql
-- Why: Slack import (docs/plans/slack-import-design.md §4a). Lets a Banter
--   channel group be tied to a BAM project so the import wizard can scope an
--   imported workspace's channels to a chosen project. ON DELETE SET NULL
--   preserves chat history when a project is deleted.
-- Client impact: additive. Existing groups stay NULL (un-linked); the new FK
--   is nullable and unconstrained for current writers. Re-running is safe via
--   ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE banter_channel_groups
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS banter_channel_groups_project_id_idx
  ON banter_channel_groups (project_id) WHERE project_id IS NOT NULL;
