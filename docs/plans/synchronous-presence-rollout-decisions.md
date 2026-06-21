# Synchronous Presence Rollout: Decision Log

Running record of decisions made while implementing
`synchronous-presence-rollout-by-app.md` on branch `feat/sync-presence-rollout`.
Each entry is a decision, the rationale, and how to reverse it if wanted. Newest
at the bottom. Work is autonomous; this log is so the choices can be revisited.

## Ground rules I am holding myself to

- **Do no harm to current functionality.** Every change must be additive or
  backward-compatible. Multiuser behavior is tested later, but single-user and
  existing flows must keep working, proven by a Playwright smoke per change.
- **Rebuild the affected local containers** after each backend/frontend change,
  then smoke-test against the running stack.
- **Commit per completed, tested unit** on this branch, with a clear message.
- **Stop short of risky scope.** Beacon T4 (full co-editing) is explicitly a
  separate deliberate call in the plan; I will NOT build it autonomously.

## Order of work (from the plan's "Suggested order")

1. 409 stale-write guard convention (shared helper) + apply to Beacon entry and
   Bam task description. Highest data-loss risk, lowest cost.
2. Presence chips (T2) on the seven apps without them: Bearing, Bench, Bolt,
   Blast, Book, Blank, Bill.
3. Bond pipeline T1 (live drags), copying Blueprint's invalidate hub.
4. Blueprint T3 awareness (cursor + selection overlay), reusing Board's ephemeral
   channel.
5. Beacon T4: DEFERRED (separate deliberate call, per the plan).

## Decisions

### 2026-06-21 — Item 1: 409 stale-write guard

1. **Used `expected_updated_at` (timestamp), not a `version` counter.** A
   `version`-counter optimistic-concurrency already exists for org member role
   updates (`org.routes.ts`, P1-25). I did not reuse or refactor it: the target
   tables (`tasks`, `beacon_entries`) have `updated_at` but no version column, and
   the plan specifies `expected_updated_at`. The two conventions now coexist.
   *Reverse:* if timestamp precision ever causes false 409s, switch these surfaces
   to a version counter.

2. **Guard lives at the route level, not in the update services.** Keeps it
   isolated and backward-compatible with zero changes to existing update logic, at
   the cost of one extra `SELECT updated_at` when the guard is actually used.
   *Reverse:* fold into the services if that read ever matters.

3. **The field is a loose `z.string().optional()`, not `z.datetime()`.** A
   malformed token never 400s; `isStaleWrite` treats anything unparseable as
   "no guard" (degrade to last-write-wins). Shared module:
   `packages/shared/src/schemas/stale-write.ts`, error code `STALE_WRITE`.

4. **Wired the Beacon editor frontend; DEFERRED the Bam task-description
   frontend.** Beacon's save is an explicit button that navigates away
   (load-once, save-once), so sending the guard token is low risk; it also has an
   overwrite path (after a 409, Save again omits the guard). Bam's task
   description is a *debounced auto-save* routed through a shared `onUpdate` prop;
   sending a stale token there risks 409ing the user's own rapid edits unless the
   cached `updated_at` is refreshed after every debounced save. That is fiddly and
   not safely multiuser-testable tonight, so I left the Bam **backend** guard in
   place (opt-in, harmless) and did not flip the Bam frontend on. *Next:* wire Bam
   description with a post-save `updated_at` refresh, then enable.

5. **Pre-existing, unrelated test failures left alone.** `apps/api`
   `test/visibility.service.test.ts` has 2 failing banter public-channel cases
   that expect "deny non-member of a public channel," but the shipped
   "public channels org-readable" feature allows it. Stale test drift, not from
   this branch (I touched none of those files). Recorded as a follow-up; not fixed
   here to keep the branch focused.

6. **Verification of Item 1.** Beacon guard proven LIVE with a self-cleaning
   Playwright/API smoke: create (201) -> PUT with a stale token (409 STALE_WRITE,
   returns current_updated_at) -> PUT with the correct token (200) -> PUT with no
   token (200, backward compat) -> retire. The Bam guard is verified by code
   parity (identical route-level pattern + the same shared helpers), 8 shared unit
   tests, apps/api typecheck, and the api unit suite (653 pass; the only 2 failures
   are the unrelated pre-existing visibility tests above). A live Bam curl was
   blocked only by test-user limits (alice@example.com has no org membership; the
   gilligan demo password is not the seed default), not by the product. The Bam
   guard is opt-in and dormant (frontend deferred), so it cannot change current Bam
   behavior. Smoke scripts are run then deleted, not committed; the committed
   regression coverage is the shared unit test.

