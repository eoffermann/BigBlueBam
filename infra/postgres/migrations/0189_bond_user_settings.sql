-- 0189_bond_user_settings.sql
-- Why: Per-user reply-to email for Bond. When a Bond user reaches out to a
--      client on their behalf (e.g. a Blast campaign), replies should route to
--      a monitored address instead of the user's unmonitored personal inbox.
--      This stores each user's chosen reply-to; the Blast campaign-create path
--      reads it as the default reply-to when the campaign doesn't set one.
-- Client impact: additive only (new table; nothing existing changes).

CREATE TABLE IF NOT EXISTS bond_user_settings (
    user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reply_to_email varchar(255),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
