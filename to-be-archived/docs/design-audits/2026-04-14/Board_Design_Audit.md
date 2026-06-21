# Board Design Audit (2026-04-14)

## Summary

Board (Visual Collaboration Whiteboards) is substantially implemented with core functionality complete. The most significant architectural divergence from the design is Excalidraw-based canvas instead of tldraw, with custom WebSocket scene sync instead of Yjs/Hocuspocus CRDT. This deviation cascades meaningfully: element snapshot denormalization, thumbnail generation, and cross-product embed shapes are architectural impacts that remain incomplete. The sticky-to-task promotion backend works but lacks frontend UI. Overall completion: approximately 68% (down from the prior 72% audit due to clarification of what "working" means for Yjs vs Excalidraw collaboration).

## Design sources consulted

- `docs/early-design-documents/Board_Design_Document.md` (v1.0, April 7, 2026)
- `docs/board-development-plan.md` (supplemental architecture notes)
- `docs/design-audits/2026-04-09/Board-Design-Audit-2026-04-09.md` (prior audit baseline)
- `CLAUDE.md` (confirms Excalidraw, not tldraw)
- Migration files: `0031_board_tables.sql`, `0032_board_system_templates.sql`, `0040_board_template_seeds.sql`

## Built and working

### REST API

All board CRUD endpoints fully implemented in `apps/board-api/src/routes/board.routes.ts`:
- GET/POST /boards (list, create with template support, pagination)
- GET/PATCH/DELETE /boards/:id (read, update metadata, soft-delete archive)
- POST /boards/:id/restore, /duplicate, /star, /lock
- GET /boards/recent, /starred, /search

Collaborator endpoints in `collaborator.routes.ts`: add/remove/update with permission gating (view/edit), unique constraint on (board_id, user_id).

Version management in `version.routes.ts`: create named snapshots with full yjs_state capture, restore to prior version, list with pagination.

Task link management in `link.routes.ts`: promote elements to Bam tasks (backend calls internal Bam API), list/delete links.

Template CRUD in `template.routes.ts`: list system + org-scoped templates, create from current board, update/delete (system protected).

### Database schema

All 8 designed tables present with correct structure:
- `boards` (yjs_state column storing Excalidraw JSON, visibility, locked, template_id)
- `board_elements` (snapshot table with text_content, position, frame/group, arrow/embed metadata)
- `board_versions` (version history, unique board_id + version_number)
- `board_task_links` (element-to-task mapping)
- `board_collaborators` (view/edit permission model)
- `board_templates` (system and org-scoped)
- `board_stars` (favorites)
- `board_chat_messages` (bonus feature, not in design)

Full-text search index on `board_elements.text_content` via GIN.

### Frontend pages

- `BoardListPage` (board-list.tsx) - grid with search, stats, empty state
- `BoardCanvasPage` (board-canvas.tsx) - Excalidraw canvas with toolbar, chat, audio
- `TemplateBrowserPage` (template-browser.tsx) - category-filtered template gallery
- `VersionHistoryPage` (version-history.tsx) - snapshot list/create/restore
- `StarredBoardsPage` (starred-boards.tsx)
- `BoardNewPage` (board-new.tsx) - board creation with template selection

### WebSocket collaboration (working with different implementation)

- Custom scene sync via WebSocket `scene_update` messages with element-level diffing
- Cursor tracking via `cursor_update` messages with color assignment
- Presence tracking (active collaborators with display names and colors)
- Redis PubSub for cross-instance broadcasting with instance ID deduplication
- 5-second debounced persistence flush to PostgreSQL
- Chat message channel on same WebSocket connection
- Rate limiting: 120 messages per 10-second window

### Element snapshot service

