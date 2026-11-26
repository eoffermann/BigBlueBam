-- 0275_bastion_evidence.sql
-- Why: Bastion evaluation and evidence tables, spec section 4.1 tables 8-22: evaluation runs,
--   content-addressed evidence objects and their write intents, immutable evidence snapshots,
--   manual evidence and its assertion links, machine feeds (feeds, per-feed keys, immutable
--   records), the mutable personal-data side table, the event inbox, the outbox, and the
--   hash-chained ledger with its daily seals and restore records. Installs the four-path
--   immutability triggers of spec 3.4 (BEFORE UPDATE with a WHEN clause naming exactly the
--   protected columns, BEFORE DELETE, ON DELETE RESTRICT on the parents, BEFORE TRUNCATE).
--   The spec numbers this file 0264; the tip had moved on.
-- Client impact: additive only. New tables and triggers; no changes to existing objects.
--
--   VOLUME NOTE (spec 4.1.1). bastion_evidence_snapshots, bastion_ledger_entries and
--   bastion_feed_records are the high-volume tables. Monthly created_at partitioning becomes
--   mandatory once they pass 50 million rows platform-wide; until then they are plain tables.
--
--   User references on immutable tables (uploaded_by, owner_user_id, ...) are plain uuid
--   columns with no FK: an ON DELETE SET NULL would be an UPDATE of a protected column and
--   would make the user undeletable through the trigger instead of through a clear FK error.

