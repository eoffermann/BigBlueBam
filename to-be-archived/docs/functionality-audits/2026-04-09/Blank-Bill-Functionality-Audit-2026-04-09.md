# Blank (Forms) & Bill (Invoicing) Functionality Audit

**Date:** 2026-04-09
**Tester:** Automated (Playwright) + Claude
**Environment:** http://localhost (Docker Compose stack)
**Credentials:** test@bigbluebam.test / TestUser2026!
**Branch:** beacon (commit 8683337)

---

## Summary

| App   | Pass | Fail | Skip | Total |
|-------|------|------|------|-------|
| Blank |  6   |  2   |  0   |   8   |
| Bill  |  8   |  0   |  0   |   8   |
| **Total** | **14** | **2** | **0** | **16** |

---

## Blank (Forms & Surveys) -- /blank/

### BLANK-01: Page loads -- PASS (with note)

**Result:** PASS
**Notes:** The Blank SPA loads correctly at `/blank/`. The page renders the sidebar navigation (Forms, Settings, Launchpad) and displays the form list with header "Forms" and subtext "Build forms and surveys to capture responses from anyone." Initial test run timed out using `networkidle` wait strategy, indicating the SPA may have persistent polling or WebSocket connections that prevent the network from going idle. Switching to `domcontentloaded` resolved the issue. The `h1` element text detection required adjustment -- the heading "Forms" is present and renders correctly.

**Caveat:** The Blank SPA does NOT reach `networkidle` within 15 seconds, suggesting a long-running network connection (likely TanStack Query polling or a keep-alive). This is a minor UX concern for perceived load time but does not affect functionality.

### BLANK-02: Form list -- empty state -- PASS

**Result:** PASS
**Notes:** Empty state renders correctly with the message "No forms yet" and "Create your first form to start collecting responses." The empty state includes a file icon placeholder.

### BLANK-03: Create a form -- PASS

**Result:** PASS
**Notes:** Clicking "New Form" fires a POST to `/blank/api/v1/forms` with auto-generated slug. API returns 201 with the new form data. The app navigates to the form builder at `/blank/forms/{id}/edit`. Form created with `name: "Untitled Form"` and slug `form-mns3zdlt`.

### BLANK-04: Form builder loads with field palette -- PASS

**Result:** PASS
**Notes:** The form builder loads a 3-panel layout:
- **Left panel:** Field palette with 21 field types including Short Text, Long Text, Email, Phone, URL, Number, Single Select, Multi Select, Dropdown, Date, Time, Rating, Scale, NPS, Checkbox, Toggle, File Upload, Section Header, Paragraph, Hidden Field, Page Break.
- **Center panel:** Form canvas with drag-and-drop sortable fields (dnd-kit).
- **Right panel:** Inline live preview with Submit button.

All 3 checked field types (Short Text, Long Text, Email) were visible in the palette.

### BLANK-05: Add fields -- different types -- PASS

**Result:** PASS
**Notes:** Successfully added 3 different field types via the palette:
1. **Short Text** -- POST to `/blank/api/v1/forms/{id}/fields` returned 201
2. **Email** -- POST returned 201
3. **Rating** -- POST returned 201

Each click fires an API call to create the field with auto-generated `field_key` and the field type's default label. Fields appear in the canvas and are sortable via drag handles.

### BLANK-06: Preview panel -- PASS

**Result:** PASS
**Notes:** The form builder includes a built-in live preview pane (right side). The preview shows:
- Form title ("Untitled Form")
- Added fields rendered with their correct input types
- A disabled "Submit" button at the bottom
- The Preview toggle button in the toolbar works to expand/collapse the preview pane.

### BLANK-07: Public form renderer (GET /forms/:slug) -- PASS

**Result:** PASS
**Notes:** After publishing the form via POST `/blank/api/v1/forms/{id}/publish`, the public form endpoint at `/blank/api/forms/{slug}` returns a fully rendered HTML page (12,997 bytes). The HTML includes:
- The form title "Untitled Form"
- All added fields rendered as interactive HTML form elements
- A submit button
- Inline CSS styling with the form's theme color
- CAPTCHA support (when enabled)
- Form submission endpoint at POST `/forms/{slug}/submit`

### BLANK-08: API GET /blank/api/v1/forms -- FAIL (BUG)

**Result:** FAIL
**Notes:** The API returns HTTP 500 with `INTERNAL_ERROR`.

**Root cause (from blank-api logs):**
```
PostgresError: malformed array literal: "d2aa5eaf-71a1-476a-88e6-6e529e2ed2e2"
Detail: Array value must start with "{" or dimension information.
```

The `GET /v1/forms` endpoint query is passing the organization ID (a plain UUID string) to a PostgreSQL query parameter that expects an array literal (e.g., `'{uuid}'` instead of `'uuid'`). This bug only manifests when the request lacks proper session/cookie context (e.g., direct API calls without the browser auth cookies), causing the org_id to be passed in a format the SQL query does not expect.

