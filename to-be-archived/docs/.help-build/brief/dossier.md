# Brief — Dossier

Research dossier for the Brief app. Everything below is cited from code in the
repo. Anything not confirmed by code is flagged explicitly.

Sources of truth:
- Backend: `apps/brief-api/src`
- Frontend (standalone SPA, NOT under apps/frontend): `apps/brief/src`
- MCP tools: `apps/mcp-server/src/tools/brief-tools.ts`
- Docs: `docs/apps/brief/`

---

## 1. App identity

- **App key:** `brief`
- **Display name:** Brief (subtitle "Documents" / "Collaborative Documents")
- **Category:** Collaborative documents
- **SPA path:** `/brief/` (standalone React SPA in `apps/brief/`)
- **API path:** `/brief/api/` -> brief-api Fastify service (internal :4005), routes under `/v1`
- **WebSocket path:** `/brief/ws` (Yjs real-time collaboration)
- **Beta:** sidebar logo shows a "beta" badge (`apps/brief/src/components/layout/brief-sidebar.tsx:118`).
- **Prerequisites:**
  - Must be logged in to BigBlueBam first. Unauthenticated users see a gate page linking to `/b3/` (`apps/brief/src/app.tsx:126-138`).
  - Cookie/bearer session shared with the platform (`apps/brief-api/src/plugins/auth.ts`).
  - Write tools/routes require `read_write` scope; many require per-action permissions (`fastify.requireCan('brief.*')`).
  - Org-scoped; cross-org access denied (`apps/brief-api/src/middleware/authorize.ts:99`).
  - Optional Qdrant for semantic search (falls back to text search if `QDRANT_URL` unset — `apps/brief-api/src/routes/document.routes.ts:175`).

---

## 2. Key concepts and vocabulary

- **Document** (`brief_documents`): core unit. `title`, unique `slug`, `icon` (emoji/short string, UI caps at 2 chars), optional `cover_image_url`, `plain_text` (markdown), `html_snapshot` (sanitized HTML), `yjs_state` (binary CRDT), `word_count`. (`apps/brief-api/src/db/schema/brief-documents.ts`)
- **Status** (`brief_document_status` enum): `draft`, `in_review`, `approved`, `archived`. Default `draft`. UI chips: "Draft / In Review / Approved / Archived" (`apps/brief/src/pages/document-list.tsx:16-22`). The editor's Publish sets status to `approved` (`apps/brief/src/pages/document-editor.tsx:252,266`); no UI sets `in_review`.
- **Visibility** (`brief_visibility` enum): `private`, `project`, `organization`. Default `project`.
  - `organization` — all org members. `private` — creator + collaborators. `project` — creator, collaborators, or project members. (`apps/brief-api/src/services/document.service.ts:86-119`, `apps/brief-api/src/middleware/authorize.ts:50-174`)
