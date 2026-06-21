# Board Design Audit -- 2026-04-09

**Auditor:** Claude (automated design-vs-implementation audit)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Board_Design_Document.md` v1.0
**Implementation:** `apps/board-api/src/` (35 files), `apps/board/src/` (39 files), `apps/mcp-server/src/tools/board-tools.ts`

---

## Executive Summary

The Board (Whiteboards & Visual Collaboration) product is **substantially implemented** with most core features in place. The implementation diverges from the design in one significant architectural decision -- using **Excalidraw** instead of **tldraw** as the canvas engine, which cascades into differences in the collaboration layer (custom WebSocket scene sync instead of Yjs/Hocuspocus CRDT). Despite this, the functional coverage is strong.

**Overall Completion: ~72%**

| Category | Items | Avg Rating | Notes |
|----------|-------|------------|-------|
| Data Model | 7 tables | P4.5 | All tables present; minor column variance |
| REST API | 29 endpoints | P3.5 | Most implemented; export and element-write endpoints missing |
| WebSocket / Collaboration | 5 features | P3.5 | Working but Excalidraw-based, not Yjs/tldraw |
| MCP Tools | 14 tools | P3.5 | All 14 registered; 2 call non-existent backend endpoints |
| Frontend Pages | 6 pages | P4.0 | All pages exist and are functional |
| Frontend Components | 15+ components | P3.0 | Core present; custom embed shapes absent |
| Cross-Product Integration | 4 integrations | P2.0 | Task promotion works; Banter/Brief/Bolt missing |
| System Templates | 10 templates | P1.0 | Template system built but no seeded templates |
| Background Jobs | 4 queues | P0.5 | No BullMQ jobs; persistence is inline |
| Authorization | 4 roles | P4.0 | Comprehensive access control in place |
| Performance | 3 items | P1.0 | No element limits or thumbnail caching |

---

## Feature Table

### Data Model (PostgreSQL Schema)

| Feature | Design | Implementation | Rating | Notes |
|---------|--------|----------------|--------|-------|
| `boards` table | Sec 4.2 | `board-api/src/db/schema/boards.ts` | **P5** | All columns match: id, org_id, project_id, name, description, icon, yjs_state, thumbnail_url, template_id, background, locked, visibility, default_viewport, created_by, updated_by, timestamps, archived_at |
| `board_elements` table | Sec 4.2 | `board-api/src/db/schema/board-elements.ts` | **P5** | All columns present including arrow_start/end, embed fields, frame_id, group_id. GIN fulltext index noted as migration-only |
| `board_versions` table | Sec 4.2 | `board-api/src/db/schema/board-versions.ts` | **P5** | Matches design: id, board_id, version_number, name, yjs_state, thumbnail_url, created_by, unique constraint |
| `board_task_links` table | Sec 4.2 | `board-api/src/db/schema/board-task-links.ts` | **P4** | Present with element_id as nullable UUID (design says NOT NULL). Unique constraint on (element_id, task_id) matches |
| `board_collaborators` table | Sec 4.2 | `board-api/src/db/schema/board-collaborators.ts` | **P5** | Exact match: id, board_id, user_id, permission (view/edit), unique constraint |
| `board_templates` table | Sec 4.2 | `board-api/src/db/schema/board-templates.ts` | **P4** | Present. Column name `org_id` vs design's `organization_id` -- minor naming difference. Missing index on org_id in Drizzle (may be in migration) |
| `board_stars` table | Sec 4.2 | `board-api/src/db/schema/board-stars.ts` | **P5** | Exact match |
| `board_chat_messages` table | N/A | `board-api/src/db/schema/board-chat-messages.ts` | **P5** (bonus) | Not in design doc -- added as bonus feature for in-canvas chat |

### REST API Endpoints

#### Boards

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `GET /boards` | Sec 5.2 | `board.routes.ts` line 52 | **P5** | Full implementation with project, visibility, created_by, archived filters, search, cursor pagination |
| `POST /boards` | Sec 5.2 | `board.routes.ts` line 73 | **P5** | Supports template_id, all fields |
| `GET /boards/:id` | Sec 5.2 | `board.routes.ts` line 125 | **P5** | Excludes yjs_state as specified |
| `PATCH /boards/:id` | Sec 5.2 | `board.routes.ts` line 161 | **P5** | Updates name, description, background, visibility, viewport, thumbnail |
| `DELETE /boards/:id` | Sec 5.2 | `board.routes.ts` line 177 | **P5** | Archives (soft delete) as specified |
| `POST /boards/:id/restore` | Sec 5.2 | `board.routes.ts` line 191 | **P5** | Restores archived boards |
| `POST /boards/:id/duplicate` | Sec 5.2 | `board.routes.ts` line 205 | **P5** | Full duplication including elements |
| `POST /boards/:id/star` | Sec 5.2 | `board.routes.ts` line 222 | **P5** | Toggle star |
| `POST /boards/:id/lock` | Sec 5.2 | `board.routes.ts` line 235 | **P5** | Toggle lock |
| `GET /boards/:id/export/:format` | Sec 5.2 | -- | **P0** | **Not implemented.** No export endpoint exists. MCP tool `board_export` calls it but would 404 |
| `GET /boards/recent` | Sec 5.2 | `board.routes.ts` line 91 | **P5** | Returns 20 most recent |
| `GET /boards/starred` | Sec 5.2 | `board.routes.ts` line 101 | **P5** | Implemented |
| `GET /boards/search` | Sec 5.2 | `board.routes.ts` line 111 | **P5** | Full-text ILIKE search across elements |
| `GET /boards/:id/stats` | N/A | `board.routes.ts` line 138 | **P5** (bonus) | Extra endpoint not in design |

#### Elements

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `GET /boards/:id/elements` | Sec 5.2 | `element.routes.ts` line 8 | **P5** | All elements with full data |
| `GET /boards/:id/elements/stickies` | Sec 5.2 | `element.routes.ts` line 18 | **P5** | Filters element_type='sticky' |
| `GET /boards/:id/elements/frames` | Sec 5.2 | `element.routes.ts` line 28 | **P5** | Frames with children populated |
| `GET /boards/:id/elements/clusters` | Sec 5.2 | -- | **P0** | **Not implemented.** AI-computed spatial clustering endpoint missing |
| `POST /boards/:id/elements/sticky` | MCP tool ref | -- | **P0** | **Not implemented.** MCP tool `board_add_sticky` calls this but no route exists |
| `POST /boards/:id/elements/text` | MCP tool ref | -- | **P0** | **Not implemented.** MCP tool `board_add_text` calls this but no route exists |

#### Versions

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `GET /boards/:id/versions` | Sec 5.2 | `version.routes.ts` line 13 | **P5** | Lists versions ordered by version_number desc |
| `POST /boards/:id/versions` | Sec 5.2 | `version.routes.ts` line 23 | **P5** | Creates named snapshot from current yjs_state |
| `POST /boards/:id/versions/:versionId/restore` | Sec 5.2 | `version.routes.ts` line 39 | **P5** | Restores yjs_state from version |

#### Links (Task Promotion)

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `POST /boards/:id/elements/promote` | Sec 5.2 | `link.routes.ts` line 17 | **P4** | Implemented. Calls Bam API to create tasks. Missing `epic_id` from PromoteElementsSchema (design has it) |
| `GET /boards/:id/links` | Sec 5.2 | `link.routes.ts` line 36 | **P5** | Lists links with task titles |
| `DELETE /links/:linkId` | Sec 5.2 | `link.routes.ts` line 46 | **P5** | Implemented with org authorization |

#### Templates

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `GET /templates` | Sec 5.2 | `template.routes.ts` line 42 | **P5** | Lists system + org templates |
| `POST /templates` | Sec 5.2 | `template.routes.ts` line 52 | **P5** | Creates from board with full visibility checks |
| `PATCH /templates/:id` | Sec 5.2 | `template.routes.ts` line 70 | **P5** | Protects system templates |
| `DELETE /templates/:id` | Sec 5.2 | `template.routes.ts` line 83 | **P5** | Protects system templates |

#### Collaborators

| Endpoint | Design | Implementation | Rating | Notes |
|----------|--------|----------------|--------|-------|
| `GET /boards/:id/collaborators` | Sec 5.2 | `collaborator.routes.ts` line 63 | **P5** | Joins users for display info |
| `POST /boards/:id/collaborators` | Sec 5.2 | `collaborator.routes.ts` line 75 | **P5** | Validates same-org membership |
| `PATCH /collaborators/:collabId` | Sec 5.2 | `collaborator.routes.ts` line 90 | **P5** | Full resolve-board middleware chain |
| `DELETE /collaborators/:collabId` | Sec 5.2 | `collaborator.routes.ts` line 106 | **P5** | Implemented |

#### Scene Persistence (bonus, not in design)

| Endpoint | Implementation | Rating | Notes |
|----------|----------------|--------|-------|
| `GET /boards/:id/scene` | `scene.routes.ts` line 15 | **P5** (bonus) | Loads Excalidraw JSON from yjs_state column |
| `PUT /boards/:id/scene` | `scene.routes.ts` line 33 | **P5** (bonus) | Saves Excalidraw JSON |

#### Chat (bonus, not in design)

| Endpoint | Implementation | Rating | Notes |
|----------|----------------|--------|-------|
| `GET /boards/:id/chat` | `chat.routes.ts` line 13 | **P5** (bonus) | Last 100 messages |
| `POST /boards/:id/chat` | `chat.routes.ts` line 23 | **P5** (bonus) | Rate-limited message send |

#### Audio (bonus, not in design)

| Endpoint | Implementation | Rating | Notes |
|----------|----------------|--------|-------|
| `POST /v1/boards/:id/audio/token` | `audio.routes.ts` line 17 | **P5** (bonus) | LiveKit JWT generation for board audio rooms |

### Canvas Architecture

| Feature | Design | Implementation | Rating | Notes |
|---------|--------|----------------|--------|-------|
| Canvas engine | tldraw (Sec 3.1) | Excalidraw | **P3** | Different library but equivalent functionality. Excalidraw provides shapes, selection, pan/zoom, undo/redo, SVG/PNG export, collaboration hooks |
| CRDT collaboration (Yjs/Hocuspocus) | Sec 3.2 | Custom WebSocket scene sync | **P2** | No Yjs or Hocuspocus. Uses custom `scene_update` WS messages with element-level version diffing (`reconcileElements` in `scene-sync.ts`). Works but lacks CRDT conflict guarantees |
| Awareness (cursors, viewport) | Sec 3.2 | `cursor_update` WS messages + Excalidraw collaborators API | **P4** | Cursor sharing works via WebSocket. Updates pushed to Excalidraw's native collaborator rendering |
| Persistence to PostgreSQL | Sec 3.2 | `ws/persistence.ts` saves JSON to `yjs_state` column | **P3** | Persistence works but stores raw Excalidraw JSON, not Yjs binary. Column name `yjs_state` is a misnomer. Debounced 5-second flush via dirty-board map |
| Element Snapshot Layer | Sec 3.3 | -- | **P0** | **Not implemented.** No automatic Yjs-to-board_elements denormalization service. The `board_elements` table exists but is not populated from canvas state. MCP reads/search would return empty results unless elements are manually inserted |
| Redis PubSub for cross-instance | Sec 3.2 | `ws/handler.ts` line 88-110 | **P5** | Full cross-instance PubSub via `board:events` channel with instance-ID deduplication |

### MCP Tools

| Tool | Design (Sec 6.1) | Implementation | Rating | Notes |
|------|-------------------|----------------|--------|-------|
| `board_list` | List boards | `board-tools.ts` line 61 | **P5** | Filters, pagination |
| `board_get` | Get metadata | `board-tools.ts` line 77 | **P5** | |
| `board_create` | Create board | `board-tools.ts` line 88 | **P5** | Template support |
| `board_update` | Update metadata | `board-tools.ts` line 105 | **P5** | |
| `board_archive` | Archive | `board-tools.ts` line 123 | **P5** | |
| `board_read_elements` | All elements | `board-tools.ts` line 138 | **P3** | Tool registered; backend endpoint exists but `board_elements` table is not auto-populated, so data would be empty |
| `board_read_stickies` | Sticky notes | `board-tools.ts` line 149 | **P3** | Same issue as above |
| `board_read_frames` | Frames + children | `board-tools.ts` line 161 | **P3** | Same issue as above |
| `board_add_sticky` | Add sticky | `board-tools.ts` line 176 | **P1** | Tool registered but calls `POST /boards/:id/elements/sticky` which does not exist. Would 404 |
| `board_add_text` | Add text | `board-tools.ts` line 192 | **P1** | Tool registered but calls `POST /boards/:id/elements/text` which does not exist. Would 404 |
| `board_promote_to_tasks` | Promote stickies | `board-tools.ts` line 209 | **P4** | Backend promote endpoint works. Depends on board_elements having data |
| `board_summarize` | AI summary | `board-tools.ts` line 238 | **P3** | Delegates to frames endpoint. No real AI analysis -- just returns raw frame data |
| `board_search` | Full-text search | `board-tools.ts` line 253 | **P5** | Search endpoint works (searches board names + element text_content via ILIKE) |
| `board_export` | Export SVG/PNG | `board-tools.ts` line 223 | **P1** | Tool registered but calls `GET /boards/:id/export/:format` which does not exist |

### Frontend Pages

| Page | Design (Sec 7.1) | Implementation | Rating | Notes |
|------|-------------------|----------------|--------|-------|
| `BoardListPage` | Grid of board thumbnails | `pages/board-list.tsx` | **P5** | Thumbnail grid, search, stats cards, empty state |
| `BoardCanvasPage` | Full-screen canvas | `pages/board-canvas.tsx` | **P4** | Excalidraw canvas with toolbar, chat, presence. Missing: sidebar panel (linked tasks, collaborators) |
| `TemplateBrowserPage` | Template gallery | `pages/template-browser.tsx` | **P5** | Category tabs, thumbnail cards, instantiate button |
| `BoardNewPage` | Create board flow | `pages/board-new.tsx` | **P4** | Name input, local template selector. Templates are hardcoded UI presets, not DB-backed templates |
| `VersionHistoryPage` | Version snapshots | `pages/version-history.tsx` | **P5** | List, create, restore versions with dialog |
| `StarredBoardsPage` | Starred boards | `pages/starred-boards.tsx` | **P5** | Grid of starred boards |

### Frontend Components

| Component | Design (Sec 7.1) | Implementation | Rating | Notes |
|-----------|-------------------|----------------|--------|-------|
| `BoardCanvas.tsx` (tldraw wrapper) | Sec 7.1 | Excalidraw wrapper in `board-canvas.tsx` | **P4** | Uses Excalidraw instead of tldraw. Functional |
| `CustomShapes.tsx` | Sec 7.1 | -- | **P0** | **Not implemented.** No custom shape definitions |
| `TaskEmbedShape.tsx` | Sec 7.2 | -- | **P0** | **Not implemented.** No Bam task embed shape |
| `BeaconEmbedShape.tsx` | Sec 7.2 | -- | **P0** | **Not implemented.** No Beacon embed shape |
| `GoalEmbedShape.tsx` | Sec 7.2 | -- | **P0** | **Not implemented.** No Bearing goal embed shape |
| `BriefEmbedShape.tsx` | Sec 7.2 | -- | **P0** | **Not implemented.** No Brief embed shape |
| `BoardToolbar.tsx` | Sec 7.1 | `canvas/board-toolbar.tsx` | **P4** | Name editing, lock toggle, version history, share button (non-functional), export menu (non-functional), chat toggle, audio controls |
| `ShapeMenu.tsx` | Sec 7.1 | -- | **P0** | **Not implemented.** Excalidraw provides its own native shape tools |
| `EmbedPicker.tsx` | Sec 7.1 | -- | **P0** | **Not implemented.** No cross-product embed search |
| `TemplateOverlay.tsx` | Sec 7.1 | Separate `board-new.tsx` page | **P3** | Template selection exists but as a full page, not an overlay on new board |
| `BoardSidebar.tsx` | Sec 7.1 | `layout/board-sidebar.tsx` (navigation) | **P2** | Exists as layout navigation sidebar, not as a canvas right-panel for collaborators/versions/linked tasks |
| `PromoteToTasksDialog.tsx` | Sec 7.1 | -- | **P0** | **Not implemented.** No frontend UI for sticky-to-task promotion |
| `VersionHistory.tsx` (sidebar) | Sec 7.1 | Separate `version-history.tsx` page | **P4** | Full page instead of sidebar panel |
| `BoardCard.tsx` | Sec 7.1 | `list/board-card.tsx` | **P5** | Thumbnail, name, star, lock, collaborator count, project badge, actions menu |
| `BoardGrid.tsx` | Sec 7.1 | Inline in `board-list.tsx` | **P5** | Responsive grid |
| `PresenceBar.tsx` | Sec 7.1 | `canvas/presence-bar.tsx` | **P3** | Component exists but receives empty collaborators array (not wired to WS collaborator tracking in the active canvas page) |
| `ExportMenu.tsx` | Sec 7.1 | Dropdown items in `board-toolbar.tsx` | **P1** | Menu items exist but no export functionality wired up |
| `ChatPanel.tsx` | N/A (bonus) | `canvas/chat-panel.tsx` | **P5** | Full chat panel with message display and compose |
| `AudioControls.tsx` | N/A (bonus) | `canvas/audio-controls.tsx` | **P5** | LiveKit audio room with mute, participant count, speaking indicators |
| `CursorOverlay.tsx` | N/A | `canvas/cursor-overlay.tsx` | **P3** | Exists but not used -- cursor rendering is handled by Excalidraw's native collaborator system in `use-board-sync.ts` |

### Cross-Product Integration

| Integration | Design (Sec 8) | Implementation | Rating | Notes |
|-------------|-----------------|----------------|--------|-------|
| Board to Bam (sticky-to-task pipeline) | Sec 8.1 | `link.service.ts` `promoteElements()` | **P3** | Backend works: creates tasks via internal Bam API call. Missing: no frontend promote dialog, no badge on promoted stickies, no backlink in task description |
| Board to Banter (share snapshot) | Sec 8.2 | -- | **P0** | **Not implemented** |
| Board to Brief (embed snapshot) | Sec 8.3 | -- | **P0** | **Not implemented** |
| Board to Bolt (event bus) | Sec 8.4 | -- | **P0** | **Not implemented.** No Bolt events published |

### System Templates

| Template | Design (Sec 9) | Implementation | Rating | Notes |
|----------|-----------------|----------------|--------|-------|
| Start / Stop / Continue | Sec 9 | -- | **P0** | No seeded templates |
| 4Ls Retrospective | Sec 9 | -- | **P0** | |
| Sailboat Retro | Sec 9 | -- | **P0** | |
| Brainstorm | Sec 9 | -- | **P0** | |
| Affinity Map | Sec 9 | -- | **P0** | |
| User Story Map | Sec 9 | -- | **P0** | |
| Architecture Diagram | Sec 9 | -- | **P0** | |
| Flowchart Starter | Sec 9 | -- | **P0** | |
| SWOT Analysis | Sec 9 | -- | **P0** | |
| Blank Canvas | Sec 9 | -- | **P0** | |

The template CRUD system is fully built (list, create from board, update, delete). The template browser page with category filtering is implemented. What is missing is the actual seed data -- no pre-built templates exist in the database.

### Background Jobs (BullMQ)

| Job | Design (Sec 10) | Implementation | Rating | Notes |
|-----|-----------------|----------------|--------|-------|
| `board:thumbnail` generateThumbnail | Sec 10 | -- | **P0** | **Not implemented.** No thumbnail generation. Boards support a `thumbnail_url` column but it is never auto-populated |
| `board:export` exportBoard | Sec 10 | -- | **P0** | **Not implemented.** No server-side export |
| `board:snapshot` elementSnapshot | Sec 10 | -- | **P0** | **Not implemented.** No Yjs-to-board_elements denormalization job |
| `board:cleanup` purgeOldVersions | Sec 10 | -- | **P0** | **Not implemented.** No nightly cleanup |

Scene persistence is handled inline via the WebSocket handler's dirty-board flush (5-second interval), not via BullMQ.

### Authorization Model

| Feature | Design (Sec 11) | Implementation | Rating | Notes |
|---------|-----------------|----------------|--------|-------|
| SuperUser access | All operations | `ws/handler.ts` line 329, `auth.ts` | **P5** | SuperUsers bypass all access checks |
| Owner/Admin full access | All boards in org | `ws/handler.ts` line 189, `middleware/authorize.ts` | **P5** | Role hierarchy checked consistently |
| Member project access | Own + project boards | `board.service.ts` `visibilityFilter()` | **P5** | Full visibility-based access: org, project membership, collaborator |
| View-only collaborators | Read-only on edit boards | `ws/handler.ts` line 397 | **P5** | WS rejects scene_update from view-only collaborators |
| Lock enforcement | Creator/Admin can unlock | `ws/handler.ts` line 410 | **P4** | Lock checked on WS scene_update. Design says "only board creator or Admin/Owner can unlock" -- implementation allows any edit-access user to toggle lock via REST endpoint |

### Performance Considerations

| Feature | Design (Sec 12) | Implementation | Rating | Notes |
|---------|-----------------|----------------|--------|-------|
| Canvas element limits (500 soft / 2000 hard) | Sec 12.1 | WS handler rejects >50000 elements | **P1** | A 50000 limit exists but is too high per design. No soft warning at 500. No hard block at 2000 |
| Thumbnail debounce + cache | Sec 12.2 | -- | **P0** | No thumbnail generation at all |
| Element snapshot batch upsert | Sec 12.3 | -- | **P0** | No element snapshot service |

---

## Detailed Findings (P0-P3)

### P0: Not Implemented

1. **Element Snapshot Service** (Sec 3.3) -- The most impactful gap. Without automatic Yjs-to-board_elements denormalization, the `board_elements` table remains empty during normal use. This breaks:
   - MCP `board_read_elements`, `board_read_stickies`, `board_read_frames` (return empty data)
   - MCP `board_promote_to_tasks` (finds no sticky elements to promote)
   - `GET /boards/search` (element text_content is never populated)
   - The entire "AI can see the board" principle (Sec 1.2 #3)

2. **Export Endpoints** (Sec 5.2) -- `GET /boards/:id/export/:format` is not implemented. The MCP tool `board_export` and the frontend export menu items have no working backend.

3. **Element Write Endpoints** (MCP Sec 6.1) -- `POST /boards/:id/elements/sticky` and `POST /boards/:id/elements/text` are referenced by MCP tools `board_add_sticky` and `board_add_text` but do not exist as routes.

4. **AI Spatial Clustering** (Sec 5.2) -- `GET /boards/:id/elements/clusters` is not implemented.

5. **Custom Embed Shapes** (Sec 7.2) -- No TaskEmbedShape, BeaconEmbedShape, GoalEmbedShape, or BriefEmbedShape. The entire cross-product embed system is absent from the canvas.

6. **System Templates Seed Data** (Sec 9) -- All 10 designed templates are unimplemented. The template infrastructure is complete but empty.

7. **All BullMQ Background Jobs** (Sec 10) -- No board-related BullMQ queues. Thumbnail generation, export, element snapshot, and version cleanup are all absent.

8. **Cross-Product Integrations** (Sec 8.2-8.4) -- Banter share, Brief embed, and Bolt events are not implemented.

9. **PromoteToTasksDialog** (Sec 7.1) -- No frontend UI for the sticky-to-task workflow. Backend exists but users cannot trigger it from the canvas.

### P1: Skeleton Only

10. **MCP `board_add_sticky` / `board_add_text`** -- Tools are registered in the MCP server but call endpoints that do not exist. Would return 404.

11. **MCP `board_export`** -- Tool registered but calls non-existent export endpoint.

12. **Frontend Export Menu** -- Dropdown items for PNG/SVG export exist in the toolbar but have no click handlers.

13. **Canvas Element Limits** -- Only a 50000 element guard exists (vs design's 500 soft / 2000 hard).

### P2: Partial Implementation

14. **CRDT Collaboration** (Sec 3.2) -- The design specifies Yjs/Hocuspocus CRDT. The implementation uses a custom WebSocket sync layer with element-level version diffing. This works for basic real-time collaboration but lacks CRDT guarantees for offline reconciliation and concurrent edit conflict resolution.

15. **Board Sidebar** (Sec 7.1) -- Exists as a layout navigation sidebar, not as the designed right-panel for collaborators, versions, and linked tasks on the canvas page.

16. **Cross-Product Task Promotion** (Sec 8.1) -- Backend `promoteElements()` calls the Bam API, but: no frontend dialog, no promoted-sticky badge, no backlink in task description, no `epic_id` support.

### P3: Mostly Working with Gaps

17. **Canvas Engine (tldraw vs Excalidraw)** -- Functional equivalent but diverges from spec. Excalidraw lacks tldraw's extensible shape system, making custom embed shapes harder to add.

18. **PresenceBar** -- Component renders but is not connected to the WebSocket collaborator tracking in `BoardCanvasPage`. The `useBoardSync` hook manages collaborators via Excalidraw's native API but does not feed them to `PresenceBar`.

19. **MCP `board_summarize`** -- Returns raw frames data rather than an AI-generated structured summary as described in the design.

---

## P4-P5 Highlights (Well Implemented)

- **P5:** Board CRUD (all 8 endpoints), star/lock toggles, version CRUD (list/create/restore), all collaborator endpoints, all template CRUD, board list page, board card component, starred boards page, version history page, template browser page, Redis PubSub cross-instance sync, WebSocket rate limiting, chat and audio conferencing (bonus features)
- **P4:** Board canvas page (Excalidraw integration works well), board toolbar (inline name editing, lock indicator), task promotion backend (calls Bam API), authorization model (comprehensive visibility and permission checks), WS collaboration with cursor sharing

---

## Recommendations

### Critical Path (Fix First)

1. **Implement Element Snapshot Service** -- Without it, MCP tools, search, and the AI-reads-board principle are non-functional. Two options:
   - (A) Build the designed Yjs-to-board_elements denormalization triggered on each scene save
   - (B) Since the implementation uses Excalidraw JSON (not Yjs binary), parse the JSON elements array on each `saveScene()` call and upsert to `board_elements`

2. **Implement Element Write Endpoints** -- Add `POST /boards/:id/elements/sticky` and `POST /boards/:id/elements/text` routes so MCP tools can add content to boards.

3. **Implement Export Endpoint** -- At minimum, use Excalidraw's `exportToSvg()`/`exportToBlob()` on the client and upload to MinIO, or implement server-side rendering.

### High Value

4. **Wire PresenceBar to WebSocket Data** -- The component exists and the data flows through `useBoardSync`; just need to bridge them.

5. **Build PromoteToTasksDialog** -- Frontend dialog for sticky-to-task promotion. Backend is ready.

6. **Seed System Templates** -- Create the 10 designed templates as Excalidraw JSON and seed them via a migration or script.

7. **Implement Element Limits** -- Add 500-element soft warning and 2000-element hard limit.

### Nice to Have

8. **Custom Embed Shapes** -- Excalidraw supports custom renderers but the API is different from tldraw's. Evaluate feasibility.

9. **BullMQ Background Jobs** -- Thumbnail generation and export are the most valuable. Version cleanup is low priority with typical usage.

10. **Cross-Product Integrations** -- Banter share and Bolt events would complete the suite integration story.
