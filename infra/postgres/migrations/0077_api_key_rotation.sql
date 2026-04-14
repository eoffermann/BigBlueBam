-- 0077_api_key_rotation.sql
-- Why: allow API keys to be rotated without immediate invalidation of the
-- predecessor. Callers holding the old token get a 7-day grace window to
-- switch over, after which the predecessor row's expires_at / grace window
-- stops verifying on the auth hot path.
-- Client impact: additive only. New columns default to NULL; existing
-- rows are unaffected and existing auth-plugin logic keeps working. A new
-- POST /v1/api-keys/:id/rotate endpoint writes these columns.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotation_grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS predecessor_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS api_keys_rotation_grace_idx
  ON api_keys(rotation_grace_expires_at)
  WHERE rotation_grace_expires_at IS NOT NULL;
