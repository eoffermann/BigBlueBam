# Brief Implementation Plan (2026-04-14)

## Scope

Brief is 62% complete at `f5fb079` with a solid REST API (88% of routes built), full Drizzle schema, and a Tiptap editor using 10 of 13 planned extensions. The single largest gap is real-time collaborative editing via Yjs/Hocuspocus (P0, blocking core product value). Plan closes that P0 plus seven P1 gaps in semantic search, missing editor extensions, Beacon graduation, background jobs, shared schemas, and collaborator permission enforcement.

**In scope (P0):** Yjs/Hocuspocus collaboration engine (server WebSocket, persistence, awareness); missing Tiptap extensions (Mention, TaskEmbed, BeaconEmbed, CalloutBlock, SlashCommand, BubbleMenu, ChannelLink).

**In scope (P1):** Qdrant semantic search integration; background jobs (`brief:embed`, `brief:snapshot`, `brief:export`, `brief:cleanup`); shared Zod schemas in `packages/shared/src/schemas/brief.ts`; Beacon graduation refactor with rendered markdown; collaborator permission middleware on mutation routes.

**In scope (P2):** Full-text search ILIKE fallback leveraging existing tsvector GIN index.

**Out of scope:** Beacon graph integration (owned by Beacon_Plan.md), folder tree UI with drag-reorder, document version branching, third-party PDF rendering services.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §P0 item 1 | Yjs/Hocuspocus collaboration engine (server, persistence, awareness, client extensions) |
| G2 | P0 | audit §P0 item 2 | Missing Tiptap extensions: Mention, TaskEmbed, BeaconEmbed, Callout, SlashCommand, BubbleMenu, ChannelLink |
| G3 | P1 | audit §P1 item 1 | Qdrant semantic search (chunks, embeddings, upsert, query) |
| G4 | P1 | audit §P1 item 2 | Background jobs: brief:embed, brief:snapshot, brief:export, brief:cleanup |
| G5 | P1 | audit §P1 item 3 | Shared Zod schemas in packages/shared/src/schemas/brief.ts |
| G6 | P1 | audit §P1 item 4 | Beacon graduation: render Yjs to Markdown, call Beacon API, set source_brief_id, suggest tags |
| G7 | P1 | audit §Partial/divergent | Collaborator permission enforcement on mutation routes (view/comment/edit) |
| G8 | P2 | audit §P2 item | PostgreSQL full-text search fallback via existing tsvector GIN index |

## Migrations

**Reserved slots: 0103, 0104.**

### 0103_brief_yjs_state_tracking.sql

**Body:**
```sql
-- 0103_brief_yjs_state_tracking.sql
-- Why: Activate yjs_state column for Hocuspocus persistence. Track last-saved timestamp for debounce logic and to avoid redundant writes.
-- Client impact: additive only. New column and index. No data migration.

ALTER TABLE brief_documents
  ADD COLUMN IF NOT EXISTS yjs_last_saved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_brief_docs_yjs_lookup
  ON brief_documents(id, organization_id)
  WHERE yjs_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brief_docs_yjs_last_saved
  ON brief_documents(yjs_last_saved_at);
```

### 0104_brief_qdrant_embedded_at.sql

**Body:**
```sql
-- 0104_brief_qdrant_embedded_at.sql
-- Why: Track which documents have been embedded for Qdrant semantic search. Enables resume-safe chunking, re-embed on update, and cleanup.
-- Client impact: additive only. New nullable column and index.

ALTER TABLE brief_documents
  ADD COLUMN IF NOT EXISTS qdrant_embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_brief_docs_qdrant_embedded
  ON brief_documents(organization_id, qdrant_embedded_at);
```

## Schemas and shared types

- `packages/shared/src/schemas/brief.ts` (new, G5) — `BriefDocumentStatus`, `BriefVisibility`, `BriefPermission` (view/comment/edit), `BriefLinkType`, `BriefBeaconLinkType`, `BriefExportFormat`, `CreateDocumentSchema`, `UpdateDocumentSchema`, `CreateCommentSchema`, `CollaboratorSchema`, `UpdateCollaboratorSchema`. Exported from `@bigbluebam/shared`.
- `apps/brief-api/src/db/schema/brief-documents.ts` (update) — add `yjs_last_saved_at` (nullable timestamptz) and `qdrant_embedded_at` (nullable timestamptz) matching migrations 0103, 0104.

## API routes and services

### New services

