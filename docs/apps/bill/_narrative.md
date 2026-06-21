# Bill - Invoicing & Billing

Bill is BigBlueBam's invoicing and billing app for creating invoices, recording payments, tracking expenses, managing client accounts, and reporting on revenue and profitability. It is org-scoped: clients, invoices, expenses, rates, and settings all belong to your active organization.

## Key Features

- **Invoice Creation** with editable line items, a tax rate, discounts, due dates, and a one-way finalize step that assigns a permanent invoice number and locks edits
- **Payment Tracking** with per-payment method, reference, and date; invoices move through draft, sent, viewed, partially paid, and paid as receipts are recorded
- **Client Management** with contact details, billing address, tax ID, default payment terms, and per-client billed/paid/outstanding summaries
- **Expense Tracking** for logging project costs with a category, vendor, billable flag, and a pending to approved or rejected review step, plus a Mark reimbursed action for paying the submitter back
- **Rate Configuration** for hourly, daily, or fixed rates scoped to the org, a project, a user, or a user on a project, with most-specific-wins resolution
- **Financial Reports** covering revenue by month, outstanding aging, project profitability, and a due-date-computed overdue list, which also feeds the Dashboard Overdue tile and the Invoices Overdue filter
- **PDF Generation** for any invoice on demand, plus an unauthenticated public view token for sharing a sent invoice
- **Invoice from a Bond deal** that pulls a deal's value into a draft, and an Invoice from Time Entries wizard that turns Bam time entries over a date range into priced line items
- **Recurring / Subscription Billing** with schedules on a weekly, monthly, quarterly, or annual cadence that generate invoices automatically from a saved line-item template, with an auto-finalize-or-draft mode and pause, resume, cancel, and generate-now controls

## Integrations

Bill connects to Bam for projects, tasks, and time entries that drive rate resolution and time-based invoicing, and routes invoice approvals through Bam's approval queue. It generates draft invoices from Bond deals and can link a billing client to a Bond company. It emits events (`invoice.created`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `payment.recorded`, `invoice.overdue`, and more) on the `bill` source for Bolt automation rules to consume. Approval requests reach the approver as a Banter DM. A daily worker sweep emails clients whose invoices are past due, and a separate daily sweep materializes invoices from due recurring schedules. Recurring schedules bill a client on a cadence (weekly, monthly, quarterly, or annually) from a saved line-item template, either generating drafts for review or auto-finalizing them, and emit `recurring.invoice_generated` on the `bill` source. Public invoice pages are view-and-PDF only; they do not collect online payment.

## Getting Started

Open Bill from the Launchpad at `/bill/`. Set up your company identity and invoice defaults in Bill Settings, then create a client under Clients. Create an invoice manually with line items, generate a draft from a Bond deal, or use the Invoice from Time Entries wizard to bill tracked Bam time over a date range. Finalize the invoice to assign its number (an admin or owner step), send it, and record payments as they arrive. For standing fees, set up a recurring schedule under Recurring to bill a client automatically on a cadence. Track status on the Dashboard and use Reports to monitor revenue, aging, profitability, and overdue balances.

## Working together

Like every app, Bill carries the persistent Bureau presence dock, so you can see who is around and start a voice or video huddle from anywhere in it; deeper per-record co-editing lives on the document, board, and task surfaces.
