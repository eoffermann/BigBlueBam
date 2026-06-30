# blip MCP Tools

Every Blip REST endpoint has a paired MCP tool (full parity), except the public ingest endpoint (`public-inbound`) and the live-tail WebSocket (`realtime`), which are intentionally not exposed as tools. Authority is the default grant, enforced by `requireCan` against the named `blip.<resource>.<verb>` permission and delegatable per the standard model. Destructive tools (`blip_app_delete`, `blip_key_revoke`, `blip_entry_purge`, `blip_watch_delete`) take an inline `confirm_action: boolean` (call without it to preview, again with `true` to execute). All `blip_*` tools obey the `blip.*` `agent_policies` allowlist and kill switch.

| Tool | REST endpoint | Authority | Description |
|------|---------------|-----------|-------------|
| `blip_app_create` | `POST /blip/api/apps` | admin | Declare a tracked app. |
| `blip_app_list` | `GET /blip/api/apps` | member | List tracked apps. |
| `blip_app_get` | `GET /blip/api/apps/:id` | member | App detail plus health. |
| `blip_app_update` | `PATCH /blip/api/apps/:id` | admin | Edit app config. |
| `blip_app_delete` | `DELETE /blip/api/apps/:id` | owner | Delete the app and its data (confirm). |
| `blip_collection_set` | `POST /blip/api/apps/:id/collection` | admin | Start or stop collection. |
| `blip_key_create` | `POST /blip/api/apps/:id/keys` | admin | Mint a key; token shown once. |
| `blip_key_list` | `GET /blip/api/apps/:id/keys` | admin | List keys, never the secret. |
| `blip_key_suspend` | `POST /blip/api/keys/:id/suspend` | admin | Suspend or resume a key. |
| `blip_key_revoke` | `POST /blip/api/keys/:id/revoke` | admin | Revoke a key, terminal (confirm). |
| `blip_key_update` | `PATCH /blip/api/keys/:id` | admin | Label or rate-limit override. |
| `blip_ratelimit_set` | `PUT /blip/api/apps/:id/rate-limit` | admin | App default rate limit. |
| `blip_retention_set` | `PUT /blip/api/apps/:id/retention` | admin | Retention policy (per type). |
| `blip_transform_set` | `PUT /blip/api/apps/:id/transform` | admin | PII transform rules. |
| `blip_report_types_list` | `GET /blip/api/apps/:id/types` | member | Observed report types. |
| `blip_field_catalog_list` | `GET /blip/api/apps/:id/types/:t/fields` | member | Field catalog for a type. |
| `blip_field_index` | `POST /blip/api/apps/:id/types/:t/fields/:f/index` | admin | Promote a field to indexed. |
| `blip_field_set_metric` | `POST /blip/api/apps/:id/types/:t/fields/:f/metric` | admin | Mark or unmark a Bench metric. |
| `blip_entry_query` | `POST /blip/api/apps/:id/entries/query` | member | Filter, sort, paginate; `format=jsonl` option. |
| `blip_entry_tail` | `POST /blip/api/apps/:id/entries/tail` | member | Entries with `seq > cursor` plus new max seq. |
| `blip_entry_purge` | `POST /blip/api/apps/:id/entries/purge` | admin | Purge a collection (confirm). |
| `blip_entry_export` | `POST /blip/api/apps/:id/entries/export` | member | Freeze a collection to a Bin JSONL asset. |
| `blip_capture_url` | `GET /blip/api/captures/:ref/url` | member | Short-TTL presigned URL for a capture or thumbnail. |
| `blip_timelapse_create` | `POST /blip/api/apps/:id/timelapse` | member | Compile capture-bearing entries into a video. |
| `blip_timelapse_get` | `GET /blip/api/timelapse/:id` | member | Job status plus the Bin video asset when ready. |
| `blip_timelapse_list` | `GET /blip/api/apps/:id/timelapse` | member | List timelapse jobs for an app. |
| `blip_watch_create` | `POST /blip/api/apps/:id/watches` | admin | Create a match or window watch. |
| `blip_watch_list` | `GET /blip/api/apps/:id/watches` | member | List watches for an app. |
| `blip_watch_get` | `GET /blip/api/watches/:id` | member | Watch detail. |
| `blip_watch_update` | `PATCH /blip/api/watches/:id` | admin | Edit a watch. |
| `blip_watch_set_enabled` | `POST /blip/api/watches/:id/enabled` | admin | Enable or disable a watch. |
| `blip_watch_delete` | `DELETE /blip/api/watches/:id` | admin | Delete a watch (confirm). |
| `blip_watch_test` | `POST /blip/api/apps/:id/watches/test` | member | Dry-run a predicate over recent entries. |
| `blip_watch_history` | `GET /blip/api/watches/:id/history` | member | Recent firings of a watch. |
| `blip_view_create` | `POST /blip/api/views` | member | Create a saved view. |
| `blip_view_list` | `GET /blip/api/apps/:id/types/:t/views` | member | List views for a type. |
| `blip_view_update` | `PATCH /blip/api/views/:id` | member (owner/admin for org-shared) | Edit a view. |
| `blip_view_delete` | `DELETE /blip/api/views/:id` | member (owner/admin) | Delete a view. |

## Related Apps

- [Bin (Digital asset management)](../bin/mcp-tools.md)
- [Bench (Analytics)](../bench/mcp-tools.md)
- [Bolt (Workflow Automation)](../bolt/mcp-tools.md)
- [Banter (Team chat)](../banter/mcp-tools.md)
