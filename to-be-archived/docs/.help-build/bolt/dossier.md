# Bolt — App Dossier

Research dossier for the Bolt workflow-automation app. Everything below is grounded in
repo source; file paths are absolute. Where docs/marketing diverge from code, see
**Discrepancies**.

---

## 1. App identity

- **App key:** `bolt`
- **Display name:** Bolt (subtitle "Workflow Automation")
- **Category:** Workflow automation
- **SPA path:** `/bolt/` (served by nginx). Routing base path is `/bolt`, stripped client-side
  (`apps/bolt/src/app.tsx`, `BASE_PATH = '/bolt'`).
- **API path:** `/bolt/api/` -> Fastify `bolt-api` on internal `:4006`, routes mounted under
  `/v1` (`apps/bolt-api/src/server.ts`).
- **Status:** BETA. The sidebar logo carries a yellow "beta" pill
  (`apps/bolt/src/components/layout/bolt-sidebar.tsx`).
- **Prerequisites:**
  - Must be logged into BigBlueBam first. Bolt has no login screen of its own; if unauthenticated
    it shows "Please log in to BigBlueBam first to access Bolt." with a "Go to BigBlueBam Login"
    link to `/b3/` (`apps/bolt/src/app.tsx`). Auth = shared session cookie or `bbam_`/`bbam_svc_`
    API key (`apps/bolt-api/src/plugins/auth.ts`).
  - Org-scoped. Active org follows `X-Org-Id` header -> `sessions.active_org_id` (set by Bam
    switch-org) -> default membership (`apps/bolt-api/src/plugins/auth.ts`, `buildAuthUser`).
  - AI routes require an LLM provider configured in Bam Settings -> AI Providers; otherwise
    `AI_NOT_CONFIGURED` (422) (`apps/bolt-api/src/routes/ai-assist.routes.ts`). No frontend caller
    exists yet (see Discrepancies).
  - To fire, other apps must publish events to ingest, and `worker` (BullMQ `bolt-execute`) +
    `mcp-server` must run; actions execute via the worker calling MCP `POST /tools/call`
    (`apps/worker/src/jobs/bolt-execute.job.ts`).

---

## 2. Key concepts and vocabulary

- **Automation** (a.k.a. "rule"): top-level object = trigger + optional conditions + ordered
  actions + rate/cooldown/chain settings. Table `bolt_automations`
  (`apps/bolt-api/src/db/schema/bolt-automations.ts`). UI label "Automations"; design docs say "rule".
- **Trigger:** has **trigger_source** (emitting app) + **trigger_event** (bare name e.g.
  `task.created`) + optional **trigger_filter** (equality-only key->value map on the raw payload).
- **trigger_source enum** (`bolt_trigger_source`): `bam, banter, beacon, brief, helpdesk, schedule,
  bond, blast, board, bench, bearing, bill, book, blank` (14). Ingest also accepts `platform`, but
  no automation row can store `platform` (not in enum), so `platform` events never match a rule —
  used for observability/webhooks (`apps/bolt-api/src/routes/event-ingestion.routes.ts`).
- **Condition:** field/operator/value + logic_group. Table `bolt_conditions`.
  - **Operators (`bolt_condition_operator`):** `equals, not_equals, contains, not_contains,
    starts_with, ends_with, greater_than, less_than, is_empty, is_not_empty, in, not_in,
    matches_regex` (13).
  - **logic_group (`bolt_condition_logic`):** `and` | `or`.
  - **Field path rule:** conditions evaluate against a wrapped payload
    `{ event: <payload>, actor: { id, type } }`. Fields reading the body MUST be `event.`-prefixed
    (e.g. `event.task.priority`); a bare path resolves to undefined and never matches. (Documented
    in `template.service.ts` header; implemented in `event-ingestion.routes.ts`.)
- **Action:** an MCP tool call with templated `parameters`, `on_error`, and retry settings. Table
  `bolt_actions`.
  - **on_error (`bolt_on_error`):** `stop` | `continue` | `retry`. UI labels Stop/Continue/Retry
    (`apps/bolt/src/components/builder/action-editor.tsx`).
  - **mcp_tool:** must be on Bolt's curated allowlist (§6); else `INVALID_MCP_TOOL`.
  - **Templating (worker-resolved):** `{{ event.* }}`, `{{ actor.id|type }}`, `{{ automation.* }}`,
    `{{ now }}`, `{{ step[N].result.* }}`. No `{{ actor.name }}`, no top-level `{{ org.* }}`
    (`apps/worker/src/jobs/bolt-execute.job.ts`).
