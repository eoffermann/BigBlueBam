-- 0226_basis_core.sql
-- Why: Basis (governed metric layer) core tables - metric catalog, immutable
--   version lineage, and per-org settings (retention window + cache TTL +
--   default decomposition dimension). See
--   docs/brainstorming/2026_07_17_12_58_APP_DESIGN_basis.md sections 3.1, 3.4.
-- Client impact: additive only. New tables, no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- basis_metrics
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basis_metrics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug varchar(80) NOT NULL,
    name varchar(160) NOT NULL,
    description text,
    unit varchar(20) NOT NULL,
    favorable_direction varchar(8) NOT NULL DEFAULT 'up',
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    certification varchar(12) NOT NULL DEFAULT 'draft',
    current_version_id uuid,
    related_apps jsonb NOT NULL DEFAULT '[]'::jsonb,
    target jsonb,
    resolve_status varchar(12) NOT NULL DEFAULT 'ok',
    resolve_failed_at timestamptz,
    last_breach_at timestamptz,
    last_breach_direction varchar(8),
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_metrics_org_slug
    ON basis_metrics(organization_id, slug);
CREATE INDEX IF NOT EXISTS idx_basis_metrics_org_cert
    ON basis_metrics(organization_id, certification);
CREATE INDEX IF NOT EXISTS idx_basis_metrics_org_owner
    ON basis_metrics(organization_id, owner_id);

-- ──────────────────────────────────────────────────────────────────────
-- basis_metric_versions (immutable lineage)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basis_metric_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_id uuid NOT NULL REFERENCES basis_metrics(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    definition jsonb NOT NULL,
    lineage jsonb NOT NULL,
    change_note text,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_versions_metric_number
    ON basis_metric_versions(metric_id, version_number);
CREATE INDEX IF NOT EXISTS idx_basis_versions_org_created
    ON basis_metric_versions(organization_id, created_at DESC);

-- FK basis_metrics.current_version_id -> basis_metric_versions (declared after
-- both tables exist to avoid a circular create order). Guarded / idempotent.
DO $$ BEGIN
    ALTER TABLE basis_metrics
        ADD CONSTRAINT fk_basis_metrics_current_version
        FOREIGN KEY (current_version_id) REFERENCES basis_metric_versions(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- basis_org_settings (per-org; retention window + cache TTL + default dim)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basis_org_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    snapshot_max_age_days integer,          -- null = unbounded
    explanation_cache_ttl_seconds integer,
    default_dimension varchar(80),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_org_settings_org
    ON basis_org_settings(organization_id);

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via app.current_org_id GUC (pattern from
-- 0116_rls_foundation.sql / 0132_entity_links.sql). Advisory until
-- BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE basis_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basis_metrics_org_isolation ON basis_metrics;
CREATE POLICY basis_metrics_org_isolation ON basis_metrics
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE basis_metric_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basis_versions_org_isolation ON basis_metric_versions;
CREATE POLICY basis_versions_org_isolation ON basis_metric_versions
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE basis_org_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basis_org_settings_org_isolation ON basis_org_settings;
CREATE POLICY basis_org_settings_org_isolation ON basis_org_settings
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);
