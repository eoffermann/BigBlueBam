# Blueprint - App Dossier

Code-only investigation (manifest flags docs_exists: false; there is no docs/apps/blueprint/ directory and no screenshots). Sourced from backend routes, the React SPA, and the MCP tool module. Paths cited inline. Plan/marketing intent the code does not implement is flagged in Discrepancies.

---

## 1. App identity

- app_key: blueprint
- Display name: Blueprint
- Category: Structured diagrams
- SPA path: /blueprint/ (React + Vite SPA, apps/blueprint/src/main.tsx)
- API path: /blueprint/api/ -> blueprint-api Fastify service, internal port 4015, routes under /v1 (apps/blueprint-api/src/server.ts)
- WebSocket: /blueprint/ws (no /v1 prefix), realtime document sync (apps/blueprint-api/src/routes/ws.routes.ts)
- Prerequisites:
  - A BigBlueBam account/session. The SPA refuses to load unauthenticated and links to /b3/ to log in (apps/blueprint/src/app.tsx lines 120-132). Auth is the shared session cookie or a bbam_ / bbam_svc_ Bearer API key (apps/blueprint-api/src/plugins/auth.ts).
  - For the Bam-integration features (generate-from-Bam, promote-to-tasks, two-way sync): a Bam project with tasks and a shared session, since the SPA performs the second hop directly against /b3/api/.
- One-liner: A diagram editor whose diagrams are a typed relational graph (blueprint_nodes + blueprint_edges), not an opaque blob, so every structural change is an auditable API call and an MCP tool, and a node can be linked to / promoted to / generated from a Bam task.

---

## 2. Key concepts and vocabulary

- Diagram - top-level artifact: name, slug, description, diagram_type, layout_algorithm, visibility, is_archived, optional project_id. (blueprint-diagrams.ts)
- diagram_type - free-form tag (default flowchart). UI dropdown: Flowchart, Graph, Sequence, Class, Mind map. Sidebar uses the same five. Export/import also recognizes org_chart, decision_tree, mindmap. Generate-from-Bam writes org_chart.
- layout_algorithm - stored ELK default (default layered). ELK-supported in code: layered, mrtree, force, radial, rectpacking, plus manual. Editor dropdown labels: Layered / Force-directed / Tree / Grid.
- visibility - organization / project / private. organization+project readable by anyone in org; private is creator-or-collaborator only. (diagram.service.ts)
- Node - graph vertex: shape, label, description (markdown), position_x/y, width/height, z_index, pinned, style JSONB, data JSONB, parent_node_id (nesting), ref_entity_type/ref_entity_id (cross-product link). (blueprint-nodes.ts, node.service.ts)
- shape - free-form tag (default rounded). UI palette: Rounded, Rectangle, Diamond, Ellipse, Hexagon. Renderer aliases process->rectangle, decision->diamond, start/end->ellipse, preparation->hexagon for imported Mermaid. (node-types.tsx)
- Edge - connection: source_node_id, target_node_id, source_handle/target_handle, kind (default default), label, marker_start (default none), marker_end (default arrowclosed), style, waypoints. (blueprint-edges.ts)
- edge kind - UI options: Default, Dependency, Flow, Reference, Inherits. Free-form on the API.
- end marker - UI: Filled arrow (arrowclosed), Open arrow (arrow), No arrow / None (none).
- pinned - node excluded from auto-layout; keeps its hand-set position.
- ref_entity_type / ref_entity_id - cross-product link. Canonical types in tool docs: bam.task, beacon.entry, bearing.goal, bond.deal, bond.contact, helpdesk.ticket. Only bam.task has live two-way sync.
- Version (snapshot) - immutable JSONB snapshot of the full graph, auto-numbered per diagram, optional label, restorable (replaces nodes/edges). (blueprint-versions.ts)
- Collaborator - per-diagram ACL row, role owner/editor/commenter/viewer. Gates edit on private diagrams. (blueprint-collaborators.ts)
- Comment - diagram-level or node-anchored (node_id) rich-text comment with resolved flag. (blueprint-comments.ts)
- Star - per-user favorite toggle.
- Template - reusable diagram definition (JSONB), org-scoped or is_system, selectable at create time. (blueprint-templates.ts)
- Promote to tasks / Generate from Bam - the two cross-product round-trip flows: graph -> Bam tasks, and Bam tasks -> graph.