- **Execution:** one run vs one event. Table `bolt_executions`.
  - **status (`bolt_execution_status`):** `running, success, partial, failed, skipped`. UI badge
    labels match (`apps/bolt/src/components/execution/status-badge.tsx`).
  - **skip reasons** in `evaluation_trace`: `max_chain_depth_exceeded`, `cooldown_active`,
    `rate_limited`, `conditions_not_met`.
- **Execution step:** one action attempt. Table `bolt_execution_steps`. status
  (`bolt_step_status`): `success, failed, skipped`.
- **Event catalog:** static read-only list of trigger events (per source) + payload schemas, and
  the action allowlist. `apps/bolt-api/src/services/event-catalog.ts`. Surfaced via
  `GET /v1/events`, `/v1/events/:source`, `/v1/actions`.
- **Template:** pre-built automation blueprint. `template.service.ts` (+ `templates/banter-approval-dm.ts`).
- **Version:** auto snapshot on every update; restorable. `bolt_automation_versions`. API only
  (no UI).
- **Graph / BoltGraph:** node-graph of `trigger|condition|action` nodes + edges, JSONB `graph` +
  `graph_mode`. Compiled to/from rows (`bolt-graph-compiler.ts`); types `apps/bolt/src/types/bolt-graph.ts`.
- **Limits / guards:** `max_executions_per_hour` (def 100, UI default 60, 1-10000);
  `cooldown_seconds` (def 0, 0-86400); `max_chain_depth` (def 5, not user-editable);
  `template_strict` (def false); `notify_owner_on_failure` (def false); action params max depth 3 /
  50 KB; conditions <=50; actions 1-50.
- **Self-trigger detection:** create/update maps action tools -> produced events and warns
  (non-blocking `_warnings`) on possible self re-fire (`detectSelfTrigger`, `automation.service.ts`).
- **SSRF guard:** `send_webhook` URLs validated; private/loopback blocked `SSRF_BLOCKED`
  (`apps/bolt-api/src/lib/url-validator.ts`).
- **Cross-org guard:** `project_id`/`user_id`/`assignee_id` UUID params verified to belong to the
  org (strict create -> `CROSS_ORG_REFERENCE`; lenient warn on update).

---

## 3. Backend REST inventory (`apps/bolt-api/src`, prefix `/bolt/api/v1`)

All routes require auth unless noted; many add a `shadowOnly`/`requireCan` permission gate; write
routes require `read_write` scope. Error envelope `{ error: { code, message, details, request_id } }`.

### Automations — `routes/automation.routes.ts`
- **GET `/automations`** — list (cursor paginated). Query: `project_id`, `trigger_source`,
  `enabled` ("true"/"false"), `search`, `cursor`, `limit` (<=100). Returns `{ data, meta:{ next_cursor, has_more } }`. Order: `created_at` asc.
- **POST `/automations`** — create. Rate 20/min, scope `read_write`, perm `bolt.automation.create`.
  Body: `name`*, `description?`, `project_id?`, `enabled?`(def true), `trigger_source`*,
  `trigger_event`*, `trigger_filter?`, `cron_expression?`, `cron_timezone?`(UTC),
  `max_executions_per_hour?`(100), `cooldown_seconds?`(0), `conditions[]?`, `actions[]`(min 1) OR
  `graph`. Validates allowlist + cross-org (strict) + SSRF. 201 `{ data }`.
- **GET `/automations/stats`** — `{ data:{ total, enabled, disabled, by_source } }`. Query `project_id?`.
- **GET `/automations/by-name/:name`** — name resolver (exact CI, then single-hit fuzzy). Returns
  `{ data:{...}|null }` (no 404). Includes `action_count`, `last_execution_at`.
- **GET `/automations/:id`** — full automation w/ conditions, actions, synthesized `graph`.
- **PUT `/automations/:id`** — full update; replaces conditions/actions; recompiles/clears graph;
  snapshots a version. Scope `read_write`.
- **PATCH `/automations/:id`** — partial metadata (`name`,`description`,`enabled`).
- **DELETE `/automations/:id`** — 204 (cascades conditions/actions/executions/versions).
- **POST `/automations/:id/enable`** — `enabled=true` (400 if already enabled).
- **POST `/automations/:id/disable`** — `enabled=false` (400 if already disabled).
- **POST `/automations/:id/duplicate`** — clone "<name> (copy)", starts **disabled**. Rate 20/min, 201.
- **POST `/automations/:id/test`** — evaluate conditions vs supplied event (NO action execution).
  Rate 10/min. Body `{ event }` required. Returns `{ data:{ passed, log, message } }`.
