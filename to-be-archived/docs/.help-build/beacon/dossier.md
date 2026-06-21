# Beacon — Help-Build Dossier

Research dossier for the writer. Every feature, label, route, and tool below is
cited to a real file. Do not document anything not surfaced here.

Sources of truth:
- Backend: `apps/beacon-api/src/` (routes, services, db/schema)
- Frontend SPA: `apps/beacon/src/` (standalone app, served at `/beacon/`)
- MCP tools: `apps/mcp-server/src/tools/beacon-tools.ts`
- Docs: `docs/apps/beacon/`
- Worker jobs: `apps/worker/src/jobs/beacon-expiry-sweep.job.ts`, `apps/worker/src/jobs/beacon-vector-sync.job.ts`

---

## 1. App identity

- **App key:** `beacon`
- **Display name:** Beacon (category in docs: "Knowledge base")
- **SPA path:** `/beacon/` (React SPA in `apps/beacon/src`)
- **API path:** `/beacon/api/` → beacon-api (internal :4004). All routes are
  registered under the `/v1` prefix (`apps/beacon-api/src/server.ts` lines
  104-112), so external paths are `/beacon/api/v1/...`.
- **Status:** BETA. Sidebar logo renders a `beta` badge
  (`apps/beacon/src/components/layout/beacon-sidebar.tsx` lines 116-119).
- **Prerequisites:**
  - Must be logged in to BigBlueBam (Bam) first. If unauthenticated, the app
    shows "Please log in to BigBlueBam first to access Beacon." with a "Go to
    BigBlueBam Login" link to `/b3/` (`apps/beacon/src/app.tsx` lines 127-139).
    Auth is the shared platform session cookie; Beacon has no login of its own.
  - Projects come from the Bam API (`apps/beacon/src/lib/bbb-api.ts`).
- **Permissions:** per-action checks via `fastify.requireCan(...)` (e.g.
  `beacon.beacon.create`, `beacon.policy.update`) plus beacon-level guards
  `requireBeaconEditAccess()` / `requireBeaconReadAccess()`
  (`apps/beacon-api/src/middleware/authorize.ts`). Edit access: SuperUser → any;
  org Admin/Owner → any beacon in org; Member → only beacons they own/created.
  System-level policy edits require SuperUser
  (`apps/beacon-api/src/routes/policy.routes.ts` lines 43-53).

---

## 2. Key concepts and vocabulary

### Beacon (entry / knowledge article)
A single knowledge article. Table `beacon_entries`
(`apps/beacon-api/src/db/schema/beacon-entries.ts`). Fields: `slug` (globally
unique), `title`, `summary` (≤500), `body_markdown` (≤500k), `body_html`,
`version` (starts at 1), `status`, `visibility`, `created_by`, `owned_by`,
`project_id` (nullable = org-wide), `organization_id`, `expires_at` (NOT NULL),
`last_verified_at`, `last_verified_by`, `verification_count`, `retired_at`,
`vector_id`, `metadata` (JSONB). UI calls these "Beacons"; docs say "articles."

### Status (lifecycle)
Enum `beacon_status`: **Draft, Active, PendingReview, Expired, Archived,
Retired**. UI labels (`status-badge.tsx`): Draft, Active, "Pending Review",
Archived, Retired (Expired is in the enum but absent from the badge map — see
Discrepancies).
Transition map (`lifecycle.service.ts` lines 32-39):
- Draft → Active, Retired
- Active → PendingReview, Retired
- PendingReview → Active, Archived, Retired
- Archived → Active, Retired
- Expired → PendingReview, Retired
- Retired → (terminal)
Invalid transitions → HTTP 409 `INVALID_TRANSITION`.

### Visibility
Enum `beacon_visibility`: **Public, Organization, Project, Private** (default
Project). Public/Organization visible to all org members; Private only to
owner/creator; Project only to owner/creator or project members
(`beacon.service.ts` getBeacon/listBeacons).

