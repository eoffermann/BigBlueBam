# Burn build - work in progress

Spec: `docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md` (2014 lines, three
adversarial hardening rounds, build-ready).

Branch: `suite-brainstorm`. Never merged to `main`/`stable`.

**Scale:** 14 tables; **3 hand-authored migrations `0239`-`0241`, then two files at
generator-assigned numbers** (see M2 - do NOT pre-assign them); 22 permissions;
17 MCP tools plus one deprecated alias; 10 Bolt events plus 4 backfilled `bill`
events and 16 subscriptions; **11 queues (10 job families + the claim reaper)**;
7 SPA screens; port 4022.

**Blast radius: ten compose services plus one extra SPA.** `burn-api`, `bill-api`,
`bolt-api`, `worker`, `mcp-server`, `api`, `basis-api`, `braid-api`, `bulwark-api`,
`frontend` - plus the `bill` SPA, which ships inside the `frontend` image.

> **Plan hardened by an adversarial review before implementation.** It found 7
> blockers: the header pre-assigned the generator-assigned migration numbers; pass 2
> omitted the manifest registration without which the permission delta is empty; and
> the bill-api gate integration, the LLM concurrency cap, the `SUPPORTED_ENTITY_TYPES`
> edit, the second subpath contract, and the bolt-api dispatch hook had no milestone
> at all. All folded in below.

---

## M0 - Preceding PRs - **COMPLETE**

Commits `24af7df2`, `6f06e22c`, plus the review-fix commits below.

- [x] `packages/shared/src/visibility-client.ts` exporting `preflightAccess` + `preflightMany`
- [x] `"./visibility-client"` block in `packages/shared/package.json` exports
- [x] **`'src/visibility-client.ts'` appended to the tsup `entry` array** - verified by a successful `docker compose build basis-api braid-api bulwark-api`, which is the check that catches a missing entry
- [x] `braid-api` and `bulwark-api` copies deleted, four call sites repointed
- [x] `basis-api` keeps a thin wrapper for its dimension-decomposition layer, re-exporting the primitive as `canAccessEntity` so its two consumers were untouched
- [x] Fail-closed contract pinned by tests (now 20, after the review fixes)
- [x] `can_access` probe passes in each migrated app
- [x] Eight env-hints entries. **Corrections found by the agent:** `BILL_API_INTERNAL_URL` is latent, not live; and `internal('burn-api')` would have thrown at module load since burn-api is not in the catalog, so a `plannedApp()` fallback was required
- [x] `check-env-hints.mjs` wired into `lint.yml` - 90 variables checked, 15 grandfathered, fails on a stale allowlist entry too
- [x] **#84 fixed at root cause:** `.gitattributes` had no `*.md` rule, so a Windows checkout gave `docs/apps/*/help.md` CRLF, the generator baked `\r\n` into `manual.generated.json`, and the committed artifact could never match a Linux CI run. Self-perpetuating: re-running `pnpm docs:manual` on Windows just re-baked it. Verified fixed against a clean clone in a Linux container
- [x] **#86 fixed:** internal `can_access` and system-error routes admitted unauthenticated requests when `INTERNAL_SERVICE_SECRET` was unset, making the visibility matrix an open oracle. Now 401, matching `requireInternalAuth`
- [x] **#80, #82 fixed:** `preflightMany` aggregate deadline (200 ids against a hung upstream was 100s), and an `onDegraded` hook distinguishing a real `allowed:false` from an outage
- [x] **#85 fixed:** `plannedApp()` now throws on an unknown service name; a typo previously resolved to a plausible unreachable URL forever
- [x] **#83 resolved by decision:** Burn does not make enforcement env-configurable. See M1

## M1 - Scaffold - **COMPLETE**

