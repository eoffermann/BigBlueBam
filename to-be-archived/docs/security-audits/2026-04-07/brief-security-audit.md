# Brief Security Audit

**Date:** 2026-04-07
**Auditor:** Claude (automated)
**Scope:** apps/brief-api/src/, apps/mcp-server/src/tools/brief-tools.ts
**Status:** Complete

## Summary
- P0 (Critical): 1 finding
- P1 (High): 8 findings
- P2 (Medium): 5 findings
- P3 (Low): 3 findings

---

## P0 -- Critical

### P0-001: Embed Deletion Missing Org Scoping (IDOR -- Cross-Org Delete)
**File:** `apps/brief-api/src/routes/embed.routes.ts:57-75`, `apps/brief-api/src/services/embed.service.ts:58-65`
**Impact:** Any authenticated user in any organization can delete any embed in the system by guessing the embed UUID. This is a cross-org data destruction vulnerability.
**Description:** The `DELETE /embeds/:embedId` route uses `requireAuth` and `requireScope('read_write')` but does NOT verify that the embed belongs to a document the user has access to. The `deleteEmbed(embedId)` service deletes by ID with no org, document, or ownership check. An attacker in Org A can delete embed records belonging to Org B by guessing UUIDs, which breaks documents that reference those embeds.
**Fix:** Pass the user's org_id into `deleteEmbed` and verify the embed's parent document belongs to the same org:
```typescript
export async function deleteEmbed(embedId: string, orgId: string) {
  const [embed] = await db
    .select({ id: briefEmbeds.id, document_id: briefEmbeds.document_id })
    .from(briefEmbeds)
    .where(eq(briefEmbeds.id, embedId))
    .limit(1);
  if (!embed) return null;
  // Verify document belongs to org
  const [doc] = await db
    .select({ org_id: briefDocuments.org_id })
    .from(briefDocuments)
    .where(eq(briefDocuments.id, embed.document_id))
    .limit(1);
  if (!doc || doc.org_id !== orgId) return null;
  // proceed with delete
}
```
**Status:** Fixed

---

## P1 -- High

### P1-001: Comment Edit/Delete/Resolve Missing Org Isolation (Cross-Org IDOR)
**File:** `apps/brief-api/src/routes/comment.routes.ts:61-101`, `apps/brief-api/src/services/comment.service.ts:100-172`
**Impact:** Any authenticated user can edit, delete, or resolve any comment in any organization by guessing the comment UUID. The `PATCH /comments/:commentId`, `DELETE /comments/:commentId`, and `POST /comments/:commentId/resolve` routes do not verify that the comment belongs to a document the user has access to.
**Description:** The comment update/delete/resolve service functions fetch the comment by ID without any org or document scoping. The `updateComment` function only checks `author_id !== userId` (ownership) but not org membership. An admin in Org A can delete comments in Org B because `isAdmin` is based on their own org role. Similarly, `toggleResolve` has no org check at all.
**Fix:** Add org verification to comment mutations by checking the comment's parent document's org_id matches the user's org_id.
**Status:** Fixed

### P1-002: Collaborator Update/Remove Missing Org Isolation (Cross-Org IDOR)
**File:** `apps/brief-api/src/routes/collaborator.routes.ts:44-77`, `apps/brief-api/src/services/collaborator.service.ts:92-123`
**Impact:** Any authenticated user can update or remove any collaborator record in any organization by guessing the collaborator UUID.
**Description:** The `PATCH /collaborators/:collabId` and `DELETE /collaborators/:collabId` routes only require auth and scope, but never verify that the collaborator belongs to a document in the user's org. The service functions `updateCollaborator` and `removeCollaborator` operate purely by collaborator ID with no org or ownership check.
**Fix:** Add org verification to collaborator mutations by joining through the document to check org_id.
**Status:** Fixed

### P1-003: Link Deletion Missing Org Isolation (Cross-Org IDOR)
**File:** `apps/brief-api/src/routes/link.routes.ts:97-123`, `apps/brief-api/src/services/link.service.ts:134-160`
**Impact:** Any authenticated user can delete any link in the system by providing a valid `document_id` they know and a `linkId` from a different document. The `deleteLink` function scopes by `document_id` but the route does not verify the user has access to that document.
**Description:** The `DELETE /links/:linkId?document_id=...` route accepts a user-provided `document_id` but does not run `requireDocumentEditAccess()`. An attacker can supply their own document_id (which they own) and a linkId belonging to a completely different document, and the delete will succeed only if `document_id` matches -- but the route does not verify the supplied document_id actually matches the link's document. However, the service does scope the delete by both `linkId` and `document_id`, so the attacker must know the correct document_id for the link. The real issue is that the route does not verify the user has edit access to the document identified by `document_id`.
**Fix:** Add document access verification to the link delete route.
**Status:** Fixed

