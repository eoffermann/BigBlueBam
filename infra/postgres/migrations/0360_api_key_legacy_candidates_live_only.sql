-- 0360_api_key_legacy_candidates_live_only.sql
-- Why: auth_api_key_legacy_candidates (0345) returned every legacy key with the prefix, most
--   recently used first, and auth-core verifies only the first 3 of the shared bbam_svc bucket.
--   Three dead rows (expired, rotated past their grace window, or owned by a deactivated user)
--   used more recently than a live key filled the cap, so the live key never authenticated, never
--   adopted a lookup id and never moved up: a permanent lockout (#372). Dead keys are now
--   filtered out before the LIMIT with the same rule as auth-core's isApiKeyUsable plus the
--   owner's is_active. auth-core still re-checks both after the verify.
-- Client impact: none. Only keys that could never authenticate stop being returned.

CREATE OR REPLACE FUNCTION auth_api_key_legacy_candidates(p_prefix text, p_limit integer)
RETURNS SETOF api_keys
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.* FROM api_keys k
    JOIN users u ON u.id = k.user_id
   WHERE k.key_prefix = p_prefix
     AND k.key_lookup IS NULL
     AND u.is_active
     AND CASE
           WHEN k.rotated_at IS NOT NULL
             THEN k.rotation_grace_expires_at IS NOT NULL AND k.rotation_grace_expires_at > now()
           ELSE k.expires_at IS NULL OR k.expires_at >= now()
         END
   ORDER BY k.last_used_at DESC NULLS LAST, k.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 64)
$$;
