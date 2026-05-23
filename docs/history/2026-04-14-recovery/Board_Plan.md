# Board Implementation Plan (2026-04-14)

## Scope

Board is 68% feature-complete at `f5fb079`. The implementation uses Excalidraw with custom WebSocket scene synchronization rather than tldraw/Yjs (intentional divergence, documented in CLAUDE.md). This plan closes the P0 items: export endpoints, element write MCP tool exposure, spatial clustering for AI summarization, system template scene content, cross-product Bolt events, sticky-to-task dialog, and thumbnail generation.

**In scope (P0):** export endpoints; element write MCP tool exposure; spatial clustering endpoint; template seed content; board.locked and board.elements_promoted Bolt events; PromoteToTasksDialog frontend; thumbnail generation worker job.

**In scope (P1):** right-panel sidebar; element count limits (500 soft / 2000 hard); custom embed shapes via DOM overlay.

**Out of scope:** migrating from Excalidraw to tldraw, offline-first CRDT reconciliation, advanced conflict resolution.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | Export endpoints (SVG, PNG, PDF) via `@excalidraw/utils` in Node |
| G2 | P0 | audit §Missing P0 item 2 | Expose `board_add_sticky` and `board_add_text` MCP tools with full schema |
| G3 | P0 | audit §Missing P0 item 3 | Spatial clustering endpoint + `board_summarize` tool backing |
| G4 | P0 | audit §Missing P0 item 8 | Populate Excalidraw scene JSON for 10 system templates via migration |
| G5 | P0 | audit §Missing P0 item 9 | Publish `board.locked` and `board.elements_promoted` Bolt events |
| G6 | P0 | audit §Missing P0 item 5 | PromoteToTasksDialog frontend component |
| G7 | P0 | audit §Missing P0 item 6 | Thumbnail generation BullMQ job |
| G8 | P1 | audit §Missing P0 item 4 (downgraded) | Custom embed shapes via DOM overlay (Excalidraw custom renderer too limited) |
| G9 | P1 | audit §Partial sidebar | Right-panel sidebar (collaborators, versions, linked tasks) |
| G10 | P1 | audit §Element count limits | 500 soft / 2000 hard element limits enforcement |

## Migrations

**Reserved slots: 0093, 0094, 0095.**

### 0093_board_template_content.sql

