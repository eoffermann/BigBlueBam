# Synchronous Presence Rollout, App by App

Expanded companion to `full-suite-synchronous-editing-plan.md`. That plan defines
the tier model and the suite-wide strategy; this document goes app by app: what is
done today, what remains, and a recommendation with rationale for each. The point
is not to push every app to the top tier. The point is to put each surface on the
rung it actually earns, and to stop silent data loss where it is real.

State refreshed against the code on 2026-06-20 (the original survey was
2026-06-12, and presence chips have reached more apps since).

## How to read this

Two different things often get bundled under "presence." Keep them separate:

1. **The ambient Bureau dock** (`mountBureauClient`) is already in all 16 apps.
   From anywhere you can see who is around and ring, knock, or huddle. This is
   done and is not what this document tracks.
2. **Per-record synchronous collaboration** is the ladder below, scoped to a
   specific task / deal / document / record. This is what is partial.

The tiers (from the parent plan):

| Tier | A second person on the same record gets |
|------|------------------------------------------|
| T0 | nothing until they refresh (static REST) |
| T1 | the record updates live (broadcast then refetch) |
| T2 | T1 plus a presence chip: who else is here |
| T3 | T2 plus awareness: their cursors, selections, typing |
| T4 | T3 plus concurrent edits merge instead of conflicting (CRDT) |

Guiding opinions applied throughout:

- **T4 only where prose or a canvas is the product.** A CRDT on a form is
  engineering theater: cost without a real collision to solve.
- **A presence chip (T2) is cheap and almost always worth it.** It answers "am I
  about to trample someone" and the component already ships in `@bigbluebam/ui`.
- **Silent last-write-wins on multi-paragraph text is data loss.** That earns
  either a CRDT (if the surface deserves one) or a 409 stale-write guard with a
  reload/overwrite affordance (if it does not).
- **Do not add live-update plumbing to a surface two people never co-occupy.**
  It is socket fan-out and failure modes for no user.

## Current state at a glance

| App | Top tier today | Presence chip | Reports location | The honest gap |
|-----|----------------|---------------|------------------|----------------|
| Brief | T4 | yes | yes | none material |
| Board | T3/T4 | yes | no | none material |
| Banter | T2/T3 | n/a (chat) | no | none material |
| Helpdesk | T1/T3 | yes | no | agent-note stale guard |
| Bam | T1/T2 | yes (task) | yes | description field is T0, silent LWW |
| Blueprint | T1 | yes | no | no cursor/selection awareness (T3) |
| Bond | T0 (+chip) | yes | yes | pipeline not live; detail PATCH silent LWW |
| Beacon | T0 (+chip) | yes | no | long-body editor is silent LWW |
| Bearing | T0 | no | yes | chip + stale guard |
| Bench | T0 | no | yes | chip + stale guard |
| Bolt | T0 (+versions) | no | yes | chip; versions soften loss |
| Blast | T0 | no | no | chip only |
| Book | T0 | no | no | chip only |
| Blank | T0 | no | no | chip only |
| Bill | T0 | no | no | chip only |
| Bureau | n/a (source) | n/a | n/a | it is the engine, not a consumer |

---

## Brief (documents)

**Done.** The flagship co-editing surface. Real Yjs CRDT with live cursors,
read-only viewers mounted on the same doc, and a flush that derives
`plain_text`/`html_snapshot` so search and exports stay fresh. Presence chip and
location reporting both present. This is T4 and it works (Phase 1 of the parent
plan repaired the transport).

**Remaining.** Nothing material. The shared `@bigbluebam/collab-client` package
the parent plan wants to extract should come *out of* Brief's wiring, so Brief is
the donor, not a consumer of new work.

**Recommendation.** Leave it. Do treat it as the reference implementation: when
`collab-client` is extracted, Brief should be the first to adopt the package so
the extraction is proven against a working surface before Beacon reuses it.

## Board (whiteboard)

**Done.** The suite's best realtime surface: live cursors on a dedicated
fire-and-forget channel, scene reconcile by version and nonce, stream replay on
reconnect, presence bar. Effectively T3/T4.

**Remaining.** Nothing material.

**Recommendation.** Leave it, and mine it for patterns. Its split-channel shape
(persisted mutations on one channel, ephemeral cursors on another) is the
template every T3 rollout below should copy. Do not let any future awareness work
put cursor spam on a persisted-mutation channel.

## Banter (chat)

**Done.** Real-time messages, typing indicators, presence states, read-cursor
sync. T2/T3 for what chat needs.

**Remaining.** None. Chat is append-only, so there is no edit-collision to solve
and T4 is meaningless here.

