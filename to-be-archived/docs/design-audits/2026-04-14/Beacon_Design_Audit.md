# Beacon Design Audit (2026-04-14)

## Summary

Beacon is approximately 70-75% complete across backend, frontend, and integration layers. The core CRUD operations, lifecycle state machine, hierarchical policy engine, hybrid search infrastructure, knowledge graph endpoints, and MCP tool suite are substantially implemented. However, critical security gaps (3 P0 findings), schema incompleteness (missing comments and attachments tables), and frontend edge cases reduce overall maturity. The design spec was rated adequate rather than comprehensive; gaps in the spec were partially inferred from the codebase itself.

## Design sources consulted

- `docs/early-design-documents/Beacon_Design_Spec.md` (primary spec v0.2.0-DRAFT, 2026-04-05)
- `docs/beacon-development-plan.md` (supplemental course-correction notes, 2026-04-06)
- `docs/beacon-frontend-fix-plan.md` (supplemental frontend diagnostics, 2026-04-07)
- `docs/beacon-security-audit.md` (supplemental security review, 2026-04-05)
- `CLAUDE.md` (repo-level architecture overview)

## Built and working

**Backend routes** (7 route files):
- `apps/beacon-api/src/routes/beacon.routes.ts` - CRUD (create, list, get by slug/id, update, delete/retire), publish, restore, verify, challenge
- `apps/beacon-api/src/routes/search.routes.ts` - hybrid search POST, typeahead GET, context POST, saved query CRUD (save, list, get, delete)
- `apps/beacon-api/src/routes/graph.routes.ts` - neighbors (N-hop traversal), hubs (top-k by authority), recent (last 7/30/90 days)
- `apps/beacon-api/src/routes/policy.routes.ts` - GET policies (resolved for scope), PUT policies (admin+ only), GET resolve (preview)
- `apps/beacon-api/src/routes/tag.routes.ts` - list with counts, POST tags to beacon, DELETE tags
- `apps/beacon-api/src/routes/link.routes.ts` - create (Member+), list, delete (Owner/Admin)
- `apps/beacon-api/src/routes/version.routes.ts` - list, get specific version

**Backend services** (14 service files, ~3300 LOC):
- `beacon.service.ts` - createBeacon, updateBeacon, listBeacons (with cursor pagination), getStats, publishBeacon, restoreBeacon, retireBeacon
- `lifecycle.service.ts` - state machine transitions (Draft to Active to PendingReview, with Archived and Retired paths)
- `policy.service.ts` - hierarchical policy resolution (System/Org/Project scope), validation against parent constraints
- `verification.service.ts` - verifyBeacon (record verification events), outcome tracking (Confirmed/Updated/Challenged/Retired)
- `search.service.ts` - hybridSearch (Qdrant + PostgreSQL fulltext fallback, tag expansion, link traversal, re-ranking with freshness decay), suggestBeacons (typeahead)
- `qdrant.service.ts` - vector DB operations (searchChunks with dense+sparse, group_by aggregation)
- `embedding.service.ts` - embedTexts (multi-vector per beacon)
- `chunker.service.ts` - body chunking at heading boundaries or token count
- `graph.service.ts` - getNeighbors (1-3 hops, implicit edges via tag affinity), getHubs (top-k by verification_count + inbound_link_count), getRecent
- `tag.service.ts` - addTags, removeTags, getTags (with beacon count aggregation)
- `link.service.ts` - createLink, listLinks, removeLink (checks link type: RelatedTo, Supersedes, DependsOn, ConflictsWith, SeeAlso)
- `version.service.ts` - listVersions, getVersion (full audit trail)
- `saved-query.service.ts` - saveQuery, listQueries, getQuery, deleteQuery (with scope: Private/Project/Organization)
- `notification.service.ts` - stub; no implementation visible

**Database schema** (8 Drizzle schemas, migration 0023_beacon_tables.sql):
- `beacon_entries` - full lifecycle columns (status, visibility, expires_at, last_verified_at, verification_count, retired_at, vector_id, metadata JSONB)
- `beacon_versions` - version history with audit trail (changed_by, change_note, created_at)
- `beacon_tags` - M:M beacons to tags
- `beacon_links` - typed edges (RelatedTo, Supersedes, DependsOn, ConflictsWith, SeeAlso) with created_by
- `beacon_expiry_policies` - System/Org/Project scope with min/max/default/grace_period_days, CHECK constraints for ordering
- `beacon_verifications` - audit log (verification_type, outcome, confidence_score, notes)
- `beacon_agents` - agent registry with model_identifier and agent_config JSONB
- `beacon_saved_queries` - query storage (query_body JSONB, scope, uniqueness on owner_id+name)

