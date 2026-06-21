# Bill — Dossier

Research dossier for the BigBlueBam "Bill" app (Invoicing & Billing). All paths
are repo-relative unless noted. Source of truth is code; docs are flagged where
they diverge.

---

## 1. App identity

- **App key:** `bill`
- **Display name:** Bill
- **Category:** Invoicing & billing
- **SPA path:** `/bill/` (served by nginx; React SPA `apps/bill/src`)
- **API path:** `/bill/api/` → bill-api Fastify service (internal `:4014`, routes
  under `/v1` except the public token routes). Source `apps/bill-api/src`.
- **MCP tools file:** `apps/mcp-server/src/tools/bill-tools.ts` (16 tools).
- **Docs dir:** `docs/apps/bill` (exists: guide.md, mcp-tools.md, marketing.md,
  meta.json, _narrative.md, _marketing_hook.md, 14 screenshots).
- **Prerequisites:**
  - User must be logged in to BigBlueBam (Bam session cookie). Unauthenticated
    visitors see a "Please log in to BigBlueBam first" screen linking to `/b3/`
    (`apps/bill/src/app.tsx` lines 132-144).
  - Org-scoped: every entity keys on `organization_id`; the SPA passes the active
    org via `X-Org-Id` header (`apps/bill/src/lib/api.ts` lines 21-51).
  - Per-action permissions enforced by the shared plugin
    (`apps/bill-api/src/plugins/permissions.ts`); mutating routes gated by
    `fastify.requireCan('bill.<entity>.<action>')`.
  - Optional integrations: Bam projects/tasks/time-entries (invoice-from-time,
    rates, profitability), Bond deals/companies (invoice-from-deal, client
    linking), Bolt (events), the Bam approvals API (Request approval),
    worker/SMTP (overdue reminders, deferred PDF/email).

---

## 2. Key concepts and vocabulary

- **Invoice** (`bill_invoices`, `apps/bill-api/src/db/schema/bill-invoices.ts`).
  A billable document for one **client**. Carries `from_*` (your company,
  snapshotted from settings at create time) and `to_*` (client, snapshotted at
  create time) fields, `invoice_number` (literally `"DRAFT"` until finalized),
  `invoice_date`, `due_date`, money in **integer minor units / cents**
  (`subtotal`, `tax_amount`, `discount_amount`, `total`, `amount_paid`),
  `tax_rate` (percent), `currency`, `public_view_token`, and timestamps
  `sent_at`/`viewed_at`/`paid_at`.
- **Invoice status** (`status varchar(20)`, no DB CHECK enum; values from service
  code + SPA filter list):
  - `draft` — editable, deletable, no number yet.
  - `sent` — finalized; number assigned; edits locked (Finalize sets this).
  - `viewed` — set when a client opens the public token URL (only `sent`→`viewed`).
  - `partially_paid` — at least one payment, balance remains.
  - `paid` — `amount_paid >= total`; sets `paid_at`; emits `invoice.paid`.
  - `overdue` — **never set by any API write path** (SPA filter + dashboard
    counter only; reports/worker compute overdue from `due_date`). See §9.
  - `void` — cancelled (non-draft only); excluded from reports.
  - `written_off` — appears only in report exclusion lists; no write path. See §9.
  SPA filter set: `['', 'draft','sent','viewed','paid','partially_paid','overdue','void']`
  (`apps/bill/src/pages/invoice-list.tsx` line 33).
- **Line item** (`bill_line_items`). `description`, `quantity`, `unit` (default
  `hours`), `unit_price` (cents), `amount = round(qty*unit_price)`; may carry
  `time_entry_ids[]`+`task_id` when generated from Bam time. Editable only on
  draft invoices (`line-item.service.ts::ensureDraftInvoice`).
- **Client** (`bill_clients`). Invoice recipient: name, email, phone, address,
  `tax_id`, `default_payment_terms_days` (30), `default_payment_instructions`,
  `notes`, optional `bond_company_id`. Distinct from Bond contacts/companies.
- **Payment** (`bill_payments`). `amount` (cents), `payment_method` enum,
  `reference`, `notes`, `paid_at` (date), `recorded_by`.
- **Expense** (`bill_expenses`). `description`, `amount` (cents), `category`,
  `vendor`, `expense_date`, `receipt_*`, `billable`, `invoiced`, `invoice_id`,
  `submitted_by`, `approved_by`, status.