- **Folder** (`brief_folders`): hierarchical (`parent_id`, `sort_order`), optionally project-scoped. Docs have nullable `folder_id`. (`apps/brief-api/src/routes/folder.routes.ts`)
- **Version** (`brief_versions`): numbered snapshot (`version_number`, `title`, `change_summary`, content). Unique on (document_id, version_number). (`apps/brief-api/src/db/schema/brief-versions.ts`)
- **Comment** (`brief_comments`): threaded (`parent_id`), optionally anchored (`anchor_start/end/text`), `resolved` + `resolved_by`. Reactions in `brief_comment_reactions` (unique on comment+user+emoji). (`apps/brief-api/src/services/comment.service.ts`)
- **Collaborator** (`brief_collaborators`): per-document share, permission `view` / `comment` / `edit`. (`apps/brief-api/src/routes/collaborator.routes.ts`)
- **Star** (`brief_stars`): per-user bookmark, toggle. (`document.service.ts:449-473`)
- **Template** (`brief_templates`): `name`, `description`, `icon`, `category`, `html_preview` (+ optional yjs_state). System templates have `org_id = null`; org templates are org-scoped. (`apps/brief-api/src/db/schema/brief-templates.ts`)
- **Links** — task links (`brief_task_links`, link_type `reference|spec|notes|postmortem`) and beacon links (`brief_beacon_links`, link_type `reference|source|related`). (`apps/brief-api/src/services/link.service.ts`)
- **Embed** (`brief_embeds`): file metadata (name/size/mime/storage_key/width/height); bytes go to MinIO/S3. (`apps/brief-api/src/routes/embed.routes.ts`)
- **Promote to Beacon**: graduate doc to a Beacon entry; sets `promoted_to_beacon_id`, one-way. (`document.service.ts:630-678`)
- **Yjs collaboration**: shared CRDT per doc, cursors + presence via WS awareness; `yjs_state` persisted (debounced 30s), tracked by `yjs_last_saved_at`. (`apps/brief/src/hooks/use-collaboration.ts`, `apps/brief-api/src/ws/handler.ts`)
- **Semantic search / Qdrant**: chunked + embedded into a `brief_documents` Qdrant collection; `qdrant_embedded_at` watermark. (`apps/brief-api/src/services/embedding.service.ts`)
- **Roles (org)**: hierarchy `viewer < member < admin < owner`. Admin/owner (or SuperUser) can edit any doc in the org and delete any comment. (`authorize.ts:10,255`, `comment.routes.ts:8-12,82-88`)

---

## 3. Feature inventory

SPA router (`apps/brief/src/app.tsx`): `/` (home), `/documents` (list, `?folder=<id>`), `/documents/:idOrSlug` (detail), `/documents/:idOrSlug/edit` (editor), `/new` (create), `/templates`, `/search`, `/starred`, `/help`. Sidebar nav (`brief-sidebar.tsx:16-22`): Home, Documents, Templates, Search, Starred + Folders tree + project-scope selector.

### 3.1 Global chrome / layout
- **Location:** all pages (`brief-layout.tsx`, `brief-sidebar.tsx`).
- Sidebar header: "Brief" + "beta" badge.
- **Project scope selector:** button shows active project or "All Projects"; dropdown lists "All Projects" + projects; sets `activeProjectId` (filters docs + folders). (`brief-sidebar.tsx:24-106`)
- Nav: "Home", "Documents", "Templates", "Search", "Starred".
- **Folders** section + "New folder" (+) -> inline "Folder name" input (Enter save, Escape cancel) -> `POST /folders`. No rename/delete in UI (`folder-tree.tsx:24`).
- Header: Launchpad trigger, breadcrumbs, OrgSwitcher, "Search documents..." input (focus -> `/search`), NotificationsBell, UserMenu. (`brief-layout.tsx:78-127`)
- **Help:** press `?` (outside inputs) -> in-app HelpViewer (`app.tsx:99-111`).

### 3.2 Home (`/`, `pages/home.tsx`)
- Header: "Brief" / "Welcome to Brief, your team's collaborative document editor."
- Stat cards (-> `/documents`): "Total Documents", "In Review", "Recently Updated". From `GET /documents/stats`. NOTE: card reads `stats.recent`, which the API never returns -> always 0 (see Discrepancies).
- Quick actions: "New Document" -> `/new`; "Browse" -> `/documents`; "Search" -> `/search`; "Templates" -> `/templates`.
- "Recent Documents" (<=8) from `GET /documents/recent`; "Starred Documents" (<=5) from `GET /documents/starred`.

### 3.3 Document list (`/documents`, `pages/document-list.tsx`)
- Toolbar: "Search documents..." input (client `?search=`); status chips "All/Draft/In Review/Approved/Archived"; project scope indicator "Showing docs for: <project>" / "Showing all org documents"; folder filter chip (with X) when `?folder=`; "New Document" -> `/new`.
- Body: DocumentCard grid (icon, title, pinned star, summary, author, relative time, word count, status badge). Empty: "No documents yet. Create your first one." "Load more" paginates.
- Route: `GET /documents` (filters project_id/folder_id/status/created_by/search/cursor/limit; visibility-enforced).

