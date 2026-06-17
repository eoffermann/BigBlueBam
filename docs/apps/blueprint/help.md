# Blueprint - Structured diagrams backed by a typed graph

> Blueprint is a diagram editor whose diagrams are a typed relational graph of nodes and edges, not an opaque drawing. Reach for it when you want a flowchart, graph, org chart, mind map, or system map that every teammate, and every AI agent, can read, edit, version, and turn into Bam tasks with a full audit trail.

## Overview

Blueprint stores every diagram as a set of database rows: a diagram record, one row per node, and one row per edge. Because the graph is structured rather than a flat image, every change you make is an ordinary, auditable action, and the same actions are exposed to AI agents as MCP tools. That is the core idea: a node is a first-class object that can be styled, nested, linked to a task in Bam, promoted into a new task, or generated from an existing one.

You work with three kinds of object. A **diagram** is the top-level artifact (a flowchart, a graph, an org chart). A **node** is a box on the canvas with a shape, label, description, size, and position. An **edge** is a connection between two nodes with a direction, a kind, and arrow markers. Diagrams live in your organization and can optionally belong to a project, which controls who can see them.

Blueprint is wired into Bam, the Kanban and sprint tool. You can generate a diagram from an existing Bam project (one node per task, edges drawn from parent/child links), and you can promote a diagram into Bam (one task per node, parent links from the edges). A node linked to a Bam task stays in two-way sync: rename the node and the task title updates, rename the task and the node updates.

Several capabilities in Blueprint are agent-driven or API-driven rather than point-and-click. Anything an agent can do to a diagram, it does through a named tool, so an agent can read a process description and emit a fully wired diagram in a single call, with the same permissions and the same audit trail as a person. Where a backend capability has no rendered screen yet, this document says so plainly rather than promising a button that does not exist.

### Key concepts

- **Diagram** - the top-level artifact. Has a name, a type, a layout algorithm, a visibility level, an optional project, and an archived flag.
- **Diagram type** - a tag that picks the type icon and the sidebar grouping. The New diagram dialog offers Flowchart, Graph, Sequence, Class, and Mind map. Generate from Bam writes the type org_chart.
- **Node** - a vertex on the canvas. Carries a shape, label, markdown description, position, width and height, a pinned flag, fill color, an optional parent (for nesting), and an optional cross-product link.
- **Shape** - the visual form of a node. The palette offers Rounded, Rectangle, Diamond, Ellipse, and Hexagon.
- **Edge** - a connection between two nodes. Carries a kind (Default, Dependency, Flow, Reference, Inherits) and an end marker (Filled arrow, Open arrow, No arrow / None).
- **Pinned** - a node excluded from auto-layout. A pinned node keeps the position you set by hand when you run a layout pass.
- **Layout algorithm** - the auto-arrange engine, run server-side by ELK. The working algorithms are Layered, Force-directed, and (through the API or an agent) mrtree, radial, and rectpacking. See the note under Auto-layout about the Tree and Grid menu entries.
- **Linked entity** - a cross-product reference from a node to an object in another app, such as a Bam task, a Beacon entry, a Bond deal, or a Bearing goal. Only Bam tasks have live two-way sync.
- **Visibility** - who can see the diagram. Private (you, plus collaborators), Project (project members, or the org if there is no project), or Organization (everyone in your org).
- **Collaborator** - a user granted explicit access to one diagram at a role of owner, editor, commenter, or viewer, on top of any project- or org-level visibility. Managed today through the API or an agent.
- **Snapshot (version)** - a saved, immutable copy of the whole graph that you can restore later.
- **Comment** - a note attached to the whole diagram or anchored to a single node, with a resolved flag for review threads. Managed today through the API or an agent.
- **Star** - your personal favorite flag on a diagram, used to filter the list.

### Where to find it

Blueprint is served at `/blueprint/`. Reach it from the platform Launchpad in the top header of any BigBlueBam app.

