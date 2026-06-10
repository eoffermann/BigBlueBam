# Bureau Troubleshooting Notes — 2026-06-10

Findings from the static troubleshooting pass on branch `bureau-troubleshooting`
(cut from main; docker/runtime verification was explicitly out of scope for this
pass — see "Runtime verification checklist" at the bottom for what the operator
should exercise once the dev stack is free).

Fixed-in-this-pass items live in the commit log (`git log bureau-troubleshooting`)
and in the updated trackers (`bureau-deferred-work.md`, `bureau-security-audit.md`).
This file records what was found but **not** fixed — each entry has file:line,
symptom, hypothesis, and a suggested fix.

---

## 1. Surface-huddle token mint has no resource/on-surface check (cross-org eavesdropping)

- **Where:** `apps/bureau-api/src/routes/livekit.routes.ts` (`POST /v1/surface-huddle/token`, ~line 193) and the deliberately-unwired guard in `apps/bureau-api/src/services/surface-presence.service.ts`.
- **Symptom:** any authenticated user (any org) who learns or guesses a `(surface_app, surface_id)` pair can mint a LiveKit token for `huddle-{app}-{id}` and listen in on that surface's huddle. Surface ids are not org-namespaced and the route does no access check by design (see the long comment in the route).
- **History:** `isUserOnSurface()` was written exactly for this ("a malicious agent that guesses … could mint a token … and listen in" — its own header) but was unwired in the Phase 3 unified-call model. The service header still claims it is "imported by livekit.routes.ts" — stale.
- **Why not fixed statically:** the obvious re-enable races the SDK. `ActiveCallManager.setTarget()` mints over REST the moment the URL changes, while the `location_update` that would satisfy `isUserOnSurface` travels over a separate WS connection — strict enforcement would intermittently 403 legitimate auto-joins. Needs a design decision + runtime verification.
- **Suggested fix:** enforce `isUserOnSurface` with a bounded retry/grace (e.g. one 250ms recheck) OR have the SDK await the location_update server ack before minting; alternatively, do a real per-app can-read preflight on `(surface_app, surface_id)` (the D-12 endpoints exist now for board/brief/bam). At minimum scope the mint to sessions whose org matches an org owning the surface.

## 2. Docked box shows "Just you" when entering a room through the SDK WS

- **Where:** `packages/bureau-client/src/index.tsx` (`room_enter` handler, ~line 340) + `apps/bureau-api/src/routes/ws.routes.ts` (`enter_room` case).
- **Symptom:** the server never sends an occupant snapshot on `enter_room` — the SDK only learns about occupants from *subsequent* `room_enter` frames. A user entering an occupied room via `actions.enterRoom()` sees an empty occupants list until someone else moves. (The Bureau floor-view SPA is unaffected: it mirrors occupancy through the `spatialOccupantIds` location descriptor.)
- **Suggested fix:** on `enter_room`, have the hub `presence.getRoomOccupants()` and push a `room_occupants { roomId, userIds }` frame to the entering socket; add the type to `packages/bureau-client/src/types.ts` and merge it in `BureauProvider`. Protocol addition → needs runtime verify with two browsers.

## 3. `enter_room` on a different floor doesn't move the floor subscription

- **Where:** `apps/bureau-api/src/routes/ws.routes.ts` (`enter_room` case — `client.floorId = room.floor_id` without re-subscribing the Redis floor channel).
- **Symptom:** a socket subscribed to floor A that enters a room on floor B keeps receiving floor-A deltas and gets none from floor B. Low impact today (the floor view always subscribes the floor it renders before entering its rooms), but the SDK's `actions.enterRoom()` can hit it.
- **Suggested fix:** in `enter_room`, when `room.floor_id !== client.floorId`, unsubscribe the old floor channel and subscribe the new one (same dance `subscribe_floor` does).

## 4. `grantAccessAndSummon` never actually grants access (documented v1 stub)

- **Where:** `apps/bureau-api/src/services/summon.service.ts` (~line 522, TODO block).
- **Symptom:** the §4.4 "Grant access & bring them" dialog flips audit outcomes to `granted` and re-fires `summon_incoming`, but no share/invite API is ever called — the recipient still 403s at the destination. Known and documented in-code; recorded here so it isn't lost.
- **Also:** `POST /v1/summons/:id/grant-access` lets a superuser through (`!user.is_superuser` carve-out) but the service then rejects any caller whose id ≠ `summoner_id`, returning `granted: 0` — the route and service disagree. Pick one (suggest: drop the superuser carve-out in the route).
- **Also:** the grant path re-enters `fanOutSummon`, which emits a second `bureau.summon.issued` Bolt event for the same summon — the "exactly once" contract in the module header is violated when grant is used. Suggest a `suppressBoltEvent` flag on `FanOutSummonArgs` for the re-fire.

## 5. WS `lock_room` unlock reverts to `privacy_default`, not the pre-lock door state

- **Where:** `apps/bureau-api/src/routes/ws.routes.ts` (`lock_room` case: `const nextPrivacy = locked ? 'private' : room.privacy_default`).
- **Symptom:** if an office owner had `set_door` to `knock` (override) and someone locks then unlocks, the door lands on the DB default instead of the prior override.
- **Suggested fix:** persist the pre-lock privacy in the door-state hash (e.g. `prevPrivacy` field) and restore it on unlock.

