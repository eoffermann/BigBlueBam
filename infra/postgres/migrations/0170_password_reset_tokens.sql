-- 0170_password_reset_tokens.sql
-- Why: B3 Frndo Launch — adds the "send password reset link" feature.
--       Admins (and eventually self-serve forgot-password) mint a one-time
--       token, the user clicks the link in their email, sets a new password,
--       and the token is burned. Also reused for new-member onboarding so a
--       freshly-invited user can set their own password instead of having
--       a temp password emailed to them in cleartext.
-- Client impact: additive only — no existing column or table is touched.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the raw token (base64). We never store the raw token —
  -- the user gets it once in the URL and we look up by hash.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  -- Whoever triggered the mint. NULL for self-serve forgot-password.
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- "invite" or "reset" — drives the wording on the consume page (e.g. the
  -- title is "Set your password" vs "Reset your password"). Cheap to add now
  -- so we don't need a second migration when invite onboarding lands.
  purpose text NOT NULL DEFAULT 'reset',
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx
  ON password_reset_tokens(expires_at);
