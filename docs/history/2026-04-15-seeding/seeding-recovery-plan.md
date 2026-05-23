# Plan: wipe postgres volume, restore dev stack, document seeding gaps

> **Status:** Approved 2026-04-15. Execution steps are in progress. The gap analysis in the second half of this doc stands on its own and is the authoritative reference for the follow-up seeding work.

## Context

**Why.** The Windows auto-update on the night of 2026-04-14 left the BigBlueBam dev host in a broken state: no `.env` file at `H:\BigBlueBam\.env` (gitignored; never touched by the orchestrator this session; confirmed `git log --all -- .env` is empty), Docker Desktop not running, and the user confirmed the existing postgres data is lost and the volume should be wiped. Before we can get a working test stack back, we need (a) a fresh postgres volume, (b) a re-created `.env`, and (c) honest clarity on whether the existing seeding under `scripts/` is enough to exercise every feature of the app suite for human-centric testing. The orchestration run committed 24 commits this session that added Wave 2 tables, columns, and features (migrations 0079 through 0120), most of which have **no seed data yet**, so the scripts under `scripts/` are already stale relative to the tree on `recovery`.

**Intended outcome.** After the plan executes:

1. The postgres Docker volume `bigbluebam_postgres_data` is deleted and re-created empty.
2. The dev stack boots cleanly (once the user restores `.env`).
3. This document is checked in and readable on any device as a permanent record of what needs to be added next.
4. Existing seed scripts are **not** modified in this pass. The user sees the gap analysis first and decides scope. P0 implementation is a follow-up.

## Scope in this pass

- Volume wipe (`docker volume rm bigbluebam_postgres_data`) and associated cleanup.
- Bring Docker Desktop back up, start the stack so migrations apply on a clean DB.
- Re-create `.env` from `.env.example` using generated 32-char hex defaults for secrets (user chose this path).
- Commit this plan to the repo so it lives in one place forever.
- **No** new seed script authoring in this pass. **No** modifications to existing seed scripts. Those are a follow-up the user decides to approve after seeing the gap analysis.

## Actions

### Action 1: pre-flight checks (read-only)

1. `docker ps -a` to confirm no containers are currently running.
2. `docker volume ls | grep bigbluebam` to confirm `bigbluebam_postgres_data` exists.
3. `docker volume inspect bigbluebam_postgres_data` to record the mountpoint and driver for the audit trail.
4. `ls -la H:\BigBlueBam\.env.example` to confirm the template is still on disk (it is; modified during Wave 0.2 to add `INTERNAL_SERVICE_SECRET` and `MCP_INTERNAL_API_TOKEN`).

### Action 2: wipe the volume

1. `docker volume rm bigbluebam_postgres_data`. This is the only destructive action. If Docker Desktop is down, start it first via the Windows Start menu or `"C:\Program Files\Docker\Docker\Docker Desktop.exe"` and re-check.
2. Leave the other volumes (`bigbluebam_redis_data`, `bigbluebam_minio_data`, `bigbluebam_qdrant_data`) untouched. The user only asked to wipe postgres; MinIO + Redis + Qdrant data are orthogonal to the broken .env and recovering them saves time on restart.

### Action 3: restore `.env` with generated dev defaults

User chose the "generate dev defaults for me" path. Concrete actions:

1. Copy `.env.example` to `.env` (via Write tool, not shell copy, so line endings and content are deterministic).
2. For each secret placeholder, replace with a generated value:
   - `POSTGRES_USER=bigbluebam`
   - `POSTGRES_PASSWORD=<32-char random hex>`
   - `REDIS_PASSWORD=<32-char random hex>`
   - `MINIO_ROOT_USER=bigbluebam`
   - `MINIO_ROOT_PASSWORD=<32-char random hex>`
   - `SESSION_SECRET=<32-char random hex>`
   - `INTERNAL_HELPDESK_SECRET=<32-char random hex>`
   - `INTERNAL_SERVICE_SECRET=<32-char random hex>`
   - `MCP_INTERNAL_API_TOKEN=` (left blank; filled after Action 4 Step 5 via `create-service-account`)
3. Generate the random hex via `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` (repeated per secret) to avoid hardcoding fake-looking placeholders.
4. Print the resulting `.env` summary to the user so they can copy any secrets they want to preserve long-term (e.g., paste into a password manager for reproducibility across future wipes). These are dev-only secrets, not production values.

### Action 4: bring the stack up

