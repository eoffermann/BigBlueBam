# Blueprint Development — Working Plan

Implementation plan for the Blueprint structured-diagram product, driven by `docs/plans/blueprint-development-plan.md`. Branch: `blueprint-dev` off `main`.

## Discovery summary

Three parallel discovery agents mapped:
- **Backend pattern** — `bench-api` / `bond-api` as the templates. Standard layout: `src/server.ts` (Fastify init + plugins + routes), `src/env.ts` (Zod env), `src/db/{index.ts, schema/*}` (Drizzle + postgres-js), `src/routes/*.routes.ts`, `src/services/*.service.ts`, `src/plugins/{auth, redis, permissions}.ts`. Bolt events fire via `publishBoltEvent('event', 'source', payload, orgId, userId)` from `@bigbluebam/shared`. Realtime is Redis PubSub broadcast on `<app>:<id>` channels. Dockerfile is a 3-stage build (`deps` / `build` / `production` on `node:22-alpine`).
- **Frontend pattern** — `bench/` and `board/` as templates. Vite 6 + React 19 + Tailwind v4 + TanStack Query v5 + Zustand. Hand-rolled router using a discriminated-union `Route` type and a `parseRoute(path)` function. Auth via shared session cookie; `useAuthStore.fetchMe()` hits `/b3/api/auth/me`. `api.ts` client uses `credentials: 'include'`, base URL `/blueprint/api`. Shell components come from `@bigbluebam/ui` (Launchpad, OrgSwitcher, NotificationsBell, UserMenu, HelpViewer, PermissionsProvider). Build output is mounted at `/usr/share/nginx/html/blueprint/` in the single shared `frontend` nginx container.
- **MCP / infra pattern** — Tool modules per app under `apps/mcp-server/src/tools/<app>-tools.ts`. Each module gets a satellite-API URL via constructor (`registerBlueprintTools(server, api, env.BLUEPRINT_API_URL)`). Tools use `registerTool(server, { name, description, input: zodInputObject, returns: zodReturn, handler })`. Bolt event catalog at `apps/bolt-api/src/services/event-catalog.ts` is the drift guard target. `infra/nginx/nginx.conf` gets three new location blocks: `/blueprint/`, `/blueprint/api/`, `/blueprint/ws`. The integration test at `apps/mcp-server/test/integration.test.ts` enumerates every tool name and must be extended.

**Port assignment:** 4011 is occupied (bench-api). 4012-4014 are book/blank/bill. **Blueprint API uses 4015.**

**Migration number:** `0173_blueprint_tables.sql` (tip is 0172).

## MVP scope

A complete walking skeleton across every layer, demonstrating the concept end-to-end. Deferred items are flagged but stubbed sensibly so they can be filled in without retrofit.

### MVP — in this turn

1. **Database** — all 7 tables in one migration plus Drizzle schemas. Optional second migration seeding 3 system templates.
2. **blueprint-api** — Fastify service on `:4015` exposing core CRUD:
   - `GET/POST /diagrams`, `GET/PATCH/POST /diagrams/:id[/archive]`
   - `GET /diagrams/:id/graph` (full nodes + edges payload)
   - `GET/POST /diagrams/:id/nodes`, `PATCH/DELETE /diagrams/:id/nodes/:nodeId`, `POST /diagrams/:id/nodes/:nodeId/move`
   - `GET/POST /diagrams/:id/edges`, `PATCH/DELETE /diagrams/:id/edges/:edgeId`
   - `POST /diagrams/:id/layout` (server-side ELK via elkjs)
   - `POST /diagrams/:id/generate` (build from a structured spec — NL inference deferred to MCP `blueprint_generate`)
   - `GET/POST /diagrams/:id/versions`, `POST /diagrams/:id/versions/:n/restore`
   - `GET/POST /diagrams/:id/comments`, `PATCH /diagrams/:id/comments/:cid`
   - `GET/POST/DELETE /diagrams/:id/collaborators`
   - `POST /diagrams/:id/star` / `DELETE`
   - `GET /templates`
   - `POST /diagrams/:id/nodes/:nodeId/promote-to-task`, `POST /diagrams/:id/nodes/:nodeId/link-entity`
   - `GET /diagrams/:id/export?format=…` — JSON and Mermaid in MVP; SVG/PNG deferred to worker
   - `POST /diagrams/:id/import` — Mermaid only in MVP; DOT deferred
   - Bolt events fired for every mutation
3. **MCP** — all 20 `blueprint_*` tools as thin pass-throughs. `blueprint_generate` runs server-side: validates the spec, materializes nodes+edges, runs auto-layout.
4. **Frontend SPA** — `apps/blueprint/` with:
   - `/blueprint/` diagram list with type/project filter + create modal
   - `/blueprint/d/:id` editor: React Flow canvas, shape palette, inspector for selected node/edge, toolbar (layout, save-version, export, type switch)
   - Read graph from `/diagrams/:id/graph`; settled drag = PATCH `/move`; connect = POST `/edges`
   - Layout button calls `POST /layout`, applies returned positions
5. **Infra**:
   - `docker-compose.yml` — `blueprint-api` service block + `BLUEPRINT_API_URL` on mcp-server + the SPA build added to the `frontend` container
   - `infra/nginx/nginx.conf` — three location blocks + the static-asset cache regex
   - `Dockerfile`s for both blueprint-api and the frontend pass
