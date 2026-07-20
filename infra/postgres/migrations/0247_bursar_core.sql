-- 0247_bursar_core.sql
-- Why: Bursar (AI bid-leveling, scope derivation, and post-award drift monitor) core
--   tables - vendors and Bursar's own payee-alias resolution (NOT Braid's), RFQ requests
--   with the injection-scan flags and pinned Bin asset version, the derived scope tree with
--   a guarded self-FK and soft-archive semantics, the GLOBAL built-in scope library
--   (organization_id IS NULL, is_global) with an org-caller immutability trigger, per-org
--   settings (thresholds, lexicons, caps), and the extraction-run audit with heartbeat/claim
--   lease columns. Also seeds the "Bursar System" service-account user that autonomous
--   worker actions and direct agent_proposals inserts (actor_id NOT NULL) attribute to, as
--   0234_bulwark_core.sql / 0239_burn_core.sql do. See
--   docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md sections 6.1, 5, 17.
-- Client impact: additive only. New tables + one sentinel service user; no changes to
--   existing objects.

-- Trigram matching on normalized payee strings (spec 6.1). pg_trgm is already present for
-- burn's title trigram index; the guard keeps this migration safe on a fresh DB.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ──────────────────────────────────────────────────────────────────────
-- bursar_vendors. braid_profile_id / bond_company_id are dotted cross-app refs with NO
-- cross-schema FK (the entity_links convention). owner_user_id SET NULL so an owner's
-- departure never blocks a delete.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_vendors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    display_name varchar(512) NOT NULL,
    braid_profile_id uuid,
    bond_company_id uuid,
    category varchar(64),
    criticality varchar(16) NOT NULL DEFAULT 'standard',
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status varchar(16) NOT NULL DEFAULT 'active',
    notes text,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_vendors
        ADD CONSTRAINT bursar_vendors_status_check
        CHECK (status IN ('active', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Case-insensitive name uniqueness per org (spec 6.1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_vendors_org_name
    ON bursar_vendors(organization_id, lower(display_name));
CREATE INDEX IF NOT EXISTS idx_bursar_vendors_org_status
    ON bursar_vendors(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_vendors_org_braid
    ON bursar_vendors(organization_id, braid_profile_id);
CREATE INDEX IF NOT EXISTS idx_bursar_vendors_org_bond
    ON bursar_vendors(organization_id, bond_company_id);

DROP TRIGGER IF EXISTS trg_bursar_vendors_updated_at ON bursar_vendors;
CREATE TRIGGER trg_bursar_vendors_updated_at
    BEFORE UPDATE ON bursar_vendors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_payee_aliases. Payee resolution is Bursar's OWN, not Braid's (spec 6.1): a payee
-- string is not a Braid source_type and braid mints a fresh singleton per unseen pair, the
-- opposite of dedup. Trigram over normalized_payee drives fuzzy match; unmatched spend keeps
-- vendor_id NULL. Unique (organization_id, normalized_payee) is the dedup key.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_payee_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE CASCADE,
    raw_payee varchar(512) NOT NULL,
    normalized_payee varchar(512) NOT NULL,
    source varchar(24) NOT NULL DEFAULT 'auto',
    confidence numeric(5,4),
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_payee_aliases_norm
    ON bursar_payee_aliases(organization_id, normalized_payee);
CREATE INDEX IF NOT EXISTS idx_bursar_payee_aliases_vendor
    ON bursar_payee_aliases(organization_id, vendor_id);
-- Trigram index for fuzzy payee resolution (spec 6.1). GIN gin_trgm_ops, same idiom as
-- burn's title trigram.
CREATE INDEX IF NOT EXISTS idx_bursar_payee_aliases_norm_trgm
    ON bursar_payee_aliases USING gin(normalized_payee gin_trgm_ops);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_requests. The RFQ / scoping request. injection_suspected + injection_signals carry
-- the pre-scan result on the request document (spec 5.5): confirm is blocked while
-- suspected. bin_asset_id + bin_asset_version_id PIN the exact bytes parsed (spec 5.8), and
-- source_doc_hash records what was read. scope_status drives the derive/confirm lifecycle.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title varchar(512) NOT NULL,
    description text,
    status varchar(16) NOT NULL DEFAULT 'draft',
    source_format varchar(24),
    bin_asset_id uuid,
    bin_asset_version_id uuid,
    source_doc_hash varchar(64),
    scope_status varchar(16) NOT NULL DEFAULT 'none',
    scope_confirmed_at timestamptz,
    scope_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    injection_suspected boolean NOT NULL DEFAULT false,
    injection_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_requests
        ADD CONSTRAINT bursar_requests_scope_status_check
        CHECK (scope_status IN ('none', 'deriving', 'derived', 'confirmed', 'awarded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_requests_org_status
    ON bursar_requests(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_requests_org_scope_status
    ON bursar_requests(organization_id, scope_status);
CREATE INDEX IF NOT EXISTS idx_bursar_requests_org_bin_asset
    ON bursar_requests(organization_id, bin_asset_id);

DROP TRIGGER IF EXISTS trg_bursar_requests_updated_at ON bursar_requests;
CREATE TRIGGER trg_bursar_requests_updated_at
    BEFORE UPDATE ON bursar_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_extraction_runs. Created before bursar_scope_nodes so the node extraction_run_id
-- FK can be inline. Never purged (audit). status covers the full lifecycle including
-- blocked (injection) and rejected_limits (cap exceeded). last_processed_chunk resumes a
-- retry; heartbeat_at + claimed_by are the lease so a reaper reclaims only cold runs.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_extraction_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id uuid NOT NULL REFERENCES bursar_requests(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'running',
    chunk_count integer,
    last_processed_chunk integer NOT NULL DEFAULT -1,
    chunks_failed integer NOT NULL DEFAULT 0,
    nodes_extracted integer NOT NULL DEFAULT 0,
    low_confidence_count integer NOT NULL DEFAULT 0,
    llm_calls_used integer NOT NULL DEFAULT 0,
    source_doc_hash varchar(64),
    provider_id uuid,
    claimed_by varchar(64),
    heartbeat_at timestamptz,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bursar_extraction_runs
        ADD CONSTRAINT bursar_extraction_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'blocked', 'rejected_limits'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_extraction_runs_request
    ON bursar_extraction_runs(organization_id, request_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bursar_extraction_runs_status
    ON bursar_extraction_runs(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_extraction_runs_claimed
    ON bursar_extraction_runs(organization_id, status, heartbeat_at) WHERE status = 'running';

-- ──────────────────────────────────────────────────────────────────────
-- bursar_scope_nodes. The derived requirement tree. parent_id is a guarded self-FK with
-- ON DELETE RESTRICT (a child blocks an accidental parent delete). normative_strength is the
-- ruler every offer is measured against (mandatory nodes default the gap bar). Soft-archive
-- ONLY (archived_at); coverage FKs into this table are RESTRICT, so a node is never hard
-- deleted out from under its coverage. contributing_offer_ids records the rivals that
-- produced a derived node. Unique (organization_id, request_id, dedup_key).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_scope_nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id uuid NOT NULL REFERENCES bursar_requests(id) ON DELETE CASCADE,
    parent_id uuid,
    path text,
    ordinal integer NOT NULL DEFAULT 0,
    title varchar(512) NOT NULL,
    description text,
    node_kind varchar(32) NOT NULL DEFAULT 'requirement',
    normative_strength varchar(16) NOT NULL DEFAULT 'mandatory',
    unit varchar(32),
    quantity numeric(18,4),
    derived_from varchar(24),
    contributing_offer_ids uuid[] NOT NULL DEFAULT '{}',
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    confidence numeric(5,2),
    review_status varchar(16) NOT NULL DEFAULT 'pending_review',
    dedup_key varchar(64) NOT NULL,
    extraction_run_id uuid REFERENCES bursar_extraction_runs(id) ON DELETE SET NULL,
    tree_suspect boolean NOT NULL DEFAULT false,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_scope_nodes
        ADD CONSTRAINT bursar_scope_nodes_normative_strength_check
        CHECK (normative_strength IN ('mandatory', 'should_have', 'nice_to_have', 'informational'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Guarded self-FK. RESTRICT: a live child must block an accidental delete of its parent.
DO $$
BEGIN
    ALTER TABLE bursar_scope_nodes
        ADD CONSTRAINT bursar_scope_nodes_parent_fk
        FOREIGN KEY (parent_id) REFERENCES bursar_scope_nodes(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_scope_nodes_dedup
    ON bursar_scope_nodes(organization_id, request_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_bursar_scope_nodes_org_request
    ON bursar_scope_nodes(organization_id, request_id);
CREATE INDEX IF NOT EXISTS idx_bursar_scope_nodes_parent
    ON bursar_scope_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_bursar_scope_nodes_org_strength
    ON bursar_scope_nodes(organization_id, request_id, normative_strength);

DROP TRIGGER IF EXISTS trg_bursar_scope_nodes_updated_at ON bursar_scope_nodes;
CREATE TRIGGER trg_bursar_scope_nodes_updated_at
    BEFORE UPDATE ON bursar_scope_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_scope_library. Built-ins are GLOBAL (organization_id IS NULL, is_global = true) so
-- orgs created after the seed migration are not born with an empty library (spec 6.1). Org
-- rows are is_global = false with a concrete organization_id. Two guards keep globals safe:
-- the variant RLS policy (0251_bursar_rls.sql) plus the BEFORE INSERT OR UPDATE OR DELETE
-- immutability trigger below, which forbids ANY org caller (a bound app.current_org_id GUC)
-- from mutating a global row.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_scope_library (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
    is_global boolean NOT NULL DEFAULT false,
    category varchar(64) NOT NULL DEFAULT 'general',
    title varchar(512) NOT NULL,
    description text,
    node_kind varchar(32) NOT NULL DEFAULT 'requirement',
    normative_strength varchar(16) NOT NULL DEFAULT 'mandatory',
    unit varchar(32),
    default_quantity numeric(18,4),
    unit_price_minor bigint,
    currency varchar(3),
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_scope_library
        ADD CONSTRAINT bursar_scope_library_normative_strength_check
        CHECK (normative_strength IN ('mandatory', 'should_have', 'nice_to_have', 'informational'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A global row has no org; an org row must have one. Enforced so the variant RLS policy's
-- (organization_id IS NULL AND is_global) branch cannot be spoofed by an org-null non-global
-- row.
DO $$
BEGIN
    ALTER TABLE bursar_scope_library
        ADD CONSTRAINT bursar_scope_library_global_org_check
        CHECK ((is_global AND organization_id IS NULL) OR (NOT is_global AND organization_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_scope_library_org
    ON bursar_scope_library(organization_id, category);
CREATE INDEX IF NOT EXISTS idx_bursar_scope_library_global
    ON bursar_scope_library(category) WHERE is_global;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_scope_library_global_title
    ON bursar_scope_library(category, lower(title)) WHERE is_global;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_scope_library_org_title
    ON bursar_scope_library(organization_id, category, lower(title)) WHERE NOT is_global;

DROP TRIGGER IF EXISTS trg_bursar_scope_library_updated_at ON bursar_scope_library;
CREATE TRIGGER trg_bursar_scope_library_updated_at
    BEFORE UPDATE ON bursar_scope_library
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Immutability for org callers on global rows (spec 6.1). A superuser / migration with no
-- bound app.current_org_id GUC (current_setting returns '' -> NULL) may seed and maintain
-- globals; any request that has bound an org GUC is an org caller and must not touch a
-- global row. This is defense in depth behind the API's is_global=false write filter.
CREATE OR REPLACE FUNCTION bursar_scope_library_guard_global()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
DECLARE
    v_org text;
    v_is_global boolean;
BEGIN
    v_org := nullif(current_setting('app.current_org_id', true), '');
    -- On DELETE OLD holds the row; on INSERT/UPDATE NEW does. A global target is any row
    -- (old or new) that is global.
    IF TG_OP = 'DELETE' THEN
        v_is_global := OLD.is_global;
    ELSE
        v_is_global := NEW.is_global OR (TG_OP = 'UPDATE' AND OLD.is_global);
    END IF;

    IF v_is_global AND v_org IS NOT NULL THEN
        RAISE EXCEPTION
            'BURSAR_GLOBAL_LIBRARY_IMMUTABLE: org caller (app.current_org_id=%) may not %  a global scope-library row',
            v_org, TG_OP
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bursar_scope_library_guard_global ON bursar_scope_library;
CREATE TRIGGER trg_bursar_scope_library_guard_global
    BEFORE INSERT OR UPDATE OR DELETE ON bursar_scope_library
    FOR EACH ROW EXECUTE FUNCTION bursar_scope_library_guard_global();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_org_settings. One row per org. Every threshold, lexicon, and cap from spec 6.1
-- with its default. ALL columns are audited with a before/after diff at the service layer
-- (spec 5.6), so an admin cannot silently zero a weight to suppress findings.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_org_settings (
    organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    llm_provider_id uuid,
    node_term_overlap_floor numeric(5,4) NOT NULL DEFAULT 0.3000,
    blanket_fanout_cap integer NOT NULL DEFAULT 25,
    blanket_cumulative_cap integer NOT NULL DEFAULT 100,
    evidence_concentration_floor numeric(5,4) NOT NULL DEFAULT 0.5000,
    max_nodes_per_run integer NOT NULL DEFAULT 400,
    max_offers_per_run integer NOT NULL DEFAULT 12,
    max_llm_calls_per_run integer NOT NULL DEFAULT 2000,
    max_lines_per_window integer NOT NULL DEFAULT 80,
    window_overlap_lines integer NOT NULL DEFAULT 10,
    price_drift_threshold_pct numeric(5,2) NOT NULL DEFAULT 10.00,
    renewal_lead_bands jsonb NOT NULL DEFAULT '["t_minus_90","t_minus_60","t_minus_30","t_minus_7"]'::jsonb,
    parse_quality_floor numeric(5,4) NOT NULL DEFAULT 0.4000,
    payee_match_threshold numeric(5,4) NOT NULL DEFAULT 0.4500,
    payee_auto_accept_threshold numeric(5,4) NOT NULL DEFAULT 0.6500,
    blanket_lexicon jsonb NOT NULL DEFAULT '[]'::jsonb,
    exclusion_lexicon jsonb NOT NULL DEFAULT '[]'::jsonb,
    digest_day integer NOT NULL DEFAULT 1,
    digest_hour integer NOT NULL DEFAULT 8,
    retention_days integer NOT NULL DEFAULT 730,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_bursar_org_settings_updated_at ON bursar_org_settings;
CREATE TRIGGER trg_bursar_org_settings_updated_at
    BEFORE UPDATE ON bursar_org_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- Bursar System service-account user. Hosted in the shared sentinel org
-- (0014_helpdesk_system_user.sql). Never logs in (password_hash='!'); exists so autonomous
-- worker actions and direct agent_proposals inserts (actor_id NOT NULL) have a valid actor.
-- kind='service' marks it (mirrors 0230 braid b1 / 0234 bulwark b2 / 0239 burn b3 seeds).
-- Bursar is b4.
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b4',
    '00000000-0000-0000-0000-000000000002',
    'system-bursar@bigbluebam.internal',
    'Bursar System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b4',
    '00000000-0000-0000-0000-000000000002',
    'system-bursar@bigbluebam.internal',
    'Bursar System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (email) DO NOTHING;
