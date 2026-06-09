# Blueprint Development Plan

## Overview

Blueprint is the structured-diagram product in the BigBlueBam suite. Where Board is a freeform infinite canvas (sticky notes, rough boxes, ink), Blueprint produces deliberate node-and-edge artifacts with auto-layout: org charts, flowcharts, ERDs, mind maps, swimlane processes, decision trees, and architecture diagrams.

The distinction is the data model, not the chrome. Board stores a canvas as an opaque collaborative blob. Blueprint stores a typed graph (nodes, edges, ports) in relational tables as the source of truth, which is what makes the rest of the suite's thesis hold for diagrams: every structural mutation is an auditable API call, every API call is an MCP tool, and an agent can build or rewrite a diagram as a first-class user with the same permissions and audit trail as a human.

Headline capabilities:

- React Flow canvas (`@xyflow/react`, MIT) with custom node and edge types per diagram kind
- Relational graph model (`blueprint_nodes`, `blueprint_edges`) as the canonical structure, with a Yjs/Hocuspocus layer for live multiplayer (shared with Board's substrate)
- Auto-layout via ELK (layered, tree, force, radial, rectpacking) behind a swappable layout interface, run in a web worker for interactive use and in the worker process for agent-initiated layout
- ~20 MCP tools (`blueprint_*`), including `blueprint_generate` (build a whole diagram from a structured spec or NL description) and `blueprint_apply_layout`
- Cross-product embeds (Bam tasks, Beacon entries, Bearing goals, Bond deals) as node references, plus promote-node-to-task
- Import/export: Mermaid and Graphviz DOT in and out, SVG/PNG/JSON out
- Org / project / private visibility mirroring Beacon and Brief, plus per-diagram collaborators
- Live audio (LiveKit) and anchored comments on the canvas

---

## Architecture Decisions

### Rendering and interaction: React Flow (`@xyflow/react`)

React Flow is purpose-built for exactly this product: node-edge editors with handles, custom node types, panning, zooming, multi-select, and a connection model. It is React 19 compatible and ships its own Zustand store internally, which sits comfortably next to the suite's Zustand usage.

Licensing verdict (verified June 2026): `@xyflow/react` 12.10.x is MIT, with no paywalled core features. "React Flow Pro" sells example code and support, not library capabilities. This is a clean dependency with none of the SDK-tier escalation that bit Board with tldraw.

### Auto-layout engine: ELK primary, Dagre fallback, one interface

Layout is the thing Board cannot do and the reason Blueprint exists. The recommendation is the Eclipse Layout Kernel via `elkjs`, which gives layered (Sugiyama) layout for flowcharts and org charts plus tree, force, radial, and rectangle-packing for the other diagram kinds. Dagre is the lighter alternative but only does layered layout and is effectively unmaintained.

The licensing nuance matters here given the tldraw history, so to be precise:

- `elkjs` is EPL-2.0, a *weak* (file-scope) copyleft license. Used as an unmodified npm dependency whose API you call (`new ELK()`), it does **not** force BigBlueBam to relicense. Your MIT code stays MIT. The obligations are: ship the EPL license text and keep the elkjs source available (it is public, so this is a NOTICE-file entry). The GPL-incompatibility you will read about in places like the Forgejo thread is a GPL-project problem, not an MIT-project problem.
- This is categorically different from the tldraw situation, which was a move to a source-available commercial license. EPL is OSI-approved FOSS.

Decision: ship ELK. Put it behind a `LayoutEngine` interface (`layout(graph, options) -> positions`) and keep a Dagre adapter (MIT) implementing the same interface. If your counsel ever objects to any copyleft in the tree, swapping engines is a one-file change and you lose only the non-layered algorithms. For pure tree layouts (org charts) `d3-hierarchy` (ISC) is a second permissive option already adjacent to the d3 you use in Beacon.

ELK runs in a web worker for interactive layout (the same web-worker pattern Beacon uses for ForceAtlas2). Agent and MCP-initiated layout on large graphs runs as a BullMQ job so it never blocks a request.

### Data model: relational graph is canonical, Yjs is the live layer

Board persists `boards.yjs_state` as the source of truth because freeform ink has no meaningful relational shape. Blueprint inverts that. The graph lives in `blueprint_nodes` and `blueprint_edges`; those tables are authoritative. A Yjs document (via Hocuspocus, the same server Board runs) carries only live multiplayer state: in-flight drag positions, selection, cursors, and awareness. On a settled mutation (node added, edge connected, label edited, drag released) the client writes through to the REST API, which persists to Postgres and broadcasts a `blueprint.*` event over Redis PubSub, exactly like the `task.*` pattern in the core API.

This keeps three properties the suite depends on:

1. Agents can read and mutate diagram structure as discrete tool calls, not by parsing a CRDT blob.
2. Every structural change is an `activity_log` row attributed to a human, agent, or service.
3. Diagrams are queryable (find every node that references task BBB-142, find every diagram an org member appears in).

Position churn during a drag is debounced: Yjs awareness handles the 60fps preview, and a single `move_node` write lands when the drag settles.

### Collaboration substrate: reuse Board's, do not rebuild it

Blueprint runs the same Hocuspocus + LiveKit + Redis PubSub stack Board already stands up. No new infrastructure services. The blueprint-api container hosts a Hocuspocus endpoint for the Yjs layer and a WebSocket channel for anchored comments and presence, and joins the existing LiveKit deployment for per-diagram audio. This is the "shared infrastructure compounds" principle: Blueprint is mostly a new data model and a layout engine bolted onto collaboration plumbing that exists.

### Diagram types and their default layout

| `diagram_type` | Default node shapes | Default ELK algorithm | Edge semantics |
|---|---|---|---|
| `flowchart` | rounded, diamond (decision), parallelogram (io) | `layered` (TB) | `flows_to`, conditional labels |
| `org_chart` | rounded (person card) | `mrtree` (TB) | `reports_to` |
| `erd` | container with column rows | `layered` (LR) | `one_to_one`, `one_to_many`, `many_to_many` |
| `mindmap` | ellipse/pill | `mrtree` (radial root) | `branch` |
| `swimlane` | rectangle inside lane containers | `layered` (LR), lanes as partitions | `flows_to` |
| `network` | hexagon, cylinder, actor | `force` or `rectpacking` | `connects_to` |
| `decision_tree` | diamond, rounded (outcome) | `mrtree` (TB) | labeled branch (`yes`/`no`/value) |
| `freeform_graph` | any | `manual` | `related_to` |

`diagram_type` drives defaults only. Shapes, edge kinds, and layout algorithm are all per-diagram overridable.

---

## Database Schema

New tables, all prefixed `blueprint_`, following suite conventions: `uuid` PKs via `gen_random_uuid()`, `org_id`/`project_id` FKs, `timestamptz` `created_at`/`updated_at`, `is_archived` soft delete, `jsonb` for flexible config, `double precision` for canvas coordinates. Drizzle table definitions live in `apps/blueprint-api/src/db/schema/` (one file per table) and are the TypeScript source of truth; the SQL below ships as a forward-only migration.

```sql
-- ─────────────────────────────────────────────────────────────────────────
-- 00NN_blueprint_tables.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Why: Introduces the Blueprint structured-diagram product (typed node/edge graph,
--      versions, templates, collaborators, anchored comments, stars).
-- Client impact: additive only — new tables, no changes to existing tables.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blueprint_diagrams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES projects(id) ON DELETE SET NULL,   -- NULL = org-level
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  name              varchar(200) NOT NULL,
  slug              varchar(200),
  description       text,
  diagram_type      varchar(32) NOT NULL DEFAULT 'flowchart',
  layout_algorithm  varchar(32) NOT NULL DEFAULT 'layered',            -- layered|mrtree|force|radial|rectpacking|manual
  layout_options    jsonb NOT NULL DEFAULT '{}'::jsonb,                -- direction, spacing, etc.
  canvas_settings   jsonb NOT NULL DEFAULT '{}'::jsonb,                -- background, grid, snap
  visibility        varchar(16) NOT NULL DEFAULT 'project',            -- organization|project|private
  yjs_state         bytea,                                            -- live-collab projection (ephemeral)
  thumbnail_key     text,                                             -- MinIO key for rendered preview
  is_archived       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprint_diagrams_org      ON blueprint_diagrams(org_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_diagrams_project  ON blueprint_diagrams(project_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_diagrams_active   ON blueprint_diagrams(org_id) WHERE is_archived = false;

CREATE TABLE IF NOT EXISTS blueprint_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  parent_node_id    uuid REFERENCES blueprint_nodes(id) ON DELETE CASCADE,  -- container/lane/subgraph membership
  shape             varchar(32) NOT NULL DEFAULT 'rounded',
  label             text NOT NULL DEFAULT '',
  description       text,                                             -- optional rich body (Tiptap JSON in `data`)
  position_x        double precision NOT NULL DEFAULT 0,
  position_y        double precision NOT NULL DEFAULT 0,
  width             double precision NOT NULL DEFAULT 160,
  height            double precision NOT NULL DEFAULT 56,
  z_index           integer NOT NULL DEFAULT 0,
  pinned            boolean NOT NULL DEFAULT false,                   -- exclude from auto-layout
  style             jsonb NOT NULL DEFAULT '{}'::jsonb,               -- fill, stroke, font
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,               -- type-specific (ERD columns, etc.)
  ref_entity_type   varchar(32),                                     -- cross-product embed: bam.task|beacon.entry|...
  ref_entity_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprint_nodes_diagram ON blueprint_nodes(diagram_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_nodes_parent  ON blueprint_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_nodes_ref     ON blueprint_nodes(ref_entity_type, ref_entity_id)
  WHERE ref_entity_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS blueprint_edges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  source_node_id    uuid NOT NULL REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  target_node_id    uuid NOT NULL REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  source_handle     varchar(64),                                     -- port/anchor id
  target_handle     varchar(64),
  kind              varchar(32) NOT NULL DEFAULT 'default',          -- routing or semantic kind
  label             text,
  marker_start      varchar(16) NOT NULL DEFAULT 'none',             -- none|arrow|arrowclosed|diamond|circle
  marker_end        varchar(16) NOT NULL DEFAULT 'arrowclosed',
  style             jsonb NOT NULL DEFAULT '{}'::jsonb,
  waypoints         jsonb,                                           -- manual routing points
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprint_edges_diagram ON blueprint_edges(diagram_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_edges_source  ON blueprint_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_edges_target  ON blueprint_edges(target_node_id);

CREATE TABLE IF NOT EXISTS blueprint_diagram_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  version_number    integer NOT NULL,
  label             varchar(200),
  snapshot          jsonb NOT NULL,                                  -- full nodes + edges + settings
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_blueprint_versions_diagram ON blueprint_diagram_versions(diagram_id);

CREATE TABLE IF NOT EXISTS blueprint_collaborators (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              varchar(16) NOT NULL DEFAULT 'editor',           -- owner|editor|commenter|viewer
  added_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_blueprint_collaborators_user ON blueprint_collaborators(user_id);

CREATE TABLE IF NOT EXISTS blueprint_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = system template
  name              varchar(200) NOT NULL,
  description       text,
  diagram_type      varchar(32) NOT NULL DEFAULT 'flowchart',
  definition        jsonb NOT NULL,                                  -- seed nodes + edges + settings
  is_system         boolean NOT NULL DEFAULT false,
  thumbnail_key     text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprint_templates_org ON blueprint_templates(org_id);

CREATE TABLE IF NOT EXISTS blueprint_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  node_id           uuid REFERENCES blueprint_nodes(id) ON DELETE CASCADE,  -- NULL = diagram-level
  author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  body              text NOT NULL,
  body_plain        text,
  resolved          boolean NOT NULL DEFAULT false,
  edited_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blueprint_comments_diagram ON blueprint_comments(diagram_id);
CREATE INDEX IF NOT EXISTS idx_blueprint_comments_node    ON blueprint_comments(node_id);

CREATE TABLE IF NOT EXISTS blueprint_stars (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, user_id)
);
```

Notes:

- No `human_id` on diagrams. Board got by without one and diagrams behave like documents, not tickets. `slug` covers shareable URLs.
- `blueprint_nodes.parent_node_id` is self-referential and carries containers, swimlane membership, and subgraphs. Swimlanes are just container nodes whose children layout into a partition.
- ERD columns, decision conditions, and org-chart person references all live in `nodes.data` so the table shape stays stable across diagram types. Tiptap rich bodies for a node serialize into `data.body`.
- A second migration seeds system templates (`blueprint_templates` with `is_system = true`), matching how Board seeds its 10 templates.

---

## REST API Catalog

Mounted under `/blueprint/api/` (nginx proxies to `blueprint-api`). Routes grouped by file in `apps/blueprint-api/src/routes/`. Every input validated with Zod schemas from `@bigbluebam/shared`; every mutation writes `activity_log` and publishes a Redis PubSub event.

| Method | Path | Description | Permission |
|---|---|---|---|
| GET | `/diagrams` | List diagrams in scope (filter by project, type, starred) | member / visibility |
| POST | `/diagrams` | Create a diagram | member |
| GET | `/diagrams/:id` | Get diagram metadata + counts | view |
| PATCH | `/diagrams/:id` | Update metadata, type, layout, settings, visibility | edit |
| POST | `/diagrams/:id/archive` | Archive (soft delete) | owner / project admin |
| GET | `/diagrams/:id/graph` | Full graph (nodes + edges + settings) in one payload | view |
| GET | `/diagrams/:id/nodes` | List nodes (optional filter) | view |
| POST | `/diagrams/:id/nodes` | Add a node | edit |
| PATCH | `/diagrams/:id/nodes/:nodeId` | Update label/shape/style/data | edit |
| POST | `/diagrams/:id/nodes/:nodeId/move` | Reposition (debounced drag-settle write) | edit |
| DELETE | `/diagrams/:id/nodes/:nodeId` | Delete node (cascade edges) | edit |
| POST | `/diagrams/:id/edges` | Connect two nodes | edit |
| PATCH | `/diagrams/:id/edges/:edgeId` | Update label/kind/markers/style | edit |
| DELETE | `/diagrams/:id/edges/:edgeId` | Remove edge | edit |
| POST | `/diagrams/:id/layout` | Run auto-layout, return + persist new positions | edit |
| POST | `/diagrams/:id/generate` | Build/extend the graph from a structured spec or NL prompt | edit |
| POST | `/diagrams/:id/import` | Import Mermaid or Graphviz DOT, materialize nodes/edges | edit |
| GET | `/diagrams/:id/export` | Export SVG / PNG / JSON / Mermaid / DOT (`?format=`) | view |
| GET | `/diagrams/:id/versions` | List version snapshots | view |
| POST | `/diagrams/:id/versions` | Snapshot current state | edit |
| POST | `/diagrams/:id/versions/:n/restore` | Restore a snapshot | edit |
| GET/POST | `/diagrams/:id/comments` | List / add anchored or diagram-level comments | view / commenter |
| PATCH | `/diagrams/:id/comments/:cid` | Edit / resolve a comment | author / edit |
| GET/POST/DELETE | `/diagrams/:id/collaborators` | Manage per-diagram sharing | owner |
| POST | `/diagrams/:id/star` / DELETE | Star / unstar | member |
| GET | `/templates` | List system + org templates | member |
| POST | `/diagrams/:id/nodes/:nodeId/promote-to-task` | Create a Bam task from a node (cross-product) | edit + Bam project member |
| POST | `/diagrams/:id/nodes/:nodeId/link-entity` | Attach a cross-product entity reference to a node | edit |

WebSocket: `wss://DOMAIN/blueprint/ws` (Hocuspocus for the Yjs layer, plus a comments/presence channel), proxied to `blueprint-api`.

---

## MCP Tool Registry (`blueprint-tools.ts`)

20 tools. Read tools available to any authenticated user; write tools require `read_write`; archive and config changes require `admin`. Destructive tools (`blueprint_delete_node`, `blueprint_delete_edge`, `blueprint_archive`) use the existing 60-second `confirm_action` token dance. Every call audits to `activity_log` with an `mcp.` action prefix.

| Tool | Description | Permission |
|---|---|---|
| `blueprint_list` | List diagrams in scope, filterable by project and type | any authenticated user |
| `blueprint_get` | Get a diagram's metadata, type, layout config, and counts | any authenticated user |
| `blueprint_read_nodes` | Read nodes (optionally filtered by shape or ref-entity) | any authenticated user |
| `blueprint_read_edges` | Read edges, with resolved source/target labels | any authenticated user |
| `blueprint_search` | Search diagrams by name, description, and node labels | any authenticated user |
| `blueprint_export` | Export a diagram to SVG / PNG / JSON / Mermaid / DOT | any authenticated user |
| `blueprint_create` | Create a diagram (type, name, project, visibility) | read_write |
| `blueprint_update` | Update metadata, diagram type, layout algorithm, settings | read_write |
| `blueprint_archive` | Archive a diagram (destructive — requires confirmation) | admin |
| `blueprint_add_node` | Add a node (shape, label, optional parent container) | read_write |
| `blueprint_update_node` | Update a node's label, shape, style, or data | read_write |
| `blueprint_move_node` | Reposition a node (and pin it against auto-layout) | read_write |
| `blueprint_delete_node` | Delete a node and its edges (destructive — confirm) | read_write |
| `blueprint_add_edge` | Connect two nodes with a kind, label, and markers | read_write |
| `blueprint_update_edge` | Relabel, restyle, or retype an edge | read_write |
| `blueprint_delete_edge` | Remove an edge (destructive — confirm) | read_write |
| `blueprint_apply_layout` | Run auto-layout (algorithm + options); large graphs offload to worker | read_write |
| `blueprint_generate` | Build or extend a diagram from a structured node/edge spec or NL description, then auto-layout | read_write |
| `blueprint_promote_node_to_task` | Create a Bam task from a node and back-link it | read_write |
| `blueprint_link_entity` | Attach a cross-product reference (bam.task, beacon.entry, bearing.goal, bond.deal) to a node | read_write |

`blueprint_generate` is the tool that carries the product's whole pitch. An agent can be handed "make an org chart from this org's membership," call `list_members`, emit a node per person plus `reports_to` edges in one `blueprint_generate` call, and the server runs ELK `mrtree` to produce a clean chart. Or: read a Brief process doc, emit a swimlane graph, lay it out. The human opens a finished, editable diagram, not a wall of text.

MCP resources:

| URI | Description |
|---|---|
| `bigbluebam://blueprint/diagrams` | Accessible diagrams |
| `bigbluebam://blueprint/diagrams/{id}` | Full graph payload |
| `bigbluebam://blueprint/diagrams/{id}/mermaid` | Diagram serialized as Mermaid (context-friendly) |

---

## Realtime Events

Published to Redis PubSub channel `blueprint:{diagramId}`, fanned out by the blueprint-api WebSocket hub to clients in the diagram room. Same mechanism as the core API's `task.*` events.

| Event | Payload |
|---|---|
| `blueprint.node.created` | Full node |
| `blueprint.node.updated` | Node id + changed fields |
| `blueprint.node.moved` | Node id + new position |
| `blueprint.node.deleted` | Node id (+ cascaded edge ids) |
| `blueprint.edge.created` | Full edge |
| `blueprint.edge.updated` | Edge id + changed fields |
| `blueprint.edge.deleted` | Edge id |
| `blueprint.layout.applied` | Map of node id to new position |
| `blueprint.diagram.updated` | Diagram id + changed metadata |
| `blueprint.comment.created` | Comment object |
| `user.presence` | Awareness (cursor, selection) via Yjs |

Conflict resolution mirrors the core API: field updates are last-write-wins with an `updated_at` stale check (HTTP 409 on mismatch, client refetches). Live drag positions reconcile through Yjs awareness so two people dragging the same node animate to the authoritative settled position.

---

## BullMQ Jobs (`apps/worker/src/jobs/`)

| Job | Trigger | Work |
|---|---|---|
| `blueprint-thumbnail` | Debounced on graph change | Headless render of the diagram to PNG, upload to MinIO, set `thumbnail_key` |
| `blueprint-layout` | `blueprint_apply_layout` / `generate` on graphs above N nodes | Run ELK off the request path, persist positions, publish `blueprint.layout.applied` |
| `blueprint-export` | Heavy SVG/PDF exports | Render and stage a download artifact in MinIO, notify the requester |

Interactive layout for small and medium graphs stays client-side in a web worker (`elk.bundled.js`), so the worker job exists only for agent-initiated or large-graph cases.

---

## Permissions and Visibility

Blueprint reuses the org and project role model and adds per-diagram collaborators, mirroring Brief and Beacon exactly:

- `visibility = 'organization'` — any member of the org can view.
- `visibility = 'project'` — project members can view; edit follows project role.
- `visibility = 'private'` — only the creator and explicit `blueprint_collaborators`.

Per-diagram roles (`owner`, `editor`, `commenter`, `viewer`) layer on top for sharing a single diagram outside its default scope.

### Agents as first-class users

Agents hold standard user records (`users.kind ∈ {human, agent, service}`) and get no special permission tier; their behavioral config is tracked separately for audit. Two integration points are required when Blueprint ships:

1. Add `blueprint.diagram` (and optionally `blueprint.node`) to the `can_access` visibility preflight allowlist in `apps/api/src/services/visibility.service.ts` (`SUPPORTED_ENTITY_TYPES`). The rule mirrors Beacon: organization-visible, private-owner-only, or project-member. Until this lands, agents must not surface Blueprint entities cross-audience (the `agent-conventions.md` deny-by-default rule). Note this closes the Wave 3 gap: the conventions doc lists Board, Bearing, Blast, and others for Wave 3 coverage but predates Blueprint, so Blueprint needs to be added to that list.
2. Agent-authored diagram generation that needs human sign-off routes through the unified `/b3/approvals` proposal surface rather than inventing its own channel.

---

## Docker and nginx

New service in `docker-compose.yml`:

```yaml
  blueprint-api:
    build: { context: ., dockerfile: apps/blueprint-api/Dockerfile }
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      LIVEKIT_URL: ${LIVEKIT_URL}
      PORT: 4011                      # next free app port — reconcile against your live port map
    depends_on:
      migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
```

The blueprint SPA builds into the single `frontend` nginx container alongside the existing SPAs. nginx routes to add:

```
location /blueprint/api/ { proxy_pass http://blueprint-api:4011/; }
location /blueprint/ws   { proxy_pass http://blueprint-api:4011/ws; }   # Hocuspocus + comments/presence
location /blueprint/     { try_files $uri /blueprint/index.html; }
```

Port 4011 is an assumption. Known-occupied from the architecture and Board docs are 4000 (api), 4001 (helpdesk), 4002 (banter), 4003 (voice-agent), 4004 (beacon), 4008 (board). Confirm the next free slot against your current compose file and adjust.

The MCP server gains `apps/mcp-server/src/tools/blueprint-tools.ts`, registered like the existing 12 tool modules, calling blueprint-api over the internal Docker network (`BLUEPRINT_API_URL=http://blueprint-api:4011`).

---

## Frontend

`apps/blueprint/` React 19 SPA. Suite stack (TanStack Query v5, Zustand, Radix UI, Motion, Tailwind v4) plus:

- `@xyflow/react` — canvas, nodes, edges, handles, minimap, controls
- `elkjs` (web worker) + a Dagre adapter behind a `LayoutEngine` interface
- `yjs` + `@hocuspocus/provider` — live multiplayer layer
- `@livekit/components-react` — per-diagram audio (reused from Board)
- `tiptap` — rich node bodies and comment composer (reused from Brief/Bam)
- `html-to-image` — client-side SVG/PNG export

Component layout: `components/canvas/` (BlueprintCanvas, custom node types per shape, custom edge types, ConnectionLine), `components/palette/` (shape and template palette), `components/inspector/` (node/edge property panel), `components/toolbar/` (layout picker, export, type switch), `components/sidebar/` (collaborators, versions, comments, audio), `hooks/` (useDiagramGraph, useLayout, useRealtime, usePresence), `stores/` (Zustand: selection, viewport, draft state), `pages/` (DiagramList, DiagramEditor, TemplateBrowser).

### ASCII wireframe — diagram editor

```
+--------------------------------------------------------------------------------+
|  Blueprint  [ Org Chart v ]   <Diagram name>        [Auto-layout v] [Export v] |  toolbar
+------+------------------------------------------------------------+------------+
|      |                                                            |            |
| P    |                  +-----------+                             | Inspector  |
| a    |                  |   CEO     |                             |            |
| l    |                  +-----+-----+                             | Shape: box |
| e    |                        |                                   | Fill:  #...|
| t    |          +-------------+-------------+                     | Stroke:... |
| t    |          |                           |                     | Label: ... |
| e    |    +-----+-----+               +-----+-----+               |            |
|      |    |   CTO     |               |   CFO     |               | [Promote   |
| []   |    +-----------+               +-----------+               |  to Task]  |
| ()   |                                                            |            |
| <>   |        (drag to connect  -  ELK auto-arranges)             | Comments(2)|
|      |                                                            |            |
+------+------------------------------------------------------------+------------+
| [+ Node]  [Fit]  Zoom 100%        o Eddie  o Agent:Drafter   [Mute] [Audio on] |  status
+--------------------------------------------------------------------------------+
```

### ASCII wireframe — diagram list

```
+--------------------------------------------------------------------------------+
|  Blueprint              [All types v]  [Project v]  [* Starred]   [+ New v]     |
+--------------------------------------------------------------------------------+
|  +----------------+  +----------------+  +----------------+  +----------------+ |
|  | [ thumbnail ]  |  | [ thumbnail ]  |  | [ thumbnail ]  |  | [ thumbnail ]  | |
|  | Onboarding     |  | Q3 Org Chart   |  | Auth ERD       |  | Deploy Flow    | |
|  | flowchart * .  |  | org_chart  .   |  | erd        .   |  | flowchart  .   | |
|  +----------------+  +----------------+  +----------------+  +----------------+ |
+--------------------------------------------------------------------------------+
```

---

## Build Agent Breakdown (10 agents)

Mirrors the Board build structure. Day estimates assume one focused build agent per track.

| # | Agent | Scope | Est. |
|---|---|---|---|
| 1 | DB migration + Drizzle schema | `00NN_blueprint_tables.sql` (7 tables) + Drizzle defs + system-template seed migration | 1.5 d |
| 2 | blueprint-api backend (routes + services) | 8 route files, graph/node/edge/layout/version/template/comment services, auth guards | 4 d |
| 3 | blueprint-api WebSocket + collab | Hocuspocus Yjs plugin, Yjs persistence + reconcile-to-relational, presence + comments channel, LiveKit room management | 3 d |
| 4 | Frontend canvas (React Flow) | Canvas, custom node types per shape, custom edges, connection handling, multitouch (`touch-action:none`), drag-settle write-through | 4.5 d |
| 5 | Frontend layout + import/export | `LayoutEngine` interface, ELK web worker, Dagre adapter, layout picker UI, Mermaid/DOT import, SVG/PNG/JSON export | 3 d |
| 6 | Frontend list, inspector, sidebar | Diagram list, template browser, node/edge inspector, versions panel, collaborators, comments, audio panel | 3.5 d |
| 7 | MCP tools (20) | `blueprint-tools.ts` incl. `blueprint_generate` + `blueprint_apply_layout`, Zod schemas, confirm-action wiring, resources | 3 d |
| 8 | Docker / nginx + cross-app nav | blueprint-api service, nginx routes, frontend Dockerfile, nav pills added to existing SPAs | 1.5 d |
| 9 | Templates + seed data | System templates (flowchart, org chart, ERD, swimlane, decision tree, mind map, network), demo diagrams, screenshot script | 2 d |
| 10 | Tests + security audit | Route tests (graph CRUD, layout, versions, auth, visibility), MCP tool tests, security audit + P0/P1 fixes, add `blueprint.diagram` to `can_access` | 3 d |

Critical path runs 1 → 2 → (3, 4 in parallel) → 5/6/7 → 8/9 → 10. Roughly three to three and a half weeks of build-agent time, with the canvas (Agent 4) and backend (Agent 2) as the long poles.

---

## Decisions Made and Open Questions

Resolved in this spec so they don't block the build:

- Rendering is React Flow; layout is ELK with a Dagre escape hatch behind one interface.
- The relational graph is canonical; Yjs is the live layer only. This is the deliberate inversion of Board's blob-of-truth model.
- Diagrams have no `human_id`; `slug` covers shareable URLs.
- Swimlanes, containers, and subgraphs are all `parent_node_id` relationships, not a separate table.

Two things genuinely need your call:

1. **The blueprint-api port (4011 used throughout).** Confirm the next free slot against your live `docker-compose.yml`; I could only verify 4000-4004 and 4008 as occupied from the docs.
2. **EPL-2.0 tolerance.** ELK is the strong technical pick and the EPL obligation is trivial for an MIT project (NOTICE entry, no relicensing). If you want zero copyleft anywhere in the dependency tree as a matter of policy, say so and Blueprint ships on Dagre for layered diagrams plus `d3-hierarchy` for trees, losing the force/radial/rectpacking algorithms. Given the tldraw scar, your instinct here is the deciding input, not mine.
