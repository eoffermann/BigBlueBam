# Bureau §9 Strategy B — Continuous-Audio Handoff

End-to-end walk-through of the continuous-audio teleport from a Bureau spatial
room into a Board canvas, with continuous audio surviving the cross-app
navigation. Brief follows the same protocol with a hidden audio renderer
instead of a full call panel.

This document is the confirmation artifact for Workstream 11 of the Bureau
rollout. The wire it describes is fully built; the only un-shut gaps are
called out at the bottom under *Known gaps*.

---

## Cast of characters

- **Eddie** — summoner. Already in a Bureau room with continuous audio
  enabled, presence frame says he's currently looking at a Bureau room.
- **Teeny** — recipient. In the same Bureau room as Eddie, has a Bureau WS
  client open, is on the room's ACL.
- **War Room** — `bureau-room-abc12345-...` (a real UUID). Has continuous
  audio enabled. Two LiveKit participants are publishing today: Eddie and
  Teeny.
- **Board "Q3 Roadmap"** — board id `Q3R` (shortcode). The bureau-client has
  classified this as `app: 'board'` for §10 step 4 routing.

## Step 1 — Both users are in the Bureau War Room

Both clients have mounted `mountBureauClient(...)` from
`@bigbluebam/bureau-client` inside their host SPA. The SDK has opened a
WebSocket to `/bureau/ws`, joined the user's `user:{id}` Redis channel via
the WS hub, and joined the LiveKit room `bureau-room-abc...` via the docked
box's media pipeline. Audio is flowing.

Both clients heartbeat presence; the worker's reaper (15s) keeps presence
fresh. Eddie's docked-box UI shows "Bureau · War Room · 2 here".

## Step 2 — Eddie navigates Board into focus, inside Bureau

Eddie clicks a Board link (`/board/b/Q3R`) from a Banter message or his
sidebar. The host SPA pushes the new route. The bureau-client emits a
`location_update` frame on the WS describing the new in-app location:

```jsonc
{
  "type": "location_update",
  "app": "board",
  "url": "/board/b/Q3R",
  "label": "Q3 Roadmap"
}
```

bureau-api now knows Eddie's foreground is "Board Q3 Roadmap" while his
presence is still pinned to War Room (the audio is unchanged — he's still
in the LiveKit room).

## Step 3 — Eddie hits "Bring everyone here" in BureauDockedBox

The dock renders the summon button when Eddie's `location.app !== 'bureau'`.
On click it POSTs to bureau-api's `POST /v1/summons` with the current
foreground location + the room id (`from_room_id`). The frontend records the
attempt in its own optimistic UI and waits for the response.

## Step 4 — `summon.service.ts` plans the summon (Phase 4 inline path)

bureau-api's summon service runs in two phases:

1. **Plan.** Loads the from-room's eligible-recipient set (presence ∪ ACL ∪
   ad-hoc, minus the summoner). For each recipient, calls the cross-app
   access preflight at
   `apps/bureau-api/src/services/cross-app-access.service.ts`. Today that
   service tries to live-call the target satellite's `/v1/internal/can-read`
   (board-api in this example) and, on the absence of that route or any
   network error, returns `{ allowed: true, reason: 'stub_allow' }`. This
   `stub_allow` posture is intentionally lenient until D-12 lands the real
   per-app preflight surface (see *Known gaps* below).
2. **Persist + fan out.** A `bureau_summons` audit row is written with
   `target_url`, `target_app`, `livekit_room_hint = 'bureau-room-abc...'`,
   and the full `recipients[]` array. If `recipients.length <=
   FANOUT_INLINE_LIMIT`, the service publishes `summon_incoming` frames
   inline. Otherwise it enqueues `bureau-summon-fanout` on BullMQ and the
   worker processes the list with its own access re-check (see
   `apps/worker/src/jobs/bureau-summon-fanout.ts`).

In our scenario there's exactly one recipient (Teeny), so the inline path
fires.

The fan-out (inline or worker) publishes this frame on `user:{teeny}`:

```jsonc
{
  "type": "summon_incoming",
  "summonId": "...",
  "summoner": { "id": "eddie-id", "name": "Eddie" },
  "targetUrl": "https://host/board/b/Q3R",
  "app": "board",
  "label": "Q3 Roadmap",
  "lkRoomHint": "bureau-room-abc12345-...",
  "autoFollow": false
}
```

## Step 5 — Teeny's SummonHandler reacts

Teeny's bureau-client receives the `summon_incoming`. The handler in
`packages/bureau-client/src/summon-handler.tsx` queues it and renders the
Join/Stay toast (§4.4 of the design doc). Teeny clicks **Join**.

The handler:

1. Sends `summon_respond { decision: 'join' }` back over the WS.
2. Computes the navigation target by appending the lkRoom hint to the URL,
   via `appendLkRoom()`:

   ```ts
   `${url}${url.includes('?') ? '&' : '?'}lkRoom=${encodeURIComponent(lkRoom)}`
   ```

   Producing `/board/b/Q3R?lkRoom=bureau-room-abc12345-...`. Note that the
   worker fan-out path (`apps/worker/src/jobs/bureau-summon-fanout.ts`) does
   NOT append the query param — it ships the bare `targetUrl` + `lkRoomHint`
   field on the WS frame, and the *client* is responsible for combining
   them. This keeps the WS payload canonical and lets clients decide
   whether to honor the hint (e.g. if continuous audio is disabled in the
   user's settings, they can simply drop the query).

3. Calls the host adapter's `navigate(stripOrigin(target))`.

## Step 6 — Board mounts the audio controls

Teeny's SPA routes to `/board/b/Q3R/?lkRoom=bureau-room-abc12345-...`. The
canvas page renders `AudioControls` (`apps/board/src/components/canvas/
audio-controls.tsx`), which on mount calls `readLkRoomFromUrl()` and
snapshots the override:

```ts
const [lkRoomOverride] = useState<string | undefined>(() => readLkRoomFromUrl());
```

The strict format gate in `readLkRoomFromUrl` (matching
`bureau-room-<uuid>`) means any other query value yields `undefined` and the
audio panel quietly falls back to its canonical room. The snapshot via
`useState(initializer)` is deliberate: a subsequent in-app route change
won't change the room mid-call.

`useBoardAudioToken(boardId, lkRoomOverride)` then POSTs to
`/b3/board/api/v1/boards/Q3R/audio/token` with body `{ lk_room:
'bureau-room-abc...' }`.

## Step 7 — board-api authorizes and mints

`apps/board-api/src/routes/audio.routes.ts` runs the standard board read
check (org membership + visibility/project/collaborator). Then it calls
`generateBoardAudioToken(boardId, userId, userName, body.lk_room)` in
`apps/board-api/src/services/livekit.service.ts`.

The service:

1. **Format gate.** `isValidAudioRoomName(override)` accepts only
   `board-<uuid>` or `bureau-room-<uuid>`. Anything else falls back to the
   canonical `board-${boardId}` room.
2. **Bureau ACL preflight.** When the override starts with `bureau-room-`,
   the service extracts the UUID and calls
   `GET http://bureau-api:4015/v1/internal/can-join-room/:roomId/:userId`
   with the shared `X-Internal-Service-Secret`. bureau-api consults
   `bureau_rooms` + `bureau_room_acl` + `organization_memberships` to
   answer (see `apps/bureau-api/src/routes/internal.routes.ts`).
3. If bureau-api returns `{ allowed: true }`, the override is honored and
   `roomName = 'bureau-room-abc...'`. If `false` (or any network error /
   missing secret), the service **fails closed**: it falls back to the
   canonical board room `board-Q3R`. The Board audio call still works,
   it's just no longer the same LiveKit room as Eddie — so continuous
   audio drops, but the user isn't blocked from the board.
4. A LiveKit JWT is minted for `roomName` with the user's display name,
   audio publish/subscribe grants, and a 1-hour TTL.

board-api responds `{ data: { token, room_name, ws_url } }`.

## Step 8 — Audio survives

Board's `AudioControls` receives the token, sets `isConnected = true`, and
renders a `LiveKitRoom` that joins `bureau-room-abc...`. Eddie was already
publishing in that room from his Bureau dock. The LiveKit SFU sees Teeny
arrive on the same room — no renegotiation from Eddie's perspective, no
audible glitch. **The call never drops.**

The toolbar shows participant count, Eddie's speaking indicator works, mute
works. Teeny is now seeing the Q3 Roadmap board while listening to Eddie
explain it.

---

## Brief variant

For a summon landing on Brief instead of Board:

- `ContinuousAudioWidget` in
  `apps/brief/src/components/continuous-audio-widget.tsx` mounts only when
  `?lkRoom=` is present and matches the `bureau-room-<uuid>` shape;
  otherwise it renders nothing. This is the **common-case render: no
  widget**. Brief has no native call surface, so this stub exists purely to
  keep the call alive during cross-app navigation.
- `brief-api`'s `POST /v1/documents/:id/audio/token` accepts only
  `bureau-room-<uuid>` (`isValidBureauRoomName`); there is no canonical
  fallback. A missing or malformed `lk_room` is a 400.
- The bureau ACL preflight in `apps/brief-api/src/services/livekit.service.ts`
  is **mandatory**: there is no fallback room. A denial throws
  `BureauRoomAccessDeniedError`, which the route translates to a 403 with
  code `BUREAU_ROOM_ACCESS_DENIED`. The widget then never reaches the
  `LiveKitRoom` mount (token is null) and renders nothing.

This means Brief's bureau-room handoff is strictly **all-or-nothing**: you
either join the same LiveKit room Eddie is in, or you see no audio widget
at all. There's no half-state where Brief mints a token for a Brief-local
room — that room doesn't exist.

---

## Known gaps (won't be perfectly water-tight until these close)

These are the seams that prevent today's wire from being the final story.
None of them is a blocker for the Bureau v0 rollout; all are tracked work.

1. **D-12: real cross-app access preflight.**
   `apps/bureau-api/src/services/cross-app-access.service.ts` currently
   returns `{ allowed: true, reason: 'stub_allow' }` whenever the target
   satellite's `/v1/internal/can-read` is unavailable or returns a non-2xx.
   Until that endpoint exists on every satellite, the summon planner is
   over-permissive: it routes summons to recipients who may not have read
   access to the target. The worker fan-out has the same fallback. This
   gets tightened in D-12, after which `stub_allow` is replaced by a
   policy-driven deny on missing preflight.
2. **board-api now calls `/v1/internal/can-join-room`** (this workstream
   added it). However, the docker-compose env for board-api and brief-api
   relies on the `BUREAU_API_INTERNAL_URL` default
   (`http://bureau-api:4015`). The compose service names match the
   default, so the wire works at runtime, but explicit
   `BUREAU_API_INTERNAL_URL` and `INTERNAL_SERVICE_SECRET` lines should be
   added to the board-api and brief-api compose stanzas in a follow-up
   for documentation clarity (the secret is already wired through; the
   URL is wired through the default).
3. **No knock fallback on denied bureau-room ACL.** If bureau-api denies
   board-api's mint preflight, Board silently falls back to the canonical
   board room. There's no UI signal that the continuous-audio link
   broke. A user-friendly future iteration would surface a toast like
   "You're not in War Room — joining Board audio instead." For Brief,
   the 403 from the audio token route currently surfaces nothing in the
   UI (the widget just renders null). A future iteration could render a
   small "Audio unavailable" badge or trigger the knock flow for the
   bureau room.
4. **Token TTL is fixed at 1 hour.** A long continuous-audio session that
   crosses the boundary will get a re-mint via the React Query
   `refetchInterval` (10 min). On re-mint the bureau ACL is re-checked,
   so a revoked permission propagates within ~10 min. There is no live
   revocation signal pushing a disconnect today.
5. **No metrics / Bolt event when a bureau-room mint is denied at the
   board-api / brief-api boundary.** Today the denial logs and the
   request 403s, but there's no aggregate visibility into how often
   summons land on a denied target. Hooking a Bolt event from these
   denials would help us catch over-permissive summon planning.

---

## File map

| File | Role |
| --- | --- |
| `apps/board/src/components/canvas/audio-controls.tsx` | Snapshots `?lkRoom=` on mount, passes to `useBoardAudioToken`. |
| `apps/board/src/hooks/use-audio.ts` | `readLkRoomFromUrl` validator + token query. |
| `apps/board-api/src/routes/audio.routes.ts` | Org/visibility/collaborator/project read checks, then service call. |
| `apps/board-api/src/services/livekit.service.ts` | Format gate + bureau ACL preflight + LiveKit JWT mint. Falls back to canonical room on denial. |
| `apps/brief/src/components/continuous-audio-widget.tsx` | Mounts only when `?lkRoom=` validates; hidden audio renderer + status bubble. |
| `apps/brief/src/hooks/use-continuous-audio.ts` | `readLkRoomFromUrl` validator + token query. |
| `apps/brief-api/src/routes/audio.routes.ts` | Document read check + format gate; surfaces `BureauRoomAccessDeniedError` as 403. |
| `apps/brief-api/src/services/livekit.service.ts` | Format gate + mandatory bureau ACL preflight + LiveKit JWT mint. No fallback. |
| `apps/bureau-api/src/routes/internal.routes.ts` | `GET /v1/internal/can-join-room/:roomId/:userId` — the authority. |
| `apps/bureau-api/src/services/cross-app-access.service.ts` | Summon-time preflight (returns `stub_allow` until D-12). |
| `apps/worker/src/jobs/bureau-summon-fanout.ts` | Worker path; same `stub_allow` posture as the inline service. Publishes `summon_incoming` with `lkRoomHint` field. |
| `packages/bureau-client/src/summon-handler.tsx` | Receives `summon_incoming`, calls `appendLkRoom(targetUrl, lkRoomHint)`, navigates. |