- **GET `/automations/:id/versions`** — version snapshots, newest first.
- **POST `/automations/:id/versions/:vid/restore`** — restore snapshot (records new version). Rate 10/min, scope `read_write`.

### Executions — `routes/execution.routes.ts`
- **GET `/automations/:id/executions`** — executions for one automation (newest first). `status?`,`cursor?`,`limit?`.
- **GET `/executions`** — org-wide list joined with `automation_name`. Perm `bolt.execution.list`.
- **GET `/executions/:id`** — detail with ordered steps. 404 if cross-org. `{ data:{...execution, steps[] } }`.
- **POST `/executions/:id/retry`** — re-queue. Perm `bolt.execution_retry.create`. Only
  `failed`/`partial` (else 400). Enforces hourly rate (429 `RATE_LIMITED`). Inserts new `running` row.

### Event catalog — `routes/event.routes.ts`
- **GET `/events`** — full catalog. **GET `/events/:source`** — per source (400 unknown).
  **GET `/actions`** — action allowlist w/ param schemas.

### Observability — `routes/observability.routes.ts` (registered before `/events/:source`)
- **GET `/events/:event_id/trace`** — full evaluation trail for one ingest event. Org-scoped.
  `{ data:{ event_id, executions[] } }`.
- **GET `/events/recent`** — recent ingest events that matched >=1 automation. `source?`,`event?`,`since?`(ISO),`limit?`(<=500).

### AI assist — `routes/ai-assist.routes.ts` (NO frontend caller)
- **POST `/ai/generate`** — NL prompt -> automation def via LLM (stub fallback). Rate 10/min. 422 if no provider.
- **POST `/ai/explain`** — explain automation in plain English. Same provider handling.

### Event ingestion (internal) — `routes/event-ingestion.routes.ts`
- **POST `/events/ingest`** — other services POST `{ event_type, source, payload, org_id,
  project_id?, actor_id?, actor_type?, chain_depth? }`. Auth via `X-Internal-Secret`. Rate 500/min.
  Matches enabled automations on (org, source, event); checks chain depth -> cooldown -> hourly
  rate -> conditions -> trigger_filter; inserts `running`/`skipped` executions; enqueues a
  `bolt-execute` job per match; fire-and-forgets drift detect + webhook fan-out. Returns
  `{ data:{ event_id, matched, executions[] } }`.

Publishers across `apps/` call `publishBoltEvent({ event, source, payload })` from `@bigbluebam/shared`.

---

## 4. Execution lifecycle

1. Source app publishes -> `POST /v1/events/ingest`.
2. Match enabled automations on `(org_id, trigger_source, trigger_event)`.
3. Per match in order: chain-depth -> cooldown (Redis) -> hourly rate (Redis) -> conditions ->
   trigger_filter equality. Any failure inserts a `skipped` execution w/ `skip_reason`, continue.
4. On pass: insert `running` execution, set cooldown, bump `last_executed_at`, enqueue job.
5. Worker resolves templated params, calls MCP `POST /tools/call`, records a `bolt_execution_steps`
   row per action, honoring `on_error` (stop/continue/retry) and `template_strict`.
6. Final status: all ok -> `success`; some failed but all ran (continue) -> `partial`; halted early
   -> `failed`. If `notify_owner_on_failure`, owner notification w/ deep link `/bolt/executions/<id>`.
7. `/test` only evaluates conditions — never runs actions.

---

## 5. Frontend inventory (`apps/bolt/src`)

Router (`app.tsx`, base `/bolt`): `/` home, `/new`, `/automations/:id` editor,
`/automations/:id/executions`, `/executions`, `/executions/:id`, `/templates`, `/help`. Unknown -> home.

**Chrome** (`components/layout/bolt-layout.tsx`, `bolt-sidebar.tsx`): brand "Bolt" + "beta" pill;
**Project scope selector** ("All Projects" default) scopes list+stats; **nav** "Automations" (Zap)
-> `/`, "Executions" (Activity) -> `/executions`, "Templates" (LayoutTemplate) -> `/templates`;
platform footer; `?` opens shared `HelpViewer` (`appSlug="bolt"`).