You need a signed-in BigBlueBam account; the app refuses to load when you are not authenticated and links you to `/b3/` to log in with the message "Please log in to BigBlueBam first to access Blueprint." To use the Bam-integration features (generate from Bam, promote to tasks, two-way sync), you also need a Bam project with tasks, because those flows talk to Bam directly using your shared session.

Press the `?` key from the diagram list or the editor (when no field is focused) to open the in-app help viewer at `/blueprint/help`.

## Feature reference

### Browse and filter diagrams

![Diagram list](screenshots/light/01-diagram-list.png)

The diagram list at `/blueprint/` shows every diagram you can see, as a grid of cards. Each card shows the type icon, the diagram name, the lowercase type label, a Star toggle, and a More menu. The card footer shows the visibility (Private, Project, or Organization, each with its own icon) and the relative time the diagram was last updated.

To find a diagram:

1. Use the left sidebar to filter. Under **Library**, click **All diagrams**, **Starred**, or **Archived**. Under **By type**, click **Flowcharts**, **Graphs**, **Sequence**, **Class**, or **Mind maps**. Each pill shows a count.
2. Type in the **Search diagrams...** box to filter the visible cards by name or description.
3. Click a card to open it in the editor, or open the card's More menu and choose **Open editor**.

The page heading reflects the active filter (for example All diagrams, Starred diagrams, or Flowchart diagrams). When nothing matches, an empty state appears with a New diagram button.

### Create a diagram

![New diagram dialog](screenshots/light/03-new-diagram-dialog.png)

To create a blank diagram:

1. Click **New diagram** at the top right of the list, or **New diagram** in the sidebar.
2. In the **New diagram** dialog, enter a **Name** (required, up to 200 characters). The placeholder suggests "System architecture, user flow...".
3. Choose a **Type**: Flowchart, Graph, Sequence, Class, or Mind map.
4. Optionally choose a **Project (optional)**. Leave it on **None - org-wide** for a diagram that is not tied to a project.
5. Pick a **Visibility**: **Private** (Only you), **Project** (Project members, or Org if no project), or **Organization** (Everyone in org). The dialog defaults to **Project**; if you choose Project without a project, the diagram is created Private.
6. Optionally pick a **Template (optional)**. The empty option is labeled **Blank canvas**, and system templates show a "system" suffix. See the note below before relying on this.
7. Click **Create diagram**. The new diagram opens in the editor.

The split button next to New diagram has a chevron menu with two entries: **Blank diagram or template** (opens the same dialog) and **From Bam project tasks...** (opens the Generate from Bam dialog, described later).

Note on templates: the Template select is present, but a chosen template does not seed any nodes or edges into the new diagram. The backend accepts a template id and ignores its content, and there is no UI to create templates today, so the list is effectively empty unless rows were inserted directly into the database. Treat every new diagram as a blank canvas regardless of the template you pick.

### The editor canvas

![Diagram editor](screenshots/light/02-diagram-editor.png)

Opening a diagram shows the editor at `/blueprint/d/<id>`. The canvas is an infinite, pannable React Flow surface with a dotted background, zoom and fit controls at the bottom left, and a minimap at the bottom right. The top bar shows a Back arrow (titled **Back to diagrams**), the diagram name, an uppercase type chip, and a count line reading `N nodes · M edges`.

The right side of the screen is the **Inspector**, which shows the properties of whatever node or edge you have selected. When nothing is selected it reads **Nothing selected** with the hint "Click a node or edge to edit it. Press **N** to add a new node."

### Add nodes

You can add a node four ways:

- Click the **Add <shape>** split button in the top bar. The body adds the last shape you used; the chevron opens a menu listing **Rounded**, **Rectangle**, **Diamond**, **Ellipse**, and **Hexagon**, with a **Last** badge on the most recent.
- Press the **N** key to add a node with the last-used shape.
- Right-click empty canvas and pick a shape under **Add node** in the pane menu.
- Drag a connection out of a node handle and release it on empty canvas. An **Add connected node** palette opens at the drop point; pick a shape and the new node is created already wired to the origin node, with the arrow following the direction you dragged.

