# Bill - Invoicing and billing for client work

> Bill turns the work your team does into invoices, tracks who has paid and who is overdue, captures project expenses, and reports on revenue and profitability. Reach for it when you need to bill a client, record a payment, or close out a billing period.

## Overview

Bill is the invoicing and billing app in the BigBlueBam suite. You create an **invoice** for a **client**, fill it with **line items**, finalize it to assign a permanent number, send it, and record **payments** until it is fully paid. Alongside invoices, Bill tracks **expenses** (with an approval step), **rates** that drive time-based billing, and a set of financial **reports**.

Bill is org-scoped: every client, invoice, expense, rate, and setting belongs to your active organization. It connects to the rest of the suite in several places. It can pull billable time from Bam projects and tasks, generate an invoice from a won Bond deal, route an invoice for approval through Bam's approval queue, and emit events that Bolt automation rules can react to.

A few conventions to know up front. All money in Bill is stored and entered in **integer cents**, not dollars. The amount, rate, and payment inputs in the UI are labeled "(cents)" and take whole numbers, so typing `150` means one dollar and fifty cents. Invoices are only editable while they are in `draft`; once you finalize an invoice, its number and line items are locked.

### Key concepts

- **Invoice** - A billable document addressed to one client. It snapshots your company details (the "from" side) and the client details (the "to" side) when it is created, and carries an invoice date, due date, line items, tax, totals, and payment history. Its number is literally `DRAFT` until you finalize it.
- **Invoice status** - The lifecycle of an invoice. The values that the app actually sets are `draft` (editable, no number yet), `sent` (finalized, number assigned, edits locked), `viewed` (a client opened the public link), `partially_paid` (some payment recorded, balance remains), `paid` (paid in full), and `void` (cancelled). The Invoices list also shows an **Overdue** filter pill, but see the note under "Invoice list" - no action ever sets an invoice's stored status to overdue; overdue is computed from the due date by the Reports view and the reminder job.
- **Line item** - One row on an invoice: a description, quantity, unit (default `hours`), and unit price in cents. The amount is quantity times unit price. Line items can only be added, edited, or removed while the invoice is a draft.
- **Client** - The recipient of an invoice. Carries name, email, phone, address, tax ID, default payment terms (in days), default payment instructions, and notes. A Bill client is separate from a Bond contact or company, though it can be linked to a Bond company.
- **Payment** - A recorded receipt against an invoice: an amount in cents, a method (Bank Transfer, Credit Card, Check, Cash, Stripe, PayPal, or Other), an optional reference, and a date.
- **Expense** - A project cost: description, amount in cents, category, vendor, date, and a billable flag. Expenses start as `pending` and a reviewer moves them to `approved` or `rejected`.
- **Rate** - A billing rate scoped to your org, a project, a user, or a user-on-a-project, with an amount in cents and a type (hourly, daily, or fixed). When Bill bills tracked time, it resolves the most specific rate that applies.
- **Settings** - Your company identity and the defaults new invoices inherit: invoice prefix, default tax rate, payment terms, payment instructions, footer text, and terms text.
- **Public view token** - A long opaque token on each invoice that grants read-only access (and a PDF) without logging in. It is how a sent invoice can be viewed by someone outside your org.

### Where to find it

Bill is served at `/bill/`. You must be logged in to BigBlueBam first; if you are not, Bill shows a "Please log in to BigBlueBam first" screen with a link to `/b3/`. Everything is scoped to your active organization, and mutating actions require the matching Bill permission on your account.

The left sidebar carries a fixed **New Invoice** quick-action button, then the nav items **Dashboard**, **Invoices**, **Clients**, **Expenses**, **Rates**, and **Reports**, and under a **Bill Settings** subheading the **Bill Settings** item. Press `?` anywhere in Bill to open the embedded Help viewer.

## Feature reference

### Dashboard

The Dashboard is the default view at `/bill/`, titled **Dashboard** with the subtitle "Overview of invoicing activity." It shows four stat tiles - **Outstanding**, **Paid**, **Overdue**, and **Drafts** - and a **Recent activity** table listing recent invoices (Number, Client, Date, Total, Status) with a **View all invoices** link.

