-- 0253_bursar_scope_derivation.sql
-- Why: M3 scope derivation and the confirmed tree. The scope_status state machine is
--   pending -> deriving -> derived -> confirmed, so 'pending' must be an allowed value (the
--   reaper reverts a wedged 'deriving' request back to 'pending'). The derivation engine tracks
--   which chunks it could not read (failed_chunks) so a partial run can surface "we could not
--   read N sections". The reaper also unwedges offers stuck 'parsing' (normalization_status,
--   whose full semantics land in M4). Finally, the built-in scope library is seeded as GLOBAL
--   rows so apply-library has content out of the box.
-- Client impact: additive only. One CHECK is widened (never narrowed); two columns are added
--   with safe defaults; global library rows are inserted idempotently. No existing row changes
--   meaning and no client contract is broken.

-- ── 1. Widen the scope_status CHECK to admit 'pending' (spec 3.2). ─────────────
ALTER TABLE bursar_requests DROP CONSTRAINT IF EXISTS bursar_requests_scope_status_check;
DO $$
BEGIN
    ALTER TABLE bursar_requests
        ADD CONSTRAINT bursar_requests_scope_status_check
        CHECK (scope_status IN ('none', 'pending', 'deriving', 'derived', 'confirmed', 'awarded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Track chunks the derivation could not read, for the partial-run surface. ─
ALTER TABLE bursar_extraction_runs
    ADD COLUMN IF NOT EXISTS failed_chunks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ── 3. Offer normalization status, so the reaper can unwedge a stuck parse (M4). ─
ALTER TABLE bursar_offers
    ADD COLUMN IF NOT EXISTS normalization_status varchar(16);

CREATE INDEX IF NOT EXISTS idx_bursar_offers_org_normalization
    ON bursar_offers(organization_id, normalization_status)
    WHERE normalization_status IS NOT NULL;

-- ── 4. Seed the built-in scope library as GLOBAL rows (organization_id NULL, is_global). ─
-- Idempotent: guarded by the (category, lower(title)) WHERE is_global partial unique index via
-- an explicit NOT EXISTS. The immutability trigger permits this because a migration runs with no
-- app.current_org_id GUC bound (current_setting returns '' -> NULL -> not an org caller).
DO $$
DECLARE
    r record;
    seeds jsonb := '[
      {"category":"procurement_general","title":"Installation and commissioning","strength":"mandatory","unit":"job"},
      {"category":"procurement_general","title":"Acceptance testing","strength":"mandatory","unit":"job"},
      {"category":"procurement_general","title":"On-site training","strength":"mandatory","unit":"session"},
      {"category":"procurement_general","title":"Warranty (24 months)","strength":"should_have","unit":"months"},
      {"category":"procurement_general","title":"Documentation and handover","strength":"should_have","unit":"set"},
      {"category":"procurement_general","title":"Spares and consumables","strength":"nice_to_have","unit":"lot"},
      {"category":"it_saas","title":"Data export on termination","strength":"mandatory","unit":"export"},
      {"category":"it_saas","title":"Uptime SLA","strength":"mandatory","unit":"pct"},
      {"category":"it_saas","title":"Support and escalation","strength":"should_have","unit":"tier"},
      {"category":"it_saas","title":"Onboarding and migration","strength":"should_have","unit":"project"},
      {"category":"it_saas","title":"Security review (SOC 2 / equivalent)","strength":"should_have","unit":"report"},
      {"category":"it_saas","title":"Price escalation cap","strength":"nice_to_have","unit":"pct"}
    ]'::jsonb;
BEGIN
    FOR r IN SELECT * FROM jsonb_to_recordset(seeds)
        AS x(category text, title text, strength text, unit text)
    LOOP
        INSERT INTO bursar_scope_library
            (organization_id, is_global, category, title, node_kind, normative_strength, unit)
        SELECT NULL, true, r.category, r.title, 'requirement', r.strength, r.unit
        WHERE NOT EXISTS (
            SELECT 1 FROM bursar_scope_library
             WHERE is_global AND category = r.category AND lower(title) = lower(r.title)
        );
    END LOOP;
END $$;
