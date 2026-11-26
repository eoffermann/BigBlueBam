-- 0283_bastion_frozen_status_transitions.sql
-- Why: issue #184. The immutability triggers on bastion_assertions (0274), bastion_manual_evidence
--   (0275) and bastion_exceptions (0276) only fired while the row sat in a frozen status, and the
--   status column itself stayed writable in any direction, so a frozen row could be stepped back
--   to an editable status, edited, and re-frozen without any trigger firing. This file replaces
--   those three BEFORE UPDATE triggers with guard functions that lock the status transition AND
--   the frozen columns in one place. Spec: docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md
--   sections 2.1 (confirmed assertions are content-immutable), 2.6 (approved exceptions are
--   immutable), 3.3 (withdrawal and redaction) and 3.4 (four-path immutability).
--   The same file carries three other Bastion schema fixes from the same review batch, so the
--   M3+ writers land on one settled contract: #189 adds 'superseded' to bastion_outbox status
--   (spec 7.2 operator re-drive), #188 gives exception-expiry drift its own idempotency key
--   (bastion_drift_events.exception_id + partial unique index), and #187 adds
--   bastion_resume_partial_run(), the conditional in-place resume spec 7.3 now requires.
-- Client impact: none for any correct writer. Rejects only writes that were already forbidden by
--   the spec: a status regression out of a frozen status, or a change to a frozen column. The
--   outbox CHECK is widened, drift_events gains one nullable column, one function is added.
--
--   Once a row reaches a frozen status it may only move forward:
--     bastion_assertions.review_status   confirmed  -> confirmed | superseded
--                                        superseded -> superseded
--     bastion_manual_evidence.status     active     -> active | superseded | withdrawn
--                                        superseded -> superseded | withdrawn (redaction, 3.3)
--                                        withdrawn  -> withdrawn
--     bastion_exceptions.status          active     -> active | expired (expiry or revocation)
--                                        expired    -> expired
--
--   Frozen columns are FAIL-CLOSED: every column is frozen except the documented operational
--   ones, so a column added by a later migration is frozen until that migration says otherwise.
--     bastion_assertions       review_status, updated_at; confirmed_by, created_by,
--                              supersedes_id and compile_run_id may change only to NULL (their
--                              FKs are ON DELETE SET NULL, and that action is an UPDATE).
--     bastion_manual_evidence  spec 3.4 list: status, blocked_reason, attempts, next_attempt_at,
--                              superseded_by_id, withdrawn_reason, withdrawn_by, withdrawn_at,
--                              redacted_at, updated_at.
--     bastion_exceptions       spec 3.4 list: status, updated_at.
--
--   Hardening matches 0279: SET search_path = pg_catalog, public, pg_temp on every function,
--   EXECUTE revoked from PUBLIC by the loop at the end (trigger functions need no EXECUTE grant
--   to fire). None of these is SECURITY DEFINER. The rejection keeps the BASTION_IMMUTABLE prefix
--   and ERRCODE restrict_violation of bastion_reject_mutation() so callers see one error shape.

-- ──────────────────────────────────────────────────────────────────────
-- Helper: the keys whose values differ between OLD and NEW, ignoring the allowed ones.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_changed_columns(p_old jsonb, p_new jsonb, p_allowed text[])
    RETURNS text[]
    LANGUAGE sql
    IMMUTABLE
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[])
      FROM (
            SELECT jsonb_object_keys(p_old) AS k
            UNION
            SELECT jsonb_object_keys(p_new)
           ) keys
     WHERE NOT (k = ANY (p_allowed))
       AND (p_old -> k) IS DISTINCT FROM (p_new -> k);
$$;

-- ──────────────────────────────────────────────────────────────────────
-- bastion_assertions
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_guard_assertion_update()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_changed text[];
    v_bad text[];
