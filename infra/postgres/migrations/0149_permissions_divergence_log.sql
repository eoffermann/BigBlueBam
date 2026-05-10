-- 0149_permissions_divergence_log.sql
-- Why: Wave B telemetry. The dual-read wrapper (apps/api/src/middleware/
--   dual-read.ts) writes one row per request to a sample-route during
--   the soak: legacy gate's decision, new resolver's decision, and the
--   resolver reason. The SuperUser dashboard at /b3/superuser/permissions/
--   divergences groups by (permission_id, route_path) so an operator can
--   spot a single misalignment as one row instead of thousands. After the
--   soak window the table is truncated; durable audit history goes through
--   the existing activity_log instead.
-- Client impact: additive only. The fire-and-forget logger ignores write
--   failures so the table going read-only or hitting a constraint never
--   blocks request processing.

CREATE TABLE IF NOT EXISTS permissions_divergence_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts                  timestamptz NOT NULL DEFAULT now(),
    request_id          text,
    user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
    org_id              uuid REFERENCES organizations(id) ON DELETE SET NULL,
    permission_id       text NOT NULL,
    scope_type          text NOT NULL,
    scope_id            uuid,
    legacy_decision     text NOT NULL CHECK (legacy_decision IN ('allow', 'deny', 'unknown')),
    resolved_decision   text NOT NULL CHECK (resolved_decision IN ('allow', 'deny')),
    resolved_reason     text NOT NULL,
    route_method        text,
    route_path          text,
    -- True when legacy and resolved disagree. Materialized as a column so
    -- the dashboard's "show only divergences" filter stays index-friendly.
    is_divergent        boolean NOT NULL
);

-- Hot-path indexes for the SuperUser dashboard's two main queries:
--   1. List recent divergences (paginated by ts).
--   2. Group divergences by (permission_id, route_path) with counts.
CREATE INDEX IF NOT EXISTS idx_perm_div_ts
    ON permissions_divergence_log (ts DESC)
    WHERE is_divergent;
CREATE INDEX IF NOT EXISTS idx_perm_div_grouping
    ON permissions_divergence_log (permission_id, route_path, route_method)
    WHERE is_divergent;
CREATE INDEX IF NOT EXISTS idx_perm_div_org
    ON permissions_divergence_log (org_id, ts DESC);

COMMENT ON TABLE permissions_divergence_log IS
    'Wave B dual-read telemetry. One row per request to a sample-route during the soak window. Truncated after Wave C flips enforcement. is_divergent column is the predicate the dashboard pages on.';
COMMENT ON COLUMN permissions_divergence_log.legacy_decision IS
    '"allow" if the legacy gate fired and passed; "deny" if it 4xx''d; "unknown" if the route does not have a legacy gate yet (mostly Wave C territory).';

-- RLS: org isolation. SuperUsers see everything via the existing
-- BYPASSRLS posture; org members only see rows for their own org.
ALTER TABLE permissions_divergence_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS permissions_divergence_log_isolation ON permissions_divergence_log;
CREATE POLICY permissions_divergence_log_isolation ON permissions_divergence_log
    USING (
        org_id IS NULL
        OR org_id = current_setting('app.current_org_id', true)::uuid
    );
