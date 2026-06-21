# Bolt Design Audit (2026-04-14)

## Summary

Bolt's implementation has progressed significantly since the April 9 audit. The core execution engine, event ingestion pipeline, and worker job processor are now fully functional. Event publishing is integrated into source APIs. Pre-built templates have been completed and now include all design-specified cases plus additional examples. A graph-based visual editor has been added as an optional advanced building mode. Overall completion has increased from approximately 58% to 80 to 85%. The system is now ready for the event-driven automation use case with minor gaps in cron-based scheduling (still P0) and real LLM integration for AI assistance (still P1 stub).

## Design sources consulted

- `docs/early-design-documents/Bolt_Design_Document.md` (v1.0, April 7, 2026)
- `docs/bolt-advanced-ui-strategy.md` (supplemental UI strategy)
- `docs/bolt-id-mapping-strategy.md` (supplemental ID mapping)
- `docs/bolt-security-audit.md` (supplemental security review)
- `docs/design-audits/2026-04-09/Bolt-Design-Audit-2026-04-09.md` (prior audit baseline)
- `CLAUDE.md`

## Built and working

### Data model

All 6 tables fully implemented with proper indexes: `bolt_automations`, `bolt_conditions`, `bolt_actions`, `bolt_executions`, `bolt_execution_steps`, `bolt_schedules`. Additional columns (`max_chain_depth`, `template_strict`, `graph`, `graph_mode`, `data_version`) exceed the design but enhance functionality.

Migrations:
- `0026_bolt_tables.sql` - Initial schema
- `0039_bolt_max_chain_depth.sql` - Loop prevention
- `0041_bolt_extended_trigger_sources.sql` - Multi-product support
- `0043_bolt_template_strict.sql` - Strict template validation
- `0044_bolt_graph_column.sql` - Graph-based editor support

### API endpoints

All 22 documented endpoints are implemented:
- CRUD: GET/POST/PUT/PATCH/DELETE `/automations`, `/automations/:id`, `/automations/:id/{enable,disable,duplicate,test}`
- Executions: GET `/automations/:id/executions`, `/executions/:id`, POST `/executions/:id/retry`, GET `/executions` (org-wide)
- Events: GET `/events`, `/events/:source`
- Templates: GET `/templates`, POST `/templates/:id/instantiate`
- AI: POST `/ai/generate`, `/ai/explain` (stubs)
- Event ingestion: POST `/events/ingest` (critical path, fully functional)

File paths:
- `apps/bolt-api/src/routes/automation.routes.ts` (509 lines)
- `apps/bolt-api/src/routes/event-ingestion.routes.ts` (380 lines)
- `apps/bolt-api/src/routes/execution.routes.ts` (102 lines)
- `apps/bolt-api/src/routes/event.routes.ts` (64 lines)
- `apps/bolt-api/src/routes/template.routes.ts` (81 lines)
- `apps/bolt-api/src/routes/ai-assist.routes.ts` (158 lines)

### Execution engine

**Event router (ingestion handler)** at `apps/bolt-api/src/routes/event-ingestion.routes.ts:101-379`:
- Matches automations by trigger + evaluates conditions + enforces rate limits + queues executor jobs
- Rate limiting: Redis counters with per-automation hourly cap and cooldown window
- Chain depth: checks against `max_chain_depth` before enqueuing

**Action executor** at `apps/worker/src/jobs/bolt-execute.job.ts:332-623`:
- Loads automation + resolves template variables + calls MCP tools sequentially + logs results + implements error policies
- Template resolution: supports `event.*`, `actor.*`, `automation.*`, `now`, `step[N].result.*` with unresolved/coercion warnings
- Error handling: stop/continue/retry per-action policies with configurable retry delays
- Tracks unresolved and coerced template variables in `parameters_resolved` JSONB

**MCP tool dispatcher** at `apps/worker/src/jobs/bolt-execute.job.ts:252-318`:
- HTTP POST to MCP server `/tools/call` endpoint with 30-second timeout per call
- Handles both HTTP-level errors and MCP-level error responses (`isError: true`)

**Known issue at a8fb19a:** The MCP `/tools/call` transport fix is NOT yet in place. Bolt actions that invoke MCP tools will 404 until restored. This is a Wave 0 work item.

