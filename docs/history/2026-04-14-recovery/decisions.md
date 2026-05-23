# BigBlueBam Design and Implementation Decisions

This file records design and implementation decisions the orchestrator has made autonomously during the 2026-04-14 recovery run. Each entry documents the concern, the options considered, the choice, and the rationale. The user can revisit any decision after the run by reading this file; reverting is usually possible because `recovery` is a single branch that can be rebased or reverted atomically.

New entries append to the end. Never edit or delete prior entries without explicit user instruction.

## D-001: Recovery branch strategy (2026-04-14)

**Concern.** After the 2026-04-13 attempt was rolled back to commit `a8fb19a`, the branch strategy needed to be redefined. The prior attempt used per-wave feature branches off `main` with PRs into `feature-completion-wip`, which required complex merge logic and produced 20+ stale worktrees that eventually blocked the Wave 2 dispatch. The user's new instruction is to "work out of the branch `recovery` until told otherwise" and "check in important files as you go."

**Options.**
- (a) Replicate the prior pattern: per-wave feature branches off `recovery`, merged back as fast-forward. Preserves atomicity per wave but reintroduces complexity.
- (b) Commit directly to `recovery` with every meaningful change, using commit messages to demarcate waves and sub-waves. Simpler, matches user instruction literally, defends against work loss.
- (c) Hybrid: commit directly to `recovery` for infrastructure and coordination work, use short-lived local branches only for agent-isolated work that must be verified before merging.

**Choice.** (b). Every orchestrator and agent commit lands directly on `recovery` and pushes. No PRs, no feature branches, no remote merge workflow. Each commit is a resumable checkpoint.

**Rationale.** The primary risk in the prior attempt was work loss from uncommitted state and tangled branch topology. Option (b) eliminates both by making every change a durable push. The downside (less atomic wave boundaries) is accepted because commit messages and `docs/plans/2026-04-14/PROGRESS.md` give sufficient wave tracking.

**Revert.** If the user wants per-wave atomic revert points, we can cherry-pick commits out of `recovery` into a new branch after the fact, or use `git revert <range>` to back out a wave. The commit messages enumerate wave boundaries to make this tractable.

## D-002: No agent worktree isolation during this run (2026-04-14)

**Concern.** The 2026-04-13 attempt used `isolation: "worktree"` on every parallel agent dispatch. This caused a cascade of Windows filesystem failures: stuck `index.lock` files, half-checked-out worktrees, locked branches that could not be deleted. By the time Wave 2 was dispatched, 12+ broken worktrees littered `.git/worktrees/` and every new dispatch failed at the "Updating files" step. The entire Wave 2 phase was blocked.

**Options.**
- (a) Retry worktree isolation with a smaller parallelism cap (2 or 3 at a time). Still filesystem-prone.
- (b) Abandon worktree isolation. All agents share the main `H:/BigBlueBam` checkout. Serialize any agent that writes files. Use parallelism only for read-only Explore agents.
- (c) Use physical clones under `C:/Users/eoffe/AppData/Local/Temp/bbb-*/` for parallel-capable agents. Isolates filesystem but costs ~500MB per clone.

**Choice.** (b) for the default path. Write-capable agents serialize through the main worktree; read-only research agents can parallelize. Option (c) stays available for cases where serialization would cost a full day of wall clock (primarily the 14 audit agents in Step 1 and any Wave 3 integration work).

**Rationale.** Filesystem race conditions are the proximate cause of the prior night's failure. Eliminating the shared-filesystem-lock problem is more important than throughput. Read-only parallelism is safe because reads do not take exclusive locks. Physical clones are a controlled escape hatch for when throughput genuinely matters.

**Revert.** None needed. If a later wave's throughput demands force a return to worktree isolation, we can revisit with a clean set of stale-worktree cleanup scripts.

## D-003: Migration numbering starts at 0079 (2026-04-14)

**Concern.** The 2026-04-13 attempt's `docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md` reserved numbers 0047 through 0077 for various apps and platform items. None of those migration files were ever committed to a surviving branch. At `a8fb19a`, the highest committed migration is `0078_reconcile_bam_bearing_drift.sql`. The reserved ranges are stale.

