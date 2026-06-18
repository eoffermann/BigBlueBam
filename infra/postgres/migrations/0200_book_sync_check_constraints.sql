-- 0200_book_sync_check_constraints.sql
-- Why: Book task #63 follow-up. The external-calendar-sync foundation (0199)
--   introduced the 'ics' provider plus 'pending'/'needs_config' sync statuses,
--   but the original book_external_connections CHECK constraints only allowed
--   provider IN (google, microsoft) and sync_status IN (active, paused, error),
--   so creating an ICS connection failed with a check-constraint violation.
--   Also widens book_calendars.calendar_type to include 'bureau', which the
--   bureau internal-events route already inserts (a pre-existing latent
--   violation that only surfaces once that path provisions a fresh calendar).
-- Client impact: additive only — relaxes (never tightens) three CHECK
--   constraints. Idempotent: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT
--   inside guarded DO blocks that tolerate re-runs.

-- provider: add 'ics'
DO $$
BEGIN
  ALTER TABLE book_external_connections DROP CONSTRAINT IF EXISTS book_external_connections_provider_check;
  ALTER TABLE book_external_connections
    ADD CONSTRAINT book_external_connections_provider_check
    CHECK (provider IN ('ics', 'google', 'microsoft'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- sync_status: add 'pending' and 'needs_config'
DO $$
BEGIN
  ALTER TABLE book_external_connections DROP CONSTRAINT IF EXISTS book_external_connections_sync_status_check;
  ALTER TABLE book_external_connections
    ADD CONSTRAINT book_external_connections_sync_status_check
    CHECK (sync_status IN ('active', 'paused', 'error', 'pending', 'needs_config'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- calendar_type: add 'bureau' (already inserted by the bureau internal route)
DO $$
BEGIN
  ALTER TABLE book_calendars DROP CONSTRAINT IF EXISTS book_calendars_calendar_type_check;
  ALTER TABLE book_calendars
    ADD CONSTRAINT book_calendars_calendar_type_check
    CHECK (calendar_type IN ('personal', 'team', 'project', 'booking', 'bureau'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
