-- 0179_task_links.sql
--
-- Why: Phase 0 of the Bam CSV-import plan (docs/plans/bam-csv-import-plan.md
-- §4.1) adds a user-facing Links field on tasks: an ordered JSONB list of
-- URL objects ({ id, url, title, title_source, added_at, added_by }), each
-- optionally titled by the user or resolved from the target page. Stored
-- JSONB-on-task like custom_fields because links are display/navigation
-- data owned by one task, always loaded with it, never queried independently.
--
-- Client impact: additive only. Existing rows get '[]' via the column
-- default; no behavior changes until the API starts writing links.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
