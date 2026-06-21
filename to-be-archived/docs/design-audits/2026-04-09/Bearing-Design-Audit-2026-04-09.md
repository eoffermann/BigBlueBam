# Bearing Design Audit

**Date:** 2026-04-09
**Auditor:** Claude Opus 4.6 (automated)
**Scope:** `Bearing_Design_Document.md` v1.0 vs. implemented code in `apps/bearing-api/src/` and `apps/bearing/src/`
**Branch:** `beacon`

---

## 1. Executive Summary

Bearing is **substantially implemented**. The core CRUD for periods, goals, key results, watchers, updates, links, and reports is fully functional across API, frontend, and MCP tooling. The progress computation engine, status auto-computation, Redis caching, daily snapshot job, authorization model, and shared Zod schemas are all in place.

The primary gaps are in cross-product integration features (Banter share, Brief embed, Bolt event bus), two missing frontend picker components, the `bearing:recompute` and `bearing:digest` background jobs, and minor schema deviations between the design document and the implementation.

**Overall Completion: ~82%**

| Rating | Count | Description |
|--------|-------|-------------|
| P0 | 4 | Never implemented |
| P1 | 2 | Stubbed but non-functional |
| P2 | 2 | Partially implemented |
| P3 | 3 | Mostly implemented, notable gaps |
| P4 | 8 | Implemented, minor deviations |
| P5 | 17 | Fully matches design |

---

## 2. Feature Inventory

### 2.1 Data Model

| Feature | Rating | Notes |
|---------|--------|-------|
| `bearing_periods` table | P4 | Implemented. Period types differ: design has `quarter/half/year/custom`, impl has `annual/semi_annual/quarterly/monthly/custom`. Status set differs: design has `planning/active/completed/archived`, impl omits `archived`. |
| `bearing_goals` table | P4 | Implemented. Status enum differs: design has `on_track/at_risk/behind/achieved/cancelled`, impl has `draft/on_track/at_risk/behind/achieved/missed`. Adds `individual` scope not in design. `icon` max length is 50 vs design 10. `color` max length is 20 vs design 7 (hex only). |
| `bearing_key_results` table | P5 | Fully matches design. Precision differs slightly (12,2 vs 15,4) but functionally equivalent. |
| `bearing_kr_links` table | P4 | Redesigned from design: impl uses `target_type`/`target_id` polymorphic pattern instead of separate `epic_id`/`project_id`/`task_query` columns. Also adds `metadata` JSONB. More flexible than design, but structurally different. No `weight` column. |
| `bearing_kr_snapshots` table | P4 | Column names differ: impl uses `value`/`recorded_at` vs design `current_value`/`snapshot_date`. Impl uses timestamp instead of date. No unique constraint on `(key_result_id, snapshot_date)` -- uses auto-generated UUID PK instead. |
| `bearing_goal_watchers` table | P5 | Fully matches design. |
| `bearing_updates` table | P4 | Implemented but differs: design has `status_at_time`/`progress_at_time`/`body` (body NOT NULL), impl has `status`/`body` (body nullable). Missing `progress_at_time` snapshot field. |

### 2.2 API Endpoints -- Periods

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /periods` | P5 | Fully implemented with status/year/cursor filters. |
| `POST /periods` | P5 | Fully implemented with validation. |
| `GET /periods/:id` | P5 | Implemented with summary stats (goal_count, avg_progress, at_risk_count). |
| `PATCH /periods/:id` | P5 | Fully implemented. |
| `DELETE /periods/:id` | P5 | Implemented with referential integrity check (rejects if goals exist). |
| `POST /periods/:id/activate` | P5 | Fully implemented with state guards. |
| `POST /periods/:id/complete` | P5 | Fully implemented. Design says "freeze progress" but implementation just sets status. |

### 2.3 API Endpoints -- Goals

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /goals` | P5 | Fully implemented with all listed filters (period, scope, project, owner, status) plus search. |
| `POST /goals` | P5 | Fully implemented. |
| `GET /goals/:id` | P5 | Returns goal with key results, computed progress and status. |
| `PATCH /goals/:id` | P5 | Fully implemented. |
| `DELETE /goals/:id` | P5 | Fully implemented. |
| `POST /goals/:id/status` | P5 | Status override implemented, sets `status_override = true`. |
| `GET /goals/:id/updates` | P5 | Fully implemented. |
| `POST /goals/:id/updates` | P4 | Implemented but schema differs from design. Takes `status` + optional `body` instead of just `body` with auto-captured `status_at_time`/`progress_at_time`. |
| `GET /goals/:id/watchers` | P5 | Fully implemented. |
| `POST /goals/:id/watchers` | P5 | Implemented with upsert (onConflictDoNothing). |
| `DELETE /goals/:id/watchers/:userId` | P5 | Implemented with self-remove, goal-owner, and admin checks. |
| `GET /goals/:id/history` | P5 | Implemented via aggregate snapshot query. |