---

## 3. Backend REST inventory

All under /blueprint/api/v1 unless noted. requireAuth on every route; requireScope read_write on mutations, requireScope admin on archive. Error envelope: { error: { code, message, details, request_id } }. Mutations publish Bolt events (source blueprint) and broadcast a typed BlueprintEvent on Redis channel blueprint:diagramId.

Diagrams (diagrams.routes.ts):
- GET /diagrams - list visible diagrams. Query: project_id, diagram_type, starred=true, include_archived=true. Hides private diagrams the caller cannot see; caps 500; orders by updated_at desc.
- POST /diagrams - create. Body: name (1-200, required), description, project_id, diagram_type, layout_algorithm, visibility, layout_options, canvas_settings, template_id. Defaults: type flowchart, algo layered, visibility project. Emits diagram.created. template_id accepted but NOT applied.
- GET /diagrams/:id - metadata. assertCanRead.
- PATCH /diagrams/:id - update metadata. Emits diagram.updated; broadcasts blueprint.diagram.updated.
- POST /diagrams/:id/archive - soft-delete (is_archived). Requires admin scope. Emits diagram.archived.
- GET /diagrams/:id/graph - one payload { diagram, nodes, edges }. Primary editor read.
- GET /diagrams/:id/nodes - list nodes.
- GET /diagrams/:id/edges - list edges.
- POST /diagrams/:id/layout - ELK auto-layout, persists positions. Body: algorithm, direction (UP/DOWN/LEFT/RIGHT), spacing, node_node_spacing, layer_spacing. Graphs over LAYOUT_INPROCESS_NODE_LIMIT (default 200) return HTTP 202 status=queued. Pinned nodes stay put. Emits layout.applied; broadcasts blueprint.layout.applied.
- POST /diagrams/:id/generate - build graph from a structured spec. Body: nodes[] (1-500: ref, label, shape, parent_ref, ref_entity_type, ref_entity_id), edges[] (max 2000: source_ref, target_ref, label, kind), auto_layout (default true), replace. Returns { graph, layout }. Emits diagram.generated.
- POST /diagrams/:id/import - import Mermaid. Body: format=mermaid, source (max 200000 chars), replace. Permissive flowchart parser. Emits diagram.imported.
- GET /diagrams/:id/export - export. Query format: json, mermaid (in-process). svg/png raise a validation error in-process (deferred to worker).
- GET /diagrams/:id/versions - list snapshots (newest first).
- POST /diagrams/:id/versions - snapshot current graph. Body: optional label. Auto-increments version_number.
- POST /diagrams/:id/versions/:n/restore - replace graph with version n (transactional).
- POST /diagrams/:id/star and DELETE /diagrams/:id/star - star/unstar. Any authenticated reader.
- GET/POST /diagrams/:id/collaborators, DELETE /diagrams/:id/collaborators/:userId - list/add-update/remove. role owner/editor/commenter/viewer (default editor); upsert on (diagram,user).
- GET/POST /diagrams/:id/comments, PATCH /diagrams/:id/comments/:cid - list/add/edit-resolve. node_id null = diagram-level. Broadcasts blueprint.comment.created.