BEGIN
    IF NOT (
        (OLD.review_status = 'confirmed' AND NEW.review_status IN ('confirmed', 'superseded'))
        OR (OLD.review_status = 'superseded' AND NEW.review_status = 'superseded')
    ) THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_assertions review_status may not move from % to %',
            OLD.review_status, NEW.review_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    v_changed := bastion_changed_columns(
        to_jsonb(OLD), to_jsonb(NEW), ARRAY['review_status', 'updated_at']);
    -- FK ON DELETE SET NULL columns: clearing is allowed, any other change is not.
    SELECT coalesce(array_agg(c), '{}'::text[]) INTO v_bad
      FROM unnest(v_changed) AS c
     WHERE NOT (
            c IN ('confirmed_by', 'created_by', 'supersedes_id', 'compile_run_id')
            AND (to_jsonb(NEW) -> c) = 'null'::jsonb
           );
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_assertions row is %; columns % are frozen',
            OLD.review_status, array_to_string(v_bad, ', ')
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bastion_assertions_content_immutable ON bastion_assertions;
CREATE TRIGGER trg_bastion_assertions_content_immutable
    BEFORE UPDATE ON bastion_assertions
    FOR EACH ROW
    WHEN (OLD.review_status IN ('confirmed', 'superseded'))
    EXECUTE FUNCTION bastion_guard_assertion_update();

-- ──────────────────────────────────────────────────────────────────────
-- bastion_manual_evidence
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_guard_manual_evidence_update()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_bad text[];
BEGIN
    IF NOT (
        (OLD.status = 'active' AND NEW.status IN ('active', 'superseded', 'withdrawn'))
        OR (OLD.status = 'superseded' AND NEW.status IN ('superseded', 'withdrawn'))
        OR (OLD.status = 'withdrawn' AND NEW.status = 'withdrawn')
    ) THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_manual_evidence status may not move from % to %',
            OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    v_bad := bastion_changed_columns(
        to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['status', 'blocked_reason', 'attempts', 'next_attempt_at', 'superseded_by_id',
              'withdrawn_reason', 'withdrawn_by', 'withdrawn_at', 'redacted_at', 'updated_at']);
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_manual_evidence row is %; columns % are frozen',
            OLD.status, array_to_string(v_bad, ', ')
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bastion_manual_evidence_no_update ON bastion_manual_evidence;
CREATE TRIGGER trg_bastion_manual_evidence_no_update
    BEFORE UPDATE ON bastion_manual_evidence
    FOR EACH ROW
    WHEN (OLD.status IN ('active', 'superseded', 'withdrawn'))
    EXECUTE FUNCTION bastion_guard_manual_evidence_update();

-- ──────────────────────────────────────────────────────────────────────
-- bastion_exceptions
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_guard_exception_update()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_bad text[];
BEGIN
    IF NOT (
        (OLD.status = 'active' AND NEW.status IN ('active', 'expired'))
        OR (OLD.status = 'expired' AND NEW.status = 'expired')
    ) THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_exceptions status may not move from % to %',
            OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    v_bad := bastion_changed_columns(to_jsonb(OLD), to_jsonb(NEW), ARRAY['status', 'updated_at']);
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION
            'BASTION_IMMUTABLE: bastion_exceptions row is %; columns % are frozen',
            OLD.status, array_to_string(v_bad, ', ')
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bastion_exceptions_no_update ON bastion_exceptions;
CREATE TRIGGER trg_bastion_exceptions_no_update
    BEFORE UPDATE ON bastion_exceptions
    FOR EACH ROW
    WHEN (OLD.status IN ('active', 'expired'))
    EXECUTE FUNCTION bastion_guard_exception_update();

