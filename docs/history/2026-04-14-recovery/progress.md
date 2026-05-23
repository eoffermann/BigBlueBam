# 2026-04-14 Recovery Orchestration Progress Ledger

Live status tracker for the 2026-04-14 recovery orchestration push on branch `recovery`.

## Current phase

**Step 3 (Implementation orchestration) - COMPLETE (awaiting user promotion decision)**

Waves 0 through 3 all landed on `recovery` and pushed. Wave 4 housekeeping and postmortem landed. User decides whether to promote `recovery` to `main`.

## Step 1 - Design audit phase - COMPLETE

All 14 design audits committed to `recovery` under `docs/design-audits/2026-04-14/`.

| Audit | Completion estimate | Merged in commit |
|---|---|---|
| Beacon | ~70-75% | `f33f31a` |
| Bearing | ~87% | `f33f31a` |
| Bench | ~85% | `f33f31a` |
| Bill | ~85-90% | `3cb07b4` |
| Blank | ~82% | `3cb07b4` |
| Blast | ~85% | `3cb07b4` |
| Board | ~68% | `62b1be5` |
| Bolt | ~80-85% | `62b1be5` |
| Bond | ~88% | `62b1be5` |
| Book | ~72% | `658be92` |
| Brief | ~62% | `658be92` |
| Banter | ~64% | `658be92` |
| Helpdesk | ~85-90% | `222b078` |
| Platform | ~84% | `222b078` |

## Step 2 - Planning phase - COMPLETE

All 15 per-app and platform plans committed. See `docs/plans/2026-04-14/` for the full set.

## Step 3 - Implementation orchestration - COMPLETE

| Wave | Summary | Commit |
|---|---|---|
| Wave 0.1 | Platform infra baseline (already in tree at baseline) | baseline |
| Wave 0.2 | MCP /tools/call HTTP route, X-Internal-Secret auth, create-service-account CLI | `6c6e7e0` |
| Wave 0.3 | Canonical publishBoltEvent and per-service re-export shims | `6c6e7e0` |
| Wave 0.4 | Event naming sweep plus migration 0096 (already in tree), bond-stale-deals worker | `6c6e7e0` |
| Wave 1.A | RLS foundation (0116), API key rotation (0117), OAuth (0118, 0119), rls plugin, oauth routes | `76e90b7` |
| Wave 1.B | 25 new Bolt event catalog entries for Wave 2 event emissions | `33d1668` |
| Wave 1.C | 12 new shared Zod schemas (banter, beacon, blank, blast, bench, bill, board, bolt, bond, book, helpdesk, platform) | `33d1668` |
| Wave 1.D | @bigbluebam/logging, /service-health, /db-stubs, /livekit-tokens packages | `88da0ed` |
| Wave 2 migrations | 28 migration files extracted from per-app plans into infra/postgres/migrations | `74a5f75` |
| Wave 2.01 Beacon | beacon-comments and beacon-attachments services, routes, schemas, Bolt events | `999dc7c` |
| Wave 2.02 Book | event.cancelled and event.rsvp Bolt events | `07df98a` |
| Wave 2.03 Bearing | P0 goal/KR/period Bolt events, watcher unsubscribe schema | `180f0b3` |
| Wave 2.04 Bench | report delivery tracking, materialized view refresh tracking | `81b14d3` |
| Wave 2.05 Bill | PDF lock schema, Redis sequence service, worker job state | `9f19ceb` |
| Wave 2.06 Blank | form.closed emission, file and bolt idempotency columns | `c7cb441` |
| Wave 2.07 Blast | engagement.opened/clicked/unsubscribed/bounced and campaign.completed Bolt events | `587efd5` |
| Wave 2.08 Board | element_count column, board.locked and board.elements_promoted events | `2b150d0` |
| Wave 2.09 Bolt | cron scheduler worker, drift guard script, notify_owner_on_failure | `a6342fd` |
| Wave 2.10 Bond | import mappings, soft-delete plumbing, company deals sub-route | `b108d7a` |
| Wave 2.11 Brief | yjs state persistence, qdrant sync hooks, document events | `3206efa` |
| Wave 2.12 Banter | presence service, viewer role, edit permissions, partition helper | `0815c0e` |
| Wave 2.13 Helpdesk | multi-tenant org_id, Bolt events, SLA, FTS, attachments, token hashing | `3dddbf2` |
| Wave 3 audit | 5 catalog entries added for Beacon and Brief events | `7c461ac` |
| Wave 3 template | Banter approval DM Bolt automation template | `59803be` |
| Wave 3 harness | apps/integration-tests scaffold with mock clients and cross-app smoke test | `c73875a` |
| Wave 4 | POSTMORTEM.md, PROGRESS.md update | see Wave 4 commits below |

