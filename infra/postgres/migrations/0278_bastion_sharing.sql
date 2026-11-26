-- 0278_bastion_sharing.sql
-- Why: Bastion sharing, spec section 4.1 tables 32-35: token-gated auditor rooms (180-day hard
--   cap, frozen restricted-evidence allowlist), the auditor access log, auditor requests, and
--   audit-packet export jobs. Also the access-log purge function and its age-guarded DELETE
--   trigger (spec 3.4). The spec numbers this file 0267; the tip had moved on.
-- Client impact: additive only. New tables, triggers and one function; no changes to existing
--   objects.
--
--   THE AGE PREDICATE IS THE GUARD. bastion_auditor_access_log rejects UPDATE and TRUNCATE,
--   and its DELETE trigger allows only rows with accessed_at older than two years.
--   bastion_purge_access_log(org) is the documented caller, but it is not what protects the
--   log: any session can set a custom GUC, and every service shares one database role today,
--   so a caller check would be theatre. A direct DELETE of a recent row fails regardless of
--   session settings (asserted by apps/bastion-api/test/db/immutability.test.ts).

-- ──────────────────────────────────────────────────────────────────────
-- 32. bastion_auditor_rooms. The bearer token is stored only as SHA-256; passcode is argon2.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_auditor_rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    framework_id uuid REFERENCES bastion_frameworks(id) ON DELETE SET NULL,
    label varchar(256) NOT NULL,
    token_sha256 varchar(64) NOT NULL,
    token_hint varchar(16),
    passcode_hash text,
    passcode_failures integer NOT NULL DEFAULT 0,
    locked_at timestamptz,
    unlocked_by uuid REFERENCES users(id) ON DELETE SET NULL,
    unlocked_at timestamptz,
    period_start date,
    period_end date,
    control_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    restricted_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    last_accessed_at timestamptz,
    access_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_auditor_rooms
        ADD CONSTRAINT bastion_auditor_rooms_expiry_check
        CHECK (expires_at <= created_at + interval '180 days');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_auditor_rooms_token
    ON bastion_auditor_rooms (token_sha256);
CREATE INDEX IF NOT EXISTS idx_bastion_auditor_rooms_org
    ON bastion_auditor_rooms (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_auditor_rooms_updated_at ON bastion_auditor_rooms;
CREATE TRIGGER trg_bastion_auditor_rooms_updated_at
    BEFORE UPDATE ON bastion_auditor_rooms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 33. bastion_auditor_access_log. Every auditor view. ip_hash only, user agent truncated.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_auditor_access_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    room_id uuid NOT NULL REFERENCES bastion_auditor_rooms(id) ON DELETE RESTRICT,
    accessed_at timestamptz NOT NULL DEFAULT now(),
    view_kind varchar(16) NOT NULL,
    object_ref varchar(256),
    ip_hash varchar(64),
    user_agent_trunc varchar(256)
);

DO $$
BEGIN
    ALTER TABLE bastion_auditor_access_log
        ADD CONSTRAINT bastion_auditor_access_log_view_kind_check
        CHECK (view_kind IN ('overview', 'control', 'evidence', 'download', 'request'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_auditor_access_log_room
    ON bastion_auditor_access_log (organization_id, room_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_auditor_access_log_age
    ON bastion_auditor_access_log (organization_id, accessed_at);

CREATE OR REPLACE FUNCTION bastion_access_log_delete_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF OLD.accessed_at >= now() - interval '2 years' THEN
        RAISE EXCEPTION
            'BASTION_ACCESS_LOG_RETAINED: auditor access log rows are kept for two years (row accessed at %)',
            OLD.accessed_at
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_bastion_auditor_access_log_no_update ON bastion_auditor_access_log;
CREATE TRIGGER trg_bastion_auditor_access_log_no_update
    BEFORE UPDATE ON bastion_auditor_access_log
    FOR EACH ROW EXECUTE FUNCTION bastion_reject_mutation();

DROP TRIGGER IF EXISTS trg_bastion_auditor_access_log_age_delete ON bastion_auditor_access_log;
CREATE TRIGGER trg_bastion_auditor_access_log_age_delete
    BEFORE DELETE ON bastion_auditor_access_log
    FOR EACH ROW EXECUTE FUNCTION bastion_access_log_delete_guard();

DROP TRIGGER IF EXISTS trg_bastion_auditor_access_log_no_truncate ON bastion_auditor_access_log;
CREATE TRIGGER trg_bastion_auditor_access_log_no_truncate
    BEFORE TRUNCATE ON bastion_auditor_access_log
    FOR EACH STATEMENT EXECUTE FUNCTION bastion_reject_mutation();

-- The documented purge path (run by the bastion-retention job per org). SECURITY DEFINER so
-- it works under BBB_RLS_ENFORCE=1 without an org GUC; the trigger above still enforces the
-- two-year floor on every row it touches.
CREATE OR REPLACE FUNCTION bastion_purge_access_log(p_org uuid)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM bastion_auditor_access_log
    WHERE organization_id = p_org
      AND accessed_at < now() - interval '2 years';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 34. bastion_auditor_requests. An auditor's question from inside the room.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_auditor_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    room_id uuid NOT NULL REFERENCES bastion_auditor_rooms(id) ON DELETE CASCADE,
    control_id uuid REFERENCES bastion_controls(id) ON DELETE SET NULL,
    requester_name varchar(256),
    body varchar(5000) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'open',
    answered_by uuid REFERENCES users(id) ON DELETE SET NULL,
    answer_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_auditor_requests
        ADD CONSTRAINT bastion_auditor_requests_status_check
        CHECK (status IN ('open', 'answered', 'closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_auditor_requests_room
    ON bastion_auditor_requests (organization_id, room_id, status);

DROP TRIGGER IF EXISTS trg_bastion_auditor_requests_updated_at ON bastion_auditor_requests;
CREATE TRIGGER trg_bastion_auditor_requests_updated_at
    BEFORE UPDATE ON bastion_auditor_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 35. bastion_export_packets. The streamed audit packet job.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_export_packets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    framework_id uuid REFERENCES bastion_frameworks(id) ON DELETE SET NULL,
    period_start date,
    period_end date,
    include_restricted boolean NOT NULL DEFAULT false,
    status varchar(16) NOT NULL DEFAULT 'queued',
    stage varchar(32),
    stage_progress integer NOT NULL DEFAULT 0,
    object_key varchar(512),
    content_sha256 varchar(64),
    size_bytes bigint,
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_export_packets
        ADD CONSTRAINT bastion_export_packets_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_export_packets_org
    ON bastion_export_packets (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_bastion_export_packets_updated_at ON bastion_export_packets;
CREATE TRIGGER trg_bastion_export_packets_updated_at
    BEFORE UPDATE ON bastion_export_packets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- Hardening loop (spec 3.1), same as 0274: no PUBLIC execute on any bastion_% function;
-- SECURITY DEFINER ones granted to bam_app only when that role exists.
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
