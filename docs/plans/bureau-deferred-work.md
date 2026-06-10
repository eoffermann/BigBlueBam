# Bureau / Calling — Deferred Work

Items that came out of the calling prerequisite phase (P-1 through P-6) but were intentionally not landed in the prereq commits. They are documented here so they're not forgotten and so the next agent picking up the work has the full picture.

## D-1: Wire consumers to read `calling.*` from `system_settings` ✅ MOSTLY CLOSED (v2 unified-call model)

**Status:** Mostly closed by the v2 unified-call model (Phase 3). Only `bureau-api` (the docked-box's LiveKit token endpoint) and `voice-agent` remain as consumers; the per-app consumer list this item originally targeted is gone.

The Phase 2 deletions removed every per-app LiveKit stack that this item was meant to wire up:

- `apps/board-api/src/services/livekit.service.ts` — deleted.
- `apps/brief-api/src/services/livekit.service.ts` — deleted.
- `apps/banter-api/src/services/livekit-token.ts` — `call.routes.ts` follows; the docked box now handles 1:1, huddle, and surface calling uniformly.

The remaining consumers — `bureau-api` token mints (spatial + surface huddle) and `voice-agent` — are a much smaller surface. The shared resolver can either ship as a 2-call utility in `@bigbluebam/livekit-tokens` or live inline in bureau-api's env layer with a `voice-agent` bridge endpoint on `apps/api`. The `calling.global_enabled = false` kill switch still needs implementing on those two paths, but the original 4-app fan-out described in the v1 item is moot.

Effort: 4-6 hours (down from 1-2 days).

## D-2: Merge or link `CallingCredentialsCard` (env-status) with the new Platform Calling Settings page

**Status:** Not started.
**Severity:** Cosmetic / UX.

`apps/frontend/src/pages/superuser/index.tsx` has a read-only `CallingCredentialsCard` that shows env-var presence. The new P-2 page (`platform-calling-settings.tsx`) is now the writable surface. Two adjacent surfaces showing similar information will confuse operators.

Two options:

- **Option A (recommended):** Inline the env-status display into the top of `platform-calling-settings.tsx` as a "Configured at: env-var / system_settings / both" banner per knob.
- **Option B:** Make `CallingCredentialsCard` a clickable card linking to the settings page; keep both as separate views.

Effort: ~2 hours.

## D-3: Brief native call panel + auto-join `brief-{docId}` ✅ CLOSED (v2 unified-call model)

**Status:** Closed by the v2 unified-call model (Phase 3). A "Brief native call panel" is no longer a concept — the docked box is the universal call UI for every surface in the suite.

A user opening a Brief doc now auto-joins `huddle-brief-{docId}` via the bureau-client SDK's `ActiveCallManager` the moment `describeLocation()` reports `app: 'brief'` plus the document id as `surface_id` (already wired in `apps/brief/src/main.tsx`). The `brief-{docId}` room name from v1 has been retired in favor of the canonical `huddle-brief-{docId}` per the §19 naming contract.

Phase 2 deleted `apps/brief-api/src/routes/audio.routes.ts`, `apps/brief-api/src/services/livekit.service.ts`, `apps/brief/src/components/continuous-audio-widget.tsx`, and `apps/brief/src/hooks/use-continuous-audio.ts` — Brief's contribution to this item is gone.

## D-4: Book auto-creates LiveKit rooms on event booking

**Status:** Not started.
**Tracking:** Calling audit doc §1 Book.

`book_events.meeting_url` exists today as a freeform string. Bureau §16 envisions bureau-api delegating booking to Book, but Book has no LiveKit awareness. Required:

- A `livekit_room_name` column on `book_events`.
- On booking confirmation (or activation), book-api mints a room name `book-{eventId}` (or accepts a Bureau-supplied `bureau-room-<uuid>` when the booking came via Bureau).
- The booking's meeting URL becomes a deep link to the LiveKit room (or to Bureau's room).
- Attendees joining the link get a token minted via the same D-1 resolver.

Effort: 2 days.

## D-5: voice-agent per-org STT/LLM/TTS persistence

**Status:** Not started.
**Tracking:** Calling audit doc §1 voice-agent.

Today voice-agent's STT/LLM/TTS provider config is platform-wide env-only with in-memory overrides pushed by banter-api at admin settings change. A pod restart loses any per-org customization until the next banter-api push.