### P1-004: Task Link Creation Route Missing `requireDocumentAccess` / `requireDocumentEditAccess`
**File:** `apps/brief-api/src/routes/link.routes.ts:30-61`
**Impact:** A user who is an org member but should NOT have access to a private document can create links FROM that document by supplying its UUID as `:id`. The route only requires `requireMinOrgRole('member')` but does NOT run `requireDocumentAccess()` or `requireDocumentEditAccess()`.
**Description:** The `POST /documents/:id/links/task` route does check that the document belongs to the org in the service layer, but does NOT check visibility (private/project) access. A member who shouldn't see a private document can still create links from it. The same issue exists for `POST /documents/:id/links/beacon`.
**Fix:** Add `requireDocumentEditAccess()` to the preHandler chain for both link creation routes.
**Status:** Fixed

### P1-005: `plain_text` and `html_snapshot` Have No Size Limit in Zod Schema
**File:** `apps/brief-api/src/routes/document.routes.ts:24-25`
**Impact:** Denial of service / storage exhaustion. The `updateDocumentSchema` accepts `plain_text: z.string().nullable().optional()` and `html_snapshot: z.string().nullable().optional()` with no `.max()` constraint. An attacker can send multi-GB strings that are stored in PostgreSQL.
**Description:** While `title` has `.max(512)` and `icon` has `.max(100)`, the `plain_text` and `html_snapshot` fields have no upper bound. These are text fields that can hold arbitrarily large payloads.
**Fix:** Add `.max(2_000_000)` (2MB) to `plain_text` and `.max(5_000_000)` (5MB) to `html_snapshot`.
**Status:** Fixed

### P1-006: Template `html_preview` Has No Size Limit in Zod Schema
**File:** `apps/brief-api/src/routes/template.routes.ts:12-13`
**Impact:** Denial of service / storage exhaustion. The `createTemplateSchema` and `updateTemplateSchema` accept `html_preview: z.string().nullable().optional()` with no `.max()` constraint.
**Description:** An admin can create templates with arbitrarily large `html_preview` payloads.
**Fix:** Add `.max(5_000_000)` to `html_preview`.
**Status:** Fixed

### P1-007: `search` Query Parameter Missing `.max()` Limit
**File:** `apps/brief-api/src/routes/document.routes.ts:35`
**Impact:** An attacker can send a very long search string that triggers expensive ILIKE pattern matching on the database.
**Description:** The `listDocumentsQuerySchema` allows `search: z.string().optional()` with no length constraint. While `escapeLike()` is correctly used to prevent ILIKE injection, a multi-MB search string still causes expensive queries.
**Fix:** Add `.max(500)` to the search parameter.
**Status:** Fixed

### P1-008: `addCollaborator` Missing Org Validation on Target User
**File:** `apps/brief-api/src/services/collaborator.service.ts:42-86`
**Impact:** A user can add a collaborator from a different organization to their document. The service verifies the user exists but does NOT verify the user belongs to the same org as the document.
**Description:** The `addCollaborator` function checks that `user_id` exists in the `users` table but never checks that the target user is a member of the same organization as the document. This could leak document access to users in other orgs.
**Fix:** Verify the target user is a member of the document's org.
**Status:** Fixed

---

## P2 -- Medium

### P2-001: No CSRF Protection on Cookie-Authenticated Requests
**File:** `apps/brief-api/src/server.ts:68-75`
**Impact:** CSRF attacks on session-authenticated users. The API uses cookie-based session auth alongside Bearer token auth. State-changing operations authenticated via cookies are vulnerable to CSRF.
**Description:** The server registers `@fastify/cors` with `credentials: true` and `@fastify/cookie`, but there is no CSRF token validation. A malicious site could make cross-origin POST requests to `/documents` that would carry the session cookie.
**Fix:** Implement one of: (1) CSRF token middleware, (2) SameSite=Strict/Lax cookie attribute, (3) require a custom header (e.g., `X-Requested-With`).
**Status:** Open

