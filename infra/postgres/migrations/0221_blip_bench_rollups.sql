-- 0221_blip_bench_rollups.sql
-- Why: Blip ships two org-scoped Bench rollups instead of pointing Bench at the
--   raw blip_entries firehose (BigBlueBam_Blip_Design_Document.md §13): an hourly
--   entry-volume rollup (with a level dimension) and an hourly numeric-metric
--   rollup whose percentile columns (p50/p95/p99 over elapsed_ms) are precomputed
--   via percentile_cont because Bench's query layer cannot compute percentiles on
--   the fly. Both carry an explicit org_id column so they are tenant-isolated.
-- Client impact: additive only — two materialized views, their UNIQUE indexes,
--   and two bench_materialized_views registry rows. Picked up automatically by
--   the existing bench-mv-refresh worker (no new worker).

-- ============================================================
-- BLIP: Bench rollups (materialized views)
-- ============================================================

-- 1. blip_entries_rollup — hourly entry counts per (app, report_type, level).
--    Wrapped to tolerate blip_entries not yet existing on very old DBs.
DO $$ BEGIN
  EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS blip_entries_rollup';
  EXECUTE '
    CREATE MATERIALIZED VIEW blip_entries_rollup AS
    SELECT
        e.org_id,
        e.tracked_app_id,
        e.report_type,
        date_trunc(''hour'', e.received_at) AS bucket_hour,
        e.level,
        COUNT(*) AS entry_count
    FROM blip_entries e
    GROUP BY e.org_id, e.tracked_app_id, e.report_type,
             date_trunc(''hour'', e.received_at), e.level
  ';
EXCEPTION WHEN undefined_table THEN
  -- blip_entries does not exist yet, skip.
  NULL;
END $$;

-- 2. blip_metric_rollup — hourly numeric aggregates per (app, report_type,
--    field_path). v1 covers field_path = 'elapsed_ms' only (the canonical
--    profiling metric); percentiles are precomputed with percentile_cont.
DO $$ BEGIN
  EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS blip_metric_rollup';
  EXECUTE '
    CREATE MATERIALIZED VIEW blip_metric_rollup AS
    SELECT
        e.org_id,
        e.tracked_app_id,
        e.report_type,
        ''elapsed_ms''::text AS field_path,
        date_trunc(''hour'', e.received_at) AS bucket_hour,
        COUNT(e.elapsed_ms) AS n,
        COALESCE(SUM(e.elapsed_ms), 0) AS sum,
        MIN(e.elapsed_ms) AS min,
        MAX(e.elapsed_ms) AS max,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY e.elapsed_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY e.elapsed_ms) AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY e.elapsed_ms) AS p99
    FROM blip_entries e
    WHERE e.elapsed_ms IS NOT NULL
    GROUP BY e.org_id, e.tracked_app_id, e.report_type,
             date_trunc(''hour'', e.received_at)
  ';
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- ============================================================
-- UNIQUE indexes — required for REFRESH MATERIALIZED VIEW CONCURRENTLY
-- (the bench-mv-refresh worker; cf. 0126). Each row is unique on its full
-- grouping key. Guarded so the migration is a no-op when the MV was skipped
-- above (blip_entries absent).
-- ============================================================
DO $$ BEGIN
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS blip_entries_rollup_uniq
    ON blip_entries_rollup (org_id, tracked_app_id, report_type, bucket_hour, level)';
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$ BEGIN
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS blip_metric_rollup_uniq
    ON blip_metric_rollup (org_id, tracked_app_id, report_type, field_path, bucket_hour)';
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- ============================================================
-- Register both MVs with the Bench refresh sweeper (refresh every 5 minutes).
-- ============================================================
INSERT INTO bench_materialized_views (view_name, description, refresh_cron)
VALUES
  ('blip_entries_rollup', 'Hourly Blip entry counts per (tracked app, report type, level)', '*/5 * * * *'),
  ('blip_metric_rollup', 'Hourly Blip numeric-metric rollup (elapsed_ms p50/p95/p99) per (tracked app, report type)', '*/5 * * * *')
ON CONFLICT (view_name) DO NOTHING;
