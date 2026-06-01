-- 0170_permissions_seed_actions_delta_007.sql
-- Why: Catalog delta. Adds bam.auth_service_account.rotate (the new
--   per-action gate for POST /auth/service-accounts/:id/rotate) and
--   grants it to the same default builtin groups as the analogous
--   svc-acct actions (owner=t, admin=t, member/viewer/guest=f).
--   Without the default-group grants, the route would deny every
--   caller in enforced mode regardless of role.
-- Client impact: additive (new catalog row + default grants).
--   Re-running is safe; both INSERT statements use ON CONFLICT DO UPDATE.

-- 1 new permission(s)
INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bam.auth_service_account.rotate', 'bam', 'auth_service_account', 'rotate', 'bam auth_service_account rotate', false, false, false, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pg.id,
       'bam.auth_service_account.rotate',
       (pg.legacy_role IN ('owner', 'admin'))
  FROM permission_groups pg
 WHERE pg.is_builtin
   AND pg.legacy_role IN ('owner', 'admin', 'member', 'viewer', 'guest')
   AND pg.deleted_at IS NULL
ON CONFLICT (group_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted;
