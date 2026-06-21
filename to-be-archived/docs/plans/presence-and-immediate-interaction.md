# Presence + Immediate Interaction — Per-App Review

**Date:** 2026-06-10
**Scope:** Holistic review of every content surface in the suite against the BigBlueBam "Work OS" goal — when you and someone else are in the same space (a Banter channel, a Brief doc, a Board canvas, a Blueprint diagram, a Bond deal, a Bam task, a Beacon article, a Helpdesk ticket), you should be able to *immediately* interact with them, the way bumping into a coworker in a physical office produces a conversation.

This review was written while Bureau workstreams 8-11 were running in the background, so it deliberately complements the Bureau work rather than restating it. Bureau is the *floor* of the office — this memo is about whether the *rooms in the building* feel alive too.

---

## Quick verdict

| App | Surface | See who's here? | Immediate interaction? | Audio room exists? | Verdict |
|---|---|---|---|---|---|
| **Banter** | channel / DM | ✅ presence dots, typing indicator | ✅ DM, huddle, voice, video, "invite agent" | ✅ banter calls / huddles | ★★★★★ The reference point. |
| **Board** | canvas | ✅ live cursors + peer count | ✅ huddle audio in the toolbar (continuous via `?lkRoom=` from Bureau) | ✅ `board-{boardId}` LiveKit room | ★★★★ Solid. |
| **Brief** | doc | ✅ Tiptap CollaborationCursor (awareness on Yjs) | ❌ no native call control; widget only mounts for Bureau summon hand-offs | ⚠ only the `bureau-room-*` stub from P-6 | ★★★ Cursors yes, voice no. |
| **Blueprint** | diagram | ❌ no presence visualization despite a WS sync layer for the graph | ❌ no calling | ❌ none | ★ Silent. |
| **Bond** | deal / contact / company | ❌ | ❌ | ❌ | ★ Silent. |
| **Beacon** | article / graph | ❌ | ❌ | ❌ | ★ Silent. |
| **Bam** | task / project | ❌ assignees are listed but you can't see who's *currently* looking | ❌ no "ping this assignee from here" | ❌ | ★ Silent. |
| **Helpdesk** | ticket | ❌ no presence on a ticket even when two agents are looking at it | ❌ no internal call from the ticket | ❌ | ★ Silent. |
| **Bench / Bill / Blast / Blank / Bolt / Bearing / Book** | dashboards, forms, etc. | ❌ (largely n/a — these are mostly solo surfaces) | ❌ | ❌ | n/a — out of scope for "co-presence" |

**Six of the eight collaborative surfaces are silent.** Two people opening the same Brief doc, Blueprint diagram, Bond deal, Bam task, Beacon article, or Helpdesk ticket today *do not see each other and cannot interact without leaving the surface*. Bureau will improve this dramatically — but only when the user is *also in a Bureau room*. The "I happened to open the same doc as you, hi" path needs its own primitive.

---

## What "immediate interaction" actually requires

Four primitives, applicable to every co-presence-capable surface:

1. **Per-surface presence chip strip** — a tiny avatar row, top-right of the surface, showing every user currently viewing this same entity (boardId / docId / diagramId / dealId / taskId / articleId / ticketId). Source of truth: the bureau-api WS `location_update` events already track which user is looking at which URL. Bureau just doesn't expose that as a query yet — `GET /bureau/api/v1/presence/here?url=...` would do it.

2. **Hover → "Ping" affordance** — clicking an avatar in that strip opens a small popover with two actions: "Send DM" (creates a Banter DM with a `[Looking at: <surface>]` prefix) and "Ring for huddle" (which is the next primitive).

3. **Surface-scoped huddle** — a "Start huddle" button that mints a LiveKit token for a deterministic room name keyed to the surface. `huddle-board-{id}`, `huddle-brief-{id}`, `huddle-blueprint-{id}`, `huddle-bond-deal-{id}`, etc. The recipient gets a ring (the existing `incoming-call-overlay.tsx` from Banter, ported to a shared package). Anyone on the surface can answer; multiple people in a surface huddle land in the same LiveKit room. Continuous audio via Bureau's `?lkRoom=` hint when relevant.

4. **DND respect** — DND'd users still appear in the chip (you can see they're around) but the "Ring" affordance becomes "Leave a note" — exactly the same primitive Bureau §4.3 uses for the office knock.

The shipped Bureau pieces give us most of the back-end already:

- Bureau's `dnd-check.service.ts` already does the DND check by reading session statuses.
- Bureau's `presence.service.ts` already has `getRoomOccupants(redis, roomId)`.
- Bureau's `cross-app-access.service.ts` already has the visibility-aware filter we'd need to gate "who's here" by the asker's own access rights.

The missing piece for non-Bureau surfaces is a tiny `GET /v1/presence/here?url=<canonical>` endpoint on bureau-api that returns the access-filtered list of userIds who reported `location_update` with that URL. Then every SPA's `@bigbluebam/bureau-client` hook can query it and render the chip strip.

---

## Per-app gaps and proposed fixes

