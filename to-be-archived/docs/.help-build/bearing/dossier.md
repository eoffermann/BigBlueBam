# Bearing Dossier (Goals & OKRs)

Research dossier for the **Bearing** app. Sourced from repo code with file paths
cited. Doc/marketing vs. code divergences are called out in **Discrepancies**.

---

## 1. App Identity

- **App key:** `bearing`
- **Display name:** Bearing
- **Category:** Goals & OKRs
- **SPA path:** `/bearing/` (`apps/bearing/src/app.tsx` `BASE_PATH = '/bearing'`)
- **API path:** `/bearing/api/` -> `bearing-api` Fastify on `:4007`, routes under `/v1` (`apps/bearing-api/src/server.ts` lines 99-102; SPA base `/bearing/api/v1`, `apps/bearing/src/lib/api.ts` line 17)
- **Status:** BETA. Sidebar logo has a "beta" pill (`apps/bearing/src/components/layout/bearing-sidebar.tsx` lines 110-113).
- **Prerequisites:**
  - Must already be logged in to BigBlueBam (Bam). Unauthenticated visitors get a "Please log in to BigBlueBam first" screen linking to `/b3/` (`apps/bearing/src/app.tsx` lines 108-120). Auth is Bam session cookie or `bbam_` API key (`apps/bearing-api/src/plugins/auth.ts`).
  - Org context via `X-Org-Id` header from the active org (`apps/bearing/src/lib/api.ts` lines 25-56).
  - **At least one Period must exist and be selected** before goals are usable. Dashboard/at-risk views are gated on a selected period (`DashboardPage.tsx` lines 70-75; goal-list hooks `enabled: !!periodId`, `useGoals.ts` line 117).
- **Backend dir:** `apps/bearing-api/src` (4 routes, 8 schema modules, 5 services)
- **Frontend dir:** `apps/bearing/src` (5 pages)
- **MCP tools file:** `apps/mcp-server/src/tools/bearing-tools.ts` (12 tools)
- **Background jobs:** `apps/worker/src/jobs/bearing-{digest,recompute,snapshot,watcher-notify}.job.ts`

---

## 2. Key Concepts & Vocabulary

**Period** (`bearing_periods`, `apps/bearing-api/src/db/schema/bearing-periods.ts`)
Named time box that goals live inside (e.g. "Q2 2026"). Has `period_type`,
`starts_at`/`ends_at` (date), lifecycle `status`. Unique per org by name. Active
period is the scope for the whole UI.

- **period_type** (shared Zod, `packages/shared/src/schemas/bearing.ts` line 4):
  `annual`, `semi_annual`, `quarterly`, `monthly`, `quarter`, `half`, `year`, `custom`. (Mixed naming - see Discrepancies. SPA only sends `quarter`/`half`/`year`/`custom`.)
- **period status** (`BearingPeriodStatus`, line 5): `planning`, `active`, `completed`, `archived`. DB default `planning`. (UI says `draft` - see Discrepancies.)
- Lifecycle (`period.service.ts`): activate blocked if already `active`/`completed`; complete blocked if `completed`; `archived` only via PATCH; delete -> 409 if period has goals.

**Goal** (`bearing_goals`, `apps/bearing-api/src/db/schema/bearing-goals.ts`)
Objective owned by a user inside a period. `scope`, optional `project_id`/`team_name`,
`icon`, `color`, `status`, `status_override` bool, cached `progress` numeric(5,2).

- **scope** (`BearingGoalScope`): `organization`, `team`, `project`, `individual` (default `organization`).
- **status** (`BearingGoalStatus`, line 7): `draft`, `on_track`, `at_risk`, `behind`, `achieved`, `missed`, `cancelled`. DB default `draft`. (Engine never emits `cancelled`; only via override/update.)
- **status_override**: when true, auto-status engine bypassed (`progress-engine.ts` `computeGoalStatus` line 234).

**Key Result (KR)** (`bearing_key_results`, schema `bearing-key-results.ts`)
Measurable outcome under a goal. `metric_type`, `target_value`, `current_value`,
`start_value`, `unit`, `direction`, `progress_mode`, optional `linked_query`
(JSONB), cached `progress`, optional `owner_id`, `sort_order`.