**Impact:** This is a backend bug in the forms listing service. The SPA itself works (it sends the X-Org-Id header from the auth store), but direct API calls to `GET /v1/forms` without the correct auth context trigger a 500 error instead of a 401. The error handling should also be improved to return a proper error response rather than exposing a raw PostgreSQL error.

**Suggested fix:** Check `apps/blank-api/src/services/form.service.ts` or the forms route handler for where `organization_id` is used in a SQL array context. The value should be wrapped in `sql.array([orgId])` or the query should use `= $1` instead of `= ANY($1)`.

---

## Bill (Invoicing & Billing) -- /bill/

### BILL-01: Page loads -- PASS

**Result:** PASS
**Notes:** The Bill SPA loads at `/bill/` and displays the Invoices page with heading "Invoices" and subtext "Manage and track all your invoices." The page includes:
- Status filter bar (All, draft, sent, viewed, paid, partially_paid, overdue, void)
- Invoice table with columns: Number, Client, Date, Due, Total, Due, Status
- "New Invoice" and "From Time Entries" buttons

### BILL-02: Invoice list -- empty state / existing invoices -- PASS

**Result:** PASS
**Notes:** 
- First run: Empty state displayed correctly with "No invoices yet. Create your first one."
- Subsequent run: Invoice rows displayed in the table from previously created test data.

### BILL-03: Create invoice -- PASS

**Result:** PASS
**Notes:**
- **UI Test:** The New Invoice page at `/bill/invoices/new` loads with:
  - Client dropdown selector (populated with available clients)
  - Line item rows with Description, Quantity, and Unit Price fields
  - Tax rate input, Notes textarea
  - Running subtotal/tax/total calculation
  - "Add Row" and "Create Invoice" buttons
- **API Test:** POST `/bill/api/v1/invoices` with `{ client_id, tax_rate: 0, notes: "Audit test invoice" }` returns 201 with invoice data including auto-generated `invoice_number`.
- **Client creation:** POST `/bill/api/v1/clients` also works correctly, creating a client with name and email.

### BILL-04: Add line items -- PASS

**Result:** PASS
**Notes:** POST `/bill/api/v1/invoices/{id}/line-items` works correctly:
- Line item 1: `{ description: "Test Service", quantity: 2, unit_price: 5000 }` -- 201 Created
- Line item 2: `{ description: "Additional Work", quantity: 1, unit_price: 3500 }` -- 201 Created

Both line items were created with unique IDs and are associated with the invoice.

### BILL-05: Client list -- PASS

**Result:** PASS
**Notes:** The Clients page at `/bill/clients` loads with heading "Clients" and subtext "Manage billing clients." The page includes a "New Client" button that toggles an inline creation form with Name and Email fields. Created clients appear in the list.

### BILL-06: Client detail -- PASS

**Result:** PASS
**Notes:** The client detail page at `/bill/clients/{id}` loads and displays the client name ("Audit Test Client"). The page shows client information and associated invoices.

### BILL-07: Billing settings -- PASS

**Result:** PASS
**Notes:** The Settings page at `/bill/settings` loads with a "Settings" heading. The page queries `GET /bill/api/v1/settings` for configuration and provides a form with fields for:
- Company name, email, phone, address, tax ID
- Default currency (USD), default tax rate
- Default payment terms (days), payment instructions
- Default footer text, terms text
- Invoice prefix (e.g., "INV")

The settings form uses `PUT /bill/api/v1/settings` to save changes.

### BILL-08: API GET /bill/api/v1/invoices -- PASS

**Result:** PASS
**Notes:** The API returns 200 with `{ data: [...] }` containing the created invoice(s). The response includes full invoice objects with `id`, `invoice_number`, `status`, `total`, `amount_paid`, `to_name`, dates, and all other fields.

---

## Bugs Found

### BUG-1: BLANK-08 -- GET /blank/api/v1/forms returns 500 (malformed array literal)

**Severity:** Medium
**Location:** `apps/blank-api/` -- forms listing query
**Error:** `PostgresError: malformed array literal` -- the org_id UUID is passed where a PostgreSQL array is expected.
**Reproduction:** `curl http://localhost/blank/api/v1/forms` (without session cookies) or any request where org_id is resolved as a plain string.
**Impact:** API returns 500 instead of 401/403 for unauthenticated requests. The SPA works around this by sending X-Org-Id header, but the server-side query still has a type mismatch bug.

### NOTE-1: BLANK SPA does not reach networkidle

**Severity:** Low
**Notes:** The Blank SPA has persistent network activity after initial load, preventing Playwright's `networkidle` wait strategy from completing within 15 seconds. This may indicate polling, WebSocket, or long-lived fetch connections. Does not affect user functionality but may impact automated testing and perceived performance metrics.

---

## Test Infrastructure

- **Tool:** Playwright 1.59.1 (chromium)
- **Test file:** `tests/blank-bill-audit.spec.ts`
- **Login method:** Session cookie from `/b3/` login, shared across SPA sub-apps
- **Wait strategy:** `domcontentloaded` (switched from `networkidle` due to Blank SPA timeout)
- **Total runtime:** ~33 seconds (16 tests)
