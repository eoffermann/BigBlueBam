# Bolt (Workflow Automation) -- Design Audit

**Date:** 2026-04-09
**Auditor:** Claude Opus 4.6 (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Bolt_Design_Document.md` (v1.0, April 7 2026)
**Implementation:** `apps/bolt-api/src/` (API), `apps/bolt/src/` (Frontend), `apps/mcp-server/src/tools/bolt-tools.ts` (MCP)

---

## Executive Summary

Bolt's implementation is **substantially complete for API and frontend CRUD surfaces** but **missing its runtime execution engine entirely**. The visual rule builder, automation management, execution log UI, templates, MCP tools, and data model are all well-built and closely match the design document. However, the core value proposition -- automations that actually fire when events occur -- has no implementation. There are no BullMQ processors in the worker, no Redis PubSub event consumers, no event publishers in the source APIs (Bam, Banter, Beacon, Brief, Helpdesk), and no MCP executor service. The test endpoint only evaluates conditions against a simulated payload; it does not execute actions.

**Overall Completion: ~58%**

- API CRUD & validation: ~90%
- Data model (Drizzle + migration): ~95%
- Frontend SPA: ~75%
- MCP tools: ~90%
- Execution engine (event router, executor, scheduler): 0%
- Event publishing from source APIs: 0%
- AI-assisted authoring (real LLM integration): ~15%

---

## Rating Scale

| Rating | Meaning |
|--------|---------|
| **P0** | Not implemented at all -- no code exists |
| **P1** | Stub or placeholder only -- code exists but does nothing meaningful |
| **P2** | Partially implemented -- core logic present but significant gaps |
| **P3** | Mostly implemented -- minor deviations or missing edge cases |
| **P4** | Nearly complete -- cosmetic or trivial gaps only |
| **P5** | Fully matches design specification |

---

## Feature Table

### 1. Data Model & Schema

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 1.1 | `bolt_automations` table | Sec 3.2 | **P5** | All columns match design. Extra `max_chain_depth` column added (BOLT-005 loop guard -- exceeds design). Uses Drizzle pgEnum for `trigger_source`. `organization_id` mapped to `org_id` (naming convention match). |
| 1.2 | `bolt_conditions` table | Sec 3.2 | **P5** | All columns, operators, and logic groups match. Uses pgEnum for operator and logic. |
| 1.3 | `bolt_actions` table | Sec 3.2 | **P5** | All columns match. `on_error`, `retry_count`, `retry_delay_ms` present. |
| 1.4 | `bolt_executions` table | Sec 3.2 | **P5** | All columns match: status enum, trigger_event JSONB, condition_log, error_message, error_step, duration_ms. |
| 1.5 | `bolt_execution_steps` table | Sec 3.2 | **P5** | All columns match: execution_id, action_id, step_index, mcp_tool, parameters_resolved, status, response, error_message, duration_ms. |
| 1.6 | `bolt_schedules` table | Sec 3.2 | **P5** | Matches design: automation_id (unique), next_run_at, last_run_at. |
| 1.7 | Indexes | Sec 3.2 | **P4** | All major indexes present. Partial index on `enabled` uses `.on(table.enabled)` instead of `WHERE enabled = true` conditional -- minor difference. |

### 2. API Endpoints

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 2.1 | `GET /automations` | Sec 6.2 | **P5** | Filterable by project, trigger_source, enabled, search. Cursor-based pagination. |
| 2.2 | `POST /automations` | Sec 6.2 | **P5** | Full creation with trigger + conditions + actions. Validates MCP tools against allowlist. Validates org-scoped entity refs. Detects self-triggering loops (BOLT-005). |
| 2.3 | `GET /automations/:id` | Sec 6.2 | **P5** | Returns automation with conditions and actions. |
| 2.4 | `PUT /automations/:id` | Sec 6.2 | **P5** | Full update with replace semantics for conditions/actions. |
| 2.5 | `PATCH /automations/:id` | Sec 6.2 | **P5** | Partial metadata update (name, description, enabled). |
| 2.6 | `DELETE /automations/:id` | Sec 6.2 | **P5** | Deletes automation (cascades via FK). |
| 2.7 | `POST /automations/:id/enable` | Sec 6.2 | **P5** | Enable with idempotency check. |
| 2.8 | `POST /automations/:id/disable` | Sec 6.2 | **P5** | Disable with idempotency check. |
| 2.9 | `POST /automations/:id/duplicate` | Sec 6.2 | **P5** | Deep-copies automation (starts disabled). |
| 2.10 | `POST /automations/:id/test` | Sec 6.2 | **P3** | Evaluates conditions against simulated payload and returns pass/fail. Does NOT execute actions via MCP as described in design ("test-fire automation with a simulated event payload"). Only condition evaluation is tested. |
| 2.11 | `GET /automations/:id/executions` | Sec 6.2 | **P5** | Paginated, filterable by status. |
| 2.12 | `GET /executions/:id` | Sec 6.2 | **P5** | Returns execution with step details. |
| 2.13 | `POST /executions/:id/retry` | Sec 6.2 | **P4** | Creates new execution record with `running` status. Enforces max_executions_per_hour. Does not actually dispatch to a worker (no BullMQ integration), so retry is recorded but never runs. |
| 2.14 | `GET /executions` (org-wide) | Sec 6.2 | **P5** | Admin-only, returns executions across all org automations with automation_name. |
| 2.15 | `GET /events` | Sec 6.2 | **P5** | Full event catalog with payload schemas. |
| 2.16 | `GET /events/:source` | Sec 6.2 | **P5** | Filtered by source. |
| 2.17 | `GET /actions` | Sec 6.2 | **P5** | Static registry of available MCP tools as actions. |
| 2.18 | `GET /templates` | Sec 6.2 | **P5** | Lists 10 pre-built templates. |
| 2.19 | `POST /templates/:id/instantiate` | Sec 6.2 | **P5** | Creates automation from template with overrides. |
| 2.20 | `POST /ai/generate` | Sec 6.2 | **P1** | Endpoint exists, resolves LLM provider, but returns hardcoded sample automation. No actual LLM call. |
| 2.21 | `POST /ai/explain` | Sec 6.2 | **P1** | Endpoint exists, but generates explanation via string concatenation, not LLM. |
| 2.22 | `GET /automations/stats` | (bonus) | **P5** | Not in design doc. Returns total/enabled/disabled counts and breakdown by source. Exceeds spec. |

### 3. Services & Business Logic

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 3.1 | Condition evaluation engine | Sec 5.2 | **P5** | All 13 operators implemented. AND/OR group logic correct. Dot-notation field resolution. ReDoS protection on regex operator. Prototype pollution guards. |
| 3.2 | Template variable resolver | Sec 5.1 | **P5** | Supports `{{ event.* }}`, `{{ actor.* }}`, `{{ automation.* }}`, `{{ now }}`, `{{ step[N].result.* }}`. No eval/Function -- pure regex replacement. Recursive resolution on objects/arrays. |
| 3.3 | Event catalog | Sec 4.2 | **P4** | 26 events across 6 sources. Missing `epic.completed` event from Bam (design lists it in Sec 4.2). |
| 3.4 | MCP tool allowlist | Sec 8 | **P5** | 20 tools registered. Actions validated against allowlist at creation and update time. |
| 3.5 | SSRF URL validation | Sec 13 | **P5** | `send_webhook` action parameters validated against private IP ranges, cloud metadata endpoints, blocked hostnames. Not in original design but called out in Sec 13 as future work -- implementation exceeds spec. |
| 3.6 | Self-trigger / loop detection | (bonus) | **P5** | BOLT-005: Maps MCP tools to produced events, warns when automation could trigger itself. Not in design doc -- exceeds spec. |
| 3.7 | Org-scoped parameter validation | (bonus) | **P5** | Validates that entity references (project_id, user_id, assignee_id) in action parameters belong to the caller's org. Not in design doc -- exceeds spec. |

### 4. Execution Engine (BullMQ Worker)

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 4.1 | Bolt Event Router (`bolt:route` queue) | Sec 2.2, 10 | **P0** | No BullMQ processor exists in `apps/worker/`. No code subscribes to `bolt:events` Redis PubSub channel. No automation matching logic at runtime. |
| 4.2 | Bolt Executor (`bolt:execute` queue) | Sec 2.2, 10 | **P0** | No execution processor. No MCP tool call dispatch. The `mcp-executor.ts` service file referenced in Sec 6.1 does not exist. |
| 4.3 | Cron Scheduler (`bolt:schedule` queue) | Sec 10 | **P0** | No cron tick processor. `bolt_schedules` table exists but is never read by a scheduler process. |
| 4.4 | Execution Log Cleanup (`bolt:cleanup` queue) | Sec 10 | **P0** | No nightly purge job for old execution records. |
| 4.5 | Rate limiting (Redis counters) | Sec 5.3 | **P0** | No Redis rate-limit counters (`bolt:rate:*`, `bolt:cooldown:*`) are implemented. The retry endpoint checks DB counts but the runtime engine (which would enforce per-execution rate limits) does not exist. |
| 4.6 | Error handling (stop/continue/retry) | Sec 5.4 | **P0** | Error policy fields exist on actions, but no executor implements the stop/continue/retry logic. |
| 4.7 | Failed execution owner notification | Sec 5.4 | **P0** | Not implemented -- requires executor + Banter DM integration. |

### 5. Event Publishing from Source APIs

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 5.1 | Bam API event publishing | Sec 4.3 | **P0** | No `publishBoltEvent()` calls found in any source API. No Redis PUBLISH to `bolt:events` channel anywhere in the codebase. |
| 5.2 | Banter API event publishing | Sec 4.3 | **P0** | Same -- not implemented. |
| 5.3 | Beacon API event publishing | Sec 4.3 | **P0** | Same -- not implemented. |
| 5.4 | Brief API event publishing | Sec 4.3 | **P0** | Same -- not implemented. |
| 5.5 | Helpdesk API event publishing | Sec 4.3 | **P0** | Same -- not implemented. |

### 6. MCP Tools

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 6.1 | `bolt_list` | Sec 7.1 | **P5** | Matches design. |
| 6.2 | `bolt_get` | Sec 7.1 | **P5** | Matches design. |
| 6.3 | `bolt_create` | Sec 7.1 | **P5** | Matches design. |
| 6.4 | `bolt_update` | Sec 7.1 | **P5** | Matches design. |
| 6.5 | `bolt_enable` | Sec 7.1 | **P5** | Matches design. |
| 6.6 | `bolt_disable` | Sec 7.1 | **P5** | Matches design. |
| 6.7 | `bolt_delete` | Sec 7.1 | **P5** | Matches design. |
| 6.8 | `bolt_test` | Sec 7.1 | **P5** | Matches design. |
| 6.9 | `bolt_executions` | Sec 7.1 | **P5** | Matches design. |
| 6.10 | `bolt_execution_detail` | Sec 7.1 | **P5** | Matches design. |
| 6.11 | `bolt_events` | Sec 7.1 | **P5** | Matches design. |
| 6.12 | `bolt_actions` | Sec 7.1 | **P5** | Matches design. |

### 7. Frontend SPA

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 7.1 | `AutomationListPage` (Home) | Sec 8.1 | **P5** | List with stats cards, search, source chip filters, enabled toggle, card actions (edit, executions, duplicate, delete). |
| 7.2 | `AutomationEditorPage` | Sec 8.1, 8.2 | **P4** | WHEN/IF/THEN vertical flow layout matches design. Trigger selector, condition list, action list, settings sidebar. Missing: AutomationPreview (natural-language summary). |
| 7.3 | `TriggerSelector` | Sec 8.1 | **P5** | Source dropdown + event type dropdown. Loads events from catalog API. |
| 7.4 | `TriggerFilterEditor` | Sec 8.1 | **P4** | Inline in editor page as key-value pair builder. Not a separate component file as designed but functionally present. |
| 7.5 | `ConditionList` + `ConditionRow` | Sec 8.1 | **P5** | Add/remove conditions. AND/OR toggle. All 13 operators. Field picker is a text input (not schema-aware autocomplete -- see 7.14). |
| 7.6 | `ActionList` + `ActionEditor` | Sec 8.1 | **P5** | Add/remove actions. MCP tool picker (grouped by source). Key-value parameter editor. Error policy (stop/continue/retry). Retry count. |
| 7.7 | `ExecutionLogPage` (org-wide) | Sec 8.1 | **P5** | Table with status filter chips. Shows automation name, status badge, duration, conditions met, started time. |
| 7.8 | `ExecutionDetailPage` | Sec 8.1 | **P5** | Summary cards (duration, conditions met, steps, completed). Trigger event JSON view. Condition log. Step timeline. Retry button for failed/partial. |
| 7.9 | `ExecutionTimeline` | Sec 8.1 | **P5** | Vertical timeline with status icons, expandable step details (parameters, response, error). |
| 7.10 | `TemplateBrowserPage` | Sec 8.1 | **P5** | Grid of template cards with instantiate button. |
| 7.11 | `AutomationExecutionsPage` | (bonus) | **P5** | Per-automation execution list page. Not in design (design only mentions `ExecutionLogPage` for org-wide). Exceeds spec. |
| 7.12 | `StatusBadge` | Sec 8.1 | **P5** | Present and used across execution views. |
| 7.13 | `CronEditor` (visual) | Sec 8.1 | **P0** | Design calls for a "visual cron schedule builder". Implementation uses a plain text input for cron expressions. |
| 7.14 | `FieldPicker` (schema-aware) | Sec 8.1 | **P0** | Design specifies "dot-notation field selector with schema-aware autocomplete". Implementation uses plain text inputs. |
| 7.15 | `McpToolPicker` (with param forms) | Sec 8.1 | **P3** | Design specifies "searchable MCP tool selector with parameter forms". Implementation has a grouped `<select>` dropdown -- not searchable. Parameters are key-value text inputs, not schema-generated forms. |
| 7.16 | `AiAssistDialog` | Sec 8.1, 8.3 | **P0** | Design calls for a dialog where users describe automations in natural language. No component exists. |
| 7.17 | `AutomationPreview` | Sec 8.1 | **P0** | Design specifies "natural-language summary of the rule" component. Not implemented. |
| 7.18 | `TemplateVariableHelper` | Sec 8.1 | **P0** | Design specifies "autocomplete for {{ event.* }} variables". Not implemented -- users type variables manually. |
| 7.19 | `AutomationTable` (sortable list view) | Sec 8.1 | **P0** | Design lists both `AutomationCard` and `AutomationTable` (sortable list view). Only card view exists. |
| 7.20 | `StepDetail` (separate component) | Sec 8.1 | **P3** | Design lists a standalone `StepDetail` component. Step detail rendering is inline within `ExecutionTimeline` instead. Functionally equivalent. |
| 7.21 | `builderStore` (Zustand) | Sec 8.1 | **P0** | Design specifies a Zustand store for builder UI state. Form state is managed with `useState` in the editor page. Works but doesn't match design architecture. |
| 7.22 | Dark mode / theming | -- | **P5** | Fully implemented with localStorage persistence and system preference detection. |

### 8. Templates (Pre-Built)

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 8.1 | Notify on Critical Task | Sec 9 | **P4** | Named "Alert on high-priority task creation" (tpl_high_priority_task_alert). Triggers on `task.created` with high/critical condition. Close match but different framing. |
| 8.2 | Overdue Task Alert | Sec 9 | **P5** | `tpl_notify_task_overdue` -- matches design. |
| 8.3 | Sprint Complete Report | Sec 9 | **P5** | `tpl_sprint_complete_summary` -- matches design. |
| 8.4 | Helpdesk Auto-Assign by Category | Sec 9 | **P4** | `tpl_auto_assign_ticket` -- triggers on priority=high rather than category=billing. Functionally similar pattern. |
| 8.5 | SLA Breach Escalation | Sec 9 | **P5** | `tpl_sla_breach_escalate` -- matches design. Two actions (Banter + task). |
| 8.6 | Beacon Expiry Reminder | Sec 9 | **P5** | `tpl_beacon_expiry_alert` -- matches design. |
| 8.7 | New Document Notification | Sec 9 | **P0** | Missing. Design specifies `document.created` trigger posting to Banter project channel. |
| 8.8 | Weekly Status Update | Sec 9 | **P0** | Missing. Design specifies `cron.fired` (Mon 9am) generating a report. |
| 8.9 | Task Moved to Review | Sec 9 | **P0** | Missing. Design specifies `task.moved` with `to_phase = "Review"`. |
| 8.10 | Close Ticket on Task Complete | Sec 9 | **P0** | Missing. Design specifies `task.completed` updating linked ticket. |
| 8.11 | (bonus) Mirror task comments to Banter | -- | **P5** | `tpl_task_comment_to_banter` -- not in design. Extra template. |
| 8.12 | (bonus) Auto-promote approved docs to Beacon | -- | **P5** | `tpl_brief_approved_to_beacon` -- not in design. Extra template. |
| 8.13 | (bonus) New member onboarding | -- | **P5** | `tpl_new_member_onboard` -- not in design. Extra template. |
| 8.14 | (bonus) Daily standup reminder | -- | **P5** | `tpl_daily_standup_reminder` -- not in design. Extra template. |

### 9. Authorization Model

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 9.1 | SuperUser bypass | Sec 11 | **P5** | SuperUsers bypass all access checks. |
| 9.2 | Owner/Admin: any automation in org | Sec 11 | **P5** | Admin+ can edit any automation. |
| 9.3 | Member: own automations + project scope | Sec 11 | **P4** | Members can create automations. Members can edit own automations (creator check). Project-level scoping for member visibility is not enforced -- members see all org automations. |
| 9.4 | Viewer: read-only | Sec 11 | **P3** | The `requireMinOrgRole('member')` guard on writes effectively blocks viewers. But there is no explicit viewer-specific code path -- viewers get through read endpoints but this is implicit. |
| 9.5 | Automations execute with creator permissions | Sec 11 | **P0** | Not implemented -- requires the execution engine. |

### 10. Security

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 10.1 | No arbitrary code execution | Sec 13 | **P5** | Actions limited to MCP tool calls on allowlist. |
| 10.2 | Template variable injection protection | Sec 13 | **P5** | Resolver is pure string interpolation via regex. Blocked keys (`__proto__`, `constructor`, `prototype`). |
| 10.3 | Rate limiting (server-side) | Sec 13 | **P3** | Global Fastify rate limit plugin applied. Per-endpoint rate limits on create/duplicate/test/AI. Per-automation rate limit (`max_executions_per_hour`) stored but not enforced at runtime (no executor). |
| 10.4 | Webhook URL allowlisting | Sec 13 | **P5** | Design says "future" but implementation has full SSRF validation via `url-validator.ts`. Exceeds design. |
| 10.5 | ReDoS protection on regex operator | -- | **P5** | Pattern length limit (100 chars), nested quantifier detection, input length limit (10K chars). Not in design -- exceeds spec. |

### 11. Observability & Metrics

| # | Feature | Design Ref | Rating | Notes |
|---|---------|-----------|--------|-------|
| 11.1 | Events received / minute | Sec 12 | **P0** | No event consumer exists to measure. |
| 11.2 | Automations matched / event | Sec 12 | **P0** | No event router exists. |
| 11.3 | Execution success rate | Sec 12 | **P2** | Data model supports it (status column), but no dashboard/metric endpoint. Stats endpoint provides count breakdowns. |
| 11.4 | Execution duration tracking | Sec 12 | **P2** | `duration_ms` column exists on executions and steps, but no p50/p99 aggregation. |
| 11.5 | Active automations / org | Sec 12 | **P4** | `GET /automations/stats` returns enabled/disabled counts. |

---

## Detailed Findings for P0-P3 Items

### P0: Execution Engine (4.1 - 4.7)

This is the most critical gap. The design describes a two-stage BullMQ pipeline:

1. **Event Router** subscribes to `bolt:events` Redis PubSub, matches events against enabled automations by `(trigger_source, trigger_event, org_id)`, evaluates conditions, and enqueues `bolt:execute` jobs.
2. **Executor** loads the automation definition, resolves template variables, executes actions sequentially as MCP tool calls, logs results to `bolt_executions` + `bolt_execution_steps`.
3. **Cron Scheduler** polls `bolt_schedules` every 60 seconds and fires synthetic events.
4. **Cleanup** purges execution logs older than 90 days nightly.

None of this exists. The `apps/worker/` directory has no Bolt-related processors. The `mcp-executor.ts` service file referenced in the design's file tree (Sec 6.1) was never created. Redis rate-limiting counters (`bolt:rate:*`, `bolt:cooldown:*`) are not implemented.

**Impact:** Automations can be created, viewed, and configured, but they will never fire. The product is a CRUD shell without the automation engine.

**Recommendation:** This is the highest-priority work item. Implement in this order:
1. `mcp-executor.ts` service in bolt-api (or shared package) for making MCP tool calls
2. `bolt:execute` BullMQ processor in worker
3. `bolt:route` BullMQ processor in worker
4. Redis PubSub subscriber for `bolt:events` channel
5. `bolt:schedule` cron tick processor
6. `bolt:cleanup` nightly purge
7. Redis rate-limiting counters

### P0: Event Publishing from Source APIs (5.1 - 5.5)

No existing API publishes events to the `bolt:events` Redis PubSub channel. The design shows this as a lightweight `redis.publish('bolt:events', ...)` call added after relevant operations in each API. This is blocked by the execution engine being P0, but should be implemented in parallel.

**Recommendation:** Add a shared `publishBoltEvent()` utility to `packages/shared` and integrate it into the relevant route handlers in each source API.

### P0: Frontend Components (7.13, 7.14, 7.16 - 7.19, 7.21)

Several builder enhancement components from the design are missing:
- **CronEditor**: Visual cron builder (currently just a text input)
- **FieldPicker**: Schema-aware field selector with autocomplete
- **AiAssistDialog**: Natural language automation generation dialog
- **AutomationPreview**: Natural language rule summary
- **TemplateVariableHelper**: `{{ }}` variable autocomplete
- **AutomationTable**: Sortable table view alternative to card list
- **builderStore**: Zustand store for builder state

**Impact:** The builder works but is less user-friendly than designed. Power users must know field paths and template variable syntax by heart.

**Recommendation:** Prioritize FieldPicker and TemplateVariableHelper for usability. CronEditor and AiAssistDialog are nice-to-haves. AutomationTable is low priority if the card view works well.

### P0: Missing Templates (8.7 - 8.10)

Four templates from the design are missing:
- New Document Notification (Brief)
- Weekly Status Update (cron)
- Task Moved to Review (Bam)
- Close Ticket on Task Complete (cross-app)

The implementation adds 4 bonus templates not in the design (task comments mirror, doc auto-promote, new member onboarding, daily standup reminder), so the total template count (10) matches. But specific use cases from the design are absent.

**Recommendation:** Add the 4 missing templates from the design. The bonus templates are good additions -- keep them.

### P1: AI-Assisted Authoring (2.20, 2.21)

Both AI endpoints exist with proper validation, LLM provider resolution, and rate limiting, but return hardcoded/template responses. The `POST /ai/generate` endpoint returns a static sample automation. The `POST /ai/explain` endpoint concatenates strings describing the automation structure.

**Impact:** The feature is discoverable (endpoints work, errors are informative when no LLM is configured) but provides no real AI value.

**Recommendation:** Replace stubs with actual LLM calls using the resolved provider. The event catalog and action catalog can be passed as context to the LLM for better generation quality.

### P3: Test Endpoint (2.10)

The test endpoint evaluates conditions against a simulated event payload but does not execute actions. The design describes it as a full "test-fire automation with a simulated event payload" that "returns execution result."

**Impact:** Users can verify their conditions work but cannot preview what actions would do.

**Recommendation:** After the execution engine is built, enhance the test endpoint to execute actions in a dry-run mode (or actually execute them and return results). This is blocked by P0 item 4.1/4.2.

### P3: McpToolPicker (7.15)

The MCP tool picker uses a standard HTML `<select>` element grouped by source. The design calls for a "searchable MCP tool selector with parameter forms." The current implementation requires users to know parameter names and type values manually.

**Recommendation:** Replace with a searchable combobox (e.g., Radix UI Combobox) and generate parameter form fields from the action catalog's parameter schemas.

---

## P4-P5 Items (Brief Summary)

Items rated P4-P5 are substantially or fully complete:

**P5 (fully matches design):**
- All 6 database tables and their Drizzle schema definitions
- All automation CRUD endpoints (list, create, get, update, patch, delete, enable, disable, duplicate)
- All 4 execution endpoints (list per automation, list org-wide, get detail, retry)
- All 3 event catalog endpoints
- Template list and instantiate endpoints
- All 12 MCP tools
- Condition evaluation engine with all 13 operators
- Template variable resolver with all 5 variable namespaces
- Frontend: AutomationListPage, TriggerSelector, ConditionList/Row, ActionList/Editor, ExecutionLogPage, ExecutionDetailPage, ExecutionTimeline, TemplateBrowserPage, StatusBadge
- Authorization: SuperUser bypass, Admin/Owner edit any, Member edit own
- Security: MCP tool allowlist, template variable injection protection, SSRF URL validation, ReDoS protection

**P4 (nearly complete):**
- Partial index on enabled (minor -- no WHERE clause)
- Event catalog missing `epic.completed` event
- TriggerFilterEditor is inline rather than a separate component
- Auto-assign template uses priority instead of category filter
- Member authorization lacks project-level visibility scoping
- Automation editor missing AutomationPreview summary

---

## Recommendations (Priority Order)

1. **[CRITICAL] Implement execution engine** -- BullMQ processors for `bolt:route`, `bolt:execute`, `bolt:schedule`, `bolt:cleanup`. Create `mcp-executor.ts` service. Without this, Bolt is non-functional.

2. **[CRITICAL] Add event publishing to source APIs** -- `publishBoltEvent()` calls in Bam, Banter, Beacon, Brief, and Helpdesk APIs. The event catalog already defines all events; each API just needs to emit them.

3. **[HIGH] Implement Redis rate limiting** -- `bolt:rate:{id}:hour` and `bolt:cooldown:{id}` counters enforced by the event router before enqueuing execution.

4. **[HIGH] Add missing event: `epic.completed`** -- Listed in design Sec 4.2 but absent from event catalog.

5. **[MEDIUM] Add missing templates** -- New Document Notification, Weekly Status Update, Task Moved to Review, Close Ticket on Task Complete.

6. **[MEDIUM] Replace AI stubs with real LLM integration** -- Wire up LLM provider for `/ai/generate` and `/ai/explain`.

7. **[MEDIUM] Build FieldPicker and TemplateVariableHelper** -- Most impactful UX improvement for the visual builder.

8. **[LOW] Build CronEditor** -- Visual cron builder instead of raw expression input.

9. **[LOW] Build AiAssistDialog** -- Button in builder to open natural language dialog.

10. **[LOW] Add AutomationTable** -- Sortable table alternative to card list view.

11. **[LOW] Migrate builder state to Zustand store** -- Currently works with useState; Zustand would help with undo/redo and persistence.
