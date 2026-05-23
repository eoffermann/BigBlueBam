-- 0159_permissions_drop_legacy_role_columns.sql
-- Why: Wave E final step. With per-action permissions canonical and all
--   code consumers migrated to either fastify.requireCan(...) or
--   account_group_memberships -> permission_groups.legacy_role lookups,
--   the legacy users.role and organization_memberships.role columns are
--   dead storage. Dropping them prevents drift and locks in the new model.
-- Client impact: destructive but isolated. The frontend reads
--   user.role / org_memberships[*].role from /auth/me; the auth hook and
--   /auth/me now synthesize those fields from account_group_memberships ->
--   permission_groups, so the API response shape is unchanged. No SPA
--   changes required.

BEGIN;

-- The check constraints reference the role column directly, so they must
-- go first. IF EXISTS guards keep the migration idempotent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;

ALTER TABLE users DROP COLUMN IF EXISTS role;
ALTER TABLE organization_memberships DROP COLUMN IF EXISTS role;

COMMIT;