Nodes (nodes.routes.ts):
- POST /diagrams/:id/nodes - create (defaults rounded, 160x56). Emits node.created; broadcasts blueprint.node.created.
- PATCH /diagrams/:id/nodes/:nodeId - update label/shape/description/size/z_index/pinned/style/data/parent/ref. A bam.task-linked node whose label/description changes pushes the change to Bam via /internal/sync-from-blueprint. Broadcasts blueprint.node.updated.
- POST /diagrams/:id/nodes/:nodeId/move - persist drag. Body: position_x, position_y, optional pinned. Broadcasts blueprint.node.moved.
- POST /diagrams/:id/nodes/:nodeId/duplicate - clone (+32,+32 default). Edges NOT copied. Emits node.created.
- DELETE /diagrams/:id/nodes/:nodeId - delete; FK-cascades edges. Broadcasts blueprint.node.deleted with cascaded_edge_ids.
- POST /diagrams/:id/nodes/:nodeId/link-entity - set ref_entity_type + ref_entity_id.
- POST /diagrams/:id/nodes/:nodeId/promote-to-task - returns a task_payload the CALLER posts to Bam (no server-side create). Body: project_id (required), phase_id, sprint_id, title.

Edges (edges.routes.ts):
- POST /diagrams/:id/edges - create. Emits edge.created; broadcasts blueprint.edge.created.
- PATCH /diagrams/:id/edges/:edgeId - update handles/kind/label/markers/style/waypoints. Broadcasts blueprint.edge.updated.
- DELETE /diagrams/:id/edges/:edgeId - delete. Broadcasts blueprint.edge.deleted.

Templates (templates.routes.ts):
- GET /templates - list org + is_system templates. (No create/update/delete endpoints exist.)

Cross-product (cross-product.routes.ts):
- POST /diagrams/:id/promote-to-tasks - returns a PLAN (tasks_to_create, parent_links_to_create, total_steps) under edge_direction (source-parent/target-parent/none). Does NOT create tasks. Emits diagram.promoted_to_tasks.
- POST /diagrams/from-bam - materialize a NEW diagram from a Bam project tasks (one node/task; edges from tasks.parent_task_id and the task_parent_links m2m). Skips completed unless include_completed. Auto-layout layered. Writes diagram_type=org_chart. Emits diagram.generated.
- POST /internal/sync-from-task - INTERNAL (secret-auth, not user). Bam calls it when a linked task title/description changes; updates every linked node and broadcasts.

WebSocket (ws.routes.ts):
- GET /ws (no /v1). Client sends a subscribe frame with diagram_id; access-gated by assertCanRead. Server forwards BlueprintEvents verbatim plus subscribed/error/ping (25s). Document-only sync; viewport never crosses the wire. SPA hook (use-diagram-sync.ts) treats any blueprint.* event as invalidate-and-refetch (debounced 200ms).

User-facing rule highlights: name 1-200; description max 5000 (diagram) / 10000 (node); generate caps 500 nodes / 2000 edges; Mermaid import max 200000 chars; inspector width/height 40-2000 (schema allows up to 5000); archive needs admin scope; private diagrams need creator or collaborator; commenter/viewer collaborators cannot edit a private diagram.

---

## 4. Frontend feature inventory (exact labels)

Three SPA routes (apps/blueprint/src/app.tsx): list (/blueprint/), editor (/blueprint/d/:id), help (/blueprint/help, opened with the ? key, rendered by the shared HelpViewer). Chrome: left sidebar (hidden on the editor), top header with Launchpad, breadcrumbs (Diagrams / Editor), OrgSwitcher, NotificationsBell, UserMenu.

### 4.1 Sidebar (blueprint-sidebar.tsx)
- App title Blueprint with a sparkle logo.
- Button: New diagram (opens the create dialog).
- Section Library: filter pills All diagrams, Starred, Archived (each with a count badge).
- Section By type: pills Flowcharts, Graphs, Sequence, Class, Mind maps (plus any extra types the org has). Counts derived client-side from the full list.
- Footer: shared platform user/footer block.

### 4.2 Diagram list page (pages/list.tsx)
- Heading reflects the active filter: All diagrams / Starred diagrams / Archived diagrams / <Type> diagrams. Subtitle: Design flowcharts, graphs, and reference diagrams. Promote any node into a Bam task with one click.
- Split button: New diagram plus a chevron menu with Blank diagram or template and From Bam project tasks...
- Search box placeholder: Search diagrams... (client-side filter on name + description).
- Diagram cards: type icon, name, type label, Star toggle (title Star/Unstar), and a More (...) menu with Open editor, Star/Unstar, Archive (destructive; window.confirm Archive name?). Card footer shows visibility (Private/Project/Organization with lock/users/globe icon) and relative updated time. Clicking a card opens the editor.
- Empty states per filter (No diagrams yet, No starred diagrams, No matching diagrams, etc.) with a New diagram CTA.