**Body:**
```sql
-- 0093_board_template_content.sql
-- Why: Populate Excalidraw scene JSON for 10 system templates so they can be used as starting points. Templates currently have metadata but NULL yjs_state.
-- Client impact: additive only. Only updates rows where yjs_state IS NULL; existing template rows are not disturbed.

DO $$
DECLARE
  tmpl_sss JSONB := '{"type":"excalidraw","version":2,"source":"bbb-templates","elements":[{"type":"frame","id":"start-frame","name":"Start","x":100,"y":100,"width":400,"height":400},{"type":"frame","id":"stop-frame","name":"Stop","x":550,"y":100,"width":400,"height":400},{"type":"frame","id":"continue-frame","name":"Continue","x":1000,"y":100,"width":400,"height":400}],"appState":{},"files":{}}'::jsonb;
  tmpl_4ls JSONB := '{"type":"excalidraw","version":2,"source":"bbb-templates","elements":[{"type":"frame","id":"liked","name":"Liked","x":100,"y":100,"width":450,"height":300},{"type":"frame","id":"learned","name":"Learned","x":600,"y":100,"width":450,"height":300},{"type":"frame","id":"lacked","name":"Lacked","x":100,"y":450,"width":450,"height":300},{"type":"frame","id":"longed","name":"Longed For","x":600,"y":450,"width":450,"height":300}],"appState":{},"files":{}}'::jsonb;
BEGIN
  UPDATE board_templates
  SET yjs_state = tmpl_sss::text::bytea
  WHERE name = 'Start Stop Continue' AND yjs_state IS NULL;

  UPDATE board_templates
  SET yjs_state = tmpl_4ls::text::bytea
  WHERE name = '4Ls Retrospective' AND yjs_state IS NULL;
  -- Additional templates populated via follow-up UPDATEs or seeded via app startup
END $$;

-- Note: Additional 8 templates (Sailboat, Brainstorm, Affinity Map, User Story Map, Architecture Diagram, Flowchart Starter, SWOT Analysis, Blank Canvas) will be populated by a startup script that reads from `apps/board-api/seed/templates/*.json` files to keep this migration readable.
```

**Verification:** scratch-DB apply + `SELECT name, LENGTH(yjs_state) FROM board_templates WHERE yjs_state IS NOT NULL;`.

**Rollback:** new migration setting yjs_state back to NULL where needed.

### 0094_board_element_count_tracking.sql (P1, may be deferred)

**Body:**
```sql
-- 0094_board_element_count_tracking.sql
-- Why: Track element count per board for soft warning (500) and hard limit (2000) enforcement per design.
-- Client impact: additive only.

ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS element_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_boards_element_count
  ON boards (element_count)
  WHERE element_count > 500;
```

### 0095 — reserved, unused

**Reserved slot for additional Board follow-up work** (e.g., frame index for performance, embed element metadata).

## Schemas and shared types

- `packages/shared/src/schemas/board.ts` (update) — add `BoardExportFormat: 'svg' | 'png' | 'pdf'`, `BoardClusterSchema` for clustering response, `BoardElementLimit` warning type.
- `apps/board-api/src/db/schema/boards.ts` (update) — add `element_count` column matching migration 0094.

## API routes and services

### New routes

- `apps/board-api/src/routes/export.routes.ts` (new, G1) — `GET /boards/:id/export/:format` with format in `{svg, png, pdf}`. Loads `yjs_state`, parses Excalidraw scene JSON, calls `@excalidraw/utils exportToSvg()` / `exportToBlob()` in Node. For PDF, use `jsPDF` + rendered SVG. Returns binary download with appropriate `Content-Type` headers. Rate limit 20/min/user.

- `apps/board-api/src/routes/clustering.routes.ts` (new, G3) — `GET /boards/:id/elements/clusters?k=5`. Calls `clustering.service.ts getClusters()`. Returns structured JSON for agent use.

### New services

- `apps/board-api/src/services/clustering.service.ts` (new, G3) — `getClusters(elements, k)`. Implements k-means clustering on element x/y centers. Adaptive k (3-8 default based on element count). Preserves frame grouping: elements in same frame cluster together. Uses `ml.js` or simple Lloyd's iteration.

- `apps/board-api/src/services/export.service.ts` (new, G1) — `exportAsSvg(boardId)`, `exportAsPng(boardId)`, `exportAsPdf(boardId)`. Loads scene, runs Excalidraw utils, returns buffer.

### Route updates

- `apps/board-api/src/routes/board.routes.ts` (G5) — In `POST /boards/:id/lock`, after toggling lock flag, publish `board.locked` Bolt event with `{ board_id, board_name, locked, locked_by, locked_at }`.

- `apps/board-api/src/routes/link.routes.ts` (G5) — In `POST /boards/:id/elements/promote`, after task creation succeeds, publish `board.elements_promoted` event with `{ board_id, element_count, task_ids, promoted_by, promoted_at }`.

### Service updates

- `apps/board-api/src/services/element.service.ts` (G10) — On scene save, count elements, update `boards.element_count`. If > 2000, reject with 400. If 500-2000, set `X-Board-Element-Warning: soft-limit-exceeded` response header.

## Frontend pages and components

### New components

- `apps/board/src/components/sidebar/PromoteToTasksDialog.tsx` (new, G6) — Modal with multi-select sticky list (pre-selected from canvas), project/epic/phase dropdowns (Bam API), submit to `POST /boards/:id/elements/promote`, show task key badges on success.

- `apps/board/src/components/canvas/EmbedOverlay.tsx` (new, G8, P1) — Absolutely positioned DOM cards above canvas, synced to canvas transform. Renders task/beacon/goal/brief embeds as live data cards.

- `apps/board/src/components/sidebar/BoardSidebar.tsx` (new, G9, P1) — Right-panel sidebar with 3 tabs: Collaborators, Versions, Linked Tasks. Toggle button in top toolbar.

### Page updates

- `apps/board/src/pages/BoardCanvasPage.tsx` — Integrate PromoteToTasksDialog trigger (button + Ctrl+Shift+T), wire export toolbar menu to `/boards/:id/export/:format`, integrate BoardSidebar (P1).

- `apps/board/src/components/canvas/board-toolbar.tsx` — Add "Promote to Tasks" button, wire export dropdown click handlers.

## Worker jobs

### `apps/worker/src/jobs/board-thumbnail.job.ts` (new, G7)

Payload: `{ board_id, org_id }`.

Pipeline:
1. Debounce check via Redis `SET board:thumbnail:debounce:<board_id> 1 EX 30 NX` — skip if already set.
2. Load `yjs_state` from DB.
3. Call `@excalidraw/utils exportToBlob({ elements, appState, mimeType: 'image/png', exportPadding: 20 })` at 300x200.
4. Upload to MinIO: `board-thumbnails/<board_id>/thumbnail.png`.
5. Update `boards.thumbnail_url` with signed URL.

Retry: 2 attempts. Timeout: 30s.

Triggers: enqueued on board creation (5s delay for initial persistence) and on scene save (debounced to 30s per board).

### `apps/worker/src/jobs/board-export.job.ts` (new, G1 optional async path)

Payload: `{ board_id, format, user_id, org_id }`.

Same export pipeline as sync route but writes result to MinIO and returns signed URL via Redis cache (5-minute TTL). Used for large boards where sync export would timeout.

## MCP tools

**`apps/mcp-server/src/tools/board-tools.ts`** (updates):

- `board_add_sticky` (G2) — Full schema: `{ board_id, text, x, y, width?, height?, color?, project_id? }`. POSTs to existing `/boards/:id/elements/sticky`.
- `board_add_text` (G2) — Full schema: `{ board_id, text, x, y, font_size?, color? }`. POSTs to existing `/boards/:id/elements/text`.
- `board_summarize` (G3) — Calls new clustering endpoint. Returns structured JSON with cluster count, text snippets, coordinates.
- `board_export` (G1) — Calls new export endpoint. Returns file URL or base64.

## Tests

- `apps/board-api/src/routes/__tests__/export.test.ts` (new) — SVG/PNG generation, error cases (board not found, locked, too large).
- `apps/board-api/src/services/__tests__/clustering.service.test.ts` (new) — k-means correctness, frame-based grouping preservation, adaptive k.
- `apps/board-api/src/routes/__tests__/board.test.ts` (update) — lock endpoint emits event.
- `apps/board-api/src/routes/__tests__/link.test.ts` (update) — promote endpoint emits event.
- `apps/worker/src/jobs/__tests__/board-thumbnail.test.ts` (new) — MinIO upload mock, debounce, URL update.
- `apps/board/src/components/__tests__/PromoteToTasksDialog.test.tsx` (new) — sticky selection, form inputs, submit.

## Verification steps

```bash
pnpm --filter @bigbluebam/board-api build
pnpm --filter @bigbluebam/board-api typecheck
pnpm --filter @bigbluebam/board-api test
pnpm --filter @bigbluebam/board typecheck
pnpm --filter @bigbluebam/board test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-board-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55493:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55493/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55493/verify' pnpm db:check
docker rm -f bbb-board-verify
```

**Live smoke tests:** export a board as SVG and PNG; add sticky via MCP tool; summarize cluster via MCP; promote stickies to tasks; verify `board.locked` and `board.elements_promoted` events reach Bolt; verify thumbnail generation on board save.

## Out of scope

Migrating to tldraw + Yjs (intentional divergence per CLAUDE.md), full CRDT collaboration, presence cursor overlays in Awareness protocol, offline-first editing, custom shape SDK (Excalidraw limitation).

## Dependencies

- `@excalidraw/utils` — new npm dep for server-side export.
- `ml.js` or similar — for clustering algorithm.
- `jsPDF` — for PDF export fallback.
- MinIO bucket `board-thumbnails` (create if absent).
- Bolt API event ingest — existing dep.
- Bam API for project/epic resolution in PromoteToTasksDialog.

**Migration numbers claimed: 0093. Reserved unused: 0094 (P1 element count), 0095 (reserve).**
