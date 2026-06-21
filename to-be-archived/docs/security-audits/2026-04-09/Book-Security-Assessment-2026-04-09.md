# BigBlueBam -- Book Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Book API (`apps/book-api/`) and Book Frontend (`apps/book/`) |
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

This assessment consolidates findings from specialized security audit agents that independently analyzed the BigBlueBam Book (Scheduling) API and Frontend source code. After deduplication, **8 unique findings** were identified across the codebase.

No critical-severity issues were found. The most concerning finding is a **race condition in the public booking endpoint** that allows double-booking of time slots. When two booking requests arrive concurrently for the same slot, neither request observes the other's pending reservation, and both succeed -- resulting in conflicting appointments. This is a high-severity business logic flaw that undermines the core purpose of the scheduling system.

Five medium-severity issues span missing rate limiting on public booking slots, cross-organization schedule exposure through the availability endpoint, missing organization scoping on team availability, iCal feed tokens that are not scoped to the owning user, and uncertainty about the encryption of external calendar integration tokens (OAuth refresh tokens for Google Calendar, Outlook, etc.).

Low-severity findings include missing UUID validation on calendar ID parameters and missing cursor pagination on event listing endpoints.

The overall security posture of the Book module is moderate. The race condition and cross-org exposure issues should be addressed before production deployment with multi-tenant data.

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
| 1 | BOOK-001 | Public booking missing double-booking check (race condition) | 1-2 days |
| 2 | BOOK-003 | Availability endpoint exposes any user's schedule cross-org | 0.5 day |
| 3 | BOOK-004 | Team availability missing org scoping | 0.5 day |
| 4 | BOOK-005 | iCal token not scoped to user | 0.5 day |
| 5 | BOOK-002 | Public booking slots no rate limit | 0.5 day |

**Estimated total for top-5 remediation: 3-4 engineering days.**

---

## 4. Detailed Findings

### 4.1 High

---

#### BOOK-001: Public Booking Missing Double-Booking Check (Race Condition)

| Field | Value |
|-------|-------|
| **ID** | BOOK-001 |
| **Severity** | High |
| **CVSS 3.1** | 7.4 (High) |
| **CWE** | CWE-362: Concurrent Execution using Shared Resource with Improper Synchronization |
| **Affected Files** | `apps/book-api/src/routes/booking.routes.ts` |

**Description:**
The public booking endpoint accepts a booking request and checks for conflicting appointments using a `SELECT` query before inserting the new booking. However, this check-then-insert sequence is not wrapped in a serializable transaction or protected by a row-level lock (`SELECT ... FOR UPDATE`). When two concurrent booking requests arrive for overlapping time slots on the same calendar, both SELECT queries execute before either INSERT completes, and both find no conflicts. Both bookings are created, resulting in a double-booked time slot.

This is a classic TOCTOU (Time-of-Check-to-Time-of-Use) race condition. The window is small but easily exploitable under load or by an attacker sending parallel requests.

**Attack Scenario:**
1. Attacker identifies a high-value time slot on a public booking page.
2. Attacker sends 10 simultaneous POST requests to the booking endpoint for the same time slot from different browser sessions or API clients.
3. Multiple bookings succeed for the same slot, causing scheduling conflicts.
4. In a business context, this could result in missed appointments, double-committed resources, or scheduling chaos.

**Recommended Fix:**
1. Wrap the conflict check and insert in a serializable transaction: `BEGIN ISOLATION LEVEL SERIALIZABLE; ... COMMIT;`.
2. Alternatively, use an advisory lock on the calendar ID + time slot hash: `SELECT pg_advisory_xact_lock(hashtext(calendar_id || start_time))` before the conflict check.
3. Add a unique partial index on `(calendar_id, start_time, end_time)` with a `WHERE status != 'cancelled'` condition to provide a database-level constraint as a safety net.
4. Return HTTP 409 Conflict when the race is detected at the constraint level.

---

### 4.2 Medium

---

#### BOOK-002: Public Booking Slots No Rate Limit

| Field | Value |
|-------|-------|
| **ID** | BOOK-002 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/book-api/src/routes/booking.routes.ts` |

**Description:**
The public booking slot creation endpoint does not enforce rate limiting. Since this endpoint is unauthenticated (it is intended for external visitors to book appointments), there is no per-user throttle. An attacker can flood the endpoint with booking requests to exhaust available time slots, creating a denial-of-service against the scheduling system.

**Recommended Fix:**
1. Add IP-based rate limiting on the public booking endpoint (e.g., 10 requests per minute per IP).
2. Implement CAPTCHA verification for public booking submissions after a threshold (e.g., 3 bookings from the same IP in a session).
3. Consider requiring email verification before confirming the booking.

---

#### BOOK-003: Availability Endpoint Exposes Any User's Schedule Cross-Org

| Field | Value |
|-------|-------|
| **ID** | BOOK-003 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.5 (Medium) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/book-api/src/routes/availability.routes.ts` |

**Description:**
The availability endpoint (`GET /availability/:userId`) accepts any user ID and returns their availability windows and busy slots without verifying that the requesting user belongs to the same organization as the target user. An authenticated user in Organization A can query the full schedule of any user in Organization B by supplying their user ID.

This leaks sensitive scheduling information including meeting times, appointment durations, and patterns of availability that could be used for competitive intelligence or social engineering.

