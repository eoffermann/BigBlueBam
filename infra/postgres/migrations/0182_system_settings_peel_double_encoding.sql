-- 0182_system_settings_peel_double_encoding.sql
-- Why: Every system_settings row written through the SuperUser PUT
--      route was stored double-encoded — the route called JSON.stringify
--      on the input before letting drizzle / postgres-js encode it for
--      the JSONB column. Result:
--        - A host of `smtp.stackmail.com` was stored as the JSONB string
--          `"smtp.stackmail.com"` WITH literal embedded quotes (the
--          underlying cause of the 2026-06-11 invite-flow DNS EBADNAME
--          incident).
--        - smtp_port: 587 was stored as the JSONB string "587".
--        - smtp_secure: false was stored as the JSONB string "false".
--        - password_policy: { mode: 'alphanumeric', … } was stored as
--          the JSONB string '{"mode":"alphanumeric", …}'.
--      The route fix (commit a95914f's sibling) removes the extra
--      JSON.stringify so new writes land correctly. This migration
--      unwraps every existing row so the storage shape is consistent
--      across legacy and new rows.
-- Client impact: data-only. Every code path that READS system_settings
--      either uses the smtp-resolver's normalizeRow helper (which
--      already handled both shapes) or password-policy's normalizePolicy
--      (likewise). The frontend form reads back into the same field it
--      wrote so changes are invisible there. The migration is purely
--      reparative and is safe to re-run — the WHERE clause filters out
--      any row already in the correct shape.

-- Identify rows where the JSONB value is a string whose contents look
-- like a JSON encoding (object, array, number, boolean, null, or a
-- quoted string). For each such row, peel one layer of encoding by
-- parsing the inner text and replacing the value with the parsed form.
--
-- We do NOT touch rows where the JSONB is already non-string (object,
-- number, boolean, etc. — those are already correctly typed) or where
-- the contained string doesn't look JSON-shaped (e.g. root_redirect's
-- legitimate 'site' value, which is just a plain string).
UPDATE system_settings
   SET value = (value #>> '{}')::jsonb
 WHERE jsonb_typeof(value) = 'string'
   AND (value #>> '{}') ~ '^("|\{|\[|true$|false$|null$|-?[0-9])';

-- Note: idempotent. After a successful run, every previously over-
-- encoded row is now a single-level JSONB value of the appropriate
-- type, and the WHERE clause skips them on a re-run.
