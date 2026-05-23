# Beacon Security Audit

**Date:** 2026-04-05
**Auditor:** Claude (automated)
**Scope:** apps/beacon-api/, apps/mcp-server/src/tools/beacon-tools.ts, infra/postgres/migrations/0023_beacon_tables.sql
**Status:** Complete

## Summary
- P0 (Critical): 3 findings
- P1 (High): 8 findings
- P2 (Medium): 7 findings
- P3 (Low): 5 findings

---

## P0 -- Critical

### P0-001: ILIKE Search Injection via Unescaped Wildcards
**File:** `apps/beacon-api/src/services/beacon.service.ts:240-245`
**Also:** `apps/beacon-api/src/services/search.service.ts:437,553-556`
**Impact:** SQL injection / denial-of-service via LIKE pattern manipulation. An attacker can inject `%`, `_`, or backslash characters in the `search` / `query` parameter to craft expensive ILIKE patterns that bypass intended matching or cause full table scans.
**Description:** The `listBeacons` function interpolates user input directly into an ILIKE pattern:
```typescript
ilike(beaconEntries.title, `%${filters.search}%`)
```
The `search` string is not sanitized for LIKE metacharacters (`%`, `_`, `\`). The same pattern appears in `fulltextSearch()` and `suggestBeacons()`. While Drizzle parameterizes the value (so this is not raw SQL injection), LIKE-specific characters are still interpreted by PostgreSQL, allowing pattern manipulation and potentially expensive regex-equivalent queries.
**Fix:** Escape LIKE metacharacters before interpolation:
```typescript
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}
// then:
ilike(beaconEntries.title, `%${escapeLike(filters.search)}%`)
```
Apply to all three locations.
**Status:** Open

### P0-002: Cross-Org Link Creation -- No Org Isolation on Target Beacon
**File:** `apps/beacon-api/src/routes/link.routes.ts:14-37`, `apps/beacon-api/src/services/link.service.ts:5-25`
**Impact:** Privilege escalation / org isolation failure. A user in Org A can create a link from their beacon to a beacon in Org B by supplying a valid `target_id` UUID belonging to Org B.
**Description:** The `POST /beacons/:id/links` route uses `requireMinOrgRole('member')` which only validates the source beacon's membership, not the link target. The `createLink` service function performs a raw insert with no check that `target_id` belongs to the same organization as `source_id`. An attacker who guesses or obtains a beacon UUID from another organization can create cross-org links, leaking the existence of beacons in other orgs and corrupting the link graph.
**Fix:** In `link.service.ts`, before inserting, verify both beacons exist and share the same `organization_id`:
```typescript
const [source] = await db.select({ org: beaconEntries.organization_id })
  .from(beaconEntries).where(eq(beaconEntries.id, sourceId)).limit(1);
const [target] = await db.select({ org: beaconEntries.organization_id })
  .from(beaconEntries).where(eq(beaconEntries.id, targetId)).limit(1);
