# Issue mitigations — 2026-06-15

End-to-end cull of the open issues on `eoffermann/BigBlueBam`, run via the
`/github-issue-cull` skill. Each issue: investigate against the real code →
acknowledge → (clear-path) implement least-disruptive fix → independent blind
verification → report. **Nothing reaches `stable` without Eddie's explicit go.**

Open issues at start: **#40, #39, #38, #36, #28, #25, #24**
Open PRs at start: **#37** (Closes #36), **#27** (Fixes #24), **#32** (DRAFT infra, not for merge)

| Issue | Title | Linked PR | Disposition |
|---|---|---|---|
| #40 | Svc-acct API key lookup collides at 4+ keys/org (degenerate `bbam_svc` prefix) | — | fix (HIGH) — auth.ts-only smart cap |
| #39 | `API_KEY_ROTATION_GRACE_MS` bypasses env validation | — | fix (low) — env.ts Zod knob |
| #38 | Seed sidecar has no CI coverage | — | fix (additive) — `seed-smoke.yml` |
| #36 | seed-platform.mjs broken after Wave E.F role column drop | #37 | fix — cherry-pick PR #37 onto fresh branch |
| #28 | Inconsistent visibility semantics across project read endpoints | — | needs-decision (design) |
| #25 | Revoked service-account agents have no UI path forward | — | needs-decision (design) |
| #24 | Rotate button on svc-acct agents silently fails (404) | #27 | fix — re-author PR #27 onto fresh branch |

Notable cross-issue facts established by investigation:
- **#40 ↔ #24/#27.** PR #27 (rotate) mints *more* `bbam_svc` keys, so merging it without #40 makes the collision arrive sooner. They're independent fixes; #40 is the higher-severity correctness bug. The auth.ts-only #40 fix chosen here does NOT touch the mint path, so it does not conflict with a re-authored #24.
- **PR #37 (#36)** is correct + complete but its branch base is 228 commits behind `main`; the single fix commit `f6740080` applies cleanly. Cherry-pick.
- **PR #27 (#24)** is sound in design but cannot merge as-is: its migration `0170_permissions_seed_actions_delta_007.sql` collides with main's existing `0170_password_reset_tokens.sql`, and its generated `packages/permissions/src/generated/permissions.ts` conflicts. Main's migration tip is `0190` (CLAUDE.md's "0141" is stale).
- The repo's per-app project-scoped REST routes are already consistent (Stance A / 404 on no-access via `requireProjectAccess`); #28's leak is isolated to the 3 MCP composite tools.

---

## Issue #40 — Service-account API key lookup collides at 4+ keys per org

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/40 · leith-bartrich · 2026-06-01

