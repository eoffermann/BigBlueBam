-- 0199_book_external_calendar_sync.sql
-- Why: Book task #63 — turn the disabled Connections placeholder into a real
--   external-calendar-sync foundation. Extends book_external_connections with
--   the columns a provider-agnostic sync engine needs (a human label, the
--   target Book calendar to mirror into, an ICS feed URL, and last-sync result
--   counters) and links book_external_events back to the mirrored book_events
--   row so a re-sync updates in place and a disconnect can clean up cleanly.
--   The first concrete provider is an ICS-URL feed (no operator OAuth secret
--   required); Google/Microsoft remain provider slots pending operator creds.
-- Client impact: additive only. New nullable columns + a relaxed NOT NULL on
--   access_token (ICS feeds carry no token). Idempotent: ADD COLUMN IF NOT
--   EXISTS, guarded DROP NOT NULL, CREATE INDEX IF NOT EXISTS.

-- ──────────────────────────────────────────────────────────────────────
-- book_external_connections: provider-agnostic connection record
-- ──────────────────────────────────────────────────────────────────────

-- Human-friendly label shown in the Connections list (e.g. "Team holidays").
ALTER TABLE book_external_connections
  ADD COLUMN IF NOT EXISTS name varchar(255);

-- The Book calendar that inbound external events are mirrored into. NULL until
-- the sync engine lazily provisions / picks one. SET NULL on calendar delete so
-- the connection survives a calendar removal (next sync re-provisions).
ALTER TABLE book_external_connections
  ADD COLUMN IF NOT EXISTS calendar_id uuid REFERENCES book_calendars(id) ON DELETE SET NULL;

-- For provider='ics': the .ics feed URL to pull. Other providers leave this
-- NULL and use access_token/refresh_token instead.
ALTER TABLE book_external_connections
  ADD COLUMN IF NOT EXISTS feed_url text;

-- Result counter from the most recent successful sync — surfaced in the UI.
ALTER TABLE book_external_connections
  ADD COLUMN IF NOT EXISTS last_sync_event_count integer NOT NULL DEFAULT 0;

-- ICS feeds (and future OAuth-less providers) carry no access token, so the
-- historical NOT NULL on access_token no longer holds. Guarded so re-runs are
-- safe and so an already-dropped constraint does not error.
DO $$
BEGIN
  ALTER TABLE book_external_connections ALTER COLUMN access_token DROP NOT NULL;
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- book_external_events: link each synced external event to the mirrored
-- book_events row so re-sync updates in place and disconnect cleans up.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE book_external_events
  ADD COLUMN IF NOT EXISTS book_event_id uuid REFERENCES book_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_book_ext_events_book_event
  ON book_external_events (book_event_id);

-- A confirmed sync needs a fast "is this external event already mirrored?"
-- lookup keyed by the connection — the unique (connection_id, external_event_id)
-- index from the table's creation migration already serves the upsert path.