1. `docker compose up -d postgres` first, let the `migrate` sidecar run (it bind-mounts `./infra/postgres/migrations` live, so all 30 new Wave 2 migrations apply to the empty volume).
2. `docker compose exec -T postgres psql -U $POSTGRES_USER -d bigbluebam -c "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 10"` to confirm 0120 is the tip.
3. `docker compose up -d` for the rest of the stack.
4. `docker compose ps` to confirm everything is healthy.
5. `docker compose exec api node dist/cli.js create-admin --email <user-provided> --password <user-provided> --name "Admin" --org "Mage Inc"` to restore the bootstrap user and org.

### Action 5: commit this plan doc

Write `docs/plans/2026-04-15/SEEDING_RECOVERY_PLAN.md` (this file), stage, commit to `recovery`, push. This is the "put it on disk so I can read it on a tablet" action.

### Action 6: verify and report

1. `docker compose exec -T postgres psql -U $POSTGRES_USER -d bigbluebam -c "SELECT COUNT(*) FROM organizations"` should return 1.
2. `docker compose exec -T postgres psql -U $POSTGRES_USER -d bigbluebam -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"` should show new Wave 2 tables (beacon_comments, beacon_attachments, bond_import_mappings, helpdesk_sla_breaches, banter_user_presence, etc).
3. `curl http://localhost/b3/` and other `http://localhost/<app>/` endpoints should return 200 / 302.
4. Report to the user: what's up, what's empty (everything, except the admin org), and point them at this doc.

---

## Gap Analysis

### TL;DR

19 seed files under `scripts/`, but the dev stack cannot come back up fully populated from this set after a wipe. Three hard problems: **(a)** 13 of 19 files hardcode the Mage Inc org UUID `57158e52-227d-4903-b0d8-d9f3c4910f61` plus 10 user UUIDs that do not exist in a fresh DB, so they fail on first run; **(b)** Banter has **zero** seed coverage and Helpdesk has one narrow script (`seed-conversations.js`) that depends on a pre-existing agent and live helpdesk-api; **(c)** every column and table added in Wave 2 (migrations 0079 through 0120) has no seed data: no Beacon comments, no Bill PDF locks, no Bond import mappings, no Helpdesk SLA breaches, no Banter presence, no OAuth user links, no API key rotations. Fixing this requires a master orchestrator `scripts/seed-all.mjs`, three new seeders (`seed-banter.mjs`, `seed-helpdesk.mjs`, `seed-platform.mjs`), UUID decoupling via a `SEED_ORG_SLUG` env var, and a `seed` profile sidecar in `docker-compose.yml`.

### Per-app coverage matrix

| # | Surface | Status | Primary files | Wave 2 coverage |
|---|---------|--------|---------------|-----------------|
| 1 | Platform (Bam core) | Inadequate | `apps/api/src/cli.ts` (manual CLI), no data seed | No RLS / 0116 demo, no OAuth / 0118-0119, no API-key rotation / 0117 |
| 2 | Beacon | Adequate demo | `scripts/seed-beacons.js` (5000 entries) | No `beacon_comments` (0079), no `beacon_attachments` (0080), no post-rename event examples (0120) |
| 3 | Bearing | Complete | `scripts/seed-bearing.mjs` + `seed-bearing.sql` | Missing only `bearing_goal_watcher_unsubscribe_tokens` (0083) |
| 4 | Bench | Inadequate | `scripts/seed-bench.sql` | No `bench_report_deliveries` (0084), no refresh tracking (0085) |
| 5 | Bill | Adequate demo | `scripts/seed-bill.mjs` | No `bill_pdf_locks` (0086), no expense receipts (0087), no worker job state (0088) |
| 6 | Blank | Inadequate | `scripts/seed-blank.sql` | No `blank_file_processing_status` (0089), no submission events (0090) |
| 7 | Blast | Inadequate | `scripts/seed-blast.sql` | No engagement events (0091), no campaign completion (0092) |
| 8 | Board | Adequate demo | `scripts/seed-board.sql` + migration 0040 | No `element_count` (0094) maintenance demonstration |
| 9 | Bolt | Inadequate | `scripts/seed-bolt.sql` | No `notify_owner_on_failure` (0097), rules too sparse for UI exercise |
| 10 | Bond | Adequate demo | `scripts/seed-bond.sql` | No `bond_import_mappings` (0099), no soft-deleted examples (0100) |
| 11 | Book | Inadequate | `scripts/seed-book.sql` | No public booking demos, no cross-product timeline items |
| 12 | Brief | Adequate demo | `seed-brief.js` + `seed-brief.sql` + `seed-brief-templates.sql` | No Yjs state (0103), no `qdrant_embedded_at` (0104) |
| 13 | **Banter** | **Missing** | (none) | Zero rows. No channels, members, messages, DMs, reactions, presence (0105), partitions exercise (0106), viewer role (0107), edit permissions (0108) |
| 14 | **Helpdesk** | Inadequate | `scripts/seed-conversations.js` (narrow, requires running agent) | No multi-tenant org_id demo (0109/0110), no SLA (0111), no FTS (0112), no email-verify hashing (0113), no attachments (0114), no ticket events bolt (0115) |