- `apps/brief-api/src/services/yjs-persistence.service.ts` (new, G1) — `loadYjsState(docId)` returns `Uint8Array | null`; `saveYjsState(docId, state, orgId)` writes with 30-second per-doc debounce, updates `yjs_last_saved_at`, skips write if state unchanged; `debounceYjsUpdate(docId, orgId, state, immediate?)` schedules async flush. Called from Hocuspocus `onStoreDocument` and `onDisconnect`.
- `apps/brief-api/src/services/embedding.service.ts` (new, G3) — `chunkDocument(plainText, chunkSize=512, overlap=64)` splits at sentence boundaries; `embedChunks(chunks, model)` calls configured embedding API; `upsertToQdrant(docId, title, chunks, vectors, orgId, projectId?)` writes to Qdrant collection `brief_documents` with metadata; `searchQdrant(query, orgId, projectId?, limit)` returns SearchResult[]; `deleteQdrantByDocId(docId)` on archive.
- `apps/brief-api/src/services/snapshot.service.ts` (update) — `renderHtmlSnapshot(yjs_state)` renders binary state to HTML via `@tiptap/html`; `renderPlainText(yjs_state)` extracts plain text for indexing.

### New routes

- `WS /ws` (new, G1) in `apps/brief-api/src/routes/collaboration.routes.ts` — Hocuspocus WebSocket endpoint. Auth via URL query `?token=<bearer>`. Register persistence extension (calls `yjs-persistence.service`) and Redis PubSub extension for cross-instance sync. 401 on invalid token.

### Route updates

- `POST /documents/:id/promote` (G6) in `apps/brief-api/src/routes/document.routes.ts` — refactored to call new `graduation.service.promoteToBeacon(docId, userId, orgId)`.
- `PATCH/DELETE /comments/:id` (G7) — add `requireCommentEditAccess()` middleware (author or admin).
- `PATCH/DELETE /collaborators/:id` (G7) — add `requireDocumentEditAccess()` middleware verifying the requester has edit permission on the document.
- `POST /search` (G3, G8) — call `searchSemanticAndFallback(query, orgId, projectId)`: try Qdrant first, fall back to ILIKE + `to_tsvector` GIN if Qdrant unavailable or returns no results.

### Service updates

- `apps/brief-api/src/services/graduation.service.ts` (update, G6) — `promoteToBeacon(docId, userId, orgId)`:
  1. Load document, verify user has edit permission.
  2. Render `yjs_state` to Markdown via `@tiptap/html` + Turndown.
  3. `POST ${BEACON_API_URL}/v1/beacons` with title, body_markdown, visibility='organization', created_by, org_id.
  4. Save returned beacon id to `brief_documents.promoted_to_beacon_id`.
  5. Insert `brief_beacon_links` row.
  6. Optional: query Qdrant for semantically similar beacons to suggest tags.
  7. Return `{ beaconId }`.
- `apps/brief-api/src/middleware/authorize.ts` (update, G7) — `requireCommentEditAccess()`, `requireCollaboratorEditAccess()`, `requireDocumentEditAccess()`.

## Frontend pages and components

### New Tiptap extensions (G2)

- `apps/brief/src/tiptap/mention.extension.ts` — `@mention` with user autocomplete fetching `/v1/users?org_id=...`.
- `apps/brief/src/tiptap/task-embed.extension.ts` — inline Bam task embed node view fetching `/b3/api/tasks/:id`, rendering mini-card.
- `apps/brief/src/tiptap/beacon-embed.extension.ts` — inline Beacon embed node view fetching `/beacon/api/beacons/:id`.
- `apps/brief/src/tiptap/callout.extension.ts` — callout block with type variants (info/warning/success/error).
- `apps/brief/src/tiptap/slash-command.extension.ts` — `/` palette for inserting block types.
- `apps/brief/src/tiptap/bubble-menu.extension.ts` — floating toolbar on text selection.
- `apps/brief/src/tiptap/channel-link.extension.ts` — `#channel-name` Banter channel resolution.

### New components

- `apps/brief/src/components/document/collaborator-cursors.tsx` (new, G1) — renders remote cursors and selection ranges from Yjs Awareness state.
- `apps/brief/src/components/document/presence-bar.tsx` (new, G1) — active collaborator avatar row, click-to-follow.

### Page updates

- `apps/brief/src/pages/document-editor.tsx` (update, G1) — integrate Hocuspocus provider and Tiptap Collaboration + CollaborationCursor extensions. Wire awareness for presence/cursor overlay. Preserve Zustand state for document metadata.

## Worker jobs

### `apps/worker/src/jobs/brief-embed.job.ts` (new, G4)

Trigger: document save webhook from brief-api plus fallback scheduled job every 30 minutes.

