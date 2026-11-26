-- 0271_bureau_chat_write_builtin_group_defaults.sql
-- Why: Issue #166. bureau.chat.write (catalog row added by 0270) gates the Bureau
--   WebSocket chat_send frame. Without a built-in default every non-SuperUser would hit
--   implicit_deny on room chat under BBB_PERMISSIONS_ENFORCE=on. Follows the 0268 tiering.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates an existing
--   default row, and non-builtin (operator) groups are untouched.
--
--   ORDERING: must run after 0270 (it cross-joins the new row). If it ran first it would
--   match zero rows and be checksummed as applied with nothing granted.
--
--   Tiering: owner, admin and member are granted. viewer is granted too: chat in a room the
--   viewer has joined is the text twin of bureau.call.join (talking in that room's call),
--   which 0268 already grants viewers, and viewers could send chat before #166. guest is not.
--
--   Verification probe (expected: owner, admin, member, viewer true; guest false):
--     SELECT pg.legacy_role, d.granted
--     FROM permission_group_defaults d
--     JOIN permission_groups pg ON pg.id = d.group_id
--     WHERE d.permission_id = 'bureau.chat.write' AND pg.is_builtin;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT
    pg.id,
    p.id,
    CASE pg.legacy_role
        WHEN 'owner'  THEN true
        WHEN 'admin'  THEN true
        WHEN 'member' THEN true
        WHEN 'viewer' THEN true
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.id = 'bureau.chat.write'
ON CONFLICT (group_id, permission_id) DO NOTHING;
