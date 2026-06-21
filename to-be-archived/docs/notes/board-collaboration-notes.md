# Board collaboration — design notes, sharp edges, and future work

This document captures the design decisions for Board's real-time collaboration + persistence model so future agents and human collaborators don't have to re-derive them. It accompanies the `board-fixes` PR series that introduced cross-replica determinism (migration 0143, the BoardRedisState helper, the reconnect-replay protocol, and the integrity check + alert UX).

## Architecture summary

### Persistence

- **Source of truth: `boards.yjs_state`** (bytea column in `apps/board-api/src/db/schema/boards.ts`). Despite the column name, the content is **JSON**, not a Yjs CRDT — it's the Excalidraw scene shape `{elements, appState, files}` UTF-8-encoded as bytes. The column name is a holdover from an earlier design.
- **Denormalized snapshot: `board_elements`** rows. Populated by `apps/board-api/src/services/element-snapshot.service.ts` whenever a scene persists. Used for search indexing (GIN fulltext on `text_content`), per-board element counts in the All Boards card, and individual-element MCP tool access. **Not authoritative** — if it's empty but `yjs_state` is non-null, the listBoards `element_count` falls back to parsing the JSON.

### Save paths (ordered by latency, all of them write the same scene)

1. **localStorage** (`board-canvas.tsx`, 500ms debounce). Per-device cache, survives refresh, useless cross-machine.
2. **HTTP PUT `/boards/:id/scene`** (`board-canvas.tsx`, 3s debounce). Authoritative cross-machine save when the user pauses.
3. **WS `scene_update`** (`use-board-sync.ts`, 150ms throttle). Real-time broadcast → `BoardRedisState.setDirty()` marks the scene dirty in Redis.
4. **`navigator.sendBeacon` to `/boards/:id/scene/beacon`** (`board-canvas.tsx`, on `beforeunload` and `pagehide`). Survives tab close. Persists straight to `boards.yjs_state` (skips the Redis dirty hash) so the durable write lands before the tab dies.
5. **Periodic 5s flush** (`handler.ts` interval). Each replica scans Redis for `board:dirty:*` keys and `takeDirty()`s them atomically (Lua GET+DEL), then `saveScene()`s. Multiple replicas can scan concurrently — the atomic take means only one replica writes any given board.
6. **Last-collaborator-leaves flush** (`handler.ts::maybeFlushOnRoomEmpty`). When a replica's local client count for a board hits zero, it tries `SETNX board:flush_lock:<boardId>` with 10s TTL; whoever wins persists immediately. Closes the tab-close-mid-stroke window.

### Real-time sync (cross-replica)

All collaboration state is in Redis so any replica can serve any client:

- `board:events` — pub/sub channel for scene + presence updates. Subscribed by every replica; messages tagged with the originating instanceId so the publisher doesn't re-receive its own broadcast.
- `board:cursors` — separate pub/sub channel for cursor-position updates. Originally local-only ("skip Redis to save bandwidth" was the comment), now cross-instance because the user requirement is "cursors must work the same regardless of deployment topology." Separated from `board:events` so high-volume cursor traffic can't backpressure scene/presence subscribers.
- `board:dirty:<boardId>` — the latest unpersisted scene + orgId, atomically taken-and-flushed.
- `board:flush_lock:<boardId>` — SETNX'd 10s lock that pins the room-empty flush to one replica.
- `board:events:<boardId>` — `XADD MAXLEN ~ 500` stream of `scene_update` events. Backs the reconnect-replay protocol.

### Reconnect replay

Every `scene_update` includes a `seq` (Redis stream id, monotonic). The frontend tracks the most recent `seq` it observed. When the WS drops and reconnects, the client sends `last_seen_seq` on the new `join_board`; the server `XRANGE`s the stream from that point and replays every missed event as a single `replay` message before broadcasting `user_joined`. Closes the data-loss window where peer edits during a reconnect gap used to be silently dropped.

### Integrity checks

