# Bill Design Audit (2026-04-14)

## Summary

Bill is approximately 85 to 90% complete at commit a8fb19a. All core invoice, client, payment, rate, expense, and financial reporting features are built and working. API routes follow design specifications with proper authentication and role-based access control. Frontend pages for all major workflows exist with functional components. MCP tools (16 tools) are fully implemented. Database schema matches design specification. Primary gaps are in worker job infrastructure for async operations (PDF generation, email delivery, overdue reminders) and some minor frontend polish. Event publishing to Bolt is fully integrated.

## Design sources consulted

- `docs/early-design-documents/Bill_Design_Document.md`
- `CLAUDE.md`
- Codebase at commit a8fb19a on recovery branch

## Built and working

### API routes and services

All REST API routes implemented with full authentication and role-based access control.

**Invoice routes** (`apps/bill-api/src/routes/invoices.routes.ts`):
- GET /v1/invoices, POST /v1/invoices, GET /v1/invoices/:id, PATCH /v1/invoices/:id, DELETE /v1/invoices/:id
- POST /v1/invoices/:id/line-items, PATCH /v1/invoices/:id/line-items/:itemId, DELETE /v1/invoices/:id/line-items/:itemId
- POST /v1/invoices/:id/finalize, POST /v1/invoices/:id/send, POST /v1/invoices/:id/void, POST /v1/invoices/:id/duplicate
- GET /v1/invoices/:id/pdf
- POST /v1/invoices/from-time-entries (Bam integration)
- POST /v1/invoices/from-deal (Bond integration)

**Client routes** (`apps/bill-api/src/routes/clients.routes.ts`): full CRUD.

**Payment routes** (`apps/bill-api/src/routes/payments.routes.ts`): POST /v1/invoices/:id/payments, DELETE /v1/payments/:id.

**Expense routes** (`apps/bill-api/src/routes/expenses.routes.ts`): full CRUD plus approve/reject.

**Rate routes** (`apps/bill-api/src/routes/rates.routes.ts`): full CRUD plus GET /v1/rates/resolve.

**Report routes** (`apps/bill-api/src/routes/reports.routes.ts`): GET /v1/reports/revenue, outstanding, profitability, overdue.

**Settings routes** (`apps/bill-api/src/routes/settings.routes.ts`): GET/PUT /v1/settings.

**Public routes** (`apps/bill-api/src/routes/public.routes.ts`): GET /invoice/:token, GET /invoice/:token/pdf (public invoice view, no auth).

### Services

All service functions implemented: `invoice.service.ts` (13 functions), `client.service.ts` (5), `payment.service.ts` (2), `line-item.service.ts` (3), `expense.service.ts` (6), `rate.service.ts` (5), `report.service.ts` (4), `settings.service.ts` (2), `pdf.service.ts` (2).

### Database schema

Migration `infra/postgres/migrations/0038_bill_tables.sql` creates all designed tables:
- `bill_clients` (with Bond company linkage)
- `bill_invoices` (all fields, statuses, generated amounts)
- `bill_line_items` (with time entry ID array for Bam linkage)
- `bill_payments`
- `bill_expenses` (with approval workflow)
- `bill_rates` (org/project/user scoped)
- `bill_invoice_sequences`
- `bill_settings` (org billing configuration)

All indices created as specified.

### MCP tools (`apps/mcp-server/src/tools/bill-tools.ts`)

16 tools implemented: bill_list_invoices, bill_get_invoice, bill_create_invoice, bill_create_invoice_from_time, bill_create_invoice_from_deal, bill_add_line_item, bill_finalize_invoice, bill_send_invoice, bill_record_payment, bill_get_overdue, bill_get_revenue_summary, bill_get_profitability, bill_list_expenses, bill_create_expense, bill_resolve_rate, bill_list_clients.

### Frontend pages

12 pages at `apps/bill/src/pages/`: invoice-list, invoice-new, invoice-detail, invoice-edit, invoice-from-time, client-list, client-detail, expense-list, expense-new, rate-list, reports, settings. Total ~1900 lines of frontend code.

### Authentication and authorization

Complete auth plugin at `apps/bill-api/src/plugins/auth.ts` with session and API key support. Proper role hierarchy (viewer, member, admin, owner). Scope enforcement for API keys. Org context resolution with multi-org support via X-Org-Id header.

### Bolt integration

Events published to Bolt for: invoice.created (manual and from-deal), invoice.finalized, invoice.sent, payment.recorded. Fire-and-forget event publishing with proper enrichment via `apps/bill-api/src/lib/bolt-event-enrich.ts`.

### PDF generation

`apps/bill-api/src/services/pdf.service.ts` uses pdf-lib (not Puppeteer as designed). Supports invoice layout with logo, line items table, totals, payment instructions, footer and terms text. Public PDF generation by token supported.

## Partial or divergent

- **PDF generation approach:** Design specifies Puppeteer (headless Chrome) for HTML-to-PDF conversion. Implementation uses pdf-lib for programmatic PDF building. Functionally equivalent, avoids containerization complexity, but differs architecturally.
- **Route prefixing:** Routes registered with `/v1` prefix (per `apps/bill-api/src/server.ts:139-145`), but design document specifies `/bill/api/`. Bridged at nginx level.
- **API key scope:** Design does not explicitly mention API key scopes. Implementation enforces three-tier scope hierarchy (read, read_write, admin) uniformly. Good defensive practice but not specified.

