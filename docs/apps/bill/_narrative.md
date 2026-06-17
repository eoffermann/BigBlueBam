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

## Integrations

Bill connects to Bam for projects, tasks, and time entries that drive rate resolution and time-based invoicing, and routes invoice approvals through Bam's approval queue. It generates draft invoices from Bond deals and can link a billing client to a Bond company. It emits events (`invoice.created`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `payment.recorded`, `invoice.overdue`, and more) on the `bill` source for Bolt automation rules to consume. Approval requests reach the approver as a Banter DM. A daily worker sweep emails clients whose invoices are past due. There is no recurring or subscription billing; each invoice is created on its own. Public invoice pages are view-and-PDF only; they do not collect online payment.

## Getting Started

Open Bill from the Launchpad at `/bill/`. Set up your company identity and invoice defaults in Bill Settings, then create a client under Clients. Create an invoice manually with line items, generate a draft from a Bond deal, or use the Invoice from Time Entries wizard to bill tracked Bam time over a date range. Finalize the invoice to assign its number (an admin or owner step), send it, and record payments as they arrive. Track status on the Dashboard and use Reports to monitor revenue, aging, profitability, and overdue balances.
