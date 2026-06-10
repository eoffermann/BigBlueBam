# Bureau / Calling — Deferred Work

Items that came out of the calling prerequisite phase (P-1 through P-6) but were intentionally not landed in the prereq commits. They are documented here so they're not forgotten and so the next agent picking up the work has the full picture.

## D-1: Wire consumers to read `calling.*` from `system_settings` ✅ MOSTLY CLOSED (v2 unified-call model)

**Status:** Mostly closed by the v2 unified-call model (Phase 3). Only `bureau-api` (the docked-box's LiveKit token endpoint) and `voice-agent` remain as consumers; the per-app consumer list this item originally targeted is gone.

The Phase 2 deletions removed every per-app LiveKit stack that this item was meant to wire up:

- `apps/board-api/src/services/livekit.service.ts` — deleted.
- `apps/brief-api/src/services/livekit.service.ts` — deleted.
- `apps/banter-api/src/services/livekit-token.ts` — `call.routes.ts` follows; the docked box now handles 1:1, huddle, and surface calling uniformly.

**Remainder ✅ CLOSED** (commit 77e9662, 2026-06-09): `apps/bureau-api/src/services/calling-settings.service.ts` resolves `calling.*` from system_settings over env (15s cache, stale-cache-then-env failure posture). All three Bureau mint paths honor `calling.global_enabled` (REST 503 CALLING_DISABLED; WS joins the room without audio) and mint with the resolved credentials, so LiveKit key/host rotation via the settings page takes effect without redeploy. The switch mirrors to Redis (`calling:global_enabled`) and the voice agent checks the mirror at spawn, coming up log-only when disabled. Verified live: 503 when off, 200 when on.

## D-2: Merge or link `CallingCredentialsCard` (env-status) with the new Platform Calling Settings page ✅ CLOSED

**Status:** Closed (Option A, 2026-06-09). Env status renders as a banner at the top of `platform-calling-settings.tsx`; every knob shows a "Configured at: env / settings / both / not configured" chip driven by the new `env_presence` field on GET `/superuser/calling-credentials`. The console card was removed (the AdminToolCard nav entry remains).
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

## D-4: Book auto-creates LiveKit rooms on event booking ✅ CLOSED

**Status:** Closed (2026-06-09), realized in v2 unified-call terms rather than the v1 sketch above: instead of a bespoke `book-{eventId}` room + token path, Book events ride the canonical surface-huddle rail.

- Migration 0141 adds `book_events.livekit_room_name`.
- Book-native events (authed create + public booking confirmation) get `livekit_room_name = huddle-book-{eventId}` and, when no external meeting URL was supplied, `meeting_url = {PUBLIC_URL}/book/events/{eventId}` — the deep link IS the join link. Bureau room reservations record `bureau-room-{roomId}`.
- The Book SPA advertises the event id as `surface_id` on `/book/events/:id`, so the docked box auto-joins `huddle-book-{eventId}` for anyone opening the meeting URL; tokens mint through bureau-api's surface-huddle endpoint (which honors the D-1 kill switch + credential resolver). `'book'` added to both bureau-api SURFACE_APPS lists and the SDK's ring/Invite maps.
- Known limitation: external attendees from public booking pages (no BBB account) see the URL but can't join — the surface-huddle mint requires a session. Guest access is a separate feature.
**Tracking:** Calling audit doc §1 Book.

## D-5: voice-agent per-org STT/LLM/TTS persistence ✅ CLOSED

**Status:** Closed (commit ae13fe0, 2026-06-09). POST /config is org-scoped (org-less legacy pushes land on a `_global` key) and the merged config persists to the `voice-agents:provider-config` Redis hash via the existing AgentRegistry connection; resolution is a read-through cache (memory → Redis org key → global key → env). `/agents/spawn`, `/transcribe`, and `GET /config` accept org_id; banter-api sends org_id on both push sites; the worker transcription job forwards it. Verified live: org-scoped config survived a pod restart while the global view stayed isolated.
**Tracking:** Calling audit doc §1 voice-agent.

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

## D-9: Pre-existing beacon-expiry-sweep cron crash ✅ CLOSED

**Status:** Closed (commit d1ef222, 2026-06-09). Root cause: drizzle binds a JS array interpolated into a raw `` sql`...ANY(${arr})` `` template as one untyped param, which Postgres rejects with 42809. Step 3a became a single `UPDATE..RETURNING`; the same bug class was fixed in banter-api @mention resolution (4 sites), blast-api segment 'in' conditions, and the Bam bulk-task access check via explicit `::text[]`/`::uuid[]` casts. Also fixed in-pass: the sweep's fan-out queues dropped the Redis password (host/port-only URL parse). Verified by manual enqueue — sweep completes through all 4 steps.

## D-10: Consolidate ws.routes.ts inline presence layer ✅ CLOSED

**Status:** Closed (commit fe70506, 2026-06-09). The WS hub now consumes `services/presence.service.ts` + `services/presence-publisher.service.ts`; the inline duplicate (~230 lines) is gone. The services gained `setFloor`, `snapshotFloor`, an explicit-floorId `enterRoom` param, and orgId/roomId extras + `'offline'` on `mirrorPresenceToShared` to cover the hub's needs.

## D-11: Banter internal DM endpoint for "leave a note" ✅ CLOSED

**Status:** Closed (commit a38ac3d, 2026-06-09). banter-api ships `POST /v1/internal/dm` (X-Internal-Secret gated, `services/internal-dm.ts`): validates both users, finds-or-creates the 1:1 DM channel with the same slug convention as `POST /v1/dm`, posts as the sender, broadcasts `message.created`, and emits the standard `dm` notification. bureau-api's `POST /v1/knocks/leave-note` (which already speculatively called it) now actually delivers and returns `200 { delivered: true }`. Verified live: 201 with channel + message ids between two seeded users. The ring 423 path's chip-strip UI still deep-links to the DM (works); converting it to an inline composer can ride on this endpoint later.

## D-12: Cross-app can-read preflights for board-api / brief-api / apps/api ✅ CLOSED

**Status:** Closed (commit fddda02, 2026-06-09). The summon eligibility filter is live: board-api and brief-api ship `POST /v1/internal/can-read` (mirroring their `authorize.ts` read guards, with real `can_share` for creator/org-admin), apps/api ships `POST /internal/can-read` (dispatching through the §11 `visibility.service` preflight). bureau-api's `stub_allow` fallback now fires only on transport failure. Drive-by: `surfaceUrlFor()` built dead URLs for board/brief/beacon — fixed (ring accept previously 404'd on those apps).