7. **Environmental fix, not feature code: Redis OOM.** Mid-testing the local Redis
   hit maxmemory (256M, policy noeviction, ~197k keys) and began rejecting writes,
   surfacing as intermittent HTTP 500 on session writes (login). I set
   maxmemory-policy=allkeys-lru at runtime so it evicts old ephemeral keys
   (sessions/cache) instead of OOMing. Postgres and MinIO untouched. Runtime-only
   (reverts if the redis container restarts). RECOMMEND, as a separate dev-stack
   fix, persisting an eviction policy and/or a larger maxmemory in the redis
   service config so this does not recur.

### 2026-06-21 — Item 2: presence chips (T2) on the seven remaining apps

1. **Mounted `PresenceChipStrip` on one canonical single-entity surface per app.**
   Surfaces chosen, each placed in the entity header next to the title and after
   the page's existing loading/null guards (so the entity is always in scope):
   - **Bearing** — `GoalDetailPage` (`goal.id` / `goal.title`)
   - **Bench** — `dashboard-view` (`dashboard.id` / `dashboard.name`); the chip
     went on the *view* page, not `dashboard-edit` (whose title is the static
     string "Edit Dashboard", a poor presence surface).
   - **Bolt** — `automation-editor`, gated on `id && existing?.data`
     (`automation.id` / `automation.name`).
   - **Blast** — `campaign-detail` (`campaign.id` / `campaign.name`); the
     campaign, not the template editor, is where a user dwells.
   - **Book** — `booking-page-editor`, gated on `!isNew && existing`
     (`bookingPage.id` / `bookingPage.title`); the booking page is the
     most-configured single entity.
   - **Blank** — `form-builder`, gated on `form` (`form.id` / `form.name`).
   - **Bill** — `invoice-detail` (`invoice.id` / `invoice.invoice_number ??
     invoice.id`).
   *Rationale:* one well-chosen surface per app proves the pattern and matches the
   bond/beacon precedent without a sprawling first pass. More surfaces per app can
   follow once multiuser presence is validated end to end.

2. **Editor surfaces gate the chip behind a saved entity id.** Bolt, Book, and
   Blank only mount the chip once the record exists (no id on the "new/unsaved"
   path), because an unsaved draft has no shared canonical URL to gather presence
   on. Detail/view surfaces (Bearing/Bench/Blast/Bill) always have an id by the
   time they render past their null guard.

3. **Extended the shared `PresenceSurfaceApp` union additively** in
   `packages/ui/presence-chip-strip.tsx` with `bench`, `bearing`, `bolt`, `blank`,
   `bill`, `book`, `blast`. Purely additive (widens a string-literal discriminator)
   so the seven apps that already consumed the component (brief/board/blueprint/
   bond/bam/beacon/helpdesk) are untouched. The seven concurrent edits to this one
   file settled with all slugs retained (verified on disk).

4. **Added the `@bigbluebam/ui/presence-chip-strip` Vite alias** to each app's
   `vite.config.ts` (it was missing in all seven; bond/beacon already had it). TS
   resolves the import through the `packages/ui` `exports` map, so no tsconfig
   `paths` change was needed; the runtime bundler alias is what was absent.

5. **Verification.** All seven apps typecheck clean individually and together
   (`pnpm --filter ... typecheck`, 7/7 Done). The change is additive and the
   component renders nothing when no other user is present (and fails silently
   until the bureau `presence/here`/`ring` endpoints are live), so it cannot alter
   current single-user behavior. Rebuilt the monolithic `frontend` image (serves
   all SPAs) and ran a Playwright smoke per surface confirming each page still
   loads and renders its entity with no uncaught errors and no layout regression.