**Recommendation.** Do nothing further on the sync axis. A per-message presence
chip would be noise; the channel itself already conveys who is present.

## Helpdesk (support tickets)

**Done.** Full WS manager, room replay with a high-water mark, typing indicators
on replies, presence chip on the ticket. T1/T3.

**Remaining.** Replies are append-only and safe. The one soft spot is the
agent-facing internal note / ticket fields, which are still last-write-wins.

**Recommendation.** Add the 409 stale-write guard to the agent note and ticket
field PATCH, nothing more. Do not co-edit a ticket: two agents editing the same
note simultaneously is rare, and the guard turns the rare case from silent loss
into a visible "reload or overwrite."

## Bam (project management)

**Done.** The board is live (task created/updated/moved/deleted broadcast, store
patches in place) and the task detail carries a presence chip. Comments are live
and append-only. Location reporting present. T1/T2 on the board.

**Remaining.** The task **description** field is the gap: edits do not broadcast,
and the debounced blur PATCH is silent last-write-wins. Two people editing a
description quietly clobber each other.

**Recommendation.** Broadcast `task.updated` on description save (the plumbing
already exists for other fields) so the detail refetches, and add a 409 guard on
the description PATCH with a reload toast. Do **not** put a CRDT on it. A task
description is a few paragraphs that one person edits at a time; a 409 guard
covers the real risk for a fraction of the cost.

## Blueprint (diagrams)

**Done.** Every mutation broadcasts and clients debounce-invalidate; viewport is
independent; presence chip on the editor. T1 with a chip. This shipped recently.

**Remaining.** No awareness (T3): you cannot see which node a collaborator has
selected or where their cursor is, so two people on the same diagram still surprise
each other.

**Recommendation.** Add T3 awareness only: a cursor and "who has which node
selected" overlay on an ephemeral channel (Board's pattern). Do **not** add a
full CRDT. Blueprint mutations are atomic REST operations on distinct rows
(a node, an edge), so they do not actually conflict the way characters in a
paragraph do. Awareness gives the collaboration feel; CRDT would be cost with no
collision to merge.

## Bond (CRM)

**Done.** Presence chips on contact and deal detail; location reporting. But the
data plane is T0: field-blur PATCHes and pipeline drags are static REST with
silent last-write-wins.

**Remaining.** Two reps dragging deals on the same pipeline do not see each
other's moves live. Detail-field edits silently overwrite.

**Recommendation.** Two moves. (1) Make the **pipeline** T1 by copying the
Blueprint invalidate-refetch hub, because two reps genuinely co-occupy a pipeline
board and live drags are the high-value win. (2) Add the 409 guard to
contact/deal detail PATCHes. Do **not** co-edit a contact record; it is structured
fields, not prose.

## Beacon (knowledge base)

**Done.** Presence chip on the entry view (added since the 2026-06-12 survey).
Every save writes a `beacon_versions` row, so history exists.

**Remaining.** The entry **editor** is still pure REST with no WS, and knowledge
bodies are long markdown. Silent last-write-wins on long prose is the most likely
real data loss in the suite, and today it is only detectable after the fact (via
the versions table), never prevented.

**Recommendation.** Now: T2 chip (done) plus a 409 stale-write guard on the entry
PUT, so a collision becomes a visible reload/merge instead of a silent overwrite.
Later, and only if Beacon adopts the Brief Tiptap editor: it then inherits T4 for
nearly free through `collab-client` plus a cloned ws handler. This is the parent
plan's optional Phase 4. Rationale: Beacon is the one non-Brief surface where full
co-editing is genuinely justified, but it should ride Brief's stack rather than
grow its own, so do not build bespoke Beacon co-editing.

## Bearing (goals and OKRs)

**Done.** Location reporting. Goal detail is T0 with 15s polling; silent LWW.

**Remaining.** No presence chip; no stale guard.

**Recommendation.** Add the presence chip and a 409 guard on goal/key-result
PATCH. That is the whole job. Do not add live co-editing or even T1 broadcast:
goals are edited occasionally by one owner, and the polling already surfaces other
people's changes within 15s. The chip plus guard closes the silent-overwrite gap
at near-zero cost.

## Bench (analytics)

**Done.** Location reporting. Dashboard canvas and widget editor are T0.

**Remaining.** No presence chip; no stale guard.

**Recommendation.** Add the presence chip on the dashboard editor and a 409 guard
on dashboard/widget save. Do **not** pursue co-editing a dashboard layout: two
people rearranging the same dashboard at the same instant is rare, and the chip
makes it visible. Note that "live data in widgets" is a *data refresh* concern,
not collaboration sync, and should not be conflated with this ladder.