-- ──────────────────────────────────────────────────────────────────────
-- #189: bastion_outbox status gains 'superseded'. Spec 7.2 bastion-outbox-drain: an operator
-- re-drive of a dead row whose key already delivered a newer row of the same kind marks it
-- superseded instead of replaying it. bastion-retention prunes superseded rows with delivered.
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'bastion_outbox_shape_check'
           AND conrelid = 'bastion_outbox'::regclass
           AND pg_get_constraintdef(oid) LIKE '%superseded%'
    ) THEN
        ALTER TABLE bastion_outbox DROP CONSTRAINT IF EXISTS bastion_outbox_shape_check;
        ALTER TABLE bastion_outbox
            ADD CONSTRAINT bastion_outbox_shape_check
            CHECK (
                kind IN ('bolt_event', 'bam_task_upsert', 'bam_task_comment', 'proposal_close', 'seal_object')
                AND status IN ('pending', 'delivered', 'dead', 'superseded')
            );
    END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- #188: exception-expiry drift idempotency. Run-driven drift is unique on
-- (organization_id, evaluation_run_id, control_id); exception-expiry drift has a NULL run id,
-- which that index never constrains. exception_id names the exception whose expiry (or
-- revocation) caused the drift, and the partial unique index makes the write idempotent.
-- Required writer behavior (bastion-evidence-expiry, M6), in ONE transaction:
--   1. UPDATE bastion_exceptions SET status = 'expired' WHERE id = $1 AND status = 'active'
--      RETURNING id  -- the compare-and-set; zero rows means another attempt already ran;
--   2. INSERT INTO bastion_drift_events (..., exception_id, reason) VALUES (..., $1,
--      'exception_expired') ON CONFLICT (organization_id, exception_id, control_id)
--      WHERE exception_id IS NOT NULL DO NOTHING RETURNING id;
--   3. write the control.drifted and task-upsert outbox rows ONLY when step 2 returned a row,
--      with idempotency_key 'drift:exception:<exception_id>:<kind>' as a backstop.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE bastion_drift_events
    ADD COLUMN IF NOT EXISTS exception_id uuid REFERENCES bastion_exceptions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_drift_events_exception
    ON bastion_drift_events (organization_id, exception_id, control_id)
    WHERE exception_id IS NOT NULL;

DO $$
BEGIN
    ALTER TABLE bastion_drift_events
        ADD CONSTRAINT bastion_drift_events_cause_check
        CHECK (
            NOT (evaluation_run_id IS NOT NULL AND exception_id IS NOT NULL)
            AND (reason <> 'exception_expired' OR exception_id IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- #187: the in-place resume of a partial nightly run (spec 7.3). idx_bastion_evaluation_runs_one_full
-- allows one queued/running scope='all' run per org, and a manual or agent full run may have
-- started after the nightly run went partial. A plain UPDATE ... SET status = 'queued' then
-- raises 23505 and, inside a multi-org tick transaction, aborts every org's claim. This function
-- is the only sanctioned resume: it re-queues only when no full run is live, and its exception
-- block is an implicit savepoint, so a race with a concurrent insert returns false instead of
-- aborting the caller's transaction. false means "not now"; the next tick retries. Invoker
-- rights, so RLS still binds; the caller must be in runInOrgScope for the run's org.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bastion_resume_partial_run(p_run_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    UPDATE bastion_evaluation_runs r
       SET status = 'queued',
           claimed_by = NULL,
           heartbeat_at = NULL,
           partial_reason = NULL,
           resume_count = r.resume_count + 1
     WHERE r.id = p_run_id
       AND r.status = 'partial'
       AND r.trigger = 'nightly'
       AND r.resume_count < 3
       AND NOT EXISTS (
            SELECT 1 FROM bastion_evaluation_runs x
             WHERE x.organization_id = r.organization_id
               AND x.scope = 'all'
               AND x.status IN ('queued', 'running')
       )
       -- A restore_pending partial (spec 3.4) waits until the restore row is resolved.
       AND NOT EXISTS (
            SELECT 1 FROM bastion_ledger_restores lr
             WHERE lr.organization_id = r.organization_id
               AND lr.resolution IS NULL
       )
    RETURNING r.id INTO v_id;
    RETURN v_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────
-- Hardening loop (spec 3.1, same as 0279): REVOKE ALL ... FROM PUBLIC on every bastion_%
-- function, and the guarded GRANT EXECUTE ... TO bam_app on SECURITY DEFINER ones only.
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