Migration 0143 introduced a DB trigger `boards_project_org_alignment_check_trg` that rejects any INSERT or UPDATE that would leave `boards.organization_id != projects.org_id`. The service layer's `assertProjectOrgAlignment` in `board.service.ts` runs the same check earlier so clients see a structured `BoardError('PROJECT_ORG_MISMATCH', 400)` instead of the DB's check_violation. Existing rows with the misalignment were detached (project_id := null) by the same migration, with audit rows in `board_integrity_audit` capturing the original project_id.

The list response includes `integrity_issue_count` (inline CASE expression) so the All Boards card grid renders an amber `AlertTriangle` for any board needing attention. Per-board details come from `GET /boards/:id/integrity`. The canvas-page banner offers two remediation actions: Detach (project_id := null) or Reassign (pick a project in the user's current org).

## Sharp edges to avoid (READ BEFORE EXTENDING)

1. **`yjs_state` is misnamed JSON, not Yjs.** Don't introduce a real Yjs library and try to use this column without renaming. The bytes are `JSON.stringify({elements, appState, files})` UTF-8. If/when a real CRDT path is needed, add a new column rather than reinterpreting this one.

2. **Redis is a hard dependency for collaboration correctness, not just scale.** If Redis is down, scene sync degrades to "single-replica best-effort" (the local broadcast still works, the dirty hash falls through to nothing, room-empty flushes don't fire, and reconnect replay is empty). Failures are silently swallowed in `BoardRedisState` so the WS connection stays alive — but nobody's collaboration is going to be deterministic in that state. Document this in the operator runbook.

3. **Don't put the docker socket inside the certbot sidecar / any board-api sidecar.** Renewal coordination and any persist-side hooks live on the host, not inside containers. Same posture as local-ssl.

4. **The Redis stream cap is 500 entries (MAXLEN ~ 500).** That's roughly 5-10 minutes of single-user editing or ~30 seconds of a 5-person team going hard. If a client's `last_seen_seq` is older than the oldest entry in the stream, the replay returns an incomplete history and the client effectively loses any edits between those two points. The frontend should detect this case (server replay returned events but stream-trimmed events are missing) and fall back to a full REST `/scene` resync. Currently it doesn't — `use-board-sync.ts` trusts the replay completeness. Worth adding a "replay window exhausted" signal in a follow-up.

5. **`element_count` fallback is parser-driven.** The COALESCE expression in `listBoards` parses `yjs_state` as JSON and counts the `elements` array. If a future schema change writes non-JSON to `yjs_state` (real CRDT bytes, etc.) the parse will throw and the count will silently become NULL, which COALESCEs to NULL not 0. Test before any `yjs_state` format migration.

6. **Cursor traffic on Redis is modest at current scale.** ~7 messages/second per drawing user × 4 concurrent users = ~28 msg/sec per board. Redis pub/sub handles that easily but it's the largest variable cost in the system. If a future scale event makes it expensive, the answer is per-room cursor channels (`board:cursors:<boardId>`) rather than the previous "skip Redis" optimization.

7. **The flush-on-room-empty lock is 10 seconds.** Long enough that a slow disk write doesn't expire mid-flush; short enough that a crashed replica releases its lock quickly. If `saveScene` ever exceeds 10 seconds on a heavily-loaded DB, two replicas could each acquire the lock back-to-back and double-flush. Last-write-wins, so it's not a correctness bug, but it wastes cycles. Bump the TTL if you ever see it happen.

8. **The reconnect-replay path bypasses the rate limiter on the client message receive side.** The server emits one `replay` message per join, regardless of how many events it contains. So a client coming back from a 4-minute disconnect with 500 events buffered hits a single big `replay` apply. The client-side debounced `applyPending` handles this fine in current testing; if you ever see UI lag on a reconnect, batch the replay events into chunks.

9. **localStorage `board-{id}` cache survives a board's permanent deletion.** If User A draws on board X, X is deleted by User B, A revisits the URL, the local cache renders the deleted board's content as if nothing happened — until A's WS connect fails with an access error. Worth invalidating the localStorage entry on a 403/404 from `/scene` REST. Currently it doesn't.

10. **OAuth callback URLs vs scheme switches.** Same caveat as the local-ssl notes — if the operator changes the BBB BASE_URL between deploys, OAuth provider consoles need an update. Not a Board-specific issue but the WS auth flow rides the same session cookie, so a partial OAuth break manifests as "Board WS won't authenticate."

## Deferred work

These items were considered and deferred. Don't re-relitigate without reading this:

- **Stream-window-exhausted signal** (sharp edge #4). When `last_seen_seq` is older than the oldest entry in `board:events:<boardId>`, the server should respond with `{ type: 'replay_window_exhausted' }` instead of a partial replay; the client falls back to a full REST `/scene` resync. Easy to add but needs a server-side stream-tail check.
- **Per-room cursor channels** (sharp edge #6). Today every replica receives every cursor update for every board the user base is editing, then filters locally by room. At BBB's current scale this is fine; at 100s of concurrent boards it stops being fine. Move to `board:cursors:<boardId>` when room count outgrows the shared channel's wire cost.
- **Sticky session affinity at the LB layer.** The cross-replica path works without sticky sessions, but adding sticky sessions reduces Redis traffic to near-zero for the steady state. Worth doing on Railway / AWS ALB / k8s ingress if scale grows. Right now BBB on Railway probably runs single-replica anyway.
- **Server-side conflict resolution for true concurrent edits.** The reconcile path on the client uses Excalidraw's `version` + `versionNonce` fields which is a last-write-wins-with-element-uniqueness model. If two users edit the same shape in the same millisecond, one of them loses their edit. A real CRDT (real Yjs in this case, despite the column name) would fix this — large project, deferred.
- **Audit-log surfacing of `board_integrity_audit` to a SuperUser dashboard.** The audit rows from migration 0143 capture pre-fix state; nobody currently reads them. A future operator-facing "boards that have been auto-detached" view would help triage data drift incidents.

## Verification recipes

### Single-replica (default) sanity

```sh
docker compose up -d
# Open http://localhost/board/ in two browser windows
# Sign in same user, open the same board
# Window A draws → Window B sees within ~150ms
# A closes tab mid-stroke → B's tab still shows the drawing
# Reload B → /scene fetches the persisted version, matches what was on canvas
```

### Multi-replica determinism

```sh
docker compose -f docker-compose.yml -f docker-compose.multi.yml up -d board-api board-api-2
# Browser A: navigate to a board via http://localhost/board/<id> as usual
# (will hit board-api via nginx; nginx round-robins or sticks)
# Browser B: navigate via http://localhost:4108/board/ws directly with WS DevTools,
# OR run a WS client against ws://localhost:4108/ws/...
# Verify scene + cursor sync between them.
```

### Integrity backfill verification

```sh
# Migration 0143 should have written rows. Inspect:
docker compose exec postgres psql -U bigbluebam -d bigbluebam \
  -c "SELECT * FROM board_integrity_audit ORDER BY created_at DESC LIMIT 10;"
# If you have a misaligned board to test the alert UX:
# 1. Open it in the browser. Banner appears at the top of the canvas.
# 2. Click Reassign. Pick a project. Banner disappears, audit row written
#    with remediation='user_reassigned'.
```

## Cross-references

- The migration that introduced the trigger and backfill: `infra/postgres/migrations/0143_board_project_org_alignment.sql`.
- The Redis-backed WS state helper: `apps/board-api/src/ws/redis-state.ts`.
- The integrity service entrypoints: `apps/board-api/src/services/board.service.ts` (`assertProjectOrgAlignment`, `checkBoardIntegrity`, `remediateBoardIntegrity`).
- The frontend integrity surfaces: `apps/board/src/components/list/board-card.tsx` (card indicator), `apps/board/src/components/canvas/board-integrity-banner.tsx` (canvas banner + remediation dialog).
- The plan that drove this work was discussed in conversation; the file-by-file punch list is in this commit series.