### 3.4 Document detail (`/documents/:idOrSlug`, `pages/document-detail.tsx`)
- Header: icon + title + status badge; star toggle ("Star document"/"Remove star"); "Edit" -> editor.
- Body: live Yjs read-only view, falling back to html_snapshot -> markdown(plain_text) -> plain text -> "No content yet."
- Action bar: "Duplicate" (`POST .../duplicate`); Export menu ("Export" -> "Markdown (.md)"/"HTML (.html)"); "Promote to Beacon" (`POST .../promote` -> `/beacon/<id>`); "Archive" (`DELETE`) or "Restore" (`POST .../restore`) when archived.
- Right sidebar: Status, Author, Project ("Organization-wide" if none), Created, Last Updated, Published (if present), Word Count, Version (expandable list from `GET .../versions`); Linked Items (task -> `/b3/tasks/:id`, beacon -> `/beacon/:id`, from `GET .../links`); Comments (N) thread with "Resolve" + delete, "Add a comment..." -> "Comment" (`POST .../comments`).

### 3.5 Document editor (`/new`, `/documents/:idOrSlug/edit`, `pages/document-editor.tsx`)
- Header: back arrow, "Document title..." input, PresenceChipStrip (edit), Export menu (edit), "Save Draft" (status draft), "Publish" (status approved; only path that fires `document.published`).
- Toolbar (`editor-toolbar.tsx`): Paragraph/Heading 1-4; Bold, Italic, Underline, Strikethrough, Inline code; Align left/center/right; Highlight; Bullet/Ordered/Task list; Blockquote, Code block; Link (inline URL + "Add"), Image (URL prompt), "Insert table (3x3)", Horizontal rule; Undo, Redo.
- Slash commands (`/`): Heading 1/2/3, Bullet List, Numbered List, Task List, Code Block, Blockquote, Horizontal Rule, Table, Image. (`extensions/slash-command.ts`)
- Inline embed nodes: @mention, Task embed `[KEY] title`, Beacon embed pill, Callout, #channel link. (`components/editor/brief-editor.tsx:24-132`)
- "Brief summary (optional)..." input (no backend column — see Discrepancies).
- Right sidebar: Table of Contents; Settings -> "Icon (emoji)" (<=2 chars); "Visibility" select ("Public"/"Organization"/"Project"/"Private" — "Public" invalid, see Discrepancies); "Project (optional)" select (create, "Organization-wide (no project)"); "Start from template" select (create, "Blank document").
- Word count footer.
- Routes: `POST /documents`, `PATCH /documents/:id`, plus WS + `PUT .../yjs-state`.

### 3.6 Templates (`/templates`, `pages/template-browser.tsx`)
- Header: "Templates" / "Start a new document from a pre-built template."
- Cards (icon, name, category, description). Click -> sessionStorage `brief_selected_template` -> `/new` (editor pre-fills). Empty: "No templates available yet." / "Templates can be created by administrators."
- Route: `GET /templates`. Template CRUD routes exist but have NO frontend UI.

### 3.7 Search (`/search`, `pages/search-page.tsx`)
- Header: "Search Documents" / "Find documents by title, content, or author."
- "Type to search..." (autofocus, >=2 chars). Results: title, excerpt, creator, time, status. Empty: "Type at least 2 characters to search." / "No documents found for \"<query>\"."
- Route: `GET /documents/search` (ILIKE title+plain_text). NOTE: `result.excerpt` never populated by text search (see Discrepancies). Vector route `GET /documents/semantic-search` has no dedicated UI.

### 3.8 Starred (`/starred`, `pages/starred-page.tsx`)
- Header: "Starred Documents" / "Your bookmarked documents for quick access."
- DocumentCard grid. Empty: "No starred documents yet." / "Star a document to add it here for quick access."
- Route: `GET /documents/starred`.

---

## 4. REST route inventory (brief-api, prefix `/brief/api/v1`)

