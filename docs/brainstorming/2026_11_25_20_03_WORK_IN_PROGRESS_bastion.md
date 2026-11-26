# Bastion build: work in progress

Spec: `docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md` (converged after three adversarial rounds, commit 2e89afca). Branch: `suite-brainstorm` (feature branches off it, merged back; never `main`/`stable`). Autonomous cycle 2026_11_25_20_03.

Each milestone lands as small commits, is pushed, and is followed by the post-commit-review pipeline; open `automated-review` issues are addressed before the next milestone starts. A milestone is checked only when its "done when" gate from spec section 12 passes on the local stack and branch CI is green.

## Milestones

- [ ] **M0 - Platform prerequisites (fix the fact, not the place)**
  - [ ] #124 one shared `BOLT_SOURCES` list in `@bigbluebam/shared`; ingest zod enum, `TRIGGER_SOURCES`, `TriggerSourceV1` derived from it; migration `0260` adds the explicit missing pgEnum values (incl. `bursar`, `bastion`); `check-bolt-catalog.mjs` fails on a source missing from the list; `db-drift.yml` step asserts the live enum equals `BOLT_SOURCES`
  - [ ] #125 `publishBoltEvent` gets an `AbortSignal` timeout, with a unit test
  - [ ] #123 `GET /files/*` restricted to `avatars/`, `Cache-Control: private` elsewhere, negative test
  - [ ] #126 `syncNew` reconcile: opt-in `propagate: true` hints, never overwrite, planned diff printed, `skipDeploys` then one redeploy per service
  - [ ] #127 index.html no-cache regex covers every SPA (incl. basis, braid, bulwark, burn, bursar)
  - [ ] #128 migration `0261`: `agent_proposals.decided_by`, `decided_by_kind` (`actorTypeEnum`), `decided_impersonator_id`, `owning_app`, `require_human_decider`; `platform_backups` mirror status/cursor columns; decide route records the decider, enforces human-only, returns 409 `DECIDE_IN_APP` for app-owned proposals; Drizzle updated
  - [ ] `gen-railway-configs.mjs` rewrites `set $var host:port;` and replaces `resolver 127.0.0.11` with `__RESOLVER__`; unit test
  - [ ] Stable-secret class in `generateSecrets()` (never rehydrated from `[REDACTED]`)
  - [ ] Gate: Bursar and Bastion events ingest 2xx; enum check green; `/files/<non-avatar>` 404; `syncNew` dry-run shows only `propagate` additions; generic decide of an app-owned proposal 409s; generator test green; `pnpm db:check` and `pnpm lint:migrations` green
- [ ] **M1 - Scaffold and infrastructure (direct URL only, no Launchpad)**
  - [ ] `apps/bastion-api` from the bursar-api skeleton (plus `packages/storage` in the Dockerfile), service-health, logging, permissions plugin, auth with `rejectWhenImpersonating`, `BASTION_TRUST_PROXY_HOPS`
  - [ ] Own bucket (`BASTION_S3_BUCKET`) with a boot put/stat/delete check and plain error
  - [ ] Compose service (port 4024, `:-` secrets with plain refusal message, `stop_grace_period: 75s`), worker env, `frontend.depends_on`
  - [ ] nginx: runtime-resolved `/bastion/api/` upstream, `/bastion/` SPA, internal-path deny, asset and no-cache regexes; regenerated Railway conf
  - [ ] `services.mjs` entry, env hints (stable secrets, `propagate` on `BASTION_S3_BUCKET` and the URL hints), `railway/bastion-api.json`
  - [ ] `apps/bastion` SPA shell matching `/b3/` (shared sidebar, top bar, Launchpad trigger, theme tokens, Bureau widget, providers)
  - [ ] Gate: `/bastion/` serves; health 200; internal path 404 through nginx; Railway grep gates; stopping bastion-api leaves other apps up; `check:env-hints` green; fresh `.env` refusal; `syncNew` dry-run adds the bucket and URL to the existing worker
- [ ] **M2 - Data model**
  - [ ] Migrations `0262`-`0269` (Bam GitHub PR events, Bastion core, evidence, gaps/policies, questionnaires, sharing, hardened probe and resolver functions, RLS)
  - [ ] Drizzle schema modules; RLS loop; GitHub webhook stores `subscribed_events` from `ping` and every PR in `github_pr_events`
  - [ ] Gate: `db:check` 0 drift; definer-function assertion test green; `ping` stores `subscribed_events`
- [ ] **M3 - Library, crosswalk, setup, deterministic compile**
  - [ ] SOC 2 and ISO 27001 libraries (own plain-language summaries), static crosswalk, per-requirement applicability, Statement of Applicability
  - [ ] Setup wizard (incl. required Compliance project), deterministic compile, GILLIGAN seeder started
  - [ ] Gate: SOC 2 then ISO share controls; SoA completeness test green
- [ ] **M4 - Evidence engine**
  - [ ] Probes via `runInOrgScopeRead`, evaluator (time budgets, resumption, orphan re-enqueue, staleness), ledger, seals plus bucket objects, identity-based restore detection with provisional epochs and append blocking, outbox with ordering keys
  - [ ] `bastionEvents` registered in the Bolt catalog; `enqueueBastionEvent` helper; bolt-api dispatch hook
  - [ ] Gate: probe goldens three ways (RLS off, RLS on, separate read pool); both restore tests; kill-mid-slice test; outbox ordering test
- [ ] **M5 - Manual evidence, personal data, feeds, Readiness** (gate: Playwright stories 1-3)
- [ ] **M6 - Gaps, fixes, exceptions, decide routes, internal Bam routes, proposal reconcile** (gate: Playwright 4-6)
- [ ] **M7 - LLM tailoring with populations; policies and attestation** (gate: compiler corpus gates)
- [ ] **M8 - Questionnaires and the xlsx codec** (gate: questionnaire gates; Playwright 7)
- [ ] **M9 - Auditor room, audit packet, object sweep, off-site mirror, restore-objects CLI, help doc** (gate: Playwright 8-11; packet smoke with differing buckets; failing mirror leaves the backup `completed`)
- [ ] **M10 - Permission chain, MCP client and handlers (pending path), visibility, search, surface map** (gate: Playwright 12-15; section 4.6 probe matches 5.5; tool-count and docs-catalog checks still green)
- [ ] **M11 - One merge unit: `bastion-tools.ts` registered, docs catalog, published counts (909), CLAUDE.md, Launchpad, marketing section, gilligan screenshots, README** (gate: Playwright 16; `check:app-completeness`, `check-tool-return-coverage`, `docs:catalog:check` green)
- [ ] **Close-out audit** (`close-out` skill) and `BUILD_REPORT_bastion.md`

## Decisions recorded during the build

- The Railway staging smoke test in the M9 gate needs a Railway deploy, which is outside this loop (local Docker dev stack only; production deploys and promotion are human decisions). It is recorded in the HUMAN_SETUP doc as a post-promotion verification step; everything else in M9 is verified locally.
- MCP parity: the spec keeps `bastion-tools.ts` out of the tree until M11 so the tool-count and docs-catalog CI gates stay green (round-3 best-practices-3). To honor the build rule that a route and its tool land together, every milestone from M3 on writes the MCP handler for each route it adds (or records the sanctioned skip in the surface-map draft) in `apps/mcp-server/src/tools-pending/bastion.ts`, with tests, in the same commit as the route. M10 completes the client and the parity cross-walk; the M11 merge unit only moves the file to `bastion-tools.ts` and registers it.

## Progress log

- 2026-11-26: spec converged; build started.