### 2.4 API Endpoints -- Key Results

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /goals/:id/key-results` | P5 | Fully implemented. |
| `POST /goals/:id/key-results` | P5 | Fully implemented with progress computation on create. |
| `GET /key-results/:id` | P5 | Implemented with org check. |
| `PATCH /key-results/:id` | P5 | Implemented with progress recomputation and snapshot recording. |
| `DELETE /key-results/:id` | P5 | Implemented with org check. |
| `POST /key-results/:id/value` | P5 | Implemented. Computes progress and records snapshot. |
| `GET /key-results/:id/links` | P5 | Fully implemented. |
| `POST /key-results/:id/links` | P5 | Implemented with cross-org validation. |
| `DELETE /key-results/:id/links/:linkId` | P5 | Implemented with org ownership check. |
| `GET /key-results/:id/history` | P5 | Fully implemented. |

### 2.5 API Endpoints -- Reports

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /reports/period/:periodId` | P5 | Generates Markdown report with summary stats and per-goal details. |
| `GET /reports/at-risk` | P5 | Filters at_risk/behind goals with KR details. |
| `GET /reports/owner/:userId` | P5 | Generates per-user goals report grouped by period. |
| `POST /reports/generate` | P5 | Dispatches to the appropriate report generator. |

### 2.6 Progress Computation Engine

| Feature | Rating | Notes |
|---------|--------|-------|
| Manual progress computation | P5 | `(current - start) / (target - start)` with direction support. |
| Linked progress computation | P3 | Only `task` target type implemented. Design specifies `epic`, `project`, and `task_query` link types with weighted progress. Epic/project/task_query computations return 0. |
| Goal progress (avg of KRs) | P5 | Implemented via SQL `AVG()`. |
| Status auto-computation | P5 | Matches design formula: achieved/on_track/at_risk/behind thresholds. Adds `draft` and `missed` states beyond design. |
| Redis caching (5min TTL) | P3 | Cache get/set/invalidate implemented, but `getCachedGoalProgress` is never actually called by route handlers. `getGoal` calls `computeGoalProgress` directly every time. |
| Cache invalidation on task complete | P0 | No integration with Bam task completion events. |

### 2.7 Background Jobs (BullMQ)

| Feature | Rating | Notes |
|---------|--------|-------|
| `bearing:snapshot` (daily) | P3 | Job processor exists (`bearing-snapshot.job.ts`) and correctly snapshots KRs. However, the snapshot table schema in the job uses `snapshot_date` column but the Drizzle schema uses `recorded_at` -- this would fail at runtime. Also uses `current_value` column name but Drizzle schema has `value`. |
| `bearing:recompute` (on task complete) | P0 | Not implemented. No recompute job exists. |
| `bearing:digest` (weekly) | P0 | Not implemented. No digest job exists. |

### 2.8 MCP Tools

