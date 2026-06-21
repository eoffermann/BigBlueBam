# Board — App Dossier

Research dossier for the writer. Everything below is grounded in repo source;
file paths are absolute. "NOT in code" / "doc-only" flags mark anything the
marketing/guide claims that the code does not back up.

---

## 1. App identity

- **app_key:** `board`
- **Display name:** `Board` (sidebar logo label literally "Board"; guide/marketing title "Board (Visual Collaboration)").
- **Category:** Whiteboards & collaboration.
- **Status:** **BETA** — the sidebar renders a yellow `beta` chip next to the logo (`apps/board/src/components/layout/board-sidebar.tsx:118-121`).
- **SPA path:** `/board/`. Canvas deep-link: `/board/:boardId`; version history: `/board/:boardId/versions`.
- **API path:** `/board/api/` -> board-api Fastify service, internal :4008, routes mounted under `/v1` (`apps/board-api/src/server.ts:112-122`).
- **WebSocket:** `/board/ws` (real-time canvas sync; raw WS + Redis PubSub). Handler `apps/board-api/src/ws/handler.ts`.
- **Engine:** Canvas is **Excalidraw** (`@excalidraw/excalidraw`), embedded in `apps/board/src/pages/board-canvas.tsx`. Scenes are stored as Excalidraw JSON inside `boards.yjs_state` (a `bytea` column — despite the name it holds UTF-8 Excalidraw JSON today, NOT Yjs CRDT state; Yjs is reserved for a future live-multiplayer layer).
- **Prerequisites:**
  - A logged-in BigBlueBam session. Board has **no login of its own** — it reads the shared Bam session cookie and, if unauthenticated, shows a "Please log in to BigBlueBam first" screen with a link to `/b3/` (`apps/board/src/app.tsx:135-147`).
  - Permissions come from Bam: Board fetches `/b3/api/auth/me` for the per-action permission matrix (`apps/board/src/main.tsx:30-34`).
  - Projects, project members, phases, and tasks all live in Bam; Board references them (board can be scoped to a Bam project, stickies promote into Bam tasks).

---

## 2. Key concepts & vocabulary

- **Board** — one infinite-canvas whiteboard. Has: name, description, icon (emoji, <=10 chars), background pattern, visibility, optional project association, locked flag, thumbnail, optional source template. (`apps/board-api/src/db/schema/boards.ts`)
- **Element** — anything on the canvas. Stored two ways: (a) the full Excalidraw scene blob in `boards.yjs_state`, and (b) a denormalized per-element row in `board_elements` (populated by the snapshot service on save) used for search, sticky/frame queries, and promote-to-tasks. (`apps/board-api/src/db/schema/board-elements.ts`, `apps/board-api/src/services/element-snapshot.service.ts`)
  - Element types mapped from Excalidraw -> board: `shape` (rectangle/diamond/ellipse/freedraw), `text`, `connector` (arrow/line), `image`, `frame`, `sticky`. (`element-snapshot.service.ts:14-33`)
