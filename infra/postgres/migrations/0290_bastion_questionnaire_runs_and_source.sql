-- 0290_bastion_questionnaire_runs_and_source.sql
-- Why: issues #260, #261, #265, #267, #271 and #273 (Bastion M8 review). Autofill needs durable
--   per-questionnaire run state: llm_calls_used counts every AI call (charged before the call,
--   throttled retries included) and is never reset by a redraft, so max_llm_calls_per_questionnaire
--   bounds the spend (#261); autofill_generation goes up on every start, so each run's
--   questionnaire.drafted event gets its own idempotency key (#267); ai_failure_streak and
--   last_ai_failure hold consecutive transient AI failures, so an outage leaves rows undrafted and
--   retried instead of banding them "Needs an expert" (#260); autofill_use_ai records whether the
--   run may call the AI at all (the deterministic seed path, #271). The parsed source grid moves
--   out of column_map into source_grid (read only by mapping changes and export), with
--   source_truncated and a small source_preview beside it, so list and get reads never load it
--   (#265, #273). Existing rows are moved by the UPDATE below.
-- Client impact: additive only. New columns with defaults; column_map keeps the mapping and loses
--   only its internal "source" key, which no API response ever returned.

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS llm_calls_used integer NOT NULL DEFAULT 0;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS autofill_generation integer NOT NULL DEFAULT 0;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS ai_failure_streak integer NOT NULL DEFAULT 0;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS last_ai_failure varchar(512);

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS autofill_use_ai boolean NOT NULL DEFAULT true;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS source_grid jsonb;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS source_truncated boolean NOT NULL DEFAULT false;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS source_preview jsonb;

-- Move the grid out of column_map (idempotent: only rows that still carry it are touched).
UPDATE bastion_questionnaires
   SET source_grid = column_map -> 'source',
       source_truncated = coalesce((column_map -> 'source' ->> 'truncated')::boolean, false),
       column_map = column_map - 'source'
 WHERE column_map ? 'source';
