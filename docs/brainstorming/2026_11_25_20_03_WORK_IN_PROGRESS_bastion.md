# Bastion build: work in progress

Spec: `docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md` (converged after three adversarial rounds, commit 2e89afca). Branch: `suite-brainstorm` (feature branches off it, merged back; never `main`/`stable`). Autonomous cycle 2026_11_25_20_03.

Each milestone lands as small commits, is pushed, and is followed by the post-commit-review pipeline; open `automated-review` issues are addressed before the next milestone starts. A milestone is checked only when its "done when" gate passes on the local stack and branch CI is green.

**Standing rules for every milestone from M2 on** (not repeated below):
- Re-verify the migration tip (`ls infra/postgres/migrations/*.sql | tail -1`) before authoring any migration.
- Shared Zod schemas for every new route body and queue contract go in `packages/shared/src/schemas/bastion.ts`, in the same change as the route.
- Every route added gets its MCP handler (typed off the shared Zod) in `apps/mcp-server/src/tools-pending/bastion.ts` with tests, in the same commit, or a sanctioned annotated skip; and its row in `docs/reference/mcp-endpoint-mapping.md`. The surface-map self-check prints `0` at every milestone gate.
- UI-action-to-tool crosswalk for every page shipped in the milestone (each button, menu action and form submit has a tool).
- Each milestone adds its GILLIGAN seed rows (spec 10.2) and the matching `BASTION_SEED_EXPECTATIONS` entries.
- Playwright gates use self-cleaning specs and read the backend back (API as the same user, and psql filtered by `organization_id`), including the expected Bolt events.
- The unit tests in spec 11.1 are owned by the milestone that implements the feature.

## Milestones

- [x] **M0 - Platform prerequisites (fix the fact, not the place)**
  - [x] #124 one shared `BOLT_SOURCES` list in `@bigbluebam/shared`; ingest zod enum, `TRIGGER_SOURCES`, `TriggerSourceV1`, pgEnum derived from it; migration `0260` adds the explicit missing values (incl. `bursar`, `bastion`); `check-bolt-catalog.mjs` fails on a source missing from the list; `db-drift.yml` step asserts the live enum equals `BOLT_SOURCES`
  - [x] #125 `publishBoltEvent` AbortSignal timeout, unit test
  - [x] #123 `GET /files/*` restricted to `avatars/`, private caching elsewhere, negative test
  - [x] #126 `syncNew` scoped reconcile (`propagate: true`, never overwrite, diff, `skipDeploys`, dry-run)
  - [x] #127 (and duplicate #130) index.html no-cache rule covers every SPA in all nginx configs, with a drift check
  - [x] #128 migration `0261`: `agent_proposals` decider columns, `owning_app`, `require_human_decider`; `platform_backups` mirror columns; decide route records decider, enforces human-only, 409 `DECIDE_IN_APP`; Drizzle and MCP output updated
  - [x] `gen-railway-configs.mjs` handles `set $var host:port;` and the resolver line; unit test
  - [x] Stable-secret class in `generateSecrets()`
  - [x] Gate: Bursar and Bastion events ingest 2xx; enum check green; `/files/<non-avatar>` 404; dry-run shows only `propagate` additions; app-owned decide 409s; generator test green; `pnpm db:check` and `pnpm lint:migrations` green
- [x] **Follow-ups from the post-commit review (before M1)**
  - [x] #129 app counts hand-coded in README and introduction.md; add an app-count check keyed to the generated catalog; build the docs.tsx app lists from the catalog
  - [x] #131 migrate runner: self-transacting migrations (0078, 0156-0159) break per-file atomicity; fix in the runner and add a `lint:migrations` rule (files themselves are immutable)
  - [x] #132 Biome warnings (~4,400) with no ratchet; add a per-package warning budget that fails CI on increase, then apply safe `--fix` reductions
  - [x] #133 and #138 the remaining hand-written copies of the Bolt source list (Bolt SPA, MCP bolt tools, generated tool schemas) derive from `BOLT_SOURCES`
  - [x] #134 Bill invoice PDF links 404; authorized bill-api download route
  - [x] #135 deploy vitest suite wired into CI
- [ ] **Follow-ups from the M0 review (before M1)**
  - [x] #136 human-only deciding must require a session login, not just a human key owner (also applied to Bastion's vouching routes, spec 2.8)
  - [x] #137 `syncNew` stranded variable after a partial failure; redeploy any service whose variable is present but whose last deploy predates it, or write and redeploy per service
  - [x] #139 a failed Railway variable read must fail closed instead of minting a divergent stable secret
  - [x] #141 lazy-expiry UPDATE in the proposals decide route guarded on `status = 'pending'`
  - [ ] #142 the four legacy `/files/*` prefixes move to app-owned authorized download routes; drop `bill/receipts/` from the allowlist now
  - [x] #143 introduction docs still say "sixteen apps" and 847 tools; add them to the count checks
  - [x] #144 MCP platform tools' 14-app Launchpad enum; one shared Launchpad app-id list
  - [x] #145 Bill receipt upload uses a hard-coded bucket and fallback credentials; authorized receipt download route
  - [x] #146 permission manifest generator's hand-written app prefix list
