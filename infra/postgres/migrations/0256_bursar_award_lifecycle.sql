-- 0256_bursar_award_lifecycle.sql
-- Why: M7 award lifecycle. bursar_awards froze at 0249 with only a status column; recording
--   WHO/WHEN/WHY an award was terminated, and WHEN a predecessor was superseded by an
--   amendment, needs four additive nullable stamps. The baseline itself stays immutable (its
--   four-path triggers live in 0249 and are untouched here) - these columns live on the award
--   header, not the frozen ledger.
-- Client impact: additive only. Four nullable columns on bursar_awards; no changes to existing
--   rows, constraints, or the baseline immutability triggers.

DO $$
BEGIN
    ALTER TABLE bursar_awards ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
    ALTER TABLE bursar_awards ADD COLUMN IF NOT EXISTS terminated_at timestamptz;
    ALTER TABLE bursar_awards ADD COLUMN IF NOT EXISTS terminated_by uuid;
    ALTER TABLE bursar_awards ADD COLUMN IF NOT EXISTS terminated_reason text;
END $$;

DO $$
BEGIN
    ALTER TABLE bursar_awards
        ADD CONSTRAINT bursar_awards_terminated_by_fk
        FOREIGN KEY (terminated_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