-- ──────────────────────────────────────────────────────────────────────
-- 8. bastion_evaluation_runs. One nightly run per org per date; at most one queued/running
-- full run per org and one per control. A partial nightly run is resumed in place.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_evaluation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    trigger varchar(16) NOT NULL,
    scope varchar(16) NOT NULL DEFAULT 'all',
    control_id uuid REFERENCES bastion_controls(id) ON DELETE SET NULL,
    nightly_for_date date,
    as_of timestamptz NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'queued',
    partial_reason varchar(48),
    resume_count integer NOT NULL DEFAULT 0,
    controls_total integer NOT NULL DEFAULT 0,
    controls_done integer NOT NULL DEFAULT 0,
    pass_count integer NOT NULL DEFAULT 0,
    fail_count integer NOT NULL DEFAULT 0,
    unprovable_count integer NOT NULL DEFAULT 0,
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    started_by uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_evaluation_runs
        ADD CONSTRAINT bastion_evaluation_runs_shape_check
        CHECK (
            trigger IN ('nightly', 'manual', 'agent')
            AND scope IN ('all', 'control')
            AND status IN ('queued', 'running', 'succeeded', 'partial', 'failed')
            AND (trigger <> 'nightly' OR nightly_for_date IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evaluation_runs_one_full
    ON bastion_evaluation_runs (organization_id)
    WHERE status IN ('queued', 'running') AND scope = 'all';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evaluation_runs_one_control
    ON bastion_evaluation_runs (organization_id, control_id)
    WHERE status IN ('queued', 'running') AND scope = 'control';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evaluation_runs_nightly
    ON bastion_evaluation_runs (organization_id, nightly_for_date)
    WHERE trigger = 'nightly';
CREATE INDEX IF NOT EXISTS idx_bastion_evaluation_runs_org_created
    ON bastion_evaluation_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_evaluation_runs_status
    ON bastion_evaluation_runs (status, heartbeat_at)
    WHERE status IN ('queued', 'running', 'partial');

DROP TRIGGER IF EXISTS trg_bastion_evaluation_runs_updated_at ON bastion_evaluation_runs;
CREATE TRIGGER trg_bastion_evaluation_runs_updated_at
    BEFORE UPDATE ON bastion_evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 9. bastion_evidence_objects. Content-addressed bytes in the Bastion bucket, stored once per
-- org and reference-counted. Never deleted: redaction sets bytes_redacted_at. holder_count,
-- mirrored_at and bytes_redacted_at change in normal operation; every other column is frozen.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_evidence_objects (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    content_sha256 varchar(64) NOT NULL,
    object_key varchar(512) NOT NULL,
    size_bytes bigint NOT NULL,
    content_type varchar(255),
    holder_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    bytes_redacted_at timestamptz,
    mirrored_at timestamptz,
    PRIMARY KEY (organization_id, content_sha256)
);

DO $$
BEGIN
    ALTER TABLE bastion_evidence_objects
        ADD CONSTRAINT bastion_evidence_objects_shape_check
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes >= 0 AND holder_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evidence_objects_key
    ON bastion_evidence_objects (object_key);
CREATE INDEX IF NOT EXISTS idx_bastion_evidence_objects_unmirrored
    ON bastion_evidence_objects (organization_id, created_at)
    WHERE mirrored_at IS NULL;

DROP TRIGGER IF EXISTS trg_bastion_evidence_objects_no_update ON bastion_evidence_objects;
CREATE TRIGGER trg_bastion_evidence_objects_no_update
    BEFORE UPDATE ON bastion_evidence_objects
    FOR EACH ROW
    WHEN (
        OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
        OR OLD.object_key IS DISTINCT FROM NEW.object_key
        OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
        OR OLD.content_type IS DISTINCT FROM NEW.content_type
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_evidence_objects_no_delete ON bastion_evidence_objects;
CREATE TRIGGER trg_bastion_evidence_objects_no_delete
    BEFORE DELETE ON bastion_evidence_objects
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_evidence_objects_no_truncate ON bastion_evidence_objects;
CREATE TRIGGER trg_bastion_evidence_objects_no_truncate
    BEFORE TRUNCATE ON bastion_evidence_objects
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 10. bastion_object_intents. Written before each bucket put; deleted in the transaction
-- that inserts the object row. Leftovers are what the object sweep reconciles.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_object_intents (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    object_key varchar(512) PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bastion_object_intents_org_created
    ON bastion_object_intents (organization_id, created_at);

-- ──────────────────────────────────────────────────────────────────────
-- 11. bastion_evidence_snapshots. One immutable row per (run, assertion); the unique key
-- makes resumption idempotent. cited_refs carries {entity_type, entity_id} only (capped 200);
-- labels live in bastion_personal_data.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_evidence_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    evaluation_run_id uuid NOT NULL REFERENCES bastion_evaluation_runs(id) ON DELETE RESTRICT,
    assertion_id uuid NOT NULL REFERENCES bastion_assertions(id) ON DELETE RESTRICT,
    control_id uuid NOT NULL REFERENCES bastion_controls(id) ON DELETE RESTRICT,
    outcome varchar(16) NOT NULL,
    unprovable_reason varchar(48),
    probe_key varchar(64),
    probe_version integer,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    query_fingerprint varchar(64),
    population_checked jsonb,
    population_unlisted jsonb,
    window_start timestamptz,
    window_end timestamptz,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    cited_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    overflow_count integer NOT NULL DEFAULT 0,
    manual_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    exception_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    feed_record_count integer NOT NULL DEFAULT 0,
    replica_lag_ms integer,
    content_sha256 varchar(64) NOT NULL,
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    ledger_seq bigint,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_evidence_snapshots
        ADD CONSTRAINT bastion_evidence_snapshots_outcome_check
        CHECK (
            outcome IN ('pass', 'fail', 'unprovable')
            AND (outcome <> 'unprovable' OR unprovable_reason IS NOT NULL)
            AND jsonb_typeof(cited_refs) = 'array'
            AND jsonb_array_length(cited_refs) <= 200
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evidence_snapshots_run_assertion
    ON bastion_evidence_snapshots (organization_id, evaluation_run_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_bastion_evidence_snapshots_control_created
    ON bastion_evidence_snapshots (organization_id, control_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_evidence_snapshots_assertion_created
    ON bastion_evidence_snapshots (organization_id, assertion_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_evidence_snapshots_no_update ON bastion_evidence_snapshots;
CREATE TRIGGER trg_bastion_evidence_snapshots_no_update
    BEFORE UPDATE ON bastion_evidence_snapshots
    FOR EACH ROW
    WHEN (
        OLD.id IS DISTINCT FROM NEW.id
        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.evaluation_run_id IS DISTINCT FROM NEW.evaluation_run_id
        OR OLD.assertion_id IS DISTINCT FROM NEW.assertion_id
        OR OLD.control_id IS DISTINCT FROM NEW.control_id
        OR OLD.outcome IS DISTINCT FROM NEW.outcome
        OR OLD.unprovable_reason IS DISTINCT FROM NEW.unprovable_reason
        OR OLD.probe_key IS DISTINCT FROM NEW.probe_key
        OR OLD.probe_version IS DISTINCT FROM NEW.probe_version
        OR OLD.params IS DISTINCT FROM NEW.params
        OR OLD.query_fingerprint IS DISTINCT FROM NEW.query_fingerprint
        OR OLD.population_checked IS DISTINCT FROM NEW.population_checked
        OR OLD.population_unlisted IS DISTINCT FROM NEW.population_unlisted
        OR OLD.window_start IS DISTINCT FROM NEW.window_start
        OR OLD.window_end IS DISTINCT FROM NEW.window_end
        OR OLD.summary IS DISTINCT FROM NEW.summary
        OR OLD.cited_refs IS DISTINCT FROM NEW.cited_refs
        OR OLD.overflow_count IS DISTINCT FROM NEW.overflow_count
        OR OLD.manual_evidence_ids IS DISTINCT FROM NEW.manual_evidence_ids
        OR OLD.exception_ids IS DISTINCT FROM NEW.exception_ids
        OR OLD.feed_record_count IS DISTINCT FROM NEW.feed_record_count
        OR OLD.replica_lag_ms IS DISTINCT FROM NEW.replica_lag_ms
        OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
        OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
        OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
        OR OLD.ledger_seq IS DISTINCT FROM NEW.ledger_seq
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_evidence_snapshots_no_delete ON bastion_evidence_snapshots;
CREATE TRIGGER trg_bastion_evidence_snapshots_no_delete
    BEFORE DELETE ON bastion_evidence_snapshots
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_evidence_snapshots_no_truncate ON bastion_evidence_snapshots;
CREATE TRIGGER trg_bastion_evidence_snapshots_no_truncate
    BEFORE TRUNCATE ON bastion_evidence_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 12. bastion_manual_evidence. Uploaded files and self-attested statements. Content columns
-- are frozen once the row has left pending_scan/blocked (active, superseded, withdrawn); the
-- lifecycle columns listed in spec 3.4 stay writable. Never deleted.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_manual_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind varchar(32) NOT NULL,
    title varchar(512) NOT NULL,
    description text,
    source_system varchar(128),
    bin_asset_id uuid,
    bin_asset_version_id uuid,
    content_sha256 varchar(64),
    size_bytes bigint,
    content_type varchar(255),
    scan_label varchar(16),
    owner_user_id uuid,
    uploaded_by uuid NOT NULL,
    produced_on date,
    period_start date,
    period_end date,
    valid_until timestamptz,
    sensitivity varchar(16) NOT NULL DEFAULT 'standard',
    uploader_statement_at timestamptz,
    status varchar(16) NOT NULL DEFAULT 'pending_scan',
    blocked_reason varchar(48),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    superseded_by_id uuid REFERENCES bastion_manual_evidence(id) ON DELETE RESTRICT,
    withdrawn_reason varchar(48),
    withdrawn_by uuid,
    withdrawn_at timestamptz,
    redacted_at timestamptz,
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    ledger_seq bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_manual_evidence
        ADD CONSTRAINT bastion_manual_evidence_shape_check
        CHECK (
            kind IN ('file', 'attestation_statement')
            AND (scan_label IS NULL OR scan_label IN ('clean', 'not_scanned'))
            AND sensitivity IN ('standard', 'restricted')
            AND status IN ('pending_scan', 'active', 'superseded', 'withdrawn', 'blocked')
            AND (kind <> 'file' OR bin_asset_id IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_org_status
    ON bastion_manual_evidence (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_org_valid_until
    ON bastion_manual_evidence (organization_id, valid_until)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_pending
    ON bastion_manual_evidence (next_attempt_at)
    WHERE status = 'pending_scan';
CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_org_sha
    ON bastion_manual_evidence (organization_id, content_sha256);

DROP TRIGGER IF EXISTS trg_bastion_manual_evidence_updated_at ON bastion_manual_evidence;
CREATE TRIGGER trg_bastion_manual_evidence_updated_at
    BEFORE UPDATE ON bastion_manual_evidence
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Writable in normal operation (spec 3.4): status, blocked_reason, attempts, next_attempt_at,
-- superseded_by_id, withdrawn_reason, withdrawn_by, withdrawn_at, redacted_at, updated_at.
-- The WHEN clause names every other column.
DROP TRIGGER IF EXISTS trg_bastion_manual_evidence_no_update ON bastion_manual_evidence;
CREATE TRIGGER trg_bastion_manual_evidence_no_update
    BEFORE UPDATE ON bastion_manual_evidence
    FOR EACH ROW
    WHEN (
        OLD.status IN ('active', 'superseded', 'withdrawn')
        AND (
            OLD.id IS DISTINCT FROM NEW.id
            OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
            OR OLD.kind IS DISTINCT FROM NEW.kind
            OR OLD.title IS DISTINCT FROM NEW.title
            OR OLD.description IS DISTINCT FROM NEW.description
            OR OLD.source_system IS DISTINCT FROM NEW.source_system
            OR OLD.bin_asset_id IS DISTINCT FROM NEW.bin_asset_id
            OR OLD.bin_asset_version_id IS DISTINCT FROM NEW.bin_asset_version_id
            OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
            OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
            OR OLD.content_type IS DISTINCT FROM NEW.content_type
            OR OLD.scan_label IS DISTINCT FROM NEW.scan_label
            OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
            OR OLD.uploaded_by IS DISTINCT FROM NEW.uploaded_by
            OR OLD.produced_on IS DISTINCT FROM NEW.produced_on
            OR OLD.period_start IS DISTINCT FROM NEW.period_start
            OR OLD.period_end IS DISTINCT FROM NEW.period_end
            OR OLD.valid_until IS DISTINCT FROM NEW.valid_until
            OR OLD.sensitivity IS DISTINCT FROM NEW.sensitivity
            OR OLD.uploader_statement_at IS DISTINCT FROM NEW.uploader_statement_at
            OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
            OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
            OR OLD.ledger_seq IS DISTINCT FROM NEW.ledger_seq
            OR OLD.created_at IS DISTINCT FROM NEW.created_at
        )
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_manual_evidence_no_delete ON bastion_manual_evidence;
CREATE TRIGGER trg_bastion_manual_evidence_no_delete
    BEFORE DELETE ON bastion_manual_evidence
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_manual_evidence_no_truncate ON bastion_manual_evidence;
CREATE TRIGGER trg_bastion_manual_evidence_no_truncate
    BEFORE TRUNCATE ON bastion_manual_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 13. bastion_manual_evidence_links. Which manual evidence proves which assertion, and the
-- reviewer's verdict.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_manual_evidence_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    manual_evidence_id uuid NOT NULL REFERENCES bastion_manual_evidence(id) ON DELETE RESTRICT,
    assertion_id uuid NOT NULL REFERENCES bastion_assertions(id) ON DELETE CASCADE,
    review_verdict varchar(16) NOT NULL DEFAULT 'pending',
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    review_note text,
    small_team_self_review boolean NOT NULL DEFAULT false,
    linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    unlinked_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bastion_manual_evidence_links
        ADD CONSTRAINT bastion_manual_evidence_links_verdict_check
        CHECK (review_verdict IN ('pending', 'accepted', 'shows_exception'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_manual_evidence_links_unique
    ON bastion_manual_evidence_links (organization_id, manual_evidence_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_links_assertion
    ON bastion_manual_evidence_links (organization_id, assertion_id);

-- ──────────────────────────────────────────────────────────────────────
-- 14. bastion_evidence_feeds. A machine feed (API push or a Bolt event) with its daily quota.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_evidence_feeds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feed_key varchar(64) NOT NULL,
    label varchar(256) NOT NULL,
    feed_kind varchar(64),
    source_kind varchar(16) NOT NULL DEFAULT 'api_push',
    bolt_source varchar(32),
    bolt_event_type varchar(128),
    cadence_days integer NOT NULL DEFAULT 1,
    daily_record_quota integer NOT NULL DEFAULT 5000,
    quota_day date,
    records_on_quota_day integer NOT NULL DEFAULT 0,
    bytes_total bigint NOT NULL DEFAULT 0,
    status varchar(16) NOT NULL DEFAULT 'active',
    last_record_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_evidence_feeds
        ADD CONSTRAINT bastion_evidence_feeds_shape_check
        CHECK (
            source_kind IN ('api_push', 'bolt_event')
            AND status IN ('active', 'paused', 'retired')
            AND (source_kind <> 'bolt_event' OR (bolt_source IS NOT NULL AND bolt_event_type IS NOT NULL))
            AND cadence_days > 0
            AND daily_record_quota > 0
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_evidence_feeds_org_key
    ON bastion_evidence_feeds (organization_id, feed_key);

DROP TRIGGER IF EXISTS trg_bastion_evidence_feeds_updated_at ON bastion_evidence_feeds;
CREATE TRIGGER trg_bastion_evidence_feeds_updated_at
    BEFORE UPDATE ON bastion_evidence_feeds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The assertion -> feed FK deferred from 0274.
DO $$
BEGIN
    ALTER TABLE bastion_assertions
        ADD CONSTRAINT bastion_assertions_feed_id_fkey
        FOREIGN KEY (feed_id) REFERENCES bastion_evidence_feeds(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 15. bastion_feed_keys. Per-feed credentials (Blip ingest-key pattern): public key_id,
-- secret_hmac keyed by BASTION_FEED_KEY_PEPPER, 7-day rotation grace.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_feed_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feed_id uuid NOT NULL REFERENCES bastion_evidence_feeds(id) ON DELETE CASCADE,
    key_id varchar(64) NOT NULL,
    secret_hmac varchar(128) NOT NULL,
    fingerprint varchar(64),
    last4 varchar(8),
    label varchar(128),
    status varchar(16) NOT NULL DEFAULT 'active',
    grace_expires_at timestamptz,
    predecessor_id uuid REFERENCES bastion_feed_keys(id) ON DELETE SET NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bastion_feed_keys
        ADD CONSTRAINT bastion_feed_keys_status_check
        CHECK (status IN ('active', 'grace', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_feed_keys_key_id
    ON bastion_feed_keys (key_id);
CREATE INDEX IF NOT EXISTS idx_bastion_feed_keys_org_feed
    ON bastion_feed_keys (organization_id, feed_id, status);

-- ──────────────────────────────────────────────────────────────────────
-- 16. bastion_feed_records. Immutable; subject and attributes live in bastion_personal_data.
-- feed_key_id is the bastion_feed_keys row that authenticated the record.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_feed_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feed_id uuid NOT NULL REFERENCES bastion_evidence_feeds(id) ON DELETE RESTRICT,
    feed_key_id uuid REFERENCES bastion_feed_keys(id) ON DELETE RESTRICT,
    idempotency_key varchar(256) NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload_sha256 varchar(64) NOT NULL,
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    ledger_seq bigint,
    received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_feed_records_idempotency
    ON bastion_feed_records (organization_id, feed_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bastion_feed_records_feed_occurred
    ON bastion_feed_records (organization_id, feed_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_feed_records_no_update ON bastion_feed_records;
CREATE TRIGGER trg_bastion_feed_records_no_update
    BEFORE UPDATE ON bastion_feed_records
    FOR EACH ROW
    WHEN (
        OLD.id IS DISTINCT FROM NEW.id
        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.feed_id IS DISTINCT FROM NEW.feed_id
        OR OLD.feed_key_id IS DISTINCT FROM NEW.feed_key_id
        OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
        OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
        OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
        OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
        OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
        OR OLD.ledger_seq IS DISTINCT FROM NEW.ledger_seq
        OR OLD.received_at IS DISTINCT FROM NEW.received_at
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_feed_records_no_delete ON bastion_feed_records;
CREATE TRIGGER trg_bastion_feed_records_no_delete
    BEFORE DELETE ON bastion_feed_records
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_feed_records_no_truncate ON bastion_feed_records;
CREATE TRIGGER trg_bastion_feed_records_no_truncate
    BEFORE TRUNCATE ON bastion_feed_records
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 17. bastion_personal_data. Mutable by design: labels for the immutable holders, blanked by
-- the owner-only redaction route. Immutable rows keep only the HMAC commitment.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_personal_data (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    holder_kind varchar(24) NOT NULL,
    holder_id uuid NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    redacted_at timestamptz,
    redacted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    redaction_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_personal_data
        ADD CONSTRAINT bastion_personal_data_shape_check
        CHECK (
            holder_kind IN ('snapshot', 'manual_evidence', 'feed_record', 'attestation', 'exception')
            AND octet_length(data::text) <= 16384
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_personal_data_holder
    ON bastion_personal_data (organization_id, holder_kind, holder_id);

DROP TRIGGER IF EXISTS trg_bastion_personal_data_updated_at ON bastion_personal_data;
CREATE TRIGGER trg_bastion_personal_data_updated_at
    BEFORE UPDATE ON bastion_personal_data
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 18. bastion_ingest_events. Inbox for events Bastion consumes (Bolt dispatch hook), claimed
-- with a heartbeat lease.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_ingest_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source varchar(32) NOT NULL,
    event_type varchar(128) NOT NULL,
    source_idempotency_key varchar(256) NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'pending',
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_ingest_events
        ADD CONSTRAINT bastion_ingest_events_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed', 'dead'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_ingest_events_idempotency
    ON bastion_ingest_events (organization_id, source_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bastion_ingest_events_pending
    ON bastion_ingest_events (next_attempt_at, created_at)
    WHERE status IN ('pending', 'processing');

DROP TRIGGER IF EXISTS trg_bastion_ingest_events_updated_at ON bastion_ingest_events;
CREATE TRIGGER trg_bastion_ingest_events_updated_at
    BEFORE UPDATE ON bastion_ingest_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 19. bastion_outbox. Every outbound side effect (Bolt events, Bam task upserts and comments,
-- proposal closes, seal objects), delivered in ordering_key order.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind varchar(24) NOT NULL,
    ordering_key varchar(160) NOT NULL,
    idempotency_key varchar(256) NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    redrive_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    last_error text,
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_outbox
        ADD CONSTRAINT bastion_outbox_shape_check
        CHECK (
            kind IN ('bolt_event', 'bam_task_upsert', 'bam_task_comment', 'proposal_close', 'seal_object')
            AND status IN ('pending', 'delivered', 'dead')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_outbox_idempotency
    ON bastion_outbox (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_bastion_outbox_pending_order
    ON bastion_outbox (ordering_key, created_at)
    WHERE status = 'pending';

-- ──────────────────────────────────────────────────────────────────────
-- 20. bastion_ledger_entries. The per-org hash chain (spec 3.4). seq never repeats within an
-- org, across epochs: a provisional epoch continues numbering above the highest sealed seq.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_ledger_entries (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    epoch integer NOT NULL DEFAULT 1,
    seq bigint NOT NULL,
    entry_kind varchar(32) NOT NULL,
    entry_id uuid NOT NULL,
    content_sha256 varchar(64),
    personal_data_hmac varchar(64),
    pd_hmac_key_id varchar(64),
    prev_entry_hash varchar(64) NOT NULL,
    entry_hash varchar(64) NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (organization_id, seq)
);

DO $$
BEGIN
    ALTER TABLE bastion_ledger_entries
        ADD CONSTRAINT bastion_ledger_entries_shape_check
        CHECK (
            entry_kind IN ('snapshot', 'manual_evidence', 'withdrawal', 'feed_record',
                           'attestation', 'exception', 'redaction', 'restore')
            AND epoch >= 1
            AND seq >= 1
            AND prev_entry_hash ~ '^[0-9a-f]{64}$'
            AND entry_hash ~ '^[0-9a-f]{64}$'
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_ledger_entries_entry
    ON bastion_ledger_entries (organization_id, entry_kind, entry_id);
CREATE INDEX IF NOT EXISTS idx_bastion_ledger_entries_epoch_seq
    ON bastion_ledger_entries (organization_id, epoch, seq);

DROP TRIGGER IF EXISTS trg_bastion_ledger_entries_no_update ON bastion_ledger_entries;
CREATE TRIGGER trg_bastion_ledger_entries_no_update
    BEFORE UPDATE ON bastion_ledger_entries
    FOR EACH ROW
    WHEN (
        OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.epoch IS DISTINCT FROM NEW.epoch
        OR OLD.seq IS DISTINCT FROM NEW.seq
        OR OLD.entry_kind IS DISTINCT FROM NEW.entry_kind
        OR OLD.entry_id IS DISTINCT FROM NEW.entry_id
        OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
        OR OLD.personal_data_hmac IS DISTINCT FROM NEW.personal_data_hmac
        OR OLD.pd_hmac_key_id IS DISTINCT FROM NEW.pd_hmac_key_id
        OR OLD.prev_entry_hash IS DISTINCT FROM NEW.prev_entry_hash
        OR OLD.entry_hash IS DISTINCT FROM NEW.entry_hash
        OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_ledger_entries_no_delete ON bastion_ledger_entries;
CREATE TRIGGER trg_bastion_ledger_entries_no_delete
    BEFORE DELETE ON bastion_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_ledger_entries_no_truncate ON bastion_ledger_entries;
CREATE TRIGGER trg_bastion_ledger_entries_no_truncate
    BEFORE TRUNCATE ON bastion_ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 21. bastion_ledger_seals. One signed seal per org per UTC day. Only object_written_at and
-- published_at change after insert (outbox delivery stamps).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_ledger_seals (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    seal_date date NOT NULL,
    epoch integer NOT NULL,
    head_seq bigint NOT NULL,
    head_hash varchar(64) NOT NULL,
    signature text NOT NULL,
    signing_key_id varchar(64) NOT NULL,
    object_written_at timestamptz,
    published_at timestamptz,
    PRIMARY KEY (organization_id, seal_date)
);

DO $$
BEGIN
    ALTER TABLE bastion_ledger_seals
        ADD CONSTRAINT bastion_ledger_seals_shape_check
        CHECK (epoch >= 1 AND head_seq >= 0 AND head_hash ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_bastion_ledger_seals_no_update ON bastion_ledger_seals;
CREATE TRIGGER trg_bastion_ledger_seals_no_update
    BEFORE UPDATE ON bastion_ledger_seals
    FOR EACH ROW
    WHEN (
        OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.seal_date IS DISTINCT FROM NEW.seal_date
        OR OLD.epoch IS DISTINCT FROM NEW.epoch
        OR OLD.head_seq IS DISTINCT FROM NEW.head_seq
        OR OLD.head_hash IS DISTINCT FROM NEW.head_hash
        OR OLD.signature IS DISTINCT FROM NEW.signature
        OR OLD.signing_key_id IS DISTINCT FROM NEW.signing_key_id
    )
    EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_ledger_seals_no_delete ON bastion_ledger_seals;
CREATE TRIGGER trg_bastion_ledger_seals_no_delete
    BEFORE DELETE ON bastion_ledger_seals
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_ledger_seals_no_truncate ON bastion_ledger_seals;
CREATE TRIGGER trg_bastion_ledger_seals_no_truncate
    BEFORE TRUNCATE ON bastion_ledger_seals
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- ──────────────────────────────────────────────────────────────────────
-- 22. bastion_ledger_restores. A detected rewind of the ledger (spec 3.4). resolution stays
-- NULL while appends are blocked.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_ledger_restores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    detected_at timestamptz NOT NULL DEFAULT now(),
    db_head_seq bigint,
    bucket_seal_date date,
    bucket_epoch integer,
    bucket_head_seq bigint,
    bucket_head_hash varchar(64),
    lost_from_seq bigint,
    lost_to_seq bigint,
    provisional_epoch integer NOT NULL,
    object_key varchar(512),
    platform_restore_id uuid,
    status varchar(16) NOT NULL,
    resolution varchar(32),
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bastion_ledger_restores
        ADD CONSTRAINT bastion_ledger_restores_shape_check
        CHECK (
            status IN ('pending_ack', 'acknowledged', 'unmatched')
            AND (resolution IS NULL OR resolution IN ('restore_acknowledged', 'continue_unexplained'))
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_ledger_restores_org_detected
    ON bastion_ledger_restores (organization_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_ledger_restores_unresolved
    ON bastion_ledger_restores (organization_id)
    WHERE resolution IS NULL;
