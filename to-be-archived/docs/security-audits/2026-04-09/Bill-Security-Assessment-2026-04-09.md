# BigBlueBam -- Bill Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Bill API (`apps/bill-api/`) and Bill Frontend (`apps/bill/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config |
| **Classification** | INTERNAL -- CONFIDENTIAL                                     |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                 |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [High](#41-high)
   - [Medium](#42-medium)
   - [Low](#43-low)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from specialized security audit agents that independently analyzed the BigBlueBam Bill (Invoicing) API and Frontend source code. After deduplication, **8 unique findings** were identified across the codebase.

No critical-severity issues were found. The most concerning finding is a **high-severity data exposure** on the public invoice view endpoint, which returns all invoice fields including tax identification numbers, internal UUIDs, and financial details that should be restricted to the invoice sender.

Five medium-severity findings cover the absence of rate limiting on public invoice token lookups, a race condition in invoice sequence number generation, missing server-side validation of payment amounts against invoice totals, negative unit price acceptance that enables financial manipulation, and a missing audit trail for payment deletion operations.

Low-severity issues include a potential open redirect in the PDF download flow and missing pagination on the invoice listing endpoint.

The overall security posture of the Bill module is moderate. The data exposure issue on the public invoice view is the most urgent concern, as it exposes sensitive financial information to anyone with a valid invoice token.

---

## 2. Finding Counts by Severity

| Severity        | Count |
|-----------------|-------|
| **Critical**    | 0     |
| **High**        | 1     |
| **Medium**      | 5     |
| **Low**         | 2     |
| **Informational** | 0   |
| **Total**       | **8** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BILL-001 | Public invoice view exposes all fields including tax IDs | 0.5 day |
| 2 | BILL-003 | Invoice sequence race condition | 1 day |
| 3 | BILL-004 | Payment amount not validated against invoice total | 0.5 day |
| 4 | BILL-005 | unit_price allows negative values | 0.5 day |
| 5 | BILL-002 | Public invoice token not rate limited | 0.5 day |

**Estimated total for top-5 remediation: 3 engineering days.**

---

## 4. Detailed Findings

### 4.1 High

---

#### BILL-001: Public Invoice View Exposes All Fields Including Tax IDs and Internal UUIDs

| Field | Value |
|-------|-------|
| **ID** | BILL-001 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-200: Exposure of Sensitive Information to an Unauthorized Actor |
| **Affected Files** | `apps/bill-api/src/routes/public.routes.ts` |

**Description:**
The public invoice view endpoint (`GET /public/invoices/:token`) returns the full invoice object without field filtering. The response includes:

- **Tax identification numbers** (e.g., VAT numbers, EIN, ABN) of both the sender and recipient organizations.
- **Internal UUIDs** for the organization, user, and related entities that could be used to target other API endpoints.
- **Full payment history** including payment method details and internal transaction references.
- **Internal notes** and metadata fields intended only for the invoice creator.
- **Line item cost breakdowns** with internal cost codes and accounting references.

The public invoice view is intended for the invoice recipient to view their invoice and make payments. Exposing sender-side tax IDs, internal notes, and entity UUIDs provides unnecessary information that could be used for social engineering, identity fraud, or further API attacks.

**Attack Scenario:**
1. Attacker obtains a public invoice token (from a forwarded email, URL history, or brute-force -- see BILL-002).
2. Attacker calls `GET /public/invoices/{token}` and receives the full invoice payload.
3. Attacker extracts the sender's tax ID number and uses it for identity fraud or competitive intelligence.
4. Attacker uses the exposed `org_id` and `user_id` UUIDs to target other org-scoped API endpoints.

**Recommended Fix:**
1. Create a public-specific response schema that includes only recipient-relevant fields: invoice number, date, due date, line items (description, quantity, unit price, amount), subtotal, tax amount, total, payment status, and the recipient's own details.
2. Exclude: tax IDs (sender's), internal UUIDs, internal notes, created_by, org_id, payment method internals, and cost codes.
3. Audit the public payment submission endpoint for similar over-exposure.

---

### 4.2 Medium

---

#### BILL-002: Public Invoice Token Not Rate Limited

| Field | Value |
|-------|-------|
| **ID** | BILL-002 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/bill-api/src/routes/public.routes.ts` |

**Description:**
The public invoice view endpoint does not enforce rate limiting. An attacker can enumerate invoice tokens by brute-forcing the token space. While UUIDs have a large keyspace making full enumeration impractical, if tokens use a shorter or predictable format (e.g., sequential or base62-encoded), the attack surface increases significantly. Additionally, the endpoint returns different HTTP status codes for valid vs. invalid tokens, enabling token existence enumeration.

**Recommended Fix:**
1. Add IP-based rate limiting on the public invoice endpoint (e.g., 30 requests per minute per IP).
2. Return identical response timing and status codes for valid and invalid tokens (prevent timing-based enumeration).
3. Ensure tokens are generated using cryptographically secure random bytes of at least 128 bits.

---

#### BILL-003: Invoice Sequence Number Race Condition

| Field | Value |
|-------|-------|
| **ID** | BILL-003 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.9 (Medium) |
| **CWE** | CWE-362: Concurrent Execution using Shared Resource with Improper Synchronization |
| **Affected Files** | `apps/bill-api/src/routes/invoice.routes.ts` |

**Description:**
Invoice sequence numbers (e.g., INV-0001, INV-0002) are generated by querying the maximum existing sequence number and incrementing it. This read-then-write pattern is not protected by a transaction with serializable isolation or an advisory lock. When two invoices are created concurrently for the same organization, both may read the same maximum sequence number and generate duplicate invoice numbers.

Duplicate invoice numbers violate accounting standards and can cause confusion in financial records, tax reporting, and payment reconciliation.

**Attack Scenario:**
1. Two team members create invoices simultaneously.
2. Both requests read `MAX(sequence_number) = 42` and generate `INV-0043`.
3. Two invoices exist with the same number, causing accounting discrepancies.

**Recommended Fix:**
1. Use a PostgreSQL sequence per organization or a serializable transaction with `SELECT ... FOR UPDATE` on a sequence counter row.
2. Add a unique constraint on `(org_id, sequence_number)` as a safety net.
3. If a duplicate constraint violation occurs, retry with the next available number.

---

#### BILL-004: Payment Amount Not Validated Against Invoice Total

| Field | Value |
|-------|-------|
| **ID** | BILL-004 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.5 (Medium) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Files** | `apps/bill-api/src/routes/payment.routes.ts` |

**Description:**
The payment recording endpoint accepts a `amount` field without validating it against the invoice's outstanding balance. It is possible to record a payment that exceeds the invoice total, record a payment on an already-paid invoice, or record a negative payment amount. This can result in:

- Overpayment records that distort financial reporting.
- Negative payment amounts that artificially increase the outstanding balance.
- Payment records on invoices with status `paid` or `void`, corrupting the invoice lifecycle.

**Recommended Fix:**
1. Validate that `amount > 0` and `amount <= invoice.total - sum(existing_payments)`.
2. Reject payments on invoices with status `paid`, `void`, or `cancelled`.
3. If partial payments are supported, update the invoice status to `partially_paid` when `0 < sum(payments) < total`.
4. Use decimal/numeric types (not float) for all financial calculations.

---

#### BILL-005: unit_price Allows Negative Values

| Field | Value |
|-------|-------|
| **ID** | BILL-005 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Files** | `apps/bill-api/src/routes/invoice.routes.ts` |

**Description:**
Invoice line items accept a `unit_price` value without a non-negative constraint. Submitting negative unit prices creates line items that reduce the invoice total, potentially resulting in:

- Invoices with negative totals (the sender "owes" the recipient).
- Financial manipulation where an attacker with invoice creation access generates credit notes or refunds disguised as regular invoices.
- Accounting anomalies in reports that aggregate invoice line item amounts.

While credit notes and discounts are legitimate use cases, they should be handled through explicit credit note workflows, not negative unit prices on standard invoices.

**Recommended Fix:**
1. Add a `z.number().nonnegative()` constraint on `unit_price` in the Zod schema.
2. If credit notes are needed, implement a separate `credit_note` document type with its own workflow and approval process.
3. For discounts, use a dedicated `discount_amount` or `discount_percent` field on line items.

---

#### BILL-006: No Audit Trail for Payment Deletion

| Field | Value |
|-------|-------|
| **ID** | BILL-006 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-778: Insufficient Logging |
| **Affected Files** | `apps/bill-api/src/routes/payment.routes.ts` |

**Description:**
The payment deletion endpoint (`DELETE /payments/:id`) hard-deletes the payment record without creating an audit log entry. In financial systems, the ability to delete payment records without a trace creates significant fraud risk. An insider with API access could delete payment records to make invoices appear unpaid, potentially triggering duplicate payments from clients.

**Recommended Fix:**
1. Replace hard deletes with soft deletes (`deleted_at` timestamp, `deleted_by` user ID).
2. Create an audit log entry for every payment deletion that records: who deleted it, when, the original payment amount, and the associated invoice.
3. Restrict payment deletion to admin-role users only.
4. Consider making payment records immutable after a configurable grace period (e.g., 24 hours).

---

### 4.3 Low

---

#### BILL-007: PDF Redirect Open Redirect Potential

| Field | Value |
|-------|-------|
| **ID** | BILL-007 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-601: URL Redirection to Untrusted Site |
| **Affected Files** | `apps/bill-api/src/routes/invoice.routes.ts` |

**Description:**
The invoice PDF download endpoint generates a pre-signed URL to the PDF stored in MinIO/S3 and responds with an HTTP 302 redirect to that URL. If the MinIO endpoint URL is configurable via environment variables and an attacker can influence the configuration (e.g., via SSRF or environment variable injection), the redirect could point to an attacker-controlled server. Additionally, if the redirect URL is constructed using user-supplied path components, it could be manipulated to redirect to an arbitrary URL.

The practical exploitability is low because it requires either server configuration access or a separate vulnerability, but the pattern should be hardened.

**Recommended Fix:**
1. Validate that the generated pre-signed URL points to the expected MinIO/S3 host before issuing the redirect.
2. Alternatively, proxy the PDF through the API server instead of redirecting, eliminating the redirect entirely.

---

#### BILL-008: Invoice List Missing Pagination

| Field | Value |
|-------|-------|
| **ID** | BILL-008 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/bill-api/src/routes/invoice.routes.ts` |

**Description:**
The `GET /invoices` endpoint returns all invoices for the authenticated user's organization without cursor-based pagination. For organizations with extensive invoice history, this results in unbounded response sizes. This is inconsistent with the pagination pattern used across other BigBlueBam modules.

**Recommended Fix:**
Implement cursor-based pagination consistent with other BigBlueBam modules. Default to 50 items per page with a maximum of 200. Support filtering by status, date range, and client.

---

## 5. Methodology Notes

Each audit agent independently analyzed the Bill module source code with a focus on its specialized domain. Agents had read access to the full `apps/bill-api/` and `apps/bill/` directories, as well as `packages/shared/` for schema definitions. Findings were deduplicated by root cause.

Financial integrity findings (sequence numbers, payment validation, negative prices) received heightened scrutiny given the compliance implications of an invoicing system. The public invoice endpoint was analyzed for both data exposure and abuse resistance.

---

## 6. Appendix: Agent Coverage Map

| Agent | Files Reviewed | Findings Contributed |
|-------|---------------|---------------------|
| Data Exposure & XSS | `routes/public.routes.ts` | BILL-001 |
| Rate Limiting & DoS | `routes/public.routes.ts`, `routes/invoice.routes.ts` | BILL-002, BILL-008 |
| Business Logic | `routes/invoice.routes.ts`, `routes/payment.routes.ts` | BILL-003, BILL-004, BILL-005 |
| Auth & Session | All route files | (corroborated BILL-001) |
| Input Validation | `routes/invoice.routes.ts`, `routes/payment.routes.ts` | BILL-004, BILL-005 |
| Authorization (RBAC) | `routes/payment.routes.ts` | BILL-006 |
| Cryptography | All route files | (no unique findings) |
| Dependencies & Config | `package.json`, `Dockerfile` | (no unique findings) |
