# Bill — Invoicing & Billing for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Bill (Invoicing & Billing)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Bill is the invoicing, billing, and financial tracking platform for the BigBlueBam suite. It enables teams to generate invoices from Bam time entries, Bond deal closures, or manual line items — and to track payments, expenses, and basic financial reporting without leaving the suite.

Bill addresses a fundamental gap: teams track work in Bam, close deals in Bond, and log time — but then switch to QuickBooks, FreshBooks, or a spreadsheet to invoice the client. Bill closes that loop. Time logged against Bam tasks generates invoice line items. Bond deals closing triggers invoice creation. Blank forms can capture expense receipts.

Bill is deliberately **lightweight financial tooling for project-based teams**, not a full accounting system. It does not handle double-entry bookkeeping, payroll, tax filing, inventory management, or chart of accounts. It generates invoices, tracks whether they are paid, and provides enough financial visibility to answer "are we profitable on this project?"

### 1.2 Core Principles

1. **Time-to-invoice pipeline.** Bam time entries flow into Bill as billable line items. Invoicing a project is a one-click operation: select a date range, and Bill pulls all unbilled time entries, applies the configured billing rate, and generates a draft invoice.
2. **Bond-to-invoice pipeline.** When a Bond deal closes-won, Bill can auto-generate an invoice for the deal value — especially useful for milestone-based or retainer billing.
3. **PDF-first.** Invoices render as professional PDF documents with configurable branding (logo, colors, footer). PDFs are generated server-side, stored in MinIO, and downloadable or emailable directly from Bill.
4. **Payment tracking, not processing.** Bill tracks invoice status (draft, sent, viewed, paid, overdue) and records payments. It does not process credit card transactions. Payment processing is handled by linking to external payment providers (Stripe payment links, bank transfer instructions) embedded in the invoice.
5. **Expense tracking.** Simple expense logging with receipt attachment (via MinIO), categorization, and linkage to projects. This feeds into project profitability calculations.
6. **AI invoice generation.** MCP tools let agents draft invoices, flag overdue payments, calculate project profitability, and generate financial summaries.

### 1.3 Non-Goals

- Bill is **not** an accounting system. No general ledger, no chart of accounts, no journal entries, no accounts receivable/payable aging beyond invoice tracking.
- Bill does **not** process payments. No credit card forms, no Stripe Connect integration, no ACH processing. Payment links (Stripe, PayPal, bank details) are embedded in invoice PDFs as text/URLs.
- Bill does **not** handle payroll, tax withholding, or tax filing.
- Bill does **not** support multi-currency at launch. All amounts are in the organization's configured currency. Multi-currency support (exchange rates, conversion) is future work.
- Bill does **not** include recurring/subscription billing management at launch. Recurring invoices can be scheduled via Bolt automations.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  bill-api/           → Fastify REST API (invoice CRUD, payment tracking, expense management, PDF generation)
  bill/               → React SPA (invoice editor, payment tracker, expense log, financial dashboard)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **bill-api** (Fastify :4012) | REST API for invoices, line items, payments, expenses, billing rates, clients |
| **PostgreSQL 16** | All billing data (shared DB, `bill_` prefix) |
| **Redis 7** | Invoice number sequence lock, overdue check caching |
| **BullMQ Worker** | PDF generation, invoice email delivery, overdue reminders, time-entry-to-invoice aggregation |
| **MinIO** | Invoice PDFs, receipt images, logo assets |
| **MCP Server** | Full billing tool surface for AI agents |

### 2.3 nginx Routing

```nginx
location /bill/ {
    alias /usr/share/nginx/html/bill/;
    try_files $uri $uri/ /bill/index.html;
}

location /bill/api/ {
    proxy_pass http://bill-api:4012/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Public invoice view (token-based, no auth)
location /invoice/ {
    proxy_pass http://bill-api:4012/invoice/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.4 Docker Service

```yaml
bill-api:
  build:
    context: .
    dockerfile: apps/bill-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
    - MINIO_ENDPOINT=minio:9000
    - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
    - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    - PUBLIC_URL=${PUBLIC_URL}
    - SMTP_HOST=${SMTP_HOST}
    - SMTP_PORT=${SMTP_PORT:-587}
    - SMTP_USER=${SMTP_USER}
    - SMTP_PASS=${SMTP_PASS}
  ports:
    - "4012:4012"
  depends_on:
    - postgres
    - redis
    - mcp-server
    - minio
