# Blip - Telemetry, log, and profiling intake

> Blip is the BigBlueBam intake and inspection layer for runtime telemetry coming from your own running software. Declare an app to track, embed an ingest key in your client, POST JSON reports, then watch them stream in live or query the accumulated history. Reach for it when you need logs, crash dumps, function timings, or custom counters from a shipped app collected inside the suite.

## Overview

Blip collects runtime reports from a customer's own software (mobile apps especially, but anything that can POST JSON) and gives you a place to watch and query them. You declare a **tracked app**, mint one or more **ingest keys**, embed a key in your client, and the client POSTs JSON reports. Each report carries a free-form **report type** and any fields you like. Blip discovers the report types and fields from the data itself: nothing is pre-declared.

Two workflows drive the app. **Live debugging** is the primary one: open a view, run the instrumented app next to it, and watch telemetry stream in through a WebSocket live tail with your filter and columns applied. **Forensic/historical** is the other: query accumulated reports of a type, filter by field content, sort, page, freeze a collection to a JSONL file in Bin, and chart aggregate trends in Bench.

The ingest path is built to be fast and forgiving. A report is accepted (HTTP 202) once it is well-formed, redacted, queued, and tailed, not once it is durably stored. Malformed elements in a batch are dropped and counted rather than failing the whole batch. A PII transform runs on the edge before anything is tailed or stored, so no un-redacted field ever leaves the request thread.

Blip is org-scoped and connects to the rest of the suite. It offloads screenshot attachments to Bin, freezes collections into Bin assets, ships rollups to Bench, and emits Bolt events (only for entries that satisfy an explicitly configured, throttled **watch**, never for every raw entry).

This document describes what Blip does today. Where an action exists only through the API or an MCP tool, that is called out.

### Key concepts

- **Tracked app** - the unit of control. Owns the collection on/off switch, the default rate limit, the default retention policy, the PII transform rules, and the set of report types observed under it. Org-scoped.
- **Ingest key** - a write-only credential belonging to one tracked app. Token format `blip_<key_id>_<secret>`, shown once at creation. Independently suspendable and revocable, with an optional per-key rate-limit override. Embedded in shipped binaries, so treated as low-trust by design.
- **Report type** - a free string, the only mandatory field in any report. Types are discovered from incoming data, never pre-declared. Each `(tracked app, report type)` pair accumulates a field catalog and can carry saved views, watches, and retention overrides.
- **Entry** - one report. An append-only row carrying the redacted JSON payload plus a small set of promoted, indexed columns.
- **Reserved field** - a blessed key that is promoted to a typed, indexed column when present: `timestamp`, `level`, `session_id`, `app_version`, `platform`, `elapsed_ms`, and `screen_captures`. Everything else stays in the payload.
- **Saved view** - a reusable filter + columns + sort + live-tail flag over one `(tracked app, report type)`. Optional; a report type is fully usable without any.
- **Watch** - a server-side condition that emits a Bolt event when satisfied. Two kinds: a **match watch** (per entry) and a **window watch** (an aggregate over a sliding window).
- **Transform** - ordered redaction rules (drop, mask, hash, truncate) applied on the edge before tail and storage.
- **Capture** - a base64 JPEG screenshot attached to a report under the `screen_captures` key. Offloaded to object storage on write; the row keeps a lightweight reference.
- **Timelapse** - a video stitched from an ordered, filtered run of capture-bearing entries (one frame per capture).

### Where to find it

Blip lives at `/blip/`. Open it from the Launchpad app switcher, or go straight to the URL. You must be signed in to BigBlueBam. Blip is org-scoped; use the OrgSwitcher in the header to change which organization's data you see.

Roles and authority: listing apps, viewing entries, running the live tail, reading the field catalog, and CRUD on your own views are **member**-level. Declaring or editing apps, managing keys, toggling collection, setting rate limits, retention, and transforms, promoting fields, purging entries, and full watch management are **admin**-level. Deleting an app is **owner**-level. Every grant is delegatable per the standard permission model, so a specific member can be handed any individual capability.

