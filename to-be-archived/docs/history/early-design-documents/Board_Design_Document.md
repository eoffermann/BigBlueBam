# Board — Visual Collaboration for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 7, 2026
**Product:** Board (Whiteboards & Visual Collaboration)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Board is the infinite-canvas visual collaboration tool for the BigBlueBam suite. It provides freeform drawing, sticky notes, shapes, connectors, embedded images, frames, and live embeds — designed for brainstorming, architecture diagramming, retrospectives, and design thinking workshops.

Board's core differentiator is the **sticky-to-task pipeline**: elements on the canvas can be promoted to Bam tasks with one action, and AI agents can read, summarize, and extract structure from boards via MCP.

### 1.2 Core Principles

1. **Canvas-first, structure-second.** Board is for spatial thinking. Structure emerges from the canvas — it isn't imposed on it. Sticky notes become tasks when the team is ready, not before.
2. **Real-time collaboration.** Multi-user editing via CRDT (Yjs), with cursor tracking, user avatars, and live element updates.
3. **AI can see the board.** MCP tools allow agents to read canvas contents, identify clusters, extract themes, and propose task breakdowns — enabling a "brainstorm → backlog" workflow driven by AI.
4. **Cross-product embeds.** Embed live Bam task cards, Beacon articles, Bearing goal progress, and Brief documents directly on the canvas.
5. **Templates for ceremonies.** Built-in retrospective formats, brainstorming templates, and architecture diagram starters reduce setup friction.

### 1.3 Non-Goals

- Board is **not** a design tool. It does not support vector editing, bezier curves, boolean operations, or design tokens. Use Figma for that.
- Board is **not** a diagramming tool with schema enforcement. It does not validate UML, ERD, or BPMN semantics. Connectors are visual, not semantic.
- Board is **not** a presentation tool. Use Brief or exported images for presentations.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  board-api/          → Fastify REST API + WebSocket (Yjs collaboration server for canvas)
  board/              → React SPA (canvas renderer, toolbar, template browser)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **board-api** (Fastify :4008) | REST API, WebSocket for Yjs canvas sync |
| **PostgreSQL 16** | Board metadata, element snapshots for search/MCP, templates (shared DB) |
| **Redis 7** | PubSub for real-time presence, cache for board thumbnails |
| **MinIO** | Image storage for embedded media and exported board images |

### 2.3 nginx Routing

```nginx
location /board/ {
    alias /usr/share/nginx/html/board/;
    try_files $uri $uri/ /board/index.html;
}

location /board/api/ {
    proxy_pass http://board-api:4008/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /board/ws {
    proxy_pass http://board-api:4008/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### 2.4 Docker Service

```yaml
board-api:
  build:
    context: .
    dockerfile: apps/board-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MINIO_ENDPOINT=minio
    - MINIO_PORT=9000
    - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
    - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    - SESSION_SECRET=${SESSION_SECRET}
  ports:
    - "4008:4008"
  depends_on:
    - postgres
    - redis
    - minio
```

---

## 3. Canvas Architecture

### 3.1 Rendering Engine: tldraw

Board is built on **tldraw** — an open-source infinite-canvas library (MIT license) that provides:
- Shape primitives (rectangles, ellipses, arrows, lines, text, sticky notes, frames, freehand draw)
- Selection, multi-select, grouping, alignment, distribution
- Pan, zoom, minimap
- Undo/redo stack
- Export to SVG/PNG
- Extensible shape system (for custom BigBlueBam embeds)

tldraw uses Yjs internally for its CRDT-based collaboration, which aligns with the Brief collaboration architecture.

### 3.2 CRDT Collaboration

```
┌─────────┐    ┌─────────┐    ┌──────────┐
│ Browser  │    │ Browser  │    │ AI Agent  │
│ (tldraw) │    │ (tldraw) │    │ (MCP)     │
└────┬─────┘    └────┬─────┘    └────┬──────┘
     │ WebSocket      │ WebSocket      │ REST API
     ▼               ▼               ▼
┌────────────────────────────────────────────────┐
│              board-api (:4008)                   │
│  ┌──────────────────────────────────────────┐  │
│  │  Yjs WebSocket Provider (Hocuspocus)     │  │
│  │  - Canvas state sync                     │  │
│  │  - Awareness (cursors, viewport)         │  │
│  │  - Persistence to PostgreSQL             │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  Element Snapshot Service                │  │
│  │  - Extracts element text on save         │  │
│  │  - Persists to board_elements for search │  │
│  │  - Enables MCP read access               │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

