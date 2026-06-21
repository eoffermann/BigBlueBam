# BigBlueBam 2026-04-14 Recovery Orchestration Plan

## Context

The previous attempt to complete the BigBlueBam design specs (2026-04-13 through the night of 2026-04-14) was rolled back after a cascade of harness and filesystem problems. The working tree is now on branch `recovery` at commit `a8fb19a` (`fix(platform): reconcile Drizzle/SQL drift via migration 0078`), and all prior wave branches plus `feature-completion-wip` have been deleted from both local and origin. The recovery commit contains the CI workflows, the migration runner bootstrap hook for 0023, biome lint unification, @types/dompurify removal, and migration 0078 (reconciling tasks/guest_invitations/impersonation_sessions/bearing_updates drift), but nothing from Wave 0.2 onward.

This plan is a corrected version of the user's 2026-04-14 orchestration instructions. The user's plan referenced data that existed in the prior attempt (specifically `docs/critiques/2026-04-13/` and the 13 per-app plan files under `docs/plans/2026-04-13-revised/`) but is no longer in the tree. The critiques directory does not exist at all, and only `DECISIONS.md` and `MIGRATION_LEDGER.md` survived under `docs/plans/2026-04-13-revised/`. The design audits directory also already contains `docs/design-audits/2026-04-09/` with 11 audits from an earlier pass, which the new 2026-04-14 audit phase should build on rather than start from scratch.

Corrections woven into this plan cover the missing data references, the consolidation of all 13 app design docs into `docs/early-design-documents/` (the user moved Beacon, Banter, and Helpdesk specs into that folder during planning), the branch strategy collision between "one PR off main" and "commit directly to recovery", the Windows worktree isolation failures observed last night, and the stale state of `MIGRATION_LEDGER.md`.

## Ground rules (non-negotiable)

These are the project rules from `CLAUDE.md` at repo root plus new rules the user set explicitly at the start of this session.

1. **Work out of branch `recovery`** until explicitly instructed otherwise. All work commits to `recovery` directly or through local feature branches that fast-forward back into `recovery`. No `main`, no `feature-completion-wip`, no remote PR workflow.
2. **Check in important files as you go.** Every time a new file is written or a non-trivial change is made to an updated file, commit to `recovery` and push to origin. Never leave hours of work uncommitted. This is the lesson of the prior night's filesystem incident.
3. **No em dashes anywhere.** In code, comments, commit messages, PR bodies, output, documentation. Reword.
4. **Every migration** must be idempotent (`IF NOT EXISTS`, guarded `DO $$ ... EXCEPTION` blocks for triggers and destructive ALTERs) and carry the `-- Why:` / `-- Client impact:` header. Filename must match `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$`. `pnpm lint:migrations` must pass.
5. **Never run `docker compose down -v`.** Preserve the seeded dev DB.
6. **Never edit an existing migration** file that has already been committed. The migrate runner records per-file SHA-256 checksums.
7. **Pre-existing errors are recorded, not dismissed.** If typecheck / lint / tests / db-check surface errors unrelated to the current task, record them in the relevant plan file and the orchestrator's PROGRESS.md, and fix the small obvious ones in the same task.
8. **Do not delegate understanding.** Every dispatched agent receives concrete file paths and exact gap IDs, not "work from the plan."
9. **Verify before editing.** If a plan cites `file:line` for a claim, re-read that line first. If reality differs, stop and record.
10. **Use relative paths in agent Edit/Write tool calls**, not absolute `H:\BigBlueBam\...` paths. The prior attempt repeatedly had absolute-path edits silently land on the main checkout instead of the agent worktree.
11. **Decisions you make without explicit user guidance** go into `docs/DECISIONS.md` (new file, created fresh in Step 1). Each entry records: the concern, the options considered, the choice, the rationale. The user can revisit after the run.

## Harness constraints learned last night

