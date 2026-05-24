-- 0169_banter_admin_import_group_defaults.sql
-- Why: Backfill built-in role defaults for the 3 banter.admin_import.*
--   permissions seeded in 0168. The 0156 CROSS JOIN was one-shot; perms
--   added later via delta migrations have no defaults rows and the
--   resolver evaluates them as "no rule". Per slack-import-design.md §6
--   the intended matrix is owner=3/3, admin=3/3, member/viewer/guest=0/3.
-- Client impact: tightens authorization for non-admin users on the Slack
--   import flow. No existing routes consume these permissions yet
--   (Agent B adds them next), so behavior change for deployed clients is
--   zero. Idempotent via ON CONFLICT.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pg.id, p.id,
       CASE pg.legacy_role
         WHEN 'owner'  THEN true
         WHEN 'admin'  THEN true
         WHEN 'member' THEN false
         WHEN 'viewer' THEN false
         WHEN 'guest'  THEN false
         ELSE false
       END
  FROM permission_groups pg
  CROSS JOIN permissions p
 WHERE pg.is_builtin
   AND pg.legacy_role IS NOT NULL
   AND p.id IN (
     'banter.admin_import.create',
     'banter.admin_import.status',
     'banter.admin_import.abort'
   )
ON CONFLICT (group_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted;