6. **Worker** — registration for three new queues (`blueprint-thumbnail`, `blueprint-layout`, `blueprint-export`) with handler stubs; only `blueprint-layout` ships a real implementation (calls ELK on a large-graph fallback). Thumbnail and export are stubs that log and return — wired but inactive.
7. **CLAUDE.md** — add Blueprint to the apps list, URL routing list, and key-design-decisions list.
8. **Bolt catalog** — register every `blueprint.*` event so `scripts/check-bolt-catalog.mjs` passes.
9. **Visibility allowlist** — add `blueprint.diagram` (and `blueprint.node`) to `SUPPORTED_ENTITY_TYPES` in `apps/api/src/services/visibility.service.ts`.
10. **Tests**: unit tests for the service layer; the MCP integration test extended to know every new tool name; end-to-end smoke via the running stack.
11. **Seeds** — `scripts/seed-blueprint.mjs` invoked by the orchestrator that creates 2-3 demo diagrams across diagram types.

### Deferred (sharp-edges acknowledged)

- **Hocuspocus / Yjs live-multiplayer layer** — MVP uses Redis-PubSub broadcasts (the same pattern Bond, Banter, and Bam use), which gives live "someone else changed this" updates but not 60fps cursor + selection + in-flight drag. Hocuspocus + `@hocuspocus/provider` is one follow-up commit's worth of work; the API surface is unchanged.
- **LiveKit per-diagram audio** — Plumbing is identical to Board; defer until the editor has a stable shape.
- **Client-side ELK web worker** — MVP runs auto-layout server-side via `/diagrams/:id/layout`. The web-worker version is purely an interactive-feel improvement.
- **DOT import + SVG/PNG export** — Mermaid round-trip is enough to prove the interop story; DOT and raster export land as worker jobs in follow-up.
- **Template browser UI** — `/templates` API endpoint ships; the SPA's create modal lists templates as a dropdown but the dedicated browser page is deferred.
- **Anchored-comment rich UX** — Comments API ships; SPA shows them in an inspector panel as a flat list. Pinning to coordinates is deferred.
- **Cross-product entity link UI** — `link-entity` and `promote-to-task` endpoints + MCP tools ship. SPA shows a tiny "linked: BBB-42" chip on the node but no rich link picker.

Sharp-edge notes for each go in `docs/blueprint-notes.md` per CLAUDE.md's "future concerns in project docs" rule.

## Execution order

Sequential where there's a build dependency, parallel where independent. I'll commit per phase, push after each.

| Phase | Deliverable | Branches off |
|---|---|---|
| 1 | DB migration + Drizzle schemas + shared Zod | — |
| 2 | `blueprint-api` Fastify scaffold (server, env, db, plugins, healthz) | Phase 1 |
| 3 | API routes + services for diagrams/nodes/edges | Phase 2 |
| 4 | Server-side ELK layout + export + versions + comments + collaborators + star + templates | Phase 3 |
| 5 | Worker jobs (thumbnail stub + layout + export stub) | Phase 4 (decoupled) |
| 6 | SPA scaffold (Vite, App router, auth, layout shell) | Phase 1 |
| 7 | SPA editor with React Flow + inspector + toolbar | Phase 6 |
| 8 | MCP tool module (`blueprint-tools.ts`) + integration-test list | Phase 4 |
| 9 | Bolt event catalog + nginx + compose + visibility allowlist + CLAUDE.md | Phases 4 + 8 |
| 10 | Seed script + smoke tests + final iteration | All |

Phases 5/6/8 can run as parallel sub-agents in addition to my sequential work where I'm confident in the spec.

## Architectural decisions

- **Realtime: Redis PubSub now, Hocuspocus later.** Bond and Banter both succeed with REST + Redis PubSub. Hocuspocus is an additive layer that doesn't change the API.
- **ELK only on the server in MVP.** The web-worker version is a P2 polish move. Server `/layout` endpoint is fully functional for both human-clicked and agent-driven layout.
- **Drizzle table names use `snake_case` with `blueprint_` prefix.** Matches every other suite app.
- **Bolt source = `blueprint`.** Single source string, bare event names (`diagram.created`, `node.moved`, `layout.applied`, etc.).
- **Visibility = `organization | project | private` mirroring Beacon/Brief.** Per-diagram collaborators layer on for explicit shares.
- **No `human_id` on diagrams.** Slug covers shareable URLs. Matches the design doc.
- **Server-side mermaid generation, client-side Mermaid display.** `mermaid-js/mermaid` ships in the SPA; the server emits the source text only.
- **Permissions** — every mutating route guarded by `requireAuth + requireCan('blueprint.<action>') + requireScope('read_write')`. `archive` gets `requireScope('admin')`. Actions land in the permissions seed migration on a follow-up; for MVP `requireCan` runs in `warn` mode (the `BBB_PERMISSIONS_ENFORCE=warn` default) so missing perm rows don't break the flow.

## Risks and mitigations

- **`elkjs` is EPL-2.0.** Used as an unmodified npm dep, no relicensing burden on the MIT codebase. Ship a NOTICE entry in the repo if not already present. Per the design doc this is settled.
- **Big surface = type drift between API, SPA, MCP.** Mitigation: all Zod schemas live in `packages/shared/src/schemas/blueprint.ts` and are imported on every layer.
- **Migration 0173's 7 tables in one file = wide blast radius if wrong.** Mitigation: every CREATE TABLE has `IF NOT EXISTS`; every index too; the runner hashes the body so any post-hoc edit gets caught.
- **The frontend Dockerfile change must build the blueprint SPA AND keep the others passing.** Mitigation: rebuild the `frontend` container once after every Dockerfile change and smoke-test bench/board/blueprint URLs in parallel.

## Verification gates per phase

Each phase commits only after:
1. `pnpm --filter <package> typecheck` clean.
2. `pnpm --filter <package> test` passes if tests exist for the touched layer.
3. Docker rebuild + restart of the affected service.
4. Smoke test of one happy-path API call or one SPA route.
5. Push to `origin/blueprint-dev`.

The final phase loops back through the original requirements (the headline-capabilities list in `blueprint-development-plan.md`) and checks each off explicitly.