Pipeline:
1. Query `brief_documents WHERE qdrant_embedded_at IS NULL OR qdrant_embedded_at < updated_at`.
2. For each: load `yjs_state`, render plain text via `snapshot.service.renderPlainText`.
3. Chunk, embed, upsert to Qdrant.
4. Update `qdrant_embedded_at = NOW()`.

### `apps/worker/src/jobs/brief-snapshot.job.ts` (new, G4)

Trigger: every 30 minutes.

Query `brief_documents WHERE yjs_last_saved_at > snapshot_updated_at OR snapshot_updated_at IS NULL`. Render `html_snapshot` and `plain_text_snapshot`, update columns.

### `apps/worker/src/jobs/brief-export.job.ts` (new, G4)

Trigger: on-demand via BullMQ enqueue from export endpoint.

Payload: `{ documentId, userId, format: 'markdown'|'html'|'pdf' }`. Render document, write to MinIO `exports/{org_id}/{doc_id}/{timestamp}.{ext}`, notify user with presigned URL.

### `apps/worker/src/jobs/brief-cleanup.job.ts` (new, G4)

Trigger: daily 4 AM UTC.

1. `DELETE FROM brief_versions WHERE created_at < NOW() - INTERVAL '365 days'`.
2. `DELETE FROM brief_embeds WHERE created_at < NOW() - INTERVAL '90 days' AND is_orphaned = true`.
3. Log row counts.

Register all four jobs in `apps/worker/src/index.ts`.

## MCP tools

- `apps/mcp-server/src/tools/brief-tools.ts` (update, G5) — align schemas to fixed API endpoints. `brief_update_content` and `brief_append_content` use restored routes. `brief_search` honors `semantic` and `limit` parameters. No new tools.

## Tests

- `apps/brief-api/src/services/__tests__/yjs-persistence.service.test.ts` (new, G1) — load/save roundtrip, debounce behavior.
- `apps/brief-api/src/services/__tests__/embedding.service.test.ts` (new, G3) — chunk boundaries, upsert to mock Qdrant, search.
- `apps/brief-api/src/services/__tests__/graduation.service.test.ts` (new, G6) — yjs-to-markdown, Beacon call, link creation.
- `apps/brief-api/src/routes/__tests__/collaboration.test.ts` (new, G1) — WebSocket handshake (valid and invalid token), mock Hocuspocus message sync.
- `apps/brief-api/src/routes/__tests__/authorize.test.ts` (update, G7) — comment edit access and collaborator edit access.
- `apps/brief/src/tiptap/__tests__/mention.extension.test.ts` (new, G2) — menu open, autocomplete, selection.
- `apps/brief/src/pages/__tests__/document-editor.test.tsx` (update, G1) — Hocuspocus provider init, cursor overlay render.
- `apps/worker/src/jobs/__tests__/brief-embed.test.ts` (new, G4) — chunk, embed, upsert, mark timestamp.
- `apps/worker/src/jobs/__tests__/brief-cleanup.test.ts` (new, G4) — version and embed cleanup.

## Verification steps

```bash
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/brief-api build
pnpm --filter @bigbluebam/brief-api typecheck
pnpm --filter @bigbluebam/brief-api test
pnpm --filter @bigbluebam/brief typecheck
pnpm --filter @bigbluebam/brief test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-brief-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55495:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55495/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55495/verify' pnpm db:check
docker rm -f bbb-brief-verify
```

**Live smoke tests:** open same document in two browser tabs, verify Yjs sync of edits in real-time; verify remote cursor overlay; trigger `@mention` and select user; insert `/task` slash command; promote a document to Beacon, verify beacon created with markdown body and `source_brief_id` set; run semantic search, verify Qdrant hits; export document as PDF, verify MinIO upload and download link.

## Out of scope

Beacon graph integration (Beacon_Plan.md), folder tree UI, document version branching, Headless Chrome PDF service procurement, real-time Banter channel presence for document mentions.

## Dependencies

- Yjs + Hocuspocus packages (`yjs`, `@hocuspocus/server`, `@hocuspocus/extension-redis`, `@hocuspocus/extension-logger`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-cursor`).
- `@tiptap/html` + `turndown` for yjs-to-markdown rendering.
- Qdrant (existing dev stack) — collection `brief_documents`.
- Embedding API: Anthropic, OpenAI, or self-hosted — configured via `BRIEF_EMBEDDING_PROVIDER` env var.
- Beacon API (internal :4004) for graduation.
- Bam API (internal :4000) for task embed resolution.
- Redis (existing) for Hocuspocus cross-instance pub/sub.
- MinIO (existing) for export staging.

**Migration numbers claimed: 0103, 0104.**
