-- create-rls-probe-role.sql (issue #152)
--
-- The CI Postgres service connects as its POSTGRES_USER, a SUPERUSER, and a
-- superuser bypasses row-level security unconditionally. Every
-- apps/*/test/rls-backstop.test.ts probe therefore skipped in CI and the
-- tenant-isolation policies were never checked. This creates a dedicated login
-- role that is BOTH NOSUPERUSER and NOBYPASSRLS, so the policies bind, and the
-- Test workflow hands it to the probes as RLS_PROBE_DATABASE_URL.
--
-- Run after migrations (grants cover the tables that exist at that point).
-- Idempotent. CI-only: never apply this to a real deployment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bbb_rls_probe') THEN
    CREATE ROLE bbb_rls_probe LOGIN PASSWORD 'rls_probe' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE bbb_rls_probe NOSUPERUSER NOBYPASSRLS LOGIN;

GRANT USAGE ON SCHEMA public TO bbb_rls_probe;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bbb_rls_probe;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bbb_rls_probe;
