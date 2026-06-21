# Beacon Development Plan

**Status:** In Progress | **Branch:** `beacon` | **Date:** 2026-04-06

---

## Backend Phases

### Phase 1 — Foundation

**Migration:** `infra/postgres/migrations/0023_beacon_tables.sql`
- All tables from spec section 2.1 plus saved queries from section 5.5.1

**New service:** `apps/beacon-api/` (Fastify on port 4004, modeled after banter-api)

**Drizzle schemas** in `apps/beacon-api/src/db/schema/` (10 files):
- `beacon-entries.ts`, `beacon-versions.ts`, `beacon-tags.ts`, `beacon-links.ts`
- `beacon-expiry-policies.ts`, `beacon-verifications.ts`, `beacon-agents.ts`
- `beacon-saved-queries.ts`, `index.ts`

**Service layer:**
- `beacon.service.ts`, `version.service.ts`, `tag.service.ts`, `link.service.ts`

**Routes:**
- `beacon.routes.ts`, `version.routes.ts`, `tag.routes.ts`, `link.routes.ts`

**Infrastructure:**
- Docker: add `beacon-api` + `qdrant` services to `docker-compose.yml`
- Nginx: add `/beacon/api/` proxy block

---

### Phase 2 — Lifecycle + Policy

**Services:**
- `lifecycle.service.ts` — state machine transitions per section 2.1.2
- `policy.service.ts` — hierarchical expiry resolution per section 3
- `verification.service.ts` — verify/challenge flows per section 4.2

**Routes:**
- `policy.routes.ts` — `GET /policies`, `PUT /policies/:id`, `GET /policies/resolve`

---

### Phase 3 — Search + Retrieval

**Qdrant client:** `apps/beacon-api/src/lib/qdrant.ts`

**Services:**
- `qdrant.service.ts`, `embedding.service.ts` (stub initially), `chunker.service.ts`
- `search.service.ts`, `saved-query.service.ts`

**Routes:**
- `search.routes.ts` — `POST /search`, `GET /suggest`, `POST /context`, saved query CRUD

**Worker job:**
- `apps/worker/src/jobs/beacon-vector-sync.job.ts`

---

### Phase 4 — Graph + Governance

**Services:**
- `graph.service.ts` — neighbors, hubs, recent
- `notification.service.ts` — Banter DM + email hooks per section 6.2

**Routes:**
- `graph.routes.ts` — 3 endpoints (neighbors, hubs, recent)

**Worker jobs:**
- `beacon-expiry-sweep` — sweep expired beacons
- `beacon-contradiction-scan` — detect contradictions across entries
- `beacon-reconciliation` — reconcile stale data

---

### Phase 5 — MCP + Integration

**MCP tools:**
- `apps/mcp-server/src/tools/beacon-tools.ts` — 36 MCP tools

**Cross-suite integration:**
- Internal routes for cross-suite linking (BBB tasks, Banter threads)
- Banter unfurl handler for `BEACON-` references

---

## Frontend Phases

### Phase F1 — App Shell

**New SPA:** `apps/beacon/` served at `/beacon/` (follows Banter pattern)

**Route union type:**
- `home`, `list`, `search`, `detail`, `create`, `edit`, `graph`, `dashboard`, `settings`

**Key deliverables:**
- Auth store using shared session via `/b3/api/auth/me`
- Layout shell with cross-app navigation (add Beacon button to Bam + Banter nav)
- Copy common components from Bam: Button, Input, Dialog, Badge, etc.

---

### Phase F2 — Beacon CRUD

**Pages:**
- `beacon-list.tsx` — filterable list with sort/filter controls
- `beacon-detail.tsx` — two-column layout (content + metadata sidebar)
- `beacon-editor.tsx` — create/edit with Markdown editor

**Components:**
- `freshness-ring.tsx`, `status-badge.tsx`, `lifecycle-actions.tsx`
- `beacon-comments.tsx`, `beacon-links.tsx`, `version-history.tsx`

---

### Phase F3 — Search Experience (section 5.5.1 + 5.5.2)

**Key files:**
- `query-builder.tsx` — faceted controls mapped to section 5.2 search facets
- `result-card.tsx` — match sources, freshness indicator, linked beacons

**Features:**
- URL state serialization (base64url + human-readable shorthand)
- Saved queries panel with CRUD

---

### Phase F4 — Knowledge Graph Explorer (section 5.5.3)

**Stack:** graphology + Sigma.js v2 (WebGL renderer)

**Components:**
- `graph-canvas.tsx`, `node-popover.tsx`, `edge-legend.tsx`, `traversal-breadcrumb.tsx`

**Features:**
- Knowledge Home landing page (hubs + recent + at-risk widgets)
- Focus+expand interaction with lazy-loaded neighbor data

---

### Phase F5 — Governance Dashboard

**Tabs:**
- Overview, At-Risk, Archived Backlog, Agent Activity, Expiry Policies

**Features:**
- Policy hierarchy editor (org > project > tag scope)
- Freshness score metrics and trend charts
