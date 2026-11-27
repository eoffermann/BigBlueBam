-- 0293_permissions_seed_actions_delta_032.sql
-- Why: Catalog delta. Adds the permission for the SuperUser deployment-health
--   route (GET /superuser/config-health), seeded already flagged
--   requires_superuser like every other bam.superuser_* row.
-- Client impact: additive (new row). Re-running is safe; INSERT...ON CONFLICT
--   is idempotent.

-- 1 new permission(s)
INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bam.superuser_config_health.list', 'bam', 'superuser_config_health', 'list', 'bam superuser_config_health list', false, false, true, true)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
