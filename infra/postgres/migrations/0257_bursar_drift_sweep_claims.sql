-- 0257_bursar_drift_sweep_claims.sql
-- Why: M8 bursar-drift-sweep is a bounded, resumable sweep (spec 15): an org cursor across ticks,
--   a per-tick row budget, and ROW CLAIMS WITH LEASE RENEWAL so two sweep workers never
--   double-evaluate the same spend event. That needs per-row sweep state on bursar_spend_events:
--   when a row was claimed (and by whom, for lease reclaim) and when its drift evaluation
--   completed. "Orgs with work" = orgs holding any spend event with drift_evaluated_at IS NULL,
--   which is the natural cursor; the partial index makes finding them cheap. bursar_spend_events
--   is a high-volume append table, so this is three nullable columns plus one partial index, not
--   a rewrite.
-- Client impact: additive only. Three nullable columns + one partial index on bursar_spend_events;
--   no changes to existing rows, constraints, or the dedup unique index.

DO $$
BEGIN
    ALTER TABLE bursar_spend_events ADD COLUMN IF NOT EXISTS drift_claimed_at timestamptz;
    ALTER TABLE bursar_spend_events ADD COLUMN IF NOT EXISTS drift_claimed_by varchar(64);
    ALTER TABLE bursar_spend_events ADD COLUMN IF NOT EXISTS drift_evaluated_at timestamptz;
END $$;

-- The sweep claims the oldest unevaluated rows per org; this partial index scopes the scan to just
-- the un-evaluated backlog so a fully-swept org costs nothing to skip.
CREATE INDEX IF NOT EXISTS idx_bursar_spend_events_drift_pending
    ON bursar_spend_events (organization_id, occurred_on)
    WHERE drift_evaluated_at IS NULL;
