-- 0192_bearing_progress_widen.sql
-- Why: migration 0028 created the bearing progress columns as NUMERIC(5,4)
--      (max 9.9999), but the Drizzle schema declares NUMERIC(5,2) and the
--      application writes a 0-100 percentage. Every progress write >= 10%
--      therefore failed with "numeric field overflow" (HTTP 500), so KR/goal
--      progress was stuck at 0% and pnpm db:check flagged the drift.
-- Client impact: none. Widening precision to match Drizzle; existing values
--      (all <= 9.9999) are preserved, just re-typed.

DO $$
BEGIN
  ALTER TABLE bearing_key_results ALTER COLUMN progress TYPE NUMERIC(5,2);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE bearing_goals ALTER COLUMN progress TYPE NUMERIC(5,2);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE bearing_kr_snapshots ALTER COLUMN progress TYPE NUMERIC(5,2);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE bearing_updates ALTER COLUMN progress_at_time TYPE NUMERIC(5,2);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;
