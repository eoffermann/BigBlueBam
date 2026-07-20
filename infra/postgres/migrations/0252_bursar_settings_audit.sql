-- 0252_bursar_settings_audit.sql
-- Why: Bursar settings-change audit (spec 5.6). EVERY write to bursar_org_settings must leave
--   a before/after diff trail, not just the lexicons - otherwise an org admin can zero a
--   detector weight (e.g. span_verified) and silently suppress findings with no record. The
--   platform activity_log is deliberately NOT reused: its project_id is NOT NULL and Bursar is
--   org-scoped with no project to attribute the change to. This is an org-scoped bursar_*
--   table, so the generated RLS loop from 0251 is re-run here to cover it.
-- Client impact: additive only. One new table + a re-run of the idempotent RLS policy loop; no
--   changes to existing objects.

CREATE TABLE IF NOT EXISTS bursar_settings_audit (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id        uuid NOT NULL REFERENCES users(id),
    -- Array of { field, before, after } objects over the audited setting keys.
    changes         jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bursar_settings_audit_org_created
    ON bursar_settings_audit(organization_id, created_at);

-- Re-run the generated org-isolation RLS loop (identical to 0251) so the new bursar_* table is
-- covered. PG16 has no CREATE POLICY IF NOT EXISTS, so each is DROP POLICY IF EXISTS then
-- CREATE POLICY; the loop is idempotent and re-covers every existing table harmlessly.
DO $$
DECLARE
    tbl text;
    pol text;
BEGIN
    FOR tbl IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name LIKE 'bursar\_%' ESCAPE '\'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

        pol := tbl || '_org_isolation';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, tbl);

        IF tbl = 'bursar_scope_library' THEN
            EXECUTE format(
                'CREATE POLICY %I ON %I FOR ALL '
                || 'USING (organization_id = current_setting(''app.current_org_id'', true)::uuid '
                || 'OR (organization_id IS NULL AND is_global)) '
                || 'WITH CHECK (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
                pol, tbl);
        ELSE
            EXECUTE format(
                'CREATE POLICY %I ON %I FOR ALL '
                || 'USING (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
                pol, tbl);
        END IF;
    END LOOP;
END $$;