New diagram dialog (title New diagram, subtitle Pick a name, type, and (optionally) a template to start from.): fields Name; Type (Flowchart/Graph/Sequence/Class/Mind map); Project (optional) (None - org-wide, or a project); Visibility radio cards Private (Only you) / Project (Project members, or Org if no project) / Organization (Everyone in org); Template (optional) (Blank canvas, or org/system templates with a system suffix). Buttons Cancel / Create diagram. On success navigates to the new editor. -> POST /diagrams.

From Bam dialog (title Generate from Bam project, subtitle Materialize a Blueprint diagram with one node per task and edges drawn from existing parent/child links. Linked nodes stay in sync with their Bam tasks afterwards.): field Project; checkboxes Include completed tasks and Run auto-layout (layered, top-to-bottom). Buttons Cancel / Generate (Generating...). -> POST /diagrams/from-bam.

### 4.3 Editor page (pages/editor.tsx, React Flow / xyflow)
Top bar (left to right):
- Back arrow (title Back to diagrams) -> list.
- Diagram name + uppercase type chip + an N nodes . M edges subtitle.
- Add node split button: body reads Add <last shape> with an N keyboard hint; chevron menu lists all shapes (Rounded/Rectangle/Diamond/Ellipse/Hexagon) with a Last badge on the most-recent.
- Layout controls: algorithm select (Layered / Force-directed / Tree / Grid), direction select (Top to bottom / Left to right / Bottom to top / Right to left), Apply layout button. -> POST /diagrams/:id/layout.
- PresenceChipStrip (shared presence avatars for the surface).
- Save snapshot (camera icon; window.prompt for an optional label) -> POST /diagrams/:id/versions.
- Export dropdown: Mermaid (.mmd), JSON, separator, Reload from server. -> GET /diagrams/:id/export?format=.
- Promote to Bam (sky button; tooltip Create one Bam task per node and wire parent/child links). Prompts for project id (if the diagram has none) and edge direction, then runs the multi-step plan with a progress overlay. -> POST /diagrams/:id/promote-to-tasks, then per-task POST /b3/api/projects/:id/tasks, POST /b3/api/tasks/:id/parents, and a back-link link-entity.
- Archive (window.confirm) -> POST /diagrams/:id/archive, returns to list.

Canvas: React Flow with Dots background, Controls (bottom-left), MiniMap (bottom-right), fitView, attribution hidden, default edges smoothstep + closed arrow. Dragging a connection from a node handle onto empty canvas opens an Add connected node palette at the drop point; picking a shape creates the node pre-wired (direction follows the drag). Selected nodes get resize handles (NodeResizer); resize persists width/height. Connecting two handles creates an edge.

Right-click context menus (CanvasContextMenu):
- Pane menu: Add node (each shape, Last badge), Reorganize (each layout algorithm, Current badge), Align -> Snap to grid (toggle, checkmark) and Snap nodes to grid now, Save snapshot, Export as Mermaid, Export as JSON, Archive diagram (destructive).
- Node menu: Duplicate (Cmd/Ctrl+D), Pin position / Unpin (allow auto-layout), Change shape (list), Fill color swatches (White/Red/Amber/Green/Blue/Violet/Pink/Zinc/Clear), Link to entity..., Promote to Bam task, Delete node (Del, destructive).
- Connect-drop menu: Add connected node shape list.
- Edge menu: Edge kind (Default/Dependency/Flow/Reference/Inherits), End marker (Filled arrow/Open arrow/No arrow), Delete edge (Del, destructive).

