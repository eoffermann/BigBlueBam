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
  - [x] `apps/frontend/Dockerfile` four lines (spec 9.3); `apps/bastion/vite.config.ts` with every `@bigbluebam/ui/*` alias from bursar (a5408230)
  - [x] SPA shell matching `/b3/`: shared sidebar with `SidebarPlatformFooter`, top bar (LaunchpadTrigger, breadcrumb, OrgSwitcher, Banter link, NotificationsBell, HelpTrigger, UserMenu), shared `Launchpad`, theme tokens copied verbatim, `mountBureauClient` and `initSystemErrorReporter({ service: 'bastion' })`, `@bigbluebam/bureau-client` dependency, `PermissionsProvider`, auth store, `?` opens Help (a5408230)
  - [ ] Gate: `/bastion/` serves; health 200; internal path 404 through nginx; Railway grep gates (`bastion-api.railway.internal:8080` present, `127.0.0.11` absent); stopping bastion-api leaves other apps up; `check:env-hints` green; fresh `.env` refusal; dry-run adds the bucket and URL to the existing worker
    - [x] Static half green: Railway grep gates (1 / 0); `check:env-hints`; `check:nginx-spa`; `nginx -t` on all three configs; fresh-`.env` refusal (compose config renders with the keys empty, `node dist/server.js` prints the four plain lines and exits 1); syncNew dry-run test (`railway-sync-bastion.nodetest.mjs`); `check-app-completeness` (24 apps, bastion absent); Biome budget; surface-map self-check 0
    - [ ] Live half (needs `docker compose build frontend` and `up` of bastion-api + frontend): `/bastion/` serves, health 200, internal path 404 through nginx, stopping bastion-api leaves other apps up
- [ ] **M2 - Data model and permission chain** (note: follow-up fixes took migrations `0262`-`0269`, so Bastion's migrations start at `0270` or later; re-verify the tip)
  - [ ] `packages/shared/src/schemas/bastion.ts` created and exported
  - [ ] Migrations `0262`-`0269` (GitHub PR events, Bastion tables, hardened probe and resolver functions with guarded GRANT, RLS); Drizzle schema modules; RLS loop
  - [ ] GitHub webhook stores `subscribed_events` from `ping` and every PR in `github_pr_events`; surface-map row for the webhook change
  - [ ] **Permission chain moved here from M10** (plan-review blocker 1): run the spec 4.5 procedure (manifest, codegen, delta, migrate, then the builtin group defaults migration) for the full spec 5.5 action set, so non-SuperUser GILLIGAN users can act from M5 on. Routes added later already reference these identifiers.
  - [ ] Gate: `db:check` 0 drift; definer-function `proconfig`/`proacl` assertion green; `ping` stores `subscribed_events`; spec 4.6 probe matches 5.5
- [ ] **M3 - Library, crosswalk, setup, deterministic compile, test harness**
  - [ ] SOC 2 and ISO 27001 libraries (own plain-language summaries), static crosswalk, per-requirement applicability, Statement of Applicability
  - [ ] Setup wizard page (incl. required Compliance project), deterministic compile
  - [ ] **MCP parity reconciliation** (plan-review 3): reconcile every spec 5.1 skip against the sanctioned categories; build read tools for read rows the spec skipped as "UI reading surface" or similar; record each remaining skip and its category in the decisions below
  - [ ] Test harness: `scripts/seed-gilligan/bastion.mjs` registered last in `run-all.mjs`, `bastion.expectations.mjs`, `appProject('bastion')` in `apps/e2e/playwright.config.ts`, `apps/e2e/src/apps/bastion/bastion-expectations.d.ts`
  - [ ] Gate: SOC 2 then ISO share controls; SoA completeness test green
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
- **Plan review.** An adversarial review of this plan against the spec and the build skill (15 findings: 2 blockers, 12 majors, 1 minor) was folded in on 2026-11-26; this version of the file reflects it.

## Progress log

- 2026-11-26: **Follow-up batches 2 and 3 done** (21 issues: #136, #137, #139, #141, #143-#159; #142 partly). Migration tip 0269. Behavior change from #153: bill expense reimburse now requires `bill.expense.approve` and recurring "generate now" requires `bill.recurring_invoice.update` (both were ungated because their ids were never in the catalog). Stack rebuild: the default desktop-linux BuildKit wedged (even a 2-line Dockerfile hung for minutes after a 30-way parallel build stalled at 0 steps for 108 min); builds now run one image at a time on an isolated `bbam-builder` docker-container builder selected by `BUILDX_BUILDER`, leaving the global default untouched. M1 started.

- 2026-11-26: **Follow-up batch 1 done**: #133 (62f1fb25), #138 (696d25dd; the MCP schema extractor was emitting zero tools and now covers all 885), #129 (84ee5f56, new `check-app-counts.mjs`), #131 (15d4c525, runner strips top-level BEGIN/COMMIT, rehearsed on a scratch postgres: 225 applied, 0 warnings, checksums unchanged), #135 (ff6eb65c), #132 (2e01263f, 4ae952aa: warning budget ratchet, 4,952 to 4,815), #134 (2b699520, migration 0262). Found and filed #143-#146. Branch CI green at 84ee5f56.

- 2026-11-26: **M0 done** (3d376ee6..8c7670a6): BOLT_SOURCES single list + 0260 + enum CI check; publishBoltEvent timeout; `/files/*` allowlist (adapted: four legacy prefixes still served with private no-store, everything else 404, see decision below); 0261 decider columns + decide route; Railway generator; no-cache for every SPA + `check:nginx-spa`; scoped `syncNew` propagation; stable secrets. Live ingest and the Railway dry run were proven by tests only (bolt-api not yet running; no Railway token). Found and filed: #133 (Bolt SPA source list), #134 (Bill PDF 404), #135 (deploy tests not in CI); queued with #129, #131, #132.

- 2026-11-26: spec converged; build started. Post-commit review of the cycle's earlier code commits: security clean; best-practices filed #129 (queued after M0); stability filed #130 (duplicate of #127, closed, folded into M0); CI watchdog pending.
