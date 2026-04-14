# 2026-04-13 Implementation Push — Progress Ledger

Tracker for the 13-plan multi-agent execution push. Committed after every meaningful state change.

**Base branch policy (2026-04-14):** All wave PRs target `feature-completion-wip`, NOT `main`. The WIP branch was created from `origin/main` on 2026-04-14 and collects every change from this push until the whole thing is ready to merge back to main as a single unit (or via cherry-picks - decided later). Agents must branch from `origin/feature-completion-wip`, not `origin/main`, and open PRs with `--base feature-completion-wip`.

**Ledger commit policy (from D-021 onward):** Every edit to this file, DECISIONS.md, or MIGRATION_LEDGER.md commits and pushes in the same turn. The orchestrator works inside a tracked worktree or a fresh clone where paths are verified. The old pattern of scratch-editing in an untracked directory was lost during the 2026-04-14 filesystem incident (see DECISIONS.md D-021).

**Legend:** `pending` / `in-flight` / `in-review` / `merged` / `blocked`

## Wave 0 — Foundation (P-1, blocks everything else)

| # | Item | Plan section | Status | PR | Merge commit |
|---|---|---|---|---|---|
| 0.1 | Platform infra baseline + migration 0023 runner bootstrap hook + helpdesk tsconfig + beacon-api lint swap + drift migration 0078 + dompurify + test quarantine + CI timeouts + e2e exclusion + apps typecheck advisory | Platform §3.1, §3.5-§3.7, §3.13, §3.23 plus D-005 through D-008 | **merged** | [#5](https://github.com/eoffermann/BigBlueBam/pull/5) | `1b77666` |
| 0.2 | MCP `POST /tools/call` transport (P-1.1) with bbam_svc_ service account prefix, Path 1 ApiClient | Cross-Product §4 Step 1 | **merged** | [#6](https://github.com/eoffermann/BigBlueBam/pull/6) | `2fffac9` |
| 0.3 | Shared `bolt-events.ts` consolidation; 12 per-service copies deleted; 2 enrichment helpers extracted; @types/node added to packages/shared; 9 apps declared workspace dep | Cross-Product §4 Step 3 (P0.2) | **merged** | [#7](https://github.com/eoffermann/BigBlueBam/pull/7) | `b46505f` |
| 0.4 | Event naming sweep + migration 0072 + new `scripts/check-bolt-catalog.mjs` drift-guard; `bond.deal.rotting` renamed to `deal.rotting`; `bolt_executions.trigger_event` handled as jsonb | Cross-Product §4 Step 4 (P0.3) | **merged** | [#8](https://github.com/eoffermann/BigBlueBam/pull/8) | `cf20b44` |

**Wave 0 exit gate: ACHIEVED at commit `cf20b44`.** All P-1 and P0 foundation items are in `feature-completion-wip`.

## Wave 1 — Platform + shared schemas + catalog entries (4 parallel agents, per D-015)

| # | Item | Plan sections | Status | PR | Merge commit |
|---|---|---|---|---|---|
| 1.A | Auth/security: RLS foundation (migration 0075) + OAuth (GitHub + Google) + API key rotation (migration 0077). Bypass-role rollout strategy per D-016. Also fixed Drizzle drift for `tasks.org_id` and `sprints.org_id`. | Platform §3.3, §3.12, §3.14 | **merged** | [#10](https://github.com/eoffermann/BigBlueBam/pull/10) | `1c747c2` |
| 1.B | Event catalog missing entries: `deal.rotting`, `campaign.completed`, `campaign.scheduled`, `engagement.opened/clicked/unsubscribed/bounced`, `elements_promoted`, `locked`, `unlocked` | Cross-Product §4 Step 2.2 (P0.1) | **merged** | [#9](https://github.com/eoffermann/BigBlueBam/pull/9) | `5d5a7c7` |
| 1.C | Shared Zod schemas for 11 apps (banter, beacon, bench, bill, blank, blast, board, bolt, bond, book, helpdesk) - approximately 210 schemas | Platform §3.17 / Cross-Product §4 Step 6 (P0.4) | **merged** | [#11](https://github.com/eoffermann/BigBlueBam/pull/11) | `8322749` |
| 1.D | Shared infra packages (db-stubs §3.15, logging §3.19, request-ID plugin §3.20, service-health §3.21, error reporting §3.22, livekit-tokens §3.25) + shared error handler rollout (§3.13 part 2) to 13 API services | Platform §3.15, §3.19, §3.20, §3.21, §3.22, §3.25, §3.13 part 2 | in-flight | | |

**Superseded in Wave 1 per D-013:** §3.16 `packages/bolt-client` wrapper (conflicts with Wave 0.4 naming decision). §3.18 event prefix validator (already shipped as `scripts/check-bolt-catalog.mjs` in Wave 0.4).

**Deferred from Wave 1 to later waves or follow-up:** §3.3 per-handler RLS conversion (Wave 2 per-app plans). §3.4 activity_log partitioning (deferred). §3.8-§3.11 integration/build/promote/replay workflows (Wave 4 housekeeping). §3.24 Qdrant provisioning script (low-priority; Wave 2 or later). §3.26 MinIO production audit (Wave 4).

## Wave 2 — Per-app implementations (P0, 11 parallel agents)

Dispatched after Wave 1 verifies. Pending until Wave 1.D merges.

| # | App | Plan | Status | PR | Merge commit |
|---|---|---|---|---|---|
| 2.01 | Beacon | `Beacon_Plan.md` | pending | | |
| 2.02 | Bearing | `Bearing_Plan.md` | pending | | |
| 2.03 | Bench | `Bench_Plan.md` | pending | | |
| 2.04 | Bill | `Bill_Plan.md` | pending | | |
| 2.05 | Blank | `Blank_Plan.md` | pending | | |
| 2.06 | Blast | `Blast_Plan.md` | pending | | |
| 2.07 | Board | `Board_Plan.md` (Excalidraw, not tldraw/Yjs) | pending | | |
| 2.08 | Bolt | `Bolt_Plan.md` (AI assist, manual trigger, schedule tick) | pending | | |
| 2.09 | Bond | `Bond_Plan.md` | pending | | |
| 2.10 | Book | `Book_Plan.md` | pending | | |
| 2.11 | Brief | `Brief_Plan.md` (REST-write freeze, Yjs) | pending | | |

Each Wave 2 per-app plan's done definition MUST include:
1. Unskipping and fixing the relevant tests in the "Skipped tests tracked for Wave 2 follow-up" table below.
2. Promoting the package into the strict typecheck filter (remove `continue-on-error: true` for its own package).
3. Converting any core-table route handlers to use `request.withRls` in preparation for `BBB_RLS_ENFORCE=1` cutover.

## Wave 3 — Cross-product integration (P1)

| # | Item | Plan section | Status | PR | Merge commit |
|---|---|---|---|---|---|
| 3.1 | Cross-app linking audit, notification fan-out, integration harness | Cross-Product §4 Step 8, Step 10, Step 11 | pending | | |
| 3.2 | Banter approval DM redesign as Bolt automation template | Cross-Product §4 Step 9 | pending | | |

## Wave 4 — Housekeeping

| # | Item | Status |
|---|---|---|
| 4.1 | CLAUDE.md refresh (app inventory, tool counts, 8 stale claims in Platform Appendix A) | pending |
| 4.2 | Platform §3.8-§3.11 integration/build/promote/replay CI workflows | pending |
| 4.3 | Platform §3.24 Qdrant provisioning script | pending |
| 4.4 | Platform §3.26 MinIO production audit | pending |
| 4.5 | `main` <- `stable` promotion decision for `feature-completion-wip` merge-back | pending |
| 4.6 | `POSTMORTEM.md` at `docs/plans/2026-04-13-revised/POSTMORTEM.md` | pending |

## Open blockers / escalations

_None at 2026-04-14 late afternoon. D-021 incident closed; recovery committed directly to `feature-completion-wip`._

## Skipped tests tracked for Wave 2 follow-up

The following tests were quarantined with `it.skip` by the Wave 0.1 second follow-up agent (PR #5) to unblock CI. Each was a fixture or mock-assertion regression that the first fresh-DB CI run surfaced once migration 0023's cold-start abort was fixed. Each Wave 2 per-app plan's done definition MUST include unskipping and fixing the relevant tests before the plan merges.

| File | Test | Symptom | Plan |
|---|---|---|---|
| `apps/bench-api/test/dashboard.test.ts` | `Dashboard Service > listDashboards > returns empty array when no dashboards exist` | Test timed out in 5000ms | `Bench_Plan.md` |
| `apps/bench-api/test/dashboard.test.ts` | `Dashboard Service > listDashboards > returns dashboards with widget counts` | AssertionError: received `widget_count: 0`, expected `widget_count: 3` | `Bench_Plan.md` |
| `apps/bench-api/test/widget.test.ts` | `Widget Service > getWidget > returns a widget by id` | Test timed out in 5000ms | `Bench_Plan.md` |
| `apps/blank-api/test/field.test.ts` | `Field Service > addField > creates a field for a form` | Test timed out in 5000ms | `Blank_Plan.md` |
| `apps/blank-api/test/submission.test.ts` | `Submission Service > getSubmission > returns a submission` | Test timed out in 5000ms | `Blank_Plan.md` |
| `apps/blank-api/test/form.test.ts` | `Form Service > listForms > returns empty array when no forms exist` | Test timed out in 5000ms | `Blank_Plan.md` |
| `apps/blank-api/test/form.test.ts` | `Form Service > listForms > returns forms with submission and field counts` | AssertionError: received shape does not include `submission_count`/`field_count` | `Blank_Plan.md` |

All seven `.skip` markers have a `TODO(wave-2-<app>):` comment pointing at the owning plan. Search `TODO(wave-2-bench)` / `TODO(wave-2-blank)` to find them.

## Packages marked advisory in CI typecheck (Wave 0.1 D-008f)

`.github/workflows/typecheck.yml` currently runs a strict step over `packages/shared` and an advisory step (with `continue-on-error: true`) over all `apps/*` packages. Approximately 100 pre-existing typecheck errors are logged but do not fail CI. Each Wave 2 per-app plan MUST promote its own package to strict as part of the plan's done definition.

## Definition of done (global)

- All 13 plans merged into `feature-completion-wip` (not `main` for now).
- `pnpm lint && pnpm typecheck && pnpm test && pnpm lint:migrations && pnpm db:check` green on a clean checkout.
- `apps/e2e/crossproduct/` harness green against a fresh `docker compose up` stack.
- Canary automation loop (Bam `task.created` -> Bond activity -> `activity.logged` -> Bolt rule -> Beacon) runs end-to-end.
- Decision on promoting `feature-completion-wip` to `main` (and then `main` to `stable`) made with user review.
- `POSTMORTEM.md` committed.
