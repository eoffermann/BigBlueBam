# BigBlueBam -- Bench Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Bench API (`apps/bench-api/`) and Bench Frontend (`apps/bench/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Rate Limiting & DoS, Business Logic, SQL Injection, Dependencies & Config |
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

This assessment consolidates findings from specialized security audit agents that independently analyzed the BigBlueBam Bench (Analytics) API and Frontend source code. After deduplication, **7 unique findings** were identified across the codebase.

The most severe issue is a **critical SQL injection vulnerability** in the ad-hoc query execution endpoint. User-supplied `date_range.start` and `date_range.end` parameters are interpolated directly into raw SQL strings, and filter values receive only naive single-quote escaping that is trivially bypassable. This allows any authenticated user with access to the query endpoint to execute arbitrary SQL against the analytics database, including reading, modifying, or deleting data across all organizations.

A second class of high-severity issues includes SQL injection via materialized view names passed to `sql.raw()`, missing organization scoping on widget operations enabling IDOR attacks, and a query preview endpoint that returns results without org-scoped filtering -- allowing cross-organization data access.

Medium-severity findings include generated SQL being returned verbatim to the client (information disclosure) and the absence of explicit body size limits on query payloads. A low-severity finding notes the lack of pagination on the dashboard listing endpoint.

The overall security posture of the Bench module requires **immediate remediation of SQL injection vectors** before any production deployment. The ad-hoc query system must be redesigned to use parameterized queries exclusively.

---

## 2. Finding Counts by Severity

| Severity        | Count |
|-----------------|-------|
| **Critical**    | 1     |
| **High**        | 3     |
| **Medium**      | 2     |
| **Low**         | 1     |
| **Informational** | 0   |
| **Total**       | **7** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BENCH-001 | SQL injection via ad-hoc query execution | 2-3 days |
| 2 | BENCH-002 | SQL injection in materialized view refresh | 1 day |
| 3 | BENCH-003 | Widget operations missing org scoping (IDOR) | 1 day |
| 4 | BENCH-004 | Query preview missing org-scoped filtering | 0.5 day |
| 5 | BENCH-005 | Generated SQL returned to client | 0.5 day |

**Estimated total for top-5 remediation: 5-6 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BENCH-001: SQL Injection via Ad-Hoc Query Execution

| Field | Value |
|-------|-------|
| **ID** | BENCH-001 |
| **Severity** | Critical |
| **CVSS 3.1** | 9.8 (Critical) |
| **CWE** | CWE-89: Improper Neutralization of Special Elements used in an SQL Command |
| **Affected Files** | `apps/bench-api/src/routes/query.routes.ts` |

**Description:**
The ad-hoc query execution endpoint accepts a JSON body containing `date_range.start`, `date_range.end`, and `filters` parameters. The `date_range.start` and `date_range.end` values are interpolated directly into raw SQL strings using template literals without parameterization:

```typescript
const sql = `SELECT ... WHERE created_at >= '${dateRange.start}' AND created_at <= '${dateRange.end}'`;
```

Filter values receive only single-quote escaping (`value.replace(/'/g, "''")`) which is trivially bypassable through techniques such as backslash escaping, Unicode homoglyphs, or encoding tricks depending on the PostgreSQL configuration. This allows any authenticated user to inject arbitrary SQL, including `UNION SELECT` to exfiltrate data from other tables, `DROP TABLE` to destroy data, or `COPY ... TO` to write files.

**Attack Scenario:**
1. Attacker authenticates with any valid account that has access to the Bench query endpoint.
2. Attacker sends a POST request with `date_range.start` set to `2024-01-01' UNION SELECT username, password_hash, email, '', '' FROM users --`.
3. The injected SQL executes and returns user credentials from the `users` table alongside legitimate query results.
4. Attacker can escalate to reading any table including `sessions`, `api_keys`, or cross-org data.

**Recommended Fix:**
1. Replace all string interpolation in SQL construction with parameterized queries using Drizzle's `sql.placeholder()` or PostgreSQL's `$1, $2` parameter binding.
2. Validate `date_range.start` and `date_range.end` against a strict ISO 8601 date regex (`/^\d{4}-\d{2}-\d{2}$/`) via Zod schema before any processing.
3. For filter values, use parameterized queries exclusively -- never attempt manual escaping.
4. Consider implementing a query allowlist or AST-based query validator that restricts ad-hoc queries to SELECT statements on approved tables only.