- **Sticky note** — emulated as an Excalidraw rectangle + bound text element (Excalidraw has no native sticky). Default color `#FFEB3B` (yellow). (`apps/board-api/src/routes/element.routes.ts:91-138`)
- **Frame** — an Excalidraw frame element; child elements reference it via `frame_id`. Used by "summarize" / "read frames". (`apps/board-api/src/services/element.service.ts:24-51`)
- **Background** — enum: `dots` (default), `grid`, `lines`, `plain`. (`apps/board-api/src/routes/board.routes.ts:12`)
- **Visibility** — enum: `private` (creator + explicit collaborators), `project` (project members + collaborators + creator), `organization` (every org member). Default `project`. (`board.routes.ts:13`, `apps/board-api/src/services/board.service.ts:88-123`). NOTE: the frontend `Board` type mislabels the third value as `'org'` (`apps/board/src/hooks/use-boards.ts:16`) while the backend stores `'organization'` — see Discrepancies.
- **Collaborator** — explicit per-board grant with `permission` `view` | `edit` (default `edit`). Unique per (board, user). (`apps/board-api/src/db/schema/board-collaborators.ts`)
- **Lock** — board-level boolean. When locked, only the board creator or an org admin/owner can edit (enforced on REST and over WS). (`requireBoardEditAccess` in `apps/board-api/src/middleware/authorize.ts:294-304`; WS check `ws/handler.ts:516-534`)
- **Star** — per-user favorite toggle (`board_stars`). (`apps/board-api/src/db/schema/board-stars.ts`)
- **Version** — named snapshot of `yjs_state` with an auto-incrementing `version_number`, unique per board. (`apps/board-api/src/db/schema/board-versions.ts`)
- **Template** — reusable board blueprint. System templates have `org_id = NULL` (read-only to all orgs); org templates belong to one org. Has category, icon, sort_order, thumbnail. (`apps/board-api/src/db/schema/board-templates.ts`)
  - Category values surfaced in the UI tab bar: `general`, `retro`, `brainstorm`, `planning`, `architecture`, `strategy`, plus an `all` pseudo-tab. (`apps/board/src/pages/template-browser.tsx:17-25`)
- **Element-task link** — row in `board_task_links` recording that a sticky was promoted into a specific Bam task. (`apps/board-api/src/db/schema/board-task-links.ts`)
- **Integrity issue** — a board whose `project_id` points cross-org / to a missing project / was auto-detached by migration 0143. Codes: `PROJECT_ORG_MISMATCH`, `PROJECT_NOT_FOUND`, `PROJECT_AUTO_DETACHED`. Remediations: `detach`, `reassign`. (`board.service.ts:173-316`)
- **Element limits** — soft limit **500**, hard limit **2000** live (non-deleted) elements. Soft -> warning header/WS warning; hard -> `413 ELEMENT_LIMIT_EXCEEDED` / WS error. (`element-snapshot.service.ts:7-8`, enforced in `element.routes.ts` and `ws/handler.ts:551-588`)
- **Role hierarchy** (org-scope, resolved from permission-group membership): `viewer < member < admin < owner`. Admin+ get full access to any board in the org. (`authorize.ts:10`, `ws/handler.ts:250-262`)
- **Presence / huddle (audio) — cross-cutting, NOT board-api.** The toolbar embeds `PresenceChipStrip` from `@bigbluebam/ui` (`board-toolbar.tsx:106-111`) and `main.tsx` mounts the **Bureau client**, surfacing the canvas as `surface_id` so the unified call manager derives a `huddle-board-{id}` LiveKit room (`apps/board/src/main.tsx:49-103`). Audio conferencing is therefore a Bureau platform feature layered on top of Board, not a board-api route. See `docs/plans/bureau-design-document.md` (teleport / "Bring everyone here").

---

## 3. Backend REST routes (board-api, prefix `/board/api/v1`)

All routes require `requireAuth`. Write routes also require `requireScope('read_write')` and a board access guard. `shadowOnly(...)` / `requireCan(...)` wire the per-action permission matrix (Wave D). Standard error envelope `{ error: { code, message, details, request_id } }`.

