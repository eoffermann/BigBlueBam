-- 0284_bastion_evidence_expiry_markers.sql
-- Why: issue #220. bastion-evidence-expiry's only "already sent" marker was the outbox row's
--   idempotency key, and bastion-retention deletes delivered outbox rows after 30 days, so
--   evidence.expired (and the control re-evaluations it queues) re-fired about every month for
--   every item that ever expired, and the daily scan grew without bound. The marker now lives on
--   the evidence row itself (the Bond rotting_alerted_at pattern): expiring_notified_at and
--   expired_notified_at, set by a conditional UPDATE in the same transaction as the event, and
--   the engine only selects rows whose marker is still NULL. Both columns are operational, so the
--   0283 frozen-column guard is re-created with them on its allowed list (it is fail-closed, so
--   without this a new column would be frozen on an active row). Spec 3.3 and 7.2 of
--   docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md.
-- Client impact: additive only. Two nullable columns; the guard function keeps every existing
--   rule and allows two more operational columns.

ALTER TABLE bastion_manual_evidence
    ADD COLUMN IF NOT EXISTS expiring_notified_at timestamptz;

ALTER TABLE bastion_manual_evidence
    ADD COLUMN IF NOT EXISTS expired_notified_at timestamptz;

-- The engine's scan: active items with an expiry whose expired notice has not gone out yet.
CREATE INDEX IF NOT EXISTS idx_bastion_manual_evidence_expiry_pending
    ON bastion_manual_evidence (organization_id, valid_until)
    WHERE status = 'active' AND valid_until IS NOT NULL AND expired_notified_at IS NULL;

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
              'withdrawn_reason', 'withdrawn_by', 'withdrawn_at', 'redacted_at', 'updated_at',
              'expiring_notified_at', 'expired_notified_at']);
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

-- Hardening (spec 3.1, as 0279/0283): the replaced function is not callable by PUBLIC.
REVOKE ALL ON FUNCTION bastion_guard_manual_evidence_update() FROM PUBLIC;