**Options.**
- (a) Honor the old reserved ranges (0047-0077) and claim numbers from them as each plan needs one. Matches the prior attempt's mental model.
- (b) Ignore the old ranges. The new `docs/plans/2026-04-14/MIGRATION_LEDGER.md` starts claims at 0079 and assigns sequentially regardless of which app gets which number.
- (c) Re-reserve the old ranges in the new ledger but note they are now "free" and can be claimed by any plan.

**Choice.** (b). Fresh ledger, claims start at 0079, no legacy range allocation. Each plan claims numbers in the order plans are written, not per any pre-assigned app slot.

**Rationale.** Ranges 0047-0077 are a bookkeeping fiction at this point because the migrate runner only cares about what is on disk, and nothing with those numbers is on disk. Assigning sequentially from 0079 upward gives the new plans a clean sequence and avoids confusing future readers with 30 phantom numbers. The old ledger file at `docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md` gets a "superseded" notice at the top during Step 1.

**Revert.** None needed.

## D-004: Stale 2026-04-13-revised ledger files marked superseded, not deleted (2026-04-14)

**Concern.** `docs/plans/2026-04-13-revised/DECISIONS.md` and `docs/plans/2026-04-13-revised/MIGRATION_LEDGER.md` still exist at `a8fb19a`. Their content is authentic (they were committed by agents during the prior attempt) but is now misleading because the branches and PRs they reference are deleted. Future readers could mistake them for current state.

**Options.**
- (a) Delete both files. Simpler tree, no risk of confusion.
- (b) Leave both files in place with no annotation. Preserves history but confuses readers.
- (c) Add a "superseded" notice at the top of each, pointing readers at the 2026-04-14 files, and leave the content intact for archaeology.

**Choice.** (c). Both files get a one-paragraph header noting they are historical artifacts of an attempt that was rolled back, and pointing at `docs/plans/2026-04-14/` for the current ledger. Done in Step 1 as a small bookkeeping commit.

**Rationale.** The prior attempt's decisions (D-002, D-003, D-005 through D-008, D-011, D-016) contain useful context and pattern documentation that the new orchestrator references when replicating Wave 0.2 (MCP transport), Wave 0.3 (bolt-events consolidation), Wave 1.A (RLS rollout), and so on. Deleting them loses that institutional memory. A superseded notice resolves the "is this current?" question without losing the history.

**Revert.** If the user decides the old files are too confusing and should be deleted outright, a later commit can remove them. The superseded notice protects against accidental mis-reading in the meantime.

## D-005: Step 1 audit dispatch uses parallel Explore agents with orchestrator-side writes (2026-04-14)

**Concern.** Step 1 needs to produce 14 per-app and platform audit documents. Doing them serially at 20-35 minutes each is 5-8 hours of wall clock. Doing them in parallel with `general-purpose` agents reintroduces worktree contention.

**Options.**
- (a) Serial `general-purpose` agents, each writing its own audit file and committing. Safe, slow.
- (b) Parallel `Explore` agents (read-only, so no filesystem contention) that return audit markdown as their report; orchestrator writes each to disk and commits. Fast, safe.
- (c) Parallel `general-purpose` agents in separate physical clones. Fast, uses disk.

**Choice.** (b). Launch up to 3 Explore agents in parallel per batch (5 batches of 2-3 agents for 14 audits). Each agent reads the codebase and design sources and returns audit markdown content up to 600-900 words. The orchestrator writes the content to the target path and commits. Orchestrator handles all writes; agents handle all research.

**Rationale.** Read-only parallelism is safe. Putting writes in the orchestrator centralizes commit discipline and keeps the "commit as you go" rule in one code path. Audit documents at 600-900 words are sufficient for the planning phase that consumes them — the audit template does not require deep prose, just structured lists and citations.

**Revert.** If the audit depth proves too thin, individual audits can be re-run through a deeper general-purpose agent that takes the Explore agent's draft as input and expands it. Alternatively the pattern flips to Option (a) or (c) for the remaining batches.

## D-006: Detached HEAD after commit auto-recovery pattern (2026-04-14 Step 1)

