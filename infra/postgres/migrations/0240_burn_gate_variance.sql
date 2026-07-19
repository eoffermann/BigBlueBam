-- 0240_burn_gate_variance.sql
-- Why: Burn's pre-transaction gate and post-transaction variance surfaces - the precheck
--   reason-of-record artifact (with supersede-then-insert columns and the partial live
--   unique index), detected variances, the never-purged classifier feedback corpus, and
--   the per-org settings row carrying every threshold with both its default and its CHECK.
--   See docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md sections 3.1, 5, 2.4.
-- Client impact: additive only. New tables; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- burn_prechecks. The reason-of-record artifact.
--
-- SUPERSEDE-THEN-INSERT, NOT UPDATE-IN-PLACE (R2-T7). The unique index below is PARTIAL on
-- superseded_at IS NULL. A total unique index left only two options on a recompute, both
-- bad: UPDATE in place, which destroys the reason-of-record on the row, or INSERT and take
-- a 23505 ON THE MONEY PATH, where the only safe handler is fail-open.
--
-- idempotency_key is SERVER-DERIVED (an HMAC over the caller namespace, work ref, amount,
-- currency, and an attempt nonce). The prefix CHECK is what makes a caller-supplied key
-- structurally impossible to smuggle in.
--
-- is_calibrating is true only for svc: rows with a resolvable ref (spec 2.4 point 10): only
-- those count toward the promotion volume gate, so a member cannot script 200 synthetic
-- `manual` prechecks and satisfy it on a fabricated sample.
--
-- RETENTION: rows with enforced=true, a non-null override, a non-null advisory_feedback, or
-- a non-null superseded_at are NEVER purged. A superseded verdict is part of the dispute
-- record.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_prechecks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    idempotency_key varchar(160) NOT NULL,
    superseded_at timestamptz,
    superseded_by uuid,
    valid_until timestamptz NOT NULL,
    is_calibrating boolean NOT NULL DEFAULT false,
    work_ref_type varchar(32) NOT NULL,
    work_ref_id uuid,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    proposed_amount bigint,
    currency varchar(3),
    engagement_id uuid REFERENCES burn_engagements(id) ON DELETE SET NULL,
    chain_root_id uuid,
    deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE SET NULL,
    verdict varchar(20) NOT NULL,
    verdict_reason varchar(40) NOT NULL,
    mode_at_decision varchar(12) NOT NULL,
    enforced boolean NOT NULL DEFAULT false,
    envelope_amount bigint,
    envelope_consumed bigint,
    envelope_remaining bigint,
    overage_amount bigint,
    confidence numeric(5,2),
    clause_ref varchar(64),
    outcome varchar(24) NOT NULL DEFAULT 'pending',
    advisory_feedback varchar(16),
    override_reason_code varchar(24),
    override_reason_text text,
    overridden_by uuid REFERENCES users(id) ON DELETE SET NULL,
    overridden_at timestamptz,
    latency_ms integer,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_idempotency_key_ns_check
        CHECK (idempotency_key LIKE 'svc:%' OR idempotency_key LIKE 'usr:%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_verdict_check
        CHECK (verdict IN ('allow', 'allow_with_note', 'needs_mapping', 'deny'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_mode_at_decision_check
        CHECK (mode_at_decision IN ('off', 'advisory', 'blocking'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The advisory_feedback split by value (R2-S7) is a permission boundary, but the enum
-- itself is closed here so a typo cannot invent a third scoring value.
DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_advisory_feedback_check
        CHECK (advisory_feedback IS NULL
               OR advisory_feedback IN ('right_call', 'would_have_mapped', 'wrong_call'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_override_reason_code_check
        CHECK (override_reason_code IS NULL
               OR override_reason_code IN ('absorbed_cost', 'mapped_manually',
                                           'change_order_pending', 'gate_wrong'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_prechecks
        ADD CONSTRAINT burn_prechecks_superseded_by_fk
        FOREIGN KEY (superseded_by) REFERENCES burn_prechecks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_prechecks_live_idem
    ON burn_prechecks(organization_id, idempotency_key) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_burn_prechecks_org_verdict_created
    ON burn_prechecks(organization_id, verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_prechecks_org_enforced_created
    ON burn_prechecks(organization_id, enforced, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_prechecks_org_calibration
    ON burn_prechecks(organization_id, mode_at_decision, is_calibrating, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_prechecks_org_chain
    ON burn_prechecks(organization_id, chain_root_id);
CREATE INDEX IF NOT EXISTS idx_burn_prechecks_org_override_code
    ON burn_prechecks(organization_id, override_reason_code)
    WHERE override_reason_code IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- burn_variances. amount is read_all-floored on read and NEVER appears in a Bolt payload:
-- Bolt is org-level with no per-rule visibility, so events carry refs plus a coarse band.
-- Unpriced deliverables are excluded from envelope_overrun and consumption_erosion (2.2.2).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_variances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    engagement_id uuid REFERENCES burn_engagements(id) ON DELETE CASCADE,
    chain_root_id uuid,
    deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE SET NULL,
    variance_kind varchar(32) NOT NULL,
    severity varchar(8) NOT NULL,
    dedup_key varchar(128) NOT NULL,
    amount bigint,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(12) NOT NULL DEFAULT 'open',
    proposal_id uuid REFERENCES agent_proposals(id) ON DELETE SET NULL,
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    detected_at timestamptz,
    resolved_at timestamptz,
    sweep_marker timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_variances
        ADD CONSTRAINT burn_variances_kind_check
        CHECK (variance_kind IN (
            'unscoped_work', 'envelope_overrun', 'envelope_at_risk', 'silent_deliverable',
            'ungated_charge', 'consumption_erosion', 'phantom_consumption', 'gate_outage',
            'rule_overreach', 'awaiting_valuation', 'precheck_probing'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_variances
        ADD CONSTRAINT burn_variances_severity_check
        CHECK (severity IN ('low', 'medium', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_variances
        ADD CONSTRAINT burn_variances_status_check
        CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_variances_dedup
    ON burn_variances(organization_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_burn_variances_org_status_severity
    ON burn_variances(organization_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_burn_variances_org_chain
    ON burn_variances(organization_id, chain_root_id);
CREATE INDEX IF NOT EXISTS idx_burn_variances_org_kind_detected
    ON burn_variances(organization_id, variance_kind, detected_at DESC);

-- ──────────────────────────────────────────────────────────────────────
-- burn_classifier_feedback. NEVER purged: this is the exemplar corpus that tunes
-- attribution. search_tsv is coalesced for the same null-safety reason as
-- burn_deliverables, and is subject to the same rule: no member-reachable endpoint may
-- filter, sort, rank, or highlight on it (R3-S4).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_classifier_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    engagement_id uuid REFERENCES burn_engagements(id) ON DELETE SET NULL,
    work_item_id uuid REFERENCES burn_work_items(id) ON DELETE SET NULL,
    decision_kind varchar(24) NOT NULL,
    proposed_deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE SET NULL,
    corrected_deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE SET NULL,
    proposed_confidence numeric(5,2),
    text_snapshot text,
    search_tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(text_snapshot, ''))
    ) STORED,
    qdrant_point_id uuid,
    qdrant_synced_at timestamptz,
    decided_by uuid NOT NULL REFERENCES users(id),
    vocabulary_version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_classifier_feedback
        ADD CONSTRAINT burn_classifier_feedback_decision_kind_check
        CHECK (decision_kind IN (
            'accept', 'reject', 'reclassify', 'mark_unscoped', 'mark_scoped',
            'mark_non_billable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_burn_classifier_feedback_org_engagement
    ON burn_classifier_feedback(organization_id, engagement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_classifier_feedback_org_kind
    ON burn_classifier_feedback(organization_id, decision_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_classifier_feedback_search
    ON burn_classifier_feedback USING gin(search_tsv);

-- ──────────────────────────────────────────────────────────────────────
-- burn_org_settings. One row per org, every threshold with BOTH its default and its CHECK.
--
-- gate_mode defaults to 'advisory' and 'blocking' is unreachable without the seven
-- server-side preconditions of spec 5.4. gate_enabled_refs defaults to money-out classes
-- only.
--
-- precheck_budget_ms is ADVISORY AND DISPLAY-ONLY; the authoritative bound is bill-api's
-- BURN_PRECHECK_TIMEOUT_MS, because the timeout that matters is the one held by the caller
-- that fails open.
--
-- embedding_enabled defaults FALSE because embedding.service.ts:17 returns zero vectors.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_org_settings (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

    gate_mode varchar(12) NOT NULL DEFAULT 'advisory',
    gate_enabled_refs jsonb NOT NULL DEFAULT '["bill.expense"]'::jsonb,
    gate_paused_until timestamptz,
    deny_threshold numeric(5,2) NOT NULL DEFAULT 0.85,
    map_threshold numeric(5,2) NOT NULL DEFAULT 0.60,

    auto_attribute_threshold numeric(5,2) NOT NULL DEFAULT 0.90,
    review_threshold numeric(5,2) NOT NULL DEFAULT 0.60,
    pending_review_max_age_days integer NOT NULL DEFAULT 14,
    reconcile_window_days integer NOT NULL DEFAULT 90,

    overage_bucket_amount bigint NOT NULL DEFAULT 10000,
    min_contributors_for_cost_aggregate integer NOT NULL DEFAULT 3,

    match_ceiling_pct numeric(5,2) NOT NULL DEFAULT 40,

    max_false_positive_rate numeric(5,2) NOT NULL DEFAULT 0.05,
    min_gate_wrong_count integer NOT NULL DEFAULT 5,
    min_gate_wrong_distinct_users integer NOT NULL DEFAULT 2,
    min_advisory_decisions integer NOT NULL DEFAULT 200,
    min_advisory_days_alt integer NOT NULL DEFAULT 60,
    min_advisory_days integer NOT NULL DEFAULT 14,
    min_labeled_denies integer NOT NULL DEFAULT 10,
    min_deny_precision numeric(5,2) NOT NULL DEFAULT 0.95,
    min_priced_deliverable_coverage_pct numeric(5,2) NOT NULL DEFAULT 60,
    min_gate_coverage_pct numeric(5,2) NOT NULL DEFAULT 0.90,
    min_gate_unavailable_days integer NOT NULL DEFAULT 2,

    precheck_budget_ms integer NOT NULL DEFAULT 600,
    precheck_replay_ttl_seconds integer NOT NULL DEFAULT 300,
    usr_precheck_daily_cap integer NOT NULL DEFAULT 200,
    usr_precheck_per_deliverable_cap integer NOT NULL DEFAULT 5,
    override_reason_min_chars integer NOT NULL DEFAULT 20,

    unscoped_alert_floor bigint NOT NULL DEFAULT 10000,
    candidate_k integer NOT NULL DEFAULT 8,
    exemplar_k integer NOT NULL DEFAULT 6,
    attribution_llm_daily_cap integer NOT NULL DEFAULT 2000,
    attribute_batch_size integer NOT NULL DEFAULT 25,
    claim_lease_seconds integer NOT NULL DEFAULT 300,
    rollup_max_age_minutes integer NOT NULL DEFAULT 120,
    variance_detail_max_refs integer NOT NULL DEFAULT 50,

    embedding_enabled boolean NOT NULL DEFAULT false,
    banter_signal_enabled boolean NOT NULL DEFAULT false,
    vcs_signal_enabled boolean NOT NULL DEFAULT false,
    llm_provider_id uuid,
    vocabulary_version integer NOT NULL DEFAULT 0,

    last_source_watermark jsonb NOT NULL DEFAULT '{}'::jsonb,
    work_item_retention_days integer NOT NULL DEFAULT 1095,
    ingest_retention_days integer NOT NULL DEFAULT 400,
    last_variance_sweep_at timestamptz,

    gate_promoted_at timestamptz,
    gate_demoted_at timestamptz,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_gate_mode_check
        CHECK (gate_mode IN ('off', 'advisory', 'blocking'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The two attribution thresholds and their relationship. review_threshold must stay a
-- clear band below auto_attribute_threshold or the "queued for a human, never guessed"
-- middle band collapses to nothing and everything auto-attributes.
DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_auto_attribute_threshold_check
        CHECK (auto_attribute_threshold BETWEEN 0.75 AND 0.99);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_review_threshold_check
        CHECK (review_threshold BETWEEN 0.30 AND (auto_attribute_threshold - 0.05));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_gate_thresholds_check
        CHECK (deny_threshold BETWEEN 0.50 AND 1.00
               AND map_threshold BETWEEN 0.10 AND deny_threshold);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_precheck_budget_ms_check
        CHECK (precheck_budget_ms BETWEEN 100 AND 750);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The claim lease, the batch size, and the heartbeat interval have to agree (R2-T9): the
-- drain heartbeats at claim_lease_seconds / 3, so a lease under 30s cannot be heartbeated
-- reliably and the reaper would yank live work.
DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_claim_lease_check
        CHECK (claim_lease_seconds BETWEEN 30 AND 3600
               AND attribute_batch_size BETWEEN 1 AND 200);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_disclosure_check
        CHECK (overage_bucket_amount >= 1
               AND min_contributors_for_cost_aggregate >= 1
               AND usr_precheck_daily_cap BETWEEN 1 AND 10000
               AND usr_precheck_per_deliverable_cap BETWEEN 1 AND 100
               AND override_reason_min_chars BETWEEN 0 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_promotion_check
        CHECK (max_false_positive_rate BETWEEN 0 AND 1
               AND min_deny_precision BETWEEN 0 AND 1
               AND min_gate_coverage_pct BETWEEN 0 AND 1
               AND min_priced_deliverable_coverage_pct BETWEEN 0 AND 100
               AND match_ceiling_pct BETWEEN 0 AND 100
               AND min_gate_wrong_count >= 1
               AND min_gate_wrong_distinct_users >= 1
               AND min_advisory_decisions >= 1
               AND min_advisory_days >= 1
               AND min_advisory_days_alt >= 1
               AND min_labeled_denies >= 1
               AND min_gate_unavailable_days >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_org_settings
        ADD CONSTRAINT burn_org_settings_windows_check
        CHECK (reconcile_window_days BETWEEN 1 AND 3650
               AND pending_review_max_age_days BETWEEN 1 AND 3650
               AND rollup_max_age_minutes BETWEEN 1 AND 10080
               AND work_item_retention_days BETWEEN 1 AND 36500
               AND ingest_retention_days BETWEEN 1 AND 36500
               AND precheck_replay_ttl_seconds BETWEEN 1 AND 86400
               AND variance_detail_max_refs BETWEEN 1 AND 1000
               AND candidate_k BETWEEN 1 AND 100
               AND exemplar_k BETWEEN 1 AND 100
               AND attribution_llm_daily_cap >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- RLS on the four tables added here.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE burn_prechecks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_prechecks_org_isolation ON burn_prechecks;
CREATE POLICY burn_prechecks_org_isolation ON burn_prechecks
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_variances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_variances_org_isolation ON burn_variances;
CREATE POLICY burn_variances_org_isolation ON burn_variances
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_classifier_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_classifier_feedback_org_isolation ON burn_classifier_feedback;
CREATE POLICY burn_classifier_feedback_org_isolation ON burn_classifier_feedback
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_org_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_org_settings_org_isolation ON burn_org_settings;
CREATE POLICY burn_org_settings_org_isolation ON burn_org_settings
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);
