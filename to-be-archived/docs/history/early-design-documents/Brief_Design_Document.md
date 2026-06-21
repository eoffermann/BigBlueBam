# Brief — Collaborative Documents for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 7, 2026
**Product:** Brief (Collaborative Documents)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Brief is the collaborative document editor for the BigBlueBam suite. It provides real-time multi-user editing for long-form content — design specs, meeting notes, RFCs, runbooks, post-mortems, and onboarding guides — with deep cross-product linking to Bam tasks, Banter channels, Beacon articles, and Helpdesk tickets.

Brief fills the gap between "thinking" and "curated knowledge." Teams draft and iterate in Brief; when content stabilizes, it graduates to Beacon with one click, inheriting tags and entering the verification governance lifecycle.

### 1.2 Core Principles

1. **Draft-first, publish-second.** Brief is where messy thinking lives. Beacon is where curated knowledge lives. The graduation workflow connects them.
2. **Real-time by default.** All editing is collaborative via CRDT (Yjs). No "lock file" or "check out" semantics.
3. **AI is a co-author.** MCP tools allow agents to create, edit, comment on, summarize, and promote documents — the same operations available to human users.
4. **Cross-product linking is native.** Task references (`BBB-247`), Beacon links, Banter channel mentions, and Helpdesk ticket references all resolve inline with rich previews.
5. **Suite-consistent UX.** Same auth, same org/project scoping, same role model, same dark/light theming as every other B-product.

### 1.3 Non-Goals

- Brief is **not** a wiki. It does not have hierarchical page trees, namespaces, or expiry governance. That's Beacon.
- Brief is **not** a spreadsheet or database. Embedded tables are for display; structured data belongs in Bam custom fields or external tools.
- Brief is **not** a design tool. Embed Figma frames; don't build a canvas editor.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  brief-api/          → Fastify REST API + WebSocket + Yjs collaboration server
  brief/              → React SPA (editor, document list, templates)
```

MCP tools for Brief are registered in the existing `apps/mcp-server/` alongside Bam, Banter, and Beacon tools.

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **brief-api** (Fastify :4005) | REST API, WebSocket for Yjs sync, document lifecycle |
| **PostgreSQL 16** | Document metadata, comments, versions, templates (shared DB) |
| **Redis 7** | PubSub for real-time presence, cache for document tree |
| **MinIO** | File/image storage for embedded media |
| **Qdrant** | Vector embeddings for semantic search across documents |
| **nginx** | `/brief/` → SPA static, `/brief/api/` → Fastify :4005, `/brief/ws` → Yjs WebSocket |

### 2.3 nginx Routing

```nginx
location /brief/ {
    alias /usr/share/nginx/html/brief/;
    try_files $uri $uri/ /brief/index.html;
}

