-- 0279_bastion_probe_functions.sql
-- Why: Bastion's native evidence probes (spec 3.1) and the two pre-org resolvers (spec 3.5) as
--   hardened SECURITY DEFINER functions, the first definer functions in the repo. Probes run
--   as definers because under BBB_RLS_ENFORCE=1 the 0116 policies hide exactly the rows a
--   probe must see (sessions of users with no membership in the current org), so an
--   invoker-rights probe would pass access.departed_still_holding precisely when it should
--   fail. The spec numbers this file 0268; the tip had moved on.
-- Client impact: additive only. New functions; nothing existing changes.
--
--   Hardening, applied to every function in this file:
--     * STABLE (probes and resolvers never write), SET search_path = pg_catalog, public,
--       pg_temp (pg_temp last so a temp object can never shadow a catalog or public one);
--     * EXECUTE revoked from PUBLIC, leaving the owner (the migrating POSTGRES_USER, which
--       is also the role every service connects as today); EXECUTE granted to bam_app inside
--       an IF EXISTS guard, because that role does not exist yet and this file must never
--       abort on a database without it;
--     * probes raise unless org = current_setting('app.current_org_id', true), so a caller
--       must be inside runInOrgScope / runInOrgScopeRead for that same org and a definer
--       function cannot be pointed at another tenant (the resolvers have no org guard: they
--       are how a pre-org request finds its org, and return only (id, org_id));
--     * every query carries an explicit org predicate. The two ops.* probes read the
--       platform-wide platform_backups / platform_restores tables, which have no org column;
--       they return counts only.
--   apps/bastion-api/test/db/definer-functions.test.ts asserts proconfig and proacl on every
--   pg_proc row named bastion_%.
--
--   Contract: bastion_probe_<key>_v<n>(org uuid, as_of timestamptz, params jsonb) RETURNS
--   jsonb with probe_key, probe_version, as_of, summary (counts and facts), cited_refs (an
--   array of {entity_type, entity_id} only, capped at 200, no labels), cited_count,
--   overflow_count, and for population probes population_checked / population_unlisted /
--   population_missing. Every probe reads as_of, never now(). The pass/fail predicate is
--   evaluated by the TypeScript probe module, not here. A new probe version is a new
--   function in a new migration; this file is immutable once applied.

-- ──────────────────────────────────────────────────────────────────────
-- Helpers
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_guard(p_org uuid)
    RETURNS void
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_scope text := nullif(current_setting('app.current_org_id', true), '');
BEGIN
    IF p_org IS NULL OR v_scope IS NULL OR p_org::text <> v_scope THEN
        RAISE EXCEPTION
            'BASTION_PROBE_ORG_SCOPE: a probe must run inside runInOrgScope for the same organization'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION bastion_probe_result(
    p_key text,
    p_version integer,
    p_as_of timestamptz,
    p_entity_type text,
    p_ids uuid[],
    p_summary jsonb,
    p_extra jsonb
)
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'probe_key', p_key,
        'probe_version', p_version,
        'as_of', p_as_of,
        'summary', coalesce(p_summary, '{}'::jsonb),
        'cited_refs', coalesce(
            (SELECT jsonb_agg(jsonb_build_object('entity_type', p_entity_type, 'entity_id', u.x) ORDER BY u.ord)
             FROM unnest((coalesce(p_ids, '{}'::uuid[]))[1:200]) WITH ORDINALITY AS u(x, ord)),
            '[]'::jsonb),
        'cited_count', coalesce(cardinality(p_ids), 0),
        'overflow_count', greatest(coalesce(cardinality(p_ids), 0) - 200, 0)
    ) || coalesce(p_extra, '{}'::jsonb);
$$;