- **metric_type** (`BearingMetricType`): `percentage`, `number`, `currency`, `boolean`.
- **direction** (`BearingDirection`): `increase`, `decrease`.
- **progress_mode** (`BearingProgressMode`): `manual`, `linked`, `rollup` (route also accepts literal `rollup`, `key-results.ts` line 26).
- Goal progress = average of KR `progress` (`progress-engine.ts` `computeGoalProgress` line 208). KR progress clamped 0-100.

**KR Link** (`bearing_kr_links`, schema `bearing-kr-links.ts`)
Connects a KR to a Bam entity for computed progress. `link_type`, `target_type`,
`target_id` UUID, optional `metadata` (may carry `weight`). Unique on
`(key_result_id, target_type, target_id)`.

- Route `link_type` enum: `epic`, `project`, `task_query`, `task`, `sprint` (line 78).
- Route `target_type` enum: `task`, `epic`, `project`, `sprint`, `goal` (line 79).
- `computeLinkedProgress` (`progress-engine.ts` lines 57-177): epic/project/sprint count Bam tasks where `task_states.category='done'` over total; task/tasks count done linked tasks; goal reads linked goal's `progress`. `metadata.weight` -> weighted average.

**Update / check-in** (`bearing_updates`, schema `bearing-updates.ts`)
Status post against a goal: `status` tag, optional `body`, snapshot columns
`status_at_time`+`progress_at_time` (`goal.service.ts` `createUpdate` lines 335-362).

**Watcher** (`bearing_goal_watchers`) - user subscribed to a goal; unique
`(goal_id, user_id)`; nullable `unsubscribe_token` for email unsubscribe.

**KR Snapshot** (`bearing_kr_snapshots`) - daily value+progress rows for KR
sparklines and goal history chart.

**Auto-status engine** (`apps/bearing-api/src/services/status-engine.ts`):
`expected = days_elapsed / total_days`; `actual >= 1.0 -> achieved`;
`>= expected*0.8 -> on_track`; `>= expected*0.5 -> at_risk`; else `behind`.
Before period start: `draft` (or `achieved`). After end: `missed` (or `achieved`).
This is the "at-risk detection".

---

## 3. REST Route Inventory (backend)

Routes under `/v1`, reached as `/bearing/api/v1/...`. All require `requireAuth`.
Mutations require `requireScope('read_write')` for API-key callers. Several
routes carry `fastify.requireCan(...)` or telemetry-only `shadowOnly(...)` gates
(`apps/bearing-api/src/plugins/permissions.ts`, `middleware/dual-read.ts`).

### Periods (`apps/bearing-api/src/routes/periods.ts`)

| Method | Path | Purpose | Key rules |
|---|---|---|---|
| GET | `/periods` | List periods | query `status`,`year`,`cursor`,`limit`(<=100). Returns `{data,meta}` |
| POST | `/periods` | Create period | body `name`,`period_type`,`starts_at`/`ends_at`(YYYY-MM-DD),`status?`. Validates start<end. Default `planning`. 20/min |
| GET | `/periods/:id` | Get period + stats | adds `stats:{goal_count,avg_progress,at_risk_count}` |
| PATCH | `/periods/:id` | Update period | emits `period.archived` on transition to archived |
| DELETE | `/periods/:id` | Delete period | **409** if period has goals |
| POST | `/periods/:id/activate` | Activate | blocked if `active`/`completed`. Emits `period.activated` |
| POST | `/periods/:id/complete` | Complete | blocked if `completed`. Emits `period.completed` |

### Goals (`apps/bearing-api/src/routes/goals.ts`)

| Method | Path | Purpose | Key rules |
|---|---|---|---|
| GET | `/goals` | List goals | query `period_id`,`scope`,`project_id`,`owner_id`,`status`,`search`(ilike title+desc),`cursor`,`limit`. Org-scoped |
| POST | `/goals` | Create goal | body `period_id`(req),`title`(req),`scope`,`project_id`,`team_name`,`description`,`icon`,`color`,`status`,`owner_id`. Owner defaults to creator. 30/min. Emits `goal.created`. 201 |
| GET | `/goals/:id` | Get goal + KRs | adds recomputed `progress`,`computed_status`,`key_results[]` |
| PATCH | `/goals/:id` | Update goal | edit-gated. Emits `goal.updated` (+`goal.status_changed`,`goal.achieved` on status change) |
| DELETE | `/goals/:id` | Delete goal | edit-gated. Emits `goal.deleted`. 204 |
| POST | `/goals/:id/status` | **Override** status | `{status}`, sets `status_override=true`. Emits `goal.status_changed`(+`goal.achieved`) |
| GET | `/goals/:id/updates` | List updates | asc, limit 500 |
| POST | `/goals/:id/updates` | Post update | `status`(req),`body?`. Snapshots status/progress. Edit-gated. 30/min. 201 |
| GET | `/goals/:id/watchers` | List watchers | |
| POST | `/goals/:id/watchers` | Add self as watcher | always adds **caller** (ignores body). Emits `goal.watcher_added`. 201 |
| DELETE | `/goals/:id/watchers/:userId` | Remove watcher | self always; others need goal owner / org admin-owner (403 else). Emits `goal.watcher_removed`. 204 |
| GET | `/goals/:id/history` | Progress history | aggregates `bearing_kr_snapshots` by `recorded_at` |