### Automations home — `pages/home.tsx`
- Heading "Automations" / "Create trigger-condition-action workflows to automate your work."
- **"New Automation"** (Plus) -> `/new`.
- Stat cards "Total Automations", "Enabled", "Disabled".
- Filters: search ("Search automations..."); source chips "All" + Bam/Banter/Beacon/Brief/Helpdesk/
  Schedule/Bond/Blast/Board/Bench/Bearing/Bill/Book/Blank; "Enabled"/"Disabled" toggles.
- Card: Power/PowerOff toggle (title "Enable"/"Disable" -> POST enable/disable); name + source
  badge; trigger_event + description; "Last run"; "Actions" count; more-menu "Edit",
  "View Executions", "Duplicate", "Delete" (window.confirm). Empty "No automations found".

### Automation editor — `pages/automation-editor.tsx` (`/new`, `/automations/:id`)
- Title input "Automation name...", description "Add a description...".
- Mode toggle **"Simple" | "Visual"**.
- Simple sections:
  - **"WHEN — Trigger"** (blue): "Trigger Source" + "Event Type" selects (option = `event — desc`).
    `schedule` shows "Schedule" CronEditor (Presets/Custom/Advanced, 11 presets, DOW picker,
    timezone, plain-English description). Collapsible "Add trigger filter" / "Filter (N rules)".
  - **"IF — Conditions" (optional)** (amber): empty "Always run". Rows: logic toggle (Where /
    AND/OR), field picker, operator select (type-filtered; friendly labels), value input, remove.
    "Add Condition".
  - **"THEN — Actions"** (green): "Add at least one action...". Each: #N, action select grouped by
    source (option = tool description), Parameters (required "*", enum/boolean selects, `{{ }}`
    template inputs, "Add optional parameter (N available)"), "Show advanced" -> "On Error"
    (Stop/Continue/Retry) + "Retry Count". "Add Action".
- Visual mode: node palette (Trigger/Condition/Action; "Only one trigger allowed"), canvas
  (shortcuts via `?`: Delete/Backspace, Escape, Ctrl+A, Scroll zoom, Drag pan), Node inspector
  ("Select a node on the canvas to configure it.").
- Settings sidebar: "Enabled" toggle, "Max Executions / Hour" (60), "Cooldown (seconds)",
  "Summary" card, buttons **"Test Run"** (existing only), **"Save Draft"**, **"Save & Enable"**.
- Error banner "Please fix the following errors before saving:".

### Per-automation executions — `pages/automation-executions.tsx`
- Back "Back to <name>"; heading "<name> — Executions"; status chips All/Success/Failed/Partial/
  Running/Skipped; table Status/Duration/Conditions Met/Error/Started -> detail.

### Org Execution Log — `pages/execution-log.tsx`
- Heading "Execution Log" / "History of all automation runs across your organization."; status
  chips; automation dropdown ("All automations") when >1; table Automation/Status/Duration/
  Conditions Met/Started -> detail.

### Execution detail — `pages/execution-detail.tsx`
- Back "Back to Executions"; heading = automation name; status badge; **"Retry"** (only
  failed/partial) -> POST retry; cards Duration/Conditions Met/Steps/Completed; Error block;
  "Trigger Event" JSON; "Condition Evaluation" JSON; "Execution Steps" timeline.

### Templates — `pages/template-browser.tsx`
- Heading "Templates" / "Start with a pre-built automation template and customize it."; cards with
  source badge, name, description, trigger_event, **"Use Template"** -> POST instantiate -> editor.

### Help — shared `HelpViewer` (`/help` or `?`).

---

## 6. Event catalog & action catalog (`apps/bolt-api/src/services/event-catalog.ts`)

**Event catalog:** ~120 event definitions across `bam, banter, beacon, brief, helpdesk, schedule,
bond, blast, board, bearing, bill, book, blank, bench, blueprint, bureau` + a wave1b/platform bucket
(incl. `approval.requested`, `proposal.created/decided`, `catalog.drift_detected`,
`agent.webhook.disabled/dead_lettered`). Each event has a `payload_schema` (name/type/enum/format)
that drives the type-aware condition picker.

> Catalog vs UI: trigger-source dropdowns only list the 14 enum sources. `blueprint`/`bureau` events
> exist in the catalog but have no enum value, so they cannot be selected as triggers.

**Action catalog** (`getAvailableActions()`), curated allowlist by source:
- bam (12), banter (14), beacon (12), brief (12), helpdesk (3), bond (12), blast (5), board (7),
  bearing (6), bill (8), book (6), blank (5), bench (6), system (2: send_email_notification, send_webhook).