Note for future visibility-model changes: the board/brief internal routes restate their middleware's visibility branch as pure functions — keep them in sync with `requireBoardAccess` / `requireDocumentAccess`.

## D-13: ws.routes.ts subscribe-vs-listener race

**Status:** Not started. (Reconstructed, see D-10 note.)

Two-line server fix in `apps/bureau-api/src/routes/ws.routes.ts`: the floor subscribe path can attach its Redis listener after the snapshot is sent, dropping deltas that land in between.

Effort: ~5 minutes.

## D-14: Ring API rejects Banter surfaces, so the docked-box Invite button hides on Banter ✅ CLOSED

**Status:** Closed (2026-06-09). `'banter'` added to `SURFACE_APPS`; the receiver-side URL problem (surface_id is the channel id, Banter routes by slug) is solved by a new `/banter/go/:channelId` resolver route in the Banter SPA that bounces to `/channels/:slug` or `/dm/:id` via the existing `GET /channels/:slugOrId`. `surfaceUrlFor()` and the Invite app map both route through it.

`SURFACE_APPS` in `apps/bureau-api/src/routes/ring.routes.ts` does not include `'banter'`, so the docked box's `RING_SURFACE_APP_BY_LOCATION_APP` map (packages/bureau-client/src/index.tsx) deliberately omits it and Banter channels/DMs get no Invite button — even though Banter advertises `surface_id` and the canonical `huddle-banter-{channelId}` room would work fine. To close: add `'banter'` to the server enum, add a `banter` case to `surfaceUrlFor()` in `packages/bureau-client/src/ring-handler.tsx` (note: `surface_id` is the channel *id*, while Banter routes by slug — needs a resolvable URL), then add `banter: 'banter'` to the client map. Related: D-11 and the Banter 1:1-call wiring noted under D-6.

Effort: 2-3 hours (mostly the URL-by-id resolution on the Banter side).

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
