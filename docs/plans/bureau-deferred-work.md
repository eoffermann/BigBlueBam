# Bureau / Calling — Deferred Work

Items that came out of the calling prerequisite phase (P-1 through P-6) but were intentionally not landed in the prereq commits. They are documented here so they're not forgotten and so the next agent picking up the work has the full picture.

## D-1: Wire consumers to read `calling.*` from `system_settings`

**Status:** Not started.
**Blocks:** Real-world utility of the SuperUser Platform Calling Settings page. Today the page accepts edits, persists them to `system_settings`, and audits the change — but no service reads from there yet.

The P-2 SuperUser settings page introduced these keys:

- `calling.global_enabled` (boolean kill switch)
- `calling.livekit_host`
- `calling.livekit_api_key`
- `calling.livekit_api_secret`
- `calling.voice_agent_url`

`banter-api`, `board-api`, `brief-api`, and `voice-agent` currently read LiveKit credentials directly from env vars and have no awareness of `system_settings`. They need a small shared resolver:

```
get-calling-config.ts (proposed @bigbluebam/shared or app-local):
  resolveLiveKitCreds(orgId): {
    host, apiKey, apiSecret, source: 'project' | 'org' | 'platform' | 'env'
  }
```

Resolution order, mirroring the project-calling-settings.service.ts cascade in apps/api:

1. (future) project-level override — n/a for credentials.
2. Org-level override from `banter_settings.livekit_host`/`livekit_api_key`/`livekit_api_secret` (these already exist).
3. Platform-level from `system_settings` rows under the `calling.*` prefix.
4. Env-var fallback (today's behavior).

`calling.global_enabled = false` must short-circuit the entire stack — every token mint route returns a 503 / CALLING_DISABLED error before any LiveKit call is attempted.

**Where this lives:**
- `apps/banter-api/src/services/livekit-token.ts` — wrap the existing token mint.
- `apps/board-api/src/services/livekit.service.ts` — wrap `generateBoardAudioToken`.
- `apps/brief-api/src/services/livekit.service.ts` — wrap `generateBriefAudioToken`.
- `apps/voice-agent/src/api.py` — read from a small bridge endpoint on `apps/api` (since voice-agent is Python and doesn't have a Drizzle client).

Effort: ~1-2 days.

## D-2: Merge or link `CallingCredentialsCard` (env-status) with the new Platform Calling Settings page

**Status:** Not started.
**Severity:** Cosmetic / UX.

`apps/frontend/src/pages/superuser/index.tsx` has a read-only `CallingCredentialsCard` that shows env-var presence. The new P-2 page (`platform-calling-settings.tsx`) is now the writable surface. Two adjacent surfaces showing similar information will confuse operators.

Two options:

- **Option A (recommended):** Inline the env-status display into the top of `platform-calling-settings.tsx` as a "Configured at: env-var / system_settings / both" banner per knob.
- **Option B:** Make `CallingCredentialsCard` a clickable card linking to the settings page; keep both as separate views.

Effort: ~2 hours.

## D-3: Brief native call panel + auto-join `brief-{docId}`

**Status:** Stub-only (P-6 ships a `?lkRoom=` listener; full Brief calling not implemented).
**Tracking:** Mentioned in `docs/plans/bureau-design-document.md` §9 as Brief's contribution to Strategy B.

P-6 made Brief honor a Bureau-issued `?lkRoom=bureau-room-<uuid>` so summons stay continuous. But Brief still has no native call panel of its own — a user opening a Brief doc directly doesn't auto-join `brief-{docId}` the way Board does for `board-{boardId}`.

For Bureau v1 this is acceptable: continuous-audio teleport into Brief works because Bureau owns the LiveKit room. The native call panel becomes a follow-up workstream.

Scope (when scheduled):
- Mirror Board's audio-controls.tsx (mute, participant count, speaking indicator, disconnect).
- Auto-join `brief-{docId}` on document open when `?lkRoom=` is absent.
- Token mint on doc open; falls back through D-1's resolver for credentials.
- `brief_settings` table parallel to `banter_settings` for org-level Brief calling toggles, OR reuse the existing P-3 banter settings if the design wants unified org-level calling controls (probably the latter).

Effort: 2-3 days.

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

## D-6: Banter incoming-call signaling

**Status:** UI-only.
**Tracking:** Calling audit doc §1 Banter B-3.

`apps/banter/src/components/calls/incoming-call-overlay.tsx` exists as a UI component but no signaling layer ever shows it. A user starting a 1:1 or huddle call doesn't ring the callee.

Required:
- When a `POST /channels/:id/calls` succeeds for a type that should ring (1:1 voice, huddle invite), banter-api publishes to a per-user Redis channel.
- The Banter SPA subscribes via its existing WS hub and mounts `IncomingCallOverlay` when a relevant event arrives.

Effort: 1-2 days.

## D-7: Banter agent-text-sidebar backend

**Status:** UI-only.
**Tracking:** Calling audit doc §1 Banter B-4.

`apps/banter/src/components/calls/agent-text-sidebar.tsx` lets a user type a message during a call. `onSendMessage` is wired but nothing receives it. Required: a `POST /v1/calls/:id/agent-message` route in banter-api that forwards the text to the voice-agent as a steering message.

Effort: 0.5 day.

---

## D-8: Pre-existing Bolt catalog drift in blueprint

**Status:** Not started (pre-existing, surfaced by Bureau workstream 2's `scripts/check-bolt-catalog.mjs` run).
**Severity:** Low — drift guard flags one entry but the event is being emitted from a real call site so production is fine.

`apps/blueprint-api/src/routes/cross-product.routes.ts` calls `publishBoltEvent` with `(source='blueprint', event_type='diagram.promoted_to_tasks')` but the `(source, event_type)` pair is missing from `apps/bolt-api/src/services/event-catalog.ts`. The drift guard rejects this on CI — though it has apparently been merging anyway, so either CI doesn't currently run the drift guard, or the violation has been ignored.

Fix is one-liner: add `{ source: 'blueprint', event_type: 'diagram.promoted_to_tasks', ... }` to the `blueprintEvents` array in event-catalog.ts. Effort: 5 minutes.

Per CLAUDE.md "pre-existing is not a dismissal" — recording it here. Will be picked up when someone touches Bolt next.

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

**Total deferred effort (D-1 through D-10): ~9-12 days.** None of these block subsequent Bureau workstreams; D-1 (consumer wiring), D-4 (Book auto-room), and D-10 (ws.routes.ts dedup) become relevant during workstreams 4-7 and 11.