location /brief/api/ {
    proxy_pass http://brief-api:4005/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /brief/ws {
    proxy_pass http://brief-api:4005/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### 2.4 Docker Service

```yaml
brief-api:
  build:
    context: .
    dockerfile: apps/brief-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MINIO_ENDPOINT=minio
    - MINIO_PORT=9000
    - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
    - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    - QDRANT_URL=http://qdrant:6333
    - SESSION_SECRET=${SESSION_SECRET}
  ports:
    - "4005:4005"
  depends_on:
    - postgres
    - redis
    - minio
    - qdrant
```

---

## 3. Data Model

### 3.1 Entity Relationship Overview

```
organizations ──1:N──► brief_folders ──1:N──► brief_documents
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                            brief_versions   brief_comments   brief_embeds
                                                    │
                                                    ▼
                                          brief_comment_reactions
```

Cross-product links:

```
brief_documents ──M:N──► tasks           (via brief_task_links)
brief_documents ──M:N──► beacons         (via brief_beacon_links)
brief_documents ──1:1──► beacons         (via graduation — beacon.source_brief_id)
```

### 3.2 PostgreSQL Schema

All tables live in the shared `bigbluebam` database alongside Bam, Banter, Beacon, and Helpdesk tables. Foreign keys reference the existing `organizations`, `projects`, `users`, and `organization_members` tables.

```sql
-- ============================================================
-- BRIEF: Collaborative Documents
-- ============================================================

-- Folders for organizing documents within a project
CREATE TABLE brief_folders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level folder
    parent_id       UUID REFERENCES brief_folders(id) ON DELETE CASCADE,  -- NULL = root
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(255) NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, project_id, parent_id, slug)
);

CREATE INDEX idx_brief_folders_org ON brief_folders(organization_id);
CREATE INDEX idx_brief_folders_project ON brief_folders(project_id);
CREATE INDEX idx_brief_folders_parent ON brief_folders(parent_id);

-- Documents — the core entity
CREATE TABLE brief_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level doc
    folder_id       UUID REFERENCES brief_folders(id) ON DELETE SET NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Untitled',
    slug            VARCHAR(500) NOT NULL,
    -- Yjs document state is stored as binary (the single source of truth for content)
    yjs_state       BYTEA,
    -- Rendered plain text for full-text search (updated on save/snapshot)
    plain_text      TEXT,
    -- Rendered HTML snapshot (for read-only views, email embeds, exports)
    html_snapshot   TEXT,
    -- Document metadata
    icon            VARCHAR(10),           -- emoji icon
    cover_image_url VARCHAR(2048),
    template_id     UUID REFERENCES brief_templates(id) ON DELETE SET NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
    visibility      VARCHAR(20) NOT NULL DEFAULT 'project'
                    CHECK (visibility IN ('private', 'project', 'organization')),
    pinned          BOOLEAN NOT NULL DEFAULT false,
    word_count      INTEGER NOT NULL DEFAULT 0,
    -- Beacon graduation
    promoted_to_beacon_id UUID REFERENCES beacons(id) ON DELETE SET NULL,
    -- Ownership and timestamps
    created_by      UUID NOT NULL REFERENCES users(id),
    updated_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at     TIMESTAMPTZ,
    UNIQUE (organization_id, project_id, slug)
);

CREATE INDEX idx_brief_docs_org ON brief_documents(organization_id);
CREATE INDEX idx_brief_docs_project ON brief_documents(project_id);
CREATE INDEX idx_brief_docs_folder ON brief_documents(folder_id);
CREATE INDEX idx_brief_docs_status ON brief_documents(status);
CREATE INDEX idx_brief_docs_created_by ON brief_documents(created_by);
CREATE INDEX idx_brief_docs_promoted ON brief_documents(promoted_to_beacon_id);
CREATE INDEX idx_brief_docs_fulltext ON brief_documents USING gin(to_tsvector('english', plain_text));

-- Version history — snapshots taken on explicit save or periodic auto-save
CREATE TABLE brief_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    title           VARCHAR(500) NOT NULL,
    yjs_state       BYTEA NOT NULL,
    html_snapshot   TEXT,
    plain_text      TEXT,
    word_count      INTEGER NOT NULL DEFAULT 0,
    change_summary  VARCHAR(500),           -- optional human/AI-authored summary
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, version_number)
);

CREATE INDEX idx_brief_versions_doc ON brief_versions(document_id);

-- Inline comments anchored to document positions
CREATE TABLE brief_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES brief_comments(id) ON DELETE CASCADE,  -- threaded replies
    author_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    -- Anchor position (Yjs-relative position for CRDT-stable anchoring)
    anchor_start    JSONB,                  -- Yjs relative position
    anchor_end      JSONB,                  -- Yjs relative position
    anchor_text     VARCHAR(500),           -- snapshot of highlighted text at comment creation
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brief_comments_doc ON brief_comments(document_id);
CREATE INDEX idx_brief_comments_author ON brief_comments(author_id);
CREATE INDEX idx_brief_comments_parent ON brief_comments(parent_id);

-- Reactions on comments
CREATE TABLE brief_comment_reactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id      UUID NOT NULL REFERENCES brief_comments(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    emoji           VARCHAR(20) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (comment_id, user_id, emoji)
);

-- Embedded media (images, files attached to documents)
CREATE TABLE brief_embeds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    file_name       VARCHAR(500) NOT NULL,
    file_size       BIGINT NOT NULL,
    mime_type       VARCHAR(255) NOT NULL,
    storage_key     VARCHAR(1024) NOT NULL,  -- MinIO object key
    width           INTEGER,
    height          INTEGER,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brief_embeds_doc ON brief_embeds(document_id);

-- Templates
CREATE TABLE brief_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = system template
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    icon            VARCHAR(10),
    category        VARCHAR(100),           -- e.g., 'engineering', 'meeting', 'rfc', 'postmortem'
    yjs_state       BYTEA NOT NULL,
    html_preview    TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brief_templates_org ON brief_templates(organization_id);

-- Cross-product links: Brief ↔ Bam tasks
CREATE TABLE brief_task_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    link_type       VARCHAR(30) NOT NULL DEFAULT 'reference'
                    CHECK (link_type IN ('reference', 'spec', 'notes', 'postmortem')),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, task_id)
);

-- Cross-product links: Brief ↔ Beacon
CREATE TABLE brief_beacon_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    beacon_id       UUID NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
    link_type       VARCHAR(30) NOT NULL DEFAULT 'reference'
                    CHECK (link_type IN ('reference', 'source', 'related')),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, beacon_id)
);

-- Collaborator access (for private documents and per-document permissions)
CREATE TABLE brief_collaborators (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission      VARCHAR(20) NOT NULL DEFAULT 'edit'
                    CHECK (permission IN ('view', 'comment', 'edit')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, user_id)
);

-- Stars / favorites (user bookmarks for quick access)
CREATE TABLE brief_stars (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES brief_documents(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, user_id)
);
```

### 3.3 Drizzle ORM Schema

Located at `apps/brief-api/src/db/schema.ts`, mirroring the SQL above using Drizzle's `pgTable` definitions with Zod inference for type safety. Follows the same pattern as Bam's `apps/api/src/db/schema.ts`.

### 3.4 Qdrant Collection

```
Collection: brief_documents
  - Vector dimension: 1536 (OpenAI text-embedding-3-small) or 384 (all-MiniLM-L6-v2)
  - Distance: Cosine
  - Payload fields:
      organization_id (keyword, indexed)
      project_id      (keyword, indexed)
      document_id     (keyword, indexed)
      chunk_index     (integer)
      title           (text)
      status          (keyword)
```

Documents are chunked (512-token windows, 64-token overlap) and embedded on save. Used by `brief_search` MCP tool for semantic retrieval and by Beacon graduation to pre-populate tags.

---

## 4. API Design

### 4.1 Fastify Application Structure

```
apps/brief-api/
  src/
    index.ts                → Fastify server bootstrap
    plugins/
      auth.ts               → JWT/session auth (shared with suite)
      websocket.ts          → WebSocket + Yjs provider
      redis.ts              → Redis PubSub client
    routes/
      documents.ts          → CRUD, search, star, archive, promote
      folders.ts            → CRUD, reorder
      versions.ts           → List, get, restore, diff
      comments.ts           → CRUD, resolve, reactions
      embeds.ts             → Upload, list, delete
      templates.ts          → CRUD, instantiate
      links.ts              → Task links, Beacon links
      collaborators.ts      → Add, remove, update permissions
      export.ts             → Markdown, HTML, PDF export
    services/
      yjs-persistence.ts    → Yjs ↔ PostgreSQL persistence layer
      search.ts             → Full-text + Qdrant semantic search
      embedding.ts          → Document chunking and vectorization
      graduation.ts         → Brief → Beacon promotion logic
      snapshot.ts           → HTML/plain-text rendering from Yjs state
    db/
      schema.ts             → Drizzle table definitions
      queries.ts            → Reusable query fragments
    ws/
      collaboration.ts      → Yjs WebSocket provider (awareness, sync)
```

### 4.2 REST Endpoints

All routes are prefixed by nginx at `/brief/api/`. Internal port is `:4005`.

#### Documents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/documents` | List documents (paginated, filterable by project, folder, status, author) |
| `POST` | `/documents` | Create document (optional template_id, folder_id) |
| `GET` | `/documents/:id` | Get document metadata + current Yjs state |
| `PATCH` | `/documents/:id` | Update metadata (title, status, visibility, folder, icon, cover) |
| `DELETE` | `/documents/:id` | Soft-delete (archive) |
| `POST` | `/documents/:id/restore` | Restore from archive |
| `POST` | `/documents/:id/duplicate` | Duplicate document |
| `POST` | `/documents/:id/promote` | Graduate to Beacon (creates Beacon, links, copies content) |
| `GET` | `/documents/:id/export/:format` | Export as `markdown`, `html`, or `pdf` |
| `POST` | `/documents/:id/star` | Toggle star |
| `GET` | `/documents/starred` | List user's starred documents |
| `GET` | `/documents/recent` | List recently viewed/edited documents |
| `GET` | `/documents/search` | Full-text + semantic search |

#### Folders

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List folders (tree structure for project/org) |
| `POST` | `/folders` | Create folder |
| `PATCH` | `/folders/:id` | Update folder (name, parent, sort_order) |
| `DELETE` | `/folders/:id` | Delete folder (moves contents to parent) |

#### Versions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/documents/:id/versions` | List version history |
| `GET` | `/documents/:id/versions/:versionId` | Get specific version |
| `POST` | `/documents/:id/versions` | Create named snapshot |
| `POST` | `/documents/:id/versions/:versionId/restore` | Restore to version |
| `GET` | `/documents/:id/versions/:v1/diff/:v2` | Diff two versions (HTML output) |

#### Comments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/documents/:id/comments` | List comments (threaded) |
| `POST` | `/documents/:id/comments` | Create comment (with anchor position) |
| `PATCH` | `/comments/:id` | Edit comment body |
| `DELETE` | `/comments/:id` | Delete comment |
| `POST` | `/comments/:id/resolve` | Resolve / unresolve |
| `POST` | `/comments/:id/reactions` | Add reaction |
| `DELETE` | `/comments/:id/reactions/:emoji` | Remove reaction |

#### Embeds

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents/:id/embeds` | Upload file/image (multipart) |
| `GET` | `/documents/:id/embeds` | List embeds for document |
| `DELETE` | `/embeds/:id` | Delete embed (removes from MinIO) |

#### Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/templates` | List templates (system + org) |
| `POST` | `/templates` | Create template from current document state |
| `PATCH` | `/templates/:id` | Update template |
| `DELETE` | `/templates/:id` | Delete template |

#### Links

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/documents/:id/links` | List all cross-product links |
| `POST` | `/documents/:id/links/task` | Link to Bam task |
| `POST` | `/documents/:id/links/beacon` | Link to Beacon |
| `DELETE` | `/links/:id` | Remove link |

#### Collaborators

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/documents/:id/collaborators` | List collaborators |
| `POST` | `/documents/:id/collaborators` | Add collaborator |
| `PATCH` | `/collaborators/:id` | Update permission level |
| `DELETE` | `/collaborators/:id` | Remove collaborator |

### 4.3 Zod Validation Schemas

Defined in `packages/shared/src/brief.ts` and exported for use by both the API and frontend:

```typescript
import { z } from 'zod';

export const BriefDocumentStatus = z.enum(['draft', 'in_review', 'approved', 'archived']);
export const BriefVisibility = z.enum(['private', 'project', 'organization']);
export const BriefPermission = z.enum(['view', 'comment', 'edit']);
export const BriefLinkType = z.enum(['reference', 'spec', 'notes', 'postmortem']);
export const BriefBeaconLinkType = z.enum(['reference', 'source', 'related']);
export const BriefExportFormat = z.enum(['markdown', 'html', 'pdf']);

export const CreateDocumentSchema = z.object({
  title: z.string().max(500).optional(),
  project_id: z.string().uuid().optional(),
  folder_id: z.string().uuid().optional(),
  template_id: z.string().uuid().optional(),
  visibility: BriefVisibility.optional(),
  icon: z.string().max(10).optional(),
});

export const UpdateDocumentSchema = z.object({
  title: z.string().max(500).optional(),
  status: BriefDocumentStatus.optional(),
  visibility: BriefVisibility.optional(),
  folder_id: z.string().uuid().nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  cover_image_url: z.string().url().max(2048).nullable().optional(),
  pinned: z.boolean().optional(),
});

export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(10000),
  parent_id: z.string().uuid().optional(),
  anchor_start: z.record(z.unknown()).optional(),
  anchor_end: z.record(z.unknown()).optional(),
  anchor_text: z.string().max(500).optional(),
});

export const SearchDocumentsSchema = z.object({
  query: z.string().min(1).max(500),
  project_id: z.string().uuid().optional(),
  status: BriefDocumentStatus.optional(),
  author_id: z.string().uuid().optional(),
  semantic: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
```

---

## 5. Real-Time Collaboration

### 5.1 Yjs Architecture

Brief uses **Yjs** as the CRDT engine for real-time collaborative editing. The collaboration server runs inside the Fastify process as a WebSocket handler.

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Browser  │    │ Browser  │    │ AI Agent │
│ (Tiptap) │    │ (Tiptap) │    │ (MCP)    │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │ WebSocket      │ WebSocket      │ REST API
     ▼               ▼               ▼
┌────────────────────────────────────────────┐
│           brief-api (:4005)                 │
│  ┌──────────────────────────────────────┐  │
│  │  Yjs WebSocket Provider (Hocuspocus) │  │
│  │  - Awareness (cursors, selections)   │  │
│  │  - Sync protocol                     │  │
│  │  - Persistence to PostgreSQL         │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │  Redis PubSub                        │  │
│  │  - Cross-instance sync (multi-node)  │  │
│  │  - Presence broadcasting             │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

**Hocuspocus** (the Yjs WebSocket backend by Tiptap) manages:
- Document loading from PostgreSQL on first connection
- Incremental Yjs update persistence (debounced, every 5 seconds or on last client disconnect)
- Awareness protocol for cursor positions and user presence
- Authentication hook (validates JWT before allowing connection)

### 5.2 Persistence Strategy

| Event | Action |
|-------|--------|
| First client connects to document | Load `yjs_state` from `brief_documents` |
| Client sends Yjs update | Apply to in-memory Yjs Doc, broadcast to peers |
| Debounce timer (5s) | Persist merged `yjs_state` to `brief_documents.yjs_state` |
| Last client disconnects | Final persist, update `plain_text` + `html_snapshot` + `word_count` |
| Explicit "Save Version" | Snapshot current state into `brief_versions` |
| Auto-version (every 100 edits or 30 min) | Background snapshot into `brief_versions` |

### 5.3 AI Agent Edits via MCP

AI agents cannot hold a WebSocket connection. Instead, the MCP tools `brief_update_content` and `brief_append_content` operate via the REST API:

1. Agent calls `brief_update_content` with document_id and a Yjs update (or plain Markdown/HTML that the server converts to a Yjs update).
2. Server applies the update to the Yjs doc in memory (or loads from DB if no active session).
3. Server broadcasts the update to any connected WebSocket clients.
4. Connected editors see the AI's changes appear in real time.

For simplicity, the MCP `brief_update_content` tool accepts **Markdown** input. The server parses it through the Tiptap schema, generates the corresponding Yjs update, and applies it. This means agents don't need to understand Yjs internals.

### 5.4 Presence

The awareness protocol provides:
- Active user list (name, avatar, color)
- Cursor positions (per-user selection ranges)
- Editing state ("viewing" vs "editing")

Presence data is broadcast via WebSocket awareness and cached in Redis with a 60-second TTL for API queries (`GET /documents/:id/presence`).

---

## 6. Rich Text Editor

### 6.1 Technology: Tiptap (ProseMirror)

The frontend editor is built on **Tiptap v2** (ProseMirror wrapper) with the **Yjs collaboration extension**.

### 6.2 Editor Extensions

| Extension | Purpose |
|-----------|---------|
| `StarterKit` | Paragraphs, headings (1–4), bold, italic, strike, code, blockquote, lists, hard break |
| `Collaboration` | Yjs binding for real-time sync |
| `CollaborationCursor` | Colored cursors with user names |
| `Placeholder` | "Start typing or paste content..." |
| `Image` | Inline images (uploaded to MinIO via embed API) |
| `Link` | Hyperlinks with paste-detection |
| `Table` | Tables with column resize and row/column add/delete |
| `TaskList` / `TaskItem` | Checkbox task lists |
| `CodeBlockLowlight` | Fenced code blocks with syntax highlighting (lowlight) |
| `Highlight` | Background color highlighting |
| `Typography` | Smart quotes, em-dashes |
| `Mention` | @user mentions with autocomplete (queries org members) |
| `BamTaskEmbed` | Custom node: `BBB-123` renders as a live task card (title, status, assignee) |
| `BeaconEmbed` | Custom node: Beacon reference renders with title and status badge |
| `BanterChannelLink` | Custom node: `#channel-name` renders as a link to Banter |
| `CalloutBlock` | Info, warning, success, error callout blocks |
| `Divider` | Horizontal rule with styled variants |
| `TableOfContents` | Auto-generated TOC from headings |
| `SlashCommand` | `/` command menu for quick block insertion |

### 6.3 Slash Command Menu

Typing `/` opens a filterable command palette:

| Command | Inserts |
|---------|---------|
| `/h1`, `/h2`, `/h3` | Heading |
| `/bullet`, `/numbered` | Lists |
| `/todo` | Task list |
| `/code` | Code block |
| `/table` | Table (3×3 default) |
| `/image` | Image upload dialog |
| `/callout` | Callout block |
| `/divider` | Horizontal rule |
| `/task` | Bam task embed (search picker) |
| `/beacon` | Beacon embed (search picker) |
| `/toc` | Table of contents |
| `/template` | Insert from template library |

---

## 7. Cross-Product Integration

### 7.1 Brief → Beacon Graduation

The graduation workflow is Brief's most important integration:

1. User clicks "Promote to Beacon" on a document (or agent calls `brief_promote_to_beacon`).
2. Server renders the current Yjs state to Markdown.
3. Server calls the Beacon API internally to create a new Beacon:
   - Title inherited from Brief document title
   - Body populated from rendered Markdown
   - Tags auto-suggested from Qdrant semantic similarity to existing Beacons
   - Status set to `draft` (requires explicit publish via Beacon workflow)
   - `source_brief_id` linked back to the originating document
4. `brief_documents.promoted_to_beacon_id` is set on the Brief document.
5. Brief UI shows a banner: "This document has been promoted to Beacon — [View in Beacon]"
6. Subsequent edits to the Brief do NOT auto-sync to the Beacon. The graduation is a one-time snapshot. If the user wants to re-promote, they create a new Beacon version.

### 7.2 Brief ↔ Bam

- **Task embed in documents:** The `BamTaskEmbed` node renders a live mini-card (fetched via internal API) showing task title, status, priority, and assignee. Clicking opens the task in Bam.
- **Document link on tasks:** When a Brief is linked to a task via `brief_task_links`, the task detail drawer in Bam shows a "Linked Documents" section with Brief title, status, and a direct link.
- **Meeting notes → action items:** A template "Meeting Notes" includes a task-list section. Checking an item and selecting "Create Task in Bam" generates a Bam task with the item text as the title and a backlink to the document.

### 7.3 Brief ↔ Banter

- **Share to channel:** From the Brief UI, "Share to Banter" posts a rich preview (title, author, excerpt, link) to a selected channel.
- **Channel link resolution:** Typing `#channel-name` in the editor auto-resolves to a clickable Banter link.
- **Comment → thread bridge:** Optionally, Brief comments can cross-post to a linked Banter thread (configurable per document).

### 7.4 Brief ↔ Helpdesk

- **Helpdesk response templates:** Brief documents tagged as `helpdesk-template` appear in the Helpdesk agent reply template picker.
- **Ticket-linked docs:** Link a Brief document to a helpdesk ticket for internal investigation notes that are invisible to the client.

---

## 8. MCP Tools

### 8.1 Tool Catalog (18 tools)

All tools are registered in `apps/mcp-server/src/tools/brief/` following the existing pattern.

| Tool | Description |
|------|-------------|
| `brief_list` | List documents (filterable by project, folder, status, author, starred). Paginated. |
| `brief_get` | Get document metadata + rendered content (Markdown or HTML). |
| `brief_create` | Create a new document. Accepts optional title, project_id, folder_id, template_id, and initial Markdown content. |
| `brief_update` | Update document metadata (title, status, visibility, folder, icon). |
| `brief_update_content` | Replace or merge document content. Accepts Markdown input. Server converts to Yjs update and broadcasts to connected editors. |
| `brief_append_content` | Append Markdown content to the end of a document. |
| `brief_archive` | Archive a document (soft delete). |
| `brief_restore` | Restore an archived document. |
| `brief_duplicate` | Duplicate a document into the same or different project. |
| `brief_search` | Full-text + semantic search across documents. Returns ranked results with excerpts. |
| `brief_comment_list` | List comments on a document (threaded). |
| `brief_comment_add` | Add a comment. Supports optional anchor text for inline comments. |
| `brief_comment_resolve` | Resolve or unresolve a comment thread. |
| `brief_versions` | List version history for a document. |
| `brief_version_get` | Get a specific version's content (Markdown or HTML). |
| `brief_version_restore` | Restore a document to a previous version. |
| `brief_promote_to_beacon` | Graduate the document to a Beacon. Returns the new Beacon ID. |
| `brief_link_task` | Link a document to a Bam task (with link_type). |

### 8.2 Tool Registration Pattern

Each tool follows the existing MCP server registration pattern:

```typescript
server.tool(
  'brief_create',
  'Create a new Brief document. Optionally provide initial Markdown content, a template, and a target project/folder.',
  {
    title: z.string().max(500).optional().describe('Document title'),
    project_id: z.string().uuid().optional().describe('Project to create in'),
    folder_id: z.string().uuid().optional().describe('Folder to create in'),
    template_id: z.string().uuid().optional().describe('Template to initialize from'),
    content: z.string().optional().describe('Initial Markdown content'),
    visibility: BriefVisibility.optional().describe('Visibility scope'),
  },
  async (params, context) => {
    // Implementation calls brief-api internally
  }
);
```

---

## 9. Frontend Architecture

### 9.1 React SPA Structure

```
apps/brief/
  src/
    main.tsx
    App.tsx
    pages/
      DocumentListPage.tsx        → Project document browser with folder tree
      DocumentEditorPage.tsx      → Full-screen Tiptap editor with sidebar
      TemplateBrowserPage.tsx     → Template gallery
      SearchResultsPage.tsx       → Search results with excerpts
      RecentPage.tsx              → Recently viewed/edited documents
      StarredPage.tsx             → Starred documents
    components/
      editor/
        BriefEditor.tsx           → Tiptap editor wrapper with toolbar
        EditorToolbar.tsx         → Formatting toolbar (bold, italic, headings, etc.)
        SlashCommandMenu.tsx      → `/` command palette
        BubbleMenu.tsx            → Floating toolbar on text selection
        CollaboratorCursors.tsx   → Remote cursor overlays
        TaskEmbed.tsx             → Bam task inline embed
        BeaconEmbed.tsx           → Beacon inline embed
      sidebar/
        DocumentSidebar.tsx       → Right panel: metadata, comments, versions, links
        CommentThread.tsx         → Comment with replies and reactions
        VersionHistory.tsx        → Version list with restore and diff
        LinkedItems.tsx           → Task and Beacon links
        TableOfContents.tsx       → Auto-generated outline navigation
      list/
        DocumentCard.tsx          → Document tile (title, author, updated, status)
        FolderTree.tsx            → Nested folder navigation
        DocumentTable.tsx         → List/table view of documents
      common/
        PromoteToBeaconDialog.tsx → Graduation confirmation with tag suggestions
        ShareToBanterDialog.tsx   → Channel picker for sharing
        ExportMenu.tsx            → Markdown / HTML / PDF export
        TemplateCard.tsx          → Template preview tile
        PresenceBar.tsx           → Active collaborators with avatars
    hooks/
      useDocument.ts              → TanStack Query hook for document CRUD
      useCollaboration.ts         → Yjs provider + awareness
      useSearch.ts                → Search with debounced query
      usePresence.ts              → Active user list for document
    stores/
      editorStore.ts              → Zustand store for editor UI state
      folderStore.ts              → Zustand store for folder tree expansion state
```

### 9.2 Key UI Patterns

- **Document list:** Grid of cards (default) or sortable table, with a left-side folder tree. Filter by status, author, date. Project-scoped or org-scoped.
- **Editor page:** Full-width Tiptap editor with a collapsible right sidebar (comments, versions, links, TOC). Top bar shows title (editable inline), breadcrumb (folder path), status badge, collaborator avatars, and action buttons (Share, Export, Promote).
- **Presence bar:** Row of avatar circles at the top-right of the editor, colored to match cursor colors. Hover shows name and "editing" / "viewing" state.
- **Inline comments:** Click the comment icon on a text selection to create an anchored comment. Comments appear as yellow highlights; clicking reveals the thread in the sidebar.
- **Dark/light mode:** Follows system preference with manual toggle, consistent with all other B-products (TailwindCSS v4 dark mode).

---

## 10. Background Jobs (BullMQ)

Added to the existing `apps/worker/` service:

| Queue | Job | Description |
|-------|-----|-------------|
| `brief:embed` | `generateEmbeddings` | Chunk document, compute vectors, upsert to Qdrant. Triggered on Yjs persist after last client disconnects. |
| `brief:snapshot` | `autoSnapshot` | Periodic version snapshot (every 30 minutes of active editing or 100+ Yjs updates). |
| `brief:export` | `exportPdf` | Render HTML snapshot to PDF via Puppeteer. Returns MinIO URL. |
| `brief:cleanup` | `purgeOldVersions` | Retain last 50 named versions + all auto-snapshots for 90 days. Runs nightly. |

---

## 11. Authorization Model

Brief inherits the BigBlueBam role hierarchy:

| Role | Permissions |
|------|------------|
| **SuperUser** | All operations across all orgs |
| **Owner** | All operations within org |
| **Admin** | Create/edit/delete all documents, manage templates, manage folders |
| **Member** | Create documents, edit own documents and documents where added as collaborator, comment on accessible documents |
| **Viewer** | Read-only access to project/org-visible documents |

Document-level permissions (via `brief_collaborators`) override project-level access:
- A `private` document is visible only to the creator and explicit collaborators.
- A `project` document is visible to all project members.
- An `organization` document is visible to all org members.

---

## 12. System Templates (Shipped by Default)

| Template | Category | Description |
|----------|----------|-------------|
| **Meeting Notes** | meeting | Date, attendees, agenda, discussion, action items (task list) |
| **RFC** | engineering | Title, status, author, summary, motivation, detailed design, drawbacks, alternatives, unresolved questions |
| **Post-Mortem** | engineering | Incident summary, timeline, root cause, impact, action items, lessons learned |
| **Sprint Retrospective** | engineering | What went well, what didn't, action items |
| **Design Spec** | engineering | Overview, goals, non-goals, detailed design, data model, API design, open questions |
| **Onboarding Guide** | hr | Welcome, team overview, tools setup, first week checklist |
| **Decision Log** | general | Decision, date, context, options considered, rationale, outcome |
| **Blank** | general | Empty document |

---

## 13. Search

### 13.1 Multi-Strategy Search

Brief search combines three strategies, consistent with the Beacon retrieval pattern:

1. **PostgreSQL full-text search** on `brief_documents.plain_text` using `to_tsvector('english', ...)` — fast, keyword-based, handles exact matches.
2. **Qdrant semantic search** on document chunk embeddings — finds conceptually related content even when keywords differ.
3. **Metadata filters** — status, project, author, date range, folder.

Results are merged using reciprocal rank fusion (RRF) and returned with highlighted excerpts.

### 13.2 Search API

```
GET /brief/api/documents/search?query=deployment+pipeline&project_id=...&semantic=true&limit=20
```

Response includes `score`, `excerpt` (with `<mark>` highlights), and document metadata.

---

## 14. Export

| Format | Method | Notes |
|--------|--------|-------|
| **Markdown** | Server-side Yjs → ProseMirror → Markdown conversion | Synchronous, returned directly |
| **HTML** | Server-side Yjs → ProseMirror → HTML rendering | Synchronous, returned directly |
| **PDF** | BullMQ job: render HTML → Puppeteer → PDF → MinIO | Async; returns a download URL when complete |

---

## 15. Metrics & Observability

| Metric | Source | Purpose |
|--------|--------|---------|
| Active collaborators per document | WebSocket awareness | Real-time presence display |
| Document save latency (p50, p99) | Yjs persistence layer | Performance monitoring |
| Search query latency | Search service | Qdrant + PG performance |
| Documents created / day | API middleware | Usage tracking |
| Beacon graduation rate | Graduation service | Cross-product conversion |
| Embedding pipeline lag | BullMQ job metrics | Freshness of semantic search |
