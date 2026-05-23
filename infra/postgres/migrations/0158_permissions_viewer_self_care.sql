-- 0158_permissions_viewer_self_care.sql
-- Client impact: viewer role gains ~12 additional permissions for personal
--   self-care and universal utility actions. Member also re-grants any that
--   were caught by the same misclassification. Owner/admin/guest unchanged.
-- Why: End-to-end testing of the viewer role after 0156/0157 surfaced that
--   the catalog generator's is_read inference is too narrow — it only flags
--   verbs that match bare patterns (list, get, search, view, find, count,
--   query, browse). Compound and semantically-read verbs like
--   list_notifications, change_password, switch_org, mark_*_read, logout,
--   get_my_tasks, search_global, resolve_references etc. are classified as
--   non-read, so the viewer rule (is_read AND ...) denied them.
--
--   This affects:
--     - platform.user.* personal self-care actions (change password, manage
--       own notifications, switch org, view own profile/tasks, logout)
--     - platform.user.find_by_email / .find_by_name (user lookup for ticket
--       assignment / @-mention rendering — viewer should be able to do this)
--     - platform.system.confirm_action / .get_info / .get_*  reads
--     - platform.visibility.can_access (universal preflight)
--     - shared.system.search_global / .resolve_references (utility reads)
--     - shared.activity.by_actor (activity feed scoped to one actor)
--     - shared.expertise.for_topic (expertise lookup, read-shaped)
--
--   This migration grants those for viewer (and also confirms they're granted
--   for member, who should never have been denied them). It does NOT change
--   the catalog flags themselves — that would require a manifest regenerate
--   and a separate catalog migration. The narrow fix is to grant the specific
--   permissions to viewer directly in permission_group_defaults.

BEGIN;

-- Snapshot pre-state.
CREATE TEMP TABLE bbb_pre_viewer_self_care AS
SELECT pg.legacy_role,
       COUNT(*) FILTER (WHERE pgd.granted) AS pre_granted
  FROM permission_group_defaults pgd
  JOIN permission_groups pg ON pg.id = pgd.group_id
 WHERE pg.is_builtin AND pg.legacy_role IN ('viewer', 'member')
 GROUP BY pg.legacy_role;

-- The targeted allow-list. Each id was confirmed against the catalog before
-- writing this migration; misses will silently no-op via the WHERE join.
WITH viewer_self_care(permission_id) AS (
    VALUES
        -- Personal account / self-care
        ('platform.user.change_password'),
        ('platform.user.list_notifications'),
        ('platform.user.mark_notification_read'),
        ('platform.user.mark_notifications_read'),
        ('platform.user.mark_all_notifications_read'),
        ('platform.user.switch_org'),
        ('platform.user.list_orgs'),
        ('platform.user.logout'),
        ('platform.user.update_profile'),
        ('platform.user.get_my_tasks'),
        ('platform.user.get_overdue_tasks'),
        -- User lookup (for @-mention rendering, assignment displays, etc.)
        ('platform.user.find_by_email'),
        ('platform.user.find_by_name'),
        -- Universal utility reads
        ('platform.visibility.can_access'),
        ('platform.system.confirm_action'),
        ('platform.system.get_info'),
        ('platform.system.get_launchpad_apps'),
        ('platform.system.get_public_config'),
        ('platform.system.get_platform_settings'),
        ('shared.system.search_global'),
        ('shared.system.resolve_references'),
        ('shared.activity.by_actor'),
        ('shared.expertise.for_topic')
)
UPDATE permission_group_defaults pgd
   SET granted = true
  FROM permission_groups pg, viewer_self_care v
 WHERE pgd.group_id = pg.id
   AND pgd.permission_id = v.permission_id
   AND pg.is_builtin
   AND pg.legacy_role IN ('viewer', 'member');

-- Audit RAISE
DO $$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '─── Viewer/member self-care fix (post-0157) ───';
    FOR r IN
        SELECT pg.legacy_role,
               COUNT(*) FILTER (WHERE pgd.granted) AS post_granted,
               COUNT(*) FILTER (WHERE NOT pgd.granted) AS post_denied
          FROM permission_group_defaults pgd
          JOIN permission_groups pg ON pg.id = pgd.group_id
         WHERE pg.is_builtin
         GROUP BY pg.legacy_role
         ORDER BY pg.legacy_role
    LOOP
        RAISE NOTICE '  % | granted=% | denied=%',
            RPAD(r.legacy_role::text, 7),
            LPAD(r.post_granted::text, 5),
            LPAD(r.post_denied::text, 5);
    END LOOP;
END $$;

COMMIT;
