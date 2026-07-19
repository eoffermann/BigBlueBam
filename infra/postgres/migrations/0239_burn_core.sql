-- 0239_burn_core.sql
-- Why: Burn (contract consumption, unscoped-work detection, and the pre-transaction gate)
--   core tables - priced engagements with amendment/restatement chains, the project link
--   that IS Burn's scope predicate, the deliverable ledger with clause citations and priced
--   envelopes, the highest-churn work-item stream, the attribution decision, the extraction
--   audit, and the durable claimed event inbox. Also seeds the "Burn System"
--   service-account user that autonomous worker actions and direct agent_proposals inserts
--   (actor_id NOT NULL) are attributed to, as 0234_bulwark_core.sql does for Bulwark. See
--   docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md sections 3.1, 3.4, 2.3, 2.4.
-- Client impact: additive only. New tables + one sentinel service user; no changes to
--   existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- burn_engagements. chain_root_id is the denormalized chain root; ALL envelope math,
-- rollups, financials, and gate evaluation resolve over it rather than a single row.
-- Both self-FKs (amends_engagement_id, supersedes_engagement_id) are added below in
-- guarded DO $$ blocks. bin_asset_id / account_id / braid_profile_id / bill_client_id are
-- dotted cross-app refs with NO cross-schema FK (the entity_links convention).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_engagements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title varchar(512) NOT NULL,
    engagement_kind varchar(32) NOT NULL DEFAULT 'sow',
    amends_engagement_id uuid,
    supersedes_engagement_id uuid,
    chain_root_id uuid NOT NULL,
    contract_value bigint,
    contract_value_delta bigint,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    envelope_basis varchar(16) NOT NULL DEFAULT 'fixed',
    period_length_days integer,
    budget_hours numeric(10,2),
    bin_asset_id uuid,
    account_type varchar(32),
    account_id uuid,
    braid_profile_id uuid,
    bill_client_id uuid,
    start_date date,
    end_date date,
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    status varchar(16) NOT NULL DEFAULT 'active',
    extraction_status varchar(16) NOT NULL DEFAULT 'pending',
    source_doc_hash varchar(64),
    extracted_at timestamptz,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- envelope_basis drives revenue_basis (spec 1.2.1) and the margin formula branches on it,
