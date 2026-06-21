# Bureau help.md - Review

Reviewed: `docs/apps/bureau/help.md` against `apps/bureau-api/src`,
`apps/bureau/src`, `packages/bureau-client/src`,
`apps/mcp-server/src/tools/bureau-tools.ts`, the worker `bureau-*` jobs, and
`apps/bureau-api/src/lib/bureau-events.ts`. Skill checklist:
`.claude/skills/help-doc-authoring/SKILL.md`.

## Verdict

**APPROVED** (with one minor, non-blocking note below).

One-line rationale: every template section is present and filled, all UI
labels and the 17-tool count trace to code, all four required story types are
covered, and the three sensitive accuracy items (stub tools, set_status enum
mismatch, no-org-settings-UI / free_walk read-only) are flagged truthfully; the
only gap is one unnamed docked-box control button, which does not block.

## What was verified true

- **MCP tools (17):** exactly 17 `registerTool(...)` calls in
  `bureau-tools.ts`. The three stubs (`bureau_locate_user`,
  `bureau_get_presence`, `bureau_set_status`) are flagged truthfully in both
  the Working-with-AI-agents section and the Related footer. The three
  `confirm_action` tools (`bureau_summon`, `bureau_book_room`,
  `bureau_cancel_booking`) match the code.
- **set_status enum mismatch:** flagged accurately. The tool's Zod enum is
  `['active','dnd','away']` (`bureau-tools.ts:269`); the canonical WS status
  enum is `available|busy|dnd|focus|away|in_meeting`
  (`ws.routes.ts:132-139`). The doc calls out that `active` is not a real
  status value (help.md lines 213, 312).
- **No org-settings UI / free_walk read-only:** truthful. `PATCH /settings`
  accepts `continuous_audio, allow_auto_follow, default_office_privacy,
  members_can_book, members_can_create_rooms` and NOT `free_walk`
  (`settings.routes.ts:19-25`); no settings page renders in `apps/bureau/src`.
- **Screenshots:** none exist on disk (`docs/apps/bureau/` holds only
  `help.md`); the doc references none and states the visual walkthrough is not
  yet available (help.md line 46). Correct, not a defect.
- **Conventions:** zero em dashes and zero en dashes in the body. Counts
  (8 room types, 6 statuses, 3 door states, 8 Bolt events, 17 tools) all match
  code.
- **UI labels** (every one traced to source): sidebar "Bureau" / "All floors" /
  "Recent chats" / "Edit floors" / "Offices"; "Floors" landing + subtitle +
  "Default" pill + "No floors yet" empty state; floor-view "Live" chip +
  "Leave room"; "Recent chats" + retention options ("24 hours (default)",
  "2 days", "3 days", "1 week (max)", "Retain permanently"); "Admin Floors"
  ("Admin · Floors", "New floor", "Live floors (n)", "Archived (n)", "Edit",
  "Preview as member", "Archive", "Restore", "Create + open editor",
  "e.g. Engineering 3F"); floor editor ("Select" / "New room" / "New office",
  "Save", "{n} zones · WxH", empty-canvas hint, inspector "Door default" +
  helper, "(unlimited)", "Allow reservations via Book", "Choose owner...",
  "Geometry (world units)", "Zone id", "Remove zone", "Live occupants are
  evicted to the lobby"); offices ("Admin · Offices", "Floor / Office",
  "Owner", "Unassigned", "Actions", "Reassign owner", "Reassign {office}",
  "Search name or email...", "Current"); docked box ("Bureau", "CHAT" +
  tooltip "Open room chat (ephemeral - 24h)", "DND" + tooltip "Go head-down:
  block invites and hunts (DND)", "In:", "No room", "Just you", "(A) " agent
  prefix, "Viewing:", "Bring everyone here", "Invite...", "Hunt...",
  mic/`mic on`, cam/`cam on`, screen/`share`); knock toast ("Let in", "Not
  now", "Decline"); summon toast ("Join", "Stay here").
- **Behavior claims:** knock 30s auto-timeout, `OWNER_DND` 423 + leave-a-note,
  "[Bureau knock note] " DM prefix (`knocks.routes.ts:66`), summon "must be in
  a room" 400, Force Invite admin-gated 3s cancellable auto-navigate
  (`ring.routes.ts:89-90,136,196`), floor-view 4-column auto-grid
  (`floor-view.tsx` autoLayout COLS=4) all confirmed.
- **Bolt events:** all 8 listed (`user.entered_room`, `user.left_room`,
  `status.changed`, `knock.requested`, `knock.resolved`, `room.booked`,
  `room.locked`, `summon.issued`) genuinely emit in live code
  (`ws.routes.ts:787,935`, `summon.service.ts:479`,
  `worker/.../bureau-booking-lifecycle.ts:188`). This resolves dossier
  discrepancy #7 in the doc's favor: the doc only asserts these on the
  `bureau` source, which is accurate.
- **Stories:** setup (Build a floor / Drop into the office), core loop (Knock,
  Bring everyone here, Invite, Hunt), collaboration (Bring everyone here,
  Recover what was said), reporting/recovery (Recent chats), and an agent flow
  (Agent staffs a room and pulls humans in) are all present and followable.

## Accuracy findings (label/claim that did not trace to code)

None. Every UI label and feature claim spot-checked traced to a route,
component, MCP tool, or worker job.

## Minor note (non-blocking, optional fix)

1. **Docked box - missing "door" control button.**
   - File/section: `docs/apps/bureau/help.md`, section "The cross-app docked
     box (audio huddles, mic, cam, screen)" (the call-strip controls bullet
     list, help.md lines 233-238).
   - What is missing: the controls row in the docked box renders a FOURTH
     button labeled **"door"** (title "Toggle door privacy"), enabled only
     while you are in a room, that flips the current room's live privacy
     override between Private and Open via `setDoor`
     (`packages/bureau-client/src/index.tsx:1775-1788`). The doc lists
     mic/cam/screen but never names this button.
   - Why it is only a note, not a blocker: the doc does correctly state at
     lines 195 and 211 that live lock/DND overrides are driven "through the
     docked box and the real-time connection," so the capability is described;
     only the specific one-click control is unnamed. The skill requires every
     user-facing action to have how-to steps, so naming it would close the gap.
   - Suggested fix: add a bullet to the call-strip controls list, e.g.
     "The **door** button (enabled when you are in a room) toggles the current
     room's live privacy between Private and Open. This is the live override
     that sits on top of the room's durable Door default."

## Fix count

1 (the optional docked-box "door" button note above). Verdict is APPROVED;
the item does not require changes before acceptance.