- **Expense status** (default `pending`): `pending`→`approved`/`rejected`;
  `reimbursed` is a filter + edit-lock condition but has no write path. See §9.
- **Rate** (`bill_rates`). Scoped to org/project/user; `rate_amount` (cents),
  `rate_type` (`hourly`|`daily`|`fixed`, default hourly), `currency`,
  `effective_from`/`effective_to`.
- **Rate resolution** — "most specific wins": `user+project` > `user` > `project`
  > `organization`, filtered to rows whose date range contains the target date,
  newest `effective_from` first (`services/rate.service.ts::resolveRate`).
- **Settings** (`bill_settings`, PK = org). Company identity + invoice defaults
  (`default_currency`, `default_tax_rate`, `default_payment_terms_days`,
  `default_payment_instructions`, `default_footer_text`, `default_terms_text`,
  `invoice_prefix` default `INV`).
- **Invoice sequence** (`bill_invoice_sequences`). Per-org `prefix`+`next_number`,
  formatted `{prefix}-{number:05d}` → `INV-00001` (`lib/utils.ts`). Reserved under
  a best-effort Redis lock on finalize (`services/sequence.service.ts`). The
  Acme seeder uses `INV-2026-0042` which the live formatter would not produce. See §9.
- **Public view token** — opaque 64-char token granting unauthenticated read+PDF
  via `GET /invoice/:token`.
- **Worker job** (`bill_worker_jobs`). Async placeholder rows for `pdf_generate`
  (on finalize) and `email_send` (on send); status `pending|processing|completed|failed`.
- **Money convention:** all amounts are integer cents in DB/API; the SPA labels
  inputs "(cents)" and takes integers. Users literally type cents. See §9.

---

## 3. Feature inventory

Navigation (`apps/bill/src/components/layout/bill-sidebar.tsx`): a fixed quick
action **"New Invoice"** button, then nav items **Dashboard, Invoices, Clients,
Expenses, Rates, Reports**, and under a **"Bill Settings"** subheading the item
**"Bill Settings"** (routes to `/settings`). Logo wordmark: **"Bill"**. Routing in
`apps/bill/src/app.tsx`; the `?` key opens the embedded Help viewer (`/help`).

### 3.1 Dashboard
- **Location:** `/bill/` (default). View **"Dashboard"**, subtitle "Overview of
  invoicing activity." (`apps/bill/src/pages/dashboard.tsx`).
- **Elements:** four stat tiles **Outstanding**, **Paid**, **Overdue**, **Drafts**;
  a **"Recent activity"** table (Number, Client, Date, Total, Status) with a
  **"View all invoices"** link. Stats computed client-side from the full invoice
  list (`summarize`), not from a reports call.
- **Route:** `GET /v1/invoices`. Tiles and "View all" all navigate to `/`
  (placeholders — no deep-link/filter). Row click goes to `/invoices/:id`.

### 3.2 Invoices — list
- **Location:** `/bill/invoices`. View **"Invoices"**, subtitle "Manage and track
  all your invoices" (`apps/bill/src/pages/invoice-list.tsx`).
- **Actions/labels:** **"From Time Entries"** to `/invoices/from-time`; **"New
  Invoice"** to `/invoices/new`; status filter pills (empty = **"All"**); per-row
  **"PDF"**, **"Finalize"** (draft only), **"Request approval"**.
- **Columns:** Number, Client, Date, Due (date), Total, Due (balance = total minus
  amount_paid), Status, Actions. (Two columns are both headed "Due".)
- **Routes:** `GET /v1/invoices?status=`; `POST /v1/invoices/:id/finalize`;
  approval goes to the **Bam** API `POST /b3/api/v1/approvals` (not bill-api).
- **Approval modal** (lines 215-287): title **"Request approval for {number}"**,
  helper "Sends a Banter DM to the approver via Bolt.", an **"Approver"** select
  (Bam users from `GET /b3/api/v1/users?active_only=true`), a **"Message
  (optional)"** textarea, **"Cancel"**/**"Send request"**. Posts
  `subject_type:"bill.invoice"`.

### 3.3 Invoices — create (manual)
- **Location:** `/bill/invoices/new`. View **"New Invoice"**
  (`apps/bill/src/pages/invoice-new.tsx`).