### Boards (`apps/board-api/src/routes/board.routes.ts`)
| Method | Path | Purpose | Key fields / rules |
|---|---|---|---|
| GET | `/boards` | List boards (cursor-paginated, visibility-filtered) | query: `project_id`, `visibility`, `created_by`, `archived` (`true`/`false`, default excludes archived), `search` (ILIKE name/description), `cursor`, `limit` (<=100, default 50). Rows also return `element_count`, `collaborator_count`, `starred`, `integrity_issue_count`, `creator_name`, `project_name`. Sorted `updated_at desc`. |
| POST | `/boards` | Create board | rate-limit 20/min. body: `name` (1-255, req), `description` (<=2000), `icon` (<=10), `project_id`, `template_id` (copies template scene), `background` (default `dots`), `visibility` (default `project`), `default_viewport`. Rejects cross-org `project_id` (400). Emits Bolt `board.created`. 201. |
| GET | `/boards/recent` | 20 most recently updated visible boards | |
| GET | `/boards/starred` | User's starred boards (<=50) | |
| GET | `/boards/stats` | Org-level counts | `{ total, recent (updated <7d), archived, starred }` (project-filterable) |
| GET | `/boards/search` | Search element text across boards | rate-limit 30/min. query `q` (1-500). ILIKE on `board_elements.text_content`, visibility-scoped. |
| GET | `/boards/:id` | Board metadata (excludes `yjs_state`) | requireBoardAccess |
| GET | `/boards/:id/integrity` | Integrity issue list | `{ issues, ok }` |
| POST | `/boards/:id/remediate` | Fix integrity issue | body: `{action:'detach'}` or `{action:'reassign', project_id}`. Writes `board_integrity_audit`. requireBoardEditAccess. |
| GET | `/boards/:id/stats` | Per-board counts | `{ element_count, collaborator_count, last_updated }`, 404 if missing |
| PATCH | `/boards/:id` | Update metadata | requireBoardEditAccess. body: name, description, icon, project_id, background, visibility, default_viewport, thumbnail_url. Emits Bolt `board.updated`. |
| DELETE | `/boards/:id` | **Archive** (soft delete; sets `archived_at`) | requireBoardEditAccess. NOT a hard delete. |
| DELETE | `/boards/:id/permanent` | **Hard delete** (FK CASCADE wipes elements/collaborators/stars/versions/links) | requireBoardEditAccess |
| POST | `/boards/:id/restore` | Un-archive | requireBoardEditAccess |
| POST | `/boards/:id/duplicate` | Copy board + elements as "<name> (copy)" | rate-limit 20/min. requireBoardAccess. 201. |
| POST | `/boards/:id/star` | Toggle star | returns `{ starred }` |
| POST | `/boards/:id/lock` | Toggle lock | requireBoardEditAccess. Emits Bolt `board.locked`. |

### Scene (`scene.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/boards/:id/scene` | Load Excalidraw scene `{ elements, appState, files }` |
| PUT | `/boards/:id/scene` | Full scene save. Triggers element-snapshot sync. |
| POST | `/boards/:id/scene/beacon` | Tab-close `sendBeacon` save; persists straight to `yjs_state` |

### Elements (`element.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/boards/:id/elements` | All `board_elements` rows |
| GET | `/boards/:id/elements/stickies` | Sticky rows only |
| GET | `/boards/:id/elements/frames` | Frames, each with `children` |
| POST | `/boards/:id/elements/sticky` | Create sticky. body: `text` (1-5000), `x`,`y`, `width`,`height` (10-2000), `color`. Hard-limit 413. 201. |
| POST | `/boards/:id/elements/text` | Create text. body: `text` (1-10000), `x`,`y`, `font_size` (8-200), `color`. 201. |
| POST | `/boards/:id/export` | Export scene. body `format`: `json`(default)/`svg`/`png`. **Returns JSON only** — svg/png via this POST return raw scene + a "client-side render required" note. |
| GET | `/boards/:id/export/:format` | **Server-side render**: `svg` string or `png` (sharp-rasterized) buffer with Content-Disposition. The path that actually yields an image. |

### Links / promote (`link.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/boards/:id/elements/promote` | Batch promote stickies -> Bam tasks. rate-limit 10/min. body: `element_ids` (1-100), `project_id` (req), `phase_id` (opt). Calls Bam internal `POST /v1/tasks` per sticky, writes `board_task_links`, emits Bolt `board.elements_promoted`. Returns `[{element_id, task_id, error?}]`. 201. |
| GET | `/boards/:id/links` | List element->task links (with `task_title`) |
| DELETE | `/links/:linkId` | Delete a link. 204. |

