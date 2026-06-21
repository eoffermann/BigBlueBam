# Bill (Invoicing & Billing) -- Design Audit

**Date:** 2026-04-09
**Auditor:** Claude Opus 4.6 (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Bill_Design_Document.md` v1.0
**Implementation:** `apps/bill-api/src/` (33 files), `apps/bill/src/` (24 files), `apps/mcp-server/src/tools/bill-tools.ts`

---

## Executive Summary

Bill's implementation covers the core invoicing workflow end-to-end: clients, invoices, line items, payments, expenses, billing rates, reporting, settings, and a public invoice view. The API layer is solid with 8 route files, 8 service files, and 8 Drizzle schema tables matching the design. The frontend has 11 pages covering all major routes. MCP integration provides 14 of the 15 designed tools.

**Overall Completion: ~75%**

The foundational CRUD operations, financial calculations, and reporting are all present and functional. The main gaps are: no PDF generation pipeline, no time-entry-to-invoice integration endpoint, no deal-to-invoice endpoint, no Bolt event emission, missing `amount_due` generated column, incomplete client detail page, and missing permission granularity (manager vs admin vs member).

---

## Rating Scale

| Rating | Meaning |
|--------|---------|
| P0 | Not implemented at all |
| P1 | Stub/placeholder only, no functional code |
| P2 | Partially implemented, major gaps |
| P3 | Mostly implemented, minor gaps |
| P4 | Implemented with trivial deviations |
| P5 | Fully matches design specification |

---

## Feature Audit Table

### 3. Data Model

| Feature | Rating | Notes |
|---------|--------|-------|
| `bill_clients` table | P5 | All columns present in Drizzle schema and migration |
| `bill_rates` table | P5 | Full match including scope resolution indexes |
| `bill_invoice_sequences` table | P5 | Present with org-scoped gap-free numbering |
| `bill_invoices` table | P3 | Missing `amount_due GENERATED ALWAYS AS (total - amount_paid) STORED` computed column; `bond_deal_id` FK not enforced (no reference to bond_deals) |
| `bill_line_items` table | P5 | Full match including time_entry_ids array and task_id FK |
| `bill_payments` table | P5 | All columns present |
| `bill_expenses` table | P5 | All columns and status enum match |
| `bill_settings` table | P5 | Full match |
| `bill_invoices` due_date index (WHERE clause) | P2 | Design specifies `WHERE status NOT IN ('paid', 'void', 'written_off')`; Drizzle schema has no partial index |

### 4. API Endpoints

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /clients` | P5 | Implemented with search filter |
| `POST /clients` | P4 | Works; role check uses `admin` but design says Manager should also have access |
| `GET /clients/:id` | P4 | Returns client, but design says "with invoice history" -- service only returns client fields, no invoice list |
| `PATCH /clients/:id` | P5 | Full match |
| `DELETE /clients/:id` | P5 | Includes invoice-exists guard per design |
| `GET /invoices` | P5 | All filters implemented (status, client, project, date range) |
| `POST /invoices` | P5 | Creates draft with settings defaults and client snapshot |
| `POST /invoices/from-time-entries` | P0 | **Not implemented.** No route, no service method. MCP tool calls it but API will 404. |
| `POST /invoices/from-deal` | P0 | **Not implemented.** No route, no service method. No MCP tool either. |
| `GET /invoices/:id` | P5 | Returns invoice with line items and payments |
| `PATCH /invoices/:id` | P5 | Draft-only guard, recalculates totals |
| `DELETE /invoices/:id` | P5 | Draft-only guard |
| `POST /invoices/:id/line-items` | P5 | Full match with amount calculation |
| `PATCH /invoices/:id/line-items/:itemId` | P5 | Full match |
| `DELETE /invoices/:id/line-items/:itemId` | P5 | Full match with total recalc |
| `POST /invoices/:id/finalize` | P3 | Assigns number and locks, but does NOT generate PDF; sets status to `sent` instead of keeping it `sent` only after explicit send |
| `POST /invoices/:id/send` | P2 | Only marks status as `sent`; **no email delivery**, no BullMQ job, no PDF attachment |
| `POST /invoices/:id/void` | P5 | Full match |
| `POST /invoices/:id/duplicate` | P5 | Clones invoice and line items |
| `GET /invoices/:id/pdf` | P0 | **Not implemented.** No route exists for authenticated PDF download. |
| `POST /invoices/:id/payments` | P5 | Records payment, recalculates, auto-updates status to paid/partially_paid |
| `DELETE /payments/:id` | P5 | Full match with total recalc |
| `GET /expenses` | P5 | All filters |
| `POST /expenses` | P5 | Full match |
| `PATCH /expenses/:id` | P5 | Guards against editing approved/reimbursed |
| `DELETE /expenses/:id` | P5 | Full match |
| `POST /expenses/:id/approve` | P5 | Full match |
| `POST /expenses/:id/reject` | P5 | Full match |
| `GET /invoice/:token` (public) | P4 | Returns public-safe fields and marks as viewed; design mentions rendering as HTML page, implementation returns JSON |
| `GET /invoice/:token/pdf` (public) | P3 | Route exists but redirects to `pdf_url`; PDF is never generated so always returns 404 |
| `GET /rates` | P5 | Full match |
| `POST /rates` | P5 | Full match |
| `PATCH /rates/:id` | P5 | Full match |
| `DELETE /rates/:id` | P5 | Full match |
| `GET /rates/resolve` | P5 | Full cascading resolution (user+project > user > project > org) |
| `GET /reports/revenue` | P5 | Monthly aggregation with invoiced/collected |
| `GET /reports/outstanding` | P5 | Aging buckets (0-30, 31-60, 61-90, 90+) by client |
| `GET /reports/profitability` | P5 | Revenue vs. expenses per project with margin |
| `GET /reports/overdue` | P5 | Lists overdue with days_overdue |
| `GET /settings` | P5 | Returns defaults if none configured |
| `PUT /settings` | P5 | Upsert pattern |

### 5. MCP Tools

| Tool | Rating | Notes |
|------|--------|-------|
| `bill_list_invoices` | P5 | Full match |
| `bill_get_invoice` | P5 | Full match |
| `bill_create_invoice` | P5 | Full match |
| `bill_create_invoice_from_time` | P1 | Tool registered and calls `/invoices/from-time-entries`, but backend endpoint does not exist -- will always fail |
| `bill_create_invoice_from_deal` | P0 | **Not registered.** Missing from bill-tools.ts entirely |
| `bill_add_line_item` | P5 | Full match |
| `bill_finalize_invoice` | P4 | Works but no PDF generation |
| `bill_send_invoice` | P3 | Marks as sent, no actual email |
| `bill_record_payment` | P5 | Full match |
| `bill_get_overdue` | P5 | Full match |
| `bill_get_revenue_summary` | P5 | Full match |
| `bill_get_profitability` | P5 | Full match |
| `bill_list_expenses` | P5 | Full match |
| `bill_create_expense` | P5 | Full match |
| `bill_resolve_rate` | P5 | Full match |

### 6. Invoice PDF Generation

| Feature | Rating | Notes |
|---------|--------|-------|
| HTML template rendering (EJS/Handlebars) | P0 | No template file exists |
| Puppeteer PDF conversion | P0 | No Puppeteer dependency, no worker job |
| PDF storage in MinIO | P0 | No MinIO upload code in bill-api |
| PDF URL saved on invoice | P3 | Column exists in schema but never populated |
| Branding (logo, colors) | P0 | No PDF rendering = no branding |
| BullMQ worker job for PDF | P0 | No bill-related job handler in worker |

### 7. Bolt Events

| Event | Rating | Notes |
|-------|--------|-------|
| `bill.invoice.created` | P0 | No event emission anywhere in the codebase |
| `bill.invoice.sent` | P0 | Not emitted |
| `bill.invoice.viewed` | P0 | Not emitted (view tracking works, but no event) |
| `bill.invoice.paid` | P0 | Not emitted |
| `bill.invoice.overdue` | P0 | Not emitted |
| `bill.payment.recorded` | P0 | Not emitted |
| `bill.expense.submitted` | P0 | Not emitted |
| `bill.expense.approved` | P0 | Not emitted |

### 8. Cross-Product Integration

| Integration | Rating | Notes |
|-------------|--------|-------|
| Bam time-to-invoice pipeline | P0 | No endpoint, no time entry aggregation |
| Bond deal-to-invoice pipeline | P0 | No endpoint |
| Bond client linkage | P3 | `bond_company_id` exists on `bill_clients`, can be set on create, but no auto-suggest flow |
| Banter event posting | P0 | No Bolt events = no Banter integration |
| Bench data source registration | P0 | Not implemented |
| Blast overdue reminders | P0 | Not implemented |

### 9. Frontend

| Route / Feature | Rating | Notes |
|-----------------|--------|-------|
| `/bill` (invoice list) | P5 | Table with number, client, date, total, status badge, due date |
| `/bill/invoices/new` | P4 | Client selector + line items + totals; missing discount input, payment instructions, footer/terms on create |
| `/bill/invoices/from-time` | P1 | **Placeholder only.** Shows informational banner, button is disabled. No Bam integration. |
| `/bill/invoices/:id` | P4 | Shows line items, payments, from/to, actions. Missing: activity timeline, PDF preview |
| `/bill/invoices/:id/edit` | P3 | Only edits tax rate, notes, footer, terms. Cannot edit client, dates, discount, payment instructions, or line items inline |
| `/bill/clients` | P4 | List with create form; only captures name+email on create (design has full address fields) |
| `/bill/clients/:id` | P0 | **Route parsed but no component rendered.** `client-detail` case in router has no matching component; falls through to null |
| `/bill/expenses` | P5 | List with status filter, approve/reject inline |
| `/bill/expenses/new` | P4 | Missing receipt upload (file picker for MinIO), missing project selector (free text UUID) |
| `/bill/rates` | P4 | List + create form; create form missing project_id/user_id selectors and effective dates |
| `/bill/reports` | P4 | All four reports render as tables; design calls for bar charts (revenue trend, aging stacked bar, profitability bar). Tables are functional but not visual. |
| `/bill/settings` | P5 | All fields present, upsert works, success feedback |
| Invoice editor live preview | P0 | Design specifies live PDF preview panel; not implemented |
| Client autocomplete with "create new" | P2 | Uses basic `<select>`, no autocomplete, no inline create |

### 10. Permissions

| Permission Check | Rating | Notes |
|------------------|--------|-------|
| Role hierarchy (viewer < member < admin < owner) | P4 | Implemented in `authorize.ts` but routes use `requireMinRole` from auth plugin, not `requireMinOrgRole` from authorize |
| Manager role distinction | P0 | Design has 4 roles (Admin, Manager, Member, Viewer); implementation only checks admin/member, no "manager" concept |
| Void invoices admin-only | P4 | Route requires `admin` role |
| Settings admin-only | P5 | Correctly requires admin |
| Expense submit by member | P5 | `requireMinRole('member')` |

### Infrastructure

| Item | Rating | Notes |
|------|--------|-------|
| Docker service (`bill-api`) | P5 | Present in docker-compose.yml with all env vars |
| nginx routing (`/bill/`, `/bill/api/`, `/invoice/`) | P5 | All three location blocks present |
| Migration file (`0038_bill_tables.sql`) | P4 | Exists; not checked for full column parity with design |
| Drizzle schema (8 table files) | P4 | All tables present; missing `amount_due` generated column and `due_date` partial index |

---

## Detailed Findings (P0-P3)

### P0: Not Implemented

1. **PDF Generation Pipeline** (Section 6) -- The entire PDF subsystem is absent. No HTML templates, no Puppeteer/headless Chrome, no BullMQ worker job, no MinIO upload. The `pdf_url` column exists but is never populated. This is the single largest missing feature.

2. **`POST /invoices/from-time-entries`** (Section 4.2) -- The core value proposition of Bill ("time logged against Bam tasks generates invoice line items") has no backend implementation. The MCP tool `bill_create_invoice_from_time` is registered but will always 404.

3. **`POST /invoices/from-deal`** (Section 4.2) -- Bond deal-to-invoice pipeline is not implemented. No API endpoint and no MCP tool.

4. **`GET /invoices/:id/pdf`** (Section 4.2) -- Authenticated PDF download endpoint is missing entirely from the routes.

5. **`bill_create_invoice_from_deal` MCP tool** (Section 5) -- Not registered in `bill-tools.ts`. 14 of 15 tools are present; this one is missing.

6. **Bolt Events** (Section 7) -- None of the 8 designed events are emitted. No event publishing code exists anywhere in bill-api.

7. **Client Detail Page** (`/bill/clients/:id`) (Section 9.1) -- Route is parsed in the router but the `client-detail` case in `renderPage()` returns null. No `ClientDetailPage` component exists.

8. **Invoice Editor Live Preview** (Section 9.2) -- Design specifies a live HTML preview panel in the editor. Not present.

### P1: Stub Only

9. **Time-to-Invoice Wizard** (`/bill/invoices/from-time`) -- Frontend page exists but is a disabled placeholder with an informational banner saying "This wizard requires Bam time entries integration." The "Preview Line Items" button is disabled.

10. **MCP `bill_create_invoice_from_time`** -- Tool is registered and will call the backend, but the backend endpoint doesn't exist. Functional stub that always errors.

### P2: Partially Implemented

11. **`POST /invoices/:id/send`** -- Marks invoice as `sent` and sets `sent_at`, but does not queue an email via BullMQ, does not attach a PDF, and does not include a public view link. The entire email delivery path is missing.

12. **Client Autocomplete** -- Invoice creation uses a basic `<select>` dropdown for clients. Design calls for an autocomplete with "create new" option.

13. **Invoice `amount_due` Column** -- Design specifies `amount_due BIGINT GENERATED ALWAYS AS (total - amount_paid) STORED`. Not in Drizzle schema or migration. Frontend computes `total - amount_paid` inline, which works but diverges from the schema contract.

### P3: Mostly Implemented, Minor Gaps

14. **`POST /invoices/:id/finalize`** -- Correctly assigns invoice number via atomic sequence increment and locks edits. However: (a) sets status directly to `sent` instead of a finalized/locked state, (b) does not trigger PDF generation, (c) conflates finalize and send semantics.

15. **Invoice Edit Page** -- Only allows editing tax rate, notes, footer text, and terms. Cannot edit client, project, dates, discount amount, payment instructions, or add/remove line items inline. Design Section 9.2 describes a full editor with editable line item table.

16. **Bond Client Linkage** -- `bond_company_id` column exists and can be set on client creation via API, but there is no UI for it, and no auto-suggest flow when creating from Bond.

17. **Public Invoice View** -- Returns JSON data, not a rendered HTML page. Design (Section 4.5) says "Render invoice as public HTML page."

---

## P4-P5 Summary (Working Well)

These features are fully or nearly fully implemented:

- **Invoice CRUD lifecycle** (create draft, edit, finalize with number, void, duplicate) -- robust with proper status guards
- **Line item management** with quantity x unit_price calculation and invoice total recalculation
- **Payment recording** with auto status transition (partially_paid, paid) and overpayment guard
- **Expense management** with full CRUD, approve/reject workflow, and status guards
- **Billing rate configuration** with cascading resolution (user+project > user > project > org)
- **All four financial reports** (revenue, outstanding aging, profitability, overdue)
- **Organization billing settings** with upsert and defaults
- **Public invoice view** with token-based access and view tracking
- **Invoice number sequencing** with atomic increment to prevent race conditions
- **Client snapshot** on invoice creation (from_name, to_name, addresses frozen at creation time)
- **Docker service, nginx, migration** -- all infrastructure pieces in place
- **13 of 15 MCP tools** functional (the 2 gaps are from-time and from-deal)
- **Frontend** -- 10 of 12 designed routes have functional pages
- **Error handling** with proper Zod validation errors and application error envelope

---

## Recommendations

### Priority 1: Core Value (blocks launch)

1. **Implement `POST /invoices/from-time-entries`** -- This is the #1 value proposition. Requires cross-service call to Bam API to fetch billable time entries, rate resolution, and line item generation.

2. **Implement PDF generation** -- Add a BullMQ job that renders an HTML template via Puppeteer, uploads to MinIO, and saves the URL. Wire it into `finalizeInvoice`. Add `GET /invoices/:id/pdf` for authenticated download.

3. **Implement email delivery on send** -- Add a BullMQ job triggered by `sendInvoice` that emails the PDF and public view link to the client.

### Priority 2: Feature Completeness

4. **Add `POST /invoices/from-deal`** endpoint and the `bill_create_invoice_from_deal` MCP tool.

5. **Build the Client Detail page** (`ClientDetailPage` component) showing invoice history, total billed, and outstanding amounts.

6. **Fix finalize/send semantics** -- Finalize should lock the invoice and generate PDF but keep status as a locked draft. Send should transition to `sent`.

7. **Emit Bolt events** from all mutation services (invoice created/sent/paid, payment recorded, expense submitted/approved).

8. **Add `amount_due` generated column** to match the design's computed column contract, or document the intentional deviation.

### Priority 3: Polish

9. **Enhance Invoice Edit page** to allow editing all fields including client, dates, discount, and inline line item editing.

10. **Upgrade client selector** to an autocomplete with inline "Create New Client" option.

11. **Add chart visualizations** to the Reports page (bar charts for revenue trend, stacked aging, profitability comparison).

12. **Implement receipt upload** on the Expense New page using MinIO file upload.

13. **Add Manager role** to the permission model so that Managers can create/edit invoices and approve expenses without full Admin access.

14. **Render public invoice view as HTML** instead of returning raw JSON.

---

*Generated by automated design audit on 2026-04-09.*
