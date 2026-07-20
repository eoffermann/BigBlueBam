-- 0248_bursar_offers_coverage.sql
-- Why: Bursar bid intake and the coverage/leveling core - vendor offers with per-offer
--   manipulation signals persisted for auditability, the parsed line ledger with an FTS
--   column (UI search only), the line-to-node allocation matches that back the section 4.3
--   caps, the six-verdict coverage decision with the "absent must be human-decided or carry
--   rejected candidates" invariant and NO 'agent' decider, durable per-window leveling
--   results, the four comparable totals, and the leveling-run checkpoint with a 3-D resume
--   cursor and heartbeat/claim lease. See
--   docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md sections 6.1, 4, 10.
-- Client impact: additive only. New tables; no changes to existing objects.
--
-- No-partitioning decision (spec 18.8): bursar_offer_lines is the highest-row table but at
-- the 2-50 seat target it stays well inside a single heap; it ships UNPARTITIONED in v1,
-- exactly as burn_work_items does (0239_burn_core.sql). Partitioning on a synthetic month
-- key is deferred to v1.1 and recorded here so a later reader does not assume it was missed.

-- ──────────────────────────────────────────────────────────────────────
-- bursar_offers. One vendor submission against a request. parse_quality, blanket_suspected,
-- unsubpriced_mandatory_count, and evidence_concentration are computed per offer and
-- PERSISTED (spec 4.3, 6.1) so a leveling verdict is auditable after the fact. sealed_until
-- backs the shared seal predicate (spec 5.6). bin_asset_version_id pins the parsed bytes.
-- Unique (organization_id, request_id, vendor_id, source_doc_hash): the same document from
-- the same vendor for the same request is one offer.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id uuid NOT NULL REFERENCES bursar_requests(id) ON DELETE CASCADE,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    label varchar(512),
    status varchar(16) NOT NULL DEFAULT 'received',
    parse_quality numeric(5,4),
    injection_suspected boolean NOT NULL DEFAULT false,
    injection_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
    blanket_suspected boolean NOT NULL DEFAULT false,
    unsubpriced_mandatory_count integer NOT NULL DEFAULT 0,
    evidence_concentration numeric(5,4),
    sealed_until timestamptz,
    source_format varchar(24),
    bin_asset_id uuid,
    bin_asset_version_id uuid,
    source_doc_hash varchar(64) NOT NULL DEFAULT '',
    uncompressed_bytes bigint,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_offers_dedup
    ON bursar_offers(organization_id, request_id, vendor_id, source_doc_hash);
CREATE INDEX IF NOT EXISTS idx_bursar_offers_org_request
    ON bursar_offers(organization_id, request_id);
