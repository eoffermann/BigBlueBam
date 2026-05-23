-- 0156_permissions_remediate_builtin_defaults.sql
-- Why: Wave A migration 0146 authored built-in role defaults that were far too
--   permissive — member role had 1007/1019 (98.8%) permissions allowed, owner and
--   admin had 100%. With Wave D's per-action resolver canonical (mode=on), this
--   makes enforcement a no-op for non-SuperUser members on any route gated by
--   pure requireCan(...). See docs/wave-d-audit/SYNTHESIS_PROGRESS.md §4.6 for
--   the incident report.
--
--   This migration replaces all built-in group defaults with a deliberate matrix
--   derived from the role hierarchy:
--     guest  <  viewer  <  member  <  admin  <  owner  <  superuser
--
--   Product decisions (confirmed with operator):
--     - bam.system_setting.* is platform-level (deny for all non-SU)
--     - admins and owners can invite org members
--     - guests can post comments on entities they were invited to
--     - bill.invoice.finalize is admin-or-owner (not member)
--     - agent.self.heartbeat granted at role; users.kind='agent' enforced at handler
--
--   Detailed proposal: docs/wave-d-audit/builtin-role-defaults-proposal.md
-- Client impact: significant authorization tightening for non-SU users on routes
--   gated by pure requireCan(...). Routes still wrapped by dualReadGate retain
--   their legacy gate as defense-in-depth, so behavior change there is bounded.
--   Account-level overrides (account_permissions) and detached memberships
--   are untouched — only the live built-in group defaults change.

BEGIN;

-- ─── Snapshot pre-state for the audit RAISE at the bottom ───────────────
CREATE TEMP TABLE bbb_pre_remediation_totals AS
SELECT pg.legacy_role,
       COUNT(*) FILTER (WHERE pgd.granted) AS pre_granted,
       COUNT(*) AS pre_total
  FROM permission_group_defaults pgd
  JOIN permission_groups pg ON pg.id = pgd.group_id
 WHERE pg.is_builtin
 GROUP BY pg.legacy_role;

-- ─── Wipe and rebuild ────────────────────────────────────────────────────
-- Non-builtin (operator-defined) groups are unaffected. Account-level
-- overrides in account_permissions also unaffected; detached memberships
-- keep their snapshots.
DELETE FROM permission_group_defaults
 USING permission_groups pg
 WHERE pg.id = permission_group_defaults.group_id
   AND pg.is_builtin;