**Persistence:** Same pattern as Brief — Yjs state binary persisted to PostgreSQL, debounced on edit, forced on last client disconnect.

### 3.3 Element Snapshot Layer

The canvas CRDT state (Yjs binary) is the source of truth. However, for search and MCP access, the server maintains a **denormalized snapshot** of elements in `board_elements`. This is a read-optimized projection, updated on each Yjs persist:

1. On persist, the server deserializes the Yjs document.
2. It extracts all shapes with text content (sticky notes, text boxes, frames).
3. It upserts these into `board_elements` with position, dimensions, text, and type.
4. MCP tools read from `board_elements`. AI agents never touch the Yjs binary directly.

---

## 4. Data Model

### 4.1 Entity Relationship Overview

```
organizations ──1:N──► boards ──1:N──► board_elements
                          │
                          ├──1:N──► board_versions
                          │
                          └──M:N──► tasks (via board_task_links)
```

### 4.2 PostgreSQL Schema

```sql
-- ============================================================
-- BOARD: Visual Collaboration / Whiteboards
-- ============================================================

-- Board definitions
CREATE TABLE boards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level board
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    icon            VARCHAR(10),
    -- Canvas state (Yjs binary — single source of truth)
    yjs_state       BYTEA,
    -- Thumbnail (auto-generated PNG snapshot, stored in MinIO)
    thumbnail_url   VARCHAR(2048),
    -- Board settings
    template_id     UUID REFERENCES board_templates(id) ON DELETE SET NULL,
    background      VARCHAR(20) NOT NULL DEFAULT 'dots'
                    CHECK (background IN ('dots', 'grid', 'lines', 'plain')),
    locked          BOOLEAN NOT NULL DEFAULT false,  -- prevent edits (presentation mode)
    visibility      VARCHAR(20) NOT NULL DEFAULT 'project'
                    CHECK (visibility IN ('private', 'project', 'organization')),
    -- Viewport defaults (initial pan/zoom on load)
    default_viewport JSONB,       -- { x, y, zoom }
    -- Metadata
    created_by      UUID NOT NULL REFERENCES users(id),
    updated_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at     TIMESTAMPTZ
);

CREATE INDEX idx_boards_org ON boards(organization_id);
CREATE INDEX idx_boards_project ON boards(project_id);
CREATE INDEX idx_boards_created_by ON boards(created_by);

-- Denormalized element snapshot (read-optimized projection of canvas elements)
-- Updated on each Yjs persist; used by search and MCP tools
CREATE TABLE board_elements (
    id              UUID PRIMARY KEY,            -- matches tldraw shape ID
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    -- Element type and content
    element_type    VARCHAR(30) NOT NULL,         -- 'sticky', 'text', 'shape', 'frame', 'arrow', 'draw', 'image', 'embed'
    text_content    TEXT,                         -- extracted text (for sticky notes, text boxes, frames)
    -- Position and dimensions (canvas coordinates)
    x               DOUBLE PRECISION NOT NULL DEFAULT 0,
    y               DOUBLE PRECISION NOT NULL DEFAULT 0,
    width           DOUBLE PRECISION,
    height          DOUBLE PRECISION,
    rotation        DOUBLE PRECISION DEFAULT 0,
    -- Visual properties
    color           VARCHAR(20),                 -- fill color name or hex
    font_size       VARCHAR(10),                 -- 's', 'm', 'l', 'xl'
    -- Grouping
    frame_id        UUID,                        -- parent frame ID (if inside a frame)
    group_id        UUID,                        -- group ID (if part of a selection group)
    -- Connector metadata (for arrows)
    arrow_start     JSONB,                       -- { shape_id, anchor }
    arrow_end       JSONB,                       -- { shape_id, anchor }
    arrow_label     TEXT,
    -- Embed metadata (for task/beacon/goal embeds)
    embed_type      VARCHAR(20),                 -- 'bam_task', 'beacon', 'bearing_goal', 'brief', 'url'
    embed_ref_id    UUID,                        -- referenced entity ID
    embed_url       VARCHAR(2048),               -- for URL embeds
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_board_el_board ON board_elements(board_id);
CREATE INDEX idx_board_el_type ON board_elements(element_type);
CREATE INDEX idx_board_el_frame ON board_elements(frame_id);
CREATE INDEX idx_board_el_fulltext ON board_elements USING gin(to_tsvector('english', text_content));

-- Version history (named snapshots of the full canvas)
CREATE TABLE board_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    name            VARCHAR(255),
    yjs_state       BYTEA NOT NULL,
    thumbnail_url   VARCHAR(2048),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (board_id, version_number)
);

CREATE INDEX idx_board_ver_board ON board_versions(board_id);

-- Task links (board elements promoted to Bam tasks)
CREATE TABLE board_task_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    element_id      UUID NOT NULL,               -- references board_elements.id
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (element_id, task_id)
);

CREATE INDEX idx_board_tl_board ON board_task_links(board_id);
CREATE INDEX idx_board_tl_task ON board_task_links(task_id);

-- Board collaborators (for private boards)
CREATE TABLE board_collaborators (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission      VARCHAR(20) NOT NULL DEFAULT 'edit'
                    CHECK (permission IN ('view', 'edit')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (board_id, user_id)
);

-- Templates (pre-built board layouts)
CREATE TABLE board_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = system template
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    category        VARCHAR(100),                -- 'retro', 'brainstorm', 'architecture', 'planning', 'general'
    icon            VARCHAR(10),
    yjs_state       BYTEA NOT NULL,
    thumbnail_url   VARCHAR(2048),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_board_tpl_org ON board_templates(organization_id);

-- Stars / favorites
CREATE TABLE board_stars (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (board_id, user_id)
);
```

