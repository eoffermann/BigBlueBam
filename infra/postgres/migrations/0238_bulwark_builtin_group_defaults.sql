-- 0238_bulwark_builtin_group_defaults.sql
-- Why: The 12 bulwark.* catalog rows (migration 0237) were added AFTER migration
--   0156 authored the built-in role default matrix, so no built-in group grants
--   any bulwark.* permission. Under the per-action resolver every non-SuperUser
--   (including org Owners) hits implicit_deny on /bulwark routes, so the Bulwark SPA
--   403s for everyone. This backfills bulwark.* into the built-in group defaults
--   using the custom tiering from spec Section 10 line 382 / THEME A / SH2:
--     owner + admin = all 12 (none require_superuser);
--     member = all 12 EXCEPT the 6 owner/admin-floored rows
--       (contract.read, obligation.read, notice.draft, compliance.chase,
--        contract.delete, settings.write), so member gets contract.write,
--        obligation.write, deadline.read, deadline.write, compliance.read,
--        settings.read;
--     viewer = the (is_read AND NOT requires_superuser) set EXCEPT contract.read
--       and obligation.read, so viewer gets deadline.read, compliance.read,
--       settings.read (3 rows);
--     guest = none.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates
--   an existing default row, and non-builtin (operator) groups are untouched.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT
    pg.id,
    p.id,
    CASE pg.legacy_role
        WHEN 'owner'  THEN (NOT p.requires_superuser)
        WHEN 'admin'  THEN (NOT p.requires_superuser)
        WHEN 'member' THEN (
            NOT p.requires_superuser
            AND p.id NOT IN (
                'bulwark.contract.read',
                'bulwark.obligation.read',
                'bulwark.notice.draft',
                'bulwark.compliance.chase',
                'bulwark.contract.delete',
                'bulwark.settings.write'
            )
        )
        WHEN 'viewer' THEN (
            p.is_read
            AND NOT p.requires_superuser
            AND p.id NOT IN (
                'bulwark.contract.read',
                'bulwark.obligation.read'
            )
        )
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app = 'bulwark'
ON CONFLICT (group_id, permission_id) DO NOTHING;