Required: voice-agent persists per-org config in Redis (e.g., `voice_agent:org:{orgId}:config`) so a restart re-hydrates. Banter-api continues to push on admin-settings change; voice-agent reads the appropriate row when spawning into a call's room.

Effort: 1 day.

## D-6: Banter incoming-call signaling ✅ CLOSED (v2 unified-call model)

**Status:** Closed by the v2 unified-call model (Phase 3). The work has shifted — and largely is already done — in bureau-client rather than banter.

What changed:

- `apps/banter/src/components/calls/incoming-call-overlay.tsx` was deleted in Phase 2; the shared `IncomingCallOverlay` lives in `@bigbluebam/ui` and is the surface for ALL incoming-call rings in the suite.
- Ring signaling lives in `apps/bureau-api/src/routes/ring.routes.ts` and `apps/bureau-api/src/services/ring.service.ts`. Any caller (Banter UI, presence chip strip, MCP tool) POSTs `/bureau/api/v1/ring` and the recipient's bureau-client SDK renders the overlay via `packages/bureau-client/src/ring-handler.tsx`.
- A Banter "start a 1:1 call" affordance is implemented as: pick the user → POST `/bureau/api/v1/ring` with the Banter DM channel's surface_id. Both ends land in `huddle-banter-{channelId}` automatically.