- **Fields:** **"Client"** select (`GET /v1/clients`); a **"Line Items"** editable
  table (Description, Qty, Unit Price, Amount, remove "X"); **"+ Add line item"**;
  totals box with **Subtotal**, editable **"Tax Rate"**, computed **Tax**,
  **Total**; **"Notes (internal)"** textarea.
- **Actions:** **"Create Draft Invoice"** (disabled until a client is chosen),
  **"Cancel"** (to `/`).
- **Routes:** `POST /v1/invoices` then a per-row loop of
  `POST /v1/invoices/:id/line-items`, then navigate to detail.

### 3.4 Invoices — from time entries
- **Location:** `/bill/invoices/from-time`. View **"Invoice from Time Entries"**,
  subtitle "Generate an invoice from Bam time tracking data"
  (`apps/bill/src/pages/invoice-from-time.tsx`).
- **State:** **non-functional stub.** Amber banner ("This wizard requires Bam time
  entries integration… Create invoices manually…"), free-text **"Project"**,
  **"Date From"/"Date To"**, a **disabled** **"Preview Line Items"** button, and
  **"Create Manually Instead"** (to `/invoices/new`). Makes **no API call**.
- **Route (exists, MCP/API only):** `POST /v1/invoices/from-time-entries`
  `{project_id, time_entry_ids[], client_id}`. Service `createInvoiceFromTimeEntries`
  (`invoice.service.ts` 449-599): joins `time_entries`+`tasks`, verifies project
  ownership, groups by user+task, resolves rate per group (errors if no rate),
  builds items "{task} - {user} ({hours}h)", creates draft, inserts items,
  recalcs. See §9 — only the MCP tool / direct API can drive this.

### 3.5 Invoices — detail
- **Location:** `/bill/invoices/:id`. Header: number, client, status badge
  (`apps/bill/src/pages/invoice-detail.tsx`).
- **Header actions (status-conditional):** **"Edit"** (draft, to `/edit`);
  **"Finalize"** (draft, `POST .../finalize`); **"Re-send"** (sent/viewed,
  `POST .../send`); **"Void"** (non-draft/non-void, `POST .../void`);
  **"Duplicate"** (always, `POST .../duplicate`, navigates to new draft);
  **"Request approval"** (inline form, posts to Bam approvals); **"PDF"** link.
- **Body:** From/To panels; Invoice Date / Due Date / Total / Amount Due tiles;
  read-only line items with Subtotal/Tax(rate%)/Discount/Total footer; Payments
  section; inline **"PDF preview"** iframe (if pdf_url).
- **Payments:** **"Record Payment"** (shown when status not draft/void/paid),
  **"Amount (cents)"** input + **"Method"** select (Bank Transfer, Credit Card,
  Check, Cash, Stripe, PayPal, Other) + **"Save Payment"**. Lists payments
  (Date, Method, Amount).
- **Routes:** `GET /v1/invoices/:id`; `POST /v1/invoices/:id/payments`;
  `GET /v1/invoices/:id/pdf`.

### 3.6 Invoices — edit (draft only)
- **Location:** `/bill/invoices/:id/edit`. Title **"Edit Invoice {number}"**
  (`apps/bill/src/pages/invoice-edit.tsx`). Non-draft shows "Only draft invoices
  can be edited." + "Back to Invoice".
- **Fields:** **"Tax Rate (%)"**, **"Internal Notes"**, **"Footer Text (on
  invoice)"**, **"Terms & Conditions (on invoice)"**; **"Save Changes"**/**"Cancel"**.
- **Route:** `PATCH /v1/invoices/:id` (rejects non-draft). NOTE: edit UI cannot
  add/remove line items or change the client — only tax/notes/footer/terms.

### 3.7 Clients — list
- **Location:** `/bill/clients`. View **"Clients"**, subtitle "Manage billing
  clients" (`apps/bill/src/pages/client-list.tsx`).