| Tool | Rating | Notes |
|------|--------|-------|
| `bearing_periods` | P5 | Fully implemented. |
| `bearing_period_get` | P5 | Fully implemented. |
| `bearing_goals` | P5 | Fully implemented with all filters. |
| `bearing_goal_get` | P5 | Fully implemented. |
| `bearing_goal_create` | P5 | Fully implemented. |
| `bearing_goal_update` | P5 | Fully implemented. |
| `bearing_kr_create` | P5 | Fully implemented. |
| `bearing_kr_update` | P5 | Dual path: updates meta and/or posts value check-in. |
| `bearing_kr_link` | P5 | Fully implemented. |
| `bearing_update_post` | P5 | Fully implemented. |
| `bearing_report` | P5 | Fully implemented with period/at_risk/owner types. |
| `bearing_at_risk` | P5 | Fully implemented. |

All 12 MCP tools from the design are implemented.

### 2.9 Frontend -- Pages

| Page | Rating | Notes |
|------|--------|-------|
| `DashboardPage` | P5 | Goal grid, period selector, progress summary, scope filter, create dialog, search. Matches design. |
| `GoalDetailPage` | P5 | Title, description, owner, status badge, progress bar, KR list, updates feed, watcher list, progress chart, edit/delete actions. |
| `PeriodListPage` | P5 | Table with CRUD, activate/complete actions, edit dialog. |
| `AtRiskPage` | P5 | Filtered list sorted by most behind, gap indicator. |
| `MyGoalsPage` | P5 | User's goals across periods, grouped by active/completed. |

### 2.10 Frontend -- Components

| Component | Rating | Notes |
|-----------|--------|-------|
| `PeriodSelector` | P5 | Dropdown to switch period, stored in Zustand with localStorage persistence. |
| `GoalCard` | P5 | Card with title, progress bar, status badge. |
| `GoalGrid` | P5 | Responsive grid, groups by scope when "all" filter. |
| `ProgressSummary` | P5 | Org-level stats bar. |
| `ScopeFilter` | P5 | Tab-style filter for scope. |
| `KeyResultRow` | P5 | Progress bar, current/target values, inline update, edit/delete. |
| `KeyResultList` | P5 | List with create/edit dialog. |
| `ProgressChart` | P5 | Recharts line chart with actual vs expected. |
| `StatusBadge` | P5 | Color-coded status badges. |
| `UpdateFeed` | P5 | Chronological status updates. |
| `PostUpdateDialog` | P5 | Form for posting status updates. |
| `WatcherList` | P5 | Avatar list with add/remove. |
| `ProgressBar` | P5 | Animated bar with optional expected line. |
| `TimeRemainingBadge` | P5 | Renders time remaining. |
| `LinkEditor` | P5 | Add/remove links with type selector and project picker. |
| `ProjectPicker` | P5 | Search and select Bam projects. |
| `EpicPicker` | P0 | Not implemented. Design specifies a component to search/select Bam epics. |
| `TaskQueryBuilder` | P0 | Not implemented. Design specifies a query builder for project + labels + phase filter. |

### 2.11 Frontend -- Hooks & Stores

| Feature | Rating | Notes |
|---------|--------|-------|
| `useGoals` | P5 | List, detail, create, update, delete, override status, updates, watchers, history. |
| `useKeyResults` | P5 | List, detail, create, update, delete, set value, links, history. |
| `usePeriods` | P5 | List, detail, create, update, delete, activate, complete. |
| `useProgress` | P5 | At-risk goals, my goals, period report. |
| `periodStore` (Zustand) | P5 | Selected period with localStorage persistence. |

### 2.12 Shared Zod Schemas (`@bigbluebam/shared`)

| Feature | Rating | Notes |
|---------|--------|-------|
| Enum schemas | P3 | Partially aligned. Shared schemas match design doc enums but bearing-api routes define their own local schemas that diverge (e.g., `individual` scope, `draft`/`missed` statuses, `annual`/`semi_annual`/`monthly` period types). The API does not import from `@bigbluebam/shared`. |
| CRUD schemas | P4 | Shared package has all schemas but API re-declares its own. Not a single source of truth as intended. |

### 2.13 Authorization Model

