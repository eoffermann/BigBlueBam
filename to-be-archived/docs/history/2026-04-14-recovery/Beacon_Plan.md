# Beacon Implementation Plan (2026-04-14)

## Scope

Executes the 2026-04-14 Beacon Design Audit, closing 7 critical and high-priority gaps. Beacon is 70-75% complete at `a8fb19a` with three P0 security findings, two P0 schema gaps (missing comments and attachments tables), and five P1-P2 gaps in embeddings, sparse vectors, notifications, graph visibility filtering, and cross-encoder re-ranking. This plan addresses all P0 items and establishes the foundation for P1 work.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | Add `beacon_comments` table and CRUD routes (GET, POST, DELETE) |
| G2 | P0 | audit §Missing P0 item 2 | Add `beacon_attachments` table with MinIO S3 upload routes |
| G3 | P0 | audit §File paths (P0-003) | Verify/add `requireBeaconReadAccess()` middleware to POST /beacons/:id/challenge |
| G4 | P0 | audit §File paths (P0-001) | Verify escapeLike universally applied on ILIKE queries in search.service.ts |
| G5 | P1 | audit §File paths (P1-004) | Add org_id override validation in policy.routes.ts |
| G6 | P1 | audit §Partial search scoring | Document and verify freshness decay formula matches spec bounds |
| G7 | P1 | audit §Missing P1 item 4 | Add visibility filtering to graph endpoints (getNeighbors, getHubs, getRecent) |

## Migrations

### 0079_beacon_comments_table.sql

**Claimed from:** ledger 0079 (Beacon range).

**Body:**
```sql
-- 0079_beacon_comments_table.sql
-- Why: Beacon spec §2.1.7 defines beacon_comments for inline discussion on beacons. Frontend references it in beacon-detail.tsx but the DB table does not exist.
-- Client impact: additive only. New table, no existing rows affected.

CREATE TABLE IF NOT EXISTS beacon_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    beacon_id       UUID NOT NULL REFERENCES beacon_entries(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES beacon_comments(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id),
    body_markdown   TEXT NOT NULL,
    body_html       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beacon_comments_beacon_id ON beacon_comments (beacon_id, created_at);
CREATE INDEX IF NOT EXISTS idx_beacon_comments_parent_id ON beacon_comments (parent_id);
```

**Verification:** scratch-DB apply + `\d beacon_comments`.

**Rollback:** new migration with `DROP TABLE IF EXISTS beacon_comments CASCADE`.

### 0080_beacon_attachments_table.sql

**Claimed from:** ledger 0080 (Beacon range).

**Body:**
```sql
-- 0080_beacon_attachments_table.sql
-- Why: Beacon spec §2.1.6 defines beacon_attachments for rich media. Frontend and Markdown body references require the table.
-- Client impact: additive only. New table, no existing rows affected.

CREATE TABLE IF NOT EXISTS beacon_attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    beacon_id       UUID NOT NULL REFERENCES beacon_entries(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    content_type    VARCHAR(128) NOT NULL,
    size_bytes      BIGINT NOT NULL,
    storage_key     VARCHAR(1024) NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(beacon_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_beacon_attachments_beacon_id ON beacon_attachments (beacon_id);
```

**Verification:** scratch-DB apply + `\d beacon_attachments`.

**Rollback:** new migration with `DROP TABLE IF EXISTS beacon_attachments CASCADE` + MinIO bucket cleanup.

**Unused ledger slots:** 0081, 0082 remain available for follow-up Beacon P1 work if needed.

## Schemas and shared types

- `apps/beacon-api/src/db/schema/beacon-comments.ts` (new) — Drizzle table for beacon_comments matching migration 0079.
- `apps/beacon-api/src/db/schema/beacon-attachments.ts` (new) — Drizzle table for beacon_attachments matching migration 0080.
- `apps/beacon-api/src/db/schema/index.ts` (update) — export both.
- `packages/shared/src/schemas/beacon.ts` (additions) — add `beaconCommentCreateSchema`, `beaconCommentSchema`, `beaconAttachmentUploadSchema`, `beaconAttachmentSchema` Zod schemas.

## API routes and services

**New services:**
- `apps/beacon-api/src/services/comment.service.ts` (new) — `listComments(beaconId, orgId)`, `createComment(...)`, `deleteComment(commentId, userId, orgId)`. Only author can delete own; cascade deletes children via FK.
- `apps/beacon-api/src/services/attachment.service.ts` (new) — `listAttachments`, `uploadAttachment` (generates `beacon-attachments/{org_id}/{beacon_id}/{uuid}/{filename}` storage key, calls minio putObject, returns with signed URL), `deleteAttachment` (DB delete + minio removeObject).

**New routes:**
- `apps/beacon-api/src/routes/comments.routes.ts` (new, G1): GET `/beacons/:id/comments`, POST `/beacons/:id/comments`, DELETE `/beacons/:id/comments/:commentId`. Use `requireAuth + requireBeaconReadAccess + requireScope('read_write')` middleware.
- `apps/beacon-api/src/routes/attachments.routes.ts` (new, G2): GET `/beacons/:id/attachments`, POST `/beacons/:id/attachments` (multipart), DELETE `/beacons/:id/attachments/:attachmentId`. Use `requireBeaconEditAccess` for mutations. 10MB per-file limit, 100 req/min rate limit.
- `apps/beacon-api/src/index.ts` (update) — register both new route files.