- **Windows worktree isolation is unreliable at scale.** Parallel `isolation: "worktree"` Agent dispatches accumulate locked `index.lock` files in `.git/worktrees/<id>/` that user-mode tools cannot release. Twelve stuck worktrees blocked the entire Wave 2 dispatch last night. **This plan does not use worktree isolation.** Agents work in the main `H:/BigBlueBam` checkout serialized one at a time, or in dedicated physical clones under `C:/Users/eoffe/AppData/Local/Temp/bbb-*/` when parallelism is essential.
- **Windows `pnpm install`** is flaky with `ERR_PNPM_ENOENT` rename races on `@modelcontextprotocol/sdk` and similar packages. Workaround: `pnpm install --node-linker=hoisted --ignore-scripts`. Every agent brief mentions this.
- **Node 22 is required**, not Node 17. Many shells default to Node 17 on this box. Agents should `nvm use 22.11.0` or explicitly prefix `PATH`.
- **Windows `rm -rf`** fails on pnpm symlink farms inside `node_modules`. Use `cmd.exe /c "rmdir /s /q <path>"` for cleanup.

## Step 1: Design audit phase

**Goal:** produce a fresh per-app design audit for each of the 13 B-apps plus a platform audit, landing under `docs/design-audits/2026-04-14/`. Each audit describes what is built, what is missing or partial, what diverges from the original design, and gives architectural guidance for filling gaps.

**Inputs available** (the user consolidated all 13 app design docs into a single folder; the plan reflects the post-consolidation layout):
- `docs/early-design-documents/Bearing_Design_Document.md` - comprehensive, 595 lines
- `docs/early-design-documents/Bench_Design_Document.md` - comprehensive, 436 lines
- `docs/early-design-documents/Bill_Design_Document.md` - comprehensive, 598 lines
- `docs/early-design-documents/Blank_Design_Document.md` - comprehensive, 448 lines
- `docs/early-design-documents/Blast_Design_Document.md` - comprehensive, 554 lines
- `docs/early-design-documents/Board_Design_Document.md` - comprehensive, 695 lines
- `docs/early-design-documents/Bolt_Design_Document.md` - comprehensive, 757 lines
- `docs/early-design-documents/Bond_Design_Document.md` - comprehensive, 692 lines
- `docs/early-design-documents/Book_Design_Document.md` - comprehensive, 512 lines
- `docs/early-design-documents/Brief_Design_Document.md` - comprehensive, ~800 lines
- `docs/early-design-documents/Banter_Design_Document.md` - comprehensive, ~1200 lines
- `docs/early-design-documents/Beacon_Design_Spec.md` - adequate, ~400 lines. Lifecycle and governance well defined; API surface and MCP tools are lighter than peer specs and the audit may need to extrapolate from CLAUDE.md and the codebase.
- `docs/early-design-documents/BigBlueBam_Helpdesk_Design_Document.md` - adequate, 499 lines. Core ticketing model and Bam integration defined; MCP tools mentioned but not detailed; phasing depth lower than peer specs.
- `docs/BigBlueBam_Design_Document.md` and `docs/BigBlueBam_Design_Document_v2.md` for platform and cross-app specification. v1 is the foundational spec (Kanban, sprints, phases, roles); v2 is the addendum covering data import, dashboards, Slack integration, git integration, task templates, recurring tasks, PWA, GDPR.
- `docs/architecture.md`, `docs/database.md`, `docs/mcp-server.md`, `docs/permissions.md`, and similar operational docs for platform context.
- **Per-app supplemental docs** at `docs/` root that the audits should also consult when relevant: `docs/banter-ui-alignment-plan.md`, `docs/beacon-development-plan.md`, `docs/beacon-frontend-fix-plan.md`, `docs/beacon-security-audit.md`, `docs/bearing-security-audit.md`, `docs/board-development-plan.md`, `docs/bolt-advanced-ui-strategy.md`, `docs/bolt-id-mapping-strategy.md`, `docs/bolt-security-audit.md`, `docs/brief-security-audit.md`, `docs/helpdesk-bbb-audit-findings.md`. These are not the design specs themselves but capture course-corrections and security review findings since v1 of each spec was written.
- **Prior audit pass** at `docs/design-audits/2026-04-09/`: 10 per-app audits plus `Platform-Design-Audit-2026-04-09-Pass-2.md`. These are older but describe gaps from that point; each new 2026-04-14 audit should reference its 2026-04-09 counterpart and note what has been addressed since then.
- `CLAUDE.md` at repo root: the canonical project summary listing all 13 apps, their routes, their internal ports, tool counts, and directory conventions.
- The live codebase at `a8fb19a`: 393 API src files, 104 API routes, 128 API schemas, 451 frontend src files, 107 frontend pages across the 13 apps. Per-app rough inventory is already recorded in Step 1 exploration and will be duplicated into the new audits.

