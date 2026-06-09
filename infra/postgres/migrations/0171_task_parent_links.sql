-- 0171_task_parent_links.sql
-- Why: B3 Frndo Launch — subtasks were one-to-many (tasks.parent_task_id
--       self-FK), but the launch spec requires many-to-many: a single
--       subtask can be reused under multiple parents (each parent depends
--       on it). This join table is the new source of truth for the parent/
--       child relationship; tasks.parent_task_id stays put as the legacy
--       "primary parent" hint for the existing denormalized counters and
--       single-parent UI code paths.
-- Client impact: additive only. Existing tasks with parent_task_id IS NOT
--       NULL get one corresponding link row on backfill. No existing
--       column is touched.

CREATE TABLE IF NOT EXISTS task_parent_links (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (task_id, parent_task_id),
  -- A task cannot be its own parent. Cycles deeper than 1 are caught by
  -- the application layer (cycle detection is bounded DFS, depth ~16).
  CONSTRAINT task_parent_links_no_self_loop CHECK (task_id <> parent_task_id)
);

CREATE INDEX IF NOT EXISTS task_parent_links_parent_idx
  ON task_parent_links(parent_task_id);
CREATE INDEX IF NOT EXISTS task_parent_links_task_idx
  ON task_parent_links(task_id);

-- Backfill from the existing parent_task_id self-FK. ON CONFLICT DO NOTHING
-- in case this migration is re-run against a DB that's already partway.
INSERT INTO task_parent_links (task_id, parent_task_id)
SELECT id, parent_task_id
FROM tasks
WHERE parent_task_id IS NOT NULL
ON CONFLICT DO NOTHING;
