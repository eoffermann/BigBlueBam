-- 0316_bastion_questionnaire_transient_releases.sql
-- Why: issue #329 (Bastion autofill). The count of free releases after a transient database error
--   lived in column_map.transient_releases and was never reset, so it was per questionnaire for its
--   whole life instead of per run: once ten blips had happened across any runs, every later blip
--   cost a resume and three of them parked the questionnaire ("Needs an expert"). It is run state,
--   so it moves into a real column beside ai_failure_streak (as 0290 did for the rest), which the
--   autofill start resets in the same UPDATE. The old key is removed from column_map; old
--   lifetime counts are deliberately not carried over (that stale count is the bug).
-- Client impact: additive only. New column with a default; column_map loses only an internal key
--   no API response documents.

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS transient_releases integer NOT NULL DEFAULT 0;

UPDATE bastion_questionnaires
   SET column_map = column_map - 'transient_releases'
 WHERE column_map ? 'transient_releases';