**Recommended Fix:**
1. Add organization scoping: verify `targetUser.org_id === request.user.org_id` before returning availability data.
2. For cross-org public booking pages, expose only the available slots (not the busy/occupied slot details) through a separate public endpoint with the booking page token.

---

#### BOOK-004: Team Availability Missing Organization Scoping

| Field | Value |
|-------|-------|
| **ID** | BOOK-004 |
| **Severity** | Medium |
| **CVSS 3.1** | 6.5 (Medium) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/book-api/src/routes/availability.routes.ts` |

**Description:**
The team availability endpoint accepts a list of user IDs and returns aggregated availability. It does not verify that all specified user IDs belong to the authenticated user's organization. An attacker can include user IDs from other organizations in the team availability query and receive their schedule data.

**Recommended Fix:**
Filter the provided user ID list to include only users within the authenticated user's organization before querying availability. Return an error or silently exclude out-of-org user IDs.

---

#### BOOK-005: iCal Token Not Scoped to User

| Field | Value |
|-------|-------|
| **ID** | BOOK-005 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.4 (Medium) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Files** | `apps/book-api/src/routes/ical.routes.ts` |

**Description:**
The iCal feed endpoint uses a token-based authentication mechanism (`GET /ical/:token`) to serve calendar data without requiring session authentication. However, the token lookup does not verify that the token belongs to the calendar being requested, or that the calendar belongs to the user who generated the token. If a user obtains another user's iCal token (e.g., from a shared link or URL history), they gain permanent read access to that user's full calendar feed.

**Recommended Fix:**
1. Scope iCal tokens to a specific user and calendar: store `(token, user_id, calendar_id)` and verify all three match on each request.
2. Add token rotation capability so users can invalidate compromised tokens.
3. Include the user ID as a path component (`/ical/:userId/:token`) and verify the token matches the user.

---

#### BOOK-006: External Calendar Tokens Encryption Unknown

| Field | Value |
|-------|-------|
| **ID** | BOOK-006 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.9 (Medium) |
| **CWE** | CWE-312: Cleartext Storage of Sensitive Information |
| **Affected Files** | `apps/book-api/src/db/schema/` |

**Description:**
The Book module stores OAuth refresh tokens for external calendar integrations (Google Calendar, Microsoft Outlook). The audit could not confirm whether these tokens are encrypted at rest in the database. If stored in plaintext, a database compromise (via SQL injection, backup exposure, or unauthorized access) would expose long-lived OAuth tokens that grant read/write access to users' external calendars.

**Recommended Fix:**
1. Verify and document whether external calendar tokens are encrypted at rest.
2. If not encrypted, implement AES-256-GCM encryption with a per-row IV, using a dedicated encryption key (not `SESSION_SECRET`).
3. Store the encryption key in a secrets manager, not in environment variables or source code.

---

### 4.3 Low

---

#### BOOK-007: Calendar ID Not Validated as UUID in Events Endpoint

| Field | Value |
|-------|-------|
| **ID** | BOOK-007 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Files** | `apps/book-api/src/routes/event.routes.ts` |

**Description:**
The events endpoint accepts a `calendarId` path parameter that is not validated as a UUID format before being used in database queries. While PostgreSQL will reject non-UUID values with a query error, the lack of upfront validation results in unhandled exceptions and potentially verbose error messages being returned to the client.

**Recommended Fix:**
Add Zod validation (`z.string().uuid()`) on the `calendarId` path parameter in the route schema definition. Return a clean 400 error for malformed IDs.

---

#### BOOK-008: No Cursor Pagination on Events Endpoint

| Field | Value |
|-------|-------|
| **ID** | BOOK-008 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/book-api/src/routes/event.routes.ts` |

**Description:**
The `GET /calendars/:id/events` endpoint returns all events for a calendar without cursor-based pagination. For calendars with extensive event history, this results in unbounded response sizes that consume excessive server and client memory. This is inconsistent with the pagination pattern used across other BigBlueBam modules.

**Recommended Fix:**
Implement cursor-based pagination consistent with other BigBlueBam modules. Default to 50 items per page with a maximum of 200. Support date-range filtering to allow clients to request only relevant time windows.

---

## 5. Methodology Notes

Each audit agent independently analyzed the Book module source code with a focus on its specialized domain. Agents had read access to the full `apps/book-api/` and `apps/book/` directories, as well as `packages/shared/` for schema definitions. Findings were deduplicated by root cause.

The public booking flow received particular scrutiny given its unauthenticated nature. The race condition finding was validated by analyzing the transaction isolation level and confirming the absence of row-level locks around the conflict check.

---

## 6. Appendix: Agent Coverage Map

| Agent | Files Reviewed | Findings Contributed |
|-------|---------------|---------------------|
| Business Logic | `routes/booking.routes.ts` | BOOK-001 |
| Rate Limiting & DoS | `routes/booking.routes.ts`, `routes/event.routes.ts` | BOOK-002, BOOK-008 |
| Authorization (RBAC) | `routes/availability.routes.ts`, `routes/ical.routes.ts` | BOOK-003, BOOK-004, BOOK-005 |
| Cryptography | `db/schema/`, `services/` | BOOK-006 |
| Input Validation | `routes/event.routes.ts` | BOOK-007 |
| Auth & Session | All route files | (corroborated BOOK-003, BOOK-005) |
| Data Exposure & XSS | All route files | (no unique findings) |
| Dependencies & Config | `package.json`, `Dockerfile` | (no unique findings) |
