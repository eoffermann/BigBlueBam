# Full-Suite Synchronous Editing Plan

**Date:** 2026-06-12
**Status:** Phase 1 (Brief repair) implemented same-day; later phases awaiting review
**Prompted by:** "Is Brief entirely interactive yet? If two people have the same
document open, do we see each other's text cursors and updates in realtime?"

---

## 0. The answer to the question that started this

**No — but not for the reason you'd guess.** Brief has a complete CRDT
collaboration stack already built in (Yjs documents, Tiptap
`Collaboration` + `CollaborationCursor` extensions, a y-protocols sync +
awareness WebSocket handler in brief-api, Redis fan-out across instances,
debounced binary persistence to `brief_documents.yjs_state`). It has simply
**never connected**, because the client and server disagree about the URL:

- The client (`apps/brief/src/hooks/use-collaboration.ts`) uses the stock
  `y-websocket` provider, which appends the room name to the **path**:
  `wss://host/brief/ws/<docId>`.
- The server (`apps/brief-api/src/ws/handler.ts:219`) registers exactly
  `GET /ws` and reads the doc id from the **query string** (`?doc=<id>`),
  closing 4002 if missing.

Live probe against the running stack (2026-06-12):

```
wss://localhost/brief/ws?doc=<uuid>   → upgrade OK, close 4001 "Authentication required"  (route exists)
wss://localhost/brief/ws/<uuid>       → HTTP 404 on upgrade                               (what the client actually sends)
```

Every collaboration connection attempt 404s and silently retries forever.
Each open editor is a local island: the Tiptap editor binds to a local-only
Y.Doc, content is seeded from a markdown roundtrip, and changes only move
between users via the explicit **Save Draft / Publish** buttons plus a page
refresh. No cursors, no live text, no awareness.

Three secondary defects compound it (all fixed in Phase 1):

1. **Provider never reaches the editor on first render.**
   `useCollaboration` returns `provider: providerRef.current` — a ref set
   inside an effect, which does not trigger a re-render. The editor is
   created with `provider = null`, so `CollaborationCursor` is never
   configured until some unrelated state update happens to re-render the
   page (and then the editor is torn down and rebuilt mid-session).
2. **A content-stomp effect.** `document-editor.tsx` had
   `if (editor.getHTML() !== initialContent) editor.commands.setContent(initialContent)`
   with no collab-mode guard. With a working transport this rewrites the
   *shared* Yjs document with a markdown roundtrip on every editor rebuild —
   the classic Yjs duplicate/clobber bug. (Ironically it's also the only
   reason the editor showed content at all while the transport was dead.)
3. **The viewer is static.** `document-detail.tsx` renders
   `html_snapshot` / markdown via `dangerouslySetInnerHTML`. A reader looking
   at a doc someone is editing sees nothing until the editor explicitly
   saves *and* the reader refreshes. Additionally the 30-second Yjs flush
   persists **only** the binary `yjs_state` — it never re-derives
   `plain_text`/`html_snapshot`, so search, exports, embeds, and the viewer
   all go stale even while the CRDT state is current.

---

## 1. A shared vocabulary: sync tiers

Every surface in the suite lands on one of these rungs. "More synchronized"
is not automatically better — each rung has real cost (server state, socket
fan-out, failure modes, UX complexity) and the right target depends on how
often two humans genuinely co-occupy the surface.

| Tier | Name | What a second person sees | Infrastructure |
|------|------|---------------------------|----------------|
| T0 | Static REST | Nothing until they refresh | none |
| T1 | Event-refresh | The *document/list updates* live (invalidate → refetch) | WS hub + Redis PubSub per entity |
| T2 | Presence | T1 + *who is here* (avatar chips, viewing/editing) | Bureau presence (already cross-app) |
| T3 | Awareness | T2 + *where they are* — cursors, selections, drags, typing | ephemeral PubSub channel (never persisted) |
| T4 | Co-editing | T3 + *concurrent edits merge* instead of conflicting | CRDT (Yjs) or server-authoritative reconciliation |

Two suite-wide primitives already exist and should be leaned on rather than
reinvented:

- **Bureau presence** (`bureau-api` + `PresenceChipStrip`) answers "who is
  on this URL/surface" for every app — that's T2 nearly for free anywhere.
- **Board's split-channel pattern** (`board:events` persisted mutations vs
  `board:cursors` fire-and-forget) is the proven shape for T3: ephemeral
  awareness traffic must never share a channel with persisted mutations.

## 2. Current state, app by app (surveyed 2026-06-12)

