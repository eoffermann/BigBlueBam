-- 0264_permissions_seed_actions_delta_026.sql
-- Why: Catalog delta for issue #145. The new expense receipt download route
--   GET /expenses/:id/receipt (bill-api) path-derives the catalog id
--   bill.expense_receipt.get in docs/permissions-action-manifest.json.
--   The route itself enforces bill.expense.list; this row keeps the catalog
--   table in step with the manifest.
-- Client impact: additive only (one new read permission row).
--   Re-running is safe; INSERT...ON CONFLICT is idempotent.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bill.expense_receipt.get', 'bill', 'expense_receipt', 'get', 'bill expense_receipt get', false, false, true, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