## Feature reference

### Tracked apps

A tracked app is the container for everything else. Declaring one gives you an ingest endpoint, a place to mint keys, and a home for the report types your client sends. A new app is created with collection enabled and a 14-day app-wide retention default already in place.

The app list shows each tracked app with a health badge (collection on/off, recent volume). The app detail page adds a recent-volume sparkline, the observed report types, and the keys, transform, retention, and rate-limit panels.

To stop collecting without revoking keys, toggle **collection** off on the app. While collection is disabled, ingest requests are rejected with 409 and nothing is stored, but the keys themselves stay valid for when you turn it back on.

### Ingest keys

An ingest key is a write-only credential for exactly one tracked app. The full token (`blip_<key_id>_<secret>`) is shown once at creation and never again: only an HMAC of the secret is stored. Because these get embedded in shipped client binaries, they are assumed to leak, which is why a key can do nothing but append entries to its one app, carries its own rate limit, and is individually revocable.

- **Suspend** is reversible: flip a key to `suspended` to stop it authenticating, then back to `active` to resume.
- **Revoke** is terminal: a revoked token never works again. Both suspend and revoke are soft (the row stays) so historical entries keep their key attribution.
- **Rotation** is "create a new key, ship it, revoke the old one." There is no shared per-app secret to rotate.

The key-management screen shows every key with its label, last-4, status, and per-key rate-limit override. The moment a key is minted, the screen also shows the ready-to-paste client snippet with the live ingest URL and the just-minted token already filled in (see Client integration below).

### Report types and reserved fields

The only mandatory field in any report is `report_type`. Everything else is free-form. When a never-before-seen report type arrives, Blip records it and (optionally, via a watch) can react to it.

A small set of **reserved fields** are promoted to typed, indexed columns when present, so filtering and sorting on the common axes is fast. Reserved keys are still kept in the payload too, so the viewer sees a faithful copy of what the client sent.

| Reserved key | Type | Purpose |
|---|---|---|
| `report_type` | text | Mandatory. The only required field. |
| `timestamp` | timestamptz | Client-side event time. The server also stamps its own `received_at`. |
| `level` | text | Severity. An enforced enum (see below). |
| `session_id` | text | Group a run or session. |
| `app_version` | text | Filter and aggregate by build. |
| `platform` | text | ios / android / web / etc. |
| `elapsed_ms` | double | Canonical profiling duration; the default Bench metric. |
| `screen_captures` | refs | List of attached JPEG screenshots (offloaded to storage). |

#### The `level` vocabulary

The `level` column is constrained to a fixed, ordered severity enum. State this plainly to anyone instrumenting a new report, because it is the one reserved field with a closed domain:

```
debug  <  info  <  warn  <  error  <  fatal
```

Intake stays forgiving. A report whose `level` is outside this set is not rejected: it is stored normally, the raw value is preserved in `payload.level`, and the promoted `level` column is left null (so filters, indexes, and the Bench level dimension keep a clean, ordered domain). Clients that want their severity to participate in level filtering and rollups must send one of the five canonical values; anything else falls back to "unleveled."

### Saved views and the field catalog

A query against a `(tracked app, report type)` is a filter predicate, a column selection, a sort, and a page or live-tail flag. The filter is a (possibly nested) tree:

```
{
  "op": "and",
  "conditions": [
    { "field": "level", "operator": "in", "value": ["error", "fatal"] },
    { "field": "payload:fn", "operator": "contains", "value": "decode" },
    { "field": "elapsed_ms", "operator": "gte", "value": 8 }
  ]
}
```

`field` is either a reserved column name or `payload:<dot.path>`. Operators are `eq`, `neq`, `contains`, `not_contains`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `is_set`, `is_not_set`. Reserved-column comparisons are typed and index-eligible; payload-path comparisons coerce to text unless the field is a declared metric or has been promoted to an index.