**Frontend** (8 pages, 40+ components):
- `apps/beacon/src/app.tsx` - route parsing (home, list, search, create, edit, detail, graph, dashboard, settings), auth gate via auth store
- `pages/home.tsx` - Knowledge Home landing (stats cards: total, at-risk, recent; quick action buttons)
- `pages/beacon-list.tsx` - filterable list view with sort/filter controls
- `pages/beacon-detail.tsx` - two-column detail (content + metadata sidebar; lifecycle actions; comments; version history)
- `pages/beacon-editor.tsx` - create/edit with Markdown editor, visibility selector, project picker
- `pages/beacon-search.tsx` - query builder with faceted filters; result cards with match sources, freshness indicator
- `pages/graph-explorer.tsx` - Sigma.js WebGL knowledge graph with traversal breadcrumb
- `pages/beacon-dashboard.tsx` - governance dashboard (at-risk, archived backlog, agent activity, policy hierarchy)
- `pages/beacon-settings.tsx` - org/project settings (theme, notification preferences)

**Worker jobs**:
- `apps/worker/src/jobs/beacon-vector-sync.job.ts` - async chunking + embedding + Qdrant upsert
- `apps/worker/src/jobs/beacon-expiry-sweep.job.ts` - sweep expired beacons (Active to PendingReview on expires_at reached)

**MCP tools** (beacon-tools.ts, 610 lines): 36 MCP tools covering beacon CRUD, search, graph, policy, verification, agent management, cross-suite linking (Bam tasks, Banter threads).

## Partial or divergent

**Schema divergence:**
- `beacon_entries`: spec calls for `vector_id` as foreign key into Qdrant; implemented as plain VARCHAR(128). Impact: low (Qdrant point IDs are strings; no structural issue).
- Expiry status: spec defines `Expired` as auto-transition state; codebase treats it as a read-only enum value that is never set (expiry is signaled by `expires_at` timestamp crossing now()). Active to PendingReview happens via background sweep job, not automatic on-read transition.

**Endpoint divergence:**
- `POST /beacons/:id/publish` - exists and transitions Draft to Active per spec.
- `POST /beacons/:id/challenge` - exists but is missing `requireBeaconReadAccess()` middleware (security finding P0-003).
- Search scoring: spec describes freshness decay as "0.85 to 1.0 clamped range, max 15% penalty." Implementation at `search.service.ts:~200` does compute freshness_boost but exact formula and bounds not verified against spec.

**Search/embeddings:**
- Embedding service is stubbed; calls to `embedTexts()` in search flow do not actually call an LLM or embedding model. Qdrant search will fail until embeddings are populated. This is listed as Phase 3 in the dev plan but not yet connected to a real embedding provider.
- Hybrid search (dense + sparse) is configured in Qdrant service but the sparse embedding (BM25/SPLADE) generation is not visible in the codebase.

**Notification service:**
- Spec §6.2 describes Banter DM and email hooks on verification/challenge/expiry events. `notification.service.ts` exists but contains only stub signatures; no Banter or email integration is implemented.

**File paths:**
- `apps/beacon-api/src/services/search.service.ts:437, 553-556` (P0-001 - ILIKE injection)
- `apps/beacon-api/src/routes/beacon.routes.ts:166, 204-207` (TODO: upgrade diff, event naming)
- `apps/beacon-api/src/routes/policy.routes.ts:57` (P1-004 - org_id override not validated)

## Missing

**P0 (blocks downstream):**
1. beacon_comments table (spec §2.1.7) - no migration, no Drizzle schema, no routes. Comments are mentioned in frontend (beacon-detail layout) but unreachable.
2. beacon_attachments table (spec §2.1.6) - no migration, no Drizzle schema, no upload routes. Rich media references in Markdown will fail.
3. Comments and attachments functionality - frontend components reference but API endpoints do not exist.

**P1 (high-value gaps):**
1. Embedding model integration - `embedding.service.ts` is stubbed. Real LLM/embedding provider (Anthropic embeddings API, OpenAI, Cohere) not wired in.
2. Sparse embedding (BM25/SPLADE) - Qdrant schema declares sparse vectors but chunker does not generate them.
3. Notification service implementation - `notification.service.ts` is stubbed; no Banter DM or email delivery on verification/challenge/expiry.
4. Graph visibility filtering - spec §5.5.3 and security finding P1-006 flag that graph endpoints (neighbors, hubs, recent) do not filter by Private/Project visibility. Returns all beacons regardless of access.
5. Cross-encoder re-ranker - spec §2.2.6 describes Stage 2 re-ranking with cross-encoder or LLM-based scoring. Currently using only PostgreSQL freshness decay + authority count.

**P2 (nice-to-have):**
1. Agent auto-verification workflows - spec §4.2 describes agent-driven verification with confidence thresholds. No scheduled job or agent-triggered verification flow.
2. Contradiction detection job - spec §3.4 mentions `beacon-contradiction-scan` background job. Not implemented.
3. Reconciliation job - spec mentions hourly PostgreSQL-to-Qdrant drift reconciliation. Not implemented.
4. Fridge Cleanout UX - dashboard mentions "Fridge Cleanout" process for expired beacon triage; frontend form exists but backend coordination missing.

