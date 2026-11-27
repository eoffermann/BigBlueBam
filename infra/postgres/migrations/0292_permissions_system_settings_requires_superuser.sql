-- 0292_permissions_system_settings_requires_superuser.sql
-- Why: The platform-settings routes in system-settings.routes.ts (list, write,
--   SMTP test, password-policy preview) were documented SuperUser-only but checked
--   only an advisory requireCan, so any authenticated user could PUT smtp_host /
--   smtp_pass and capture every user's password-reset mail. The routes now carry
--   requirePlatformSuperuser; this flips the catalog flags so the resolver (and any
--   MCP tool mapped to these ids) refuses a non-SuperUser under
--   BBB_PERMISSIONS_ENFORCE=on too, instead of falling through to an org Owner's
--   group defaults. bam.system_setting.get stays false: it is the authenticated
--   single-key read ordinary app code depends on, and it masks secret values.
--   Mirrors REQUIRES_SUPERUSER_IDS in scripts/generate-permission-manifest.mjs.
-- Client impact: none for legitimate users (the UI for these is SuperUser-only).
--   Tightening only; idempotent (re-running updates zero rows).

UPDATE permissions
   SET requires_superuser = true
 WHERE id IN (
   'bam.system_setting.list',
   'bam.system_setting.update'
 )
   AND requires_superuser IS DISTINCT FROM true;