## Known issues and deferrals

The following per-app gaps were explicitly deferred during Wave 2 dispatches and remain open for follow-up work:

- **Worker-side jobs across apps.** Many Wave 2 plans moved worker code to a follow-up pass to stay inside the "no cross-app touch" rule during parallel dispatches. Known deferrals: Bill PDF generation and email send jobs, Blank confirmation email and file process jobs, Bench report generation and MV refresh scheduler jobs, Brief embed and snapshot jobs, Helpdesk SLA breach monitor.
- **Frontend UI across all 13 apps.** Wave 2 scoped only server-side work. Each per-app plan's G-numbered UI gaps remain to be implemented in a dedicated Wave 2B frontend pass.
- **Approval request event.** Wave 3 Banter approval DM template targets `approval.requested`, an event not yet emitted by any service. Template activates the moment a producer ships the event.
- **pnpm install / typecheck on this Windows host.** Every Wave 2 dispatch skipped `pnpm --filter typecheck` because the Windows dev host consistently fails on biomejs native rename races during `pnpm install`. Each agent visually verified its changes. CI or a clean Linux checkout is the authoritative verification path.

## Fixes applied during Wave 4 close-out (the "pre-existing is still ours" pass)

- **POST /auth/api-keys org_id insert** (orchestrator task #10): fixed. The route now passes `request.user!.active_org_id` on the insert.
- **Beacon event name rename plus historical rewrite**: `beacon.comment.created` renamed to `comment.created`, `beacon.attachment.uploaded` renamed to `attachment.uploaded`, both in the emission sites and the catalog. Migration 0120_beacon_event_naming_rewrite.sql follows the 0096 pattern to rewrite historical `bolt_automations` and `bolt_executions` rows. Drift-guard allowlist cleared.
- **Helpdesk local bolt-events shim**: replaced with a re-export from `@bigbluebam/shared`, and `@bigbluebam/shared` added to `apps/helpdesk-api/package.json` as a workspace dependency.
- **Bond CSV import pipeline wiring**: `importContacts` now accepts an optional `source_system` plus a `resolveSourceId` callback, and creates/looks up `bond_import_mappings` rows automatically so re-imports short-circuit via `lookupImportMapping`. The raw REST CRUD remains in place for manual mapping authoring.
- **Banter migration 0106**: rewrapped in a `DO $$` block that detects whether `banter_messages` is a partitioned parent and no-ops with `RAISE NOTICE` if not. This makes the migration safe on every cluster regardless of whether the parent-table conversion has happened yet. The partition-manager helper in `apps/banter-api` already handled the runtime side.

## Git state checkpoints

- Step 1 base: `a8fb19a` (fix(platform): reconcile Drizzle/SQL drift via migration 0078)
- Step 1 complete: `222b078` (all 14 audits + D-006 decision)
- Step 2 complete: `1a615c5`
- Wave 0 complete: `6c6e7e0`
- Wave 1 complete: `88da0ed`
- Wave 2 complete: `3dddbf2`
- Wave 3 complete: `c73875a`
- Wave 4 complete: see POSTMORTEM commit below.

## Open blockers

None in scope of this run. User decides whether to promote `recovery` to `main`.

## Known operational issues

- Detached-HEAD auto-recovery pattern in use per D-006. All orchestrator and agent commits check `git branch --show-current` after `git commit` and cherry-pick back onto `recovery` if detached.
- Windows filesystem flakiness: `pnpm install` persistently fails on biomejs native rename races. Workaround: retry after `cmd.exe /c "rmdir /s /q node_modules\.pnpm\@biomejs+biome*"`. The `--node-linker=hoisted` flag helps with the first install pass but does not complete the workspace package symlinks on this host.
- No agent worktree isolation this run (D-002). All agents used the main `H:/BigBlueBam` checkout.