All routes require auth. "edit access" = creator / collaborator-with-edit / org admin+ / SuperUser. "read access" = visibility rules. Mutations require `read_write` scope.

### Documents (`document.routes.ts`)
- `POST /documents` — create (title?, project_id?, folder_id?, template_id?, visibility?, icon?). Copies template html_preview when template_id set. Emits `document.created`. (perm `brief.document.create`)
- `GET /documents` — list (project_id, folder_id, status, created_by, search, cursor, limit<=100). Cursor-paginated, visibility-enforced. `{ data, meta:{ next_cursor, has_more } }`.
- `GET /documents/starred` — current user's stars.
- `GET /documents/recent` — recent visible docs (limit<=50, default 20).
- `GET /documents/search` — ILIKE title+plain_text. Query: query(1-500), project_id?, status?.
- `GET /documents/semantic-search` — Qdrant vector search (q, limit?). Falls back to text; meta.source vector|text|text_fallback.
- `GET /documents/stats` — `{ total, draft, in_review, approved, archived }` (visibility-scoped).
- `GET /documents/by-slug/:slug` — slug -> doc (no yjs_state).
- `GET /documents/:id` — get by UUID or slug (no yjs_state).
- `PATCH /documents/:id` — update title, folder_id, icon, cover_image_url(http/https), status, visibility, pinned, plain_text, html_snapshot, word_count, project_id. Emits `document.updated`; `document.published` on status->approved. (edit access)
- `DELETE /documents/:id` — archive. 400 if already archived. (edit access)
- `POST /documents/:id/restore` — unarchive (->draft). 400 if not archived. (edit access)
- `POST /documents/:id/duplicate` — copy "<title> (copy)", draft. (read access; 20/min)
- `POST /documents/:id/star` — toggle -> `{ starred }`. (read access)
- `POST /documents/:id/promote` — graduate to Beacon. 400 if already promoted. Emits `document.promoted`. `{ document, beacon_id }`. (perm `brief.document.promote`, edit access)
- `PUT /documents/:id/content` — replace content (recomputes word_count). (edit access)
- `POST /documents/:id/append` — append content. (edit access)
- `GET /documents/:id/yjs-state` — raw Yjs base64.
- `PUT /documents/:id/yjs-state` — persist Yjs snapshot (base64, immediate?). Debounced 30s; invalidates embedding watermark. (edit access; 60/min)

### Folders (`folder.routes.ts`)
- `GET /folders?project_id=`; `POST /folders` (name, project_id?, parent_id?, sort_order?; perm create); `PATCH /folders/:id` (perm update); `DELETE /folders/:id` (perm delete).

### Versions (`version.routes.ts`)
- `GET /documents/:id/versions` (read); `POST /documents/:id/versions` (title?, change_summary?; auto-increment; edit); `GET /documents/:id/versions/:versionId`; `POST /documents/:id/versions/:versionId/restore` (restores + records a "Restored from version N" snapshot; edit); `GET /documents/:id/versions/:v1/diff/:v2` (LCS line diff; no UI/MCP consumer).

### Comments (`comment.routes.ts`)
- `GET /documents/:id/comments` (threaded); `POST /documents/:id/comments` (body<=50k, parent_id?, anchor_*?); `PATCH /comments/:commentId` (author only); `DELETE /comments/:commentId` (author or admin+/SuperUser); `POST /comments/:commentId/resolve` (toggle); `POST /comments/:commentId/reactions` (emoji; 409 dup; no UI); `DELETE /comments/:commentId/reactions/:emoji` (no UI).

### Collaborators (`collaborator.routes.ts`)
- `GET /documents/:id/collaborators` (read); `POST /documents/:id/collaborators` ({user_id, permission: view|comment|edit}; edit); `PATCH /collaborators/:collabId`; `DELETE /collaborators/:collabId`. NO frontend UI, NO MCP tools.

