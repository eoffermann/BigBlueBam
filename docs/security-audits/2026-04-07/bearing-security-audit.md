# Bearing Security Audit Fixes

Applied 2026-04-07. Fixes P0 and P1 issues found during security audit.

## P0 Fixes

### P0-1: Cross-org IDOR on key result update
**Status:** Already fixed. `updateKeyResult()` in `key-result.service.ts` already calls `getKeyResultWithOrgCheck(id, orgId)` which joins through the parent goal to verify `organization_id` matches. No code change needed.

### P0-2: Missing rate limits on mutation endpoints
**File:** `apps/bearing-api/src/routes/key-results.ts`
Added `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }` to both PATCH `/key-results/:id` and DELETE `/key-results/:id` endpoints, matching the pattern used by the POST create and set-value endpoints.

### P0-3: Frontend field name mismatches causing blank pages
**Files:**
- `apps/bearing/src/hooks/useGoals.ts` — Rewrote `BearingGoal` interface to match actual API response fields. Changed `progress` from `number` to `string` (API returns numeric string). Made `owner`, `expected_progress`, `period_name`, `project_name`, `key_result_count`, `watcher_count` optional. Removed `parent_goal_id`, `team_id`. Added `organization_id`, `icon`, `color`, `status_override`, `created_by`, `computed_status`, `key_results`.
- `apps/bearing/src/pages/GoalDetailPage.tsx` — Added optional chaining on `goal.owner`, `goal.expected_progress`, `goal.period_name`, `goal.project_name`. Wrapped `Number()` around `goal.progress`.
- `apps/bearing/src/pages/AtRiskPage.tsx` — Added `Number()` conversion for `goal.progress`, null coalescing for `expected_progress`, optional chaining on `goal.owner`.
- `apps/bearing/src/pages/MyGoalsPage.tsx` — Added guards for `progress`, `expected_progress`, `key_result_count`. Changed status filter from `'cancelled'` to `'missed'`.
- `apps/bearing/src/pages/DashboardPage.tsx` — No direct changes needed; fixes propagate through updated `BearingGoal` type.
- `apps/bearing/src/components/dashboard/GoalCard.tsx` — Added guards for `owner`, `progress`, `expected_progress`, `key_result_count`. Added `individual` scope color.
- `apps/bearing/src/components/dashboard/GoalGrid.tsx` — Added `individual` to scope order and labels.
- `apps/bearing/src/components/dashboard/ScopeFilter.tsx` — Added `individual` tab.

## P1 Fixes

### P1-1: MCP tool enum mismatches
**File:** `apps/mcp-server/src/tools/bearing-tools.ts`
- Period status: `['planning', 'active', 'closed']` -> `['planning', 'active', 'completed']`
- Goal scope: `['org', ...]` -> `['organization', ...]` (all three occurrences)
- Goal status: added `'draft'`, replaced `'cancelled'` with `'missed'`
- KR progress_mode: `['manual', 'auto']` -> `['manual', 'linked']`
- KR link tool: replaced `epic_id`/`project_id`/`task_query`/`weight` params with `target_type`/`target_id`/`metadata` to match API's `addLinkSchema`

### P1-2: Schema mismatch between migration SQL and Drizzle ORM
**File:** `infra/postgres/migrations/0029_bearing_schema_alignment.sql`
New idempotent migration that:
- `bearing_kr_links`: drops `epic_id`, `project_id`, `task_query`, `weight`; adds `target_type`, `target_id`, `metadata` with proper indexes and unique constraint
- `bearing_kr_snapshots`: drops `snapshot_date`, `current_value`; adds `value`, `recorded_at` with data migration
- `bearing_goals`: replaces status CHECK (adds `draft`, `missed`; removes `cancelled`), replaces scope CHECK (adds `individual`), changes default status to `draft`
- `bearing_periods`: replaces `period_type` CHECK to match API enum (`annual`, `semi_annual`, `quarterly`, `monthly`, `custom`)

### P1-3: Goal status enum mismatch between API and frontend
**File:** `apps/bearing/src/hooks/useGoals.ts`
- `GoalStatus` type: added `'draft'`, replaced `'cancelled'` with `'missed'`
- `GoalScope` type: added `'individual'`

**File:** `apps/bearing/src/components/goal/StatusBadge.tsx`
- Replaced `cancelled` entry with `missed`, added `draft` entry
- Added fallback for unknown status values

**File:** `apps/bearing/src/hooks/useProgress.ts`
- Changed `cancelled` to `missed` in `PeriodReport` interface

### P1-4: Key result update doesn't record snapshots
**File:** `apps/bearing-api/src/services/key-result.service.ts`
Added snapshot recording in `updateKeyResult()`: when `data.current_value !== undefined`, inserts a row into `bearing_kr_snapshots` with the new value and computed progress, matching the pattern in `setCurrentValue()`.