The tiles and the link are summary indicators; clicking a tile or "View all invoices" returns you to the Dashboard rather than a filtered list. The numbers are computed in the browser from your full invoice list. Note that the **Overdue** tile counts invoices whose stored status equals `overdue`, and because no action in Bill sets that status, this tile stays at zero even when invoices are past due. Use the Reports view's "Overdue Invoices" table for the real overdue picture.

To open an invoice from the Dashboard:

1. Go to `/bill/` from the sidebar **Dashboard** item.
2. In the **Recent activity** table, click any row.
3. You land on that invoice's detail page.

### Invoice list

The Invoices list at `/bill/invoices` is titled **Invoices** with the subtitle "Manage and track all your invoices." It is the main place to scan, filter, and act on invoices.

The columns are Number, Client, Date, Due (the due date), Total, Due (the remaining balance, which is total minus amount paid), Status, and Actions. The two "Due" columns are a date and a balance respectively. Above the table is a row of status filter pills; the empty pill is labeled **All**. Per-row actions include **PDF**, **Finalize** (drafts only), and **Request approval**.

To filter the list:

1. Open **Invoices** in the sidebar.
2. Click a status pill (**All**, or a specific status such as **Draft**, **Sent**, or **Paid**).
3. The table reloads with only invoices in that status.

The **Overdue** pill filters on the stored `overdue` status, which nothing sets, so it returns no rows. To see invoices that are actually past due, use Reports.

To finalize a draft from the list:

1. Find a draft row.
2. Click **Finalize** in its Actions cell.
3. The invoice is assigned a number and moves to `sent`; it can no longer be edited.

To download a PDF from the list:

1. Click **PDF** on any row.
2. The invoice PDF opens inline.

To request approval from the list:

1. Click **Request approval** on a row.
2. In the **Request approval for {number}** modal, choose an **Approver** from the select (the list is active Bam users), optionally type a **Message (optional)**, and click **Send request**.
3. The helper text reads "Sends a Banter DM to the approver via Bolt." The request is posted to Bam's approval queue with subject type `bill.invoice`; the approver acts on it inside Bam.

The two entry points for creating invoices live at the top of this view: **From Time Entries** (see "Invoice from time entries") and **New Invoice** (see "Create an invoice").

![Invoice list](screenshots/light/01-invoice-list.png)

### Create an invoice

The New Invoice form at `/bill/invoices/new` (titled **New Invoice**) builds a draft invoice manually. Reach it from the sidebar **New Invoice** button, the Invoices list **New Invoice** button, or a client's **+ New Invoice** link.

To create an invoice:

1. Click **New Invoice**.
2. Choose a **Client** from the select. The **Create Draft Invoice** button stays disabled until a client is chosen.
3. In the **Line Items** table, fill in Description, Qty, and Unit Price (in cents) for each row. The Amount column is computed. Click **+ Add line item** to add another row, or the **X** at the end of a row to remove it.
4. In the totals box, review the **Subtotal**, edit the **Tax Rate** if needed (the **Tax** and **Total** update automatically).
5. Optionally add **Notes (internal)**.
6. Click **Create Draft Invoice**. Bill creates the draft, adds each line item, and opens the new invoice's detail page. Use **Cancel** to return to the Dashboard instead.

![New invoice form](screenshots/light/02-invoice-new.png)

### Invoice from time entries

The page at `/bill/invoices/from-time` is titled **Invoice from Time Entries** with the subtitle "Generate an invoice from Bam time tracking data."

This page is currently a non-functional placeholder. It shows an amber banner ("This wizard requires Bam time entries integration. Currently, you can create invoices manually with line items."), a **Project** text field, **Date From** and **Date To** date fields, a **Preview Line Items** button that is permanently disabled, and a **Create Manually Instead** button that sends you to the manual New Invoice form. The page makes no API call, so you cannot generate a time-based invoice from this screen.

The underlying capability does exist and works from the API and from an AI agent. To bill tracked time today, use the `bill_create_invoice_from_time` MCP tool (see "Working with AI agents") or call `POST /bill/api/v1/invoices/from-time-entries` directly with a project, a client, and the specific time entry IDs to bill. The service joins those time entries to their tasks, resolves a rate per user-and-task group, and builds one line item per group.

