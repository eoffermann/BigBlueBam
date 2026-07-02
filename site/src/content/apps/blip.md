---
title: "Blip (Telemetry)"
app: blip
generated: "2026-07-01T00:00:00.000Z"
---

# Blip (Telemetry)


App-telemetry recording for your own software: ship JSON, watch it stream live, query the history, and never lose it in a log file again.

- Embed one write-only ingest key, POST any JSON report over a bearer token, and Blip discovers the report types and fields for you, with no schema to declare
- Tail entries in a live streaming viewer over WebSocket, with backfill, cursor resume, and server-side filtering while you debug
- Filter fast against an auto-maintained field index, and pin recurring filters as saved views
- Turn a slow frame or an error spike into a throttled Bolt event with watches, routed straight into a Banter channel instead of a per-entry firehose
- Scrub PII at the edge with transforms (drop, mask, hash, truncate), keep telemetry lean with per-app retention, and freeze a collection to JSONL in Bin when you need it forever
- Let AI agents declare apps, mint keys, query and tail entries, manage watches, and stitch timelapses through 38 MCP tools, gated by agent policies and a visibility preflight

## See It in Action


![Live viewer](screenshots/light/05-live-viewer.png)


![Watch management](screenshots/light/06-watch-management.png)

![Transform editor](screenshots/light/08-transform-editor.png)

---

Part of the [BigBlueBam](/) productivity suite.
