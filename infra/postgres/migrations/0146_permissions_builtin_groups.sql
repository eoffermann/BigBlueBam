-- 0146_permissions_builtin_groups.sql
-- Why: Wave A foundation. Seeds the five built-in permission groups
--   (Owner / Admin / Member / Viewer / Guest) at global scope and
--   populates their permission_group_defaults so day-one of the new
--   resolver matches today's behavior. The permission_groups rows are
--   immortal (is_builtin=true blocks soft-delete via the editor UI);
--   only their defaults can be edited and even that is gated on
--   SuperUser in the editor.
-- Client impact: additive only. No effect on any existing user until
--   account_group_memberships rows are written by 0147 (Wave B). The
--   permissions catalog seeded by 0145 is required first; this migration
--   reads from it.

-- ──────────────────────────────────────────────────────────────────────
-- Built-in groups
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permission_groups (id, name, description, scope_type, scope_id, is_builtin, legacy_role)
VALUES
    ('11111111-1111-4111-8111-111111111111', 'Owner',
     'Full org authority. Includes ownership transfer and org deletion. Mirrors the legacy owner role.',
     'global', NULL, true, 'owner'),
    ('22222222-2222-4222-8222-222222222222', 'Admin',
     'Org-level administrator. Same as Owner except cannot delete the org or transfer ownership. Mirrors the legacy admin role.',
     'global', NULL, true, 'admin'),
    ('33333333-3333-4333-8333-333333333333', 'Member',
     'Standard org member. Read everywhere, write on most resources. Cannot administer the org or other members. Mirrors the legacy member role.',
     'global', NULL, true, 'member'),
    ('44444444-4444-4444-8444-444444444444', 'Viewer',
     'Read-only access across the org. Mirrors the legacy viewer role.',
     'global', NULL, true, 'viewer'),
    ('55555555-5555-4555-8555-555555555555', 'Guest',
     'Project-scoped read access. Limited to projects the guest has been explicitly invited to. Mirrors the legacy guest role.',
     'global', NULL, true, 'guest')
ON CONFLICT DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Owner: every permission granted.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT '11111111-1111-4111-8111-111111111111', id, true FROM permissions
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Admin: every permission EXCEPT org deletion and ownership transfer.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT '22222222-2222-4222-8222-222222222222', id,
       NOT (id IN ('platform.org.delete')
            OR id LIKE '%.transfer'
            OR id LIKE '%.transfer_ownership'
            OR id = 'platform.system.set_launchpad_defaults'
            OR id = 'platform.system.set_public_signup_disabled'
            OR id = 'platform.system.list_beta_signups')
FROM permissions
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Member: read everywhere, write on most resources, no org admin.
-- ──────────────────────────────────────────────────────────────────────
--
-- Excluded write actions:
--   - org/member admin: invite, set_role, remove member, delete org
--   - api-key admin scope (covered by api_keys.scope ceiling, not here)
--   - destructive global actions
--   - launchpad/platform settings
--   - agent policy + webhook administration

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT '33333333-3333-4333-8333-333333333333', id,
       CASE
           -- Always allow reads.
           WHEN is_read THEN true
           -- Deny org administration verbs.
           WHEN id LIKE 'platform.org.%' AND verb IN ('delete', 'create', 'update', 'set_launchpad_apps') THEN false
           WHEN id LIKE 'platform.system.%' AND verb LIKE 'set_%' THEN false
           WHEN id LIKE 'platform.system.%' AND verb LIKE 'list_beta_signups' THEN false
           -- Deny member-management verbs.
           WHEN resource = 'member' AND verb IN ('invite', 'remove', 'set_role', 'transfer') THEN false
           WHEN id LIKE '%.member.invite' OR id LIKE '%.member.remove' THEN false
           -- Deny agent administration (kill-switch, allowlist edits).
           WHEN app = 'agent' AND verb IN ('set', 'configure', 'rotate_secret', 'redeliver') THEN false
           -- Deny operator-only proposal decisions.
           WHEN id = 'platform.proposal.decide' THEN false
           -- Allow every other write.
           ELSE true
       END
FROM permissions
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Viewer: reads only.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT '44444444-4444-4444-8444-444444444444', id, is_read FROM permissions
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Guest: reads only, scoped to the projects they've been invited to.
-- ──────────────────────────────────────────────────────────────────────
--
-- The scope-level check (which projects) lives outside the permission
-- system in project_memberships. This default mirrors Viewer for the
-- read side; the resolver is responsible for verifying the user has
-- visibility into the specific entity via visibility.service.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT '55555555-5555-4555-8555-555555555555', id,
       CASE
           -- Reads on bam (tasks/projects/sprints) and helpdesk only.
           WHEN is_read AND app IN ('bam', 'helpdesk', 'platform', 'shared') THEN true
           -- Self-management still allowed.
           WHEN id LIKE 'platform.user.%' AND verb IN ('get_profile', 'update_profile', 'change_password', 'logout', 'list_orgs', 'list_notifications') THEN true
           ELSE false
       END
FROM permissions
ON CONFLICT (group_id, permission_id) DO NOTHING;
