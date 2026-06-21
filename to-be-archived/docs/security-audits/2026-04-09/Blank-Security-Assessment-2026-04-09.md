# BigBlueBam -- Blank Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Blank API (`apps/blank-api/`) and Blank Frontend (`apps/blank/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, SQL Injection, Cryptography, Dependencies & Config |
| **Classification** | INTERNAL -- CONFIDENTIAL                                     |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                 |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [Critical](#41-critical)
   - [High](#42-high)
   - [Medium](#43-medium)
   - [Low](#44-low)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from specialized security audit agents that independently analyzed the BigBlueBam Blank (Forms) API and Frontend source code. After deduplication, **9 unique findings** were identified across the codebase.

The most severe issue is a **critical authorization bypass** on submission retrieval and deletion endpoints. The `GET /submissions/:id` and `DELETE /submissions/:id` routes look up submissions by primary key without verifying that the submission belongs to a form owned by the authenticated user's organization. Any authenticated user can read or delete any submission across the entire platform, exposing personally identifiable information (PII) collected through forms -- including names, emails, phone numbers, addresses, and any other data captured by custom form fields.

Three high-severity findings include missing organization scoping on field update and delete operations (allowing cross-org modification of form structures), missing server-side field validation on public form submissions (allowing arbitrary JSON payloads to bypass field type constraints), and SQL injection via the `field_key` parameter in the analytics endpoint.

Medium-severity issues span stored XSS risk through custom CSS injection, unbounded CSV export, unenforced CAPTCHA and one-per-email constraints, and public form definition endpoints leaking internal metadata.

The overall security posture of the Blank module requires **immediate remediation of the submission access control gap** given the PII exposure risk. The authorization pattern across the module is inconsistent and should be systematically reviewed.

---

## 2. Finding Counts by Severity

| Severity        | Count |
|-----------------|-------|
| **Critical**    | 1     |
| **High**        | 3     |
| **Medium**      | 4     |
| **Low**         | 1     |
| **Informational** | 0   |
| **Total**       | **9** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BLANK-001 | Submission get/delete missing org scoping (PII exposure) | 1 day |
| 2 | BLANK-002 | Field update/delete missing org scoping | 0.5 day |
| 3 | BLANK-003 | Public form submission missing field validation | 1 day |
| 4 | BLANK-004 | SQL injection via field_key in analytics | 1 day |
| 5 | BLANK-005 | Custom CSS stored XSS risk | 1 day |

**Estimated total for top-5 remediation: 4.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BLANK-001: Submission Get/Delete Missing Organization Scoping -- PII Exposure

| Field | Value |
|-------|-------|
| **ID** | BLANK-001 |
| **Severity** | Critical |
| **CVSS 3.1** | 9.1 (Critical) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Files** | `apps/blank-api/src/routes/submission.routes.ts` |

**Description:**
The `GET /submissions/:id` and `DELETE /submissions/:id` endpoints look up submissions using only the submission's primary key ID. There is no join or WHERE clause verifying that the submission belongs to a form owned by the authenticated user's organization. Any authenticated user can:

1. Read any submission by supplying its UUID, gaining access to all form field values including PII (names, emails, phone numbers, addresses, file uploads, and any other custom field data).
2. Delete any submission, destroying evidence and audit trails across organizations.

The submission listing endpoint (`GET /forms/:formId/submissions`) appears to be form-scoped, but the individual submission endpoints operate on the submission ID alone.

**Attack Scenario:**
1. Attacker authenticates with any valid account.
2. Attacker calls `GET /submissions/{submission_id}` with UUIDs obtained by enumeration, leaked URLs, or other means.
3. The endpoint returns the full submission payload including all field values -- names, emails, phone numbers, free-text responses, and file attachment references.
4. Attacker exfiltrates PII from thousands of form submissions across all organizations on the platform.
5. Attacker can also call `DELETE /submissions/{id}` to destroy submissions, covering tracks or sabotaging other organizations' data collection.

**Recommended Fix:**
1. Add organization scoping to all individual submission endpoints: join through `submissions -> forms -> org_id` and verify `form.org_id === request.user.org_id`.
2. Add a `requireFormAccess` middleware that validates the authenticated user has access to the form that owns the submission.
3. Audit all submission-related endpoints (export, analytics, bulk operations) for the same pattern.

---

### 4.2 High

---

#### BLANK-002: Field Update/Delete Missing Organization Scoping

| Field | Value |
|-------|-------|
| **ID** | BLANK-002 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Files** | `apps/blank-api/src/routes/field.routes.ts` |

**Description:**
The `PATCH /fields/:id` and `DELETE /fields/:id` endpoints look up form fields by primary key without verifying that the field belongs to a form in the authenticated user's organization. An authenticated user in Organization A can modify or delete form fields belonging to Organization B's forms.

Modifying a field (e.g., changing its type, label, or validation rules) can corrupt existing submission data or alter the form's behavior for future submissions. Deleting a field removes it from the form definition and may cascade to orphaned submission data.

**Attack Scenario:**
1. Attacker authenticates with a valid account.
2. Attacker calls `PATCH /fields/{org_b_field_id}` to change the field label from "Email" to "Phone Number", confusing respondents.
3. Alternatively, attacker calls `DELETE /fields/{id}` to remove a required field, breaking the form.

**Recommended Fix:**
Add organization scoping: join through `fields -> forms -> org_id` and verify the authenticated user's org_id matches before any mutation.

---

#### BLANK-003: Public Form Submission Missing Field Validation

| Field | Value |
|-------|-------|
| **ID** | BLANK-003 |
| **Severity** | High |
| **CVSS 3.1** | 7.3 (High) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Files** | `apps/blank-api/src/routes/submission.routes.ts` |

**Description:**
The public form submission endpoint (`POST /public/forms/:token/submissions`) accepts the submission payload without validating it against the form's field definitions. The endpoint stores whatever JSON is submitted in the `data` JSONB column without verifying:

- Required fields are present.
- Field values match their defined types (e.g., email format for email fields, numeric values for number fields).
- No extra fields beyond those defined in the form are submitted.
- Field value lengths are within acceptable bounds.

This allows attackers to submit malformed data, inject arbitrary keys into the JSONB payload, or bypass required field constraints.

**Attack Scenario:**
1. Attacker submits a form with missing required fields, bypassing the frontend validation.
2. Attacker injects extra keys like `{ "admin_notes": "promoted to admin" }` into the submission data.
3. Attacker submits extremely long string values (megabytes per field) to consume storage.
4. If submission data is later rendered without sanitization, injected HTML/script content could execute in admin views.

**Recommended Fix:**
1. On the server side, load the form's field definitions and dynamically build a Zod schema that validates the submission payload against the form structure.
2. Reject submissions with missing required fields, invalid types, or unknown keys.
3. Enforce maximum value lengths per field type (e.g., 10,000 characters for text, 254 characters for email).
4. Strip or reject any keys not present in the form's field definitions.

---

#### BLANK-004: SQL Injection via field_key in Analytics

| Field | Value |
|-------|-------|
| **ID** | BLANK-004 |
| **Severity** | High |
| **CVSS 3.1** | 8.1 (High) |
| **CWE** | CWE-89: Improper Neutralization of Special Elements used in an SQL Command |
| **Affected Files** | `apps/blank-api/src/routes/analytics.routes.ts` |

**Description:**
The analytics endpoint constructs SQL queries that reference submission JSONB fields using a `field_key` parameter. The `field_key` value is interpolated into the SQL string to build JSONB path expressions:

```typescript
const query = `SELECT data->>'${fieldKey}' as value, COUNT(*) FROM submissions ...`;
```

The `field_key` is not validated against the form's actual field definitions or sanitized for SQL metacharacters. An attacker can inject arbitrary SQL through the field_key parameter.

**Attack Scenario:**
1. Attacker calls `GET /forms/:id/analytics?field_key=name' UNION SELECT password_hash, 1 FROM users --`.
2. The injected SQL executes and returns data from the `users` table.
3. Attacker exfiltrates credentials, session tokens, or any other database content.

**Recommended Fix:**
1. Validate `field_key` against the form's field definitions -- only allow keys that actually exist as defined fields.
2. Use parameterized JSONB access: `data->>$1` with the field_key as a bound parameter.
3. Add a strict regex validation on field_key (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) as a defense-in-depth measure.

---

### 4.3 Medium

---

#### BLANK-005: Custom CSS Stored XSS Risk

| Field | Value |
|-------|-------|
| **ID** | BLANK-005 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.1 (Medium) |
| **CWE** | CWE-79: Improper Neutralization of Input During Web Page Generation |
| **Affected Files** | `apps/blank-api/src/routes/form.routes.ts`, `apps/blank/src/components/PublicForm.tsx` |

**Description:**
The form builder allows administrators to add custom CSS that is applied to the public form rendering. This CSS is stored in the database and injected into the public form page without sanitization. While CSS injection is lower risk than JavaScript injection, an attacker with form admin access can:

- Use CSS `content` properties and `attr()` to exfiltrate form field values to external servers via `background-image: url(...)`.
- Use CSS keylogger techniques to detect which characters users type in form fields.
- Deface the form to phish for credentials or redirect users.

**Recommended Fix:**
1. Implement a CSS sanitizer that strips `url()`, `@import`, `expression()`, and `behavior:` directives.
2. Use a CSS parser (e.g., PostCSS) to validate and sanitize the CSS AST, allowing only safe properties.
3. Alternatively, use a `<style>` tag with a Content-Security-Policy that restricts the CSS scope.

---

#### BLANK-006: Unbounded CSV Export

| Field | Value |
|-------|-------|
| **ID** | BLANK-006 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/blank-api/src/routes/submission.routes.ts` |

**Description:**
The CSV export endpoint (`GET /forms/:id/submissions/export`) generates a CSV file containing all submissions for a form without row limits or streaming. For forms with a large number of submissions (tens of thousands or more), this loads the entire result set into memory on the server before sending the response, potentially causing out-of-memory errors.

**Recommended Fix:**
1. Implement streaming CSV generation using Node.js streams to avoid loading all rows into memory.
2. Add a configurable row limit (e.g., 100,000 rows) with a warning to the user.
3. For very large exports, offload to a background job (BullMQ) and provide a download link when complete.

---

#### BLANK-007: CAPTCHA Not Enforced on Public Form Submission

| Field | Value |
|-------|-------|
| **ID** | BLANK-007 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-799: Improper Control of Interaction Frequency |
| **Affected Files** | `apps/blank-api/src/routes/submission.routes.ts` |

**Description:**
Public form submission supports a CAPTCHA configuration flag in the form settings, but the server-side endpoint does not enforce CAPTCHA validation. Even when a form is configured to require CAPTCHA, submissions are accepted without verifying the CAPTCHA token. This allows automated spam submissions that bypass the intended protection.

**Recommended Fix:**
1. When the form's `require_captcha` flag is true, verify the CAPTCHA response token server-side before processing the submission.
2. Reject submissions with missing or invalid CAPTCHA tokens with a 422 error.

---

#### BLANK-008: one_per_email Constraint Not Enforced Server-Side

| Field | Value |
|-------|-------|
| **ID** | BLANK-008 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-799: Improper Control of Interaction Frequency |
| **Affected Files** | `apps/blank-api/src/routes/submission.routes.ts` |

**Description:**
Forms can be configured with a `one_per_email` setting intended to restrict each email address to a single submission. However, this constraint is only enforced on the frontend. The server-side submission handler does not check for existing submissions with the same email address before creating a new one. An attacker can submit the form multiple times with the same email by calling the API directly, bypassing the frontend check.

**Recommended Fix:**
1. When `one_per_email` is enabled, query existing submissions for the form where the email field matches the submitted value.
2. Return HTTP 409 Conflict if a submission already exists for that email.
3. Consider adding a unique partial index on `(form_id, data->>'email')` for forms with this constraint enabled.

---

### 4.4 Low

---

#### BLANK-009: Public Form Definition Leaks Internal Data

| Field | Value |
|-------|-------|
| **ID** | BLANK-009 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-200: Exposure of Sensitive Information to an Unauthorized Actor |
| **Affected Files** | `apps/blank-api/src/routes/form.routes.ts` |

**Description:**
The public form definition endpoint (`GET /public/forms/:token`) returns the full form object including internal fields such as `org_id`, `created_by` (user UUID), `created_at`, `updated_at`, internal form settings, and analytics configuration. While none of these fields are directly exploitable, they leak internal identifiers that could aid in targeting other API endpoints (e.g., using the `org_id` to construct requests against org-scoped endpoints).

**Recommended Fix:**
Create a public-specific response schema that returns only the fields needed to render the form: `title`, `description`, `fields` (definitions only), `theme`, `custom_css`, and `settings` (only public-facing settings like `require_captcha` and `one_per_email`).

---

## 5. Methodology Notes

Each audit agent independently analyzed the Blank module source code with a focus on its specialized domain. Agents had read access to the full `apps/blank-api/` and `apps/blank/` directories, as well as `packages/shared/` for schema definitions. Findings were deduplicated by root cause.

The public form submission flow received particular scrutiny given its unauthenticated nature and the sensitivity of data collected through forms. The SQL injection finding was confirmed by tracing the `field_key` parameter from the request through to the SQL query construction.

---

## 6. Appendix: Agent Coverage Map

| Agent | Files Reviewed | Findings Contributed |
|-------|---------------|---------------------|
| Authorization (RBAC) | `routes/submission.routes.ts`, `routes/field.routes.ts` | BLANK-001, BLANK-002 |
| Input Validation | `routes/submission.routes.ts`, `routes/analytics.routes.ts` | BLANK-003, BLANK-004 |
| SQL Injection | `routes/analytics.routes.ts` | BLANK-004 |
| Data Exposure & XSS | `routes/form.routes.ts`, `components/PublicForm.tsx` | BLANK-005, BLANK-009 |
| Rate Limiting & DoS | `routes/submission.routes.ts` | BLANK-006 |
| Business Logic | `routes/submission.routes.ts` | BLANK-007, BLANK-008 |
| Auth & Session | All route files | (corroborated BLANK-001) |
| Cryptography | All route files | (no unique findings) |
| Dependencies & Config | `package.json`, `Dockerfile` | (no unique findings) |