### P2-002: MCP `brief_create` Sends `content` Field, API Expects No Such Field
**File:** `apps/mcp-server/src/tools/brief-tools.ts:94-105`
**Impact:** The `content` parameter is accepted by the MCP tool but the Brief API's `createDocumentSchema` does not have a `content` field. It will be silently stripped by Zod validation, so document creation via MCP will always produce empty documents.
**Description:** The MCP `brief_create` tool accepts `content: z.string().max(500_000)` and sends it to `POST /documents`. However, the API's `createDocumentSchema` only accepts `title`, `project_id`, `folder_id`, `template_id`, `visibility`, and `icon`. The `content` field is not recognized and will be silently dropped by Zod `.parse()`.
**Fix:** Either: (1) add a `content` field to the API's create schema that populates `plain_text`, or (2) have the MCP tool make a second call to `PUT /documents/:id/content` after creation.
**Status:** Open

### P2-003: MCP `brief_update_content` and `brief_append_content` Target Non-Existent API Routes
**File:** `apps/mcp-server/src/tools/brief-tools.ts:125-149`
**Impact:** Both tools will always return 404 errors. The Brief API does not have `PUT /documents/:id/content` or `POST /documents/:id/append` routes.
**Description:** The MCP tools `brief_update_content` and `brief_append_content` make requests to routes that do not exist in the Brief API. These endpoints are not registered in `document.routes.ts`.
**Fix:** Either add the missing routes to the Brief API, or remove the MCP tools.
**Status:** Open

### P2-004: MCP `brief_search` Sends `semantic` and `limit` Params Not Recognized by API
**File:** `apps/mcp-server/src/tools/brief-tools.ts:190-204`
**Impact:** The `semantic` and `limit` parameters are silently ignored by the API. The API's `searchDocumentsQuerySchema` only accepts `query`, `project_id`, and `status`.
**Description:** The MCP tool schema includes `semantic: z.boolean().optional()` and `limit: z.number()...` but the API search endpoint does not support these parameters. Results are always limited to 50 with no semantic search option.
**Fix:** Align the MCP tool schema with the API, or add the missing parameters to the API.
**Status:** Open

### P2-005: Session Cookie `COOKIE_SECURE` Defaults to `false`
**File:** `apps/brief-api/src/env.ts:32`
**Impact:** In production, cookies may be transmitted over unencrypted HTTP.
**Description:** `COOKIE_SECURE` defaults to `false`. While the Brief API reads cookies rather than setting them, this configuration value may influence cookie handling behavior. In production with HTTPS, cookies should require secure transport.
**Fix:** Default `COOKIE_SECURE` to `true` in production environments.
**Status:** Open

---

## P3 -- Low

### P3-001: Missing Audit Logging for Sensitive Operations
**File:** `apps/brief-api/src/services/*.ts` (all mutations)
**Impact:** Reduced forensic capability. Document creation, updates, status changes, collaborator changes, and link mutations have no audit trail.
**Description:** The Brief API has no activity log integration. Operations like archiving documents, changing visibility, promoting to beacons, or modifying collaborators are not logged anywhere an admin can review.
**Fix:** Add audit logging for document CRUD, status changes, collaborator mutations, and link operations.
**Status:** Open

### P3-002: No Content-Type Validation on Request Bodies
**File:** `apps/brief-api/src/server.ts` (global)
**Impact:** Defense in depth gap. The server does not validate that POST/PUT/PATCH requests have `Content-Type: application/json`.
**Description:** Fastify will parse JSON by default but does not reject requests with incorrect Content-Type headers.
**Fix:** Add a `preValidation` hook that rejects non-JSON content types on mutation routes.
**Status:** Open

### P3-003: Session Cookie Missing SameSite Attribute
**File:** `apps/brief-api/src/plugins/auth.ts:176-177`
**Impact:** Cookie sent on cross-site requests (CSRF enabler). The auth plugin reads cookies but the session cookie may not have `SameSite=Lax` or `Secure` attributes set by the main API.
**Description:** While the Brief API does not set cookies itself (it reads them from the main BBB API), the lack of SameSite enforcement enables the CSRF vector described in P2-001.
**Fix:** Ensure the main API sets `SameSite=Lax` on session cookies.
**Status:** Open
