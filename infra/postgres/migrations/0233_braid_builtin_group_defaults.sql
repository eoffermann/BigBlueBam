-- 0233_braid_builtin_group_defaults.sql
-- Why: The 9 braid.* catalog rows (migration 0232) were added AFTER migration
--   0156 authored the built-in role default matrix, so no built-in group grants
--   any braid.* permission. Under the per-action resolver every non-SuperUser
--   (including org Owners) hits implicit_deny on /braid routes, so the Braid SPA
--   403s for everyone. This backfills braid.* into the built-in group defaults
--   using the exact tiering rules from 0156 (owner/admin = full, member = full
--   minus admin-shaped/destructive-shared carve-outs [none apply to braid],
--   viewer = read-only, guest = none).
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates
--   an existing default row, and non-builtin (operator) groups are untouched.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT
    pg.id,
    p.id,
    CASE pg.legacy_role
        WHEN 'owner'  THEN (NOT p.requires_superuser)
        WHEN 'admin'  THEN (NOT p.requires_superuser)
        WHEN 'member' THEN (NOT p.requires_superuser)
        WHEN 'viewer' THEN (p.is_read AND NOT p.requires_superuser)
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app = 'braid'
ON CONFLICT (group_id, permission_id) DO NOTHING;
