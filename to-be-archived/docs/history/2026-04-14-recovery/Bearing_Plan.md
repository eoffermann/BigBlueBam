# Bearing Implementation Plan (2026-04-14)

## Scope

Complete Bearing's remaining gaps to reach feature parity with the design. Bearing is 87% complete at `a8fb19a`. Core backend (schema, services, routes, jobs, authorization) and frontend pages are fully functional. Four distinct areas need closure: frontend component gaps (P0), cross-product integrations (P1), watcher notification infrastructure (P1), and observability and caching optimizations (P2).

**In scope:** EpicPicker and TaskQueryBuilder React components with Bam API integration; cross-product integrations (Banter share, Brief embed, Bolt event publishing, Bam goal badges, sprint sidebar); watcher notifications (email first); linked progress validation; Redis cache wiring; observability metrics endpoint.

**Out of scope:** KR weight field (intentionally deferred), cascading goal hierarchies (design non-goal), Brief quarterly template auto-population (Brief team), performance review integration.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | EpicPicker frontend component |
| G2 | P0 | audit §Missing P0 item 2 | TaskQueryBuilder frontend component |
| G3 | P1 | audit §Missing P1 item 3a | Banter share integration for reports |
| G4 | P1 | audit §Missing P1 item 3b | Brief embed Tiptap extension for goal progress |
| G5 | P1 | audit §Missing P1 item 3c | Complete Bolt event publishing audit across all mutation endpoints |
| G6 | P1 | audit §Missing P1 item 3d | Bam goal badge on epic detail page |
| G7 | P1 | audit §Missing P1 item 3e | Sprint planning sidebar widget |
| G8 | P1 | audit §Missing P1 item 5 | Linked progress validation for epic/project/task_query targets |
| G9 | P1 | audit §Missing P1 item 4 | Watcher notifications via email worker |
| G10 | P2 | audit §Missing P2 item 6 | Redis cache wiring in `listGoals` service |
| G11 | P2 | audit §Missing P2 item 7 | Observability `/metrics` endpoint with Prometheus format |

## Migrations

**Reserved slot: 0083.** Bearing likely needs no migrations; slot left for optional schema additions such as an `unsubscribe_token` on `bearing_goal_watchers` if email notifications ship with one-click unsubscribe.

### 0083_bearing_watcher_unsubscribe_token.sql (conditional, only if email notifications land)

**Body:**
```sql
-- 0083_bearing_watcher_unsubscribe_token.sql
-- Why: Support one-click unsubscribe link in watcher notification emails without requiring login.
-- Client impact: additive only. New nullable column; email generation populates it lazily.

ALTER TABLE bearing_goal_watchers
  ADD COLUMN IF NOT EXISTS unsubscribe_token VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_bearing_goal_watchers_unsubscribe_token
  ON bearing_goal_watchers (unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;
```

**Verification:** scratch-DB apply + `\d bearing_goal_watchers`.

If email notifications are deferred to a later phase, slot 0083 remains available.

## Schemas and shared types

All existing types in `packages/shared/src/schemas/bearing.ts` remain unchanged. No new types required for P0 items.

For G9 email notifications, add `watcherNotificationPayloadSchema` to the notification job's types (local to worker).

## API routes and services

**New routes:**
- `POST /reports/:id/share-to-banter` (G3) — Accepts `{ channel_id, report_type }`. Formats markdown via `report-generator.ts`. Calls Banter API client to post a message. Emits `goal.report_shared` Bolt event.
- `GET /metrics` (G11) — Returns Prometheus format. Counts by status, avg progress, stale count, active periods.
- `POST /goals/:id/watchers/:userId/unsubscribe` (G9) — Accepts `?token=<unsubscribe_token>`. Removes watcher. No auth required (token-authenticated).

**Service additions:**
- `goal.service.ts` — `notifyWatchers(goalId, eventType, updateId?)` helper that enqueues `bearing-notify-watchers` job. Called from `createUpdate()` and status-change paths in `updateGoal()`.
- `goal.service.ts listGoals()` (G10) — Call `getCachedGoalProgress()` for each goal in the result set. Invalidate cache on `updateGoal()`, `setCurrentValue()`, `createUpdate()`.

**Bolt event audit (G5):** Review every mutation endpoint in `goals.ts`, `key-results.ts`, `periods.ts` for missing `publishBoltEvent` calls. Required events: `goal.created`, `goal.updated`, `goal.status_changed`, `goal.achieved`, `goal.deleted`, `kr.created`, `kr.updated`, `kr.value_updated`, `kr.linked`, `kr.deleted`, `period.activated`, `period.completed`, `period.archived`, `goal.watcher_added`, `goal.watcher_removed`. Enrich with goal URL, owner email, period name.

## Frontend pages and components

**New components:**
- `apps/bearing/src/components/links/EpicPicker.tsx` (G1) — Search input + dropdown. Calls Bam API `GET /b3/api/epics?search=...`. Props: `onSelect(epicId)`, `defaultEpicId?`, `disabled?`. Follows `ProjectPicker.tsx` pattern.
- `apps/bearing/src/components/links/TaskQueryBuilder.tsx` (G2) — Visual query builder. Renders: `ProjectPicker` (required), label multiselect, phase radio buttons. Outputs `{ project_id, labels: string[], phase: string }`. Consumed by `LinkEditor.tsx`.

