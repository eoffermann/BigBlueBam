-- 0274_bastion_core.sql
-- Why: Bastion (continuous compliance evidence) core tables, spec section 4.1 tables 1-7:
--   frameworks, controls, control-to-requirement links (with the human applicability
--   decision), assertions (how a control is proven; content immutable once confirmed),
--   compile runs, per-org settings, and Bastion's own append-only audit log. Also seeds the
--   "Bastion System" service-account user (...0000b5) that worker actions and direct
--   agent_proposals inserts attribute to, and the shared bastion_reject_mutation() trigger
--   function the four-path immutability triggers in 0275-0278 use. Spec:
--   docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md sections 3.4 and 4.1 (the spec
--   numbers this file 0263; the tip had moved on).
-- Client impact: additive only. New tables, one trigger function, one sentinel service user;
--   no changes to existing objects.
--
--   Every bastion_% function created by the Bastion migrations is hardened the same way
--   (spec 3.1): SET search_path = pg_catalog, public, pg_temp; EXECUTE revoked from PUBLIC;
--   EXECUTE granted to bam_app only for SECURITY DEFINER functions and only when that role
--   exists. The hardening loop at the end of each file applies the REVOKE/GRANT idempotently.

-- ──────────────────────────────────────────────────────────────────────
-- Shared immutability trigger function (spec 3.4, the 0249 four-path pattern). Used by every
-- BEFORE UPDATE (WHEN scoped to the protected columns), BEFORE DELETE and BEFORE TRUNCATE
-- trigger on Bastion's evidence tables. A trigger function needs no EXECUTE grant to fire.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'BASTION_IMMUTABLE: % rows are immutable evidence; % is not permitted', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    RETURN NULL;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 1. bastion_frameworks. One adopted framework (SOC 2, ISO 27001) per row.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_frameworks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    template_key varchar(64) NOT NULL,
    template_version varchar(32) NOT NULL,
    name varchar(256) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'compiling',
    audit_target_date date,
    period_start date,
    period_end date,
    adopted_at timestamptz,
    adopted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_frameworks
        ADD CONSTRAINT bastion_frameworks_status_check
        CHECK (status IN ('compiling', 'active', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_frameworks_org_status
    ON bastion_frameworks (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bastion_frameworks_org_template
    ON bastion_frameworks (organization_id, template_key);

DROP TRIGGER IF EXISTS trg_bastion_frameworks_updated_at ON bastion_frameworks;
CREATE TRIGGER trg_bastion_frameworks_updated_at
    BEFORE UPDATE ON bastion_frameworks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 2. bastion_controls. The org's controls; one control can satisfy requirements in several
-- frameworks. status is the STORED status (pass/fail/unprovable); readers go through
-- effectiveStatus() (spec 3.2). Derived applicability is computed, not stored. tsv feeds the
-- questionnaire lexical retrieval (spec 2.7).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_controls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_key varchar(128) NOT NULL,
    title varchar(512) NOT NULL,
    plain_summary text,
    category varchar(64),
    risk_weight smallint NOT NULL DEFAULT 3,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    lifecycle varchar(16) NOT NULL DEFAULT 'active',
    status varchar(16) NOT NULL DEFAULT 'unprovable',
    status_reason varchar(48) DEFAULT 'not_yet_confirmed',
    stale_reason varchar(64),
    consecutive_error_nights integer NOT NULL DEFAULT 0,
    last_error_night date,
    coverage_kind varchar(16) NOT NULL DEFAULT 'none',
    active_exception_count integer NOT NULL DEFAULT 0,
    last_evaluated_at timestamptz,
    status_changed_at timestamptz,
    tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(plain_summary, ''))
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_controls
        ADD CONSTRAINT bastion_controls_status_check
        CHECK (status IN ('pass', 'fail', 'unprovable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_controls
        ADD CONSTRAINT bastion_controls_status_reason_check
        CHECK (status_reason IS NULL OR status_reason IN (
            'not_yet_confirmed', 'no_evidence_source', 'source_not_connected',
            'manual_evidence_missing', 'manual_evidence_expired', 'insufficient_data',
            'probe_error'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_controls
        ADD CONSTRAINT bastion_controls_lifecycle_check
        CHECK (lifecycle IN ('active', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_controls
        ADD CONSTRAINT bastion_controls_coverage_kind_check
        CHECK (coverage_kind IN ('native', 'feed', 'manual_file', 'self_attested', 'mixed', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_controls
        ADD CONSTRAINT bastion_controls_risk_weight_check
        CHECK (risk_weight BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_controls_org_key
    ON bastion_controls (organization_id, control_key);
CREATE INDEX IF NOT EXISTS idx_bastion_controls_org_status
    ON bastion_controls (organization_id, lifecycle, status);
CREATE INDEX IF NOT EXISTS idx_bastion_controls_org_owner
    ON bastion_controls (organization_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_bastion_controls_tsv
    ON bastion_controls USING gin (tsv);

DROP TRIGGER IF EXISTS trg_bastion_controls_updated_at ON bastion_controls;
CREATE TRIGGER trg_bastion_controls_updated_at
    BEFORE UPDATE ON bastion_controls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 3. bastion_control_requirements. Control-to-framework-requirement link with the human
-- applicability decision (Statement of Applicability). not_applicable needs a reason.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_control_requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE CASCADE,
    framework_id uuid NOT NULL REFERENCES bastion_frameworks(id) ON DELETE CASCADE,
    ref_code varchar(64) NOT NULL,
    requirement_title varchar(512) NOT NULL,
    applicability varchar(16) NOT NULL DEFAULT 'applicable',
    not_applicable_reason text,
    decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    source varchar(16) NOT NULL DEFAULT 'crosswalk',
    removed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_control_requirements
        ADD CONSTRAINT bastion_control_requirements_applicability_check
        CHECK (
            applicability IN ('applicable', 'not_applicable')
            AND (applicability = 'applicable' OR length(btrim(coalesce(not_applicable_reason, ''))) > 0)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_control_requirements
        ADD CONSTRAINT bastion_control_requirements_source_check
        CHECK (source IN ('crosswalk', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_control_requirements_unique
    ON bastion_control_requirements (organization_id, framework_id, ref_code, control_id);
CREATE INDEX IF NOT EXISTS idx_bastion_control_requirements_control
    ON bastion_control_requirements (organization_id, control_id);

DROP TRIGGER IF EXISTS trg_bastion_control_requirements_updated_at ON bastion_control_requirements;
CREATE TRIGGER trg_bastion_control_requirements_updated_at
    BEFORE UPDATE ON bastion_control_requirements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 5. bastion_compile_runs (created before assertions, which reference it). One queued or
-- running compile per framework.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_compile_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    framework_id uuid NOT NULL REFERENCES bastion_frameworks(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'queued',
    controls_total integer NOT NULL DEFAULT 0,
    controls_done integer NOT NULL DEFAULT 0,
    assertions_proposed integer NOT NULL DEFAULT 0,
    assertions_dropped integer NOT NULL DEFAULT 0,
    drop_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
    llm_calls_used integer NOT NULL DEFAULT 0,
    used_fallback boolean NOT NULL DEFAULT false,
    resume_count integer NOT NULL DEFAULT 0,
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    error text,
    started_by uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_compile_runs
        ADD CONSTRAINT bastion_compile_runs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_compile_runs_one_active
    ON bastion_compile_runs (organization_id, framework_id)
    WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_bastion_compile_runs_org_created
    ON bastion_compile_runs (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_compile_runs_updated_at ON bastion_compile_runs;
CREATE TRIGGER trg_bastion_compile_runs_updated_at
    BEFORE UPDATE ON bastion_compile_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 4. bastion_assertions. How one control is proven: a probe, a manual-evidence requirement,
-- or a machine feed. Content is immutable once confirmed (a change files a superseding
-- assertion). feed_id gets its FK in 0275, once bastion_evidence_feeds exists.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_assertions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE CASCADE,
    kind varchar(16) NOT NULL,
    probe_key varchar(64),
    probe_version integer,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    predicate jsonb NOT NULL DEFAULT '{}'::jsonb,
    manual_evidence_spec jsonb,
    feed_id uuid,
    plain_statement text NOT NULL,
    proposed_by varchar(16) NOT NULL DEFAULT 'library',
    compile_run_id uuid REFERENCES bastion_compile_runs(id) ON DELETE SET NULL,
    review_status varchar(16) NOT NULL DEFAULT 'proposed',
    supersedes_id uuid REFERENCES bastion_assertions(id) ON DELETE SET NULL,
    confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_assertions
        ADD CONSTRAINT bastion_assertions_kind_check
        CHECK (
            (kind = 'probe' AND probe_key IS NOT NULL AND probe_version IS NOT NULL)
            OR (kind = 'manual' AND manual_evidence_spec IS NOT NULL)
            OR (kind = 'feed' AND feed_id IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_assertions
        ADD CONSTRAINT bastion_assertions_proposed_by_check
        CHECK (proposed_by IN ('library', 'compiler', 'human', 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bastion_assertions
        ADD CONSTRAINT bastion_assertions_review_status_check
        CHECK (review_status IN ('proposed', 'confirmed', 'rejected', 'superseded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_assertions_org_control
    ON bastion_assertions (organization_id, control_id, review_status);
CREATE INDEX IF NOT EXISTS idx_bastion_assertions_org_probe
    ON bastion_assertions (organization_id, probe_key)
    WHERE kind = 'probe';
CREATE INDEX IF NOT EXISTS idx_bastion_assertions_supersedes
    ON bastion_assertions (supersedes_id);

DROP TRIGGER IF EXISTS trg_bastion_assertions_updated_at ON bastion_assertions;
CREATE TRIGGER trg_bastion_assertions_updated_at
    BEFORE UPDATE ON bastion_assertions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Content immutable once confirmed (spec 4.1). The WHEN clause names exactly the content
-- columns; review_status (confirmed -> superseded), updated_at and the bookkeeping columns
-- stay writable. A rejected or proposed assertion may still be edited.
DROP TRIGGER IF EXISTS trg_bastion_assertions_content_immutable ON bastion_assertions;
CREATE TRIGGER trg_bastion_assertions_content_immutable
    BEFORE UPDATE ON bastion_assertions
    FOR EACH ROW
    WHEN (
        OLD.review_status IN ('confirmed', 'superseded')
        AND (
            OLD.organization_id IS DISTINCT FROM NEW.organization_id
            OR OLD.control_id IS DISTINCT FROM NEW.control_id
            OR OLD.kind IS DISTINCT FROM NEW.kind
            OR OLD.probe_key IS DISTINCT FROM NEW.probe_key
            OR OLD.probe_version IS DISTINCT FROM NEW.probe_version
            OR OLD.params IS DISTINCT FROM NEW.params
            OR OLD.predicate IS DISTINCT FROM NEW.predicate
            OR OLD.manual_evidence_spec IS DISTINCT FROM NEW.manual_evidence_spec
            OR OLD.feed_id IS DISTINCT FROM NEW.feed_id
            OR OLD.plain_statement IS DISTINCT FROM NEW.plain_statement
        )
    )
    EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 6. bastion_org_settings. One row per org. evaluation_minute_offset is written by the app
-- (a hash of the org id, 0-59) so nightly runs spread across the hour.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_org_settings (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    llm_provider_id uuid,
    compliance_project_id uuid,
    remediation_tasks varchar(16) NOT NULL DEFAULT 'create',
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    evaluation_hour_local smallint NOT NULL DEFAULT 3,
    evaluation_minute_offset smallint NOT NULL DEFAULT 0,
    stale_after_hours integer NOT NULL DEFAULT 36,
    not_assessed_grace_days integer NOT NULL DEFAULT 14,
    manual_expiry_warn_days integer NOT NULL DEFAULT 30,
    questionnaire_high_floor numeric(4,3) NOT NULL DEFAULT 0.800,
    questionnaire_medium_floor numeric(4,3) NOT NULL DEFAULT 0.550,
    max_llm_calls_per_compile integer NOT NULL DEFAULT 400,
    max_llm_calls_per_questionnaire integer NOT NULL DEFAULT 1200,
    max_rows_per_questionnaire integer NOT NULL DEFAULT 1000,
    auditor_room_max_days integer NOT NULL DEFAULT 90,
    max_packet_bytes bigint NOT NULL DEFAULT 2147483648,
    company_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    offsite_backup_configured boolean NOT NULL DEFAULT false,
    bucket_check_status varchar(32),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_org_settings
        ADD CONSTRAINT bastion_org_settings_ranges_check
        CHECK (
            remediation_tasks IN ('create', 'propose')
            AND evaluation_hour_local BETWEEN 0 AND 23
            AND evaluation_minute_offset BETWEEN 0 AND 59
            AND stale_after_hours > 0
            AND auditor_room_max_days BETWEEN 1 AND 180
            AND questionnaire_medium_floor <= questionnaire_high_floor
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_bastion_org_settings_updated_at ON bastion_org_settings;
CREATE TRIGGER trg_bastion_org_settings_updated_at
    BEFORE UPDATE ON bastion_org_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 7. bastion_audit_log. Append-only record of every Bastion write (actor, impersonator,
-- action, subject). UPDATE and TRUNCATE are rejected; DELETE stays possible so an org
-- deletion can cascade.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id uuid,
    actor_kind varchar(16),
    impersonator_id uuid,
    action varchar(96) NOT NULL,
    subject_type varchar(48),
    subject_id uuid,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bastion_audit_log_org_created
    ON bastion_audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_audit_log_org_subject
    ON bastion_audit_log (organization_id, subject_type, subject_id);

DROP TRIGGER IF EXISTS trg_bastion_audit_log_no_update ON bastion_audit_log;
CREATE TRIGGER trg_bastion_audit_log_no_update
    BEFORE UPDATE ON bastion_audit_log
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_audit_log_no_truncate ON bastion_audit_log;
CREATE TRIGGER trg_bastion_audit_log_no_truncate
    BEFORE TRUNCATE ON bastion_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- Bastion System service-account user. Hosted in the shared sentinel org
-- (0014_helpdesk_system_user.sql). Never logs in (password_hash='!'); exists so worker
-- actions and direct agent_proposals inserts (actor_id NOT NULL) have a valid actor.
-- kind='service' marks it (braid b1, bulwark b2, burn b3, bursar b4). Bastion is b5.
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b5',
    '00000000-0000-0000-0000-000000000002',
    'system-bastion@bigbluebam.internal',
    'Bastion System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Hardening loop (spec 3.1): every bastion_% function loses PUBLIC execute; SECURITY DEFINER
-- ones are granted to bam_app only when that role exists. Idempotent.
-- ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure AS sig, p.prosecdef
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'bastion\_%' ESCAPE '\'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
        IF fn.prosecdef AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bam_app') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO bam_app', fn.sig);
        END IF;
    END LOOP;
END $$;