**Design-doc health note (from the Step 1 exploration health report):** 11 of the 13 specs are comprehensive (data model, API, MCP tools, frontend, jobs, integrations all covered with depth). **Beacon** and **Helpdesk** are rated adequate rather than comprehensive - the auditor will need to lean more heavily on supplemental docs, CLAUDE.md, and the live codebase for those two. The audits should call out any gaps where the source spec is too thin to make a definitive "missing vs partial" call, so the planning phase can decide whether to fill in from the codebase or escalate.

**Outputs:**
- `docs/design-audits/2026-04-14/Beacon_Design_Audit.md`
- `docs/design-audits/2026-04-14/Bearing_Design_Audit.md`
- `docs/design-audits/2026-04-14/Bench_Design_Audit.md`
- `docs/design-audits/2026-04-14/Bill_Design_Audit.md`
- `docs/design-audits/2026-04-14/Blank_Design_Audit.md`
- `docs/design-audits/2026-04-14/Blast_Design_Audit.md`
- `docs/design-audits/2026-04-14/Board_Design_Audit.md`
- `docs/design-audits/2026-04-14/Bolt_Design_Audit.md`
- `docs/design-audits/2026-04-14/Bond_Design_Audit.md`
- `docs/design-audits/2026-04-14/Book_Design_Audit.md`
- `docs/design-audits/2026-04-14/Brief_Design_Audit.md`
- `docs/design-audits/2026-04-14/Banter_Design_Audit.md`
- `docs/design-audits/2026-04-14/Helpdesk_Design_Audit.md`
- `docs/design-audits/2026-04-14/Platform_Design_Audit.md`

**Audit document template** (each audit should follow this shape):
1. **Summary** - one paragraph stating overall completion percentage and health.
2. **Design sources consulted** - which design docs, spec docs, prior audits.
3. **Built and working** - concrete list of routes, schemas, pages, tools that exist and appear complete.
4. **Partial or divergent** - features that exist but differ from spec, with reason-to-believe (file path citations).
5. **Missing** - features from the spec with no implementation, grouped by priority.
6. **Architectural guidance** - for each missing or partial feature, a short paragraph on how to approach it, referencing existing patterns in the codebase that can be reused.
7. **Dependencies** - any cross-app dependencies (e.g. "needs Beacon search before Bolt rule library can work").
8. **Open questions** - things the audit author is uncertain about, flagged for the planning phase.

**Dispatch:**
- Launch **3 parallel agents** per batch, each handling one audit. Agents use the main worktree serially through a queue: launch 3 at a time, wait for all 3 to complete, launch the next 3. This is a hard parallelism cap to avoid the filesystem issues from last night. 14 audits at 3-at-a-time gives 5 batches (3+3+3+3+2). Each audit agent is given the exact design source paths, the prior audit file path, and the output file path. Agents READ the codebase and the design docs; they do not touch code. Agents commit their own audit file to `recovery` as soon as it is written and push.
- **Agent type:** `general-purpose` with explicit Read/Grep/Glob permissions. The `Explore` subagent type is appropriate for the first batch since it is pure research.
- Each agent's brief must include: the app name, the exact paths of its design sources, the exact path of the 2026-04-09 prior audit (if one exists), the output file path under `docs/design-audits/2026-04-14/`, a link to the audit template above, and a commit instruction that the agent should `git add docs/design-audits/2026-04-14/<App>_Design_Audit.md && git commit -m "docs(audit): 2026-04-14 <App> design audit" && git push origin recovery` at completion.