### Freshness / Expiry
Every beacon has `expires_at`. Frontend freshness states
(`freshness-indicator.tsx`): **fresh** ("Verified recently"), **stale**
("Content is stale"), **expiring** ("Expiring soon"), **expired** ("Needs
verification"). Expired if past expiry or >90d since verify; expiring if ≤14d to
expiry or >16d since verify; stale if >30d since verify.

### Verification
A review event confirming accuracy. Table `beacon_verifications`.
`verification_type`: **Manual, AgentAutomatic, AgentAssisted, ScheduledReview**;
`outcome`: **Confirmed, Updated, Challenged, Retired**; optional
`confidence_score` (0-1), `notes`. Verifying resets `expires_at` and increments
`verification_count`.

### Challenge
Flags an Active beacon → **PendingReview**. Optional `reason`.

### Tags
Per-beacon labels. Table `beacon_tags` (unique on `(beacon_id, tag)`). Drive
filtering, search tag-expansion, and implicit graph edges.

### Links (typed edges)
Enum `beacon_link_type`: **RelatedTo, Supersedes, DependsOn, ConflictsWith,
SeeAlso**. UI edge labels/colors (`edge-legend.tsx`): "Related To", "Supersedes",
"Depends On", "Conflicts With" (dashed), "See Also".

### Knowledge Graph
Nodes = beacons, edges = links. Edge kinds: **explicit** (typed) and
**implicit** = "Tag Affinity" (beacons sharing ≥ N tags; N =
`tag_affinity_threshold`, default 2; dashed gray). Graph queries: **neighbors**
(BFS ≤3 hops), **hubs** (most-connected), **recent** (recently modified/verified).

### Search (hybrid retrieval)
Semantic (Qdrant) + tag expansion + link traversal + full-text fallback
(`search.service.ts`). `match_sources` shown as "Semantic match", "Tag
expansion", "Link traversal", "Keyword match" (`result-card.tsx`).

### Saved query
Named reusable search config. Table `beacon_saved_queries`. Scope enum:
**Private, Project, Organization**.

### Expiry policy (governance)
Per-scope freshness rules. Table `beacon_expiry_policies`, scope enum: **System,
Organization, Project**. Fields: min/max/default_expiry_days, grace_period_days
(default 14). Resolution walks Project → Organization → System; hard fallback
(`policy.service.ts`): min 7, max 365, default 90, grace 14.

### Version history
Each update writes a `beacon_versions` snapshot (title/summary/body +
`change_note` + `changed_by`); beacon `version` bumps.

### Comments / Attachments
Threaded comments (`beacon_comments`, reply depth ≤4 in UI) and file
attachments (`beacon_attachments`, 10 MB cap). Both have REST routes + UI but
**no MCP tools**.

---

## 3. Backend REST routes (apps/beacon-api/src/routes/)

Paths below are relative to `/beacon/api/v1`. `requireAuth` on every route. Most
mutating routes also require `requireScope('read_write')` + a `requireCan(...)`.

### beacon.routes.ts (core CRUD + lifecycle)
| Method | Path | Does | Key fields / rules |
|---|---|---|---|
| POST | `/entries/upsert` | Idempotent create-or-update by `slug` (agent write plane). Emits `entry.upserted` w/ `created`. Rate 30/min. | body: slug,title,body_markdown,summary?,body_html?,visibility?,project_id?,metadata?,change_note?. Returns `{data,created,idempotency_key}`. 201 create / 200 update. Perm `beacon.entry_upsert.create`. |
| POST | `/beacons` | Create (always **Draft**). Rate 20/min. Emits `beacon.created`. | title(1-512), body_markdown(1-500k), summary?(≤500), body_html?, visibility?(default Project), project_id?, metadata?. expires_at from policy. Perm `beacon.beacon.create`. |
| GET | `/beacons/stats` | Org counts. | `{total, at_risk(expiring ≤7d), recently_updated(≤7d)}` over status in (Active,PendingReview,Draft). |
| GET | `/beacons` | List + cursor pagination. | query: project_ids(csv)/project_id, status, tag/tags(csv), visibility_max, expires_after, search, cursor, limit. Visibility-filtered per user. `{data, meta:{next_cursor,has_more}}`. |
| GET | `/beacons/by-slug/:slug` | Slug-only get (mirror). | Read-access guard. |
| GET | `/beacons/:id` | Get by UUID or slug. | Read-access; Private/Project visibility checked. |
| PUT | `/beacons/:id` | Update (bumps version, writes snapshot). Emits `beacon.updated`. | body: any of title,summary,body_markdown,body_html,visibility,metadata,change_note. Edit-access. |
| DELETE | `/beacons/:id` | **Retire** (soft delete): status→Retired, sets retired_at. Emits `beacon.expired` (legacy name, lines 268-273). | Edit-access. Errors if already Retired. |
| POST | `/beacons/:id/publish` | Draft→Active; recompute expires_at. Emits `beacon.published`. | Edit-access. 400 if not Draft. |
| POST | `/beacons/:id/restore` | Archived→Active; reset expiry + last_verified_at. | Edit-access. 400 if not Archived. |
| POST | `/beacons/:id/verify` | Record verification. Emits `beacon.verified` (any outcome). | verification_type, outcome, confidence_score?(0-1), notes?(≤2000). Edit-access. |
| POST | `/beacons/:id/challenge` | Active→PendingReview. Emits `beacon.challenged`. | reason?(≤2000). Read-access + perm `beacon.beacon_challenge.create`. |

### version.routes.ts
- GET `/beacons/:id/versions` — list history.
- GET `/beacons/:id/versions/:v` — one version (positive int; 400 bad / 404 missing).

### tag.routes.ts
- GET `/tags` — tags in scope w/ counts (query `project_id?`).
- POST `/beacons/:id/tags` — add 1-20 tags (1-128 chars). Edit-access.
- DELETE `/beacons/:id/tags/:tag` — remove a tag (404 if absent). Edit-access.

### link.routes.ts
- POST `/beacons/:id/links` — create typed link (target_id uuid, link_type). 409 if exists. Perm `beacon.beacon_link.create` + edit-access.
- GET `/beacons/:id/links` — list links. Read-access.
- DELETE `/beacons/:id/links/:linkId` — remove link (404 if absent). Edit-access.

### policy.routes.ts
- GET `/policies` — effective resolved policy (query `project_id?`).
- PUT `/policies` — set/update. scope(System/Organization/Project), min/max/default_expiry_days, grace_period_days (≥1). System needs SuperUser; org forced from session. Returns `{data, warnings}`. Perm `beacon.policy.update`.
- GET `/policies/resolve` — preview resolved for a project. Perm `beacon.policy_resolve.list`.

### search.routes.ts
- POST `/search` — hybrid search. Rate 30/min. body: query(≤1000), filters{project_ids,status[],tags[],visibility_max,expires_after}, options{include_graph_expansion,include_tag_expansion,include_fulltext_fallback,rerank,top_k(0-100),group_by_beacon}. Org forced. Returns `{results,total_candidates,retrieval_stages}`.
- GET `/search/suggest` — typeahead. q(1-200), limit(1-50).
- POST `/search/context` — like `/search` but always graph+tag expansion on; enriched linked beacons.
- POST `/search/saved` — save query. name(1-200), description?, query_body, scope?, project_id?. 201.
- GET `/search/saved` — list (query `project_id?`).
- GET `/search/saved/:id` — get one (404 missing).
- DELETE `/search/saved/:id` — delete.

### graph.routes.ts
- GET `/graph/neighbors` — BFS nodes+edges. beacon_id(uuid req), hops(1-3, def 1), include_implicit(def true), tag_affinity_threshold(1-5, def 2), `filters.status`(def Active,PendingReview). `{focal_beacon_id,nodes,edges}`. Perm `beacon.graph_neighbor.list`.
- GET `/graph/hubs` — most-connected. scope(project/organization def project), project_id?, top_k(1-50 def 20). `{data,edges}`. Perm `beacon.graph_hub.list`.
- GET `/graph/recent` — recently modified/verified. scope, project_id?, days(1-90 def 7). Perm `beacon.graph_recent.list`.

### comments.routes.ts
- GET `/beacons/:id/comments` — list (UI builds tree). Read-access.
- POST `/beacons/:id/comments` — create/reply. body_markdown(1-20000), parent_id?. Rate 60/min. Emits `comment.created`.
- PUT `/beacons/:id/comments/:commentId` — edit own.
- DELETE `/beacons/:id/comments/:commentId` — author or admin/owner/superuser. Cross-beacon safety check.

### attachments.routes.ts
- GET `/beacons/:id/attachments` — list. Read-access.
- POST `/beacons/:id/attachments` — multipart, 1 file, **10 MB max**. Rate 100/min. Emits `attachment.uploaded`. Edit-access.
- DELETE `/beacons/:id/attachments/:attachmentId` — uploader or admin.

### Bolt events (source `beacon`)
`entry.upserted`, `beacon.created`, `beacon.updated`, `beacon.expired` (on
retire — see Discrepancies), `beacon.published`, `beacon.verified`,
`beacon.challenged`, `comment.created`, `attachment.uploaded`.

---

## 4. Frontend feature inventory (apps/beacon/src/)

Client routing in app.tsx. Base path /beacon. Routes: / (home), /list, /search,
/create, /dashboard, /settings, /help, /<idOrSlug> (detail), /<idOrSlug>/edit,
/graph, /graph/<id>. Pressing the ? key (outside an input) opens in-app Help
(HelpViewer, appSlug "beacon").

### Sidebar (components/layout/beacon-sidebar.tsx)
Logo "Beacon" + beta badge. Project scope selector at top labeled with the
active project name or **"All Projects"** (default). Nav items (exact labels ->
path): **Home** -> /, **Browse** -> /list, **Search** -> /search, **Graph** ->
/graph, **Dashboard** -> /dashboard, **Beacon Settings** -> /settings. Footer:
shared SidebarPlatformFooter.

### Home -- "Knowledge Home" (pages/home.tsx)
Heading **"Knowledge Home"**, subtitle "Welcome to Beacon, your team's knowledge
base." Three stat cards: **"Total Beacons"** (->/list), **"At Risk (7d)"**
(->/list), **"Recently Updated"** (->/graph) -- from GET /beacons/stats and GET
/graph/recent. Four quick-action cards: **"Create a Beacon"** ("Write a new
knowledge article" ->/create), **"Browse"** ("Explore existing articles"
->/list), **"Search"** ("Find knowledge with semantic search" ->/search),
**"Knowledge Graph"** ("Visualize connections" ->/graph). **"Recent Activity"**
list (<=8 -> detail).

### Browse -- "Article list" (pages/beacon-list.tsx)
Toolbar: search input placeholder **"Search beacons..."**; status chips **All /
Active / Pending Review / Draft / Archived**; project indicator "Showing beacons
for: <name>" or "Showing all org beacons". Primary **"New Beacon"** (->/create).
Empty state: "No beacons yet. Create your first one." + **"Create Beacon"**.
Card grid (-> detail by slug). **"Load more"** pagination. Route GET /beacons.

### Detail -- "Article detail" (pages/beacon-detail.tsx)
Title + StatusBadge; **LifecycleActions** row; presence chips; **"Edit"** button
(-> /<idOrSlug>/edit). Summary, rendered Markdown body, Tags row. **Attachments**
panel + **Comments** section. Right sidebar fields: **Status, Owner, Project**
("Organization-wide" if none), **Freshness, Expires** (date), **Last Verified**
("Never" if none), **Verifications** (count), **Tags**, **Linked Beacons** (->
target), **Version** (vN, expandable history), **"View in Graph"** (->
/graph/<id>). Routes: GET /beacons/:id, .../links, .../versions.

### Lifecycle actions (components/beacon/lifecycle-actions.tsx)
Buttons depend on status; each opens a confirm Dialog titled "<Action> Beacon".
- **Draft** -> **Publish** -> POST .../publish.
- **Active** -> **Verify**, **Challenge**, **Retire** -> .../verify,
  .../challenge, DELETE /beacons/:id.
- **PendingReview** -> **Publish**, **Retire**.
- **Archived** -> **Restore**, **Retire** -> .../restore.
- **Retired** -> **Restore** (server rejects unless Archived -- see Discrepancies).
Dialog descriptions (exact): Publish "This will make the beacon visible to
others based on its visibility setting."; Verify "Confirm this beacon is still
accurate and up to date."; Challenge "Flag this beacon for review. It will move
to Pending Review status."; Retire "Retire this beacon. It will no longer appear
in active listings."; Restore "Restore this beacon to Active status."

### Editor -- Create/Edit (pages/beacon-editor.tsx)
Header **"Create Beacon"** / **"Edit Beacon"**, back arrow. Buttons **"Save as
Draft"** and **"Publish"** (disabled until title non-empty). Fields: title
(placeholder "Beacon title..."), **Summary** (<=500, live "N characters
remaining"), **Body (Markdown)** (placeholder "Write your knowledge article in
Markdown..."), **Project (optional)** select with "Organization-wide (no
project)" (create only; read-only when editing), **Tags (comma-separated)**
(placeholder "e.g. onboarding, deployment, api"), **Visibility** (Public /
Organization / Project / Private; default Organization). Save-Draft: POST
/beacons or PUT /beacons/:id. Publish: create+publish or update+POST
.../publish. (Editor sends tags in create/update payloads -- see Open Questions.)

### Search (pages/beacon-search.tsx + components/search/*)
Heading **"Search"**, subtitle "Find knowledge across all accessible Beacons."
Top-right **"Saved queries"** dropdown. **QueryBuilder**: primary input
placeholder **"Search Beacons..."**; **Project:** multi-select chips ("All
accessible projects" / **"Add"**); **Tags:** chips + "Add tag..." typeahead
(from GET /tags); **"Advanced filters"** expander -> **Status** checkboxes
(Active / Pending Review / Archived / Draft / Retired), **Freshness** "Expiring
within [N] days", **Retrieval** checkboxes **"Graph expansion" / "Tag neighbors"
/ "Keyword fallback"** (= include_graph_expansion / include_tag_expansion /
include_fulltext_fallback), **Visibility** select ("Default (your highest)" /
Public / Organization / Project / Private). Footer: live "~N Beacons match"
(debounced 300ms, top_k=0 count) + **"Save query"** -> "Save Search Query"
dialog (Name + Scope: "Private (only me)" / Project / Organization).
**ResultCard**: title -> detail, StatusBadge, summary, highlighted passage
(**bold** -> mark), clickable tag chips ("Add '<tag>' to filters"), match-source
badges ("Semantic match" / "Tag expansion" / "Link traversal" / "Keyword
match"), freshness, "N verifications", "@owner", <=2 linked beacons w/
(link_type). **SavedQueriesPanel**: list (name, scope, time), click to load,
trash to delete. Route POST /search; URL state serialized
(lib/query-serializer.ts) so searches are shareable.

### Graph -- "Knowledge Graph" (pages/graph-explorer.tsx + components/graph/*)
Heading **"Knowledge Graph"**. Controls: implicit-edges eye toggle ("Show/Hide
implicit edges"), **Hops:** 1/2/3 (when a focal node is selected), **Filter**
dropdown "Filter by Status" (Active / Pending Review / Draft / Archived) +
"Filtered nodes are dimmed, not hidden." + "Clear". No focal node ->
**KnowledgeHome**: left "Hub Beacons" canvas ("Top N most-connected", GET
/graph/hubs), right **"At Risk"** (expiring <=7d) + **"Recently Updated"** (GET
/graph/recent). With a focal node -> **GraphCanvas** (force-directed via
lib/force-layout.ts) from GET /graph/neighbors, breadcrumb (TraversalBreadcrumb),
node/edge counts, EdgeLegend. **NodePopover**: title, status, summary, tags,
freshness, "N verifications", "Owner: ...", actions **"View Beacon"** (-> detail)
+ **"Explore from here"** (re-center graph).

### Dashboard -- "Fridge Cleanout" (pages/beacon-dashboard.tsx)
Header **"Fridge Cleanout"**, subtitle "Knowledge governance dashboard". Tabs:
**Overview / At-Risk / Archived / Agent Activity**.
- **Overview**: cards **"Freshness Score"** (%), **"At-Risk (7 days)"**,
  **"Archived Backlog"** (archived >30d), **"Total Active"**; "Freshness
  Breakdown" bar ("X of Y active beacons verified within 30 days").
- **At-Risk**: table (Title/Expires/Owner/Status/Actions); row **Verify** /
  **Challenge**; multi-select + bulk **"Verify Selected (n)"**.
- **Archived**: archived 30+ days (Title/Archived Since/Owner/Actions); row
  **Restore** / **Retire**; bulk **"Retire Selected (n)"**.
- **Agent Activity**: recent verification events ("Verified by <owner> <time>",
  vN, status).
Hooks: hooks/use-dashboard.ts.

### Beacon Settings -- "Expiry Policy Settings" (pages/beacon-settings.tsx)
Header **"Expiry Policy Settings"**, subtitle "Manage knowledge freshness
policies across the hierarchy". **"Effective Policy (Your Context)"** card (Min/
Max/Default Expiry, Grace Period). **System Policy** editor (SuperUser only),
**Organization Policy** editor, **Project Policy** section (pick project ->
per-project editor). Each editor: Min/Max/Default expiry + Grace (days), client
validation (min <= default <= max; within parent bounds), **"Save Policy"**,
success/warning text, "Read-only -- requires higher permissions to edit" note.
Routes GET/PUT /policies.

### Comments (components/beacon/comments-section.tsx)
Heading **"Comments (n)"**; textarea "Add a comment. Markdown supported.";
**"Post Comment"**. Threaded **Reply** / **Delete** (depth <=4). Delete confirm
"Delete this comment? Replies will also be removed." Cross-author delete gated by
beacon.beacon_comment.delete.

### Attachments (components/beacon/attachments-panel.tsx)
Heading **"Attachments (n)"**; drop zone "Drop a file here or" **"Choose File"**;
"Max 10 MB. Images, PDF, text, office docs." Each row: thumb/icon, filename, size
+ uploader + time, **Download**, **Delete** (uploader or
beacon.beacon_attachment.delete). Delete confirm "Delete attachment '<name>'?".

---

## 5. MCP tools (apps/mcp-server/src/tools/beacon-tools.ts) -- 30 tools

All resolve `id` via UUID, slug, OR title (resolveBeaconId). Project args accept
UUID or project name where noted.

CRUD (11):
- `beacon_create` -> POST /beacons (create Draft). Editor "Save as Draft".
- `beacon_list` -> GET /beacons. Browse.
- `beacon_get` -> GET /beacons/:id. Detail.
- `beacon_update` -> PUT /beacons/:id (new version). Editor edit.
- `beacon_upsert_by_slug` -> POST /entries/upsert. Idempotent; returns
  {data, created, idempotency_key}. Agent write plane (no human button).
- `beacon_retire` -> DELETE /beacons/:id. Lifecycle "Retire".
- `beacon_publish` -> POST .../publish. "Publish".
- `beacon_verify` -> POST .../verify (type/outcome/confidence/notes). "Verify".
- `beacon_challenge` -> POST .../challenge. "Challenge".
- `beacon_restore` -> POST .../restore. "Restore".
- `beacon_versions` / `beacon_version_get` -> GET .../versions. Version panel.

Search (4):
- `beacon_search` -> POST /search. Search view.
- `beacon_suggest` -> GET /search/suggest. Typeahead.
- `beacon_search_context` -> POST /search/context. Agent-optimized retrieval
  (linked beacons pre-fetched). No dedicated human view.

Policy (3):
- `beacon_policy_get` -> GET /policies. Settings effective policy.
- `beacon_policy_set` -> PUT /policies. Settings save policy.
- `beacon_policy_resolve` -> GET /policies/resolve. Settings preview.

Tags & Links (5):
- `beacon_tags_list` -> GET /tags. Tag typeahead.
- `beacon_tag_add` / `beacon_tag_remove` -> POST/DELETE /beacons/:id/tags.
- `beacon_link_create` / `beacon_link_remove` -> POST/DELETE /beacons/:id/links.

Saved queries (4):
- `beacon_query_save` / `beacon_query_list` / `beacon_query_get` /
  `beacon_query_delete` -> /search/saved. Saved-queries panel.

Graph (3):
- `beacon_graph_neighbors` -> GET /graph/neighbors. Graph focal view.
- `beacon_graph_hubs` -> GET /graph/hubs. Knowledge Home hubs.
- `beacon_graph_recent` -> GET /graph/recent. Home/Graph recent.

NOTE: there are **no MCP tools for comments or attachments** despite REST routes
and UI for both.

---

## 6. Candidate user stories

1. **Author and publish an article.** Browse -> "New Beacon" -> fill Title/
   Summary/Body, pick Project + Visibility + Tags -> "Publish" (or "Save as
   Draft" then Publish from detail). Routes POST /beacons, POST .../publish.
2. **Find an answer by meaning.** Search -> natural-language query -> optional
   tag/project/status filters + retrieval toggles -> open a result. POST /search.
3. **Save and reuse a search.** Search -> configure -> "Save query" (name +
   scope) -> reopen via "Saved queries". /search/saved.
4. **Keep knowledge fresh (governance).** Dashboard -> At-Risk -> multi-select
   -> "Verify Selected"; Archived -> "Retire Selected". .../verify, DELETE.
5. **Challenge a wrong article.** Detail (or At-Risk row) -> "Challenge" -> moves
   to Pending Review. .../challenge.
6. **Explore connections.** Graph -> Hub Beacons or "View in Graph" -> expand
   neighbors, adjust hops, toggle implicit edges, "Explore from here". /graph/*.
7. **Link related articles.** Detail/graph -> create typed link (Related To /
   Supersedes / Depends On / Conflicts With / See Also). POST /beacons/:id/links.
8. **Set freshness policy.** Beacon Settings -> edit Organization/Project policy
   (min/max/default/grace days) -> "Save Policy". PUT /policies.
9. **Discuss / attach evidence.** Detail -> comment/reply; upload attachment
   (<=10 MB). .../comments, .../attachments.
10. **(Agent) Idempotent ingestion.** Repeated `beacon_upsert_by_slug`; `created`
    flag distinguishes insert vs update. POST /entries/upsert.

---

## 7. Agent flows

- **Grounding / RAG:** `beacon_search` or `beacon_search_context` (linked beacons
  pre-fetched) to pull KB context. Guide markets the search API to the MCP server.
- **Idempotent ingestion:** `beacon_upsert_by_slug` (POST /entries/upsert),
  emits `entry.upserted` with `created`.
- **Automated verification:** `beacon_verify` supports AgentAutomatic /
  AgentAssisted / ScheduledReview with confidence_score. Dashboard "Agent
  Activity" tab shows recent verification events. The daily expiry sweep
  (apps/worker/src/jobs/beacon-expiry-sweep.job.ts) moves Active->PendingReview
  on expiry, PendingReview->Archived after grace, deletes old Drafts, and
  enqueues PendingReview beacons for an agent verification queue (step 4).
- **Vector sync:** apps/worker/src/jobs/beacon-vector-sync.job.ts keeps Qdrant
  embeddings in sync for semantic search.
- **Visibility preflight:** per docs/reference/agent-conventions.md,
  `beacon.entry` (table beacon_entries) is visibility-gated; agents citing
  beacons in shared surfaces must can_access-check. Refusal reasons include
  beacon_private_not_owner / beacon_project_not_member.
- **Graph/governance via tools:** agents can build/query the graph
  (beacon_graph_*, beacon_link_*) and read/set policy (beacon_policy_*).

---

## 8. Screenshots available (docs/apps/beacon/screenshots/{light,dark}/)

Both light and dark variants for each (12 files). Labels from meta.json:
- `01-home.png` -- "Knowledge Home" -> Home view / stat cards / quick actions.
- `02-browse.png` -- "Article list" -> Browse view (filters, "New Beacon").
- `03-detail.png` -- "Article detail" -> detail page (lifecycle, sidebar, tags,
  links) -- stories 1, 5, 7, 9.
- `04-graph.png` -- "Knowledge graph explorer" -> Graph view (story 6).
- `05-dashboard.png` -- "Governance dashboard" -> "Fridge Cleanout" dashboard
  (story 4). meta label says Governance dashboard; UI title is Fridge Cleanout.
- `06-search.png` -- "Search results" -> Search + QueryBuilder (stories 2, 3).
No screenshot for Beacon Settings / Expiry Policy (story 8) or the editor.

---

## 9. Discrepancies (docs/marketing vs. code)

1. **No view/search analytics.** guide.md / _narrative.md / marketing.md say the
   Dashboard has "analytics on article views, search patterns." The real
   Dashboard ("Fridge Cleanout") is freshness/governance only (freshness score,
   at-risk, archived backlog, recent verifications). No view-count or search
   analytics exist in schema or routes.
2. **"Rich text editor" is actually Markdown.** Marketing says rich text; the
   editor is a plain Markdown textarea ("Body (Markdown)").
3. **Retire emits beacon.expired.** DELETE /beacons/:id publishes the Bolt event
   beacon.expired (code comment at beacon.routes.ts 268-273 admits this; Bolt
   rules must match beacon.status === Retired).
4. **Expired status not rendered.** DB enum + lifecycle map include Expired, but
   StatusBadge has no Expired entry, so an Expired beacon renders undefined
   label/style. The sweep uses Active->PendingReview->Archived, never Expired, so
   the value is effectively dead in the live flow.
5. **Restore on Retired beacons.** UI offers "Restore" for Retired
   (lifecycle-actions.tsx line 40), but restoreBeacon rejects anything not
   Archived (beacon.service.ts 473-478) and Retired is terminal -> clicking it
   errors.
6. **Policy MCP params diverge from REST.** beacon_policy_set/get expose
   verification_interval_days, auto_archive, tag_affinity_threshold, but PUT
   /policies and the policy table only have min/max/default_expiry_days +
   grace_period_days. Treat policy as those four expiry/grace fields.

---

## 10. Open questions

1. **Tags on create/update.** Editor sends tags in POST /beacons and PUT
   /beacons/:id, but createBeaconSchema/updateBeaconSchema do not include tags,
   and tags have their own endpoint (POST /beacons/:id/tags). Unconfirmed whether
   editor tags persist on create/edit or are silently dropped.
2. **Publish from PendingReview.** UI shows "Publish" for PendingReview calling
   POST .../publish, but publishBeacon requires Draft and 400s otherwise. The
   lifecycle map allows PendingReview->Active but only verify performs it via a
   route. How does a PendingReview beacon return to Active from the detail page?
3. **beacon_search response shape.** The MCP tool documents {data,next_cursor,
   total}, but search.service.ts returns {results,total_candidates,
   retrieval_stages}. Unverified whether a transform exists.
4. **Create entry point.** /create is reachable only from Home/Browse buttons;
   sidebar has no "Create" item. Confirm there is no global command-palette create.
5. **Expired reachability.** Since the sweep never sets Expired, is the Expired
   enum value reachable in production, or dead? Affects whether to mention
   "Expired" as a user-facing state.
