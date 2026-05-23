// scripts/seed-brief.js
// Seed Brief with demo documents, folders, comments, and templates.
// Resolves the target org via SEED_ORG_SLUG env var (set by the orchestrator)
// or --org-slug=<slug> CLI arg, falling back to the oldest org in the DB.
// Run: SEED_ORG_SLUG=mage-inc node scripts/seed-brief.js
// Requires: DATABASE_URL env var or running postgres on localhost:5432
// idempotent: skip-if-any-document-already-present

import postgres from 'postgres';
import crypto from 'crypto';

const NOW = new Date();
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function uuid() { return crypto.randomUUID(); }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 240); }
function daysAgo(d) { return new Date(NOW.getTime() - d * 86400000); }
function randomBetween(a, b) { return new Date(a.getTime() + Math.random() * (b.getTime() - a.getTime())); }

const DB_URL = process.env.DATABASE_URL || 'postgresql://bigbluebam:bigbluebam@localhost:5432/bigbluebam';
const sql = postgres(DB_URL, { max: 4 });

// ── Folders ──────────────────────────────────────────────────────────────────

const FOLDERS = [
  { name: 'Engineering', slug: 'engineering' },
  { name: 'Meeting Notes', slug: 'meeting-notes' },
  { name: 'RFCs', slug: 'rfcs' },
  { name: 'Onboarding', slug: 'onboarding' },
  { name: 'Post-Mortems', slug: 'post-mortems' },
];

// ── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES = [
  { name: 'Meeting Notes', icon: '📋', category: 'meeting', description: 'Date, attendees, agenda, discussion, action items' },
  { name: 'RFC', icon: '📐', category: 'engineering', description: 'Title, status, motivation, detailed design, alternatives, open questions' },
  { name: 'Post-Mortem', icon: '🔥', category: 'engineering', description: 'Incident summary, timeline, root cause, impact, action items, lessons' },
  { name: 'Sprint Retrospective', icon: '🔄', category: 'engineering', description: 'What went well, what didn\'t, action items' },
  { name: 'Design Spec', icon: '📝', category: 'engineering', description: 'Overview, goals, non-goals, detailed design, data model, API' },
  { name: 'Onboarding Guide', icon: '👋', category: 'hr', description: 'Welcome, team overview, tools setup, first week checklist' },
  { name: 'Decision Log', icon: '⚖️', category: 'general', description: 'Decision, context, options, rationale, outcome' },
  { name: 'Blank', icon: '📄', category: 'general', description: 'Empty document' },
];

// ── Documents ────────────────────────────────────────────────────────────────