## Step 2: Planning phase

**Goal:** for each design audit from Step 1, produce a detailed implementation plan landing under `docs/plans/2026-04-14/`.

**Inputs:**
- `docs/design-audits/2026-04-14/*.md` from Step 1.
- The codebase at whatever `recovery` tip exists after Step 1 commits.
- Existing plan templates from `docs/plans/2026-04-13-revised/DECISIONS.md` and `MIGRATION_LEDGER.md` for format conventions only - the content is stale and should not be treated as authoritative plan content.

**Outputs:**
- `docs/plans/2026-04-14/Beacon_Plan.md`
- `docs/plans/2026-04-14/Bearing_Plan.md`
- `docs/plans/2026-04-14/Bench_Plan.md`
- `docs/plans/2026-04-14/Bill_Plan.md`
- `docs/plans/2026-04-14/Blank_Plan.md`
- `docs/plans/2026-04-14/Blast_Plan.md`
- `docs/plans/2026-04-14/Board_Plan.md`
- `docs/plans/2026-04-14/Bolt_Plan.md`
- `docs/plans/2026-04-14/Bond_Plan.md`
- `docs/plans/2026-04-14/Book_Plan.md`
- `docs/plans/2026-04-14/Brief_Plan.md`
- `docs/plans/2026-04-14/Banter_Plan.md`
- `docs/plans/2026-04-14/Helpdesk_Plan.md`
- `docs/plans/2026-04-14/Platform_Plan.md`
- `docs/plans/2026-04-14/Cross_Product_Plan.md` - a cross-cutting plan covering anything that spans multiple apps (shared Zod schemas, event catalog entries, canonical publishers, CI wiring).
- `docs/plans/2026-04-14/MIGRATION_LEDGER.md` - fresh ledger reserving numbers from 0079 upward, NOT reusing the stale ranges from `docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md`.
- `docs/plans/2026-04-14/PROGRESS.md` - wave tracking ledger used during Step 3.

**Migration number policy for Step 2:**
- The committed tree at `a8fb19a` has migrations through `0078_reconcile_bam_bearing_drift.sql`. **All numbers 0079 and higher are available.**
- The "reserved" ranges in the old `docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md` (0047-0077) are meaningless now because none of those files were committed. The new ledger at `docs/plans/2026-04-14/MIGRATION_LEDGER.md` starts claims at **0079** and assigns sequentially.
- Each per-app plan declares its migration needs in its "Migrations" section, with numbers claimed from the new ledger.

**Plan document template** (each plan should follow this shape):
1. **Scope** - which audit this plan executes, which gaps it closes.
2. **Gap inventory (G1..Gn)** - each gap numbered, with citation from the audit and a one-line summary.
3. **Migrations** - each migration file with its reserved number, purpose, idempotent body, header block, and client impact. Includes scratch-DB verification steps.
4. **Schemas and shared types** - any `packages/shared/src/schemas/<app>.ts` additions or changes.
5. **API routes and services** - file paths, function signatures, gap-to-file mapping.
6. **Frontend pages and components** - file paths, gap-to-file mapping.
7. **Worker jobs** - any new BullMQ handlers.
8. **MCP tools** - any new tool handlers under `apps/mcp-server/src/tools/`.
9. **Tests** - file paths and test coverage requirements per gap.
10. **Verification steps** - exact commands to run (`pnpm --filter @bigbluebam/<app>-api typecheck`, test, build, migration-lint, db-check).
11. **Out of scope** - things deliberately deferred, with pointers to where they will land.