**Component updates:**
- `apps/bearing/src/components/links/LinkEditor.tsx` — Conditional render of `EpicPicker` when `link_type === 'epic'` and `TaskQueryBuilder` when `link_type === 'task_query'`.
- `apps/bearing/src/pages/GoalDetailPage.tsx` — Ensure KR progress charts handle epic/project/sprint target types (already supported in progress-engine; verify UI handles all).

## Worker jobs

**New job:** `apps/worker/src/jobs/bearing-notify-watchers.job.ts` (G9)

Payload: `{ goalId, eventType: 'update' | 'status_change', updateId?, watcherIds: string[] }`.

Pipeline:
1. Fetch watchers from bearing-api if not passed.
2. For each watcher, render email via Handlebars template `apps/worker/src/templates/bearing-goal-update.hbs`.
3. Send via SMTP using Nodemailer (pattern from `banter-notification.job.ts`).
4. On send failure, log and continue (best-effort delivery).

Enqueue from `goal.service.ts createUpdate()` and `updateGoal()` (status change path).

## MCP tools

No new tools required. Existing 12 tools (`bearing_periods`, `bearing_period_get`, `bearing_goals`, `bearing_goal_get`, `bearing_goal_create`, `bearing_goal_update`, `bearing_kr_create`, `bearing_kr_update`, `bearing_kr_link`, `bearing_update_post`, `bearing_report`, `bearing_at_risk`) cover all functionality.

Optional enhancement: `bearing_share_report_to_banter(reportId, channelId)` tool wrapping the new G3 endpoint.

## Tests

- `apps/bearing/src/components/__tests__/EpicPicker.test.tsx` (new) — search debouncing, API call, selection callback.
- `apps/bearing/src/components/__tests__/TaskQueryBuilder.test.tsx` (new) — form state, project picker integration, label multiselect, phase radio buttons, output shape.
- `apps/worker/src/jobs/__tests__/bearing-notify-watchers.test.ts` (new) — mock SMTP client, template rendering, failure handling.
- `apps/bearing-api/test/progress-engine-epic.test.ts` (new, G8) — integration test: create epic with 10 tasks (5 done), create KR with epic link, assert progress = 50%, complete another task, trigger recompute, assert 60%.
- `apps/bearing-api/test/goal-list-caching.test.ts` (new, G10) — verify `listGoals` uses cache, verify invalidation on update.
- `apps/bearing-api/test/metrics-endpoint.test.ts` (new, G11) — mock Prometheus client, verify format.
- `apps/bearing-api/test/bolt-events-coverage.test.ts` (new, G5) — verify every mutation endpoint emits the expected event type.

## Verification steps

**Pre-merge QA:**
1. EpicPicker + TaskQueryBuilder manual: create goal, add epic link via picker, add task_query link via builder, verify progress auto-computes.
2. Linked progress for epics (G8): create fixture epic with 10 tasks, link KR, complete tasks, assert progress updates.
3. Watcher notifications (G9, if shipped): add watcher, post update, verify email delivered with goal name and progress.
4. Banter share (G3, if shipped): generate report, click "Share to Banter", verify channel message.
5. Redis cache (G10): list 50 goals, benchmark first vs second request, modify goal, verify invalidation.
6. Metrics (G11): curl `/bearing/api/metrics`, verify Prometheus format.

**Commands:**
```bash
pnpm --filter @bigbluebam/bearing-api build
pnpm --filter @bigbluebam/bearing-api typecheck
pnpm --filter @bigbluebam/bearing-api test
pnpm --filter @bigbluebam/bearing test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations  # only if 0083 was shipped
pnpm db:check
```

## Out of scope

- **KR weight field:** intentionally dropped from schema in favor of polymorphic target model. Re-add only if product decides weight is needed.
- **Cascading goal hierarchies:** design non-goal.
- **Brief quarterly planning template with auto-populated KRs:** owned by Brief team.
- **Performance review or compensation integration:** out of product scope.
- **Bolt event subscription (Bearing listening to Bam task.completed to auto-trigger recompute):** deferred to Cross_Product_Plan.
- **Mobile app, multi-language UI, real-time WebSocket progress:** out of scope for MVP.

## Dependencies

- **Bam API:** requires `GET /b3/api/epics?search=...` endpoint for EpicPicker (G1). Already present per Bam API inventory.
- **Banter API client:** needed for G3 share-to-banter. Banter API already has POST /channels/:id/messages endpoint per Banter audit.
- **Nodemailer + SMTP:** needed for G9 watcher notifications. SMTP config should be in .env already.
- **Bolt API event ingest:** needed for G5 event publishing audit. Already working per Bolt audit.
- **Brief Tiptap extension support:** G4 is cross-product; owned jointly with Brief team.
- **Bam frontend changes:** G6 (goal badge on epic) and G7 (sprint sidebar widget) require changes to `apps/frontend/`. Coordinate with Bam team for Wave 2 scheduling.

**Migration numbers claimed: 0083 (conditional on email notifications). Unused: none if email lands; 0083 otherwise.**
