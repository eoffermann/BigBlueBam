-- 0268_blueprint_bureau_builtin_group_defaults.sql
-- Why: Issue #153. The 29 blueprint.* / bureau.* catalog rows (migration 0267) were added
--   after migration 0156 authored the built-in role default matrix, so no built-in group grants
--   any of them. Every Blueprint and Bureau route now calls requireCan() with one of these ids;
--   in BBB_PERMISSIONS_ENFORCE=on every non-SuperUser (org Owners included) would hit
--   implicit_deny on every /blueprint and /bureau route. This backfills them into the built-in
--   group defaults, following the bursar (0259) and burn (0243) precedent.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates an existing
--   default row, and non-builtin (operator) groups are untouched.
--
--   ORDERING: numbered after the catalog delta (0267), which build-permission-delta.mjs was
--   observed to assign, so the CROSS JOIN below matches the new rows. If it ran first it would
--   match zero rows and be checksummed as applied with nothing granted.
--
--   Tiering. The routes keep their in-route checks (admin/owner-only floors, settings, office
--   assignment and chat retention; room ACL roles; diagram ownership), so these grants never
--   widen what a role can do today; they only stop the new gate from denying it:
--     owner + admin = all 29 rows (none require_superuser);
--     member = all except the four admin-only bureau actions (25 rows): bureau.floor.write,
--       bureau.settings.write, bureau.office.assign, bureau.chat.configure;
--     viewer = the is_read rows (10) plus three self-service actions a read-only member
--       already performs today: blueprint.diagram.star (personal favorite),
--       bureau.status.update (own status) and bureau.call.join (join a room call) = 13 rows;
--     guest = none.
--
--   Verification probe (expected: owner 29, admin 29, member 25, viewer 13, guest 0):
--     SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
--     FROM permission_group_defaults d
--     JOIN permissions p ON p.id = d.permission_id
--     JOIN permission_groups pg ON pg.id = d.group_id
--     WHERE p.app IN ('blueprint', 'bureau') GROUP BY 1;

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
                'bureau.floor.write',
                'bureau.settings.write',
                'bureau.office.assign',
                'bureau.chat.configure'
            )
        )
        WHEN 'viewer' THEN (
            NOT p.requires_superuser
            AND (
                p.is_read
                OR p.id IN (
                    'blueprint.diagram.star',
                    'bureau.status.update',
                    'bureau.call.join'
                )
            )
        )
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app IN ('blueprint', 'bureau')
ON CONFLICT (group_id, permission_id) DO NOTHING;
