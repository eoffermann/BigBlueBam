# Bolt Security Audit

**Date:** 2026-04-07
**Auditor:** Claude (automated)
**Scope:** apps/bolt-api/src/, apps/mcp-server/src/tools/bolt-tools.ts
**Status:** Complete

## Summary
- P0 (Critical): 0 findings
- P1 (High): 5 findings (4 fixed, 1 mitigated)
- P2 (Medium): 4 findings
- P3 (Low): 3 findings

---

## P1 -- High

### P1-001: MCP `bolt_test` Sends Wrong Field Name (Schema Mismatch)
**File:** `apps/mcp-server/src/tools/bolt-tools.ts:175`
**Impact:** The `bolt_test` MCP tool always fails with a validation error. It sends `{ event_payload: ... }` but the Bolt API's `testAutomationSchema` expects `{ event: ... }`. Every invocation of this tool by an AI agent will return an error.
**Fix:** Changed `event_payload` to `event` in both the Zod schema and the handler.
**Status:** Fixed

### P1-002: MCP `trigger_source` Enum Includes Non-Existent `webhook` Value
**File:** `apps/mcp-server/src/tools/bolt-tools.ts:66,96,118` (multiple tools)
**Impact:** If an AI agent creates or filters automations with `trigger_source: 'webhook'`, the Bolt API will reject the request with a Zod validation error (the API enum is `['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule']`). For `bolt_create` and `bolt_update`, the postgres `bolt_trigger_source` enum would also reject it at the DB level.
**Fix:** Removed `'webhook'` from all `trigger_source` enums in bolt-tools.ts.
**Status:** Fixed

### P1-003: MCP `bolt_executions` Status Enum Mismatches API
**File:** `apps/mcp-server/src/tools/bolt-tools.ts:189`
**Impact:** The MCP tool allows filtering by `'pending'` and `'failure'` statuses, but the Bolt API uses `'running'` and `'failed'`. Filtering by the wrong status values returns empty results, misleading the AI agent into thinking there are no executions.
**Fix:** Changed enum from `['pending', 'running', 'success', 'failure', 'skipped']` to `['running', 'success', 'partial', 'failed', 'skipped']`.
**Status:** Fixed

### P1-004: ReDoS via `matches_regex` Condition Operator
**File:** `apps/bolt-api/src/services/condition-engine.ts:118-125`
**Impact:** The `matches_regex` operator constructs a `new RegExp()` from user-supplied input with no length or complexity limits. A malicious user could craft a regex pattern causing catastrophic backtracking (e.g., `(a+)+$` against a long input), blocking the Node.js event loop for seconds or minutes. This is exploitable via the automation test endpoint or when an automation fires.
**Description:** Any authenticated user who can create automations can supply a regex condition pattern. When the automation is tested or triggered, the regex is evaluated synchronously with no timeout.
**Fix:** Added a 500-character limit on regex patterns in the condition engine. Patterns exceeding this length return `false` immediately. A more robust fix would involve running regex evaluation in a worker thread with a timeout, or using a safe-regex library.
**Status:** Mitigated (length limit applied; full timeout-based fix recommended)

### P1-005: Prototype Traversal in Field Path Resolution
**File:** `apps/bolt-api/src/services/template-resolver.ts:25-34`, `apps/bolt-api/src/services/condition-engine.ts:40-49`
**Impact:** An attacker who can create automations with template variables like `{{ event.__proto__.constructor }}` or conditions with field paths like `__proto__.constructor` could leak internal JavaScript object properties. While this does not enable arbitrary code execution, it exposes runtime internals (e.g., `function Object() { [native code] }`) that could aid further exploitation.
**Description:** Both `resolveFieldPath()` (template resolver) and `resolveField()` (condition engine) traverse object properties using dot-separated paths without blocking access to `__proto__`, `constructor`, or `prototype`. These paths resolve through JavaScript's prototype chain rather than the intended data payload.
**Fix:** Added a `BLOCKED_KEYS` set containing `__proto__`, `constructor`, and `prototype`. Both functions now return `undefined` when any path segment matches a blocked key.
**Status:** Fixed

---

## P2 -- Medium

### P2-001: No CSRF Protection on Cookie-Authenticated Requests
**File:** `apps/bolt-api/src/server.ts:62-69`
**Impact:** CSRF attacks on session-authenticated users. The API uses cookie-based session auth with `credentials: true` CORS, but there is no CSRF token validation. A malicious site could trigger state-changing POST/PUT/DELETE requests carrying the session cookie.
**Description:** Same pattern as the Brief API (see brief-security-audit.md P2-001). The Bolt API accepts cookies from the main BBB auth system but does not validate a CSRF token or require a custom header.
**Fix:** Implement one of: (1) CSRF token middleware, (2) SameSite=Strict/Lax cookie attribute, (3) require a custom header like `X-Requested-With` on mutation routes.
**Status:** Open