- [x] `apps/burn-api` (Fastify, internal 4022) from the bulwark-api sibling
- [x] `apps/burn` SPA from the blip sibling
- [x] `@bigbluebam/logging`, `@bigbluebam/service-health` with `/health` and `/health/ready`
- [x] Enforcement is a hardcoded `'on'` literal asserted at three points, NOT an env var (issue #83). Three deliberate departures from the sibling, each documented in-code: this one, the transaction-scoped RLS binding, and the health route names

## M2 - Data model and permissions - **COMPLETE**

**Do NOT pre-assign or pre-create the last two migration filenames.** Author
`0239`-`0241` by hand; observe the number `build-permission-delta.mjs` prints and
author the group-defaults file at that number **+1**. Authoring it first makes it
sort first, match zero rows, get swallowed by `ON CONFLICT DO NOTHING`, and
checksum as applied so it can never re-run - and then no built-in group grants any
`burn.*` and every non-SuperUser including Owners hits `implicit_deny`.

- [x] 14 Drizzle schema modules plus `agent-proposals.ts`, `entity-links.ts`, `bbb-refs.ts`
- [x] `search_tsv` via `customType<{data:string}>({dataType:()=>'tsvector'})` per `braid-profiles.ts:15-18` (`db-check.mjs:454` treats an undeclared DB column as fatal; `text()` would only warn)
- [x] **Pass 1:** authored and applied `0239`-`0241`
- [x] Appended the 22 `burn.*` rows to the literal `HAND_AUTHORED` array at `scripts/generate-permission-manifest.mjs:719` with explicit `is_read` / `is_destructive` / `requires_confirmation` flags (the copy loop is at `:816`); add the `burn.` provenance branch beside the `bulwark.` one at `:843`; confirm `burn_*` is absent from `EXPLICIT_TOOL_OVERRIDES`
- [x] **Pass 2, four scripts in order:** `generate-permission-manifest.mjs` → `build-permission-codegen.mjs` → `check-permission-catalog.mjs` → `build-permission-delta.mjs`
- [x] Committed `packages/permissions/src/generated/permissions.ts` (M7's `useCan('burn.*')` will not typecheck without it)
- [x] Generator assigned `0242`; group defaults authored at `0243`. **The ordering trap was avoided**
- [x] Group-defaults probe: owner 22, admin 22, member 14, viewer 7, guest 0 - exactly as specified
- [x] §12.1 assertions for §3. **They caught a spec defect:** three columns were declared too narrow for their own enum values, fixed in a new migration `0244` and corrected in the spec
- [x] `db:check` 259/259 in sync, `lint:migrations` 206 files 0 violations, CI fully green

## M3 - Shared Zod - **COMPLETE** (`9f7a9dec`)

- [x] `packages/shared/src/schemas/burn.ts` + `export * from './burn.js'` in `schemas/index.ts`
- [x] Money block is a discriminated union on `metric_basis` including a `suppressed` member
- [x] **Three-file contract again, same as M0:** `packages/shared/src/burn-precheck-key.ts` + a `"./burn-precheck-key"` exports block + **`'src/burn-precheck-key.ts'` appended to the tsup `entry` array**. Verified by `dist/burn-precheck-key.{js,cjs,d.ts}` being emitted
- [x] 26 tests. **Spec correction found while implementing:** §6.1 lists `margin_state` on `/v1/financials` generically, but §12.1 asserts no response carries the string "margin" under `metric_basis='contract_consumption'`. The `contract_consumption` variant therefore carries **`completion_state`**; `margin_state` exists only on `true_margin`
- [x] **Naming resolved:** §1.2.2's table says `contract_consumption_pct` and §2.4 point 17 says `consumption_pct` for the same figure. The wire name is `contract_consumption_pct` (§1.2.2 is the authoritative variant table); it is sourced from `burn_engagement_rollups.consumption_pct`

## M4 - Serializer and viewerCaps - **COMPLETE** (`bdf33534`)

Split out deliberately: every money figure in the app projects through this, and its
two failure modes are the sharpest in the spec.

- [x] `viewerCaps` from a fail-closed `POST /internal/permissions/dual-read`, resolved once per request (`src/lib/viewer-caps.ts` + `src/plugins/viewer-caps.ts`). **Never `fastify.canResolve`**. A 2xx carrying `decision: 'unknown'` is treated as an OUTAGE, not a deny, so `resolved` stays false and the suppression reason names it
- [x] `redactFinancialFields` applied across all eight surfaces (`src/lib/redact-financial-fields.ts`). Surfaces are exported as `BURN_FLOORED_SURFACES` data and enumerated by name in the test, so a ninth cannot be added without a fixture. The walk RECURSES (variance `detail` is JSONB; unscoped clusters embed their rows) and DELETES rather than nulls
- [x] `buildMoneyBlock` makes a cost leak to a non-`read_all` caller structurally impossible: that branch returns the `suppressed` union member, which has no cost/margin/coverage key to populate
- [x] Bearer-intersect-asker rule; unresolvable AND malformed asker both fail floored fields closed
- [x] §12.1 serializer-identity tests (78), including the `canResolve`-absent-from-the-flooring-path assertion (per-file and whole-`src` sweep)

**Note for M5:** `/v1/cost-rates` is deliberately NOT one of the eight serializer surfaces - `cost_amount` is its entire payload. It is gated by `burn.costrate.read` at the route plus the second in-route role guard (2.4 point 1); `viewerCaps.costrate_read` is resolved for it and is already on the request.

## M5 - REST routes and 17 MCP tools, together - **COMPLETE** (`11935649`, `52c552a9`)

- [x] REST endpoints per §6.1
- [x] `burn.engagement` / `burn.deliverable` added at **three sites** in `apps/api/src/services/visibility.service.ts`: the `VisibilityEntityType` union (`:104`), the `SUPPORTED_ENTITY_TYPES` array (`:142`), and a resolver `case` beside `:1716`
- [x] `/burn/ws` Redis PubSub fan-out per §6.2: rooms keyed `(org, project)`, membership from the cached `PermissionContext` not a per-frame DB round trip, five frame types, refs and coarse bands only, advisory-only with client refetch on reconnect
- [x] 17 tools in `apps/mcp-server/src/tools/burn-tools.ts`, all via `registerTool()`
- [x] `registerBurnTools` imported and called in `apps/mcp-server/src/server.ts` (per-app bootstrap edit, see `:39`)
- [x] `BURN_API_URL: http://burn-api:4022/v1` in the compose `mcp-server` block **and** `mcp-server.env.optional` in `services.mjs`; `burn` NOT added to `mcp-server.needs`
- [x] `burn.*` `agent_policies` allowlist
- [x] `confirm_action` on destructive tools **and on gate disable** (`off`/`advisory`/`gate_paused_until`)
- [x] `entity_links` upserts per §8.4; ported `braid-resolve.client.ts` with its soft-degradation contract per §8.5
- [x] Surface-map rows for every endpoint (39 burn rows). Self-check prints `0` with the EM DASH variant, which is CLAUDE.md's actual command. The orchestrator's briefs transcribed it with an ASCII hyphen, which matches nothing in a document that uses em dashes 240 times, so that variant printed `0` vacuously and could never have caught a violation
- [x] §12.1 assertions for §5, §6, §11


**Notes for later milestones, from the M5 build:**

- **Three spec/instruction defects found.** (1) 6.2 names the Redis-cached
  `PermissionContext` as the source of the WS membership check, but that object carries
  account-GROUP memberships, not `project_memberships`; a user can be a project member with
  no project-scoped permission group, so deriving membership from it would silently drop
  frames. The hub implements the actual requirement (no per-frame DB round trip) with a
  connect-time project-id set cached in Redis, documented in-file. (2) `burnRuleCreateSchema`
  carries two `.refine()` calls and is therefore a ZodEffects, so `.partial()` does not exist
  on it; a `burnRuleUpdateSchema` was added to the shared package. (3) The M5 brief's
  surface-map self-check greps for an ASCII hyphen, but the document's established convention
  is an em dash; both variants now print 0.
- **`burn_confirm_deliverable` cannot expose `review_status: 'rejected'`.** Its enum omits
  that value so the destructive transition is only reachable through the confirm-gated
  `burn_reject_deliverable`.
- **The docs catalog files burn tools under "Platform"** until M8 adds the
  `LAUNCHPAD_CATALOG` row and M10 adds the `APP_TOOL_MODULES` entry. The generated JSON is
  committed and `docs:catalog:check` is green; re-run `pnpm docs:catalog` after those
  milestones so the tools group under Burn.
- **No permission delta migration was needed.** The 22 `burn.*` rows were hand-authored in
  M2, so regenerating the manifest changed only `mcp_tools_scanned` (847 to 865); the total
  stays 1445 and `packages/permissions/src/generated/permissions.ts` had no diff.

## M6 - Engines, workers, events

- [x] Extraction, attribution, variance, inverse check, revaluation, change-order drafting
- [x] **11 queues:** `burn-extract-deliverables`, `burn-attribute-batch`, `burn-claim-reaper`, `burn-variance-sweep`, `burn-revalue`, `burn-silent-deliverable-sweep`, `burn-rollup-refresh`, `burn-calibration-recompute`, `burn-proposal-reconcile`, `burn-retention`, `burn-embed-sync`
- [x] `pg_advisory_xact_lock` in burn-api's sweep service. **HARD RULE: no lock-holding transaction contains an outbound HTTP call** - which is why extraction and attribute-batch use row claims, with each chunk checkpoint committed in its own transaction
- [x] 10 `burn` events plus 4 backfilled `bill` events in `event-catalog.ts`; `source:` precedes `event_type:` within 300 chars or the drift-guard regex misses it
- [x] Payloads carry refs and coarse bands only - no amounts, no `margin_pct`
- [x] **`burn-dispatch-hook.ts` in bolt-api**, wired into `event-ingestion.routes.ts` beside `dispatchToBraid`, forwarding to `${BURN_API_INTERNAL_URL}/v1/internal/events`, gated by a per-org Redis binding set on the `gate.service.ts` shape; plus `BURN_API_INTERNAL_URL` in bolt-api compose and catalog; plus the 16 subscriptions from §8.3
- [x] **LLM concurrency cap (§9.7.1):** Redis token bucket keyed `llm:bucket:<service>` in front of `POST /internal/llm/chat`; `LLM_INTERNAL_MAX_CONCURRENT_PER_SERVICE=4`, `LLM_INTERNAL_RATE_PER_MINUTE=120`, both in `env-hints.mjs` and `.env.example`; 429 + `Retry-After`; `burn-attribute-batch` defers a 429 to `pending_attribution`, never `unscoped`; extraction retries from checkpoint; done criterion is the two-service saturation test
- [x] `check:bolt-catalog` added to `lint.yml` (it exists in `package.json:35` and runs in no workflow today)
- [x] §12.1 assertions for §4, §8

## M6b - bill-api gate integration (the flagship feature)

- [x] `apps/bill-api/src/lib/burn-precheck.client.ts`: the suite's **first** circuit breaker. `burn:breaker:fails:<org>` INCR, `burn:breaker:state:<org>`, `NX` probe election on `burn:breaker:probe:<org>`, threshold 5, probe 30000ms. Every Redis touch goes through `withRedis()` (never throws) with a per-process `fallbackBreakers` in-process fallback. `allowed: true` on every error path; the ONLY `allowed: false` is an ENFORCED `deny` from burn-api
- [x] Coverage counter `burn:gate_calls:<org>:<yyyymmdd>` incremented in `recordGateAttempt` **on every gated write attempt including the unconfigured no-op** (ordering is load-bearing: count first, decide second) so a missing `BURN_API_INTERNAL_URL` reads as 0 percent coverage; the unconfigured/unavailable failure counters are kept as separate keys so the Gate Console can tell "nobody configured this" from "the service is down"
- [x] `burnPrecheck` preHandler on four hook points: `expenses.routes.ts` POST `/expenses` (`expenseCreateCharge`), PATCH `/expenses/:id` (`expenseUpdateCharge`, gated only on an amount/project change), POST `/expenses/:id/approve` (`expenseApproveCharge`), and `bill-recurring-generate.job.ts` via `createJobGate` - ONE breaker check per (job, org), memoized, not per schedule
- [x] `POST /internal/rates/resolve` + `POST /internal/rates/resolve-batch` (cap 500) in `apps/bill-api/src/routes/internal.routes.ts`, delegating to `rate.service.ts` `resolveRate()` so Bill stays the single definition of rate precedence (built in bill-api per the spec - Bill owns the rate algorithm; Burn must not restate it)
- [x] Internal line-item write `POST /internal/invoices/:id/line-items` accepting `acting_user_id` in the body (column from migration 0245); no trusted `X-Acting-User` header, per the platform pattern
- [x] Four `billEvents` present in `event-catalog.ts`: `expense.created`, `expense.approved`, `rate.created`, `rate.updated` (VERIFIED already registered from M6; publishers in `expenses.routes.ts` + rate routes emit them; not duplicated)
- [x] Breaker unit test file `apps/bill-api/test/burn-precheck-breaker.test.ts` (18 tests: closed/open/half-open transitions, single-flight NX probe election across 10 replicas, multi-replica tripping, per-org scoping, success-clears, Redis-failure fallback, coverage counters)
- [x] §12.1's five fail-open assertions `apps/bill-api/test/burn-precheck-failopen.test.ts` (23 tests): (a) burn unreachable, (b) breaker open (zero network cost), (c) timeout, (d) `BURN_API_INTERNAL_URL` unset -> `gate_not_configured`, (e) Redis unreachable -> `redis_unavailable`. In every case `allowed === true` (the expense posts). All 41 M6b tests green; typecheck clean for bill-api/burn-api/worker/shared; `check-bolt-catalog` reports 0 violations

## M7 - SPA

- [x] 7 screens (Portfolio Board, Unscoped Queue, Engagement detail, Gate Console, Variances/change-orders, Cost Rates, Settings + Rules editor)
- [x] Shell parity: sidebar (`w-[260px] bg-sidebar`, `bg-primary-600` badge, `SidebarPlatformFooter`), top bar (`LaunchpadTrigger`, breadcrumb, `OrgSwitcher`, search, Banter link, `NotificationsBell`, `HelpTrigger`, `UserMenu`), `<Launchpad currentApp="burn" />`, `globals.css` copied verbatim, `mountBureauClient` + `initSystemErrorReporter({service:'burn'})` + `@bigbluebam/bureau-client`, `PermissionsProvider`, auth store, loading gate, saved-theme, `?`-opens-Help
- [x] The one Bill SPA change (§7.8): the inline advisory-feedback control (`BurnGateNotice`) in `apps/bill/` on the expense create + approve flows

## M8 - Launchpad and infra

- [x] `LAUNCHPAD_APP_IDS` + `LAUNCHPAD_CATALOG` row
- [x] `import { Flame } from 'lucide-react'` + a `'flame': Flame` entry in `ICONS` at `packages/ui/launchpad.tsx:65` (absent today; falls back to `Box` at `:226`)
- [x] Launchpad grid overflow checked; condense in this change or state explicitly it still fits and file a `best-practices` issue
- [x] `docker-compose.yml` burn-api service (4022, `migrate` `service_completed_successfully`, postgres/redis `service_healthy`); `frontend.depends_on: burn-api`; `/burn/` added to the `frontend` entry's `public_paths`
- [x] Edit **the two source nginx configs only**, then regenerate `nginx.railway.conf` via `node scripts/gen-railway-configs.mjs`. Do not hand-edit `:8080` or the `$rw_upstream_NN` index. Reconcile the pre-existing `bill`/`bay`/`blip` alternation drift in the same change
- [x] `apps/frontend/Dockerfile` SPA lines; `services.mjs` catalog entry with `healthcheck: '/health'`; `gen-railway-configs.mjs`; `CLAUDE.md` inventory and routes; `.env.example`

## M9 - Deploy and test

- [x] Two migrate passes per §9.8
- [x] **Rebuild and force-recreate all ten:** `burn-api bill-api bolt-api worker mcp-server api basis-api braid-api bulwark-api frontend`. `frontend` is rebuilt **twice** - here for the SPA, and again in M10 after `help:index` for `docs/apps/` at `apps/frontend/Dockerfile:232`. Without the M9 rebuild, `/burn/` 404s and every Playwright story fails as a routing bug
- [x] Eleven convention gates (§12.4's ten plus M0's new `check:env-hints`)
- [x] §12.1 fully implemented; **no assertion deferred**
- [x] `appProject('burn')` in `apps/e2e/playwright.config.ts` projects array, specs at `apps/e2e/src/apps/burn/tests/` (`appProject` hardcodes `testDir: ./src/apps/${name}/tests`). Note `bin`, `bay`, `blip`, `bureau`, `blueprint` are all absent from that array today, so this failure is live in the repo and easy to repeat
- [x] Playwright user stories against gilligan, each verifying backend state via curl AND psql
- [x] `apps/integration-tests` case for the full expense → precheck → event → dispatch hook → work item → attribution → rollup chain, plus five negatives: `BURN_API_INTERNAL_URL` unset, burn-api stopped, breaker open, bill-api 404 on `/internal/rates/resolve`, Redis unreachable
- [x] A representative slice driven through MCP tools alone, producing the same rows and events

## M10 - Docs, screenshots, marketing

- [x] `docs/apps/burn/help.md` + `help-index.json` + Help Center
- [x] `burn` row in the hardcoded `APP_REGISTRY` at `scripts/docs/extract.mjs:63` (without it `docs/apps/burn/` is never emitted at all)
- [x] `APP_TOOL_MODULES` entry in `scripts/docs/lib/tool-source.mjs`
- [x] `docs:extract`, `docs:compose`, `docs:catalog`, `docs:manual` regenerated and committed
- [x] `marketing.md` + `docs:publish` + `APP_ICON`/`APP_COLOR` in `site/src/pages/docs.tsx` (the one sanctioned hand-edit)
- [x] MCP tool counts updated everywhere. Confirm whether the deprecated `burn_margin` alias counts before committing a number `pnpm docs:catalog` will contradict
- [x] **Two separate seeders:** author `scripts/seed-burn.mjs` and add `'seed-burn.mjs'` to the flat `PHASE_B` array in `scripts/seed-all.mjs` after `'seed-bill.mjs'`; separately author `scripts/seed-gilligan/burn.mjs` and add a trailing `{ name: 'Margin', files: ['burn.mjs'] }` group to `PHASES` in `run-all.mjs`, which must follow both the Billing and Knowledge groups
- [x] Gilligan screenshots
- [x] `frontend` rebuilt again after `help:index`

## M11 - Close-out

- [x] `close-out` skill passes every line
- [x] `BUILD_REPORT` written
- [x] Lock released