---

### 4.2 High

---

#### BENCH-002: SQL Injection in Materialized View Refresh

| Field | Value |
|-------|-------|
| **ID** | BENCH-002 |
| **Severity** | High |
| **CVSS 3.1** | 8.1 (High) |
| **CWE** | CWE-89: Improper Neutralization of Special Elements used in an SQL Command |
| **Affected Files** | `apps/bench-api/src/routes/query.routes.ts` |

**Description:**
The materialized view refresh endpoint passes the view name directly into `sql.raw()` without validation or quoting:

```typescript
await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${viewName}`));
```

The `viewName` parameter originates from user input (either the request body or a database record that was user-created). If the view name is not strictly validated against an allowlist of existing materialized views, an attacker can inject arbitrary SQL by supplying a crafted view name such as `my_view; DROP TABLE users; --`.

**Attack Scenario:**
1. Attacker creates a widget or saved query with a materialized view name containing SQL injection payload.
2. When the refresh endpoint is triggered (either manually or by a scheduled job), the injected SQL executes with the database connection's full privileges.
3. Attacker achieves arbitrary SQL execution including data exfiltration or schema destruction.

**Recommended Fix:**
1. Validate view names against a strict regex (`/^[a-z_][a-z0-9_]*$/`) and maximum length.
2. Query `pg_matviews` to confirm the view exists before refreshing.
3. Use `sql.identifier()` or double-quote escaping via `pg_catalog.quote_ident()` to safely interpolate the view name.
4. Restrict the database user's permissions so it cannot execute DDL or DML outside of expected operations.

---

#### BENCH-003: Widget Operations Missing Organization Scoping (IDOR)

| Field | Value |
|-------|-------|
| **ID** | BENCH-003 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Files** | `apps/bench-api/src/routes/widget.routes.ts` |

**Description:**
Widget CRUD endpoints (GET, PATCH, DELETE on `/widgets/:id`) look up the widget by its primary key ID alone without verifying that the widget belongs to a dashboard owned by the authenticated user's organization. An authenticated user can supply the UUID of any widget from any organization and read its configuration (including the underlying query definition, data source references, and cached results), modify it, or delete it.

**Attack Scenario:**
1. Attacker authenticates with a valid account in Organization A.
2. Attacker enumerates or guesses widget UUIDs from Organization B.
3. Attacker calls `GET /widgets/{org_b_widget_id}` and receives the full widget configuration including query SQL, data source connection details, and cached result sets.
4. Attacker calls `DELETE /widgets/{org_b_widget_id}` to destroy another organization's analytics dashboards.

**Recommended Fix:**
Add an organization scoping check to all widget endpoints. Join through `widgets -> dashboards -> org_id` and verify `dashboard.org_id === request.user.org_id` before returning or mutating any widget. Consider adding a Drizzle helper that automatically injects the org scope into all widget queries.

---

#### BENCH-004: Query Preview Missing Organization-Scoped Filtering

| Field | Value |
|-------|-------|
| **ID** | BENCH-004 |
| **Severity** | High |
| **CVSS 3.1** | 7.5 (High) |
| **CWE** | CWE-862: Missing Authorization |
| **Affected Files** | `apps/bench-api/src/routes/query.routes.ts` |

**Description:**
The query preview endpoint executes user-defined queries against the analytics database but does not inject organization-scoped `WHERE` clauses. When the query references shared or cross-org tables, the results include data from all organizations. This enables cross-organization data access even without SQL injection -- a user can write a legitimate `SELECT` query that returns data belonging to other organizations.

**Attack Scenario:**
1. Attacker creates an ad-hoc query: `SELECT * FROM tasks WHERE priority = 'critical'`.
2. The query executes without an `org_id` filter and returns critical tasks from all organizations.
3. Attacker gains access to task titles, descriptions, assignees, and custom field data across the entire platform.

**Recommended Fix:**
1. Implement a query rewriter or middleware that injects `AND org_id = $1` into all user-submitted queries, using the authenticated user's org_id as the parameter.
2. Alternatively, execute all ad-hoc queries against org-scoped database views that filter by org_id using PostgreSQL RLS policies.
3. Restrict the set of tables accessible to ad-hoc queries via an allowlist.

---

### 4.3 Medium

---

#### BENCH-005: Generated SQL Returned to Client

| Field | Value |
|-------|-------|
| **ID** | BENCH-005 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-200: Exposure of Sensitive Information to an Unauthorized Actor |
| **Affected Files** | `apps/bench-api/src/routes/query.routes.ts` |

**Description:**
The query execution and preview endpoints return the generated SQL string in the API response body (e.g., `{ sql: "SELECT ...", results: [...] }`). This exposes the internal database schema, table names, column names, and query patterns to the client. An attacker can use this information to craft more targeted SQL injection payloads or understand the data model for further exploitation.

**Recommended Fix:**
Remove the `sql` field from production API responses. If SQL visibility is needed for debugging, gate it behind a `debug` query parameter that is only available in development mode or to platform administrators.

---

#### BENCH-006: No Explicit Body Size Limit on Query Payloads

| Field | Value |
|-------|-------|
| **ID** | BENCH-006 |
| **Severity** | Medium |
| **CVSS 3.1** | 5.3 (Medium) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/bench-api/src/routes/query.routes.ts` |