| App | Surface | Today | Conflict model | Evidence |
|-----|---------|-------|----------------|----------|
| **Brief** | Document editor | **T4 built, transport broken** (this plan, §0) | Yjs CRDT (once connected); DB flush is LWW snapshot | `apps/brief-api/src/ws/handler.ts`, `apps/brief/src/hooks/use-collaboration.ts` |
| **Board** | Whiteboard canvas | **T3/T4 working** — live cursors (20/s throttle), scene reconcile by version+nonce, stream replay on reconnect | Element-version LWW, server-authoritative | `apps/board-api/src/ws/handler.ts`, `apps/board/src/lib/scene-sync.ts` |
| **Banter** | Chat | **T2/T3 working** — message events, typing indicators, presence states, read-cursor sync | Append-only; N/A | `apps/banter-api/src/ws/handler.ts`, `services/realtime.ts` |
| **Blueprint** | Diagram editor | **T1 working** (shipped this week): every mutation broadcasts, clients debounce-invalidate; viewport independent | Server-authoritative REST, last request wins | `apps/blueprint-api/src/routes/ws.routes.ts`, `apps/blueprint/src/hooks/use-diagram-sync.ts` |
| **Bam** | Kanban board | **T1/T2 working** — task.created/updated/moved/deleted events, board store patches in place; presence chips on task detail | LWW, no stale check | `apps/api/src/plugins/websocket.ts`, `apps/frontend/src/hooks/use-realtime.ts` |
| **Bam** | Task detail (description) | **T0/T1 partial** — comments live, *description edits don't broadcast*; debounced blur PATCH | Silent LWW | `task-detail-drawer.tsx` (1s debounce) |
| **Helpdesk** | Ticket workspace | **T1/T3 working** — full WS manager, room replay (HB-47 high-water mark), typing indicators on replies | Event-sourced `ticket_events` | `apps/helpdesk-api/src/ws/handler.ts`, `apps/helpdesk/src/lib/websocket.ts` |
| **Beacon** | Knowledge entry editor | **T0** — pure REST form, no WS at all; every update writes a `beacon_versions` row | Silent LWW (conflict detectable retroactively, never prevented) | `apps/beacon/src/pages/beacon-editor.tsx`, `beacon-versions.ts` |
| **Bond** | Contact/deal detail, pipeline | **T0** (+ presence chips on details) — field-blur PATCHes, drag PATCHes | Silent LWW | `apps/bond/src/pages/*.tsx` |
| **Bench** | Dashboard canvas, widget editor | **T0** | Silent LWW | `apps/bench/src/pages/dashboard-edit.tsx` |
| **Bolt** | Automation editor | **T0** + version history (restore exists) | LWW; versions auditable | `apps/bolt/src/pages/automation-editor.tsx` |
| **Bearing** | Goal detail | **T0** (15s staleTime polling) | Silent LWW | `apps/bearing/src/pages/GoalDetailPage.tsx` |
| **Blast** | Template editor | **T0**, explicit save | Silent LWW | `apps/blast/src/pages/template-editor.tsx` |
| **Book / Blank / Bill** | Page/form/invoice editors | **T0**, explicit save (Bill edits draft-only) | Silent LWW | respective `pages/` |

## 3. Could vs. should: target tier per surface

Principles:
- **T4 only where prose/canvas is the product** (Brief, Board, eventually
  Beacon). CRDT for a form is engineering theater.
- **Every detail/editor surface deserves T2** — Bureau presence chips are
  nearly free and answer "am I about to trample someone."
- **Every surface two people plausibly stare at together deserves T1** —
  the Blueprint invalidate-refetch hub is ~150 lines server + ~100 client
  and is the template.
