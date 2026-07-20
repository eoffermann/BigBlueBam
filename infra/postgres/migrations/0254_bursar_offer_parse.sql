-- 0254_bursar_offer_parse.sql
-- Why: M4 deterministic offer parse. The offer row gains the parse audit columns the Stage-1
--   parser writes (normalization_error, parsed_at, page_count) and the unseal audit columns
--   (unsealed_at/by, unseal_reason) - the Bam activity_log is project-scoped (project_id NOT NULL)
--   and cannot represent an org-only bursar offer.unseal event, so the who/when/reason lives on the
--   row and the durable offer.unsealed Bolt event is the cross-app audit fan-out (spec 5.6/16/25).
--   This migration also CORRECTS three §4.3/§4.1 knob defaults that the M1 seed set off-spec: the
--   split-blanket attack (14 mandatory nodes over 4 lines) must trip a cumulative cap of 4, not
--   slip under 100, and the parse_quality floor is 0.35, not 0.40.
-- Client impact: additive only. New nullable columns; the default corrections update ONLY rows that
--   still hold the exact off-spec M1 default (an admin's customized value is never overwritten). No
--   column is dropped and no existing contract narrows.

-- ── 1. Offer parse + unseal audit columns. ────────────────────────────────────
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS normalization_error text;
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS parsed_at timestamptz;
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS unsealed_at timestamptz;
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS unsealed_by uuid;
ALTER TABLE bursar_offers ADD COLUMN IF NOT EXISTS unseal_reason text;

DO $$
BEGIN
    ALTER TABLE bursar_offers
        ADD CONSTRAINT bursar_offers_unsealed_by_fk
        FOREIGN KEY (unsealed_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Correct the §4.3 caps + §4.1 parse floor to their spec defaults. ────────
-- Set the column default for freshly-inserted org settings rows.
ALTER TABLE bursar_org_settings ALTER COLUMN blanket_fanout_cap SET DEFAULT 4;
ALTER TABLE bursar_org_settings ALTER COLUMN blanket_cumulative_cap SET DEFAULT 4;
ALTER TABLE bursar_org_settings ALTER COLUMN parse_quality_floor SET DEFAULT 0.3500;

-- Update existing rows ONLY where they still equal the exact off-spec M1 default, so a value an
-- admin deliberately chose is never clobbered.
UPDATE bursar_org_settings SET blanket_fanout_cap = 4 WHERE blanket_fanout_cap = 25;
UPDATE bursar_org_settings SET blanket_cumulative_cap = 4 WHERE blanket_cumulative_cap = 100;
UPDATE bursar_org_settings SET parse_quality_floor = 0.3500 WHERE parse_quality_floor = 0.4000;