### Invoice detail

The detail page at `/bill/invoices/:id` shows everything about one invoice: header with number, client, and a status badge; From and To panels; Invoice Date, Due Date, Total, and Amount Due tiles; the read-only line items with a Subtotal / Tax / Discount / Total footer; the payments section; and an inline **PDF preview** iframe once a PDF exists.

The header actions vary by status:

- **Edit** appears on drafts and opens the edit form.
- **Finalize** appears on drafts; it assigns the number and locks the invoice.
- **Re-send** appears on sent or viewed invoices; it marks the invoice sent again and queues an email if email is configured.
- **Void** appears on any non-draft, non-void invoice; it cancels the invoice.
- **Duplicate** is always available; it clones the invoice (and its line items) into a new draft and opens that draft.
- **Request approval** opens an inline form that posts to Bam's approval queue, the same flow as the list view.
- **PDF** opens the invoice PDF.

To record a payment from the detail page:

1. Open the invoice. The **Record Payment** control appears when the status is not draft, void, or paid.
2. Enter the **Amount (cents)**.
3. Choose a **Method** (Bank Transfer, Credit Card, Check, Cash, Stripe, PayPal, or Other).
4. Click **Save Payment**.
5. The payment appears in the list (Date, Method, Amount). When recorded payments reach the total, the invoice flips to `paid`; a partial payment shows `partially_paid`. Bill rejects a payment that would exceed the remaining balance.

To void an invoice:

1. Open a sent, viewed, or paid invoice (void is blocked on drafts; delete a draft instead).
2. Click **Void** in the header.
3. The invoice moves to `void` and drops out of revenue reports.

To duplicate an invoice:

1. Click **Duplicate** in the header.
2. Bill creates a new draft with the same line items and opens it for editing.

### Edit an invoice

The edit form at `/bill/invoices/:id/edit` is titled **Edit Invoice {number}** and is available only for drafts. A non-draft shows "Only draft invoices can be edited." with a "Back to Invoice" link.

The editable fields are **Tax Rate (%)**, **Internal Notes**, **Footer Text (on invoice)**, and **Terms & Conditions (on invoice)**. The edit form cannot add or remove line items and cannot change the client. To change line items, do it on the New Invoice form before creating, or duplicate the invoice and rebuild it.

To edit a draft:

1. On the invoice detail page, click **Edit**.
2. Adjust **Tax Rate (%)**, **Internal Notes**, **Footer Text (on invoice)**, or **Terms & Conditions (on invoice)**.
3. Click **Save Changes** (or **Cancel** to discard).

### Clients

The Clients list at `/bill/clients` is titled **Clients** with the subtitle "Manage billing clients." Columns are Name, Email, Phone, and Terms (shown as "{n} days").

To add a client:

1. Open **Clients** in the sidebar.
2. Click **New Client** to reveal the inline form.
3. Enter **Name** and **Email**.
4. Click **Create Client**.

To open and edit a client:

1. Click a client row to open `/bill/clients/:id`.
2. Click **Edit** to enable inline editing of Contact Information (Name, Email, Phone) and Address & Tax (Address Line 1, Address Line 2, City, State, ZIP, Tax ID) plus Notes.
3. Click **Save** (or **Cancel**).

The client detail page also shows **Total Billed**, **Total Paid**, and **Outstanding Balance** summary cards computed from this client's invoices, the read-only address, tax ID, payment terms, and notes, and an **Invoices** table (Invoice #, Date, Status, Total, Paid, Due). The **+ New Invoice** link opens the New Invoice form; note that it does not pre-select this client, so choose the client again on the form.

![Clients list](screenshots/light/03-clients.png)

### Expenses

The Expenses list at `/bill/expenses` is titled **Expenses** with the subtitle "Track project expenses and receipts." Columns are Description, Category, Vendor, Date, Amount, Status, and Actions. A row of status pills filters the list: **All** (empty), **pending**, **approved**, **rejected**, and **reimbursed**. Note that nothing in Bill sets an expense to `reimbursed`, so the **reimbursed** pill returns no rows.

