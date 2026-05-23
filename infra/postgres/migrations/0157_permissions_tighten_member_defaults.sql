-- 0157_permissions_tighten_member_defaults.sql
-- Why: 0156 reduced member's allow set from 1007 → 945 (out of 1047), but the
--   audit found 25 more admin-shaped resources slipping through because they
--   didn't match the literal resource-name deny list. This migration tightens
--   the member rule using LIKE patterns to catch the structural admin/config
--   shapes the catalog generator produced:
--     - *audit*       (agent_audit, audit_log, platform_audit_log)
--     - *integration* (integration, project_github_integration,
--                      project_slack_integration, project_slack_integration_test)
--     - *webhook*     (webhook, project_webhook, agent_runner_webhook,
--                      agent_webhook_delivery, webhook_bounce, webhook_complaint,
--                      webhook_livekit)
--     - *setting*     (every *_setting* / settings / public_settings resource)
--     - project_import_* + bare 'import'
--     - 'approval', 'proposal_decide', 'agent_policy', 'agent_policy_check'
--   These are all org-config / admin-moderation / agent-platform surfaces that
--   should be admin/owner only. The `proposal` resource itself (without
--   _decide) stays member-allowed so members can create/list their own proposals.
-- Client impact: tighter member defaults. Owner/admin/viewer/guest unchanged.
--   Expected member grant count drops from 945 → ~870 (delete the relevant
--   admin-shaped rows that 0156 left allow=true).

BEGIN;

-- Snapshot pre-state for the audit RAISE.
CREATE TEMP TABLE bbb_pre_tighten_member AS
SELECT COUNT(*) FILTER (WHERE pgd.granted) AS pre_granted,
       COUNT(*) AS pre_total
  FROM permission_group_defaults pgd
  JOIN permission_groups pg ON pg.id = pgd.group_id
 WHERE pg.is_builtin AND pg.legacy_role = 'member';

-- Flip the granted flag to false for any member row whose permission_id
-- matches an admin-shape we missed in 0156. UPDATE rather than DELETE so
-- the audit can compare row counts; rows still present, just denied.
UPDATE permission_group_defaults pgd
   SET granted = false
  FROM permission_groups pg, permissions p
 WHERE pgd.group_id = pg.id
   AND pgd.permission_id = p.id
   AND pg.is_builtin
   AND pg.legacy_role = 'member'
   AND pgd.granted = true
   AND (
       -- Admin/audit/integration/webhook/setting structural patterns
       p.resource LIKE '%audit%'
    OR p.resource LIKE '%integration%'
    OR p.resource LIKE '%webhook%'
    OR p.resource LIKE '%setting%'
       -- Imports (bulk admin operations)
    OR p.resource = 'import'
    OR p.resource LIKE 'project_import_%'
       -- Approval / decision surfaces (admin moderation)
    OR p.resource IN ('approval', 'proposal_decide')
       -- Agent-platform admin (not agent.self.*)
    OR p.resource IN ('agent_policy', 'agent_policy_check')
   );

-- Also tighten viewer with the same patterns — viewer should not see audit
-- logs or admin settings either.
UPDATE permission_group_defaults pgd
   SET granted = false
  FROM permission_groups pg, permissions p
 WHERE pgd.group_id = pg.id
   AND pgd.permission_id = p.id
   AND pg.is_builtin
   AND pg.legacy_role = 'viewer'
   AND pgd.granted = true
   AND (
       p.resource LIKE '%audit%'
    OR p.resource LIKE '%integration%'
    OR p.resource LIKE '%webhook%'
    OR p.resource LIKE '%setting%'
    OR p.resource = 'import'
    OR p.resource LIKE 'project_import_%'
    OR p.resource IN ('approval', 'proposal_decide', 'agent_policy', 'agent_policy_check')
   );

-- Audit RAISE
DO $$
DECLARE
    r RECORD;
    pre_m INT;
BEGIN
    SELECT pre_granted INTO pre_m FROM bbb_pre_tighten_member;
    RAISE NOTICE '─── Member/viewer tightening (post-0156) ───';
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
    RAISE NOTICE 'Member delta from 0156: % → ?', pre_m;
END $$;

COMMIT;