What still needs doing (small, but it's not the same item):

- Wire Banter's UI for "call this person" to the bureau-api ring endpoint (vs. the historical `/channels/:id/calls` flow).
- Decide whether 1:1 Banter calls use a `huddle-banter-{channelId}` room or a synthetic `dm-{userA}-{userB}` room name — the v2 naming contract assumes a surface_id, and 1:1 DMs do have one.

Effort: 2-3 hours follow-up.

## D-7: Banter agent-text-sidebar backend ✅ CLOSED (v2 unified-call model)

**Status:** Closed by Phase 2 deletions in the v2 unified-call model.

`apps/banter/src/components/calls/agent-text-sidebar.tsx` was deleted along with the rest of the Banter calls subtree. The "type a steering message during a call" affordance, if we want to bring it back, belongs on the docked box (so it works in every surface, not just Banter calls) and routes through bureau-api → voice-agent. Not currently scheduled.

---

## D-8: Pre-existing Bolt catalog drift in blueprint ✅ CLOSED

**Status:** Closed in-pass during the presence-and-immediate-interaction verify pass (commit 71fe0e3).

`apps/blueprint-api/src/routes/cross-product.routes.ts` was emitting `blueprint.diagram.promoted_to_tasks` without a catalog entry; added the definition (with `id`, `project_id`, `task_count`, `link_count` payload schema) to `apps/bolt-api/src/services/event-catalog.ts`. The drift guard now reports 0 violations across 131 (source, event_type) pairs.

## D-9: Pre-existing beacon-expiry-sweep cron crash

**Status:** Not started (pre-existing, surfaced during Bureau workstream 3 verification).
**Severity:** Medium — the cron runs daily and silently fails today.

The `beacon-expiry-sweep` daily worker cron throws `PostgresError 42809 "op ANY/ALL (array) requires array on right side"` every time it fires. The query is malformed: it's passing a scalar where an array is expected on the right side of an `= ANY(...)` or `IN (...)` clause.

Recorded per CLAUDE.md "pre-existing is not a dismissal." Locate the failing query in `apps/worker/src/jobs/beacon-expiry-sweep.ts` (or wherever the job's processor lives) and either wrap the scalar in `[...]` or rewrite as `=` rather than `= ANY`. Effort: 30 minutes once found.

## D-11: Banter internal DM endpoint for Bureau "leave a note"

**Status:** Not started (introduced by Bureau workstream 5).
**Severity:** Low — leave-a-note returns 202 with a logged TODO when the endpoint is missing, so visitors get a reasonable message.

When a Bureau visitor knocks on a DND'd office, they're offered the "leave a note" path which calls `POST http://banter-api:4002/v1/internal/dm` with `X-Internal-Secret` and a body like `{ org_id, from_user_id, to_user_id, content: '[Bureau knock note] {message}', source: 'bureau-knock' }`. That endpoint does NOT currently exist in banter-api — only `/v1/internal/feed`, `/v1/internal/share`, `/v1/internal/transcript`.

Required:
- New file `apps/banter-api/src/routes/internal-dm.routes.ts` exposing `POST /v1/internal/dm` gated on `X-Internal-Secret` (timing-safe compare against `env.INTERNAL_SERVICE_SECRET`).
- Resolves/creates the DM channel between `from_user_id` and `to_user_id` in `org_id`.
- Inserts a banter_messages row with the content.
- Returns `{ delivered: true, channel_id, message_id }`.

Effort: 2-3 hours.

## D-12: Cross-app `can-read` preflight endpoints for Bureau summons

**Status:** Not started (introduced by Bureau workstream 6).
**Severity:** Medium — without these, summon access checks return `stub_allow` for everyone and the §4.4 "denied list" is always empty. Functionally Bureau still summons everyone in the room; navigating to a target you can't see surfaces a 403 from the destination app's own UI, so this is graceful but not the experience the design doc describes.

Bureau's `cross-app-access.service.ts` calls these endpoints when planning a summon:

- `POST http://board-api:4008/v1/internal/can-read` body `{ user_id, board_id }` → `{ allowed, canShare }`.
- `POST http://brief-api:4005/v1/internal/can-read` body `{ user_id, document_id }` → `{ allowed, canShare }`.
- `POST http://api:4000/internal/can-read` body `{ user_id, project_id }` → `{ allowed, canShare }`.

All three should:
- Authenticate via `X-Internal-Service-Secret` (timing-safe).
- Look up the resource and check the caller's existing visibility rules (board collaborators / brief permissions / project members).
- Return `canShare: true` when the caller can add other users to the resource.

The HTTP code path is already in `apps/bureau-api/src/services/cross-app-access.service.ts` — it activates automatically when each peer ships its endpoint.

Effort: ~1 day total (each endpoint is ~3 hours).

## D-13: Subscribe-vs-listener race in `apps/bureau-api/src/routes/ws.routes.ts`

**Status:** Mitigated client-side, server-side fix recommended.
**Severity:** Low — symptom is a ~100ms window after WS upgrade in which client messages get dropped.

Discovered by the workstream 15 smoke script while writing E2E coverage. In `apps/bureau-api/src/routes/ws.routes.ts`, the server emits the `connected` frame at line ~499 BEFORE binding `socket.on('message', ...)` at line ~561. A client that sends `subscribe_floor` immediately on receiving `connected` can race the listener; the message arrives at the socket before the handler is bound and is silently dropped.

The bureau-client SDK and the smoke script both wait for the `connected` frame before sending, so this is invisible in practice. But a future client implementation that assumes any post-upgrade send is safe will hit it.

Fix is 2 lines: move the `socket.on('message', ...)` binding BEFORE the `socket.send(JSON.stringify({ type: 'connected', ... }))` line. The listener will be bound when the first user message arrives, and the `connected` frame still goes out in the right order.

Effort: 5 minutes.

## D-10: Consolidate `ws.routes.ts`'s inline presence layer

**Status:** Not started (introduced by Bureau workstream 3).
**Severity:** Low — works correctly today, but the duplication will drift.

`apps/bureau-api/src/routes/ws.routes.ts` is 1324 lines because the parallel workflow agent that built the WS hub was scoped to "don't modify outside your assigned files." That blocked it from importing the `presence.service.ts` + `presence-publisher.service.ts` that a sibling agent was building in parallel. It inlined a near-duplicate of both.

Both copies currently behave identically (typecheck clean, smoke verified), but any change to the canonical service in `apps/bureau-api/src/services/presence.service.ts` will silently fail to propagate into the WS hub. This is the classic two-codebase-one-feature footgun.

The consolidation is mechanical:
1. Replace the inlined `presenceService` object in `ws.routes.ts` with imports from `../services/presence.service.js`.
2. Replace the inlined publishers with imports from `../services/presence-publisher.service.js`.
3. Remove the dead lines.

Expected delta: `ws.routes.ts` drops from ~1324 to ~500 lines. Effort: 2 hours including verification (rebuild bureau-api, smoke-test WS upgrade, smoke-test enter_room → presence_delta).

---

**Total deferred effort (open items only): ~5-7 days.** The Phase 3 unified-call-model consolidation closed D-1 (mostly), D-3, D-6, and D-7 outright by deleting the per-app LiveKit stacks those items targeted; what's left is consumer wiring on a smaller surface (bureau-api + voice-agent), Book auto-room creation (D-4), voice-agent per-org persistence (D-5), the ws.routes.ts presence-layer dedup (D-10), the banter `/v1/internal/dm` endpoint (D-11), the cross-app `can-read` preflights (D-12), and the listener-binding race (D-13). None block subsequent Bureau workstreams.