- [ ] **M1 - Scaffold and infrastructure (direct URL only, no Launchpad)**
  - [x] `apps/bastion-api` from the bursar-api skeleton; Dockerfile copies and builds `packages/storage` and `packages/permissions`; service-health, logging, permissions plugin, auth with `rejectWhenImpersonating`, `BASTION_TRUST_PROXY_HOPS` (bb485a26; `requireSession` exported too)
  - [x] Own bucket (`BASTION_S3_BUCKET`) with boot put/stat/delete check and a plain error (bb485a26)
  - [x] Compose: bastion-api (port 4024, `:-` secrets with a plain refusal message, `stop_grace_period: 75s`); `frontend.depends_on`; worker env (`BASTION_API_INTERNAL_URL`, `BASTION_S3_BUCKET`); bolt-api env and `apps/bolt-api/src/env.ts` (`BASTION_API_INTERNAL_URL`); mcp-server env and `apps/mcp-server/src/env.ts` (`BASTION_API_URL`) (01b302ac)
  - [x] nginx: `nginx-with-site.conf` hand-edited (runtime-resolved `/bastion/api/`, `/bastion/` SPA, internal-path deny, asset and no-cache regexes); `nginx.conf` same blocks after confirming which stack mounts it; `nginx.railway.conf` regenerated; `nginx -t` (5e930014)
  - [x] `services.mjs` entry (incl. bolt-api and mcp-server env, frontend `needs`), env hints (stable secrets, `propagate` on the bucket and URL hints), `railway/bastion-api.json`, `.env.example` (c5042731, .env.example in 01b302ac)
  - [x] Storage prompt asks AWS S3 / R2 operators for the Bastion bucket, default `<S3_BUCKET>-bastion` (spec 9.1, infrastructure-N5); MinIO keeps `bigbluebam-bastion`; the chosen value reaches `.env` and wins over the env-hints literal on Railway (provision, propagate, never reset by reconcile) (issue #171)
  - [x] `apps/frontend/Dockerfile` four lines (spec 9.3); `apps/bastion/vite.config.ts` with every `@bigbluebam/ui/*` alias from bursar (a5408230)
  - [x] SPA shell matching `/b3/`: shared sidebar with `SidebarPlatformFooter`, top bar (LaunchpadTrigger, breadcrumb, OrgSwitcher, Banter link, NotificationsBell, HelpTrigger, UserMenu), shared `Launchpad`, theme tokens copied verbatim, `mountBureauClient` and `initSystemErrorReporter({ service: 'bastion' })`, `@bigbluebam/bureau-client` dependency, `PermissionsProvider`, auth store, `?` opens Help (a5408230)
  - [ ] Gate: `/bastion/` serves; health 200; internal path 404 through nginx; Railway grep gates (`bastion-api.railway.internal:8080` present, `127.0.0.11` absent); stopping bastion-api leaves other apps up; `check:env-hints` green; fresh `.env` refusal; dry-run adds the bucket and URL to the existing worker
    - [x] Static half green: Railway grep gates (1 / 0); `check:env-hints`; `check:nginx-spa`; `nginx -t` on all three configs; fresh-`.env` refusal (compose config renders with the keys empty, `node dist/server.js` prints the four plain lines and exits 1); syncNew dry-run test (`railway-sync-bastion.nodetest.mjs`); `check-app-completeness` (24 apps, bastion absent); Biome budget; surface-map self-check 0
    - [ ] Live half (needs `docker compose build frontend` and `up` of bastion-api + frontend): `/bastion/` serves, health 200, internal path 404 through nginx, stopping bastion-api leaves other apps up
- [x] **Follow-ups from the batch-3 and M1 reviews**: #164 (shared storage helper in 7 services), #165, #166 (Bureau WebSocket per-message permissions; `bureau.chat.write`, 0270/0271), #167 (HIGH: Blueprint per-diagram ACL), #168, #169 (0272), #170, #171 (Bastion bucket prompt for S3/R2), #172 (Railway location resolver), and the 11 skipped tests now run. Tracked, not blocking: #173-#178.
- [ ] **M2 - Data model and permission chain** (note: follow-up fixes took migrations `0262`-`0272` (0270-0272 by the #166/#169 batch), so Bastion's migrations start at `0273` or later; re-verify the tip)
  - [x] `packages/shared/src/schemas/bastion.ts` created and exported (378bd487; a test pins every enum to its migration CHECK)
  - [x] Migrations `0273`-`0280` (spec numbers 0262-0269 were stale): `0273_github_pr_events`, `0274_bastion_core`, `0275_bastion_evidence`, `0276_bastion_gaps_policies`, `0277_bastion_questionnaires`, `0278_bastion_sharing`, `0279_bastion_probe_functions` (20 v1 probes + 2 resolvers, hardened), `0280_bastion_rls`; 35 Drizzle modules; RLS loop (6a075ed6, 16b1439a)
  - [x] GitHub webhook stores `subscribed_events` from `ping` and every PR and review delivery in `github_pr_events`; surface-map row for the webhook change (554cea9d)
  - [x] **Permission chain moved here from M10** (plan-review blocker 1): spec 4.5 procedure run; delta observed at `0281_permissions_seed_actions_delta_031` (50 added, 0 removed), then `0282_bastion_builtin_group_defaults` (7b4928ee)
  - [x] Gate: `db:check` 0 drift (324/324 tables); definer-function `proconfig`/`proacl` assertion green live (27 functions); `ping` stores `subscribed_events` (route test, and webhook-shaped rows read back by the `change.*` probes live); spec 4.6 probe owner 50, admin 50, member 25, viewer 10, guest 0
  - [ ] GILLIGAN seed rows: none at M2 (no Bastion seeder exists yet; it lands at M3 with the test harness)
- [ ] **M3 - Library, crosswalk, setup, deterministic compile, test harness**
  - [x] SOC 2 and ISO 27001 libraries (own plain-language summaries), static crosswalk, per-requirement applicability, Statement of Applicability (b5f45714; routes caac9dff, edb76f9e)
  - [x] Setup wizard page (incl. required Compliance project), deterministic compile; Controls list stub with "Not set up yet" (8e9809be; first SPA component tests)
  - [x] **MCP parity reconciliation** (plan-review 3): table in the decisions below; 7 pending `bastion_*` handlers and `clients/bastion-client.ts` (01a789ed); surface map 26 rows, self-check 0
  - [x] Test harness: `scripts/seed-gilligan/bastion.mjs` registered last in `run-all.mjs`, `bastion.expectations.mjs`, `appProject('bastion')` in `apps/e2e/playwright.config.ts`, `apps/e2e/src/apps/bastion/bastion-expectations.d.ts`, M3 story `bastion-setup.spec.ts` (a48f04a5)
  - [x] Gate: SOC 2 then ISO share controls (DB-backed `test/db/m3-services.test.ts` green against the local database: 45 shared controls reused, SoA completes only after all 93 decisions, population confirmation enforced, archive retires single-framework controls); SoA completeness unit test green
  - [ ] GILLIGAN seed rows and the M3 Playwright story run live (needs bastion-api and the rebuilt frontend up; `node scripts/seed-gilligan/run-all.mjs`, then the `bastion` Playwright project as Skipper)
- [ ] **M4 - Evidence engine**
  - [ ] Probes via `runInOrgScopeRead`; evaluator (time budgets, resumption, orphan re-enqueue, staleness); ledger; seals plus bucket objects; identity-based restore detection with provisional epochs and append blocking; outbox with ordering keys
  - [ ] `bastion-shared.ts` and `registerBastionSweep` (with `withRetention` and the no-bare-`add` scanning test); jobs: evaluate-tick, evaluate-run, outbox-drain, ledger-seal, ledger-verify, run-reaper, evaluation-missed, weekly-readiness, retention
  - [ ] `bastionEvents` registered in the Bolt catalog; `enqueueBastionEvent` helper; `check-bolt-catalog.mjs` treats `enqueueBastionEvent(` as a `bastion` publisher; test that `BASTION_EVENT_TYPES` equals `bastionEvents`; bolt-api dispatch hook
  - [ ] Gate: probe goldens three ways (RLS off, RLS on, separate read pool); both restore tests (restart and in place); kill-mid-slice test; outbox ordering test
- [ ] **M5 - Manual evidence, personal data, feeds, Readiness**
  - [ ] Manual evidence (Bin scan-state mapping, copy at attach), personal-data table and redaction route, feeds with per-feed keys and quotas, coverage numbers
  - [ ] Pages: Readiness, Evidence map, Evidence locker
  - [ ] Jobs: evidence-ingest, evidence-expiry
  - [ ] Gate: Playwright stories 1-3
- [ ] **M6 - Gaps, fixes, exceptions, visibility**
  - [ ] Gap ranking (full spec 2.3 mapping table), fix drafting with closed Bolt rule shapes, exceptions (`pass_with_exception`, per-assertion aggregation, frozen refs, expiry drift), Bastion decide routes, internal Bam routes (tasks, comments by `external_id`, proposal close), proposal reconcile
  - [ ] **Visibility moved here from M10** (plan-review blocker 2): the six `bastion.*` types in `visibility.service.ts`, `bastion_*` stubs in `peer-app-stubs`, generated `visibility-tools.ts` description, `agent-conventions.md`
  - [ ] Pages: Controls, What to fix first, Review queue
  - [ ] Jobs: gap-rank, proposal-reconcile
  - [ ] Gate: Playwright stories 4-6
- [ ] **M7 - LLM tailoring with populations; policies and attestation**
  - [ ] Compile tailoring with populations and the deterministic fallback; policies and version-pinned attestation
  - [ ] Pages: Policies, Policies to read
  - [ ] Jobs: compile, attestation-nudge
  - [ ] HUMAN_SETUP doc created if a live LLM provider credential is needed and absent
  - [ ] Gate: compiler corpus gates
- [ ] **M8 - Questionnaires and the xlsx codec**
  - [ ] Questionnaire ingest, autofill with banding, answer library; xlsx codec (`packages/structured-data` in the Dockerfile)
  - [ ] Page: Questionnaires; job: questionnaire-autofill
  - [ ] Gate: questionnaire corpus gates (0 persisted citations failing `can_access`); Playwright story 7
- [ ] **M9 - Auditor room, audit packet, sweep, mirror, help**
  - [ ] Auditor room (`/bastion/room` before the auth gate), streamed packet with commitments verified via bastion-api, object sweep engine (intents), off-site mirror enqueued after a successful backup (tested locally against a second MinIO bucket), `restore-objects` CLI
  - [ ] Pages: Sharing, Settings
  - [ ] Jobs: export-packet, object-sweep, object-backup (plus the `backup-database.job.ts` enqueue)
  - [ ] Help: `docs/apps/bastion/help.md` in the `/b3/` format via `help-doc-authoring`, `guide.md`, `meta.json`, `help-index.json` via `node scripts/help/build-help-index.mjs` (`--check` green), Help Center wired; image refs finalized at M11
  - [ ] Gate: Playwright 8-11; packet smoke with differing buckets; failing mirror leaves the backup `completed`
- [ ] **M10 - MCP client completion, search, surface-map summary**
  - [ ] `src/clients/bastion-client.ts` completed; full parity cross-walk (routes and UI actions) against `tools-pending/bastion.ts`; search integration; surface-map summary counts and the #123/#124/#128 notes
  - [ ] Gate: Playwright 12-15; `check-tool-return-coverage` and `docs:catalog:check` still green
- [ ] **M11 - One merge unit (Launchpad row last)**
  - [ ] Move `tools-pending/bastion.ts` to `tools/bastion-tools.ts` and register it; `APP_TOOL_MODULES` entry; `pnpm docs:catalog`; published counts set from the generated total (885 + the final Bastion tool count); CLAUDE.md per-module line and app inventory
  - [ ] `ROOT_REDIRECT_VALUES` and `REDIRECT_MAP`; lucide `castle` in `packages/ui/launchpad.tsx` `ICONS`, SPAs rebuilt; `APP_ICON`/`APP_COLOR` in `site/src/pages/docs.tsx`
  - [ ] Screenshots: `packages/docs-capture/recipes/bastion/bastion.yaml`, GILLIGAN capture, copied to `site/public/screenshots/bastion/`, help.md and guide.md refs rewritten to the numbered filenames
  - [ ] Marketing: `site/src/components/sections/bastion-section.tsx` imported by a named page; `docker compose build site && docker compose up -d --force-recreate site`; curl or Playwright proves it renders
  - [ ] `pnpm docs:generate` (manual), `pnpm docs:readme`, `pnpm docs:readme:check`
  - [ ] Agent path: drive a slice of the app through MCP tools only (service account, `bastion.*` allowlist) and compare rows and events with the UI path
  - [ ] Last: `LAUNCHPAD_APP_IDS` and `LAUNCHPAD_CATALOG` row; api rebuilt; `curl .../b3/api/launchpad/apps` shows bastion
  - [ ] Gate: Playwright 16; `check:app-completeness`, `check-tool-return-coverage`, `docs:catalog:check` green
- [ ] **Close-out audit** (`close-out` skill) and `BUILD_REPORT_bastion.md`

## Decisions recorded during the build

- **Railway smoke test.** The M9 gate's Railway staging packet test needs a Railway deploy, which is outside this loop (local Docker dev stack only; deploys and promotion are human decisions). It belongs in the HUMAN_SETUP doc only as part of the standing promotion note (category 3): "after promotion, build and download one packet on staging". Everything else in M9 is verified locally.
- **MCP parity.** The spec keeps `bastion-tools.ts` out of the tree until M11 so the tool-count and docs-catalog CI gates stay green (round-3 best-practices-3). To honor the build rule that a route and its tool land together, every milestone from M2 on writes the handler for each route it adds in `apps/mcp-server/src/tools-pending/bastion.ts`, with tests, in the same commit as the route. M11 only moves and registers the file.
- **Permission chain at M2, not M10.** The plan review showed the M5-M7 seed rows and Playwright stories need the Professor and Gilligan to act through bastion-api, which is impossible before the permission actions exist. The full spec 5.5 action set is registered at M2; the spec 4.6 probe check runs there.
- **Visibility at M6, not M10.** The M8 and M9 gates depend on `can_access` supporting Bastion entity types.
- **`/files/*` scope (M0, #123).** Restricting to `avatars/` only would have broken four live features (Bam attachments and Bureau underlays under `uploads/`, Banter `banter/uploads/`, Helpdesk `helpdesk/`, Bill `bill/receipts/`). Those prefixes stay allowlisted with `Cache-Control: private, no-store`; every org-prefixed key (Bin, Bay, Blip, Bastion) returns 404. Moving the four legacy prefixes to app-owned authorized routes is tracked as follow-up work.
- **M1 nginx.conf upstream.** `nginx.conf` is the frontend image's baked default profile, used only when no site template is bind-mounted (bare `docker run`); no compose file mounts it (`docker-compose.multi.yml` does not touch nginx). Because that stack is not guaranteed to be on Docker's embedded DNS, it uses a literal `bastion-api:4024` upstream like its other apps; only `nginx-with-site.conf` (and the generated Railway conf) use the runtime resolver. Proven by `nginx -t` with bastion-api unresolvable: with-site and Railway pass, nginx.conf fails exactly like every other literal upstream there.
- **M1 `needs`.** `bastion-api` is not added to bolt-api's `needs` (bastion-api already needs bolt-api; `needs` is documentary only) nor to mcp-server's (Bastion tools register at M11). Both get their env var and propagate hint.
- **M1 startup logging.** `src/server.ts` prints a progress line and then dynamically imports `main.ts`, because static ESM imports (env validation, stable-secret refusal, pool creation) run before any statement in a module.
- **M1 bucket check.** Runs after `listen`, not awaited, with a 15 s per-step timeout; outcome kept in memory (`getBucketCheckStatus()`) for the Readiness banner, since `bucket_check_status` has no table until M2. The S3 credentials use `${MINIO_ROOT_USER:-}` rather than the `:?` other services use, so storage stays optional for bastion-api (spec 9.1).
- **M1 surface map.** A Bastion section with only the combined health row (the map lists other apps' health rows); summary counts updated.
- **Fix batches move off the milestone path (2026-11-26).** Each review of a fix batch kept surfacing more pre-existing defects, and four sequential batches (49 issues) delayed M2 by most of a day. From M2 on, `automated-review` findings are fixed in a separate git worktree on a feature branch off `suite-brainstorm` (`fix/review-batch-N`) and merged back, so milestone work and review fixes proceed in parallel without sharing a git index. Pre-existing defects outside Bastion's scope that are not `automated-review` findings are filed and tracked, not fixed in this cycle.
- **M2 migration numbers.** Tip was 0272, so the spec's 0262-0269 became 0273-0280, the delta 0281 (observed from the generator, not chosen) and the defaults 0282. The migration headers say which spec number each replaces.
- **M2 org role.** `organization_memberships.role` (named by spec 3.1 for `access.privileged_roster`) was dropped in 0159; the probe reads the org-scope `account_group_memberships` -> `permission_groups.legacy_role` (owner/admin), plus member SuperUsers.
- **M2 probe contract.** Each `bastion_probe_<key>_v1` returns facts as jsonb (`summary`, `cited_refs` of `{entity_type, entity_id}` capped at 200, `cited_count`, `overflow_count`, and `population_checked/unlisted/missing` for population probes); the pass/fail predicate is evaluated by the TypeScript probe module at M4. All 20 probes of the spec 3.1 table shipped at M2, so M4 adds only TypeScript. The `ops.*` probes read the platform-wide backup/restore tables (no org column) and return counts only. Hazard for M4: `params` must reach the function as a JSON object; a jsonb string (a double-encoded parameter) makes every lookup read its default silently. The caller must bind params as text and cast (`$3::text::jsonb`) or pass an object; a v2 function may refuse non-objects.
- **M2 hardening.** Every `bastion_%` function (probes, resolvers, purge, and the two trigger functions) has `SET search_path = pg_catalog, public, pg_temp`; a loop at the end of 0274, 0278 and 0279 revokes PUBLIC execute and grants `bam_app` only on SECURITY DEFINER functions and only if the role exists. The definer test covers every `bastion_%` row, not just probes.
- **M2 immutability scopes.** Manual evidence content freezes once the row leaves `pending_scan`/`blocked` (status `active`, `superseded`, `withdrawn`); exceptions freeze in `active`/`expired`; assertions freeze in `confirmed`/`superseded`; `bastion_audit_log` rejects UPDATE and TRUNCATE (DELETE stays for the org cascade). User references on immutable tables are plain uuids with no FK (a SET NULL would be an UPDATE of a protected column). As with Bursar's baseline, deleting an org that has immutable Bastion rows is refused by the triggers.
- **M2 `github_pr_events`.** Bam-owned, `org_id` (Bam naming), no RLS (written before any org scope, like `github_integrations`). Every `pull_request` and `pull_request_review` delivery from an enabled integration is recorded, all actions; a disabled integration records nothing; the insert runs before task linking and a failure fails the delivery so GitHub's Redeliver retries it; redelivery is a no-op on `(repo, delivery_id)`. A `ping` without a usable `hook.events` leaves `subscribed_events` as it was.
- **M2 permission generator.** `bastion-api` is in `NOT_ROUTE_SCANNED`. The stale-entry check now accepts a classified app directory that has no routes yet (only an entry naming no app is stale), so ids can be registered ahead of routes; test added. Viewer gets `attestation.sign` (not a read), so 0282 uses explicit member and viewer lists rather than `is_read`.
- **M2 verification mechanics.** Postgres is not exposed to the host: `db:check` ran in a `node:22-alpine` container on `bigbluebam_backend`; the DB-backed vitest suites ran from the host through a temporary `alpine/socat` forwarder (`127.0.0.1:15432`, removed afterwards). In CI they run in `test.yml`, which migrates its postgres and sets `DATABASE_URL`. The api container was not running, so the `ping` gate is proven by the route test plus the probe reading webhook-shaped rows, not by a delivery to the live stack.
- **M3 library.** 48 internal controls (`apps/bastion-api/src/library/controls.ts`), SOC 2 common criteria CC1.1-CC9.2 (33) and ISO 27001:2022 Annex A (93) as templates; 46 controls serve SOC 2, 47 serve ISO, 45 are shared (the static crosswalk). Reference codes are the public numbers; every title and summary is our own plain wording, never AICPA or ISO text. `starter.ts` (spec 2.1) is deferred: the M3 scope is SOC 2 and ISO, and nothing reads a starter template yet. The ten ISO premises requirements (A.7.1-A.7.6, A.7.8, A.7.11-A.7.13) map only to `physical.premises`, so excluding them excludes one control in the ISO view while CC6.4 keeps it applicable for SOC 2.
- **M3 probe catalog home.** Each probe's params and threshold schemas live in `library/probe-catalog.ts` (key, version, plain title, population kind, inherited). The M4 probe modules import them rather than restating them, so one place encodes each probe's inputs. Population probes also accept `population_labels` (what people see; the SQL reads only `expected_population`) and the confirmation stamp.
- **M3 compile runs inline.** The deterministic compile is pure planning plus one insert, so `POST /frameworks/:id/compile` claims the run (one active run per framework, else 409 `COMPILE_RUNNING`), plans and inserts in the request, and answers 202 with the finished run (`used_fallback = true`, `proposed_by = 'library'`). A failure marks the run `failed`. M7 moves the LLM-tailored compile onto the worker behind the same contract. A control whose derived applicability is not_applicable gets no proposals.
- **M3 "decision" for the SoA.** A requirement counts as decided only when every live link has `decided_at` set; the default `applicable` with nobody deciding does not count, because the Statement of Applicability is a human statement. `assertSoaCompleteForPacket` (library/soa.ts) is the check the M9 packet builder calls; unit-tested now.
- **M3 setup routes outside spec 5.1.** `GET /setup` (state, `framework.read`), `PATCH /setup/profile` and `POST /setup/compliance-project` (`framework.write`), and `POST /frameworks/:id/applicability` (bulk, `control.write`, the row 15 permission). Setup is "done" when a framework is adopted and compiled, the Compliance project is set and (ISO) the SoA is complete; reviewing every proposed check is not required, because anything left is counted under "Not set up yet".
- **M3 Compliance project.** The project is created through the existing Bam API (`POST /b3/api/projects` from the wizard with Bam's CSRF header; `POST /projects` with Skipper's key in the seeder), so Bam applies its own permission and membership rules; bastion-api then records it after checking the project belongs to the org. No new internal Bam route.
- **M3 population confirmation.** Confirming a population check needs a non-empty list (an empty `expected_population` makes the 0279 probe fall back to whatever is connected, which defeats the rule; 400 `POPULATION_EMPTY`) and `population_confirmed: true` (400 `POPULATION_CONFIRMATION_REQUIRED`). Revising never carries the old confirmation stamp over. GitHub repository values are lower-cased as the probe compares them.
- **M3 assertion kind of the caller.** `proposed_by` is `human` or `agent` from `users.kind` read in the caller's transaction (the auth plugin does not carry kind); audit rows record `actor_kind`, the impersonator and the auth method.
- **M3 lists.** The M3 list routes return the whole org set with `next_cursor: null` (at most a few hundred controls per org); cursor pagination lands if a list can grow past that.
- **M3 surface map dashes.** The `— _(skip: ...)_` marker in `mcp-endpoint-mapping.md` is the format CLAUDE.md and the self-check require, so it stays; no other dash appears in what M3 wrote.
- **MCP parity reconciliation (M3, plan-review 3).** Every spec 5.1 skip, against the categories CLAUDE.md sanctions (auth/credentials, multipart/binary, public-inbound, SuperUser/permission admin, internal service-to-service, realtime, resolver-done-internally, health) plus one this build treats as sanctioned because spec 2.8 binds it: **human gate** (setup and admin writes, applicability decisions, vouching, decisions, disclosure and destructive acts; the vouching routes also require a cookie session, so no API key could call them). Read rows skipped for any other reason become tools, built by the milestone that ships the route:

  | Spec row | Route | Spec skip reason | Outcome | Category or tool (milestone) |
  | --- | --- | --- | --- | --- |
  | 1 | `GET /library/templates` | static catalog | **now a tool** | `bastion_list_frameworks` (M3, built) |
  | 3, 5, 6 | framework create, edit, archive | human act / admin / destructive | skip | human gate |
  | 8 | SoA csv | binary download | skip | multipart/binary |
  | 12, 14, 15 | control create, edit, applicability | human admin / decision | skip | human gate |
  | 18, 19 | assertion confirm, reject | human gate | skip | human gate (session required) |
  | 28, 35 | evidence and manual-evidence download | binary | skip | multipart/binary |
  | 29 | `GET /ledger/seals` | verification material | **now a tool** | `bastion_list_seals` (M4) |
  | 30 | `GET /ledger/restores` | integrity admin surface | **now a tool** | `bastion_list_restores` (M4) |
  | 31 | restore acknowledge | human integrity act | skip | human gate |
  | 32, 40 | manual evidence upload, supersede | a human attests | skip | multipart/binary and human gate |
  | 36-39, 41 | link, unlink, review, withdraw, redact | human curation / destructive | skip | human gate |
  | 42 | `GET /feeds` | admin configuration | **now a tool** | `bastion_list_feeds` (M5) |
  | 43, 44 | feed create, edit | admin configuration | skip | human gate (admin) |
  | 45-47 | feed keys list, mint, revoke | credential admin | skip | auth/credentials |
  | 48 | `POST /feeds/:feed_key/records` | machine ingest | skip | public-inbound (own credential) |
  | 49 | `GET /feeds/:id/records` | admin inspection | **now a tool** | `bastion_list_feed_records` (M5) |
  | 53 | gap dismiss | human adjudication | skip | human gate |
  | 54, 55 | `GET /fix-drafts`, `GET /fix-drafts/:id` | read in the review queue | **now a tool** | `bastion_list_fix_drafts` (M6) |
  | 56, 57, 61, 63 | decide, mark applied, exception decide, drift acknowledge | humans decide in Bastion | skip | human gate |
  | 64 | `GET /policies` | covered by `bastion_attestation_status` | **now a tool** | `bastion_attestation_status` gains a list mode (M7) |
  | 65, 66, 71 | policy create, edit, request attestations | human admin / nudge | skip | human gate |
  | 67 | `GET /policies/:id/body` | UI reading surface | **now a tool** | `bastion_get_policy_body` (M7) |
  | 69 | `GET /me/attestations` | personal UI list | **now a tool** | `bastion_my_attestations` (M7) |
  | 70 | attest | humans only | skip | human gate (never an agent) |
  | 73, 80 | questionnaire upload, export | file intake / binary | skip | multipart/binary |
  | 75, 78, 79, 83 | mapping, item review, approve, answer-library edit | human review / release | skip | human gate |
  | 84, 88, 89 | auditor rooms, access log, auditor requests (reads) | floored | skip | human gate (spec 2.8: rooms have no tool) |
  | 85-87, 90 | room create, revoke, unlock, respond | disclosure | skip | human gate |
  | 91, 93 | packet create, download | binary packet | skip | multipart/binary |
  | 92 | `GET /exports` | floored | **now a tool** | `bastion_list_exports` (M9) |
  | 95 | `GET /search` | consumed by `search_everything` | skip | resolver-done-internally |
  | 96-99 | settings read and write, delivery problems, retry | admin / operator | skip | human gate (spec 2.8: settings have no tool) |
  | 100 | `GET /audit` | floored | **now a tool** | `bastion_audit_log` (M9) |
  | 101-104 | auditor room public routes | public | skip | public-inbound |
  | 105, 106 | internal events, engines | service-to-service | skip | internal service-to-service |
  | 107 | health | health | skip | health |

  Plus the new M3 read `GET /setup`, which gets `bastion_get_setup_status` (built). Net: 12 spec rows move from skip to a tool (1 built at M3, 11 assigned), and the tool roster grows from the spec's 24 to 34 (`bastion_get_setup_status`, `bastion_list_seals`, `bastion_list_restores`, `bastion_list_feeds`, `bastion_list_feed_records`, `bastion_list_fix_drafts`, `bastion_get_policy_body`, `bastion_my_attestations`, `bastion_list_exports`, `bastion_audit_log`). Playwright story 16 ("/docs lists 24 Bastion tools") takes its number from the registered file at M11, not from the spec.
- **Plan review.** An adversarial review of this plan against the spec and the build skill (15 findings: 2 blockers, 12 majors, 1 minor) was folded in on 2026-11-26; this version of the file reflects it.

## Progress log

- 2026-11-26: **M3 library, crosswalk, setup, deterministic compile, test harness** (b5f45714..8e9809be): 48 controls, SOC 2 (33) and ISO 27001 Annex A (93) templates with our own wording, 45 shared controls; 25 bastion-api routes (spec 5.1 rows 1-21 plus setup and bulk applicability), each with requireAuth and a catalogued requireCan, confirm and reject behind `requireSession` + `rejectWhenImpersonating`; Setup wizard and Controls pages; 7 pending MCP handlers; seeder, expectations and the M3 Playwright story. Gates: bastion-api 134 tests (incl. the DB-backed M3 gate through a temporary forwarder, removed afterwards), shared 263, mcp-server 352, bastion SPA 7; `tsc --noEmit` clean for bastion-api, bastion, shared, mcp-server; `check-permission-catalog` in sync (1570 rows); Biome budget 4796/4796; `check-tool-return-coverage` 885 tools unchanged; `docs:catalog:check` current; surface-map self-check 0; no migration added (tip 0282). Not yet run live: the seeder and Playwright, because bastion-api was not up (the stack had only postgres, redis, minio and qdrant running).

- 2026-11-26: **M2 data model and permission chain** (6a075ed6..7b4928ee): migrations 0273-0282 applied locally (rehearsed first inside a rolled-back transaction with every probe called against the GILLIGAN org); 35 `bastion_*` tables plus `github_pr_events`; `db:check` 0 drift; 21 DB-backed Bastion tests green live (definer hardening, org guard, immutability, access-log age guard, RLS coverage, change probes) and the spec 5.5 parity test; spec 4.6 probe 50/50/25/10/0; `check-permission-catalog` in sync with the DB (1570 rows); `lint:migrations` 0 violations; Biome budget 4805/4805; surface-map self-check 0. The change-probe test caught a double-encoded params bug in the test harness itself (recorded as an M4 hazard above).

- 2026-11-26: **Batch 4 done** (#164-#172; migration tip 0272). **M1 static gates all green** (bb485a26..8fb46bc6); the bastion-api image built. The Docker VM disk writes at ~0.35 MB/s, so only the images Bastion needs are being rebuilt (api done, bastion-api done, frontend in progress, then worker, bolt-api, mcp-server); every other service starts on its existing image. Recorded in the HUMAN_SETUP doc. M2 started.

- 2026-11-26: **Follow-up batches 2 and 3 done** (21 issues: #136, #137, #139, #141, #143-#159; #142 partly). Migration tip 0269. Behavior change from #153: bill expense reimburse now requires `bill.expense.approve` and recurring "generate now" requires `bill.recurring_invoice.update` (both were ungated because their ids were never in the catalog). Stack rebuild: the default desktop-linux BuildKit wedged (even a 2-line Dockerfile hung for minutes after a 30-way parallel build stalled at 0 steps for 108 min); builds now run one image at a time on an isolated `bbam-builder` docker-container builder selected by `BUILDX_BUILDER`, leaving the global default untouched. M1 started.

- 2026-11-26: **Follow-up batch 1 done**: #133 (62f1fb25), #138 (696d25dd; the MCP schema extractor was emitting zero tools and now covers all 885), #129 (84ee5f56, new `check-app-counts.mjs`), #131 (15d4c525, runner strips top-level BEGIN/COMMIT, rehearsed on a scratch postgres: 225 applied, 0 warnings, checksums unchanged), #135 (ff6eb65c), #132 (2e01263f, 4ae952aa: warning budget ratchet, 4,952 to 4,815), #134 (2b699520, migration 0262). Found and filed #143-#146. Branch CI green at 84ee5f56.

- 2026-11-26: **M0 done** (3d376ee6..8c7670a6): BOLT_SOURCES single list + 0260 + enum CI check; publishBoltEvent timeout; `/files/*` allowlist (adapted: four legacy prefixes still served with private no-store, everything else 404, see decision below); 0261 decider columns + decide route; Railway generator; no-cache for every SPA + `check:nginx-spa`; scoped `syncNew` propagation; stable secrets. Live ingest and the Railway dry run were proven by tests only (bolt-api not yet running; no Railway token). Found and filed: #133 (Bolt SPA source list), #134 (Bill PDF 404), #135 (deploy tests not in CI); queued with #129, #131, #132.

- 2026-11-26: spec converged; build started. Post-commit review of the cycle's earlier code commits: security clean; best-practices filed #129 (queued after M0); stability filed #130 (duplicate of #127, closed, folded into M0); CI watchdog pending.
