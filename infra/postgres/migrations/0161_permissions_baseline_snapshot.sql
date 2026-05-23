-- 0161_permissions_baseline_snapshot.sql
-- Why: Wave F.1.a SuperUser permissions editor reset target. The
--   permission_group_defaults rows that exist immediately after migrations
--   0146/0156/0157/0158 form the canonical "factory" defaults; the editor
--   needs a stable copy of that state so the per-group `reset` endpoint
--   can restore baseline without recomputing it from the original seed
--   logic on every call. This migration creates a sibling table that
--   mirrors permission_group_defaults's shape and snapshots the current
--   state into it.
-- Client impact: additive only. No effect on existing reads or writes.
--   The new table is consulted only by the
--   POST /superuser/permissions/groups/:id/reset handler (also Wave F.1.a).

-- ──────────────────────────────────────────────────────────────────────
-- Baseline snapshot table. Mirrors permission_group_defaults (group_id,
-- permission_id, granted) and adds snapshot_at so future re-snapshots
-- can be diffed against the original. Same PK shape so a per-group reset
-- is a single DELETE + INSERT...SELECT.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS permission_group_defaults_baseline (
    group_id uuid NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
    permission_id text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted boolean NOT NULL,
    snapshot_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_perm_group_defaults_baseline_group
    ON permission_group_defaults_baseline (group_id);

-- ──────────────────────────────────────────────────────────────────────
-- Seed the baseline from the current state of permission_group_defaults.
-- ON CONFLICT DO NOTHING keeps this migration idempotent on re-runs and
-- guards against the (rare) case where an operator restores from backup
-- and reapplies migrations against a DB that already has the baseline.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO permission_group_defaults_baseline (group_id, permission_id, granted, snapshot_at)
SELECT group_id, permission_id, granted, now()
FROM permission_group_defaults
ON CONFLICT (group_id, permission_id) DO NOTHING;
