# Blueprint Development — Progress Log

Running log of decisions and progress. Latest entries at the top.

## Status

| Phase | Item | Status | Commit |
|---|---|---|---|
| 0 | Branch `blueprint-dev` + plan + progress | ✅ | `7f1fa55` |
| 1 | DB migration + Drizzle schemas + shared Zod | ✅ | `3d67953` |
| 2 | `blueprint-api` Fastify scaffold + all 7 core services + 4 route files | ✅ | `3d67953` |
| 3 | Core API routes (diagrams, nodes, edges) | ✅ | `3d67953` |
| 4 | Layout, export, versions, comments, collaborators, star, templates | ✅ | `3d67953` |
| 5 | Worker jobs | ⏳ deferred to follow-up (layout runs in-process; thumbnail/export stubs not yet shipping) | — |
| 6 | SPA scaffold + auth shell | ✅ (Agent A) | this commit |
| 7 | SPA editor with React Flow + inspector + toolbar | ✅ (Agent A) | this commit |
| 8 | MCP tools (`blueprint-tools.ts`) + integration test | ✅ (Agent B) | this commit |
| 9 | Bolt catalog + nginx + compose + visibility + CLAUDE.md | ✅ (Agent C) | this commit |
| 10 | Smoke tests + final iteration | ✅ | this commit |

## End-to-end smoke (running stack)

  - SPA at `https://localhost/blueprint/` returns 200.
  - blueprint-api healthcheck passes (container reports Healthy).
  - Login as SuperUser → `POST /blueprint/api/v1/diagrams` creates a row.
  - `POST /diagrams/:id/generate` materializes 3 nodes + 2 edges + auto-layout.
  - `GET /diagrams/:id/graph` returns the laid-out graph.
  - `GET /diagrams/:id/export?format=mermaid` returns valid Mermaid flowchart syntax.
  - MCP handshake → `tools/list` shows all 20 `blueprint_*` tools.
  - `tools/call blueprint_list` returns the demo diagram.

## Tests

  - blueprint-api: typecheck clean (no unit tests yet).
  - mcp-server: 287/287 tests pass; integration test counts every tool.
  - api: 488/488 tests pass — no regressions from the visibility allowlist + peer-app stubs.
  - frontend: 119/119 tests pass.
  - bolt-catalog: 122 events registered, all `publishBoltEvent` call sites match.
  - lint-migrations: 0 violations.

## Deferred (acknowledged sharp edges)

Per the original plan, these are API-additive on landing and don't change anything that shipped today:

  - Hocuspocus + `@hocuspocus/provider` for true 60fps multiplayer. Today the stack uses REST + Redis PubSub broadcast on `blueprint:<diagramId>`, identical to Bond/Banter.
  - LiveKit per-diagram audio.
  - Client-side ELK web worker (interactive feel improvement).
  - DOT/Graphviz import + SVG/PNG raster export (worker jobs).
  - Template-browser dedicated page (the current API endpoint lists templates; the create-diagram dialog uses it as a dropdown).
  - Anchored-comment rich pinning UI (API has the columns + endpoints; the SPA shows them as a flat list).

## Decisions

### 2026-06-08 — Discovery + plan

Three discovery agents (backend, frontend, MCP+infra) returned detailed templates. Templates point at `bench-api` / `bond-api` for the API, `bench` / `board` for the SPA, and the established `apps/mcp-server/src/tools/<app>-tools.ts` pattern for MCP. Port assignment: **4015** (4011-4014 are occupied). Migration tip is 0172, next is **0173_blueprint_tables.sql**.

MVP scope = the full spec minus four explicitly-deferred sharp edges (Hocuspocus, LiveKit audio, web-worker ELK, DOT import + raster export). Each deferred item is API-additive only when it lands, so the MVP's shape doesn't change.
