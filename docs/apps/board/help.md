# Board - Visual collaboration whiteboards

> Board gives your team an infinite canvas for sketching ideas, running retros, mapping architecture, and brainstorming together. Reach for it when a list or a document is not enough and you need to draw, group, and arrange thoughts in space.

## Overview

Board is BigBlueBam's whiteboarding app. Each board is one infinite canvas powered by Excalidraw, where you place sticky notes, text, shapes, arrows, freehand drawings, frames, and images. Boards auto-save as you work and sync in real time, so several people can edit the same canvas at once and see each other's cursors.

Board is in **beta**. The sidebar shows a yellow `beta` chip next to the Board logo.

Boards live inside your BigBlueBam organization and can optionally be scoped to a Bam project. Because projects, project members, phases, and tasks all live in Bam, Board can hand work back to Bam: sticky notes from a brainstorm can be promoted into Bam tasks in a named project and phase. You organize boards with stars, archive, templates, and named version snapshots.

Board does not have its own login. It reads your shared BigBlueBam session, and your permissions come from Bam. If you are not signed in, Board shows a "Please log in to BigBlueBam first" screen with a link to the main app.

![All boards](screenshots/light/01-all-boards.png)

### Key concepts

- **Board** - one infinite-canvas whiteboard. It has a name, a description, an emoji icon, a background pattern, a visibility setting, an optional project association, and a locked flag.
- **Element** - anything on the canvas: a sticky note, text, a shape, a connector (arrow or line), an image, or a frame. The canvas scene is stored whole, and a per-element copy is kept so the board can be searched, read, and promoted.
- **Sticky note** - a colored note. The default color is yellow. (Excalidraw has no native sticky; Board builds one from a rectangle with bound text.)
- **Shape** - a rectangle, diamond, ellipse, or freehand drawing from Excalidraw's toolbar.
- **Frame** - a labeled region on the canvas that groups the elements inside it. Frames are used when reading or summarizing a board by section.
- **Background** - the canvas backdrop pattern. One of `dots` (default), `grid`, `lines`, or `plain`.
- **Visibility** - who can see a board. `private` (creator plus explicitly added collaborators), `project` (project members plus collaborators plus creator), or `organization` (every member of your org). The default is `project`.
- **Collaborator** - a person granted access to a single board with either `view` or `edit` permission. There is no in-app screen to manage collaborators today; manage them through the visibility setting or have an agent or API client do it (see Feature reference).
- **Lock** - a board-level read-only switch. When a board is locked, only the board creator or an org admin or owner can edit it.
- **Star** - your personal favorite marker on a board.
- **Version** - a named snapshot of a board's canvas that you can restore later.
- **Template** - a reusable board blueprint you start new boards from. System templates ship with the platform; your org can also create its own.
- **Integrity issue** - a flag on a board whose project link is broken (cross-org, missing, or auto-detached). You resolve it by detaching the board from the project or reassigning it to a valid one.
- **Roles** - org roles resolve as viewer, member, admin, owner. Admins and owners get full access to any board in the org.

### Where to find it

Board is served at `/board/`. A single board's canvas is at `/board/<boardId>`, and its version history is at `/board/<boardId>/versions`.

Prerequisites:

- A signed-in BigBlueBam session. Board uses the shared Bam session cookie.
- An organization. To scope a board to a project, that project must exist in Bam and belong to your org.
- Edit access to a board to change it. Locked boards are editable only by the creator or an org admin or owner.

The left sidebar has four nav items: **All Boards**, **Starred**, **Templates**, and **Archive**. A project scope selector at the top of the sidebar lets you switch between "All Projects" and a single project to filter the list and stats. Press `?` anywhere outside a text field to open the in-app help.

## Feature reference

### Board list (All Boards)

The home view lists your boards as cards. It shows a heading "Boards" and the subtitle "Visual collaboration whiteboards for your team".

The page has four stat cards across the top: **Total Boards**, **Recent**, **Starred**, and **Archived**. Below them is a search box and a grid of board cards.

To browse and open a board:

1. Open Board at `/board/`. **All Boards** is the default view.
2. To narrow the list to one project, use the project scope selector at the top of the sidebar. A banner shows "Showing: All Projects" or "Showing: <Project>", with a **Show All Projects** reset.
3. Type in the **Search boards...** box to filter by board name or description.
4. Click a board card to open its canvas.

