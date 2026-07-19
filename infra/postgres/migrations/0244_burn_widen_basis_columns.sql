-- 0244_burn_widen_basis_columns.sql
-- Why: Three burn columns were created too narrow to hold their OWN declared enum values,
--   so the widest legal value in each case would fail on insert with 22001 (value too long).
--   Caught by the section 12.1 live-constraint tests in apps/burn-api/test/, which insert
--   every legal enum value rather than a representative one. The widths came straight from
--   the design spec's section 3.1 tables, so this is a spec defect, not a transcription
--   slip; the spec has been noted accordingly.
--     burn_engagements.envelope_basis   varchar(16) < 'time_and_materials'        (18)
--     burn_engagement_rollups.revenue_basis varchar(24) < 'billable_recognized_capped' (26)
--                                                       and 'contract_value_per_period'  (25)
--     burn_prechecks.advisory_feedback  varchar(16) < 'would_have_mapped'         (17)
--   Every one of these is load-bearing. envelope_basis drives the revenue_basis branch that
--   spec 1.2.1 exists to get right, so a T&M engagement could not be created at all.
--   revenue_basis could not represent a not_to_exceed or retainer chain, which are exactly
--   the two bases round 2 and round 3 added. advisory_feedback could not store the
--   member-writable 'would_have_mapped' value that R2-S7 split out specifically so members
--   would stop getting 403s on the inline control.
-- Client impact: additive only. Widening a varchar is a metadata-only change in Postgres
--   (no table rewrite, no lock beyond ACCESS EXCLUSIVE for the catalog update), and every
--   existing value remains valid. No data is truncated or rewritten. The CHECK constraints
--   that close each enum are untouched.

-- Widen only if still narrow, so the file is safe to re-run against a DB that already has
-- the wider type.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'burn_engagements'
          AND column_name = 'envelope_basis'
          AND character_maximum_length < 24
    ) THEN
        ALTER TABLE burn_engagements ALTER COLUMN envelope_basis TYPE varchar(24);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'burn_engagement_rollups'
          AND column_name = 'revenue_basis'
          AND character_maximum_length < 32
    ) THEN
        ALTER TABLE burn_engagement_rollups ALTER COLUMN revenue_basis TYPE varchar(32);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'burn_prechecks'
          AND column_name = 'advisory_feedback'
          AND character_maximum_length < 24
    ) THEN
        ALTER TABLE burn_prechecks ALTER COLUMN advisory_feedback TYPE varchar(24);
    END IF;
END $$;
