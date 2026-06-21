# BigBlueBam -- Bond Module Security Assessment

| Field              | Value                                                                |
|--------------------|----------------------------------------------------------------------|
| **Date**           | 2026-04-09                                                           |
| **Scope**          | Bond API (`apps/bond-api/`) and Bond Frontend (`apps/bond/`)        |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)         |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, SQL Injection, Dependencies & Config, API Design, Data Integrity |
| **Classification** | INTERNAL -- CONFIDENTIAL                                             |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                         |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [Medium](#41-medium)
   - [Low](#42-low)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Bond (CRM) API and Frontend source code. After deduplication, **8 unique findings** were identified across the codebase.

The Bond module demonstrates a **stronger security baseline** than several other BigBlueBam modules. All CRUD endpoints enforce org-scoping in their database queries (e.g., `eq(bondContacts.organization_id, orgId)` is consistently applied), preventing the cross-org data access vulnerabilities found in other modules. Role-based access control is applied to mutating endpoints, and input validation uses Zod schemas throughout.

The most significant finding class is **cross-org data leakage in related entity joins** -- the contact detail endpoint fetches associated companies, deals, and activities by `contact_id` alone without including an `organization_id` filter on the joined tables. If a contact's ID were to collide with or be referenced by a row in another org (e.g., via a data migration bug), the response would leak cross-org data. A second concern is **owner_id spoofing** on creation endpoints, where an attacker can set the `owner_id` to any user UUID, potentially attributing CRM records to users who did not create them.

The overall security posture is **adequate for staging deployment** with the caveat that the related entity join issue should be addressed before production multi-tenant use.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 0     |
| **High**          | 0     |
| **Medium**        | 3     |
| **Low**           | 5     |
| **Informational** | 0     |
| **Total**         | **8** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. As there are no Critical or High findings, these address the Medium and most impactful Low issues.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BOND-001 | Cross-org data leakage in contact detail related entity joins | 1 day |
| 2 | BOND-002 | Owner ID spoofing on creation endpoints | 0.5 day |
| 3 | BOND-003 | Pipeline deletion check not org-scoped | 0.5 day |
| 4 | BOND-006 | Ownership guard defined but never used | 0.5 day |
| 5 | BOND-007 | Missing rate limits on analytics endpoints | 0.5 day |

**Estimated total for top-5 remediation: 3 engineering days.**

---

## 4. Detailed Findings

### 4.1 Medium

---

#### BOND-001: Cross-Org Data Leakage in Contact Detail Related Entity Joins

| Field | Value |
|-------|-------|
| **ID** | BOND-001 |
| **Severity** | Medium |
| **Affected Files** | `apps/bond-api/src/services/contact.service.ts` (lines 145-188) |

**Description:**
The `getContact()` function correctly fetches the contact itself with an `organization_id` filter:

```typescript
const [contact] = await db
  .select()
  .from(bondContacts)
  .where(and(eq(bondContacts.id, id), eq(bondContacts.organization_id, orgId)))
  .limit(1);
```

However, the subsequent queries for associated companies, deals, and activities use only `contact_id` without an `organization_id` filter:

```typescript
// Companies — no org filter on bondCompanies
const companies = await db
  .select({ ... })
  .from(bondContactCompanies)
  .innerJoin(bondCompanies, eq(bondContactCompanies.company_id, bondCompanies.id))
  .where(eq(bondContactCompanies.contact_id, id));

// Deals — no org filter on bondDeals
const deals = await db
  .select({ ... })
  .from(bondDealContacts)
  .innerJoin(bondDeals, eq(bondDealContacts.deal_id, bondDeals.id))
  .where(eq(bondDealContacts.contact_id, id));

// Activities — no org filter
const activities = await db
  .select()
  .from(bondActivities)
  .where(eq(bondActivities.contact_id, id))
  .orderBy(desc(bondActivities.performed_at))
  .limit(20);
```

If a `bondContactCompanies`, `bondDealContacts`, or `bondActivities` row were to reference a `contact_id` belonging to a different organization (e.g., due to a data migration error, a UUID collision in test data, or a future feature that shares contacts across orgs), the response would include companies, deals, and activities from the other organization.

The same pattern exists in `getDeal()` in `deal.service.ts` (lines 145-208), where contacts, stage history, activities, and company data are fetched by `deal_id` without org filtering on joined tables.

**Attack Scenario:**
1. An attacker in Org A knows or guesses a contact UUID that exists in Org A (legitimate access).
2. If a `bondDealContacts` row links that contact to a deal in Org B (via a bug or shared-contact feature), the response includes Org B deal names, values, and stage IDs.
3. The attacker gains insight into Org B's sales pipeline without authorization.

**Recommended Fix:**
Add `eq(bondCompanies.organization_id, orgId)`, `eq(bondDeals.organization_id, orgId)`, and `eq(bondActivities.organization_id, orgId)` to each of the related-entity queries. Apply the same fix to `getDeal()` in `deal.service.ts`.

---

#### BOND-002: Owner ID Spoofing on Creation Endpoints

| Field | Value |
|-------|-------|
| **ID** | BOND-002 |
| **Severity** | Medium |
| **Affected Files** | `apps/bond-api/src/routes/contacts.routes.ts` (line 32), `apps/bond-api/src/routes/deals.routes.ts` (line 19), `apps/bond-api/src/services/contact.service.ts` (line 219), `apps/bond-api/src/services/deal.service.ts` (line 257) |

**Description:**
Both the contact and deal creation schemas accept an optional `owner_id` field as a UUID. The service layer uses it directly:

```typescript
owner_id: input.owner_id ?? userId,
```

Any authenticated user with `member` role can set `owner_id` to any UUID, including:
- Another user's ID in the same org (attributing the record to someone else).
- A user ID from a different org (the field is not validated against org membership).
- A non-existent UUID (creating orphaned ownership).

While the `owner_id` is primarily used for display and filtering (not access control in the current code), incorrect attribution could be used for social engineering ("Your manager created this deal") or to bypass future ownership-based access controls.

**Attack Scenario:**
1. User A creates a contact with `owner_id` set to the CEO's user ID.
2. The contact appears in the CEO's "My Contacts" view.
3. Other team members assume the CEO personally added this contact, lending it unearned credibility.

**Recommended Fix:**
Validate that `owner_id`, when provided, belongs to an active user in the same organization. If the caller is not an admin/owner, restrict `owner_id` to the caller's own ID.

---

#### BOND-003: Pipeline Deletion Check Not Org-Scoped

| Field | Value |
|-------|-------|
| **ID** | BOND-003 |
| **Severity** | Medium |
| **Affected Files** | `apps/bond-api/src/services/pipeline.service.ts` (lines 172-190) |

**Description:**
The `deletePipeline()` function checks whether any deals reference the pipeline before allowing deletion:

```typescript
const [dealCount] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(bondDeals)
  .where(eq(bondDeals.pipeline_id, id));
```

This query counts deals across *all organizations*, not just the requesting user's org. While the actual DELETE is org-scoped (line 185 includes `eq(bondPipelines.organization_id, orgId)`), the guard check could produce a false positive: if Org B has deals referencing a pipeline ID that happens to exist in Org A (possible if pipeline IDs are guessable or reused in test data), the deletion of Org A's pipeline would be incorrectly blocked.

In practice, this is unlikely with UUIDs but represents a defense-in-depth gap.

**Recommended Fix:**
Add `eq(bondDeals.organization_id, orgId)` to the deal count query:

```typescript
.where(and(eq(bondDeals.pipeline_id, id), eq(bondDeals.organization_id, orgId)))
```

---

### 4.2 Low

---

#### BOND-004: Missing UUID Validation on Route Params

| Field | Value |
|-------|-------|
| **ID** | BOND-004 |
| **Severity** | Low |
| **Affected Files** | `apps/bond-api/src/routes/contacts.routes.ts`, `apps/bond-api/src/routes/deals.routes.ts`, `apps/bond-api/src/routes/pipelines.routes.ts`, `apps/bond-api/src/routes/activities.routes.ts` |

**Description:**
Route parameters like `:id`, `:stageId`, and `:contactId` are read directly from `request.params` without UUID format validation. While Drizzle ORM will safely parameterize the value in SQL queries (preventing injection), passing non-UUID strings to PostgreSQL `uuid` columns will trigger a database-level error that surfaces as a 500 Internal Server Error with a potentially verbose error message.

**Attack Scenario:**
1. Attacker calls `GET /v1/contacts/not-a-uuid`.
2. PostgreSQL returns: `ERROR: invalid input syntax for type uuid: "not-a-uuid"`.
3. The error handler may leak the database error message in the response.

**Recommended Fix:**
Add a shared UUID validation utility or Fastify schema that validates `:id` parameters match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` before the handler executes. Alternatively, use Fastify JSON Schema for route params.

---

#### BOND-005: Stage Deletion Check Not Org-Scoped

| Field | Value |
|-------|-------|
| **ID** | BOND-005 |
| **Severity** | Low |
| **Affected Files** | `apps/bond-api/src/services/pipeline.service.ts` (lines 265-291) |

**Description:**
Similar to BOND-003, the `deleteStage()` function checks for deals in the stage without org-scoping:

```typescript
const [dealCount] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(bondDeals)
  .where(eq(bondDeals.stage_id, stageId));
```

While `getPipeline(pipelineId, orgId)` is called first (which verifies the pipeline belongs to the org), the deal count query itself spans all orgs.

**Recommended Fix:**
Add `eq(bondDeals.organization_id, orgId)` to the deal count WHERE clause for consistency.

---

#### BOND-006: Ownership Guard Defined but Never Used

| Field | Value |
|-------|-------|
| **ID** | BOND-006 |
| **Severity** | Low |
| **Affected Files** | `apps/bond-api/src/middleware/authorize.ts` (lines 52-79) |

**Description:**
The `requireOwnershipOrRole()` middleware function is defined in `authorize.ts` with a clear purpose: restrict access to resources based on ownership. However, it is not imported or used by any route file in the Bond API. All routes use `requireAuth`, `requireMinRole`, or `requireScope` only.

This means the ownership-based access control model documented in the middleware comments is not enforced. Any user with `member` role can read, update, or delete any contact, deal, or company in their org, regardless of the `owner_id` field.

**Recommended Fix:**
Either integrate `requireOwnershipOrRole()` into the appropriate route pre-handlers (e.g., `PATCH /contacts/:id` and `DELETE /contacts/:id` should check that the caller is the contact owner or an admin), or remove the dead code to avoid the false impression that ownership-based access control is in place.

---

#### BOND-007: Missing Rate Limits on Analytics Endpoints

| Field | Value |
|-------|-------|
| **ID** | BOND-007 |
| **Severity** | Low |
| **Affected Files** | `apps/bond-api/src/routes/analytics.routes.ts` (all endpoints) |

**Description:**
None of the six analytics endpoints (`/analytics/pipeline-summary`, `/analytics/conversion-rates`, `/analytics/deal-velocity`, `/analytics/forecast`, `/analytics/stale-deals`, `/analytics/win-loss`) have route-level rate limits. Analytics queries typically involve aggregations and joins that are more expensive than simple CRUD operations. A client could rapidly poll these endpoints, causing excessive database load.

**Recommended Fix:**
Add route-level rate limits to all analytics endpoints: `config: { rateLimit: { max: 10, timeWindow: '1 minute' } }`.

---

#### BOND-008: Unbounded `custom_fields` JSON

| Field | Value |
|-------|-------|
| **ID** | BOND-008 |
| **Severity** | Low |
| **Affected Files** | `apps/bond-api/src/routes/contacts.routes.ts` (line 31), `apps/bond-api/src/routes/deals.routes.ts` (line 21) |

**Description:**
Both contact and deal creation/update schemas accept `custom_fields: z.record(z.unknown()).optional()` with no constraints on the number of keys, depth of nesting, or total serialized size. A user could store megabytes of data in the `custom_fields` JSONB column, which is returned in every list and detail response.

**Attack Scenario:**
1. Attacker creates contacts with 10,000 custom field keys, each containing deeply nested objects.
2. List endpoints return all contacts with their full `custom_fields`, dramatically increasing response size and database I/O.

**Recommended Fix:**
Add a `z.string().max(50000).transform(JSON.parse)` wrapper or implement a custom Zod refinement that limits the number of top-level keys (e.g., max 100) and the total serialized size (e.g., max 50 KB).

---

## 5. Methodology Notes

Each agent was assigned a specific security domain and independently reviewed all source files within the `apps/bond-api/` directory. Agents had read access to the full monorepo for cross-referencing shared libraries and configuration. Findings were deduplicated based on root cause; where two agents reported the same underlying issue from different angles, the reports were merged under a single finding ID.

Severity ratings follow a modified CVSS v3.1 qualitative scale:
- **Critical:** Exploitable remotely by any authenticated user, leads to data loss, unauthorized data access across security boundaries, or full system compromise.
- **High:** Exploitable remotely with authentication, leads to unauthorized access within a reduced scope, or enables denial of service affecting multiple users.
- **Medium:** Requires specific conditions to exploit, leads to information disclosure or limited unauthorized access.
- **Low:** Minor issues that increase attack surface or deviate from security best practices.
- **Informational:** Defense-in-depth recommendations that do not represent an active vulnerability.

---

## 6. Appendix: Agent Coverage Map

| Agent | Primary Files Analyzed | Findings |
|-------|----------------------|----------|
| Auth & Session | `plugins/auth.ts`, `middleware/authorize.ts` | BOND-006 |
| Input Validation | All route files, Zod schemas | BOND-004, BOND-008 |
| Authorization (RBAC) | `middleware/authorize.ts`, all routes | BOND-002, BOND-006 |
| Data Exposure & XSS | `contact.service.ts`, `deal.service.ts` | BOND-001 |
| Rate Limiting & DoS | All route files | BOND-007 |
| Business Logic | `pipeline.service.ts`, `deal.service.ts` | BOND-003, BOND-005 |
| SQL Injection | All service files | (None -- Drizzle ORM parameterizes all queries) |
| Dependencies & Config | `server.ts`, `env.ts` | (None) |
| API Design | All route files | BOND-004 |
| Data Integrity | `contact.service.ts`, `deal.service.ts` | BOND-001, BOND-002 |