**Route fixes:**
- `apps/beacon-api/src/routes/beacon.routes.ts` (G3) — re-read the challenge endpoint; if `requireBeaconReadAccess()` middleware is missing, add it. If already present (audit may have been a false positive), note this in the PR.
- `apps/beacon-api/src/routes/policy.routes.ts` line 57 (G5) — add explicit check: if `data.scope === 'Organization'` and client-supplied `org_id` differs from `request.user!.org_id`, return 403 UNAUTHORIZED.

**Service fixes:**
- `apps/beacon-api/src/services/search.service.ts` (G4) — re-verify `escapeLike()` is applied to all ILIKE queries at lines 437, 553-556. Current audit notes suggest it may already be compliant; record verification in PR.
- `apps/beacon-api/src/services/search.service.ts` (G6) — add the freshness decay formula comment documenting `1.0 - (days / expiry_window) * 0.15` clamped to `[0.85, 1.0]`, matching spec §2.2.6.
- `apps/beacon-api/src/services/graph.service.ts` (G7) — add `userId` parameter to `getNeighbors`, `getHubs`, `getRecent`. Filter results to exclude Private beacons where `owned_by !== userId` and Project beacons where user is not in `project_members`. Apply at query level with LEFT JOIN.

## Frontend pages and components

- `apps/beacon/src/components/CommentsSection.tsx` (new) — threaded comment list + reply form + delete button. Props: `beaconId`, `comments`, `onCommentAdded`, `onCommentDeleted`, `isLoading`, `error`.
- `apps/beacon/src/components/AttachmentsPanel.tsx` (new) — attachment list + drag-and-drop upload zone + preview/download links + delete. Props mirror comments component.
- `apps/beacon/src/pages/beacon-detail.tsx` (update) — integrate CommentsSection and AttachmentsPanel in the two-column layout.

## Worker jobs

No new worker jobs required. Existing `beacon-vector-sync.job.ts` handles embedding sync. Comments and attachments do not need async processing.

## MCP tools

`apps/mcp-server/src/tools/beacon-tools.ts` (additions):
- `beacon_list_comments(beaconId)`, `beacon_create_comment(beaconId, bodyMarkdown, parentId?)`, `beacon_delete_comment(commentId)`
- `beacon_list_attachments(beaconId)`, `beacon_upload_attachment(beaconId, filename, content_base64)`, `beacon_delete_attachment(attachmentId)`

All follow existing patterns: visibility enforcement, author/uploader enrichment, same auth guards as routes.

## Tests

- `apps/beacon-api/src/routes/__tests__/comments.test.ts` (new) — list, create, reply (with parent_id), delete-own, reject-delete-others, access control.
- `apps/beacon-api/src/routes/__tests__/attachments.test.ts` (new) — list, upload (multipart with MinIO mock), storage_key generation, delete + MinIO cleanup, access control.
- `apps/beacon-api/src/services/__tests__/comment.service.test.ts` and `attachment.service.test.ts` (new) — unit tests.
- `apps/beacon-api/src/services/__tests__/search.service.test.ts` (update) — add escapeLike injection test and freshness decay bounds test.
- `apps/beacon-api/src/services/__tests__/graph.service.test.ts` (update) — visibility filter test cases for Private and Project beacons.
- `apps/beacon/src/components/__tests__/CommentsSection.test.tsx` and `AttachmentsPanel.test.tsx` (new) — React component tests.

## Verification steps

```bash
pnpm --filter @bigbluebam/beacon-api build
pnpm --filter @bigbluebam/beacon-api typecheck
pnpm --filter @bigbluebam/beacon-api test
pnpm --filter @bigbluebam/beacon typecheck
pnpm --filter @bigbluebam/beacon test
pnpm lint:migrations
# scratch DB:
docker run --rm -d --name bbb-beacon-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55498:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55498/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55498/verify' pnpm db:check
docker rm -f bbb-beacon-verify
```

## Out of scope

- **Embedding model integration (P1):** Deferred to Platform_Plan § LLM integration. Requires external provider (Anthropic embeddings, OpenAI, Cohere).
- **Sparse embedding (P1):** Deferred to Platform_Plan § vector database tuning.
- **Notification service implementation (P1):** Deferred to Cross_Product_Plan § notification fan-out module. Stub exists at `notification.service.ts`.
- **Cross-encoder re-ranker (P1):** Deferred to Platform_Plan § LLM search.
- **Agent auto-verification, contradiction detection, PostgreSQL-Qdrant reconciliation, Fridge Cleanout UX (P2):** Deferred to future maintenance phases.

## Dependencies

- **No blockers.** Beacon P0 closure has no external dependencies; all changes are internal to beacon-api and beacon frontend.
- Future P1 work depends on Platform_Plan § LLM integration and Banter API for notifications.

**Migration numbers claimed: 0079, 0080. Unused: 0081, 0082 (reserved in-range for follow-up P1 work).**