To log an expense:

1. Open **Expenses** and click **New Expense** to go to `/bill/expenses/new` (titled **New Expense**).
2. Fill in **Description**, **Amount (cents)**, and **Date**.
3. Choose a **Category** (Software, Travel, Hardware, Contractor, Office, Meals, or Other) and optionally a **Vendor**.
4. Tick **Billable to client** if the cost should be invoiceable.
5. Click **Submit Expense**. The expense is created as `pending`.

To approve or reject an expense:

1. On the Expenses list, find a `pending` row.
2. Click **Approve** or **Reject** in its Actions cell.
3. The status changes to `approved` or `rejected`. Only pending expenses can be approved or rejected; once approved, an expense is locked.

Editing an expense, deleting one, and attaching a receipt are supported by the API but have no button in the current UI. To attach a receipt or edit an expense, use the API (`POST /bill/api/v1/expenses/:id/receipt`, `PATCH /bill/api/v1/expenses/:id`).

![Expenses list](screenshots/light/04-expenses.png)

### Rates

The Rates list at `/bill/rates` is titled **Billing Rates** with the subtitle "Configure hourly, daily, or fixed rates per org/project/user." Columns are Rate, Type, Scope (derived as User + Project, User, Project, or Organization), Effective From, and Actions.

To add a rate:

1. Open **Rates** and click **New Rate** to reveal the inline form.
2. Enter **Rate (cents)** (the form defaults to 15000) and choose a **Type** (Hourly, Daily, or Fixed).
3. Click **Create Rate**.

To delete a rate, click **Delete** in its Actions cell.

The inline form only sets amount and type, so rates created in the UI are organization-scoped. Project-specific, user-specific, and date-bounded rates are supported by the data model and the resolver but must be created through the API (`POST /bill/api/v1/rates` with `project_id`, `user_id`, `effective_from`, or `effective_to`). When Bill bills time, it resolves the most specific rate that applies, preferring a user-and-project rate, then a user rate, then a project rate, then the organization rate, restricted to rates whose date range covers the work date.

![Billing rates list](screenshots/light/05-rates.png)

### Reports

The Reports view at `/bill/reports` is titled **Financial Reports**. It renders four tables:

- **Revenue by Month** (Month, Invoiced, Collected, Count).
- **Outstanding Aging** (Client, with 0-30, 31-60, 61-90, and 90+ day buckets).
- **Project Profitability** (Project, Revenue, Expenses, Profit, Margin). Only approved expenses count against profit.
- **Overdue Invoices** (Invoice, Client, Amount Due, Days Overdue). Each row links to the invoice. This is the authoritative overdue list; it computes overdue from each invoice's due date rather than a stored status.

Revenue and profitability exclude draft, void, and written-off invoices. Outstanding and overdue also exclude paid invoices.

To read your reports:

1. Open **Reports** in the sidebar.
2. Review the four tables in place.
3. Click any **Overdue Invoices** row to jump to that invoice.

![Financial reports](screenshots/light/06-reports.png)

### Settings

The Settings view at `/bill/settings` is titled **Billing Settings**. It has two sections.

**Company Information** holds Company Name, Email, Phone, Tax ID, and Address. These are snapshotted onto each invoice's "from" side at creation time.

**Invoice Defaults** holds Invoice Prefix, Default Tax Rate (%), Payment Terms (days), Default Payment Instructions, Default Footer Text, and Default Terms & Conditions. New invoices inherit these defaults.

To update your billing identity and defaults:

1. Open **Bill Settings** in the sidebar.
2. Edit any field under **Company Information** or **Invoice Defaults**.
3. Click **Save Settings**. The button shows "Saved!" on success.

![Billing settings](screenshots/light/07-settings.png)

### PDF generation

Every invoice can be downloaded as a PDF. The **PDF** action on the list, the **PDF** action in the detail header, and the inline **PDF preview** iframe all render the invoice through Bill's PDF service (`GET /bill/api/v1/invoices/:id/pdf`). A draft's PDF is named `DRAFT.pdf`; a finalized invoice's PDF is named after its number.

