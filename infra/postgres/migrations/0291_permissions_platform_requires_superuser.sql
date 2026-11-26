-- 0291_permissions_platform_requires_superuser.sql
-- Why: The platform-admin permissions (promote a user to SuperUser, impersonate,
--   list/create/update/delete any org, platform settings, and the cross-org user
--   administration under /superuser/users) were catalogued with
--   requires_superuser = false. Under BBB_PERMISSIONS_ENFORCE=on the resolver's
--   requires_superuser step therefore never fired and the decision fell through to
--   group defaults, where an org Owner's builtin group grants every permission. The
--   requirePlatformSuperuser route guard already blocks these routes in every
--   posture; this makes the catalog say the same thing, so the resolver (and every
--   MCP tool that maps to these ids) refuses a non-SuperUser too. Mirrors the
--   REQUIRES_SUPERUSER_IDS list in scripts/generate-permission-manifest.mjs.
--   bam.platform_stop_impersonation.create is deliberately left false: it must stay
--   callable while impersonating, when the request user is the non-SuperUser target.
-- Client impact: none for legitimate users (these surfaces are SuperUser-only
--   already). Tightening only; idempotent (re-running updates zero rows).

UPDATE permissions
   SET requires_superuser = true
 WHERE id IN (
   'bam.audit_log.list',
   'bam.beta_signup.list',
   'bam.context_clear.create',
   'bam.organization.get',
   'bam.organization.list',
   'bam.overview.list',
   'bam.user.delete',
   'bam.user_active.update',
   'bam.user_email.update',
   'bam.user_login_history.get',
   'bam.user_membership.create',
   'bam.user_membership.delete',
   'bam.user_membership.update',
   'bam.user_project.get',
   'bam.user_session.delete',
   'bam.user_session.get',
   'bam.user_session_revoke_all.create',
   'bam.user_set_default_org.create',
   'bam.platform_audit_log.list',
   'bam.platform_impersonate.create',
   'bam.platform_impersonation_session.list',
   'bam.platform_org_member.get',
   'bam.platform_org.create',
   'bam.platform_org.delete',
   'bam.platform_org.get',
   'bam.platform_org.list',
   'bam.platform_org.update',
   'bam.platform_setting.list',
   'bam.platform_setting.update',
   'bam.platform_user_superuser.update'
 )
   AND requires_superuser IS DISTINCT FROM true;