## Missing

### P0 Blocks downstream

- **Worker jobs for async operations.** No Bill-owned worker jobs found in `apps/worker/src/jobs/`. Design specifies: PDF generation queue (currently synchronous in route handler), invoice email delivery with attachments via Blast, overdue invoice reminder job (daily trigger via Bolt), time-entry-to-invoice aggregation.
- **Slack/email delivery for invoices.** POST /v1/invoices/:id/send route exists but implementation is minimal. Should integrate with Blast email service or SMTP service (apps/worker/src/jobs/email.job.ts), and with MinIO PDF storage before attachment.
- **Invoice number sequence locking.** Design requires gap-free invoice sequences with atomic locking. `bill_invoice_sequences` table exists, but no Redis lock implementation visible in service layer. Race conditions in finalizeInvoice could produce duplicate invoice numbers.

### P1 High value

- **MinIO integration for file storage.** No MinIO client configured in bill-api. `bill_invoices.pdf_url` field exists but not populated during PDF generation. Design specifies MinIO for invoice PDFs and receipt images.
- **Time entry integration workflow.** POST /v1/invoices/from-time-entries requires Bam time entry IDs to be passed explicitly. Design envisions a time-to-invoice wizard on frontend that queries Bam API for unbilled entries.
- **Bond deal linkage and auto-invoice.** POST /v1/invoices/from-deal exists but requires explicit deal_id. Design envisions Bolt automation triggered on deal.closed-won event. Also missing: Bond contact/company detail pages should show related Bill invoices.
- **Expense receipt uploads.** Expense routes accept receipt_url, but no multipart file upload handler.
- **Overdue invoice reminders.** Design describes daily Bolt automation querying bill_get_overdue and drafting emails via Blast.

### P2 Nice-to-have

- **Invoice template/draft saving** - reusable retainer templates.
- **Multi-currency exchange rates** - explicitly future work in the spec.
- **Expense approval workflow** - already partially handled; can be extended with comments/activity log.

## Architectural guidance

### Worker jobs for async operations

Reference: `apps/worker/src/jobs/email.job.ts`, `apps/worker/src/jobs/bolt-execute.job.ts`.

Pattern: Define job handler in `apps/worker/src/jobs/bill-pdf-generate.job.ts`. In bill-api invoice routes, after finalize or send, enqueue job with `queue.add('bill-pdf-generate', { invoice_id, org_id }, ...)`. Job fetches invoice, generates PDF (synchronously via pdf-lib), uploads to MinIO, stores URL, publishes `bill.invoice.generated` event or updates invoice status.

### MinIO file storage

Reference: `apps/api/src/plugins/minio.ts` if it exists in main Bam API.

Pattern: Add Fastify plugin for MinIO client in `bill-api/src/plugins/`. Decorate `fastify.minio` with client. In `pdf.service.ts` and `expense.service.ts`, call `fastify.minio.putObject('bill-pdfs', ${org_id}/${invoice_id}.pdf, pdfBuffer)`. Store returned URL in `bill_invoices.pdf_url` or `bill_expenses.receipt_url`.

### Invoice number sequence locking

Add Redis-based atomic increment: use `INCR bill:seq:<org_id>:<template>` under a Redis lock scoped to the org. Ensure the service function for finalizeInvoice acquires the lock, reads/increments the counter, formats the invoice number, and stores it with the invoice row in a single transaction. Alternatively, add a UNIQUE constraint on `(org_id, invoice_number)` to force DB-level uniqueness.

## Dependencies

### Inbound (other apps depend on Bill)

- **Bolt** subscribes to bill.invoice.created, bill.invoice.sent, bill.invoice.paid, bill.payment.recorded, bill.expense.submitted events.
- **Bond** linked via `bill_clients.bond_company_id` and `bill_invoices.bond_deal_id`. Bond company/deal detail pages should display related invoices.
- **Bam** time entries with `billable:true` can be aggregated into invoices. Requires Bam task/project IDs in line items.

### Outbound (Bill depends on other apps)

- **Blast** for email delivery and overdue reminders.
- **Email service** (`apps/worker/src/jobs/email.job.ts`) for SMTP delivery.
- **Bam API** (internal :4000) for project name resolution and time entry queries.
- **Bond API** (internal :4009) for company ID resolution.
- **Bolt API** (internal :4006) for event publishing.

## Open questions

1. **PDF storage strategy:** Should generated PDFs be stored in MinIO persistently or regenerated on-demand via public token?
2. **Invoice number sequence conflict resolution:** Should `invoice_number` have a UNIQUE constraint to force DB rejection, or rely on Redis lock in service layer?
3. **Blast email integration readiness:** Does blast-api have public template API? If not, Bill's sendInvoice() will need fallback to raw email.job.ts.
4. **Bam time entry API contract:** Exact fields and filters exposed on `/projects/:id/time-entries`?
5. **Public invoice token security:** `public_view_token` is generated at create time but never rotated. Should users be able to rotate without changing invoice?
6. **Tax calculation immutability:** After invoice finalize, should tax_rate and tax_amount be locked to a snapshot, not re-read from org settings on PDF regeneration?