```

---

## 3. Data Model

### 3.1 PostgreSQL Schema

```sql
-- ============================================================
-- BILL: Invoicing & Billing
-- ============================================================

-- Billing clients (may map to Bond companies or standalone)
CREATE TABLE bill_clients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Identity
    name                VARCHAR(255) NOT NULL,
    email               VARCHAR(255),                  -- primary billing contact email
    phone               VARCHAR(50),
    -- Address (for invoice rendering)
    address_line1       VARCHAR(255),
    address_line2       VARCHAR(255),
    city                VARCHAR(100),
    state_region        VARCHAR(100),
    postal_code         VARCHAR(20),
    country             VARCHAR(2),
    tax_id              VARCHAR(50),                   -- VAT number, EIN, etc.
    -- Bond linkage
    bond_company_id     UUID REFERENCES bond_companies(id) ON DELETE SET NULL,
    -- Payment terms
    default_payment_terms_days INTEGER NOT NULL DEFAULT 30,
    default_payment_instructions TEXT,                  -- bank details, Stripe link, etc.
    -- Notes
    notes               TEXT,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_clients_org ON bill_clients(organization_id);
CREATE INDEX idx_bill_clients_bond ON bill_clients(bond_company_id);

-- Billing rates (configurable per org, project, or user)
CREATE TABLE bill_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org default
    user_id             UUID REFERENCES users(id) ON DELETE CASCADE,     -- NULL = applies to all users
    -- Rate
    rate_amount         BIGINT NOT NULL,               -- in cents (e.g., 15000 = $150.00)
    rate_type           VARCHAR(10) NOT NULL DEFAULT 'hourly'
                        CHECK (rate_type IN ('hourly', 'daily', 'fixed')),
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    -- Scope priority: user+project > user > project > org
    -- Resolved in query: most specific match wins
    effective_from      DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to        DATE,                          -- NULL = no end
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_rates_org ON bill_rates(organization_id);
CREATE INDEX idx_bill_rates_resolve ON bill_rates(organization_id, project_id, user_id, effective_from);

-- Invoice number sequence (per org, gap-free)
CREATE TABLE bill_invoice_sequences (
    organization_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    prefix              VARCHAR(20) NOT NULL DEFAULT 'INV',
    next_number         INTEGER NOT NULL DEFAULT 1,
    format_pattern      VARCHAR(50) NOT NULL DEFAULT '{prefix}-{number:05d}'
    -- e.g., "INV-00001", "INV-00002"
);

-- Invoices
CREATE TABLE bill_invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES bill_clients(id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,

    -- Invoice identity
    invoice_number      VARCHAR(50) NOT NULL,
    invoice_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date            DATE NOT NULL,

    -- Status
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'sent', 'viewed', 'paid', 'partially_paid', 'overdue', 'void', 'written_off')),

    -- Amounts (computed from line items, stored for query performance)
    subtotal            BIGINT NOT NULL DEFAULT 0,     -- sum of line item amounts (cents)
    tax_rate            NUMERIC(5,2) DEFAULT 0,        -- percentage (e.g., 8.25)
    tax_amount          BIGINT NOT NULL DEFAULT 0,     -- computed: subtotal * tax_rate / 100
    discount_amount     BIGINT NOT NULL DEFAULT 0,     -- flat discount in cents
    total               BIGINT NOT NULL DEFAULT 0,     -- subtotal + tax - discount
    amount_paid         BIGINT NOT NULL DEFAULT 0,     -- sum of payments received
    amount_due          BIGINT GENERATED ALWAYS AS (total - amount_paid) STORED,
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',

    -- Sender info (snapshot at invoice creation for immutability)
    from_name           VARCHAR(255),
    from_email          VARCHAR(255),
    from_address        TEXT,
    from_logo_url       TEXT,
    from_tax_id         VARCHAR(50),

    -- Client info (snapshot)
    to_name             VARCHAR(255),
    to_email            VARCHAR(255),
    to_address          TEXT,
    to_tax_id           VARCHAR(50),

    -- Payment
    payment_terms_days  INTEGER NOT NULL DEFAULT 30,
    payment_instructions TEXT,                          -- bank details, Stripe link

    -- Notes
    notes               TEXT,                          -- internal notes (not on invoice)
    footer_text         TEXT,                          -- printed on invoice PDF
    terms_text          TEXT,                          -- printed on invoice PDF

    -- Bond linkage
    bond_deal_id        UUID REFERENCES bond_deals(id) ON DELETE SET NULL,

    -- PDF
    pdf_url             TEXT,                          -- MinIO URL of generated PDF
    public_view_token   VARCHAR(64) DEFAULT encode(gen_random_bytes(32), 'hex'),

    -- Tracking
    sent_at             TIMESTAMPTZ,
    viewed_at           TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    overdue_reminder_sent_at TIMESTAMPTZ,

    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_invoices_org ON bill_invoices(organization_id);
