---
title: "Blip (Telemetry) Guide"
app: blip
---

# Blip (Telemetry) Guide

# Blip - Telemetry, log, and profiling intake

Blip is BigBlueBam's intake and inspection layer for runtime telemetry from your own running software. Declare an app to track, embed an ingest key in your client, and POST JSON reports: log lines, crash dumps, function timings, custom counters, anything. Then open a viewer with the instrumented app running next to it and watch data stream in live, or query the accumulated history, freeze a collection to a JSONL file, and chart aggregate trends. Report types and fields are discovered from the data itself, so there is no schema to declare up front.

## Key Features

- **Fast, forgiving ingest.** `POST /blip/ingest/v1` with the key on `X-Blip-Key`. Single object, JSON array, or NDJSON. A report is accepted (202) once it is well-formed, redacted, queued, and tailed; malformed elements in a batch are dropped and counted, never failing the batch.
- **Tracked apps and ingest keys.** Each app owns its collection switch, default rate limit, retention, and PII transform. Keys are write-only, one-app, individually suspendable and revocable, shown once at creation.
- **Discovered report types and reserved fields.** The only required field is `report_type`. Reserved keys (`timestamp`, `level`, `session_id`, `app_version`, `platform`, `elapsed_ms`, `screen_captures`) are promoted to typed, indexed columns; `level` is an enforced `debug < info < warn < error < fatal` enum.
- **Live tail over WebSocket** with backfill, clean resume by sequence cursor, server-side filter and column projection, and backpressure sampling that never touches the durable store.
- **Saved views** (filter + columns + sort + live-tail flag, private or org-shared) and an auto-maintained **field catalog** that drives column pickers, sort options, Bench metric declaration, and index suggestions.
- **Watches** that emit Bolt events only on an explicit, throttled condition: match watches (per entry) and window watches (aggregate over a sliding window, with breach/recovery hysteresis).
- **Edge PII transform** (drop, mask, hash, truncate) applied before tail and storage, plus a global string-length floor.
- **Rate limiting and retention** per app and per key, with a 14-day default that never silently becomes unbounded.
- **Captures and timelapse.** Attach base64 JPEG frames under `screen_captures`; Blip offloads them to Bin and keeps refs, shows a thumbnail strip, and stitches a session into an MP4 timelapse.
- **AI agent surface** of blip_* MCP tools covering app/key/collection/rate-limit/retention/transform management, entry query and cursor tail, export, captures, timelapse, watches, and views.

## Integrations

Blip offloads capture images and compiles timelapse videos as **Bin** assets, and freezes filtered collections into immutable JSONL **Bin** assets viewable read-only in Bin's structured viewer. It ships two org-scoped rollups (`blip:entries_rollup`, `blip:metric_rollup`) that **Bench** dashboards chart for volume, error rate, and latency percentiles per build and platform. Watches emit **Bolt** events on the `blip` source (`tracked_app.created`, `collection.started`/`stopped`, `key.created`/`suspended`/`revoked`, `report_type.first_seen`, `entry.matched`, `window.breached`/`recovered`, `entries.purged`, `timelapse.ready`), so automation rules can route a slow-frame or error-spike straight into a **Banter** channel. Across the suite, agents reach Blip under an identity with heartbeat and `agent_policies` gating, and preflight visibility with `can_access` against the parent `blip.tracked_app` before citing any entry, since entries gate through their tracked app rather than registering as individual entities.

## Getting Started

Open Blip from the Launchpad. Declare a **tracked app** (it starts with collection on and a 14-day retention default). On the app detail page, mint an **ingest key**: copy the one-time token and the ready-to-paste client snippet shown beneath it, and drop the snippet into your client. Run the client so it POSTs reports, then open the live viewer for the report type that arrives and watch it stream in. From there, save a view for the filter you keep reaching for, add a watch to get alerted on a condition, set a transform to redact PII, and build a Bench dashboard over the rollups for trends.

## Walkthrough

### Declare a tracked app and mint a key

Create the app, then mint a key on its detail page. The token is `blip_<key_id>_<secret>` and is shown exactly once. Suspend a key to pause it reversibly; revoke to kill it permanently. Rotate by minting a new key, shipping it, and revoking the old one.

### Wire up a client

Every report is JSON with a non-empty `report_type`; everything else is free-form. The key rides on `X-Blip-Key`. A `202` means accepted (queued and tailed), not durably stored, which is the right contract for telemetry.

Unity / C#:

```csharp
using System.Collections.Generic;
using BigBlueBam.Blip;

var blip = new BlipClient("https://your-host/blip/ingest/v1", "blip_<key_id>_<secret>");
await blip.ReportAsync("fn_timing", new Dictionary<string, object>
{
    ["fn"] = "decodeFrame",
    ["elapsed_ms"] = 12.4,
    ["session_id"] = "a91f",
    ["app_version"] = "1.4.2",
    ["platform"] = "ios",
    ["level"] = "debug",
});
```

