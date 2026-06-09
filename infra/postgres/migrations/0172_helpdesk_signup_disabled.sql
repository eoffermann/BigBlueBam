-- 0172_helpdesk_signup_disabled.sql
-- Why: B3 Frndo Launch follow-up — the existing `public_signup_disabled`
--       toggle was wired to BOTH the BigBlueBam internal signup AND the
--       Helpdesk customer signup. Closing internal signup during beta is
--       reasonable; closing Helpdesk signup at the same time blocks
--       legitimate customers from filing tickets. The two systems are
--       distinct identity scopes (BBB users vs Helpdesk end-customer
--       users) and need separate gates.
--       This migration adds a dedicated `helpdesk_signup_disabled` flag.
--       It defaults to FALSE so on existing deployments Helpdesk signup
--       remains open even if internal signup is closed.
-- Client impact: additive only — existing rows get the new column with
--       its default value via the standard ADD COLUMN IF NOT EXISTS
--       guard. The helpdesk-api will swap which flag it reads in a
--       follow-up code change; until that ships, behavior is unchanged.

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS helpdesk_signup_disabled BOOLEAN NOT NULL DEFAULT FALSE;
