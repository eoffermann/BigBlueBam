# Beacon help.md - Review

Verdict: CHANGES REQUESTED

One-line rationale: The flagged code-truth items are all documented correctly, but
the doc presents two non-functional UI paths (editor Tags, PendingReview Publish)
and one non-existent UI affordance (link creation / per-article tag controls) as if
they work for human users.

Reviewed against:
- Frontend: apps/beacon/src/ (pages, components)
- Backend: apps/beacon-api/src/ (routes, services)
- MCP: apps/mcp-server/src/tools/beacon-tools.ts
- Worker: apps/worker/src/jobs/beacon-expiry-sweep.job.ts
- Dossier: docs/.help-build/beacon/dossier.md

---

## What is correct (spot-checks that passed)

- Markdown editor, not rich text. beacon-editor.tsx lines 204-217: Body is a plain
  textarea labeled "Body (Markdown)", placeholder "Write your knowledge article in
  Markdown...", font-mono, no toolbar. Doc is accurate.
- Fridge Cleanout is freshness-only. beacon-dashboard.tsx: cards are Freshness Score,
  At-Risk (7 days), Archived Backlog, Total Active, plus a Freshness Breakdown bar and
  a recent-verifications list. No view-count or search-pattern analytics. Correct.
- Restore-on-Retired is server-rejected. lifecycle-actions.tsx line 39-40 shows Restore
  for Retired; beacon.service.ts restoreBeacon lines 473-478 throws INVALID_TRANSITION
  unless status is Archived. Documented correctly.
- Expired status is unreachable. status-badge.tsx has no Expired entry; the sweep only
  does Active->PendingReview->Archived and draft deletion, never sets Expired. Accurate.
- MCP tool count = 30. Confirmed by name grep in beacon-tools.ts. Matches doc.
- Freshness states "Verified recently / Content is stale / Expiring soon / Needs
  verification" match freshness-indicator.tsx lines 36-41 exactly.
- Retire emits beacon.expired. beacon.routes.ts lines 268-283. Listed correctly.
- All 6 screenshots exist under docs/apps/beacon/screenshots/light/ (and dark):
  01-home, 02-browse, 03-detail, 04-graph, 05-dashboard, 06-search.
- No em dashes in help.md.
- Template complete; stories cover setup, core loop, search/reporting, collaboration,
  and an agent flow. Sidebar labels, home stat-card nav, lifecycle dialog text,
  search/graph/dashboard labels all verified against code.

---

## Fix list (numbered, concrete)

1. Editor tags are silently dropped on create and edit (broken feature, documented as
   working).
   - File/section: help.md -> Feature reference "Create and edit an article" (step 6),
     "Tags" section, and "Story: Write and publish your first article" (step 6).
   - What is wrong: The doc tells users to add tags via the editor "Tags
     (comma-separated)" field. beacon-editor.tsx sends tags in the create/update
     payload, but beacon.service.ts createBeacon (lines 145-186) and updateBeacon
     (lines 375-415) never read or persist data.tags, and the POST/PUT /beacons routes
     call no tag-insert helper. Tags entered in the editor do not persist. The only
     working tag-write path is POST/DELETE /beacons/:id/tags (and beacon_tag_add /
     beacon_tag_remove MCP tools), which have no human UI.
   - What it should be: Flag for a code fix wiring editor tags into create/update; until
     fixed, the doc must not claim the editor field persists tags. Reword to state that
     tags cannot be set through the human UI today and are only writable via the API /
     agent tools, or remove the editor-tag instructions.

2. "Tags" feature section invents a non-existent per-article tag UI control.
   - File/section: help.md -> Feature reference "Tags".
   - What is wrong: "or add and remove tags through the article tag controls" and the
     "add 1 to 20 tags ... removing a tag that is not present returns an error" details
     describe POST/DELETE /beacons/:id/tags behavior. No such UI exists: the detail page
     (beacon-detail.tsx lines 92-96, 170-176) only displays tags read-only; the
     addTag/removeTag symbols belong to the search QueryBuilder filter chips.
   - What it should be: Drop the "article tag controls" clause. Present the 1-20 tag /
     1-128 char rules and the remove-error as API/agent-tool behavior, not human UI.

3. Link creation is described as a human UI action, but no such UI exists.
   - File/section: help.md -> Feature reference "Links between articles" and
     "Story: Link related articles" (step 2).
   - What is wrong: Both instruct the user to "create a link, choosing a target article
     and a link type" from the detail page or graph. Grep of apps/beacon/src shows no
     link-creation hook, mutation, form, or button; beacon-detail.tsx only renders a
     read-only "Linked Beacons" list (lines 186-197) and the graph only draws existing
     edges. Link creation exists solely via POST /beacons/:id/links and beacon_link_create.
   - What it should be: State that creating/removing links is done via the API or an
     agent (beacon_link_create / beacon_link_remove), and the human UI only displays
     existing links. Reframe the story as agent-driven or flag the missing UI.

4. PendingReview "Publish" button errors, but the doc presents it as functional.
   - File/section: help.md -> Feature reference "Lifecycle actions" ("Pending Review
     shows Publish and Retire").
   - What is wrong: lifecycle-actions.tsx line 35 shows Publish for PendingReview, but
     beacon.service.ts publishBeacon lines 442-447 throws INVALID_TRANSITION for any
     status other than Draft. Clicking Publish on a PendingReview beacon errors and the
     status does not change. The doc flags the analogous Restore-on-Retired case but
     leaves this one looking functional.
   - What it should be: Add a parallel known-limitation note: the Publish button on a
     Pending Review beacon returns an error because the publish endpoint only accepts
     Draft. The only route back to Active from PendingReview is Verify. (And/or flag the
     broken button for a fix.)

5. Agent Activity "version" label is actually a verification count.
   - File/section: help.md -> Feature reference "Fridge Cleanout" (Agent Activity bullet)
     and "Story: Keep knowledge fresh" Related note.
   - What is wrong: Doc says each Agent Activity row shows "the version and current
     status." beacon-dashboard.tsx lines 583-585 render v{verification_count} - a
     verification count prefixed with "v", not the article version number.
   - What it should be: Change "the version" to "the verification count" (rendered as vN).

---

## Accuracy findings (labels/claims that did not trace to code)

- "Add and remove tags through the article tag controls": no UI exists (fix 2).
- "Create a link ... from detail/graph": no link-creation UI exists (fix 3).
- Editor "Tags (comma-separated)" persisting on create/edit: not wired; dropped (fix 1).
- "Pending Review shows Publish": button exists but endpoint rejects non-Draft (fix 4).
- Agent Activity "version": it is the verification count, not the version (fix 5).

All other labels, counts, routes, dialog strings, and screenshot references traced
cleanly to code.