---

## 5. API Design

### 5.1 Fastify Application Structure

```
apps/board-api/
  src/
    index.ts
    plugins/
      auth.ts
      websocket.ts            → WebSocket + Yjs (Hocuspocus)
      redis.ts
    routes/
      boards.ts               → CRUD, search, star, archive, lock, export
      elements.ts             → Read-only element queries (for MCP and search)
      versions.ts             → List, get, restore
      links.ts                → Task link management
      templates.ts            → CRUD, instantiate
      collaborators.ts        → Add, remove, update
    services/
      yjs-persistence.ts      → Yjs ↔ PostgreSQL persistence
      element-snapshot.ts     → Yjs → board_elements denormalization
      thumbnail.ts            → Canvas → PNG thumbnail generation (Puppeteer or SVG rasterization)
      task-promotion.ts       → Element → Bam task creation
      canvas-reader.ts        → Structured extraction of canvas contents for MCP
    ws/
      collaboration.ts        → Yjs WebSocket provider
    db/
      schema.ts
      queries.ts
```

### 5.2 REST Endpoints

#### Boards

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards` | List boards (filterable by project, created_by, archived) |
| `POST` | `/boards` | Create board (optional template_id) |
| `GET` | `/boards/:id` | Get board metadata (without Yjs state — that's via WebSocket) |
| `PATCH` | `/boards/:id` | Update metadata (name, description, background, visibility, locked) |
| `DELETE` | `/boards/:id` | Archive board |
| `POST` | `/boards/:id/restore` | Restore archived board |
| `POST` | `/boards/:id/duplicate` | Duplicate board |
| `POST` | `/boards/:id/star` | Toggle star |
| `GET` | `/boards/:id/export/:format` | Export as `svg`, `png`, or `pdf` |
| `POST` | `/boards/:id/lock` | Toggle lock (prevent edits) |
| `GET` | `/boards/recent` | Recently accessed boards |
| `GET` | `/boards/starred` | Starred boards |
| `GET` | `/boards/search` | Full-text search across board element text |

#### Elements (Read-Only — MCP and Search Interface)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards/:id/elements` | List all elements with text content, positions, and types |
| `GET` | `/boards/:id/elements/stickies` | List only sticky note elements with text |
| `GET` | `/boards/:id/elements/frames` | List frames with contained elements |
| `GET` | `/boards/:id/elements/clusters` | AI-computed spatial clusters of elements (grouped by proximity) |

#### Versions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards/:id/versions` | List version history |
| `POST` | `/boards/:id/versions` | Create named snapshot |
| `POST` | `/boards/:id/versions/:versionId/restore` | Restore to version |

#### Links

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/boards/:id/elements/promote` | Promote selected elements to Bam tasks (batch) |
| `GET` | `/boards/:id/links` | List element → task links |
| `DELETE` | `/links/:id` | Remove link |

#### Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/templates` | List templates (system + org) |
| `POST` | `/templates` | Create template from current board |
| `PATCH` | `/templates/:id` | Update template |
| `DELETE` | `/templates/:id` | Delete template |