const DOCUMENTS = [
  {
    title: 'RFC: Migrate to PostgreSQL 17',
    folder: 'rfcs',
    status: 'in_review',
    icon: '📐',
    body: `# RFC: Migrate to PostgreSQL 17

## Status
In Review

## Author
Alex Rodriguez — April 2, 2026

## Summary
Propose upgrading our PostgreSQL 16 cluster to PostgreSQL 17 to take advantage of improved JSON performance, incremental backup support, and the new identity-always columns that simplify our migration scripts.

## Motivation
- PostgreSQL 17 introduces \`JSON_TABLE\` which would let us replace 14 custom JSONB query helpers with standard SQL
- Incremental backup support reduces our backup window from ~40 minutes to ~8 minutes
- The \`MERGE\` statement improvements simplify our upsert-heavy beacon sync pipeline
- Several query planner improvements directly benefit our graph traversal queries

## Detailed Design

### Migration Strategy
1. Set up a PG 17 replica using \`pg_upgrade --link\`
2. Run the full test suite against the replica for 1 week
3. Perform a blue-green cutover during the Sunday maintenance window
4. Keep the PG 16 instance on standby for 2 weeks

### Breaking Changes
- \`standard_conforming_strings\` is now enforced (already true for us)
- \`vacuum_failsafe_age\` default changed — verify our autovacuum settings

### Risks
- Extension compatibility: verify \`pgvector\`, \`pg_trgm\`, and \`btree_gin\` on PG 17
- Drizzle ORM may need patching for new type serialization behavior

## Timeline
| Phase | Dates |
|-------|-------|
| Replica setup | Apr 7–11 |
| Test suite validation | Apr 12–18 |
| Cutover | Apr 20 (Sunday) |
| PG 16 decommission | May 4 |

## Open Questions
- Should we also migrate to the Qdrant 1.9 release at the same time?
- Do we need to coordinate with the Banter team on their connection pool settings?`,
  },
  {
    title: 'Sprint 14 Retrospective',
    folder: 'meeting-notes',
    status: 'approved',
    icon: '🔄',
    body: `# Sprint 14 Retrospective

**Date:** March 28, 2026
**Facilitator:** Maya Patel
**Attendees:** Alex, Ryan, Jordan, Taylor, Casey, Drew, Avery

## What Went Well
- Beacon knowledge graph launched on time — graph traversal queries are under 50ms at p99
- Helpdesk AI triage handled 73% of tickets without human intervention this sprint
- Zero production incidents for the third sprint in a row
- The new command palette (Ctrl+K) got great feedback from beta testers

## What Didn't Go Well
- The Banter voice call feature slipped by 3 days due to LiveKit configuration issues
- We underestimated the effort for the Beacon seed data script — it took 2 days instead of half a day
- Two PRs sat in review for 4 days because reviewers were overloaded

## Action Items
- [ ] Set up a review rotation schedule — no PR should wait more than 24 hours
- [ ] Create a LiveKit troubleshooting runbook in Beacon
- [ ] Add estimation buffer for data migration tasks (1.5x)
- [ ] Schedule a pairing session for the voice agent integration next sprint`,
  },
  {
    title: 'Incident Post-Mortem: Redis Memory Spike (March 15)',
    folder: 'post-mortems',
    status: 'approved',
    icon: '🔥',
    body: `# Post-Mortem: Redis Memory Spike

## Incident Summary
On March 15, 2026 at 14:23 UTC, the Redis instance reached 95% memory utilization, causing WebSocket connection drops for ~200 concurrent users. The Banter real-time messaging service was degraded for 23 minutes.

## Timeline
| Time (UTC) | Event |
|------------|-------|
| 14:23 | Redis memory alert fires (>90% threshold) |
| 14:25 | On-call (Jordan) acknowledges |
| 14:28 | Investigation begins — \`redis-cli info memory\` shows 3.2GB/3.5GB used |
| 14:31 | Root cause identified: Banter presence keys missing TTL |
| 14:35 | Hotfix deployed: add 60s TTL to all \`banter:presence:*\` keys |
| 14:38 | Memory starts declining as stale keys expire |
| 14:46 | Memory below 60%, all services healthy |

## Root Cause
The Banter presence system was writing user-online status keys without a TTL. Over 2 weeks, ~180,000 stale presence keys accumulated. Each key was small (~200 bytes) but the aggregate was ~36MB of pure waste plus Redis overhead.

## Impact
- ~200 users experienced WebSocket disconnects for 23 minutes
- 47 Banter messages were delayed by up to 2 minutes (buffered in client)
- No data loss

## Action Items
- [x] Add TTL to all Banter presence keys (hotfixed during incident)
- [x] Add Redis memory monitoring dashboard in Grafana
- [ ] Audit ALL Redis key patterns across Bam, Banter, and Beacon for missing TTLs
- [ ] Set up Redis maxmemory-policy to \`allkeys-lru\` as a safety net
- [ ] Add integration test that verifies TTL is set on presence keys`,
  },
  {
    title: 'Onboarding Guide: New Engineer Setup',
    folder: 'onboarding',
    status: 'approved',
    icon: '👋',
    body: `# New Engineer Onboarding Guide

Welcome to BigBlueBam! This guide will get you set up and productive within your first week.

## Day 1: Environment Setup

### Prerequisites
- macOS, Linux, or Windows 11 with WSL2
- Docker Desktop installed
- Node.js 22 LTS
- pnpm 9+
- Git with SSH key configured

### Repository Setup
\`\`\`bash
git clone git@github.com:eoffermann/BigBlueBam.git
cd BigBlueBam
cp .env.example .env
pnpm install
docker compose up -d
\`\`\`

### Verify Everything Works
\`\`\`bash
# All 14 services should be running
docker compose ps

# Run the test suite
pnpm test  # 530+ tests should pass

# Open the apps
open http://localhost/b3/          # Bam
open http://localhost/banter/      # Banter
open http://localhost/beacon/      # Beacon
open http://localhost/helpdesk/    # Helpdesk
open http://localhost/brief/       # Brief
\`\`\`

## Day 2: Architecture Overview

Read these documents in order:
1. **CLAUDE.md** — project conventions, tech stack, key decisions
2. **BigBlueBam_Design_Document.md** — full design spec
3. **docs/reference/mcp-server.md** — how AI agents interact with the system

### Key Concepts
- **Monorepo** with Turborepo + pnpm workspaces
- **5 SPAs** served by a single nginx container
- **140 MCP tools** expose everything to AI agents
- **Shared PostgreSQL** with per-app Drizzle schemas
- **Redis** for sessions, cache, PubSub, and BullMQ queues

## Day 3–5: First Task

Your onboarding ticket is already on the board — check My Work at \`/b3/my-work\`. It's a small, well-scoped task designed to touch the full stack (API route → service → frontend component → test).

Ask questions in #engineering on Banter. We don't bite.`,
  },
  {
    title: 'Design Spec: Brief (Collaborative Documents)',
    folder: 'rfcs',
    status: 'approved',
    icon: '📝',
    body: `# Design Spec: Brief

## Overview
Brief is the collaborative document editor for the BigBlueBam suite. It provides real-time multi-user editing for long-form content with deep cross-product linking.

## Goals
- Real-time collaborative editing via Yjs/CRDT
- Cross-product linking to Bam tasks, Beacon articles, Banter channels
- Brief-to-Beacon graduation workflow
- AI agent co-authoring via 18 MCP tools

## Non-Goals
- Not a wiki (that's Beacon)
- Not a spreadsheet
- Not a design tool

## Architecture
- **brief-api** on port 4005 (Fastify + Yjs WebSocket)
- PostgreSQL for metadata, Redis for presence, Qdrant for search
- Tiptap editor on the frontend with collaboration extensions

## Data Model
Core entities: documents, folders, versions, comments, templates, embeds, collaborators, cross-product links.

## API
30+ REST endpoints covering full CRUD for all entities, plus search, export, and graduation.

Refer to the full design document for complete details.`,
  },
  {
    title: 'Weekly Standup Notes: April 7, 2026',
    folder: 'meeting-notes',
    status: 'draft',
    icon: '📋',
    body: `# Weekly Standup — April 7, 2026

## Attendees
Alex, Ryan, Maya, Jordan, Taylor, Casey

## Updates

### Alex (Backend)
- Finished Brief API implementation — all routes working
- Running security audit on Brief endpoints
- Next: seed data and integration tests

### Ryan (Frontend)
- Brief SPA routing and layout complete
- Document list and editor pages rendering
- Next: polish editor toolbar, add template browser

### Maya (AI/MCP)
- 18 Brief MCP tools registered and tested
- Updated tool count in docs: 140 → 158 tools
- Next: test graduation workflow end-to-end

### Jordan (DevOps)
- Brief added to Docker Compose (15th service)
- nginx routing configured for /brief/
- Next: update Helm chart, staging deploy

### Taylor (QA)
- Writing Brief test suite (targeting 60+ tests)
- Found 3 bugs in document visibility filtering — filed tickets
- Next: load testing on Yjs persistence

## Blockers
- None! 🎉

## Decisions
- Brief will ship in the next release alongside Beacon improvements
- Template library will include 8 built-in templates`,
  },
  {
    title: 'API Rate Limiting Strategy',
    folder: 'engineering',
    status: 'approved',
    icon: '🛡️',
    body: `# API Rate Limiting Strategy

## Current State
All BigBlueBam APIs use a global rate limit of 100 requests per 60 seconds per IP. This is too generous for expensive write operations and too restrictive for cheap reads.

## Proposed Changes

### Tiered Rate Limits

| Tier | Limit | Applies To |
|------|-------|-----------|
| **Read** | 200/min | GET endpoints, search, list |
| **Write** | 30/min | POST, PATCH, PUT (creation, updates) |
| **Expensive** | 10/min | Search with embeddings, PDF export, bulk operations |
| **Auth** | 5/min | Login, password reset |

### Implementation
Using \`@fastify/rate-limit\` with per-route config overrides:

\`\`\`typescript
fastify.post('/beacons', {
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  preHandler: [requireAuth, ...],
}, handler);
\`\`\`

### Key Decisions
- Rate limits are per-IP for unauthenticated requests, per-user for authenticated
- API key requests get 3x the limit (for agent workloads)
- Redis-backed sliding window (not fixed window) for accuracy

## Rollout
1. Add to Beacon API (done — P1-008)
2. Add to Brief API (done — shipped with initial build)
3. Backport to Bam and Banter APIs (next sprint)`,
  },
  {
    title: 'MCP Tool Inventory & Coverage Matrix',
    folder: 'engineering',
    status: 'approved',
    icon: '🤖',
    body: `# MCP Tool Inventory

## Overview
BigBlueBam exposes **158 MCP tools** across 5 products. This document tracks coverage and identifies gaps.

## Tool Count by Product

| Product | Tools | Categories |
|---------|-------|-----------|
| **Bam** | 64 | Tasks, sprints, comments, labels, board, members, settings, views, reports |
| **Banter** | 47 | Channels, DMs, threads, messages, reactions, pins, voice, admin, search |
| **Beacon** | 29 | CRUD, search, verification, graph, policies, tags, links, saved queries |
| **Brief** | 18 | Documents, comments, versions, search, graduation, links |

## Coverage Analysis

### Well Covered
- Task CRUD and sprint management (Bam)
- Channel messaging and search (Banter)
- Knowledge base lifecycle (Beacon)
- Document editing and collaboration (Brief)

### Gaps to Address
- No tool for bulk task operations (move 10 tasks to a sprint)
- No tool for cross-product search (search across Bam + Beacon + Brief at once)
- No tool for Helpdesk ticket creation (only triage/response)
- Voice call tools are stub-only (waiting on LiveKit agent SDK)

## Next Steps
- Add \`bam_bulk_move\` and \`bam_bulk_assign\` tools
- Build a \`unified_search\` meta-tool
- Implement helpdesk ticket creation tools`,
  },
  {
    title: 'Beacon → Brief Integration Spec',
    folder: 'rfcs',
    status: 'draft',
    icon: '🔗',
    body: `# Beacon → Brief Integration

## Motivation
Brief documents can be promoted ("graduated") to Beacon articles. This document specifies the reverse direction: embedding Beacon references inside Brief documents.

## Design

### Beacon Embed Node
A custom Tiptap node that renders a Beacon reference inline:

\`\`\`
[beacon:database-index-optimization-guide-part-229]
\`\`\`

Renders as a card showing:
- Beacon title
- Status badge (Active/Draft/etc)
- Freshness indicator (green/yellow/red ring)
- Verification count
- Click to open in Beacon

### Implementation
1. Custom ProseMirror node type \`beaconEmbed\`
2. Node view component fetches beacon data from \`/beacon/api/v1/beacons/:slug\`
3. Cached in TanStack Query with 2-minute stale time
4. Slash command \`/beacon\` opens a search picker

### Cross-Product Link
When a Beacon embed is inserted, a \`brief_beacon_links\` row is automatically created. When the embed is removed, the link is cleaned up.

## Open Questions
- Should we support embedding Beacon search results (not just single beacons)?
- Should edits to the Beacon be reflected in the Brief embed in real-time?`,
  },
  {
    title: 'Database Schema Conventions',
    folder: 'engineering',
    status: 'approved',
    icon: '🗄️',
    body: `# Database Schema Conventions

## Naming
- **Tables:** snake_case plural (\`brief_documents\`, \`beacon_entries\`)
- **Columns:** snake_case (\`created_at\`, \`organization_id\`)
- **Indexes:** \`idx_{table}_{column}\` or \`idx_{table}_{purpose}\`
- **Constraints:** auto-generated by PostgreSQL or explicit \`{table}_{type}_{columns}\`

## Required Columns
Every table MUST have:
- \`id UUID PRIMARY KEY DEFAULT gen_random_uuid()\`
- \`created_at TIMESTAMPTZ NOT NULL DEFAULT now()\`

Entity tables (not join tables) should also have:
- \`organization_id UUID NOT NULL REFERENCES organizations(id)\`
- \`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\`

## Migration Rules
1. Append-only numbered files: \`0024_brief_tables.sql\`
2. Every statement must be idempotent (IF NOT EXISTS)
3. Header with \`-- Why:\` and \`-- Client impact:\`
4. Never edit an existing migration (SHA-256 checksums enforced)
5. Destructive ALTERs wrapped in guarded DO blocks

## Foreign Keys
- Use ON DELETE CASCADE for child tables
- Use ON DELETE SET NULL for optional references
- Always index foreign key columns

## Visibility Pattern
\`\`\`sql
visibility VARCHAR(20) NOT NULL DEFAULT 'project'
    CHECK (visibility IN ('private', 'project', 'organization'))
\`\`\`

Application code enforces:
- \`private\` → only owner + explicit collaborators
- \`project\` → all project members
- \`organization\` → all org members`,
  },
  {
    title: 'Q2 2026 Engineering Roadmap',
    folder: null,
    status: 'draft',
    icon: '🗺️',
    body: `# Q2 2026 Engineering Roadmap

## Theme: Platform Maturity

### April
- **Brief launch** — collaborative documents with real-time editing
- **Beacon security hardening** — fix all P0/P1 audit findings
- **Banter voice calls** — LiveKit integration for in-app calling

### May
- **Unified search** — single search across Bam, Beacon, Brief, and Banter
- **Helm chart v2** — Kubernetes deployment with horizontal pod autoscaling
- **Mobile web optimization** — responsive layouts for all 5 apps

### June
- **AI agent improvements** — multi-step workflows, approval chains
- **SSO integration** — SAML 2.0 and OIDC for enterprise customers
- **Performance audit** — p99 latency targets for all API endpoints

## Key Metrics
| Metric | Target |
|--------|--------|
| API p99 latency | < 200ms |
| Test coverage | > 80% |
| Uptime | 99.9% |
| MCP tool count | 175+ |

## Team Allocation
- 3 engineers on Brief (April)
- 2 engineers on platform (May–June)
- 1 engineer on AI/MCP throughout
- 1 engineer on DevOps/infrastructure`,
  },
  {
    title: 'Tiptap Editor Extension Registry',
    folder: 'engineering',
    status: 'draft',
    icon: '✏️',
    body: `# Tiptap Editor Extension Registry

This document tracks all Tiptap extensions used in the Brief editor and their configuration.

## Core Extensions

| Extension | Source | Purpose |
|-----------|--------|---------|
| StarterKit | @tiptap/starter-kit | Paragraphs, headings, bold, italic, strike, code, blockquote, lists |
| Collaboration | @tiptap/extension-collaboration | Yjs binding for real-time sync |
| CollaborationCursor | @tiptap/extension-collaboration-cursor | Colored cursors with names |
| Placeholder | @tiptap/extension-placeholder | "Start typing..." hint |

## Rich Content Extensions

| Extension | Source | Purpose |
|-----------|--------|---------|
| Image | @tiptap/extension-image | Inline images (uploaded to MinIO) |
| Link | @tiptap/extension-link | Hyperlinks with paste-detection |
| Table | @tiptap/extension-table | Tables with column resize |
| TaskList / TaskItem | @tiptap/extension-task-list | Checkbox task lists |
| CodeBlockLowlight | @tiptap/extension-code-block-lowlight | Syntax-highlighted code blocks |
| Highlight | @tiptap/extension-highlight | Background color highlighting |

## Custom Extensions

| Extension | Source | Purpose |
|-----------|--------|---------|
| BamTaskEmbed | custom | Live task card embed (BBB-123) |
| BeaconEmbed | custom | Beacon reference with status badge |
| BanterChannelLink | custom | #channel-name clickable link |
| CalloutBlock | custom | Info/warning/success/error callouts |
| SlashCommand | custom | \`/\` command menu for quick insertion |
| TableOfContents | custom | Auto-generated TOC from headings |

## Slash Commands

| Command | Inserts |
|---------|---------|
| /h1, /h2, /h3 | Heading |
| /bullet, /numbered | Lists |
| /todo | Task list |
| /code | Code block |
| /table | 3x3 table |
| /image | Image upload |
| /callout | Callout block |
| /task | Bam task embed |
| /beacon | Beacon embed |
| /toc | Table of contents |`,
  },
  {
    title: 'Docker Compose Service Map',
    folder: 'engineering',
    status: 'approved',
    icon: '🐳',
    body: `# Docker Compose Service Map

## Application Services (stateless, horizontally scalable)

| Service | Port | Description |
|---------|------|-------------|
| api | 4000 | Bam REST API + WebSocket |
| banter-api | 4002 | Banter REST API + WebSocket |
| helpdesk-api | 4001 | Helpdesk REST API |
| beacon-api | 4004 | Beacon REST API |
| brief-api | 4005 | Brief REST API + Yjs WebSocket |
| mcp-server | 3001 | MCP protocol server (158 tools) |
| worker | — | BullMQ background jobs |
| voice-agent | 4003 | Python AI voice agent |
| frontend | 80 | nginx serving all SPAs |

## Data Services

| Service | Port | Description |
|---------|------|-------------|
| postgres | 5432 | PostgreSQL 16 — primary database |
| redis | 6379 | Redis 7 — sessions, cache, PubSub, queues |
| minio | 9000 | S3-compatible file storage |
| qdrant | 6333 | Vector search (Beacon + Brief embeddings) |
| livekit | 7880 | WebRTC SFU for voice/video |

## Service Dependencies

\`\`\`
postgres ─► migrate ─► api, banter-api, helpdesk-api, beacon-api, brief-api, worker
redis ───► api, banter-api, beacon-api, brief-api, worker, mcp-server
minio ───► api, beacon-api, brief-api
qdrant ──► beacon-api, brief-api
livekit ─► voice-agent
\`\`\`

## Quick Commands

\`\`\`bash
# Start everything
docker compose up -d

# Rebuild one service
docker compose build brief-api && docker compose up -d --force-recreate brief-api

# View logs
docker compose logs -f brief-api mcp-server

# Stop without wiping data
docker compose down  # NO -v flag!
\`\`\``,
  },
  {
    title: 'Security Audit Checklist Template',
    folder: null,
    status: 'approved',
    icon: '🔒',
    body: `# Security Audit Checklist

Use this template when auditing a new BigBlueBam service.

## Authentication & Authorization
- [ ] All mutation endpoints require authentication
- [ ] Role-based access control enforced (member/admin/owner)
- [ ] Organization isolation on all queries (org_id filter)
- [ ] Private resources only visible to owner/collaborators
- [ ] API key scope validation (read/read_write/admin)

## Input Validation
- [ ] All inputs validated with Zod schemas
- [ ] String length limits on all text fields
- [ ] ILIKE queries use escapeLike() helper
- [ ] No raw SQL interpolation
- [ ] File upload size limits enforced

## Data Access
- [ ] Cross-org data access impossible (verify with test)
- [ ] IDOR protection on all resource endpoints
- [ ] Link creation validates both sides belong to same org
- [ ] Delete operations verify ownership/permission

## Rate Limiting
- [ ] Global rate limit configured
- [ ] Write endpoints have stricter per-route limits
- [ ] Search endpoints have per-route limits

## Response Security
- [ ] Error handler sanitizes non-app errors
- [ ] X-Content-Type-Options: nosniff header
- [ ] X-Frame-Options: DENY header
- [ ] Cache-Control: no-store on sensitive responses
- [ ] No internal details leaked in error messages

## Dependencies
- [ ] No known vulnerabilities in direct dependencies
- [ ] Secrets not hardcoded (read from environment)
- [ ] Session secret is cryptographically random`,
  },
  {
    title: 'Brief Launch Checklist',
    folder: null,
    status: 'in_review',
    icon: '🚀',
    body: `# Brief Launch Checklist

## Pre-Launch

### Backend
- [x] All REST endpoints implemented and tested
- [x] Database migration deployed and verified
- [x] Security audit completed — P0/P1 issues fixed
- [x] Rate limiting configured on write endpoints
- [ ] Load test: 50 concurrent document edits
- [ ] Yjs persistence verified under crash recovery

### Frontend
- [x] All pages rendering correctly
- [x] Dark/light mode working
- [x] Cross-app navigation pills added
- [ ] Mobile responsive check
- [ ] Accessibility audit (keyboard nav, screen reader)

### MCP
- [x] All 18 Brief tools registered
- [x] Tool schemas validated against API
- [ ] End-to-end test: Claude creates and edits a document

### Infrastructure
- [x] Docker service added and healthy
- [x] nginx routing configured
- [x] Health check passing
- [ ] Helm chart updated
- [ ] Staging deploy successful
- [ ] Monitoring dashboards created

### Documentation
- [x] README updated with Brief section
- [x] CLAUDE.md updated
- [x] Marketing site updated
- [ ] API documentation generated
- [x] Screenshots captured

## Launch Day
- [ ] Deploy to production
- [ ] Verify all health checks
- [ ] Smoke test: create, edit, comment, search
- [ ] Announce in #engineering on Banter
- [ ] Update changelog`,
  },
];