### 1. Investigation
**Valid — reproduces (static trace).** `apps/api/src/plugins/auth.ts:379` does `prefix = token.slice(0, 8)`; `bbam_svc_` is 9 chars, so every service-account token's stored `key_prefix` is the literal `"bbam_svc"` (mint: `service-account.routes.ts:255-258`, `cli.ts:564-565`). The lookup `auth.ts:398` `eq(key_prefix, prefix)` `.limit(10)` then hits the DoS cap `auth.ts:410-411` `candidates.length > 3 ? candidates.slice(0,1) : candidates`, which collapses to verifying only `candidates[0]` (arbitrary DB order). At 4+ svc-acct keys in one org, any bearer whose row isn't `[0]` fails `argon2.verify` → **401**. Fails closed (rejects valid keys; never admits invalid), so no security downgrade — but it's a silent service-to-service auth outage. `api_keys.key_prefix` is already `varchar(12)`, so no schema change is needed for any fix.
**Affected:** every `bbam_svc_` bearer path (the MCP server's outbound Bearer client `apps/mcp-server/src/middleware/api-client.ts:31`, agent runners, customer-created svc accounts). Triggers at ≥4 live svc-acct keys/org; rotation's 7-day grace doubles rows, so 2 rotated accounts already = 4. ~`1/N` success probability past the cap. The MCP internal `/tools/call` route is safe (uses `X-Internal-Secret`). Severity **HIGH**.

### 2. Mitigation
Investigator's recommended architectural fix (12-char svc prefix + branched lookup + dual-read legacy fallback) is correct but (a) can't backfill existing rows — the plaintext token isn't stored, so chars 9-11 are unrecoverable — and (b) overlaps the #24 mint path. **Chosen least-disruptive fix: auth.ts only.** Treat the known literal `bbam_svc` bucket as legitimate shared-prefix (not a forgery signal): raise the candidate `.limit` and skip the collapse-to-1 cap *for that bucket only*, keeping the strict `>3 → slice(0,1)` DoS guard for genuinely random user-key prefixes. Fixes old AND new keys, no mint change, no migration, no #24 overlap. Bounded worst case (≤64 Argon2 verifies, rate-limited). The selective-prefix lengthening is recorded as a follow-up to ride with #24's mint consolidation.

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/40#issuecomment-4712146325
### 4. Implementation
Branch `issue-40-svc-acct-prefix-collision`, commit `7de1cc09`. `apps/api/src/plugins/auth.ts` only: detect the literal `bbam_svc` bucket, raise its fetch limit to 64 and verify all candidates, keep the strict `>3 → first-only` cap for random user-key prefixes. No schema/mint change (fixes existing keys).
### 5. Independent verification
issue-fix-verifier (blind): **High, 90/100 — resolved.** Independently rebuilt the api and reproduced before(401)/after(200) for 4 svc tokens in a 9-key bucket; confirmed user-key auth, rotation grace, and expiry paths are byte-unchanged. Surfaced: (a) DoS amplification — an attacker can force up to 64 Argon2 verifies/req against the known `bbam_svc` bucket (bounded by the route rate limit; the prefix-lengthening follow-up closes it); (b) the 64-key ceiling is global+unordered; (c) **sibling unfixed:** `ical.routes.ts:179` shares the same `slice(0,8)`+`limit(10)` lookup (queued as a discovered bug).
### 6. Status/confidence
Implemented + Layer-3 proven. **READY TO MERGE** pending sign-off. Follow-ups: lengthen new svc-key prefixes for index selectivity (with mint consolidation) + fix the iCal sibling — both queued.

---

## Issue #39 — API_KEY_ROTATION_GRACE_MS bypasses env validation

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/39 · leith-bartrich · 2026-05-25

### 1. Investigation
**Partial — real weakness, but the issue's "two identical sites" framing is wrong.** There is exactly ONE site on current `main`: `apps/api/src/routes/api-key.routes.ts:14-20` (`getRotationGraceMs()`), consumed at `:212` in `POST /auth/api-keys/:id/rotate`. `service-account.routes.ts` has NO grace helper, NO `process.env.API_KEY_ROTATION_GRACE_MS` read, and no rotation route (its cited "lines 17-23" are a JSDoc block). Repo-wide, `api-key.routes.ts` is the sole reader. The helper accepts any finite positive value with no upper bound; a typo (e.g. `7000000000`ms ≈ 81d) silently extends the predecessor-key grace window. Failure mode is benign (NaN/negative fall back to the 7-day default). Severity **low**.

### 2. Mitigation
Add `API_KEY_ROTATION_GRACE_MS: z.coerce.number().int().positive().max(30*24*60*60*1000).default(7*24*60*60*1000)` to the Zod `envSchema` in `apps/api/src/env.ts` (mirrors `SESSION_TTL_SECONDS`/`RATE_LIMIT_MAX`; fail-fast `process.exit(1)` on violation). Delete the local helper from `api-key.routes.ts`, import `env`, repoint `:212`. **Two files** (env.ts + api-key.routes.ts) — NOT the three the issue claims; drop the phantom service-account.routes.ts edit.

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/39#issuecomment-4712146490 (noted the one-site correction)
### 4. Implementation
Branch `issue-39-rotation-grace-env-validation`, commit `105a2343`. Added the Zod knob to `apps/api/src/env.ts`, deleted the local helper, repointed the single call site to `env.API_KEY_ROTATION_GRACE_MS`.
### 5. Independent verification
issue-fix-verifier (blind): **High, 92/100 — resolved.** Boundary-probed the knob (30d ok, 30d+1ms / 81d / negative / non-numeric all rejected → boot abort); confirmed the raw reader is fully removed with no dangling references. Flagged the #24 merge-order risk (below).
### 6. Status/confidence
Implemented + Layer-3 proven. **READY TO MERGE** pending sign-off. ⚠ **Merge-order note:** #24's branch adds its own local `getRotationGraceMs()` raw-env reader; whoever merges #24 and #39 second must repoint #24's call site to `env.API_KEY_ROTATION_GRACE_MS` or the typo hole reopens on the svc-acct rotate path (a code comment in #24 says exactly this).

---

## Issue #38 — Seed sidecar has no CI coverage

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/38 · leith-bartrich · 2026-05-25

### 1. Investigation
**Valid — infra coverage gap, live-reproducible.** None of the 5 workflows (`test/db-drift/migration-replay/lint/typecheck`) runs the seed orchestrator; `test.yml` mocks Drizzle, the DB jobs only diff/apply schema. So #36's raw-SQL drift shipped green. **Important wrinkle:** `scripts/seed-all.mjs:312-315` returns `exit 0` for any Phase B/C/D seeder failure — only Phase A (`seed-platform.mjs`) is fatal (`:258-264 → exit 1`). #36 is Phase A so a bare exit-0 check catches it, but a future Phase B/C/D drift would pass; the smoke must ALSO assert `failed: 0` in the log. The compose `seed` service `depends_on api: service_healthy`, so the literal `--profile seed up` invocation drags up the full api container.

### 2. Mitigation
Add `.github/workflows/seed-smoke.yml` modeled on `migration-replay.yml` (postgres:16 service container, build shared+api, run migrate, `create-admin`, then `node scripts/seed-all.mjs`), asserting exit 0 **and** grepping the log for `failed: 0`. Path-gate to `scripts/seed-*.mjs`, `infra/postgres/migrations/**`, `docker-compose.yml`. Avoids the full-compose tax of the issue's literal proposal. Must merge together-with/after #36 or it goes red immediately (which is the point). Open sub-question (needs-decision, NOT bundled): whether to also harden `seed-all.mjs` to exit non-zero on any seeder failure (behavior change for operators relying on best-effort partial seeding).

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/38#issuecomment-4712146628
### 4. Implementation
**Deferred — gated.** Design specified above (service-container postgres modeled on `migration-replay.yml`; build shared+api; migrate; `create-admin`; run `seed-all.mjs`; assert exit 0 AND `failed: 0`; path-gate to seeders/migrations). Can't land green yet: depends on (a) #36 merging and (b) the discovered `seed-beacons.js` Phase-B failure being fixed (queued) — else the `failed: 0` assertion fails on seed-beacons. Implement + verify after seed-beacons is green.
### 5. Independent verification: n/a (not yet implemented)
### 6. Status/confidence
**SPECIFIED, gated on #36 + seed-beacons fix.** The live #36 smoke is itself proof the gap is real — the orchestrator returned `failed: 1` yet exited 0.

---

## Issue #36 — seed-platform.mjs broken after Wave E.F role column drop

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/36 · leith-bartrich · 2026-05-25 · **PR #37**

### 1. Investigation
**Valid — reproduces against live schema.** Migration `0159` dropped `users.role` + `organization_memberships.role`; `scripts/seed-platform.mjs` (`:68,74-92,492,502,510`) and `scripts/seed-acme-scenario.mjs:860` still reference them, crashing Phase A at the first `SELECT role`. Live DB confirms both columns gone; the 5 builtin `permission_groups` exist with the exact UUIDs/legacy_role mapping PR #37 relies on; `account_group_memberships` PK is `(user_id, scope_type, scope_id)` matching the PR's `ON CONFLICT`.
**PR #37 verdict: sound + complete.** `BUILTIN_GROUP_IDS` byte-identical to `cli.ts`; upserts `account_group_memberships` with the right scope + conflict target; clears `detached_at/by` on re-run (a slight improvement over `cli.ts`); fixes the owner-lookup join in both files; covers every site the issue lists PLUS the acme `:860` site the issue omitted. No new drift. Only defect: branch base is 228 commits behind `main`, though commit `f6740080` `git apply --check --3way` is clean.

### 2. Mitigation
Cherry-pick `f6740080` onto a fresh branch off current `main` → clean single-commit PR. Then live-verify: `docker compose --profile seed run --rm seed` exits 0, and the 8 seeded users map to correct legacy roles via the new `account_group_memberships` join.

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/36#issuecomment-4712146760
### 4. Implementation
Branch `issue-36-seed-role-drop`, commit `47e7f591` — cherry-pick of PR #37's `f6740080` (original author preserved) onto fresh main. Touches `scripts/seed-platform.mjs` + `scripts/seed-acme-scenario.mjs`.
### 5. Independent verification
issue-fix-verifier (blind): **High, 94/100 — resolved.** Reproduced the exact `column "role" does not exist` crash on main, then ran the orchestrator with the branch scripts against its own throwaway org `verify-36`: Phase A + acme clean, role mapping correct. Confirmed every surviving `role` reference is to a non-dropped column. (Also independently noted the seed-beacons re-run quirk + a non-idempotent `seed-book.sql` on re-seed — separate, pre-existing.)
### 6. Status/confidence
Implemented + Layer-3 proven (mine + the verifier's, two separate orgs). **READY TO MERGE** pending sign-off. (The seed run surfaced `failed: 1 — seed-beacons.js`, a SEPARATE discovered bug now queued, and that the orchestrator exits 0 despite Phase-B failures — exactly #38's gap.)

---

## Issue #28 — Inconsistent visibility semantics across project read endpoints

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/28 · leith-bartrich · 2026-05-07

### 1. Investigation
**Valid — still reproduces on current `main` (post permissions landing).** The owner's Wave E permissions expansion (`shadowOnly`/`requireCan`) is telemetry-only on these paths and didn't change behavior. `get_project` (`project.routes.ts:117-126`) and `list_members` (`:253-262`) return `404 NOT_FOUND` for an org-member-but-not-project-member — Stance A. But `project_view` (MCP composite `apps/mcp-server/src/tools/composite-tools.ts:1157-1162`) synthesizes a stub `{id: project_id, name:'', slug:null, org_id:''}`, sets `partial:true`, and lists `'project'` in `missing` — echoing the id the other two deny, an existence oracle; `missing`'s arm-asymmetry leaks structure too. Composites explicitly do NOT preflight `can_access` (header comment `:30-32`). The leak is **isolated to the 3 composites** (`project_view`/`account_view`/`user_view`); all per-app project routes already use `requireProjectAccess` (404). Severity **low (existence oracle)**.

### 2. Mitigation — needs-decision (Stance A vs B is Eddie's call)
- **Option 1 (recommended interim, stance-agnostic):** in the 3 composites, when the primary-entity arm fails, drop the stub echo (omit the entity or return `NOT_FOUND`) and sanitize `missing` so it can't distinguish denied-vs-empty. `composite-tools.ts` + its test file. Effort S. Closes the leak under BOTH stances.
- **Option 2 (Stance A, 404 everywhere):** make the composite's failed primary arm propagate `NOT_FOUND` (needs `fetchProject` to surface 404 distinctly). Matches the rest of the codebase. Effort S–M.
- **Option 3 (Stance B, 403 everywhere):** flip `requireProjectAccess` 404→403 across ~16 route files + reword messages + promote the redacted envelope to contract. Effort L, risk medium — reverses the codebase's deliberate anti-enumeration posture. The contributor leans B; the codebase is built around A.
**Recommendation:** A-vs-B is Eddie's decision; land Option 1 now regardless (it's a bug under both stances).

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/28#issuecomment-4712146922
### 4. Implementation: needs-decision — not implemented (awaiting stance choice)
### 5. Independent verification: n/a until decided
### 6. Status/confidence
**NEEDS-DECISION.** Stance A (404 everywhere) vs Stance B (403 everywhere) is yours; the codebase is currently all-Stance-A except the 3 MCP composites. Recommended regardless: land the stance-agnostic leak fix in `composite-tools.ts` (drop the stub echo + sanitize `missing`). Ready to implement on your call.