Inspector (right panel, inspector.tsx), shown when a node or edge is selected:
- Node panel: header Node + short id, Pin toggle, Delete (trash). Fields Label; Description (markdown rich-text editor, placeholder Describe this node... bold, italic, code, links all work.); Shape select; Width/Height (40-2000); Fill color swatches + Clear. Linked entity section: type + entity id (uuid) inputs, Link button, Promote to task button.
- Edge panel: header Edge + short id, Delete. Fields Label, Kind, End marker.
- Empty state: Nothing selected - Click a node or edge to edit it. Press N to add a new node.

Dialogs/overlays:
- NodeDeletePromptDialog - when deleting a node linked to a bam.task: Delete name? with buttons Cancel, Delete node only, Delete node + task (the last also DELETEs /b3/api/tasks/:id).
- PromotionProgressOverlay - progress bar, per-step label, success summary (Created N tasks . reused M existing . wired K parent links), and an error list.

Keyboard shortcuts (editor): N add node (last shape), Cmd/Ctrl+D duplicate selected node, Delete/Backspace delete selection, Esc close menus; ? (global) opens Help. Local persistence: last-used shape and snap-to-grid in localStorage (bp.lastShape, bp.snapToGrid); theme from bbam-theme.

Frontend gaps vs backend: the SPA has hooks for versions list (useVersions), restore (useRestoreVersion), and Mermaid import (useImportMermaid), but NO rendered UI to browse/restore versions or paste Mermaid for import. Collaborators and comments have NO UI at all (read/write via API/MCP only). See Discrepancies.

---

## 5. Feature -> route/tool cross-map

| Feature | UI location & label | Route(s) | MCP tool(s) |
|---|---|---|---|
| Browse/filter diagrams | Sidebar pills + list grid | GET /diagrams | blueprint_list, blueprint_search |
| Create diagram | New diagram dialog | POST /diagrams | blueprint_create |
| Create from template | Template (optional) select | POST /diagrams (template_id) | blueprint_create (template_id) - NOT applied server-side |
| Edit diagram metadata | (no dedicated UI; rename via API/MCP) | PATCH /diagrams/:id | blueprint_update |
| Open editor / read graph | Card click | GET /diagrams/:id, /graph, /nodes, /edges | blueprint_get, blueprint_read_nodes, blueprint_read_edges |
| Add node | Add shape, pane menu, connect-drop, N key | POST /diagrams/:id/nodes | blueprint_add_node |
| Edit node | Inspector fields, node context menu | PATCH /diagrams/:id/nodes/:nodeId | blueprint_update_node |
| Move node | Drag on canvas | POST .../nodes/:nodeId/move | blueprint_move_node |
| Duplicate node | Duplicate (Cmd/Ctrl+D) | POST .../duplicate | blueprint_duplicate_node |
| Delete node | Delete node (Del) | DELETE .../nodes/:nodeId | blueprint_delete_node (confirm_action) |
| Add edge | Drag handle to handle / connect-drop | POST /diagrams/:id/edges | blueprint_add_edge |
| Edit edge | Inspector / edge context menu | PATCH .../edges/:edgeId | blueprint_update_edge |
| Delete edge | Delete edge (Del) | DELETE .../edges/:edgeId | blueprint_delete_edge (confirm_action) |
| Auto-layout | Apply layout / Reorganize menu | POST /diagrams/:id/layout | blueprint_apply_layout |
| Build graph from spec | (agent-driven; no direct UI) | POST /diagrams/:id/generate | blueprint_generate |
| Import Mermaid | (hook exists, NO UI) | POST /diagrams/:id/import | (no import tool) |
| Export | Export -> Mermaid/JSON | GET /diagrams/:id/export | blueprint_export |
| Versions / snapshot | Save snapshot (create only; NO restore UI) | POST/GET /versions, POST /versions/:n/restore | (no version tools) |
| Star / unstar | Card star toggle | POST/DELETE /diagrams/:id/star | (none) |
| Archive | Archive (card + editor + pane menu) | POST /diagrams/:id/archive | blueprint_archive (confirm_action, admin) |
| Collaborators | (NO UI) | GET/POST/DELETE /collaborators | (none) |
| Comments | (NO UI) | GET/POST/PATCH /comments | (none) |
| Snap to grid | Snap to grid / Snap nodes to grid now | (client-side + move) | (none) |
| Fill color | Inspector + node menu swatches | PATCH node style | blueprint_update_node (style) |
| Pin node | Pin toggle / node menu | PATCH node pinned, or move pinned | blueprint_update_node / blueprint_move_node |
| Link node to entity | Link to entity... / inspector Link | POST .../link-entity | blueprint_link_entity |
| Promote node to task | Promote to Bam task / Promote to task | POST .../promote-to-task (+ SPA second hop) | blueprint_promote_node_to_task |
| Promote whole graph to tasks | Promote to Bam | POST /promote-to-tasks (+ SPA executes plan) | blueprint_promote_graph_to_tasks |
| Generate from Bam | From Bam project tasks... | POST /diagrams/from-bam | blueprint_generate_from_bam |
| Two-way node-task sync | automatic | internal sync routes | (implicit via update_node) |
| Live collaboration refresh | automatic | WS /blueprint/ws | (none) |