#### Collaborators

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boards/:id/collaborators` | List collaborators |
| `POST` | `/boards/:id/collaborators` | Add collaborator |
| `PATCH` | `/collaborators/:id` | Update permission |
| `DELETE` | `/collaborators/:id` | Remove collaborator |

### 5.3 Zod Schemas

```typescript
import { z } from 'zod';

export const BoardBackground = z.enum(['dots', 'grid', 'lines', 'plain']);
export const BoardVisibility = z.enum(['private', 'project', 'organization']);
export const BoardPermission = z.enum(['view', 'edit']);
export const BoardExportFormat = z.enum(['svg', 'png', 'pdf']);

export const CreateBoardSchema = z.object({
  name: z.string().max(255),
  description: z.string().max(2000).optional(),
  project_id: z.string().uuid().optional(),
  template_id: z.string().uuid().optional(),
  background: BoardBackground.default('dots'),
  visibility: BoardVisibility.default('project'),
  icon: z.string().max(10).optional(),
});

export const UpdateBoardSchema = z.object({
  name: z.string().max(255).optional(),
  description: z.string().max(2000).optional(),
  background: BoardBackground.optional(),
  visibility: BoardVisibility.optional(),
  locked: z.boolean().optional(),
  icon: z.string().max(10).optional(),
  default_viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.1).max(10),
  }).optional(),
});

export const PromoteElementsSchema = z.object({
  element_ids: z.array(z.string().uuid()).min(1).max(100),
  project_id: z.string().uuid(),
  epic_id: z.string().uuid().optional(),
  phase_id: z.string().uuid().optional(),
});
```

---

## 6. MCP Tools

### 6.1 Tool Catalog (14 tools)

| Tool | Description |
|------|-------------|
| `board_list` | List boards (filterable by project). |
| `board_get` | Get board metadata (name, description, element count, last updated). |
| `board_create` | Create a new board (optional template). |
| `board_update` | Update board metadata (name, description, background, locked). |
| `board_archive` | Archive a board. |
| `board_read_elements` | Get all elements with text, type, position, and frame grouping. Returns structured data suitable for AI analysis. |
| `board_read_stickies` | Get only sticky notes with text. Optimized for brainstorm → backlog workflows. |
| `board_read_frames` | Get frames with their contained elements. Useful for section-based analysis. |
| `board_add_sticky` | Add a sticky note to the board at a specified position with text and color. |
| `board_add_text` | Add a text element to the board. |
| `board_promote_to_tasks` | Promote one or more sticky notes to Bam tasks. Accepts element IDs, creates tasks, returns task IDs. |
| `board_summarize` | AI-powered: returns a structured summary of the board contents grouped by frames/spatial clusters. |
| `board_search` | Full-text search across all board element text in the org. |
| `board_export` | Export board as SVG or PNG. Returns a MinIO download URL. |

### 6.2 AI Canvas Interaction

The `board_read_elements` tool returns a structured representation of the canvas:

```json
{
  "board_id": "...",
  "board_name": "Sprint 12 Retro",
  "element_count": 47,
  "frames": [
    {
      "id": "frame-1",
      "name": "What Went Well",
      "elements": [
        { "id": "sticky-1", "type": "sticky", "text": "Deployment pipeline is fast now", "color": "green" },
        { "id": "sticky-2", "type": "sticky", "text": "Team communication improved", "color": "green" }
      ]
    },
    {
      "id": "frame-2",
      "name": "What Didn't Go Well",
      "elements": [
        { "id": "sticky-3", "type": "sticky", "text": "Too many meetings", "color": "red" },
        { "id": "sticky-4", "type": "sticky", "text": "Flaky tests blocking deploys", "color": "red" }
      ]
    }
  ],
  "ungrouped_elements": [
    { "id": "text-1", "type": "text", "text": "Action Items", "x": 1200, "y": 100 }
  ]
}
```

This structured output allows an agent to:
1. Read the board contents
2. Identify themes and patterns
3. Propose a task breakdown: "Based on the retro, I suggest creating tasks for: (1) Reduce meeting load — review recurring meetings, (2) Fix flaky test suite — dedicate a spike"
4. Promote sticky notes to tasks via `board_promote_to_tasks`

---

## 7. Frontend Architecture

### 7.1 React SPA Structure

```
apps/board/
  src/
    main.tsx
    App.tsx
    pages/
      BoardListPage.tsx            → Grid of board thumbnails
      BoardCanvasPage.tsx          → Full-screen tldraw canvas
      TemplateBrowserPage.tsx      → Template gallery
    components/
      canvas/
        BoardCanvas.tsx            → tldraw wrapper with Yjs provider
        CustomShapes.tsx           → BigBlueBam-specific shape definitions
        TaskEmbedShape.tsx         → Bam task card rendered on canvas
        BeaconEmbedShape.tsx       → Beacon article card on canvas
        GoalEmbedShape.tsx         → Bearing goal progress bar on canvas
        BriefEmbedShape.tsx        → Brief document link card on canvas
      toolbar/
        BoardToolbar.tsx           → Top bar: name, share, export, lock, version
        ShapeMenu.tsx              → Shape insertion menu
        EmbedPicker.tsx            → Cross-product embed search (tasks, beacons, goals, briefs)
        TemplateOverlay.tsx        → Template picker on new board
      sidebar/
        BoardSidebar.tsx           → Right panel: collaborators, versions, linked tasks
        PromoteToTasksDialog.tsx   → Multi-select sticky → task creation dialog
        VersionHistory.tsx         → Named snapshots with thumbnails
      list/
        BoardCard.tsx              → Thumbnail, name, last updated, collaborator avatars
        BoardGrid.tsx              → Responsive grid of BoardCards
      common/
        PresenceBar.tsx            → Active collaborators with colored cursors
        ExportMenu.tsx             → SVG / PNG / PDF
    hooks/
      useBoard.ts
      useCanvasCollaboration.ts    → tldraw Yjs provider
      useElements.ts
    stores/
      canvasStore.ts               → Zustand store for canvas UI state