| Feature | Rating | Notes |
|---------|--------|-------|
| SuperUser bypass | P5 | Implemented in auth plugin and middleware. |
| Owner/Admin: full CRUD | P5 | `requireMinOrgRole('admin')` on periods; goal edit via `requireGoalEditAccess`. |
| Member: create in own projects, edit own goals | P5 | Creator and owner checks in `requireGoalEditAccess`. |
| Viewer: read-only | P5 | Default access is read via `requireAuth` only. |
| Watcher notifications | P1 | Watcher records exist, but no notification delivery is implemented. |

### 2.14 Cross-Product Integration

| Feature | Rating | Notes |
|---------|--------|-------|
| Progress reads from Bam (tasks/epics) | P2 | `computeLinkedProgress` only handles `task` target_type. Epic and project link progress always returns 0. |
| Goal badge on Bam epics | P0 | Not implemented. Would require changes in `apps/api/` (the Bam API). |
| Sprint planning sidebar widget | P0 | Not implemented. Would require changes in `apps/frontend/`. |
| Share report to Banter | P0 | Not implemented. No Banter integration. |
| Weekly digest via Bolt | P0 | Not implemented. No Bolt integration. |
| Goal achievement notification to Banter | P0 | Not implemented. |
| Brief embed (live goal progress widget) | P0 | Not implemented. |
| Brief quarterly planning template | P0 | Not implemented. |
| Bolt event publishing | P1 | No event bus integration. Events like `goal.created`, `goal.status_changed`, etc. are not published. |

### 2.15 Observability & Metrics

| Feature | Rating | Notes |
|---------|--------|-------|
| Goal count by status/period | P2 | Period stats query exists but no dedicated metrics endpoint or Prometheus export. |
| KR progress computation latency | P0 | No instrumentation. |
| Snapshot job duration | P0 | No metrics beyond BullMQ default. |
| Stale progress detection | P0 | Not implemented. |
| Goals per user distribution | P0 | Not implemented. |

---

## 3. Detailed Findings for P0-P3 Items

### P0: Never Implemented

**3.1 EpicPicker component** (`apps/bearing/src/components/links/EpicPicker.tsx`)
- Design specifies a picker to search and select Bam epics for linking to key results.
- The `LinkEditor` component exists and handles project linking, but epic selection requires manual ID entry.

**3.2 TaskQueryBuilder component** (`apps/bearing/src/components/links/TaskQueryBuilder.tsx`)
- Design specifies a visual query builder (project + labels + phase filter) for task_query links.
- Not even stubbed. Users would need to construct task queries via the API directly.

**3.3 Cross-product integrations (Bam badge, Banter share, Brief embed, Bolt events)**
- These features span multiple services and are expected as later-phase work.
- No code, stubs, or placeholders exist in any of the relevant codebases.

**3.4 `bearing:recompute` and `bearing:digest` background jobs**
- Design specifies two additional BullMQ jobs beyond the daily snapshot.
- `bearing:recompute` would debounce-recompute linked KR progress on Bam task completion.
- `bearing:digest` would generate weekly goal summaries.
- Neither job exists.

**3.5 Cache invalidation on task completion**
- The Redis cache infrastructure exists (`getCachedGoalProgress`, `invalidateGoalProgressCache`) but is never wired to external events.

### P1: Stubbed but Non-Functional

**3.6 Watcher notifications**
- `bearing_goal_watchers` table and CRUD operations are fully functional.
- However, watchers never receive any notification (email, in-app, or Banter message).
- The worker has no bearing notification job handler.

**3.7 Bolt event publishing**
- No event bus client is initialized in bearing-api.
- Goal/KR lifecycle events (`goal.created`, `goal.status_changed`, `goal.achieved`, `kr.value_updated`, `period.activated`, `period.completed`) are not emitted.

### P2: Partially Implemented

**3.8 Linked progress computation**
- `computeLinkedProgress` in `progress-engine.ts` only handles `task`/`tasks` target types.
- Epic completion, project completion, and task_query evaluation all return 0.
- The design's weighted-average-across-links logic is not implemented.

**3.9 Observability metrics**
- Basic aggregation exists in `getPeriod` (goal_count, avg_progress, at_risk_count).
- No dedicated metrics endpoint, no Prometheus integration, no stale-detection queries.