### Links (`link.routes.ts`)
- `GET /documents/:id/links` -> `{ task_links, beacon_links }` (read); `POST /documents/:id/links/task` ({task_id, link_type}; 409 dup/cross-org; perm `brief.document_link_task.create`, edit); `POST /documents/:id/links/beacon` ({beacon_id, link_type}; perm `brief.document_link_beacon.create`, edit); `DELETE /links/:linkId?document_id=`. NO UI to CREATE links (read-only display).

### Embeds (`embed.routes.ts`)
- `POST /documents/:id/embeds` (file_name, file_size<=100MB, mime_type, width?, height?; edit); `GET /documents/:id/embeds`; `DELETE /embeds/:embedId`. No dedicated upload UI wired.

### Templates (`template.routes.ts`)
- `GET /templates` (system + org); `POST /templates` (perm create); `PATCH /templates/:id` (perm update); `DELETE /templates/:id` (perm delete). CRUD has no UI.

### Export (`export.routes.ts`)
- `GET /documents/:id/export/markdown` (.md attachment); `GET /documents/:id/export/html` (styled standalone HTML).

### Internal (`internal.routes.ts`)
- `POST /internal/can-read` — Bureau summon read-preflight ({user_id, org_id, target_url} + X-Internal-Service-Secret) -> `{ allowed, can_share, reason }`. Service-to-service only.

### WebSocket (`ws/handler.ts`)
- `fastify.get('/ws')` and `fastify.get('/ws/:docId')` (both registered, lines 486-487). Client dials `wss://host/brief/ws/<docId>` (y-websocket path room name); `?doc=` query form kept for back-compat. Auth via session cookie + per-document access check (`checkDocumentAccessForWs`); closes 4001/4002/4003 on auth/missing-doc/no-access. Redis fan-out across instances; flushes dirty rooms every 30s. The path-shape bug noted in the synchronous-editing plan IS fixed here.

---

## 5. MCP tools (`apps/mcp-server/src/tools/brief-tools.ts`)

17 tools. All proxy to brief-api forwarding the user's bearer token. Write tools resolve id/document_id (UUID, slug, OR exact case-insensitive title) via `resolveDocumentId`; on miss return "Brief document not found: <id>".

Documents CRUD:
- `brief_list` -> `GET /documents` (project_id, folder_id, status, created_by, cursor, limit). Feature: list.
- `brief_get` -> `GET /documents/:id`. Feature: open doc.
- `brief_create` -> `POST /documents` (title, project_id, folder_id, template_id, content markdown, visibility). Feature: New Document.
- `brief_update` -> `PATCH /documents/:id` (title, status, visibility, folder_id, icon, pinned). Feature: editor settings/metadata.
- `brief_update_content` -> `PUT /documents/:id/content` (replace body markdown). Feature: editor body.
- `brief_append_content` -> `POST /documents/:id/append`. Agent-oriented; no human button.
- `brief_archive` -> `DELETE /documents/:id`. Feature: Archive.
- `brief_restore` -> `POST /documents/:id/restore`. Feature: Restore.
- `brief_duplicate` -> `POST /documents/:id/duplicate` (optional target project by name/UUID). Feature: Duplicate.

Search:
- `brief_search` -> `GET /documents/search` (query, project_id, status, semantic, limit). Feature: Search. NOTE: semantic/limit ignored by the text route; vector route is `/documents/semantic-search` (param `q`). (see Discrepancies)

Comments:
- `brief_comment_list` -> `GET /documents/:id/comments`. Feature: Comments panel.
- `brief_comment_add` -> `POST /documents/:id/comments` (body, parent_id, anchor_text). Feature: Add comment.
- `brief_comment_resolve` -> `POST /comments/:id/resolve`. Feature: Resolve.

Versions:
- `brief_versions` -> `GET /documents/:id/versions`. Feature: version list.
- `brief_version_get` -> `GET /documents/:id/versions/:versionId`.
- `brief_version_restore` -> `POST /documents/:id/versions/:versionId/restore`. No direct human restore button.

Integrations:
- `brief_promote_to_beacon` -> `POST /documents/:id/promote`. Feature: Promote to Beacon.
- `brief_link_task` -> `POST /documents/:id/links/task` (task by UUID or human ref FRND-42). Feature: Linked Items (read-only in UI; create is tool-only).