When you finalize an invoice, Bill enqueues a background PDF job; when you send one, it enqueues an email job. While those run, the detail page can show a "PDF generating..." state. You do not need to trigger PDF generation manually; the PDF action always renders on demand.

### Public invoice view

Each invoice carries a public view token. Anyone with the token URL can read a safe subset of the invoice and fetch its PDF without logging in, through `GET /bill/api/v1/invoice/:token` and `GET /bill/api/v1/invoice/:token/pdf`. The first open of the token URL marks a sent invoice as `viewed`. The public response omits internal fields such as the organization ID, the creator, the linked Bond deal, and tax IDs.

There is no Bill SPA page for the public view and no client-facing payment action on it. The client cannot pay through this page; you record payments yourself from the invoice detail page. The token URL is intended to be shared with a client, typically from a sent-invoice email.

### Working with AI agents

Bill exposes 16 MCP tools (catalogued in `apps/mcp-server/src/tools/bill-tools.ts`), enough for an agent to drive most of the invoicing lifecycle from chat or a Bolt automation rule. The tools resolve fuzzy identifiers: a client can be named by name or email, and a Bam project by name, and the tool resolves it to an ID.

What agents commonly do:

- **List and inspect:** `bill_list_invoices`, `bill_get_invoice`, `bill_list_clients`, `bill_list_expenses`.
- **Build a draft:** `bill_create_invoice` (blank draft for a client), then `bill_add_line_item` per line. For a Bond-deal handoff, `bill_create_invoice_from_deal` pulls the deal value into one line item; in a Bolt rule the deal ID is passed as `{{ event.deal.id }}` from a `deal.*` event, and it must be a UUID.
- **Finish and collect:** `bill_finalize_invoice` to assign the number and lock the invoice, `bill_send_invoice` to mark it sent, and `bill_record_payment` to log receipts.
- **Expenses and rates:** `bill_create_expense` to log a cost, `bill_resolve_rate` to look up the effective rate for a project, user, and date.
- **Reporting:** `bill_get_overdue`, `bill_get_revenue_summary`, and `bill_get_profitability` back the Reports view's data.

Two cautions for agent-driven invoicing:

- `bill_create_invoice_from_time` is the only working path to bill tracked time today, because the in-app wizard is a stub. However, this tool sends `date_from` and `date_to`, while the API route it calls (`POST /invoices/from-time-entries`) requires an explicit list of `time_entry_ids` and ignores dates. As written, the tool call is expected to fail validation. Until the tool is fixed to pass `time_entry_ids`, drive time-based invoicing by calling the API directly with the entry IDs.
- The tools cover creation through payment but not voiding, duplicating, editing, deleting, approving or rejecting expenses, updating rates, or changing settings. Those actions remain human-driven in the UI (or direct API calls).

When an agent surfaces Bill data into a shared surface in another app, it should run the platform `can_access` visibility check per `docs/reference/agent-conventions.md`. For the full tool catalog, see the MCP-tools reference in `docs/apps/bill/`.

## User Stories

### Story: Set up your billing identity

**Who:** An org admin setting up Bill for the first time.
**Goal:** Make new invoices carry your company details and sensible defaults.
**Before you start:** You are logged in to BigBlueBam and have Bill settings permission.

**Steps**

1. Open Bill at `/bill/` and click **Bill Settings** in the sidebar.
2. Under **Company Information**, fill in Company Name, Email, Phone, Tax ID, and Address.
3. Under **Invoice Defaults**, set the Invoice Prefix, Default Tax Rate (%), Payment Terms (days), Default Payment Instructions, Default Footer Text, and Default Terms & Conditions.
4. Click **Save Settings** and wait for the "Saved!" confirmation.

**Result:** Your company identity is stored. Every new invoice snapshots these details onto its "from" side and inherits the defaults you set.

**Related:** Add your first client next (Story: Add a client and send your first invoice).

### Story: Add a client and send your first invoice

**Who:** Anyone who bills clients.
**Goal:** Create a client, invoice them, and send it.
**Before you start:** Billing identity is set in Bill Settings. You have permission to create clients and invoices.