Every new node starts with the label **New node** and is selected immediately so the Inspector is open and ready for you to type. The last-used shape is remembered per browser.

### Edit a node

Select a node to edit it in the Inspector on the right. The node panel header shows **Node** and a short id, a Pin toggle, and a Delete button.

To edit a node:

1. Select the node on the canvas.
2. Edit the **Label** field; the change saves when you leave the field or press Enter.
3. Edit the **Description** using the rich-text editor (it supports bold, italic, code, and links). The placeholder reads "Describe this node... **bold**, *italic*, `code`, [links](url) all work."
4. Change the **Shape** with the dropdown.
5. Set **Width** (40 to 2000) and **Height** (30 to 2000).
6. Pick a **Fill color** swatch, or click **Clear** to remove the fill.

You can also resize a node directly on the canvas: select it and drag the resize handles that appear around it. The new size is saved when you finish dragging.

The node right-click menu offers the same actions plus a few extras: **Duplicate** (with the keyboard hint), **Pin position** or **Unpin (allow auto-layout)**, a **Change shape** list, the **Fill color** swatches (White, Red, Amber, Green, Blue, Violet, Pink, Zinc, and Clear), **Link to entity...**, **Promote to Bam task**, and **Delete node**.

### Move and pin nodes

Drag a node to reposition it. The new position is saved when you release the drag.

To keep a node where you put it during an auto-layout pass, **pin** it: select the node and click the Pin toggle in the Inspector, or right-click the node and choose **Pin position**. A pinned node is excluded from layout and cannot be dragged until you unpin it. To release it, click the Pin toggle again or choose **Unpin (allow auto-layout)**.

### Duplicate a node

To copy a node, select it and press **Cmd/Ctrl+D**, or right-click it and choose **Duplicate**. The clone appears offset down and to the right and copies the label, shape, size, style, and any linked entity. Edges connected to the original are not copied; wire the clone in yourself if you need it connected.

### Delete a node

To delete a node, select it and press **Delete**, or right-click it and choose **Delete node**, or click the trash button in the Inspector. A confirmation appears asking "Delete this node and its connected edges?"; deleting a node removes every edge attached to it.

If the node is linked to a Bam task, a richer dialog appears titled **Delete "<label>"?**. It explains that the node is linked to a Bam task and offers three buttons: **Cancel**, **Delete node only**, and **Delete node + task**. The last option also deletes the linked Bam task, including its subtasks, comments, time entries, and activity.

### Connect nodes with edges

To draw an edge, hover a node to reveal its connection handles (top, left, right, bottom), then drag from a handle to a handle on another node. Releasing on a valid handle creates the edge. Releasing on empty canvas opens the **Add connected node** palette so you can create the target node and the edge in one gesture.

New edges use a smooth line with a closed (filled) arrowhead by default.

### Edit an edge

Select an edge to edit it in the Inspector. The edge panel header shows **Edge** and a short id and a Delete button.

To edit an edge:

1. Select the edge.
2. Edit the **Label** field.
3. Choose a **Kind**: Default, Dependency, Flow, Reference, or Inherits.
4. Choose an **End marker**: Filled arrow, Open arrow, or None.

The edge right-click menu offers the same **Edge kind** and **End marker** choices, plus **Delete edge**.

### Delete an edge

To delete an edge, select it and press **Delete**, right-click it and choose **Delete edge**, or click the trash button in the Inspector.

### Snap to grid

To line nodes up on a grid, right-click empty canvas and choose **Snap to grid** under **Align**; a checkmark shows it is on. While it is on, dragging a node quantizes its position to the grid. To clean up an existing diagram in one pass, choose **Snap nodes to grid now**, which rounds every node onto the grid and saves the moves. The snap-on setting is remembered per browser.

