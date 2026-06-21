# Bureau security audit

**Status:** initial audit, Workstream 15.
**Scope:** apps/bureau-api, packages/bureau-client, the bureau-room-X cross-app
token mint surfaces in board-api and brief-api, and the four BullMQ workers
(reaper, booking-lifecycle, knock-timeout, summon-fanout) in apps/worker.
**Out of scope:** the voice-agent service (separate review), the LiveKit SFU
config in infra/livekit (operational hardening tracked elsewhere).

Bureau is a security-sensitive surface area for three reasons. First,
presence data is sensitive — knowing where every employee is in the
virtual office, with whom, for how long, is a behavioral signal that
employers can misuse and that adversaries can exploit. Second, the summon
flow ("bring everyone here") could leak resource existence to recipients
who lack access if the recipient-eligibility filter is not airtight.
Third, Bureau is one of the first products to introduce cross-app HTTP
calls into the platform's previously-flat authorization model (board-api
and brief-api now ask bureau-api whether a given user is allowed inside
a `bureau-room-X` LiveKit room), and any weakness there propagates.

This document records the model as built, identifies known gaps, and
recommends concrete production hardening.

## 1. Authentication model

### 1.1 End-user requests (REST + WebSocket)

Every browser-originated request reaches bureau-api through nginx after
the shared cookie auth handshake in apps/api. Concretely:

- **Cookie**: `session=<opaque>` set by `POST /b3/api/auth/login`.
  HttpOnly, Secure, SameSite=Lax, 7-day Max-Age. The companion
  `csrf_token` cookie is SameSite=Strict and is not HttpOnly so JS can
  read it for the X-CSRF-Token header on mutations.
- **REST**: bureau-api's plugins/auth.ts looks up the session row in
  `sessions`, joins `users`, and decorates `request.user` with
  `{ id, org_id, display_name, is_active, is_superuser }`. Sessions are
  rejected when expired, when the user is inactive, or when the session
  row no longer exists.
- **WebSocket**: identical lookup runs at HTTP upgrade time in
  `apps/bureau-api/src/routes/ws.routes.ts`. A missing or invalid session
  closes with code 4401 (custom close code, "Authentication required").
  No further messages are processed by an unauthenticated socket.

### 1.2 Cross-app server-to-server calls

The new cross-app surface is:

- board-api and brief-api LiveKit mint routes call `bureau-api` to verify
  that a user is allowed inside a `bureau-room-X` room before issuing the
  token. The call carries `X-Internal-Service-Secret:
  <INTERNAL_SERVICE_SECRET>` and `X-Organization-ID: <orgId>` headers and
  goes over the internal Docker network only.
