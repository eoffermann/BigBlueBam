# Burn build report - autonomous cycle 2026-07-19 (08:01)

Winner of the 2026-07-19 08:01 suite-brainstorm (Burn, Seat F, 27/30). Spec
`docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md` converged through 3 adversarial
rounds. The 08:00 headless build reached M5 and then died at the M5/M6 boundary; the build
was RESUMED interactively from M6 and carried to completion. Built entirely on
`suite-brainstorm`; nothing merged or promoted.

Human actions required: see `docs/brainstorming/2026_07_19_08_01_HUMAN_SETUP_burn.md` (a gate
opt-in config note, a local Docker-disk note, and the standing promotion decision - no
external secret).

## What shipped

Burn turns a signed contract into a live scope/margin monitor: it reads a signed SOW (a Bin
asset) into a clause-cited deliverable ledger of what was sold with priced envelopes,
classifies every unit of work (Bam tasks/time, Bill expenses) against it in dollars (the
unscoped bucket is the product), and - the flagship - vets a billable expense in Bill against
the confirmed envelope BEFORE it posts, blocking the out-of-scope charge while NEVER blocking
because something broke (fail-open). App id `burn`, burn-api port 4022.

Milestones (all committed on `suite-brainstorm`):
- **M1-M5** (08:00 headless, pre-death): scaffold, 9-table data model + migrations 0239-0245,
  shared Zod, the financial serializer + viewerCaps, all REST routes + 17 MCP tools.
- **M6** (resume): 6 engines (extraction, attribution, variance, inverse-check, revaluation,
  change-order), 11 BullMQ workers, the per-org `pg_advisory_xact_lock` sweep (no HTTP call
  under a lock - row claims + per-chunk checkpoint commits), 10 burn + 4 bill Bolt events, the
  bolt-api `burn-dispatch-hook` (`/v1/internal/events`, 16 subscriptions), the Redis
  token-bucket LLM concurrency cap, and `check:bolt-catalog` wired into CI. It also fixed a
  pre-existing gap (missing satellite sources in the ingest enum).
- **M6b** (the flagship, verified): the bill-api gate + the suite's FIRST circuit breaker
  (`burn-precheck.client.ts`) - Redis breaker with NX probe election, threshold 5, in-process
  fallback, non-throwing everywhere; four hook points (POST/PATCH/approve expense + the
  recurring worker); the single blocking path is verdict=deny AND enforced -> 409
  `BURN_ENVELOPE_EXCEEDED`; fail-open on every error. 41 unit tests (18 breaker + 23 fail-open).
- **M7** (resume): the SPA - 7 screens (Portfolio Board, Unscoped Queue, Engagement detail,
  Gate Console, Variances, Cost Rates, Settings/Rules) + shell parity + Bureau + the Bill
  §7.8 gate-notice control; plus the register-engagement UI (was a missing entry point).
- **M8** (resume): Launchpad tile + `flame` icon, docker-compose burn-api service, both nginx
  configs (reconciled the pre-existing bill/bay/blip drift) + regenerated Railway, frontend
  Dockerfile, services catalog, mcp-server wiring (BURN_API_URL + registerBurnTools), CLAUDE.md.
  Permissions were already done in M2 (22 `burn.*` rows + built-in group defaults 0243).
- **M9/M10** (resume): deploy + the full test pass (below); help.md + guide.md + help-index.json
  (Help Center verified, APPROVED), gilligan screenshots, and a marketing section on the site.
- The `/docs` catalog + canonical tool count auto-absorbed Burn (24 products / 865 tools),
  derived from source via the generator built in the prior cycle - no hand-editing.

## Tests + CI status

- **Static gates green locally:** typecheck (shared, burn-api, burn, worker, bolt-api, bill-api,
  bill, api, mcp-server, ui), `check-bolt-catalog` 0, `lint:migrations` 0, `check-permission-catalog`
  in sync, `docs:catalog --check` current, surface-map self-check 0, env-hints OK.
- **M6b: 41 unit tests** (breaker + the 5 fail-open assertions).
- **Phase 4 backend + UI verification PASSED (live, gilligan):** seeded a "Castaway Rescue
  Platform SOW" engagement with a confirmed $5,000 priced-envelope deliverable, then proved:
  in-envelope charge -> `allow`; over-envelope -> advisory `deny` (enforced:false, posts with a
  note); with the org gate set to `blocking`, an over-envelope billable expense through bill-api
  -> **HTTP 409 `BURN_ENVELOPE_EXCEEDED`** with the four remediation actions and **zero** rows
  for the blocked charge; **fail-open** - with burn-api stopped, the same over-envelope charge
  **posts (201)** carrying `burn_gate='unavailable'`, no 409 (burn-api restarted after);
  a non-project member sees `[]`/404/403; and MCP `burn_precheck`/`burn_list_engagements` match
  REST while a kill-switched service account fails closed (`AGENT_DISABLED`).
