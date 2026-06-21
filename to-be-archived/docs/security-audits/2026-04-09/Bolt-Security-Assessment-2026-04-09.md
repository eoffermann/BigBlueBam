# BigBlueBam -- Bolt Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Bolt API (`apps/bolt-api/`) and Bolt Frontend (`apps/bolt/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, SSRF & Network, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config, Automation Logic |
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
   - [Informational](#45-informational)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Bolt (Workflow Automation) API and Frontend source code. After deduplication, **21 unique findings** were identified across the codebase, plus several informational observations.

The most severe issues center on **unconstrained automation execution**. The `execute_action` MCP integration does not maintain an allowlist of permitted tool names, meaning any authenticated organization member can craft an automation rule that invokes arbitrary MCP tools -- including destructive operations like deleting projects, removing members, or exfiltrating data via cross-product actions. Compounding this, cross-product action parameters (e.g., targeting a Bam project, Banter channel, or Beacon entry) are not scoped to the automation owner's organization, enabling cross-tenant data manipulation through automation chains.

A secondary concern is the **absence of input validation on action parameters**, which are typed as `z.record(z.unknown())`. This open schema permits prototype pollution payloads, oversized objects, and type-confused values to flow through the execution pipeline unchecked. The `send_webhook` action accepts arbitrary URLs without SSRF protections, and automation chains have no loop or recursion detection, enabling infinite execution cascades that could exhaust system resources.

The overall security posture requires **immediate lockdown of the MCP tool interface and action parameter validation** before any production deployment with multi-tenant automation workflows.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 2     |
| **High**          | 3     |
| **Medium**        | 7     |
| **Low**           | 9     |
| **Informational** | 4     |
| **Total**         | **25** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BOLT-001 | No allowlist on MCP tool names -- arbitrary tool execution | 1-2 days |
| 2 | BOLT-002 | No org scoping on cross-product action parameters | 1-2 days |
| 3 | BOLT-003 | No validation of action parameters (z.record(z.unknown())) | 1 day |
| 4 | BOLT-004 | send_webhook action enables SSRF | 0.5 day |
| 5 | BOLT-005 | No loop/recursion detection for automation chains | 1 day |

**Estimated total for top-5 remediation: 4.5-6.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BOLT-001: No Allowlist on MCP Tool Names -- Arbitrary Tool Execution

| Field | Value |
|-------|-------|
| **ID** | BOLT-001 |
| **Severity** | Critical |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts`, `apps/bolt-api/src/services/automation.service.ts` |

**Description:**
The automation execution engine dispatches MCP tool calls based on the `tool_name` field stored in the automation action configuration. There is no allowlist restricting which MCP tools can be invoked by automations. Any organization member who can create an automation rule can specify any of the 238+ registered MCP tools as an action target, including destructive tools such as `delete_project`, `remove_member`, `complete_sprint`, or cross-product tools that operate on Banter, Beacon, Brief, Bond, and other modules.

The MCP server's two-step confirmation flow (designed to gate destructive actions) is bypassed because the automation executor calls tools programmatically without presenting confirmation prompts.

**Attack Scenario:**
1. Attacker with `member` role creates an automation: "When any task is created, execute MCP tool `delete_project` with parameters `{project_id: '<target>'}`."
2. A legitimate user creates a task, triggering the automation.
3. The execution engine calls the MCP tool without confirmation, deleting the target project and all its data.
4. The attacker can also invoke `export_project` to exfiltrate data, or `create_api_key` to establish persistent access.

**Recommended Fix:**
1. Maintain an explicit allowlist of MCP tools permitted for automation actions (e.g., `create_task`, `update_task`, `send_notification`, `add_comment`).
2. Reject any automation rule at creation time if its action references a tool not on the allowlist.
3. Enforce the allowlist again at execution time as a defense-in-depth measure.
4. Log and alert on any attempted invocation of a non-allowlisted tool.

---

#### BOLT-002: No Org Scoping on Cross-Product Action Parameters

| Field | Value |
|-------|-------|
| **ID** | BOLT-002 |
| **Severity** | Critical |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts`, `apps/bolt-api/src/routes/automation.routes.ts` |

**Description:**
When an automation action targets a cross-product resource (e.g., creating a Beacon entry, posting to a Banter channel, updating a Bond deal), the target resource identifiers (project IDs, channel IDs, beacon IDs, etc.) are taken directly from the action parameters without verifying they belong to the same organization as the automation owner. This allows a malicious user to create automations that manipulate resources in other organizations.

The execution engine inherits the session context of the automation creator but does not re-validate org boundaries when resolving cross-product references.

**Attack Scenario:**
1. Attacker in Organization A discovers a Banter channel ID from Organization B (via enumeration or leaked URL).
2. Attacker creates an automation: "When a task moves to Done, post a message to Banter channel `<org_b_channel_id>`."
3. Every time a task completes in the attacker's project, a message is injected into Organization B's Banter channel.
4. The attacker can similarly target Beacon entries, Brief documents, or Bond deals in foreign organizations.

**Recommended Fix:**
1. Before persisting an automation rule, resolve all cross-product resource IDs and verify they belong to the automation creator's organization.
2. At execution time, re-validate org ownership of all target resource IDs before dispatching the action.
3. Add an `org_id` column to the `bolt_automations` table (if not already present) and enforce it in all queries.

---

### 4.2 High

---

#### BOLT-003: No Validation of Action Parameters (z.record(z.unknown()))

| Field | Value |
|-------|-------|
| **ID** | BOLT-003 |
| **Severity** | High |
| **Affected Files** | `apps/bolt-api/src/routes/automation.routes.ts`, `apps/bolt-api/src/db/schema/bolt-actions.ts` |

**Description:**
The `params` field on automation actions is validated with `z.record(z.unknown())`, which accepts any JSON object with arbitrary keys and values. This allows attackers to inject oversized payloads, nested objects designed to trigger prototype pollution in downstream consumers, or type-confused values that cause unexpected behavior in the execution engine. The params object flows through `condition-engine.ts`, `execution.service.ts`, and ultimately to MCP tool invocations or webhook payloads without further schema validation.

**Attack Scenario:**
1. Attacker creates an automation with `params: {"__proto__": {"isAdmin": true}, "constructor": {"prototype": {"role": "admin"}}}`.
2. If any downstream code uses `Object.assign` or spread operators to merge params, prototype pollution can elevate privileges.
3. Alternatively, attacker submits a params object with deeply nested structures or multi-megabyte string values to cause OOM or CPU exhaustion during JSON serialization.

**Recommended Fix:**
1. Define per-action-type Zod schemas that validate the exact shape and types of permitted parameters (e.g., `send_webhook` params must have `{url: z.string().url(), method: z.enum([...]), body: z.string().max(...)}`).
2. Apply `z.strictObject()` to reject unexpected keys.
3. Add a maximum serialized size check (e.g., 64 KB) on the params JSON before storage.
4. Use `Object.create(null)` or `structuredClone()` when handling params to prevent prototype pollution.

---

#### BOLT-004: send_webhook Action Enables SSRF

| Field | Value |
|-------|-------|
| **ID** | BOLT-004 |
| **Severity** | High |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts` |

**Description:**
The `send_webhook` action type accepts a `url` parameter and makes an outbound HTTP request to it during automation execution. There is no URL validation beyond basic format checking -- internal network addresses (RFC 1918, link-local, localhost, cloud metadata endpoints) are not blocked. An attacker can craft automations that probe internal infrastructure, access cloud metadata services (e.g., `http://169.254.169.254/latest/meta-data/`), or interact with internal services not intended to be publicly accessible.

**Attack Scenario:**
1. Attacker creates an automation with action `send_webhook` and URL `http://169.254.169.254/latest/meta-data/iam/security-credentials/`.
2. The execution engine makes the request from the server's network context.
3. Cloud provider returns IAM credentials, which are logged in the execution step output.
4. Attacker reads the execution log to obtain cloud credentials.
5. Alternatively, attacker targets internal services: `http://redis:6379/`, `http://postgres:5432/`, `http://mcp-server:3001/`.

**Recommended Fix:**
1. Implement a URL allowlist/denylist that blocks all RFC 1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), localhost (`127.0.0.0/8`), and IPv6 equivalents.
2. Resolve DNS before making the request and validate the resolved IP against the denylist (to prevent DNS rebinding).
3. Enforce HTTPS-only for webhook URLs in production.
4. Set a short timeout (5s) and disable redirects or re-validate each redirect target.