6. **Smoke result: 7/7 surfaces OK.** Logged in (alice@example.com) and loaded
   all seven detail/editor routes against the rebuilt stack
   (`/bearing/goals/:id`, `/bench/dashboards/:id`, `/bill/invoices/:id`,
   `/blast/campaigns/:id`, `/bolt/automations/:id`, `/blank/forms/:id/edit`,
   `/book/booking-pages/:id/edit`). Each rendered its entity with no `pageerror`.
   Seeded one Book booking page first (alice's org had zero). Smoke + probe
   scripts were run then deleted (not committed), matching the Item 1 precedent;
   the durable coverage is the per-app typecheck plus this recorded run.

7. **Discovered (pre-existing, NOT this branch): `/b3/api/auth/me` 403 for
   demo users on a soft-deleted org.** The smoke's only console noise was a 403
   on `GET /b3/api/auth/me`. Root-caused: alice/bob have `users.org_id` pointing
   at org `seed-smoke-36`, soft-deleted 2026-06-15, and no `organization_memberships`
   rows; `resolveOrgContext` (apps/api/src/plugins/auth.ts:126-141) falls back to
   the legacy org_id but rejects it because the org is soft-deleted, while login
   uses a more lenient path — so login 200s and every authed call 403s. This is
   the same thing that blocked the Bam live smoke in Item 1. It is independent of
   the presence change (the chip never calls auth/me), affects all apps equally,
   and does NOT touch Eddie's own (healthy) accounts. Recorded as task #16 with
   fix options; left unfixed because the right remedy is a product/data design
   call (which org should orphaned users belong to), not something to guess
   autonomously.

### 2026-06-21 — Item 3: Bond pipeline T1 (live deal updates)

1. **Copied Blueprint's proven invalidate-hub pattern rather than inventing
   one.** Blueprint already does Redis-PubSub-per-entity -> per-socket Redis
   subscriber -> WS fan-out -> client `invalidateQueries`. Bond had no WS route
   at all (only Bolt events on deal moves). New pieces, all modeled on the
   blueprint files line-for-line:
   - `apps/bond-api/src/lib/broadcast.ts` — `broadcastToPipeline(redis, pipelineId, event)`
     on channel `bond:<pipelineId>`, fire-and-forget (a Redis failure never
     blocks the mutation).
   - `apps/bond-api/src/routes/ws.routes.ts` — `GET /ws`, subscribe protocol
     `{ type:'subscribe', pipeline_id }`, gated by the same `getPipeline(id,
     orgId)` org check the REST routes use (throws -> FORBIDDEN frame), 25s
     ping keepalive, per-socket Redis subscriber.
   - `apps/bond/src/hooks/use-pipeline-sync.ts` — connects to `/bond/ws`,
     subscribes to the active pipeline, invalidates `['bond','deals']` +
     `['bond','analytics']` (200ms trailing debounce), capped-backoff reconnect.
     Mounted in `pipeline-board.tsx`.

2. **Broadcast on every board-changing deal mutation, not just stage move.**
   The user story is "live drags," but create/update/delete/close/restore/
   duplicate all visibly change the board, so each route now broadcasts a typed
   `DealEvent`. The client invalidates on any `bond.deal.*`, so the event detail
   is advisory. DELETE has no returned deal, so the route reads the deal's
   `pipeline_id` via `getDeal` before the soft-delete (getDeal's notFound throw
   also yields the correct 404).

3. **Self-echo intentionally not filtered** (same as Blueprint): the mutating
   client already refetched via the mutation's `onSuccess`; the WS-triggered
   refetch is a cheap no-op and self-heals optimistic drift.

4. **Backward-compatible / no-harm:** the WS is pure read-only fan-out (no
   writes flow over it); if `/bond/ws` is unreachable the hook silently retries
   and the board behaves exactly as before (refetch-on-action). Added the
   `@fastify/websocket@^11` dep to bond-api and registered the plugin + route in
   `server.ts`. Added the `/bond/ws` proxy block to ALL THREE nginx configs
   (`nginx.conf`, `nginx-with-site.conf` [the local bind-mounted one],
   `nginx.railway.conf` [prod]) so it works on every profile.

5. **Verification:** bond-api + bond frontend typecheck clean; all 85 bond-api
   unit tests pass (no regression). Rebuilt bond-api + frontend, recreated both
   (frontend re-renders the bind-mounted nginx config). A live Playwright smoke
   proved the whole realtime path end to end against the rebuilt stack, as a
   healthy-org user (e2e-admin, to avoid the soft-deleted-org auth issue in
   task #16): board page renders -> browser WebSocket subscribes to /bond/ws and
   gets the `subscribed` ack -> an API `PATCH /deals/:id/stage` (200) -> the
   subscribed socket receives `bond.deal.stage_moved` with the correct stage_id
   -> deal moved back (fixture restored). That is exactly what makes a second
   viewer's board refresh live. Smoke script run then deleted; durable coverage
   is the bond-api unit suite + this recorded run.
