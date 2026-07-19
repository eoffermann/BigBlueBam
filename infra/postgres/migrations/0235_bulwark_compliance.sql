-- 0235_bulwark_compliance.sql
-- Why: Bulwark compliance chain - lower-tier vendors (bulwark_vendor_tiers) and their
--   required/collected compliance docs (bulwark_compliance_docs) with separated collection
--   and validity lifecycles (D9). vendor_tier.contract_id is the compliance-read scoping
--   anchor (SH3); parent_tier_id models the flow-down chain. See
--   docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md sections 3.1, 3.4, 4.4.
-- Client impact: additive only. New tables; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_vendor_tiers (a lower-tier vendor in the compliance chain). contract_id is the
-- compliance-read scoping anchor; a null contract_id makes the tier owner/admin-only.
-- parent_tier_id self-FK added below. required_doc_types is RECOMPUTED each sweep (DI5).
-- vendor_type / vendor_id are dotted refs with NO cross-schema FK.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_vendor_tiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contract_id uuid REFERENCES bulwark_contracts(id) ON DELETE SET NULL,
    parent_tier_id uuid,
    vendor_type varchar(32),
    vendor_id uuid,
    tier_level smallint NOT NULL DEFAULT 1,
    required_doc_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    chase_status varchar(16) NOT NULL DEFAULT 'idle',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulwark_vendor_tiers_org_contract
    ON bulwark_vendor_tiers(organization_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_vendor_tiers_org_chase
    ON bulwark_vendor_tiers(organization_id, chase_status);
CREATE INDEX IF NOT EXISTS idx_bulwark_vendor_tiers_parent
    ON bulwark_vendor_tiers(parent_tier_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulwark_vendor_tiers_vendor
    ON bulwark_vendor_tiers(organization_id, contract_id, vendor_type, vendor_id);

-- ──────────────────────────────────────────────────────────────────────
-- bulwark_compliance_docs (one required/collected doc). collection_status and
-- validity_status are separate lifecycles (D9). bin_asset_id / blank_form_id are dotted refs
-- with NO cross-schema FK.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulwark_compliance_docs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    vendor_tier_id uuid NOT NULL REFERENCES bulwark_vendor_tiers(id) ON DELETE CASCADE,
    doc_type varchar(24) NOT NULL,
    collection_status varchar(16) NOT NULL DEFAULT 'missing',
    validity_status varchar(12) NOT NULL DEFAULT 'unknown',
    chase_status varchar(16) NOT NULL DEFAULT 'none',
    bin_asset_id uuid,
    effective_date date,
    expires_at date,
    chase_proposal_id uuid REFERENCES agent_proposals(id) ON DELETE SET NULL,
    blank_form_id uuid,
    last_chased_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_tier
    ON bulwark_compliance_docs(organization_id, vendor_tier_id);
CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_validity
    ON bulwark_compliance_docs(organization_id, validity_status);
CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_collection
    ON bulwark_compliance_docs(organization_id, collection_status);
CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_expires
    ON bulwark_compliance_docs(organization_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_type
    ON bulwark_compliance_docs(organization_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_bulwark_compliance_docs_proposal
    ON bulwark_compliance_docs(chase_proposal_id);

-- ──────────────────────────────────────────────────────────────────────
-- parent_tier_id self-FK declared after the table exists (guarded / idempotent).
-- ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE bulwark_vendor_tiers
        ADD CONSTRAINT fk_bulwark_vendor_tiers_parent
        FOREIGN KEY (parent_tier_id) REFERENCES bulwark_vendor_tiers(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via app.current_org_id GUC. Advisory until BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE bulwark_vendor_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_vendor_tiers_org_isolation ON bulwark_vendor_tiers;
CREATE POLICY bulwark_vendor_tiers_org_isolation ON bulwark_vendor_tiers
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE bulwark_compliance_docs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulwark_compliance_docs_org_isolation ON bulwark_compliance_docs;
CREATE POLICY bulwark_compliance_docs_org_isolation ON bulwark_compliance_docs
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);