---

#### BOLT-005: No Loop/Recursion Detection for Automation Chains

| Field | Value |
|-------|-------|
| **ID** | BOLT-005 |
| **Severity** | High |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts`, `apps/bolt-api/src/services/event-catalog.ts` |

**Description:**
When an automation action produces a side effect that itself triggers another automation (e.g., Action A creates a task, which triggers Automation B, whose action updates a task, which triggers Automation A again), there is no cycle detection or recursion depth limit. This enables infinite execution loops that consume unbounded CPU, memory, and database writes until the process crashes or the database runs out of disk space.

**Attack Scenario:**
1. Attacker creates Automation A: "When task status changes to `in_progress`, set task status to `done`."
2. Attacker creates Automation B: "When task status changes to `done`, set task status to `in_progress`."
3. A legitimate user moves a task to `in_progress`.
4. Automation A fires and sets it to `done`. Automation B fires and sets it to `in_progress`. This repeats indefinitely.
5. The execution table grows unboundedly, the API becomes unresponsive, and the database is flooded with writes.

**Recommended Fix:**
1. Add a `chain_depth` counter to the execution context, incremented each time an automation triggers another automation.
2. Enforce a maximum chain depth (e.g., 5) and abort execution with an error when exceeded.
3. Maintain a set of `(automation_id, trigger_event_id)` pairs within a chain to detect direct cycles.
4. Log and alert when chain depth limits are hit, as this may indicate misconfiguration or abuse.

---

### 4.3 Medium

---

#### BOLT-006: No Project-Level Authorization on Automation CRUD

| Field | Value |
|-------|-------|
| **ID** | BOLT-006 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/routes/automation.routes.ts` |

