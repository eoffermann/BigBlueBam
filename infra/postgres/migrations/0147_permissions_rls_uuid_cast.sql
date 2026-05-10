-- 0147_permissions_rls_uuid_cast.sql
-- Why: Wave-B prep cleanup of the RLS policies introduced in 0144. The
--   original policies cast scope_id::text instead of using the codebase-
--   idiomatic `scope_id = current_setting('app.current_org_id', true)::uuid`
--   from 0116 (slower text-vs-text comparison) and carried two dead
--   branches (org-id-as-text and an organizations subquery) in
--   permission_groups_isolation. This migration replaces the policies
--   with cleaner versions; behavior is identical, but the cleanup matters
--   for Wave B when the resolver runs on every request.
-- Client impact: none. Policies are advisory under BBB_RLS_ENFORCE=0
--   (today's default); tightened policies don't change query results
--   when the role has BYPASSRLS. Safe to apply with active traffic.

DROP POLICY IF EXISTS permission_groups_isolation ON permission_groups;
CREATE POLICY permission_groups_isolation ON permission_groups
    USING (
        scope_type = 'global'
        OR scope_id = current_setting('app.current_org_id', true)::uuid
        OR scope_id IN (
            -- project scope: a row is visible if its scope_id is a
            -- project that belongs to the current org.
            SELECT id FROM projects
            WHERE org_id = current_setting('app.current_org_id', true)::uuid
        )
    );

DROP POLICY IF EXISTS permission_group_defaults_isolation ON permission_group_defaults;
CREATE POLICY permission_group_defaults_isolation ON permission_group_defaults
    USING (
        EXISTS (
            SELECT 1 FROM permission_groups pg
            WHERE pg.id = permission_group_defaults.group_id
              AND (pg.scope_type = 'global'
                   OR pg.scope_id = current_setting('app.current_org_id', true)::uuid
                   OR pg.scope_id IN (
                       SELECT id FROM projects
                       WHERE org_id = current_setting('app.current_org_id', true)::uuid
                   ))
        )
    );

DROP POLICY IF EXISTS account_permissions_isolation ON account_permissions;
CREATE POLICY account_permissions_isolation ON account_permissions
    USING (
        scope_type = 'global'
        OR scope_id = current_setting('app.current_org_id', true)::uuid
        OR scope_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.current_org_id', true)::uuid
        )
    );

DROP POLICY IF EXISTS account_group_memberships_isolation ON account_group_memberships;
CREATE POLICY account_group_memberships_isolation ON account_group_memberships
    USING (
        scope_type = 'global'
        OR scope_id = current_setting('app.current_org_id', true)::uuid
        OR scope_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.current_org_id', true)::uuid
        )
    );
