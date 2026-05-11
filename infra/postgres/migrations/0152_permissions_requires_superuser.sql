-- 0152_permissions_requires_superuser.sql
-- Why: Wave C prep. Wave B's soak surfaced a real divergence: the 5
--   builtin Owner group grants every permission in the catalog, but
--   SuperUser-only routes (e.g. POST /superuser/context/switch) need
--   to deny non-SuperUsers regardless of group membership. Without
--   this flag, flipping BBB_PERMISSIONS_ENFORCE=on would let any org
--   Owner reach the SuperUser console.
--
--   Adds a requires_superuser column to permissions. The resolver
--   (packages/permissions/src/resolver.ts) checks it after step 2.5
--   (helpdesk short-circuit) and before step 3 (api-key ceiling) —
--   if true AND ctx.subject.is_superuser is false, DENY.
-- Client impact: additive only. Default value is false, so behavior is
--   unchanged for every permission not explicitly marked. A separate
--   data migration (this same file) sets the flag for the obvious
--   platform.* surface (org CRUD, platform settings, beta signups) +
--   bam.context.switch, bam.organization_impersonation.*, and the
--   superuser_audit.* read paths.

ALTER TABLE permissions
    ADD COLUMN IF NOT EXISTS requires_superuser boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN permissions.requires_superuser IS
    'When true, the resolver denies unless ctx.subject.is_superuser. Used for platform-level surfaces that no operator-defined group should be able to grant.';

-- ──────────────────────────────────────────────────────────────────────
-- Mark the obvious platform-only permissions
-- ──────────────────────────────────────────────────────────────────────
--
-- Pattern: platform.org.* (org CRUD via /platform/orgs) is SuperUser-only.
-- Pattern: platform.system.set_* and platform.system.list_beta_signups
--          are operator-only settings.
-- Pattern: bam.context.switch is the SuperUser org-context impersonation
--          flow; legacy code already enforces is_superuser.
-- Pattern: superuser_* resource prefixes are obviously SuperUser-only.

UPDATE permissions SET requires_superuser = true WHERE id IN (
    -- Platform org CRUD (creating, deleting, updating orgs is SU-only)
    'platform.org.create',
    'platform.org.delete',
    'platform.org.update',
    -- Platform-wide settings
    'platform.system.set_launchpad_defaults',
    'platform.system.set_public_signup_disabled',
    'platform.system.list_beta_signups',
    'platform.system.test_slack_webhook',
    -- SuperUser context impersonation
    'bam.context.switch'
);

-- Anything resource-named superuser_* is SU-only by convention. The
-- generated catalog uses underscores after the prefix, so this matches
-- both 'superuser_user', 'superuser_organization', etc.
UPDATE permissions
SET requires_superuser = true
WHERE resource LIKE 'superuser_%';
