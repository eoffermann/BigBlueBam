-- 0193_banter_preferences_notification_toggles.sql
-- Why: The Banter Preferences page exposes five toggles, but only two
--      (compact_mode, enter_sends_message) had backing columns. The other
--      three — notification_sound, desktop_notifications,
--      show_typing_indicators — were silently dropped by the PATCH handler
--      (no column), so they never persisted and reset to defaults on reload.
--      This adds the missing boolean columns so all five toggles round-trip.
-- Client impact: additive only (three new boolean columns with defaults;
--      existing rows backfill to the column default).

ALTER TABLE banter_user_preferences
  ADD COLUMN IF NOT EXISTS notification_sound boolean NOT NULL DEFAULT true;

ALTER TABLE banter_user_preferences
  ADD COLUMN IF NOT EXISTS desktop_notifications boolean NOT NULL DEFAULT true;

ALTER TABLE banter_user_preferences
  ADD COLUMN IF NOT EXISTS show_typing_indicators boolean NOT NULL DEFAULT true;
