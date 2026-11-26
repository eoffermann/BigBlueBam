-- 0262_permissions_seed_actions_delta_025.sql
-- Why: Catalog delta for issue #134. The new invoice PDF download route
--   GET /invoices/:id/pdf/download (bill-api) path-derives the catalog id
--   bill.invoice_pdf_download.get in docs/permissions-action-manifest.json.
--   The route itself enforces bill.invoice.get; this row keeps the catalog
--   table in step with the manifest.
-- Client impact: additive only (one new read permission row).
--   Re-running is safe; INSERT...ON CONFLICT is idempotent.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bill.invoice_pdf_download.get', 'bill', 'invoice_pdf_download', 'get', 'bill invoice_pdf_download get', false, false, true, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
