-- 0345_api_key_lookup.sql
-- Why: Every service-account key shares the 8-char key_prefix 'bbam_svc', so an unauthenticated
--   'Bearer bbam_svc...' header made every service run Argon2id once per service-account key on
--   the platform, up to 64 times (#353). Keys now carry a high-entropy lookup id (hex SHA-256 of
--   the full token) that locates exactly one row. Existing hashes cannot be backfilled (the token
--   is not stored), so a legacy key gains its lookup id the first time it authenticates
--   (auth_adopt_api_key_lookup); until then it is found by prefix with a hard cap of 3 verifies.
-- Client impact: additive only (nullable column, unique partial index, new functions). Existing
--   keys keep working; mint paths start writing key_lookup.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_lookup text;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_lookup_uniq
  ON api_keys (key_lookup) WHERE key_lookup IS NOT NULL;

-- The key whose lookup id matches (zero or one row). The caller still Argon2-verifies the token.
CREATE OR REPLACE FUNCTION auth_api_key_by_lookup(p_lookup text)
RETURNS SETOF api_keys
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM api_keys WHERE key_lookup = p_lookup LIMIT 1
$$;

-- Legacy keys (no lookup id yet) for a key prefix, most recently used first.
CREATE OR REPLACE FUNCTION auth_api_key_legacy_candidates(p_prefix text, p_limit integer)
RETURNS SETOF api_keys
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM api_keys
   WHERE key_prefix = p_prefix AND key_lookup IS NULL
   ORDER BY last_used_at DESC NULLS LAST, created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 64)
$$;

-- Record the lookup id on a legacy key that just authenticated. Never overwrites an existing one.
CREATE OR REPLACE FUNCTION auth_adopt_api_key_lookup(p_key_id uuid, p_lookup text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_keys SET key_lookup = p_lookup WHERE id = p_key_id AND key_lookup IS NULL
$$;
