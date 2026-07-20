-- 0255_bursar_leveling_caps.sql
-- Why: the M5 leveling engine persists the per-run caps it actually enforced (max_offers_per_run,
--   max_llm_calls_per_run, max_nodes_per_run) as USED on the run row, so a leveling verdict is
--   auditable against the exact limits in force at the time (spec 3.9). Kept as one jsonb column
--   rather than three integers so a later cap addition does not need another migration.
-- Client impact: additive only. One nullable-with-default column on bursar_leveling_runs; no
--   changes to existing objects, no backfill required.

ALTER TABLE bursar_leveling_runs
    ADD COLUMN IF NOT EXISTS caps_used jsonb NOT NULL DEFAULT '{}'::jsonb;