---

## 6. Candidate user stories

1. Sketch a flowchart from scratch. New diagram (type Flowchart) -> add nodes (N / palette) -> drag handles to connect -> label nodes/edges in the inspector -> Apply layout -> Save snapshot -> Export Mermaid.
2. Mind-map then turn it into a project plan. Create a Mind map -> build the node tree -> Promote to Bam with edge direction source-parent -> progress overlay creates one task per node + parent links -> nodes get linked back to their tasks.
3. Visualize an existing project. From the list, From Bam project tasks... -> pick a project, choose include-completed + auto-layout -> Generate -> a laid-out org-chart-style diagram opens, each node linked to its task and live-synced.
4. Keep a diagram and its tasks in sync. Open a generated diagram, rename a node -> the linked Bam task title updates; rename the task in Bam -> the node updates (two-way sync via internal routes).
5. Reorganize a messy graph. Pin the nodes you want fixed -> choose an algorithm + direction -> Apply layout -> optionally Snap nodes to grid now.
6. Version and roll back. Save a snapshot before a big edit; later restore a version (API/MCP today; restore UI pending).
7. Agent builds a diagram from a doc. An agent calls blueprint_create then blueprint_generate with a node/edge spec extracted from a process description; the server materializes uuids, wires parents, and auto-layouts.
8. Cross-product map. Link nodes to Beacon entries / Bond deals / Bearing goals via Link to entity... so one diagram references entities across the suite.
9. Curate the library. Star important diagrams, archive stale ones, filter by type or starred from the sidebar.

---

## 7. Agent flows

Blueprint is designed as a first-class agent surface; every structural mutation is a tool (apps/mcp-server/src/tools/blueprint-tools.ts, ~20 tools).

- Whole-diagram authoring: blueprint_create + blueprint_generate (headline tool: 1-500 node specs + up to 2000 edge specs with local ref handles, parent_ref containers, cross-product refs; auto-layout; replace to overwrite). The read-a-doc-then-emit-a-diagram-in-one-call path.
- Incremental editing: blueprint_add_node/update_node/move_node/duplicate_node/delete_node, blueprint_add_edge/update_edge/delete_edge, blueprint_apply_layout.
- Reading: blueprint_list, blueprint_get, blueprint_read_nodes, blueprint_read_edges, blueprint_search (client-side substring; MVP), blueprint_export.
- Cross-product round trip: blueprint_generate_from_bam (tasks to graph) and blueprint_promote_graph_to_tasks / blueprint_promote_node_to_task (graph to tasks plans the agent then executes via Bam tools), plus blueprint_link_entity.
- Destructive guardrails: blueprint_archive, blueprint_delete_node, blueprint_delete_edge use the per-tool boolean confirm_action preview-then-commit pattern. blueprint_archive also needs admin scope.
- Audit/policy: the shared registerTool wrapper enforces section-15 agent_policies (kill switch + blueprint.* allowlist) on service-account calls; mutations emit Bolt events on source blueprint and broadcast to live editors.