**Steps**

1. Click **Clients** in the sidebar, then **New Client**.
2. Enter the client **Name** and **Email** and click **Create Client**.
3. Click **New Invoice** (sidebar or Invoices list).
4. Choose your new client in the **Client** select.
5. In **Line Items**, enter a Description, Qty, and Unit Price (in cents) for each row, using **+ Add line item** for more rows.
6. Set the **Tax Rate** if needed and review **Subtotal**, **Tax**, and **Total**.
7. Click **Create Draft Invoice**. You land on the draft's detail page.
8. Click **Finalize** in the header. The invoice gets its number and locks.
9. Click **Re-send** to dispatch it (this queues an email if email is configured).

**Result:** The client has a finalized, sent invoice with a permanent number. It appears in the Invoices list as `sent`.

**Related:** Record the payment when it arrives (Story: Record a payment to closeout). An agent can do the same with `bill_create_invoice`, `bill_add_line_item`, `bill_finalize_invoice`, and `bill_send_invoice`.

### Story: Record a payment to closeout

**Who:** Anyone tracking receivables.
**Goal:** Log payments against an invoice and watch it reach paid.
**Before you start:** The invoice is finalized (status is sent, viewed, or partially_paid).

**Steps**

1. Open **Invoices** and click the invoice row.
2. In the payments section, find **Record Payment**.
3. Enter the **Amount (cents)** received.
4. Choose a **Method** (for example, Bank Transfer).
5. Click **Save Payment**.
6. Repeat for additional payments until the recorded total reaches the invoice total.

**Result:** A partial payment shows the invoice as `partially_paid`; when payments reach the total it becomes `paid`. The Dashboard **Paid** and **Outstanding** tiles reflect the change.

**Related:** Bill rejects a payment larger than the remaining balance. An agent can record payments with `bill_record_payment`.

### Story: Capture and approve an expense

**Who:** A team member logging a project cost, and a reviewer approving it.
**Goal:** Record an expense and move it through approval.
**Before you start:** You have permission to create expenses; the reviewer has permission to approve.

**Steps**

1. Click **Expenses** in the sidebar, then **New Expense**.
2. Fill in **Description**, **Amount (cents)**, and **Date**.
3. Choose a **Category** and optionally a **Vendor**.
4. Tick **Billable to client** if it should be invoiceable, then click **Submit Expense**. The expense is `pending`.
5. The reviewer opens the Expenses list, finds the pending row, and clicks **Approve** (or **Reject**).

**Result:** The expense moves to `approved` (or `rejected`). Approved expenses count against project profit in the Project Profitability report and can no longer be edited.

**Related:** Receipt upload and expense edits are API-only today. An agent can log expenses with `bill_create_expense` and list them with `bill_list_expenses`.

### Story: Send an invoice for approval before billing

**Who:** Someone who needs sign-off before an invoice goes out.
**Goal:** Route an invoice to a colleague for approval.
**Before you start:** The invoice exists. You know which Bam user should approve it.

**Steps**

1. On the Invoices list, click **Request approval** on the invoice row (or use **Request approval** on the invoice detail page).
2. In the **Request approval for {number}** dialog, pick an **Approver** from the select.
3. Optionally type a **Message (optional)**.
4. Click **Send request**.

**Result:** A request is posted to Bam's approval queue (subject type `bill.invoice`) and a Banter DM goes to the approver via Bolt. The approver reviews and decides inside Bam.

**Related:** After approval, finalize and send the invoice (Story: Add a client and send your first invoice).

### Story: Turn a won Bond deal into an invoice

**Who:** An account owner, or a Bolt rule, converting closed-won revenue into a bill.
**Goal:** Generate a draft invoice from a Bond deal with the deal value as a line item.
**Before you start:** The deal exists in Bond and you have its UUID. A matching Bill client exists (or you know its name/email).

**Steps**

1. Have an agent call `bill_create_invoice_from_deal` with the deal's UUID and the billing client. In a Bolt rule, pass `{{ event.deal.id }}` from the triggering `deal.*` event.
2. The tool creates a draft invoice with the deal value as one line item and opens it for review.
3. In Bill, open the new draft, adjust line items or tax if needed, and click **Finalize**.
4. Click **Re-send** to send it.

