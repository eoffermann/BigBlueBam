# Bolt — Workflow Automation for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 7, 2026
**Product:** Bolt (Workflow Automation)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Bolt is the visual workflow automation engine for the BigBlueBam suite. It allows users to create trigger→condition→action rules that span Bam, Banter, Beacon, Brief, and Helpdesk — without writing code, configuring AI agents, or touching MCP.

The critical architectural decision: **every Bolt automation compiles to MCP tool calls**. The visual builder and the AI agent layer share the same execution substrate. This means:
- Automations built visually can be inspected as MCP sequences.
- AI agents can trigger, extend, and introspect automations.
- There is exactly one execution engine, not two parallel systems.

### 1.2 Core Principles

1. **MCP is the runtime.** Bolt does not have its own action execution layer. Every action is an MCP tool call. This ensures feature parity between visual automations and AI-driven workflows.
2. **Suite-wide scope.** A single automation can react to a Bam event, check a Beacon article, post to Banter, and update a Helpdesk ticket. No other competitor's automation engine crosses product boundaries this cleanly.
3. **Auditable by default.** Every execution is logged: trigger event, conditions evaluated, actions taken, outcome (success/failure/skipped), duration, and the MCP calls made.
4. **AI-assisted authoring.** Users can describe an automation in natural language ("notify #ops when a critical task is overdue by 2 days") and Bolt generates the rule visually for review.
5. **Fail-safe.** Automations that error do not retry silently. Failed executions surface in the audit log and optionally notify the automation owner.

### 1.3 Non-Goals

- Bolt is **not** a general-purpose workflow orchestration tool (no Airflow/Temporal). It handles event-driven, low-latency rules — not multi-hour DAGs.
- Bolt does **not** replace AI agents. Agents handle nuanced, context-dependent tasks (triage, summarization, content generation). Bolt handles deterministic if-then rules.
- Bolt does **not** include external service integrations at launch. Outbound webhooks are the escape hatch. Native integrations (Slack, GitHub, etc.) are future work.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  bolt-api/           → Fastify REST API (automation CRUD, execution engine, audit log)
  bolt/               → React SPA (visual rule builder, automation list, execution log)
```

Bolt does **not** have its own database service or message queue. It uses the shared PostgreSQL, Redis, and BullMQ worker infrastructure.

### 2.2 Event-Driven Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Event Producers                                │
│  Bam API  │  Banter API  │  Beacon API  │  Brief API  │  Helpdesk │
└─────┬──────────┬──────────────┬──────────────┬──────────────┬────┘
      │          │              │              │              │
      ▼          ▼              ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Redis PubSub                                 │
│              Channel: bolt:events                                │
│  { source, event_type, org_id, project_id, payload, timestamp } │
└─────────────────────────────┬────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Bolt Event Router                             │
│  (runs inside apps/worker as a BullMQ processor)                 │
│                                                                  │
│  1. Receive event from Redis                                     │
│  2. Query bolt_automations WHERE trigger matches event           │
│  3. For each matching automation:                                │
│     a. Evaluate conditions against event payload                 │
│     b. If conditions pass → enqueue bolt:execute job             │
│     c. If conditions fail → log skip                             │
└─────────────────────────────┬────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Bolt Executor                                 │
│  (BullMQ processor in apps/worker)                               │
│                                                                  │
│  1. Load automation definition                                   │
│  2. Resolve action parameters (template variables from event)    │
│  3. Execute actions as MCP tool calls (sequential)               │
│  4. Log execution result to bolt_executions                      │
│  5. On failure: log error, optionally notify owner via Banter DM │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 Infrastructure

| Component | Role |
|-----------|------|
| **bolt-api** (Fastify :4006) | REST API for automation CRUD, execution log queries, AI-assisted authoring |
| **PostgreSQL 16** | Automation definitions, execution log (shared DB) |
| **Redis 7** | Event bus (`bolt:events` PubSub channel), execution rate limiting |
| **BullMQ Worker** | Event router + executor (added as processors to existing worker) |
| **MCP Server** | Action execution runtime (Bolt calls MCP tools internally) |

### 2.4 nginx Routing

```nginx
location /bolt/ {
    alias /usr/share/nginx/html/bolt/;
    try_files $uri $uri/ /bolt/index.html;
}

