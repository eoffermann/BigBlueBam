-- 0191_org_soft_delete.sql
-- Why: platform_delete_org did a hard DELETE relying on ON DELETE CASCADE, but
--   ~77 FKs into users.id (and several org-scoped tables) are NO ACTION/RESTRICT,
--   so deleting any non-trivial org raised Postgres 23503 and was masked as a
--   generic INTERNAL_ERROR — no org with real data could be deleted. Switch to a
--   soft-delete (matches how the codebase already soft-deletes users) via a
--   nullable deleted_at marker; reads filter it out, the org row + authored
--   content survive for audit.
-- Client impact: additive only (nullable columns + partial index). Existing rows
--   get deleted_at = NULL (active).

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_by uuid;

-- Partial index over active orgs — every hot read filters `deleted_at IS NULL`.
CREATE INDEX IF NOT EXISTS organizations_active_idx
  ON organizations (id) WHERE deleted_at IS NULL;
