-- 0234_bulwark_core.sql
-- Why: Bulwark (AI contract-obligation monitor) core tables - tracked contracts, the typed
--   clause-cited obligation ledger, the durable event inbox, live notice deadlines, waiver
--   risks, extraction-run audit, and per-org settings. Also seeds the "Bulwark System"
--   service-account user that autonomous worker actions and direct agent_proposals inserts
--   (actor_id NOT NULL) are attributed to. See
--   docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md sections 3.1, 3.4, 2.2.
-- Client impact: additive only. New tables + one sentinel service user; no changes to
--   existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_contracts (a contract or amendment Bulwark tracks). project_id is the read/write
-- project-membership scoping anchor. supersedes_contract_id self-FK added below.
-- bin_asset_id / counterparty_id are dotted refs with NO cross-schema FK (D8).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    title varchar(512) NOT NULL,
    contract_kind varchar(32) NOT NULL DEFAULT 'subcontract',
    supersedes_contract_id uuid,
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    jurisdiction varchar(32),
    bin_asset_id uuid NOT NULL,
    counterparty_type varchar(32),
    counterparty_id uuid,
    effective_date date,
    expiry_date date,
    status varchar(16) NOT NULL DEFAULT 'active',
    extraction_status varchar(16) NOT NULL DEFAULT 'pending',
    extracted_at timestamptz,
    source_doc_hash varchar(64),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulwark_contracts_org_status
    ON bulwark_contracts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bulwark_contracts_org_project
    ON bulwark_contracts(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_contracts_org_bin_asset
    ON bulwark_contracts(organization_id, bin_asset_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_contracts_org_expiry
    ON bulwark_contracts(organization_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_bulwark_contracts_supersedes
    ON bulwark_contracts(supersedes_contract_id);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_extraction_runs (audit + chunk checkpoint, ST6). Created before obligations so
-- the obligations.extraction_run_id FK can be inline. Never purged.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_extraction_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contract_id uuid NOT NULL REFERENCES bulwark_contracts(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'running',
    chunk_count integer,
    last_processed_chunk integer NOT NULL DEFAULT -1,
    source_doc_hash varchar(64),
    obligations_extracted integer NOT NULL DEFAULT 0,
    low_confidence_count integer NOT NULL DEFAULT 0,
    provider_id uuid,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bulwark_extraction_runs_contract
    ON bulwark_extraction_runs(organization_id, contract_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulwark_extraction_runs_status
    ON bulwark_extraction_runs(status);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_obligations (one typed, clause-cited obligation). dedup_key is the stable
-- per-obligation upsert/supersession key (DI1). supersedes_obligation_id self-FK added below.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_obligations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contract_id uuid NOT NULL REFERENCES bulwark_contracts(id) ON DELETE CASCADE,
    clause_ref varchar(64),
    dedup_key varchar(64) NOT NULL,
    supersedes_obligation_id uuid,
    obligation_type varchar(32) NOT NULL,
    title varchar(512) NOT NULL,
    trigger_description text,
    event_binding jsonb NOT NULL DEFAULT '{}'::jsonb,
    deadline_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
    mandated_doc_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    confidence numeric(5,2),
    review_status varchar(16) NOT NULL DEFAULT 'pending_review',
    is_armed boolean NOT NULL DEFAULT false,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    extraction_run_id uuid REFERENCES bulwark_extraction_runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_obligations_dedup
    ON bulwark_obligations(organization_id, contract_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_org_contract
    ON bulwark_obligations(organization_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_org_review
    ON bulwark_obligations(organization_id, review_status);
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_org_type
    ON bulwark_obligations(organization_id, obligation_type);
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_org_armed
    ON bulwark_obligations(organization_id, is_armed) WHERE is_armed;
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_supersedes
    ON bulwark_obligations(supersedes_obligation_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_obligations_event_binding
    ON bulwark_obligations USING gin(event_binding);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_ingest_events (the durable event inbox, THEME D). Highest-churn table; first
-- candidate for monthly partitioning (ST9). source_idempotency_key is the redelivery dedup
-- atom, independent of deadline retention (ST4).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_ingest_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_idempotency_key varchar(128) NOT NULL,
    bolt_event_id uuid,
    source varchar(48) NOT NULL,
    event_type varchar(96) NOT NULL,
    logged_at timestamptz NOT NULL,
    trigger_at timestamptz,
    scope_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(12) NOT NULL DEFAULT 'pending',
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_ingest_events_idem
    ON bulwark_ingest_events(organization_id, source_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bulwark_ingest_events_pending
    ON bulwark_ingest_events(organization_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_bulwark_ingest_events_source_type
    ON bulwark_ingest_events(source, event_type);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_notice_deadlines (a live deadline instance). obligation FK is ON DELETE RESTRICT
-- (THEME C) so a live clock blocks an accidental obligation delete. triggering_event_id is
-- the deterministic arm key; the unique (org, obligation, triggering_event_id) is the single
-- at-most-once arm guard.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_notice_deadlines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    obligation_id uuid NOT NULL REFERENCES bulwark_obligations(id) ON DELETE RESTRICT,
    contract_id uuid NOT NULL REFERENCES bulwark_contracts(id) ON DELETE CASCADE,
    ingest_event_id uuid REFERENCES bulwark_ingest_events(id) ON DELETE SET NULL,
    triggering_event_id uuid NOT NULL,
    anchor_source varchar(12) NOT NULL,
    triggered_at timestamptz NOT NULL,
    logged_at timestamptz,
    resolved_timezone varchar(64) NOT NULL,
    due_at timestamptz NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'open',
    notice_status varchar(16) NOT NULL DEFAULT 'none',
    notice_proposal_id uuid REFERENCES agent_proposals(id) ON DELETE SET NULL,
    notice_draft jsonb NOT NULL DEFAULT '{}'::jsonb,
    discharged_at timestamptz,
    radar_marker timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_deadlines_arm
    ON bulwark_notice_deadlines(organization_id, obligation_id, triggering_event_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_deadlines_radar
    ON bulwark_notice_deadlines(organization_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_bulwark_deadlines_org_contract
    ON bulwark_notice_deadlines(organization_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_deadlines_proposal
    ON bulwark_notice_deadlines(notice_proposal_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_deadlines_org_notice
    ON bulwark_notice_deadlines(organization_id, notice_status);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_waiver_risks (a flagged risk). obligation FK ON DELETE RESTRICT, deadline FK
-- ON DELETE SET NULL: a risk is never cascade-deleted (D3). Retained indefinitely.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_waiver_risks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    obligation_id uuid NOT NULL REFERENCES bulwark_obligations(id) ON DELETE RESTRICT,
    deadline_id uuid REFERENCES bulwark_notice_deadlines(id) ON DELETE SET NULL,
    contract_id uuid NOT NULL REFERENCES bulwark_contracts(id) ON DELETE CASCADE,
    severity varchar(8) NOT NULL,
    reason varchar(32) NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(12) NOT NULL DEFAULT 'open',
    detected_at timestamptz,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_waiver_risks_dedup
    ON bulwark_waiver_risks(organization_id, obligation_id, deadline_id, reason);
CREATE INDEX IF NOT EXISTS idx_bulwark_waiver_risks_org_status_sev
    ON bulwark_waiver_risks(organization_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_bulwark_waiver_risks_org_contract
    ON bulwark_waiver_risks(organization_id, contract_id);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_org_settings (per-org tunables; one row per org, modeled on basis_org_settings).
-- inbox_retention_days is enforced >= discharged_deadline_retention_days at the app layer
-- (STJ7). auto_draft_notices off by default (D5).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_org_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    default_timezone varchar(64) NOT NULL DEFAULT 'UTC',
    auto_confirm_threshold numeric(5,2) NOT NULL DEFAULT 0.95,
    radar_lead_times jsonb NOT NULL DEFAULT '{"critical_hours":24,"high_hours":72,"medium_hours":168}'::jsonb,
    auto_draft_notices boolean NOT NULL DEFAULT false,
    auto_draft_max_per_sweep integer NOT NULL DEFAULT 20,
    notice_llm_daily_cap integer NOT NULL DEFAULT 100,
    chase_cadence_days integer NOT NULL DEFAULT 7,
    coi_expiry_lead_days integer NOT NULL DEFAULT 30,
    discharged_deadline_retention_days integer NOT NULL DEFAULT 365,
    inbox_retention_days integer NOT NULL DEFAULT 400,
    llm_provider_id uuid,
    last_radar_sweep_at timestamptz,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_org_settings_org
    ON bulwark_org_settings(organization_id);

-- ──────────────────────────────────────────────────────────────────────
-- Self-FKs declared after the tables exist (guarded / idempotent).
-- ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE bulwark_contracts
        ADD CONSTRAINT fk_bulwark_contracts_supersedes
        FOREIGN KEY (supersedes_contract_id) REFERENCES bulwark_contracts(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bulwark_obligations
        ADD CONSTRAINT fk_bulwark_obligations_supersedes
        FOREIGN KEY (supersedes_obligation_id) REFERENCES bulwark_obligations(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via app.current_org_id GUC (pattern from 0230_braid_core.sql /
-- 0226_basis_core.sql / 0132_entity_links.sql). Advisory until BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE bulwark_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_contracts_org_isolation ON bulwark_contracts;
CREATE POLICY bulwark_contracts_org_isolation ON bulwark_contracts
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_extraction_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_extraction_runs_org_isolation ON bulwark_extraction_runs;
CREATE POLICY bulwark_extraction_runs_org_isolation ON bulwark_extraction_runs
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_obligations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_obligations_org_isolation ON bulwark_obligations;
CREATE POLICY bulwark_obligations_org_isolation ON bulwark_obligations
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_ingest_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_ingest_events_org_isolation ON bulwark_ingest_events;
CREATE POLICY bulwark_ingest_events_org_isolation ON bulwark_ingest_events
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_notice_deadlines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_notice_deadlines_org_isolation ON bulwark_notice_deadlines;
CREATE POLICY bulwark_notice_deadlines_org_isolation ON bulwark_notice_deadlines
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_waiver_risks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_waiver_risks_org_isolation ON bulwark_waiver_risks;
CREATE POLICY bulwark_waiver_risks_org_isolation ON bulwark_waiver_risks
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_org_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_org_settings_org_isolation ON bulwark_org_settings;
CREATE POLICY bulwark_org_settings_org_isolation ON bulwark_org_settings
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ──────────────────────────────────────────────────────────────────────
-- Bulwark System service-account user. Hosted in the shared sentinel org
-- (0014_helpdesk_system_user.sql). Never logs in (password_hash='!'); exists so
-- autonomous worker actions and direct agent_proposals inserts have a valid actor.
-- The users table has no 'role' column; kind='service' marks it (mirrors 0230 braid seed).
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b2',
    '00000000-0000-0000-0000-000000000002',
    'system-bulwark@bigbluebam.internal',
    'Bulwark System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b2',
    '00000000-0000-0000-0000-000000000002',
    'system-bulwark@bigbluebam.internal',
    'Bulwark System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (email) DO NOTHING;
