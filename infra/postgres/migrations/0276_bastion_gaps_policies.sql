-- 0276_bastion_gaps_policies.sql
-- Why: Bastion gaps, drift, fixes, exceptions and policies, spec section 4.1 tables 23-28:
--   drift events (one per control per run), ranked gaps (the 12 stored gap kinds of spec 2.3),
--   fix drafts mirrored into agent_proposals, accepted-risk exceptions (content immutable once
--   active, never deleted), Beacon-linked policies, and immutable version-pinned policy
--   attestations. The spec numbers this file 0265; the tip had moved on.
-- Client impact: additive only. New tables and triggers; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- 23. bastion_drift_events. A worsening of a control's status (or effective state, when an
-- exception expires). evaluation_run_id is NULL for exception-expiry drift.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_drift_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE CASCADE,
    evaluation_run_id uuid REFERENCES bastion_evaluation_runs(id) ON DELETE SET NULL,
    from_status varchar(32) NOT NULL,
    to_status varchar(32) NOT NULL,
    reason varchar(64) NOT NULL,
    snapshot_id uuid REFERENCES bastion_evidence_snapshots(id) ON DELETE SET NULL,
    bam_task_id uuid,
    task_status varchar(16) NOT NULL DEFAULT 'pending',
    proposal_id uuid,
    acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    detected_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_drift_events
        ADD CONSTRAINT bastion_drift_events_task_status_check
        CHECK (task_status IN ('pending', 'created', 'reopened', 'updated', 'no_project', 'proposed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_drift_events_run_control
    ON bastion_drift_events (organization_id, evaluation_run_id, control_id);
CREATE INDEX IF NOT EXISTS idx_bastion_drift_events_org_detected
    ON bastion_drift_events (organization_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_drift_events_control
    ON bastion_drift_events (organization_id, control_id, detected_at DESC);

-- ──────────────────────────────────────────────────────────────────────
-- 24. bastion_gaps. The ranked "what to fix first" list. gap_kind holds the 12 stored kinds of
-- spec 2.3 (the org-level `stale` row is derived at read time, never stored). assertion_id is
-- NULL for control-level gaps (not_assessed); the unique index treats NULLs as equal so a
-- control-level gap cannot be duplicated.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_gaps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE CASCADE,
    assertion_id uuid REFERENCES bastion_assertions(id) ON DELETE CASCADE,
    gap_kind varchar(24) NOT NULL,
    risk_score numeric(8,4) NOT NULL DEFAULT 0,
    fix_template varchar(24),
    fix_cost smallint,
    status varchar(16) NOT NULL DEFAULT 'open',
    dismissed_reason text,
    dismissed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    computed_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_gaps
        ADD CONSTRAINT bastion_gaps_shape_check
        CHECK (
            gap_kind IN ('failing', 'no_source', 'manual_expired', 'not_connected', 'manual_missing',
                         'population_drift', 'check_broken', 'insufficient_data',
                         'population_review', 'not_assessed', 'manual_expiring', 'attested_only')
            AND (fix_template IS NULL OR fix_template IN ('confirm_check', 'evidence_request',
                         'policy_draft', 'bolt_rule', 'connect_source', 'config_change',
                         'process_change'))
            AND status IN ('open', 'proposed', 'resolved', 'dismissed')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_gaps_unique
    ON bastion_gaps (organization_id, control_id, assertion_id, gap_kind) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_bastion_gaps_org_rank
    ON bastion_gaps (organization_id, status, risk_score DESC);

-- ──────────────────────────────────────────────────────────────────────
-- 25. bastion_fix_drafts. A drafted fix for one gap, mirrored as an agent_proposals row with
-- owning_app = 'bastion' and decided inside Bastion only (spec 2.4, 2.8).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_fix_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    gap_id uuid REFERENCES bastion_gaps(id) ON DELETE SET NULL,
    template varchar(24) NOT NULL,
    title varchar(512) NOT NULL,
    body_markdown text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    cited_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    dropped_citation_count integer NOT NULL DEFAULT 0,
    proposal_id uuid,
    status varchar(24) NOT NULL DEFAULT 'proposed',
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    applied_entity_type varchar(48),
    applied_entity_id uuid,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_kind varchar(16),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_fix_drafts
        ADD CONSTRAINT bastion_fix_drafts_shape_check
        CHECK (
            template IN ('confirm_check', 'evidence_request', 'policy_draft', 'bolt_rule',
                         'connect_source', 'config_change', 'process_change')
            AND status IN ('proposed', 'approved', 'rejected', 'expired', 'applied', 'decision_rejected')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_fix_drafts_org_status
    ON bastion_fix_drafts (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_fix_drafts_gap
    ON bastion_fix_drafts (organization_id, gap_id);
CREATE INDEX IF NOT EXISTS idx_bastion_fix_drafts_proposal
    ON bastion_fix_drafts (proposal_id);

DROP TRIGGER IF EXISTS trg_bastion_fix_drafts_updated_at ON bastion_fix_drafts;
CREATE TRIGGER trg_bastion_fix_drafts_updated_at
    BEFORE UPDATE ON bastion_fix_drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 26. bastion_exceptions. Accepted risk (spec 2.6). Single-entity exceptions last at most 365
-- days, assertion-wide ones 90 and cover only frozen_refs. Content is immutable once active
-- (status and updated_at stay writable so it can expire); never deleted.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE RESTRICT,
    assertion_id uuid REFERENCES bastion_assertions(id) ON DELETE RESTRICT,
    scope varchar(16) NOT NULL,
    cited_entity_type varchar(48),
    cited_entity_id uuid,
    frozen_refs jsonb,
    reason text NOT NULL,
    compensating_note text,
    proposal_id uuid,
    status varchar(16) NOT NULL DEFAULT 'proposed',
    proposed_by uuid NOT NULL,
    decided_by uuid,
    decided_at timestamptz,
    small_team_self_approval boolean NOT NULL DEFAULT false,
    expires_at timestamptz NOT NULL,
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    ledger_seq bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_exceptions
        ADD CONSTRAINT bastion_exceptions_shape_check
        CHECK (
            scope IN ('entity', 'assertion')
            AND status IN ('proposed', 'active', 'expired', 'rejected')
            AND (scope <> 'entity' OR (cited_entity_type IS NOT NULL AND cited_entity_id IS NOT NULL))
            AND (scope <> 'assertion' OR assertion_id IS NOT NULL)
            AND (
                (scope = 'entity' AND expires_at <= created_at + interval '365 days')
                OR (scope = 'assertion' AND expires_at <= created_at + interval '90 days')
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_exceptions_org_control
    ON bastion_exceptions (organization_id, control_id, status);
CREATE INDEX IF NOT EXISTS idx_bastion_exceptions_active_expiry
    ON bastion_exceptions (organization_id, expires_at)
    WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_bastion_exceptions_updated_at ON bastion_exceptions;
CREATE TRIGGER trg_bastion_exceptions_updated_at
    BEFORE UPDATE ON bastion_exceptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Once active (and after it expires), every column except status and updated_at is frozen.
DROP TRIGGER IF EXISTS trg_bastion_exceptions_no_update ON bastion_exceptions;
CREATE TRIGGER trg_bastion_exceptions_no_update
    BEFORE UPDATE ON bastion_exceptions
    FOR EACH ROW
    WHEN (
        OLD.status IN ('active', 'expired')
        AND (
            OLD.id IS DISTINCT FROM NEW.id
            OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
            OR OLD.control_id IS DISTINCT FROM NEW.control_id
            OR OLD.assertion_id IS DISTINCT FROM NEW.assertion_id
            OR OLD.scope IS DISTINCT FROM NEW.scope
            OR OLD.cited_entity_type IS DISTINCT FROM NEW.cited_entity_type
            OR OLD.cited_entity_id IS DISTINCT FROM NEW.cited_entity_id
            OR OLD.frozen_refs IS DISTINCT FROM NEW.frozen_refs
            OR OLD.reason IS DISTINCT FROM NEW.reason
            OR OLD.compensating_note IS DISTINCT FROM NEW.compensating_note
            OR OLD.proposal_id IS DISTINCT FROM NEW.proposal_id
            OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
            OR OLD.decided_by IS DISTINCT FROM NEW.decided_by
            OR OLD.decided_at IS DISTINCT FROM NEW.decided_at
            OR OLD.small_team_self_approval IS DISTINCT FROM NEW.small_team_self_approval
            OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
            OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
            OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
            OR OLD.ledger_seq IS DISTINCT FROM NEW.ledger_seq
            OR OLD.created_at IS DISTINCT FROM NEW.created_at
        )
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_exceptions_no_delete ON bastion_exceptions;
CREATE TRIGGER trg_bastion_exceptions_no_delete
    BEFORE DELETE ON bastion_exceptions
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_exceptions_no_truncate ON bastion_exceptions;
CREATE TRIGGER trg_bastion_exceptions_no_truncate
    BEFORE TRUNCATE ON bastion_exceptions
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 27. bastion_policies. A Beacon article adopted as a policy people must read and attest.
-- audience: {"kind":"all"} or {"kind":"users","user_ids":[...]}.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    beacon_entry_id uuid NOT NULL,
    title_cache varchar(512),
    audience jsonb NOT NULL DEFAULT '{"kind":"all"}'::jsonb,
    cadence_days integer NOT NULL DEFAULT 365,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status varchar(16) NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_policies
        ADD CONSTRAINT bastion_policies_shape_check
        CHECK (status IN ('active', 'retired') AND cadence_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_policies_org_entry
    ON bastion_policies (organization_id, beacon_entry_id);

DROP TRIGGER IF EXISTS trg_bastion_policies_updated_at ON bastion_policies;
CREATE TRIGGER trg_bastion_policies_updated_at
    BEFORE UPDATE ON bastion_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 28. bastion_policy_attestations. "I have read and understood this", pinned to one Beacon
-- version and the SHA-256 of the exact body served. Immutable.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_policy_attestations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    policy_id uuid NOT NULL REFERENCES bastion_policies(id) ON DELETE RESTRICT,
    beacon_entry_id uuid NOT NULL,
    beacon_version integer NOT NULL,
    body_sha256 varchar(64) NOT NULL,
    user_id uuid NOT NULL,
    attested_at timestamptz NOT NULL DEFAULT now(),
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    ledger_seq bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_policy_attestations_unique
    ON bastion_policy_attestations (organization_id, policy_id, beacon_version, user_id);
CREATE INDEX IF NOT EXISTS idx_bastion_policy_attestations_user
    ON bastion_policy_attestations (organization_id, user_id, attested_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_policy_attestations_no_update ON bastion_policy_attestations;
CREATE TRIGGER trg_bastion_policy_attestations_no_update
    BEFORE UPDATE ON bastion_policy_attestations
    FOR EACH ROW
    WHEN (
        OLD.id IS DISTINCT FROM NEW.id
        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.policy_id IS DISTINCT FROM NEW.policy_id
        OR OLD.beacon_entry_id IS DISTINCT FROM NEW.beacon_entry_id
        OR OLD.beacon_version IS DISTINCT FROM NEW.beacon_version
        OR OLD.body_sha256 IS DISTINCT FROM NEW.body_sha256
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.attested_at IS DISTINCT FROM NEW.attested_at
        OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
        OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
        OR OLD.ledger_seq IS DISTINCT FROM NEW.ledger_seq
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_policy_attestations_no_delete ON bastion_policy_attestations;
CREATE TRIGGER trg_bastion_policy_attestations_no_delete
    BEFORE DELETE ON bastion_policy_attestations
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_policy_attestations_no_truncate ON bastion_policy_attestations;
CREATE TRIGGER trg_bastion_policy_attestations_no_truncate
    BEFORE TRUNCATE ON bastion_policy_attestations
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();
