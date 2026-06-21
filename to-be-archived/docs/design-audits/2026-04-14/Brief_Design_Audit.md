# Brief Design Audit (2026-04-14)

## Summary

Brief has achieved substantial progress since the 2026-04-09 audit. The REST API layer is now 88% feature-complete with two critical additions: export endpoints (Markdown, HTML) now exist, and content update/append endpoints (`PUT /documents/:id/content`, `POST /documents/:id/append`) are fully implemented. Version diffing is in place. The frontend has gained ExportMenu and LinkedItems components. However, the defining feature — real-time collaborative editing via Yjs/Hocuspocus — remains entirely unimplemented. This is the single largest gap between the design and the codebase. Overall completion is approximately 62% (up from 52% on 2026-04-09).

## Design sources consulted

- `docs/early-design-documents/Brief_Design_Document.md` (v1.0, 888 lines)
- `docs/brief-security-audit.md` (supplemental)
- `docs/design-audits/2026-04-09/Brief-Design-Audit-2026-04-09.md` (prior audit baseline)
- `CLAUDE.md`
- Implementation: `apps/brief-api/src/` (37 files, 3006 lines), `apps/brief/src/` (40 files, 2917 lines), `apps/mcp-server/src/tools/brief-tools.ts`

## Built and working

### Data model

All 11 tables defined in Drizzle schema files under `apps/brief-api/src/db/schema/`. Schema includes `yjs_state` column on `brief_documents` but the column is never read or written by application code. Brief-api has a local `tasks` stub in `bbb-refs.ts` that references `tasks.org_id`, which migration 0078 added to the Bam tasks table.

### REST API endpoints

88% feature-complete. Implemented routes in `apps/brief-api/src/routes/`:
- `document.routes.ts` - CRUD, publish, archive, list with filter/search, content update/append
- `export.routes.ts` - GET /documents/:id/export/markdown, /export/html (65 lines, synchronous)
- `version.routes.ts` - list versions, get version, diff v1/v2 with LCS line-by-line (lines 83-131)
- `link.routes.ts` - manage links to Bam tasks and Beacon articles
- `comment.routes.ts` - document comments
- `folder.routes.ts` - folder CRUD
- `star.routes.ts` - favorite/unfavorite
- `collaborator.routes.ts` - add/remove/list collaborators with permission enum
- `search.routes.ts` - ILIKE keyword search (NOT full-text, NOT semantic)

### MCP tools

18 tools registered in `apps/mcp-server/src/tools/brief-tools.ts`. `brief_update_content` and `brief_append_content` now have functional backend endpoints.

### Frontend components

ExportMenu at `apps/brief/src/components/document/export-menu.tsx` - dropdown with Markdown and HTML export, uses window.open() to trigger download.

LinkedItems at `apps/brief/src/components/document/linked-items.tsx` - displays task and Beacon links, fetches via `useLinks()` hook.

Document editor uses Tiptap with 10 of 13 designed extensions.

### Version diffing

`GET /documents/:id/versions/:v1/diff/:v2` computes LCS-based line-by-line diff and returns JSON with changes array.

### Input validation

Plain text and HTML snapshot fields enforce size limits (`.max(2_000_000)` and `.max(5_000_000)`) per P1-005/006 security audit findings.

## Partial or divergent

### Yjs state column unused

Schema: `brief_documents.yjs_state` (bytea, nullable). Never read or written by application code. No Hocuspocus provider to load/update this column. Database is prepared for collaboration but application never uses it.

### Search implementation (ILIKE only)

Still ILIKE-only in `apps/brief-api/src/services/document.service.ts:545-580`. Design specifies `to_tsvector` GIN index (not created in Drizzle schema) and Qdrant semantic search (not integrated). No pagination in search results (API returns all matches).

### Brief to Beacon graduation simplified

The `promoteToBeacon` endpoint exists but does not match spec:
- **Design:** Render Yjs state to Markdown, call Beacon API, auto-suggest tags from Qdrant, set `source_brief_id`
- **Implementation:** Create minimal `beacon_entries` row with slug + title + org only. No Beacon API call. No tag suggestion. No body content copy. No `source_brief_id` linkage.

### Authorization gaps

- Collaborator permission granularity not fully enforced: a "comment"-level collaborator can likely trigger document updates in some operations.
- `brief_collaborators.permission` enum is view/comment/edit but middleware does not differentiate for all mutation routes.

## Missing

### P0 — Blocks core product value