location /bolt/api/ {
    proxy_pass http://bolt-api:4006/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.5 Docker Service

```yaml
bolt-api:
  build:
    context: .
    dockerfile: apps/bolt-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
  ports:
    - "4006:4006"
  depends_on:
    - postgres
    - redis
    - mcp-server
```

---

## 3. Data Model

### 3.1 Entity Relationship Overview

```
organizations ──1:N──► bolt_automations ──1:N──► bolt_actions
                              │
                              ├──1:N──► bolt_conditions
                              │
                              └──1:N──► bolt_executions ──1:N──► bolt_execution_steps
```

### 3.2 PostgreSQL Schema

```sql
-- ============================================================
-- BOLT: Workflow Automation
-- ============================================================

-- Automation definitions
CREATE TABLE bolt_automations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,

    -- Trigger definition
    trigger_source  VARCHAR(30) NOT NULL
                    CHECK (trigger_source IN ('bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule')),
    trigger_event   VARCHAR(60) NOT NULL,    -- e.g., 'task.moved', 'ticket.created', 'message.posted'
    trigger_filter  JSONB,                   -- optional filter on trigger payload (e.g., { "priority": "critical" })

    -- Schedule trigger (cron expression, only when trigger_source = 'schedule')
    cron_expression VARCHAR(100),
    cron_timezone   VARCHAR(50) DEFAULT 'UTC',

    -- Execution control
    max_executions_per_hour INTEGER DEFAULT 100,
    cooldown_seconds        INTEGER DEFAULT 0,     -- minimum seconds between executions
    last_executed_at        TIMESTAMPTZ,

    -- Metadata
    created_by      UUID NOT NULL REFERENCES users(id),
    updated_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bolt_auto_org ON bolt_automations(organization_id);
CREATE INDEX idx_bolt_auto_project ON bolt_automations(project_id);
CREATE INDEX idx_bolt_auto_trigger ON bolt_automations(trigger_source, trigger_event);
CREATE INDEX idx_bolt_auto_enabled ON bolt_automations(enabled) WHERE enabled = true;

-- Conditions (evaluated before actions fire)
CREATE TABLE bolt_conditions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id   UUID NOT NULL REFERENCES bolt_automations(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    -- Condition definition
    field           VARCHAR(255) NOT NULL,   -- e.g., 'event.task.priority', 'event.ticket.category'
    operator        VARCHAR(30) NOT NULL
                    CHECK (operator IN (
                        'equals', 'not_equals',
                        'contains', 'not_contains',
                        'starts_with', 'ends_with',
                        'greater_than', 'less_than',
                        'is_empty', 'is_not_empty',
                        'in', 'not_in',
                        'matches_regex'
                    )),
    value           JSONB,                   -- comparison value (string, number, array, null)
    -- Logic
    logic_group     VARCHAR(5) NOT NULL DEFAULT 'and'
                    CHECK (logic_group IN ('and', 'or')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bolt_cond_auto ON bolt_conditions(automation_id);

-- Actions (executed sequentially when conditions pass)
CREATE TABLE bolt_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id   UUID NOT NULL REFERENCES bolt_automations(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    -- Action definition (maps to an MCP tool)
    mcp_tool        VARCHAR(100) NOT NULL,   -- e.g., 'banter_post_message', 'task_update', 'beacon_create'
    parameters      JSONB NOT NULL,          -- tool parameters with template variables: {{ event.task.title }}
    -- Error handling
    on_error        VARCHAR(20) NOT NULL DEFAULT 'stop'
                    CHECK (on_error IN ('stop', 'continue', 'retry')),
    retry_count     INTEGER DEFAULT 0,
    retry_delay_ms  INTEGER DEFAULT 1000,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bolt_action_auto ON bolt_actions(automation_id);

-- Execution log
CREATE TABLE bolt_executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id   UUID NOT NULL REFERENCES bolt_automations(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL
                    CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
    -- Trigger context
    trigger_event   JSONB NOT NULL,          -- full event payload that triggered this execution
    -- Timing
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,
    -- Condition evaluation
    conditions_met  BOOLEAN NOT NULL DEFAULT true,
    condition_log   JSONB,                   -- per-condition evaluation results
    -- Error info
    error_message   TEXT,
    error_step      INTEGER,                 -- which action step failed (0-indexed)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bolt_exec_auto ON bolt_executions(automation_id);
CREATE INDEX idx_bolt_exec_status ON bolt_executions(status);
CREATE INDEX idx_bolt_exec_started ON bolt_executions(started_at DESC);

-- Individual action step results within an execution
CREATE TABLE bolt_execution_steps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id    UUID NOT NULL REFERENCES bolt_executions(id) ON DELETE CASCADE,
    action_id       UUID NOT NULL REFERENCES bolt_actions(id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    mcp_tool        VARCHAR(100) NOT NULL,
    parameters_resolved JSONB NOT NULL,      -- parameters after template variable resolution
    status          VARCHAR(20) NOT NULL
                    CHECK (status IN ('success', 'failed', 'skipped')),
    response        JSONB,                   -- MCP tool response
    error_message   TEXT,
    duration_ms     INTEGER,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bolt_step_exec ON bolt_execution_steps(execution_id);

-- Scheduled job tracking (for cron-triggered automations)
CREATE TABLE bolt_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id   UUID NOT NULL REFERENCES bolt_automations(id) ON DELETE CASCADE,
    next_run_at     TIMESTAMPTZ NOT NULL,
    last_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (automation_id)
);

CREATE INDEX idx_bolt_sched_next ON bolt_schedules(next_run_at);
```

---

## 4. Event System

### 4.1 Event Schema

All events published to the `bolt:events` Redis PubSub channel follow a common envelope:

```typescript
interface BoltEvent {
  id: string;               // unique event ID (UUID)
  source: 'bam' | 'banter' | 'beacon' | 'brief' | 'helpdesk';
  event_type: string;       // e.g., 'task.moved', 'ticket.created'
  organization_id: string;
  project_id?: string;
  actor_id: string;         // user or agent who caused the event
  actor_type: 'user' | 'agent' | 'system';
  payload: Record<string, unknown>;  // event-specific data
  timestamp: string;        // ISO 8601
}
```

### 4.2 Event Catalog

#### Bam Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `task.created` | `{ task }` | New task created |
| `task.updated` | `{ task, changes: { field, old, new }[] }` | Task metadata changed |
| `task.moved` | `{ task, from_phase, to_phase }` | Task moved between phases |
| `task.assigned` | `{ task, assignee, previous_assignee }` | Task assigned/reassigned |
| `task.completed` | `{ task }` | Task moved to final phase |
| `task.overdue` | `{ task, days_overdue }` | Task past due date (checked hourly) |
| `task.commented` | `{ task, comment }` | Comment added to task |
| `sprint.started` | `{ sprint, task_count }` | Sprint activated |
| `sprint.completed` | `{ sprint, report }` | Sprint completed |
| `epic.completed` | `{ epic, task_count }` | All tasks in epic done |

#### Banter Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `message.posted` | `{ message, channel }` | Message sent to channel |
| `message.mentioned` | `{ message, mentioned_user }` | @mention in message |
| `channel.created` | `{ channel }` | New channel created |
| `reaction.added` | `{ message, reaction, user }` | Reaction added to message |

#### Beacon Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `beacon.published` | `{ beacon }` | Beacon published |
| `beacon.expired` | `{ beacon, days_overdue }` | Beacon past verification date |
| `beacon.challenged` | `{ beacon, challenger }` | Beacon accuracy challenged |
| `beacon.verified` | `{ beacon, verifier }` | Beacon re-verified |

#### Brief Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `document.created` | `{ document }` | New document created |
| `document.promoted` | `{ document, beacon }` | Document graduated to Beacon |
| `document.status_changed` | `{ document, old_status, new_status }` | Status transition |
| `document.commented` | `{ document, comment }` | Comment added |

#### Helpdesk Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `ticket.created` | `{ ticket, task }` | New ticket submitted |
| `ticket.replied` | `{ ticket, message, author_type }` | Agent or client replied |
| `ticket.status_changed` | `{ ticket, old_status, new_status }` | Ticket status transition |
| `ticket.sla_breach` | `{ ticket, sla_rule, breach_type }` | SLA threshold exceeded |

#### Schedule Events

| Event Type | Trigger Payload | Description |
|------------|----------------|-------------|
| `cron.fired` | `{ schedule_id, fired_at }` | Cron schedule triggered |

### 4.3 Publishing Events from Existing APIs

Each existing API (Bam, Banter, Beacon, Brief, Helpdesk) publishes events by adding a lightweight `publishBoltEvent()` call after the relevant operation succeeds. This is a Redis PUBLISH — no database write, sub-millisecond overhead.

```typescript
// Example: in apps/api/src/routes/tasks.ts (Bam)
await redis.publish('bolt:events', JSON.stringify({
  id: randomUUID(),
  source: 'bam',
  event_type: 'task.moved',
  organization_id: task.organization_id,
  project_id: task.project_id,
  actor_id: userId,
  actor_type: 'user',
  payload: { task, from_phase: oldPhase, to_phase: newPhase },
  timestamp: new Date().toISOString(),
}));
```

---

## 5. Execution Engine

### 5.1 Template Variable Resolution

Action parameters support Mustache-style template variables that resolve against the trigger event payload:

```json
{
  "mcp_tool": "banter_post_message",
  "parameters": {
    "channel_name": "engineering",
    "text": "Task **{{ event.task.title }}** was moved to {{ event.to_phase.name }} by {{ actor.name }}"
  }
}
```

**Resolution rules:**
- `{{ event.* }}` — resolves against `BoltEvent.payload`
- `{{ actor.* }}` — resolves against the user/agent who triggered the event (looked up from `actor_id`)
- `{{ automation.* }}` — resolves against the automation definition metadata
- `{{ now }}` — current ISO timestamp
- `{{ step[N].result.* }}` — resolves against the response from a previous action step (for chaining)

### 5.2 Condition Evaluation

Conditions are evaluated in order, grouped by `logic_group`:

```
(cond1 AND cond2 AND cond3) OR (cond4 AND cond5)
```

All conditions in an AND group must pass. Any OR group passing triggers execution.

The `field` in each condition uses dot-notation to traverse the event payload:
- `event.task.priority` → `BoltEvent.payload.task.priority`
- `event.ticket.category` → `BoltEvent.payload.ticket.category`
- `actor.type` → `BoltEvent.actor_type`

### 5.3 Rate Limiting

Each automation has `max_executions_per_hour` and `cooldown_seconds`. The router checks Redis counters before enqueuing execution:

```
bolt:rate:{automation_id}:hour → INCREMENT, EXPIRE 3600
bolt:cooldown:{automation_id} → SET with TTL = cooldown_seconds
```

If rate limit is hit, the event is logged as `skipped` with reason `rate_limited`.

### 5.4 Error Handling

Each action specifies `on_error`:
- **stop** (default): Halt execution, mark as `failed`, log error.
- **continue**: Log error for this step, proceed to next action.
- **retry**: Retry the action up to `retry_count` times with `retry_delay_ms` between attempts. If all retries fail, follow `stop` behavior.

Failed executions optionally notify the automation owner via Banter DM (configurable per automation).

---

## 6. API Design

### 6.1 Fastify Application Structure

```
apps/bolt-api/
  src/
    index.ts
    plugins/
      auth.ts
      redis.ts
    routes/
      automations.ts       → CRUD, enable/disable, duplicate, test
      executions.ts        → List, get detail, retry
      events.ts            → List available events (for builder UI)
      templates.ts         → Pre-built automation templates
      ai-assist.ts         → Natural language → automation generation
    services/
      condition-engine.ts  → Condition evaluation logic
      template-resolver.ts → Mustache variable resolution
      event-catalog.ts     → Registry of all available events + payload schemas
      mcp-executor.ts      → Internal MCP tool call dispatcher
    db/
      schema.ts
      queries.ts
```

### 6.2 REST Endpoints

#### Automations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/automations` | List automations (filterable by project, trigger_source, enabled) |
| `POST` | `/automations` | Create automation (full definition: trigger + conditions + actions) |
| `GET` | `/automations/:id` | Get automation with conditions and actions |
| `PUT` | `/automations/:id` | Update full automation definition |
| `PATCH` | `/automations/:id` | Update automation metadata (name, description, enabled) |
| `DELETE` | `/automations/:id` | Delete automation and all execution history |
| `POST` | `/automations/:id/enable` | Enable automation |
| `POST` | `/automations/:id/disable` | Disable automation |
| `POST` | `/automations/:id/duplicate` | Duplicate automation |
| `POST` | `/automations/:id/test` | Test-fire automation with a simulated event payload |

#### Executions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/automations/:id/executions` | List executions for an automation (paginated, filterable by status) |
| `GET` | `/executions/:id` | Get execution detail with step-by-step results |
| `POST` | `/executions/:id/retry` | Re-run a failed execution from the failed step |
| `GET` | `/executions` | List all executions org-wide (admin view) |

#### Event Catalog

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/events` | List all available trigger events with payload schemas |
| `GET` | `/events/:source` | List events for a specific source (bam, banter, etc.) |
| `GET` | `/actions` | List all available MCP tools usable as actions (with parameter schemas) |

#### Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/templates` | List pre-built automation templates |
| `POST` | `/templates/:id/instantiate` | Create an automation from a template |

#### AI-Assisted Authoring

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ai/generate` | Natural language → automation definition (returns full automation JSON for review) |
| `POST` | `/ai/explain` | Automation definition → natural language explanation |

### 6.3 Zod Schemas

```typescript
import { z } from 'zod';

export const BoltTriggerSource = z.enum(['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule']);

export const BoltConditionOperator = z.enum([
  'equals', 'not_equals', 'contains', 'not_contains',
  'starts_with', 'ends_with', 'greater_than', 'less_than',
  'is_empty', 'is_not_empty', 'in', 'not_in', 'matches_regex',
]);

export const BoltActionErrorPolicy = z.enum(['stop', 'continue', 'retry']);

export const BoltConditionSchema = z.object({
  field: z.string().max(255),
  operator: BoltConditionOperator,
  value: z.unknown().optional(),
  logic_group: z.enum(['and', 'or']).default('and'),
  sort_order: z.number().int().min(0).default(0),
});

export const BoltActionSchema = z.object({
  mcp_tool: z.string().max(100),
  parameters: z.record(z.unknown()),
  sort_order: z.number().int().min(0).default(0),
  on_error: BoltActionErrorPolicy.default('stop'),
  retry_count: z.number().int().min(0).max(5).default(0),
  retry_delay_ms: z.number().int().min(100).max(30000).default(1000),
});

export const CreateAutomationSchema = z.object({
  name: z.string().max(255),
  description: z.string().max(2000).optional(),
  project_id: z.string().uuid().optional(),
  trigger_source: BoltTriggerSource,
  trigger_event: z.string().max(60),
  trigger_filter: z.record(z.unknown()).optional(),
  cron_expression: z.string().max(100).optional(),
  cron_timezone: z.string().max(50).default('UTC'),
  conditions: z.array(BoltConditionSchema).default([]),
  actions: z.array(BoltActionSchema).min(1),
  max_executions_per_hour: z.number().int().min(1).max(10000).default(100),
  cooldown_seconds: z.number().int().min(0).max(86400).default(0),
  enabled: z.boolean().default(true),
});
```

---

## 7. MCP Tools

### 7.1 Tool Catalog (12 tools)

| Tool | Description |
|------|-------------|
| `bolt_list` | List automations (filterable by project, trigger_source, enabled status). |
| `bolt_get` | Get automation definition with conditions and actions. |
| `bolt_create` | Create a new automation from a full definition (trigger + conditions + actions). |
| `bolt_update` | Update an automation definition. |
| `bolt_enable` | Enable a disabled automation. |
| `bolt_disable` | Disable an automation. |
| `bolt_delete` | Delete an automation. |
| `bolt_test` | Test-fire an automation with a simulated event. Returns execution result. |
| `bolt_executions` | List recent executions for an automation (with status filtering). |
| `bolt_execution_detail` | Get step-by-step detail for a specific execution. |
| `bolt_events` | List available trigger events with payload schemas (useful for agent-driven automation creation). |
| `bolt_actions` | List available MCP tools usable as actions (with parameter schemas). |

---

## 8. Frontend Architecture

### 8.1 React SPA Structure

```
apps/bolt/
  src/
    main.tsx
    App.tsx
    pages/
      AutomationListPage.tsx      → List of automations with status badges
      AutomationEditorPage.tsx    → Visual rule builder
      ExecutionLogPage.tsx        → Org-wide execution log
      ExecutionDetailPage.tsx     → Step-by-step execution trace
      TemplateBrowserPage.tsx     → Pre-built automation templates
    components/
      builder/
        TriggerSelector.tsx       → Event source + event type picker
        TriggerFilterEditor.tsx   → Optional payload filter (key-value builder)
        ConditionList.tsx         → Add/remove/reorder conditions with AND/OR groups
        ConditionRow.tsx          → Single condition: field picker + operator + value
        ActionList.tsx            → Add/remove/reorder actions
        ActionEditor.tsx          → MCP tool picker + parameter editor with template variables
        TemplateVariableHelper.tsx → Autocomplete for {{ event.* }} variables
        CronEditor.tsx            → Visual cron schedule builder
        AutomationPreview.tsx     → Natural-language summary of the rule
      execution/
        ExecutionTimeline.tsx     → Vertical timeline of steps with status icons
        StepDetail.tsx            → MCP call parameters, response, duration, error
        StatusBadge.tsx           → success / failed / skipped / running
      list/
        AutomationCard.tsx        → Name, trigger, enabled toggle, last execution
        AutomationTable.tsx       → Sortable list view
      common/
        FieldPicker.tsx           → Dot-notation field selector with schema-aware autocomplete
        McpToolPicker.tsx         → Searchable MCP tool selector with parameter forms
        AiAssistDialog.tsx        → Natural language → automation dialog
    hooks/
      useAutomation.ts
      useExecutions.ts
      useEventCatalog.ts
    stores/
      builderStore.ts             → Zustand store for builder UI state
```

### 8.2 Visual Builder UX

The automation editor is a vertical flow layout:

```
┌─────────────────────────────────────────────────┐
│  🔔 WHEN                                        │
│  ┌─────────────────────────────────────────────┐│
│  │ Source: [Bam ▼]  Event: [Task moved ▼]      ││
│  │ Filter: priority = critical (optional)       ││
│  └─────────────────────────────────────────────┘│
│                      ↓                           │
│  🔍 IF (conditions — optional)                   │
│  ┌─────────────────────────────────────────────┐│
│  │ event.to_phase.name  [equals ▼]  "Done"     ││
│  │ [+ Add condition]                            ││
│  └─────────────────────────────────────────────┘│
│                      ↓                           │
│  ⚡ THEN (actions)                               │
│  ┌─────────────────────────────────────────────┐│
│  │ 1. banter_post_message                       ││
│  │    channel: #releases                        ││
│  │    text: "✅ {{ event.task.title }} is done" ││
│  │ 2. task_update                               ││
│  │    task_id: {{ event.task.id }}              ││
│  │    labels: ["shipped"]                       ││
│  │ [+ Add action]                               ││
│  └─────────────────────────────────────────────┘│
│                                                  │
│  [Test Run]    [Save]    [Save & Enable]         │
└─────────────────────────────────────────────────┘
```

### 8.3 AI-Assisted Authoring

A button in the builder opens a dialog: "Describe your automation in plain English."

The user types: "When a helpdesk ticket is tagged billing and priority is high, assign it to @sarah and post a message in #billing-alerts."

The AI (via `POST /bolt/api/ai/generate`) returns a fully populated automation definition. The visual builder renders it for review. The user can edit any part before saving.

---

## 9. Pre-Built Templates

Shipped as system templates, selectable from the template browser:

| Template Name | Trigger | Conditions | Actions |
|--------------|---------|------------|---------|
| **Notify on Critical Task** | `task.created` | priority = critical | Post to Banter channel |
| **Overdue Task Alert** | `task.overdue` | days_overdue > 2 | DM assignee via Banter |
| **Sprint Complete Report** | `sprint.completed` | — | Post sprint report to Banter channel |
| **Helpdesk Auto-Assign by Category** | `ticket.created` | category = billing | Assign to specific user |
| **SLA Breach Escalation** | `ticket.sla_breach` | — | Set priority to critical, DM team lead |
| **Beacon Expiry Reminder** | `beacon.expired` | — | Post reminder to Banter, DM last verifier |
| **New Document Notification** | `document.created` | — | Post to Banter project channel |
| **Weekly Status Update** | `cron.fired` (Mon 9am) | — | Generate report via MCP, post to Banter |
| **Task Moved to Review** | `task.moved` | to_phase = "Review" | Notify reviewer via Banter DM |
| **Close Ticket on Task Complete** | `task.completed` | task has linked ticket | Update ticket status to resolved |

---

## 10. Background Jobs (BullMQ)

Added as processors in the existing `apps/worker/`:

| Queue | Job | Description |
|-------|-----|-------------|
| `bolt:route` | `routeEvent` | Receive event, match automations, evaluate conditions, enqueue execution |
| `bolt:execute` | `executeAutomation` | Run action sequence via MCP tool calls, log results |
| `bolt:schedule` | `cronTick` | Check `bolt_schedules` for due automations, fire synthetic cron event. Runs every 60 seconds. |
| `bolt:cleanup` | `purgeExecutionLog` | Retain 90 days of execution history, delete older records. Runs nightly. |

---

## 11. Authorization Model

| Role | Permissions |
|------|------------|
| **SuperUser** | All operations across all orgs |
| **Owner / Admin** | Create, edit, delete, enable/disable any automation in the org. View all executions. |
| **Member** | Create automations in projects they belong to. Edit/delete own automations. View executions for own automations. |
| **Viewer** | View automations and execution logs. Cannot create or modify. |

Automations execute actions with the **permissions of the automation creator**. If the creator's role is downgraded, the automation continues to run but MCP calls that exceed their new permissions will fail and be logged.

---

## 12. Observability & Metrics

| Metric | Source | Purpose |
|--------|--------|---------|
| Events received / minute | Redis PubSub consumer | Throughput monitoring |
| Automations matched / event | Event router | Rule matching efficiency |
| Execution success rate | `bolt_executions` table | Reliability tracking |
| Execution duration (p50, p99) | `bolt_executions.duration_ms` | Performance monitoring |
| MCP call failure rate | `bolt_execution_steps` | Downstream service health |
| Rate limit hits / hour | Redis counters | Automation tuning signal |
| Active automations / org | `bolt_automations` table | Usage metrics |

---

## 13. Security Considerations

- **No arbitrary code execution.** Bolt actions are MCP tool calls, not user-supplied scripts. The action surface is bounded by the MCP tool catalog.
- **Template variable injection.** Variables like `{{ event.task.title }}` are resolved as string interpolation, not evaluated as code. The resolver escapes values to prevent injection into MCP tool parameters.
- **Rate limiting is enforced server-side.** Users cannot disable rate limits below system minimums (1 execution/second floor).
- **Webhook actions (future)** will require URL allowlisting per organization to prevent SSRF.