A **saved view** bundles that filter with columns, sort, the live-tail flag, and a page size, named for reuse, scoped `private` (only you) or `org` (anyone who can access the app). A report type works with zero saved views: Blip auto-provides a sensible default (all reserved columns present, sorted newest-first, live tail on).

The **field catalog** is maintained automatically from incoming data: one entry per observed `(tracked app, report type, field path)` with an inferred type, first/last seen, and an observation count. It powers the column picker, the sort dropdown, metric declaration for Bench, and "this field is hot, index it" suggestions. Reserved fields are always indexed; a payload field is sortable unindexed by default, and an admin can explicitly promote a hot one to an index.

### Live tail

The live workflow is the point of the app, so tail streams over WebSocket rather than polling. The ingest edge publishes every redacted entry to a per-`(app, report type)` channel before it is durably written, so the tail is genuinely live and not gated on the write loop.

On connect, the gateway sends a **backfill** of the most recent matching page (the view's page size, default 100, capped at 500), then streams live entries as they arrive, each filtered and projected to the view's columns server-side. The viewer tracks the highest sequence number it has rendered so a reconnect resumes cleanly from where it left off.

A single chatty client can outrun a socket and a human's eyes. Above a per-socket ceiling, the gateway switches that subscription to sampled mode and shows a visible "sampling, N/sec not shown" banner plus a pause control. Only the live view is ever sampled; the durable store and watch evaluation always see every entry.

### Watches

A watch is a saved server-side condition on a `(tracked app, report type)` that emits a Bolt event when satisfied, so the suite can act on data the moment it lands. Watches are org-scoped operational objects with an enabled/disabled toggle. Two kinds:

- **Match watch (per entry).** The condition is a filter predicate evaluated on the edge against each incoming redacted entry. On a match it emits `entry.matched`. A per-watch cooldown caps fire frequency so a flood of matches never becomes a flood of Banter posts (`cooldown_sec = 0` means fire on every match). This is the direct answer to "post to Banter if `elapsed_ms` > 500."
- **Window watch (aggregate over a sliding window).** The condition is an aggregate (`count`, `rate`, or `avg`/`min`/`max`/`p50`/`p95`/`p99` of a numeric field) over a trailing window compared to a threshold. A worker tick evaluates it and emits `window.breached` on an upward crossing and `window.recovered` on the return below it. This is the right instrument for sustained degradation ("p95 of `elapsed_ms` over 5 min exceeds 800ms" or "error count over 1 min exceeds 20"): one alert on breach, one on recovery, instead of chattering.

A dry-run (`blip_watch_test`) evaluates a predicate against recent history and returns what would have matched, so you can validate a watch before enabling it. Each firing is recorded in the watch's history.

### Transforms (PII redaction)

Mobile logs routinely carry secrets and personal data, and Blip is a long-lived sink, so redaction runs on the edge before tail publish and before queueing. A transform is an ordered list of rules; each rule matches by explicit field path, glob, or regex on keys and applies an action:

- **drop** - remove the key entirely.
- **mask** - replace with a fixed token, optionally keeping the last N characters.
- **hash** - HMAC the value so identical values still correlate without exposing the value.
- **truncate** - cap string length.

A global per-string length cap is always applied as a floor regardless of rules, so a runaway log line can never store unbounded text. A transform can also target `screen_captures` to drop it entirely (an app that must never retain screenshots) or cap the list length. Pixel-level redaction inside an image is out of scope; the lever is keep-or-drop at the attachment level.

### Rate limiting and retention

Rate limiting is a token bucket in Redis, evaluated on the edge before any body parse, in two tiers that both must pass: per key (a key override, else the app default) and per tracked app (an aggregate ceiling across all its keys). Over limit returns 429 with `Retry-After`. The configurable caps are `refill_per_sec`, `burst`, `max_body_bytes` (default 256 KB), `max_batch_count` (default 500 entries/request), and the capture caps (`max_capture_body_bytes` 4 MB, `max_capture_bytes` 2 MB per image, `max_captures_per_report` 8).

Retention is a policy per `(tracked app, report type)` with an app-wide default, so crash reports can outlive verbose debug logs. A new app is seeded with a 14-day default. Storage never grows unbounded by accident: removing the age limit is an explicit policy edit, not a default. A policy can cap by age (`max_age_days`), row count (`max_rows`), or bytes (`max_bytes`). A manual purge targets a collection (with an optional filter) and routes through the standard two-step confirmation before deleting.

### Captures and timelapse

A report can attach screenshots from the tracked app under the reserved `screen_captures` key: a list of base64-encoded JPEGs (high quality assumed; no PNG/TIFF). Inline base64 would wreck row size and query speed, so Blip never stores it. On the async worker each image is decoded, validated, and offloaded to object storage with a thumbnail, and the inline base64 is replaced with a reference (`object_key`, `thumb_key`, `bytes`, `width`/`height`, `sha256`). The viewer and agents never receive base64: they get refs and resolve them to short-lived presigned URLs.

In the viewer, an entry with captures shows a thumbnail strip inline; clicking a thumbnail opens the full image. On the live tail a freshly arrived capture shows a "pending" placeholder that resolves to the thumbnail the moment the worker has stored it.

Any filtered, ordered run of capture-bearing entries can be compiled into a **timelapse** video. The intent case is a session: filter to one `session_id`, order by sequence, one frame per capture, a fixed duration per frame (default 0.5s). The worker assembles an MP4 with ffmpeg and stores it as an ordinary Bin video asset, then emits `timelapse.ready`.

### Bin and Bench handoffs

Live viewing is Blip-native: the live tail and custom-view viewer are Blip pages, and Blip owns server-side sort/filter/paginate on its own entries endpoint. To hand a collection off, **freeze to JSONL**: Blip materializes a filtered collection as a JSONL asset (one redacted report per line) and creates it as a normal Bin asset with its own retention, viewable read-only in Bin's structured viewer.

For trends, Blip ships two org-scoped rollups that Bench reads as data sources: an **entries rollup** (volume and rate over time, with per-level counts) and a **metric rollup** (n, sum, min, max, p50/p95/p99 of `elapsed_ms` and any field marked as a metric). Dashboards chart request volume, error rates, and latency percentiles per build and platform with no per-entry scanning.

## Client integration

Instrumenting a client is just "POST JSON to the ingest endpoint with the key header." Every report must contain a non-empty `report_type`; all other fields are free-form and discovered server-side. The ingest key is low-trust (it can only append to its one tracked app), so it is safe to embed in distributed clients and is rotated by minting a new key and revoking the old one.

The endpoint is `POST /blip/ingest/v1`, with the key on the `X-Blip-Key` header. A single report, an array, or NDJSON (`Content-Type: application/x-ndjson`, one object per line) are all accepted. The response is `202 Accepted` with `{ accepted, rejected }` counts.

### Unity / C#

```
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace BigBlueBam.Blip
{
    /// <summary>
    /// Minimal Blip telemetry client. Sends JSON reports to a Blip ingest
    /// endpoint. Every report must contain a non-empty <c>report_type</c>; all
    /// other fields are free-form and discovered server-side.
    /// </summary>
    public sealed class BlipClient : IDisposable
    {
        private readonly HttpClient _http;
        private readonly Uri _ingestUri;

        /// <summary>Creates a client bound to one ingest endpoint and key.</summary>
        /// <param name="ingestUrl">Full ingest URL, e.g. https://host/blip/ingest/v1.</param>
        /// <param name="ingestKey">The blip_&lt;key_id&gt;_&lt;secret&gt; token.</param>
        public BlipClient(string ingestUrl, string ingestKey)
        {
            _ingestUri = new Uri(ingestUrl);
            _http = new HttpClient();
            // The key travels on every request; never logged client-side.
            _http.DefaultRequestHeaders.Add("X-Blip-Key", ingestKey);
        }

        /// <summary>Sends a single report. report_type is injected.</summary>
        public async Task<bool> ReportAsync(string reportType, IDictionary<string, object> fields = null)
        {
            var payload = fields is null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(fields);
            payload["report_type"] = reportType;

            var json = JsonSerializer.Serialize(payload);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");

            // 202 == accepted (queued + tailed), not durably stored.
            var resp = await _http.PostAsync(_ingestUri, content).ConfigureAwait(false);
            return resp.StatusCode == System.Net.HttpStatusCode.Accepted;
        }

        public void Dispose() => _http.Dispose();
    }
}
```

### Python

```
"""Minimal Blip telemetry client.

Sends JSON reports to a Blip ingest endpoint. The only mandatory field in a
report is ``report_type``; everything else is free-form and discovered
server-side. The ingest key is low-trust (it can only append to its one
tracked app), so it is safe to embed in distributed clients.
"""

from __future__ import annotations

from typing import Any

import requests


class BlipClient:
    """A thin client around a single Blip ingest endpoint and key."""

    def __init__(self, ingest_url: str, ingest_key: str, timeout: float = 5.0) -> None:
        self._url = ingest_url
        self._timeout = timeout
        self._session = requests.Session()
        # The key travels on every request; it is never logged.
        self._session.headers["X-Blip-Key"] = ingest_key

    def report(self, report_type: str, **fields: Any) -> bool:
        """Send a single report. Returns True if accepted (HTTP 202)."""
        payload = dict(fields)
        payload["report_type"] = report_type  # the one mandatory key
        resp = self._session.post(self._url, json=payload, timeout=self._timeout)
        return resp.status_code == 202

    def report_batch(self, reports: list[dict[str, Any]]) -> bool:
        """Send many reports in one request. Malformed elements are dropped
        server-side and reported in the response counts."""
        resp = self._session.post(self._url, json=reports, timeout=self._timeout)
        return resp.status_code == 202
```

### Raw curl / HTTP

The universal fallback: any HTTP client works.

```
curl -X POST https://your-host/blip/ingest/v1 \
  -H "X-Blip-Key: blip_<key_id>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{ "report_type": "fn_timing", "fn": "decodeFrame", "elapsed_ms": 12.4,
        "session_id": "a91f", "app_version": "1.4.2", "platform": "ios",
        "level": "debug" }'
```

A successful response looks like:

```
202 Accepted
{ "accepted": 1, "rejected": 0 }
```

A batch returns the per-element counts and, if any element failed envelope validation, the offending indexes:

```
202 Accepted
{ "accepted": 498, "rejected": 2, "rejected_index": [17, 203] }
```

## User Stories

### Story: Track your first app and send a report

**Who:** A developer wiring telemetry into a shipped app.
**Goal:** Have a tracked app, a working ingest key, and a report visible in the viewer.
**Before you start:** You need admin access to Blip to declare an app and mint a key.

**Steps**

1. Open Blip and click **New Tracked App**. Give it a name (for example "Rescue Beacon (iOS)") and create it. Collection is on and a 14-day retention default is in place.
2. On the app detail page, open the **Keys** panel and click **Mint Key**. Copy the one-time token shown; it is never displayed again.
3. Beneath the token, copy the ready-to-paste client snippet (C#, Python, or curl) with your ingest URL and token already filled in, and drop it into your client.
4. Run your client so it POSTs a report, or paste the curl snippet into a terminal.
5. Open the live viewer for the report type that just arrived and watch it appear.

**Result:** Your app is tracked, a key is live, and reports are flowing into the viewer. The report type and its fields are now discoverable in the field catalog.

**Related:** Agents can do the same with `blip_app_create`, `blip_key_create`, and `blip_entry_query`.

### Story: Watch a build live while you debug

**Who:** A developer reproducing a bug with the instrumented app running next to Blip.
**Goal:** See telemetry stream in with a filter applied, frozen on the backfill when you want a stable frame.
**Before you start:** You need member access and at least one report type with entries.

**Steps**

1. Open the live viewer for a `(tracked app, report type)`, for example `fn_timing`.
2. Apply a filter or load a saved view such as "Slow frames" (`elapsed_ms >= 16`).
3. Run the instrumented app. New matching entries stream in at the top; expand one to see its full JSON.
4. If a chatty client outruns the socket, the viewer shows a "sampling, N/sec not shown" banner. Click **Pause** to freeze the on-screen stream, then **Resume** to reattach.

**Result:** You are watching live telemetry filtered to what you care about, with a clean resume after any reconnect.

**Related:** Agents poll the same stream without a socket via `blip_entry_tail` (entries with `seq > cursor`).

### Story: Alert when frames get slow

**Who:** An engineer who wants to know the moment performance regresses.
**Goal:** Post to a chat channel when a frame blows its budget, without a per-entry firehose.
**Before you start:** You need admin access to create a watch, and a Bolt rule to route the event.

**Steps**

1. On the tracked app, create a **match watch** on `(report_type = fn_timing)` with predicate `elapsed_ms gt 500`, cooldown 60s, named `slow-frame`.
2. Use **Test** to dry-run the predicate against recent history and confirm it would have matched the right entries.
3. Enable the watch.
4. In Bolt, add a rule triggered on `entry.matched` (source `blip`), filtered to `watch_name = slow-frame`, with an action that posts to a Banter channel.

**Result:** Each qualifying slow frame posts once to chat with the viewer deep link, throttled to at most one post per minute. For sustained degradation, a window watch (p95 over 5 min) posts once on breach and once on recovery instead.

**Related:** Agents manage watches with `blip_watch_create`, `blip_watch_test`, and `blip_watch_set_enabled`.

### Story: Redact PII before it is ever stored

**Who:** An admin responsible for what telemetry is allowed to retain.
**Goal:** Strip a sensitive field and cap a noisy one, on the edge, before tail or storage.
**Before you start:** You need admin access to manage the transform.

**Steps**

1. Open the tracked app's **Transform** editor.
2. Add a rule matching `payload:user.email` with action **hash** so identical addresses still correlate without exposing the value.
3. Add a rule matching `payload:radio_log` with action **truncate** and a `max_len`.
4. Optionally add a rule matching `screen_captures` with action **drop** if this app must never retain screenshots.
5. Save. The compiled ruleset takes effect at the edge within a second.

**Result:** No un-redacted copy of those fields is ever tailed or stored, and a global length floor still bounds any runaway string regardless of rules.

**Related:** Agents set rules with `blip_transform_set`.

### Story: Freeze a collection and chart its trend

**Who:** An analyst archiving an incident window and reporting on latency.
**Goal:** A shareable JSONL archive in Bin and a latency-percentile dashboard in Bench.
**Before you start:** You need member access (export covers the freeze and the captures/timelapse).

**Steps**

1. In the viewer, narrow to the collection you want (a report type plus a filter, for example a `session_id` or a date window).
2. Choose **Export to JSONL**. Blip writes a frozen Bin asset, one redacted report per line, with its own retention.
3. Open the asset in Bin's structured viewer to browse it read-only, or hand it to any JSONL-consuming tool.
4. In Bench, build a dashboard over the `blip:metric_rollup` source and chart p50/p95/p99 of `elapsed_ms` per `app_version` and `platform`.

**Result:** An immutable archive lives in Bin, and a Bench dashboard charts latency percentiles and volume with no per-entry scanning.

**Related:** Agents freeze with `blip_entry_export` and query trends through Bench's own tools.

## Related

- [Bin (Digital asset management)](../bin/help.md) - hosts frozen JSONL collections and the offloaded capture images and timelapse videos.
- [Bench (Analytics)](../bench/help.md) - charts the Blip entries and metric rollups (volume, error rate, latency percentiles).
- [Bolt (Workflow automation)](../bolt/help.md) - reacts to Blip watch events (`entry.matched`, `window.breached`, `window.recovered`, `report_type.first_seen`, `timelapse.ready`).
- [Banter (Team chat)](../banter/help.md) - a common destination for watch-driven alerts routed through Bolt.
