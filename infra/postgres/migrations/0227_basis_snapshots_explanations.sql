-- 0227_basis_snapshots_explanations.sql
-- Why: Basis snapshot history (range-partitioned monthly by captured_at, with a
--   wide runway + DEFAULT catch-all like Blip) and the cached deterministic
--   explanation table. See design spec sections 3.1, 3.4, 6.
-- Client impact: additive only. New partitioned table + new table.

-- ──────────────────────────────────────────────────────────────────────
-- basis_metric_snapshots (RANGE-partitioned by captured_at).
-- PK and UNIQUE both include captured_at (the partition key) so they are
-- enforceable on the partitioned parent. Idempotency (ON CONFLICT) relies on
-- captured_at being bucket-aligned in the worker (spec 3.1 / 6).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basis_metric_snapshots (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    metric_id uuid NOT NULL REFERENCES basis_metrics(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    version_id uuid NOT NULL,
    captured_at timestamptz NOT NULL,
    grain varchar(10) NOT NULL,
    value numeric NOT NULL,
    PRIMARY KEY (id, captured_at),
    UNIQUE (metric_id, grain, captured_at, version_id)
) PARTITION BY RANGE (captured_at);

CREATE INDEX IF NOT EXISTS idx_basis_snapshots_metric_grain
    ON basis_metric_snapshots(metric_id, grain, captured_at DESC);

-- Pre-create a runway of monthly partitions (current-1 .. current+12) plus a
-- DEFAULT catch-all, mirroring blip's provisioning. The worker keeps the runway
-- current; DEFAULT is the degradation net (NOT a self-healing guarantee - see
-- the spec's DEFAULT recovery runbook). All CREATE ... IF NOT EXISTS so re-runs
-- are no-ops.
DO $$
DECLARE
    start_month date := (date_trunc('month', now())::date - interval '1 month')::date;
    m date;
    pname text;
BEGIN
    FOR i IN 0..13 LOOP
        m := (start_month + (i || ' months')::interval)::date;
        pname := 'basis_metric_snapshots_' || to_char(m, 'YYYYMM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF basis_metric_snapshots FOR VALUES FROM (%L) TO (%L)',
            pname,
            to_char(m, 'YYYY-MM-DD'),
            to_char((m + interval '1 month')::date, 'YYYY-MM-DD')
        );
    END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS basis_metric_snapshots_default
    PARTITION OF basis_metric_snapshots DEFAULT;

ALTER TABLE basis_metric_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basis_snapshots_org_isolation ON basis_metric_snapshots;
CREATE POLICY basis_snapshots_org_isolation ON basis_metric_snapshots
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ──────────────────────────────────────────────────────────────────────
-- basis_explanations (cached deterministic driver decomposition only)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS basis_explanations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_id uuid NOT NULL REFERENCES basis_metrics(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    version_id uuid NOT NULL,
    cache_key varchar(64) NOT NULL,
    period_a jsonb NOT NULL,
    period_b jsonb NOT NULL,
    dimension varchar(80),
    dimension_class varchar(1),
    delta_abs numeric,
    delta_pct numeric,
    drivers jsonb NOT NULL,
    narrative text,
    model varchar(60),
    computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_explanations_cache_key
    ON basis_explanations(cache_key);
CREATE INDEX IF NOT EXISTS idx_basis_explanations_metric_computed
    ON basis_explanations(metric_id, computed_at DESC);

ALTER TABLE basis_explanations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS basis_explanations_org_isolation ON basis_explanations;
CREATE POLICY basis_explanations_org_isolation ON basis_explanations
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);