**Access** (`apps/bearing-api/src/middleware/authorize.ts`): read = org isolation
(404 cross-org); edit = SuperUser OR org role >= admin OR goal `created_by` OR goal `owner_id`, else 403.

### Key Results (`apps/bearing-api/src/routes/key-results.ts`)

| Method | Path | Purpose | Key rules |
|---|---|---|---|
| GET | `/goals/:id/key-results` | List KRs | by `sort_order` |
| POST | `/goals/:id/key-results` | Create KR | `title`(req),`target_value`,`current_value`,`start_value`,`unit`,`metric_type`,`direction`,`progress_mode`,`linked_query`(strict),`owner_id`,`sort_order`. Emits `kr.created`. 201 |
| GET | `/key-results/:id` | Get KR | 400 bad UUID, 404 cross-org |
| PATCH | `/key-results/:id` | Update KR | recomputes progress; emits `key_result.updated`(+previous_progress/delta). 30/min |
| DELETE | `/key-results/:id` | Delete KR | emits `kr.deleted`. 204 |
| POST | `/key-results/:id/value` | **Set value** (check-in) | `{value}`; writes snapshot; emits `key_result.updated`+`kr.value_updated`. 60/min |
| GET | `/key-results/:id/links` | List links | |
| POST | `/key-results/:id/links` | Add link | `link_type`,`target_type`,`target_id`,`metadata`. Emits `kr.linked`. 201 |
| DELETE | `/key-results/:id/links/:linkId` | Remove link | 204 |
| GET | `/key-results/:id/history` | Snapshot history | drives sparkline |

### Reports & Export (`apps/bearing-api/src/routes/reports.ts`)

| Method | Path | Output |
|---|---|---|
| GET | `/reports/period/:periodId` | markdown period report (summary table + per-goal/KR detail) |
| GET | `/reports/at-risk` | markdown of `at_risk`+`behind` goals org-wide |
| GET | `/reports/owner/:userId` | markdown grouped by period |
| POST | `/reports/generate` | `{type:'period'|'at_risk'|'owner',period_id?,user_id?}`; owner defaults to caller. 10/min |
| GET | `/goals/export` | CSV `goals-export.csv` (exhausts pagination) |
| GET | `/key-results/export` | CSV `key-results-export.csv` (optional `goal_id`) |

> Reports/CSV export have **no Bearing SPA UI** - backend-only, reached via MCP
> `bearing_report`/`bearing_at_risk` or direct URL. See Discrepancies.

---

## 4. Frontend Feature Inventory

Hand-rolled `pushState` router (`apps/bearing/src/app.tsx`). Routes: `/`
(dashboard), `/my-goals`, `/at-risk`, `/periods`, `/goals/:id`, `/help`. Unknown
paths fall back to dashboard. Pressing **`?`** (outside an input) opens the
in-app **Help** viewer (`HelpViewer appSlug="bearing"`).

### 4.0 Sidebar (`components/layout/bearing-sidebar.tsx`)
- Brand: target icon + "Bearing" + **beta** pill.
- **Period scope selector** dropdown sets the global selected period (Zustand `period.store`, persisted to localStorage `bearing_selected_period_id`; auto-selects first `active` period). Entries show a status pill.
- **Nav items** (exact labels): **Dashboard**, **My Goals**, **At Risk**, **Periods**.
- Footer: shared `SidebarPlatformFooter`.