### Versions (`version.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/boards/:id/versions` | List snapshots (desc). Returns id, board_id, version_number, name, thumbnail_url, created_by, created_at. |
| POST | `/boards/:id/versions` | Create snapshot of current scene. body `name` (opt). requireBoardEditAccess. 201. |
| POST | `/boards/:id/versions/:versionId/restore` | Restore board scene from a version. requireBoardEditAccess. |

### Templates (`template.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/templates` | List system (org_id NULL) + this-org templates. query `category`. |
| POST | `/templates` | Create template (optional `board_id` snapshots a board). rate-limit 20/min. 201. |
| PATCH | `/templates/:id` | Update org template. System templates 403. |
| DELETE | `/templates/:id` | Delete org template. System templates 403. 204. |
| POST | `/templates/:id/instantiate` | New board from template. rate-limit 30/min. body `name`,`project_id` (opt). Returns `{id,name}`. 201. |

### Collaborators (`collaborator.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/boards/:id/collaborators` | List (display_name, email, avatar_url, permission) |
| POST | `/boards/:id/collaborators` | Add. body: `user_id` (req, same org), `permission` view/edit (default edit). 409 if dup. 201. |
| PATCH | `/collaborators/:collabId` | Change permission. |
| DELETE | `/collaborators/:collabId` | Remove. 204. |

### Chat (`chat.routes.ts`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/boards/:id/chat` | Last <=100 messages, chronological, with author info |
| POST | `/boards/:id/chat` | Send. rate-limit 20/min. body `body` (1-5000). requireBoardEditAccess. 201. NOTE: chat is **not** broadcast over WS; the panel relies on query polling/refetch. |