-- ─── Insert the new matrix ───────────────────────────────────────────────
-- Logic is expressed in terms of catalog flags (is_read, is_destructive,
-- requires_superuser) + explicit per-id / per-resource carve-outs. Anything
-- not explicitly classified falls through to the role's base rule.
--
-- Cross-cutting denies (applied at owner and below):
--   - requires_superuser = true
--   - bam.platform_* (impersonation tooling, platform_setting, etc.)
--   - bam.system_setting.* (platform-level per product decision)
--   - platform.system.{list_beta_signups,set_launchpad_defaults,
--                      set_public_signup_disabled,test_slack_webhook}

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT
    pg.id,
    p.id,
    CASE pg.legacy_role

        WHEN 'owner' THEN (
            NOT p.requires_superuser
            AND NOT (p.id LIKE 'bam.platform_%')
            AND NOT (p.id LIKE 'bam.system_setting.%')
            AND NOT (p.app = 'platform' AND p.resource = 'system' AND p.verb IN
                ('list_beta_signups', 'set_launchpad_defaults',
                 'set_public_signup_disabled', 'test_slack_webhook'))
        )

        WHEN 'admin' THEN (
            -- Admin gets owner's allow-set MINUS two explicit owner-only carve-outs.
            NOT p.requires_superuser
            AND NOT (p.id LIKE 'bam.platform_%')
            AND NOT (p.id LIKE 'bam.system_setting.%')
            AND NOT (p.app = 'platform' AND p.resource = 'system' AND p.verb IN
                ('list_beta_signups', 'set_launchpad_defaults',
                 'set_public_signup_disabled', 'test_slack_webhook'))
            AND p.id NOT IN (
                'bam.org.update',
                'bam.org_member_transfer_ownership.create'
            )
        )

        WHEN 'member' THEN (
            -- Member gets admin's allow-set MINUS admin-shaped resources,
            -- agent-platform writes, bill financial finality, and destructive
            -- writes on shared-org content.
            NOT p.requires_superuser
            AND NOT (p.id LIKE 'bam.platform_%')
            AND NOT (p.id LIKE 'bam.system_setting.%')
            AND NOT (p.app = 'platform' AND p.resource = 'system' AND p.verb IN
                ('list_beta_signups', 'set_launchpad_defaults',
                 'set_public_signup_disabled', 'test_slack_webhook'))
            AND p.id NOT IN (
                'bam.org.update',
                'bam.org_member_transfer_ownership.create'
            )
            -- Admin-shaped resources: org config, audit, integrations, member mgmt
            AND p.resource NOT IN (
                'audit_log',
                'auth_service_account',
                'guest_invitation', 'guest_invitation_resend', 'guest_scope',
                'import',
                'launchpad_app',
                'llm_provider', 'llm_provider_resolve', 'llm_provider_test',
                'org_launchpad_app',
                'org_member', 'org_member_active', 'org_member_activity',
                'org_member_api_key', 'org_member_force_password_change',
                'org_member_invite_bulk', 'org_member_profile',
                'org_member_project', 'org_member_reset_password',
                'org_member_sign_out_everywhere', 'org_member_transfer_ownership',
                'platform_setting',
                'project_github_integration', 'project_slack_integration',
                'webhook', 'agent_runner_webhook', 'agent_webhook_delivery'
            )
            -- agent.* admin surfaces (kill-switch, policies, webhooks).
            -- agent.self.* (heartbeat, report) is allowed; handler enforces
            -- users.kind='agent' so non-agent users effectively can't use it.
            AND NOT (p.app = 'agent' AND p.resource <> 'self')
            -- Platform org/proposal admin operations
            AND NOT (p.app = 'platform' AND p.resource = 'org' AND
                     p.verb IN ('set_launchpad_apps', 'list_members',
                                'update', 'create', 'delete'))
            AND NOT (p.app = 'platform' AND p.resource = 'proposal' AND p.verb = 'decide')
            -- Bill financial finality: members can draft, admin+ finalize
            AND p.id NOT IN (
                'bill.invoice.finalize', 'bill.invoice.send',
                'bill.expense.approve', 'bill.expense.reject'
            )
            -- Destructive writes on shared-org resources where ownership is
            -- collective. Per-content delete (task/comment/attachment/etc.) is
            -- still allowed; handler enforces ownership at request time.
            AND NOT (p.app = 'bam' AND p.is_destructive AND p.resource IN (
                'project', 'guest', 'epic', 'phase', 'label',
                'custom_field', 'template', 'view'
            ))
        )

        WHEN 'viewer' THEN (
            -- Viewer: member's allow-set ∩ is_read. Pure read-only.
            p.is_read
            AND NOT p.requires_superuser
            AND NOT (p.id LIKE 'bam.platform_%')
            AND NOT (p.id LIKE 'bam.system_setting.%')
            AND p.resource NOT IN (
                'audit_log',
                'auth_service_account',
                'guest_invitation', 'guest_invitation_resend', 'guest_scope',
                'launchpad_app',
                'llm_provider', 'llm_provider_resolve', 'llm_provider_test',
                'org_launchpad_app',
                'org_member_api_key', 'org_member_activity',
                'platform_setting',
                'webhook', 'agent_runner_webhook', 'agent_webhook_delivery'
            )
            AND NOT (p.app = 'agent' AND p.resource <> 'self')
            AND NOT (p.app = 'platform' AND p.resource = 'org' AND
                     p.verb IN ('set_launchpad_apps', 'list_members'))
        )

        WHEN 'guest' THEN (
            -- Guest: explicit short allow-list. Everything else deny.
            -- Visibility (per-entity access) is still enforced by the route
            -- handler — a granted permission only matters for entities the
            -- guest can actually see.
            p.id IN (
                -- Personal account / session
                'platform.user.get_profile',
                'platform.user.view',
                'platform.user.logout',
                'platform.user.change_password',
                'platform.user.list_notifications',
                'platform.user.mark_notification_read',
                'platform.user.mark_notifications_read',
                'platform.user.mark_all_notifications_read',
                'platform.user.switch_org',
                'platform.user.list_orgs',
                -- Public/system reads
                'platform.system.get_info',
                'platform.system.get_public_config',
                'platform.system.confirm_action',
                'platform.visibility.can_access',
                -- The invited entity and basic rendering context
                'bam.task.get',
                'bam.task.search',
                'bam.comment.list',
                'bam.comment.create',
                'bam.comment_reaction.create',
                'bam.comment_reaction.get',
                'bam.attachment.get',
                'bam.attachment.list',
                'bam.file.list',
                'bam.project.get',
                'bam.label.list',
                'bam.project_phase.get',
                'bam.project_epic.get',
                -- Cross-cutting utility reads
                'shared.attachment.get',
                'shared.attachment.list',
                'shared.system.resolve_references',
                'shared.system.search_global'
            )
        )

        ELSE false
    END AS granted

FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL;

-- ─── Post-migration audit ────────────────────────────────────────────────
DO $$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '─────────────────────────────────────────────────────';
    RAISE NOTICE 'Built-in role defaults: before vs. after';
    RAISE NOTICE '  role     |  pre_grant  |  post_grant  |  delta';
    RAISE NOTICE '─────────────────────────────────────────────────────';
    FOR r IN
        SELECT pre.legacy_role,
               pre.pre_granted,
               post.post_granted,
               (post.post_granted - pre.pre_granted) AS delta
          FROM bbb_pre_remediation_totals pre
          JOIN (
              SELECT pg.legacy_role,
                     COUNT(*) FILTER (WHERE pgd.granted) AS post_granted
                FROM permission_group_defaults pgd
                JOIN permission_groups pg ON pg.id = pgd.group_id
               WHERE pg.is_builtin
               GROUP BY pg.legacy_role
          ) post ON post.legacy_role = pre.legacy_role
         ORDER BY pre.legacy_role
    LOOP
        RAISE NOTICE '  % | %       | %        | %',
            RPAD(r.legacy_role::text, 7),
            LPAD(r.pre_granted::text, 5),
            LPAD(r.post_granted::text, 5),
            LPAD(r.delta::text, 6);
    END LOOP;
    RAISE NOTICE '─────────────────────────────────────────────────────';
END $$;

COMMIT;