---

## Issue #25 — Revoked service-account agents have no UI path forward

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/25 · leith-bartrich · 2026-04-27

### 1. Investigation
**Valid — reproduces (genuine dead-end), but a lifecycle design question.** Revoke (`service-account.routes.ts:334-417`) sets `disabled_at/is_active/agent_policies.enabled=false` and hard-deletes all `api_keys` rows; the list (`:59-84`) has no `disabled_at` filter so revoked rows persist; the frontend (`settings.tsx:1164,1207-1239`) gates both buttons on `!isDisabled` and renders an empty actions cell once disabled — no Delete/Re-enable/Archive. No hard-delete endpoint, no purge job exist.
**Audit/FK entanglement (constrains the choice):** `activity_log.actor_id → users(id) ON DELETE CASCADE` (`0000_init.sql:271`) — hard-deleting the svc user **destroys its entire activity history**, the exact audit trail Eddie said to keep; `agent_proposals.actor_id → users(id) ON DELETE RESTRICT` (`0128:31`) — would **block** the delete if the agent ever filed a proposal (the reporter's SQL recipe is incomplete/wrong). So hard-delete is the least-safe option. Severity **low/cosmetic** (revoked agents can't auth).

### 2. Mitigation — needs-decision (owner leans audit-retention)
- **Option 1 (recommended, matches owner's lean):** archive/hide + "Show revoked (N)" toggle. Frontend-only: default the table to non-disabled rows; toggle reveals revoked rows with the existing "Revoked" badge; optionally surface `disabled_by/at`. No new endpoint, no migration, preserves 100% of audit data. Effort S, risk very low.
- **Option 2:** soft-delete + dedicated audit screen (more surface).
- **Options 3/4 (reject for default lifecycle):** scheduled retention / hard-delete endpoint — both fight the `activity_log` CASCADE + `agent_proposals` RESTRICT FKs and destroy audit history; reserve only as an explicit, separately-gated erasure action.
**Recommendation:** Option 1; the only real decision is inline toggle vs dedicated audit screen. Owner said "let me think on it" — not implementing without his go.

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/25#issuecomment-4712147052
### 4. Implementation: needs-decision — not implemented (awaiting lifecycle choice)
### 5. Independent verification: n/a until decided
### 6. Status/confidence
**NEEDS-DECISION.** You leaned "keep for audit trail." The audit FKs (`activity_log` CASCADE + `agent_proposals` RESTRICT) make hard-delete unsafe, so the fit is the frontend-only archive/hide + "Show revoked" toggle (no destructive endpoint, no data loss). Only sub-choice: inline toggle vs a dedicated audit screen. Ready to implement on your call.

---

## Issue #24 — Rotate button on service-account agents silently fails

- **Issue:** https://github.com/eoffermann/BigBlueBam/issues/24 · leith-bartrich · 2026-04-27 · **PR #27**

### 1. Investigation
**Valid — reproduces.** `POST /auth/api-keys/:id/rotate` (`api-key.routes.ts:174-194`) scopes the lookup to `apiKeys.user_id = request.user.id`; for a svc-acct the key owner is the service user, so zero rows → 404. The frontend `rotateAgentKey` (`settings.tsx:232-239`) has no `onError`, so the 404 is invisible (`createAgent`/`revokeAgent` share the gap). Revoke works because it routes through the org-admin-gated `DELETE /auth/service-accounts/:id`.
**PR #27 verdict: sound design, NOT mergeable as-is.** The new `POST /auth/service-accounts/:id/rotate` correctly mirrors DELETE's auth gate (`is_superuser || isOrgPrivileged(role) || created_by === caller.id`), selects the active key, runs the same successor-insert+predecessor-stamp txn; the frontend now passes the agent user id and adds onError banners; 19 unit tests are meaningful. BUT two hard blockers: (1) its migration `0170_permissions_seed_actions_delta_007.sql` **collides** with main's `0170_password_reset_tokens.sql`; (2) generated `packages/permissions/src/generated/permissions.ts` conflicts. `createAgent` still lacks onError.

### 2. Mitigation
Re-author #27's validated logic onto a fresh branch off `main`: add the `POST /auth/service-accounts/:id/rotate` route mirroring the DELETE role gate (so **no new permission action / migration / codegen** is needed — sidesteps both blockers), point the frontend mutation at it (passing agent id), add onError to rotate/revoke/create, reword the confirm dialog. Live-smoke: create a svc account → rotate → new `bbam_svc_` token returned; failure path surfaces a banner.

### 3. Acknowledgement posted
https://github.com/eoffermann/BigBlueBam/issues/24#issuecomment-4712147177
### 4. Implementation
Branch `issue-24-svc-acct-rotate`, commit `24c10cae`. Backend: `apps/api/src/routes/service-account.routes.ts` — new `POST /auth/service-accounts/:id/rotate` mirroring the revoke gate + the api-key rotation txn, reusing the existing `bam.auth_service_account.create` action (no new migration/codegen → sidesteps PR #27's two blockers). Frontend: `apps/frontend/src/pages/settings.tsx` — repoint mutation at the new endpoint with the agent user id, add onError banners to rotate/revoke/create, reword the dialog + panel.
### 5. Independent verification
issue-fix-verifier (blind): **High, 92/100 — resolved.** Reproduced old 404, confirmed new endpoint → 201 + correct rotation chain (predecessor rotated_at/grace, successor predecessor_id), plus 404 (non-svc/wrong-org/no-key) and 403 (unprivileged) paths; both apps typecheck; no new migration/file. Minor note: rotate gate uses the `.create` requireCan action vs DELETE's `.delete` (functionally equivalent; the in-handler gate matches revoke exactly).
### 6. Status/confidence
Implemented + Layer-3 proven. **READY TO MERGE** pending sign-off. See the #39 merge-order note (repoint the local grace helper to `env.API_KEY_ROTATION_GRACE_MS` whichever of #24/#39 merges second).

---

# Phase 5 — Report (STOP for sign-off)

**Nothing has been merged or closed. All four fixes sit on local branches off `main`; no pushes, no `stable` promotion.** Awaiting your go.

## Ready to merge — verified fixes (4)
| Issue | Branch | Commit | Verifier | What |
|---|---|---|---|---|
| #40 | `issue-40-svc-acct-prefix-collision` | `7de1cc09` | High 90 | Svc-acct auth no longer collapses the global `bbam_svc` bucket; 401→200 for 4+ keys. auth.ts only. |
| #24 | `issue-24-svc-acct-rotate` | `24c10cae` | High 92 | New `POST /auth/service-accounts/:id/rotate` (404→201) + frontend onError banners. No new migration. |
| #36 | `issue-36-seed-role-drop` | `47e7f591` | High 94 | Cherry-pick of PR #37 — seeders no longer reference dropped `role` columns. |
| #39 | `issue-39-rotation-grace-env-validation` | `105a2343` | High 92 | Boot-validate `API_KEY_ROTATION_GRACE_MS` (Zod `.max(30d)`). |

**⚠ Merge-order:** #24 and #39 both touch the rotation-grace helper. Whichever merges **second**, repoint #24's local `getRotationGraceMs()` to `env.API_KEY_ROTATION_GRACE_MS` (a code comment in #24 marks the spot). No conflict, just a 1-line follow-up.

## Needs your decision (2) — not implemented
- **#28** visibility stance: A (404 everywhere) vs B (403 everywhere). Codebase is all-A except 3 MCP composites. Recommended either way: land the stance-agnostic leak fix in `composite-tools.ts`. Ready on your word.
- **#25** revoked-agent lifecycle: you leaned audit-retention; hard-delete is unsafe (audit FKs). Fit = frontend-only archive/hide + "Show revoked" toggle. Ready on your word (inline toggle vs dedicated audit screen).

## Specified but gated (1)
- **#38** seed CI coverage: `seed-smoke.yml` designed; can't land green until #36 merges AND the discovered seed-beacons failure is fixed. The #36 smoke is itself proof the gap is real (orchestrator returned `failed: 1`, exited 0).

## Discovered bugs found during the cull (queued, not yet fixed)
1. **`platform_delete_org` is broken** — hard-cascade hits RESTRICT FKs → masked `INTERNAL_ERROR`; no org with real data can be deleted. (task #1)
2. **`seed-beacons.js` Phase-B seeder exits 1** — separate from #36; would block #38's CI. (task #2)
3. **iCal key-prefix sibling of #40** — `ical.routes.ts:179` shares the degenerate `slice(0,8)`+`limit(10)` lookup. (task #3)

## Cleanup debt (blocked on task #1)
Two throwaway orgs from #36 smokes can't be removed until `platform_delete_org` is fixed: `seed-smoke-36` (cbae1740…) and `verify-36` (442d429d…). Tracked in task #1; verifying that fix == deleting these.

---

# Phase 6 — Shipped (2026-06-15)

Eddie approved shipping all 4. Cherry-picked onto `main`, repointed #24's grace helper to the #39 env knob (`2203e5f8`), build-gated, promoted `main`→`stable`. **Railway: frontend + api both `2203e5f8/SUCCESS` (live in prod, 21:26Z).**

- #40 `c7e6a09a` · #39 `befe17d9` · #36 `e59547e0` (author preserved) · #24 `686763d6` · merge-repoint `2203e5f8`
- Issues #40/#24/#36/#39 commented + closed. PRs #37/#27 closed as superseded with pointers.

## Discovered-bug drain
- **task #2 seed-beacons** — FIXED, branch `fix-seed-beacons-global-slug` `7b601fb7`. Global-unique slug; pre-load existing slugs into dedupe. Smoked (5000 inserted into a 2nd org). Unblocks #38. *Awaiting sign-off to ship.*
- **task #3 iCal sibling** — FIXED, branch `fix-ical-svc-prefix-bucket` `03276ce1`. Raise svc-bucket fetch limit to 64. Verified by parity + typecheck. *Awaiting sign-off to ship.*
- **task #1 platform_delete_org** — NOT implemented; needs Eddie's design call (A: soft-delete org + migration, recommended; vs B: ordered hard-teardown). Throwaway orgs `seed-smoke-36` / `verify-36` cleanup rides on this.

## Remaining open (need Eddie)
- #38 seed CI — unblocked now (seed-beacons green); `seed-smoke.yml` ready to implement on go.
- #28 visibility stance (A vs B) — decision.
- #25 revoked-agent lifecycle — decision (archive/hide recommended).
- PR #32 — explicit DRAFT ("not for merge"); no action.

---

# Phase 6b — Close-out batch (2026-06-15)

Eddie chose: soft-delete org (A), #28 Stance A, #25 archive/hide toggle, implement seed-smoke.yml, ship the queued fixes. All implemented + verified, promoted `main`→`stable` (`4d2fdb8d`).

| Item | Commit | Verification |
|---|---|---|
| seed-beacons global-slug | `6c138259` | smoked: 5000 inserted into 2nd org, exit 0 |
| iCal svc-bucket sibling | `98b2dec3` | parity with #40 + typecheck |
| **#1 platform_delete_org → soft-delete** | `5132ea6e` (migration 0191) | login/me/switcher still 200; MCP delete now succeeds; org hidden (list+get NOT_FOUND); deleted_at/by stamped, memberships dropped, users kept |
| **#28 composite leak → Stance A** | `20bc186a` | 15 unit tests incl. denied-arm → NOT_FOUND; live non-member MCP smoke not run (needs non-superuser caller) |
| seed-book idempotent | `9b11e1d2` | full run ok:15 failed:0 |
| **#38 seed-smoke.yml** | `a6180fec` | full orchestrator failed:0 validated locally; GH Actions env not runnable offline |
| **#25 revoked toggle** | `fe3983f0` | headless smoke: revoked hidden by default, toggle reveals |
| mcp delete-org description | `4d2fdb8d` | typecheck |

Cleanup: all three throwaway test orgs (seed-smoke-36, verify-36, seed-full-check) soft-deleted via the now-working tool.

Discovered during close-out + fixed in the same batch: seed-book non-idempotency (another seeder bug the #38 CI now guards).

Remaining open issue: none of the originals — only PR #32 (explicit DRAFT, not for merge). #28/#25/#38 closed on deploy confirm.