`element-snapshot.service.ts` functional:
- Deserializes Excalidraw JSON (not Yjs binary) from boards.yjs_state
- Maps Excalidraw element types to board_elements types (rectangle -> shape, text -> text, arrow -> connector, frame -> frame)
- Extracts text content, position, dimensions, frame/group associations
- Upserts to `board_elements` in 100-element batches
- Deletes stale rows for elements no longer in scene
- Triggered on each `saveScene()` call via fire-and-forget

### Authorization model

- SuperUser bypass
- Owner/Admin full org access
- Member project-scoped access
- Visibility rules: private (collaborators only), project (project members), organization (org members)
- Lock enforcement on WebSocket scene_update
- Collaborator permission gates on routes

### Chat and audio (bonus)

- Chat messages stored in `board_chat_messages` and delivered via WebSocket
- LiveKit room per board (room name = board ID, auto-join on board open)
- Audio token generation via `audio.routes.ts`
- Mute controls and speaking indicators in frontend

### MCP tools (14 registered)

All 14 tools in `board-tools.ts`: board_list, board_get, board_create, board_update, board_archive, board_read_elements, board_read_stickies, board_read_frames, board_add_sticky, board_add_text, board_promote_to_tasks, board_summarize, board_search, board_export.

Tool resolver functions handle UUID-or-name inputs for board and template IDs.

## Partial or divergent

### Canvas engine: Excalidraw vs tldraw

**Design specifies:** tldraw with native Yjs CRDT, extensible shape system, cursor/viewport tracking via Awareness protocol.

**Implementation:** Excalidraw (MIT open-source) with custom WebSocket sync and element-level version diffing. Works for basic real-time collaboration but differs in:
- No CRDT guarantees for offline reconciliation or concurrent edit conflict resolution
- Yjs binary column name is semantically misleading (stores Excalidraw JSON, not Yjs)
- Lacks tldraw's extensible custom shape API (impacts embed shapes)

**Impact:** Functional for single org, single project use cases. Conflict resolution relies on last-write-wins semantics with 5-second debounce.

### CRDT collaboration architecture

**Design:** Yjs WebSocket provider (Hocuspocus pattern), Awareness for cursors/viewports, persistence of Yjs binary.

**Implementation:** Custom sync with `dirtyBoards` map of boards with pending saves, scene updates broadcast as JSON via WebSocket, cursor position synced as separate `cursor_update` messages, no Awareness protocol.

**Impact:** Simpler to reason about, lower operational complexity, but no CRDT guarantees. Adequate for live synchronization in small teams but not suitable for offline-heavy or high-concurrency scenarios.

### Cross-product task promotion

**Design (Sec 8.1):** Promote sticky notes to Bam tasks with title from sticky text, description including board backlink, optional epic/phase assignment, promoted sticky gets badge showing task key.

**Implementation:** Backend (`link.service.ts promoteElements()`) calls Bam API and creates tasks. Missing:
- Frontend `PromoteToTasksDialog` - no UI for selecting stickies and choosing epic/phase
- Promoted sticky badge - no visual indicator on canvas after promotion
- Backlink in task description

## Missing

### P0

1. **Export endpoints** (Sec 5.2) - `GET /boards/:id/export/:format` does not exist. MCP tool `board_export` has no working backend. Design requires SVG/PNG/PDF renders.
2. **Element write endpoints** (Sec 5.2) - `POST /boards/:id/elements/sticky` and `POST /boards/:id/elements/text` missing. MCP tools `board_add_sticky` and `board_add_text` call non-existent routes.
3. **Spatial clustering** (Sec 5.2) - `GET /boards/:id/elements/clusters` not implemented. MCP `board_summarize` has no backing for AI-computed clustering.
4. **Custom embed shapes** (Sec 7.2) - TaskEmbedShape, BeaconEmbedShape, GoalEmbedShape, BriefEmbedShape absent. Cannot embed live Bam task cards, Beacon articles, Bearing goals, Brief documents on canvas.
5. **PromoteToTasksDialog** (Sec 7.1) - No frontend dialog for sticky-to-task workflow.
6. **Thumbnail generation** (Sec 10) - No BullMQ job for `board:thumbnail`. `boards.thumbnail_url` never auto-populated.
7. **Background jobs** (Sec 10) - No BullMQ queues for `board:export`, `board:snapshot`, `board:cleanup`.
8. **System template seeds** (Sec 9) - 10 designed templates listed in DB but with NULL yjs_state. Migration 0040 adds metadata (names/descriptions) but not template content.
9. **Cross-product integrations** (Sec 8.2-8.4): Board-to-Banter, Board-to-Brief, Board-to-Bolt (`board.created`, `board.locked`, `board.elements_promoted` events).

