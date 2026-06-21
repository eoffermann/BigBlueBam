# Brief Design Audit

**Date:** 2026-04-09
**Auditor:** Claude (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Brief_Design_Document.md` v1.0 (2026-04-07)
**Implementation:** `apps/brief-api/` (33 source files), `apps/brief/` (37 source files), `apps/mcp-server/src/tools/brief-tools.ts`

---

## Executive Summary

Brief's implementation covers the foundational CRUD layer well but is missing the defining feature of the product: real-time collaborative editing via Yjs/Hocuspocus. The REST API, data model, MCP tools, and basic frontend are substantially built out, yielding a functional document management app. However, the collaboration engine, semantic search, export pipeline, background jobs, and several advanced editor features described in the design spec are entirely absent.

**Overall Completion: ~52%**

| Category | Items Audited | Weighted Completion |
|----------|--------------|-------------------|
| Data Model (schema) | 11 tables | 88% |
| REST API Endpoints | 38 endpoints | 72% |
| Real-Time Collaboration | 5 features | 0% |
| Rich Text Editor | 20 extensions | 50% |
| Frontend Pages & Components | 24 components | 48% |
| MCP Tools | 18 tools | 89% |
| Background Jobs | 4 queues | 0% |
| Cross-Product Integration | 6 features | 30% |
| Shared Schemas | 1 module | 0% |
| Search | 3 strategies | 33% |

---

## Rating Scale

| Rating | Meaning |
|--------|---------|
| **P0** | Not implemented at all |
| **P1** | Stub or placeholder only |
| **P2** | Partially implemented, major gaps |
| **P3** | Mostly implemented, minor gaps |
| **P4** | Implemented with cosmetic deviations |
| **P5** | Fully matches design |

---

## Feature Audit Table

### Data Model

| Feature | Rating | Notes |
|---------|--------|-------|
| `brief_documents` table | P4 | Implemented. Column `org_id` vs design's `organization_id`; slug uniqueness is global not composite `(org, project, slug)`. Missing full-text GIN index on `plain_text`. |
| `brief_folders` table | P4 | Implemented. `parent_id` lacks self-referencing FK constraint in Drizzle (defined as plain uuid). Column naming `org_id` vs `organization_id`. |
| `brief_versions` table | P5 | Fully matches design. |
| `brief_comments` table | P3 | Missing `resolved_at` column (design spec includes it, Drizzle schema omits it). |
| `brief_comment_reactions` table | P5 | Matches design. |
| `brief_embeds` table | P5 | Matches design. |
| `brief_templates` table | P4 | Matches design. `yjs_state` is nullable vs design's `NOT NULL`. Minor. |
| `brief_task_links` table | P4 | Unique constraint is `(doc, task, link_type)` vs design's `(doc, task)`. Slightly different semantics. |
| `brief_beacon_links` table | P4 | Same deviation as task_links: unique on `(doc, beacon, link_type)`. |
| `brief_collaborators` table | P4 | Implemented. Default is `'view'` vs design's `'edit'`. Has extra `updated_at` column (additive). |
| `brief_stars` table | P5 | Matches design. |

### REST API Endpoints -- Documents

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /documents` | P5 | Implemented with pagination, filters, visibility enforcement. |
| `POST /documents` | P5 | Implemented with template support. |
| `GET /documents/:id` | P5 | Implemented (excludes yjs_state from response). |
| `PATCH /documents/:id` | P5 | Implemented with all metadata fields. |
| `DELETE /documents/:id` | P5 | Implemented as archive (soft delete). |
| `POST /documents/:id/restore` | P5 | Implemented. |
| `POST /documents/:id/duplicate` | P5 | Implemented. |
| `POST /documents/:id/promote` | P4 | Implemented but simplified -- creates a minimal beacon_entries stub. Does not call Beacon API, does not copy body content, does not auto-suggest tags from Qdrant. |
| `GET /documents/:id/export/:format` | P0 | **Not implemented.** No export route file exists. No Markdown/HTML/PDF export endpoints. |
| `POST /documents/:id/star` | P5 | Implemented as toggle. |
| `GET /documents/starred` | P5 | Implemented. |
| `GET /documents/recent` | P5 | Implemented. |
| `GET /documents/search` | P3 | Implemented as ILIKE search only. Missing full-text `to_tsvector` search. Missing semantic/Qdrant search. Missing `limit`/`offset` params. |
| `GET /documents/:id/presence` | P0 | **Not implemented.** No presence endpoint. |
| `GET /documents/stats` | P5 | Implemented (bonus -- not in design). |

### REST API Endpoints -- Folders

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /folders` | P5 | Implemented. |
| `POST /folders` | P5 | Implemented. |
| `PATCH /folders/:id` | P5 | Implemented. |
| `DELETE /folders/:id` | P4 | Implemented. Design says "moves contents to parent" -- not verified whether documents are reparented. |

### REST API Endpoints -- Versions

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /documents/:id/versions` | P5 | Implemented. |
| `GET /documents/:id/versions/:versionId` | P5 | Implemented. |
| `POST /documents/:id/versions` | P5 | Implemented. |
| `POST /documents/:id/versions/:versionId/restore` | P5 | Implemented. |
| `GET /documents/:id/versions/:v1/diff/:v2` | P0 | **Not implemented.** No version diff endpoint. |

### REST API Endpoints -- Comments

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /documents/:id/comments` | P5 | Implemented. |
| `POST /documents/:id/comments` | P5 | Implemented with anchor support. |
| `PATCH /comments/:id` | P5 | Implemented. |
| `DELETE /comments/:id` | P5 | Implemented with admin override. |
| `POST /comments/:id/resolve` | P5 | Implemented as toggle. |
| `POST /comments/:id/reactions` | P5 | Implemented. |
| `DELETE /comments/:id/reactions/:emoji` | P5 | Implemented. |

### REST API Endpoints -- Embeds

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `POST /documents/:id/embeds` | P3 | Records metadata only; does not handle multipart file upload. Generates storage key but no actual MinIO upload. |
| `GET /documents/:id/embeds` | P5 | Implemented. |
| `DELETE /embeds/:id` | P3 | Deletes DB record but does not delete object from MinIO. |

### REST API Endpoints -- Templates

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /templates` | P5 | Implemented. |
| `POST /templates` | P5 | Implemented. |
| `PATCH /templates/:id` | P5 | Implemented. |
| `DELETE /templates/:id` | P5 | Implemented. |

### REST API Endpoints -- Links

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /documents/:id/links` | P5 | Implemented. |
| `POST /documents/:id/links/task` | P5 | Implemented. |
| `POST /documents/:id/links/beacon` | P5 | Implemented. |
| `DELETE /links/:id` | P4 | Implemented but requires `document_id` as query param (not in design). |

### REST API Endpoints -- Collaborators

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /documents/:id/collaborators` | P5 | Implemented. |
| `POST /documents/:id/collaborators` | P5 | Implemented. |
| `PATCH /collaborators/:id` | P5 | Implemented. |
| `DELETE /collaborators/:id` | P5 | Implemented. |

### Real-Time Collaboration (Section 5)

| Feature | Rating | Notes |
|---------|--------|-------|
| Yjs CRDT engine / Hocuspocus server | P0 | **Not implemented.** No WebSocket plugin, no `ws/` directory, no Yjs dependency in brief-api. |
| Yjs persistence strategy (load/save/debounce) | P0 | **Not implemented.** `yjs_state` column exists but is never read/written by a Yjs provider. |
| Awareness protocol (cursors, selections) | P0 | **Not implemented.** |
| Redis PubSub for cross-instance sync | P1 | Redis plugin exists but is used only for session/health. No PubSub channels for Yjs. |
| AI agent edits via REST (Markdown -> Yjs update) | P0 | MCP tools `brief_update_content` and `brief_append_content` call endpoints (`PUT /documents/:id/content`, `POST /documents/:id/append`) that do not exist in the API routes. |
| Auto-version (100 edits / 30 min) | P0 | **Not implemented.** No auto-snapshot logic. |

### Rich Text Editor (Section 6)

| Extension | Rating | Notes |
|-----------|--------|-------|
| StarterKit (paragraphs, headings 1-4, bold, italic, strike, code, blockquote, lists) | P5 | Implemented. |
| Collaboration (Yjs binding) | P0 | **Not implemented.** Editor uses local-only state. |
| CollaborationCursor | P0 | **Not implemented.** |
| Placeholder | P5 | Implemented. |
| Image | P5 | Implemented (URL prompt only, no MinIO upload integration). |
| Link | P5 | Implemented with autolink. |
| Table | P5 | Implemented with resize. |
| TaskList / TaskItem | P5 | Implemented. |
| CodeBlockLowlight | P5 | Implemented with lowlight. |
| Highlight | P5 | Implemented. |
| Typography | P5 | Implemented. |
| Mention (@user autocomplete) | P0 | **Not implemented.** |
| BamTaskEmbed (custom node) | P0 | **Not implemented.** |
| BeaconEmbed (custom node) | P0 | **Not implemented.** |
| BanterChannelLink (custom node) | P0 | **Not implemented.** |
| CalloutBlock (info/warning/success/error) | P0 | **Not implemented.** |
| Divider (styled variants) | P3 | HorizontalRule is implemented but without styled variants. |
| TableOfContents | P4 | Implemented as a sidebar component (reads headings from editor). Not a Tiptap extension node. |
| SlashCommand menu | P0 | **Not implemented.** No `/` command palette. |
| BubbleMenu (floating toolbar on selection) | P0 | **Not implemented.** |

### Frontend Pages & Components (Section 9)

| Component | Rating | Notes |
|-----------|--------|-------|
| DocumentListPage | P3 | Implemented as card grid. Missing FolderTree sidebar, DocumentTable (list view), and swimlane by status/author/date. |
| DocumentEditorPage | P3 | Implemented with toolbar and sidebar. Missing Yjs collaboration, presence bar, inline comments on selection, BubbleMenu. |
| TemplateBrowserPage | P4 | Implemented as a gallery with category filtering. |
| SearchResultsPage | P4 | Implemented. Missing excerpt highlighting with `<mark>` tags. |
| RecentPage | P0 | **Not implemented.** Home page shows recent docs but there is no dedicated RecentPage component. |
| StarredPage | P5 | Implemented. |
| BriefEditor | P3 | Functional Tiptap wrapper. No Collaboration or CollaborationCursor extensions. |
| EditorToolbar | P4 | Comprehensive two-row toolbar with all basic formatting. |
| SlashCommandMenu | P0 | **Not implemented.** |
| BubbleMenu | P0 | **Not implemented.** |
| CollaboratorCursors | P0 | **Not implemented.** |
| TaskEmbed | P0 | **Not implemented.** |
| BeaconEmbed | P0 | **Not implemented.** |
| DocumentSidebar (right panel) | P3 | Exists in editor and detail pages. Missing linked items section. |
| CommentThread | P4 | Implemented. Missing threaded reply UI (flat list only). |
| VersionHistory | P3 | Shown in detail sidebar. Missing restore button and diff view. |
| LinkedItems | P0 | **Not implemented.** No UI for task/beacon links display. |
| PresenceBar | P0 | **Not implemented.** |
| PromoteToBeaconDialog | P2 | Promote action exists as a button. No dialog with tag suggestions. |
| ShareToBanterDialog | P0 | **Not implemented.** |
| ExportMenu | P0 | **Not implemented.** |
| TemplateCard | P4 | Implemented within TemplateBrowserPage. |
| FolderTree | P0 | **Not implemented.** |
| DocumentTable (list/table view) | P0 | **Not implemented.** Only card grid view exists. |

### Frontend Hooks & Stores

| Item | Rating | Notes |
|------|--------|-------|
| useDocument / useDocumentList | P5 | Implemented with TanStack Query + infinite scroll. |
| useCollaboration (Yjs provider) | P0 | **Not implemented.** |
| useSearch | P4 | Implemented with debounced query. |
| usePresence | P0 | **Not implemented.** |
| editorStore (Zustand) | P0 | **Not implemented.** No Zustand store for editor UI state. |
| folderStore (Zustand) | P0 | **Not implemented.** No Zustand store for folder tree. |

### MCP Tools (Section 8)

| Tool | Rating | Notes |
|------|--------|-------|
| `brief_list` | P5 | Implemented. |
| `brief_get` | P5 | Implemented. |
| `brief_create` | P5 | Implemented. |
| `brief_update` | P5 | Implemented. |
| `brief_update_content` | P1 | Registered in MCP but calls `PUT /documents/:id/content` which does not exist in brief-api routes. Will always 404. |
| `brief_append_content` | P1 | Registered in MCP but calls `POST /documents/:id/append` which does not exist in brief-api routes. Will always 404. |
| `brief_archive` | P5 | Implemented. |
| `brief_restore` | P5 | Implemented. |
| `brief_duplicate` | P5 | Implemented. |
| `brief_search` | P4 | Implemented. `semantic` param accepted but backend ignores it (no Qdrant). |
| `brief_comment_list` | P5 | Implemented. |
| `brief_comment_add` | P5 | Implemented. |
| `brief_comment_resolve` | P5 | Implemented. |
| `brief_versions` | P5 | Implemented. |
| `brief_version_get` | P5 | Implemented. |
| `brief_version_restore` | P5 | Implemented. |
| `brief_promote_to_beacon` | P4 | Implemented but simplified promotion. |
| `brief_link_task` | P5 | Implemented. |

### Background Jobs (Section 10)

| Job | Rating | Notes |
|-----|--------|-------|
| `brief:embed` (generateEmbeddings) | P0 | **Not implemented.** No worker handlers, no Qdrant integration. |
| `brief:snapshot` (autoSnapshot) | P0 | **Not implemented.** |
| `brief:export` (exportPdf) | P0 | **Not implemented.** |
| `brief:cleanup` (purgeOldVersions) | P0 | **Not implemented.** |

### Cross-Product Integration (Section 7)

| Feature | Rating | Notes |
|---------|--------|-------|
| Brief -> Beacon graduation | P2 | Endpoint exists. Creates a minimal beacon_entries row but does not copy body, tags, or set `source_brief_id`. |
| Beacon link back banner in UI | P0 | No "promoted to Beacon" banner in the document detail page. |
| BamTaskEmbed (live mini-card in editor) | P0 | **Not implemented.** |
| Meeting notes -> action items workflow | P0 | **Not implemented.** |
| Share to Banter | P0 | **Not implemented.** |
| Helpdesk template integration | P0 | **Not implemented.** |

### Shared Zod Schemas (Section 4.3)

| Item | Rating | Notes |
|------|--------|-------|
| `packages/shared/src/brief.ts` | P0 | **Does not exist.** Validation schemas are defined inline in route files. Not shared with frontend. |

### System Templates (Section 12)

| Item | Rating | Notes |
|------|--------|-------|
| 8 default templates (Meeting Notes, RFC, Post-Mortem, etc.) | P2 | Migration `0025_brief_system_templates.sql` exists but templates are seeded as DB rows. Cannot verify content fidelity without running the migration. Template CRUD is functional. |

### Authorization Model (Section 11)

| Item | Rating | Notes |
|------|--------|-------|
| Role hierarchy (SuperUser/Owner/Admin/Member/Viewer) | P4 | Implemented in `middleware/authorize.ts` with `requireMinOrgRole`. |
| Document-level visibility enforcement | P4 | Implemented in `listDocuments` and `searchDocuments` with private/project/organization rules. |
| Collaborator permission override | P3 | `brief_collaborators` table and routes exist. Visibility queries check collaborator membership. Edit-access middleware partially checks but does not differentiate view/comment/edit granularity for all operations. |

### Infrastructure

| Item | Rating | Notes |
|------|--------|-------|
| Docker service in docker-compose | P5 | `brief-api` service is defined and runs on :4005. |
| nginx routing `/brief/`, `/brief/api/` | P5 | Configured in nginx.conf. |
| nginx WebSocket `/brief/ws` | P0 | **Not implemented.** No WebSocket proxy rule (no Yjs server to proxy to). |
| Migration files | P5 | `0024_brief_tables.sql` and `0025_brief_system_templates.sql` exist. |
| Qdrant collection `brief_documents` | P0 | **Not implemented.** No Qdrant collection setup, no embedding logic. |

---

## Detailed Findings for P0-P3 Items

### P0 -- Critical Missing Features

**1. Real-Time Collaborative Editing (Yjs/Hocuspocus)**
This is the defining feature of Brief per the design document ("Real-time by default. All editing is collaborative via CRDT."). The entire Section 5 is unimplemented:
- No Hocuspocus or y-websocket dependency
- No `ws/collaboration.ts` WebSocket handler
- No `plugins/websocket.ts` Fastify plugin
- No `services/yjs-persistence.ts` persistence layer
- No awareness protocol for cursor positions
- The frontend editor operates in local-only mode
- Files needed: `apps/brief-api/src/ws/collaboration.ts`, `apps/brief-api/src/plugins/websocket.ts`, `apps/brief-api/src/services/yjs-persistence.ts`

**2. Export Endpoints (`GET /documents/:id/export/:format`)**
No `export.routes.ts` file exists. Design specifies synchronous Markdown/HTML export and async PDF via BullMQ. None implemented.

**3. Version Diff (`GET /documents/:id/versions/:v1/diff/:v2`)**
No diff endpoint. Design specifies HTML diff output between two versions.

**4. Semantic Search / Qdrant Integration**
No Qdrant client, no embedding service, no vector collection. Search is ILIKE only.

**5. Background Jobs**
None of the four BullMQ queues (`brief:embed`, `brief:snapshot`, `brief:export`, `brief:cleanup`) are implemented in the worker service.

**6. Custom Editor Extensions (Mention, BamTaskEmbed, BeaconEmbed, CalloutBlock, BanterChannelLink, SlashCommand, BubbleMenu)**
Seven custom Tiptap extensions specified in the design are entirely missing. These are key to the "cross-product linking is native" principle.

**7. Shared Zod Schemas (`packages/shared/src/brief.ts`)**
Design specifies shared validation schemas. All schemas are defined inline in route files, violating the "single source of truth" principle.

**8. Frontend Components: FolderTree, DocumentTable, LinkedItems, PresenceBar, ShareToBanterDialog, ExportMenu**
Six specified frontend components do not exist.

**9. Zustand Stores (editorStore, folderStore)**
Neither store exists. Editor state is managed with local React state.

**10. RecentPage**
Design specifies a dedicated page; implementation only shows recent docs on the home page.

### P1 -- Stub / Broken

**1. MCP `brief_update_content` and `brief_append_content`**
These tools are registered in the MCP server and call `PUT /documents/:id/content` and `POST /documents/:id/append` respectively. However, neither endpoint exists in `document.routes.ts`. Any MCP call will receive a 404. This is a broken contract between the MCP layer and the API.

### P2 -- Partial

**1. Brief -> Beacon Graduation**
The `promoteToBeacon` service creates a minimal `beacon_entries` row (slug + title + org only). The design specifies:
- Rendering current Yjs state to Markdown
- Calling Beacon API to create a full beacon with body, tags, status, `source_brief_id`
- Auto-suggesting tags from Qdrant semantic similarity
None of this is implemented. The current stub is functional but incomplete.

**2. Embed Upload**
`POST /documents/:id/embeds` records metadata and generates a storage key but does not perform actual file upload to MinIO. No multipart handling.

**3. System Templates**
Migration exists to seed templates but content is not verifiable without running the DB. CRUD is functional.

### P3 -- Mostly Implemented

**1. Search**
Uses ILIKE for keyword matching. Missing `to_tsvector`-based full-text search (GIN index not created in Drizzle schema). Missing Qdrant semantic search. Missing `limit`/`offset` pagination in search.

**2. Comments Schema**
Missing `resolved_at` timestamp column that the design includes.

**3. Document List Page**
Card grid works. Missing folder tree sidebar, table/list view toggle, advanced filter options.

**4. Collaborator Permission Granularity**
Table and routes exist, but middleware does not differentiate between view/comment/edit permissions for all operations (e.g., a "comment"-level collaborator can likely trigger edit operations).

---

## P4-P5 Items (Brief List)

### P5 (Fully Matches Design)
- `brief_versions` schema
- `brief_comment_reactions` schema
- `brief_embeds` schema
- `brief_stars` schema
- All 7 Comment API endpoints
- All 4 Template API endpoints
- All 4 Collaborator API endpoints
- Document CRUD core (list, create, get, patch, delete, restore, duplicate, star, starred, recent)
- Version list/get/create/restore endpoints
- MCP tools: brief_list, brief_get, brief_create, brief_update, brief_archive, brief_restore, brief_duplicate, brief_comment_list, brief_comment_add, brief_comment_resolve, brief_versions, brief_version_get, brief_version_restore, brief_link_task
- Docker service and nginx routing
- Migration files
- Frontend: StarredPage, useDocument hooks, basic editor extensions (StarterKit, Placeholder, Image, Link, Table, TaskList, CodeBlockLowlight, Highlight, Typography)

### P4 (Minor Deviations)
- `brief_documents` schema (column naming, slug uniqueness scope)
- `brief_folders` schema (missing self-FK in Drizzle)
- `brief_templates` schema (nullable yjs_state)
- `brief_task_links` / `brief_beacon_links` (unique constraint includes link_type)
- `brief_collaborators` schema (default permission is 'view' not 'edit')
- EditorToolbar (comprehensive, minor differences from design)
- TemplateBrowserPage, SearchResultsPage, TableOfContents
- Role-based authorization
- Document visibility enforcement

---

## Recommendations

### Immediate Priority (Blocks core product value)

1. **Implement Yjs/Hocuspocus collaboration server.** This is the product's raison d'etre. Without it, Brief is just a document manager, not a collaborative editor. Install `@hocuspocus/server`, create the WebSocket plugin, implement persistence to `brief_documents.yjs_state`, and add the Collaboration + CollaborationCursor extensions to the frontend editor.

2. **Add `PUT /documents/:id/content` and `POST /documents/:id/append` API endpoints.** The MCP tools already reference these. Without them, AI agents cannot edit document content -- breaking the "AI is a co-author" principle.

3. **Create `packages/shared/src/brief.ts`** with shared Zod schemas. Extract from inline route definitions. This is a structural issue that will compound as the codebase grows.

### High Priority (Core feature gaps)

4. **Implement export endpoints** (Markdown, HTML synchronous; PDF async via BullMQ).
5. **Add version diff endpoint** (`GET /documents/:id/versions/:v1/diff/:v2`).
6. **Build SlashCommand menu and BubbleMenu** -- these are primary UX differentiators.
7. **Implement MinIO file upload in embed route** (multipart handler).
8. **Add FolderTree component** to document list page.

### Medium Priority (Enhancement)

9. **Qdrant semantic search integration** -- chunking, embedding, and hybrid search.
10. **Background jobs** -- at minimum autoSnapshot and generateEmbeddings.
11. **Custom editor nodes** (BamTaskEmbed, BeaconEmbed, Mention, CalloutBlock).
12. **Complete Beacon graduation** with full body copy, tag suggestion, and `source_brief_id`.
13. **Presence bar** and collaborator cursors in the editor.
14. **Add `resolved_at` column** to `brief_comments` schema.

### Low Priority (Polish)

15. **DocumentTable** (list view alternative to card grid).
16. **Share to Banter** dialog.
17. **Zustand stores** for editor and folder state.
18. **RecentPage** as a dedicated page.
19. **Callout block** styled variants for Divider.
20. **Full-text search** via `to_tsvector` GIN index (replace or supplement ILIKE).