### Human-tester checklist per app (concrete minimums)

**Platform.** 2 orgs (Mage, Frndo), 10 users across all roles (owner, admin, member x 6, viewer, service account, helpdesk agent), 1 API key per scope level, 1 OAuth user link stub, 1 rotated API key (predecessor + current), 2 projects per org, 15 tasks across 5 phases including 1 blocked, 1 with attachment, 1 with custom fields, and at least 1 task cross-linked each to Bond, Helpdesk, and Board.

**Beacon.** Keep existing 5000-entry generator. Add: 1 entry with a 4-reply comment thread, 1 with a PDF attachment, 1 in PendingReview with a reviewer, 1 expired (`expires_at < now()`), 1 with `vector_id` populated.

**Bearing.** Nearly complete. Add: 1 goal with a watcher holding a valid unsubscribe token, 1 already-redeemed token.

**Bench.** 3 saved queries (1 scheduled, 1 executed producing a delivery row, 1 with a public share), 1 materialized view with recent refresh, 1 delivery in `failed` state.

**Bill.** 5 clients, 10 invoices across all 9 status variants (draft, sent, viewed, paid x 2 partial+full, overdue, cancelled, void, recurring), 1 with PDF lock, 1 expense with receipt, 1 worker_job_state row mid-run.

**Blank.** 3 forms (single-submit, file-upload, conditional logic), 4 submissions hitting every processing_status variant, 1 form routing to Bond, 1 routing to Helpdesk.

**Blast.** 3 contact lists (20/50/200), 3 campaigns (draft / sending / completed), 1 template with header+body+footer, 20 opens + 10 clicks + 2 bounces + 1 unsubscribe per sent campaign with `client_info` populated, 1 segment with JSONB filter.

**Board.** 8 existing boards plus 1 with 500 elements for the count-maintenance showcase, 1 board cross-linked to a Bam task, 1 with 3 stars + 2 collaborators + 5 chat messages.

**Bolt.** 10 automation rules across 6 triggers (task.created, ticket.status_changed, deal.rotting, engagement.clicked, event.rsvp, comment.created [post-rename per 0120]), 1 with `notify_owner_on_failure=true` and a recorded failure, 1 referencing an API key for rotation test, 20 `bolt_execution_logs` mixing success and failure.

**Bond.** 15 companies, 40 contacts, 25 deals across 5 pipeline stages, 1 `bond_import_mappings` row from a fake `express-interest` source, 1 soft-deleted contact, 1 deal cross-linked to a Bill invoice and a Book event, 1 deal stale > 14 days for `deal.rotting` to fire into Bolt.

**Book.** 2 public booking pages, 5 events this week (1 cancelled, 1 declined, 1 accepted), 1 booked-via-public-page spawning a Bond contact and Bam task, 1 external-calendar block.

**Brief.** 10 documents in 5 folders, 1 with Yjs state populated, 1 with `qdrant_embedded_at` set, 3 comments (1 resolved), 8 templates.

**Banter.** (Everything is new.) 1 workspace, 6 channels (`#general`, `#engineering`, `#design`, `#random` public + `#leadership` private 3-member + `#viewers` viewer-role), ~50 messages per channel across last 14 days, 1 thread with 5 replies, 3 reactions per top-level message, 1 pin, 1 bookmark, 1 DM between two users, presence rows covering online/idle/in_call/dnd/offline, 1 message with `edit_permission='thread_starter'`, 1 with `'none'`, 1 message with a cross-product embed, 1 call + 1 transcript.

**Helpdesk.** 2 helpdesk_users per org (org-scoped per 0110), 1 with hashed email_verification_token (0113) + 1 verified, 12 tickets across all 6 status states, 1 with SLA breach imminent (created_at = now() - sla_first_response_minutes + 30min), 1 with recorded `helpdesk_sla_breaches` row, 1 with 2 internal + 3 public messages, 1 with MinIO attachment via `helpdesk_ticket_attachments`, 1 cross-linked to a Bam task, 1 with FTS hits for "billing", 5 `ticket_events` rows.

