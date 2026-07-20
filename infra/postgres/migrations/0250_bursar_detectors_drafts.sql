-- 0250_bursar_detectors_drafts.sql
-- Why: Bursar's post-award detector outputs and human-in-the-loop surfaces - the mismatch
--   ledger (the flagship output) with dedup + evidence-hash noise control, the renewal radar
--   with per-band idempotency, the advisory-only scope-gap check records, the durable event
--   inbox with a heartbeat/claim lease, the detector mark-wrong feedback loop, and the
--   content-free draft rows that pair with an agent_proposals summary. See
--   docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md sections 6.1, 8, 9, 16.
-- Client impact: additive only. New tables; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- bursar_mismatches. The detector output (spec 8). detector names the rule that fired.
-- dollars_at_stake_minor is NULL when unquantifiable (spec 7.3) and the UI shows "not
-- quantified" rather than a fabricated figure. dedup_key upserts and bumps last_seen_at;
-- dismissed is sticky by dedup_key UNLESS evidence_hash changes. Cross-app / cross-table
-- anchors (vendor, award, offer, node, request, baseline item, spend event, normalized_payee)
-- are nullable because different detectors cite different evidence.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_mismatches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    detector varchar(48) NOT NULL,
    severity varchar(16) NOT NULL DEFAULT 'medium',
    status varchar(16) NOT NULL DEFAULT 'open',
    dedup_key varchar(64) NOT NULL,
    evidence_hash varchar(64),
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    award_id uuid REFERENCES bursar_awards(id) ON DELETE SET NULL,
    chain_root_id uuid,
    request_id uuid REFERENCES bursar_requests(id) ON DELETE SET NULL,
    offer_id uuid REFERENCES bursar_offers(id) ON DELETE SET NULL,
    scope_node_id uuid REFERENCES bursar_scope_nodes(id) ON DELETE SET NULL,
    baseline_item_id uuid REFERENCES bursar_baseline_items(id) ON DELETE SET NULL,
    spend_event_id uuid REFERENCES bursar_spend_events(id) ON DELETE SET NULL,
    normalized_payee varchar(512),
    dollars_at_stake_minor bigint,
    currency varchar(3),
    basis varchar(32),
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    dismissed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    dismissed_at timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_mismatches
        ADD CONSTRAINT bursar_mismatches_severity_check
        CHECK (severity IN ('low', 'medium', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bursar_mismatches
        ADD CONSTRAINT bursar_mismatches_status_check
        CHECK (status IN ('open', 'resolved', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_mismatches_dedup
    ON bursar_mismatches(organization_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_bursar_mismatches_org_status
    ON bursar_mismatches(organization_id, status, detector);
CREATE INDEX IF NOT EXISTS idx_bursar_mismatches_org_vendor
    ON bursar_mismatches(organization_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bursar_mismatches_org_payee
    ON bursar_mismatches(organization_id, normalized_payee);
CREATE INDEX IF NOT EXISTS idx_bursar_mismatches_org_chain
    ON bursar_mismatches(organization_id, chain_root_id);

DROP TRIGGER IF EXISTS trg_bursar_mismatches_updated_at ON bursar_mismatches;
CREATE TRIGGER trg_bursar_mismatches_updated_at
    BEFORE UPDATE ON bursar_mismatches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_renewals. The renewal radar (spec 8, renewal_cliff). notice_deadline is anchored in
-- the award timezone. alerted_bands records which lead bands (t_minus_90/60/30/7) have
-- already fired, so a re-sweep is idempotent per band. One live radar row per award.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_renewals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    award_id uuid NOT NULL REFERENCES bursar_awards(id) ON DELETE CASCADE,
    chain_root_id uuid,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    term_end date,
    notice_deadline date,
    auto_renew boolean NOT NULL DEFAULT false,
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    current_band varchar(16),
    alerted_bands jsonb NOT NULL DEFAULT '[]'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'pending',
    decision varchar(16),
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_renewals
        ADD CONSTRAINT bursar_renewals_status_check
        CHECK (status IN ('pending', 'decided', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_renewals_award
    ON bursar_renewals(organization_id, award_id);
CREATE INDEX IF NOT EXISTS idx_bursar_renewals_org_status
    ON bursar_renewals(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_renewals_deadline
    ON bursar_renewals(organization_id, notice_deadline);

DROP TRIGGER IF EXISTS trg_bursar_renewals_updated_at ON bursar_renewals;
CREATE TRIGGER trg_bursar_renewals_updated_at
    BEFORE UPDATE ON bursar_renewals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_gate_checks. The ADVISORY-ONLY scope-gap check record (spec 9). The enforcing
-- bill-api gate is cut from v1: this table records verdict = pass / advisory plus cited
-- reason codes and never blocks a write. acting_user_id flows through viewer-caps.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_gate_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    check_kind varchar(24) NOT NULL DEFAULT 'scope_gap',
    verdict varchar(16) NOT NULL,
    request_id uuid REFERENCES bursar_requests(id) ON DELETE SET NULL,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    subject_ref varchar(96),
    reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    acting_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    source varchar(16) NOT NULL DEFAULT 'api',
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_gate_checks
        ADD CONSTRAINT bursar_gate_checks_verdict_check
        CHECK (verdict IN ('pass', 'advisory'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_gate_checks_org_created
    ON bursar_gate_checks(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bursar_gate_checks_org_verdict
    ON bursar_gate_checks(organization_id, verdict);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_ingest_events. The durable event inbox (spec 16.2). source_idempotency_key is the
-- payload _event_id when present, else the bolt event id. Like burn_ingest_events (and
-- UNLIKE bulwark_ingest_events) it has claim + heartbeat columns, because Bursar's drain is
-- both event-driven and scheduled so two drains can observe the same pending row: rows are
-- CLAIMED, never bare-selected, and claimed_at/heartbeat_at let the reaper reclaim only cold
-- rows. The reaper scan index is PER ORG so it still returns rows under BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_ingest_events (
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
    heartbeat_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bursar_ingest_events
        ADD CONSTRAINT bursar_ingest_events_status_check
        CHECK (status IN ('pending', 'claimed', 'processed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_ingest_events_idem
    ON bursar_ingest_events(organization_id, source_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bursar_ingest_events_pending
    ON bursar_ingest_events(organization_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_bursar_ingest_events_claimed
    ON bursar_ingest_events(organization_id, status, heartbeat_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_bursar_ingest_events_source_type
    ON bursar_ingest_events(source, event_type);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_detector_feedback. The mark-wrong loop (spec 8, POST /mismatches/:id/mark-wrong):
-- a human verdict on whether a detector fired correctly, feeding threshold calibration.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_detector_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    mismatch_id uuid NOT NULL REFERENCES bursar_mismatches(id) ON DELETE CASCADE,
    detector varchar(48) NOT NULL,
    verdict varchar(16) NOT NULL,
    reason text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_detector_feedback
        ADD CONSTRAINT bursar_detector_feedback_verdict_check
        CHECK (verdict IN ('wrong', 'right'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_detector_feedback_mismatch
    ON bursar_detector_feedback(organization_id, mismatch_id);
CREATE INDEX IF NOT EXISTS idx_bursar_detector_feedback_detector
    ON bursar_detector_feedback(organization_id, detector, verdict);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_drafts. The only thing that leaves the building (spec 3.6, 16.2): a clarification
-- or negotiation-brief draft with a content-free agent_proposals summary. NO outbound
-- transport exists in v1. Owner-scoped reads (GET /drafts). proposal_id is a dotted ref to
-- the shared agent_proposals row.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind varchar(24) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'draft',
    request_id uuid REFERENCES bursar_requests(id) ON DELETE SET NULL,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    award_id uuid REFERENCES bursar_awards(id) ON DELETE SET NULL,
    mismatch_id uuid REFERENCES bursar_mismatches(id) ON DELETE SET NULL,
    proposal_id uuid,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    title varchar(512),
    body text,
    created_by uuid NOT NULL REFERENCES users(id),
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    rejected_by uuid REFERENCES users(id) ON DELETE SET NULL,
    rejected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_drafts
        ADD CONSTRAINT bursar_drafts_kind_check
        CHECK (kind IN ('clarification', 'negotiation_brief'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bursar_drafts
        ADD CONSTRAINT bursar_drafts_status_check
        CHECK (status IN ('draft', 'pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_drafts_owner
    ON bursar_drafts(organization_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_drafts_org_status
    ON bursar_drafts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_drafts_proposal
    ON bursar_drafts(proposal_id);

DROP TRIGGER IF EXISTS trg_bursar_drafts_updated_at ON bursar_drafts;
CREATE TRIGGER trg_bursar_drafts_updated_at
    BEFORE UPDATE ON bursar_drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