**Description:**
Automation CRUD endpoints verify organization membership but do not check project-level roles. Any organization member can create, read, update, and delete automations that target any project within the organization, regardless of whether they have access to that project. This violates the principle of least privilege, as a user with access only to Project A can create automations that affect Project B.

**Recommended Fix:**
When an automation rule references a specific project (via trigger filters or action targets), verify the requesting user holds at least `member` role on that project. For organization-wide automations, require `admin` or `owner` org role.

---

#### BOLT-007: ReDoS via matches_regex Condition Operator

| Field | Value |
|-------|-------|
| **ID** | BOLT-007 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/services/condition-engine.ts` |

**Description:**
The condition engine supports a `matches_regex` operator that compiles a user-supplied regular expression pattern and tests it against event data. There is no validation of the regex pattern's complexity. An attacker can supply a catastrophic backtracking pattern (e.g., `(a+)+$`) that causes the regex engine to hang for minutes or hours on certain inputs, blocking the event loop and preventing all other automation processing.

**Attack Scenario:**
1. Attacker creates an automation with condition: `field "title" matches_regex "(a+)+$"`.
2. A legitimate user creates a task with title `"aaaaaaaaaaaaaaaaaaaaaaaaaaa!"`.
3. The condition engine attempts to evaluate the regex, which enters catastrophic backtracking.
4. The Node.js event loop is blocked for the duration, causing all API requests to time out.

**Recommended Fix:**
1. Use a safe regex library (e.g., `re2` via the `re2` npm package) that guarantees linear-time evaluation.
2. Alternatively, set a timeout on regex evaluation using `vm.runInNewContext` with a timeout option.
3. Validate regex patterns at automation creation time for known catastrophic patterns.
4. Consider limiting the regex feature to admin-only or removing it in favor of simpler string matching operators.

---

#### BOLT-008: Execution Steps Expose Sensitive Data to Viewers

| Field | Value |
|-------|-------|
| **ID** | BOLT-008 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/routes/execution.routes.ts` |

**Description:**
Execution step records include the full `input` and `output` payloads of each action, including webhook response bodies, MCP tool responses, and resolved action parameters. These records are readable by any organization member who can view automations. If a webhook action returns sensitive data (API keys, tokens, PII), or if MCP tool responses contain privileged information, this data is persisted and exposed through the execution detail endpoint.