### Auto-layout

Auto-layout arranges the graph automatically using the ELK engine, server-side. Pinned nodes keep their hand-set positions.

To run a layout:

1. In the top bar, choose an algorithm from the layout dropdown: **Layered**, **Force-directed**, **Tree**, or **Grid**.
2. Choose a direction: **Top to bottom**, **Left to right**, **Bottom to top**, or **Right to left**. Direction applies to layered layouts.
3. Click **Apply layout**.

You can also right-click empty canvas and pick an algorithm under **Reorganize**, where the current algorithm carries a **Current** badge.

Important caveat about the algorithm choices: only **Layered** and **Force-directed** actually run. The backend accepts the algorithm names layered, mrtree, force, radial, rectpacking, and manual. The dropdown's **Tree** and **Grid** entries send names the backend does not recognize, so choosing either one returns "Unknown algorithm" and does not rearrange the diagram. Use **Layered** or **Force-directed** in the UI. The additional algorithms mrtree, radial, and rectpacking are reachable only through the API or an agent using `blueprint_apply_layout`.

### Export a diagram

To export, click the **Export** dropdown in the top bar. It offers **Mermaid (.mmd)** and **JSON**, a separator, and **Reload from server**. Pick a format and the file downloads, named after the diagram.

You can also export from the pane right-click menu via **Export as Mermaid** and **Export as JSON**.

Only Mermaid and JSON export work today. The underlying tool advertises SVG and PNG (those are deferred to a worker render job), but the in-process export service rejects those formats with "Format ... is not supported in-process", so do not rely on image export from the editor.

### Mermaid import

The backend can import a Mermaid source string and turn it into a Blueprint graph, materializing its nodes and edges into the typed tables. There is no rendered screen for pasting Mermaid into the editor yet, so this is currently an API or agent capability rather than a button. Import can replace the existing graph or append to it, and you can run a layout pass afterward to position the new nodes.

### Snapshots (versions)

A snapshot saves the entire graph so you can return to it later.

To save a snapshot, click **Save snapshot** (the camera button) in the top bar, or choose **Save snapshot** from the pane right-click menu. You can enter an optional label when prompted ("Snapshot label (optional)"). Each snapshot is numbered automatically, one higher than the latest.

Listing the saved versions and restoring an earlier one are supported by the backend but have no rendered screen yet. Browsing versions and rolling back are available only through the API or an agent today (`blueprint_list_versions`, `blueprint_restore_version`).

### Star and archive

To star a diagram, click the **Star** toggle on its card in the list (the title reads Star or Unstar). Starred diagrams show under the **Starred** sidebar filter.

To archive a diagram, use the card's More menu and choose **Archive**, or in the editor click **Archive** in the top bar, or choose **Archive diagram** from the pane right-click menu. Archiving is a soft delete: the diagram is hidden from the default list but its nodes, edges, comments, and snapshots are preserved. You confirm before it archives ("Archive this diagram? It will be hidden from the default list."). Archived diagrams show under the **Archived** sidebar filter. Archiving requires admin scope on your API key when done by an agent.

![Starred diagrams](screenshots/light/04-starred-filter.png)

![Archived diagrams](screenshots/light/05-archived-filter.png)

### Link a node to another app's entity

A node can carry a cross-product link to an object in another app, so the diagram references entities across the suite. The canonical link types are bam.task, beacon.entry, bearing.goal, bond.deal, bond.contact, and helpdesk.ticket. Only bam.task links stay in live two-way sync.

To link a node:

1. Select the node.
2. In the Inspector, under **Linked entity**, type the link type into the **type** field (for example bam.task) and the entity id (a UUID) into the **entity id (uuid)** field.
3. Click **Link**.

Alternatively, right-click the node, choose **Link to entity...**, and enter the reference type and UUID when prompted. A linked node shows a small badge on the canvas.

