-- 0236_bulwark_deadline_arm_components.sql
-- Why: Amendment supersession (Bulwark spec §4.1 / STJ4) must recompute the SUCCESSOR
--   event-armed key IN PLACE, not merely re-point a deadline. The event arm key is
--   uuid5(obligation_id || scope_entity_id || state_epoch); on a restate the obligation_id
--   changes but the scope entity and state epoch do not, so the successor key is
--   uuid5(successor_id || same scope entity || same epoch). Persisting the two arm-key
--   components on each deadline row lets the re-point transaction recompute the exact
--   successor key deterministically instead of leaving the stale predecessor key, which the
--   next state-reconcile tick would otherwise double-arm.
-- Client impact: additive only. Two nullable columns; existing rows are backfilled lazily by
--   the firing drain / state-reconcile as they re-arm. No column is dropped or tightened.

ALTER TABLE bulwark_notice_deadlines
    ADD COLUMN IF NOT EXISTS arm_scope_entity_id uuid;

ALTER TABLE bulwark_notice_deadlines
    ADD COLUMN IF NOT EXISTS arm_state_epoch varchar(64);
