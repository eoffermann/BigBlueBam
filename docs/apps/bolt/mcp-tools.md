# bolt MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bolt_actions` | List available MCP tools that can be used as automation actions. | none |
| `bolt_create` | Create a new workflow automation with trigger, conditions, and actions. | `project_id`, `trigger_source`, `trigger_event`, `trigger_filter`, `conditions`, `actions`, `max_executions_per_hour`, `cooldown_seconds`, `enabled` |
| `bolt_delete` | Delete a workflow automation. | `id` |
| `bolt_disable` | Disable a workflow automation. | `id` |
| `bolt_duplicate` | Duplicate an automation. Creates a disabled copy (with its conditions and actions) under a new name so you can safely modify it before enabling. | `id` |
| `bolt_enable` | Enable a workflow automation. | `id` |
| `bolt_event_trace` | Return the full evaluation trail for a single Bolt ingest event: every automation that evaluated the event, whether its conditions matched, and the outcome of each action step. Values in actual/expected are truncated to 1KB per field. Empty executions[] means the event hit zero rules. Org-scoped: only executions in the caller's active org are returned. | `event_id` |
| `bolt_events` | List available trigger events, optionally filtered by source. | `source` |
| `bolt_execution_detail` | Get detailed information about a single execution, including action results. | `id` |
| `bolt_executions` | List execution history for an automation. | `automation_id`, `status`, `limit` |
| `bolt_explain` | Explain an automation definition in plain English using the org's configured LLM provider. Pass the automation shape (name, trigger_source, trigger_event, conditions, actions) — for an existing automation, fetch it with bolt_get first. Returns a natural-language explanation. Requires an LLM provider to be configured (returns AI_NOT_CONFIGURED otherwise). | `automation`, `trigger_source`, `trigger_event`, `conditions`, `actions`, `project_id` |
| `bolt_generate` | Generate a draft automation definition from a natural-language prompt using the org's configured LLM provider. Returns a proposed automation object (name, trigger, conditions, actions) plus a confidence score; it does NOT persist anything — pass the result to bolt_create to save it. Requires an LLM provider to be configured (returns AI_NOT_CONFIGURED otherwise). | `prompt`, `context`, `project_id` |
| `bolt_get` | Get a single automation with its conditions and actions. | `id` |
| `bolt_get_automation_by_name` | Resolve an automation by its name within the caller's org. Case-insensitive exact match is preferred; falls back to a single-hit fuzzy ILIKE "%name%" match. Returns a compact projection ({ id, name, description, trigger_source, trigger_event, enabled, action_count, last_execution_at }) or null if no unique match is found. Useful for meta-automations that need to reference other automations by name (e.g. disable the "Nightly Deploys" automation when an incident is declared). | none |
| `bolt_instantiate_template` | Create a new automation from a built-in template (see bolt_list_templates for ids). Optional overrides let you set the name, description, project, and cron schedule on the new automation. | `template_id`, `project_id`, `cron_expression`, `cron_timezone` |
| `bolt_list` | List workflow automations with optional filters and pagination. | `project_id`, `trigger_source`, `enabled`, `cursor`, `limit` |
| `bolt_list_executions` | List execution history across all automations in the org (not scoped to a single automation — use bolt_executions for that). Org-admin scoped. | `status`, `cursor`, `limit` |
| `bolt_list_templates` | List the built-in automation templates available for instantiation (pre-built trigger/condition/action blueprints). | none |
| `bolt_list_versions` | List the saved version history for an automation. Each version is a point-in-time snapshot of the trigger, conditions, and actions captured on update/restore. | `id` |
| `bolt_patch` | Partial metadata update of an automation. Only touches name, description, and/or enabled — does not modify the trigger, conditions, or actions (use bolt_update for those). Provide only the fields to change. | `id`, `enabled` |
| `bolt_recent_events` | List recent Bolt ingest events in the caller's org that matched at least one automation. Each row is aggregated by event_id with the count of matched automations and the earliest started_at. Filters are optional; limit is capped server-side at 500 (default 50). Useful for a live-ish ops view of what is firing. | `source`, `event`, `since`, `limit` |
| `bolt_restore_version` | Restore an automation to a previously saved version. The current state is snapshotted first, then the named version becomes the live definition. | `id`, `version_id` |
| `bolt_retry_execution` | Retry a failed (or partial) execution. Re-runs the automation against the original event payload and creates a new execution row. | `id` |
| `bolt_stats` | Get aggregate automation statistics for the org (totals, enabled count, execution counts). Pass project_id to scope the numbers to a single project so they line up with a filtered list view. | `project_id` |
| `bolt_test` | Dry-run an automation against a simulated event payload. This evaluates ONLY the automation's conditions against the event — it does NOT execute the actions. Use it to check whether a given event would (or would not) trigger the automation. Returns `passed` (would the actions run), a per-condition `log`, and a human-readable `message`. To actually run actions, the automation must fire on a real ingested event. | `id`, `event` |
| `bolt_update` | Update an existing automation. Provide only the fields to change. | `id`, `trigger_source`, `trigger_event`, `trigger_filter`, `conditions`, `actions`, `enabled` |