NO MCP tools for: folders, collaborators, template CRUD, embeds, beacon-link creation, export, version diff, comment reactions, comment edit/delete.

---

## 6. Candidate user stories

1. **Draft and publish.** Home -> "New Document" -> type -> set Visibility -> "Save Draft" -> later "Publish". (`POST /documents`, `PATCH /documents/:id`)
2. **Start from a template.** Templates -> pick card -> editor pre-filled -> Publish. (`GET /templates`, `POST /documents`)
3. **Co-edit in real time.** Two users on `/documents/:slug/edit`; live cursors; readers on detail see edits live. (`use-collaboration.ts`, `ws/handler.ts`)
4. **Organize with folders + project scope.** Pick scope, create folder, create docs into it, browse by folder. (`GET/POST /folders`, `GET /documents?folder_id=`)
5. **Find a document.** Search / header box -> >=2 chars -> click result. (`GET /documents/search`)
6. **Review with comments.** Detail -> add comment -> teammate resolves. (`POST /documents/:id/comments`, `POST /comments/:id/resolve`)
7. **Snapshot + restore a version.** (agent/API today) `POST .../versions`; restore via `brief_version_restore`. UI shows the list read-only.
8. **Archive / restore lifecycle.** Detail -> "Archive"; filter list by "Archived"; open -> "Restore". (`DELETE /documents/:id`, `POST .../restore`)
9. **Duplicate.** Detail -> "Duplicate" -> editor on the copy. (`POST .../duplicate`)
10. **Export.** Detail/editor -> "Export" -> Markdown/HTML. (`GET .../export/markdown|html`)
11. **Promote to Beacon.** Detail -> "Promote to Beacon" -> Beacon article. (`POST .../promote`)
12. **Link a spec doc to a task (agentic).** `brief_link_task` (doc + FRND-42, link_type spec); read in "Linked Items".
13. **Star for quick access.** Detail -> star; find on Home/Starred. (`POST .../star`)
14. **Agent authors end-to-end.** `brief_create` -> `brief_update_content`/`brief_append_content` -> `brief_link_task` -> `brief_promote_to_beacon`.

---

## 7. Agent flows

- **Authoring/maintenance:** `brief_create`, `brief_update_content`, `brief_append_content`, plus `brief_update`/`brief_archive`/`brief_restore`/`brief_duplicate`.
- **Knowledge graduation:** `brief_promote_to_beacon`.
- **Cross-linking:** `brief_link_task` is the ONLY way to create task links (no human UI).
- **Review automation:** `brief_comment_list`/`brief_comment_add`/`brief_comment_resolve`.
- **Search/retrieval:** `brief_search` (text/semantic); Brief is a registered source for platform `search_everything`.
- **Bolt events (source `brief`, `apps/bolt-api/src/services/event-catalog.ts`):** `document.created`, `document.updated`, `document.published`, `document.promoted`, plus worker/system `brief.export.*`, `brief.snapshot.*`, `brief.cleanup.*`, document.embedded, yjs-snapshot event. Trigger Bolt automations.
- **Bureau summon preflight:** `POST /internal/can-read`.
- **Visibility:** agents should run platform `can_access` before posting Brief links into shared surfaces; Brief enforces private/project/organization server-side regardless.

---

## 8. Screenshots available (`docs/apps/brief/screenshots/`, light + dark, 1440x900, captured 2026-04-17)

- `01-home.png` — "Brief home": stat cards, quick actions, recent/starred. Illustrates §3.2, stories 1/5.
- `02-documents.png` — "Document list": toolbar, status chips, cards. Illustrates §3.3, stories 4/8.
- `03-detail.png` — "Document detail": body, action bar, sidebar (status/author/versions/links/comments). Illustrates §3.4, stories 6/9/10/11.
- `04-editor.png` — "Document editor": title, toolbar, body, TOC + settings sidebar. Illustrates §3.5, stories 1/2/3.
- `05-templates.png` — "Template browser": template cards. Illustrates §3.6, story 2.
- `06-starred.png` — "Starred documents": bookmarked grid. Illustrates §3.8, story 13.