## Architectural guidance

**For beacon_comments and beacon_attachments:**
The pattern is established in `beacon_entries` and `beacon_versions`. Create two new Drizzle schema files (`beacon-comments.ts`, `beacon-attachments.ts`), add them to `apps/beacon-api/src/db/schema/index.ts`, create a new migration in `infra/postgres/migrations/` (idempotent CREATE TABLE IF NOT EXISTS). Add routes (`comments.routes.ts`, `attachments.routes.ts`) following the pattern of `tag.routes.ts` (list, create, delete). Wire them into `apps/beacon-api/src/index.ts` registerRoutes. Reuse MinIO S3 client pattern from other apps (api, brief, etc.) for file storage.

**For embedding service:**
Replace stub `embedTexts()` in `apps/beacon-api/src/services/embedding.service.ts` with a real provider. Recommended: Anthropic embeddings API or equivalent. Accept env var `BEACON_EMBEDDING_PROVIDER`. Call embeddings in the `beacon-vector-sync` worker job after chunking, before Qdrant upsert. Cache embeddings in Qdrant payload so re-chunking is optional on next sync.

**For graph visibility filtering:**
Pass `userId` to all three graph service functions (getNeighbors, getHubs, getRecent). Before returning node list, filter out Private beacons where `owned_by !== userId` and Project beacons where user is not a `project_members` row. Same pattern as `listBeacons` at `beacon.service.ts:~450`. Alternatively, apply filter in the SQL query with a LEFT JOIN on visibility rules.

**For sparse embeddings:**
Qdrant `sparse` vector support requires SPLADE or BM25 sparse vectors. Options: (a) Use Qdrant's built-in `ModifierBM25` sparse vector type and feed raw text to Qdrant (it will tokenize server-side). (b) Use an external sparse encoder in a sidecar or async job. Recommended: option (a) for simplicity. Modify `chunker.service.ts` to pass chunk text to Qdrant; Qdrant will handle sparse generation automatically if collection schema includes sparse vector definition.

**For notifications:**
Implement `notification.service.ts` to emit events to Banter API and email queue. Pattern: on `verifyBeacon`, `challengeBeacon`, and expiry sweep, call `notificationService.notifyOwner()` with event type and beacon details. Reuse Banter DM schema from `banter-api` (DM endpoint, thread-level mentions). Use existing email job in `worker` for SMTP delivery.

## Dependencies

**Beacon depends on:**
- `apps/api` shared auth, session, org/user/project models via bbb-refs.ts foreign keys
- PostgreSQL 16 (shared with Bam/Banter)
- Redis 7 (for graph service edge caching, session store)
- Qdrant vector DB (semantic search index)
- (Future) Anthropic Embeddings API or equivalent for text embedding
- Banter API (for DM notifications on verification/challenge events)
- Bolt API (event ingestion for beacon lifecycle events)

**Other apps depend on Beacon:**
- Brief (`brief-api/src/routes/documents.routes.ts` POST /documents/:id/promote promotes Brief doc to Beacon; POST /documents/:id/links/beacon links Brief to Beacon)
- Bolt (consumes beacon.created, beacon.updated, beacon.verified, beacon.challenged, beacon.expired events)
- MCP server (29 Beacon tools exposed at /mcp/)

## Open questions

1. **Embedding model choice and latency:** Spec does not specify which embedding model to use. Choice affects latency (chunker job may block on embedding calls) and cost. Should embedding be synchronous in beacon creation flow or async in worker?

2. **Sparse vector strategy:** Qdrant sparse support is relatively new (v1.7+). Spec mentions SPLADE but does not clarify whether to use Qdrant's ModifierBM25 (automatic) or a sidecar sparse encoder. Automatic is simpler but may be slower; sidecar is more control but adds infrastructure.

3. **Notification delivery:** Should verification/challenge notifications go to Banter DM, email, or both? Spec implies both but priority unclear. Are agents notified of verification outcomes?

4. **Graph re-ranking complexity:** Spec §2.2.6 describes multi-signal re-ranking (semantic + freshness + authority + visibility). Current implementation does only freshness. Should implement full cross-encoder re-ranker or is current approach sufficient for MVP?

5. **Contradiction detection semantics:** Spec mentions `ConflictsWith` link type and automated contradiction scanning. How should contradictions be ranked/surfaced? Should they block beacon publication or just flag for human review?

6. **Comments on comments nesting depth:** Spec §2.1.7 allows threaded replies via `parent_id`. Should nesting be limited (e.g., max 3 levels) or unlimited? Frontend layout may constrain this.
