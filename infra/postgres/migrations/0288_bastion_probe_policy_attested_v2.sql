-- 0288_bastion_probe_policy_attested_v2.sql
-- Why: issue #244. bastion_probe_policy_attested_v1 never looked at the linked Beacon article's
--   state. A DELETED article gave a NULL version, `beacon_version = NULL` is never true, so every
--   audience member read as "not attested" and the daily nudge told the whole organization to
--   read a policy nobody could open; a RETIRED, ARCHIVED or EXPIRED article stayed "current", so
--   people kept being nudged to acknowledge a withdrawn document. v2 reports article_state
--   ('current' | 'missing' | 'retired' | 'expired') and, for anything but 'current', an EMPTY
--   not-attested set, so no consumer (Policies page, /me/attestations, the nudge, the nightly
--   check) treats the audience as due on a policy that cannot be read. The TypeScript probe
--   module turns a non-current article into a failing (retired/expired) or unprovable (missing)
--   check, so policy.attested no longer shows green on a withdrawn policy. Per the 0279
--   contract a new probe version is a new function in a new migration; v1 stays as it was
--   (snapshots taken with it keep their meaning).
-- Client impact: additive only. One new SECURITY DEFINER function, hardened exactly like 0279's
--   (pinned search_path, org guard, EXECUTE revoked from PUBLIC, guarded grant to bam_app).

CREATE OR REPLACE FUNCTION bastion_probe_policy_attested_v2(org uuid, as_of timestamptz, params jsonb)
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
    v_found boolean;
    v_version integer;
    v_status text;
    v_expires timestamptz;
    v_state text;
    v_required integer;
    v_ids uuid[];
BEGIN
    PERFORM bastion_probe_guard(v_org);
    SELECT p.beacon_entry_id, p.audience, p.cadence_days
      INTO v_entry_id, v_audience, v_cadence
      FROM bastion_policies p
     WHERE p.id = v_policy_id AND p.organization_id = v_org AND p.status = 'active';
    IF v_entry_id IS NULL THEN
        RETURN bastion_probe_result('policy.attested', 2, v_as_of, 'user', '{}'::uuid[],
            jsonb_build_object('policy_found', false), NULL);
    END IF;
    SELECT true, be.version, be.status::text, be.expires_at
      INTO v_found, v_version, v_status, v_expires
      FROM beacon_entries be
     WHERE be.id = v_entry_id AND be.organization_id = v_org;
    v_state := CASE
        WHEN v_found IS NULL OR v_version IS NULL THEN 'missing'
        WHEN v_status IN ('Retired', 'Archived') THEN 'retired'
        WHEN v_status = 'Expired' OR (v_expires IS NOT NULL AND v_expires < v_as_of) THEN 'expired'
        ELSE 'current'
    END;
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
           coalesce(array_agg(r.id ORDER BY r.id) FILTER (WHERE v_state = 'current' AND NOT EXISTS (
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
    RETURN bastion_probe_result('policy.attested', 2, v_as_of, 'user', v_ids,
        jsonb_build_object('policy_found', true, 'article_state', v_state, 'beacon_status', v_status,
                           'beacon_expires_at', v_expires, 'beacon_version', v_version,
                           'required_people', v_required, 'not_attested', cardinality(v_ids),
                           'cadence_days', v_cadence),
        NULL);
END;
$$;

REVOKE ALL ON FUNCTION bastion_probe_policy_attested_v2(uuid, timestamptz, jsonb) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bam_app') THEN
        GRANT EXECUTE ON FUNCTION bastion_probe_policy_attested_v2(uuid, timestamptz, jsonb) TO bam_app;
    END IF;
END $$;