### 4.1 Goals Dashboard - `/` (`pages/DashboardPage.tsx`)
- Header "Goals Dashboard" / "Track objectives and key results across your organization."
- Primary button **"New Goal"** -> Create Goal dialog.
- `PeriodSelector` card (name, date range, `TimeRemainingBadge`).
- Stats row (`ProgressSummary`): four cards **"Total Goals"**, **"Avg Progress"**, **"At Risk"**, **"Achieved"**. Data via `usePeriodReport` -> `GET /periods/:id/report` (**broken - see Discrepancies**).
- Scope tabs (`ScopeFilter`): **All**, **Organization**, **Team**, **Project**, **Individual**.
- Search box placeholder "Search goals..." -> `?search=`.
- Goal grid (`GoalCard`); scope=All groups by scope. Card: target icon, title, scope badge, project/team, ProgressBar (actual vs expected), owner avatar, "{n} KRs". Click -> `/goals/:id`.
- Empty states: "Select a period"; "No goals found" + **"Create First Goal"**.
- **Create Goal dialog** ("Create Goal" / "Set a new objective for this period."): **Title** (ph "e.g., Increase customer retention by 15%"), **Description (optional)** (ph "Why is this goal important?"), **Scope** buttons **Organization/Team/Project** (default Team; omits Individual), **Cancel** / **Create Goal**. Sends `POST /goals` with `owner_id = current user`; navigates to new goal.

### 4.2 My Goals - `/my-goals` (`pages/MyGoalsPage.tsx`)
- Header avatar + "My Goals" / "All goals owned by you across all periods."
- **"New Goal"** button (navigates to dashboard).
- Goals where `owner_id=me` (`GET /goals?filter[owner_id]=...`), split **Active (n)** / **Completed (n)** (`achieved`/`missed`). Row: icon, title, StatusBadge, progress bar, period+scope badges, KR count. Click -> detail.
- Empty: "No goals assigned to you" + **"Go to Dashboard"**.

### 4.3 At Risk - `/at-risk` (`pages/AtRiskPage.tsx`)
- Header "At Risk Goals" / "Goals that are behind expected progress and need attention."
- Period selector. Lists `at_risk`/`behind` goals (`GET /goals?filter[status]=at_risk,behind&sort=progress`), sorted client-side by gap.
- Row: red alert badge, title, StatusBadge, progress bar, "{actual} actual vs {expected} expected", color-coded **Gap**, owner avatar. Click -> detail.
- Empty: "All goals are on track".

### 4.4 Periods - `/periods` (`pages/PeriodListPage.tsx`)
- Header "Periods" / "Manage time periods for organizing goals and OKRs."
- **"New Period"** -> Create Period dialog.
- Table headers: **Name**, **Type**, **Date Range**, **Status**, **Goals**, + row menu.
- Row "..." menu (exact labels): **Edit**; **Activate** (only when status `draft`) -> activate route; **Complete** (only when `active`) -> complete route; **Delete** (confirm) -> delete route.
- **Period Form dialog** (Create/Edit): **Name** (ph "e.g., Q2 2026"), **Type** buttons **Quarter / Half Year / Year / Custom** (values quarter/half/year/custom), **Start Date** + **End Date**, **Cancel** / **Create Period** or **Save Changes**.
- Empty: "No periods yet" + **"Create Period"**.

### 4.5 Goal Detail - `/goals/:id` (`pages/GoalDetailPage.tsx`)
- **Back to Dashboard** link.
- Header: title+description, StatusBadge, "..." menu with **Edit** and **Delete Goal** (window.confirm). Inline edit: Title input + Description textarea + **Save**/**Cancel** (`PATCH /goals/:id`).
- Meta row: owner avatar+name, scope badge, period-name badge, project-name badge.
- Progress bar "{n}% (expected: {m}%)".
- **Key Results** (`KeyResultList`): header "Key Results (n)" + **"Add Key Result"**; empty "No key results yet" + **"Add First Key Result"**. Add/Edit dialog ("Add/Edit Key Result" / "Define a measurable outcome for this goal."): **Title** (ph "e.g., Increase monthly active users"), **Metric Type** buttons **Number / Percentage / Currency / Yes/No**, **Start Value** + **Target Value**, **Unit (optional)** (number/currency only), **Cancel** / **Add Key Result** or **Save Changes**. KR row: metric icon, title, progress bar, sparkline, "current / target". Hover: **"Update"** -> inline number + **Save**/**Cancel** (`POST /key-results/:id/set-value` - **broken path**); "..." menu **Edit** / **Delete** (confirm).
- **Status Updates** (`UpdateFeed`+`PostUpdateDialog`): header "Status Updates" + **"Post Update"**. Dialog ("Post Status Update" / "Share progress with your team."): **Status** chips **On Track / At Risk / Behind / Achieved**, **Update** textarea (ph "What's the latest on this goal? Any blockers?"), **Cancel** / **Post Update** (`POST /goals/:id/updates`). Feed: author, relative time, body, status-at-time badge, "progress at time".
- Right sidebar: **Progress Over Time** chart (recharts "Actual" vs "Expected", via `usePeriodReport` - **broken endpoint**); **Period Timeline** card with `TimeRemainingBadge` (fed `endDate={null}` - inert) + "Created {date}"; **Watchers** card "Watchers (n)" with add form ("User ID or email", `POST /goals/:id/watchers`) and removable chips (backend ignores body, adds caller).