Python:

```python
from blip_client import BlipClient

blip = BlipClient("https://your-host/blip/ingest/v1", "blip_<key_id>_<secret>")
blip.report(
    "fn_timing",
    fn="decodeFrame",
    elapsed_ms=12.4,
    session_id="a91f",
    app_version="1.4.2",
    platform="ios",
    level="debug",
)
```

Raw curl:

```bash
curl -X POST https://your-host/blip/ingest/v1 \
  -H "X-Blip-Key: blip_<key_id>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{ "report_type": "fn_timing", "fn": "decodeFrame", "elapsed_ms": 12.4,
        "session_id": "a91f", "app_version": "1.4.2", "platform": "ios",
        "level": "debug" }'
```

High-throughput clients can POST a JSON array or NDJSON (`Content-Type: application/x-ndjson`, one object per line). The response carries `{ accepted, rejected }` and, if any element failed validation, a `rejected_index` list.

### Watch live and query history

Open the live viewer for a `(tracked app, report type)`. Apply a filter or load a saved view such as "Slow frames" (`elapsed_ms >= 16`). The viewer backfills the recent matching page, then streams live; pause to freeze the frame, resume to reattach. For forensics, query the accumulated history with the same predicate, sort and page it, expand any entry's JSON, and export the result to a frozen JSONL asset in Bin.

### React, redact, and trend

Add a match watch (`elapsed_ms gt 500`, cooldown 60s, named `slow-frame`) and a Bolt rule on `entry.matched` filtered to that name to post into a Banter channel. Add a window watch (error count over 60s) for sustained-degradation alerting. Set a transform to drop or hash sensitive fields on the edge. Build a Bench dashboard over `blip:metric_rollup` to chart latency percentiles per build.

## MCP Tools

| Tool | Description |
|------|-------------|
| `blip_app_create` | Declare a tracked app (admin). |
| `blip_app_list` | List tracked apps. |
| `blip_app_get` | App detail plus health. |
| `blip_app_update` | Edit app config (admin). |
| `blip_app_delete` | Delete an app and its data (owner, confirm). |
| `blip_collection_set` | Start or stop collection (admin). |
| `blip_key_create` | Mint an ingest key; token shown once (admin). |
| `blip_key_list` | List keys, never the secret (admin). |
| `blip_key_suspend` | Suspend or resume a key (admin). |
| `blip_key_revoke` | Revoke a key, terminal (admin, confirm). |
| `blip_key_update` | Set a key label or rate-limit override (admin). |
| `blip_ratelimit_set` | Set the app default rate limit (admin). |
| `blip_retention_set` | Set a retention policy, per type (admin). |
| `blip_transform_set` | Set the PII transform rules (admin). |
| `blip_report_types_list` | List observed report types. |
| `blip_field_catalog_list` | Field catalog for a report type. |
| `blip_field_index` | Promote a payload field to indexed (admin). |
| `blip_field_set_metric` | Mark or unmark a field as a Bench metric (admin). |
| `blip_entry_query` | Filter, sort, and paginate entries; `format=jsonl` option. |
| `blip_entry_tail` | Incremental pull: entries with `seq > cursor` plus the new max seq. |
| `blip_entry_purge` | Purge a collection (admin, confirm). |
| `blip_entry_export` | Freeze a collection to a Bin JSONL asset. |
| `blip_capture_url` | Short-TTL presigned URL for a stored capture or its thumbnail. |
| `blip_timelapse_create` | Compile capture-bearing entries into a video. |
| `blip_timelapse_get` | Job status plus the Bin video asset when ready. |
| `blip_timelapse_list` | List timelapse jobs for an app. |
| `blip_watch_create` | Create a match or window watch (admin). |
| `blip_watch_list` | List watches for an app. |
| `blip_watch_get` | Watch detail. |
| `blip_watch_update` | Edit a watch (admin). |
| `blip_watch_set_enabled` | Enable or disable a watch (admin). |
| `blip_watch_delete` | Delete a watch (admin, confirm). |
| `blip_watch_test` | Dry-run a predicate over recent entries. |
| `blip_watch_history` | Recent firings of a watch. |
| `blip_view_create` | Create a saved view. |
| `blip_view_list` | List views for a report type. |
| `blip_view_update` | Edit a view (owner/admin for org-shared). |
| `blip_view_delete` | Delete a view (owner/admin). |

## Related Apps

- [Bin (Digital asset management)](../bin/guide.md)
- [Bench (Analytics)](../bench/guide.md)
- [Bolt (Workflow Automation)](../bolt/guide.md)
- [Banter (Team chat)](../banter/guide.md)
- [Introduction to BigBlueBam](../introduction/guide.md)
