# BigBlueBam -- Board Module Security Assessment

| Field              | Value                                                                 |
|--------------------|-----------------------------------------------------------------------|
| **Date**           | 2026-04-09                                                            |
| **Scope**          | Board API (`apps/board-api/`) and Board Frontend (`apps/board/`)      |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)          |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, WebSocket, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config, Real-time Collaboration |
| **Classification** | INTERNAL -- CONFIDENTIAL                                              |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                          |

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

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Board API and Frontend source code. After deduplication, **29 unique findings** were identified across the codebase.

The most severe class of issues centers on **WebSocket authorization bypass** -- the `scene_update` message handler does not enforce write-permission checks after the initial `join_board` access check. A user who joins a board with view-only collaborator status can broadcast `scene_update` messages that overwrite the board's element state and are persisted to the database. A second critical issue is a **visibility enum mismatch** between the board creation schema (which accepts `'organization'`) and the `requireBoardAccess` middleware (which checks for `'org'`), causing organization-visibility boards to fall through to the default-deny path and break access control in unpredictable ways.

The high-severity findings cluster around **missing authorization checks** on the audio token endpoint (private boards don't verify creator/admin status, project-visibility boards skip project membership checks), collaborator management endpoints that lack board-level authorization, WebSocket authentication that reads a stale `users.org_id` column instead of resolving multi-org membership, unbounded `scene_update` payloads that enable denial of service, and chat endpoints that only require read access instead of edit permission.

The overall security posture requires **immediate remediation of WebSocket write-permission enforcement and the visibility enum mismatch** before any production deployment with shared or public boards.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 2     |
| **High**          | 6     |
| **Medium**        | 9     |
| **Low**           | 7     |
| **Informational** | 5     |
| **Total**         | **29** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BOARD-001 | WS `scene_update` has no write-permission check | 1 day |
| 2 | BOARD-002 | Visibility enum mismatch `'organization'` vs `'org'` breaks access control | 0.5 day |
| 3 | BOARD-003 | Private board audio token skips creator/admin check | 0.5 day |
| 4 | BOARD-007 | WS `scene_update` has no size limit (DoS) | 0.5 day |
| 5 | BOARD-005 | Collaborator PATCH/DELETE lack board-level authorization | 1 day |

**Estimated total for top-5 remediation: 3.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 Critical

---

#### BOARD-001: WebSocket `scene_update` Has No Write-Permission Check

| Field | Value |
|-------|-------|
| **ID** | BOARD-001 |
| **Severity** | Critical |
| **Affected Files** | `apps/board-api/src/ws/handler.ts` (lines 322-348) |

**Description:**
When a user sends a `join_board` message, the WebSocket handler calls `checkBoardAccess()` which verifies the user can *view* the board. However, once joined, the `scene_update` message handler (line 322) does not perform any additional permission check. It blindly accepts an `elements` array, marks the board as dirty for persistence, and broadcasts the update to all other connected users.

A user who has been added as a collaborator with `view` permission can send `scene_update` messages that overwrite the entire board's element state. The dirty board is then persisted to the `boards.yjs_state` column by the periodic persistence timer (line 102), making the overwrite permanent.

**Attack Scenario:**
1. Attacker is added to a board as a view-only collaborator.
2. Attacker connects to the WebSocket and sends `{"type":"join_board","boardId":"<board_id>"}`.
3. `checkBoardAccess()` returns `true` because the attacker is a collaborator (view-only still passes the collaborator check at line 186).
4. Attacker sends `{"type":"scene_update","elements":[]}` -- erasing all board elements.
5. The board state is persisted within 5 seconds, destroying the original content.

**Recommended Fix:**
After the `case 'scene_update'` match, query the `board_collaborators` table for the connected user's permission level. If the user is a `view`-only collaborator (not the creator, not an admin/owner), reject the update with an error frame. Additionally, check the board's `locked` status and reject edits from non-admin/non-owner users when the board is locked. Consider caching the permission level on the `ConnectedClient` object during `join_board` and refreshing it periodically.

---

#### BOARD-002: Visibility Enum Mismatch `'organization'` vs `'org'` Breaks HTTP Access Control

| Field | Value |
|-------|-------|
| **ID** | BOARD-002 |
| **Severity** | Critical |
| **Affected Files** | `apps/board-api/src/routes/board.routes.ts` (line 13), `apps/board-api/src/middleware/authorize.ts` (line 156) |

**Description:**
The `createBoardSchema` in `board.routes.ts` defines the visibility enum as `['private', 'project', 'organization']`. When a board is created with `visibility: 'organization'`, this literal string is stored in the database. However, the `requireBoardAccess()` middleware in `authorize.ts` checks:

```typescript
if (board.visibility === 'org') {
  // All org members can access
  (request as any).board = board;
  return;
}
```

The middleware compares against the string `'org'`, not `'organization'`. Boards created with `'organization'` visibility will not match any visibility branch in the middleware and will fall through to the default-deny block at line 237, returning a 404. This means:

1. Organization-visibility boards are inaccessible to all org members (except the creator and admins) via HTTP routes.
2. However, the WebSocket `checkBoardAccess()` function (in `ws/handler.ts` line 167) correctly checks `board.visibility === 'organization'`, creating an inconsistency where the same board is accessible via WebSocket but not via HTTP.

**Attack Scenario:**
This is primarily a functional bug that breaks access control in both directions:
- **Denial of access:** Legitimate org members cannot view organization-visibility boards through the REST API, breaking the intended sharing model.
- **Inconsistent enforcement:** The WebSocket path grants access while the HTTP path denies it, creating confusion about the actual security posture and making the board editable via WebSocket but not viewable via REST.

**Recommended Fix:**
Normalize the visibility enum. Either:
1. Change the Zod schema to use `'org'` instead of `'organization'` and add a migration to update existing rows.
2. Change the middleware check to `board.visibility === 'organization'` to match the schema.

Whichever direction is chosen, ensure the WebSocket `checkBoardAccess()`, the HTTP `requireBoardAccess()`, and the `requireBoardEditAccess()` middleware all use the same literal. Add a shared constant (e.g., `VISIBILITY_ORG = 'organization'`) imported by all three locations.

---

### 4.2 High

---

#### BOARD-003: Private Board Audio Token Skips Creator/Admin Check

| Field | Value |
|-------|-------|
| **ID** | BOARD-003 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/routes/audio.routes.ts` (lines 48-69) |

**Description:**
The audio token endpoint checks if a private board has a matching collaborator row, but it does not check whether the user is the board's creator or an org admin/owner. The board creator -- who always has full access to their own board -- is denied an audio token because they are not listed in the `board_collaborators` table (they are implicitly authorized by `created_by`).

Additionally, the check only looks at `board_collaborators` and does not account for org-level admins/owners who should have access to all boards within their organization.

**Attack Scenario:**
1. User creates a private board.
2. User clicks "Join Audio" on their own board.
3. The API returns HTTP 403 because the user is not in the collaborators table, despite being the board creator.

This is primarily a denial-of-service to legitimate users, though the inverse concern also applies: a `view`-only collaborator receives an audio token with full publish permissions, which may not be intended.

**Recommended Fix:**
Reuse the `requireBoardAccess()` middleware (or extract its logic) for the audio token endpoint instead of implementing ad-hoc access checks. This would correctly handle creator access, org admin/owner bypass, and visibility-based checks in a single consistent code path. Also consider whether view-only collaborators should receive publish-capable audio tokens.

---

#### BOARD-004: Project-Visibility Boards No Project Membership Check for Audio

| Field | Value |
|-------|-------|
| **ID** | BOARD-004 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/routes/audio.routes.ts` (lines 46-70) |

**Description:**
For boards with `project` visibility, the audio token endpoint only checks `board.organization_id !== user.org_id`. It does not verify that the user is a member of the board's linked project. Any org member can obtain a LiveKit audio token for any project-visibility board, even if they are not a member of that project.

**Attack Scenario:**
1. User A is a member of Project X but not Project Y within the same organization.
2. Board B has `visibility: 'project'` and is linked to Project Y.
3. User A calls `POST /v1/boards/{boardB}/audio/token` and receives a valid LiveKit JWT, allowing them to join the audio room and listen to conversations about Project Y.

**Recommended Fix:**
Add a project membership check for `project`-visibility boards, identical to the one in `requireBoardAccess()` (querying `project_members` for `board.project_id` + `user.id`). Better yet, replace the ad-hoc checks with a call to the existing `requireBoardAccess()` middleware.

---

#### BOARD-005: Collaborator PATCH/DELETE Lack Board-Level Authorization

| Field | Value |
|-------|-------|
| **ID** | BOARD-005 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/routes/collaborator.routes.ts` (lines 49-93) |

**Description:**
The `PATCH /collaborators/:collabId` and `DELETE /collaborators/:collabId` endpoints use only `requireAuth` and `requireScope('read_write')` as pre-handlers. They do not include `requireBoardAccess()` or `requireBoardEditAccess()`. While the service layer passes `org_id` to scope the update/delete to the correct organization, there is no check that the authenticated user has edit permission on the *board* that the collaborator belongs to.

Any authenticated user in the same organization can modify or remove collaborators from any board, including boards they have no access to.

**Attack Scenario:**
1. User A is not a collaborator on Board X (a private board in their org).
2. User A calls `DELETE /v1/collaborators/{collabId}` for a collaborator on Board X.
3. The collaborator is removed, potentially locking the board owner's invited guests out.

**Recommended Fix:**
Add a middleware step that resolves the collaborator's `board_id`, then applies `requireBoardEditAccess()` (or at minimum checks that the caller is the board creator or an org admin). The route should be restructured as `/boards/:id/collaborators/:collabId` to naturally scope to a board.

---

#### BOARD-006: WebSocket Uses Stale `users.org_id` Not Multi-Org Resolved

| Field | Value |
|-------|-------|
| **ID** | BOARD-006 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/ws/handler.ts` (lines 207-232) |

**Description:**
The WebSocket authentication handler reads `row.user.org_id` directly from the `users` table to populate the `ConnectedClient.orgId` field. In a multi-org deployment, a user may belong to multiple organizations and send requests with an `X-Org-Id` header to select the active org. The HTTP auth plugin (`plugins/auth.ts`) resolves this correctly via `resolveOrgContext()`, but the WebSocket handler bypasses this resolution entirely.

This means:
1. The `checkBoardAccess()` function uses the user's *default* org, not their intended org.
2. A user who belongs to Org A (default) and Org B may be denied access to Org B boards, or -- more dangerously -- granted access to Org A boards when they intended to operate in Org B context.

**Attack Scenario:**
1. User belongs to Org A (default) and Org B.
2. User authenticates and connects to the WebSocket.
3. `orgId` is set to Org A (the `users.org_id` column value).
4. User sends `join_board` with a Board in Org A, which succeeds.
5. User's UI shows them as operating in Org B, but the WebSocket silently operates in Org A context.

**Recommended Fix:**
Accept an optional `orgId` field in the `join_board` message, validate it against the user's `organization_memberships`, and use it for the `checkBoardAccess()` call. Alternatively, read the org context from the WebSocket connection's initial HTTP upgrade headers (the `X-Org-Id` header is available at upgrade time).

---

#### BOARD-007: WebSocket `scene_update` No Size Limit (DoS)

| Field | Value |
|-------|-------|
| **ID** | BOARD-007 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/ws/handler.ts` (lines 322-348), `apps/board-api/src/ws/persistence.ts` (lines 15-24) |

**Description:**
The `scene_update` message handler accepts an `elements` array of arbitrary size with no validation beyond `Array.isArray(elements)`. A malicious client can send a `scene_update` with millions of elements, which:

1. Is stored in the `dirtyBoards` Map in server memory.
2. Is serialized to JSON and broadcast to all other clients in the room.
3. Is serialized to a Buffer and written to the `boards.yjs_state` column via `saveScene()`.

There are no limits on:
- The number of elements in the array.
- The size of each individual element object.
- The total byte size of the WebSocket message.

Additionally, the Fastify WebSocket configuration does not set `maxPayload`, defaulting to the library's internal default (which may be very large or unlimited depending on the version).

**Attack Scenario:**
1. Attacker joins a board via WebSocket.
2. Attacker sends `{"type":"scene_update","elements":[...10MB of data...]}`.
3. Server allocates memory for the array, stores it in `dirtyBoards`, serializes it for broadcast, and writes it to PostgreSQL.
4. Repeated messages exhaust server memory or fill the database column, causing denial of service.

**Recommended Fix:**
1. Add a `maxPayload` option to the WebSocket server configuration (e.g., 5 MB).
2. Validate the `elements` array length (e.g., max 50,000 elements).
3. Validate the serialized message size before broadcasting.
4. Consider rate-limiting `scene_update` messages per client (e.g., max 10 per second).

---

#### BOARD-008: Chat POST Only Requires Read Access Not Edit

| Field | Value |
|-------|-------|
| **ID** | BOARD-008 |
| **Severity** | High |
| **Affected Files** | `apps/board-api/src/routes/chat.routes.ts` (lines 23-35) |

**Description:**
The `POST /boards/:id/chat` endpoint uses `requireBoardAccess()` as its pre-handler, which only verifies read access. It does not use `requireBoardEditAccess()`. This allows view-only collaborators to send chat messages on boards where they are intended to be passive observers.

While chat messages are less destructive than scene modifications, they can be used for spam, social engineering, or disruption of collaborative sessions.

**Attack Scenario:**
1. User is added to a board with `view` permission.
2. User sends `POST /v1/boards/{id}/chat` with arbitrary message body.
3. Message is stored and visible to all board participants.

**Recommended Fix:**
Change the pre-handler to `requireBoardEditAccess()` or introduce a separate `requireBoardChatAccess()` middleware that checks for at least `edit` permission. If the design intention is that viewers should be able to chat, document this as an explicit policy decision.

---

### 4.3 Medium

---

#### BOARD-009: `saveScene` No Organization Check

| Field | Value |
|-------|-------|
| **ID** | BOARD-009 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/ws/persistence.ts` (lines 15-24) |

**Description:**
The `saveScene()` function updates the board's `yjs_state` using only `boards.id` in the WHERE clause, without including `organization_id`. While the WebSocket handler does check org membership during `join_board`, if a bug or race condition allows a user from Org A to have `client.boardId` set to a Board in Org B, the persistence layer would silently overwrite the wrong board.

**Recommended Fix:**
Pass `orgId` to `saveScene()` and include `eq(boards.organization_id, orgId)` in the WHERE clause. The `loadScene()` function already includes this check correctly.

---

#### BOARD-010: Board Search Returns Private Board Content

| Field | Value |
|-------|-------|
| **ID** | BOARD-010 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/services/board.service.ts` (lines 374-398) |

**Description:**
The `searchBoards()` function queries `board_elements` joined with `boards` filtered by `organization_id`, but does not filter by board visibility or the user's collaborator/project membership status. A search query will return text content from private boards and project-scoped boards that the searching user has no access to.

**Attack Scenario:**
1. User searches for "confidential" via `GET /v1/boards/search?q=confidential`.
2. Results include element text content from private boards belonging to other users in the same org.

**Recommended Fix:**
Add visibility-based filtering to the search query. Either join with `board_collaborators` and filter by visibility, or post-filter results through the same access check logic used in `requireBoardAccess()`.

---

#### BOARD-011: `getRecent` Leaks Private Board Metadata

| Field | Value |
|-------|-------|
| **ID** | BOARD-011 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/services/board.service.ts` (lines 417-439) |

**Description:**
The `getRecent()` function returns the 20 most recently updated boards in the org without filtering by visibility. Private boards and project-scoped boards that the requesting user has no access to are included in the result set, exposing board names, icons, thumbnail URLs, and last-update timestamps.

**Recommended Fix:**
Add a visibility filter or subquery that excludes private boards where the user is not a collaborator/creator, and project-visibility boards where the user is not a project member.

---

#### BOARD-012: `listBoards` Leaks Private Board Metadata

| Field | Value |
|-------|-------|
| **ID** | BOARD-012 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/services/board.service.ts` (lines 81-145) |

**Description:**
The `listBoards()` function filters by `organization_id` but does not filter by visibility or the requesting user's access level. All boards in the org -- including private boards created by other users -- are returned with full metadata (name, description, thumbnail, creator name, element count, collaborator count).

**Recommended Fix:**
Add a visibility filter to the query. Private boards should only appear if the requesting user is the creator or a collaborator. Project-visibility boards should only appear if the user is a project member.

---

#### BOARD-013: Template Creation from Board Bypasses Visibility Check

| Field | Value |
|-------|-------|
| **ID** | BOARD-013 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/services/template.service.ts` (lines 41-54) |

**Description:**
The `createTemplate()` function accepts a `board_id` parameter and copies the board's `yjs_state` into a new template. While it checks `board.organization_id !== orgId`, it does not check whether the requesting user has access to the source board. A user with `member` org role can create a template from any board in their org, including private boards they are not a collaborator on, effectively exfiltrating the board's entire element state.

**Attack Scenario:**
1. User A has a private board with confidential architecture diagrams.
2. User B (same org, `member` role) calls `POST /v1/templates` with `{"name":"test","board_id":"<A's board>"}`.
3. Template is created containing User A's board state. User B can then create a new board from the template to view the content.

**Recommended Fix:**
Before copying the board's `yjs_state`, verify that the requesting user has at least read access to the source board using the same logic as `requireBoardAccess()`.

---

#### BOARD-014: `restoreVersion` No Organization Check on Version

| Field | Value |
|-------|-------|
| **ID** | BOARD-014 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/services/version.service.ts` (lines 69-98) |

**Description:**
The `restoreVersion()` function queries `board_versions` by `versionId` and `boardId` but does not include an `organization_id` check. While the route handler uses `requireBoardEditAccess()` which verifies org membership, the service function itself has no org guard. If called from a different code path (e.g., a future internal API or MCP tool), it could restore a version cross-org.

**Recommended Fix:**
Add an `orgId` parameter to `restoreVersion()` and include it in the board lookup WHERE clause, consistent with how `createVersion()` already operates.

---

#### BOARD-015: No Rate Limit on Chat Messages

| Field | Value |
|-------|-------|
| **ID** | BOARD-015 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/routes/chat.routes.ts` (lines 22-35) |

**Description:**
The `POST /boards/:id/chat` endpoint does not have a route-level rate limit configuration. While a global rate limit exists on the server, it is typically set high (100 req/min) for general API usage. A user could flood a board's chat with hundreds of messages per minute, degrading the experience for other collaborators.

**Recommended Fix:**
Add a route-level rate limit: `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }`.

---

#### BOARD-016: No Rate Limit on WebSocket Messages

| Field | Value |
|-------|-------|
| **ID** | BOARD-016 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/ws/handler.ts` (lines 254-388) |

**Description:**
The WebSocket message handler processes all incoming messages without any rate limiting. A client can send thousands of `scene_update`, `cursor_update`, or `join_board` messages per second. While `cursor_update` messages are not published to Redis (an explicit optimization), they are still parsed and broadcast to all clients in the room, consuming CPU and bandwidth.

**Recommended Fix:**
Implement a per-client message rate limiter. A simple token-bucket algorithm (e.g., 60 `scene_update` messages per minute, 120 `cursor_update` messages per second) would prevent abuse while allowing normal interactive use.

---

#### BOARD-017: CORS Origin Splitting Could Allow Wildcards

| Field | Value |
|-------|-------|
| **ID** | BOARD-017 |
| **Severity** | Medium |
| **Affected Files** | `apps/board-api/src/server.ts` (lines 61-64) |

**Description:**
The CORS origin configuration splits the `CORS_ORIGIN` environment variable on commas: `origin: env.CORS_ORIGIN.split(',')`. If a misconfiguration includes `*` as one of the comma-separated values, `@fastify/cors` will allow requests from any origin while also sending `credentials: true`. This combination is forbidden by the CORS spec but some browsers may handle it permissively.

**Recommended Fix:**
Add validation in `env.ts` to reject `*` as a CORS origin value when `credentials: true` is configured. Alternatively, validate each split origin against a URL pattern.

---

### 4.4 Low

---

#### BOARD-018: API Key Candidate Truncation

| Field | Value |
|-------|-------|
| **ID** | BOARD-018 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/plugins/auth.ts` (lines 232-234) |

**Description:**
When more than 3 API key candidates match a given 8-character prefix, the auth plugin truncates to only the first candidate and logs a warning. While this is a reasonable DoS mitigation, it means that if more than 3 keys happen to share an 8-character prefix (statistically unlikely with `bbam_` prefixed keys, but possible with high key volume), legitimate API keys may fail to authenticate.

**Recommended Fix:**
Consider increasing the limit to 5 or using a longer prefix (e.g., 12 characters) for the initial query to reduce collision probability.

---

#### BOARD-019: `toggleLock` Should Be Admin-Only

| Field | Value |
|-------|-------|
| **ID** | BOARD-019 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/routes/board.routes.ts` (lines 235-246) |

**Description:**
The `POST /boards/:id/lock` endpoint uses `requireBoardEditAccess()`, which allows any user with edit permission to toggle the lock on a board. Locking is a governance control that should typically be restricted to the board creator or org admins/owners. Allowing regular editors to lock a board could be used to deny service to other collaborators.

**Recommended Fix:**
Add `requireMinOrgRole('admin')` to the pre-handler chain, or add a check in the handler that the requesting user is the board creator or an org admin.

---

#### BOARD-020: Zod Validation Error Details Leaked

| Field | Value |
|-------|-------|
| **ID** | BOARD-020 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/server.ts` (lines 26-37) |

**Description:**
The error handler for `ZodError` returns the full `error.issues` array in the response `details` field. This includes the exact Zod schema path, expected types, and received values, which could help an attacker map the internal schema structure and craft targeted payloads.

**Recommended Fix:**
Sanitize the issues array to only include `field` (path) and `message`, stripping `received`, `expected`, and `code` from the response.

---

#### BOARD-021: `default_viewport` Accepts Arbitrary JSON

| Field | Value |
|-------|-------|
| **ID** | BOARD-021 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/routes/board.routes.ts` (lines 22, 32) |

**Description:**
The `default_viewport` field in both create and update board schemas is typed as `z.record(z.unknown()).nullable().optional()`, which accepts any JSON object of arbitrary depth and size. This could be used to store large payloads that are returned in every board fetch, wasting bandwidth and storage.

**Recommended Fix:**
Define a stricter schema for viewport data (e.g., `z.object({ x: z.number(), y: z.number(), zoom: z.number() })`) or add a `z.string().max(1000)` constraint if the field is opaque JSON.

---

#### BOARD-022: `thumbnail_url` Not Validated as URL

| Field | Value |
|-------|-------|
| **ID** | BOARD-022 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/routes/board.routes.ts` (line 33) |

**Description:**
The `thumbnail_url` field in `updateBoardSchema` is `z.string().max(2048).nullable().optional()` without a `.url()` validator. A user could store arbitrary strings (including `javascript:` URIs) that might be rendered in an `<img>` tag or link on the frontend.

**Recommended Fix:**
Add `.url()` to the Zod schema, or validate that the value starts with `https://` or a known file-hosting prefix.

---

#### BOARD-023: `embed_url` No SSRF Protection

| Field | Value |
|-------|-------|
| **ID** | BOARD-023 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/db/schema/board-elements.ts` (schema definition) |

**Description:**
Board elements can contain an `embed_url` field that stores a URL for embedded content. If the server or any backend service fetches this URL (e.g., for generating previews, thumbnails, or validating the embed), an attacker could supply an internal network URL (`http://169.254.169.254/`, `http://localhost:4000/`, etc.) to perform server-side request forgery.

While the current code does not appear to fetch `embed_url` server-side, the field is stored without validation and could be consumed by future features or MCP tools.

**Recommended Fix:**
Add URL validation on the element schema that rejects private IP ranges, loopback addresses, and internal hostnames. Validate the URL protocol is `https://` only.

---

#### BOARD-024: Session Cookie Attributes

| Field | Value |
|-------|-------|
| **ID** | BOARD-024 |
| **Severity** | Low |
| **Affected Files** | `apps/board-api/src/server.ts` (lines 66-68), `apps/board-api/src/env.ts` |

**Description:**
The `COOKIE_SECURE` environment variable defaults to `false`, and the `COOKIE_DOMAIN` is optional. In production, if `COOKIE_SECURE` is not explicitly set to `true`, session cookies will be sent over unencrypted HTTP connections, exposing session tokens to network sniffing. Additionally, the session cookie set by the main API may not include `SameSite` attributes, which could allow CSRF attacks.

**Recommended Fix:**
Default `COOKIE_SECURE` to `true` in production (`NODE_ENV === 'production'`). Ensure the session cookie includes `SameSite=Lax` or `SameSite=Strict`.

---

### 4.5 Informational

---

#### BOARD-025: Health Endpoint Leaks Build Info

| Field | Value |
|-------|-------|
| **ID** | BOARD-025 |
| **Severity** | Informational |
| **Affected Files** | `apps/board-api/src/server.ts` (lines 91-98) |

**Description:**
The `/health` endpoint returns `git_commit` and `build_date` in its response. While useful for operations, this information could help an attacker identify the exact codebase version and target known vulnerabilities.

**Recommended Fix:**
Move `git_commit` and `build_date` to the `/health/ready` endpoint (which is typically not exposed externally) or gate their inclusion behind an authentication check.

---

#### BOARD-026: WebSocket `connected` Message Leaks `org_id`

| Field | Value |
|-------|-------|
| **ID** | BOARD-026 |
| **Severity** | Informational |
| **Affected Files** | `apps/board-api/src/ws/handler.ts` (lines 246-252) |

**Description:**
The `connected` message sent upon WebSocket authentication includes both `user_id` and `org_id`. While the user already knows their own user ID, broadcasting the org ID on every connection could be used by a client-side attacker (XSS) to enumerate internal identifiers.

**Recommended Fix:**
Remove `org_id` from the `connected` message. The frontend should already know the user's org context from its own session state.

---

#### BOARD-027: Duplicate `BoardError` Classes

| Field | Value |
|-------|-------|
| **ID** | BOARD-027 |
| **Severity** | Informational |
| **Affected Files** | `apps/board-api/src/services/board.service.ts` (line 27), `apps/board-api/src/services/version.service.ts` (line 5), `apps/board-api/src/services/template.service.ts` (line 5) |

**Description:**
Three separate `BoardError` classes are defined independently in `board.service.ts`, `version.service.ts`, and `template.service.ts`. While functionally identical, this duplication means the error handler's `error.name === 'BoardError'` check might not behave consistently if one class is modified independently of the others.

**Recommended Fix:**
Extract `BoardError` to a shared `lib/errors.ts` module and import it in all three services.

---

#### BOARD-028: No Request Body Size Limit on Scene Route

| Field | Value |
|-------|-------|
| **ID** | BOARD-028 |
| **Severity** | Informational |
| **Affected Files** | `apps/board-api/src/routes/scene.routes.ts` (lines 32-52) |

**Description:**
The `PUT /boards/:id/scene` endpoint accepts `elements: z.array(z.unknown())` with no length or size constraint. While Fastify has a default body size limit, the lack of application-level validation means the only protection is the server-wide default (typically 1 MB in Fastify, but this can be reconfigured).

**Recommended Fix:**
Add `.max(100000)` to the elements array validation or set an explicit `bodyLimit` on the route.

---

#### BOARD-029: LiveKit Development Credentials as Defaults

| Field | Value |
|-------|-------|
| **ID** | BOARD-029 |
| **Severity** | Informational |
| **Affected Files** | `apps/board-api/src/env.ts` (lines 28-29) |

**Description:**
The `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` environment variables default to `'devkey'` and `'devsecret'` respectively. If these defaults are used in a production deployment, the LiveKit JWT signing secret is publicly known, allowing anyone to forge valid audio room tokens.

**Recommended Fix:**
Remove the defaults and require these values to be explicitly set (or make them optional and disable audio features when not configured).

---

## 5. Methodology Notes

Each agent was assigned a specific security domain and independently reviewed all source files within the `apps/board-api/` directory. Agents had read access to the full monorepo for cross-referencing shared libraries and configuration. Findings were deduplicated based on root cause; where two agents reported the same underlying issue from different angles, the reports were merged under a single finding ID.

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
| Auth & Session | `plugins/auth.ts`, `ws/handler.ts` | BOARD-006, BOARD-018, BOARD-024 |
| Input Validation | All route files, Zod schemas | BOARD-020, BOARD-021, BOARD-022, BOARD-028 |
| Authorization (RBAC) | `middleware/authorize.ts`, all routes | BOARD-001, BOARD-002, BOARD-003, BOARD-004, BOARD-005, BOARD-008, BOARD-019 |
| Data Exposure & XSS | `board.service.ts`, `template.service.ts` | BOARD-010, BOARD-011, BOARD-012, BOARD-013 |
| WebSocket | `ws/handler.ts`, `ws/persistence.ts` | BOARD-001, BOARD-007, BOARD-016, BOARD-026 |
| Rate Limiting & DoS | All route files, `ws/handler.ts` | BOARD-007, BOARD-015, BOARD-016 |
| Business Logic | `version.service.ts`, `board.service.ts` | BOARD-009, BOARD-014, BOARD-027 |
| Cryptography | `services/livekit.service.ts` | BOARD-029 |
| Dependencies & Config | `server.ts`, `env.ts` | BOARD-017, BOARD-025 |
| Real-time Collaboration | `ws/handler.ts`, `routes/chat.routes.ts` | BOARD-001, BOARD-008, BOARD-015 |
