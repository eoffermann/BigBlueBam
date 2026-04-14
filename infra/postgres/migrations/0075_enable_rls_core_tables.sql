-- 0075_enable_rls_core_tables.sql
-- Why: enforce tenant isolation at the database layer so a handler that
-- forgets the org_id filter returns zero rows instead of leaking across
-- tenants. Defense in depth behind the existing handler-filter strategy.
-- Client impact: additive only. Every existing query keeps working as
-- long as either (a) the application sets app.current_org_id per request
-- via the new withRls plugin, or (b) the Bam API role has BYPASSRLS set
-- while BBB_RLS_ENFORCE=0 (the default during Wave 1). See DECISIONS.md
-- D-016 for the bypass-role rollout strategy.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- Pre-flight: backfill core-table org_id columns that were added in
-- earlier migrations but never populated. RLS policies below assume
-- every row in the four org-scoped tables carries a usable org_id.
-- Each step is idempotent.
-- ─────────────────────────────────────────────────────────────────────

-- tasks.org_id was added nullable by 0078_reconcile_bam_bearing_drift.sql.
-- Backfill from projects, then tighten to NOT NULL once all rows have a
-- value. If any row is still NULL after the backfill (orphaned task), we
-- leave the column nullable and RAISE WARNING instead of failing.
UPDATE tasks t
   SET org_id = p.org_id
  FROM projects p
 WHERE p.id = t.project_id
   AND t.org_id IS NULL;

DO $$
DECLARE
    unfilled bigint;
BEGIN
    SELECT COUNT(*) INTO unfilled FROM tasks WHERE org_id IS NULL;
    IF unfilled = 0 THEN
        ALTER TABLE tasks ALTER COLUMN org_id SET NOT NULL;
    ELSE
        RAISE WARNING
            'tasks.org_id backfill left % row(s) NULL; leaving column nullable. Investigate orphaned tasks and rerun SET NOT NULL manually.',
            unfilled;
    END IF;
END $$;

-- sprints.org_id: add, backfill, index. The plan template keeps this in
-- a DO block so re-running the migration is a no-op once the column is
-- in place. Foreign-key creation is guarded against duplicate_object.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sprints' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE sprints ADD COLUMN org_id uuid; -- noqa: add-column-if-not-exists
    UPDATE sprints s
       SET org_id = p.org_id
      FROM projects p
     WHERE p.id = s.project_id;

    -- Only tighten if fully populated. On an empty sprints table or a
    -- clean backfill this runs; on a partial state we skip and warn.
    IF NOT EXISTS (SELECT 1 FROM sprints WHERE org_id IS NULL) THEN
      ALTER TABLE sprints ALTER COLUMN org_id SET NOT NULL;
    ELSE
      RAISE WARNING 'sprints.org_id backfill incomplete; column left nullable.';
    END IF;

    BEGIN
      ALTER TABLE sprints
        ADD CONSTRAINT sprints_org_id_fk
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sprints_org_id_idx ON sprints(org_id);

-- ─────────────────────────────────────────────────────────────────────
-- Enable RLS and install the tenant-isolation policy on each of the
-- six core tables. FORCE ROW LEVEL SECURITY makes policies apply even
-- to the table owner, since the Bam service role owns the schema.
-- The `current_setting('app.current_org_id', true)` form returns NULL
-- when the variable is unset (true == missing_ok), and `= NULL` is
-- false, so an unset variable denies every row. That is intentional:
-- unconverted handlers must either use withRls OR run as a role with
-- BYPASSRLS. See DECISIONS.md D-016.
-- ─────────────────────────────────────────────────────────────────────

-- organizations: scoped by its own id column.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_rls_policy ON organizations;
CREATE POLICY organizations_rls_policy ON organizations
  USING (id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);

-- projects: scoped by org_id.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_rls_policy ON projects;
CREATE POLICY projects_rls_policy ON projects
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- tasks: scoped by the denormalized org_id column added in 0078.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_rls_policy ON tasks;
CREATE POLICY tasks_rls_policy ON tasks
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- sprints: scoped by the org_id column installed above.
ALTER TABLE sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sprints_rls_policy ON sprints;
CREATE POLICY sprints_rls_policy ON sprints
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- tickets: the table has no org_id column of its own; scope through
-- project_id -> org_id. Tickets without a project (legacy rows) are
-- denied by the subquery, which is the safe fail mode.
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tickets_rls_policy ON tickets;
CREATE POLICY tickets_rls_policy ON tickets
  USING (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

-- activity_log: same project_id -> org_id indirection. Avoiding a
-- column add on the hot append-only log table.
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_log_rls_policy ON activity_log;
CREATE POLICY activity_log_rls_policy ON activity_log
  USING (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

COMMIT;