- **Silent LWW on multi-paragraph text is data loss** and gets either a
  CRDT (if the surface earns it) or a 409 stale-check with a reload/merge
  affordance (if it doesn't).

| Surface | Target | Why / why not more |
|---------|--------|--------------------|
| Brief document | **T4** (repair, this phase) | Already built; flagship co-writing surface |
| Brief viewer | **T4 read-only** (this phase) | A reader is a participant; mount the same Yjs doc `editable: false` |
| Board | T3/T4 (done) | Already the suite's best realtime surface |
| Blueprint | **T3** (next) | Structural graph: cursors + "who has which node selected" overlay; full CRDT unnecessary — mutations are atomic REST ops on distinct rows |
| Bam task description | **T1 + 409 guard** | Broadcast `task.updated` on description save (already does for other fields); add `updated_at` stale check + "Reload" toast. CRDT unwarranted for a 2-paragraph field |
| Bam comments | T1 (done) | Append-only |
| Beacon entry | **T2 + 409 guard now; T4 candidate later** | Long markdown bodies invite real collisions; versions table already exists. If Beacon adopts the Brief editor (Tiptap), reuse the whole Brief collab stack wholesale |
| Helpdesk ticket | T1/T3 (mostly done) | Typing indicators exist; replies are append-only; agent notes could use a 409 guard |
| Bond pipeline | **T1** | Two reps dragging deals want live board moves; copy the Blueprint hub pattern |
| Bond/Bearing/Bench/Bolt detail forms | **T2 + 409 guard** | Presence chip + stale-write protection; no co-editing |
| Blast/Book/Blank/Bill editors | **T2 only** | Single-author by nature; explicit save; presence chip is enough |

## 4. Shared infrastructure to extract

1. **`@bigbluebam/collab-client`** (new package, Phase 2): the Brief
   wiring generalized — `useYjsRoom(app, entityId)` (provider lifecycle,
   reconnect, state-not-ref), deterministic cursor color hash, awareness
   helpers, "seed-once-on-first-sync" helper. Brief is the first consumer;
   Beacon's future editor the second.
2. **Awareness channel convention** (Phase 3): `\<app\>:awareness:\<entityId\>`
   Redis PubSub, never persisted, payloads ≤1KB, server relays verbatim with
   per-socket subscribe — exactly Board's cursor channel, formalized.
   Blueprint is the first adopter.
3. **Stale-write guard convention** (Phase 2, per-app rollout): PATCH/PUT
   accept optional `expected_updated_at`; mismatch → 409 with the current
   row; client toast "Changed by <name> while you edited — Reload / Overwrite".
   One Zod fragment in `@bigbluebam/shared`, one TanStack helper.
4. **Bureau presence chips everywhere** (cheap, ongoing): `PresenceChipStrip`
   already ships in `@bigbluebam/ui` and works on any URL/surface; add to
   Beacon/Bench/Bolt/Blast/Bearing detail headers as they're touched.

## 5. Phases

### Phase 1 — Brief repair (implemented with this plan)
- **B1 server:** register `GET /ws/:docId` (y-websocket's native path shape)
  alongside `GET /ws?doc=` (back-compat); shared handler.
- **B2 client:** hold the provider in React **state** so the editor is
  created with `CollaborationCursor` bound from the start; fix the
  misleading URL comment.
- **B3 page:** never `setContent` into a collab editor from the markdown
  roundtrip; instead **seed once on first sync** if and only if the synced
  Yjs fragment is empty and the document has legacy `plain_text` (migration
  path for pre-collab docs).
- **B4 flush:** derive `plain_text` + `html_snapshot` from the Y.Doc at
  flush time so search/exports/viewer stay fresh without manual saves.
- **B5 viewer:** `document-detail.tsx` mounts the collaborative editor
  read-only when the doc is open — readers see live text + cursors.
- **B6:** tests (URL shapes, seed-once guard, flush derivation), deploy
  both stacks, verify with the WS probe + two-browser session.

### Phase 2 — Stop silent text loss (review before starting)
- 409 stale-guard convention in shared + Bam task description + Beacon PUT.
- Bam: broadcast description saves; task-detail subscribes (it already has
  the event plumbing).
- Extract `@bigbluebam/collab-client` from Brief's repaired wiring.

### Phase 3 — Awareness where structure lives
- Blueprint cursors/selection overlay on the ephemeral channel (Board's
  pattern; the editor already preserves selection across refetches).
- Bond pipeline live drags (Blueprint-style invalidate hub).

### Phase 4 — Beacon co-editing (largest, optional)
- Port Beacon's editor to the shared Tiptap stack, then it inherits T4 via
  `collab-client` + a `beacon-api` ws handler cloned from Brief's (~400
  lines). Versions table already provides history.

## 6. Risks / decisions taken
- **Stay on y-websocket + hand-rolled handler** (vs Hocuspocus): the
  handler already implements sync, awareness, Redis fan-out, debounced
  persistence, and auth. Hocuspocus would be a rewrite for marginal gain;
  revisit only if we need its document-webhooks ecosystem.
- **DB flush stays LWW snapshot**: safe because instances converge via the
  Redis update fan-out before flushing; the flush lock pattern from Board
  can be added if flush contention ever shows in logs.
- **Awareness ≠ Bureau**: in-document cursors (Yjs awareness) and
  cross-app "who's here" (Bureau) stay separate systems on purpose — one is
  per-editor ephemeral state, the other is suite-wide location presence.

## 7. Verification matrix (Phase 1)
| Check | How |
|-------|-----|
| Path-shape WS upgrades | `wss://host/brief/ws/<docId>` closes 4001 unauthenticated (not 404) |
| Cursors from first keystroke | Two browsers, same doc: remote caret + name chip visible before either re-renders |
| No duplicate seeding | Open a legacy doc (plain_text, empty yjs_state) in two tabs simultaneously: content appears once |
| Flush freshness | Edit, wait ≤35s, `SELECT length(yjs_state), left(plain_text,40), yjs_last_saved_at FROM brief_documents WHERE id=…` |
| Viewer liveness | Browser A edits, Browser B on `/brief/documents/<slug>` sees text within ~1s without refresh |
