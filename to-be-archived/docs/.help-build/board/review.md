# Board help.md - Review

## Verdict: APPROVED

`docs/apps/board/help.md` passes the help-doc-authoring acceptance checklist.
Every template section is present and filled, every user-facing frontend view
and action has how-to steps, all six required story categories are covered, the
14 MCP tools are code-backed, all three referenced screenshots exist, there are
no em dashes, and the two specifically-watched traps (audio = Bureau not Board;
Share button and Export menu items presented as non-working) are handled
correctly. No changes required.

---

## Verification performed

### Template completeness
All four canonical sections present and filled: Overview (with Key concepts and
Where to find it), Feature reference (with Working with AI agents), User Stories,
Related. Skeleton order respected.

### Feature coverage (frontend inventory cross-check)
Every page under `apps/board/src/pages/` is documented:
- `board-list.tsx` -> Board list (All Boards)
- `board-new.tsx` -> Creating a blank board
- `template-browser.tsx` -> Creating from a template / Templates browser
- `board-canvas.tsx` -> The infinite canvas + board toolbar
- `version-history.tsx` -> Version history
- `starred-boards.tsx` -> Starring a board
- `archived-boards.tsx` -> Archive, restore, and delete

Every canvas component is documented: `board-toolbar.tsx`, `chat-panel.tsx`,
`connection-status-badge.tsx`, `board-integrity-banner.tsx`. `cursor-overlay.tsx`
and `presence-bar.tsx` are dossier-flagged dead code (live cursors render via
Excalidraw's native collaborators map; toolbar uses `PresenceChipStrip`), and the
doc correctly omits them. Every mutation hook (`use-boards`, `use-chat`,
`use-templates`, `use-versions`) maps to a documented feature.

### Story coverage
- Setup: "Create your first board from a template", "Create a blank board"
- Core loop: "Brainstorm on the canvas"
- Collaboration: "Collaborate live with teammates", "Chat while you whiteboard"
- Search/reporting/organize: "Star and find your boards"
- Agent flow: "Promote brainstorm stickies into Bam tasks"
- Plus: snapshot/restore, lock, integrity fix, archive/restore/delete, export.
Steps name exact UI elements and are followable.

### Accuracy spot-checks (all traced to code)
- Subtitle "Visual collaboration whiteboards for your team" -> board-list.tsx:41
- Stat cards Total Boards / Recent / Starred / Archived -> board-list.tsx:53-56
- "New Board" button -> board-list.tsx:46 (lands on /templates per template-browser.tsx:65 comment)
- "Showing: All Projects" / "Show All Projects" -> board-list.tsx:78-89
- "Search boards..." -> board-list.tsx:100
- Card "..." menu: Version history / Duplicate / Archive / Delete; archived: Restore / Delete permanently -> board-card.tsx:144-170
- "Empty board" / "N elements" / "N collaborator(s)" -> board-card.tsx:70, 198-204
- Integrity tooltip "N integrity issue(s). Open the board to fix." -> board-card.tsx:119
- "Delete board?" -> board-card.tsx:223
- Integrity banner "Detach from project" / "Leave unattached" / "Reassign to a project" -> board-integrity-banner.tsx:85-106
- "Create New Board", "Untitled Board", "Blank Board", "Create Board", "Cancel" -> board-new.tsx
- Templates subtitle and "Blank board", category tabs, "Use", "No templates available" -> template-browser.tsx
- "Version History", "Save Version", "Restore this version?" -> version-history.tsx:64-169
- "Starred Boards" / "No starred boards" -> starred-boards.tsx:17,34
- "Archive" / "Archive is empty" -> board-sidebar.tsx:18, archived-boards.tsx:37
- Chat "Type a message..." -> chat-panel.tsx:118
- Connection badge "Live" / "Connecting" / "Offline" -> connection-status-badge.tsx:43
- `beta` chip -> board-sidebar.tsx:120
- Sticky default yellow #FFEB3B, colors yellow/green/blue/red/purple/orange -> board-tools.ts:304-311, element.routes.ts:25
- Element limits soft 500 / hard 2000 -> element-snapshot.service.ts:7-8
- Chat last 100 messages -> chat.routes.ts:13
- Backgrounds dots(default)/grid/lines/plain; visibilities private/project(default)/organization -> board.routes.ts:12-22
- Bolt events board.created / board.updated / board.locked / board.elements_promoted -> event-catalog.ts:1226,1255,2058,2071
- 14 MCP tools enumerated -> board-tools.ts (board_list, board_get, board_create, board_update, board_archive, board_read_elements, board_read_stickies, board_read_frames, board_add_sticky, board_add_text, board_promote_to_tasks, board_export, board_summarize, board_search)

### Documented drifts confirmed accurate
- Share button has no onClick -> board-toolbar.tsx:135-142. Doc correctly says
  "not wired to anything in the current build."
- Export-as-PNG / Export-as-SVG menu items have no onClick ->
  board-toolbar.tsx:165-172. Doc correctly says they "do not produce a file"
  and points to API/MCP `board_export`.
- Audio is Bureau, not Board -> toolbar mounts `PresenceChipStrip`; board-api has
  no LiveKit/audio code. Doc's "Note on audio" and Related entry correctly
  attribute voice to the platform-wide Bureau presence system, never to board-api.
- `board_update` cannot toggle lock: `updateBoardSchema` (board.routes.ts:26-32)
  has no `locked` field; lock is `POST /boards/:id/lock`. Doc flags this.
- Version description / element_count / creator_name not stored:
  `createVersionSchema` (version.routes.ts:8) accepts only `name`. Doc flags that
  those dialog/list fields render blank.
- Chat is poll-refresh, not WS-broadcast (chat.routes.ts note). Doc flags it.

### Conventions
- No em dashes (grep for U+2014 returned nothing).
- Counts are code-backed and exact (500/2000, 100, 14 tools).
- All three referenced screenshots exist:
  `docs/apps/board/screenshots/{light,dark}/01-list.png`, `02-canvas.png`,
  `03-templates.png` (6 files total).

---

## Accuracy findings (non-blocking)

1. Minor imprecision, not a fix: the doc twice describes an "N editors" chip on
   the connection status badge (Feature reference > Real-time presence, and the
   "Collaborate live" story). In `connection-status-badge.tsx:47-54` the visible
   chip renders only the peer count next to a Users icon; the word "editors"
   appears only in the chip's hover `title` tooltip
   (`${peerCount} other editor(s) on this board`), not as on-screen chip text.
   The claim is substantively true (a count chip does appear, and the "editors"
   wording exists), so this is acceptable as written. Optional tightening: phrase
   it as "a peer-count chip (its tooltip reads 'N other editors on this board')."

No false claims found. No fixes required.
