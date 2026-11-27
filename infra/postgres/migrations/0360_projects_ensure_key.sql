-- 0360_projects_ensure_key.sql
-- Why: POST /internal/projects/ensure was idempotent on (org_id, slug), so a Slack import that
--   asked for a new project whose derived slug an unrelated project already held (a user's
--   project, an archived one, another import's) was handed that project and imported into it
--   (#373). ensure now keys on the caller's own operation id, stored here, and gives a new project
--   a free suffixed slug instead of answering a foreign one.
-- Client impact: additive only. New nullable column and a partial unique index; existing rows
--   keep ensure_key NULL.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS ensure_key VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS projects_org_ensure_key_idx
  ON projects (org_id, ensure_key)
  WHERE ensure_key IS NOT NULL;