// ── Comment data ─────────────────────────────────────────────────────────────

const COMMENTS_DATA = [
  { docTitle: 'RFC: Migrate to PostgreSQL 17', comments: [
    { body: 'Have we checked if pg_repack works on PG 17? We rely on it for zero-downtime table rewrites.', author: 2 },
    { body: 'Good call — I\'ll add that to the extension compatibility check list.', author: 1, isReply: true },
    { body: 'The blue-green cutover window on Sunday LGTM. Can we do a dry run the Saturday before?', author: 3 },
    { body: '+1 on the dry run. Let\'s also make sure we have a rollback plan documented.', author: 5 },
  ]},
  { docTitle: 'Sprint 14 Retrospective', comments: [
    { body: 'The review rotation schedule is a great idea. I\'d suggest pairing it with a Banter bot that pings reviewers after 12 hours.', author: 4 },
    { body: 'Agreed. I\'ll set up the bot this sprint.', author: 6, isReply: true },
  ]},
  { docTitle: 'Brief Launch Checklist', comments: [
    { body: 'Should we add browser compatibility testing to the pre-launch list?', author: 7 },
    { body: 'The Yjs persistence crash recovery test is critical — we should block launch on it.', author: 3 },
    { body: 'I can help with the accessibility audit. I\'ll grab that task.', author: 8 },
  ]},
];