**Recommended Fix:**
1. Truncate or redact `input` and `output` fields in execution steps before storage (e.g., mask values matching known secret patterns).
2. Restrict execution step detail access to the automation owner and org admins.
3. Add a configurable retention period for execution step data with automatic purging.

---

#### BOLT-009: Missing Rate Limits on Retry and Write Endpoints

| Field | Value |
|-------|-------|
| **ID** | BOLT-009 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/routes/execution.routes.ts`, `apps/bolt-api/src/routes/automation.routes.ts` |

**Description:**
The execution retry endpoint and automation creation/update endpoints do not enforce per-user or per-org rate limits. An attacker can trigger rapid retries of failed executions or create hundreds of automations per second, overwhelming the execution engine and downstream services.

**Recommended Fix:**
Apply per-user rate limits (e.g., 10 retries/minute, 30 automation creates/hour) using the existing Redis-backed rate limiter. Add a global execution queue depth limit that pauses new executions when the backlog exceeds a threshold.

---

#### BOLT-010: max_executions_per_hour Not Enforced at Runtime

| Field | Value |
|-------|-------|
| **ID** | BOLT-010 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts`, `apps/bolt-api/src/db/schema/bolt-automations.ts` |

**Description:**
The `bolt_automations` table includes a `max_executions_per_hour` column, and the automation creation schema accepts this value. However, the execution engine does not check the current execution count against this limit before processing a new execution. The limit is purely cosmetic -- any automation will execute without throttling regardless of the configured cap.

**Recommended Fix:**
Before starting a new execution, query the count of executions for that automation in the past hour. If the count meets or exceeds `max_executions_per_hour`, skip the execution and log a throttle event. Use a Redis counter with TTL for efficient checking without per-execution DB queries.

---

#### BOLT-011: COOKIE_SECURE Defaults to False

| Field | Value |
|-------|-------|
| **ID** | BOLT-011 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/env.ts`, `apps/bolt-api/src/plugins/session.ts` (if present) |

**Description:**
The `COOKIE_SECURE` environment variable defaults to `false`. If the application is deployed behind HTTPS without explicitly setting this variable, session cookies will be transmitted over unencrypted connections, exposing them to network-level interception.

**Recommended Fix:**
Default `COOKIE_SECURE` to `true` and require an explicit opt-out for development. Log a warning at startup when running with `COOKIE_SECURE=false`.

---

#### BOLT-012: Raw Cookie Forwarded to Internal MCP Service

| Field | Value |
|-------|-------|
| **ID** | BOLT-012 |
| **Severity** | Medium |
| **Affected Files** | `apps/bolt-api/src/services/execution.service.ts` |

**Description:**
When the execution engine invokes MCP tools on behalf of an automation, it forwards the original session cookie from the automation creator's stored context to the internal MCP server. This grants the MCP server the full session context of the automation creator, which may include elevated permissions not intended for automated actions. If the MCP server has vulnerabilities, the forwarded cookie could be logged, leaked, or replayed.

**Recommended Fix:**
Use a dedicated service-to-service authentication mechanism (e.g., a shared HMAC secret or internal JWT) for MCP tool invocations from the execution engine. Include only the minimum required identity claims (user ID, org ID, automation ID) rather than forwarding the full session cookie.

---

### 4.4 Low

---

#### BOLT-013: API Key Timing Oracle

| Field | Value |
|-------|-------|
| **ID** | BOLT-013 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/middleware/authorize.ts` |

**Description:**
API key authentication performs a database lookup by key prefix, then verifies the key hash with Argon2. If no matching prefix is found, the endpoint returns immediately. If a prefix matches but the hash fails, the response is delayed by the Argon2 computation time. This timing difference allows an attacker to enumerate valid key prefixes.

**Recommended Fix:**
When no matching prefix is found, perform a dummy Argon2 verification against a fixed hash to normalize response times. Alternatively, always return 401 after a constant-time delay regardless of the failure reason.

---

#### BOLT-014: Expiry Check After Argon2 Verification