Bolt events emitted (source blueprint): diagram.created, diagram.updated, diagram.archived, diagram.generated, diagram.imported, diagram.promoted_to_tasks, node.created, edge.created, layout.applied.

---

## 8. Screenshots available

None. There is no docs/apps/blueprint/ directory and no screenshot assets for this app (confirmed: ls docs/apps/blueprint -> No such file or directory). This app must be documented from code descriptions only.

---

## 9. Discrepancies (docs/plan/tool text vs code)

1. Templates are inert. template_id is accepted by POST /diagrams and the create dialog offers a Template select, but createDiagram (diagram.service.ts) never reads template_id - a chosen template does not seed nodes/edges. The blueprint_create tool doc claims it initializes the diagram from an existing template. There is no template create/update/delete endpoint, so /templates is empty unless rows are seeded directly.
2. Hocuspocus / Yjs multiplayer is not implemented. CLAUDE.md and docs/plans/blueprint-development-plan.md describe a Yjs/Hocuspocus live-multiplayer layer and a yjs_state column. The column exists and is documented as reserved/unused; actual realtime is invalidate-and-refetch over a plain WS hub (ws.routes.ts, use-diagram-sync.ts). No CRDT, and no per-diagram LiveKit audio (the plan mentions audio; the code has none).
3. SVG/PNG export not available in-process. blueprint_export advertises svg/png; the in-process export service throws a validation error for those formats (deferred to a worker that is not wired here). Only json and mermaid work today.
4. blueprint_promote_node_to_task does not create the task. The tool/route only returns a payload; the SPA performs the actual Bam POST. The route comment and tool doc both note the server-side second hop is on the roadmap. Same caveat for promote-to-tasks (returns a plan only).
5. blueprint_search is client-side only - it fetches the visible list and substring-filters; no server-side search filter or node-label search exists yet (the tool itself documents this).
6. Layout algorithm vocabulary mismatch. The editor dropdown labels Layered/Force-directed/Tree/Grid send values layered/force/tree/grid. The backend ELK map only knows layered, mrtree, force, radial, rectpacking (+ manual). Selecting Tree (tree) or Grid (grid) sends an algorithm the server rejects as Unknown algorithm - two of the four UI options do not map to valid ELK names. mrtree/radial/rectpacking are reachable only via API/MCP.
7. Versions, comments, collaborators, and Mermaid import lack UI. Endpoints (and for some, TanStack hooks) exist, but there is no rendered surface to restore a version, view/post comments, manage collaborators, or paste Mermaid to import. Do not promise these as user-clickable features yet.
8. Edit-permission gating is shallow. assertCanEdit only blocks viewer/commenter on private diagrams; for project/organization diagrams any org member with read_write scope can edit regardless of collaborator role (the code comments flag this as future work).

---

## 10. Open questions

1. How are blueprint_templates rows ever created? No endpoint, no tool, and no seeder found under scripts/ (grep for blueprint in scripts hit only deploy service lists). Are system templates expected to ship via migration/seed, or is the feature dormant?
2. Is the tree/grid editor layout mismatch (Discrepancy 6) a known bug? It would surface as a silent Apply layout failure for two of the four UI options.
3. The orchestrator notes anchored comments and collaborators as shipped features - confirm whether to document them at all given there is no UI, or to mark them API/agent-only.
4. diagram_type is free-form but values (org_chart, decision_tree, mindmap vs UI mindmap/class/sequence) are referenced inconsistently across export logic, the create dialog, and generate-from-Bam. Which set is canonical for help docs?
5. Does the worker actually process queued large-graph layouts / SVG-PNG exports, or do those 202/deferred paths currently dead-end? No blueprint-layout / blueprint-export worker handler appears in the worker handler list (CLAUDE.md lists 16 handlers, none Blueprint).
