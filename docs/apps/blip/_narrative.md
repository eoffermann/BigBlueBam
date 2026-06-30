# Blip - Telemetry, log, and profiling intake

Blip is BigBlueBam's intake and inspection layer for runtime telemetry from your own running software. Declare an app to track, embed an ingest key in your client, and POST JSON reports: log lines, crash dumps, function timings, custom counters, anything. Then open a viewer with the instrumented app running next to it and watch data stream in live, or query the accumulated history, freeze a collection to a JSONL file, and chart aggregate trends. Report types and fields are discovered from the data itself, so there is no schema to declare up front.

## Key Features

- **Fast, forgiving ingest** at `POST /blip/ingest/v1` (single object, array, or NDJSON). A report is accepted (202) once it is well-formed, redacted, queued, and tailed; malformed elements in a batch are dropped and counted, never failing the batch.
- **Tracked apps and write-only ingest keys.** Each app owns its collection switch, default rate limit, retention, and PII transform. Keys are one-app, individually suspendable and revocable, and shown once at creation.
- **Discovered report types and reserved fields.** The only required field is `report_type`; reserved keys (`timestamp`, `level`, `session_id`, `app_version`, `platform`, `elapsed_ms`, `screen_captures`) promote to typed, indexed columns, with `level` an enforced `debug < info < warn < error < fatal` enum.
- **Live tail over WebSocket** with backfill, sequence-cursor resume, server-side filtering, and backpressure sampling that never touches the durable store.
- **Saved views and an auto-maintained field catalog**, plus **watches** (match per-entry and window aggregate) that emit Bolt events only on an explicit, throttled condition.
- **Edge PII transform** (drop, mask, hash, truncate) and per-app/per-key rate limiting and retention with a 14-day default that never silently becomes unbounded.
- **Captures and timelapse.** Attach base64 JPEG frames under `screen_captures`; Blip offloads them to Bin, shows a thumbnail strip, and stitches a session into an MP4 timelapse.
- **AI agent surface** of blip_* MCP tools covering app/key/collection/rate-limit/retention/transform management, entry query and cursor tail, export, captures, timelapse, watches, and views.

## Integrations

Blip offloads capture images and compiles timelapse videos as Bin assets, and freezes filtered collections into immutable JSONL Bin assets. It ships two org-scoped rollups (`blip:entries_rollup`, `blip:metric_rollup`) that Bench dashboards chart for volume, error rate, and latency percentiles per build and platform. Watches emit Bolt events on the `blip` source (`entry.matched`, `window.breached`/`recovered`, `report_type.first_seen`, key and collection lifecycle, `entries.purged`, `timelapse.ready`), so a slow-frame or error-spike can route straight into a Banter channel. Agents reach Blip under an identity with heartbeat and `agent_policies` gating, and preflight visibility with `can_access` against the parent `blip.tracked_app` before citing any entry.

## Getting Started

Open Blip from the Launchpad. Declare a tracked app (collection on, 14-day retention default), mint an ingest key, and paste the ready-made client snippet shown beneath the one-time token into your client. Run the client so it POSTs reports, then open the live viewer for the report type that arrives. Save a view for a recurring filter, add a watch to get alerted on a condition, set a transform to redact PII, and build a Bench dashboard over the rollups for trends.