### Promote a single node to a Bam task

To turn one node into a Bam task:

1. Select the node.
2. Click **Promote to task** in the Inspector, or right-click the node and choose **Promote to Bam task**.
3. If the diagram is not tied to a project, enter the Bam project id (a UUID) when prompted.
4. The app creates the task in Bam, then links the node back to it so future title and description edits sync both ways.

Under the hood the Blueprint backend returns a task payload; the app posts that payload to Bam itself using your session, then links the node to the new task. The backend does not create the task on its own.

### Promote a whole graph to Bam tasks

To turn an entire diagram into a Bam project plan:

1. Click **Promote to Bam** (the sky-blue button) in the top bar.
2. If the diagram has no project, enter a Bam project id (a UUID) when prompted.
3. Choose an edge direction when prompted: `source-parent` (default; an edge A to B means A is the parent of B), `target-parent` (A to B means B is the parent of A), or `none` (skip parent links).
4. Watch the progress overlay. It creates one task per node, reuses any task a node is already linked to, then wires parent and child links from the edges.
5. When it finishes, the summary reads "Created N task(s)", plus "reused M existing" and "wired K parent link(s)" where applicable. Any failures are listed.

As with single-node promotion, the backend returns a plan and the app executes it against Bam; the diagram itself does not create tasks server-side. After promotion, each node is linked to its new task, so the badges appear and two-way sync is active.

### Generate a diagram from a Bam project

To build a diagram automatically from an existing project:

1. In the list, click the chevron next to **New diagram** and choose **From Bam project tasks...**.
2. In the **Generate from Bam project** dialog, choose a **Project**.
3. Optionally check **Include completed tasks**.
4. Optionally check **Run auto-layout (layered, top-to-bottom)** (on by default).
5. Click **Generate**.

The result is a new diagram with one node per task and edges drawn from existing parent/child links, opened already laid out. Each node is linked to its task, so renaming a node updates the task and renaming the task updates the node. Generated diagrams are written with the type org_chart.

### Two-way sync with Bam

Once a node is linked to a Bam task (through generation, promotion, or a manual link), the two stay in sync. Editing the node's label or description in Blueprint updates the linked task in Bam. Changing the task's title or description in Bam updates every node linked to it. This happens automatically; there is nothing to configure.

### Live collaboration refresh

When more than one person has a diagram open, Blueprint keeps everyone's canvas current. When anyone adds, moves, edits, or deletes a node or edge, every other open editor refetches the graph and updates. Your own zoom and pan position are not affected by other people's edits. The presence strip in the top bar shows who else is on the diagram, and the selected node is URL-addressable (`?node=<id>`) so a follower can be brought to the same node.

### Comments and collaborators

A diagram can carry comments, either anchored to a specific node or attached to the diagram as a whole, with a resolved flag for review threads. A diagram can also have explicit collaborators at the roles owner, editor, commenter, and viewer, granted on top of project- or org-level visibility. Both features are backed by the API and exposed as MCP tools today; there is no dedicated comments or collaborators panel rendered in the editor yet, so an agent or an API client manages them. Comments and collaborators are preserved when a diagram is archived.

### Working with AI agents

Blueprint is built to be driven by AI agents. Every structural change is exposed as an MCP tool, so an agent acts on a diagram with the same permissions and the same audit trail as a person. There are 36 Blueprint MCP tools, covering the full surface: diagram read and write, nodes, edges, layout and generation, the Bam round-trip, versions, comments, collaborators, stars, Mermaid import, and templates.

Common agent flows:

