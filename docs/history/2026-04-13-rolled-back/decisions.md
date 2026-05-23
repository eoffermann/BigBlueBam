# 2026-04-13 Implementation Push — Decision Log

Audit trail of decisions the orchestrator made autonomously during the overnight run of 2026-04-13 / 2026-04-14. Each entry records what was decided, why, the alternatives considered, and how to revert if the user disagrees.

Context: user authorized autonomous execution before bed with the note "use your own best judgment and document what your decisions were."

## Scope and guardrails accepted at the start of the night

- **No merges to `main`.** Every wave PR targets `feature-completion-wip`. When a wave PR is ready, the orchestrator merges it into `feature-completion-wip` to unblock downstream waves. `feature-completion-wip` itself never touches `main` without user sign-off.
- **No `docker compose down -v`.** The seeded dev DB is preserved.
- **No editing applied migrations.** Checksum rule respected; migration runner hooks are the escape hatch when cold-start semantics need fixing.
- **Follow the plans.** Scope stays inside each plan's gap list; out-of-scope discoveries are recorded, not silently folded in.
- **Pre-existing is not a dismissal.** Errors surfaced by new CI must be tracked even when they are not fixed in the current PR.

---

## D-001: Wave 0.1 plan section re-scoping (2026-04-14 early)

**Decision.** The orchestration brief listed "Platform §3.1-§3.4" for Wave 0.1 but the parenthetical described sections that map to §3.1, §3.5-§3.7, §3.13, §3.23 (non-contiguous). I briefed the agent with the parenthetical-matching sections and explicitly excluded §3.3 (RLS rollout, which the brief assigns to Wave 1) and §3.4 (activity_log partitioning, deferred).

**Why.** The parenthetical description is the authoritative intent; the range label was a typo. Including §3.3 would have bundled a multi-day RLS rollout into Wave 0.

**Alternatives.** Halt and ask the user to disambiguate. Rejected because the parenthetical was unambiguous and the user was async.

**Revert.** Respawn the Wave 1 Platform agent with §3.3 in-scope; that is the default plan anyway. No work needs undoing on PR #5.

## D-002: Wave 0.2 ApiClient stays 3-arg (Path 1) (2026-04-14 early)

**Decision.** The Cross-Product plan's code skeleton for `POST /tools/call` called `new ApiClient(url, token, logger, { orgId, actorId })` but the real constructor is 3-arg. I directed the agent to Path 1 of the three the first agent proposed: drop the 4th argument, read `X-Org-Id` / `X-Actor-Id` from headers for audit logging, but do NOT extend `ApiClient`. Org scoping continues via the org-bound bearer token on the service-account API key.

**Why.** Matches the plan's stated "simpler, smaller surface area" framing. The worker does not send `X-Actor-Id` today anyway, so extending `ApiClient` to forward it would be dead code. Paths 2 and 3 would have expanded PR #6 by at least one file plus every existing `new ApiClient(...)` call site.

**Alternatives.** Path 2 (extend `ApiClient`) bloats this PR and touches unrelated tool code. Path 3 (inject via SDK `extra`) requires auditing every tool to see who reads the values.

**Revert.** A future PR can extend `ApiClient` if a tool ever genuinely needs actor attribution. The header values are already logged at the route layer, so no data is lost today.

## D-003: Wave 0.2 service-account prefix `bbam_svc_` (2026-04-14 early)

**Decision.** I directed the agent to verify `apps/api/src/plugins/auth.ts` prefix-slicing behavior before choosing a prefix, with a hard rule not to touch `auth.ts` in this PR. The agent confirmed that auth uses `token.slice(0, 8)` positional slicing and looks up `apiKeys.key_prefix`, so storing `bbam_svc` (exactly 8 characters) works transparently. Prefix is `bbam_svc_`.

**Why.** Reserves the "service" identity at the token level without touching the auth plugin's prefix-matching logic.

**Alternatives.** Keep the `bbam_` prefix and distinguish service accounts by a row-level marker. Rejected because the prefix is visually clearer for operators pasting keys.

**Revert.** None needed. If auth.ts is refactored later, it continues to work as long as the slice stays at 8 chars.

## D-004: `feature-completion-wip` branch created; both Wave 0 PRs retargeted (2026-04-14 mid)

**Decision.** Created `feature-completion-wip` on origin from the current `origin/main` tip. Retargeted PR #5 (Platform infra) and PR #6 (MCP transport) from `main` to `feature-completion-wip`. All future wave PRs will target `feature-completion-wip`.

**Why.** User instruction: "put all these into a new `feature-completion-wip` branch, keeping them out of main. We'll merge those later." Keeps main untouched until the whole push is ready for a single review-and-merge decision.