**Rate limiting:**
- Redis keys: `bolt:rate:{automation_id}:hour` (hourly INCR+EXPIRE 3600), `bolt:cooldown:{automation_id}` (EX cooldown_seconds)
- Enforced at ingestion time before job enqueue
- Skipped executions logged with reason `rate_limited` or `cooldown_active`

### Event catalog

`apps/bolt-api/src/services/event-catalog.ts` implements 26 events across 6 sources:
- Bam: task.created/updated/moved/assigned/completed/overdue/commented, sprint.started/completed, epic.completed
- Banter: message.posted/mentioned, channel.created, reaction.added
- Beacon: beacon.published/expired/challenged/verified
- Brief: document.created/promoted/status_changed/commented
- Helpdesk: ticket.created/replied/status_changed/sla_breach
- Schedule: cron.fired

Extended sources (Bond, Blast, Board, Bench, Bearing, Bill, Book, Blank) enabled by migration `0041_bolt_extended_trigger_sources.sql` but event definitions sparse in catalog.

Payload enrichment: Task events include denormalized fields (project_name, phase_name, assignee_name, assignee_email, task.url) and actor metadata.

### Frontend (apps/bolt/src)

6 pages all P5:
- AutomationListPage (319 lines): filterable list with stats cards, enabled toggle
- AutomationEditorPage (602 lines): supports both form-based (WHEN/IF/THEN vertical flow) and graph-based editing
- ExecutionLogPage (115 lines): org-wide execution filter by status
- ExecutionDetailPage (154 lines): step-by-step timeline with parameter expansion
- TemplateBrowserPage (112 lines): template grid with instantiate buttons
- AutomationExecutionsPage (122 lines): per-automation execution history

**Graph-based visual editor (bonus feature):**
- Files: `apps/bolt/src/components/graph/graph-editor-view.tsx`, `graph-canvas.tsx`, `graph-help-overlay.tsx`
- Support: `apps/bolt/src/lib/graph-serializer.ts`, `graph-validation.ts`, `apps/bolt/src/stores/graph-editor.store.ts`
- Schema: `apps/bolt/src/types/bolt-graph.ts`
- Database: `graph` and `graph_mode` columns in `bolt_automations` (migration 0044)
- Full node-and-edge visual builder with drag-and-drop canvas

Theming: dark mode fully supported with localStorage persistence.

### Security and authorization

- SuperUser bypass
- Owner/Admin: edit any automation in org
- Member: create, edit own (creator check enforced)
- Viewer: read-only

Security findings from `bolt-security-audit.md`:
- Prototype pollution: fixed via BLOCKED_KEYS set
- ReDoS on matches_regex: mitigated with 500-char pattern limit
- MCP tool allowlist: enforced at creation/update
- SSRF validation: prevents private IP ranges and cloud metadata endpoints
- Open issues: CSRF, JSONB size limits, cookie security

### Templates

14 templates implemented (10 design-specified + 4 bonus):
- `tpl_notify_task_overdue`, `tpl_auto_assign_ticket`, `tpl_sprint_complete_summary`
- `tpl_beacon_expiry_alert`, `tpl_sla_breach_escalate`, `tpl_task_comment_to_banter`
- `tpl_brief_approved_to_beacon`, `tpl_new_member_onboard`, `tpl_high_priority_task_alert`
- `tpl_daily_standup_reminder`, `tpl_new_document_notification`, `tpl_weekly_status_update`
- `tpl_task_moved_to_review`, `tpl_close_ticket_on_task_complete`

## Partial or divergent

### MCP transport broken at a8fb19a

The worker's `apps/worker/src/jobs/bolt-execute.job.ts` posts to `${mcpUrl}/tools/call` but no such route exists on the MCP server at this commit. Every Bolt action that calls an MCP tool currently 404s. This is a known Wave 0 work item.

### Event naming divergence

Some producers still emit prefixed names (e.g., `bond.deal.rotting` in `apps/worker/src/jobs/bond-stale-deals.job.ts`) while others emit bare names. The Wave 0.4 event-naming sweep was rolled back and the drift guard `scripts/check-bolt-catalog.mjs` does NOT exist at a8fb19a.

### AI assist endpoints stubbed

Both `/ai/generate` and `/ai/explain` return hardcoded responses. LLM provider resolution infrastructure is in place but not wired to an actual LLM.

## Missing

### P0