- **Actions:** **"New Client"** opens an inline **"Name"**/**"Email"** form +
  **"Create Client"**. Columns: Name, Email, Phone, **Terms** (`{n} days`). Row
  goes to `/clients/:id`.
- **Routes:** `GET /v1/clients?search=`, `POST /v1/clients`.

### 3.8 Clients — detail
- **Location:** `/bill/clients/:id` (`apps/bill/src/pages/client-detail.tsx`).
- **Elements:** back arrow; **"Edit"** toggle for inline edit of Name/Email/Phone
  (Contact Information) and Address Line 1/2, City, State, ZIP, Tax ID (Address &
  Tax) + Notes; **"Save"**/**"Cancel"**. Summary cards **Total Billed**, **Total
  Paid**, **Outstanding Balance** (client-side from this client's invoices).
  Read-only panels show address, Tax ID, payment terms, notes. An **"Invoices"**
  table (Invoice #, Date, Status, Total, Paid, Due) + **"+ New Invoice"** link
  (to `/invoices/new`, does not pre-select the client).
- **Routes:** `GET /v1/clients/:id`, `GET /v1/invoices?client_id=`,
  `PATCH /v1/clients/:id`.

### 3.9 Expenses — list
- **Location:** `/bill/expenses`. View **"Expenses"**, subtitle "Track project
  expenses and receipts" (`apps/bill/src/pages/expense-list.tsx`).
- **Actions:** **"New Expense"** to `/expenses/new`; status pills
  `['', 'pending','approved','rejected','reimbursed']`; per-row (pending only)
  **"Approve"**/**"Reject"**.
- **Columns:** Description, Category, Vendor, Date, Amount, Status, Actions.
- **Routes:** `GET /v1/expenses?status=`; `POST /v1/expenses/:id/approve`;
  `POST /v1/expenses/:id/reject`.

### 3.10 Expenses — create
- **Location:** `/bill/expenses/new`. View **"New Expense"**
  (`apps/bill/src/pages/expense-new.tsx`).
- **Fields:** **"Description"**, **"Amount (cents)"**, **"Date"**, **"Category"**
  select (Software, Travel, Hardware, Contractor, Office, Meals, Other),
  **"Vendor"**, **"Billable to client"** checkbox. **"Submit Expense"**/**"Cancel"**.
- **Route:** `POST /v1/expenses` (defaults `status:pending`, `billable:false`,
  `invoiced:false`).
- **API-only (no UI):** `PATCH /v1/expenses/:id`, `DELETE /v1/expenses/:id`,
  `POST /v1/expenses/:id/receipt` (multipart, 10/min). See §9.

### 3.11 Rates
- **Location:** `/bill/rates`. View **"Billing Rates"**, subtitle "Configure
  hourly, daily, or fixed rates per org/project/user"
  (`apps/bill/src/pages/rate-list.tsx`).
- **Actions:** **"New Rate"** opens an inline **"Rate (cents)"** (default 15000) +
  **"Type"** (Hourly/Daily/Fixed) + **"Create Rate"**. Columns: Rate, Type,
  **Scope** (derived: User + Project / User / Project / Organization), Effective
  From, Actions (**"Delete"**).
- **Routes:** `GET /v1/rates`, `POST /v1/rates`, `DELETE /v1/rates/:id`.
- **API-only (no UI):** the form only sets amount+type (so UI creates org-default
  rates only); `PATCH /v1/rates/:id` and `GET /v1/rates/resolve` have no control.
  See §9.

### 3.12 Reports
- **Location:** `/bill/reports`. View **"Financial Reports"**
  (`apps/bill/src/pages/reports.tsx`). Four tables:
  - **"Revenue by Month"** (Month, Invoiced, Collected, Count) ->
    `GET /v1/reports/revenue`.
  - **"Outstanding Aging"** (Client + 0-30/31-60/61-90/90+ buckets) ->
    `GET /v1/reports/outstanding`.
  - **"Project Profitability"** (Project, Revenue, Expenses, Profit, Margin) ->
    `GET /v1/reports/profitability`.
  - **"Overdue Invoices"** (Invoice, Client, Amount Due, Days Overdue; rows link
    to invoice) -> `GET /v1/reports/overdue`.
- Report routes are gated by `fastify.requireCan('bill.report_*.list')`.

### 3.13 Settings
- **Location:** `/bill/settings`. View **"Billing Settings"**
  (`apps/bill/src/pages/settings.tsx`).
- **"Company Information":** Company Name, Email, Phone, Tax ID, Address.
- **"Invoice Defaults":** Invoice Prefix, Default Tax Rate (%), Payment Terms
  (days), Default Payment Instructions, Default Footer Text, Default Terms &
  Conditions. **"Save Settings"** (shows "Saved!").
- **Routes:** `GET /v1/settings`, `PUT /v1/settings`. NOTE: `company_logo_url`
  and `default_currency` are in the schema/PUT but absent from the UI.

### 3.14 Public invoice view (no SPA, API only)
- **Routes:** `GET /invoice/:token` (safe field subset; excludes org_id,
  created_by, bond_deal_id, tax IDs; auto-marks `viewed`), `GET /invoice/:token/pdf`
  (on-the-fly PDF). (`routes/public.routes.ts`, `invoice.service.ts::getInvoiceByToken`).
- No Bill SPA route for the public page; marketing's "client portal / public
  invoice pages" = these token endpoints (presumably linked from a sent email). See §9.

### 3.15 PDF generation
- **Authenticated:** `GET /v1/invoices/:id/pdf` (inline, filename = number or
  `DRAFT.pdf`), rendered with pdf-lib (`services/pdf.service.ts`).
- **Async placeholder:** finalize enqueues `pdf_generate`; send enqueues
  `email_send`. `GET /v1/invoices/:id/jobs` returns latest job state for "PDF
  generating…". Handlers `apps/worker/src/jobs/bill-pdf-generate.job.ts`,
  `bill-email-send.job.ts`, wired in `apps/worker/src/worker.ts`.

### 3.16 Overdue reminder sweep (worker, automated)
- **Job:** `apps/worker/src/jobs/bill-overdue-reminder.job.ts`, scheduled daily at
  09:00 UTC (cron pattern `0 9 star star star`, `worker.ts` line 861). Finds
  invoices past `due_date`, not paid/void/written_off, not reminded in 7 days;
  emails the client (or logs if no SMTP), stamps `overdue_reminder_last_sent_at`,
  bumps `overdue_reminder_count`, emits `invoice.overdue` (source `bill`,
  actor_type `system`).

---

## 4. Backend REST route reference

All under prefix `/v1` unless noted. Auth via `requireAuth`; mutations also need
`requireScope('read_write')` and a `requireCan('bill.*')` permission.

Invoices (`routes/invoices.routes.ts`):
- `GET /invoices` — list; filters `status, client_id, project_id, date_from, date_to`.
- `POST /invoices` — create draft. Body: `client_id`(req), `project_id?`,
  `invoice_date?`, `due_date?`, `tax_rate?`(0-100), `discount_amount?`(cents),
  `payment_terms_days?`(0-365), `payment_instructions?`, `notes?`, `footer_text?`,
  `terms_text?`, `bond_deal_id?`. Emits `invoice.created` (source manual).
- `GET /invoices/:id` — detail incl. `line_items`, `payments`.
- `PATCH /invoices/:id` — update (draft only; 400 otherwise).
- `DELETE /invoices/:id` — delete (draft only; 400 otherwise).
- `POST /invoices/:id/line-items` — add (draft only). Body: `description`,
  `quantity?`, `unit?`, `unit_price`(cents), `sort_order?`, `time_entry_ids?`, `task_id?`.
- `PATCH /invoices/:id/line-items/:itemId` — update (draft only).
- `DELETE /invoices/:id/line-items/:itemId` — delete (draft only).
- `POST /invoices/:id/finalize` — draft to `sent`, assigns number, emits
  `invoice.finalized`, enqueues `pdf_generate` job.
- `POST /invoices/:id/send` — set `sent` + `sent_at`; rejects draft ("Finalize the
  invoice before sending") and void; emits `invoice.sent`, enqueues `email_send`.
- `POST /invoices/:id/void` — to `void`; rejects draft ("delete it instead") and
  already-void.
- `POST /invoices/:id/duplicate` — clone as new draft (copies line items too).
- `GET /invoices/:id/jobs` — latest `pdf_generate`/`email_send` job state.
- `GET /invoices/:id/pdf` — PDF bytes.
- `POST /invoices/from-time-entries` — body `{project_id, time_entry_ids[]>=1, client_id}`.
- `POST /invoices/from-deal` — body `{deal_id, client_id}`; pulls Bond deal value
  as one line item; emits `invoice.created` (source deal).

Payments (`routes/payments.routes.ts`):
- `POST /invoices/:id/payments` — body `amount`(cents,>0), `payment_method?`(enum),
  `reference?`, `notes?`, `paid_at?`. Rejects draft/void; rejects overpayment
  beyond remaining balance (BILL-004). Sets `paid`/`partially_paid`; emits
  `payment.recorded` always and `invoice.paid` when fully paid.
- `DELETE /payments/:id` — delete payment, recompute totals.

Clients (`routes/clients.routes.ts`): `GET /clients?search=`, `POST /clients`,
`GET /clients/:id`, `PATCH /clients/:id`, `DELETE /clients/:id`.

Expenses (`routes/expenses.routes.ts`): `GET /expenses` (filters project_id,
category, status, dates), `POST /expenses`, `PATCH /expenses/:id` (blocked once
approved/reimbursed), `DELETE /expenses/:id`, `POST /expenses/:id/approve`
(pending to approved), `POST /expenses/:id/reject` (pending to rejected),
`POST /expenses/:id/receipt` (multipart upload to MinIO, 10/min limit).

Rates (`routes/rates.routes.ts`): `GET /rates` (filter project_id, user_id),
`POST /rates`, `PATCH /rates/:id`, `DELETE /rates/:id`,
`GET /rates/resolve?project_id&user_id&date` returns `{data, scope}` with scope one
of `user+project|user|project|organization|none`.

Reports (`routes/reports.routes.ts`): `GET /reports/revenue?date_from&date_to`,
`GET /reports/outstanding`, `GET /reports/profitability`, `GET /reports/overdue`.

Settings (`routes/settings.routes.ts`): `GET /settings`, `PUT /settings`.

Public (`routes/public.routes.ts`, no prefix): `GET /invoice/:token`,
`GET /invoice/:token/pdf`.

State/validation rules implying user-facing behavior:
- Invoices are only editable/deletable/line-item-editable in `draft`.
- Finalize is one-way and assigns the permanent number (DRAFT to `{prefix}-NNNNN`).
- Payments cannot exceed remaining balance; a full payment flips to `paid` and
  emits `invoice.paid`.
- Expenses lock after approve/reimburse; only `pending` can be approved/rejected.
- Reports exclude `draft`, `void`, `written_off` (revenue/profitability) and also
  `paid` (outstanding/overdue). Profitability counts only `approved` expenses.

---

## 5. MCP tools (`apps/mcp-server/src/tools/bill-tools.ts`)

16 tools; each maps to a human feature. Tools resolve fuzzy identifiers: client
names/emails via `GET /clients?search=` (`resolveBillClientId`), Bam project names
via `GET /projects` (`resolveBamProjectId`).

| Tool | Does | Human feature / route |
|---|---|---|
| `bill_list_invoices` | List invoices (status/client/project/date filters) | Invoices list, `GET /invoices` |
| `bill_get_invoice` | Full detail incl. line items + payments | Invoice detail, `GET /invoices/:id` |
| `bill_create_invoice` | Create blank draft (resolves client/project) | New Invoice, `POST /invoices` |
| `bill_create_invoice_from_time` | Invoice from Bam time entries | (no working UI), `POST /invoices/from-time-entries` |
| `bill_create_invoice_from_deal` | Draft from a Bond deal (deal_id must be UUID; hint `{{ event.deal.id }}` in Bolt) | (no UI), `POST /invoices/from-deal` |
| `bill_add_line_item` | Add a line item to a draft | New Invoice line items, `POST /invoices/:id/line-items` |
| `bill_finalize_invoice` | Finalize draft, assign number, lock | Finalize button, `POST /invoices/:id/finalize` |
| `bill_send_invoice` | Mark sent (triggers email if configured) | Re-send button, `POST /invoices/:id/send` |
| `bill_record_payment` | Record a payment (method enum, reference) | Record Payment, `POST /invoices/:id/payments` |
| `bill_get_overdue` | Overdue invoices + days/amount | Reports: Overdue, `GET /reports/overdue` |
| `bill_get_revenue_summary` | Revenue by month | Reports: Revenue, `GET /reports/revenue` |
| `bill_get_profitability` | Revenue vs expenses per project | Reports: Profitability, `GET /reports/profitability` |
| `bill_list_expenses` | List expenses (project/category/status) | Expenses list, `GET /expenses` |
| `bill_create_expense` | Log an expense | New Expense, `POST /expenses` |
| `bill_resolve_rate` | Effective rate for project+user+date | (no UI), `GET /rates/resolve` |
| `bill_list_clients` | List/search clients (enriched: company_id/name, currency, terms) | Clients list, `GET /clients` |

Tool coverage gaps vs API: no MCP tools for void, duplicate, update invoice,
delete invoice/line-item, create/update client, update/delete rate, approve/reject
expense, PDF, settings, or delete payment.

---

## 6. Candidate user stories

1. **Manual invoice end to end.** Clients to New Client (name/email). Invoices to
   New Invoice, pick client, add line items + tax, Create Draft Invoice. On detail,
   Edit (notes/footer/terms) then Finalize (number assigned) then Re-send if needed.
   Record Payment(s) until status flips to paid. (Routes: clients POST, invoices
   POST + line-items POST, PATCH, finalize, send, payments POST.)
2. **Invoice from tracked time (agent/API only today).** Configure a rate (Rates to
   New Rate, or API for project/user scope), then `bill_create_invoice_from_time` /
   `POST /invoices/from-time-entries` with project + time entry IDs, review the
   generated line items, Finalize, Send. (UI stub blocks the human path.)
3. **Bond deal to invoice handoff.** From a won Bond deal, an agent or Bolt rule
   calls `bill_create_invoice_from_deal` (deal_id = `{{ event.deal.id }}`) to get a
   draft with the deal value as one line item, then a human Finalizes/Sends. (The
   Acme scenario seeds exactly this: `INV-2026-0042` linked to the Acme deal.)
4. **Invoice approval before sending.** On an invoice (list or detail), Request
   approval, pick a Bam user as approver, which sends a Banter DM via the Bam
   approvals API (`subject_type: bill.invoice`); the approver acts in Bam. (Acme
   scenario seeds an `approval.requested` for the MSA invoice.)
5. **Collect payment & track status.** Open a sent invoice, Record Payment (amount
   in cents, method); partial payments show `partially_paid`; the final payment
   shows `paid`. Watch the Dashboard Outstanding/Paid tiles.
6. **Expense capture + approval.** Expenses to New Expense (mark billable);
   submitter creates as pending; reviewer Approves/Rejects on the list. (Receipt
   upload + edit are API-only.)
7. **Period close / financial review.** Reports: Revenue by Month, Outstanding
   Aging, Project Profitability, Overdue Invoices. Same data via
   `bill_get_revenue_summary` / `bill_get_profitability` / `bill_get_overdue`.
8. **Configure the billing identity.** Bill Settings: company info + invoice
   defaults (prefix, tax rate, terms, footer/terms text) so new invoices and PDFs
   inherit them.
9. **Automated overdue dollar-chasing.** Worker sweep (09:00 UTC) emails overdue
   clients and emits `invoice.overdue`; a Bolt rule can escalate or notify the
   account owner.

---

## 7. Agent flows

- **Drive invoicing from chat/automation:** the 16 MCP tools let an agent create
  clients-by-name, build a draft (manual / from-time / from-deal), add line items,
  finalize, send, and record payments — the full lifecycle except void/duplicate/
  delete/edit, which remain human/API only.
- **Bolt-triggered invoice from deal:** `bill_create_invoice_from_deal` is
  explicitly documented for use inside a Bolt rule with `{{ event.deal.id }}` from a
  `deal.*` event (tool description). Canonical Bond-to-Bill automation entry point.
- **Approval routing:** invoices are an approvable subject (`subject_type:
  "bill.invoice"`); the platform approval queue / `proposal_*` tools and the Bam
  approvals API both reference Bill invoices (Acme seeder; event-catalog line 2234).
- **Events agents/rules consume** (registered in
  `apps/bolt-api/src/services/event-catalog.ts`, all source `bill`):
  `invoice.created`, `invoice.finalized`, `invoice.sent`, `invoice.paid`,
  `payment.recorded`, `invoice.pdf_generated`, `invoice.email_sent`,
  `invoice.overdue`. Payloads are enriched (customer, company, project, deal,
  money, deep-link `url`, `pdf_url`).
- **Visibility:** `bill.invoice` is in the cross-app entity surface; agents posting
  Bill data into shared surfaces should run `can_access` per platform convention
  (`docs/reference/agent-conventions.md`).

---

## 8. Screenshots available

In `docs/apps/bill/screenshots/{light,dark}/` (identical set per theme; labels from
`meta.json`, 1440x900, captured 2026-04-17):

| File | Depicts | Illustrates step |
|---|---|---|
| `01-invoice-list.png` | Invoice list with status filter pills + actions | Story 1/5 (Invoices view, Finalize) |
| `02-invoice-new.png` | New Invoice form (client select, line items, totals) | Story 1 (create manual invoice) |
| `03-clients.png` | Clients list | Story 1/6 (client management) |
| `04-expenses.png` | Expenses list | Story 6 (expense capture/approval) |
| `05-rates.png` | Billing Rates list | Story 2 (rate config for from-time) |
| `06-reports.png` | Financial Reports (revenue/aging/profitability/overdue) | Story 7 (period close) |
| `07-settings.png` | Billing Settings | Story 8 (billing identity) |

No screenshots exist for: invoice detail, invoice edit, invoice-from-time stub,
client detail, expense create, or the public token view.

---

## 9. Discrepancies (docs/marketing vs code)

1. **"Invoice from Time Entries" is a non-functional stub in the UI.** guide.md and
   marketing list "Create invoices from Bam time entries in one click" as a headline
   feature, but `apps/bill/src/pages/invoice-from-time.tsx` is a disabled placeholder
   that makes no API call and tells the user to "Create Manually Instead." The
   backend (`POST /invoices/from-time-entries`) and the MCP tool work; only the human
   UI path is missing. (Per project memory: a broken feature is a bug, and the
   missing wiring is the fix — flag for the writer.)
2. **`overdue` status is never written by an API path.** It is a SPA filter and a
   dashboard counter, but no service transitions an invoice to `overdue`. Overdue is
   computed by reports/worker via `due_date <= today AND not paid/void`. So the
   "Overdue" filter pill and the dashboard "Overdue" count (which match
   `status === 'overdue'`) effectively never fire. The Reports to Overdue table uses
   the correct computed logic.
3. **`written_off` status has no write path.** It only appears in report exclusion
   lists; no UI/API sets it. Vocabulary only; treat as aspirational.
4. **`reimbursed` expense status has no write path.** It is a filter option and an
   edit-lock condition, but nothing sets `reimbursed`. Approve sets `approved`.
5. **Invoice number format mismatch.** `formatInvoiceNumber` produces `INV-00001`
   (5-digit zero-pad), but the Acme seeder, the from-deal/finalize event docs example
   ("INV-0042"), and several docs use year-based forms like `INV-2026-0042`. Live
   finalize produces `INV-00001`-style numbers.
6. **No recurring billing.** The orchestrator brief lists "recurring billing," but
   there is **no recurring/subscription code** anywhere in bill-api, the worker, or
   the schema (grep for `recurring` returns nothing). Treat as not implemented.
7. **"Client portal / public invoice pages" is API-only.** Marketing implies a
   portal; in code it is two unauthenticated API endpoints (`/invoice/:token`,
   `/invoice/:token/pdf`) with no Bill SPA route and no "pay" action (payment is
   recorded internally, not by the client). No online payment collection exists.
8. **Rate creation UI is org-default only.** guide.md says rates can be set "per
   project or team member," but the Rates form only sets amount + type
   (`rate-list.tsx`), so the UI can only create org-scoped rates; project/user/
   effective-date scoping requires the API/seed (the resolver and schema fully
   support it).
9. **Several backend capabilities have no UI control:** expense update/delete and
   receipt upload; rate update and `rates/resolve`; invoice update is limited to
   tax/notes/footer/terms (no line-item or client edit post-create); settings UI
   omits `company_logo_url` and `default_currency`.
10. **Money is entered as raw cents in the UI.** Amount/rate/payment inputs are
    labeled "(cents)" and take integers; there is no dollars formatting on input.
    Worth a note for the writer (a user typing "150" means $1.50).
11. **MCP `bill_create_invoice_from_time` param shape looks incompatible with the
    API.** The tool input is `{project_id, client_id, date_from, date_to}` and it
    forwards those, but `fromTimeEntriesSchema` requires `time_entry_ids[]` and
    ignores dates — so the call would fail validation (missing `time_entry_ids`).
    Likely a real bug; flag for verification.

---

## 10. Open questions

- Is the invoice-from-time UI stub intended to ship, or should the working flow be
  wired before help docs are written? (Affects whether to document a UI path.)
- Does any environment ever set `status = 'overdue'` (e.g., a trigger or job not in
  this tree)? If not, the "Overdue" filter/tile are dead UI.
- What surfaces the public `/invoice/:token` link to a client? No email template or
  SPA link to the token was found in this app's tree (the email worker exists but
  `bill-email-send.job.ts` body was not inspected here).
- Is `bill_create_invoice_from_time` exercised in any test/integration harness? Its
  param shape appears incompatible with the API schema (Discrepancy 11).
- Are `pdf_generate` / `email_send` worker handlers fully functional or still the
  "deferred placeholder" the schema comment describes? (`bill_worker_jobs` rows may
  sit `pending`.)