**Concern.** During Step 1, Batches 2 and 4 unexpectedly committed onto a detached HEAD at `a8fb19a` instead of branch `recovery`, despite `git branch --show-current` returning `recovery` immediately before the commit. Whatever mechanism is reparenting HEAD happens between the branch check and `git commit`, and the pattern repeats deterministically. Root cause is still unidentified (hypothesis: one of the harness's internal git operations temporarily detaches HEAD as part of agent orchestration, and my commits land in that detached state).

**Options.**
- (a) Diagnose the root cause before proceeding. Requires instrumenting git hooks or tracing harness behavior. High time cost, unclear success.
- (b) Accept the detachment as an environmental given, and bake auto-recovery into every commit. Each commit is followed by a branch check; if HEAD is detached, the commit is cherry-picked back onto `recovery` and the detached commit is abandoned.
- (c) Use `git commit --branch recovery` or similar. Git has no such flag; this option does not exist.
- (d) Force-move `recovery` to HEAD with `git branch -f recovery HEAD` after each commit. Fragile if `recovery` has advanced concurrently.

**Choice.** (b). Every commit in Step 1 Batch 5 onward uses a one-liner shell check: after `git commit`, check `git branch --show-current`. If it is not `recovery`, capture the commit SHA, `git checkout recovery`, `git cherry-pick <sha>`. Works deterministically without requiring understanding of what causes the detachment.

**Rationale.** The recovery is cheap (a single cherry-pick) and idempotent. The root cause investigation would consume significant context and time for marginal benefit. Auto-recovery keeps work on `recovery` regardless of what happens to HEAD in between commits.

**Revert.** None needed. If the detached-HEAD behavior stops happening on its own, the auto-recovery becomes a harmless no-op.

**Scope.** This pattern is used for the rest of Step 1, Step 2, and Step 3. Every commit that writes orchestrator-owned files or creates new tree state goes through the same pattern.

## D-007: Bond worker publishBoltEvent retains silent failure, no pino logger pass-through (2026-04-14 Wave 0.3/0.4)

**Concern.** The worker's local `apps/worker/src/utils/bolt-events.ts` had a richer signature than the canonical `publishBoltEvent` in `@bigbluebam/shared`: it took an options object as the 4th argument and a pino Logger as the 5th, and logged pino warnings on non-2xx responses and on thrown errors. The canonical shared function is fully silent on failure (fire-and-forget). Converting the worker to use the shared function means per-row failures are no longer logged by the worker itself.

**Options.**
- (a) Keep a small worker-local wrapper that logs via pino, then delegates to the shared publisher. Preserves visibility. Costs one extra indirection per call and leaks a second signature into the workspace.
- (b) Accept silent failure at the publisher layer. Rely on bolt-api's own ingest logging and on the worker's outer sweep-level `logger.error` that catches thrown exceptions. Canonical behavior is consistent with every other service in the workspace.
- (c) Extend the canonical signature with an optional logger parameter. Breaks consistency for every existing caller and pushes worker concerns into a shared package.

**Choice.** (b). The worker's `utils/bolt-events.ts` is now a straight re-export from `@bigbluebam/shared`, and `bond-stale-deals.job.ts` calls the canonical 6+1-arg signature with `undefined` actor and `'system'` actor type.

**Rationale.** The Wave 0.3 plan explicitly says "call sites also need renormalizing to the canonical 6+1-arg signature in the same commit." Failures in `publishBoltEvent` are already swallowed at the shared layer precisely so that originating operations never crash on a missing/down bolt-api. The worker's visibility loss is limited to per-row HTTP failure reasons that were already logged at `warn`, not `error`. Recovery path: if a specific bolt-api outage needs per-row diagnostic, we can temporarily switch to a local wrapper at that site without touching the shared package. bolt-api's event-ingestion route already logs rejected requests on its side.

**Revert.** Swap `apps/worker/src/utils/bolt-events.ts` back to a local publisher and restore the 4-arg options-object call site in `bond-stale-deals.job.ts`. The job file's event-name migration (`bond.deal.rotting` to `deal.rotting`) is a separate commit and does not need reverting.

## D-008: Bond-api call sites get the canonical source argument; no local wrapper (2026-04-14 Wave 0.3)

**Concern.** `apps/bond-api/src/lib/bolt-events.ts` had a non-canonical 5-arg signature: `(eventType, payload, orgId, actorId?, actorType?)` with `source` hard-coded to `'bond'` inside the helper. Every bond-api call site (8 total across `activity.service.ts`, `contact.service.ts`, `deal.service.ts`) used this 5-arg shape.

**Options.**
- (a) Keep a bond-api-local wrapper that curries `'bond'` and delegates to the shared publisher. Minimizes call-site churn.
- (b) Update every bond-api call site to pass `'bond'` explicitly as the 2nd argument, matching the canonical 6-arg signature. Consistent with every other service.

**Choice.** (b). Edited all 8 bond-api call sites to insert `'bond'` as the explicit second argument and replaced the bond-api `lib/bolt-events.ts` with a re-export shim.

**Rationale.** The Wave 0.3 plan goal is a single canonical signature across the workspace. A local wrapper that hides `source` makes bond-api the odd one out and hides which source string reaches bolt-api's ingest route. Explicit is better than implicit here. The churn is 8 touch points in known files, fully mechanical.

**Revert.** None needed; if the 6-arg shape proves ergonomically painful, a helper like `publishBondEvent = (name, payload, orgId, actorId?, actorType?) => publishBoltEvent(name, 'bond', payload, orgId, actorId, actorType)` can be added at any time without touching the shared package.

## D-009: Edit-in-place fix for never-applied migrations 0103 and 0104 (2026-04-15 Wave 2)

**Concern.** While extracting Wave 2 migrations from the per-app plans, the generated `infra/postgres/migrations/0103_brief_yjs_state_tracking.sql` and `0104_brief_qdrant_embedded_at.sql` both referenced `brief_documents.organization_id`, but the actual column in `0024_brief_tables.sql` is `org_id`. The Brief subagent discovered this while wiring the yjs persistence service: the `CREATE INDEX` at line 9 of 0103 and line 9 of 0104 would fail, rolling back the whole transaction (including the `ADD COLUMN`), which would leave the migrate runner in a permanent failure loop on any fresh database. Because these migrations have never been successfully applied anywhere, no `schema_migrations` row exists and no checksum is cached.

**Options.**
- (a) Honor the "never edit a committed migration" rule literally and add a new migration 0120/0121 pair. This does not work: 0103 is tried before 0120 and fails, aborting the runner before 0120 runs.
- (b) Delete 0103 and 0104 outright and add replacement files at 0120/0121. Works but leaves ambiguous gaps in the numeric sequence and confuses future archaeologists.
- (c) Edit 0103 and 0104 in place to fix the column name. Safe precisely because neither has been applied, so no checksum mismatch is possible and no client DB has any rollback work to do.

**Choice.** (c). Both files edited to use `org_id` instead of `organization_id`. Commit message calls out that the fix is a recovery-of-never-applied-migration, not a retroactive rewrite.

**Rationale.** The ground rule exists to prevent checksum drift on already-applied migrations. Migrations that have never applied cannot drift; the rule's spirit (do not break deployed databases) is trivially satisfied. Option (c) is the simplest path forward and produces the cleanest history. Option (a) is a dead end and option (b) creates worse bookkeeping. If a deployed environment somehow already applied the broken 0103 via a path we have not seen, the fix would need to be a forward-only 0120/0121 step that ADDs the correct index; we can revisit if that happens.

**Revert.** None needed; the original broken SQL can be restored from git history if a concrete deployment is later found to have applied it. In that case, add 0120/0121 that drop the bad indexes and create the correct ones.

## D-010: Helpdesk multi-tenant routing: path-based slugs first, host-based subdomains deferred (2026-04-15)

**Concern.** The helpdesk portal historically lived at a single URL `/helpdesk/` and picked its host org via `SELECT * FROM helpdesk_settings LIMIT 1`. On a stack with two or more configured orgs (Mage Inc plus Frndo, say) the pick was non-deterministic at best and flat wrong at worst: customers could register under one org and end up with tickets routed to another, and there was no URL-visible way to tell which tenant's portal a visitor was on. The fix needed to make the tenant authoritative, visible in the URL, and flexible enough to accommodate per-project queues.

**Options.**
- (a) Path-based slug routing: `/helpdesk/<org-slug>/` as the canonical org portal, with an optional second segment `/helpdesk/<org-slug>/<project-slug>/` for per-project queues. The SPA parses the path on load, injects `X-Org-Slug` (and optionally `X-Project-Slug`) on every API call, and the helpdesk-api resolves those headers to org/project uuids via a tenant-resolution middleware. At `/helpdesk/` with no slug the SPA shows an org picker backed by a public discovery endpoint. Works on every deployment model including bare self-hosted, single-IP, no DNS.
- (b) Host-based subdomain routing: `support.mage-inc.example.com`, `support.frndo.example.com`, each vhost mapped to an org at the nginx layer. Clean UX, survives cookie-scoped auth without path rewrites, keeps the "/helpdesk/" URL sacred. Requires wildcard DNS (or per-org DNS provisioning), wildcard TLS certificates (or a cert per subdomain), and a customer-domain table at the data layer for custom-domain support. Not feasible on a self-hosted stack without operator-side DNS plumbing, and not feasible at all on deployments behind a corporate VPN where DNS is controlled centrally.
- (c) Query-param based: `/helpdesk/?org=mage-inc`. Trivial to implement but ugly, easy to drop on share, and breaks bookmarks when the SPA does any client-side navigation that does not preserve the query.

**Choice.** (a). This commit ships the path-based slug approach end-to-end: migration 0122 backfills `helpdesk_settings.default_project_id` per org (oldest-project fallback) and upgrades the FK to `ON DELETE SET NULL`; helpdesk-api gets a `resolve-tenant.ts` middleware plugin that reads `X-Org-Slug` / `X-Project-Slug` headers; the ticket-create, register, login, and admin settings routes all scope by tenant context rather than `LIMIT 1`; two new public discovery endpoints (`GET /helpdesk/public/orgs`, `GET /helpdesk/public/orgs/:slug`) feed the SPA's pre-login org picker and branding; the SPA parses the URL, exposes a `useTenantStore` with `orgSlug` / `projectSlug` / `orgName` / `projectName`, and the api fetch wrapper injects the headers automatically; the nginx `try_files $uri $uri/ /helpdesk/index.html` fallback already handles deep links like `/helpdesk/mage-inc/tickets/42`; an MCP tool `helpdesk_set_default_project` lets admins re-pick the default via slugs without writing SQL.

**Rationale.**
- Path-based works today on every deployment the project targets. Self-hosted single-compose stacks, Railway, bare-metal behind a reverse proxy: all of them serve a single public IP and a single TLS cert. Host-based would add a DNS and cert dependency that we cannot force operators to take on.
- Per-project portals (`/helpdesk/<org>/<project>/`) are included in the design now because multi-project orgs routinely want project-specific queues (e.g. a separate Mage Inc billing helpdesk and Mage Inc engineering helpdesk) and adding the second path segment after the fact would require rewriting every customer's bookmark.
- The SPA rollout is backwards compatible: if a request arrives without `X-Org-Slug` (an existing bookmark, a script hitting the API directly), every middleware branch falls back to the historical `LIMIT 1` behavior so no customer's existing session breaks. The header-injecting fetch wrapper is SPA-side only.
- Host-based subdomain routing stays an option: once a SaaS deployment wants `support.<org>.example.com` or custom domains, we add a `custom_domains` table keyed on hostname, a tiny nginx server-name-based rewrite that injects the `X-Org-Slug` header server-side, and the rest of the stack (middleware, SPA, MCP tool) keeps working unchanged because the resolution surface is the header, not the path. The path stays as a fallback for operators who do not want to touch DNS.

**Revert.** This is forward-only. If for some reason path-based routing needs to be rolled back, the SPA would revert to parsing `/helpdesk/tickets/...` without any tenant segment, the middleware would still be safe (header-less requests fall back to the legacy path), and the migration is net-additive (FK widening is invisible to existing queries). No destructive surgery is needed.

**Scope.** This entry covers the helpdesk portal only. Other apps (Bond, Brief, Bolt, etc.) already have per-org pages that live under the Bam frontend at `/b3/` and use Bam's session-org mechanism; they do not inherit this design. If future apps want a customer-facing unauthenticated portal, they should copy the pattern documented here.

**Future work.** Host-based subdomain routing with a `custom_domains` table and a host-to-org-slug nginx shim; see above for the structural sketch. Track as a follow-up once the first SaaS deployment asks for it.

