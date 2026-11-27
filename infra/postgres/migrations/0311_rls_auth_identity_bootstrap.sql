-- 0311_rls_auth_identity_bootstrap.sql
-- Why: Under BBB_RLS_ENFORCE=1 the api auth preHandler could not authenticate anyone (#105). It
--   reads sessions, api_keys, organization_memberships, organizations and the role tables to learn
--   WHICH org a request belongs to, but every one of those tables was gated by
--   app.current_org_id, which can only be bound after authentication. With no org bound the
--   lookups returned zero rows, so every valid cookie and API key was a 401. Identity lookups
--   now go through SECURITY DEFINER functions keyed by the credential (session id, key prefix)
--   or by the already-authenticated user id, and sessions loses its org policy: a session is a
--   per-user credential that spans orgs (the org policy also hid a SuperUser's own session while
--   they viewed an org they are not a member of).
-- Client impact: none under the default advisory posture (the app role bypasses RLS and the
--   functions return exactly what the old queries returned). Under enforce mode, authentication
--   works. Additive functions plus one dropped policy; re-runnable.

-- sessions: per-user credential rows, not org data. Keyed by an unguessable id or by user id.
DROP POLICY IF EXISTS sessions_org_isolation ON sessions;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;

-- API key candidates for a key prefix (the bearer token's first 8 chars). The caller still
-- Argon2-verifies the full token, so the prefix alone authenticates nothing.
CREATE OR REPLACE FUNCTION auth_api_key_candidates(p_prefix text, p_limit integer)
RETURNS SETOF api_keys
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM api_keys WHERE key_prefix = p_prefix LIMIT LEAST(GREATEST(p_limit, 1), 64)
$$;

-- last_used_at bump after a key authenticated (before the org GUC is bound).
CREATE OR REPLACE FUNCTION auth_touch_api_key(p_key_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_keys SET last_used_at = now() WHERE id = p_key_id
$$;

-- An authenticated user's memberships in live (not soft-deleted) orgs, with the org-scope role.
CREATE OR REPLACE FUNCTION auth_user_live_memberships(p_user_id uuid)
RETURNS TABLE (org_id uuid, is_default boolean, joined_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT om.org_id, om.is_default, om.joined_at
    FROM organization_memberships om
    JOIN organizations o ON o.id = om.org_id
   WHERE om.user_id = p_user_id AND o.deleted_at IS NULL
$$;

-- An authenticated user's org-scope role in every org they are grouped into.
CREATE OR REPLACE FUNCTION auth_user_org_roles(p_user_id uuid)
RETURNS TABLE (org_id uuid, legacy_role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT agm.scope_id, pg.legacy_role::text
    FROM account_group_memberships agm
    JOIN permission_groups pg ON pg.id = agm.group_id
   WHERE agm.user_id = p_user_id AND agm.scope_type = 'org'
     AND agm.scope_id IS NOT NULL AND pg.legacy_role IS NOT NULL
$$;

-- Whether an org exists and is not soft-deleted (the users.org_id fallback for a user with no
-- membership rows).
CREATE OR REPLACE FUNCTION auth_org_is_live(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM organizations WHERE id = p_org_id AND deleted_at IS NULL)
$$;
