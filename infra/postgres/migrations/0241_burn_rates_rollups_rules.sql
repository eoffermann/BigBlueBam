-- 0241_burn_rates_rollups_rules.sql
-- Why: The three remaining Burn tables - burn_cost_rates (the internal-cost primitive the
--   platform lacks entirely; bill_rates is the rate charged TO the client), the per-chain
--   financial rollup, and the deterministic attribution rules. Also adds one additive index
--   on another app's table, bill_expenses, which Burn's reconcile pass needs and which does
--   not exist today. See docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md sections
--   3.1, 1.2, 2.3.2E, 2.3.3.
-- Client impact: additive only. New tables plus one new index on an existing table; no
--   column, constraint, or data changes to any existing object.

-- ──────────────────────────────────────────────────────────────────────
-- burn_cost_rates. THE PRIMITIVE THE PLATFORM LACKS.
--
-- bill_rates.rate_amount is the rate charged TO THE CLIENT (invoice.service.ts:583 resolves
-- it straight into unit_price on an invoice line item), and grepping every
-- apps/*/src/db/schema/ for cost_rate or internal_rate returns nothing. Without this table
-- `contract_value - sum(billing_rate x hours)` is contract consumption at LIST PRICE, not
-- margin, which is why metric_basis exists and why Burn refuses to call it margin when
-- coverage is zero.
--
-- The shape mirrors bill_rates so the two resolvers can be held to a parity test:
-- precedence user+project > user > project > org, and effective_to INCLUSIVE, matching
-- rate.service.ts:117.
--
-- Reads AND writes are floored to owner/admin with a second in-route role guard. This is
-- per-person compensation data.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_cost_rates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    cost_amount bigint NOT NULL,
    rate_type varchar(10) NOT NULL DEFAULT 'hourly',
    currency varchar(3) NOT NULL DEFAULT 'USD',
    effective_from date NOT NULL DEFAULT now(),
    effective_to date,
    note varchar(255),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_cost_rates
        ADD CONSTRAINT burn_cost_rates_amount_check
        CHECK (cost_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- effective_to is INCLUSIVE, so an equal pair is a valid one-day window.
DO $$
BEGIN
    ALTER TABLE burn_cost_rates
        ADD CONSTRAINT burn_cost_rates_effective_window_check
        CHECK (effective_to IS NULL OR effective_to >= effective_from);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_burn_cost_rates_org
    ON burn_cost_rates(organization_id);
-- A supporting b-tree, NOT a statement of precedence. Precedence is resolver logic.
CREATE INDEX IF NOT EXISTS idx_burn_cost_rates_org_project_user_from
    ON burn_cost_rates(organization_id, project_id, user_id, effective_from);

-- ──────────────────────────────────────────────────────────────────────
-- burn_engagement_rollups. THE GRAIN IS THE CHAIN.
--
-- revenue_basis branches on the engagement's envelope_basis and the branch is load-bearing.
-- In particular not_to_exceed is NOT grouped with fixed: NTE bills actual work up to a
-- ceiling and never the ceiling itself, so grouping them would make a $6,000 NTE that
-- delivered $2,000 report margin = 6000 - cost, booking $4,000 that can never be invoiced.
--
-- The three unscoped buckets are stored separately and are never summed into one: "work
-- nobody sold", "work not yet classified", and "work outside any contract window" are
-- different problems with different owners.
--
-- period_start/end/index are DESCRIPTIVE columns for a retainer chain (R3-D3). The unique
-- key stays (organization_id, chain_root_id) and the row is always the CURRENT period;
-- prior periods come from the burn-down series, not from additional rollup rows.
--
-- frozen_at is set by burn-retention on purge and a frozen row is NEVER recomputed (R2-T5).
-- Without it the hourly full recompute would, on the first pass after a purge, recompute
-- from surviving rows (near zero), DO UPDATE a years-old figure to $0, and stamp a fresh
-- computed_at so it would not even read as stale.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_engagement_rollups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    chain_root_id uuid NOT NULL,
    contract_value bigint,
    attributed_billable bigint,
    attributed_cost bigint,
    unscoped_sold_by_nobody bigint,
    unscoped_unclassified bigint,
    unscoped_outside_contract bigint,
    pending_review_amount bigint,
    awaiting_valuation_amount bigint,
    non_billable_amount bigint,
    consumption_pct numeric(6,2),
    margin_amount bigint,
    margin_pct numeric(6,2),
    cost_rate_coverage_pct numeric(6,2),
    priced_deliverable_coverage_pct numeric(6,2),
    distinct_contributor_count integer NOT NULL DEFAULT 0,
    metric_basis varchar(24) NOT NULL,
    revenue_basis varchar(24) NOT NULL,
    period_start date,
    period_end date,
    period_index integer,
    margin_state varchar(16),
    work_item_count integer NOT NULL DEFAULT 0,
    frozen_at timestamptz,
    computed_at timestamptz NOT NULL DEFAULT now()
);

-- 'suppressed' is a RESPONSE SHAPE (spec 1.2.2), never a stored value, so it is
-- deliberately absent from this enum.
DO $$
BEGIN
    ALTER TABLE burn_engagement_rollups
        ADD CONSTRAINT burn_engagement_rollups_metric_basis_check
        CHECK (metric_basis IN ('true_margin', 'contract_consumption'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagement_rollups
        ADD CONSTRAINT burn_engagement_rollups_revenue_basis_check
        CHECK (revenue_basis IN ('contract_value', 'billable_recognized_capped',
                                 'contract_value_per_period', 'billable_recognized'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagement_rollups
        ADD CONSTRAINT burn_engagement_rollups_margin_state_check
        CHECK (margin_state IS NULL OR margin_state IN ('in_progress', 'final'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Period columns are meaningful only for a retainer chain, and they travel together: a
-- start with no end is an unlabeled window, which is exactly the ambiguity R3-D3 removed.
DO $$
BEGIN
    ALTER TABLE burn_engagement_rollups
        ADD CONSTRAINT burn_engagement_rollups_period_shape_check
        CHECK (
            (period_start IS NULL AND period_end IS NULL AND period_index IS NULL)
            OR (period_start IS NOT NULL AND period_end IS NOT NULL
                AND period_index IS NOT NULL AND period_end >= period_start)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE burn_engagement_rollups
        ADD CONSTRAINT burn_engagement_rollups_period_basis_check
        CHECK (period_start IS NULL OR revenue_basis = 'contract_value_per_period');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_engagement_rollups_chain
    ON burn_engagement_rollups(organization_id, chain_root_id);
CREATE INDEX IF NOT EXISTS idx_burn_engagement_rollups_org_computed
    ON burn_engagement_rollups(organization_id, computed_at);
CREATE INDEX IF NOT EXISTS idx_burn_engagement_rollups_org_frozen
    ON burn_engagement_rollups(organization_id, frozen_at);

-- ──────────────────────────────────────────────────────────────────────
-- burn_attribution_rules. Applied BEFORE any LLM call. priority ascending, first match wins.
--
-- The discriminating-key CHECK is the important one: a rule with an empty `match` silently
-- swallows every work item in the org. Zod refuses it at the API boundary and this refuses
-- it at the storage boundary, because rules are one of the three gate-neutralization
-- vectors (spec 2.4 point 8).
--
-- title_pattern is glob or substring, NEVER regex (enforced at write): there is no regex
-- timeout in Node, so a member-authored catastrophic-backtracking pattern would be an
-- unbounded denial of service on the attribution worker.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burn_attribution_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name varchar(255) NOT NULL,
    priority integer NOT NULL DEFAULT 100,
    match jsonb NOT NULL,
    outcome_kind varchar(24) NOT NULL,
    outcome_deliverable_id uuid REFERENCES burn_deliverables(id) ON DELETE CASCADE,
    outcome_reason varchar(24),
    is_enabled boolean NOT NULL DEFAULT true,
    match_count integer NOT NULL DEFAULT 0,
    last_match_pct numeric(5,2),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE burn_attribution_rules
        ADD CONSTRAINT burn_attribution_rules_outcome_kind_check
        CHECK (outcome_kind IN ('attribute', 'non_billable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An `attribute` rule needs a target; a `non_billable` rule needs a reason.
DO $$
BEGIN
    ALTER TABLE burn_attribution_rules
        ADD CONSTRAINT burn_attribution_rules_outcome_shape_check
        CHECK (
            (outcome_kind = 'attribute' AND outcome_deliverable_id IS NOT NULL)
            OR (outcome_kind = 'non_billable' AND outcome_reason IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- THE discriminating-key CHECK. At least one real selector must be present.
DO $$
BEGIN
    ALTER TABLE burn_attribution_rules
        ADD CONSTRAINT burn_attribution_rules_match_discriminating_check
        CHECK (
            jsonb_typeof(match) = 'object'
            AND (
                match ? 'project_ids'
                OR match ? 'phase_ids'
                OR match ? 'label_ids'
                OR match ? 'account_ids'
                OR match ? 'title_pattern'
                OR match ? 'expense_categories'
                OR match ? 'source_types'
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_burn_attribution_rules_org_enabled_priority
    ON burn_attribution_rules(organization_id, is_enabled, priority);
CREATE INDEX IF NOT EXISTS idx_burn_attribution_rules_outcome_deliverable
    ON burn_attribution_rules(outcome_deliverable_id);

-- ──────────────────────────────────────────────────────────────────────
-- RLS on the three tables added here.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE burn_cost_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_cost_rates_org_isolation ON burn_cost_rates;
CREATE POLICY burn_cost_rates_org_isolation ON burn_cost_rates
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_engagement_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_engagement_rollups_org_isolation ON burn_engagement_rollups;
CREATE POLICY burn_engagement_rollups_org_isolation ON burn_engagement_rollups
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE burn_attribution_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS burn_attribution_rules_org_isolation ON burn_attribution_rules;
CREATE POLICY burn_attribution_rules_org_isolation ON burn_attribution_rules
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ──────────────────────────────────────────────────────────────────────
-- A Burn-owned ADDITIVE index on another app's table (spec 2.3.2E).
--
-- bill_expenses is indexed today on organization_id, project_id, and status only
-- (bill-expenses.ts:50-52). Burn's reconcile pass 1 scans by (organization_id, created_at)
-- against the per-source watermark, which without this index is a full org-wide scan of
-- the expense table on every pass. Purely additive: no column, constraint, or data change
-- to bill_expenses, and bill-api is unaffected other than by the index's write cost.
-- ──────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bill_expenses_created_at
    ON bill_expenses(organization_id, created_at);