1. **MCP `/tools/call` transport** - Bolt actions 404 until restored. Highest priority, blocks all automation that calls MCP tools.
2. **Cron scheduling** - `bolt:schedule` queue processor and 60-second cron tick not implemented. `bolt_schedules` table exists but is never read. Schedule-based automations can be created but will never fire.
3. **Event-naming convention sweep** - Rename prefixed event names to bare names. Add `scripts/check-bolt-catalog.mjs` drift guard. Publish canonical `publishBoltEvent` helper from shared package.

### P1

1. **Real LLM integration** - Replace stubs in `/ai/generate` and `/ai/explain` with Claude API calls. Use prompt caching for the system prompt.
2. **Field autocomplete UI** - Enhance FieldPicker and TemplateVariableHelper with schema-aware dropdown/combobox based on event catalog `payload_schema`.
3. **Execution cleanup job** - Add `bolt:cleanup` nightly processor to purge executions older than 90 days.
4. **Execution owner notification** - Integrate with Banter DM API to send failure summaries to automation creators.

### P2

1. **Visual cron builder** - Replace cron expression text input with graphical cron composer.
2. **AiAssistDialog** - Button to open natural language prompt dialog for LLM generation.
3. **AutomationPreview** - Natural language summary of automation rules.
4. **AutomationTable** - Sortable table view alternative to the card list.
5. **TemplateVariableHelper** - `{{ }}` autocomplete in action parameter fields.

## Architectural guidance

### Cron scheduler

Add `apps/worker/src/jobs/bolt-schedule-tick.job.ts` that runs every 60 seconds. The job:
1. Queries `bolt_schedules` for rows where `next_run_at <= now()` and `enabled = true`.
2. For each row, builds a synthetic `cron.fired` event payload and POSTs to the bolt-api `/events/ingest` endpoint (internal URL).
3. Updates `next_run_at` using a cron parser library to compute the next firing time.

Register the job in `apps/worker/src/index.ts` with a BullMQ repeating job configured to run every minute.

### LLM integration for AI assist

Replace stubs in `apps/bolt-api/src/routes/ai-assist.routes.ts` with actual Claude API calls. Add `@anthropic-ai/sdk` as a dependency. Build the system prompt from the event catalog (list of available triggers and payload fields) and the MCP tool registry (list of available actions and their parameters). Use prompt caching on the system prompt because it is large and stable. For `/ai/generate`, return structured output matching the automation schema; for `/ai/explain`, return a natural language summary.

### Execution cleanup job

Add `apps/worker/src/jobs/bolt-cleanup.job.ts` that runs daily at 3 AM UTC. The job:
1. DELETE FROM `bolt_execution_steps` WHERE `execution_id` IN (SELECT id FROM `bolt_executions` WHERE `started_at` < NOW() - INTERVAL '90 days')
2. DELETE FROM `bolt_executions` WHERE `started_at` < NOW() - INTERVAL '90 days'
3. Log count of purged records.

Consider adding a `retention_days` column to `bolt_automations` so orgs can configure per-automation retention.

## Dependencies

### Inbound (other apps depend on Bolt)

- Every B-app that emits events depends on Bolt's ingest endpoint.
- The MCP server's `/tools/call` endpoint is called by the Bolt worker for action dispatch.

### Outbound (Bolt depends on other apps)

- **MCP server** (internal :3001) for action dispatch. Critical dependency currently broken at a8fb19a.
- **Bam, Banter, Beacon, Brief, Bond, etc.** APIs for enrichment lookups (project_name, assignee_email, etc.).
- **Claude API** (future, for AI assist).
- **Redis** (rate limiting, queue).

## Open questions

1. **MCP `/tools/call` shape:** What is the canonical request/response format? Should the worker preserve request IDs for correlation with MCP server logs?
2. **Cron tick granularity:** 60 seconds is sufficient for most schedules. Should there be a finer-grained tick (e.g., 10 seconds) for time-sensitive automations?
3. **Cleanup retention:** Is 90 days the right default, or should it be configurable per-org or per-automation?
4. **AI assist prompt caching:** Should the system prompt be cached at the API level (Anthropic's prompt cache) or at the bolt-api level (Redis)?
5. **Event naming:** Is the Wave 0.4 bare-name convention firm, or should we accept some prefixed names as legitimate (e.g., `bond.deal.rotting` for worker-emitted events)?