## Bolt (automation)

**Done.** Location reporting and a version history with restore. The automation
editor itself is T0.

**Remaining.** No presence chip.

**Recommendation.** Add the presence chip; that is enough. A 409 guard is
optional here precisely because Bolt already has versioned restore, which softens
an accidental overwrite into a recoverable one. Do not co-edit an automation: a
rule is a single-author artifact, and the graph is atomic. The chip is the "is
someone else in this rule" signal; versions are the safety net.

## Blast (email campaigns)

**Done.** Nothing on this axis. Template editor is T0 with explicit save.

**Remaining.** No presence chip.

**Recommendation.** Presence chip only. A campaign or template is authored by one
person and shipped; there is no co-authoring workflow to support. The chip
prevents two marketers unknowingly editing the same draft. No T1, no co-editing.

## Book (scheduling)

**Done.** Nothing on this axis. Booking-page and event editors are T0.

**Remaining.** No presence chip.

**Recommendation.** Presence chip only, and frankly this is the lowest priority of
the set: booking pages are configured rarely and almost never by two people at
once. Add the chip when the page is next touched; do not schedule dedicated work
for it. (Note: Book events can carry a LiveKit room for the *scheduled meeting*
itself, which is a real feature but is not the ambient pervasive-presence layer.)

## Blank (forms)

**Done.** Nothing on this axis. Form builder is T0 with explicit save.

**Remaining.** No presence chip.

**Recommendation.** Presence chip only. A form is built by one author. Same
reasoning as Blast: the chip is the cheap "someone else is in here" guard; nothing
above T2 is warranted.

## Bill (invoicing)

**Done.** Nothing on this axis. Invoice/expense editors are T0, draft-only edits,
explicit save.

**Remaining.** No presence chip.

**Recommendation.** Presence chip only. Invoices are single-author financial
records; co-editing would be actively undesirable (you do not want two people
mutating the same invoice's line items concurrently). If anything, a 409 guard is
the more valuable add here than presence, to prevent two people overwriting an
invoice draft. No co-editing, ever.

## Bureau (virtual office)

**Done.** Bureau is not a consumer surface on this ladder; it is the **source** of
the presence layer the rest of the suite reads. Live floors, rooms, and the dock
that `mountBureauClient` mounts everywhere.

**Remaining / Recommendation.** Keep it the single source of presence and location.
The one thing to guard against is any app reinventing presence locally instead of
reading Bureau. Every T2 chip rollout below should resolve "who is here" through
Bureau, not a new per-app presence store.

---

## What the remaining work actually is

Stripped of the top-tier ambition, the realistic backlog is small and cheap:

1. **Presence chips (T2) on the seven apps that lack them:** Bearing, Bench, Bolt,
   Blast, Book, Blank, Bill. The component already ships; this is header wiring,
   done opportunistically "as each app is touched" rather than as a project.
2. **The 409 stale-write guard** (one shared Zod fragment + one TanStack helper)
   applied where multi-field or long-text editing is silent LWW: Bam description,
   Beacon entry, Bond/Bearing/Bench detail PATCHes, Bill drafts. This is the
   single highest-value item because it converts silent data loss into a visible
   choice across the whole suite.
3. **T1 where two people co-occupy:** Bond pipeline (copy Blueprint's hub). That
   is the main net-new live-update surface worth building.
4. **T3 awareness on Blueprint** (cursor + selection overlay), reusing Board's
   ephemeral channel.
5. **T4 only if Beacon adopts the Brief editor** (optional, largest). Otherwise no
   new co-editing surfaces.

## What we should explicitly NOT do

- No CRDT on forms, invoices, automations, goals, dashboards, or task
  descriptions. The collision those would solve does not happen often enough to
  justify the cost, and a 409 guard covers the rare case.
- No live-update plumbing on single-author operational surfaces (Bill, Blank,
  Blast, Book). Presence chip is the ceiling.
- No per-app presence store. Everything resolves through Bureau.
- No treating "live widget data" or "scheduled-meeting rooms" as part of this
  ladder; they are separate concerns.

## Suggested order

1. Ship the 409 stale-write guard convention and apply it to Beacon and Bam
   description first (highest data-loss risk). One shared helper unlocks the rest.
2. Roll presence chips to the seven remaining apps as a cheap sweep.
3. Build Bond pipeline T1.
4. Add Blueprint T3 awareness.
5. Decide Beacon T4 (adopt Brief editor) as a separate, deliberate call.
