-- 0186_comment_revisions.sql
-- Why: Task comments are now editable in the UI; every edit must preserve
--   the superseded text so a comment's history stays auditable ("edited"
--   badge + viewable prior versions in the task drawer).
-- Client impact: additive only — new table, no changes to existing rows.

CREATE TABLE IF NOT EXISTS comment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  -- The body text this revision row preserves (the version REPLACED by an
  -- edit). The current text always lives on comments.body; rows here are
  -- strictly historical, newest-first by revised_at.
  body text NOT NULL,
  revised_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revised_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comment_revisions_comment_idx
  ON comment_revisions (comment_id, revised_at DESC);