**Alternatives.** None, per user direction.

**Revert.** `git push origin :feature-completion-wip` deletes the branch; each PR's base can be edited back to main.

## D-005: Migration 0023 cold-start fix via migrate-runner bootstrap hook, not a new migration file (2026-04-14 mid)

**Decision.** The user chose option (c) (sentinel system user) for fixing the broken `beacon_expiry_policies` seed in migration 0023. I reinterpreted (c) from "new migration that creates the sentinel" to "bootstrap hook in `apps/api/src/migrate.ts` that inserts the sentinel idempotently before each migration runs." The hook creates a stable sentinel org + superuser at known-fixed UUIDs (`00000000-0000-0000-0000-000000000003` and `00000000-0000-0000-0000-000000000004`, password_hash `!` so the account is unloginable), guarded by `information_schema` checks so it only fires once the `users` table and `is_superuser` column exist.

**Why.** A new migration file cannot fix this bug: on a fresh DB, migration 0023 aborts before any later-numbered migration can run. The checksum rule forbids editing 0023's body. The only remaining surface is the runner itself. Putting the hook in the runner also covers the general case of "future migration depends on a superuser being present" without requiring every future author to remember.

**Alternatives.** Edit 0023 directly with a one-time checksum re-stamp step (rejected: breaks every existing dev DB until operators know to pass the flag). Make the INSERT conditional in a new migration (rejected: never runs on fresh DBs). Remove the seed entirely (rejected: changes semantics of an applied migration).

**Revert.** Remove the `ensureSuperuserSentinel` call from the migration loop in `apps/api/src/migrate.ts`. Existing DBs that were bootstrapped during this window will still have the sentinel row, which is harmless.

## D-006: Beacon-api lint failure fixed via repo-wide eslint-to-biome swap + scoped warn downgrades (2026-04-14 mid)

**Decision.** The follow-up agent discovered the reported failure was a tip-of-iceberg symptom: 13 API packages had broken `eslint src/` scripts (eslint was not even installed; all would have failed if turbo had not short-circuited at beacon-api). The agent swapped all 13 API packages to `biome check ./src`, added an `overrides` block in root `biome.json` scoped to `apps/**/src/**` + `apps/**/test/**` that disables formatter/organizeImports (to avoid reformatting ~1000 files in an infra PR) and explicitly downgrades ~35 rules to `warn` that existing code hits across a11y, style, suspicious, correctness, security, complexity, and performance groups. Each downgraded rule is listed individually so it is visible as a tracked follow-up rather than silently suppressed. I reviewed and accepted the expansion.

**Why.** The reported failure was not the real failure. The real failure was "the entire API-side lint setup is broken." Either approach to fix it (install eslint across 13 packages vs. swap to biome) is a scope expansion; swapping to biome is the cleaner direction because the frontend packages already use biome and the monorepo already pulls biome in for the formatter. Downgrading rules to warn preserves visibility of tech debt (~1600 warnings now logged) without blocking CI.

**Alternatives.** Install eslint in 13 packages (rejected: two linters is worse than one, and the eslint configs would have been aspirational). Accept ~1600 errors as hard failures (rejected: blocks all of Wave 0 and every subsequent wave). Silently disable (rejected: hides the debt).

**Revert.** Revert commits `fcc2dd0` and `df5b22b` on PR #5; restore per-package `eslint src/` scripts and install eslint. Note: this re-breaks CI.

## D-007: Wave 0.1 second follow-up authorized — fix drift, dompurify, and skip fixture-broken tests (2026-04-14 overnight)

**Decision.** User authorized rec (a) on test failures. I am dispatching a second follow-up agent to PR #5 to:
1. Add `@types/dompurify` to `apps/banter-api` devDeps (one-line fix).
2. Write migration `0078_reconcile_bam_bearing_drift.sql` (claimed from MIGRATION_LEDGER.md overflow pool) reconciling four missing columns: `guest_invitations.revoked_at`, `impersonation_sessions.reason`, `tasks.org_id`, `bearing_updates.status`. Update three Drizzle schema files to declare the three unknown-in-Drizzle columns: `bearing_kr_snapshots.created_at`, `bearing_updates.status_at_time`, `bearing_updates.progress_at_time`.
3. `.skip` failing fixture-dependent tests in `apps/bench-api` and `apps/blank-api` with `// TODO(wave-2-<app>):` tracking comments referencing the respective Wave 2 plan file. Each Wave 2 per-app plan's done definition will require unskipping and fixing the tests as part of that plan.