-- so an out-of-enum value silently mislabels money. period_length_days is required for a
-- retainer because the per-period boundary cannot be computed without it.
DO $$
BEGIN
    ALTER TABLE burn_engagements
        ADD CONSTRAINT burn_engagements_envelope_basis_check
        CHECK (envelope_basis IN ('fixed', 'time_and_materials', 'retainer', 'not_to_exceed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagements
        ADD CONSTRAINT burn_engagements_retainer_period_check
        CHECK (envelope_basis <> 'retainer' OR period_length_days IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagements
        ADD CONSTRAINT burn_engagements_status_check
        CHECK (status IN ('draft', 'extracting', 'active', 'superseded', 'closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Self-FKs. ON DELETE RESTRICT on both: a live amendment or restatement must block an
-- accidental delete of the row it depends on.
DO $$
BEGIN
    ALTER TABLE burn_engagements
        ADD CONSTRAINT burn_engagements_amends_fk
        FOREIGN KEY (amends_engagement_id) REFERENCES burn_engagements(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagements
        ADD CONSTRAINT burn_engagements_supersedes_fk
        FOREIGN KEY (supersedes_engagement_id) REFERENCES burn_engagements(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_burn_engagements_org_status
    ON burn_engagements(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_org_chain
    ON burn_engagements(organization_id, chain_root_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_org_account
    ON burn_engagements(organization_id, account_type, account_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_org_braid
    ON burn_engagements(organization_id, braid_profile_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_org_bin_asset
    ON burn_engagements(organization_id, bin_asset_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_amends
    ON burn_engagements(amends_engagement_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagements_supersedes
    ON burn_engagements(supersedes_engagement_id);

-- ──────────────────────────────────────────────────────────────────────
-- burn_engagement_projects. This join table IS Burn's project-scope predicate (spec 2.4
-- point 6). There is NO null/empty fallback, so a chain with zero linked projects is
-- read_all-only by construction, flagged `unlinked`, and incapable of producing a deny.
-- project_id CASCADEs: a deleted project takes its link rows with it.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_engagement_projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    engagement_id uuid NOT NULL REFERENCES burn_engagements(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_engagement_projects_unique
    ON burn_engagement_projects(organization_id, engagement_id, project_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagement_projects_org_project
    ON burn_engagement_projects(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagement_projects_engagement
    ON burn_engagement_projects(engagement_id);

-- ──────────────────────────────────────────────────────────────────────
-- burn_extraction_runs. Created before burn_deliverables so the deliverables
-- extraction_run_id FK can be inline. Never purged (audit). A retry resumes at
-- last_processed_chunk + 1, which is what makes the "no HTTP inside a lock-holding
-- transaction" rule survivable.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_extraction_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    engagement_id uuid NOT NULL REFERENCES burn_engagements(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'running',
    chunk_count integer,
    last_processed_chunk integer NOT NULL DEFAULT -1,
    source_doc_hash varchar(64),
    doc_bytes bigint,
    doc_pages integer,
    deliverables_extracted integer NOT NULL DEFAULT 0,
    low_confidence_count integer NOT NULL DEFAULT 0,
    provider_id uuid,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_burn_extraction_runs_engagement
    ON burn_extraction_runs(organization_id, engagement_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_extraction_runs_status
    ON burn_extraction_runs(status);

-- ──────────────────────────────────────────────────────────────────────
-- burn_deliverables. One priced line of what was actually sold.
--
-- envelope_amount NULL means UNPRICED: hours only, can never deny.
-- is_active has EXACTLY ONE WRITER, POST /v1/deliverables/:id/confirm-envelope under
-- burn.envelope.confirm. That single-writer property is a security boundary, which is why
-- an amendment deliverable gets its OWN activation state (delta_confirmed_by/at) instead
-- of a second code path flipping is_active on proposal.decided.
--
-- search_tsv is null-safe with an explicit 'english' regconfig: a bare concatenation over
-- nullable columns yields NULL and guts recall on the shipped path.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_deliverables (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    engagement_id uuid NOT NULL REFERENCES burn_engagements(id) ON DELETE CASCADE,
    dedup_key varchar(64) NOT NULL,
    clause_ref varchar(64),
    title varchar(512) NOT NULL,
    description text,
    deliverable_kind varchar(32) NOT NULL DEFAULT 'work_product',
    amends_deliverable_id uuid,
    envelope_amount_delta bigint,
    envelope_amount bigint,
    envelope_hours numeric(10,2),
    envelope_source varchar(24) NOT NULL DEFAULT 'proposed',
    lifecycle_status varchar(16) NOT NULL DEFAULT 'open',
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    due_date date,
    confidence numeric(5,2),
    review_status varchar(16) NOT NULL DEFAULT 'pending_review',
    is_active boolean NOT NULL DEFAULT false,
    delta_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    delta_confirmed_at timestamptz,
    supersedes_deliverable_id uuid,
    search_tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(title, '') || ' ' ||
            coalesce(description, '') || ' ' ||
            coalesce(cited_span->>'quote', ''))
    ) STORED,
    qdrant_point_id uuid,
    qdrant_synced_at timestamptz,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    envelope_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    envelope_confirmed_at timestamptz,
    extraction_run_id uuid REFERENCES burn_extraction_runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_envelope_source_check
        CHECK (envelope_source IN ('proposed', 'human', 'stated', 'unpriced'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_lifecycle_status_check
        CHECK (lifecycle_status IN ('open', 'complete', 'closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_review_status_check
        CHECK (review_status IN ('pending_review', 'confirmed', 'rejected', 'superseded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An amendment deliverable is a pure envelope-delta carrier and is NEVER an attribution
-- target (R3-D2). It must never be activated through is_active: its activation state is
-- delta_confirmed_at. Enforcing that here means a bug in the service layer cannot produce
-- a row that splits consumption off the base deliverable.
DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_amendment_not_active_check
        CHECK (amends_deliverable_id IS NULL OR is_active = false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_amends_fk
        FOREIGN KEY (amends_deliverable_id) REFERENCES burn_deliverables(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_deliverables
        ADD CONSTRAINT burn_deliverables_supersedes_fk
        FOREIGN KEY (supersedes_deliverable_id) REFERENCES burn_deliverables(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_deliverables_dedup
    ON burn_deliverables(organization_id, engagement_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_org_engagement
    ON burn_deliverables(organization_id, engagement_id);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_org_review
    ON burn_deliverables(organization_id, review_status);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_org_active
    ON burn_deliverables(organization_id, is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_org_lifecycle
    ON burn_deliverables(organization_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_org_due
    ON burn_deliverables(organization_id, due_date);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_amends
    ON burn_deliverables(amends_deliverable_id);
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_search
    ON burn_deliverables USING gin(search_tsv);
-- Trigram on title only. A member-tier q filter matches title through THIS index; the
-- FTS index above is reserved for internal candidate assembly and read_all callers,
-- because a floored field that stays searchable is not floored (R3-S4).
CREATE INDEX IF NOT EXISTS idx_burn_deliverables_title_trgm
    ON burn_deliverables USING gin(title gin_trgm_ops);

-- ──────────────────────────────────────────────────────────────────────
-- burn_work_items. Highest-churn table. First candidate for monthly partitioning on
-- occurred_at (per 0220_blip_entries_partitioned.sql); v1 ships unpartitioned at the
-- 2-50 seat target.
--
-- source_epoch is a PLAIN COMPARED COLUMN and is deliberately NOT part of any unique key
-- (R2-T4): including it is what produced the 23505-on-revert bug, where minutes
-- 60 -> 90 -> 60 collides with the row excluded on the first change. The live-row partial
-- unique index below is the replacement.
--
-- reconcile_until is anchored on ingested_at, not occurred_at (R2-T3), so a timesheet
-- dated 120 days ago but created today is still observed for edits and deletes.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_work_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type varchar(32) NOT NULL,
    source_id uuid NOT NULL,
    source_epoch varchar(64) NOT NULL,
    classification_epoch varchar(64) NOT NULL,
    cost_epoch varchar(64) NOT NULL,
    valuation_epoch varchar(64),
    valued_at timestamptz,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    reconcile_until timestamptz NOT NULL,
    title_snapshot varchar(512),
    text_snapshot text,
    minutes integer,
    billable_amount bigint,
    cost_amount bigint,
    currency varchar(3),
    valuation_basis varchar(16) NOT NULL DEFAULT 'none',
    unrated_reason varchar(32),
    bill_rate_id uuid,
    burn_cost_rate_id uuid,
    attribution_state varchar(24) NOT NULL DEFAULT 'pending',
    exclusion_reason varchar(32),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_work_items
        ADD CONSTRAINT burn_work_items_attribution_state_check
        CHECK (attribution_state IN (
            'pending', 'pending_attribution', 'attributed', 'pending_review',
            'unscoped', 'excluded_non_billable', 'excluded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_work_items
        ADD CONSTRAINT burn_work_items_valuation_basis_check
        CHECK (valuation_basis IN ('rate', 'expense', 'invoice', 'none', 'unrated', 'no_cost_rate'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- THE live-row constraint. One live row per source record; excluded rows are tombstones
-- and are exempt, which is what lets a revert re-insert without a 23505.
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_work_items_live
    ON burn_work_items(organization_id, source_type, source_id)
    WHERE attribution_state <> 'excluded';

CREATE INDEX IF NOT EXISTS idx_burn_work_items_org_state_occurred
    ON burn_work_items(organization_id, attribution_state, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_work_items_org_project_occurred
    ON burn_work_items(organization_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_burn_work_items_org_source
    ON burn_work_items(organization_id, source_type, source_id);
-- A partial index WHERE reconcile_until > now() is not immutable-safe, so this is plain.
CREATE INDEX IF NOT EXISTS idx_burn_work_items_org_reconcile
    ON burn_work_items(organization_id, reconcile_until);
CREATE INDEX IF NOT EXISTS idx_burn_work_items_org_valued
    ON burn_work_items(organization_id, valued_at);

-- ──────────────────────────────────────────────────────────────────────
-- burn_attributions. Carries the classification decision and NO MONEY (R3-T2). Every
-- consumption figure joins burn_work_items for amounts; this table answers only "which
-- deliverable does this belong to". deliverable_id is ON DELETE RESTRICT so a live
-- classification blocks an accidental deliverable delete.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_attributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_item_id uuid NOT NULL REFERENCES burn_work_items(id) ON DELETE CASCADE,
    deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE RESTRICT,
    engagement_id uuid REFERENCES burn_engagements(id) ON DELETE SET NULL,
    chain_root_id uuid,
    state varchar(24) NOT NULL,
    unscoped_reason varchar(32),
    non_billable_reason varchar(24),
    confidence numeric(5,2),
    method varchar(24) NOT NULL,
    candidate_set jsonb NOT NULL DEFAULT '[]'::jsonb,
    rationale text,
    superseded_at timestamptz,
    superseded_by uuid,
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    vocabulary_version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_attributions
        ADD CONSTRAINT burn_attributions_state_check
        CHECK (state IN (
            'auto_attributed', 'confirmed', 'pending_review', 'unscoped',
            'excluded_non_billable', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_attributions
        ADD CONSTRAINT burn_attributions_method_check
        CHECK (method IN ('rule', 'structural', 'precedent', 'lexical', 'llm', 'human', 'inherited'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_attributions
        ADD CONSTRAINT burn_attributions_superseded_by_fk
        FOREIGN KEY (superseded_by) REFERENCES burn_attributions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- At most one live attribution per work item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_attributions_live
    ON burn_attributions(organization_id, work_item_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_burn_attributions_live_deliverable
    ON burn_attributions(organization_id, deliverable_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_burn_attributions_live_chain_state
    ON burn_attributions(organization_id, chain_root_id, state) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_burn_attributions_org_state_created
    ON burn_attributions(organization_id, state, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────
-- burn_ingest_events. Unlike bulwark_ingest_events (0234:123-136) this table has claim
-- columns with a lease, because Burn's batch is BOTH event-driven and scheduled so two
-- drains can legitimately observe the same pending row. claimed_at is heartbeated by the
-- holding drain, so the reaper reclaims only genuinely cold rows.
--
-- The reaper scan index is PER ORG, not global (spec 2.4 point 14): under
-- BBB_RLS_ENFORCE=1 a global scan on (status, claimed_at) with no GUC set returns zero
-- rows, so expired claims would never be released and attribution would permanently stop
-- draining for any org whose worker died mid-claim.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_ingest_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_idempotency_key varchar(128) NOT NULL,
    bolt_event_id uuid,
    source varchar(48) NOT NULL,
    event_type varchar(96) NOT NULL,
    scope_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz,
    logged_at timestamptz,
    status varchar(12) NOT NULL DEFAULT 'pending',
    claimed_by varchar(64),
    claimed_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE burn_ingest_events
        ADD CONSTRAINT burn_ingest_events_status_check
        CHECK (status IN ('pending', 'claimed', 'processed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_ingest_events_idem
    ON burn_ingest_events(organization_id, source_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_burn_ingest_events_pending
    ON burn_ingest_events(organization_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_burn_ingest_events_claimed
    ON burn_ingest_events(organization_id, status, claimed_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_burn_ingest_events_source_type
    ON burn_ingest_events(source, event_type);

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via the app.current_org_id GUC (pattern from 0234_bulwark_core.sql /
-- 0230_braid_core.sql / 0226_basis_core.sql). Advisory until BBB_RLS_ENFORCE=1. burn-api
-- binds the GUC per request inside a transaction (see apps/burn-api/src/plugins/rls.ts),
-- rather than the standalone set_config the four earlier plugins use, which is discarded
-- immediately on a pooled connection.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE burn_engagements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_engagements_org_isolation ON burn_engagements;
CREATE POLICY burn_engagements_org_isolation ON burn_engagements
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_engagement_projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_engagement_projects_org_isolation ON burn_engagement_projects;
CREATE POLICY burn_engagement_projects_org_isolation ON burn_engagement_projects
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_extraction_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_extraction_runs_org_isolation ON burn_extraction_runs;
CREATE POLICY burn_extraction_runs_org_isolation ON burn_extraction_runs
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_deliverables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_deliverables_org_isolation ON burn_deliverables;
CREATE POLICY burn_deliverables_org_isolation ON burn_deliverables
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_work_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_work_items_org_isolation ON burn_work_items;
CREATE POLICY burn_work_items_org_isolation ON burn_work_items
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_attributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_attributions_org_isolation ON burn_attributions;
CREATE POLICY burn_attributions_org_isolation ON burn_attributions
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_ingest_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_ingest_events_org_isolation ON burn_ingest_events;
CREATE POLICY burn_ingest_events_org_isolation ON burn_ingest_events
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ──────────────────────────────────────────────────────────────────────
-- Burn System service-account user. Hosted in the shared sentinel org
-- (0014_helpdesk_system_user.sql). Never logs in (password_hash='!'); exists so autonomous
-- worker actions and direct agent_proposals inserts have a valid actor. The users table has
-- no 'role' column; kind='service' marks it (mirrors the 0230 braid / 0234 bulwark seeds).
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-000000000002',
    'system-burn@bigbluebam.internal',
    'Burn System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-000000000002',
    'system-burn@bigbluebam.internal',
    'Burn System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (email) DO NOTHING;
