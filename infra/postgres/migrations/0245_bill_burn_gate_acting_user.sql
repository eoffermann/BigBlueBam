-- 0245_bill_burn_gate_acting_user.sql
--
-- Why: Burn spec section 6.1 ("Deferred fail-open outcome") requires bill-api to stamp a
-- created expense with a burn_gate marker when the precheck gate failed open, because on
-- that path bill-api has no precheck_id to call back with and burn-variance-sweep needs
-- REAL ROWS to raise ungated_charge against rather than a bare counter. Section 9.2 and
-- section 2.4 point 11 additionally require the internal line-item write to record the
-- acting_user_id supplied in the request body, so a change-order approval running under
-- the internal secret (no session) leaves an auditable authority trail.
--
-- Client impact: additive only. All three columns are nullable with no default, so every
-- existing read path and every existing INSERT continues to work untouched.

ALTER TABLE bill_expenses
    ADD COLUMN IF NOT EXISTS burn_gate varchar(32);

ALTER TABLE bill_expenses
    ADD COLUMN IF NOT EXISTS burn_precheck_id uuid;

-- Partial index: only the small minority of rows that actually failed open are ever
-- scanned by burn-variance-sweep, so keep the index off the 99% NULL majority.
CREATE INDEX IF NOT EXISTS idx_bill_expenses_burn_gate
    ON bill_expenses(organization_id, burn_gate)
    WHERE burn_gate IS NOT NULL;

-- The authority that caused this line item to exist. NULL for every line item written
-- through the session-authenticated SPA path (request.user is the authority there and is
-- already captured in the activity log); populated only by the internal write, where the
-- caller is a service and the human decider must be recorded explicitly.
ALTER TABLE bill_line_items
    ADD COLUMN IF NOT EXISTS acting_user_id uuid;

DO $$
BEGIN
    ALTER TABLE bill_line_items
        ADD CONSTRAINT bill_line_items_acting_user_id_fkey
        FOREIGN KEY (acting_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_table THEN NULL;
END $$;