### P1

- MCP `board_add_sticky`/`board_add_text`/`board_export` - registered but backing routes missing.
- Export menu items in `board-toolbar.tsx` dropdown exist but no click handlers.
- Canvas element limits: only 50,000-element hard guard exists (vs design's 500 soft, 2,000 hard).

### P2

- Sidebar panel (Sec 7.1) - Design specifies right-panel sidebar showing collaborators, versions, linked tasks.
- PresenceBar component exists but not wired to WebSocket collaborator tracking.
- Element limits and warnings at 500 soft / 2,000 hard.

## Architectural guidance

### Thumbnail generation

Two viable options: (a) client-side `Excalidraw.exportToBlob()` and upload to MinIO on scene save. (b) server-side Puppeteer/Playwright rendering of the scene from JSON. Option (a) is lower infrastructure but requires every client to generate. Option (b) is more consistent but adds a heavy dependency. Recommend (a) for simplicity with fallback to (b) for large boards.

### Element snapshot integrity

The element snapshot service is well-designed and fire-and-forget (does not block WebSocket persistence). For boards with 500+ elements, upsert batching (100 elements per batch) is correct. No index on `frame_id` yet, which may impact "elements in frame" lookups. Consider adding `CREATE INDEX IF NOT EXISTS idx_board_elements_frame ON board_elements(frame_id) WHERE frame_id IS NOT NULL` as a performance improvement.

### Custom embed shapes feasibility

Excalidraw's custom renderer API is less extensible than tldraw's. Options: (a) Build embed shapes as overlaid DOM elements above the canvas, positioned to follow canvas transform. (b) Use Excalidraw's image element type with a fetched screenshot fallback. (c) Render embed shapes as static images that update on click. Recommend (a) for interactivity.

### Export endpoint

Implement `GET /boards/:id/export/:format` with format in `{svg, png, pdf}`. Server-side: load yjs_state (Excalidraw JSON), run headless export via the Excalidraw library or a Puppeteer render of a minimal HTML wrapper. Return the file as a download. Consider queuing via BullMQ for large boards to avoid request timeout.

## Dependencies

**External:**
- Excalidraw (canvas library, not in monorepo)
- LiveKit SFU (video/audio at `infra/livekit/livekit.yaml`)
- Redis 7 (PubSub for cross-instance sync)
- PostgreSQL 16 (all board tables)
- MinIO (for export file storage, currently unused)

**Internal:**
- Bam API (task creation during promotion)
- Banter, Brief, Bolt APIs (not yet integrated)
- MCP server (14 board tools, all registered)

## Open questions

1. **Thumbnail generation strategy:** Client-side `Excalidraw.exportToBlob()` plus MinIO upload, or server-side Puppeteer render?
2. **Custom embed shapes feasibility:** Overlaid DOM elements, image placeholder, or something else?
3. **Element limits enforcement:** Is the 50,000 element guard intentional for power users, or should design's 500 soft / 2,000 hard limits be enforced?
4. **Bolt event publishing:** Should `board.created`, `board.locked`, `board.elements_promoted` fire now or defer to a later phase?
5. **Template content delivery:** Should templates be pre-built Excalidraw scenes seeded via migration, or created on-demand from a library?
6. **Cross-instance scene conflicts:** Is last-write-wins acceptable, or should version checking be added?
