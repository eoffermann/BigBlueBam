# Blueprint - Structured Diagrams

Blueprint is the BigBlueBam suite's diagramming tool, and it is built differently from a freeform whiteboard. Every diagram is a typed relational graph: a diagram record, one row per node, and one row per edge, stored in real tables rather than as an opaque drawing blob. Because the graph is structured, every change is an ordinary, auditable action, and the same actions are exposed to AI agents as named tools. A node is a first-class object you can style, nest, link to a task in Bam, promote into a new task, or generate from an existing one.

You draw on an infinite React Flow canvas with a shape palette, a property inspector, and a top toolbar. Diagrams come in five types: Flowchart, Graph, Sequence, Class, and Mind map. Nodes carry a shape, a markdown description, a size, a fill color, and an optional cross-product link; edges carry a kind and arrow markers. Server-side ELK auto-layout arranges the graph in one click, and snapshots let you save and roll back the whole graph.

The headline idea is that anything a person can do to a diagram, an agent can do too, with the same permissions and the same audit trail. An agent can read a process description and emit a fully wired, laid-out diagram in a single call.

## Key Features

- Typed node/edge graph stored in relational tables, so every structural mutation is an auditable API call and an MCP tool, not an edit to an opaque image.
- React Flow editor with a shape palette (Rounded, Rectangle, Diamond, Ellipse, Hexagon), a property inspector, drag-to-connect edges, an add-connected-node palette, snap-to-grid, and resize handles.
- Five diagram types: Flowchart, Graph, Sequence, Class, and Mind map.
- Server-side ELK auto-layout (Layered and Force-directed in the UI; mrtree, radial, and rectpacking through the API or an agent), with pinned nodes excluded.
- Versions: save immutable snapshots of the whole graph and restore an earlier one.
- Mermaid and JSON export, and Mermaid import that materializes a Mermaid block into the editable graph.
- Comments anchored to a node or the whole diagram, with a resolved flag, and explicit per-diagram collaborators at owner / editor / commenter / viewer roles.
- Star and archive for organizing the library; archive is a soft delete that preserves nodes, edges, comments, and snapshots.
- Visibility controls (Private, Project, Organization) and live multi-editor refresh with a presence strip.

## Integrations

- **Bam** - Generate a diagram from a Bam project (one node per task, edges from parent/child links), promote a node or a whole graph into Bam tasks, and keep a node and its linked task in two-way sync on title and description.
- **Beacon, Bearing, Bond, Helpdesk** - Nodes can carry cross-product links to a Beacon entry, a Bearing goal, a Bond deal or contact, or a Helpdesk ticket.
- **Brief** - Mermaid export produces an embeddable source string, and Mermaid import turns a Mermaid block from a Brief or an LLM draft back into an editable graph.
- **Agentic platform** - All 36 MCP tools run under the platform's agent identity, heartbeat, unified activity feed, proposal queue, and `agent_policies` kill switch plus `blueprint.*` allowlist; agents call `can_access` before citing entities, and destructive tools require a confirm step.

## Getting Started

Blueprint is served at `/blueprint/`, reachable from the Launchpad in any BigBlueBam app. You need a signed-in account; for the Bam-integration features you also need a Bam project with tasks.

1. Open `/blueprint/` and click **New diagram**.
2. Name it, pick a **Type** and a **Visibility**, and click **Create diagram**.
3. In the editor, press **N** to add a node, drag between handles to connect nodes, and edit properties in the Inspector.
4. Choose **Layered** in the layout dropdown and click **Apply layout** to tidy it up.
5. Click **Save snapshot** to capture a restore point, and use **Export** for Mermaid or JSON.

To start from existing work, use the chevron next to **New diagram** and choose **From Bam project tasks...**.