### P2-002: `trigger_filter` and `parameters` Accept Unbounded JSONB
**File:** `apps/bolt-api/src/routes/automation.routes.ts:44,33`
**Impact:** Denial of service / storage exhaustion. The `trigger_filter: z.record(z.unknown())` and `parameters: z.record(z.unknown())` Zod schemas accept arbitrarily deep/large JSON objects. An attacker could send multi-MB JSON payloads that are stored directly in PostgreSQL JSONB columns.
**Description:** While the overall Fastify body parser has a default size limit (~1MB), the individual JSONB fields have no application-level size constraint. A user could pack most of that budget into a single `trigger_filter` field.
**Fix:** Add a custom Zod refinement limiting the serialized JSON size, e.g., `.refine(v => JSON.stringify(v).length <= 100_000, 'Filter too large')`.
**Status:** Open

### P2-003: `COOKIE_SECURE` Defaults to `false`
**File:** `apps/bolt-api/src/env.ts:25`
**Impact:** In production environments behind HTTPS, cookies may still be transmitted over HTTP if this default is not overridden.
**Description:** Same pattern as the Brief API. The default should be `true` in production.
**Fix:** Default `COOKIE_SECURE` to `true` when `NODE_ENV=production`.
**Status:** Open

### P2-004: MCP `bolt_create` Conditions/Actions Schema Too Loose
**File:** `apps/mcp-server/src/tools/bolt-tools.ts:99-100`
**Impact:** The MCP tool defines conditions as `z.array(z.record(z.unknown()))` -- an array of arbitrary objects. The Bolt API will reject these if they lack required fields (`sort_order`, `field`, `operator`), but the MCP schema gives the AI agent no guidance on the required structure, leading to frequent validation failures.
**Description:** Unlike `bolt_list` which has properly typed params, the `bolt_create` tool uses untyped condition and action schemas. This forces the AI agent to guess the structure or rely on the error message.
**Fix:** Replace `z.record(z.unknown())` with properly typed schemas matching the API's `conditionSchema` and `actionSchema`.
**Status:** Open

---

## P3 -- Low

### P3-001: Missing Audit Logging for Automation Mutations
**File:** `apps/bolt-api/src/services/automation.service.ts` (all mutations)
**Impact:** Reduced forensic capability. Automation creation, updates, enable/disable, duplication, and deletion have no audit trail.
**Description:** There is no activity log integration. Operations like enabling/disabling automations, changing triggers, or deleting automations are not logged anywhere an admin can review.
**Fix:** Add audit logging for all automation CRUD operations, ideally to the shared activity log.
**Status:** Open

### P3-002: No Content-Type Validation on Request Bodies
**File:** `apps/bolt-api/src/server.ts` (global)
**Impact:** Defense in depth gap. The server does not reject POST/PUT/PATCH requests with incorrect Content-Type headers.
**Description:** Fastify parses JSON by default but does not reject requests with non-JSON content types on mutation routes.
**Fix:** Add a `preValidation` hook rejecting non-JSON content types on mutation routes.
**Status:** Open

### P3-003: Health Endpoints Expose Infrastructure Details
**File:** `apps/bolt-api/src/server.ts:90-121`
**Impact:** Information disclosure. The `/health/ready` endpoint returns individual service status for `database` and `redis`, revealing infrastructure component names and their availability. While health endpoints are typically internal, if exposed publicly this provides reconnaissance value.
**Description:** The health check returns `{ checks: { database: 'ok', redis: 'ok' } }` which confirms the existence and status of specific infrastructure components.
**Fix:** Ensure health endpoints are not exposed externally via nginx, or return only an aggregate status.
**Status:** Open

---

## Positive Findings

The following security patterns are correctly implemented:

1. **Org isolation on all CRUD:** Every automation query includes `org_id` in the WHERE clause. The `requireAutomationAccess()` and `requireAutomationEditAccess()` middleware verify org ownership before allowing access.

2. **ILIKE injection prevention:** The `escapeLike()` function correctly escapes `%`, `_`, and `\` before using user input in ILIKE queries.

3. **SQL injection prevention:** All queries use Drizzle ORM parameterized queries or tagged template literals (`sql\`...\``). No raw string concatenation into SQL.

4. **Input size limits:** The route Zod schemas enforce `.max()` limits on names (255), descriptions (5000), search (500), trigger events (60), mcp tool names (100), conditions (50 items), and actions (50 items).

5. **Rate limiting:** Creation endpoints (`POST /automations`, `POST /automations/:id/duplicate`, `POST /automations/:id/test`) have per-route rate limits (10-20 req/min). Global rate limiting is also applied.

6. **Security headers:** The server sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Cache-Control: no-store` on all responses.

7. **Error message sanitization:** The error handler only exposes messages from known `BoltError` and `ExecutionError` classes. 5xx errors always return `'Internal server error'`.

8. **Auth middleware chain:** All mutation endpoints require `requireAuth` + `requireScope('read_write')`. Edit operations additionally require `requireAutomationEditAccess()` which checks creator ownership or admin/owner org role.

9. **Template variable resolution:** The `resolveTemplateString` function uses regex-based replacement, NOT `eval()` or `Function` constructor. Unknown variable patterns are returned as-is rather than throwing.

10. **Cross-org execution isolation:** The `getExecution` service verifies org ownership by joining through the parent automation's `org_id`.

11. **UUID validation:** The `requireAutomationAccess()` and `requireAutomationEditAccess()` middleware validate `:id` params against a UUID regex before querying the database, preventing invalid UUID injection.
