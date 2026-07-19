# Burn build - work in progress

Spec: `docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md` (2014 lines, three
adversarial hardening rounds, build-ready).

Branch: `suite-brainstorm`. Never merged to `main`/`stable`.

**Scale:** 14 tables, 5 migrations (0239-0243, two passes), 22 permissions,
17 MCP tools, 10 Bolt events plus 4 backfilled `bill` events, 9 job families plus
a claim reaper, 7 SPA screens, port 4022.

**Blast radius: nine services.** Burn touches `bill-api`, `bolt-api`, `worker`,
`mcp-server`, `api`, and the `bill` SPA, and the shared-package consolidation
touches `basis-api`, `braid-api`, `bulwark-api`.

---

## M0 - Preceding PRs (land before Burn code)

- [ ] `packages/shared/src/visibility-client.ts` exporting `preflightAccess` + `preflightMany`
- [ ] `"./visibility-client"` block in `packages/shared/package.json` exports
- [ ] **`'src/visibility-client.ts'` appended to the `entry` array in `packages/shared/tsup.config.ts`** (three-file contract; without it the dist artifact is never emitted and four services fail image build)
- [ ] `basis-api`, `braid-api`, `bulwark-api` migrated onto it, per-app copies deleted
- [ ] Basis-only `DIMENSION_ENTITY_TYPE` / `entityTypeForDimension` / `resolveVisibleValues` kept in `apps/basis-api/src/lib/` as a thin wrapper (Class-B decomposition, not a visibility client)
- [ ] `can_access` fail-closed probe passes in each of the three migrated apps
- [ ] `BOLT_API_INTERNAL_URL` computed hint added (closes a live bug: required on bulwark-api, orchestrator throws on unknown-required)
- [ ] env-hints coverage test with a dated, append-forbidden allowlist of the 16 pre-existing names
- [ ] Root `check:env-hints` script + a step in `.github/workflows/lint.yml`

## M1 - Scaffold

- [ ] `apps/burn-api` (Fastify, internal 4022) from the bulwark-api sibling
- [ ] `apps/burn` SPA from the blip sibling
- [ ] `@bigbluebam/logging`, `@bigbluebam/service-health` (`/health`, `/health/ready` - there is no `/readyz`)
- [ ] `BBB_PERMISSIONS_ENFORCE=on` unconditional plus a boot assertion that exits non-zero otherwise

## M2 - Data model

- [ ] 14 Drizzle schema modules plus `agent-proposals.ts`, `entity-links.ts`, `bbb-refs.ts`
- [ ] `search_tsv` declared via `customType<{data:string}>({dataType:()=>'tsvector'})`
- [ ] **Pass 1:** author and apply `0239`-`0241`
- [ ] **Pass 2:** run `build-permission-delta.mjs` against the applied schema, then author `NNNN+1_burn_builtin_group_defaults.sql`
- [ ] Group-defaults probe: owner 22, admin 22, member 14, viewer 7, guest 0
- [ ] `pnpm db:check` and `pnpm lint:migrations` green

## M3 - Shared Zod

- [ ] `packages/shared/src/schemas/burn.ts`
- [ ] `export * from './burn.js'` in `schemas/index.ts`
- [ ] Money block is a discriminated union on `metric_basis` including a `suppressed` member
- [ ] Idempotency HMAC in its own file behind a subpath export (no `node:crypto` in the frontend bundle)

## M4 + M5 - Routes and tools together

- [ ] REST endpoints per §6.1
- [ ] Shared `redactFinancialFields` serializer across all eight surfaces
- [ ] `viewerCaps` from fail-closed `dual-read`, never `fastify.canResolve`
- [ ] Bearer-intersect-asker rule on MCP surfaces
- [ ] 17 tools via `registerTool()`
- [ ] `burn.*` `agent_policies` allowlist
- [ ] `confirm_action` on destructive tools **and on gate disable**
- [ ] Surface-map rows for every endpoint; self-check prints `0`

## M6 - Engines, workers, events

- [ ] Extraction, attribution, variance, inverse check, revaluation, change-order drafting
- [ ] 9 job families plus the claim reaper
- [ ] `pg_advisory_xact_lock` in burn-api's sweep service; **no lock-holding transaction contains an outbound HTTP call**
- [ ] 10 `burn` events plus 4 backfilled `bill` events in `event-catalog.ts`
- [ ] Payloads carry refs and coarse bands only
- [ ] `check:bolt-catalog` added to `lint.yml`

## M7 - SPA

- [ ] 7 screens
- [ ] Shell parity: sidebar, top bar, Launchpad, `globals.css` verbatim, Bureau widget, providers
- [ ] The one Bill SPA change (inline advisory-feedback control)

## M8 - Launchpad and infra

- [ ] `LAUNCHPAD_APP_IDS` + `LAUNCHPAD_CATALOG`
- [ ] Launchpad grid overflow checked and condensed if needed, or explicitly stated as fitting
- [ ] `docker-compose.yml` burn-api service
- [ ] All three nginx configs, plus the pre-existing `bill`/`bay`/`blip` alternation drift reconciled
- [ ] `apps/frontend/Dockerfile` SPA lines
- [ ] `services.mjs`, ENV_HINTS, `gen-railway-configs.mjs`
- [ ] `CLAUDE.md` inventory and routes, `.env.example`

## M9 - Deploy and test

- [ ] Two migrate passes, all nine changed services rebuilt
- [ ] All eleven convention gates green
- [ ] `appProject('burn')` registered in `apps/e2e/playwright.config.ts`
- [ ] Playwright user stories against gilligan, each verifying backend state via curl AND psql
- [ ] A representative slice driven through MCP tools alone

## M10 - Docs, screenshots, marketing

- [ ] `docs/apps/burn/help.md` + `help-index.json` + Help Center
- [ ] `burn` in the hardcoded `APP_REGISTRY` at `scripts/docs/extract.mjs:63`
- [ ] `APP_TOOL_MODULES` entry
- [ ] `docs:extract`, `docs:compose`, `docs:catalog`, `docs:manual` regenerated and committed
- [ ] `marketing.md` + `docs:publish` + `APP_ICON`/`APP_COLOR`
- [ ] MCP tool counts updated everywhere (847 to 864)
- [ ] `scripts/seed-gilligan/burn.mjs` in a new trailing group + `seed-all.mjs` PHASE_B
- [ ] Gilligan screenshots
- [ ] `frontend` rebuilt after `help:index`

## M11 - Close-out

- [ ] `close-out` skill passes every line
- [ ] `BUILD_REPORT` written
- [ ] Lock released