Each board card shows the board's thumbnail or icon, an element-count caption ("N elements" or "Empty board"), a project badge, and a collaborator-count chip ("N collaborator(s)"). A lock icon appears on locked boards. An amber warning icon appears when a board has an integrity issue, with the tooltip "N integrity issue(s). Open the board to fix."

If there are no boards, the empty state reads "No boards yet" (or "No boards match your search"), with a **Create Board** button that takes you to the Templates browser.

The **...** menu on each card holds **Version history**, **Duplicate**, **Archive**, and **Delete**. See the lifecycle and version sections below.

![All boards](screenshots/light/01-all-boards.png)

### Creating a board from a template

Templates give you a pre-built canvas (a retro layout, a brainstorm board, an architecture template, and so on).

To create a board from a template:

1. From **All Boards**, click **New Board** (top-right), or click **Templates** in the sidebar. Both lead to the Templates browser.
2. The browser shows a heading "Templates" and the subtitle "Start from a pre-built template, or create a blank board".
3. Use the category tabs to filter: **General**, **Retro**, **Brainstorm**, **Planning**, **Architecture**, **Strategy**, or **All**.
4. On the template you want, click **Use**.
5. A new board is created from that template and its canvas opens.

![Board templates](screenshots/light/03-templates.png)

### Creating a blank board

To start from an empty canvas:

1. In the Templates browser, click **Blank board** (top-right), which opens the "Create New Board" page. (You can also pick the **Blank Board** card, captioned "Start with an empty canvas", on that page.)
2. The page shows a heading "Create New Board".
3. Pick an emoji with the **Icon** picker.
4. Type a name in the **Board name** field (placeholder "Untitled Board").
5. Click **Create Board**. To abandon, click **Cancel**.
6. The new board's canvas opens.

### The infinite canvas

The canvas is a full-screen Excalidraw editor. It opens when you click a board card or finish creating a board.

The drawing tools are Excalidraw's own native toolbar, not Board's. From that toolbar you can add and edit shapes (rectangle, diamond, ellipse), arrows and lines, text, freehand drawings, frames, and images, plus zoom, pan, and multi-select. Use Excalidraw's toolbar for everything you draw.

Board overlays a few of its own controls on top of the canvas:

- A floating **board toolbar** at the top (covered below).
- A **connection status badge** at the top-right.
- An **integrity banner** at the top when the board's project link is broken.
- A **chat panel** that slides in from the right.

Your work saves automatically. The canvas persists locally as you draw and writes to the server a few seconds after you stop, and it saves once more when you close the tab. You do not need a Save button for canvas content.

![Board canvas](screenshots/light/02-canvas-populated.png)

#### Adding sticky notes

Sticky notes are colored notes for capturing ideas. The default color is yellow.

Add stickies from Excalidraw's tools on the canvas (a rectangle with text). An AI agent can also add a sticky directly with one of six colors (yellow, green, blue, red, purple, orange) and a position; see Working with AI agents.

#### Adding text

Add free text from Excalidraw's text tool on the canvas. An agent can add a text element with a position; see Working with AI agents.

#### Shapes, arrows, and frames

Rectangles, diamonds, ellipses, arrows, lines, freehand strokes, images, and frames all come from Excalidraw's native toolbar. Group related elements inside a frame so the board can later be read or summarized by section.

### The board toolbar

