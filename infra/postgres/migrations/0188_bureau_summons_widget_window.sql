-- 0188_bureau_summons_widget_window.sql
-- Why: The seeded "Bureau Summons (Latest Day)" Bench widget (migration 0178)
--      uses a `last_1_days` date range. Because bureau_floor_analytics is a
--      nightly rollup that writes *yesterday's* totals at midnight UTC, a
--      1-day window is blank for most of the working day, so the KPI card
--      reads zero even when activity occurred. Widen it to `last_7_days` so
--      the card always reflects recent rollup data. Migration 0178 is already
--      applied and immutable, so this is a separate corrective UPDATE rather
--      than an edit to the original seed.
-- Client impact: additive only. UPDATEs a single seeded widget's date_range
--      preset in place; no schema change. Idempotent: only touches the row if
--      it still carries the original `last_1_days` preset, so re-runs and
--      operator-customised copies are left untouched.

UPDATE bench_widgets
   SET query_config = jsonb_set(
           query_config,
           '{date_range,preset}',
           '"last_7_days"'::jsonb,
           false
       )
 WHERE id = 'a0000000-0000-4000-8000-bbb00000d102'
   AND query_config #>> '{date_range,preset}' = 'last_1_days';
