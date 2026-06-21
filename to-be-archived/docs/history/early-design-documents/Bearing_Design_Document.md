# Bearing — Goals & OKRs for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 7, 2026
**Product:** Bearing (Goals & OKRs)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Bearing is the strategy-to-execution layer for the BigBlueBam suite. It connects quarterly objectives to the daily task work happening in Bam, giving leadership real-time visibility into whether the team is on track — without requiring manual progress updates.

Bearing is deliberately lightweight. The hierarchy is: **Goal → Key Result → linked Epics/Projects**. No nested goal trees, no strategy maps, no cascading dependency chains. The value is in the rollup, not the taxonomy.

### 1.2 Core Principles

1. **Automatic progress.** Key Results linked to Bam epics or task queries update their progress as tasks complete. No one manually drags a slider to 73%.
2. **Cross-project rollup.** A single goal can draw progress from multiple Bam projects, giving org-level visibility without requiring uniform project structure.
3. **Time-boxed by default.** Goals have time periods (quarters, halves, custom). Bearing assumes you're running cadenced planning cycles.
4. **AI reporting via MCP.** Agents can generate goal status reports, flag at-risk objectives, and post summaries to Banter — the same weekly status update that takes a human 45 minutes becomes a one-line agent action.
5. **Complement, don't compete.** Bearing does not replace Bam's sprint-level execution. Sprints are "how we work this week." Bearing is "why we're working on this at all."

### 1.3 Non-Goals

- Bearing is **not** a full OKR platform (no Gtmhub/Viva Goals). No scoring rubrics, no OKR coaches, no "check-in" ceremonies.
- Bearing does **not** support goal dependencies or cascading alignment beyond the two-level hierarchy (Goal → KR). Organizational alignment is conveyed by shared goals, not by wiring goals to other goals.
- Bearing does **not** include compensation or performance review integration. Goals inform strategy, not HR decisions.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  bearing-api/        → Fastify REST API (goals, key results, progress, reporting)
  bearing/            → React SPA (goal dashboard, timeline, detail views)
```

Bearing is architecturally simple. No WebSocket (progress updates are polled via TanStack Query refetch), no separate vector DB, no background collaboration server. It reads from Bam's database to compute progress.

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **bearing-api** (Fastify :4007) | REST API for goals, key results, progress snapshots, reporting |
| **PostgreSQL 16** | Goal definitions, key results, progress history (shared DB) |
| **Redis 7** | Cache for computed progress (avoids recalculating on every page load) |

### 2.3 nginx Routing

```nginx
location /bearing/ {
    alias /usr/share/nginx/html/bearing/;
    try_files $uri $uri/ /bearing/index.html;
}

