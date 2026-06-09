# Blueprint Development — Progress Log

Running log of decisions and progress. Latest entries at the top.

## Status

| Phase | Item | Status | Commit |
|---|---|---|---|
| 0 | Branch `blueprint-dev` + plan + progress | ✅ | — |
| 1 | DB migration + Drizzle schemas + shared Zod | ⏳ | — |
| 2 | `blueprint-api` Fastify scaffold | ⏳ | — |
| 3 | Core API routes + services | ⏳ | — |
| 4 | Layout, export, versions, comments, collaborators, star, templates | ⏳ | — |
| 5 | Worker jobs (layout primary; thumbnail/export stubs) | ⏳ | — |
| 6 | SPA scaffold + auth shell | ⏳ | — |
| 7 | SPA editor with React Flow + inspector + toolbar | ⏳ | — |
| 8 | MCP tools (`blueprint-tools.ts`) + integration test | ⏳ | — |
| 9 | Bolt catalog + nginx + compose + visibility + CLAUDE.md | ⏳ | — |
| 10 | Seeds + smoke tests + final iteration | ⏳ | — |

## Decisions

### 2026-06-08 — Discovery + plan

Three discovery agents (backend, frontend, MCP+infra) returned detailed templates. Templates point at `bench-api` / `bond-api` for the API, `bench` / `board` for the SPA, and the established `apps/mcp-server/src/tools/<app>-tools.ts` pattern for MCP. Port assignment: **4015** (4011-4014 are occupied). Migration tip is 0172, next is **0173_blueprint_tables.sql**.

MVP scope = the full spec minus four explicitly-deferred sharp edges (Hocuspocus, LiveKit audio, web-worker ELK, DOT import + raster export). Each deferred item is API-additive only when it lands, so the MVP's shape doesn't change.