Full tool lists are in the file's `curated` array. Param schemas come from
`mcp-tool-schemas.generated.ts` (real tools) + `SYSTEM_TOOL_PARAMS` (system primitives).

---

## 7. Templates (16) — `template.service.ts` (15) + `templates/banter-approval-dm.ts` (1)

| id | name (as shown) | category | trigger | functional? |
|---|---|---|---|---|
| tpl_notify_task_overdue | Notify on overdue task | notifications | bam/task.overdue | yes |
| tpl_auto_assign_ticket | Auto-progress high-priority tickets | helpdesk | helpdesk/ticket.created | yes |
| tpl_sprint_complete_summary | Sprint completion summary | notifications | bam/sprint.completed | yes (edit channel) |
| tpl_beacon_expiry_alert | Alert on beacon expiry | knowledge | beacon/beacon.expired | yes |
| tpl_task_comment_to_banter | Mirror task comments to Banter | sync | bam/comment.created | yes |
| tpl_brief_approved_to_beacon | Auto-promote published docs to Beacon | knowledge | brief/document.published | yes (default tags) |
| tpl_sla_breach_escalate | Escalate SLA breaches | helpdesk | helpdesk/ticket.sla_breach | partial (create_task needs manual project_id+phase_id) |
| tpl_new_member_onboard | New member onboarding (requires agent — placeholder) | onboarding | banter/channel.created | NOT FUNCTIONAL (no member-join event) |
| tpl_high_priority_task_alert | Alert on high-priority task creation | notifications | bam/task.created | yes |
| tpl_daily_standup_reminder | Daily standup reminder | schedule | schedule/cron.fired | yes (supply cron) |
| tpl_new_document_notification | New document notification | notifications | brief/document.created | yes |
| tpl_weekly_status_update | Weekly status reminder | schedule | schedule/cron.fired | yes (supply cron) |
| tpl_task_moved_to_review | Task moved to review | notifications | bam/task.moved | yes |
| tpl_close_ticket_on_task_complete | Close ticket on task complete (requires agent) | sync | bam/task.completed | NOT FUNCTIONAL in pure Bolt (inert guard) |
| tpl_bond_deal_close_invoice | Create invoice on deal close (requires agent for invoice step) | billing | bond/deal.won | partial (DM works; invoice needs agent) |
| tpl_banter_approval_dm | Send approval request DM | notifications | platform/approval.requested | yes (but see Discrepancies #9) |

**Instantiate** `POST /templates/:id/instantiate` (`routes/template.routes.ts`): optional overrides
`name`,`description`,`project_id`,`cron_expression`,`cron_timezone`; copies conditions/actions
verbatim; creates an automation. UI "Use Template" sends no overrides and jumps to the editor.

Authoring rules (file header): condition fields must be `event.`-prefixed; action param keys must
match live MCP signatures; several "requires-agent" templates are intentionally non-functional
placeholders (document as starting points, not turnkey).

---

## 8. MCP tools

### `bolt-tools.ts` (13)
`bolt_list`, `bolt_get`, `bolt_get_automation_by_name`, `bolt_create`, `bolt_update`, `bolt_enable`,
`bolt_disable`, `bolt_delete`, `bolt_test` (evaluates conditions w/ simulated `event`),
`bolt_executions`, `bolt_execution_detail`, `bolt_events`, `bolt_actions`. Each maps to the obvious
human feature (list/open/create/edit/enable/disable/delete/test/executions/catalogs). Mutating
tools resolve `id` via `bolt_get_automation_by_name` when not a UUID; return clean "Automation not
found" on miss.

### `bolt-observability-tools.ts` (2)
`bolt_event_trace` (full eval trail for one ingest event_id), `bolt_recent_events` (recent matched
ingest events, filters source/event/since/limit<=500).

Total = **15** (13 + 2). No MCP tool for duplicate, versions/restore, or AI generate/explain.

---

## 9. Agent flows

1. **Authoring/operating via MCP** (`bolt_create/update/enable/disable/delete/test`,
   `bolt_get_automation_by_name`) — enables meta-automations (disable "Nightly Deploys" by name).
   Service-account calls pass the agent_policies kill-switch/allowlist
   (`apps/mcp-server/src/lib/register-tool.ts`).
2. **Agents are the execution substrate** — every action is an MCP call the worker makes to
   `POST /tools/call` (`apps/worker/src/jobs/bolt-execute.job.ts`). Several "requires-agent"
   templates wire a working notify step and defer the cross-app resolution (task->ticket map,
   deal->Bill client) to an agent runner.
3. **Observe/debug** via `bolt_event_trace` / `bolt_recent_events`. Bolt emits platform
   `catalog.drift_detected` on unknown events (`catalog-drift-detector.ts`) and fans subscribed
   events to agent runners via HMAC-signed outbound webhooks (`webhook-dispatch-hook.ts`).

Canonical cross-app demo (`scripts/seed-acme-scenario.mjs`): a Bond stale-deal automation triggers
on `bond/deal.rotting` (daily 2AM worker job for deals past `rotting_days`) and auto-creates a Bam task.

---

## 10. Screenshots available (`docs/apps/bolt/screenshots/{light,dark}/`)

5 screenshots x light+dark (10 files); labels from `meta.json` (captured 2026-04-17):
- `01-automations.png` — "Automation list" — home list/stats/filters — browse, enable/disable, New Automation.
- `02-editor.png` — "Automation builder" — editor WHEN/IF/THEN + settings — build a rule, Save/Test.
- `03-detail.png` — "Automation detail" — actually the **execution detail** page — inspect a run, Retry.
- `04-executions.png` — "Execution log" — org-wide log table — monitor/filter runs.
- `05-templates.png` — "Automation templates" — templates grid — start from a template, Use Template.

---

## 11. Discrepancies (docs / marketing / code)

1. **AI authoring has no UI.** README/marketing tout "AI-assisted authoring" / "Describe your
   automation" and `/ai/generate` + `/ai/explain` exist, but no `apps/bolt/src` file calls them.
   AI is backend/agent-only today; do not document a visible AI button.
2. **Versioning has no UI.** `/automations/:id/versions` + restore exist and `updateAutomation`
   snapshots on every save, but no frontend lists/restores versions.
3. **`bolt_test` semantics.** MCP `bolt_test` describes "test-fire ... with a simulated event
   payload" and mentions `actions_executed`, but `/test` only **evaluates conditions**
   (`{ passed, log, message }`) — it does NOT execute actions. Same for UI "Test Run".
4. **"Test Run" likely broken (verify).** `useTestAutomation` POSTs `/test` with no body, but
   `testAutomationSchema` requires `{ event }` -> would 400 `VALIDATION_ERROR`
   (`apps/bolt/src/hooks/use-automations.ts` vs `automation.routes.ts`). Flag, do not document as working.
5. **Test Run reads a missing field.** Editor reads `testMutation.data.data.execution_id`, but
   `/test` returns no `execution_id`. Reinforces #4.
6. **Screenshot 03 mislabeled.** "Automation detail" in meta/guide is actually the **execution**
   detail page; there is no standalone automation-detail view (the editor doubles as it).
7. **guide.md/mcp-tools.md omit the 2 observability tools** (list 13, README counts 15). The
   `bolt_get_automation_by_name` row is also mangled by the generator ("caller\\" / "none").
8. **"Branching" claim.** Marketing says branching; the engine runs a linear ordered action list —
   conditions gate the whole automation, not per-edge branches (the compiler flattens the graph).
   Variable interpolation (`{{ step[N].result.* }}`) IS real.
9. **Source list drift.** UI/enum cover 14 sources; catalog also defines `blueprint`/`bureau`
   events (unusable as triggers). `tpl_banter_approval_dm` uses `trigger_source: 'platform'`, not
   in the enum -> instantiating it may be rejected by the create schema (verify).
10. **`task.priority` enum stale.** Catalog annotates `['low','medium','high','urgent']`; real
    default slugs are `critical|high|medium|low|none` (migration 0183). Templates match `high`/`critical`.

---

## 12. Open questions

1. Does "Test Run" actually 400 due to the missing `event` body (#4/#5)? Live check
   `POST /bolt/api/v1/automations/<id>/test`.
2. Does instantiating `tpl_banter_approval_dm` (`platform` source) succeed or get rejected by the
   create-schema enum? (#9)
3. Is a versions/restore UI planned, or is it agent/API-only?
4. How robust is the visual-graph round-trip for non-linear graphs given the compiler flattens to a
   linear action list?
5. Is the 3-tool helpdesk action scope intentional vs the broader helpdesk catalog?
6. The `cron.fired` schedule trigger: `bolt_schedules.next_run_at` seeds `null`; which service
   computes next_run and emits `schedule/cron.fired`? (CLAUDE.md references a `bolt-schedule-tick`
   worker job, not read here.) Confirm scheduled automations fire before documenting as turnkey.