CREATE INDEX IF NOT EXISTS idx_bursar_offers_org_vendor
    ON bursar_offers(organization_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bursar_offers_sealed
    ON bursar_offers(organization_id, sealed_until) WHERE sealed_until IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bursar_offers_updated_at ON bursar_offers;
CREATE TRIGGER trg_bursar_offers_updated_at
    BEFORE UPDATE ON bursar_offers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_leveling_runs. The engine checkpoint. Created before coverage so the coverage
-- leveling_run_id FK is inline. last_processed_offer_index / node_index / window_index are
-- the 3-D resume cursor (spec 6.1): a bounded slice under a lease advances the cursor, so a
-- reclaimed run resumes rather than restarts. heartbeat_at + claimed_by are the lease.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_leveling_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id uuid NOT NULL REFERENCES bursar_requests(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'running',
    last_processed_offer_index integer NOT NULL DEFAULT -1,
    last_processed_node_index integer NOT NULL DEFAULT -1,
    last_processed_window_index integer NOT NULL DEFAULT -1,
    offer_count integer,
    node_count integer,
    llm_calls_used integer NOT NULL DEFAULT 0,
    coverage_written integer NOT NULL DEFAULT 0,
    claimed_by varchar(64),
    heartbeat_at timestamptz,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bursar_leveling_runs
        ADD CONSTRAINT bursar_leveling_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'blocked', 'rejected_limits'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_leveling_runs_request
    ON bursar_leveling_runs(organization_id, request_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bursar_leveling_runs_claimed
    ON bursar_leveling_runs(organization_id, status, heartbeat_at) WHERE status = 'running';

-- ──────────────────────────────────────────────────────────────────────
-- bursar_offer_lines. The parsed line ledger. raw_text is bounded to 4,000 chars (spec 6.1).
-- char_start/end + page anchor a line back to the source for span verification. line_role
-- distinguishes base / option / allowance / exclusion. search_tsv is a GENERATED tsvector
-- for UI search ONLY; there is deliberately NO trigram index (it died with retrieval).
-- Unique (organization_id, offer_id, ordinal).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_offer_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    offer_id uuid NOT NULL REFERENCES bursar_offers(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    raw_text varchar(4000) NOT NULL DEFAULT '',
    char_start integer,
    char_end integer,
    page integer,
    quantity numeric(18,4),
    unit varchar(32),
    unit_price_minor bigint,
    extended_minor bigint,
    currency varchar(3),
    line_role varchar(24),
    blanket_claim boolean NOT NULL DEFAULT false,
    exclusion_hit boolean NOT NULL DEFAULT false,
    parsed_by varchar(24),
    search_tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(raw_text, ''))
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_offer_lines_ordinal
    ON bursar_offer_lines(organization_id, offer_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_lines_offer
    ON bursar_offer_lines(organization_id, offer_id);
-- FTS index for UI search only. No trigram index by design (spec 6.1).
CREATE INDEX IF NOT EXISTS idx_bursar_offer_lines_search
    ON bursar_offer_lines USING gin(search_tsv);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_offer_coverage. The per-(offer, node) adjudication. verdict is one of exactly six
-- values. decided_by is deterministic / llm / human - NO 'agent' value in v1 (spec 6.1):
-- there is no agent adjudication path, and adding the value with no gate would be an
-- invitation to write a verdict that skipped every predicate and cap. The absent CHECK
-- forces an 'absent' verdict to be either human-decided or backed by rejected candidates, so
-- a bare absent can never be auto-published without evidence. Unique (organization_id,
-- offer_id, scope_node_id). subsumed_by_coverage_id is a guarded self-FK (window merge).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_offer_coverage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    offer_id uuid NOT NULL REFERENCES bursar_offers(id) ON DELETE CASCADE,
    scope_node_id uuid NOT NULL REFERENCES bursar_scope_nodes(id) ON DELETE RESTRICT,
    leveling_run_id uuid REFERENCES bursar_leveling_runs(id) ON DELETE SET NULL,
    verdict varchar(24) NOT NULL,
    decided_by varchar(16) NOT NULL DEFAULT 'deterministic',
    matched_line_ids uuid[] NOT NULL DEFAULT '{}',
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    rejected_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    node_term_overlap numeric(5,4),
    classifier_confidence numeric(5,4),
    composite_confidence numeric(5,4),
    confidence_band varchar(16),
    review_status varchar(16) NOT NULL DEFAULT 'pending_review',
    withheld_reason varchar(24),
    provisional boolean NOT NULL DEFAULT false,
    blanket_suspected boolean NOT NULL DEFAULT false,
    window_coverage numeric(5,4),
    subsumed_by_coverage_id uuid,
    derived_covered boolean NOT NULL DEFAULT false,
    delta_kind varchar(24),
    delta_quantity numeric(18,4),
    delta_unit varchar(32),
    delta_amount_minor bigint,
    priced_amount_minor bigint,
    overridden_by uuid REFERENCES users(id) ON DELETE SET NULL,
    overridden_at timestamptz,
    overridden_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_offer_coverage
        ADD CONSTRAINT bursar_offer_coverage_verdict_check
        CHECK (verdict IN ('covered', 'partial', 'excluded_explicit', 'absent', 'ambiguous', 'not_applicable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- decided_by has NO 'agent' value in v1 (spec 6.1). Do not add one without the write path,
-- gate, and permission that section 24 records as the reintroduction conditions.
DO $$
BEGIN
    ALTER TABLE bursar_offer_coverage
        ADD CONSTRAINT bursar_offer_coverage_decided_by_check
        CHECK (decided_by IN ('deterministic', 'llm', 'human'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An 'absent' verdict must be human-decided OR carry rejected candidates: a bare absent with
-- no evidence can never be auto-published (spec 6.1).
DO $$
BEGIN
    ALTER TABLE bursar_offer_coverage
        ADD CONSTRAINT bursar_offer_coverage_absent_check
        CHECK (verdict <> 'absent' OR decided_by = 'human' OR jsonb_array_length(rejected_candidates) > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bursar_offer_coverage
        ADD CONSTRAINT bursar_offer_coverage_subsumed_fk
        FOREIGN KEY (subsumed_by_coverage_id) REFERENCES bursar_offer_coverage(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_offer_coverage_unique
    ON bursar_offer_coverage(organization_id, offer_id, scope_node_id);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_coverage_offer
    ON bursar_offer_coverage(organization_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_coverage_node
    ON bursar_offer_coverage(organization_id, scope_node_id);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_coverage_verdict
    ON bursar_offer_coverage(organization_id, offer_id, verdict);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_coverage_run
    ON bursar_offer_coverage(leveling_run_id);

DROP TRIGGER IF EXISTS trg_bursar_offer_coverage_updated_at ON bursar_offer_coverage;
CREATE TRIGGER trg_bursar_offer_coverage_updated_at
    BEFORE UPDATE ON bursar_offer_coverage
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_line_node_matches. Which offer lines allocate to which node, and by how much. Both
-- section 4.3 caps are computed from this table. offer_line_id CASCADEs; scope_node_id
-- RESTRICTs (a live match blocks a node hard-delete, reinforcing soft-archive). coverage_id
-- links the match to its adjudication. allocation_weight is numeric(6,5); weights per line
-- sum to 1.0. Unique (organization_id, offer_line_id, scope_node_id).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_line_node_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    offer_line_id uuid NOT NULL REFERENCES bursar_offer_lines(id) ON DELETE CASCADE,
    scope_node_id uuid NOT NULL REFERENCES bursar_scope_nodes(id) ON DELETE RESTRICT,
    coverage_id uuid REFERENCES bursar_offer_coverage(id) ON DELETE SET NULL,
    allocation_weight numeric(6,5) NOT NULL DEFAULT 1.00000,
    allocation_method varchar(24),
    match_method varchar(24),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_line_node_matches_unique
    ON bursar_line_node_matches(organization_id, offer_line_id, scope_node_id);
CREATE INDEX IF NOT EXISTS idx_bursar_line_node_matches_line
    ON bursar_line_node_matches(organization_id, offer_line_id);
CREATE INDEX IF NOT EXISTS idx_bursar_line_node_matches_node
    ON bursar_line_node_matches(organization_id, scope_node_id);
CREATE INDEX IF NOT EXISTS idx_bursar_line_node_matches_coverage
    ON bursar_line_node_matches(coverage_id);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_leveling_window_results. Durable per-window verdicts (spec 6.1) so a resumed
-- leveling run does not recompute a settled window. Unique on all five of
-- (leveling_run_id, offer_id, scope_node_id, window_index, verdict).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_leveling_window_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    leveling_run_id uuid NOT NULL REFERENCES bursar_leveling_runs(id) ON DELETE CASCADE,
    offer_id uuid NOT NULL REFERENCES bursar_offers(id) ON DELETE CASCADE,
    scope_node_id uuid NOT NULL REFERENCES bursar_scope_nodes(id) ON DELETE RESTRICT,
    window_index integer NOT NULL,
    verdict varchar(24) NOT NULL,
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_leveling_window_results_unique
    ON bursar_leveling_window_results(leveling_run_id, offer_id, scope_node_id, window_index, verdict);
CREATE INDEX IF NOT EXISTS idx_bursar_leveling_window_results_run
    ON bursar_leveling_window_results(organization_id, leveling_run_id);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_offer_totals. The four comparable totals per offer (spec 10). total_kind is one of
-- stated / base_only / gap_adjusted / should_have_supplement. renderable = false when gaps
-- cannot be valued above rung 3, and the UI shows the unpriced-gap count instead of a
-- fabricated number. provenance records the valuation ladder rung used.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_offer_totals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    offer_id uuid NOT NULL REFERENCES bursar_offers(id) ON DELETE CASCADE,
    total_kind varchar(24) NOT NULL,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    amount_minor bigint,
    estimated boolean NOT NULL DEFAULT false,
    unvalued_gap_count integer NOT NULL DEFAULT 0,
    renderable boolean NOT NULL DEFAULT true,
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_offer_totals
        ADD CONSTRAINT bursar_offer_totals_total_kind_check
        CHECK (total_kind IN ('stated', 'base_only', 'gap_adjusted', 'should_have_supplement'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_offer_totals_unique
    ON bursar_offer_totals(organization_id, offer_id, total_kind);
CREATE INDEX IF NOT EXISTS idx_bursar_offer_totals_offer
    ON bursar_offer_totals(organization_id, offer_id);
