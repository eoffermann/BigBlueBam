# Blueprint help.md - Review

## Verdict: CHANGES REQUESTED

The doc is strong: it is structurally complete, covers every frontend view and
action, tells the truth about all the major gaps (Tree/Grid silent failure,
inert templates, SVG/PNG export rejection, no-UI versions/comments/collaborators,
plan-only promotion, client-side search), references no screenshots (correct -
none exist), uses no em dashes, and the MCP tool count of 23 is exact. The
issues below are small accuracy nits and one over-specific numeric claim; none
are structural, but they should be fixed before approval.

---

## Numbered fix list

1. **File: docs/apps/blueprint/help.md - "Edit a node" section, step 5 (line ~94)
   and "Key concepts" / Inspector wording.**
   Wrong: "Set **Width** and **Height** (each between 40 and 2000)."
   The Width and Height bounds are not the same. In the Inspector the Width field
   enforces a minimum of 40 (`commitWidth` rejects < 40, apps/blueprint/src/components/canvas/inspector.tsx:131)
   but the Height field enforces a minimum of 30 (`commitHeight` rejects < 30,
   inspector.tsx:139; the canvas NodeResizer also uses `minHeight={30}`,
   apps/blueprint/src/components/canvas/node-types.tsx:65). Both max out at 2000.
   Fix: state Width 40 to 2000 and Height 30 to 2000 (or "each up to 2000; minimum
   40 wide, 30 tall").

2. **File: docs/apps/blueprint/help.md - "Edit a node" section, step 3 (line ~92).**
   The doc quotes the Description placeholder as
   `Describe this node... **bold**, *italic*, `code`, [links](url) all work.`
   using three ASCII periods. The actual rendered string uses a single ellipsis
   character: `Describe this node… **bold**, *italic*, `code`, [links](url) all work.`
   (apps/blueprint/src/components/canvas/inspector.tsx:203). Convention requires
   UI labels reproduced exactly. Fix: change `node...` to `node…` (ellipsis), or
   drop the verbatim quote and paraphrase ("a placeholder reminding you that
   bold, italic, code, and links all work").

3. **File: docs/apps/blueprint/help.md - "The editor canvas" section (line ~69).**
   The doc says the count line reads `N nodes . M edges`. The separator in the
   code is a middle dot, not a period: `{N} nodes · {M} edges`
   (apps/blueprint/src/pages/editor.tsx:960). Minor, but since it is presented as
   the literal on-screen string, use the middle dot (·) or describe it as "a count
   line showing the node and edge totals" rather than transcribing a wrong glyph.

---

## Accuracy findings (claims checked against code)

All of the following doc claims were verified and TRACE CORRECTLY to code; listed
so the orchestrator can see what was checked:

- **23 MCP tools.** Exactly 23 `registerTool` / `blueprint_*` registrations in
  apps/mcp-server/src/tools/blueprint-tools.ts (the in-file section-header comments
  miscount node ops as 4 and cross-product as 2, but the actual registered count is
  23). Doc's "There are 23 Blueprint tools" and the Related-section "23 agent tools"
  are correct.
- **Tree/Grid layout silent failure.** TRUE and well-explained. The editor dropdown
  offers values `layered`/`force`/`tree`/`grid` (editor.tsx:81-86) but the backend
  `ALGORITHM_MAP` only contains `layered`, `mrtree`, `force`, `radial`, `rectpacking`
  (apps/blueprint-api/src/services/layout.service.ts:22-28); `tree`/`grid` hit the
  `Unknown algorithm` ValidationError path (layout.service.ts:59-63). Doc flags this
  accurately in both the Auto-layout feature section and the "Reorganize a messy
  graph" story.
- **Inert templates.** TRUE. `createDiagram` never reads `template_id`
  (apps/blueprint-api/src/services/diagram.service.ts:104-127); the route accepts it
  (diagrams.routes.ts:24) and the dialog offers a Template select (list.tsx:491-511)
  but nothing is seeded. No template create/update/delete endpoint exists. Doc's
  "Note on templates" and the agent-section caveat are accurate.
- **SVG/PNG export rejected in-process.** TRUE. exportDiagram throws
  `Format '<f>' is not supported in-process` for svg/png
  (apps/blueprint-api/src/services/export.service.ts:49); only json and mermaid
  return. The `blueprint_export` tool still advertises svg/png
  (blueprint-tools.ts:223). Doc flags both correctly.
- **No UI for versions/restore, comments, collaborators, Mermaid import.** TRUE.
  The editor only creates snapshots (Save snapshot -> POST /versions); there is no
  restore, comment, collaborator, or import surface in apps/blueprint/src. There are
  no MCP tools for versions, comments, or collaborators either. Doc says so plainly
  in each relevant section.
- **Promotion is plan/payload only.** TRUE. promote-to-tasks returns a plan and
  promote-to-task returns a task_payload; the SPA does the second hop against
  /b3/api (editor.tsx onPromoteGraph/onPromoteToTask). Doc explains the
  caller-executes-the-plan mechanic correctly.
- **Generate from Bam writes org_chart.** TRUE
  (apps/blueprint-api/src/services/cross-product.service.ts:150).
- **Archive requires admin scope.** TRUE (diagrams.routes.ts:154 requireScope('admin')).
- **Auth gate links to /b3/.** TRUE (app.tsx:120-132, "Please log in to BigBlueBam
  first to access Blueprint").
- **UI labels** (New diagram dialog fields, visibility radios + hints, "None - org-wide",
  "Blank canvas", From Bam dialog title/checkboxes, sidebar Library/By type pills,
  Add-shape split button, layout direction options, Export menu items, Promote to Bam,
  delete-prompt buttons "Cancel"/"Delete node only"/"Delete node + task", node/edge
  context-menu items, edge Kind/End marker options, "Nothing selected" empty state)
  all match the frontend source exactly.
- **No screenshots referenced; "a visual walkthrough is not yet available."** CORRECT.
  docs/apps/blueprint/ contains only help.md; the doc references no image paths.
- **No em dashes.** CONFIRMED (grep for U+2014 returned none).

No false feature claims were found. The three fixes above are transcription/precision
corrections only.
