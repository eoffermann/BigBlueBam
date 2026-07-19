# basis MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `basis_add_metric_version` | Add a new immutable definition version to a metric. Versioning a certified metric changes the org-wide source of truth, so this is a two-step confirm: call with confirm_action omitted/false to preview the current metric, then again with confirm_action:true to proceed. | `id`, `definition`, `change_note`, `confirm_action` |
| `basis_certify_metric` | Certify a metric so it becomes the org-wide source of truth (truth-flip). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed. | `id`, `confirm_action` |
| `basis_decertify_metric` | Return a certified metric to draft (truth-flip). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed. | `id`, `confirm_action` |
| `basis_define_metric` | Define a NEW draft Basis metric (draft only; certification is a separate HITL-gated step). | `slug`, `unit`, `favorable_direction`, `definition` |
| `basis_deprecate_metric` | Deprecate (soft-retire) a metric (destructive). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed. | `id`, `confirm_action` |
| `basis_explain_change` | Explain why a metric changed between two periods: a deterministic dimensional decomposition plus a per-viewer, access-scoped "possibly related activity" aid. REQUIRES asker_user_id; when omitted, Class-B (entity) breakdowns collapse to a single hidden aggregate (fail-closed). | `id`, `period_a`, `period_b`, `dimension`, `asker_user_id` |
| `basis_get_metric` | Get a Basis metric with its current version definition. | none |
| `basis_get_settings` | Get this org's Basis settings: default decomposition dimension, explanation cache TTL, and snapshot retention window. | none |
| `basis_list_metrics` | List governed Basis metrics for the current organization, optionally filtered by certification state. | none |
| `basis_list_versions` | List a metric's immutable definition version history (newest first), as shown on the metric detail page. | none |
| `basis_metric_lineage` | Get a metric binding contract: its query definition and certified presentation envelope (unit, direction, target). | none |
| `basis_metric_value` | Get a certified metric value over a period. Returns UPSTREAM_UNAVAILABLE if the Bench query service is down. | none |
| `basis_rank_drivers` | Rank the deterministic drivers of a metric delta (dimension-value contributions). Same fail-closed asker rule as basis_explain_change. | `id`, `period_a`, `period_b`, `dimension`, `asker_user_id` |
| `basis_search_metrics` | Search Basis metrics by name/slug substring (case-insensitive) within the org. | none |
| `basis_update_metric` | Update a metric's metadata (name, description, favorable_direction, owner, related_apps, target). Does NOT change the definition - use basis_add_metric_version for that. | `id`, `favorable_direction`, `owner_id`, `related_apps`, `target` |
| `basis_update_settings` | Update this org's Basis settings (default dimension, explanation cache TTL seconds, snapshot retention days; null retention = unbounded). | `snapshot_max_age_days`, `explanation_cache_ttl_seconds`, `default_dimension` |