- **Phase 4 e2e: Playwright 6/6 burn stories pass** (19 total incl. setup),
  `apps/e2e/src/apps/burn/tests/burn.spec.ts` + `appProject('burn')`.

## Deploy incidents found + fixed (Phase 4)

- **Docker WSL2 disk was full** (196GB images + 126GB build cache): postgres could not extend
  files, and Docker served stale cached images (the frontend image lacked the burn SPA, and
  api/mcp-server lagged burn's permissions/tools). Fix: reclaimed ~140GB of dangling images +
  build cache (no volumes touched); rebuilt api + mcp-server (owner now resolves all 22 burn
  permissions; MCP burn tools live); rebuilt the frontend image once disk was free. The
  Dockerfile/code were correct throughout - CI/Railway would build cleanly. Recorded in
  HUMAN_SETUP as an ongoing host-disk hygiene note.
- **The gate was unconfigured** in the dev stack (bill-api `BURN_API_INTERNAL_URL` empty -
  optional by design). Enabled it in `.env` + recreated bill-api so the flagship fires;
  documented the opt-in in HUMAN_SETUP.

## automated-review issues

The post-commit-review pipeline (ci-watchdog, security, stability, best-practices) ran over the
whole resume body. It filed 9 issues; **all 9 fixed + closed**, each in its own `Fixes #<n>`
commit:
- **#94** (stability, HIGH): nightly retention re-freeze zeroed already-frozen rollups (missing
  `WHERE frozen_at IS NULL` guard). Fixed `64594853` (+ NOT-EXISTS on frozen chains; SQL-proven
  immutable + 3 live tests).
- **#96** (stability, HIGH): LLM-throttled `pending_attribution` items were never re-driven and
  dropped out of every rollup. Fixed `587b56ee` (attribute-batch re-drives them; 3 live tests).
- **#98** (stability): unbounded `burn_ingest_events`/`burn_prechecks` growth; retention settings
  were dead config (the disk-full incident's shape). Fixed `3688f282` (batched purge wired to
  `ingest_retention_days`).
- **#99** (stability): burn workers ran `attempts=1`. Fixed `764c3bae` (attempts:5 + exp backoff +
  DLQ).
- **#93** (best-practices): 3 registered Bolt events never published. Fixed `cadabe44` (producers
  for `precheck.blocked`/`precheck.overridden`/`consumption.threshold_crossed`, refs-only).
- **#95** (best-practices): `/burndown` omitted the `metric_basis` discriminator. Fixed `9afe8fb8`.
- **#97** (best-practices): dead ternary. Fixed `7030d849`.
- **#92** (security, low): cited-source `can_access` filter only covered `bam.task`. Fixed
  `d8c79820` (fails closed on un-preflightable types).
- **#100** (ci): Lint `docs:manual:check` drift (burn screenshots added without regenerating the
  manual). Fixed `e56b33a9`.
- Also fixed the extract-enqueue gap the stability review noted (`POST /extract` returned 202 but
  never enqueued the job): `d0b38081` wires a real producer.

Disclosure note: the security + stability reviewers again published file:line detail to the
public repo; the sensitive issue bodies were redacted and the bugs fixed fast (a recurring
reviewer-agent behavior worth a durable fix).

## main -> branch sync

`suite-brainstorm` was current with `main` at the start of the 08:00 cycle (a clean no-op sync).
Nothing was merged branch -> main.

## How to see it in action

1. Stack is live. Launchpad -> **Burn** tile (Scope and Margin, flame icon) -> `/burn/`. Log in
   as `skipper@gilligantravel.example` / `Castaway2026!`.
2. **Portfolio Board** shows "Castaway Rescue Platform SOW"; **Gate Console** shows the
   7-precondition "blocking is earned" ladder; **Cost Rates** is owner/admin-only.
3. The flagship 409 block + the fail-open post are reproducible with the commands in the Phase 4
   agent's report (set `burn_org_settings.gate_mode='blocking'`, POST an over-envelope billable
   expense to bill-api -> 409; `docker compose stop burn-api`, POST again -> 201 fail-open;
   revert mode to `advisory`, restart burn-api).
4. Re-run e2e: `cd apps/e2e && E2E_ADMIN_EMAIL=skipper@gilligantravel.example E2E_ADMIN_PASSWORD='Castaway2026!' E2E_MEMBER_EMAIL=professor@gilligantravel.example E2E_MEMBER_PASSWORD='Castaway2026!' pnpm exec playwright test --project=burn` -> 19 passed.
5. Agents: the 17 `burn_*` MCP tools are registered and fail closed until `burn.*` is allowlisted.

Merging `suite-brainstorm` into `main`/`stable` is the maintainer's decision; nothing was merged.