## 6. calling-settings boolean parse is stricter than apps/api's

- **Where:** `apps/bureau-api/src/services/calling-settings.service.ts:85` vs `apps/api/src/services/project-calling-settings.service.ts:188` (`readBool`).
- **Symptom:** bureau-api treats a JSONB **string** `'true'` for `calling.global_enabled` as *disabled* (only boolean `true`/null/undefined count as enabled); apps/api tolerates `'true'`/`'false'` strings. Today the settings route validates `z.boolean()` so only real booleans are stored — latent only. Suggest mirroring `readBool` for parity.

## 7. Security-audit follow-ups still open (no change this pass)

From `bureau-security-audit.md` §6/§7, still outstanding:
- per-(user, floor) cooldown on `subscribe_floor` (snapshotFloor amplification);
- audit-log on `evaluateRoomAccess` denials;
- full helmet-style `SECURITY_HEADERS` on bureau-api (only nosniff/frame-deny/no-store are set in `server.ts`);
- `INTERNAL_SERVICE_SECRET` rotation cadence;
- direct unit tests for `canSetDoor` / `canLockRoom` (they are closures inside `ws.routes.ts` — extract to `middleware/room-access.ts` to make them testable);
- `stub_allow` transport-failure fallback in `cross-app-access.service.ts` remains fail-open by design — flip to fail-closed if the threat model hardens.

## 8. Known duplication that will drift

- `apps/worker/src/jobs/bureau-summon-fanout.ts` and `apps/worker/src/services/bureau-presence-cleanup.ts` carry hand-mirrored copies of bureau-api logic (documented in their headers). This pass touched the cleanup mirror (session index) and updated both sides; the next person to touch either should consider promoting to a shared package as the headers suggest.
- `SURFACE_APPS` exists in both `ring.routes.ts` and `livekit.routes.ts`, and again as `RING_SURFACE_APP_BY_LOCATION_APP` in `packages/bureau-client/src/index.tsx` — three lists that must agree.

## 9. Pre-existing verification noise (recorded per CLAUDE.md)

- `pnpm --filter @bigbluebam/bureau-api lint` (Biome): **39 warnings**, all pre-existing style-level suggestions (`noNonNullAssertion`, suggested-fix notices) — baseline before this pass was 40; no new warnings introduced. None are errors; lint exits 0.
- No pre-existing test failures or typecheck errors were encountered in `@bigbluebam/bureau-api`, `@bigbluebam/bureau-client`, or `@bigbluebam/worker`.

---

## Runtime verification checklist (for the operator, once the stack is free)

Rebuild + restart `bureau-api` and `worker`; rebuild any SPA that vendors `@bigbluebam/bureau-client` (all of them embed it — at minimum rebuild the ones you'll test through). Migrations: **none** — no schema changes in this pass.

1. **Ring end-to-end (the headline fix):** two browsers, same org. User A on a Brief doc clicks Invite → ring user B. B must now actually see the IncomingCallOverlay (previously the frame type mismatch dropped it). Accept should navigate B to the doc and auto-join `huddle-brief-{id}`; A's server log should show a `ring_responded` publish (no more UNKNOWN_TYPE error for `ring_respond`).
2. **Ring org-scoping:** with a user from a *different* org, POST `/bureau/api/v1/ring` at a foreign user id → expect 404 `Recipient not found in your organization`.
3. **Ghost-presence reap:** enter a room, then kill the browser process (no graceful close) or restart bureau-api with a client in a room. Within ~50s (35s TTL + 15s reap tick) the avatar must leave the floor view, `bureau:room:{id}:occupants` must not contain the user, and `bureau:presence:index` must not retain the session (check with `HGETALL bureau:presence:index` in redis-cli). Previously the ghost persisted forever.
4. **Locked door enforcement:** lock a shared room from the docked box (door button) — a second non-admin, non-ACL member must now get FORBIDDEN on `enter_room` and 403 on `POST /v1/rooms/:id/token`. Unlock → entry works again. Also verify board-api continuous-audio mint into a locked `bureau-room-*` falls back to the canonical board room.
5. **Knock-room continuous audio:** put a room's privacy on `knock`, have a member join it, summon to a Board — the recipient's Board audio must land in the same `bureau-room-*` (previously `can-join-room` denied knock rooms and audio dropped).
6. **WS pre-init frames:** hard-refresh a SPA while watching bureau-api logs — the first `location_update` after connect must register (check `GET /v1/presence/here?url=...` from a second user immediately after the first user's reload).
7. **Concurrent summon responses:** summon a room with 3+ recipients; have two accept near-simultaneously; `GET /v1/summons/:id` must show both `joined` (previously one could be clobbered back to `pending`).
8. **DND knock fallback:** knock on a DND'd office → the 423 body's `leave_a_note_endpoint` is `/v1/knocks/leave-note` and posting there delivers the Banter DM.
9. **Smoke script:** `node scripts/bureau-smoke-test.mjs` against the seeded stack (9 steps) as the regression backstop.
