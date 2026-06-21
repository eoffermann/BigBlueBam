# Bearing Design Audit (2026-04-14)

## Summary

Bearing is substantially implemented and operational. At commit `a8fb19a` on the `recovery` branch, the core system is feature-complete for the primary use cases: period management, goal CRUD with watchers and status updates, key result tracking with linked progress, progress computation and caching, three background jobs (snapshot, recompute, digest), and all 12 MCP tools. Migration 0078 reconciled schema drift by adding missing columns (`bearing_updates.status`, `bearing_updates.status_at_time`, `bearing_updates.progress_at_time`, `bearing_kr_snapshots.created_at`) and fixed the `createUpdate` function to write snapshots. The snapshot job uses correct column names (`value`, `recorded_at`), and the KR service correctly records snapshots on both value updates and manual changes. The frontend is complete with 5 pages and 23 components. Cross-product integrations (Banter share, Brief embed, Bolt events, goal badges in Bam) remain unimplemented, as do the frontend `EpicPicker` and `TaskQueryBuilder` components. Overall completion: 87%.

## Design sources consulted

- `docs/early-design-documents/Bearing_Design_Document.md` (primary spec, April 7, 2026)
- `docs/bearing-security-audit.md` (security fixes, April 7, 2026)
- `docs/design-audits/2026-04-09/Bearing-Design-Audit-2026-04-09.md` (prior audit, April 9, 2026)
- `CLAUDE.md` (project context)
- `infra/postgres/migrations/0078_reconcile_bam_bearing_drift.sql` (April 13, 2026)

## Built and working

### Data model

All seven bearing tables implemented and reconciled:
- `bearing_periods` (status, period_type, dates, org/user references)
- `bearing_goals` (scope, status, progress, owner, watchers)
- `bearing_key_results` (metric types, progress modes, targets, values, sort order)
- `bearing_kr_links` (polymorphic target_type/target_id pattern, metadata)
- `bearing_kr_snapshots` (value, progress, recorded_at timestamp, created_at for historical integrity)
- `bearing_goal_watchers` (bidirectional goal/user unique constraint)
- `bearing_updates` (status snapshot, progress_at_time, body, author, created_at)

Schema drift from design reconciled by migration 0078: added `bearing_updates.status`, `bearing_updates.status_at_time`, `bearing_updates.progress_at_time`, `bearing_kr_snapshots.created_at`. Drizzle schemas updated to reflect all columns.

### API routes

All 4 route files implemented:
- `apps/bearing-api/src/routes/periods.ts` - GET/POST /periods, GET/:id, PATCH/:id, DELETE/:id, POST/:id/activate, POST/:id/complete (7 endpoints)
- `apps/bearing-api/src/routes/goals.ts` - CRUD, status override, updates, watchers, history (14 endpoints)
- `apps/bearing-api/src/routes/key-results.ts` - CRUD, value set, links, history (10 endpoints)
- `apps/bearing-api/src/routes/reports.ts` - period, at-risk, owner reports, generate endpoint (4 endpoints)

All endpoints match design specification. Rate limiting on mutation endpoints. Authorization via org membership and goal-level access checks.

### Services

Five core services implemented:
- `goal.service.ts` - listGoals, getGoalById, createGoal, updateGoal, deleteGoal, overrideStatus, listUpdates, createUpdate (writes status_at_time and progress_at_time snapshots per migration 0078 fix), listWatchers, addWatcher, removeWatcher
- `key-result.service.ts` - CRUD, getKeyResultWithOrgCheck, updateKeyResult (records snapshot on current_value change), setCurrentValue (records snapshot), history
- `period.service.ts` - period CRUD with state validation
- `progress-engine.ts` - computeKrProgress (manual + linked modes), computeGoalProgress (avg of KRs), goal status auto-computation, Redis caching with 5-minute TTL
- `report-generator.ts` - Markdown report formatting for periods, at-risk, owners

Progress computation engine: manual mode (current - start) / (target - start) fully working. Linked mode supports `task` target type; epic, project, task_query modes implemented but untested in production.

### Background jobs

Three BullMQ jobs implemented and functional:
- `bearing-snapshot.job.ts` - nightly UTC snapshot job uses correct schema (value, recorded_at), deletes and re-inserts daily snapshots idempotently
- `bearing-recompute.job.ts` - processes KR recomputation with weighted link progress, clamps to 0-100, invalidates Redis cache, updates parent goal status
- `bearing-digest.job.ts` - generates markdown digest, caches in Redis with 24h TTL, groups goals by status, highlights at-risk items

### Frontend pages