### Brief (highest leverage)
Brief already has CollaborationCursor (you see other people's *text* cursors via Yjs awareness), so the presence layer is *almost there*. What's missing is:
- A top-right avatar strip — Tiptap awareness already publishes display name + color per user; render that as `<UserChipStrip>`.
- A "Start huddle on this doc" button next to the existing `ContinuousAudioWidget`. The widget already accepts a LiveKit room name; the button just mints `huddle-brief-{docId}` instead of waiting for a Bureau summon.

**Lift:** ~2 days. Tiptap awareness is already the source of truth — we just surface it visually and add a one-button audio path. The audio token endpoint already exists from P-6.

### Blueprint
Blueprint has a WS sync layer for diagram changes but doesn't propagate presence. The diagram editor is one of the highest-value collaboration surfaces in the suite ("let's whiteboard this together") and currently it's completely silent.

**Lift:** ~3 days. Add a `presence.update` WS message to blueprint-api's hub, render the chip strip on the diagram canvas, and ship the surface-scoped huddle (room name `huddle-blueprint-{diagramId}`).

### Bond / Bam / Beacon / Helpdesk (the lighter group)
These surfaces show *one entity at a time* and don't have a Yjs-style sync layer, so presence requires only a single WS subscription. The Bureau internal `location_update` stream covers it. UX:
- Avatar strip in the entity header.
- "Start huddle" pops a LiveKit room scoped to the entity.
- "DM about this" pre-fills a Banter message with the deep link to the entity.

For Bam specifically: the right-click context menu on task cards already has the scaffolding for surface actions (commit b474918) — adding "Ping assignee" / "Start huddle on this task" fits the same menu.

For Helpdesk: a "currently being viewed by Brian" badge on a ticket prevents two agents from accidentally double-responding to the same customer — a real workflow win.

**Lift per app:** ~1.5 days each (~6 days total).

### Board
Board is the closest to the bar — has live cursors, audio, peer count. One remaining gap: **the peer count is a number, not faces.** Show the avatars so a user knows *who* they're sharing the canvas with at a glance. Same Bureau-style chip strip works.

**Lift:** ~0.5 day. Wire the existing peer list (from `useBoardSync`) to a chip strip in the toolbar.

### Banter
Already at the bar. One small follow-up applies the same primitive elsewhere: the `incoming-call-overlay.tsx` is UI-only with no signaling layer (workstream 5 audit B-3). When we ship the surface-scoped huddle ring, we get this for free — fix once, every app benefits.

---

## Sequencing recommendation

If we want the suite to *feel present* by end of feature-bureau (or shortly after):

1. **First** (~1 day): bureau-api `GET /v1/presence/here?url=<canonical>` + the cross-app `location_update` ingest is already running. Add the query route.
2. **Next** (~1 day): shared `@bigbluebam/ui/presence-chip-strip` React component that takes a canonical URL and renders the chip strip with the "Ping" popover. Mount it in B3's board.tsx, brief's document-editor.tsx, blueprint's editor.tsx, bond's deal-detail.tsx, bam's task-card / task-detail-drawer.tsx, beacon's article-view.tsx, helpdesk's ticket-detail.tsx.
3. **Then** (~2 days): surface-scoped huddle button. Mint LiveKit tokens for `huddle-<app>-<id>` rooms via a new shared endpoint (could live in bureau-api since it already mints `bureau-room-*` tokens and has the LiveKit helpers). Wire the ring (port `incoming-call-overlay.tsx` to a shared package).
4. **Finally** (~2 days): Brief native call panel (audit doc D-3) and Blueprint native call panel — once the surface-scoped huddle primitive exists, these become small wrappers around it.

**Total: ~6 days of focused work** for an entirely different feel across the suite. Every app gets the same "I can see who's here and call them right now" affordance, the existing Bureau infrastructure (presence stream, LiveKit minting, DND check, access filter) is reused, and nothing is per-app reinvention.

---

## Bureau composition

Bureau's spatial floor is the *orchestrator* of presence across the suite (where am I, who's around, can I summon them). Surface-level presence is the *grain*: who's specifically looking at this thing right now. The two complement each other:

- Walk into the War Room in Bureau → you see Eddie and Teeny via the floor view.
- Eddie navigates to a Brief doc; Teeny is still in the War Room → Bureau says Eddie is "viewing Q3 Roadmap (Brief)."
- Sam happens to open the same Brief doc directly, not via Bureau → Eddie sees Sam in the Brief presence chip strip *and* Bureau says nothing changed (Sam isn't in the War Room).
- Eddie clicks Sam's chip → "Ring for huddle" → Sam gets the ring, they talk inside the doc.

Bureau gives you the *building map*. The presence chip strip gives you the *room you're in right now*. Both are needed for the suite to feel like a place where you can work together by accident.

---

## What's already partially built

While reviewing the codebase I noticed several pieces of this puzzle already exist and could be lifted into the shared primitives:

- `apps/banter/src/components/calls/incoming-call-overlay.tsx` — the ring UI exists, just unwired. Move to `packages/ui/incoming-call-overlay.tsx` and the ring is shared.
- `apps/board/src/hooks/use-board-sync.ts` — already tracks `peerCount`. Generalize the WS topic so other surfaces can subscribe (current code is canvas-specific).
- `apps/brief/src/hooks/use-collaboration.ts` — Yjs awareness already publishes display name + color. Map to the same `BureauOccupant` shape the `@bigbluebam/bureau-client` SDK uses and the chip strip rendering is identical across apps.
- `packages/bureau-client/src/index.tsx` — `BureauProvider` + `useBureauPresence()` could absorb the surface-presence query and serve as the single source of "who is in my immediate vicinity" across the suite.

The "Work OS feels present" outcome is closer than it appears. Most of the back-end is shipped or shipping; the missing piece is one shared UI primitive and one shared bureau-api query route, threaded into eight surfaces.