- summon's per-app access preflight (`apps/bureau-api/src/services/
  cross-app-access.service.ts`) calls `board-api`, `brief-api`, and the
  Bam api with the same header pair. **Status: stub_allow today**
  because the destination apps do not yet expose a `/v1/internal/can-read`
  preflight. See "Known gaps" §6 below.

The `INTERNAL_SERVICE_SECRET` is the only secret protecting these calls.
It is environment-injected, never persisted in DB, and shared across all
internal services.

### 1.3 Service-account tokens

Where bureau-api needs to act on behalf of an autonomous agent (e.g.
booking-lifecycle worker scheduling a Banter follow-up), it uses an
`bbam_svc_`-prefixed API key tied to a locked service-account user (see
the platform §15 agent policies). The MCP register-tool middleware
enforces the §15 kill switch and allowlist on every service-account
invocation; Bureau service accounts get `bureau.*` in their allowlist by
default.

## 2. ACL enforcement at WebSocket upgrade time + per message

### 2.1 At upgrade time

The WS handshake gates only on session validity (§1.1) and Redis
availability for the per-socket subscriber. It does NOT verify any
floor/room access at this point — the upgrade is for the org-scoped
presence bus, not for any specific resource.

### 2.2 Per message

Every privileged WS message re-runs the room-access middleware:

- `enter_room`, `lock_room`, `unlock_room`, `set_door`, `summon`,
  `knock`, `cancel_knock`, `accept_knock`, `decline_knock` each call
  `loadRoom(roomId, orgId)` (returns null for archived rooms and for
  rooms in a different org) and then `evaluateRoomAccess(room, user)`.
- `evaluateRoomAccess` is a single function (`apps/bureau-api/src/
  middleware/room-access.ts`) that admits (in order):
  1. superusers,
  2. org admins/owners,
  3. the room's owner,
  4. any org member for `open` or `knock` rooms,
  5. private-room ACL holders.
- The function falls **closed** for unknown privacy buckets — a future
  enum value introduced without code change defaults to deny.
- `set_status`, `update_location`, and the heartbeat take no roomId and
  are scoped to the caller's own session id only.

The `bureauRoomAcl` table holds two roles: `member` (walk-in) and
`manager` (walk-in + can change door state on shared rooms). The
WS-level `canSetDoor()` and `canLockRoom()` closures encode the §8 door
authorization rules and are exercised by manual smoke testing today;
unit-test coverage for these specifically is a follow-up
(see "Known gaps" §6 item D-9).

### 2.3 Cross-app LiveKit token gate

When the user navigates from any non-Bureau app into a `bureau-room-X`
LiveKit room (e.g. they're on a Brief doc that's pinned inside a
conference room), the destination app's LiveKit mint route is the gate
that catches them. board-api's `audio.routes.ts` and brief-api's
equivalent both call bureau-api's `POST /bureau/api/v1/livekit/can_join`
before issuing the token. Without that round-trip a board-api token
mint for `bureau-room-X` would never have run any Bureau ACL.

## 3. Summon access-leak prevention

§10 of the design doc is explicit: "Occupants without access are
recorded as `no_access`. They are not navigated and not notified, so
the summon never reveals the resource to someone who cannot open it."
The implementation in `apps/bureau-api/src/services/summon.service.ts`
honors this:

1. `planSummon` calls `resolveAccess` for every occupant in parallel.
2. Recipients with `allowed: false` are split into `deniedRecipients`
   and the audit row's `recipients[]` array stores their outcome as
   `no_access` plus the optional reason.
3. `fanOutSummon` only publishes `summon_incoming` to the
   `eligibleRecipients`. Denied users **receive nothing** — no
   notification, no WS frame, no audit visibility from their side.
4. `reportDenials` pushes a `summon_access_report` back to the summoner
   with the list of denied recipients, so the summoner can decide
   whether to use the §4.4 "Grant access & bring them" follow-up. This
   report is **only** sent to the summoner, never broadcast to the room.
5. Bolt `bureau.summon.issued` is emitted exactly once, from either the
   inline `fanOutSummon` path or the BullMQ offload job. The payload
   reports `recipient_count` (eligible only) so downstream observers
   cannot scrape the denial list out of telemetry.

Unit test `test/summon-access-filter.test.ts` covers the
eligible/denied split and the audit row contract; integration coverage
of the "denied recipients never see a frame" property is implicit
because publishUserTarget is never called for the denied list.

## 4. Token rotation

- **Session cookies** are 7-day TTL by default and rotate on every
  `/auth/login`. There is no idle-rotation today.
- **LiveKit access tokens** minted for `bureau-room-X` carry the
  `@bigbluebam/livekit-tokens` default 1-hour TTL. The client refreshes
  them by re-requesting the token, which re-runs the ACL gate (see §2.3).
  This is the standard LiveKit pattern — short-lived tokens, infinite
  re-mints if access persists, instant revocation if access is removed.
- **bureau API keys** (`bbam_` and `bbam_svc_`) follow the platform
  rotation pattern from migration 0117: a 7-day grace window during
  which both predecessor and current secret authenticate, enabling
  zero-downtime rollover.
- **`INTERNAL_SERVICE_SECRET`**: no in-process rotation today. See
  "Recommendations" §7 for a monthly out-of-band rotation cadence.

## 5. Rate limiting

### 5.1 Fastify global limit

Every bureau-api route inherits the `@fastify/rate-limit` global
ceiling: `RATE_LIMIT_MAX` (default 100) requests per `RATE_LIMIT_WINDOW_MS`
(default 60s) per (IP, route) key. The `BBB_E2E_PERMISSIVE_RATE_LIMIT`
flag from the bam api applies the same multiplier here so E2E and the
Playwright workers do not collide.

### 5.2 Per-WebSocket limit

A per-socket message-rate window in `ws.routes.ts` (`WS_RATE_LIMIT_MAX`
messages per `WS_RATE_LIMIT_WINDOW_MS`, currently 200/10s) closes the
socket with code 4429 on overshoot. This is the only limit on knock /
summon / status-change frequency from a malicious or buggy client.

### 5.3 Per-route ceilings

- `POST /v1/summons`        — global limit only (recipient count is the
  natural cost; large rooms still offload to BullMQ).
- `POST /v1/rooms/:id/knock` — global limit only; the knock-timeout job
  closes pending knocks at 90s so an attacker cannot pin them open
  indefinitely.
- `POST /v1/bookings`       — global limit only; Book performs its own
  per-user/per-day enforcement upstream.

## 6. Known gaps

This is the live gap list, ordered most-to-least urgent for production.

- **D-12 (cross-app preflight) — ✅ CLOSED 2026-06-09 (commit fddda02).**
  board-api and brief-api ship `POST /v1/internal/can-read`, apps/api
  ships `POST /internal/can-read` (via the §11 visibility preflight). The
  eligibility filter is real and `canShare` drives the §4.4 grant dialog
  for Board/Brief. Residual: `stub_allow` remains as the transport-failure
  fallback (a peer outage degrades to the historical permissive behavior
  rather than breaking summons) — flip to fail-closed if the threat model
  hardens.
- **Voice-agent per-org config persistence — ✅ CLOSED 2026-06-09
  (commit ae13fe0, D-5).** Provider config is org-scoped (org-less legacy
  pushes land on a `_global` key) and persists in the
  `voice-agents:provider-config` Redis hash; resolution is memory → Redis
  org key → global key → env. Verified: org config survives a pod restart
  and does not leak into the global view. The agent also honors the D-1
  `calling.global_enabled` kill switch via its Redis mirror at spawn.
- **D-9 WS door-permission unit tests** — `canSetDoor` / `canLockRoom`
  are exercised manually but lack dedicated tests. Adding them is
  Workstream 15 follow-up; the underlying authorization helpers in
  `room-access.ts` are covered by `test/room-access.test.ts`.
- **WS subscribe-vs-message race — ✅ CLOSED 2026-06-10 (commit 539c163).**
  The hub now attaches a buffering `'message'` listener as its first
  statement after upgrade (100-frame cap), swaps in the real handler once
  auth + Redis init complete, and replays the buffered frames in order.
  Notably the bureau-client SDK does NOT wait for `connected` before
  sending — it flushes its outbound queue on socket OPEN — so the race
  was real in production, not just on loopback.
- **Floor occupancy snapshot reads** — `presenceService.snapshotFloor`
  does one HGET per unique room in the floor's occupancy hash. This is
  O(rooms-with-occupants), bounded by floor design, but a malicious
  client that spams `subscribe_floor` against many floors could amplify
  Redis load. The per-socket WS rate limit mitigates this but does not
  cap it. Consider adding a per-(user, floor) cooldown.
- **`SECURITY_HEADERS` are not enforced on bureau-api** — the helmet
  config from apps/api is not yet wired here. Browsers reach bureau
  endpoints through the nginx vhost so the headers that matter
  (HSTS, X-Content-Type-Options) are already set at the edge, but
  defense in depth is missing.

## 7. Recommendations for production

1. **Rotate `INTERNAL_SERVICE_SECRET` monthly.** Today it is set in
   `.env` at deploy time and never rotated. Add a deploy-time rotation
   step that:
   - generates a new value,
   - rolls every internal service (api, banter-api, beacon-api,
     bond-api, board-api, brief-api, bureau-api, mcp-server, worker,
     blueprint-api) with the new value alongside a 7-day grace period
     accepting both,
   - then drops the previous value.
   This mirrors the API-key rotation behavior introduced in migration 0117.
2. **Monitor `bureau_summons` for unusual patterns.** A bench query for
   "users issuing > 10 summons per hour" or "summons with > 20 denied
   recipients" surfaces both legitimate abuse (summon spamming) and
   reconnaissance attempts (summoning to a resource the attacker
   suspects exists, watching the denial report come back). Land this as
   a Bench scheduled report.
3. **Bind the WS message handler before sending `connected`.** ✅ Done
   (2026-06-10, commit 539c163) — implemented as buffer-and-replay rather
   than a reorder, which also covers frames sent before auth completes.
4. **Add WS-level per-(user, floor) cooldown on `subscribe_floor`.**
   3 second floor — 99.9% of legitimate clients only subscribe once
   per page navigation. This caps the snapshotFloor amplification noted
   in §6.
5. **Audit-log every `evaluateRoomAccess` deny.** Today the deny path
   returns `{ allowed: false, reason }` without logging. A denied user
   leaves no trace in the activity log, which complicates incident
   response. Use `actor_type='human'`, `verb='access.denied'`,
   `target_type='bureau_room'`.
6. **Smoke test in CI.** `scripts/bureau-smoke-test.mjs` runs end-to-end
   in ~3s against a seeded stack. Wire it into the deploy pipeline as
   the final pre-traffic check; cost is negligible and it catches every
   regression below the unit-test layer (nginx misconfig, cookie
   handling drift, room-access middleware drift, Redis presence drift).
7. **Wire dedicated D-9 tests for `canSetDoor` / `canLockRoom`.** Pure
   functions over a small input space, < 50 lines of test code.

## 8. Smoke test verification

This audit's "Verification" requirement is satisfied by one full local
run of `scripts/bureau-smoke-test.mjs` against a `docker compose up`
stack with a fresh seed floor + room:

```
$ BUREAU_SMOKE_EMAIL=e2e-admin@bigbluebam.test \
  BUREAU_SMOKE_PASSWORD='E2eTestP@ss123!' \
  node scripts/bureau-smoke-test.mjs