The floating toolbar at the top of the canvas holds board-level controls (it is separate from Excalidraw's drawing toolbar):

- A **back arrow** (tooltip "Back to boards") that returns to **All Boards**.
- An **icon picker** and the board name. Click the name to rename the board inline; press Enter to save or Escape to cancel.
- A lock icon, shown when the board is locked.
- The **presence strip**, which shows who else is present on the board and is the entry point to a voice huddle (see Real-time presence and audio).
- A **Toggle chat** button that opens the chat panel.
- A **Version history** button that opens the board's versions.
- A **Share** button that copies a shareable link to the board to your clipboard. The button briefly reads "Link copied" after a successful copy.
- A **...** menu containing **Lock board** / **Unlock board**, and **Export as PNG** and **Export as SVG**. Each export item renders the board on the server and downloads a real image file.

To rename a board from the toolbar:

1. Open the board's canvas.
2. Click the board name in the floating toolbar.
3. Type the new name.
4. Press Enter to save (or Escape to cancel).

To copy a shareable link:

1. Open the board's canvas.
2. Click the **Share** button in the floating toolbar.
3. The board's link is copied to your clipboard and the button shows "Link copied".
4. Paste the link to anyone who has access to the board. Access is still governed by the board's visibility and collaborators, so the link opens for people who are already allowed to see it.

### Locking a board

Locking makes a board read-only for everyone except its creator and org admins and owners. Use it to freeze a finished board.

To lock or unlock a board:

1. Open the board's canvas.
2. In the floating toolbar, open the **...** menu.
3. Click **Lock board** (or **Unlock board** if it is already locked).
4. A locked board shows a lock icon in the toolbar and on its card in the list.

### Chat

Each board has a side chat panel for discussion while you whiteboard.

To chat:

1. Open the board's canvas.
2. Click the **Toggle chat** button in the floating toolbar to open the chat panel (header "Chat").
3. Type in the **Type a message...** box and send.
4. Your messages appear right-aligned; others' messages appear on the left.

Note: chat is not pushed live over the realtime connection. The panel refreshes by polling, so new messages from others appear after the next refresh rather than the instant they are sent. The chat shows up to the last 100 messages.

### Version history (snapshots)

A version is a named snapshot of the whole canvas. Save a version before a big change so you can roll back.

To save a version:

1. Open the board's canvas and click the **Version history** button in the floating toolbar (or open the **...** menu on the board card and choose **Version history**). This opens the "Version History" page.
2. Click **Save Version**.
3. In the dialog, type a **Version name**.
4. Confirm to create the snapshot.

The version list shows each version's name, a "Latest" chip on the newest one, the creator, and a relative time. The newest snapshot is at the top.

To restore a version:

1. Open the "Version History" page for the board.
2. Find the version you want and click **Restore**.
3. Confirm at the "Restore this version?" prompt.
4. The board's canvas is replaced with that snapshot.

Note: the Save Version dialog has a **Description (optional)** field, and the list is laid out to show a description, an element count, and the creator's name. The backend does not store the description and does not return an element count or creator name on versions today, so those fields render blank. Only the version name, the creator reference, and the timestamp are saved and shown reliably.

![Version history](screenshots/light/04-version-history.png)

### Archive, restore, and delete

Archiving hides a board without destroying it. Deleting is permanent.

To archive a board:

1. On **All Boards**, open the **...** menu on the board's card.
2. Click **Archive**. The board moves to the **Archive** view.

To view and restore archived boards:

1. Click **Archive** in the sidebar. The heading reads "Archive".
2. On an archived board's card, click **Restore** to bring it back, or **Delete permanently** to remove it for good.
3. If the archive is empty, you see "Archive is empty".

To delete a board permanently from the list:

1. On a board's **...** menu, click **Delete**.
2. Confirm in the "Delete board?" dialog. This permanently removes the board and its elements, collaborators, stars, versions, and links. This cannot be undone.

### Duplicating a board

Duplicate copies a board and all its elements into a new board.

To duplicate:

1. On **All Boards**, open the **...** menu on the board's card.
2. Click **Duplicate**.
3. A copy is created, named "<original name> (copy)".

### Starring a board

Stars are your personal favorites.

To star a board:

1. On a board card in **All Boards**, click the star overlay on the card to toggle it.
2. Open **Starred** in the sidebar to see all your starred boards (heading "Starred Boards"). If you have none, the view reads "No starred boards".

### Templates browser

Beyond creating boards, the Templates browser is where org templates are surfaced. Each template card shows a thumbnail or icon, a name, a description, a category badge, an element count, and a **Use** button. Categories shown as tabs are **General**, **Retro**, **Brainstorm**, **Planning**, **Architecture**, **Strategy**, and **All**. If there are none, the view reads "No templates available". System templates are read-only; your org can create and manage its own (through the API or an agent today; see Working with AI agents).

### Fixing a board with an integrity issue

A board can end up with a broken project link (the project is in another org, was deleted, or was auto-detached). When that happens, an amber banner appears at the top of the canvas.

To fix it:

1. Open the affected board (its card shows an amber warning icon in **All Boards**).
2. Read the message in the amber integrity banner at the top of the canvas.
3. To remove the broken link, click **Detach from project** (also labeled **Leave unattached**).
4. To point the board at a valid project, click **Reassign to a project**, pick a project from the radio list in the "Reassign to a project" dialog, and confirm.

### Export

A board's canvas can be exported as JSON, SVG, or PNG.

To export an image from the canvas:

1. Open the board's canvas.
2. In the floating toolbar, open the **...** menu.
3. Click **Export as PNG** or **Export as SVG**. The menu item briefly reads "Exporting…" while the server renders the board.
4. A real image file downloads, named after the board.

Export is also available to AI agents: an agent renders SVG or PNG with the `board_export` tool, and the same server endpoint (`GET /boards/:id/export/:format`) can be called directly through the API.

### Collaborators (no in-app management today)

A board's visibility (`private`, `project`, `organization`) controls who can reach it, and a board can also have explicit per-person collaborators with `view` or `edit` permission. There is a complete backend for adding, listing, changing, and removing collaborators, but there is no screen in the Board app to manage them today. The toolbar's **Share** button copies the board's link rather than opening a collaborator manager. Until a sharing screen ships, control who can see a board through its **visibility** setting, or have an agent or API client manage collaborators directly (the `board_add_collaborator`, `board_list_collaborators`, `board_update_collaborator`, and `board_remove_collaborator` tools, covered under Working with AI agents).

### Real-time presence and audio

When more than one person is on a board, you see each other's live cursors on the canvas and presence indicators in the toolbar. The connection status badge at the top-right shows **Live** (green), **Connecting** (amber), or **Offline** (red), plus an "N editors" chip when other people are present. If your connection drops and reconnects, recent changes are replayed so the canvas catches up.

Audio for a board comes from the platform-wide presence system that the toolbar surfaces through its presence strip, not from a board-api capability. The strip reports the open canvas as a shared surface, and the platform call manager derives a per-board voice room from it, so a teammate can join a voice huddle on the same canvas. Audio conferencing is therefore a platform feature layered on top of Board, not something the Board service hosts itself.

### Element limits

A board can hold a large number of elements, with a soft limit at 500 and a hard limit at 2000 live elements. Past the soft limit you get a warning; at the hard limit further additions are rejected. Deleted elements do not count.

### Working with AI agents

Agents reach Board through 40 MCP tools backed by board-api. Every tool forwards your bearer token, so an agent acts with your permissions and a locked board stays locked. Most tools accept a board **name or UUID**; templates, projects, and phases also resolve by name. For the full catalog and arguments, see the Board MCP-tools reference in `docs/apps/board/`.

What agents commonly do:

- **Read and observe a canvas.** `board_read_elements` reads every element with its position, text, and type. `board_read_stickies` returns only sticky notes; `board_read_frames` returns frames with their child elements; `board_summarize` produces a frame-grouped summary. `board_search` searches element text across boards. `board_list`, `board_get`, `board_list_recent`, `board_list_starred`, `board_stats`, and `board_org_stats` cover discovery and metadata.
- **Build a board.** `board_create` makes a board (optionally from a template by name). `board_add_sticky` drops a sticky in one of six colors at a position; `board_add_text` adds a text element. `board_update` patches name, description, background, visibility, and icon.
- **Promote to Bam tasks (the marquee cross-app flow).** `board_promote_to_tasks` turns selected brainstorm stickies into Bam tasks in a named project and phase, and records a link from each sticky back to its task. There is no human button for this today; it is an agent-and-API flow. `board_list_links` shows the resulting links and `board_delete_link` removes one without touching the task or sticky.
- **Manage what humans cannot reach in the UI yet.** Collaborators (`board_add_collaborator`, `board_list_collaborators`, `board_update_collaborator`, `board_remove_collaborator`), templates (`board_list_templates`, `board_create_template`, `board_update_template`, `board_delete_template`, `board_instantiate_template`), versions (`board_list_versions`, `board_create_version`, `board_restore_version`), chat (`board_read_chat`, `board_post_chat`), stars (`board_star_toggle`), and integrity (`board_check_integrity`, `board_remediate_integrity`) all have tools even where Board has no screen.
- **Run lifecycle and export.** `board_duplicate`, `board_archive` (soft delete), `board_restore`, and `board_delete_permanent` (hard, irreversible delete) cover lifecycle. `board_export` exports SVG or PNG, the same render the canvas export menu downloads.

Things for a human reviewer to know:

- Promote-to-tasks creates real Bam tasks. Review the resulting tasks in the target project after an agent runs it.
- `board_delete_permanent` cascades through elements, collaborators, stars, versions, and links and cannot be undone. Prefer `board_archive` unless removal is final.
- Two MCP behaviors are known to drift from the backend and may not do what their description implies: `board_update` cannot toggle the lock state (its PATCH does not accept a `locked` field, so locking stays a separate action with no MCP tool of its own), and a few tool descriptions and return shapes do not exactly match the live API (for example `board_create` lists different background and visibility defaults than the server applies, which are `dots` and `project`). Prefer the dedicated paths and verify results.
- Right after a fresh board is drawn, the per-element copy that powers search and promote may lag the canvas by a few seconds. If `board_search` or a promote finds nothing on a brand-new board, give the snapshot a moment.

Agent actions emit Bolt events you can automate on: `board.created`, `board.updated`, `board.locked`, and `board.elements_promoted`.

#### Cross-cutting agentic platform

Board's tools sit on the same platform surface every app shares, so agent work is identifiable, reviewable, and governed:

- **Identity and heartbeat.** Agent and service accounts are distinct from human users, and their actions are tagged as such in the activity log. Long-running agents report liveness with `agent_heartbeat`.
- **Approvals.** An agent can route a board action it should not take unilaterally (for example a permanent delete or a large promote-to-tasks run) into an approval queue with `proposal_create`; a human reviews and resolves it with `proposal_list` and `proposal_decide`.
- **Unified activity.** Board activity is queryable alongside every other app through the unified activity view and `activity_query` / `activity_by_actor`.
- **Visibility preflight.** Before an agent posts a board's contents into another shared surface, it calls `can_access` for each cited entity and drops anything the asking user is not allowed to see.
- **Policies and webhooks.** Per-agent kill switches and tool allowlists (a `board.*` glob covers Board's tools) gate every service-account call, and subscribed Bolt events can be pushed to an agent runner over a signed outbound webhook.

## User Stories

### Story: Create your first board from a template

**Who:** A team member new to Board.
**Goal:** Get a working whiteboard started without setting up a layout by hand.
**Before you start:** Be signed in to BigBlueBam.

**Steps**

1. Go to `/board/`. You land on **All Boards**.
2. Click **New Board** at the top-right. The Templates browser opens.
3. Use the category tabs (**General**, **Retro**, **Brainstorm**, **Planning**, **Architecture**, **Strategy**, **All**) to find a fitting layout.
4. On the template you want, click **Use**.
5. The new board opens on the canvas.

**Result:** A new board exists, pre-filled from the template, and you are looking at its canvas. It appears in **All Boards**.

**Related:** To start empty instead, see "Create a blank board". An agent can do the same with `board_create` (template by name) or `board_instantiate_template`.

### Story: Create a blank board

**Who:** Anyone who wants an empty canvas.
**Goal:** Start a whiteboard from scratch with a name and icon.
**Before you start:** Be signed in.

**Steps**

1. Go to `/board/` and click **Templates** in the sidebar (or **New Board** from the list).
2. Click **Blank board** at the top-right of the Templates browser.
3. On the "Create New Board" page, pick an emoji with the **Icon** picker.
4. Type a name in **Board name** (placeholder "Untitled Board").
5. Click **Create Board**.

**Result:** An empty board opens on the canvas, ready to draw on.

**Related:** `board_create` does this for an agent.

### Story: Brainstorm on the canvas

**Who:** A facilitator or contributor running an ideation session.
**Goal:** Capture ideas as sticky notes, text, shapes, and arrows on one canvas.
**Before you start:** Have a board open and edit access to it.

**Steps**

1. Open the board's canvas.
2. Use Excalidraw's native toolbar to add sticky notes, text, shapes, arrows, freehand drawings, and frames.
3. Drag elements to arrange them; group related ideas inside a frame.
4. Keep working. The canvas auto-saves as you go and again when you close the tab.

**Result:** Your ideas are captured on the board and saved automatically.

**Related:** An agent can seed a board with `board_add_sticky` and `board_add_text`, then group thinking with frames for `board_summarize`.

### Story: Collaborate live with teammates

**Who:** Two or more people working a board at the same time.
**Goal:** Edit together and see each other's changes and cursors.
**Before you start:** Each person needs access to the same board.

**Steps**

1. Each person opens the same board's canvas.
2. Watch the connection status badge at the top-right for **Live**, and the "N editors" chip for who is present.
3. Add and move elements. Changes from others appear on your canvas in real time, and you see their cursors.
4. If your connection drops, wait for it to reconnect; recent changes are replayed automatically.

**Result:** Everyone is editing one shared canvas and stays in sync.

**Related:** To bring people in, copy the board link with the **Share** button (see "Share a board link"). To talk while you work, use the presence strip in the toolbar to start a voice huddle on the canvas. To type instead, see "Chat while you whiteboard".

### Story: Share a board link

**Who:** Anyone who wants a teammate on a board.
**Goal:** Hand someone a direct link to the board.
**Before you start:** Have the board open. The recipient must already be allowed to see the board (through its visibility or as a collaborator).

**Steps**

1. Open the board's canvas.
2. Click the **Share** button in the floating toolbar.
3. The board's link is copied to your clipboard and the button shows "Link copied".
4. Paste the link into chat, email, or wherever your teammate will find it.

**Result:** Your teammate has a direct link that opens the board's canvas, subject to the board's visibility and collaborator rules.

**Related:** There is no in-app collaborator manager yet; widen who can open the link through the board's **visibility** setting, or have an agent add explicit collaborators with `board_add_collaborator`.

### Story: Chat while you whiteboard

**Who:** Collaborators on a board.
**Goal:** Discuss the board without leaving it.
**Before you start:** Have the board open and edit access.

**Steps**

1. Open the board's canvas.
2. Click **Toggle chat** in the floating toolbar to open the chat panel.
3. Type in **Type a message...** and send.
4. Read the thread in the panel; your messages are right-aligned.

**Result:** The team has a running discussion attached to the board.

**Related:** Chat refreshes by polling, so messages from others appear on the next refresh rather than instantly. An agent can read or post with `board_read_chat` and `board_post_chat`.

### Story: Star and find your boards

**Who:** A regular Board user with many boards.
**Goal:** Keep important boards one click away and filter the list.
**Before you start:** Have at least one board.

**Steps**

1. On **All Boards**, click the star overlay on a board card to favorite it.
2. Click **Starred** in the sidebar to see only starred boards.
3. Back on **All Boards**, use the project scope selector to filter by project.
4. Use the **Search boards...** box to find a board by name or description.

**Result:** Your favorites are grouped in **Starred**, and you can filter and search the full list.

**Related:** An agent can list boards with `board_list`, list starred with `board_list_starred`, toggle a star with `board_star_toggle`, and search element text with `board_search`.

### Story: Snapshot and restore a board

**Who:** Anyone about to make a big change.
**Goal:** Save a restore point and roll back if needed.
**Before you start:** Have edit access to the board.

**Steps**

1. Open the board and click the **Version history** button in the floating toolbar.
2. On the "Version History" page, click **Save Version**.
3. Type a **Version name** and confirm.
4. Later, to roll back, return to "Version History", click **Restore** on the version you want, and confirm at "Restore this version?".

**Result:** A named snapshot is saved, and you can restore the canvas to it at any time.

**Related:** The dialog's Description field and the list's element-count and creator-name fields are not stored or returned by the backend today and render blank. An agent can snapshot and restore with `board_create_version`, `board_list_versions`, and `board_restore_version`.

### Story: Promote brainstorm stickies into Bam tasks

**Who:** A facilitator (with an agent's help) turning ideas into tracked work.
**Goal:** Convert selected sticky notes into Bam tasks in a project and phase.
**Before you start:** Stickies exist on the board, and you know the target Bam project (and optionally phase). There is no human button for this; it runs through an agent or the API.

**Steps**

1. Identify the sticky notes you want to turn into tasks.
2. Ask an agent to promote them, naming the target project and phase. The agent uses `board_promote_to_tasks`.
3. The agent creates one Bam task per sticky and records a link from each sticky to its task.
4. Open the target project in Bam to review the new tasks.

**Result:** Each promoted sticky has a matching Bam task, linked back to the source element.

**Related:** This emits a `board.elements_promoted` Bolt event you can automate on. An agent can review the links with `board_list_links`. See the Bam help doc for task management.

### Story: Lock a finished board

**Who:** The board creator or an org admin or owner.
**Goal:** Freeze a board so others cannot change it.
**Before you start:** Be the creator or an org admin or owner.

**Steps**

1. Open the board's canvas.
2. Open the **...** menu in the floating toolbar.
3. Click **Lock board**.
4. To allow edits again, repeat and click **Unlock board**.

**Result:** The board is read-only for everyone except its creator and org admins and owners, and shows a lock icon in the toolbar and on its card.

**Related:** An agent cannot toggle the lock through `board_update`; locking is a separate action with no MCP tool of its own today.

### Story: Fix a board flagged with an integrity issue

**Who:** Anyone who opens a board with a broken project link.
**Goal:** Clear the integrity warning by detaching or reassigning the project.
**Before you start:** Have edit access to the board.

**Steps**

1. Open the board; its card in **All Boards** shows an amber warning icon.
2. Read the amber integrity banner at the top of the canvas.
3. To drop the broken link, click **Detach from project** (or **Leave unattached**).
4. To repoint it, click **Reassign to a project**, choose a project in the "Reassign to a project" dialog, and confirm.

**Result:** The integrity warning clears and the board is either unattached or attached to a valid project.

**Related:** An agent can do the same with `board_check_integrity` and `board_remediate_integrity` (action `detach` or `reassign`).

### Story: Archive, restore, or delete a board

**Who:** A board owner cleaning up.
**Goal:** Remove a board from the active list, recover it, or delete it for good.
**Before you start:** Have edit access to the board.

**Steps**

1. On **All Boards**, open the board card's **...** menu and click **Archive**.
2. To recover it, click **Archive** in the sidebar, find the board, and click **Restore**.
3. To remove it permanently, click **Delete permanently** on the archived card, or use **Delete** on the **...** menu in the list and confirm "Delete board?".

**Result:** The board is archived (recoverable) or permanently deleted, depending on your choice.

**Related:** Use **Duplicate** on the **...** menu first if you want a copy before removing the original. An agent uses `board_archive`, `board_restore`, and `board_delete_permanent`.

### Story: Export a board image

**Who:** Anyone who needs a picture of the board for a doc or deck.
**Goal:** Get an SVG or PNG of the board.
**Before you start:** Have access to the board.

**Steps**

1. Open the board's canvas.
2. Open the **...** menu in the floating toolbar.
3. Click **Export as PNG** or **Export as SVG**. The item shows "Exporting…" while the server renders the board.
4. The image file downloads, named after the board.

**Result:** You have an SVG or PNG rendering of the board saved to your downloads.

**Related:** An agent can export the same render with `board_export`, and the export endpoint is also reachable directly through the board-api.

### Story: Have an agent set up and seed a board

**Who:** Someone who wants a board built and pre-populated without doing it by hand.
**Goal:** Get a named board, scoped to a project, with starter stickies on it.
**Before you start:** Be signed in. Know the project name (if you want it scoped) and the rough content you want seeded.

**Steps**

1. Ask an agent to create the board, naming it and the project. The agent uses `board_create` (optionally from a template by name).
2. Ask the agent to drop your starter ideas as stickies. It uses `board_add_sticky` once per note, choosing colors.
3. Open `/board/` and the new board appears in **All Boards**; open it to see the seeded canvas.

**Result:** A ready-to-use board exists with your starting content, and you can keep editing it live.

**Related:** The agent can also group the stickies into frames so a later `board_summarize` reads cleanly, and can promote them to Bam tasks with `board_promote_to_tasks`.

## Related

- **Bam** - the core project and task app. Board scopes boards to Bam projects, and promote-to-tasks creates Bam tasks in a project and phase. See `docs/apps/api/` or the Bam help doc.
- **Bolt** - workflow automation. Board emits `board.created`, `board.updated`, `board.locked`, and `board.elements_promoted` events you can build rules on.
- **Platform presence and audio** - provides the toolbar presence strip and any voice huddle on a board. Audio is a platform feature, not part of the Board service.
- **Board MCP-tools reference** - the full list and arguments for the 40 Board MCP tools, in `docs/apps/board/`.
- **Board guide** - the product guide in `docs/apps/board/`, for narrative and background.