-- ──────────────────────────────────────────────────────────────────────
-- keys.max_age: no live key older than max_age_days (default 90) since
-- coalesce(rotated_at, created_at). A predecessor key counts until its rotation grace ends.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_keys_max_age_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_max_age integer := coalesce((params->>'max_age_days')::integer, 90);
    v_checked integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer,
           coalesce(array_agg(k.id ORDER BY coalesce(k.rotated_at, k.created_at), k.id)
                    FILTER (WHERE coalesce(k.rotated_at, k.created_at) < v_as_of - make_interval(days => v_max_age)),
                    '{}'::uuid[])
      INTO v_checked, v_ids
      FROM api_keys k
     WHERE k.org_id = v_org
       AND k.created_at <= v_as_of
       AND (k.expires_at IS NULL OR k.expires_at > v_as_of)
       AND (k.rotation_grace_expires_at IS NULL OR k.rotation_grace_expires_at > v_as_of);
    RETURN bastion_probe_result('keys.max_age', 1, v_as_of, 'api_key', v_ids,
        jsonb_build_object('keys_checked', v_checked, 'max_age_days', v_max_age), NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- keys.unused_active: no live key unused for unused_days (default 60).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_keys_unused_active_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_days integer := coalesce((params->>'unused_days')::integer, 60);
    v_checked integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer,
           coalesce(array_agg(k.id ORDER BY coalesce(k.last_used_at, k.created_at), k.id)
                    FILTER (WHERE coalesce(k.last_used_at, k.created_at) < v_as_of - make_interval(days => v_days)),
                    '{}'::uuid[])
      INTO v_checked, v_ids
      FROM api_keys k
     WHERE k.org_id = v_org
       AND k.created_at <= v_as_of
       AND (k.expires_at IS NULL OR k.expires_at > v_as_of)
       AND (k.rotation_grace_expires_at IS NULL OR k.rotation_grace_expires_at > v_as_of);
    RETURN bastion_probe_result('keys.unused_active', 1, v_as_of, 'api_key', v_ids,
        jsonb_build_object('keys_checked', v_checked, 'unused_days', v_days), NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- access.departed_still_holding: people who hold a live key or live session for this org but
-- are no longer a member of it, or whose account is disabled.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_access_departed_still_holding_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_holders integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    WITH holders AS (
        SELECT k.user_id
          FROM api_keys k
         WHERE k.org_id = v_org
           AND k.created_at <= v_as_of
           AND (k.expires_at IS NULL OR k.expires_at > v_as_of)
           AND (k.rotation_grace_expires_at IS NULL OR k.rotation_grace_expires_at > v_as_of)
        UNION
        SELECT s.user_id
          FROM sessions s
         WHERE s.active_org_id = v_org
           AND s.created_at <= v_as_of
           AND s.expires_at > v_as_of
    )
    SELECT count(*)::integer,
           coalesce(array_agg(h.user_id ORDER BY h.user_id) FILTER (
               WHERE NOT EXISTS (
                         SELECT 1 FROM organization_memberships m
                          WHERE m.user_id = h.user_id AND m.org_id = v_org)
                  OR NOT u.is_active
                  OR (u.disabled_at IS NOT NULL AND u.disabled_at <= v_as_of)
           ), '{}'::uuid[])
      INTO v_holders, v_ids
      FROM holders h
      JOIN users u ON u.id = h.user_id;
    RETURN bastion_probe_result('access.departed_still_holding', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('people_holding_access', v_holders), NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- access.dormant_accounts: active human members (joined before the window) with no successful
-- sign-in and no session use for dormant_days (default 90).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_access_dormant_accounts_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_days integer := coalesce((params->>'dormant_days')::integer, 90);
    v_since timestamptz;
    v_checked integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    v_since := v_as_of - make_interval(days => v_days);
    SELECT count(*)::integer,
           coalesce(array_agg(u.id ORDER BY u.id) FILTER (
               WHERE NOT EXISTS (
                         SELECT 1 FROM login_history lh
                          WHERE lh.user_id = u.id AND lh.success
                            AND lh.created_at > v_since AND lh.created_at <= v_as_of)
                 AND NOT EXISTS (
                         SELECT 1 FROM sessions s
                          WHERE s.user_id = u.id
                            AND s.last_used_at > v_since AND s.last_used_at <= v_as_of)
           ), '{}'::uuid[])
      INTO v_checked, v_ids
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.org_id = v_org
       AND u.kind = 'human'
       AND u.is_active
       AND u.disabled_at IS NULL
       AND m.joined_at <= v_since;
    RETURN bastion_probe_result('access.dormant_accounts', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('members_checked', v_checked, 'dormant_days', v_days), NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- access.privileged_roster: owners and admins of the org (the org-scope permission-group
-- membership's legacy_role; organization_memberships.role was dropped in 0159) plus member
-- SuperUsers. cited_refs is the roster itself; over_limit compares with max_privileged (3).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_access_privileged_roster_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_max integer := coalesce((params->>'max_privileged')::integer, 3);
    v_ids uuid[];
    v_superusers integer;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT coalesce(array_agg(u.id ORDER BY u.id), '{}'::uuid[]),
           count(*) FILTER (WHERE u.is_superuser)::integer
      INTO v_ids, v_superusers
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.org_id = v_org
       AND u.is_active
       AND m.joined_at <= v_as_of
       AND (
           u.is_superuser
           OR EXISTS (
               SELECT 1
                 FROM account_group_memberships agm
                 JOIN permission_groups pg ON pg.id = agm.group_id
                WHERE agm.user_id = u.id
                  AND agm.scope_type = 'org'
                  AND agm.scope_id = v_org
                  AND agm.detached_at IS NULL
                  AND pg.deleted_at IS NULL
                  AND pg.legacy_role IN ('owner', 'admin'))
       );
    RETURN bastion_probe_result('access.privileged_roster', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('privileged_count', cardinality(v_ids), 'superuser_count', v_superusers,
                           'max_privileged', v_max, 'over_limit', cardinality(v_ids) > v_max),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- auth.failed_login_spikes: member accounts with spike_threshold (10) or more failed sign-ins
-- within one clock hour, over window_days (30).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_auth_failed_login_spikes_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 30);
    v_threshold integer := coalesce((params->>'spike_threshold')::integer, 10);
    v_spike_hours integer;
    v_failures integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    WITH failures AS (
        SELECT lh.user_id, date_trunc('hour', lh.created_at) AS hour_bucket
          FROM login_history lh
         WHERE NOT lh.success
           AND lh.user_id IS NOT NULL
           AND lh.created_at > v_as_of - make_interval(days => v_window)
           AND lh.created_at <= v_as_of
           AND EXISTS (SELECT 1 FROM organization_memberships m
                        WHERE m.user_id = lh.user_id AND m.org_id = v_org)
    ), spikes AS (
        SELECT f.user_id, f.hour_bucket
          FROM failures f
         GROUP BY f.user_id, f.hour_bucket
        HAVING count(*) >= v_threshold
    )
    SELECT (SELECT count(*)::integer FROM spikes),
           (SELECT count(*)::integer FROM failures),
           coalesce((SELECT array_agg(DISTINCT s.user_id ORDER BY s.user_id) FROM spikes s), '{}'::uuid[])
      INTO v_spike_hours, v_failures, v_ids;
    RETURN bastion_probe_result('auth.failed_login_spikes', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('spike_hours', v_spike_hours, 'failed_sign_ins', v_failures,
                           'window_days', v_window, 'spike_threshold', v_threshold),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- agents.policy_coverage: every active agent member has an agent_policies row for this org
-- and no bare '*' allowlist.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_agents_policy_coverage_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_checked integer;
    v_missing integer;
    v_wildcard integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer,
           count(*) FILTER (WHERE ap.agent_user_id IS NULL)::integer,
           count(*) FILTER (WHERE ap.agent_user_id IS NOT NULL AND '*' = ANY (ap.allowed_tools))::integer,
           coalesce(array_agg(u.id ORDER BY u.id)
                    FILTER (WHERE ap.agent_user_id IS NULL OR '*' = ANY (ap.allowed_tools)),
                    '{}'::uuid[])
      INTO v_checked, v_missing, v_wildcard, v_ids
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN agent_policies ap ON ap.agent_user_id = u.id AND ap.org_id = v_org
     WHERE m.org_id = v_org
       AND u.kind = 'agent'
       AND u.is_active
       AND u.created_at <= v_as_of;
    RETURN bastion_probe_result('agents.policy_coverage', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('agents_checked', v_checked, 'missing_policy', v_missing,
                           'bare_wildcard', v_wildcard),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- agents.human_approval: over window_days (30), proposals that expired undecided, and decided
-- proposals that required a human decider but were decided by a non-human.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_agents_human_approval_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 30);
    v_since timestamptz;
    v_expired uuid[];
    v_non_human uuid[];
    v_decided integer;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    v_since := v_as_of - make_interval(days => v_window);
    SELECT coalesce(array_agg(p.id ORDER BY p.expires_at, p.id), '{}'::uuid[])
      INTO v_expired
      FROM agent_proposals p
     WHERE p.org_id = v_org
       AND p.decided_at IS NULL
       AND p.status IN ('expired', 'pending')
       AND p.expires_at > v_since
       AND p.expires_at <= v_as_of;
    SELECT count(*)::integer,
           coalesce(array_agg(p.id ORDER BY p.decided_at, p.id)
                    FILTER (WHERE p.require_human_decider
                              AND p.decided_by_kind IS DISTINCT FROM 'human'::actor_type),
                    '{}'::uuid[])
      INTO v_decided, v_non_human
      FROM agent_proposals p
     WHERE p.org_id = v_org
       AND p.status IN ('approved', 'rejected')
       AND p.decided_at > v_since
       AND p.decided_at <= v_as_of;
    RETURN bastion_probe_result('agents.human_approval', 1, v_as_of, 'agent_proposal',
        v_non_human || v_expired,
        jsonb_build_object('expired_undecided', cardinality(v_expired),
                           'decided', v_decided,
                           'decided_without_required_human', cardinality(v_non_human),
                           'window_days', v_window),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- change.merge_reviewed: default-branch merges in window_days (90) with no non-author
-- approval submitted before the merge (a dismissed approval does not count). Population:
-- params.expected_population is a list of "owner/name" repositories; repos are matched
-- case-insensitively. subscribed_events NULL is reported as unknown, never as "not
-- subscribed" (spec 3.1).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_change_merge_reviewed_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 90);
    v_expected text[];
    v_integrated text[];
    v_checked text[];
    v_unlisted text[];
    v_missing text[];
    v_repos jsonb;
    v_merges integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    v_expected := ARRAY(
        SELECT DISTINCT lower(x)
          FROM jsonb_array_elements_text(coalesce(params->'expected_population', '[]'::jsonb)) AS x
         ORDER BY 1);
    v_integrated := ARRAY(
        SELECT DISTINCT lower(gi.repo_owner || '/' || gi.repo_name)
          FROM github_integrations gi
          JOIN projects p ON p.id = gi.project_id
         WHERE p.org_id = v_org AND gi.enabled
         ORDER BY 1);
    v_checked := CASE WHEN cardinality(v_expected) > 0 THEN v_expected ELSE v_integrated END;
    v_unlisted := CASE WHEN cardinality(v_expected) > 0
                       THEN ARRAY(SELECT unnest(v_integrated) EXCEPT SELECT unnest(v_expected) ORDER BY 1)
                       ELSE '{}'::text[] END;
    v_missing := ARRAY(SELECT unnest(v_checked) EXCEPT SELECT unnest(v_integrated) ORDER BY 1);
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'repo', lower(gi.repo_owner || '/' || gi.repo_name),
               'enabled', gi.enabled,
               'subscribed_events', to_jsonb(gi.subscribed_events),
               'reviews_subscribed', CASE WHEN gi.subscribed_events IS NULL THEN NULL
                                          ELSE ('pull_request_review' = ANY (gi.subscribed_events)
                                                OR '*' = ANY (gi.subscribed_events)) END)
             ORDER BY gi.repo_owner, gi.repo_name), '[]'::jsonb)
      INTO v_repos
      FROM github_integrations gi
      JOIN projects p ON p.id = gi.project_id
     WHERE p.org_id = v_org
       AND lower(gi.repo_owner || '/' || gi.repo_name) = ANY (v_checked);
    WITH merges AS (
        SELECT DISTINCT ON (e.repo_owner, e.repo_name, e.pr_number)
               e.id, e.repo_owner, e.repo_name, e.pr_number, e.pr_author_login, e.merged_at
          FROM github_pr_events e
         WHERE e.org_id = v_org
           AND e.event_type = 'pull_request'
           AND e.merged
           AND e.merged_at IS NOT NULL
           AND e.merged_at > v_as_of - make_interval(days => v_window)
           AND e.merged_at <= v_as_of
           AND (e.default_branch IS NULL OR e.base_ref IS NULL OR e.base_ref = e.default_branch)
           AND lower(e.repo_owner || '/' || e.repo_name) = ANY (v_checked)
         ORDER BY e.repo_owner, e.repo_name, e.pr_number, e.merged_at DESC
    )
    SELECT count(*)::integer,
           coalesce(array_agg(mg.id ORDER BY mg.merged_at, mg.id) FILTER (WHERE NOT EXISTS (
               SELECT 1
                 FROM github_pr_events r
                WHERE r.org_id = v_org
                  AND r.event_type = 'pull_request_review'
                  AND r.action = 'submitted'
                  AND r.repo_owner = mg.repo_owner
                  AND r.repo_name = mg.repo_name
                  AND r.pr_number = mg.pr_number
                  AND lower(coalesce(r.review_state, '')) = 'approved'
                  AND r.reviewer_login IS NOT NULL
                  AND r.reviewer_login IS DISTINCT FROM mg.pr_author_login
                  AND coalesce(r.review_submitted_at, r.occurred_at) <= mg.merged_at
                  AND NOT EXISTS (
                      SELECT 1
                        FROM github_pr_events d
                       WHERE d.org_id = v_org
                         AND d.event_type = 'pull_request_review'
                         AND d.action = 'dismissed'
                         AND d.review_id IS NOT NULL
                         AND d.review_id = r.review_id
                         AND d.occurred_at <= mg.merged_at))
           ), '{}'::uuid[])
      INTO v_merges, v_ids
      FROM merges mg;
    RETURN bastion_probe_result('change.merge_reviewed', 1, v_as_of, 'github_pr_event', v_ids,
        jsonb_build_object('merges', v_merges, 'unreviewed_merges', cardinality(v_ids),
                           'window_days', v_window, 'repos', v_repos),
        jsonb_build_object('population_checked', to_jsonb(v_checked),
                           'population_unlisted', to_jsonb(v_unlisted),
                           'population_missing', to_jsonb(v_missing)));
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- change.merge_traceable: default-branch merges in window_days (90) whose title/body named no
-- Bam task. Same population rule as change.merge_reviewed.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_change_merge_traceable_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 90);
    v_expected text[];
    v_integrated text[];
    v_checked text[];
    v_unlisted text[];
    v_missing text[];
    v_merges integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    v_expected := ARRAY(
        SELECT DISTINCT lower(x)
          FROM jsonb_array_elements_text(coalesce(params->'expected_population', '[]'::jsonb)) AS x
         ORDER BY 1);
    v_integrated := ARRAY(
        SELECT DISTINCT lower(gi.repo_owner || '/' || gi.repo_name)
          FROM github_integrations gi
          JOIN projects p ON p.id = gi.project_id
         WHERE p.org_id = v_org AND gi.enabled
         ORDER BY 1);
    v_checked := CASE WHEN cardinality(v_expected) > 0 THEN v_expected ELSE v_integrated END;
    v_unlisted := CASE WHEN cardinality(v_expected) > 0
                       THEN ARRAY(SELECT unnest(v_integrated) EXCEPT SELECT unnest(v_expected) ORDER BY 1)
                       ELSE '{}'::text[] END;
    v_missing := ARRAY(SELECT unnest(v_checked) EXCEPT SELECT unnest(v_integrated) ORDER BY 1);
    WITH merges AS (
        SELECT DISTINCT ON (e.repo_owner, e.repo_name, e.pr_number)
               e.id, e.merged_at, e.task_refs
          FROM github_pr_events e
         WHERE e.org_id = v_org
           AND e.event_type = 'pull_request'
           AND e.merged
           AND e.merged_at IS NOT NULL
           AND e.merged_at > v_as_of - make_interval(days => v_window)
           AND e.merged_at <= v_as_of
           AND (e.default_branch IS NULL OR e.base_ref IS NULL OR e.base_ref = e.default_branch)
           AND lower(e.repo_owner || '/' || e.repo_name) = ANY (v_checked)
         ORDER BY e.repo_owner, e.repo_name, e.pr_number, e.merged_at DESC
    )
    SELECT count(*)::integer,
           coalesce(array_agg(mg.id ORDER BY mg.merged_at, mg.id)
                    FILTER (WHERE coalesce(cardinality(mg.task_refs), 0) = 0), '{}'::uuid[])
      INTO v_merges, v_ids
      FROM merges mg;
    RETURN bastion_probe_result('change.merge_traceable', 1, v_as_of, 'github_pr_event', v_ids,
        jsonb_build_object('merges', v_merges, 'untraced_merges', cardinality(v_ids),
                           'window_days', v_window),
        jsonb_build_object('population_checked', to_jsonb(v_checked),
                           'population_unlisted', to_jsonb(v_unlisted),
                           'population_missing', to_jsonb(v_missing)));
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- ops.backup_fresh (inherited control): the newest completed platform backup and its Bastion
-- off-site mirror status, plus whether this org has off-site evidence backup configured.
-- platform_backups is platform-wide (no org column); counts only.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_ops_backup_fresh_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_completed integer;
    v_latest_at timestamptz;
    v_mirror_status text;
    v_mirror_cursor timestamptz;
    v_offsite boolean;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer INTO v_completed
      FROM platform_backups b
     WHERE b.status = 'completed' AND b.completed_at <= v_as_of;
    SELECT b.completed_at, b.bastion_mirror_status, b.bastion_mirror_cursor
      INTO v_latest_at, v_mirror_status, v_mirror_cursor
      FROM platform_backups b
     WHERE b.status = 'completed' AND b.completed_at <= v_as_of
     ORDER BY b.completed_at DESC
     LIMIT 1;
    SELECT s.offsite_backup_configured INTO v_offsite
      FROM bastion_org_settings s
     WHERE s.organization_id = v_org;
    RETURN bastion_probe_result('ops.backup_fresh', 1, v_as_of, 'platform_backup', '{}'::uuid[],
        jsonb_build_object(
            'completed_backups', v_completed,
            'latest_completed_at', v_latest_at,
            'hours_since_latest', CASE WHEN v_latest_at IS NULL THEN NULL
                                       ELSE round((extract(epoch FROM (v_as_of - v_latest_at)) / 3600.0)::numeric, 2) END,
            'latest_mirror_status', v_mirror_status,
            'latest_mirror_cursor', v_mirror_cursor,
            'offsite_backup_configured', coalesce(v_offsite, false)),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- ops.restore_tested (inherited control): the newest completed platform restore.
-- platform_restores is platform-wide; counts only.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_ops_restore_tested_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 365);
    v_latest_at timestamptz;
    v_in_window integer;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT max(r.completed_at),
           count(*) FILTER (WHERE r.completed_at > v_as_of - make_interval(days => v_window))::integer
      INTO v_latest_at, v_in_window
      FROM platform_restores r
     WHERE r.status = 'completed' AND r.completed_at <= v_as_of;
    RETURN bastion_probe_result('ops.restore_tested', 1, v_as_of, 'platform_restore', '{}'::uuid[],
        jsonb_build_object('latest_completed_at', v_latest_at,
                           'completed_in_window', v_in_window,
                           'window_days', v_window),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- logging.retention_floor: every tracked Blip app keeps logs at least floor_days (90). The
-- effective retention is the tightest app-specific policy, else the tightest org-wide one;
-- NULL max_age_days means unlimited. Population: params.expected_population is a list of
-- tracked-app ids.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_logging_retention_floor_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_floor integer := coalesce((params->>'floor_days')::integer, 90);
    v_expected text[];
    v_tracked text[];
    v_checked text[];
    v_unlisted text[];
    v_missing text[];
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    v_expected := ARRAY(
        SELECT DISTINCT lower(x)
          FROM jsonb_array_elements_text(coalesce(params->'expected_population', '[]'::jsonb)) AS x
         ORDER BY 1);
    v_tracked := ARRAY(
        SELECT a.id::text FROM blip_tracked_apps a
         WHERE a.org_id = v_org AND a.created_at <= v_as_of
         ORDER BY 1);
    v_checked := CASE WHEN cardinality(v_expected) > 0 THEN v_expected ELSE v_tracked END;
    v_unlisted := CASE WHEN cardinality(v_expected) > 0
                       THEN ARRAY(SELECT unnest(v_tracked) EXCEPT SELECT unnest(v_expected) ORDER BY 1)
                       ELSE '{}'::text[] END;
    v_missing := ARRAY(SELECT unnest(v_checked) EXCEPT SELECT unnest(v_tracked) ORDER BY 1);
    WITH apps AS (
        SELECT a.id,
               coalesce(
                   (SELECT min(rp.max_age_days) FROM blip_retention_policies rp
                     WHERE rp.org_id = v_org AND rp.tracked_app_id = a.id),
                   (SELECT min(rp.max_age_days) FROM blip_retention_policies rp
                     WHERE rp.org_id = v_org AND rp.tracked_app_id IS NULL)
               ) AS effective_days
          FROM blip_tracked_apps a
         WHERE a.org_id = v_org
           AND a.id::text = ANY (v_checked)
    )
    SELECT coalesce(array_agg(ap.id ORDER BY ap.id)
                    FILTER (WHERE ap.effective_days IS NOT NULL AND ap.effective_days < v_floor),
                    '{}'::uuid[])
      INTO v_ids
      FROM apps ap;
    RETURN bastion_probe_result('logging.retention_floor', 1, v_as_of, 'blip_tracked_app', v_ids,
        jsonb_build_object('apps_checked', cardinality(v_checked) - cardinality(v_missing),
                           'below_floor', cardinality(v_ids), 'floor_days', v_floor),
        jsonb_build_object('population_checked', to_jsonb(v_checked),
                           'population_unlisted', to_jsonb(v_unlisted),
                           'population_missing', to_jsonb(v_missing)));
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- logging.audit_trail_alive: unified activity recorded in the last window_days (7).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_logging_audit_trail_alive_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 7);
    v_count integer;
    v_latest timestamptz;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer, max(a.created_at)
      INTO v_count, v_latest
      FROM v_activity_unified a
     WHERE a.organization_id = v_org
       AND a.created_at > v_as_of - make_interval(days => v_window)
       AND a.created_at <= v_as_of;
    RETURN bastion_probe_result('logging.audit_trail_alive', 1, v_as_of, 'activity', '{}'::uuid[],
        jsonb_build_object('activity_count', v_count, 'latest_activity_at', v_latest,
                           'window_days', v_window),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- automation.failure_rate: Bolt executions in window_days (30) and how many failed. cited_refs
-- are the automations with at least one failure.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_automation_failure_rate_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 30);
    v_total integer;
    v_failed integer;
    v_automations integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer INTO v_automations
      FROM bolt_automations a
     WHERE a.org_id = v_org AND a.created_at <= v_as_of;
    SELECT count(*)::integer,
           count(*) FILTER (WHERE e.status = 'failed')::integer,
           coalesce(array_agg(DISTINCT e.automation_id ORDER BY e.automation_id)
                    FILTER (WHERE e.status = 'failed'), '{}'::uuid[])
      INTO v_total, v_failed, v_ids
      FROM bolt_executions e
      JOIN bolt_automations a ON a.id = e.automation_id
     WHERE a.org_id = v_org
       AND e.started_at > v_as_of - make_interval(days => v_window)
       AND e.started_at <= v_as_of;
    RETURN bastion_probe_result('automation.failure_rate', 1, v_as_of, 'bolt_automation', v_ids,
        jsonb_build_object('automations', v_automations, 'executions', v_total, 'failed', v_failed,
                           'failure_rate', CASE WHEN v_total = 0 THEN NULL
                                                ELSE round(v_failed::numeric / v_total, 4) END,
                           'window_days', v_window),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- policy.attested: the people a linked policy requires (audience all = active human members;
-- audience users = the listed members) who have NOT attested to the current Beacon version
-- within the policy cadence. params.policy_id is required.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_policy_attested_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_policy_id uuid := (params->>'policy_id')::uuid;
    v_entry_id uuid;
    v_audience jsonb;
    v_cadence integer;
    v_version integer;
    v_required integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT p.beacon_entry_id, p.audience, p.cadence_days
      INTO v_entry_id, v_audience, v_cadence
      FROM bastion_policies p
     WHERE p.id = v_policy_id AND p.organization_id = v_org AND p.status = 'active';
    IF v_entry_id IS NULL THEN
        RETURN bastion_probe_result('policy.attested', 1, v_as_of, 'user', '{}'::uuid[],
            jsonb_build_object('policy_found', false), NULL);
    END IF;
    SELECT be.version INTO v_version
      FROM beacon_entries be
     WHERE be.id = v_entry_id AND be.organization_id = v_org;
    WITH required AS (
        SELECT u.id
          FROM organization_memberships m
          JOIN users u ON u.id = m.user_id
         WHERE m.org_id = v_org
           AND u.kind = 'human'
           AND u.is_active
           AND u.disabled_at IS NULL
           AND (
               coalesce(v_audience->>'kind', 'all') = 'all'
               OR (v_audience->>'kind' = 'users'
                   AND u.id::text IN (SELECT jsonb_array_elements_text(coalesce(v_audience->'user_ids', '[]'::jsonb))))
           )
    )
    SELECT count(*)::integer,
           coalesce(array_agg(r.id ORDER BY r.id) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM bastion_policy_attestations a
                WHERE a.organization_id = v_org
                  AND a.policy_id = v_policy_id
                  AND a.beacon_version = v_version
                  AND a.user_id = r.id
                  AND a.attested_at <= v_as_of
                  AND a.attested_at > v_as_of - make_interval(days => v_cadence))
           ), '{}'::uuid[])
      INTO v_required, v_ids
      FROM required r;
    RETURN bastion_probe_result('policy.attested', 1, v_as_of, 'user', v_ids,
        jsonb_build_object('policy_found', true, 'beacon_version', v_version,
                           'required_people', v_required, 'not_attested', cardinality(v_ids),
                           'cadence_days', v_cadence),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- policy.current: facts about the linked Beacon article (status, visibility, expiry,
-- verification). params.beacon_entry_id, or params.policy_id to look it up.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_policy_current_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_entry_id uuid := (params->>'beacon_entry_id')::uuid;
    v_status text;
    v_visibility text;
    v_expires timestamptz;
    v_verified timestamptz;
    v_found boolean := false;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    IF v_entry_id IS NULL AND params ? 'policy_id' THEN
        SELECT p.beacon_entry_id INTO v_entry_id
          FROM bastion_policies p
         WHERE p.id = (params->>'policy_id')::uuid AND p.organization_id = v_org;
    END IF;
    SELECT be.status::text, be.visibility::text, be.expires_at, be.last_verified_at, true
      INTO v_status, v_visibility, v_expires, v_verified, v_found
      FROM beacon_entries be
     WHERE be.id = v_entry_id AND be.organization_id = v_org;
    RETURN bastion_probe_result('policy.current', 1, v_as_of, 'beacon_entry',
        CASE WHEN coalesce(v_found, false) THEN ARRAY[v_entry_id] ELSE '{}'::uuid[] END,
        jsonb_build_object(
            'found', coalesce(v_found, false),
            'status', v_status,
            'visibility', v_visibility,
            'expires_at', v_expires,
            'days_to_expiry', CASE WHEN v_expires IS NULL THEN NULL
                                   ELSE floor(extract(epoch FROM (v_expires - v_as_of)) / 86400)::integer END,
            'last_verified_at', v_verified,
            'days_since_verified', CASE WHEN v_verified IS NULL THEN NULL
                                        ELSE floor(extract(epoch FROM (v_as_of - v_verified)) / 86400)::integer END),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- platform.superuser_access (informational): SuperUser actions targeting this org within
-- window_days (30).
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_platform_superuser_access_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_window integer := coalesce((params->>'window_days')::integer, 30);
    v_ids uuid[];
    v_actions jsonb;
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT coalesce(array_agg(l.id ORDER BY l.created_at DESC, l.id), '{}'::uuid[])
      INTO v_ids
      FROM superuser_audit_log l
     WHERE l.target_org_id = v_org
       AND l.created_at > v_as_of - make_interval(days => v_window)
       AND l.created_at <= v_as_of;
    SELECT coalesce(jsonb_object_agg(x.action, x.n), '{}'::jsonb)
      INTO v_actions
      FROM (SELECT l.action, count(*)::integer AS n
              FROM superuser_audit_log l
             WHERE l.target_org_id = v_org
               AND l.created_at > v_as_of - make_interval(days => v_window)
               AND l.created_at <= v_as_of
             GROUP BY l.action) x;
    RETURN bastion_probe_result('platform.superuser_access', 1, v_as_of, 'superuser_audit_log', v_ids,
        jsonb_build_object('actions', cardinality(v_ids), 'by_action', v_actions,
                           'window_days', v_window),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- vendors.critical_have_award: active critical Bursar vendors with no active, unexpired award.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_vendors_critical_have_award_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_checked integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT count(*)::integer,
           coalesce(array_agg(v.id ORDER BY v.id) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM bursar_awards a
                WHERE a.organization_id = v_org
                  AND a.vendor_id = v.id
                  AND a.status = 'active'
                  AND a.awarded_at <= v_as_of
                  AND (a.term_end IS NULL OR a.term_end >= (v_as_of AT TIME ZONE 'UTC')::date))
           ), '{}'::uuid[])
      INTO v_checked, v_ids
      FROM bursar_vendors v
     WHERE v.organization_id = v_org
       AND v.criticality = 'critical'
       AND v.status = 'active'
       AND v.created_at <= v_as_of;
    RETURN bastion_probe_result('vendors.critical_have_award', 1, v_as_of, 'bursar_vendor', v_ids,
        jsonb_build_object('critical_vendors', v_checked, 'without_award', cardinality(v_ids)),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- feed.fresh: records received for one feed within its cadence. params.feed_id is required;
-- params.cadence_days overrides the feed's own cadence. cited_refs are the newest records.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_probe_feed_fresh_v1(org uuid, as_of timestamptz, params jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_org uuid := org;
    v_as_of timestamptz := as_of;
    v_feed_id uuid := (params->>'feed_id')::uuid;
    v_cadence integer;
    v_latest timestamptz;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT coalesce((params->>'cadence_days')::integer, f.cadence_days)
      INTO v_cadence
      FROM bastion_evidence_feeds f
     WHERE f.id = v_feed_id AND f.organization_id = v_org;
    IF v_cadence IS NULL THEN
        RETURN bastion_probe_result('feed.fresh', 1, v_as_of, 'bastion_feed_record', '{}'::uuid[],
            jsonb_build_object('feed_found', false), NULL);
    END IF;
    SELECT coalesce(array_agg(r.id ORDER BY r.occurred_at DESC, r.id), '{}'::uuid[]),
           max(r.occurred_at)
      INTO v_ids, v_latest
      FROM bastion_feed_records r
     WHERE r.organization_id = v_org
       AND r.feed_id = v_feed_id
       AND r.received_at <= v_as_of
       AND r.occurred_at > v_as_of - make_interval(days => v_cadence)
       AND r.occurred_at <= v_as_of;
    RETURN bastion_probe_result('feed.fresh', 1, v_as_of, 'bastion_feed_record', v_ids,
        jsonb_build_object('feed_found', true, 'records_in_cadence', cardinality(v_ids),
                           'latest_occurred_at', v_latest, 'cadence_days', v_cadence),
        NULL);
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- Pre-org resolvers (spec 3.5). They return only (id, org_id) so a feed push or an auditor
-- room request can find its org and then bind runInOrgScope; every status/expiry check runs
-- after that, inside the org scope. No org guard (there is no org yet), otherwise hardened.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_resolve_feed_key(p_key_id text)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT k.id, k.organization_id
      FROM bastion_feed_keys k
     WHERE k.key_id = p_key_id
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION bastion_resolve_room(p_token_sha256 text)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT r.id, r.organization_id
      FROM bastion_auditor_rooms r
     WHERE r.token_sha256 = p_token_sha256
     LIMIT 1;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- Hardening loop (spec 3.1): REVOKE ALL ... FROM PUBLIC on every bastion_% function, and the
-- guarded GRANT EXECUTE ... TO bam_app on the SECURITY DEFINER ones only when the role exists.
-- ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure AS sig, p.prosecdef
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'bastion\_%' ESCAPE '\'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
        IF fn.prosecdef AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bam_app') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO bam_app', fn.sig);
        END IF;
    END LOOP;
END $$;
