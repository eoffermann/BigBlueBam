# Braid build report - autonomous cycle 2026-07-18

Winner of the 2026-07-18 suite-brainstorm session (Braid, 19 pts; runner-up Bridle, 17).
Spec `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` converged after 3 adversarial
rounds (7+2+0 blockers, all folded). Built end to end on `suite-brainstorm`; nothing merged
or promoted to `main`/`stable`.

## What shipped

Braid is the identity-resolution / golden-record customer-data platform: an AI engine
clusters person-and-company rows across Bond, Bill, and Book into one confidence-scored
golden profile per real-world person, with an evidence trail and human-in-the-loop merge
review. Flagship `braid_resolve(entity)` returns a stable golden id for any app record.

Milestones (all committed on `suite-brainstorm`):
- **M1** `apps/braid-api` Fastify service on port 4020 (env, db, redis/auth/rls/permissions
  plugins, health) + **M7** `apps/braid` SPA (shared `/b3/` shell + Bureau widget, 5 pages:
  catalog, detail, review queue, survivorship, settings).
- **M2** data model: 6 tables + 3 platform ref-stubs, migrations `0230`/`0231` (RLS, self-FKs,
  canonical-pair CHECK, Braid System service user), db:check clean of braid drift.
- **M3** shared Zod schemas (`packages/shared/src/schemas/braid.ts`).
- **M4** all `/v1` routes, per-viewer PII re-assembly + `can_access`, the single CAS-guarded
  transactional merge/reject/split executors, the all-keys `pg_advisory_xact_lock` helper,
  the `proposal.decided` handler (kill-switch + decider re-check), `/braid/ws`.
- **M5** MCP surface at full parity: 13 `braid_*` tools via `registerTool`, `confirm_action`
  on merge/split, reads take `asker_user_id`; surface-map self-check prints 0.
- **M6** 4 BullMQ jobs (match-on-ingest, rescan, proposal-reconcile, candidate-retention),
  4 Bolt events (`profile.merged/split/matched`, `candidate.created`), the ingest producer
  + bolt-api dispatch hook. `check-bolt-catalog` 0 violations.
- **M8** Launchpad tile + `git-merge` icon, docker-compose service + frontend depends_on +
  worker env, both nginx source configs + regenerated Railway, frontend Dockerfile, services
  catalog, `visibility.service.ts` branches (bill.client, book.event_attendee, braid.profile/
  identity; helpdesk.user deferred per the 5.5 gate) with 9 branch tests, CLAUDE.md
  (833 tools / 51 modules).
- **M9** help.md + guide.md (real UI labels, 5 user stories, agent tools).
- **M11** marketing section on the Operations page + suite tool-count bump to 833.
- Permission catalog: the 9 hand-authored `braid.*` rows + migration `0232` + regenerated
  manifest/codegen (so the route `requireCan` gates resolve).