```

### 7.2 Custom Shape: BigBlueBam Embeds

Board extends tldraw's shape system with custom shapes for cross-product embeds:

| Shape | Renders | Data Source |
|-------|---------|-------------|
| `BamTaskEmbed` | Task card (title, status, priority, assignee) | Fetched from Bam API on render |
| `BeaconEmbed` | Beacon card (title, status, verification badge) | Fetched from Beacon API |
| `BearingGoalEmbed` | Goal progress bar with status | Fetched from Bearing API |
| `BriefEmbed` | Document link with title and author | Fetched from Brief API |

Embeds are rendered as custom tldraw shapes with a fixed size (300×80px default). They display cached data with a 60-second refresh interval. Clicking opens the referenced entity in its native app.

### 7.3 Key UI Patterns

- **Board list:** Grid of thumbnail cards showing board name, last updated, collaborator avatars, and project badge. Search and filter by project.
- **Canvas page:** Full-screen tldraw canvas. Top toolbar: board name (editable), share button, export, lock toggle, version history. Floating bottom toolbar: shape tools, sticky note, text, draw, arrow, frame, embed picker.
- **Sticky-to-task flow:** User multi-selects sticky notes → clicks "Create Tasks" in toolbar → dialog shows selected stickies as task titles → user picks project, epic, phase → tasks are created in Bam with backlinks to the board.
- **Retro template:** Board loads with three pre-positioned frames ("What Went Well" / "What Didn't" / "Action Items"), each color-coded, with a timer widget for timeboxing.

---

## 8. Cross-Product Integration

### 8.1 Board → Bam (Sticky-to-Task Pipeline)

The defining integration:

1. User selects sticky notes on the canvas.
2. Clicks "Create Tasks" (or agent calls `board_promote_to_tasks`).
3. Server creates one Bam task per sticky note:
   - Task title = sticky note text
   - Task description includes "Created from Board: [board name]" with a backlink
   - Optionally grouped under a specified epic
   - Placed in specified phase (default: first phase)
4. `board_task_links` records the element → task mapping.
5. On the canvas, promoted stickies get a small task icon badge showing the task key (e.g., `BBB-301`).
6. Clicking the badge opens the task in Bam.

### 8.2 Board → Banter

- **Share snapshot to channel:** Export the board as a PNG and post to a Banter channel with a link to the live board.
- **Retro results posting:** After a retrospective, a "Post Summary" action generates a Markdown summary of each frame's contents and posts to a configured channel.

### 8.3 Board → Brief

- **Embed in documents:** Brief documents can embed a static snapshot of a Board (PNG) with a "Open in Board" link. The snapshot updates on each Board save.
- **Architecture diagram workflow:** Create a system architecture diagram in Board, embed it in a Brief design spec, link both to the relevant Bam epic.

### 8.4 Board → Bolt

Board publishes events to the Bolt event bus:

| Event | Payload | Description |
|-------|---------|-------------|
| `board.created` | `{ board }` | New board created |
| `board.elements_promoted` | `{ board, element_count, task_ids }` | Sticky notes promoted to tasks |
| `board.locked` | `{ board }` | Board locked for presentation |

---

## 9. System Templates

| Template Name | Category | Description |
|--------------|----------|-------------|
| **Start / Stop / Continue** | retro | Three frames, color-coded, with voting indicators |
| **4Ls Retrospective** | retro | Liked, Learned, Lacked, Longed For — four quadrant frames |
| **Sailboat Retro** | retro | Wind (helps), Anchors (drags), Rocks (risks), Island (goals) |
| **Brainstorm** | brainstorm | Central topic frame with radiating idea clusters |
| **Affinity Map** | brainstorm | Empty frames for grouping + ungrouped zone |
| **User Story Map** | planning | Horizontal epic lanes with vertical priority columns |
| **Architecture Diagram** | architecture | Pre-positioned frames for Frontend, Backend, Database, External Services |
| **Flowchart Starter** | architecture | Start/End nodes with sample decision diamonds and process boxes |
| **SWOT Analysis** | strategy | 2×2 grid: Strengths, Weaknesses, Opportunities, Threats |
| **Blank Canvas** | general | Empty board with dots background |

---

## 10. Background Jobs (BullMQ)

| Queue | Job | Description |
|-------|-----|-------------|
| `board:thumbnail` | `generateThumbnail` | Render canvas to PNG thumbnail (300×200) for list view. Triggered on Yjs persist. Uses Puppeteer with headless tldraw render or server-side SVG rasterization. |
| `board:export` | `exportBoard` | Render full-resolution SVG/PNG/PDF export. Returns MinIO URL. |
| `board:snapshot` | `elementSnapshot` | Deserialize Yjs state and upsert to `board_elements`. Runs on each Yjs persist. |
| `board:cleanup` | `purgeOldVersions` | Retain last 30 named versions. Runs nightly. |

---

## 11. Authorization Model

| Role | Permissions |
|------|------------|
| **SuperUser** | All operations across all orgs |
| **Owner / Admin** | Create, edit, delete, lock any board in org. Manage templates. |
| **Member** | Create boards in projects they belong to. Edit boards they created or are collaborators on. View all project/org-visible boards. |
| **Viewer** | Read-only access to project/org-visible boards. Cannot edit canvas. |

When a board is `locked`, only the board creator or an Admin/Owner can unlock it. This enables "presentation mode" where the board is shared but immutable.

---

## 12. Performance Considerations

### 12.1 Canvas Scale Limits

tldraw handles thousands of shapes efficiently, but practical limits should be set:
- **Soft limit:** 500 elements per board (warning shown)
- **Hard limit:** 2000 elements per board (creation blocked, suggest splitting)
- **Yjs state size:** Alert if binary exceeds 10MB

### 12.2 Thumbnail Generation

Thumbnail generation is the most expensive background job. Mitigation:
- Debounce: generate at most once per 30 seconds per board
- Cache: Redis with 10-minute TTL
- Fallback: if thumbnail generation fails, show a placeholder with board name and element count

### 12.3 Element Snapshot Performance

The `board_elements` table is a read-optimized projection. For boards with 500+ elements, the snapshot upsert uses `ON CONFLICT DO UPDATE` with batch inserts (100 elements per batch).

---

## 13. Observability & Metrics

| Metric | Source | Purpose |
|--------|--------|---------|
| Active boards (with connected users) | WebSocket connections | Real-time usage |
| Elements per board (distribution) | `board_elements` count | Scale monitoring |
| Sticky-to-task promotion rate | `board_task_links` | Cross-product conversion |
| Thumbnail generation latency | BullMQ job metrics | Background job health |
| Export generation latency | BullMQ job metrics | Background job health |
| Yjs state size (per board) | Persistence layer | Storage monitoring |
| Boards per project | `boards` table | Adoption metrics |