- **Author a whole diagram in one call.** An agent reads a process description, org roster, or task list and calls `blueprint_create` to make the diagram, then `blueprint_generate` with a list of node specs and edge specs. The server materializes the ids, wires up parent containers, and runs auto-layout. This is the headline path; `blueprint_generate` accepts 1 to 500 node specs and up to 2000 edge specs, with `replace: true` to wipe the existing graph first or `auto_layout: false` to skip the post-generate pass.
- **Turn a Mermaid block into an editable graph.** `blueprint_import_mermaid` parses a Mermaid source string (for example from a Brief, a Beacon entry, or an LLM draft) into the typed node/edge graph, then `blueprint_apply_layout` positions it.
- **Edit incrementally.** `blueprint_add_node`, `blueprint_update_node`, `blueprint_move_node`, `blueprint_duplicate_node`, and `blueprint_delete_node` cover nodes; `blueprint_add_edge`, `blueprint_update_edge`, and `blueprint_delete_edge` cover edges; `blueprint_apply_layout` re-arranges. Through `blueprint_apply_layout` an agent can use the mrtree, radial, and rectpacking algorithms that the UI dropdown does not reach.
- **Read the graph.** `blueprint_list`, `blueprint_get`, `blueprint_read_nodes`, `blueprint_read_edges`, `blueprint_search`, and `blueprint_export`. Note `blueprint_search` matches only on name and description and filters the visible list client-side; it does not search node labels yet.
- **Round-trip with Bam.** `blueprint_generate_from_bam` turns a project's tasks into a diagram; `blueprint_promote_graph_to_tasks` and `blueprint_promote_node_to_task` return a plan the caller executes against Bam; `blueprint_link_entity` attaches a cross-product reference so the two-way sync hook fires.
- **Version, review, and share.** `blueprint_snapshot_version` / `blueprint_list_versions` / `blueprint_restore_version` manage restore points; `blueprint_list_comments` / `blueprint_add_comment` / `blueprint_update_comment` (set `resolved: true` to resolve a thread) drive review; `blueprint_list_collaborators` / `blueprint_add_collaborator` / `blueprint_remove_collaborator` manage explicit access; `blueprint_star` / `blueprint_unstar` set the caller's personal favorite; `blueprint_list_templates` lists templates.

Destructive tools follow a preview-then-commit pattern: `blueprint_archive`, `blueprint_delete_node`, `blueprint_delete_edge`, `blueprint_restore_version`, and `blueprint_remove_collaborator` first return a confirmation prompt and act only when called again with `confirm_action: true`. `blueprint_archive` also requires admin scope. Service-account calls are checked against the platform agent policy kill switch and the `blueprint.*` allowlist before they run, and an agent posting cited entities into shared surfaces should call the platform `can_access` tool first. Agent runs are recorded in the unified activity feed under the agent identity, surface a heartbeat, and can route work through the platform proposal queue for human approval.

A few tool descriptions describe roadmap behavior that the running app does not yet deliver. `blueprint_create` claims a template seeds the diagram, but template content is never applied. `blueprint_export` advertises svg and png, which the in-process export service rejects. `blueprint_promote_node_to_task` and `blueprint_promote_graph_to_tasks` return a payload or plan only; the caller performs the actual task creation in Bam and then back-links the node with `blueprint_link_entity`. Plan for these gaps when reviewing agent work.

For the full tool catalog and schemas, see the Blueprint MCP-tools reference in `docs/apps/blueprint/`.

## User Stories

### Story: Create your first flowchart

**Who:** Anyone with a BigBlueBam account who wants to sketch a process.
**Goal:** Build a small flowchart, connect and label the steps, tidy the layout, and save a copy.
**Before you start:** Be signed in. No project is required.

**Steps**

1. Go to `/blueprint/` from the Launchpad.
2. Click **New diagram**. Enter a **Name**, leave **Type** on **Flowchart**, choose a **Visibility**, and click **Create diagram**.
3. In the editor, press **N** (or click **Add <shape>**) to add a node. With the node selected, type a **Label** in the Inspector.
4. Add two or three more nodes the same way.
5. Drag from one node's handle to another node's handle to connect them. Repeat until the steps are linked.
6. Select an edge and set its **Label** and **Kind** in the Inspector if you want to annotate the flow.
7. Set the layout dropdown to **Layered**, pick a direction such as **Top to bottom**, and click **Apply layout**.
8. Click **Save snapshot** and enter an optional label.