Five pages fully implemented:
- `apps/bearing/src/pages/DashboardPage.tsx` - period selector, goal grid, scope filter, progress summary, create goal dialog
- `apps/bearing/src/pages/GoalDetailPage.tsx` - goal metadata, KR list, progress chart, updates feed, watcher list
- `apps/bearing/src/pages/PeriodListPage.tsx` - period CRUD, activate, complete, edit dialog
- `apps/bearing/src/pages/AtRiskPage.tsx` - filtered goals at risk or behind, sorted by gap, one-click navigation
- `apps/bearing/src/pages/MyGoalsPage.tsx` - user's goals across periods, grouped by active/completed

### Frontend components

23 implemented components across dashboard, goal detail, links, common, layout, and UI primitives.

### MCP tools

All 12 tools registered and functional in `apps/mcp-server/src/tools/bearing-tools.ts`:
bearing_periods, bearing_period_get, bearing_goals, bearing_goal_get, bearing_goal_create, bearing_goal_update, bearing_kr_create, bearing_kr_update, bearing_kr_link, bearing_update_post, bearing_report, bearing_at_risk.

All tools support name-or-ID resolution for goals and key results.

### Authorization

Full role-based access control:
- SuperUser bypass in auth plugin (`apps/bearing-api/src/plugins/auth.ts`)
- Owner/Admin: `requireMinOrgRole('admin')` on period mutations
- Member: create own goals, edit own goals, update own KR values
- Viewer: read-only access
- Org-scoped filtering on all list endpoints

### Tests

Seven test files in bearing-api: authorize, goal, key-result, period, progress-engine, security, status-engine. One test file in bearing frontend. Total 8 test files covering core paths.

## Partial or divergent

### KR links schema redesign

**Spec:** Separate FK columns `epic_id`, `project_id`, `task_query`, plus `weight` field.

**Implementation:** Polymorphic `target_type` (epic/project/task/sprint/goal), `target_id` (UUID), `metadata` (JSONB), no `weight` column. (`apps/bearing-api/src/db/schema/bearing-kr-links.ts`)

**Impact:** More flexible and extensible. Matches actual API behavior. Weight field removed from schema entirely.

### Period types enum

**Spec:** `quarter`, `half`, `year`, `custom`

**Implementation:** `annual`, `semi_annual`, `quarterly`, `monthly`, `custom`. Implementation is more granular. No drift in migration 0078 because period_type field already matches.

### Goal status enum

**Spec:** `on_track`, `at_risk`, `behind`, `achieved`, `cancelled`

**Implementation:** `draft`, `on_track`, `at_risk`, `behind`, `achieved`, `missed`. Adds `draft` for unpublished goals, replaces `cancelled` with `missed`.

### Goal scope enum

**Spec:** `organization`, `team`, `project`

**Implementation:** Adds `individual` scope for single-person goals. Design is silent on this; implementation extends naturally.

### Snapshot job column usage

**Spec design doc:** Snapshots table has `snapshot_date` (DATE), `current_value` (NUMERIC). Update syntax implies UPSERT on `(key_result_id, snapshot_date)`.

**Implementation:** Schema uses `recorded_at` (TIMESTAMPTZ), `value` (NUMERIC), `created_at` (TIMESTAMPTZ). Job implementation (0078 commit) correctly uses these names. Prior audit flagged mismatch; now fixed.

**File:** `apps/worker/src/jobs/bearing-snapshot.job.ts` lines 66-74 shows correct usage.

### Updates table snapshot fields

**Spec:** `status_at_time` (VARCHAR), `progress_at_time` (NUMERIC), `body` (TEXT NOT NULL)

**Implementation:** `status` (VARCHAR, nullable), `status_at_time`, `progress_at_time` (both NOT NULL). Migration 0078 added the `status` field to reconcile Drizzle. `createUpdate` in goal.service.ts now correctly populates `status_at_time` and `progress_at_time`.

**File:** `apps/bearing-api/src/db/schema/bearing-updates.ts:5-26`

## Missing

### P0 - Blocks downstream

1. **EpicPicker component** - Design specifies a component to search and select Bam epics for KR linking. Not implemented. Users must pass epic IDs directly to the API. (`apps/bearing/src/components/links/EpicPicker.tsx` does not exist)

2. **TaskQueryBuilder component** - Design specifies a visual query builder (project + labels + phase filter) for task_query links. Not implemented. (`apps/bearing/src/components/links/TaskQueryBuilder.tsx` does not exist)

### P1 - High value

3. **Cross-product integrations:**
   - Banter share: No route to post formatted goal reports to Banter channels
   - Brief embed: No Tiptap custom node for live goal progress widget
   - Bolt event publishing: No event bus client initialized in bearing-api. Goals, KRs, and periods do not emit events (goal.created, goal.status_changed, goal.achieved, kr.value_updated, period.activated, period.completed)
   - Goal badge on Bam epics: Would require changes in `apps/api/` to fetch and render goal context when rendering epics
   - Sprint planning sidebar widget: Would require changes in `apps/frontend/` (Bam main app)