### P3: Mostly Implemented, Notable Gaps

**3.10 Daily snapshot job**
- The job processor exists and has correct logic (iterate active periods, snapshot all KRs).
- Column name mismatch: job writes `snapshot_date` and `current_value`, but Drizzle schema has `recorded_at` and `value`. This would cause a runtime SQL error.
- The upsert ON CONFLICT references `(key_result_id, snapshot_date)` but the table has no such unique constraint (the Drizzle schema only has single-column indexes).

**3.11 Redis progress caching**
- `getCachedGoalProgress` and `invalidateGoalProgressCache` are implemented with correct 5-minute TTL.
- Neither function is called from any route handler. `getGoal` calls `computeGoalProgress` directly.
- Cache warming and invalidation on external events are missing.

**3.12 Shared Zod schemas divergence**
- `packages/shared/src/schemas/bearing.ts` exists with design-matching schemas.
- `apps/bearing-api/src/routes/*.ts` define their own local schemas with divergent enum values.
- The API does not import from `@bigbluebam/shared`, violating the "single source of truth" principle.

---

## 4. P4-P5 Items (Brief Summary)

### P4 (Minor Deviations)

- **Period types**: Impl adds `annual`, `semi_annual`, `monthly`; design has `quarter`, `half`, `year`, `custom`.
- **Goal statuses**: Impl adds `draft`, `missed`; design has `cancelled`.
- **Goal icon/color**: Relaxed validation (50/20 chars vs 10/7 hex-only).
- **KR links schema**: Polymorphic `target_type`/`target_id` pattern replaces per-type FK columns. No `weight` column on links.
- **Snapshot columns**: `recorded_at`/`value` vs `snapshot_date`/`current_value`.
- **Updates table**: Missing `progress_at_time` column; `body` is nullable.
- **Shared schemas**: Exist but not used by API routes.

### P5 (Fully Matching)

All period CRUD + lifecycle endpoints, goal CRUD + status override + watchers + updates + history, key result CRUD + value set + links + history, all 4 report endpoints, all 12 MCP tools, all 5 frontend pages, all 16 implemented frontend components, all 4 hook modules, Zustand period store, auth plugin with session + API key + impersonation, authorization middleware with role hierarchy and goal-level access control.

---

## 5. Recommendations

### High Priority

1. **Fix snapshot job column mismatch** -- Update `bearing-snapshot.job.ts` to use `value` and `recorded_at` column names matching the Drizzle schema, or add a unique constraint and `snapshot_date`/`current_value` columns. Currently the nightly job would fail at runtime.

2. **Wire Redis caching into route handlers** -- `getGoal` should call `getCachedGoalProgress` instead of `computeGoalProgress` directly. The cache infrastructure is built but unused.

3. **Implement epic/project linked progress** -- Extend `computeLinkedProgress` to handle `epic`, `project`, and `task_query` target types with completion ratios.

4. **Consolidate Zod schemas** -- Make bearing-api import from `@bigbluebam/shared` instead of re-declaring schemas. Reconcile enum differences (add `draft`/`missed` to shared, or justify the divergence).

### Medium Priority

5. **Implement `bearing:recompute` job** -- Wire Bam task-completion events (via Bolt or direct webhook) to trigger debounced KR progress recalculation.

6. **Add `EpicPicker` and `TaskQueryBuilder`** frontend components to complete the link editor UX.

7. **Add `progress_at_time` to `bearing_updates`** -- Capture progress snapshot when updates are posted, matching the design.

8. **Add `weight` column to `bearing_kr_links`** -- Enable proportional contribution from multiple linked entities.

### Lower Priority

9. **Cross-product integrations** (Banter share, Brief embed, Bolt events) -- These are cross-service features that require coordinated work across multiple apps. Plan as a dedicated sprint.

10. **Watcher notifications** -- Define notification channel (email, in-app, Banter DM) and implement delivery in the worker.

11. **Observability** -- Add basic Prometheus metrics for goal counts, computation latency, and stale-progress detection.

---

*End of audit.*