**Result:** A draft invoice tied to the deal becomes a finalized, sent invoice. A human stays in control of finalize and send.

**Related:** This is the canonical Bond-to-Bill handoff. See "Working with AI agents" for the tool details.

### Story: Bill tracked time from a project

**Who:** An agent or API caller billing logged hours (the in-app wizard does not work).
**Goal:** Generate an invoice from specific Bam time entries.
**Before you start:** A rate exists that covers the work (set one under Rates, or via the API for project/user scope). You have the project, the client, and the time entry IDs to bill.

**Steps**

1. Confirm a rate applies by checking Rates, or have an agent call `bill_resolve_rate` for the project, user, and date.
2. Call `POST /bill/api/v1/invoices/from-time-entries` with `project_id`, `client_id`, and the array of `time_entry_ids` to bill. (The `bill_create_invoice_from_time` MCP tool currently sends date ranges instead of entry IDs and is expected to fail validation, so use the API or pass the entry IDs explicitly.)
3. The service groups the entries by user and task, resolves a rate per group, and builds one line item per group on a new draft.
4. In Bill, open the draft, review the generated line items, click **Finalize**, then **Re-send**.

**Result:** A draft invoice built from real tracked time, ready to finalize and send. The in-app **Invoice from Time Entries** page remains a placeholder and cannot do this.

**Related:** Configure rates first (the Rates feature). Resolve a rate with `bill_resolve_rate`.

### Story: Close out a billing period

**Who:** A finance owner reviewing the month.
**Goal:** See revenue, aging, profitability, and what is overdue.
**Before you start:** You have Bill report permissions.

**Steps**

1. Click **Reports** in the sidebar.
2. Read **Revenue by Month** for invoiced and collected totals.
3. Read **Outstanding Aging** to see balances by client and age bucket.
4. Read **Project Profitability** to compare revenue against approved expenses per project.
5. Read **Overdue Invoices**, and click any row to open and chase that invoice.

**Result:** A complete financial snapshot for the period, with overdue invoices computed from due dates rather than a stored status.

**Related:** An agent can pull the same data with `bill_get_revenue_summary`, `bill_get_profitability`, and `bill_get_overdue`. The Dashboard's **Overdue** tile does not reflect this; use the Reports table.

### Story: Chase overdue invoices automatically

**Who:** A finance owner who wants overdue reminders to send themselves.
**Goal:** Have Bill email clients whose invoices are past due, and let automation escalate.
**Before you start:** Invoices have due dates; SMTP is configured for real email (otherwise reminders are logged).

**Steps**

1. Finalize and send invoices as usual so they have due dates.
2. Each day at 09:00 UTC, Bill's reminder sweep finds invoices past their due date that are not paid or void, and that were not reminded in the last 7 days.
3. The sweep emails the client (or logs the reminder if SMTP is not set), records the reminder timestamp and count, and emits an `invoice.overdue` event on the `bill` source.
4. Build a Bolt rule on `invoice.overdue` to escalate or notify the account owner.

**Result:** Overdue clients get periodic reminders without manual effort, and downstream automation can react to the `invoice.overdue` event.

**Related:** Bill also emits `invoice.created`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, and `payment.recorded`, all on the `bill` source, for Bolt rules to consume.

## Related

- **Bam** (`/b3/`) - Projects, tasks, and time entries feed time-based invoicing and rate resolution; invoice approvals route through Bam's approval queue.
- **Bond** (`/bond/`) - Won deals convert into draft invoices via `bill_create_invoice_from_deal`; a Bill client can link to a Bond company.
- **Bolt** (`/bolt/`) - Automation rules consume Bill events such as `invoice.paid`, `invoice.overdue`, and `payment.recorded`, and can trigger `bill_create_invoice_from_deal`.
- **Banter** (`/banter/`) - Approval requests reach the approver as a Banter DM.
- Bill's own docs in `docs/apps/bill/`: the MCP-tools reference (the full 16-tool catalog) and `guide.md`.