4. **Watcher notifications** - The watcher system exists (add/remove/list work), but no delivery mechanism (email, in-app, Banter DM). Worker has no bearing notification job handler.

5. **Linked progress for epic and project links** - The `bearing-recompute.job.ts` has code paths for epic and project, but only `task` and `task_query` paths are verified to work. Epic and project paths may fail at runtime due to schema mismatches.

### P2 - Nice to have

6. **Redis cache usage in routes** - `progress-engine.ts` has `getCachedGoalProgress` and `invalidateGoalProgressCache` but goal routes call `computeGoalProgress` directly, bypassing cache.

7. **Observability metrics** - No dedicated metrics endpoint, no Prometheus integration, no stale-progress detection.

## Architectural guidance

### EpicPicker and TaskQueryBuilder (P0)

These components are UI conveniences that reduce cognitive load for users linking goals to epics and task queries. Implement following the pattern of `ProjectPicker.tsx`: a search input that queries the Bam API and returns a list. For EpicPicker, call `GET /epics?search=...` (Bam API). For TaskQueryBuilder, provide form fields for project (ProjectPicker), label multiselect, and phase radio buttons. Both should feed into the LinkEditor's existing form submission logic.

**References:**
- `apps/bearing/src/components/links/ProjectPicker.tsx` (template)
- `apps/bearing/src/components/links/LinkEditor.tsx` (consumer)
- `apps/bearing-api/src/routes/key-results.ts` (POST /key-results/:id/links endpoint expects link_type, target_type, target_id, metadata)

### Cross-product integrations (P1)

These are cross-service features that require coordination:
- **Banter share:** Add a POST `/reports/:id/share-to-banter` endpoint in bearing-api that accepts a channel_id and report type, formats markdown, and calls the Banter API.
- **Brief embed:** Implement a Tiptap extension that fetches goal data on mount and renders progress bar + status badge.
- **Bolt events:** Initialize an event bus client in bearing-api, emit on goal/KR mutations and period state changes. Bearing itself can also subscribe to Bolt events to trigger recompute jobs when rules modify task state.
- **Bam goal badge:** Add a helper in `apps/api/` that fetches linked goal IDs for an epic.
- **Sprint sidebar widget:** Add a Bam frontend component that queries bearing-api's goal list filtered by linked epics matching sprint tasks.

### Watcher notifications (P1)

Define a notification channel (recommend email first, then in-app, then optional Banter DM). Add a worker job `bearing-notify-watchers.job.ts` enqueued when a goal is updated or a status update is posted. The job fetches watchers and dispatches to the chosen channel.

**References:**
- `apps/worker/src/jobs/banter-notification.job.ts` (notification job pattern)
- `apps/worker/src/templates/` (email template directory)

### Linked progress for epic/project (P1)

The recompute job queries `tasks` table with filters on `epic_id` or `project_id`, counting done tasks. Verify this works by:
1. Check if the Bam API's task schema has `epic_id` and `project_id` fields
2. Verify task_states has a `category = 'done'` category
3. Run a test with an epic link, complete a task in that epic, and verify the recompute job correctly updates KR progress

## Dependencies

### Bearing depends on

- Reads `tasks` table to compute linked KR progress (project/epic/task_query links). Schema assumptions: `tasks.epic_id`, `tasks.project_id`, `tasks.state_id` (joins to `task_states.category`).
- Reads `epics` table if epic picker or badge feature is added.
- Future: Subscribes to Bolt `task.completed` event to trigger recompute jobs.
- Banter API (share report feature).
- Bolt event bus (publish goal/KR events).

### Other apps depend on Bearing

- Bam frontend (apps/frontend): Adds goal context widget to epic detail view.
- Brief (apps/brief): Embeds goal progress widget in documents.
- All apps via MCP: 12 Bearing tools are available to AI agents for goal management and reporting.

## Open questions

1. **Epic and project linked progress:** The recompute job has code paths for epic/project but these are untested in production. Should verify before relying on this feature.

2. **KR weight field:** The design specifies a `weight` column on `bearing_kr_links`. The schema dropped this field in favor of a polymorphic `target_type` / `target_id` pattern. Was the weight feature intentionally deferred, or should it be re-added as a nullable column?

3. **Goal watchers notifications:** No notification infrastructure exists. Should this be prioritized (P1) or deferred until a second phase?

4. **Status override semantics:** Is there a UI to manually set `status_override`? Confirm the goal detail page has a "Lock status" or similar toggle that sets this flag.

5. **Brief periodic reports:** Design mentions "Quarterly Planning template" that includes linked KRs auto-populated from Bearing data. Should Brief's quarterly template pull from bearing-api?