Both `light/` and `dark/` contain all six; `meta.json` records sha256 + dimensions + timestamps.

---

## 9. Discrepancies (docs / marketing / UI vs code)

1. **"Public" visibility option doesn't exist in the backend.** Editor offers Public/Organization/Project/Private (`document-editor.tsx:27-32`); type includes `'public'` (`use-documents.ts:7`); backend enum is only `private|project|organization` (`brief-documents.ts:30-34`). Choosing "Public" sends an invalid enum -> Zod VALIDATION_ERROR (`document.routes.ts:19,40`). Live bug.
2. **Home "Recently Updated" is always 0.** Home reads `stats.recent` (`home.tsx:27`) but `getStats` returns no `recent` (`document.service.ts:621-627`).
3. **Search results show no excerpt.** Search page renders `result.excerpt` (`search-page.tsx:71`); `searchDocuments` returns raw rows without `excerpt` (`document.service.ts:586-605`). Only semantic-search builds excerpt.
4. **`brief_search` semantic/limit are no-ops on the text route.** Tool sends `semantic`/`limit` to `GET /documents/search`, whose schema accepts only query/project_id/status (`document.routes.ts:70-74`). Vector search lives at `GET /documents/semantic-search` (param `q`). Tool description overclaims.
5. **`summary` / `published_at` / `version` have no backend columns.** Editor "Brief summary" input + detail/card render these fields, but `brief_documents` has none. Sent values are dropped by Zod; read values are null/undefined (sidebar "Version" can show "vundefined").
6. **Collaborator management is API-only.** DB + routes + visibility support per-doc collaborators (view/comment/edit), but no share dialog in `apps/brief/src` and no MCP tools. Marketing "Share documents with team members" is only achievable via org/project visibility or direct API.
7. **Link creation is not in the UI.** "Linked Items" is read-only; no "add link" button. Task links: `brief_link_task` (MCP) only. Beacon links: API only (no MCP tool, no UI).
8. **`in_review` status is unreachable from the UI.** Chip + stats exist, but no control sets it (editor only sets draft/approved). Reachable only via `brief_update`/`PATCH`.
9. **Beacon-embed / @mention insertion has no toolbar/slash entry.** The BeaconEmbed/TaskEmbed/Mention/ChannelLink nodes exist (`brief-editor.tsx`, extensions dir) and render if present, but there's no UI affordance to insert a Beacon embed (slash menu lists only headings/lists/code/quote/hr/table/image). Guide claims "Beacon Embeds that pull articles inline" — the node only stores an id+title pill, not live content.
10. **Banter rich-preview cards** for Brief links (guide.md) are a Banter-side concern; not verifiable in Brief's code.

---

## 10. Open questions

1. **Version restore/create from the UI?** Sidebar lists versions but has no "Restore"/"Save version" button. Human-facing later, or agent/API-only by design?
2. **Origin of `summary`/`published_at`/`version`.** Planned columns (pending migration) or dead frontend fields?
3. **Template authoring UX.** CRUD routes + `brief.template.*` perms exist but no admin UI. Created via MCP/API/seed only?
4. **Embeds vs editor images.** `brief_embeds` records MinIO metadata, but the editor's image insert uses a URL prompt and doesn't appear to call `POST /documents/:id/embeds`. Is the embed route wired to any upload flow?
5. **Semantic search embeddings are stubbed.** `semantic-search` uses a zero-vector (real model "not yet wired", `document.routes.ts:194-198`), so vector ranking is inert. When does the real model land?
6. **Version diff** (`/versions/:v1/diff/:v2`) has no UI and no MCP tool. Planned compare view?
7. **Comment reactions** have full API support but no UI and no MCP tool. Intended surface?
8. **i18n / a11y** beyond sr-only labels not assessed here.