**Cross-cutting topics the Cross_Product_Plan.md must cover:**
- Shared Zod schemas for any app that lacks them in `packages/shared/src/schemas/`.
- Bolt event catalog additions for new events emitted by any plan.
- The canonical `publishBoltEvent` signature from `packages/shared/src/bolt-events.ts` - this package does NOT exist at `a8fb19a`, so the Cross_Product_Plan must either create it or keep each app's local publisher. The planning-phase agent decides which; the decision is logged in `docs/DECISIONS.md`.
- The `scripts/check-bolt-catalog.mjs` drift guard and event-naming convention (bare names with explicit `source` argument, never prefixed). This also does not exist at `a8fb19a` and must be created or explicitly deferred.
- Any `packages/db-stubs`, `packages/logging`, `packages/service-health`, `packages/livekit-tokens` decisions the platform plan defers to cross-product scope.

**Dispatch:**
- Launch **up to 3 parallel planning agents** per batch through the same queue as Step 1. 15 plans (13 per-app + Platform + Cross_Product) at 3-at-a-time gives 5 batches.
- Each planning agent is given: the input audit path, the output plan path, the plan template, the fresh migration ledger path with instructions to append-only claim numbers, and the `docs/DECISIONS.md` path for design calls. Each plan commits its own plan file to `recovery` on completion and pushes.
- A single final "reconciliation" agent runs after all 15 plan files are committed. It reads every plan file, cross-references migration number claims in `MIGRATION_LEDGER.md`, verifies no number collisions, updates `PROGRESS.md` with the wave mapping, and commits.

## Step 3: Implementation orchestration

**Goal:** execute the 15 plans from Step 2 through dependency-ordered waves, landing all code on `recovery`.

**Dispatch policy:**
- **No worktree isolation.** All agents work in the main `H:/BigBlueBam` checkout and commit directly to `recovery`, or in a dedicated physical clone under `C:/Users/eoffe/AppData/Local/Temp/bbb-wave-N/` that the orchestrator creates on demand.
- **Serial within a wave.** Even waves that the plan describes as "parallel" run one agent at a time. The Windows filesystem is too flaky for concurrent multi-agent git operations. Total wall-clock cost goes up; total successful-commit rate goes up more. Judgment call per Ground Rule 11: serialize rather than risk another night of lost work.
- **Orchestrator commits after each merge.** After an agent finishes, the orchestrator reads its work, runs verification commands (typecheck, test, lint, db-check as applicable), and commits/pushes. If verification fails, the orchestrator either fixes the issue in place or dispatches a follow-up agent. The orchestrator's commit hygiene is the project's commit hygiene.

**Dependency-ordered waves:**

**Wave 0 - Foundation (serial, blocks everything else).** Same spirit as the prior attempt. Items:
- **0.1 Platform infra.** Whatever the new Platform_Plan.md identifies as unblockers. At minimum: CI workflows, error envelope, migrate bootstrap hook, db-check schema roots. At a8fb19a, several of these are already present, so 0.1 is likely smaller than last time.
- **0.2 MCP `/tools/call` transport.** If missing at `a8fb19a` (it is missing per the rollback), recreate the Wave 0.2 work from the Cross_Product_Plan.md: `POST /tools/call` route, X-Internal-Secret auth, `create-service-account` CLI. Reference: prior D-002 and D-003 decisions in the 2026-04-13-revised DECISIONS.md, which establish that `ApiClient` stays 3-arg and the service account prefix is `bbam_svc_`.
- **0.3 Shared bolt-events consolidation.** Create `packages/shared/src/bolt-events.ts` with the canonical 6+1-arg signature. Delete any existing per-service copies. Update imports. This work was done in the prior attempt and can be replicated from memory of the canonical skeleton, but the recovery tree has none of it, so it is re-implemented from scratch.
- **0.4 Event naming sweep + migration 0079.** Rename any prefixed event names (`bond.deal.rotting` -> `deal.rotting`), create migration 0079 (the next free number under the new ledger policy, replacing the old 0072 slot) to rewrite historical `bolt_executions.trigger_event` and `bolt_automations.trigger_event` entries. Create `scripts/check-bolt-catalog.mjs` drift guard.