**Result:** A laid-out flowchart with labeled steps and a saved snapshot you can return to.

**Related:** Export the diagram as Mermaid or JSON from the **Export** menu. An agent would build the same diagram with `blueprint_create` plus `blueprint_generate`.

### Story: Visualize an existing Bam project

**Who:** A project lead who wants a picture of a project's task structure.
**Goal:** Generate a diagram from a Bam project, with each node tied to its task.
**Before you start:** Have a Bam project that contains tasks, in the same org and session.

**Steps**

1. Go to `/blueprint/`.
2. Click the chevron next to **New diagram** and choose **From Bam project tasks...**.
3. In the **Generate from Bam project** dialog, choose your **Project**.
4. Check **Include completed tasks** if you want finished work in the diagram.
5. Leave **Run auto-layout (layered, top-to-bottom)** checked.
6. Click **Generate**.

**Result:** A new diagram opens, laid out, with one node per task and edges drawn from the project's parent/child links. Each node is linked to its task, so the two stay in sync.

**Related:** This is the reverse of promoting a graph to tasks. An agent uses `blueprint_generate_from_bam`.

### Story: Turn a mind map into a project plan

**Who:** A planner who brainstormed work as a mind map and now wants real tasks.
**Goal:** Promote the diagram into a Bam project, one task per node, with parent links from the edges.
**Before you start:** Have a diagram of the work and a target Bam project id.

**Steps**

1. Open the diagram in the editor.
2. Make sure the structure reads parent-to-child along the edges (an edge from the parent idea to the child idea).
3. Click **Promote to Bam** in the top bar.
4. If prompted, enter the Bam project id (a UUID).
5. When prompted for edge direction, choose `source-parent` so each edge makes the source node the parent.
6. Watch the progress overlay until it reports the created tasks and wired parent links.

**Result:** One Bam task per node, with parent and child relationships matching the edges. Each node is now linked to its task, and the badges appear on the canvas.

**Related:** Promote a single node instead with **Promote to task** in the Inspector. An agent uses `blueprint_promote_graph_to_tasks` and then creates the tasks with Bam tools.

### Story: Keep a diagram and its tasks in sync

**Who:** Anyone maintaining a diagram that mirrors live work in Bam.
**Goal:** Confirm that edits flow both directions between a node and its linked task.
**Before you start:** Have a diagram whose nodes are linked to Bam tasks (from generation or promotion).

**Steps**

1. Open the diagram in the editor.
2. Select a linked node (it shows a link badge) and change its **Label** in the Inspector.
3. Open the linked task in Bam and confirm its title now matches.
4. In Bam, rename the task.
5. Back in Blueprint, reload the diagram (or wait for the live refresh) and confirm the node label updated.

**Result:** The node and the task hold the same title and description, kept in sync automatically.

**Related:** Link more nodes with the Inspector **Link** button or the node menu's **Link to entity...**. An agent uses `blueprint_link_entity` and `blueprint_update_node`.

### Story: Reorganize a messy graph

**Who:** Anyone whose diagram has drifted into a tangle.
**Goal:** Auto-arrange the graph while keeping a few key nodes fixed.
**Before you start:** Have a diagram open in the editor.

**Steps**

1. Pin the nodes you want to keep in place: select each one and click the Pin toggle in the Inspector, or right-click and choose **Pin position**.
2. In the layout dropdown, choose **Layered** or **Force-directed**. Do not choose Tree or Grid; those do not apply.
3. Pick a direction and click **Apply layout**.
4. If you want everything aligned to a grid afterward, right-click empty canvas and choose **Snap nodes to grid now**.

**Result:** The unpinned nodes are arranged by the chosen algorithm; the pinned nodes stay where you put them.