### Internal (`internal.routes.ts`) — service-to-service, not user-facing
| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/can-read` | Bureau "summon" cross-app read preflight. Guarded by `X-Internal-Service-Secret`. Returns `{allowed, can_share, reason}`. Mirrors `requireBoardAccess`. |

### WebSocket `/board/ws` (`ws/handler.ts`)
- Auth via session cookie (closes 4001 if missing/expired). Per-client rate limit 120 msgs / 10s (closes 4429).
- Client -> server `type`s: `join_board` (`{boardId, last_seen_seq?}`), `scene_update` (`{elements:[changed]}`), `cursor_update` (`{pointer, button, tool}`), `ping`.
- Server -> client: `connected`, `room_state` (`{collaborators}`), `user_joined`, `user_left`, `scene_update` (`{elements, userId, seq}`), `replay`, `cursor_update`, `warning` (soft limit), `error` (FORBIDDEN/PAYLOAD_TOO_LARGE/ELEMENT_LIMIT_EXCEEDED), `pong`.
- View-only collaborators and non-admins on locked boards are rejected for `scene_update`.
- Persistence: dirty scenes flushed every 5s + on last-collaborator-leave (cross-replica via Redis flush lock). Per-board Redis event stream backs reconnect replay. Cursor colors from an 8-color palette.

---

## 4. Frontend inventory (apps/board/src)

Routing is custom (history API), base path `/board` (`apps/board/src/app.tsx:34-57`). Routes: `home`, `new`, `canvas /:id`, `versions /:id/versions`, `templates`, `starred`, `archived`, `help`.

### Sidebar (`components/layout/board-sidebar.tsx`)
- Logo "Board" + `beta` chip.
- **Project scope selector** dropdown: "All Projects" or active project name; filters list + stats.
- Nav items (exact labels): **All Boards** (`/`), **Starred** (`/starred`), **Templates** (`/templates`), **Archive** (`/archived`).
- Platform footer (`SidebarPlatformFooter`).
- `?` key (outside inputs) opens Help -> `HelpViewer appSlug="board"` (`app.tsx:108-120`).

### All Boards / list page (`pages/board-list.tsx`)
- Heading "Boards"; subtitle "Visual collaboration whiteboards for your team".
- Primary button **"New Board"** (top-right) -> navigates to **/templates** (NOT /new). Calls `GET /boards`, `GET /boards/stats`.
- Stat cards: **Total Boards**, **Recent**, **Starred**, **Archived**.
- Active-filter banner: "Showing: All Projects" / "Showing: <Project>" + **"Show All Projects"** reset.
- Search box ("Search boards...") -> re-queries `GET /boards?search=`.
- Grid of `BoardCard`s. Empty states "No boards yet" / "No boards match your search" + **"Create Board"** -> /templates.

### Board card (`components/list/board-card.tsx`)
- Thumbnail or icon + element-count caption ("N elements" / "Empty board").
- Star overlay (toggle) -> `POST /boards/:id/star`.
- Lock icon indicator; amber **AlertTriangle** integrity indicator (tooltip "N integrity issue(s). Open the board to fix.").
- "..." dropdown — **active:** "Version history" (-> /:id/versions), "Duplicate" (`POST /duplicate`), "Archive" (`DELETE /boards/:id`), "Delete" (confirm -> `DELETE /boards/:id/permanent`). **archived:** "Restore" (`POST /restore`), "Delete permanently".
- Click body -> opens canvas (suppressed for archived).
- Project badge; collaborator count chip ("N collaborator(s)").
- Delete confirm dialog titled "Delete board?".

### Create board page (`pages/board-new.tsx`, /new)
- Heading "Create New Board". Controls: **Icon** picker, **Board name** input (placeholder "Untitled Board"), **Cancel** / **Create Board**.
- "Choose a template" grid: first card **"Blank Board"** ("Start with an empty canvas"), then DB templates. `POST /boards` with `template_id`, navigates to `/:newId`.

### Template browser (`pages/template-browser.tsx`, /templates)
- Heading "Templates"; subtitle "Start from a pre-built template, or create a blank board".
- Top-right **"Blank board"** button -> /new.
- Category tabs (exact): **General, Retro, Brainstorm, Planning, Architecture, Strategy, All**.
- Template cards: thumbnail/icon, name, description, category Badge, element count, **"Use"** -> `POST /templates/:id/instantiate` -> new board.
- Empty state "No templates available".

### Canvas page (`pages/board-canvas.tsx`, /:id) — full-screen, no layout chrome
- Renders `<Excalidraw>` with the full **native Excalidraw toolbar** (shapes, arrows, text, freedraw, frames, images, zoom, pan, multi-select — Excalidraw's own UI, not custom Board UI).
- Local `localStorage` persistence (500ms debounce) + server `PUT /boards/:id/scene` (3s debounce) + `sendBeacon` on unload to `/scene/beacon`.
- Real-time sync via `useBoardSync` (WS).
- Overlays: **BoardIntegrityBanner** (top), **BoardToolbar** (floating top), **ConnectionStatusBadge** (top-right), **ChatPanel** (right slide-over).

### Board toolbar (`components/canvas/board-toolbar.tsx`)
- Back arrow (-> /).
- Icon picker + inline-editable board name (click to rename -> `PATCH /boards/:id`).
- Lock icon when locked.
- `PresenceChipStrip` (Bureau presence/audio surface).
- **Toggle chat** button -> opens ChatPanel.
- **Version history** button -> /:id/versions.
- **"Share"** button — **renders but has NO onClick handler / not wired to any API** (see Discrepancies).
- "..." menu: **"Lock board"/"Unlock board"** (-> `POST /boards/:id/lock`), separator, **"Export as PNG"**, **"Export as SVG"** — the two export items have **NO onClick handlers** (dead; see Discrepancies).

### Chat panel (`components/canvas/chat-panel.tsx`)
- Header "Chat", message list (own messages right-aligned), compose input ("Type a message...") + send. Calls `GET/POST /boards/:id/chat`.

### Connection status badge (`components/canvas/connection-status-badge.tsx`)
- "Live" (green) / "Connecting" (amber spinner) / "Offline" (red) + "N editors" chip when peers present.

### Integrity banner (`components/canvas/board-integrity-banner.tsx`)
- Amber bar; primary message from first issue. Buttons: **"Detach from project"** / **"Leave unattached"** and **"Reassign to a project here"** / **"Reassign to a project"** -> **"Reassign to a project"** dialog (radio list of org projects) -> `POST /boards/:id/remediate`.

### Version history (`pages/version-history.tsx`, /:id/versions)
- Heading "Version History" + board name. **"Save Version"** button.
- Rows: name, "Latest" chip on newest, element count, description, creator avatar/name, relative time, **"Restore"** (confirm "Restore this version?..."). Calls `GET/POST /boards/:id/versions`, `.../restore`.
- "Save Version" dialog: **Version name** input + **Description (optional)** textarea. (Description sent but backend ignores it — see Discrepancies.)

### Starred (`pages/starred-boards.tsx`, /starred)
- Heading "Starred Boards". Grid from `GET /boards/starred`. Empty state "No starred boards".

### Archive (`pages/archived-boards.tsx`, /archived)
- Heading "Archive". Grid from `GET /boards?archived=true`. Cards show Restore + Delete-permanently. Empty state "Archive is empty".

### Cursor / presence components present
- `cursor-overlay.tsx`, `presence-bar.tsx` exist; live cursors are actually rendered through Excalidraw's native `collaborators` Map in `use-board-sync.ts` (cursor_update -> `api.updateScene({collaborators})`). `presence-bar.tsx` is not wired into the current canvas page (toolbar uses `PresenceChipStrip`). Likely dead code — confirm before documenting.

---

## 5. MCP tools (`apps/mcp-server/src/tools/board-tools.ts`) — 14 tools

All target board-api and forward the user's bearer token. Many accept a board **name OR UUID** (resolved via the list `search` filter, exact case-insensitive match; ambiguity -> "not found"). Templates and phases resolve by name too.

| Tool | What it does | Backing route | Human feature |
|---|---|---|---|
| `board_list` | List boards (project_id, visibility, cursor, limit) | `GET /boards` | All Boards list |
| `board_get` | Board metadata by ID | `GET /boards/:id` | open a board |
| `board_create` | Create board (template_id by name/UUID) | `POST /boards` | Create New Board |
| `board_update` | Patch metadata (name/description/background/visibility/**locked**/icon); id by name/UUID | `PATCH /boards/:id` | rename / settings / lock |
| `board_archive` | Soft-delete | `DELETE /boards/:id` | Archive |
| `board_read_elements` | All elements; id by name/UUID | `GET /boards/:id/elements` | (read) |
| `board_read_stickies` | Sticky rows only | `GET /boards/:id/elements/stickies` | (read) |
| `board_read_frames` | Frames + children | `GET /boards/:id/elements/frames` | (read) |
| `board_add_sticky` | Add sticky; color name->hex (yellow/green/blue/red/purple/orange) | `POST /boards/:id/elements/sticky` | add sticky |
| `board_add_text` | Add text element | `POST /boards/:id/elements/text` | add text |
| `board_promote_to_tasks` | Promote stickies -> Bam tasks (resolves project & phase by name) | `POST /boards/:id/elements/promote` | (no human UI — agent-only) |
| `board_export` | Export svg/png | `POST /boards/:id/export` | "..." menu (UI dead) |
| `board_summarize` | Frame-grouped summary (calls frames endpoint) | `GET /boards/:id/elements/frames` | (read/summary) |
| `board_search` | Search element text | `GET /boards/search` | (search) |

MCP surface gaps vs REST:
- No MCP tools for: **versions**, **templates** CRUD/instantiate, **collaborators**, **chat**, **star**, dedicated lock toggle.
- `board_update.locked`: the REST `PATCH /boards/:id` schema does NOT accept `locked` (lock is a separate `POST /boards/:id/lock`), so `board_update(locked=...)` likely no-ops. Flag.
- `board_create` description says background default "plain" / visibility default "private"; REST defaults are `dots` / `project`. Doc-only drift.
- `board_promote_to_tasks` tool return schema `{created_task_ids,count}` vs REST per-element array `[{element_id,task_id,error?}]`. Schema/reality drift.

---

## 6. Candidate user stories

1. **Create a board from a template.** All Boards -> New Board -> Templates -> category tab -> Use (or Blank board) -> canvas. (`POST /templates/:id/instantiate`)
2. **Create a blank board.** Templates -> "Blank board" -> name + icon -> Create Board. (`POST /boards`)
3. **Brainstorm on the canvas.** Open board -> Excalidraw tools add shapes/sticky/text/arrows/frames; auto-saves (local + server + WS).
4. **Collaborate live.** Two+ users on the same board -> live cursors, presence chips, "N editors", reconnect replay. Audio huddle via Bureau ("Bring everyone here").
5. **Chat while whiteboarding.** Toggle chat -> send messages (`POST /boards/:id/chat`).
6. **Promote sticky notes to Bam tasks.** (Agent-driven today — no human button.) Select stickies -> `POST /elements/promote` with project/phase -> tasks created + linked.
7. **Snapshot & restore.** Version history -> Save Version -> later Restore.
8. **Organize the library.** Star a board; filter by project; search boards.
9. **Lifecycle.** Archive -> Archive page -> Restore or Delete permanently.
10. **Lock a board.** "..." -> Lock board (read-only for non-admins/non-creators).
11. **Fix a misconfigured board.** Integrity banner -> Detach / Reassign to a project.
12. **Export a board.** `GET /boards/:id/export/svg|png` (server render). Toolbar export items UI-dead; export works via API/MCP.
13. **Duplicate a board.** "..." -> Duplicate -> "<name> (copy)".
14. **Share to collaborators.** (REST exists; **no working UI** — Share button dead. Agent/API only.)

---

## 7. Agent flows

- **Read/observe:** `board_list`, `board_get`, `board_read_elements`, `board_read_stickies`, `board_read_frames`, `board_summarize`, `board_search`.
- **Author:** `board_create` (incl. from named template), `board_add_sticky`, `board_add_text`, `board_update`, `board_archive`.
- **Cross-app handoff (marquee flow):** `board_promote_to_tasks` turns brainstorm stickies into Bam tasks in a named project/phase, recording `board_task_links`. Only "promote" path; **no human UI button** — agent/API-only today.
- **Export:** `board_export`.
- **Bolt events emitted:** `board.created`, `board.updated`, `board.locked`, `board.elements_promoted` (registered in `apps/bolt-api/src/services/event-catalog.ts`). Payloads enriched with board/project/template/actor/org + counts (`apps/board-api/src/lib/bolt-events.ts`).
- **Bureau summon/teleport** consumes `POST /v1/internal/can-read` to gate pulling collaborators onto a board canvas.

---

## 8. Screenshots available (`docs/apps/board/screenshots/`)

Light + dark (1440x900), catalogued in `docs/apps/board/meta.json`:
- `light/01-list.png` & `dark/01-list.png` — "Board grid view" -> **All Boards** list (stats cards, search, card grid). Stories 1, 8.
- `light/02-canvas.png` & `dark/02-canvas.png` — "Board canvas" -> **canvas/editor** (Excalidraw + floating toolbar). Stories 3, 4, 5, 10.
- `light/03-templates.png` & `dark/03-templates.png` — "Board templates" -> **Templates** browser (category tabs, cards, Use). Stories 1, 2.

No screenshots for: version history, archive, starred, integrity banner, chat panel, create-board form.

---

## 9. Discrepancies (docs/marketing vs code)

1. **"Audio conferencing" is not in board-api.** guide.md / marketing.md / _narrative.md list "Audio Conferencing" as a Board feature, but board-api has **zero** LiveKit/audio/token/conferencing code. It is delivered by the **cross-cutting Bureau system** (`PresenceChipStrip` in the toolbar + `mountBureauClient` in `main.tsx` deriving a `huddle-board-{id}` LiveKit room). Phrase it as "audio is available on a board via the platform-wide Bureau presence bar," not "Board has its own audio server."
2. **"Connectors / freehand / shapes" are Excalidraw-native, not bespoke Board UI.** The guide's "Use the toolbar to add shapes, connectors, and sticky notes" refers to Excalidraw's toolbar; Board's own floating toolbar only has name/icon/chat/version/share/lock/export.
3. **Share button is dead.** `board-toolbar.tsx` renders a "Share" button with no handler. A full collaborator REST API exists (`collaborator.routes.ts`) but there is **no frontend UI** to add/list/manage collaborators. Per project memory ("a feature that doesn't work is a bug") this is a wiring gap.
4. **Export menu items are dead.** "Export as PNG"/"Export as SVG" have no onClick. Export only works via `GET /boards/:id/export/:format` (API/MCP).
5. **Version description / element_count / creator_name not returned.** The Save-Version dialog collects a Description and the version list renders `version.description`, `version.element_count`, `version.creator_name` (`version-history.tsx`, `use-versions.ts`), but `createVersionSchema` accepts only `name` and `listVersions` returns only id/board_id/version_number/name/thumbnail_url/created_by/created_at. Those UI fields render `undefined`. (`board_versions` table has no such columns.)
6. **Visibility enum naming mismatch.** Frontend `Board.visibility` type is `'private' | 'project' | 'org'` (`use-boards.ts:16`) but the backend stores/validates `'organization'`. Works today only because the frontend never sends `'org'`.
7. **`board_create` MCP description defaults wrong** (background "plain"/visibility "private" vs REST `dots`/`project`).
8. **`board_update.locked` likely a no-op** — PATCH schema doesn't accept `locked`; lock is `POST /boards/:id/lock`.
9. **`board_promote_to_tasks` return-shape drift** (tool schema vs REST array). Doc/schema-only.
10. **"yjs_state" naming is misleading.** Despite the column name (and Yjs in the stack list), scenes are plain Excalidraw JSON; no Yjs CRDT in use yet (confirmed by `convert_from(yjs_state,'UTF8')::jsonb` parsing in `board.service.ts`).
11. **Chat is not realtime.** Chat has no WS broadcast; it refreshes via query polling only. Don't imply live chat.

---

## 10. Open questions

1. **Is the Share / collaborator UI intended for beta?** REST exists but is unreachable from the SPA. Document collaborators at all, or treat as backend-only?
2. **Promote-to-tasks has no human entry point.** Planned selection->promote UI, or deliberately agent-only? Help text must not imply a non-existent button.
3. **Audio/Bureau scope:** how much of the teleport/huddle flow is live vs planned (`docs/plans/bureau-*.md`)? Verify what a Board user actually sees today beyond the wired `PresenceChipStrip`.
4. **Server-side PNG/SVG export** depends on `sharp` (`export.service.ts`) — confirm the board-api image bundles it in prod, else `GET /export/png` 500s.
5. **`presence-bar.tsx` / `cursor-overlay.tsx`** appear superseded by Excalidraw-native collaborator rendering + `PresenceChipStrip`. Confirm dead code (don't document).
6. **Element snapshot timing:** list `element_count` has a yjs_state JSON fallback because `board_elements` can lag/empty if the snapshot job didn't run. Could affect search/promote (which read `board_elements`) for very fresh boards — possible "search finds nothing right after drawing" caveat.