CREATE INDEX idx_bill_invoices_client ON bill_invoices(client_id);
CREATE INDEX idx_bill_invoices_project ON bill_invoices(project_id);
CREATE INDEX idx_bill_invoices_status ON bill_invoices(status);
CREATE INDEX idx_bill_invoices_due ON bill_invoices(due_date) WHERE status NOT IN ('paid', 'void', 'written_off');
CREATE INDEX idx_bill_invoices_number ON bill_invoices(organization_id, invoice_number);
CREATE INDEX idx_bill_invoices_token ON bill_invoices(public_view_token);

-- Invoice line items
CREATE TABLE bill_line_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          UUID NOT NULL REFERENCES bill_invoices(id) ON DELETE CASCADE,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    -- Description
    description         TEXT NOT NULL,
    -- Quantity & rate
    quantity            NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit                VARCHAR(20) DEFAULT 'hours',   -- 'hours', 'days', 'units', 'fixed'
    unit_price          BIGINT NOT NULL,               -- price per unit in cents
    amount              BIGINT NOT NULL,               -- quantity * unit_price (cents)
    -- Bam time entry linkage
    time_entry_ids      UUID[],                        -- Bam time_entries that this line item aggregates
    -- Bam task linkage
    task_id             UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_items_invoice ON bill_line_items(invoice_id, sort_order);

-- Payments received
CREATE TABLE bill_payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          UUID NOT NULL REFERENCES bill_invoices(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    amount              BIGINT NOT NULL,               -- payment amount in cents
    payment_method      VARCHAR(30)
                        CHECK (payment_method IN ('bank_transfer', 'credit_card', 'check', 'cash', 'stripe', 'paypal', 'other')),
    reference           VARCHAR(255),                  -- transaction ID, check number, etc.
    notes               TEXT,
    paid_at             DATE NOT NULL DEFAULT CURRENT_DATE,
    recorded_by         UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_payments_invoice ON bill_payments(invoice_id);
CREATE INDEX idx_bill_payments_org ON bill_payments(organization_id, paid_at DESC);

-- Expenses (project-linked cost tracking)
CREATE TABLE bill_expenses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
    -- Expense data
    description         TEXT NOT NULL,
    amount              BIGINT NOT NULL,               -- in cents
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    category            VARCHAR(60),                   -- e.g., 'software', 'travel', 'hardware', 'contractor'
    vendor              VARCHAR(255),
    expense_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Receipt
    receipt_url         TEXT,                           -- MinIO URL
    receipt_filename    VARCHAR(255),
    -- Status
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'reimbursed')),
    approved_by         UUID REFERENCES users(id),
    -- Billing
    billable            BOOLEAN NOT NULL DEFAULT false, -- can this be invoiced to a client?
    invoiced            BOOLEAN NOT NULL DEFAULT false, -- has it been included on an invoice?
    invoice_id          UUID REFERENCES bill_invoices(id) ON DELETE SET NULL,
    -- Metadata
    submitted_by        UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bill_expenses_org ON bill_expenses(organization_id);
CREATE INDEX idx_bill_expenses_project ON bill_expenses(project_id);
CREATE INDEX idx_bill_expenses_status ON bill_expenses(status);
CREATE INDEX idx_bill_expenses_date ON bill_expenses(expense_date DESC);