**Related:** For mrtree, radial, or rectpacking layouts, use an agent with `blueprint_apply_layout`, since the UI dropdown does not offer them.

### Story: Have an agent draft a diagram from a document

**Who:** A user working with an AI agent that has MCP access.
**Goal:** Produce a complete, laid-out diagram from a written process description without drawing it by hand.
**Before you start:** Have an agent connected to the MCP server with a key allowed to use `blueprint.*` tools.

**Steps**

1. Give the agent the source text (a process description, a roster, or a task list) and ask it to build a Blueprint diagram.
2. The agent calls `blueprint_create` to make the diagram.
3. The agent calls `blueprint_generate` with node specs and edge specs extracted from your text. The server creates the nodes, wires the edges and any parent containers, and runs auto-layout. (If the source is already a Mermaid block, the agent can use `blueprint_import_mermaid` instead, then `blueprint_apply_layout`.)
4. Open the diagram from `/blueprint/` to review it.
5. Adjust labels, shapes, and layout in the editor as needed.

**Result:** A fully wired, laid-out diagram you can refine by hand, created in a single agent call.

**Related:** The agent can then call `blueprint_promote_graph_to_tasks` to turn the diagram into a Bam plan. Every agent mutation is audited like a human edit.

### Story: Review and snapshot before an agent rewrite

**Who:** A diagram owner who wants a safe restore point before an agent reworks the graph.
**Goal:** Capture the current graph, let the agent rewrite it, and roll back if needed.
**Before you start:** Have a diagram open, and an agent with `blueprint.*` access.

**Steps**

1. In the editor, click **Save snapshot** and label it (for example "before agent rewrite").
2. Ask the agent to make its changes. It can read the graph with `blueprint_read_nodes` and `blueprint_read_edges`, and rewrite with `blueprint_generate` (`replace: true`) or incremental node/edge tools.
3. Have the agent add a comment summarizing what it changed with `blueprint_add_comment`, and read review feedback with `blueprint_list_comments`.
4. If the result is wrong, ask the agent to restore the labeled snapshot with `blueprint_restore_version` (it lists versions with `blueprint_list_versions` first).

**Result:** The diagram is either the agent's improved version or rolled back to your snapshot, with the review thread recorded.

**Related:** Listing and restoring versions, and reading comments, have no editor screen yet; both are agent/API capabilities today.

### Story: Curate your diagram library

**Who:** Anyone keeping a tidy set of diagrams.
**Goal:** Star the diagrams you use most and archive the ones you no longer need.
**Before you start:** Have several diagrams in your org.

**Steps**

1. Go to `/blueprint/`.
2. Click the **Star** toggle on the cards you want to keep handy.
3. Click **Starred** in the sidebar to see only those.
4. For a stale diagram, open its More menu and choose **Archive**, then confirm.
5. Click **Archived** in the sidebar to review or find archived diagrams later.

**Result:** Your most-used diagrams are one filter click away, and stale ones are hidden from the default list without being destroyed.

**Related:** Archiving is reversible at the data level since nodes, edges, comments, and snapshots are preserved. An agent archives with `blueprint_archive` (which requires admin scope and a confirmation step).

## Related

- **Bam** (`/b3/`) - the Kanban and sprint tool Blueprint exchanges work with. Generate a diagram from a Bam project, promote a diagram or node into Bam tasks, and rely on two-way sync between a node and its linked task.
- **Beacon, Bearing, Bond, Helpdesk** - nodes can carry cross-product links to a Beacon entry, a Bearing goal, a Bond deal or contact, or a Helpdesk ticket via the Inspector's **Linked entity** section or the node menu's **Link to entity...**.
- **Brief** - Mermaid export from Blueprint produces a source string you can embed elsewhere, and `blueprint_import_mermaid` turns a Mermaid block back into an editable graph.
- Blueprint MCP-tools reference and guide in `docs/apps/blueprint/` for the full catalog of the 36 agent tools.