**Wave 1 - Platform + shared schemas + catalog entries (serial).** Items:
- **1.A Auth/security.** RLS foundation + OAuth + API key rotation. Migrations from the new ledger (starting at whatever is free after Wave 0 claims). The RLS bypass-role strategy (prior D-016) applies here - log it fresh in DECISIONS.md.
- **1.B Event catalog entries.** Append missing entries to `apps/bolt-api/src/services/event-catalog.ts`. Exact list comes from the new Cross_Product_Plan.md.
- **1.C Shared Zod schemas.** Fill in `packages/shared/src/schemas/<app>.ts` for every app that lacks one. 11 of the 13 apps need this at `a8fb19a`.
- **1.D Shared infrastructure packages.** `packages/db-stubs`, `packages/logging` (with pino factory, request-id plugin, error handler, Sentry init), `packages/service-health`, `packages/livekit-tokens`. Plus the shared error handler rollout to every API service's `middleware/error-handler.ts`.

**Wave 2 - Per-app implementations (serial, one per app).** Each of the 13 per-app plans becomes one agent dispatch. No parallelism. Order: start with apps whose plans depend on no other app (usually Beacon, Bearing, Bench), then work through dependent ones. The new plans' "Dependencies" sections drive the order.

Each Wave 2 agent's done definition includes:
1. Implement all plan gaps.
2. Use shared Zod schemas from `packages/shared/src/schemas/<app>.ts`.
3. Use `@bigbluebam/logging`, `@bigbluebam/db-stubs` (created in Wave 1.D).
4. Promote the app's package to strict typecheck (if strict/advisory split is in the CI workflow at that point).
5. Un-skip any tests the prior attempt quarantined with `TODO(wave-2-<app>):` markers. **At `a8fb19a`, these markers do NOT exist**, so this is a no-op for this attempt unless Wave 1 re-introduces quarantine markers - which it should not if the mock-harness issues are fixed rather than deferred.
6. Convert core-table handlers to `request.withRls` in preparation for `BBB_RLS_ENFORCE=1` cutover (Wave 1.A foundation required).

**Wave 3 - Cross-product integration (serial).** Items:
- **3.1 Cross-app linking audit, notification fan-out, integration harness.** End-to-end test infrastructure that exercises the full Bam-to-Bond-to-Bolt-to-Beacon loop. This cannot run until Wave 2 per-app plans emit real events.
- **3.2 Banter approval DM redesign** as a Bolt automation template.

**Wave 4 - Housekeeping.** Items:
- **4.1 CLAUDE.md refresh.** Update app inventory, tool counts, stale claims. This is the **only** commit in the entire run that touches `CLAUDE.md`; Wave 0 through Wave 3 agents are forbidden from touching it.
- **4.2 CI workflows rest.** Integration, build-push, promote, migration-replay workflows from Platform_Plan if the new Platform plan lists them.
- **4.3 Qdrant provisioning, MinIO production audit, activity_log partitioning plan** - the P2 items that were deferred in the prior attempt.
- **4.4 `recovery` to `main` promotion decision.** Orchestrator halts here and writes a final status message. User makes the promotion call.
- **4.5 `POSTMORTEM.md`** at `docs/plans/2026-04-14/POSTMORTEM.md`.

## Verification strategy

**Per-step verification** runs after every commit:
- `pnpm --filter @bigbluebam/<pkg> build` where `<pkg>` is the package the step touched.
- `pnpm --filter @bigbluebam/<pkg> typecheck`.
- `pnpm --filter @bigbluebam/<pkg> test` if tests exist.
- `pnpm lint` (workspace biome) if any source file outside migrations was touched.
- `pnpm lint:migrations` if a migration file was added or changed.
- `pnpm db:check` if a schema file was added or changed.
- Scratch-DB apply-check for new migrations using `docker run --rm -d postgres:16-alpine` against a throwaway container - never the dev stack, never `docker compose down -v`.