| Field | Value |
|-------|-------|
| **ID** | BOLT-014 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/middleware/authorize.ts` |

**Description:**
API key expiry is checked after the Argon2 hash verification succeeds. This means expired keys still consume Argon2 computation resources, and the timing difference between "expired" and "invalid hash" responses provides a side channel confirming that an expired key was once valid.

**Recommended Fix:**
Check expiry before performing the Argon2 hash comparison. Return the same error code for expired and invalid keys.

---

#### BOLT-015: Viewers Can Read All Automations

| Field | Value |
|-------|-------|
| **ID** | BOLT-015 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/automation.routes.ts` |

**Description:**
The `GET /automations` and `GET /automations/:id` endpoints require only `requireAuth` (organization membership). Users with viewer-level access can see the full configuration of all automations, including action parameters that may contain sensitive values (webhook URLs, API tokens embedded in params, internal resource IDs).

**Recommended Fix:**
Restrict automation detail access to users with `member` or `admin` project roles. Provide viewers with a summary view that omits action parameters and sensitive configuration.

---

#### BOLT-016: Unbounded listOrgExecutions Query

| Field | Value |
|-------|-------|
| **ID** | BOLT-016 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/execution.routes.ts` |

**Description:**
The `GET /executions` endpoint lists all executions for an organization. While cursor-based pagination is implemented, there is no maximum page size enforcement. A client can request `?limit=100000` and receive a massive result set, causing high memory usage and slow database queries.

**Recommended Fix:**
Clamp the `limit` parameter to a maximum value (e.g., 100) server-side, regardless of the client request.

---

#### BOLT-017: Cursor Value Not Validated

| Field | Value |
|-------|-------|
| **ID** | BOLT-017 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/execution.routes.ts` |

**Description:**
The pagination cursor is accepted as a raw string and used directly in a SQL `WHERE` clause comparison. While parameterized queries prevent SQL injection, a malformed cursor (e.g., non-ISO date string or non-UUID) could cause unexpected query behavior or database errors that leak schema information.

**Recommended Fix:**
Validate the cursor as a UUID or ISO 8601 timestamp (matching the cursor format) before using it in queries. Return a 400 error for invalid cursors.

---

#### BOLT-018: Status Filter Not Validated

| Field | Value |
|-------|-------|
| **ID** | BOLT-018 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/execution.routes.ts` |

**Description:**
The `?status=` filter parameter on execution list endpoints is not validated against the known set of execution statuses. While this does not cause a security vulnerability (parameterized queries prevent injection), invalid status values silently return empty results, which can confuse API consumers and mask bugs.

**Recommended Fix:**
Validate the status filter against a Zod enum of valid execution statuses (`pending`, `running`, `completed`, `failed`, `cancelled`). Return a 400 error for unrecognized values.

---

#### BOLT-019: trigger_source Field Not Validated

| Field | Value |
|-------|-------|
| **ID** | BOLT-019 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/event.routes.ts` |

**Description:**
The `trigger_source` field on incoming events is accepted as a free-form string. This field is stored in the database and displayed in execution logs. A malicious value could be used for log injection or to mislead auditors about the origin of an automation trigger.

**Recommended Fix:**
Validate `trigger_source` against a known enum of event sources (e.g., `bam`, `banter`, `beacon`, `brief`, `bond`, `manual`, `schedule`).

---

#### BOLT-020: Full Database Rows Returned in API Responses