1. **Yjs/Hocuspocus collaboration engine** (Design Section 5, ~120 lines of spec). Entire collaboration layer unimplemented.
   - No Hocuspocus server; no WebSocket plugin for Fastify.
   - No `apps/brief-api/src/ws/collaboration.ts` module.
   - No `apps/brief-api/src/services/yjs-persistence.ts` for load/save/debounce logic.
   - No awareness protocol (cursors, selections, user presence).
   - Frontend editor operates in local-only mode (no Collaboration or CollaborationCursor Tiptap extensions).
   - No browser package dependencies: hocuspocus, y-websocket, or @yjs/* in `apps/brief/package.json`.
   - **Impact:** Documents are not collaborative by default. Users editing the same document do not see each other's changes in real time. This is the core product feature.

2. **Missing Tiptap editor extensions** (Design Section 6.2). 3 of 13 specified extensions absent:
   - `Mention` (@user autocomplete with org member list)
   - `BamTaskEmbed` (renders Bam tasks as live inline cards)
   - `BeaconEmbed` (renders Beacon references with status)
   - `CalloutBlock` (info/warning/success/error callout blocks)
   - `BanterChannelLink` (resolves `#channel-name` syntax)
   - `SlashCommand` menu (command palette on `/`)
   - `BubbleMenu` (floating toolbar on text selection)

3. **Missing frontend components** (Design Section 9.1):
   - `FolderTree.tsx` - nested folder navigation sidebar (document list shows flat card grid only)
   - `DocumentTable.tsx` - table/list view alternative
   - `SlashCommandMenu.tsx` - command palette for `/` blocks
   - `BubbleMenu.tsx` - floating toolbar on selection
   - `CollaboratorCursors.tsx` - remote cursor overlays
   - `TaskEmbed.tsx` - inline task mini-card
   - `BeaconEmbed.tsx` - inline Beacon reference
   - `ShareToBanterDialog.tsx` - channel picker for sharing
   - `PresenceBar.tsx` - active collaborators with avatars

### P1

4. **Qdrant semantic search integration** - MCP `brief_search` tool accepts `semantic` boolean but API ignores it. No vector embeddings computed or stored.
5. **Background jobs not implemented** (Design Section 10): `brief:embed`, `brief:snapshot`, `brief:export`, `brief:cleanup`.
6. **Shared Zod schemas** - Design specifies `packages/shared/src/brief.ts` for single source of truth between API and frontend. Not created; validation schemas live inline in route files.
7. **Brief to Beacon graduation** needs to call Beacon API, populate source_brief_id, suggest tags from Qdrant.

### P2

8. **Editor state Zustand stores** - Design Section 9.1 specifies `editorStore.ts` and `folderStore.ts`. Both absent; state managed via local React state.
9. **Full-text search via PostgreSQL tsvector** with GIN index as fallback below Qdrant.

## Architectural guidance

### Yjs/Hocuspocus collaboration

Effort estimate: 40-60 hours.

Install dependencies: `@hocuspocus/server`, `y-protocols`, `lib0` server-side. Install `@hocuspocus/provider`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-cursor`, `yjs` client-side.

Server: Create `apps/brief-api/src/ws/collaboration.ts` that registers a Hocuspocus server on the Fastify WebSocket adapter. Register persistence extension that reads `brief_documents.yjs_state` on connect and debounced writes on change (spec says 30-second debounce).

Nginx: Add WebSocket proxy at `/brief/ws` with upgrade headers.

Redis PubSub: For cross-instance sync, use Hocuspocus's Redis extension.

Frontend: In the Tiptap editor, add `Collaboration.configure({ document: yDoc })` and `CollaborationCursor.configure({ provider: hocuspocusProvider, user: {name, color} })` extensions.

### Custom editor nodes

Start with Mention (simplest). Create `apps/brief/src/tiptap/mention.ts` as a Tiptap extension with a custom `NodeView` component. Fetch org members on open from `GET /v1/users` (Bam).

BamTaskEmbed and BeaconEmbed use the same pattern but fetch task/beacon data on mount and render live cards. Embed shape: `<task-embed task-id="...">`. The NodeView component renders a read-only card with title, status, assignee.

### SlashCommand and BubbleMenu

These are standard Tiptap patterns. SlashCommand listens for `/` key and opens a floating menu with command options. BubbleMenu floats over selected text with inline format buttons (bold, italic, link, etc.).

### Qdrant integration

Create `apps/brief-api/src/services/qdrant.service.ts` with `upsertDocument(docId, chunks)`, `searchSimilar(query, limit)`. Background job `brief-embed.job.ts` triggers on document save, chunks text, calls embedding API, upserts to Qdrant.

### Brief to Beacon graduation

Refactor `promoteToBeacon`:
1. Render Yjs state to Markdown via `@tiptap/html` or yjs -> HTML -> Markdown chain.
2. Call Beacon API `POST /v1/beacons` with title, body_markdown, visibility, org_id, created_by.
3. Save returned beacon ID to `brief_documents.source_beacon_id`.
4. Optionally auto-suggest tags via Qdrant similarity search against existing beacons.

## Dependencies

### Inbound

- Beacon promotes from Brief.
- MCP tools expose Brief operations.
- Bam task embeds.
- Banter share dialog.

### Outbound

- Bam API for task lookup.
- Beacon API for promotion.
- Banter API for sharing.
- Qdrant vector DB (future).
- Tiptap editor library (frontend).

## Open questions

1. **Yjs persistence debounce:** Design says 30-second debounce. Is this per document or per edit? Should save also trigger on user disconnect?
2. **Embedding model:** Which embedding model for Qdrant? Anthropic, OpenAI, Cohere, or self-hosted sentence-transformers?
3. **Collaborator permission enforcement:** Should "comment" collaborators be able to edit comments or only add new ones? Should "view" be strictly read-only, or allow starring?
4. **Full-text search priority:** If Qdrant integration is deferred, is PostgreSQL tsvector GIN index sufficient for Phase 1?
5. **Folder tree vs flat:** Flat card grid is simpler but limits large knowledge bases. Is there a size threshold where folder tree becomes essential?
