# bolt MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bolt_actions` | List available MCP tools that can be used as automation actions. | none |
| `bolt_create` | Create a new workflow automation with trigger, conditions, and actions. | `project_id`, `trigger_source`, `trigger_event`, `trigger_filter`, `conditions`, `actions`, `max_executions_per_hour`, `cooldown_seconds`, `enabled` |
| `bolt_delete` | Delete a workflow automation. | `id` |
| `bolt_disable` | Disable a workflow automation. | `id` |
| `bolt_duplicate` | Duplicate an automation. Creates a disabled copy (with its conditions and actions) under a new name so you can safely modify it before enabling. | `id` |
| `bolt_enable` | Enable a workflow automation. | `id` |
| `bolt_events` | List available trigger events, optionally filtered by source. | `source` |
| `bolt_execution_detail` | Get detailed information about a single execution, including action results. | `id` |
| `bolt_executions` | List execution history for an automation. | `automation_id`, `status`, `limit` |
| `bolt_explain` | Explain an automation definition in plain English using the org\ | `automation`, `trigger_source`, `trigger_event`, `conditions`, `actions`, `project_id` |
| `bolt_generate` | Generate a draft automation definition from a natural-language prompt using the org\ | `prompt`, `context`, `project_id` |
| `bolt_get` | Get a single automation with its conditions and actions. | `id` |
| `bolt_get_automation_by_name` | Resolve an automation by its name within the caller\ | none |
| `bolt_instantiate_template` | Create a new automation from a built-in template (see bolt_list_templates for ids). Optional overrides let you set the name, description, project, and cron schedule on the new automation. | `template_id`, `project_id`, `cron_expression`, `cron_timezone` |
| `bolt_list` | List workflow automations with optional filters and pagination. | `project_id`, `trigger_source`, `enabled`, `cursor`, `limit` |
| `bolt_list_executions` | List execution history across all automations in the org (not scoped to a single automation — use bolt_executions for that). Org-admin scoped. | `status`, `cursor`, `limit` |
| `bolt_list_templates` | List the built-in automation templates available for instantiation (pre-built trigger/condition/action blueprints). | none |
| `bolt_list_versions` | List the saved version history for an automation. Each version is a point-in-time snapshot of the trigger, conditions, and actions captured on update/restore. | `id` |
| `bolt_patch` | Partial metadata update of an automation. Only touches name, description, and/or enabled — does not modify the trigger, conditions, or actions (use bolt_update for those). Provide only the fields to change. | `id`, `enabled` |
| `bolt_restore_version` | Restore an automation to a previously saved version. The current state is snapshotted first, then the named version becomes the live definition. | `id`, `version_id` |
| `bolt_retry_execution` | Retry a failed (or partial) execution. Re-runs the automation against the original event payload and creates a new execution row. | `id` |
| `bolt_stats` | Get aggregate automation statistics for the org (totals, enabled count, execution counts). Pass project_id to scope the numbers to a single project so they line up with a filtered list view. | `project_id` |
| `bolt_test` | Test-fire an automation with a simulated event payload. | `id`, `event` |
| `bolt_update` | Update an existing automation. Provide only the fields to change. | `id`, `trigger_source`, `trigger_event`, `trigger_filter`, `conditions`, `actions`, `enabled` |
