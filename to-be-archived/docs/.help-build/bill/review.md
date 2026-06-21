# Bill help.md - Review

## Verdict

**APPROVED**

`docs/apps/bill/help.md` is accurate, complete against the template, and every
load-bearing claim traces to code. The four mandated truthfulness items are each
documented correctly and prominently. The two items below are optional polish,
not blockers.

---

## Checklist results

| Check | Result |
|---|---|
| Template completeness (Overview, Feature reference, User Stories, Related) | Pass - all four sections present and filled |
| Feature coverage (every frontend view/action has how-to steps) | Pass - all 13 pages + public view + PDF + reminder sweep covered |
| Story coverage (setup / core loop / collaboration / search-reporting / agent) | Pass - all five archetypes present (see below) |
| UI label accuracy (labels appear in code) | Pass - every quoted label verified against the page components |
| Conventions: no em dashes | Pass - perl scan for U+2013/U+2014 returns zero hits |
| 16 MCP tools, code-backed | Pass - exactly 16 tools in bill-tools.ts; all 16 named in the doc |
| 7 referenced screenshots exist | Pass - 01..07 present in both screenshots/light and screenshots/dark |

### Mandated truthfulness items (all correctly documented)

1. **Invoice-from-Time UI stub** - documented as a "non-functional placeholder"
   in the "Invoice from time entries" feature section and in the "Bill tracked
   time" story; the disabled "Preview Line Items" button, amber banner, "Create
   Manually Instead" navigation, and "makes no API call" are all stated. Matches
   `apps/bill/src/pages/invoice-from-time.tsx`.
2. **Never-firing overdue status** - documented three times (Key concepts /
   "Invoice status", Dashboard "Overdue" tile, Invoice list "Overdue" pill). Code
   confirms no service write path sets `status='overdue'`; the only `overdue`
   token in the API services is a display label in `pdf.service.ts`. The doc
   correctly routes users to the Reports "Overdue Invoices" table for the real
   computed list.
3. **Absence of recurring billing** - the doc never claims recurring/subscription
   billing as a feature. `grep -ri "recurring|subscription"` across
   `apps/bill-api/src` and `apps/bill/src` returns nothing, so the omission is
   correct.
4. **API-token-only public view** - documented in "Public invoice view": no Bill
   SPA page, no client-facing payment action, read-only subset plus PDF via
   `GET /invoice/:token` and `/pdf`. Matches `routes/public.routes.ts` and
   `getInvoiceByToken` (which omits org_id, created_by, bond_deal_id, tax IDs and
   auto-marks `sent` -> `viewed`).

### Story coverage detail

- Setup: "Set up your billing identity" (Settings).
- Core loop: "Add a client and send your first invoice" + "Record a payment to
  closeout".
- Collaboration: "Send an invoice for approval before billing" (Bam approval
  queue + Banter DM via Bolt).
- Search/reporting: "Close out a billing period" (Reports: revenue, aging,
  profitability, overdue).
- Agent flow: "Turn a won Bond deal into an invoice" and "Bill tracked time from
  a project", both driven through MCP tools / API; plus "Chase overdue invoices
  automatically" (worker sweep + invoice.overdue event).

### Notable accuracy strengths

- The doc correctly captures that Finalize sets status directly to `sent` (there
  is no distinct `finalized` status; `finalizeInvoice` sets `status:'sent'`), and
  that Re-send (the `/send` route) is what queues the email.
- The doc correctly flags the `bill_create_invoice_from_time` tool/API parameter
  mismatch (tool sends `date_from`/`date_to`; `fromTimeEntriesSchema` requires
  `time_entry_ids[].min(1)` and ignores dates), and steers users to the direct API.
- The `reimbursed` expense pill and `written_off` status are both correctly
  described as having no write path.
- Worker reminder facts verified: daily `0 9 * * *` (09:00 UTC), excludes
  paid/void/written_off, due_date < now, 7-day re-nag guard, emits
  `invoice.overdue` on source `bill`. The catalog registers invoice.created,
  invoice.finalized, invoice.sent, invoice.paid, payment.recorded, invoice.overdue.

---

## Optional polish (non-blocking, not required for approval)

These are two spots where the doc states a conditional UI element
unconditionally. Both are defensible as written; listed only for completeness.

1. File `docs/apps/bill/help.md`, section "Invoice detail" (the header-actions
   bullet list) and section "Invoice list" (per-row actions). The **PDF**
   action/link renders only when the invoice has a `pdf_url`
   (`{pdf && ...}` in `invoice-detail.tsx` and `invoice-list.tsx`); a freshly
   created draft with no generated PDF shows no PDF control. The doc lists PDF as
   an always-present action ("PDF opens the invoice PDF" / "Click PDF on any
   row"). Consider noting "PDF appears once a PDF has been generated" to match the
   conditional render. Low severity: the authenticated `GET /invoices/:id/pdf`
   route always works on demand, so the capability claim is true even when the
   button is absent.

2. File `docs/apps/bill/help.md`, "Invoice detail" -> "Re-send" bullet (line ~111)
   says Re-send "marks the invoice sent again and queues an email if email is
   configured." Verified accurate against the `/send` route. No change needed;
   recorded only to confirm it was checked.

## Accuracy findings (claims that did NOT trace to code)

None. Every UI label, status value, route, event name, tool name, count, and
screenshot reference in the doc was confirmed against the source.
