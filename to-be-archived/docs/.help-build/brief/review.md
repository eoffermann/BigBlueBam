# Brief help.md - Acceptance Review

**Verdict: CHANGES REQUESTED**

One-line rationale: The doc is accurate, complete, and correctly documents every
known-broken surface, but the MCP tool count is wrong (says 17, code registers 18).

---

## Summary of checks

- **Template completeness:** PASS. All four required sections present and filled:
  Overview (what/who/key concepts/where to find it), Feature reference (one
  subsection per user-facing view + Working with AI agents), User Stories (15
  named stories), Related (Bam/Beacon/Bolt handoffs + guide + mcp-tools links).
- **Feature coverage:** PASS. Every SPA view and action found in `apps/brief/src`
  has how-to steps: Home, Documents list, Create, Write/format (toolbar + slash),
  Set visibility, Set icon, Choose project, Templates, Save/Publish, Read detail,
  Edit/co-edit, Comments, Star, Duplicate, Export, Archive/Restore, Promote,
  Linked Items, Folders/project scope, Search. The "Brief summary" non-functional
  input is covered. Slash menu (Heading 1/2/3, Bullet/Numbered/Task List, Code
  Block, Blockquote, Horizontal Rule, Table, Image) matches
  `apps/brief/src/extensions/slash-command.ts` exactly.
- **Story coverage:** PASS. Setup (first doc, template, folders/scope), core loop
  (publish, edit, duplicate, archive/restore, export, star), collaboration
  (co-edit real time, comments), search/reporting (Find a document), and three
  agent flows (link task, version snapshot/restore, author end-to-end) all have
  followable stories.
- **Accuracy:** PASS except for one count (see fix list). Spot-checked UI labels
  all trace to code: "Document title...", "Save Draft", "Publish", "Brief summary
  (optional)...", "Organization-wide (no project)", "Start from template", "Blank
  document", "No content yet.", "Star document"/"Remove star", "Promote to
  Beacon", "Add a comment...", "Insert table (3x3)", "Folder name", "No documents
  yet. Create your first one.", "No templates available yet." /  "Templates can
  be created by administrators.", "Type at least 2 characters to search.",
  "Showing docs for:" / "Showing all org documents", "Load more". Bolt events
  (document.created/updated/published/promoted, source `brief`) verified in
  `document.service.ts` + `event-catalog.ts`. `?` help-key binding verified.
- **Conventions:** PASS. No em dashes and no en dashes (verified U+2014 / U+2013
  scan). Screenshots: all 6 referenced files exist under both
  `docs/apps/brief/screenshots/light/` and `.../dark/`.

## Critical "must be documented as broken" items - all correctly handled

1. **"Public" visibility (invalid):** Correctly flagged in 4 places (Overview line
   41-46, Key concepts, Set visibility line 215-218, Story step "Do not choose
   Public"). Code confirms: editor lists Public (`document-editor.tsx:28`) but
   backend enum is only `private|project|organization`
   (`brief-documents.ts:30-34`). Doc tells users to avoid it and explains the
   validation error. GOOD.
2. **Always-0 "Recently Updated" stat:** Correctly flagged (line 108-110). Code
   confirms `home.tsx:27` reads `stats.recent`, which `getStats`
   (`document.service.ts:621-627`) never returns. GOOD.
3. **Non-persisted summary / version / published:** Correctly flagged. "Brief
   summary" input documented as dropped on save (line 195-200); Version button
   "vundefined" and absent Published row documented (line 296-299). Code confirms
   `v{doc.version}` renders with no backing column (`document-detail.tsx:293`) and
   Published is gated on `doc.published_at` which is never set (line 271). GOOD.
4. **Collaborator / link UI as API-only:** Correctly flagged. Linked Items
   documented as read-only with no create button (line 391-399); collaborators
   documented as API/MCP-only with no share dialog (line 485-490). Code confirms
   no collaborator UI in `apps/brief/src` and no MCP tool; link creation is
   tool/API only. GOOD.

---

## Fix list (numbered, concrete)

1. **File `docs/apps/brief/help.md`, section "Working with AI agents", line 440.**
   - Wrong: "Brief exposes 17 MCP tools."
   - Correct: Brief registers **18** MCP tools. `apps/mcp-server/src/tools/brief-tools.ts`
     has 18 `registerTool(...)` calls: brief_list, brief_get, brief_create,
     brief_update, brief_update_content, brief_append_content, brief_archive,
     brief_restore, brief_duplicate, brief_search, brief_comment_list,
     brief_comment_add, brief_comment_resolve, brief_versions, brief_version_get,
     brief_version_restore, brief_promote_to_beacon, brief_link_task.
   - Change "17" to "18". (Note: the dossier `§5` also states "17 tools" while
     listing all 18 by name; the dossier is the source of the miscount but the
     help.md is what ships. The tool-by-name coverage in the doc body is already
     complete - only the prose number is wrong.)

---

## Accuracy findings (claims that did not trace cleanly to code)

- **MCP tool count (17 vs 18)** - the only hard inaccuracy. Detailed in fix #1.
- No other label or feature claim failed to trace. All visibility values, status
  values (draft/in_review/approved/archived), the "In Review unreachable from UI"
  claim, the duplicate "(copy)" naming, restore-to-draft behavior, the four Bolt
  events, the `?` help key, the slash-command menu, and the search no-excerpt
  note were each confirmed against the cited code.

## Minor observations (not blocking, no fix required)

- The doc describes `brief_search` as running "the keyword search" and does not
  repeat the tool's own "semantic similarity" overclaim (dossier discrepancy #4).
  This is the correct call - the doc stays accurate to the text route's behavior.
- The doc's "Brief exposes ... 17 tools" is the single edit needed; everything
  else in the AI-agents section (token forwarding, read_write scope, per-tool
  descriptions, the collaborators-are-API-only note) is code-accurate.