**Cross-wave verification** runs after each wave merges:
- Full `pnpm lint && pnpm typecheck && pnpm test && pnpm lint:migrations && pnpm db:check` on a clean worktree.
- For any wave that changed runtime behavior: a manual smoke test exercising the changed surface.

**Global done definition** (copied and adapted from the original plan):
- All 15 plans merged to `recovery`.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm lint:migrations && pnpm db:check` green on a clean checkout of `recovery`.
- A canary automation loop (Bam `task.created` -> Bond activity -> `activity.logged` -> Bolt rule -> Beacon) runs end-to-end in a live dev stack. If the canary cannot run because dev stack cannot be rebuilt, the orchestrator says so explicitly and documents the blocker.
- `docs/plans/2026-04-14/POSTMORTEM.md` committed.
- Orchestrator halts and reports status. User decides whether to promote `recovery` to `main`.

## Critical files (paths the orchestrator will create or modify)

**New files (Step 1 produces these):**
- `docs/design-audits/2026-04-14/<App>_Design_Audit.md` for 13 apps plus `Platform_Design_Audit.md` (14 files total).
- `docs/DECISIONS.md` - at docs root. Created in Step 1 with an initial entry describing the recovery rollback and the new operating rules. Every subsequent decision appends here.

**New files (Step 2 produces these):**
- `docs/plans/2026-04-14/<App>_Plan.md` for 13 apps plus `Platform_Plan.md` and `Cross_Product_Plan.md` (15 files total).
- `docs/plans/2026-04-14/MIGRATION_LEDGER.md` - fresh, starting claims at 0079.
- `docs/plans/2026-04-14/PROGRESS.md` - wave tracker.

**Existing files touched by Step 3 (expected, not exhaustive):**
- `apps/api/src/plugins/rls.ts` (new, Wave 1.A).
- `apps/api/src/routes/oauth.routes.ts` (new, Wave 1.A).
- `apps/api/src/routes/api-key.routes.ts` (modified, Wave 1.A).
- `apps/api/src/db/schema/api-keys.ts`, `tasks.ts`, `sprints.ts` (modified, Wave 1.A).
- `apps/api/src/middleware/error-handler.ts` (modified, Wave 1.D).
- `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/routes/tools-call.ts` (Wave 0.2).
- `apps/mcp-server/src/env.ts`, `apps/api/src/cli.ts`, `docker-compose.yml`, `.env.example` (Wave 0.2).
- `apps/bolt-api/src/services/event-catalog.ts` (Wave 1.B append-only).
- `packages/shared/src/bolt-events.ts` (new, Wave 0.3).
- `packages/shared/src/schemas/<app>.ts` for 11 apps (new, Wave 1.C).
- `packages/shared/src/index.ts` (append-only re-exports, Wave 0.3 and 1.C).
- `packages/db-stubs/`, `packages/logging/`, `packages/service-health/`, `packages/livekit-tokens/` (new packages, Wave 1.D).
- `apps/*/src/middleware/error-handler.ts` for 14 API services (new or modified, Wave 1.D).
- `apps/*/src/db/schema/bbb-refs.ts` for 13 services (replaced with db-stubs re-export, Wave 1.D, with any canonical override carefully justified).
- `infra/postgres/migrations/0079_*.sql` onward (new migrations per wave plan claims).
- `scripts/check-bolt-catalog.mjs`, `scripts/check-no-local-bbb-refs.mjs` (Wave 0.4 and 1.D).
- `.github/workflows/test.yml`, `.github/workflows/typecheck.yml` (modified if Wave 1 adjusts build/test steps).
- `apps/<app>-api/vitest.config.ts` for any app whose test timeouts need a bump (avoid if possible).

**Orchestrator-owned files** (updated at every wave merge, committed same-turn):
- `docs/DECISIONS.md`
- `docs/plans/2026-04-14/PROGRESS.md`
- `docs/plans/2026-04-14/MIGRATION_LEDGER.md`

## Reuse from the prior attempt

Specific shapes and skeletons from the prior attempt that are safe to reuse (they are in conversation memory, not in any git history):
- The `publishBoltEvent` canonical 6+1-arg signature and skeleton.
- The RLS bypass-role strategy (prior D-016) for rolling out `0075_enable_rls_core_tables.sql` without forcing same-PR handler conversion.
- The MCP `POST /tools/call` route skeleton including the microtask-ordering guard that waits for the SDK handler wrapper to install.
- The `create-service-account` CLI shape with `bbam_svc_` prefix that does not disturb `auth.ts` prefix slicing.
- The migrate runner bootstrap hook pattern (ensuring a sentinel system user exists before 0023 runs on fresh DBs). **This is already in the tree at `a8fb19a`**, committed as `f1d035c`, so no re-implementation needed.
- The biome lint unification and rule warn-downgrade pattern. **Also in the tree at `a8fb19a`**.
- The vitest testTimeout / hookTimeout bumps. **NOT in the tree at `a8fb19a`**; Wave 0 or Wave 1 will re-introduce if tests hit the same cold-start issues.

## Known risks and mitigations

1. **Dispatch throughput.** Serializing every agent costs wall-clock time. Rough estimate: Step 1 takes 5 to 8 hours (14 audits at 20 to 35 minutes each), Step 2 takes 6 to 10 hours (15 plans at 25 to 40 minutes each), Step 3 takes 30 to 60 hours (15 implementations at 90 to 240 minutes each). Total roughly 2 to 3 days of wall clock. Acceptable trade-off vs. another night of filesystem disaster.
2. **Migration number drift.** The orchestrator's `MIGRATION_LEDGER.md` must be updated in the same commit that introduces each migration to prevent two plans both claiming the same number. Enforce with `pnpm lint:migrations`.
3. **Agent context pollution.** Every agent brief must include the relative-paths rule and the no-em-dashes rule. Put them at the top of every brief.
4. **Stale prior-attempt artifacts.** `docs/plans/2026-04-13-revised/DECISIONS.md` and `MIGRATION_LEDGER.md` still exist at `a8fb19a` and may confuse future readers. Step 1 includes a mini task: add a note at the top of each stale file saying "Superseded by docs/plans/2026-04-14/" and commit.
5. **User interruption of a serial run.** The run will take days. Each commit is a resumable checkpoint - `recovery` is always pushable, so if the orchestrator is killed and restarted, it can read `PROGRESS.md` to see where to pick up. This is the main defense against losing work.

## Verification section (end-to-end)

After all four waves complete, verify the following from a fresh clone of `recovery`:

```bash
# 1. Fresh checkout
git clone https://github.com/eoffermann/BigBlueBam.git /tmp/bbb-verify
cd /tmp/bbb-verify
git checkout recovery
pnpm install --node-linker=hoisted --ignore-scripts

# 2. Static checks
pnpm lint
pnpm -r --parallel --if-present typecheck
pnpm lint:migrations

# 3. Migration chain against a scratch DB
docker run --rm -d --name bbb-verify-pg \
  -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify \
  -p 55499:5432 postgres:16-alpine
sleep 5
pnpm --filter @bigbluebam/api build
DATABASE_URL='postgresql://verify:verify@localhost:55499/verify' \
  node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55499/verify' \
  pnpm db:check
docker rm -f bbb-verify-pg

# 4. Tests
pnpm -r --parallel --if-present test

# 5. Packages build
pnpm --filter './packages/*' build

# 6. Canary automation loop (in live dev stack, if dev stack is rebuildable)
# Exact commands come from the Cross_Product_Plan.md and depend on Wave 3 output.
```

If any step fails, the orchestrator records the failure in `docs/plans/2026-04-14/PROGRESS.md`, fixes it in a follow-up commit, and re-runs the verification from step 2 onward.