### Cross-app linking chain ("the Acme scenario")

Package one end-to-end scenario called **"Acme lead to delivery"** that threads through 9 surfaces:

1. Bond: deal `Acme Corp enterprise contract` in `negotiation`, owner=admin.
2. Bolt: rule `deal.rotting` to `create bam task` with 1-day staleness threshold.
3. Bam: task `MAGE-201 Draft Acme MSA` cross-linked to the Bond deal.
4. Book: event `Acme kickoff call` tomorrow 10am, cross-linked to the deal + task.
5. Brief: document `Acme MSA Draft v1` cross-linked to the task.
6. Bill: invoice `INV-2026-0042` draft for Acme, cross-linked to the deal.
7. Helpdesk: ticket `Cannot sign MSA PDF` from contact@acme.example, cross-linked to `MAGE-201`.
8. Banter: message in `#sales` with a rich embed referencing the Bond deal.
9. Beacon: article `How to close Acme-tier deals` with an attachment and 1 comment.

One scenario proves every cross-app FK, demonstrates Bolt event flow, and gives a tester a 5-minute guided tour.

### Recommended additions: file list

**New files** (author in follow-up pass, not in this plan's scope):

- `scripts/seed-all.mjs` - master orchestrator, ~150 LOC. Resolves org once, exports `BBB_SEED_ORG_ID` to children, runs each seeder in dependency phases, reports row-count deltas per table.
- `scripts/seed-banter.mjs` - ~500 LOC, follows the `seed-bearing.mjs` pattern (dynamic org lookup, skip-if-exists).
- `scripts/seed-helpdesk.mjs` - ~600 LOC, seeds helpdesk_users, settings, tickets, messages, attachments, SLA breaches, ticket_events. Uses the live SLA minutes to compute a ticket with breach imminent.
- `scripts/seed-platform.mjs` - ~400 LOC. Complements `apps/api/src/cli.ts` (doesn't replace it). Projects, tasks, sprints, activity_log, OAuth link stub, API key rotation predecessor.
- `scripts/seed-verify.mjs` - ~100 LOC. Asserts minimum row counts per table; exits non-zero on failure.
- `docs/seeding-smoke-test.md` - 14-URL click-through checklist.

**Extensions** (small additions to existing files):

- `seed-beacons.js`: comments + attachments rows; replace hardcoded USER_IDS with `SELECT id FROM users WHERE org_id = $1`.
- `seed-bench.sql`: delivery + refresh tracking rows.
- `seed-bill.mjs`: PDF lock + expense receipt + worker_job_state rows.
- `seed-blank.sql`: 4 processing_status variants + 1 submission event.
- `seed-blast.sql`: 33 engagement events + campaign_completed update + client_info.
- `seed-board.sql`: 500-element board.
- `seed-bolt.sql`: expand to 10 rules + notify_owner_on_failure + execution logs.
- `seed-bond.sql`: import mapping + soft-deleted contact + rotting deal.
- `seed-book.sql`: booking pages + cross-product booking.
- `seed-brief.js`: Yjs state + qdrant_embedded_at columns.

### Orchestration proposal

**Single-convention idempotency.** Adopt the `seed-bearing.mjs` pattern across all files. Delete every `DELETE FROM` statement in the 10 SQL seeds. Use `ON CONFLICT DO NOTHING` where natural unique keys exist; `SELECT ... LIMIT 1 ... IF NOT FOUND THEN INSERT` otherwise. For bulk generators (beacons, banter messages), gate on `if (existing_count >= target) skip`.

**UUID decoupling.** Read org via `SEED_ORG_SLUG` env var (preferred) or `--org-slug=` CLI flag (fallback). Default to first-org-by-created-at if neither set. Same pattern in every script:

```js
const orgSlug = process.env.SEED_ORG_SLUG ?? process.argv.find(a => a.startsWith('--org-slug='))?.split('=')[1];
const [org] = orgSlug
  ? await sql`SELECT id, name FROM organizations WHERE slug = ${orgSlug} LIMIT 1`
  : await sql`SELECT id, name FROM organizations ORDER BY created_at LIMIT 1`;
if (!org) { console.error('No org found, run create-admin first'); process.exit(1); }
```

SQL-only files get wrapped in a small `.mjs` driver that substitutes `:org_id`, `:user_1`, etc. via `postgres-js` parameter binding, so we don't need `psql` variable substitution.

**Users.** Select all active users in the org and round-robin through them for `created_by` / `author_id` fields, so the tester sees diverse authorship instead of everything attributed to one person.

**Docker integration.** Add a `seed` sidecar to `docker-compose.yml` under `profiles: ["seed"]` so it does NOT run on plain `docker compose up -d`. Invocation becomes `docker compose --profile seed run --rm seed`. Mirror the existing `migrate` sidecar's depends_on chain.

**Bootstrap flow refresh.** Update `docs/getting-started.md` Step 5 to a 4-substep sequence:

```
5a. docker compose exec api node dist/cli.js create-admin --email admin@example.com --password <pw> --name Admin --org "Mage Inc" --org-slug mage
5b. docker compose --profile seed run --rm seed   # SEED_ORG_SLUG=mage from .env
5c. (optional) docker compose exec api node dist/cli.js create-user ...
5d. Open http://localhost, login as admin@example.com
```

Add a "What gets seeded" row-count table and a "Re-seeding after a wipe" subsection.

### Priority ordering

**P0: must-fix to be able to test all functions on a freshly-wiped stack:**

1. `scripts/seed-banter.mjs` - Banter has zero rows today.
2. `scripts/seed-helpdesk.mjs` - current seeder is narrow and requires a live agent.
3. UUID decoupling of the 13 hardcoded scripts via `SEED_ORG_SLUG` env var.
4. `scripts/seed-all.mjs` orchestrator + `docker compose --profile seed` sidecar.
5. `scripts/seed-platform.mjs` - needed so cross-app links resolve.
6. The "Acme lead to delivery" cross-app chain.

**P1: closes Wave 2 feature gaps:**

7. Beacon comments + attachments rows.
8. Helpdesk SLA breaches + FTS + attachments.
9. Banter presence + viewer + edit permissions.
10. Bolt rules expanded + notify_owner_on_failure + execution logs.
11. Bill / Bench / Blast Wave 2 column demos.
12. `docs/getting-started.md` refresh.

**P2: nice-to-have:**

13. OAuth user link stub + API key rotation predecessor.
14. Board 500-element performance showcase.
15. Brief Yjs + Qdrant demonstration rows.
16. `scripts/seed-verify.mjs` automated post-seed checker.
17. `docs/seeding-smoke-test.md` click-through checklist.
18. CI GitHub Action that re-runs `seed-all.mjs` against a scratch postgres.

### Verification

**Automated smoke test** (after seeders land, not in this pass): `scripts/seed-verify.mjs` asserts per-table minimums:

```
organizations >= 1
users >= 6
projects >= 1
tasks >= 15
beacon_entries >= 100 AND beacon_comments >= 1 AND beacon_attachments >= 1
bearing_goals >= 5 AND bearing_kr_snapshots >= 100
banter_channels >= 6 AND banter_messages >= 200 AND banter_user_presence >= 5
tickets >= 12 AND helpdesk_sla_breaches >= 1 AND helpdesk_ticket_attachments >= 1
bond_deals >= 20 AND bond_import_mappings >= 1
...
```

**Human click-through** (`docs/seeding-smoke-test.md`): 14 URLs to visit after seeding with expected visible evidence per app (dashboard shows 15 tasks, Beacon first page 20 entries, Banter sidebar shows 6 channels, Helpdesk has a red-badge SLA ticket, and so on).

---

## Critical files (this pass)

- `H:\BigBlueBam\docs\plans\2026-04-15\SEEDING_RECOVERY_PLAN.md` (this document)
- `H:\BigBlueBam\.env` (regenerated with dev defaults)
- No existing repo files are modified in this pass.

## Out of scope (follow-up passes)

- Authoring `scripts/seed-banter.mjs`, `seed-helpdesk.mjs`, `seed-platform.mjs`, `seed-all.mjs`, `seed-verify.mjs`.
- Modifying the existing 19 seed scripts.
- Authoring `docs/seeding-smoke-test.md`.
- Modifying `docker-compose.yml` to add the `seed` profile.
- Refreshing `docs/getting-started.md`.
- Recovering other volumes (MinIO, Redis, Qdrant); not requested; unaffected by the postgres wipe.

After this plan executes, the user has a working stack, an admin account, no seed data beyond the admin org + users, and this document describing exactly what to add next. They decide which P0 items to green-light for a follow-up dispatch.