**Description:**
The query execution endpoint does not enforce an explicit body size limit beyond Fastify's default of 1 MiB. An attacker can submit extremely large query payloads containing deeply nested filter objects or very long SQL strings, consuming server memory and CPU during parsing and validation. Combined with the ad-hoc query execution capability, this could be used to execute resource-intensive queries that degrade database performance for all tenants.

**Recommended Fix:**
1. Set a conservative `bodyLimit` on the query routes (e.g., 64 KiB).
2. Add Zod schema validation with `z.string().max(4096)` on the query text field.
3. Implement query timeout limits at the PostgreSQL connection level (`statement_timeout`).
4. Add per-user rate limiting on query execution endpoints.

---

### 4.4 Low

---

#### BENCH-007: No Pagination on Dashboard Listing

| Field | Value |
|-------|-------|
| **ID** | BENCH-007 |
| **Severity** | Low |
| **CVSS 3.1** | 3.1 (Low) |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **Affected Files** | `apps/bench-api/src/routes/dashboard.routes.ts` |

**Description:**
The `GET /dashboards` endpoint returns all dashboards for the authenticated user's organization without pagination. In organizations with a large number of dashboards, this could return an unbounded result set, consuming excessive memory on both the server and client. While not directly exploitable as a security vulnerability, it represents a denial-of-service vector if an attacker programmatically creates a large number of dashboards.

**Recommended Fix:**
Implement cursor-based pagination consistent with the pattern used across other BigBlueBam modules. Default to 50 items per page with a maximum of 200.

---

## 5. Methodology Notes

Each audit agent independently analyzed the Bench module source code with a focus on its specialized domain. Agents had read access to the full `apps/bench-api/` and `apps/bench/` directories, as well as `packages/shared/` for schema definitions. Findings were deduplicated by root cause -- overlapping reports from multiple agents were consolidated into a single finding with the highest applicable severity.

SQL injection findings received particular scrutiny given the ad-hoc query execution nature of the Bench module. The audit verified that string interpolation (not parameterized queries) is used in multiple code paths for constructing SQL statements.

---

## 6. Appendix: Agent Coverage Map

| Agent | Files Reviewed | Findings Contributed |
|-------|---------------|---------------------|
| Input Validation | `routes/query.routes.ts`, `routes/widget.routes.ts` | BENCH-001, BENCH-006 |
| SQL Injection | `routes/query.routes.ts` | BENCH-001, BENCH-002 |
| Authorization (RBAC) | `routes/widget.routes.ts`, `routes/dashboard.routes.ts`, `routes/query.routes.ts` | BENCH-003, BENCH-004 |
| Data Exposure & XSS | `routes/query.routes.ts` | BENCH-005 |
| Rate Limiting & DoS | `routes/dashboard.routes.ts`, `routes/query.routes.ts` | BENCH-006, BENCH-007 |
| Auth & Session | All route files | (no unique findings) |
| Business Logic | `routes/query.routes.ts`, `routes/widget.routes.ts` | (corroborated BENCH-001, BENCH-003) |
| Dependencies & Config | `package.json`, `Dockerfile` | (no unique findings) |
