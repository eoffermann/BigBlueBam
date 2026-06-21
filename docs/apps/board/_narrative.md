# Board - Visual Collaboration

Board is BigBlueBam's infinite canvas whiteboard for real-time visual collaboration, brainstorming, diagramming, and team workshops. Each board is one Excalidraw-powered canvas where you place sticky notes, text, shapes, connectors, freehand drawings, frames, and images, and everything auto-saves as you work. Board is in beta.

## Key Features

- **Infinite Canvas** with shapes, sticky notes, connectors, freehand drawing, text, and frames, all from Excalidraw's native toolbar
- **Real-Time Collaboration** with live cursors, presence indicators, reconnect replay, and WebSocket-powered scene sync
- **Templates** for common workshop formats like retrospectives, brainstorms, planning, and architecture diagrams, across General, Retro, Brainstorm, Planning, Architecture, and Strategy categories
- **Version History** with named snapshots you can save before a big change and restore later
- **Starred Boards, Archive, and Duplicate** for organizing and managing your library, with a project scope selector to filter by Bam project
- **Promote to Bam tasks** that turns brainstorm sticky notes into tracked Bam tasks in a named project and phase, linked back to the source stickies (an agent and API flow today)
- **Voice huddles on a board** provided by the platform-wide presence system the toolbar surfaces, so teammates can talk while they whiteboard

## Integrations

Board shares authentication with all BigBlueBam apps and reads your Bam session and permissions directly. Boards can be scoped to a Bam project, and brainstorm stickies promote into Bam tasks. Bolt automations can react to `board.created`, `board.updated`, `board.locked`, and `board.elements_promoted` events. AI agents work the canvas through 40 Board MCP tools: creating boards, dropping stickies and text, reading and summarizing elements, promoting stickies to tasks, and managing templates, versions, collaborators, and lifecycle. Agent actions run on the shared platform surface with identity tagging, approval queues, unified activity, visibility preflight, and per-agent policies.

## Getting Started

Open Board from the Launchpad at `/board/`. You land on All Boards. Click New Board to pick a template, or start a Blank board with a name and icon. Open a board to reach the full-screen canvas; use Excalidraw's toolbar to add shapes, connectors, sticky notes, and frames. The canvas supports zoom, pan, and multi-select and saves automatically. Press `?` for in-app help.

## Working together

The canvas is co-edited live with shared cursors and a presence bar, and the board carries audio conferencing so collaborators can talk while they draw.