Key commits: `8bbc22f5` (M1/M2) ... `2c2fc9ab` (M6), plus review-fix commits `f45cda8d`
(#62 permissions + branch CI), `121a93f4` (#60), `cfc73c0f` (#61), and the internal-route
`/v1` path fix.

## Tests + CI status

- **Static gates green locally:** typecheck (braid-api, worker, bolt-api, mcp-server, shared,
  api), `check-bolt-catalog` (0), `lint:migrations` (0), surface-map self-check (0), the 9
  visibility branch tests. `db:check` shows no braid drift (the one `deployment_secrets`
  error and the `bam.platform_*` requires_superuser mismatch are pre-existing local-dev-DB
  artifacts of another branch, absent from CI's fresh DB; tracked issues #11/#14).
- **Branch CI:** the ci-watchdog found `suite-brainstorm` was in no workflow's push trigger,
  so pushes never ran CI. Added `suite-brainstorm` to lint/typecheck/test/db-drift push
  triggers, so subsequent pushes (from the review-fix commits onward) run the full gates.
- **Phase 4 backend verification PASSED (live):** enabled `book.event_attendee` for the
  gilligan org, drove 3 `skipper@gilligan.example` bookings through the real transport
  (`POST /v1/internal/events` -> BullMQ `braid-match-on-ingest` -> worker). Result: the 3
  records clustered into ONE golden profile (`772fc292...`, person, identity_count 3,
  confidence 0.95) - first identity `seed`, next two auto-attached on exact-email match.
  The core wedge works end to end.
- **Phase 4 UI verification PASSED (live):** the gilligan Owner (Skipper) opens `/braid/`
  and `GET /braid/api/v1/profiles` returns 200 with the golden profile (not 403). This
  required migration `0233_braid_builtin_group_defaults.sql` - the built-in permission
  groups (migration 0156) predated Braid's rows, so no group granted `braid.*` and every
  non-SuperUser hit `implicit_deny`. 0233 backfills the defaults (Owner/Admin/Member = 9,
  Viewer = 4 read-tier, Guest = 0) and is applied. Screenshots captured against gilligan.

## automated-review issues filed + disposition

Post-commit-review filed 3 (all fixed + closed):
- **#60** (security, High): read routes dropped `asker_user_id`, so an admin-bearer agent
  answering for a restricted user got the raw-PII admin fast-path. Fixed (`121a93f4`):
  `readViewer` forces a non-admin viewer keyed on the asker so per-viewer filtering runs.
- **#61** (stability): static match-on-ingest jobId + retention dropped re-ingest of edited
  rows. Fixed (`cfc73c0f`): BullMQ TTL deduplication (60s).
- **#62** (best-practices): `requireCan('braid.*')` routes shipped with no permission-catalog
  rows. Fixed (`f45cda8d`): 9 rows + migration 0232 + regenerated manifest/codegen.

## Pending / follow-ups (tracked as tasks, non-blocking)

- **M10 screenshots** (gilligan): DONE. Light catalog/detail/review-queue + dark catalog in
  `docs/apps/braid/screenshots/` and `site/public/screenshots/braid/`; a thematic review
  candidate (Jonas Grumby <-> Skipper, "'Skipper' is a nickname for Jonas Grumby") was seeded
  for the queue shot. Rebuild the `site` service to serve the marketing images.
- **Help Center index** (`help-index.json` build + wiring) not yet generated; the SPA
  `HelpTrigger app="braid"` is wired but the index is pending.
- **Playwright user-story e2e** not yet added to `apps/e2e/`; the backend verification above
  is the live proof for this cycle.
- **Redeploy** worker + bolt-api with the `/v1` internal-path fix (rebuild in flight at
  report time) so the live auto-dispatch works; until then the nightly `braid-rescan`
  source-diff is the (documented) fallback and the engine is fully functional via it.
- Pre-existing, not Braid: surface-map summary table missing Basis/Bin/Bay rows (#35), site
  "19 apps" narrative drift (#36), local-DB `deployment_secrets`/`bam.platform_*` drift
  (#11/#14).

## No HUMAN_SETUP required

All dependencies are internal (Postgres, Redis, Qdrant, the platform llm-provider). No
external secret or third-party account is needed.

## How to see it in action

1. Stack is live locally. Open the Launchpad on any app and click the **Braid** tile
   (Customer Identity, git-merge icon) -> `/braid/`.
2. The gilligan golden profile exists now:
   `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SELECT primary_email, identity_count, confidence FROM braid_profiles WHERE organization_id='57db0001-3f0e-463f-b514-1cd14fd14241';"`
   -> `skipper@gilligan.example | 3 | 0.95`.
3. Re-run the live ingest for another gilligan attendee id via
   `POST http://braid-api:4020/v1/internal/events` with the `X-Internal-Secret` header, then
   watch `docker compose logs -f worker | grep braid` and re-query the profile's
   `identity_count`.
4. Agents: the 13 `braid_*` MCP tools are registered; `braid.*` fails closed until an
   operator allowlists it per agent (`agent_policies`).

Merging `suite-brainstorm` into `main`/`stable` is the maintainer's decision; nothing was
merged or promoted.
