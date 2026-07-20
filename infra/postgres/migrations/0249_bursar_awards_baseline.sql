-- 0249_bursar_awards_baseline.sql
-- Why: Bursar award freeze and the spend feed - awards chained by supersedes/chain_root with
--   an immutable baseline hash and nullable term window, the FROZEN baseline item ledger
--   (kind = included / excluded_at_award / absent_at_award) with four-path immutability, the
--   item-to-node link, and the spend event stream with an occurrence-ordinal-aware dedup key
--   plus the resumable import batch. See
--   docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md sections 6.1, 7.
-- Client impact: additive only. New tables + one immutability trigger function; no changes
--   to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- bursar_awards. The frozen decision. supersedes_award_id + chain_root_id chain amendments
-- (spec 7.2): a new row inherits chain_root_id and the predecessor flips to superseded.
-- term_start / term_end are NULLABLE (spec 7.3): null term_end means open-ended. baseline_hash
-- is computed at freeze over the accepted lines. contract_bin_asset_id is a dotted ref.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_awards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id uuid NOT NULL REFERENCES bursar_requests(id) ON DELETE RESTRICT,
    offer_id uuid REFERENCES bursar_offers(id) ON DELETE SET NULL,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    supersedes_award_id uuid,
    chain_root_id uuid NOT NULL,
    baseline_hash varchar(64),
    currency varchar(3) NOT NULL DEFAULT 'USD',
    term_start date,
    term_end date,
    auto_renew boolean NOT NULL DEFAULT false,
    renewal_notice_days integer,
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    contract_bin_asset_id uuid,
    status varchar(16) NOT NULL DEFAULT 'active',
    awarded_by uuid NOT NULL REFERENCES users(id),
    awarded_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_awards
        ADD CONSTRAINT bursar_awards_status_check
        CHECK (status IN ('active', 'superseded', 'terminated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE bursar_awards
        ADD CONSTRAINT bursar_awards_supersedes_fk
        FOREIGN KEY (supersedes_award_id) REFERENCES bursar_awards(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_awards_org_status
    ON bursar_awards(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_bursar_awards_org_chain
    ON bursar_awards(organization_id, chain_root_id);
CREATE INDEX IF NOT EXISTS idx_bursar_awards_org_vendor
    ON bursar_awards(organization_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bursar_awards_supersedes
    ON bursar_awards(supersedes_award_id);
CREATE INDEX IF NOT EXISTS idx_bursar_awards_term_end
    ON bursar_awards(organization_id, term_end);

DROP TRIGGER IF EXISTS trg_bursar_awards_updated_at ON bursar_awards;
CREATE TRIGGER trg_bursar_awards_updated_at
    BEFORE UPDATE ON bursar_awards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_baseline_items. The FROZEN copy of every accepted line at award, including the
-- excluded_at_award and absent_at_award rows (spec 7.1). kind is one of included /
-- excluded_at_award / absent_at_award. coverage_verdict_at_award stamps what the coverage
-- said the moment the award froze, so post-award drift is measured against a fixed point.
--
-- award_id is ON DELETE RESTRICT (path iii of four): a cascade would NOT fire the row-level
-- delete trigger, so RESTRICT is what makes the baseline undeletable via its award.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_baseline_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    award_id uuid NOT NULL REFERENCES bursar_awards(id) ON DELETE RESTRICT,
    ordinal integer NOT NULL DEFAULT 0,
    kind varchar(24) NOT NULL DEFAULT 'included',
    title varchar(512) NOT NULL,
    description text,
    unit varchar(32),
    quantity numeric(18,4),
    unit_price_minor bigint,
    extended_minor bigint,
    currency varchar(3),
    delta_kind varchar(24),
    delta_amount_minor bigint,
    coverage_verdict_at_award varchar(24),
    source_offer_line_id uuid,
    cited_span jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_baseline_items
        ADD CONSTRAINT bursar_baseline_items_kind_check
        CHECK (kind IN ('included', 'excluded_at_award', 'absent_at_award'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bursar_baseline_items_award
    ON bursar_baseline_items(organization_id, award_id);
CREATE INDEX IF NOT EXISTS idx_bursar_baseline_items_kind
    ON bursar_baseline_items(organization_id, award_id, kind);

-- ── Four-path immutability on baseline items (spec 6.1) ──────────────────
-- One function raises for every mutating operation; the triggers below apply it to UPDATE,
-- DELETE, and TRUNCATE. INSERT is allowed (that is the freeze itself). Path iii (award-side
-- ON DELETE RESTRICT) is on the FK above, since a cascade would not fire a row trigger.
CREATE OR REPLACE FUNCTION bursar_baseline_items_immutable()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'BURSAR_BASELINE_IMMUTABLE: bursar_baseline_items rows are frozen at award; % is not permitted',
        TG_OP
        USING ERRCODE = 'restrict_violation';
    RETURN NULL;
END;
$$;

-- Path i: BEFORE UPDATE, WHEN scoped to CONTENT columns only, so an additive migration that
-- backfills a NEW column is not aborted while every content edit still is.
DROP TRIGGER IF EXISTS trg_bursar_baseline_items_no_update ON bursar_baseline_items;
CREATE TRIGGER trg_bursar_baseline_items_no_update
    BEFORE UPDATE ON bursar_baseline_items
    FOR EACH ROW
    WHEN (
        OLD.award_id IS DISTINCT FROM NEW.award_id
        OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.title IS DISTINCT FROM NEW.title
        OR OLD.description IS DISTINCT FROM NEW.description
        OR OLD.unit IS DISTINCT FROM NEW.unit
        OR OLD.quantity IS DISTINCT FROM NEW.quantity
        OR OLD.unit_price_minor IS DISTINCT FROM NEW.unit_price_minor
        OR OLD.extended_minor IS DISTINCT FROM NEW.extended_minor
        OR OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.delta_kind IS DISTINCT FROM NEW.delta_kind
        OR OLD.delta_amount_minor IS DISTINCT FROM NEW.delta_amount_minor
        OR OLD.coverage_verdict_at_award IS DISTINCT FROM NEW.coverage_verdict_at_award
        OR OLD.source_offer_line_id IS DISTINCT FROM NEW.source_offer_line_id
        OR OLD.cited_span IS DISTINCT FROM NEW.cited_span
    )
    EXECUTE FUNCTION bursar_baseline_items_immutable();

-- Path ii: BEFORE DELETE.
DROP TRIGGER IF EXISTS trg_bursar_baseline_items_no_delete ON bursar_baseline_items;
CREATE TRIGGER trg_bursar_baseline_items_no_delete
    BEFORE DELETE ON bursar_baseline_items
    FOR EACH ROW
    EXECUTE FUNCTION bursar_baseline_items_immutable();

-- Path iv: BEFORE TRUNCATE, statement-level (a row trigger never sees TRUNCATE).
DROP TRIGGER IF EXISTS trg_bursar_baseline_items_no_truncate ON bursar_baseline_items;
CREATE TRIGGER trg_bursar_baseline_items_no_truncate
    BEFORE TRUNCATE ON bursar_baseline_items
    FOR EACH STATEMENT
    EXECUTE FUNCTION bursar_baseline_items_immutable();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_baseline_item_nodes. Links a frozen baseline item to the scope node(s) it covered
-- at award. scope_node_id RESTRICTs (reinforcing node soft-archive).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_baseline_item_nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    baseline_item_id uuid NOT NULL REFERENCES bursar_baseline_items(id) ON DELETE CASCADE,
    scope_node_id uuid NOT NULL REFERENCES bursar_scope_nodes(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_baseline_item_nodes_unique
    ON bursar_baseline_item_nodes(organization_id, baseline_item_id, scope_node_id);
CREATE INDEX IF NOT EXISTS idx_bursar_baseline_item_nodes_node
    ON bursar_baseline_item_nodes(organization_id, scope_node_id);

-- ──────────────────────────────────────────────────────────────────────
-- bursar_spend_imports. The import batch header. Unique (organization_id, file_sha256) with
-- an upsert-and-resume contract (spec 6.1): a crashed import is retried by re-uploading the
-- same file, and "0 new" is derived from rows_deduped, never from this row's existence, so a
-- die-at-row-200 import re-runs the loop rather than short-circuiting.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_spend_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_sha256 varchar(64) NOT NULL,
    filename varchar(512),
    row_count integer NOT NULL DEFAULT 0,
    rows_inserted integer NOT NULL DEFAULT 0,
    rows_deduped integer NOT NULL DEFAULT 0,
    status varchar(16) NOT NULL DEFAULT 'running',
    imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_spend_imports
        ADD CONSTRAINT bursar_spend_imports_status_check
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_spend_imports_file
    ON bursar_spend_imports(organization_id, file_sha256);
CREATE INDEX IF NOT EXISTS idx_bursar_spend_imports_org_status
    ON bursar_spend_imports(organization_id, status);

DROP TRIGGER IF EXISTS trg_bursar_spend_imports_updated_at ON bursar_spend_imports;
CREATE TRIGGER trg_bursar_spend_imports_updated_at
    BEFORE UPDATE ON bursar_spend_imports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- bursar_spend_events. The observed spend stream. source_type is one of bill.expense /
-- import.csv / manual. occurrence_ordinal is the row's index within its dedup group in the
-- SOURCE FILE (spec 6.1), so two genuine identical same-day same-payee charges get distinct
-- ordinals and their own rows rather than collapsing. dedup_key is a plain local sha256 over
-- the canonical tuple; unique (organization_id, dedup_key). Index (organization_id,
-- normalized_payee) drives unbaselined-vendor grouping (spec 8).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bursar_spend_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type varchar(24) NOT NULL,
    spend_import_id uuid REFERENCES bursar_spend_imports(id) ON DELETE SET NULL,
    vendor_id uuid REFERENCES bursar_vendors(id) ON DELETE SET NULL,
    occurred_on date NOT NULL,
    amount_minor bigint NOT NULL,
    currency varchar(3) NOT NULL DEFAULT 'USD',
    payee_raw varchar(512),
    normalized_payee varchar(512),
    funding_source varchar(64),
    external_ref varchar(256),
    matched_baseline_item_id uuid REFERENCES bursar_baseline_items(id) ON DELETE SET NULL,
    match_method varchar(24),
    match_confidence numeric(5,4),
    dedup_key varchar(64) NOT NULL,
    occurrence_ordinal integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bursar_spend_events
        ADD CONSTRAINT bursar_spend_events_source_type_check
        CHECK (source_type IN ('bill.expense', 'import.csv', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bursar_spend_events_dedup
    ON bursar_spend_events(organization_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_bursar_spend_events_org_payee
    ON bursar_spend_events(organization_id, normalized_payee);
CREATE INDEX IF NOT EXISTS idx_bursar_spend_events_org_occurred
    ON bursar_spend_events(organization_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_bursar_spend_events_vendor
    ON bursar_spend_events(organization_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bursar_spend_events_baseline_item
    ON bursar_spend_events(matched_baseline_item_id);
