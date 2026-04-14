-- 0072_bolt_rename_prefixed_events.sql
-- Why: Normalize event-type strings to bare names after the Wave 0.4
--   cross-product naming sweep. Bond's stale-deal worker previously
--   emitted 'bond.deal.rotting'; every other catalog entry is bare
--   (deal.created, board.updated, beacon.verified, etc.). This
--   migration rewrites the two persisted columns that could hold a
--   historical prefixed value: bolt_automations.trigger_event (text)
--   and bolt_executions.trigger_event (jsonb, with _event_type key).
--   See Cross_Product_Integration_Plan.md Step 4 (P0.3) and
--   DECISIONS.md D-011 for context.
-- Client impact: additive only. String rewrites on two existing
--   columns; no schema change, no row creation, no row deletion. Safe
--   to re-run (second run's WHERE clause matches zero rows).

BEGIN;

-- 1. bolt_automations.trigger_event (varchar(60), NOT NULL)
--    Matches the exact legacy string on equality.
UPDATE bolt_automations
SET trigger_event = 'deal.rotting'
WHERE trigger_event = 'bond.deal.rotting';

-- 2. bolt_executions.trigger_event (jsonb, nullable)
--    The column stores the full trigger payload; the event-type string
--    lives under the `_event_type` key, set by
--    apps/bolt-api/src/routes/event-ingestion.routes.ts at ingest time.
--    jsonb_set returns the same object with that key replaced.
--    The WHERE clause uses ->> for a text comparison so rows where the
--    key is absent or NULL are naturally skipped.
UPDATE bolt_executions
SET trigger_event = jsonb_set(
    trigger_event,
    '{_event_type}',
    '"deal.rotting"'::jsonb,
    false
)
WHERE trigger_event IS NOT NULL
  AND trigger_event->>'_event_type' = 'bond.deal.rotting';

-- No further prefixed names were found by the Wave 0.4 sweep. If future
-- incidents surface additional rewrites, claim a new migration number
-- rather than editing this file.

COMMIT;