if (!source || !target || source.org !== target.org) {
  throw new BeaconError('NOT_FOUND', 'Target beacon not found', 404);
}
```
**Status:** Open

### P0-003: Challenge Endpoint Missing Beacon Ownership Check (IDOR)
**File:** `apps/beacon-api/src/routes/beacon.routes.ts:181-195`
**Impact:** Any authenticated member can transition any Active beacon in their org to PendingReview, even beacons they have no read access to (e.g., Private beacons owned by someone else).
**Description:** The `POST /beacons/:id/challenge` route uses `requireMinOrgRole('member')` but does NOT use `requireBeaconReadAccess()` or `requireBeaconEditAccess()`. It directly calls `transitionBeacon()` with the raw `request.params.id`. A member can challenge any beacon by UUID, including Private beacons they should not be able to see, effectively discovering their existence and forcing a status change.
**Fix:** Add `requireBeaconReadAccess()` to the preHandler chain:
```typescript
{ preHandler: [requireAuth, requireBeaconReadAccess(), requireMinOrgRole('member'), requireScope('read_write')] }
```
**Status:** Open

---

## P1 -- High

### P1-001: body_markdown Has No Size Limit -- Unbounded Storage
**File:** `apps/beacon-api/src/routes/beacon.routes.ts:13` (createBeaconSchema), `apps/beacon-api/src/routes/beacon.routes.ts:20` (updateBeaconSchema)
**Impact:** Denial of service / resource exhaustion. An attacker can create beacons with arbitrarily large `body_markdown` payloads (multi-GB), consuming database storage, memory during chunking/embedding, and Qdrant storage.
**Description:** The `createBeaconSchema` validates `body_markdown: z.string().min(1)` with no `.max()` constraint. The `updateBeaconSchema` has the same issue. The chunker service will attempt to process and embed the entire body regardless of size.
**Fix:** Add a reasonable maximum size limit:
```typescript
body_markdown: z.string().min(1).max(500_000), // ~500KB max
```
Also add the same limit to the update schema. Consider a `Content-Length` check at the Fastify level.
**Status:** Open

### P1-002: Saved Query Get/Delete Missing Org Isolation
**File:** `apps/beacon-api/src/services/saved-query.service.ts:95-110`
**Impact:** Information disclosure / cross-org data access. A user can read any Organization-scoped or Project-scoped saved query from ANY org if they know the UUID.
**Description:** The `getQuery` function fetches by ID and only checks `owner_id !== userId && scope === 'Private'`. For non-Private queries, there is no `organization_id` check. A user in Org A can read Organization-scoped saved queries belonging to Org B by guessing the UUID.
**Fix:** Pass `orgId` into `getQuery` and enforce it:
```typescript
export async function getQuery(id: string, userId: string, orgId: string) {
  // ... fetch query ...
  if (query.organization_id !== orgId) return null;
  if (query.owner_id !== userId && query.scope === 'Private') return null;
  return query;
}
```
Update the route handler at `search.routes.ts:173` to pass `request.user!.org_id`.
**Status:** Open

### P1-003: retireBeacon Allows Retiring From Any Status (Lifecycle Bypass)
**File:** `apps/beacon-api/src/services/beacon.service.ts:365-380`
**Impact:** Data integrity violation. The `retireBeacon` function directly sets `status: 'Retired'` without calling `assertTransition()` or checking the current status. This bypasses the lifecycle state machine, allowing retirement from Draft (should only go to Active/Retired, which is fine) but also from already-Retired beacons (double retirement).
**Description:** Unlike `publishBeacon` (which checks `existing.status !== 'Draft'`) and `restoreBeacon` (which checks `existing.status !== 'Archived'`), the `retireBeacon` function has no status check. Per the lifecycle map, Retired is terminal -- re-retiring should be a no-op or error.
**Fix:** Add lifecycle validation:
```typescript
import { assertTransition } from './lifecycle.service.js';
// ...
assertTransition(existing.status as BeaconStatus, 'Retired');
```
**Status:** Open

### P1-004: Policy PUT Allows Admin to Set Policy for Another Org
**File:** `apps/beacon-api/src/routes/policy.routes.ts:37-69`
**Impact:** Privilege escalation. An admin-level user can supply `organization_id` in the request body to set a policy for a different organization. The route falls back to `data.organization_id ?? request.user!.org_id` at line 57, but never validates that `data.organization_id` matches the user's org.
**Description:** The `setPolicySchema` accepts `organization_id: z.string().uuid().optional()`. If an admin provides an `organization_id` belonging to a different org, the `setPolicy` service will create/update a policy for that foreign org.
**Fix:** Always use the session org and ignore client-supplied `organization_id`:
```typescript
const result = await policyService.setPolicy(
  data.scope,
  request.user!.org_id, // always use session org
  data.project_id,
  // ...
);
```
Alternatively, add a guard: `if (data.organization_id && data.organization_id !== request.user!.org_id) return 403`.
**Status:** Open

### P1-005: Link Removal Missing Org Scoping (IDOR)
**File:** `apps/beacon-api/src/routes/link.routes.ts:52-69`, `apps/beacon-api/src/services/link.service.ts:27-33`
**Impact:** IDOR -- a user can delete any link in the system by guessing the link UUID, regardless of org ownership.
**Description:** The `DELETE /beacons/:id/links/:linkId` route uses `requireBeaconEditAccess()` which validates the source beacon (`:id`), but the `removeLink(request.params.linkId)` call at line 56 deletes the link by its own ID without verifying it actually belongs to the beacon identified by `:id`. An attacker can supply a valid beacon ID they own as `:id` (to pass edit access) and a `linkId` from a completely different beacon (potentially in another org).
**Fix:** Scope the deletion to the source beacon:
```typescript
export async function removeLink(linkId: string, beaconId: string) {
  const [deleted] = await db
    .delete(beaconLinks)
    .where(and(
      eq(beaconLinks.id, linkId),
      or(eq(beaconLinks.source_id, beaconId), eq(beaconLinks.target_id, beaconId)),
    ))
    .returning();
  return deleted ?? null;
}
```
**Status:** Open

### P1-006: Graph Endpoints Missing Visibility Filtering
**File:** `apps/beacon-api/src/services/graph.service.ts:66-152` (getNeighbors), `apps/beacon-api/src/services/graph.service.ts:271-322` (getHubs), `apps/beacon-api/src/services/graph.service.ts:328-382` (getRecent)
**Impact:** Information disclosure. Private and Project-scoped beacons are returned in graph results to users who should not see them. The graph service filters by org and status but never checks visibility or project membership.
**Description:** All three graph functions (getNeighbors, getHubs, getRecent) query `beacon_entries` filtering only by `organization_id` and `status`. They do not apply the same Private/Project visibility rules used in `listBeacons` and `suggestBeacons`. A member can see Private beacons owned by other users in graph traversal results.
**Fix:** Add a visibility-filtering pass to `fetchNodes()` (or inline into the SQL) that excludes Private beacons not owned by the requesting user and Project beacons where the user is not a project member. This requires passing `userId` through to the graph service functions.
**Status:** Open

### P1-007: Search hybridSearch Uses Undefined `userId` Variable
**File:** `apps/beacon-api/src/services/search.service.ts:272-274`
**Impact:** Visibility filtering in search is broken at runtime. The function signature accepts `_userId` (line 85) but the body references bare `userId` (line 272, 278, 279, 284). This will throw a ReferenceError at runtime, meaning search likely crashes or (if caught) falls back to returning no results.
**Description:** The parameter is named `_userId` with a leading underscore (conventionally meaning "unused") but then `userId` is referenced on lines 272, 278-279, 284, 288. If TypeScript does not catch this (due to `any` casts or loose config), the search service will fail at runtime during visibility filtering.
**Fix:** Rename the parameter from `_userId` to `userId`:
```typescript
export async function hybridSearch(
  request: SearchRequest,
  userId: string, // was _userId
): Promise<SearchResponse> {
```
**Status:** Open

### P1-008: No Rate Limiting on Beacon Creation / Mutation Endpoints
**File:** `apps/beacon-api/src/server.ts:60-63`
**Impact:** Abuse / resource exhaustion. The global rate limiter applies 100 requests per 60 seconds across ALL endpoints. There are no endpoint-specific rate limits for write operations (POST /beacons, POST /search, POST /beacons/:id/verify). An attacker can create 100 beacons per minute or fire 100 searches per minute.
**Description:** Beacon creation involves slug generation (multiple DB queries), version insertion, and potentially embedding + Qdrant upsert. Search involves embedding + Qdrant search + multiple DB queries. The global 100req/60s limit is too generous for these expensive operations.
**Fix:** Add endpoint-specific rate limits:
```typescript
fastify.post('/beacons', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  preHandler: [requireAuth, ...],
}, handler);
```
Apply stricter limits (10-20 per minute) to creation, mutation, and search endpoints.
**Status:** Open

---

## P2 -- Medium

### P2-001: No CSRF Protection on Cookie-Authenticated Requests
**File:** `apps/beacon-api/src/server.ts:51-58`, `apps/beacon-api/src/plugins/auth.ts:185-215`
**Impact:** CSRF attacks on session-authenticated users. The API uses cookie-based session auth alongside Bearer token auth. State-changing operations (POST, PUT, DELETE) authenticated via cookies are vulnerable to CSRF.
**Description:** The server registers `@fastify/cors` with `credentials: true` and `@fastify/cookie`, but there is no CSRF token validation. A malicious site could make cross-origin POST requests to `/beacons` that would carry the session cookie, creating beacons on behalf of the victim.
**Fix:** Implement one of: (1) CSRF token middleware (e.g., `@fastify/csrf-protection`), (2) SameSite=Strict/Lax cookie attribute, (3) require a custom header (e.g., `X-Requested-With`) that cannot be set by simple CORS requests. Option 3 is lightest weight; option 1 is strongest.
**Status:** Open

### P2-002: Slug Collision Attack -- Enumeration via Timing
**File:** `apps/beacon-api/src/services/beacon.service.ts:32-47`
**Impact:** Information disclosure / denial of service. The `uniqueSlug()` function queries existing slugs with ILIKE, incrementing a counter until a free slot is found. An attacker can: (1) create many beacons with the same title to force high `-N` suffixes (O(N) DB queries per creation), (2) use timing side-channels to determine if a slug exists.
**Description:** The slug generation issues an ILIKE query `${base}-%` which is not anchored -- it matches any slug starting with the base. Creating beacons with adversarial titles like `a` produces slugs `a`, `a-2`, `a-3`, ..., and each new creation scans the full set. At 10,000 identical-title beacons, creation becomes significantly slower.
**Fix:** Add a random suffix to guarantee uniqueness in O(1):
```typescript
async function uniqueSlug(title: string): string {
  const base = slugify(title);
  if (!base) return `beacon-${Date.now()}`;
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${base}-${suffix}`;
}
```
Or add a `LIMIT` + `ORDER BY` to only check the highest existing suffix.
**Status:** Open

### P2-003: Error Handler May Leak Internal Details for Non-500 Errors
**File:** `apps/beacon-api/src/server.ts:38-47`
**Impact:** Information disclosure. For non-500 errors (`statusCode < 500`), the error handler returns `error.message` directly. If a database error or unexpected error has a non-500 status code attached, internal details (table names, column names, constraint names) could leak.
**Description:** The error handler at line 43 sends `error.message` for any error with `statusCode < 500`. While Drizzle/pg errors typically don't set a statusCode, Fastify schema validation errors and some middleware errors may include detailed internal messages.
**Fix:** Sanitize error messages for non-ZodError, non-BeaconError exceptions:
```typescript
const message = error instanceof BeaconError
  ? error.message
  : statusCode >= 500 ? 'Internal server error' : 'Bad request';
```
**Status:** Open

### P2-004: MCP beacon_verify Tool Missing Required Fields
**File:** `apps/mcp-server/src/tools/beacon-tools.ts:152-160`
**Impact:** API errors / broken verification flow. The `beacon_verify` MCP tool does not include `verification_type` or `outcome` parameters in its schema. The beacon API route requires both fields. When the tool is called, it will always receive a 400 validation error.
**Description:** The tool schema only defines `id` and `notes`. The API route at `beacon.routes.ts:149-153` requires `verification_type` (enum) and `outcome` (enum). The MCP tool will never successfully verify a beacon.
**Fix:** Add the required fields to the tool schema:
```typescript
server.tool('beacon_verify', '...', {
  id: z.string().uuid(),
  verification_type: z.enum(['Manual', 'AgentAutomatic', 'AgentAssisted', 'ScheduledReview']),
  outcome: z.enum(['Confirmed', 'Updated', 'Challenged', 'Retired']),
  confidence_score: z.number().min(0).max(1).optional(),
  notes: z.string().max(1000).optional(),
}, ...);
```
**Status:** Open

### P2-005: MCP beacon_create Schema Mismatch -- Extra/Wrong Fields
**File:** `apps/mcp-server/src/tools/beacon-tools.ts:61-77`
**Impact:** Fields silently dropped or API validation errors. The MCP tool sends `body` but the API expects `body_markdown`. The tool accepts `owner_id` and `tags` which are not in the API `createBeaconSchema`.
**Description:** The MCP tool schema includes `body` (should be `body_markdown`), `tags` (no tags-in-creation endpoint -- tags are added separately via POST `/beacons/:id/tags`), and `owner_id` (not supported by the create endpoint). The API will either ignore these fields or return validation errors.
**Fix:** Align the MCP tool schema with the API:
```typescript
{
  title: z.string().min(1).max(512),
  summary: z.string().max(500).optional(),
  body_markdown: z.string().min(1),
  visibility: z.enum([...]).optional(),
  project_id: z.string().uuid().optional(),
}
```
If tags-on-create is desired, add a second call to the tags endpoint after creation.
**Status:** Open

### P2-006: MCP beacon_list Accepts limit up to 200, API Caps at 100
**File:** `apps/mcp-server/src/tools/beacon-tools.ts:87` vs `apps/beacon-api/src/routes/beacon.routes.ts:37`
**Impact:** Silent data truncation. The MCP tool allows `limit: 200` but the API clamps it to 100 via `z.coerce.number().int().min(1).max(100)`. MCP users requesting 200 will silently get 100, which may cause confusion or missed results.
**Fix:** Align the MCP tool limit to `.max(100)` to match the API.
**Status:** Open

### P2-007: Qdrant Visibility Filtering Is Incomplete
**File:** `apps/beacon-api/src/services/qdrant.service.ts:224-234`
**Impact:** Information disclosure via search. The Qdrant `visibility_max` filter limits results by visibility level, but it does not enforce per-user visibility (e.g., Private beacons only visible to owner). A user searching with `visibility_max: Private` could get Qdrant hits for Private beacons owned by other users.
**Description:** The Qdrant filter uses a simple `match.any` on the visibility field. It does not filter by `owned_by` for Private beacons. While the post-search visibility filtering in `hybridSearch()` should catch this, the semantic search stage itself leaks scores and counts of Private beacons to unauthorized users (visible in `retrieval_stages.semantic_hits`).
**Fix:** Add an `owned_by` filter for Private visibility in the Qdrant query, or pass the user's project memberships to exclude unauthorized Project-scoped beacons at the Qdrant level. At minimum, exclude Private from Qdrant results unless specifically requested.
**Status:** Open

---

## P3 -- Low

### P3-001: Missing Audit Logging for Sensitive Operations
**File:** `apps/beacon-api/src/services/beacon.service.ts` (all mutations), `apps/beacon-api/src/services/lifecycle.service.ts`, `apps/beacon-api/src/services/policy.service.ts`
**Impact:** Reduced forensic capability. Beacon creation, updates, lifecycle transitions, policy changes, and link/tag mutations have no audit trail beyond the `beacon_verifications` table (which only covers verifications). There is no activity_log integration.
**Description:** The main BigBlueBam API has an append-only activity log. The beacon-api has no equivalent. Operations like retiring beacons, changing policies, or transitioning states are not logged anywhere that an admin can review.
**Fix:** Add audit logging for: beacon CRUD, lifecycle transitions, policy changes, link/tag mutations. Either integrate with the existing BBB activity_log or create a beacon-specific audit table.
**Status:** Open

### P3-002: No Content-Type Validation on Request Bodies
**File:** `apps/beacon-api/src/server.ts` (global)
**Impact:** Defense in depth gap. The server does not validate that POST/PUT requests have `Content-Type: application/json`. Fastify's default parser handles this, but explicit validation prevents content-type confusion attacks.
**Description:** Fastify will parse JSON by default, but does not reject requests with incorrect Content-Type headers. A request with `Content-Type: text/plain` containing JSON will still be parsed.
**Fix:** Add a `preValidation` hook that rejects non-JSON content types on POST/PUT/PATCH routes, or configure Fastify's content type parser strictly.
**Status:** Open

### P3-003: Missing Security Headers
**File:** `apps/beacon-api/src/server.ts` (global)
**Impact:** Defense in depth gap. The API does not set security headers like `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, or `Cache-Control: no-store` on sensitive responses.
**Description:** While the API is proxied through nginx (which may set some headers), the API itself should set defense-in-depth headers, especially for direct access during development.
**Fix:** Register `@fastify/helmet` or add a custom `onSend` hook:
```typescript
fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});
```
**Status:** Open

### P3-004: Session Cookie Missing SameSite and Secure Attributes
**File:** `apps/beacon-api/src/plugins/auth.ts:185-215`, `apps/beacon-api/src/env.ts:39`
**Impact:** Cookie sent on cross-site requests (CSRF enabler). The auth plugin reads cookies but there is no evidence that the session cookie is set with `SameSite=Lax` or `Secure` attributes. `COOKIE_SECURE` defaults to `false` in env.
**Description:** While the beacon-api does not set cookies itself (it reads them from the main BBB API), the `COOKIE_SECURE: false` default means in production environments where HTTPS is expected, cookies may not require secure transport. This is a configuration concern rather than a code bug.
**Fix:** Default `COOKIE_SECURE` to `true` in production, and ensure the main API sets `SameSite=Lax` on session cookies.
**Status:** Open

### P3-005: Migration Missing RLS (Row-Level Security) Policies
**File:** `infra/postgres/migrations/0023_beacon_tables.sql`
**Impact:** Defense in depth gap. The migration creates tables without PostgreSQL Row-Level Security policies. If the application-level org isolation is bypassed (e.g., by a SQL injection elsewhere in the stack), there is no database-level protection preventing cross-org data access.
**Description:** The migration creates indexes and constraints but no RLS policies. While the application enforces org isolation, adding RLS as a secondary defense layer would prevent cross-org access even if the application layer is compromised.
**Fix:** Add RLS policies to key tables:
```sql
ALTER TABLE beacon_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY beacon_entries_org_isolation ON beacon_entries
  USING (organization_id = current_setting('app.current_org_id')::uuid);
```
This requires setting `app.current_org_id` at the connection level in the Drizzle/pg client.
**Status:** Open