[1] login: ok, cookie length=112, names=[session,csrf_token]
[2] GET /bureau/api/v1/floors: 200, floors.length=1
[3] GET /bureau/api/v1/settings: 200
[4] GET /floors/:id: 200, rooms.length=1, first=eb62c0ab-2168-48dd-83ff-7c57622b3cbc
[5] ws open: connection established
[6] ws connected: received; sending subscribe_floor
[7] ws presence_snapshot: received for floor=4bda090e-82ad-49fb-a32c-9e4aceb83ea3
[8] ws livekit_token: received
[9] ws room_enter: received

bureau smoke test: ALL CHECKS PASSED
```

The seed data used in this run:
- a `bureau_floors` row with `slug='smoke-test-floor'` in the E2E test
  organization (the default e2e admin's org has no Bureau seed today),
- one `bureau_rooms` row (`type='lobby'`, `privacy_default='open'`,
  `name='Smoke Lobby'`) inside that floor.

In CI this seed step should be folded into `scripts/seed-platform.mjs`
so the smoke test runs against any freshly-seeded stack without
operator setup.

Unit test verification (Pieces 1 of Workstream 15):

```
$ pnpm --filter @bigbluebam/bureau-api test

Test Files  5 passed (5)
     Tests  42 passed (42)
  Duration  1.85s
```

- `presence.service.test.ts`        — 14 tests
- `room-access.test.ts`             — 16 tests
- `summon-access-filter.test.ts`    —  4 tests
- `dnd-check.test.ts`               —  7 tests
- `smoke.test.ts`                   —  1 test (placeholder, retained)

Typecheck verification:

```
$ pnpm --filter @bigbluebam/bureau-api typecheck
(no output — exit 0)
```
