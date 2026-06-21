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