-- Organization billing settings
CREATE TABLE bill_settings (
    organization_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    company_name        VARCHAR(255),
    company_email       VARCHAR(255),
    company_phone       VARCHAR(50),
    company_address     TEXT,
    company_logo_url    TEXT,
    company_tax_id      VARCHAR(50),
    default_currency    VARCHAR(3) NOT NULL DEFAULT 'USD',
    default_tax_rate    NUMERIC(5,2) DEFAULT 0,
    default_payment_terms_days INTEGER NOT NULL DEFAULT 30,
    default_payment_instructions TEXT,
    default_footer_text TEXT,
    default_terms_text  TEXT,
    invoice_prefix      VARCHAR(20) NOT NULL DEFAULT 'INV',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. API Endpoints

### 4.1 Clients

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/clients` | List billing clients |
| `POST` | `/bill/api/clients` | Create a client (optionally linked to Bond company) |
| `GET` | `/bill/api/clients/:id` | Get client detail with invoice history |
| `PATCH` | `/bill/api/clients/:id` | Update client |
| `DELETE` | `/bill/api/clients/:id` | Delete client (only if no invoices) |

### 4.2 Invoices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/invoices` | List invoices (filterable by status, client, project, date range) |
| `POST` | `/bill/api/invoices` | Create a blank invoice |
| `POST` | `/bill/api/invoices/from-time-entries` | Create invoice from Bam time entries (specify project, date range → auto-generates line items) |
| `POST` | `/bill/api/invoices/from-deal` | Create invoice from Bond deal close (deal value → single line item) |
| `GET` | `/bill/api/invoices/:id` | Get invoice detail with line items and payments |
| `PATCH` | `/bill/api/invoices/:id` | Update invoice (only in draft status) |
| `DELETE` | `/bill/api/invoices/:id` | Delete invoice (only in draft status) |
| `POST` | `/bill/api/invoices/:id/line-items` | Add a line item |
| `PATCH` | `/bill/api/invoices/:id/line-items/:itemId` | Update a line item |
| `DELETE` | `/bill/api/invoices/:id/line-items/:itemId` | Remove a line item |
| `POST` | `/bill/api/invoices/:id/finalize` | Finalize invoice (assigns invoice number, generates PDF, locks edits) |
| `POST` | `/bill/api/invoices/:id/send` | Send invoice via email to client (includes PDF attachment and public view link) |
| `POST` | `/bill/api/invoices/:id/void` | Void an invoice |
| `POST` | `/bill/api/invoices/:id/duplicate` | Clone invoice as new draft |
| `GET` | `/bill/api/invoices/:id/pdf` | Download invoice PDF |

### 4.3 Payments

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bill/api/invoices/:id/payments` | Record a payment against an invoice |
| `DELETE` | `/bill/api/payments/:id` | Delete a payment record |

### 4.4 Expenses

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/expenses` | List expenses (filterable by project, category, status, date range) |
| `POST` | `/bill/api/expenses` | Create an expense (with optional receipt upload) |
| `PATCH` | `/bill/api/expenses/:id` | Update an expense |
| `DELETE` | `/bill/api/expenses/:id` | Delete an expense |
| `POST` | `/bill/api/expenses/:id/approve` | Approve an expense |
| `POST` | `/bill/api/expenses/:id/reject` | Reject an expense |

### 4.5 Public Invoice View (No Auth — Token-Based)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/invoice/:token` | Render invoice as public HTML page (logs "viewed" event) |
| `GET` | `/invoice/:token/pdf` | Download invoice PDF |

### 4.6 Billing Rates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/rates` | List billing rates |
| `POST` | `/bill/api/rates` | Create a rate (org, project, or user-specific) |
| `PATCH` | `/bill/api/rates/:id` | Update a rate |
| `DELETE` | `/bill/api/rates/:id` | Delete a rate |
| `GET` | `/bill/api/rates/resolve` | Resolve the effective rate for a given project + user + date |

### 4.7 Financial Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/reports/revenue` | Revenue summary by month, client, project |
| `GET` | `/bill/api/reports/outstanding` | Total outstanding (unpaid) by client and age bucket (0-30, 31-60, 61-90, 90+) |
| `GET` | `/bill/api/reports/profitability` | Project profitability: invoiced revenue vs. logged expenses |
| `GET` | `/bill/api/reports/overdue` | List of overdue invoices with days overdue |

### 4.8 Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bill/api/settings` | Get org billing settings |
| `PUT` | `/bill/api/settings` | Update billing settings (company info, defaults, branding) |

---

## 5. MCP Tools

| Tool | Description |
|------|-------------|
| `bill_list_invoices` | List invoices with filters |
| `bill_get_invoice` | Get invoice detail |
| `bill_create_invoice` | Create a blank invoice |
| `bill_create_invoice_from_time` | Generate invoice from Bam time entries for a project/date range |
| `bill_create_invoice_from_deal` | Generate invoice from Bond deal close |
| `bill_add_line_item` | Add a line item to a draft invoice |
| `bill_finalize_invoice` | Finalize and generate PDF |
| `bill_send_invoice` | Email invoice to client |
| `bill_record_payment` | Record a payment against an invoice |
| `bill_get_overdue` | List overdue invoices |
| `bill_get_revenue_summary` | Revenue by period, client, or project |
| `bill_get_profitability` | Project profitability calculation |
| `bill_list_expenses` | List expenses |
| `bill_create_expense` | Log an expense |
| `bill_resolve_rate` | Get the effective billing rate for a user+project |

### 5.1 Agent Billing Workflows

**End-of-Month Invoicing:**
1. Scheduled Bolt automation triggers agent on the 1st of each month
2. Agent calls Bam time entry API to find all unbilled time per project for the previous month
3. For each project with billable time, agent calls `bill_create_invoice_from_time`
4. Agent calls `bill_finalize_invoice` to generate PDFs
5. Agent posts draft invoices to Banter `#finance` for human review before sending

**Overdue Reminders:**
1. Daily Bolt automation triggers agent
2. Agent calls `bill_get_overdue`
3. For each overdue invoice, agent drafts a polite reminder email via Blast
4. Agent logs reminder activity on the corresponding Bond contact

---

## 6. Invoice PDF Generation

### 6.1 Approach

Invoices are rendered as HTML using an EJS/Handlebars template, then converted to PDF via Puppeteer (headless Chrome) running in the BullMQ worker. The PDF is stored in MinIO and the URL is saved on the invoice record.

### 6.2 PDF Content

- **Header:** Organization logo, name, address, contact info
- **Invoice details:** Invoice number, date, due date, payment terms
- **Client details:** Name, address, tax ID
- **Line items table:** Description, quantity, unit, unit price, amount
- **Totals:** Subtotal, tax, discount, total, amount paid, amount due
- **Payment instructions:** Bank details, Stripe payment link, or custom text
- **Footer:** Custom footer text, terms and conditions

### 6.3 Branding

Configurable per organization in `bill_settings`:
- Company logo (uploaded to MinIO)
- Color accent for headers and totals
- Custom footer and terms text

---

## 7. Events (Bolt Integration)

| Event | Trigger | Payload |
|-------|---------|---------|
| `bill.invoice.created` | Invoice created | `{ invoice_id, client_id, project_id, total, currency }` |
| `bill.invoice.sent` | Invoice emailed to client | `{ invoice_id, client_id, to_email, total }` |
| `bill.invoice.viewed` | Client viewed invoice via public link | `{ invoice_id, client_id }` |
| `bill.invoice.paid` | Invoice fully paid | `{ invoice_id, client_id, total, paid_at }` |
| `bill.invoice.overdue` | Invoice past due date | `{ invoice_id, client_id, total, days_overdue }` |
| `bill.payment.recorded` | Payment received | `{ payment_id, invoice_id, amount, payment_method }` |
| `bill.expense.submitted` | Expense submitted | `{ expense_id, project_id, amount, category }` |
| `bill.expense.approved` | Expense approved | `{ expense_id, project_id, amount, approved_by }` |

---

## 8. Cross-Product Integration

### 8.1 Bam Integration
- **Time-to-invoice:** Bam time entries with `billable: true` are aggregated into Bill invoice line items. The time entry IDs are stored on the line item for traceability.
- **Task linkage:** Line items can reference the Bam task they relate to.
- Bam's time tracking summary (Section 29.4 in Bam v2) provides the source data for Bill's time-based invoicing.

### 8.2 Bond Integration
- **Deal-to-invoice:** When a Bond deal closes-won, Bolt can trigger invoice creation via `bill_create_invoice_from_deal`.
- **Client linkage:** Bill clients can be linked to Bond companies. Creating a Bond deal's client auto-suggests creating a Bill client if one doesn't exist.
- Bond contact/company detail pages show related invoices in a sidebar tab.

### 8.3 Banter Integration
- Invoice events (sent, paid, overdue) can post to Banter channels via Bolt.
- Invoice links shared in Banter render as rich previews (invoice number, client, total, status badge).

### 8.4 Bench Integration
- Bill data is registered as a Bench data source: revenue trend, outstanding aging, profitability by project, expense breakdown by category.

### 8.5 Blast Integration
- Overdue invoice reminders can be sent via Blast email templates for consistent branding.

### 8.6 Blank Integration
- Expense receipts or reimbursement requests can be submitted via Blank forms, with Bolt routing the submission to `bill_create_expense`.

---

## 9. Frontend

### 9.1 Routes

| Route | View |
|-------|------|
| `/bill` | Invoice list (table with number, client, date, total, status badge, due date) |
| `/bill/invoices/new` | Invoice editor (line items, client selection, tax, payment terms) |
| `/bill/invoices/from-time` | Time-to-invoice wizard (select project, date range → preview line items → create) |
| `/bill/invoices/:id` | Invoice detail (line items, payments, activity timeline, PDF preview) |
| `/bill/invoices/:id/edit` | Edit draft invoice |
| `/bill/clients` | Client list |
| `/bill/clients/:id` | Client detail (invoice history, total billed, outstanding) |
| `/bill/expenses` | Expense list (filterable by project, category, status) |
| `/bill/expenses/new` | Expense submission form with receipt upload |
| `/bill/rates` | Billing rate configuration |
| `/bill/reports` | Financial dashboard (revenue trend, outstanding aging, profitability) |
| `/bill/settings` | Organization billing settings (company info, branding, defaults) |

### 9.2 Invoice Editor

- **Client selector:** Autocomplete from Bill clients (with "create new" option)
- **Line items:** Editable table with description, quantity, unit, unit price, computed amount. Add/remove/reorder rows.
- **Totals panel:** Subtotal, tax rate input, tax amount, discount, total, amount due
- **Notes/Terms:** Text areas for notes (internal) and footer/terms (on invoice)
- **Preview panel:** Live PDF preview rendered in-browser (HTML version, not actual PDF)
- **Actions:** Save draft, Finalize (assign number + generate PDF), Send, Duplicate, Void

### 9.3 Financial Dashboard

- **Revenue trend:** Monthly bar chart of invoiced revenue
- **Outstanding aging:** Stacked bar chart showing unpaid invoices by age bucket (0-30, 31-60, 61-90, 90+ days)
- **Top clients:** Table of clients sorted by total billed
- **Project profitability:** Bar chart comparing invoiced revenue vs. expenses per project
- **Overdue alerts:** List of overdue invoices with days overdue and amount

---

## 10. Permissions

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View invoices | ✓ | ✓ | ✓ | ✓ |
| Create/edit invoices | ✓ | ✓ | ✗ | ✗ |
| Finalize/send invoices | ✓ | ✓ | ✗ | ✗ |
| Record payments | ✓ | ✓ | ✗ | ✗ |
| Void invoices | ✓ | ✗ | ✗ | ✗ |
| Submit expenses | ✓ | ✓ | ✓ | ✗ |
| Approve/reject expenses | ✓ | ✓ | ✗ | ✗ |
| Configure rates | ✓ | ✓ | ✗ | ✗ |
| Configure billing settings | ✓ | ✗ | ✗ | ✗ |
| View financial reports | ✓ | ✓ | ✗ | ✗ |
| Manage clients | ✓ | ✓ | ✗ | ✗ |