location /bearing/api/ {
    proxy_pass http://bearing-api:4007/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.4 Docker Service

```yaml
bearing-api:
  build:
    context: .
    dockerfile: apps/bearing-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - SESSION_SECRET=${SESSION_SECRET}
  ports:
    - "4007:4007"
  depends_on:
    - postgres
    - redis
```

---

## 3. Data Model

### 3.1 Entity Relationship Overview

```
organizations ──1:N──► bearing_periods ──1:N──► bearing_goals ──1:N──► bearing_key_results
                                                      │                        │
                                                      │                ┌───────┴───────┐
                                                      │                ▼               ▼
                                                      │        bearing_kr_links  bearing_kr_snapshots
                                                      │         (→ epics/projects/task queries)
                                                      ▼
                                              bearing_goal_watchers
```

### 3.2 PostgreSQL Schema

```sql
-- ============================================================
-- BEARING: Goals & OKRs
-- ============================================================

-- Time periods (quarters, halves, custom)
CREATE TABLE bearing_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,       -- e.g., "Q2 2026", "H1 2026", "FY2026"
    period_type     VARCHAR(20) NOT NULL
                    CHECK (period_type IN ('quarter', 'half', 'year', 'custom')),
    starts_at       DATE NOT NULL,
    ends_at         DATE NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning', 'active', 'completed', 'archived')),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name),
    CHECK (ends_at > starts_at)
);

CREATE INDEX idx_bearing_periods_org ON bearing_periods(organization_id);
CREATE INDEX idx_bearing_periods_status ON bearing_periods(status);

-- Goals (top-level objectives)
CREATE TABLE bearing_goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    period_id       UUID NOT NULL REFERENCES bearing_periods(id) ON DELETE CASCADE,
    -- Scope: org-wide or team/project-scoped
    scope           VARCHAR(20) NOT NULL DEFAULT 'organization'
                    CHECK (scope IN ('organization', 'team', 'project')),
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,  -- for project-scoped goals
    team_name       VARCHAR(100),                                     -- for team-scoped goals (freeform label)
    -- Goal definition
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    icon            VARCHAR(10),                 -- emoji
    color           VARCHAR(7),                  -- hex color for dashboard cards
    -- Status
    status          VARCHAR(20) NOT NULL DEFAULT 'on_track'
                    CHECK (status IN ('on_track', 'at_risk', 'behind', 'achieved', 'cancelled')),
    status_override BOOLEAN NOT NULL DEFAULT false,  -- true = status set manually, not computed
    -- Computed progress (0.0 – 1.0, averaged from key results)
    progress        NUMERIC(5,4) NOT NULL DEFAULT 0.0,
    -- Ownership
    owner_id        UUID NOT NULL REFERENCES users(id),
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bearing_goals_org ON bearing_goals(organization_id);
CREATE INDEX idx_bearing_goals_period ON bearing_goals(period_id);
CREATE INDEX idx_bearing_goals_owner ON bearing_goals(owner_id);
CREATE INDEX idx_bearing_goals_project ON bearing_goals(project_id);
CREATE INDEX idx_bearing_goals_status ON bearing_goals(status);

-- Key Results (measurable outcomes under a goal)
CREATE TABLE bearing_key_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id         UUID NOT NULL REFERENCES bearing_goals(id) ON DELETE CASCADE,
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    -- Metric definition
    metric_type     VARCHAR(20) NOT NULL DEFAULT 'percentage'
                    CHECK (metric_type IN ('percentage', 'number', 'currency', 'boolean')),
    target_value    NUMERIC(15,4) NOT NULL,       -- e.g., 100.0 (%), 50 (count), 1000000.00 ($)
    current_value   NUMERIC(15,4) NOT NULL DEFAULT 0.0,
    start_value     NUMERIC(15,4) NOT NULL DEFAULT 0.0,
    unit            VARCHAR(20),                  -- e.g., '%', 'users', 'USD', 'tickets'
    -- Direction: are we trying to increase or decrease?
    direction       VARCHAR(10) NOT NULL DEFAULT 'increase'
                    CHECK (direction IN ('increase', 'decrease')),
    -- Progress source
    progress_mode   VARCHAR(20) NOT NULL DEFAULT 'manual'
                    CHECK (progress_mode IN ('manual', 'linked', 'rollup')),
    -- For 'linked' mode: a task query that computes progress
    linked_query    JSONB,
    -- Computed progress (0.0 – 1.0)
    progress        NUMERIC(5,4) NOT NULL DEFAULT 0.0,
    -- Ownership
    owner_id        UUID REFERENCES users(id),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bearing_kr_goal ON bearing_key_results(goal_id);
CREATE INDEX idx_bearing_kr_owner ON bearing_key_results(owner_id);

-- Links between Key Results and Bam entities (epics, projects)
CREATE TABLE bearing_kr_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_result_id   UUID NOT NULL REFERENCES bearing_key_results(id) ON DELETE CASCADE,
    link_type       VARCHAR(20) NOT NULL
                    CHECK (link_type IN ('epic', 'project', 'task_query')),
    -- Exactly one of these is populated based on link_type
    epic_id         UUID,                        -- references Bam epics table
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    task_query       JSONB,                       -- { "project_id": "...", "labels": ["..."], "phase": "Done" }
    -- Weight for contribution to KR progress (default 1.0, allows proportional credit)
    weight          NUMERIC(5,2) NOT NULL DEFAULT 1.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (key_result_id, epic_id),
    UNIQUE (key_result_id, project_id)
);

CREATE INDEX idx_bearing_krl_kr ON bearing_kr_links(key_result_id);

-- Progress snapshots (daily snapshot for charting progress over time)
CREATE TABLE bearing_kr_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_result_id   UUID NOT NULL REFERENCES bearing_key_results(id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL,
    current_value   NUMERIC(15,4) NOT NULL,
    progress        NUMERIC(5,4) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (key_result_id, snapshot_date)
);

CREATE INDEX idx_bearing_snap_kr ON bearing_kr_snapshots(key_result_id);
CREATE INDEX idx_bearing_snap_date ON bearing_kr_snapshots(snapshot_date);

-- Goal watchers (users who receive status updates)
CREATE TABLE bearing_goal_watchers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id         UUID NOT NULL REFERENCES bearing_goals(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (goal_id, user_id)
);

-- Status update notes (periodic check-in notes from goal owner)
CREATE TABLE bearing_updates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id         UUID NOT NULL REFERENCES bearing_goals(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    status_at_time  VARCHAR(20) NOT NULL,     -- snapshot of goal status when update was written
    progress_at_time NUMERIC(5,4) NOT NULL,   -- snapshot of goal progress
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bearing_updates_goal ON bearing_updates(goal_id);
```

---

## 4. Progress Computation Engine

### 4.1 Progress Modes

Each Key Result has a `progress_mode`:

| Mode | How progress is computed |
|------|------------------------|
| **manual** | User (or agent) sets `current_value` directly via API/UI. Progress = `(current_value - start_value) / (target_value - start_value)`. |
| **linked** | Progress is computed from linked Bam entities via `bearing_kr_links`. Each linked entity contributes proportionally to KR progress. |
| **rollup** | KR progress = weighted average of sub-KRs. (Reserved for future nested KR support; for now, only `manual` and `linked` are active.) |

### 4.2 Linked Progress Computation

For `linked` mode, the progress engine queries Bam:

**Epic link:** `progress = (tasks completed in epic) / (total tasks in epic)`, weighted by the link's `weight` value.

**Project link:** `progress = (tasks completed in project) / (total tasks in project)`, weighted.

**Task query link:** A JSONB query evaluated against Bam tasks (e.g., `{ "project_id": "...", "labels": ["launch-blocker"], "phase": "Done" }`). Progress = `(matching tasks) / (total tasks matching the non-phase filters)`.

If multiple links exist for a KR, progress is the weighted average across all links.

### 4.3 Goal Progress

Goal progress = average of all Key Result progress values (equally weighted). Can be overridden to a weighted average if weights are specified on KRs (via `sort_order` repurposing or a future `weight` column on `bearing_key_results`).

### 4.4 Goal Status Auto-Computation

Unless `status_override` is true, goal status is computed from progress relative to elapsed time in the period:

```
expected_progress = (days_elapsed / total_days)
actual_progress   = goal.progress

if actual >= 1.0            → achieved
if actual >= expected * 0.8 → on_track
if actual >= expected * 0.5 → at_risk
else                        → behind
```

### 4.5 Caching

Computed progress is cached in Redis with a 5-minute TTL:

```
bearing:progress:kr:{kr_id}  → { value, progress, computed_at }
bearing:progress:goal:{goal_id} → { progress, status, computed_at }
```

The cache is invalidated when:
- A linked task is completed/reopened (via Bolt event or webhook from Bam API)
- A KR is manually updated
- The cache TTL expires

### 4.6 Daily Snapshots

A BullMQ job (`bearing:snapshot`) runs at midnight UTC, computing and persisting progress for every active KR into `bearing_kr_snapshots`. These snapshots power the progress-over-time charts.

---

## 5. API Design

### 5.1 Fastify Application Structure

```
apps/bearing-api/
  src/
    index.ts
    plugins/
      auth.ts
      redis.ts
    routes/
      periods.ts          → CRUD, activate, complete, archive
      goals.ts            → CRUD, status, progress, watchers, updates
      key-results.ts      → CRUD, manual progress update, links
      reports.ts          → Goal summary, period report, at-risk goals
    services/
      progress-engine.ts  → Linked progress computation from Bam data
      status-engine.ts    → Auto-status computation
      snapshot.ts         → Daily snapshot logic
      report-generator.ts → Formatted reports for Banter/Brief sharing
    db/
      schema.ts
      queries.ts
```

### 5.2 REST Endpoints

#### Periods

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/periods` | List periods (filterable by status, year) |
| `POST` | `/periods` | Create period |
| `GET` | `/periods/:id` | Get period with summary stats |
| `PATCH` | `/periods/:id` | Update period (name, dates, status) |
| `DELETE` | `/periods/:id` | Delete period (cascades goals) |
| `POST` | `/periods/:id/activate` | Set period to active |
| `POST` | `/periods/:id/complete` | Set period to completed, freeze progress |

#### Goals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/goals` | List goals (filterable by period, scope, project, owner, status) |
| `POST` | `/goals` | Create goal |
| `GET` | `/goals/:id` | Get goal with key results, progress, and links |
| `PATCH` | `/goals/:id` | Update goal metadata |
| `DELETE` | `/goals/:id` | Delete goal |
| `POST` | `/goals/:id/status` | Override status manually |
| `GET` | `/goals/:id/updates` | List status update notes |
| `POST` | `/goals/:id/updates` | Post a status update note |
| `GET` | `/goals/:id/watchers` | List watchers |
| `POST` | `/goals/:id/watchers` | Add watcher |
| `DELETE` | `/goals/:id/watchers/:userId` | Remove watcher |
| `GET` | `/goals/:id/history` | Progress-over-time data from snapshots |

#### Key Results

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/goals/:id/key-results` | List KRs for a goal |
| `POST` | `/goals/:id/key-results` | Create KR |
| `GET` | `/key-results/:id` | Get KR with links and progress history |
| `PATCH` | `/key-results/:id` | Update KR metadata or manual value |
| `DELETE` | `/key-results/:id` | Delete KR |
| `POST` | `/key-results/:id/value` | Set current_value (manual mode) |
| `GET` | `/key-results/:id/links` | List linked Bam entities |
| `POST` | `/key-results/:id/links` | Add link to epic/project/task query |
| `DELETE` | `/key-results/:id/links/:linkId` | Remove link |
| `GET` | `/key-results/:id/history` | Daily snapshot history for charting |

#### Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/period/:periodId` | Full period report (all goals, progress, status) |
| `GET` | `/reports/at-risk` | Goals currently at_risk or behind |
| `GET` | `/reports/owner/:userId` | All goals owned by a user across periods |
| `POST` | `/reports/generate` | Generate formatted Markdown report (for sharing to Banter/Brief) |

### 5.3 Zod Schemas

```typescript
import { z } from 'zod';

export const BearingPeriodType = z.enum(['quarter', 'half', 'year', 'custom']);
export const BearingPeriodStatus = z.enum(['planning', 'active', 'completed', 'archived']);
export const BearingGoalScope = z.enum(['organization', 'team', 'project']);
export const BearingGoalStatus = z.enum(['on_track', 'at_risk', 'behind', 'achieved', 'cancelled']);
export const BearingMetricType = z.enum(['percentage', 'number', 'currency', 'boolean']);
export const BearingDirection = z.enum(['increase', 'decrease']);
export const BearingProgressMode = z.enum(['manual', 'linked', 'rollup']);
export const BearingLinkType = z.enum(['epic', 'project', 'task_query']);

export const CreateGoalSchema = z.object({
  period_id: z.string().uuid(),
  title: z.string().max(500),
  description: z.string().max(5000).optional(),
  scope: BearingGoalScope.default('organization'),
  project_id: z.string().uuid().optional(),
  team_name: z.string().max(100).optional(),
  icon: z.string().max(10).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  owner_id: z.string().uuid(),
});

export const CreateKeyResultSchema = z.object({
  title: z.string().max(500),
  description: z.string().max(5000).optional(),
  metric_type: BearingMetricType.default('percentage'),
  target_value: z.number(),
  start_value: z.number().default(0),
  unit: z.string().max(20).optional(),
  direction: BearingDirection.default('increase'),
  progress_mode: BearingProgressMode.default('manual'),
  owner_id: z.string().uuid().optional(),
});

export const CreateKrLinkSchema = z.object({
  link_type: BearingLinkType,
  epic_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  task_query: z.record(z.unknown()).optional(),
  weight: z.number().min(0).max(100).default(1.0),
});
```

---

## 6. MCP Tools

### 6.1 Tool Catalog (12 tools)

| Tool | Description |
|------|-------------|
| `bearing_periods` | List periods (filterable by status). |
| `bearing_period_get` | Get period with summary stats (goal count, avg progress, at-risk count). |
| `bearing_goals` | List goals (filterable by period, scope, owner, status). |
| `bearing_goal_get` | Get goal with key results, progress, status, and linked entities. |
| `bearing_goal_create` | Create a new goal in a period. |
| `bearing_goal_update` | Update goal metadata or override status. |
| `bearing_kr_create` | Create a key result under a goal. |
| `bearing_kr_update` | Update key result value (manual mode) or metadata. |
| `bearing_kr_link` | Link a key result to a Bam epic, project, or task query. |
| `bearing_update_post` | Post a status update note on a goal. |
| `bearing_report` | Generate a period or at-risk report as formatted Markdown. |
| `bearing_at_risk` | List all goals currently at_risk or behind (quick agent check). |

---

## 7. Frontend Architecture

### 7.1 React SPA Structure

```
apps/bearing/
  src/
    main.tsx
    App.tsx
    pages/
      DashboardPage.tsx           → Period overview with all goals, progress bars, status
      GoalDetailPage.tsx          → Goal with KRs, progress chart, updates, watchers
      PeriodListPage.tsx          → List/manage periods
      AtRiskPage.tsx              → Goals that need attention
      MyGoalsPage.tsx             → Current user's goals across periods
    components/
      dashboard/
        PeriodSelector.tsx        → Dropdown to switch active period
        GoalCard.tsx              → Card with title, owner, progress bar, status badge
        GoalGrid.tsx              → Responsive grid of GoalCards
        ProgressSummary.tsx       → Org-level stats (X goals, Y% avg progress, Z at-risk)
        ScopeFilter.tsx           → Filter by org / team / project
      goal/
        KeyResultRow.tsx          → KR with progress bar, current/target value, edit controls
        KeyResultList.tsx         → Ordered list of KRs for a goal
        ProgressChart.tsx         → Line chart of progress over time (Recharts)
        StatusBadge.tsx           → on_track (green) / at_risk (yellow) / behind (red) / achieved (blue)
        UpdateFeed.tsx            → Chronological status updates from goal owner
        PostUpdateDialog.tsx      → Form for posting a status update
        WatcherList.tsx           → Avatar list of watchers with add/remove
      links/
        LinkEditor.tsx            → Add/remove links to epics, projects, task queries
        EpicPicker.tsx            → Search and select Bam epics
        ProjectPicker.tsx         → Search and select Bam projects
        TaskQueryBuilder.tsx      → Simple query builder (project + labels + phase filter)
      common/
        ProgressBar.tsx           → Animated progress bar with percentage label
        TimeRemainingBadge.tsx    → "42 days remaining" or "3 days overdue"
    hooks/
      useGoals.ts
      useKeyResults.ts
      usePeriods.ts
      useProgress.ts
    stores/
      periodStore.ts              → Zustand store for selected period
```

### 7.2 Key UI Patterns

- **Dashboard:** Grid of goal cards grouped by scope (Org Goals, Team Goals, Project Goals). Each card shows title, owner avatar, progress bar, status badge, and KR count. Clicking opens the goal detail.
- **Goal detail:** Full-width page with title, description, owner, status badge, and progress bar at top. Below: Key Results as a vertical list with individual progress bars and current/target values. Right sidebar: progress-over-time chart, status updates feed, watcher list.
- **Progress chart:** Line chart (Recharts) with daily data points from `bearing_kr_snapshots`. Shows actual vs. expected (linear interpolation from start to end of period). Gap between the lines visually conveys on-track vs. behind.
- **At-risk view:** Filtered list of goals where status = `at_risk` or `behind`, sorted by most behind first. One-click navigation to goal detail for investigation.

---

## 8. Cross-Product Integration

### 8.1 Bearing → Bam

- **Progress reads from Bam.** The progress engine queries Bam's `tasks` and `epics` tables directly (same database) to compute linked KR progress.
- **Goal badge on epics.** In the Bam UI, epics linked to a Bearing goal show a small "🎯 Q2 Goal" badge that links to the goal in Bearing.
- **Goal context in sprint planning.** When viewing a sprint in Bam, a sidebar widget shows "Goals this sprint contributes to" — computed from the intersection of sprint tasks and goal-linked epics.

### 8.2 Bearing → Banter

- **Share report to channel.** From the dashboard or goal detail, "Share to Banter" posts a formatted progress update to a selected channel.
- **Weekly digest automation.** A Bolt template ("Weekly Goals Digest") generates a Bearing report every Monday and posts it to a configured channel.
- **Goal achievement notification.** When a goal reaches `achieved` status, an automatic Banter notification is posted (via Bolt event: `goal.achieved`).

### 8.3 Bearing → Brief

- **Embed goal progress.** Brief documents can embed a live goal progress widget (custom Tiptap node) that shows current progress and status, updated on each render.
- **Quarterly planning template.** A Brief template "Quarterly Planning" includes sections for each goal with linked KRs, auto-populated from Bearing data.

### 8.4 Bearing → Bolt

Bearing publishes events to the Bolt event bus:

| Event | Payload | Description |
|-------|---------|-------------|
| `goal.created` | `{ goal }` | New goal created |
| `goal.status_changed` | `{ goal, old_status, new_status }` | Status transition |
| `goal.achieved` | `{ goal }` | Goal reached 100% / marked achieved |
| `kr.value_updated` | `{ key_result, old_value, new_value }` | KR progress changed |
| `period.activated` | `{ period }` | Period set to active |
| `period.completed` | `{ period, summary }` | Period closed |

---

## 9. Background Jobs (BullMQ)

| Queue | Job | Description |
|-------|-----|-------------|
| `bearing:snapshot` | `dailySnapshot` | Compute and persist KR progress snapshots. Runs at midnight UTC. |
| `bearing:recompute` | `recomputeProgress` | Recompute linked KR progress when a Bam task is completed (triggered by Bolt event or direct call). Debounced to once per minute per KR. |
| `bearing:digest` | `weeklyDigest` | Generate and cache the weekly goals summary. Triggered by Bolt schedule or on-demand. |

---

## 10. Authorization Model

| Role | Permissions |
|------|------------|
| **SuperUser** | All operations across all orgs |
| **Owner / Admin** | Create/edit/delete periods and goals. Manage all goals in org. |
| **Member** | Create goals in projects they belong to. Edit own goals. Update KR values for own KRs. Post status updates on goals they own. View all org/project goals. |
| **Viewer** | Read-only access to all goals in their projects/org. |

Goal watchers receive notifications but don't gain edit permissions from watching alone.

---

## 11. Observability & Metrics

| Metric | Source | Purpose |
|--------|--------|---------|
| Goal count by status / period | `bearing_goals` | Org health dashboard |
| KR progress computation latency | Progress engine | Performance monitoring |
| Snapshot job duration | BullMQ | Nightly job health |
| Goals with stale progress (no update in 7+ days) | `bearing_key_results.updated_at` | Engagement tracking |
| Goals per user | `bearing_goals.owner_id` | Load distribution |