### 4.6 Link components present but NOT wired into any page
`components/links/LinkEditor.tsx` + `ProjectPicker`/`EpicPicker`/`TaskQueryBuilder`
implement a full "Link to Item" dialog ("Connect this key result to a project,
epic, or task query."), but **`LinkEditor` is imported by no page or row**.
KR->entity linking is therefore reachable only via MCP `bearing_kr_link` or REST,
not the human UI. Missing-wiring gap, not a working UI feature.

---

## 5. MCP Tools (`apps/mcp-server/src/tools/bearing-tools.ts`)

12 tools via `registerTool`. Client forwards caller bearer token + `X-Org-Id` to
bearing-api. Name-or-ID resolvers let agents pass labels (period name, goal/KR
title, owner email) instead of UUIDs.

| Tool | Does | Human feature | Backing route |
|---|---|---|---|
| `bearing_periods` | List periods (status/year) | Periods / sidebar selector | `GET /periods` |
| `bearing_period_get` | One period + stats | Period stats | `GET /periods/:id` |
| `bearing_goals` | List goals (period/scope/owner/status/limit) | Dashboard, My Goals | `GET /goals` |
| `bearing_goal_get` | Goal + KRs | Goal detail | `GET /goals/:id` |
| `bearing_goal_create` | Create goal (period by label, owner by email) | New Goal dialog | `POST /goals` |
| `bearing_goal_update` | Update goal (goal by title, owner by email) | Goal edit | `PATCH /goals/:id` |
| `bearing_kr_create` | Create KR (goal by title) | Add Key Result | `POST /goals/:id/key-results` |
| `bearing_kr_update` | Update KR meta and/or value check-in (KR by title) | KR Update/Edit | `PATCH /key-results/:id` + `POST /key-results/:id/value` |
| `bearing_kr_link` | Link KR to Bam entity | (no human UI - link UI unwired) | `POST /key-results/:id/links` |
| `bearing_update_post` | Post goal status update | Post Update dialog | `POST /goals/:id/updates` |
| `bearing_report` | period / at_risk / owner report | (no human UI - reports backend-only) | `GET /reports/period|at-risk|owner` |
| `bearing_at_risk` | Quick at-risk/behind list | At Risk page (conceptually) | `GET /reports/at-risk` |

Resolver notes:
- `resolveKeyResultId` has **no top-level KR list endpoint**, so it walks up to 50 recent goals fetching each goal's KRs to title-match; multiple matches -> null + disambiguation error (lines 124-166).
- `resolveOwnerId` hits the **Bam** api (`/users/by-email`, `/users/search`), not bearing-api (lines 194-205).

Bolt action catalog advertises agent-invokable actions
(`apps/bolt-api/src/services/event-catalog.ts` lines 2769-2774):
`bearing_goal_create`, `bearing_goal_update`, `bearing_kr_create`,
`bearing_kr_update`, `bearing_kr_link`, `bearing_update_post`.

---

## 6. Bolt Events Emitted (automation surface)

`apps/bolt-api/src/services/event-catalog.ts` `bearingEvents`, `source:'bearing'`,
published via `publishBoltEvent(event, 'bearing', ...)`:

`goal.created`, `goal.updated`, `goal.status_changed`, `goal.achieved`,
`goal.deleted`, `goal.watcher_added`, `goal.watcher_removed`,
`key_result.updated`, `kr.created`, `kr.updated`, `kr.value_updated`,
`kr.linked`, `kr.deleted`, `period.activated`, `period.completed`,
`period.archived`.

Lets Bolt react to goals going `at_risk`, being `achieved`, or KR values
crossing thresholds. Payloads are enriched (goal/period/owner/actor/org objects +
legacy flat fields).

---

## 7. Background Jobs (worker)

- **`bearing-snapshot`**: daily midnight-UTC cron; per-KR snapshot row per active period; idempotent upsert on `(key_result_id, snapshot_date)`. Powers sparklines + history chart.
- **`bearing-recompute`**: enqueued on Bam task state change; recomputes linked KR progress -> rolls up to goal -> re-derives status -> invalidates cache. ~1/min/KR debounce. This is "KRs linked to Bam tasks -> automatic progress".
- **`bearing-digest`**: weekly markdown goals summary per org active period, cached in Redis 24h.
- **`bearing-watcher-notify`**: on goal status change, emails all watchers (real SMTP when configured, else log-only). Uses `unsubscribe_token`.

---

## 8. Candidate User Stories

1. **Set up a quarter.** Periods -> New Period -> name "Q2 2026", type Quarter, dates -> Create Period -> row menu Activate -> select in scope selector.
2. **Create an objective.** Dashboard -> New Goal -> Title/Description/Scope -> Create Goal -> goal detail.
3. **Add key results.** Goal detail -> Add Key Result -> Title/Metric Type/Start/Target(+Unit) -> Add Key Result. Repeat.
4. **Record progress (check-in).** KR row hover -> Update -> new value -> Save. Goal % + status auto-recompute.
5. **Post a status update.** Goal detail -> Post Update -> status chip + body -> Post Update.
6. **Triage at-risk goals.** At Risk nav -> review sorted by gap -> open worst -> update / adjust KRs.
7. **Review my own goals.** My Goals nav -> Active vs Completed across periods.
8. **Watch a goal.** Goal detail -> Watchers -> add self -> receive status-change emails (worker).
9. **Override a stuck status.** (REST/MCP) `POST /goals/:id/status` to force e.g. achieved/cancelled.
10. **Close the quarter.** Periods -> row menu Complete (fires `period.completed`); MCP `bearing_report` for retro.
11. **(Agent) Bulk-create OKRs.** `bearing_goal_create` (period label + owner email) then `bearing_kr_create` per KR.
12. **(Agent) Auto-link KRs to delivery.** `bearing_kr_link` binds a KR to a Bam epic/project/sprint so progress tracks real tasks.
13. **(Agent) Weekly status sweep.** `bearing_at_risk` / `bearing_report` then relay summaries (Banter/Brief).

---

## 9. Agent Flows

- **OKR lifecycle:** `bearing_period_get`/`bearing_periods` -> `bearing_goal_create` -> `bearing_kr_create` -> `bearing_kr_update` (value check-ins) -> `bearing_update_post`.
- **Automatic progress wiring:** `bearing_kr_link` connects a KR to a Bam epic/project/sprint/task; `bearing-recompute` worker keeps KR + goal progress current as tasks move to `done`.
- **Reporting/monitoring:** `bearing_report` (period/at_risk/owner) + `bearing_at_risk` return markdown/JSON. Bolt rules subscribe to section-6 events for cross-app reactions.
- **Resolver ergonomics:** human labels resolve to UUIDs; fails closed with disambiguation on ambiguous KR titles.
- **Policy/kill-switch:** every service-account tool call passes the platform `agent_policies` allowlist middleware in `register-tool.ts`.

---

## 10. Screenshots Available

`docs/apps/bearing/screenshots/{light,dark}/`. `meta.json` registers only four
ids per theme (01-dashboard, 02-goal-detail, 03-periods, 04-at-risk), but the
directory and `guide.md` also contain `03-timeline` and `04-reports`.

| File (light & dark) | Depicts | Illustrates |
|---|---|---|
| `01-dashboard.png` | Dashboard: period selector, 4 stat cards, scope tabs, goal grid | Stories 2, 6 |
| `02-goal-detail.png` | Goal detail: status, KR list, updates, watchers, chart | Stories 3,4,5,8 |
| `03-periods.png` | Period list table + row actions | Story 1 |
| `03-timeline.png` | "Timeline" view; **not in meta.json; no dedicated timeline page in code** (closest is goal-detail Period Timeline / progress chart). Verify before captioning | unclear |
| `04-at-risk.png` | At Risk list with gap indicators | Story 6 |
| `04-reports.png` | "Reports" view; **not in meta.json; no reports page in SPA**. Likely rendered report markdown or planned view | unclear |

---

## 11. Discrepancies (docs / marketing / UI vs. code)

1. **Broken frontend->backend endpoint paths** (would 404 / silently no-op as written):
   - `usePeriodReport` calls `GET /periods/:id/report` (`useProgress.ts` line 75). No such route; reports live at `/reports/period/:periodId`. So dashboard stat cards and goal-detail "Progress Over Time" chart have no working data source.
   - `useSetKrValue` POSTs `/key-results/:id/set-value` (`useKeyResults.ts` line 131); route is `/key-results/:id/value`. KR inline Update would fail.
   - `useOverrideStatus` POSTs `/goals/:id/override-status` (`useGoals.ts` line 175); route is `/goals/:id/status`. (No UI calls it - latent.)
   - List filters sent as `filter[scope]`/`filter[status]`/`filter[owner_id]` but backend parses bare `scope`/`status`/`owner_id` (`goals.ts` lines 52-61). Bracketed params + `sort=progress` are ignored, so server-side scope/status/owner filtering does not happen. (At-Risk still works via client-side filtering after fetching all period goals.)

2. **Add-watcher UI vs. behavior.** `WatcherList` sends `{user_id}`, but `POST /goals/:id/watchers` ignores the body and adds the authenticated caller (`goals.ts` line 549). UI implies arbitrary users; API only lets you watch as yourself.

3. **Period status vocabulary mismatch.** Backend uses `planning`->`active`->`completed`->`archived`. Frontend uses `draft` instead of `planning` (`period.store.ts` line 9). A new period is `planning`, but the "Activate" menu item guard checks `status === 'draft'`, which never matches - Activate may not appear for new periods. Verify live.

4. **period_type mixed enum.** `BearingPeriodType` has both `quarterly/semi_annual/annual/monthly` and `quarter/half/year` plus `custom`. SPA only uses `quarter/half/year/custom`.

5. **Reports & CSV export have no human UI.** `guide.md` shows a Reports screenshot and `04-reports.png` exists, but there is no reports page in `apps/bearing/src`. Reachable only via MCP / REST. "Timeline" screenshot likewise has no corresponding page.

6. **KR->entity linking UI is unwired.** Marketing touts "link KRs to Bam tasks for automatic progress"; components exist (`LinkEditor`+pickers) but nothing renders them. Agent/REST-only in this build.

7. **"Goal Hierarchy / parent-child rollup."** Guide/narrative claim it. Schema has **no `parent_goal_id`** (`goals.ts` lines 125, 232 even carry a `// TODO: parent_goal_id - not yet modeled` comment). Goal-to-goal rollup exists only indirectly via a KR `link target_type='goal'`. No true hierarchy.

8. **`progress_mode='rollup'`** accepted by route enum but `computeKrProgress` only special-cases `linked`; `rollup` falls through to the manual formula (`progress-engine.ts` lines 16-45). Behaves like `manual`.

9. **Goal-detail Period Timeline badge** fed `endDate={null}` hard-coded (`GoalDetailPage.tsx` line 199) - inert despite real period dates.

10. **MCP tool count drift.** Code has exactly **12** tools. Docs `guide.md`/`mcp-tools.md` table lists 11 rows (short by one). README/CLAUDE.md variously say 12 and 14. Treat **12** as authoritative.

11. **Status `cancelled`/`draft` unsurfaced.** `cancelled` is in the enum and settable via override/update but no engine path produces it and no UI offers it. `draft` is the create default but the Post-Update chips are only On Track / At Risk / Behind / Achieved.

---

## 12. Open Questions

- What do `03-timeline.png` and `04-reports.png` actually show? No timeline or reports page exists in the current SPA - possibly older build, planned view, or rendered report markdown. Inspect images before captioning.
- Are the broken endpoint paths (11.1) live bugs in the shipped build, or is there nginx/route aliasing papering over them? Nothing in the repo rewrites `/periods/:id/report`->`/reports/period/:id` or `/set-value`->`/value`. Confirm against a running stack whether dashboard stats, progress chart, and KR Update actually work.
- Does the Period Activate item appear for a freshly-created `planning` period given the `planning` vs `draft` mismatch (11.3)?
- Is `LinkEditor` intentionally hidden (feature-flag) or just never wired? No flag visible; appears to be dead UI.
- bearing-api exposes no `/users` endpoint and the SPA has no owner picker (create assigns current user; inline edit has no owner field). How is a goal reassigned to another owner from the UI? Appears UI-impossible (only via MCP `bearing_goal_update` / REST PATCH).
