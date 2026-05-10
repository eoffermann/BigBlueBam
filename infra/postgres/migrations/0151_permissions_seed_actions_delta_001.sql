-- 0151_permissions_seed_actions_delta_001.sql
-- Why: Wave B follow-up catalog delta. The seed migration 0145 is now
--   frozen post-deploy per CLAUDE.md's immutability rule; new permissions
--   discovered after Wave A land in delta migrations like this one.
--
--   This delta:
--     1. Adds bam.superuser_permission_divergence_summary.list (the new
--        SuperUser dashboard endpoint introduced in Wave B).
--     2. Removes bam.version.list and bam.version_check.create (the
--        /version probe is now correctly excluded from the catalog by
--        the manifest generator since it's a public-health route, not
--        a permission-gated action).
-- Client impact: additive + minor cleanup. The 5 builtin groups already
--   re-evaluate from permissions on read, so no existing account loses
--   or gains anything operationally; the deletions just remove rows
--   that nobody had ever explicitly granted/denied. Re-running this
--   migration is safe.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read) VALUES
    ('bam.superuser_permission_divergence_summary.list', 'bam', 'superuser_permission_divergence_summary', 'list', 'bam superuser_permission_divergence_summary list', false, false, true)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read;

-- Cleanup: /version was never user-permission-gated. The CASCADE on
-- permission_group_defaults + account_permissions handles any builtin-
-- group rows that were auto-seeded for these now-removed permissions.
DELETE FROM permissions WHERE id IN ('bam.version.list', 'bam.version_check.create');