| Field | Value |
|-------|-------|
| **ID** | BOLT-020 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/routes/automation.routes.ts`, `apps/bolt-api/src/routes/execution.routes.ts` |

**Description:**
API responses return the full database row objects (via `SELECT *` semantics in Drizzle), including internal fields such as `created_at`, `updated_at`, and potentially internal IDs that are not needed by the frontend. This increases response payload size and exposes internal schema details.

**Recommended Fix:**
Define explicit response schemas that select only the fields needed by the frontend. Use Drizzle's column selection to query only required fields.

---

#### BOLT-021: No Database SSL Enforcement

| Field | Value |
|-------|-------|
| **ID** | BOLT-021 |
| **Severity** | Low |
| **Affected Files** | `apps/bolt-api/src/db/index.ts` (or connection configuration) |

**Description:**
The database connection string does not enforce SSL/TLS. In a deployment where the database is on a separate network segment, unencrypted connections could expose query data and credentials to network-level attackers.

**Recommended Fix:**
Set `ssl: { rejectUnauthorized: true }` in the database connection configuration for production environments. Provide the CA certificate path via environment variable.

---

### 4.5 Informational

---

#### BOLT-INFO-001: Organization Isolation -- PASS

| Field | Value |
|-------|-------|
| **ID** | BOLT-INFO-001 |
| **Severity** | Informational |

**Description:**
All automation and execution queries include an `org_id` filter derived from the authenticated user's session. Cross-org data access via direct ID manipulation is prevented at the query level. However, this does not extend to cross-product resource references within action parameters (see BOLT-002).

---

#### BOLT-INFO-002: Prototype Pollution Protection -- PASS

| Field | Value |
|-------|-------|
| **ID** | BOLT-INFO-002 |
| **Severity** | Informational |

**Description:**
Fastify's default JSON parser rejects `__proto__` keys in request bodies. This mitigates direct prototype pollution via HTTP requests. However, action parameters stored in the database and loaded later may bypass this protection (see BOLT-003).

---

#### BOLT-INFO-003: Templates Properly Scoped

| Field | Value |
|-------|-------|
| **ID** | BOLT-INFO-003 |
| **Severity** | Informational |

**Description:**
Automation templates (`apps/bolt-api/src/routes/template.routes.ts`, `apps/bolt-api/src/services/template.service.ts`) are scoped to the organization. Template listing and resolution correctly filter by `org_id`, preventing cross-org template access.

---

#### BOLT-INFO-004: Event Ingestion Not Fully Implemented

| Field | Value |
|-------|-------|
| **ID** | BOLT-INFO-004 |
| **Severity** | Informational |

**Description:**
The event ingestion endpoint (`apps/bolt-api/src/routes/event.routes.ts`) accepts events from other BigBlueBam modules but does not yet implement full event validation or signature verification. When cross-service event ingestion is enabled, events should be signed with a shared HMAC secret to prevent spoofing.

---

## 5. Methodology Notes

- **Scope limitation:** This assessment covers only the Bolt API (`apps/bolt-api/`) and Bolt Frontend (`apps/bolt/`). Other modules (Bam, Banter, Beacon, Brief, Bearing, Board, Bond, Blast, Bench, Helpdesk, MCP Server, Worker) were not assessed in this document.
- **Static analysis only:** All findings are based on source code review. No dynamic testing (penetration testing, fuzzing) was performed.
- **Deduplication:** Where multiple agents reported the same underlying issue, findings were merged into a single entry with the highest severity assessment retained.
- **False positive rate:** Static analysis may flag patterns that are mitigated by runtime conditions not visible in source (e.g., nginx rules, network policies). Each finding should be validated against the deployed architecture before prioritization.
- **CVSS scores:** Not assigned. Severity ratings are qualitative (Critical/High/Medium/Low) based on exploitability, impact, and affected data sensitivity.

---

## 6. Appendix: Agent Coverage Map

| Agent | Focus Area | Findings Contributed |
|-------|-----------|---------------------|
| Agent 1 | Auth & Session | BOLT-013, BOLT-014 |
| Agent 2 | Input Validation | BOLT-003, BOLT-007, BOLT-017, BOLT-018, BOLT-019 |
| Agent 3 | Authorization (RBAC) | BOLT-002, BOLT-006, BOLT-015 |
| Agent 4 | Data Exposure & XSS | BOLT-008, BOLT-020 |
| Agent 5 | SSRF & Network | BOLT-004, BOLT-021 |
| Agent 6 | Rate Limiting & DoS | BOLT-009, BOLT-010, BOLT-016 |
| Agent 7 | Business Logic | BOLT-005 |
| Agent 8 | Automation Logic | BOLT-001, BOLT-012 |
| Agent 9 | Cryptography | (no unique findings -- covered by Auth agent) |
| Agent 10 | Dependencies & Config | BOLT-011, BOLT-INFO-001, BOLT-INFO-002, BOLT-INFO-003, BOLT-INFO-004 |

---

*End of assessment.*
