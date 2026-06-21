# Synchronous Presence Rollout: Notes & Sharp Edges

Deferred work and known edges from the synchronous-presence rollout
(branch `feat/sync-presence-rollout`). The running decision log is the sibling
`synchronous-presence-rollout-decisions.md`; this file is the "future concerns"
list so they live in the repo rather than being buried in commits.

## Item 1 — 409 stale-write guard

- **Bam task-description frontend not wired.** The backend guard exists and is
  opt-in (harmless when no `expected_updated_at` is sent). The Bam description
  edit is a debounced auto-save through a shared `onUpdate` prop; enabling the
  guard there needs a post-save `updated_at` refresh so a user does not 409
  their own rapid edits. Beacon (load-once, save-once) is fully wired.

## Item 2 — presence chips (T2)

- **One surface per app.** Each of the seven apps got the chip on a single
  canonical detail/editor surface. More surfaces per app (e.g. list rows,
  secondary editors) can follow once true multiuser presence is validated.
- The chip and all of T2/T3/T1 stay silent until the bureau `presence/here` and
  `ring` endpoints are live; mounting them now is safe by design.

## Item 3 — Bond pipeline T1

- **Refetch-based, not patch-based.** A deal event invalidates the deals +
  analytics queries (a refetch), rather than surgically moving one card in the
  cache. Simpler and self-healing; if pipelines get very large, a targeted
  cache update could replace the broad invalidate.
- **One pipeline room per socket.** The board subscribes to the active pipeline
  only; switching pipelines resubscribes. Cross-pipeline moves (deal changes
  pipeline) emit on the destination pipeline's channel.

## Item 4 — Blueprint T3 awareness

- **Edge-selection highlight not rendered.** Remote *node* selections draw a
  colored ring; remote *edge* selections are broadcast (the `selection` frame
  carries `edge_ids`) but not drawn, because edge path geometry on React Flow is
  materially more involved. Adding it later needs no protocol change — just a
  renderer in `remote-selection-overlay.tsx`.
- **No reconnect replay.** Awareness is purely ephemeral: on reconnect a peer
  re-announces via their next cursor/selection move; there is no event-stream
  replay (unlike Board's durable scene stream). Correct for awareness.
- **Idle cursor vs. presence.** Cursors fade after 8s of no movement; an idle
  but present peer's cursor disappears (their selection ring persists until they
  leave). There is no separate heartbeat — acceptable for T3.

## Cross-cutting / environment

- **Redis eviction policy.** During testing the local Redis hit `maxmemory`
  (256M, `noeviction`) and rejected writes (login 500s). Set
  `maxmemory-policy=allkeys-lru` at runtime to recover. RECOMMEND persisting an
  eviction policy / larger `maxmemory` in the redis service config so it does not
  recur. Runtime-only today (reverts on container restart).
- **auth/me 403 for soft-deleted-org users.** Pre-existing, not from this
  branch. Demo users `alice`/`bob` point at a soft-deleted org with no
  `organization_memberships` rows, so login 200s but every authed call 403s
  (`apps/api/src/plugins/auth.ts` rejects a soft-deleted fallback org). Tracked
  as task #16; the smokes used the healthy `e2e-admin` org to work around it.
  Needs a product/data decision (which org orphaned users belong to), not an
  autonomous guess.
- **Pre-existing api test drift.** `apps/api` `test/visibility.service.test.ts`
  has 2 banter public-channel cases asserting the old "deny non-member" behavior
  that the shipped "public channels org-readable" feature intentionally allows.
  Tracked as task #15; not touched by this branch.
