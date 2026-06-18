-- 0195_backfill_tasks_org_id.sql
-- Why: tasks.org_id was added by migration 0078 ahead of the Wave 1 RLS
--   rollout but never backfilled, and no insert path set it — so every task
--   row carries org_id IS NULL. That makes Bench analytics fan-out over Bam
--   tasks (which joins/filters on tasks.org_id) return nothing, and would
--   mis-gate the future RLS org-scoping policy. This migration backfills
--   org_id from the owning project (the authoritative org), the companion
--   to the 0078 "Wave 1 follow-up" note. The insert paths in apps/api +
--   apps/worker are fixed in the same change so new rows are never NULL.
-- Client impact: additive only. Populates an existing nullable column for
--   historical rows; no schema change, no reads/inserts altered here.

-- Idempotent: the org_id IS NULL guard means a re-run is a no-op once rows
-- are populated, and rows whose project has somehow vanished (none today,
-- given the ON DELETE CASCADE FK) are simply left NULL.
UPDATE tasks
SET org_id = projects.org_id
FROM projects
WHERE tasks.project_id = projects.id
  AND tasks.org_id IS NULL;

-- The org_id column, its FK to organizations(id) ON DELETE CASCADE, and the
-- tasks_org_id_idx index were all created by migration 0078 — declared here
-- only as IF-NOT-EXISTS belt-and-suspenders so this file is also correct if
-- applied against a DB where 0078 was skipped.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tasks_org_id_idx ON tasks(org_id);