**Why.**
- Drift: `tasks.org_id` is load-bearing for Wave 1 RLS (Platform §3.3 assumes it exists on the core tables). Fixing it in Wave 0 unblocks Wave 1 without forcing Wave 1 to own both RLS and the pre-existing drift.
- Dompurify: trivial, no risk, keeps typecheck clean.
- Test skips: the failing tests have never actually run on a fresh DB before because migration 0023 blocked them. Fixing each one requires per-app fixture / seed / business-logic understanding that belongs to the respective Wave 2 plan author. Quarantining them with explicit tracking preserves visibility without expanding Wave 0 indefinitely.

**Alternatives.** Leave drift and fold into Wave 1 Platform (rejected: bloats Wave 1 and delays Wave 0 verification). Fix every bench-api/blank-api test now (rejected: scope expansion beyond Wave 0's mandate). Delete the broken tests (rejected: loses the intent).

**Revert.** Revert migration 0078 and the drizzle edits; unskip the tests. The tests will fail again, so this revert is only sensible if simultaneously fixing the fixture bugs.

## D-008: Sub-decisions made by the Wave 0.1 second follow-up agent (2026-04-14 overnight)

**Decision.** Three sub-decisions made while executing D-007, each small enough that I did not stop to escalate.

### D-008a: dompurify fix is removal, not addition

**Decision.** The brief said to "add `@types/dompurify` to `apps/banter-api/package.json` devDependencies" but the stub was already declared there at `^3.2.0`. The TS2688 error surfaces because `@types/dompurify@3.2.0` is a deprecated empty stub whose own package.json says "dompurify provides its own type definitions, so you do not need this installed." The fix is to remove the stub from devDependencies; `isomorphic-dompurify` and `dompurify` both ship their own `.d.ts` files, which the banter-api `sanitize.ts` import resolves without an ambient `@types` package.

**Why.** Adding the stub back does not work — it has no index.d.ts and TypeScript fails with TS2688 trying to load it. Removing it is the canonical fix called out by the stub itself.

**Alternatives.** Pin a newer stub version (none exists; the package is deprecated and frozen at 3.2.0). Add `"types": []` to tsconfig (rejected: too invasive, would break every other auto-loaded types package).

**Revert.** Re-add `"@types/dompurify": "^3.2.0"` to `apps/banter-api/package.json`. Typecheck breaks again.

### D-008b: fix bearing_updates.createUpdate insert site alongside the Drizzle declaration

**Decision.** Adding `bearing_updates.status_at_time` and `bearing_updates.progress_at_time` to the Drizzle schema as `.notNull()` (to match the DB's NOT NULL constraint from migration 0028) breaks TypeScript on `apps/bearing-api/src/services/goal.service.ts` createUpdate, because the insert did not pass those columns. The insert is broken at runtime today — any real call would fail with a "null value in column violates not-null constraint" error at the DB. Rather than relax the Drizzle declaration to nullable (which would hide the bug), I fixed the insert to write `status_at_time: goal.status` and `progress_at_time: String(goal.progress ?? '0')`, snapshotting the live goal state at update time.

**Why.** The "small and obviously safe" fix per CLAUDE.md's pre-existing rule. The goal object is already fetched on line 341; the values are trivially available. The alternative (leave the insert broken and mark Drizzle nullable) trades a runtime crash for a silent db-check warning and passes the bug downstream to a Wave 2 owner who will re-discover it the first time they call the endpoint.

**Alternatives.** Declare nullable (rejected: perpetuates the runtime bug). Skip the test that exercises createUpdate (rejected: the test is not currently failing because migration 0023 blocked the entire fresh-DB path; once it runs it would have broken). Move the fix to Wave 2 (rejected: the delta is two lines and owning it here keeps Wave 0 self-consistent).

**Revert.** Revert the two-line change in goal.service.ts createUpdate; flip the Drizzle columns back to nullable. The insert will fail again on any real call.

### D-008c: bearing_updates.status stays nullable at both the Drizzle and DB layer

**Decision.** Migration 0078 adds `bearing_updates.status` as nullable. The Drizzle declaration is likewise relaxed from `.notNull()` to nullable. Existing rows (none in most installs, but possibly some in seeded dev DBs) cannot be retroactively assigned a status without re-reading the goal state at the time, which is lossy.

**Why.** A NOT NULL column would require a backfill, which in turn would require running migration 0078 after some procedure fills in historic values. Keeping it nullable is the only choice that is safely idempotent on existing DBs and matches the existing createUpdate code path (which always writes a value on new inserts anyway).

**Alternatives.** Add NOT NULL with a default like `'on_track'` (rejected: fabricates historic state). Leave the column out of 0078 and force a future migration to add it (rejected: would keep the drift on every db-check run indefinitely).

**Revert.** A future Wave 2 migration can tighten `status` to NOT NULL once all historic rows have been assigned a value.