// ── Main seed function ───────────────────────────────────────────────────────

async function seed() {
  // Check if tables exist
  const tableCheck = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'brief_documents')
  `;
  if (!tableCheck[0].exists) {
    console.error('ERROR: brief_documents table does not exist. Run migrations first.');
    process.exit(1);
  }

  // ── Resolve target org dynamically ─────────────────────────────────────
  const orgSlug = process.env.SEED_ORG_SLUG
    ?? process.argv.find((a) => a.startsWith('--org-slug='))?.split('=')[1];
  const [org] = orgSlug
    ? await sql`SELECT id, name FROM organizations WHERE slug = ${orgSlug} LIMIT 1`
    : await sql`SELECT id, name FROM organizations ORDER BY created_at LIMIT 1`;
  if (!org) {
    console.error('No org found, run create-admin first');
    process.exit(1);
  }
  const ORG_ID = org.id;
  console.log(`Seeding Brief data for org: ${org.name} (${ORG_ID})\n`);

  const users = await sql`SELECT id FROM users WHERE org_id = ${ORG_ID} ORDER BY created_at`;
  if (users.length === 0) {
    console.error('No users in org, run create-admin first');
    process.exit(1);
  }
  const USER_IDS = users.map((u) => u.id);
  console.log(`User pool: ${USER_IDS.length} users (round-robin assignment)`);

  const projects = await sql`SELECT id FROM projects WHERE org_id = ${ORG_ID} ORDER BY created_at LIMIT 1`;
  const PROJECT_ID = projects.length > 0 ? projects[0].id : null;

  // Idempotency guard: skip if the org already has Brief documents seeded.
  // We intentionally do NOT delete existing rows; re-runs are a no-op.
  const [{ count: existingDocs }] = await sql`SELECT COUNT(*)::int AS count FROM brief_documents WHERE org_id = ${ORG_ID}`;
  if (existingDocs > 0) {
    console.log(`Brief seed: ${existingDocs} documents already exist for this org, skipping.`);
    await sql.end();
    return;
  }

  // ── Insert folders ──
  const folderIds = {};
  for (const f of FOLDERS) {
    const id = uuid();
    await sql`
      INSERT INTO brief_folders (id, org_id, project_id, name, slug, sort_order, created_by)
      VALUES (${id}, ${ORG_ID}, ${PROJECT_ID}, ${f.name}, ${f.slug}, ${FOLDERS.indexOf(f)}, ${USER_IDS[0]})
      ON CONFLICT DO NOTHING
    `;
    folderIds[f.slug] = id;
    console.log(`  Folder: ${f.name}`);
  }

  // ── Insert templates ──
  for (const t of TEMPLATES) {
    await sql`
      INSERT INTO brief_templates (id, org_id, name, description, icon, category, yjs_state, sort_order, created_by)
      VALUES (${uuid()}, NULL, ${t.name}, ${t.description}, ${t.icon}, ${t.category}, ${Buffer.from('{}')}, ${TEMPLATES.indexOf(t)}, ${USER_IDS[0]})
      ON CONFLICT DO NOTHING
    `;
    console.log(`  Template: ${t.name}`);
  }

  // ── Insert documents ──
  const docIds = {};
  for (const doc of DOCUMENTS) {
    const id = uuid();
    const author = pick(USER_IDS);
    const createdAt = randomBetween(daysAgo(90), daysAgo(1));
    const updatedAt = randomBetween(createdAt, NOW);
    const folderId = doc.folder ? folderIds[doc.folder] || null : null;
    const slug = slugify(doc.title) + '-' + crypto.randomBytes(3).toString('hex');
    const wordCount = doc.body.split(/\s+/).length;

    await sql`
      INSERT INTO brief_documents (
        id, org_id, project_id, folder_id, title, slug,
        plain_text, html_snapshot, icon, status, visibility, pinned,
        word_count, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG_ID}, ${PROJECT_ID}, ${folderId}, ${doc.title}, ${slug},
        ${doc.body}, ${null}, ${doc.icon || null}, ${doc.status}, ${'project'}, ${false},
        ${wordCount}, ${author}, ${author}, ${createdAt}, ${updatedAt}
      )
    `;
    docIds[doc.title] = id;
    console.log(`  Document: ${doc.title} (${doc.status})`);

    // Create initial version
    await sql`
      INSERT INTO brief_versions (id, document_id, version_number, title, yjs_state, plain_text, word_count, change_summary, created_by, created_at)
      VALUES (${uuid()}, ${id}, ${1}, ${doc.title}, ${Buffer.from('{}')}, ${doc.body}, ${wordCount}, ${'Initial version'}, ${author}, ${createdAt})
    `;
  }

  // ── Insert comments ──
  let commentCount = 0;
  for (const cd of COMMENTS_DATA) {
    const docId = docIds[cd.docTitle];
    if (!docId) continue;
    let parentId = null;
    for (const c of cd.comments) {
      const id = uuid();
      // Round-robin through the available user pool. Historical authors were
      // specific named engineers; with a dynamic org we just rotate.
      const authorId = USER_IDS[c.author % USER_IDS.length];
      await sql`
        INSERT INTO brief_comments (id, document_id, parent_id, author_id, body, created_at, updated_at)
        VALUES (${id}, ${docId}, ${c.isReply ? parentId : null}, ${authorId}, ${c.body}, ${randomBetween(daysAgo(30), NOW)}, ${NOW})
      `;
      if (!c.isReply) parentId = id;
      commentCount++;
    }
  }
  console.log(`  Comments: ${commentCount}`);

  // ── Star some documents ──
  let starCount = 0;
  for (const title of ['Onboarding Guide: New Engineer Setup', 'Sprint 14 Retrospective', 'Q2 2026 Engineering Roadmap', 'Brief Launch Checklist']) {
    const docId = docIds[title];
    if (!docId) continue;
    for (const userId of USER_IDS.slice(0, 3 + Math.floor(Math.random() * 4))) {
      await sql`
        INSERT INTO brief_stars (id, document_id, user_id)
        VALUES (${uuid()}, ${docId}, ${userId})
        ON CONFLICT DO NOTHING
      `;
      starCount++;
    }
  }
  console.log(`  Stars: ${starCount}`);

  console.log(`\nDone! Seeded ${DOCUMENTS.length} documents, ${FOLDERS.length} folders, ${TEMPLATES.length} templates, ${commentCount} comments, ${starCount} stars.`);
  await sql.end();
}

seed().catch((e) => { console.error('FATAL:', e); process.exit(1); });
