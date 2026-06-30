# BigBlueBam Blip Design Document

**App:** Blip (telemetry, log, and profiling intake)
**Status:** Design. Not yet implemented.
**Port:** 4018 (next free; bin-api took 4016, bay-api took 4017)
**Served at:** `/blip/` (SPA), `/blip/api/*` (authenticated REST), `/blip/ingest/*` (public-inbound), `/blip/ws` (live tail)
**Bolt source:** `blip`

---

## 1. Problem and users

Teams shipping apps (mobile especially, but anything that can POST JSON) have no
place inside the suite to collect runtime telemetry from those apps and look at
it. Today that means standing up a separate logging or APM stack, which is
exactly the kind of out-of-suite tool the rest of BigBlueBam exists to absorb.

Blip is the intake and inspection layer for runtime reports coming **from a
customer's own running software**, not from the suite's internal activity. A BBB
user declares an app to be tracked, gets an ingest endpoint and one or more API
keys, embeds those in their client, and the client POSTs JSON reports: log
lines, crash dumps, function timings, custom counters, whatever. The user then
opens a viewer (often with the tracked app running live next to it) and watches
the data arrive in real time through a custom view, or queries the accumulated
history, or builds dashboards over aggregates.

Two distinct user modes drive the design:

- **Live debugging.** Open a view, run the instrumented app, watch telemetry
  stream in with the view's filter and columns applied. This is the primary
  workflow and the reason live tail is a v1 requirement, not a nice-to-have.
- **Forensic / historical.** Query accumulated reports of a given type, filter
  by field content, sort, page, export a collection as JSONL, and aggregate
  trends in Bench.

Blip consumes nothing from other apps' operational data. It is a write-once
(from external clients), read-many intake plus inspection app. It depends
downstream on Bin (the `@bigbluebam/storage` object-storage backbone, plus Bin's
read-only structured viewer for frozen JSONL assets), Bench (rollup dashboards),
and Bolt (lifecycle events). Note Blip's own live viewer is native to Blip —
Bin's structured viewer renders Bin assets, not a remote app's live records
endpoint (see Section 14).

---

## 2. Naming and entity types

Single B-word, consistent with the suite. Entity-type strings follow the
existing dotted `app.entity` convention (e.g. `bond.deal`, `blank.form`,
`bin.asset`). Registering each new type is a five-part edit, not a single
allowlist append — `apps/api/src/services/visibility.service.ts` keeps two
synchronized lists plus a dispatch switch:

1. add the literal to the `VisibilityEntityType` string-union type;
2. add it to the `SUPPORTED_ENTITY_TYPES` array;
3. write a `preflightBlip…()` resolver (cf. `preflightBlankForm`);
4. add a `case` to the `preflightAccess` dispatch switch (unknown types fall
   through to `unsupported_entity_type`);
5. add a peer-app stub for the Blip table in
   `apps/api/src/db/schema/peer-app-stubs/` (this service reads peer tables via
   stubs).

Also extend the hard-coded supported-type allowlist string in the MCP
`can_access` tool description (`apps/mcp-server/src/tools/visibility-tools.ts`),
or agents will not be told the `blip.*` types exist. The registered types:

- `blip.tracked_app` (the gating entity; entries inherit its visibility)
- `blip.saved_view`

(Both are convention-compliant; `tracked_app` would be the first entity segment
with an underscore, which is fine — the dot between app and entity is the only
structural requirement.)

Entries themselves are **not** registered as entities. They are gated through
their parent `tracked_app`, the same way Bin assets gate through their container
rather than registering one entity per object. Anything querying or surfacing
entries calls `can_access(asker_user_id, 'blip.tracked_app', tracked_app_id)`
and denies by default on an unregistered or inaccessible app.

---

## 3. Core model

Four nouns. Everything else hangs off them.

1. **Tracked app.** The unit of control. Owns the collection on/off switch, the
   default rate limit, the default retention policy, the PII transform rules,
   and the set of report types observed under it. Org-scoped.
2. **Ingest key.** A write-only credential belonging to one tracked app.
   Independently suspendable and revocable, with an optional per-key rate-limit
   override. Embedded in shipped client binaries, so treated as low-trust and
   leak-prone by design.
3. **Report type.** A free string. The only mandatory field in any incoming
   report is `report_type`. Types are discovered from incoming data, never
   pre-declared. Each `(tracked_app, report_type)` pair accumulates an observed
   field catalog and can carry saved views, retention overrides, and declared
   metric fields.
4. **Entry.** One report. An append-only row carrying the (redacted) JSON
   payload plus a small set of promoted, indexed columns.

```
org
 └─ tracked_app (collection on/off, default rate limit, default retention, transform)
      ├─ ingest_key  (status, rate-limit override)         [many]
      ├─ report_type (discovered)                           [many]
      │    ├─ field_catalog entry (path, type, is_metric)   [many]
      │    ├─ saved_view (filter + columns + sort + tail)   [many]
      │    ├─ watch (match | window condition -> Bolt event)[many]
      │    └─ retention override                            [0..1]
      └─ entry (received_at, report_type, payload, ...)     [very many]
```

---

## 4. Ingest path ("fast as hell")

The hot path does the minimum to be safe and correct, then gets out of the way.
No database hit per request, no synchronous durable write, no heavy
transformation on the request thread.

### 4.1 Edge pipeline (synchronous, per request)

```
POST /blip/ingest/v1            Header: X-Blip-Key: blip_<key_id>_<secret>
  1. Parse key_id from token (string split, no DB).
  2. Resolve key from Redis cache (key_id -> {tracked_app_id, org_id,
     secret_hmac, status, collection_enabled, rate_limit, transform_version}).
     Cache miss -> single DB read, then cache with a 60s TTL + pub/sub
     invalidation on key/app mutations (a suspend/revoke takes effect within
     a second in practice, within the TTL worst case).
  3. Reject if status != 'active' or collection disabled (403 / 409).
  4. Constant-time compare HMAC-SHA256(secret, server_pepper) to secret_hmac.
  5. Token-bucket rate-limit check in Redis (per key, then per tracked_app).
     Over limit -> 429 + Retry-After. No body read on rejection.
  6. Enforce body size cap and batch-count cap (413 / 422).
  7. Parse body (single object | JSON array | NDJSON). Validate envelope:
     each element must be an object containing a non-empty report_type.
     Malformed elements are dropped and counted, never fail the batch.
  8. Apply the compiled PII transform (Section 9) to each element. This runs
     here, on the edge, so neither the live tail nor the stored copy ever sees
     un-redacted fields.
  9. Evaluate compiled match-watches (Section 12) for this (tracked_app,
     report_type). On a match, enqueue an entry.matched Bolt event honoring the
     watch cooldown (one Redis op), and bump window-watch counters/reservoirs.
     Predicates are cached and pre-compiled; this is cheap boolean work on the
     already-parsed, already-redacted object.
 10. Publish each redacted element to the live-tail channel
     blip:tail:<tracked_app_id>:<report_type> (Redis pub/sub). Fire-and-forget.
     If the element carries screen_captures (Section 23), the base64 images are
     stripped from the tail copy and replaced with lightweight descriptors
     ({ index, bytes, pending: true }) so a screenshot-bearing report never
     pushes megabytes over the socket; the viewer lazily resolves the real
     images once the worker has stored them.
 11. Enqueue the redacted batch to BullMQ (blip-ingest queue) for durable write.
 12. Return 202 with { accepted, rejected } counts (and a rejected-index list
     only if any element failed envelope validation).
```

Steps 1 through 5 touch only Redis and a string compare. The key insight: the
secret is high-entropy (we generate it), so a fast keyed HMAC is the correct
verification primitive on a hot path. A slow KDF (argon2/bcrypt) is for
low-entropy human passwords and would be wrong here.

"Accepted" means "well-formed, redacted, queued and tailed," not "durably
stored." That is the right contract for telemetry: a fast ack, burst
absorption, and batched writes. The rare case where a tailed/queued entry later
fails the durable write (DB outage) is logged to a dead-letter queue and counted
in the tracked app's health panel, not surfaced to the client.

### 4.2 Worker (asynchronous, batched)

The `blip-ingest` BullMQ worker drains the queue and, per batch:

1. Extracts promoted reserved fields (Section 6) from each redacted payload.
   The `level` value is coerced against the enforced enum: a recognized value
   populates the `level` column, an unrecognized one leaves the column null
   while the raw value stays in `payload.level` (forgiving intake, clean
   column domain).
2. Computes `payload_bytes` for byte-based retention accounting.
3. Offloads `screen_captures` (Section 23): for each base64 JPEG, validate the
   magic bytes, `put` the full image and a sharp-generated thumbnail to object
   storage under a partition-aligned key, then replace the base64 element with a
   ref (`object_key`, `thumb_key`, `bytes`, `width`/`height`, `sha256`). Sets
   `capture_count`. The base64 never reaches the row. This is the one heavy step,
   and it is deliberately here in the async worker, not on the edge.
4. Upserts the observed field catalog for each `(tracked_app, report_type)`
   (path, inferred type, first/last seen, observation count). New report types
   emit `report_type.first_seen` (Section 12).
5. Multi-row `INSERT` into the partitioned `blip_entries` table, assigning each
   row the next value of the shared `blip_entry_seq` sequence (monotonic cursor
   ordering across partitions).

Batch size and flush interval are tuned so a chatty client produces a few wide
inserts per second, not thousands of tiny ones.

### 4.3 Request and response examples

Single report:

```json
POST /blip/ingest/v1
X-Blip-Key: blip_7fkd2a_9c1e...secret...
Content-Type: application/json

{ "report_type": "fn_timing", "fn": "decodeFrame", "elapsed_ms": 12.4,
  "session_id": "a91f", "app_version": "1.4.2", "platform": "ios",
  "level": "debug" }
```

Batch (array) or NDJSON (one object per line, `Content-Type:
application/x-ndjson`) for high-throughput clients:

```
202 Accepted
{ "accepted": 498, "rejected": 2, "rejected_index": [17, 203] }
```

---

## 5. Storage

One append-only table, monthly range-partitioned by `received_at`, mirroring the
`banter_messages` monthly partitioning (migration `0124` converts that table to a
partitioned parent and `0106` pre-creates future month partitions) so that the
cheap bulk purge path is "drop a partition," not "delete millions of rows."
(Note: `activity_log` is **not** partitioned — `banter_messages` is the real
partitioned-table precedent to copy, not `activity_log`.) Declared in Drizzle for
columns and consumed shapes; partitioning and partition provisioning live in raw
migration SQL (Drizzle does not model partitioning). No partition-provisioning
**worker job** exists yet to copy: the closest reference is the banter-api
`partition-manager.ts` service (`computePartitionInfo` / `partitionExists` /
`ensureNextMonthPartition`), and `blip-partition-provision` (Section 17) would be
the first such job actually wired into `apps/worker/src/worker.ts` — port that
helper's logic.

```ts
/**
 * blip_entries: the append-only telemetry store.
 *
 * Range-partitioned monthly by received_at (see migration; Drizzle declares the
 * columns only). One row per accepted, redacted report. The full redacted
 * report is kept verbatim in `payload`; a small set of reserved fields is
 * promoted to typed, indexed columns for fast filter/sort on the common axes
 * without forcing any schema on the client.
 */
export const blipEntries = pgTable('blip_entries', {
  // Partition key. Server-stamped on durable write, always present.
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  id: uuid('id').notNull().defaultRandom(),
  // Shared monotonic sequence: stable cursor + live-tail resume across partitions.
  seq: bigint('seq', { mode: 'bigint' }).notNull(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type').notNull(),
  // Which key wrote this. Nullable so revoking a key never orphans its entries.
  ingestKeyId: uuid('ingest_key_id'),
  // --- promoted reserved fields (null when absent in the report) ---
  clientTs: timestamp('client_ts', { withTimezone: true }), // client-side event time
  level: text('level'),                                      // CHECK-constrained enum: debug|info|warn|error|fatal (see migration)
  sessionId: text('session_id'),
  appVersion: text('app_version'),
  platform: text('platform'),
  elapsedMs: doublePrecision('elapsed_ms'),                  // the canonical profiling metric
  // Number of attached screenshots (see Section 23). Promoted so "has captures"
  // is an index-backed filter and the timelapse selector is cheap.
  captureCount: integer('capture_count').notNull().default(0),
  // --- the report itself (redacted), plus accounting ---
  payload: jsonb('payload').notNull(),                       // full redacted report incl. reserved keys; screen_captures held as refs, not base64
  payloadBytes: integer('payload_bytes').notNull(),
}, (t) => ({
  // PK must include the partition key.
  pk: primaryKey({ columns: [t.receivedAt, t.id] }),
  // Cursor + live-tail resume: WHERE tracked_app/report_type AND seq > :cursor.
  bySeq: index('blip_entries_app_type_seq').on(t.trackedAppId, t.reportType, t.seq),
  // Time-window queries.
  byTime: index('blip_entries_app_type_time').on(t.trackedAppId, t.reportType, t.receivedAt),
  // Common promoted-field filters.
  byLevel: index('blip_entries_app_type_level').on(t.trackedAppId, t.reportType, t.level),
  byElapsed: index('blip_entries_app_type_elapsed').on(t.trackedAppId, t.reportType, t.elapsedMs),
  // "Entries with screenshots" + timelapse selection.
  byCaptures: index('blip_entries_app_type_captures').on(t.trackedAppId, t.reportType, t.captureCount),
  // Arbitrary field containment / existence on the blob.
  payloadGin: index('blip_entries_payload_gin').using('gin', t.payload),
}));
```

Notes:

- **`seq`** comes from a single shared sequence (`blip_entry_seq`), assigned at
  insert time. It orders by durable-write order (not ingest order), which is the
  correct ordering for a cursor and is monotonic across partitions. A viewer
  remembers the last `seq` it saw and resumes from there after a reconnect.
- **GIN with `jsonb_path_ops`** keeps arbitrary-field containment queries fast.
  Sorting and ranged comparison on arbitrary (non-reserved) fields uses
  `payload->>'field'` expressions, unindexed by default. An admin can promote a
  hot field to an expression index (Section 7.3).
- RLS org scoping applies the same way as the rest of the suite (defense in
  depth over application-level `org_id` filtering).

---

## 6. Reserved (blessed) fields

Promoted to typed, indexed columns when present in a report. Everything else
stays in `payload`. Reserved keys are still kept in `payload` too, so the
viewer sees a faithful copy of what the client sent.

| Reserved key | Column | Type | Purpose |
|---|---|---|---|
| `report_type` | `report_type` | text | **Mandatory.** The only required field. |
| `timestamp` | `client_ts` | timestamptz | Client-side event time (server `received_at` always recorded separately). |
| `level` | `level` | text | Severity. **Enforced enum** (see below); `error`/`fatal` get UI affordances. |
| `session_id` | `session_id` | text | Group a run/session. |
| `app_version` | `app_version` | text | Filter and aggregate by build. |
| `platform` | `platform` | text | ios / android / web / etc. |
| `elapsed_ms` | `elapsed_ms` | double | Canonical profiling duration; default Bench metric. |
| `screen_captures` | _(offloaded; see §23)_ | jsonb (refs) | List of attached JPEG screenshots. Offloaded to object storage on write; the stored value is a list of refs, never inline base64. |
| _(derived)_ | `capture_count` | int | Number of attached captures. Promoted and indexed so "entries with screenshots" is a fast filter and the timelapse selector (§23) is cheap. |

Sorting and filtering on a reserved field is index-backed and fast. Sorting and
filtering on any other field is available (over `payload`) but unindexed unless
promoted. `screen_captures` is the one reserved key handled specially: it is an
attachment channel, not a scalar, and is offloaded rather than promoted to a
scalar column (Section 23).

### 6.1 The `level` vocabulary (document this for report authors)

The promoted `level` column is constrained to a fixed, ordered severity enum.
This must be stated plainly in the setup docs for anyone instrumenting a new
report, because it is the one reserved field with a closed domain:

```
debug  <  info  <  warn  <  error  <  fatal
```

Intake stays forgiving: a report whose `level` is outside this set is **not**
rejected. It is stored normally, the raw value is preserved in `payload.level`,
and the promoted `level` column is left null (so filters, indexes, and the
Bench `level` dimension keep a clean, ordered domain). Clients that want their
severity to participate in level filtering and rollups must send one of the five
canonical values. The setup guide should show the five values and note that
anything else falls back to "unleveled."

---

## 7. Viewing: ad-hoc reporting and saved views

### 7.1 The query model

A query against a `(tracked_app, report_type)` is a filter predicate, a column
selection, a sort, and a page or live-tail flag. There is **no shared recursive
AND/OR condition-tree** in the suite to reuse (Bond has no segments; the closest
existing shapes are flat and single-level: Blast segments
`{ conditions: [{ field, op, value }], match: 'all' | 'any' }` keyed on `op`,
Blank routing `{ condition: { field, op, value }, action }`, and Bolt's
`{ field, operator, value, logicGroup: 'and' | 'or' }`). Blip's nested predicate
below is therefore **net-new to Blip**, modeled on those shapes but adding
recursion and JSONB field paths. Note the field-name divergence in prior art
(`op` in Blast/Blank vs `operator` in Bolt); Blip standardizes on `operator`:

```jsonc
{
  "op": "and",
  "conditions": [
    { "field": "level", "operator": "in", "value": ["error", "fatal"] },     // reserved column
    { "field": "payload:fn", "operator": "contains", "value": "decode" },     // JSONB path
    { "field": "elapsed_ms", "operator": "gte", "value": 8 }                  // reserved column
  ]
}
```

- `field` is either a reserved column name or `payload:<dot.path>` resolving to
  `payload #>> '{dot,path}'`.
- Operators: `eq`, `neq`, `contains`, `not_contains`, `gt`, `gte`, `lt`, `lte`,
  `in`, `not_in`, `is_set`, `is_not_set`.
- Reserved-column comparisons are typed and index-eligible; JSONB-path
  comparisons coerce to text unless the path is a declared metric (numeric) or a
  promoted indexed field.

### 7.2 Saved views (v1 feature)

A saved view belongs to a `(tracked_app, report_type)` and is **optional**: a
report type works with zero saved views (Blip auto-provides a sensible default
view: all reserved columns present in the catalog, sorted `seq desc`, live tail
on). At product release the user can create, name, and reuse views.

```ts
/**
 * A reusable view over one (tracked_app, report_type). Optional; a report type
 * is fully usable without any. `scope` controls sharing: 'private' is visible
 * only to the owner, 'org' to anyone who can_access the tracked_app.
 */
export const blipSavedViews = pgTable('blip_saved_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type').notNull(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull(),
  scope: text('scope').notNull().default('private'), // 'private' | 'org'
  isDefault: boolean('is_default').notNull().default(false),
  // { filter, columns:[{field,label?,width?}], sort:[{field,dir}],
  //   liveTail:boolean, pageSize:number }
  spec: jsonb('spec').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

### 7.3 Field catalog and field promotion

The worker maintains `blip_field_catalog`, one row per observed
`(tracked_app, report_type, field_path)` with inferred type, first/last seen,
and observation count. It powers the view column picker, the sort-field
dropdown, metric declaration for Bench, and "this field is hot, index it"
suggestions.

```ts
/**
 * Observed-field catalog, upserted by the ingest worker. Drives column pickers
 * and sort options with zero client configuration.
 *   is_metric  -> included in the numeric Bench rollup (Section 8)
 *   is_indexed -> a btree expression index exists on payload->>field_path
 */
export const blipFieldCatalog = pgTable('blip_field_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type').notNull(),
  fieldPath: text('field_path').notNull(),       // 'payload:fn', 'level', ...
  inferredType: text('inferred_type').notNull(), // 'string'|'number'|'bool'|'object'|'array'|'mixed'
  isMetric: boolean('is_metric').notNull().default(false),
  isIndexed: boolean('is_indexed').notNull().default(false),
  firstSeen: timestamp('first_seen').notNull().defaultNow(),
  lastSeen: timestamp('last_seen').notNull().defaultNow(),
  observationCount: bigint('observation_count', { mode: 'bigint' }).notNull().default(0n),
}, (t) => ({
  uniqPath: uniqueIndex('blip_field_catalog_uniq').on(t.trackedAppId, t.reportType, t.fieldPath),
}));
```

Reserved fields are indexed always. JSONB fields are sortable unindexed by
default; promoting one (`blip.field.index`) creates
`CREATE INDEX CONCURRENTLY ... ((payload->>'field'))` via a worker job and flips
`is_indexed`. Index creation is heavy and explicit, never automatic.

---

## 8. Live tail (v1, true real time)

The live workflow is the point of the app, so tail streams over WebSocket rather
than polling. Blip joins the suite's many realtime-bearing apps — Bam, Helpdesk,
Banter, Beacon, Brief, Board, Bond, Bin, Bay, Blueprint, and Bureau all run
WebSocket endpoints today.

### 8.1 Mechanics

The ingest **edge** publishes every redacted entry to
`blip:tail:<tracked_app_id>:<report_type>` (Redis pub/sub) before it is durably
written, so the tail is genuinely live and not gated on the write loop. A WS
gateway in blip-api holds client subscriptions, each carrying a compiled filter
and the subscribed channel. On each published entry it evaluates the
subscriber's filter server-side, projects to the view's columns, and pushes only
matching, projected entries.

### 8.2 Connect, backfill, resume

```
client -> ws:  { type: "subscribe", tracked_app_id, report_type,
                 filter, columns, since_seq? }
server -> ws:  { type: "backfill", entries: [...] }   // recent N matching, seq asc
server -> ws:  { type: "entry", entry: {...} }        // live, as they arrive
server -> ws:  { type: "sampling", dropped_per_sec }  // see backpressure
server -> ws:  { type: "error", code, message }
```

On connect the gateway loads the most recent matching page from `blip_entries`
(the view's `page_size`, default 100, capped at 500) (or everything with
`seq > since_seq` on reconnect), sends it as `backfill`, then streams live. The
client tracks the highest `seq` it has rendered for clean resume.

### 8.3 Backpressure

A single chatty client can outrun a socket and a human's eyes. Per-socket
ceiling on delivered entries per second: above it, the gateway switches that
subscription to coalesced/sampled mode and emits periodic `sampling` notices
with the drop rate, which the viewer surfaces as a visible "sampling, N/sec
not shown" banner plus a pause control. The durable store is never sampled; only
the live view is. "Pause" freezes the on-screen stream (buffers nothing) and
"resume" reattaches from the current head.

---

## 9. PII / payload transform (v1)

Mobile logs routinely carry secrets and personal data, and Blip is a long-lived
sink, so redaction ships in v1 and runs on the **edge** (before tail publish and
before queueing), so no un-redacted field ever leaves the request thread.

```ts
/**
 * Ordered redaction rules for a tracked_app (optionally narrowed to one
 * report_type). Compiled and cached per (tracked_app, report_type); the cache
 * is invalidated via pub/sub when rules change, and the active version is
 * carried in the ingest key cache entry so the edge always applies the current
 * ruleset.
 */
export const blipTransforms = pgTable('blip_transforms', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type'),  // null = applies to all report types for the app
  enabled: boolean('enabled').notNull().default(true),
  // [{ match: 'payload:user.email' | 'glob:*token*' | 'regex:...',
  //    action: 'drop' | 'mask' | 'hash' | 'truncate',
  //    params: { keep_last?: 4, max_len?: 256 } }, ...]
  rules: jsonb('rules').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

Actions: `drop` (remove the key), `mask` (replace with a fixed token, optionally
keeping the last N chars), `hash` (HMAC the value so identical values still
correlate without exposing the value), `truncate` (cap string length). Matching
is by explicit field path, glob, or regex on keys. A global per-string length
cap is always applied as a floor regardless of rules, so a runaway log line can
never store unbounded text.

A transform may target `screen_captures` to `drop` it entirely (an app that must
never retain screenshots) or to cap the list length, and this runs at the edge
before the images are ever queued or stored. Pixel-level redaction inside an
image (blur, OCR-and-mask) is out of scope; the lever is keep-or-drop at the
attachment level (Section 23, Section 19).

---

## 10. Ingest keys

```ts
/**
 * A write-only ingest credential for one tracked_app. The full token is shown
 * exactly once at creation and never again; only an HMAC of the secret is
 * stored. These get embedded in shipped client binaries and are assumed to
 * leak, which is why they can do nothing but append entries to their one app,
 * are individually revocable, and carry their own rate limit.
 *
 * Token format: blip_<key_id>_<secret>
 *   key_id  -> public, indexed lookup id (cleartext)
 *   secret  -> high-entropy; verified by constant-time HMAC compare
 */
export const blipIngestKeys = pgTable('blip_ingest_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  keyId: text('key_id').notNull(),          // public lookup id embedded in the token
  secretHmac: text('secret_hmac').notNull(),// HMAC-SHA256(secret, server_pepper)
  last4: text('last4').notNull(),           // display only
  fingerprint: text('fingerprint').notNull(),
  label: text('label'),                     // human label ("iOS prod", "Android beta")
  status: text('status').notNull().default('active'), // 'active' | 'suspended' | 'revoked'
  rateLimitOverride: jsonb('rate_limit_override'),     // { refill_per_sec, burst } | null
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  suspendedAt: timestamp('suspended_at'),
}, (t) => ({
  uniqKeyId: uniqueIndex('blip_ingest_keys_key_id').on(t.keyId),
}));
```

- **Suspend** is reversible (flip to `active`); **revoke** is terminal (the
  token never works again). Both are soft (the row stays) so historical entries
  keep their `ingest_key_id` attribution. Hard deletion of a key row is a
  separate admin action that nulls the FK on its entries.
- Rotation is "create a new key, ship it, revoke the old one." There is no
  shared per-app secret to rotate, only per-key tokens, by design.

---

## 11. Rate limiting and retention

### 11.1 Rate limiting

Token bucket in Redis, evaluated at the edge before any body parse. Two tiers,
both must pass: **per key** (key override, else the tracked app default) and
**per tracked app** (an aggregate ceiling across all its keys). A
platform-level hard cap sits above both as a safety stop (SuperUser-set). Over
limit returns `429` with `Retry-After`. Caps configurable per tracked app and
per key:

- `refill_per_sec`, `burst` (the bucket parameters)
- `max_body_bytes` (default 256 KB)
- `max_batch_count` (default 500 entries per request)
- `max_capture_body_bytes` (default 4 MB; the larger cap applied when a report
  carries `screen_captures`, so screenshots fit while text-only reports stay
  cheap)
- `max_capture_bytes` (default 2 MB per image) and `max_captures_per_report`
  (default 8)

### 11.2 Retention and purge

Policy per `(tracked_app, report_type)` with a tracked-app default, so crash
reports can outlive verbose debug logs. A newly declared tracked app is seeded
with a 14-day app-wide default (`max_age_days = 14`); a report type with no
override inherits it. Storage never grows unbounded by accident: removing the
age limit is an explicit policy edit, not a default.

```ts
export const blipRetentionPolicies = pgTable('blip_retention_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type'),     // null = the app-wide default
  maxAgeDays: integer('max_age_days'),  // null = no age limit
  maxRows: bigint('max_rows', { mode: 'bigint' }),    // null = no row cap
  maxBytes: bigint('max_bytes', { mode: 'bigint' }),  // null = no byte cap
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

Two enforcement mechanisms, chosen honestly for cost:

1. **Coarse floor (cheap).** A worker drops whole monthly partitions once every
   row in them is past the **longest** retention in force. This is the bulk path
   and the reason for time-partitioning.
2. **Finer per-type policies (bounded).** Where a report type's retention is
   shorter than the partition floor, the worker runs batched ranged deletes
   within live partitions (`WHERE tracked_app_id=? AND report_type=? AND
   received_at < ?`, limited and looped). Row- and byte-cap policies are enforced
   the same way (delete oldest beyond the cap).

Partitioning by report type as well was considered and rejected: it explodes
partition count for the common case to optimize the uncommon one. Monthly
partitions plus targeted deletes is the right tradeoff.

Purging entries must also reclaim their offloaded images, and partition-drop
does not cascade to object storage. So capture objects are keyed by month
(Section 23.2): dropping a month partition is paired with a prefix sweep of that
month's image objects. `@bigbluebam/storage` exposes prefix `list(prefix, cursor)`
(paged at 1000) but **no bulk/prefix delete** — only single-key `delete(key)` —
so the sweep is a `list`-then-`delete`-per-object loop, still cheap because it is
bounded to one month's keys. For the finer ranged deletes and manual purges, the
worker enumerates the `capture_count > 0` rows it is about to remove and deletes
their referenced objects first (bounded work). Compiled timelapse videos (Section 23.4) are independent Bin
assets with their own retention and are not GC'd by entry purges.

**Manual purge** (`blip.entry.purge`) targets a `(tracked_app, report_type[,
filter])` and routes through the `confirm_action` two-step token dance like
every other destructive suite action. Emits `entries.purged`.

---

## 12. Reactive monitoring: watches, Bolt events, and agent tail

Fast, live intake is only worth it if the suite can act on data the moment it
lands. Three mechanisms ship at launch and give humans, agents, and Bolt rules
first-class reactive access **without turning Bolt into a per-entry firehose**.
The discipline holds: Blip never emits a Bolt event for a raw entry. Events fire
only for entries that satisfy an explicitly configured, throttled **watch**.

### 12.1 Watches

A watch is a saved server-side condition on a `(tracked_app, report_type)` (or
all types for an app) that emits a Bolt event when satisfied. It reuses the
Section 7.1 filter-predicate shape. Watches are org-scoped operational objects
(admin-managed, delegatable), not personal views, and carry an enabled/disabled
toggle. Two kinds:

- **Match watch (per-entry).** The condition is a filter predicate, evaluated at
  the **edge** against each incoming redacted entry (pipeline step 9), the same
  point as the tail publish. On a match it emits `entry.matched`. A per-watch
  cooldown (Redis) caps fire frequency so a flood of matches never becomes a
  flood of Banter posts (`cooldown_sec = 0` means fire on every match). This is
  the direct answer to "post to Banter if `elapsed_ms` > 500."
- **Window watch (aggregate over a sliding window).** The condition is an
  aggregate over a trailing window compared to a threshold: `count`, `rate`
  (per second/minute), or `avg`/`min`/`max`/`p50`/`p95`/`p99` of a numeric field.
  Edge increments lightweight per-watch counters/reservoirs in Redis; a
  `blip-watch-eval` worker tick (default every 30s) evaluates the threshold and
  emits `window.breached` on an upward crossing and `window.recovered` on the
  return below it. Hysteresis plus cooldown prevent flapping. This is the path
  for "p95 of `elapsed_ms` over the last 5 min exceeds 800ms" or "`error`-level
  count over 1 min exceeds 50," which is sustained-degradation alerting done
  right (one alert on breach, one on recovery), and it retires the old
  "threshold/anomaly deferred to P1" hedge.

```ts
/**
 * A server-side condition that emits a Bolt event when satisfied. Reuses the
 * Section 7.1 predicate for `match`; for `window`, `predicate` holds the window,
 * aggregate, and comparator. Org-scoped operational config, not a personal view.
 */
export const blipWatches = pgTable('blip_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type'),               // null = all report types for the app
  name: text('name').notNull(),                  // stable handle Bolt rules filter on
  description: text('description'),
  kind: text('kind').notNull(),                  // 'match' | 'window'
  enabled: boolean('enabled').notNull().default(true),
  // match:  a Section 7.1 filter tree
  // window: { window_sec, aggregate: { op:'count'|'rate'|'avg'|'min'|'max'|'p50'|'p95'|'p99',
  //           field? }, comparator: { operator:'gt'|'gte'|'lt'|'lte', value } }
  predicate: jsonb('predicate').notNull(),
  cooldownSec: integer('cooldown_sec').notNull().default(60), // min seconds between fires
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastFiredAt: timestamp('last_fired_at'),
});

/**
 * Append-only firing log for watches. Powers blip_watch_history, dedup, and the
 * watch health panel. Time-pruned (short retention; this is operational, not
 * the telemetry store).
 */
export const blipWatchEvents = pgTable('blip_watch_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  watchId: uuid('watch_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type'),
  eventName: text('event_name').notNull(),       // 'entry.matched'|'window.breached'|'window.recovered'
  firedAt: timestamp('fired_at').notNull().defaultNow(),
  // match: matched entry summary (seq, reserved fields, truncated payload, deep link)
  // window: { value, threshold, window_sec, sample_count }
  context: jsonb('context').notNull(),
});
```

Watches gate through their `tracked_app` for `can_access` (no new entity type).
A `blip_watch_test` dry-run evaluates a predicate against recent history and
returns what would have matched, so a watch can be validated before it is
enabled. Watch conditions are **declarative only** (predicates and aggregates,
no custom code on the ingest path), which is what keeps edge evaluation cheap
and safe.

### 12.2 Bolt events (source `blip`)

| Event | When |
|---|---|
| `tracked_app.created` | A new app is declared for tracking. |
| `collection.started` / `collection.stopped` | Collection toggled. |
| `key.created` / `key.suspended` / `key.revoked` | Key lifecycle. |
| `report_type.first_seen` | A never-before-seen report type arrives for an app. React to new telemetry kinds (notify Banter, auto-create a default view). |
| `entries.purged` | A manual or policy purge completed (counts in payload). |
| `entry.matched` | A **match watch** fired. Payload: `watch_id`, `watch_name`, `tracked_app_id`, `report_type`, and an entry summary (`seq`, `received_at`, reserved fields, truncated payload, viewer deep link). Fires only on match, throttled by cooldown. |
| `window.breached` / `window.recovered` | A **window watch** crossed or cleared its threshold. Payload: `watch_id`, `watch_name`, and window stats (`value`, `threshold`, `window_sec`, `sample_count`). |
| `timelapse.ready` | A timelapse compilation job (Section 23.4) finished. Payload: `job_id`, `tracked_app_id`, the Bin video asset ref, frame count, and duration. |

The match/window payloads carry a summary plus a deep link rather than an
unbounded entry, so a Bolt rule can act immediately and fetch full context via
`blip_entry_query` only if it needs more. A match watch whose predicate is
`screen_captures is_set` is the natural "a bug report with a screenshot just
arrived" trigger, routing such reports straight into a Banter channel.

Emit each event with the shared helper, whose real signature is **positional**
(not an options object): `publishBoltEvent('tracked_app.created', 'blip',
payload, orgId, actorId?, actorType?)` from `@bigbluebam/shared` — note `orgId`
is a required 4th argument. Event names are **bare/un-prefixed** (`tracked_app.created`,
never `blip.tracked_app.created`); the `source: 'blip'` is the separate 2nd arg.
Register every `{ source: 'blip', event_type, description, payload_schema: [...] }`
in a new `blipEvents: EventDefinition[]` block in
`apps/bolt-api/src/services/event-catalog.ts`; the `scripts/check-bolt-catalog.mjs`
CI guard rejects any `(source, event_type)` pair not in the catalog and any
source-prefixed event name.

### 12.3 Worked example: `elapsed_ms` > 500 posts to Banter

1. An admin (or an agent via `blip_watch_create`) creates a **match watch** on
   `(app = Frndo, report_type = fn_timing)`: predicate `elapsed_ms gt 500`,
   `cooldown_sec = 60`, name `slow-frame`.
2. A report arrives with `elapsed_ms = 812`. It matches at the edge, so Blip
   enqueues `entry.matched` (source `blip`, `watch_name = slow-frame`).
3. A Bolt automation rule triggered on `entry.matched` (source `blip`), filtered
   to `watch_name = slow-frame`, posts to a Banter channel: "slow frame:
   decodeFrame 812ms, build 1.4.2 ios" with the viewer deep link.
4. The 60s cooldown means at most one post per minute even if frames keep
   blowing the budget. For sustained degradation, a **window watch** (p95 of
   `elapsed_ms` over 5 min > 800) is the better instrument: it posts once on
   breach and once on recovery instead of chattering.

When a **static Bolt rule** posts the match, the admin who authored the rule
already has access to both the tracked app and the target channel, so no extra
check is needed. When an **agent** fans a match into a shared surface, it runs
the standard `can_access` preflight against the parent `blip.tracked_app` for
that surface's audience (agent-conventions §1), exactly as for any other
cross-app surfacing.

### 12.4 Agents monitoring incoming data

Agents are first-class users, so they monitor two complementary ways:

- **Reactive (push).** An agent reacts to `entry.matched` / `window.breached` /
  `window.recovered` through Bolt or by its runner subscribing to those events,
  and can create and tune its own watches via the `blip_watch_*` tools. This is
  the efficient default: the agent sleeps until a condition it configured fires.
- **Active (pull).** `blip_entry_tail(tracked_app, report_type, cursor=seq,
  filter?)` returns entries with `seq > cursor` (newest-bounded) plus the new
  max `seq`, so a runner incrementally polls the live stream without holding a
  socket. This is the agent-facing equivalent of the human WebSocket tail; the
  WS transport stays UI-only, the cursor tail serves agents.

A typical "agent watching the logs" creates a window watch for the condition it
cares about (push) and uses `blip_entry_tail` to pull surrounding context when
it wakes. Aggregate trends for dashboards still come from the Bench rollups
(Section 13) through Bench's own MCP tools; watches are the low-latency reactive
layer, Bench is the trend layer.

---

## 13. Bench integration (rollups, not raw JSONB)

Bench is a read layer over a compile-time allowlist (the `DATA_SOURCES` array in
`apps/bench-api/src/lib/data-source-registry.ts`, keyed by a `product:entity`
string). The query builder always injects `<orgColumn> = $org` for tenant
isolation; `orgColumn` **defaults to `organization_id`** and is overridden
per-source to `org_id` for tables that use that name. A source whose backing
table lacks its declared org column 42703s and returns nothing — the registry's
documented example of this gap is `bench:daily_task_throughput` (commented at the
registry), with `helpdesk:tickets` an undocumented twin. So Blip does **not**
point Bench at raw entries. It ships two org-scoped rollups and registers those:

- **`blip:entries_rollup`** — `(org_id, tracked_app_id, report_type,
  bucket_hour, entry_count)`. Volume and rate over time; per-level counts via a
  `level` dimension.
- **`blip:metric_rollup`** — `(org_id, tracked_app_id, report_type, field_path,
  bucket_hour, n, sum, min, max, p50, p95, p99)` using Postgres
  `percentile_cont`. Covers `elapsed_ms` always (it is the canonical profiling
  metric) plus any field marked `is_metric` in the catalog. **The percentile
  columns must be precomputed in the rollup SQL:** Bench's query layer only
  supports `count/sum/avg/min/max` and cannot compute percentiles on the fly, so
  p50/p95/p99 are stored columns the Bench tools then read as plain measures.

Both carry an explicit org column (`org_id`, declared via `orgColumn: 'org_id'`
in the registry entry) so they are tenant-isolated and do not repeat the
`bench:daily_task_throughput` mistake. Registration is concrete work, not just an
allowlist line: append two `BenchDataSource` literals to the `DATA_SOURCES` array
in `apps/bench-api/src/lib/data-source-registry.ts`; add a migration under
`infra/postgres/migrations/` that creates the rollups (as materialized views,
mirroring `0035_bench_tables.sql`); register each MV as a row in the
`bench_materialized_views` table with `refresh_cron = '*/5 * * * *'`; and add a
UNIQUE index per MV so concurrent refresh works (cf. `0126`). Do **not** add a
new refresh worker: the existing `bench-mv-refresh` BullMQ worker
(`apps/worker/src/worker.ts`) sweeps `bench_materialized_views` every 5 minutes
and picks the rollups up automatically. That refresh is a **full**
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, not incremental; if true incremental
maintenance is required, that is net-new work (implement the rollups as plain
tables maintained by a dedicated `blip-rollup-refresh` worker instead, still
registered in `DATA_SOURCES` with the right `orgColumn`). Dashboards then chart
request volume, error rates, and latency percentiles per build/platform with no
per-entry scanning, via Bench's MCP tools (`bench_query_ad_hoc` against the
`product:entity` keys).

---

## 14. Bin integration (viewer + JSONL freeze)

Reality check on Bin's actual capabilities (verified against `apps/bin-api`):
Bin's structured viewer reads **its own stored assets** via
`GET /bin/api/data/:assetId`, returning `{ columns, rows, total, offset, limit,
schema }`. Filtering and paging happen **in-memory over the parsed asset file**,
support **equality filters only, and there is no sort parameter** — there is no
mechanism today for Bin's viewer to render a *remote* app's live records
endpoint with push-down. Bin also has **no built-in freeze/export feature**.
Given that, the integration is two handoffs, corrected:

- **Live viewing is Blip-native.** The live tail + custom-view viewer is a Blip
  SPA page (Section 17), not a Bin view. Blip does not push its live records into
  Bin's viewer (Bin cannot consume a remote source). Blip owns server-side
  sort/filter/paginate on its own `/blip/api/.../entries/query` endpoint.
- **Freeze to JSONL → a normal Bin asset.** `blip.entry.export` materializes a
  filtered collection as a JSONL asset (one redacted report object per line) by
  encoding rows with `@bigbluebam/structured-data`'s `encodeJsonl` codec and
  creating a new Bin asset through Bin's asset-upload API (Bin stores it on the
  `@bigbluebam/storage` backbone). Because Bin has no freeze primitive, Blip
  drives the creation. The resulting immutable JSONL asset has its own Bin
  retention and is then viewable **read-only** in Bin's structured viewer
  (equality-filter, no sort — fine for a frozen archive), and can be shared or
  handed to any JSONL-consuming tool.

---

## 15. API surface (REST ↔ MCP)

Full parity per the surface-map discipline. `IK` = ingest key. The ingest and WS
rows are intentionally MCP-skipped (`public-inbound` and `realtime/Yjs`).
Authority is the **default** grant, enforced by `requireCan` against the named
`blip.<resource>.<verb>` permission, delegatable per the standard permission
model (not a hard role gate).

| REST endpoint | MCP tool | Authority | Purpose |
|---|---|---|---|
| `POST /blip/ingest/v1` | _(skip: public-inbound)_ | IK | Ingest one/many reports |
| `GET /blip/ws` | _(skip: realtime)_ | member | Live-tail WebSocket |
| `POST /blip/api/apps` | `blip_app_create` | admin | Declare a tracked app |
| `GET /blip/api/apps` | `blip_app_list` | member | List tracked apps |
| `GET /blip/api/apps/:id` | `blip_app_get` | member | App detail + health |
| `PATCH /blip/api/apps/:id` | `blip_app_update` | admin | Edit app config |
| `DELETE /blip/api/apps/:id` | `blip_app_delete` | owner | Delete app + its data (confirm) |
| `POST /blip/api/apps/:id/collection` | `blip_collection_set` | admin | Start/stop collection |
| `POST /blip/api/apps/:id/keys` | `blip_key_create` | admin | Mint a key (token shown once) |
| `GET /blip/api/apps/:id/keys` | `blip_key_list` | admin | List keys (never the secret) |
| `POST /blip/api/keys/:id/suspend` | `blip_key_suspend` | admin | Suspend / resume |
| `POST /blip/api/keys/:id/revoke` | `blip_key_revoke` | admin | Revoke (terminal, confirm) |
| `PATCH /blip/api/keys/:id` | `blip_key_update` | admin | Label / rate-limit override |
| `PUT /blip/api/apps/:id/rate-limit` | `blip_ratelimit_set` | admin | App default rate limit |
| `PUT /blip/api/apps/:id/retention` | `blip_retention_set` | admin | Retention policy (per type) |
| `PUT /blip/api/apps/:id/transform` | `blip_transform_set` | admin | PII transform rules |
| `GET /blip/api/apps/:id/types` | `blip_report_types_list` | member | Observed report types |
| `GET /blip/api/apps/:id/types/:t/fields` | `blip_field_catalog_list` | member | Field catalog for a type |
| `POST /blip/api/apps/:id/types/:t/fields/:f/index` | `blip_field_index` | admin | Promote a field to indexed |
| `POST /blip/api/apps/:id/types/:t/fields/:f/metric` | `blip_field_set_metric` | admin | Mark/unmark a Bench metric |
| `POST /blip/api/apps/:id/entries/query` | `blip_entry_query` | member | Filter/sort/paginate; `format=jsonl` option |
| `POST /blip/api/apps/:id/entries/tail` | `blip_entry_tail` | member | Incremental pull: entries with `seq > cursor` + new max seq |
| `POST /blip/api/apps/:id/entries/purge` | `blip_entry_purge` | admin | Purge a collection (confirm) |
| `POST /blip/api/apps/:id/entries/export` | `blip_entry_export` | member | Freeze a collection to a Bin JSONL asset |
| `GET /blip/api/captures/:ref/url` | `blip_capture_url` | member | Presigned GET URL (short TTL) for a stored capture or its thumbnail |
| `POST /blip/api/apps/:id/timelapse` | `blip_timelapse_create` | member | Compile an ordered, filtered collection of capture-bearing entries into a video |
| `GET /blip/api/timelapse/:id` | `blip_timelapse_get` | member | Job status + the Bin video asset when ready |
| `GET /blip/api/apps/:id/timelapse` | `blip_timelapse_list` | member | List timelapse jobs for an app |
| `POST /blip/api/apps/:id/watches` | `blip_watch_create` | admin | Create a match/window watch |
| `GET /blip/api/apps/:id/watches` | `blip_watch_list` | member | List watches for an app |
| `GET /blip/api/watches/:id` | `blip_watch_get` | member | Watch detail |
| `PATCH /blip/api/watches/:id` | `blip_watch_update` | admin | Edit a watch |
| `POST /blip/api/watches/:id/enabled` | `blip_watch_set_enabled` | admin | Enable / disable |
| `DELETE /blip/api/watches/:id` | `blip_watch_delete` | admin | Delete a watch (confirm) |
| `POST /blip/api/apps/:id/watches/test` | `blip_watch_test` | member | Dry-run a predicate over recent entries |
| `GET /blip/api/watches/:id/history` | `blip_watch_history` | member | Recent firings of a watch |
| `POST /blip/api/views` | `blip_view_create` | member | Create a saved view |
| `GET /blip/api/apps/:id/types/:t/views` | `blip_view_list` | member | List views for a type |
| `PATCH /blip/api/views/:id` | `blip_view_update` | member (owner/admin to edit org-shared) | Edit a view |
| `DELETE /blip/api/views/:id` | `blip_view_delete` | member (owner/admin) | Delete a view |

Destructive tools (`blip_app_delete`, `blip_key_revoke`, `blip_entry_purge`,
`blip_watch_delete`) use the prevailing two-step confirmation convention: an
inline `confirm_action: boolean` parameter (call with it omitted/false to
preview, then again with `true` to execute), the same pattern as
`bin_asset_archive` — not a delegated call to the central `confirm_action` token
tool (which exists but most destructive tools do not route through). Mark the
matching permission `is_destructive` / `requires_confirmation` in the manifest.
All `blip_*` tools register through `register-tool.ts` (which auto-applies the
PolicyGate) and obey the `blip.*` `agent_policies` allowlist and kill-switch;
because MCP tools are app-prefixed snake_case (`blip_app_create`, …), a `blip.*`
allowlist entry matches them via the dotted-alias rule. Wiring the module in is
an explicit edit to `apps/mcp-server/src/server.ts` (add a `registerBlipTools`
import + call, like `registerBinTools`) plus a `BLIP_API_URL` in the MCP
server's `env.ts`. Any agent surfacing entries into a shared surface runs the
`can_access` preflight against the parent `blip.tracked_app` first.

---

## 16. Permissions

Granular `@bigbluebam/permissions` identifiers, `app.resource.verb`, delegatable.
New identifiers are registered **centrally**, not per-app: add the `blip.*` rows
to `docs/permissions-action-manifest.json`, run the codegen
(`scripts/build-permission-codegen.mjs`, which regenerates
`packages/permissions/src/generated/permissions.ts`), and land a delta migration
(`scripts/build-permission-delta.mjs`; the CI guard `check-permission-catalog.mjs`
fails on drift). Builtin member/admin/owner defaults are rows in
`permission_group_defaults` (set via a remediation migration like `0156`), with
member ⊂ admin ⊂ owner. The Fastify guard is `fastify.requireCan('blip.<resource>.<verb>')`;
the Blip api adds the standard `src/plugins/permissions.ts` (satellite apis use
the HTTP variant that dual-reads through apps/api). The identifiers:

```
blip.app.create / read / update / delete
blip.collection.toggle
blip.key.create / suspend / revoke / update
blip.ratelimit.manage
blip.retention.manage
blip.transform.manage
blip.entry.read / purge / export        (entry.read also gates the cursor tail)
blip.field.index / metric
blip.view.create / update / delete / share
blip.watch.create / read / update / delete / enable / test
blip.timelapse.create / read
```

Default builtin-group grants: members get `read`, `entry.read/export` (which
covers `blip_entry_tail`, `blip_capture_url`, and `timelapse.read/create`),
`watch.read/test`, and CRUD on their own views; admins/owners get
app/key/collection/rate-limit/retention/transform/field management, purge, and
full watch management (`create/update/delete/enable`). Org-shared view edits
require the view owner or an admin. Any row is delegatable to a specific member
via an account override, the same as Bin.

---

## 17. Service structure

Following the layered route -> service -> schema pattern, shared-Zod discipline,
snake_case columns and payload fields, numbered idempotent migrations.

- **Internal port:** 4018. nginx routes `/blip/` to the SPA, `/blip/api/*` and
  `/blip/ingest/*` and `/blip/ws` to `blip-api:4018`. The ingest and WS routes
  bypass the session-auth plugin (the ingest route authenticates by ingest key;
  the WS route authenticates the session on upgrade). Add these location blocks to
  the canonical `infra/nginx/nginx-with-site.conf` **and** the second local
  variant `infra/nginx/nginx.conf`, then regenerate the Railway config with
  `node scripts/gen-railway-configs.mjs` (never hand-edit
  `infra/nginx/nginx.railway.conf`). Model the public `/blip/ingest/` block on
  Blank's `/forms/` block (straight proxy_pass, no auth) and the `/blip/ws` block
  on Board's `/board/ws`; bin-api/bay-api are the closest full three-block
  templates (SPA + ws + api).
- **Railway service catalog (mandatory, easy to miss):** register `blip-api` in
  `scripts/deploy/shared/services.mjs` as an `APP_SERVICES` entry (with
  `port: 4018`, `dockerfile`, `healthcheck`, `needs`, and
  `public_paths: ['/blip/api/', '/blip/ingest/', '/blip/ws']`), **and** add
  `/blip/` to the `frontend` entry's `public_paths`. Skipping this 502s the app in
  prod or falls through to the marketing site (`gen-railway-configs.mjs` reads this
  catalog to emit both `railway/*.json` and the Railway nginx routes). Also add
  `BLIP_API_URL` to the MCP server (`apps/mcp-server/src/env.ts`) if Blip exposes
  MCP tools.
- **Route files:** `ingest` (public), `apps`, `keys`, `entries`, `views`,
  `watches`, `transforms`, `retention`, `fields`, `captures`, `timelapse`,
  `rollups`, `ws`, `settings`.
- **Schema modules:** `blip-tracked-apps`, `blip-ingest-keys`, `blip-entries`,
  `blip-field-catalog`, `blip-saved-views`, `blip-watches`, `blip-watch-events`,
  `blip-transforms`, `blip-retention-policies`, `blip-timelapse-jobs`,
  `bbb-refs`, `index`.
- **Worker jobs (registered in the single file `apps/worker/src/worker.ts`,
  which already runs ~50 BullMQ handlers):** `blip-ingest` (drain + capture
  offload + catalog upsert + batch insert), `blip-partition-provision` (provision
  upcoming monthly partitions; first job of its kind — port the banter-api
  `partition-manager.ts` helpers), `blip-retention-sweep` (partition drops +
  ranged deletes + paired image GC), `blip-watch-eval` (window-watch threshold
  evaluation tick, default every 30s), `blip-field-index` (concurrent
  expression-index creation), `blip-export-jsonl` (freeze to Bin), `blip-timelapse`
  (ffmpeg video assembly). Each is a `new Worker<…>('queue-name', handler, …)` plus
  a `recordWorkerError` on failure; scheduled jobs add an `upsertJobScheduler`
  cron (e.g. `'*/2 * * * *'` for the sweep). **Rollup refresh is NOT a Blip worker
  job:** reuse the existing `bench-mv-refresh` worker by registering the rollup MVs
  in `bench_materialized_views` (Section 13). **Image deps, corrected:** ffmpeg is
  **already installed in the worker image** (`apps/worker/Dockerfile`, added for
  the existing `bin-transcode` job), so `blip-timelapse` needs no Dockerfile
  change; `sharp`, however, is **not** currently a worker dependency (it lives in
  board-api/bureau-api) and **must be added to `apps/worker/package.json`** for
  capture thumbnailing.
- **Realtime:** Redis pub/sub for tail fan-out; the WS gateway lives in
  blip-api. Match-watch evaluation and window-watch counters run on the ingest
  edge; the `blip-watch-eval` worker evaluates window thresholds.
- **Storage:** capture images and compiled videos use `@bigbluebam/storage`
  (the Bin backbone); no Blip-local object store. Use it the way bin-api does
  today — through the single bootstrap S3/MinIO driver
  (`createBootstrapDriver`). The per-org `media` binding is designed but **not
  yet implemented** (bin-api leaves `binding_id` null and writes through the one
  bootstrap driver), so Blip should follow suit rather than assume a binding
  resolver exists.
- **Frontend SPA pages:** app list, app detail (health/keys/collection),
  key management (which surfaces the client integration snippets inline at key
  creation, with the live ingest URL + token interpolated — Section 18.3), a
  dedicated **Client setup / quickstart** page (the C#/Python/curl snippets with a
  placeholder token), transform editor, retention/rate-limit settings, the report
  type browser, the live viewer (custom view + tail, with an inline capture strip
  and a "Compile to video" action), saved-view management, watch management
  (create/test/enable, firing history), timelapse jobs, and the Bin-viewer
  handoff.

---

## 18. Client integration examples

The two clients most relevant here: a Unity/C# client (the obvious path for
instrumenting a Unity app such as Frndo) and a Python client. Both just POST
JSON to the ingest endpoint with the key header; nothing about the client is
special.

These snippets are a **v1 deliverable that must be surfaced inside the app**, not
buried in an external doc — the moment a developer mints an ingest key is exactly
the moment they need the wiring code, so the app puts the code in front of them
then. The two code blocks below are the canonical source; Section 18.3 specifies
where they are reproduced (in-app Help Center + key-creation screen + the per-app
docs) and how they stay in sync.

### 18.1 Unity / C#

```csharp
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
    /// <remarks>
    /// The ingest key is embedded in the shipped binary and is therefore
    /// low-trust: it can only append entries to its one tracked app. Rotate by
    /// shipping a new key and revoking the old one in Blip.
    /// </remarks>
    public sealed class BlipClient : IDisposable
    {
        private readonly HttpClient _http;
        private readonly Uri _ingestUri;

        /// <summary>Creates a client bound to one ingest endpoint and key.</summary>
        /// <param name="ingestUrl">Full ingest URL, e.g. https://host/blip/ingest/v1.</param>
        /// <param name="ingestKey">The <c>blip_&lt;key_id&gt;_&lt;secret&gt;</c> token.</param>
        public BlipClient(string ingestUrl, string ingestKey)
        {
            _ingestUri = new Uri(ingestUrl);
            _http = new HttpClient();
            // The key travels on every request; never logged client-side.
            _http.DefaultRequestHeaders.Add("X-Blip-Key", ingestKey);
        }

        /// <summary>
        /// Sends a single report. The <paramref name="fields"/> map is serialized
        /// as-is; <c>report_type</c> is injected and must not be supplied twice.
        /// </summary>
        /// <param name="reportType">The report type bucket (required).</param>
        /// <param name="fields">Arbitrary report fields (may be null).</param>
        /// <returns>True if Blip accepted the report (HTTP 202).</returns>
        public async Task<bool> ReportAsync(string reportType, IDictionary<string, object> fields = null)
        {
            // Compose the payload; report_type is the one mandatory key.
            var payload = fields is null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(fields);
            payload["report_type"] = reportType;

            var json = JsonSerializer.Serialize(payload);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");

            // 202 == accepted (queued + tailed), not durably stored. Fire and forget
            // semantics are appropriate for telemetry; we surface only hard failures.
            var resp = await _http.PostAsync(_ingestUri, content).ConfigureAwait(false);
            return resp.StatusCode == System.Net.HttpStatusCode.Accepted;
        }

        /// <summary>Releases the underlying HTTP client.</summary>
        public void Dispose() => _http.Dispose();
    }
}
```

### 18.2 Python

```python
"""Minimal Blip telemetry client.

Sends JSON reports to a Blip ingest endpoint. The only mandatory field in a
report is ``report_type``; everything else is free-form and discovered
server-side. The ingest key is low-trust (it can only append to its one
tracked app), so it is safe to embed in distributed clients and is rotated by
minting a new key and revoking the old one in Blip.
"""

from __future__ import annotations

from typing import Any

import requests


class BlipClient:
    """A thin client around a single Blip ingest endpoint and key.

    Args:
        ingest_url: Full ingest URL, e.g. ``https://host/blip/ingest/v1``.
        ingest_key: The ``blip_<key_id>_<secret>`` token.
        timeout: Per-request timeout in seconds.
    """

    def __init__(self, ingest_url: str, ingest_key: str, timeout: float = 5.0) -> None:
        self._url = ingest_url
        self._timeout = timeout
        self._session = requests.Session()
        # The key travels on every request; it is never logged.
        self._session.headers["X-Blip-Key"] = ingest_key

    def report(self, report_type: str, **fields: Any) -> bool:
        """Send a single report.

        Args:
            report_type: The report-type bucket (required, non-empty).
            **fields: Arbitrary report fields. ``report_type`` is injected and
                must not be passed here.

        Returns:
            True if Blip accepted the report (HTTP 202), else False.
        """
        payload = dict(fields)
        payload["report_type"] = report_type  # the one mandatory key
        resp = self._session.post(self._url, json=payload, timeout=self._timeout)
        # 202 == accepted (queued + tailed), not durably stored.
        return resp.status_code == 202

    def report_batch(self, reports: list[dict[str, Any]]) -> bool:
        """Send many reports in one request.

        Each element must contain a non-empty ``report_type``. Malformed
        elements are dropped server-side and reported in the response counts;
        a partially valid batch is still accepted.

        Args:
            reports: A list of report objects.

        Returns:
            True if the batch request was accepted (HTTP 202), else False.
        """
        resp = self._session.post(self._url, json=reports, timeout=self._timeout)
        return resp.status_code == 202
```

### 18.3 Where these snippets live (in-app + docs) — a v1 requirement

The C#, Python, and a third **raw `curl` / HTTP** snippet (the universal fallback,
already shown in Section 4.3) are reproduced in three places, all at launch:

1. **In-app, at the point of need (primary).** On the **key-management screen**,
   the moment a key is minted the app shows the one-time token *and*, directly
   beneath it, the ready-to-paste client snippet with the live ingest URL and the
   just-minted token already interpolated (e.g. `new BlipClient("https://…/blip/ingest/v1", "blip_…")`).
   This mirrors two existing patterns to copy rather than invent:
   - the show-once token panel `RevealOnceSecret`
     (`apps/frontend/src/components/people/reveal-once-secret.tsx` — mono `<code>`
     block + a `navigator.clipboard.writeText` Copy button with a 2s "Copied"
     flip), used on the Bam Access > API-keys create flow; and
   - the live-URL interpolation in Blank's `PublishResultDialog`
     (`apps/blank/src/pages/form-builder.tsx`), which splices `window.location.origin`
     into the copied value.
   There is **no** suite-wide language-tabs/`CopyButton` component today, so the
   C#/Python/curl tabbed snippet block is a small new Blip component; cite
   `RevealOnceSecret` as the visual + copy-idiom precedent. A dedicated **Client
   setup / quickstart** SPA page (Section 17) hosts the same three snippets with a
   placeholder token for users who arrive before minting a key.
2. **In-app Help Center (the "help file").** The snippets are embedded in
   `docs/apps/blip/help.md` (e.g. under a `## Client integration` section). The
   Help Center fetches `help.md` and renders it through `packages/ui/markdown.ts`
   → `help-center.tsx`, which **does** render fenced ```` ``` ```` blocks as styled
   monospace code, so they appear in the in-app "(?)" Help Center verbatim.
   **Caveat:** the markdown renderer applies no syntax highlighting and does **not**
   strip the language tag after the opening fence, so a ```` ```csharp ```` fence
   would print the literal word `csharp` as the first code line — use **bare
   ```` ``` ```` fences** (no language identifier) in `help.md`. The help-index
   build (`scripts/help/build-help-index.mjs`) preserves fenced content, so the
   snippets are also searchable; re-run `pnpm help:index` after editing.
3. **Long-form docs (`guide.md`) + marketing/printed manual.** The full quickstart
   (the same three snippets plus narrative) lives under `## Getting Started` /
   `## Walkthrough` in `docs/apps/blip/guide.md` and flows into the marketing site
   and the printed manual via the standard docs pipeline (Section 22).

Single-source discipline: this design document's Section 18 code is the source of
truth; the in-app snippet component, `help.md`, and `guide.md` reproduce it. When
the client contract changes, all four update in the same change (the same rule as
the surface map and the capture recipes).

---

## 19. Non-goals (this pass)

- No client-side SDK packaging/distribution beyond the reference snippets above.
- No arbitrary user code in watches. Watch conditions are declarative predicates
  and aggregates only (no custom scripts on the ingest path), which is what keeps
  edge evaluation cheap and safe. Richer logic lives in the Bolt rule that reacts
  to the emitted event, not in Blip.
- No tracing/span correlation model (parent/child spans). Profiling here is flat
  `elapsed_ms` per report; a span tree is a separate, larger design.
- No constant video/screen streaming. Captures are sparse stills attached to
  reports (Section 23); a timelapse is assembled from those stills on request,
  not from a live frame feed.
- No pixel-level image redaction (blur, OCR-and-mask). The privacy lever for
  captures is keep-or-drop at the attachment level via the transform (Section 9).
- No image transcoding beyond JPEG validation and thumbnailing. Clients send
  high-quality JPEG; Blip stores it as received.
- No sampling on the durable store (only the live view samples under
  backpressure; watch evaluation always sees every entry).
- No cross-app entity surfacing of individual entries (entries gate through
  their tracked app; they are not first-class linkable entities).

---

## 20. Defaults summary (resolved)

Assigned values, baked into the sections above. Tuning any of these is a
settings/migration change, not a redesign.

- **`level` is an enforced enum:** `debug < info < warn < error < fatal`.
  Out-of-vocab values are kept in `payload.level` but leave the promoted column
  null (Section 6.1). Document the five canonical values for every new report.
- **Tail backfill on connect:** the view's `page_size`, default 100, capped at
  500 (Section 8.2).
- **Rollup refresh cadence:** periodic, every 5 minutes (Sections 13, 17).
- **Default retention:** 14-day app-wide default seeded on app creation;
  unbounded only if a policy explicitly removes the age limit (Section 11.2).
- **Ingest key cache TTL:** 60 seconds with pub/sub invalidation on mutation
  (Sections 4.1, 10).
- **Watch cooldown:** 60s default per watch (`0` = fire every match); window-watch
  evaluation tick every 30s (Section 12).
- **Captures:** reserved key `screen_captures` (list of base64 JPEG); offloaded to
  Bin on write, refs in the row (Section 23). Caps: 4 MB capture-report body,
  2 MB per image, 8 images per report. Timelapse default frame duration 0.5s
  (Sections 11.1, 23).

Other defaults established in the body: rate-limit body cap 256 KB, batch cap
500 entries/request (Section 11.1); entries and watches gate through their
`tracked_app` for `can_access` (Sections 2, 12.1); destructive tools route
through `confirm_action` (Section 15).

---

## 21. Seed data (the Gilligan dataset)

Blip ships demo data as a new seeder in the themed `scripts/seed-gilligan/`
harness (`pnpm seed:gilligan` -> `scripts/seed-gilligan/run-all.mjs`), not as a
one-off. The harness bootstraps the `Gilligan Travel Ltd` org
(`gilligan-travel-ltd`) and the seven castaway users at fixed UUIDs, mints a
`read_write` platform key per castaway into the `GKEYS` map, and runs each
seeder inside the `api` container via
`docker compose exec -T -e GKEYS=... api node - < <file>` so it reaches the
internal app hosts and `DATABASE_URL`. Blip's seeder follows that contract
exactly: find-or-create, fixed UUIDs, idempotent re-runs.

### 21.1 New file and ordering

- **File:** `scripts/seed-gilligan/blip.mjs`, registered in `run-all.mjs`'s
  dependency-ordered `PHASES` list (it becomes the 31st seeder; the harness
  currently runs **30**, not 28 — the repo's own inline "28 seeders" comments are
  stale).
- **Order:** run it **after** `bolt.mjs` and `banter.mjs`. Blip's seeded watches
  emit `entry.matched` / `window.breached`, and the point of seeding them is to
  show the reactive loop landing in a real Banter channel via a seeded Bolt rule,
  so those targets must already exist.
- **Theme:** the castaways run a rescue effort, so the Professor built a mobile
  app and Blip tracks it. Owner of the seeded tracked apps is the Professor's
  user; Skipper (owner) and Howell (admin) can see everything.

### 21.2 What it seeds (in-theme, realistic)

- **Tracked apps (fixed UUIDs):** "Rescue Beacon (iOS)" and "Rescue Beacon
  (Android)" under `gilligan-travel-ltd`, collection enabled, 14-day default
  retention, a seeded PII transform (drops a `payload:castaway_gps` field and
  truncates `payload:radio_log`), a default rate limit.
- **Ingest keys (Blip's own, not GKEYS):** per app, one `active`, one
  `suspended`, one `revoked`, so every key state renders in the UI. These are
  `blip_`-prefixed ingest keys minted through `POST /blip/api/apps/:id/keys`
  using the Professor's `GKEYS` platform key to authenticate the management call.
  They are distinct from the harness's `gilligan-seed` platform keys (which are
  revoked under People -> Access; Blip ingest keys are managed inside Blip).
- **Report types (discovered from the seeded entries):** `crash`, `fn_timing`,
  `app_log`, `net_request`, and a themed `sos_ping`. Enough variety to populate
  the field catalog and the Bench rollups.
- **Saved views (the v1 feature, exercised):** "Errors only" on `app_log`
  (`level in [error, fatal]`), "Slow frames" on `fn_timing`
  (`elapsed_ms gte 16`), plus each type's auto default view.
- **Watches (reactive features, exercised):** a match watch `slow-frame`
  (`elapsed_ms gt 500`, cooldown 60s) and a window watch `error-spike`
  (count of `level in [error, fatal]` over 60s > 20). A seeded Bolt rule on
  `entry.matched` filtered to `slow-frame` posts to a castaway Banter channel,
  demonstrating the §12.3 loop end to end in the demo.
- **Entries (the backlog):** a deterministic body of a few thousand reports per
  app, spread across the last 14 days (inside retention), with realistic
  distributions: `elapsed_ms` skewed log-normal, `level` weighted mostly
  `debug`/`info` with a minority of `warn`/`error` and a handful of `crash`
  reports, several `app_version`s and both `platform`s, recurring `session_id`s.

### 21.3 How entries are inserted (the blank.mjs lesson)

`blank.mjs` is marked *soft* because the public form endpoint enforces a
10/hour/form anti-spam cap that the dev rate-limit flag does not relax. Blip's
public ingest endpoint has the same shape (a rate limit, plus accept-then-async
write whose worker timing is nondeterministic), so the seeder does not pour the
backlog through it. Instead:

- **Bulk backlog:** insert the historical entries **directly into `blip_entries`
  via `DATABASE_URL`** (the established pattern — `bond.mjs`, `bin.mjs`, `bay.mjs`
  all open `postgres(process.env.DATABASE_URL)` inside the api container), using a
  fixed-seed RNG and a fixed clock anchor so a wipe-and-reseed reproduces
  byte-identical data. The harness has **no global `_seed` marker convention** —
  its idempotency elsewhere is fixed-UUID + name/slug find-or-create. Entries have
  no natural key, so Blip introduces its own per-row marker `payload._seed =
  'gilligan'` and skips an app whose seeded entries already exist (idempotent at
  app granularity). The `blip_entries` table and its monthly partitions must be
  created by a migration first; ensure the partitions for the seeded date range
  exist, then assign `seq` from the shared sequence.
- **Live-path proof:** send a small number (5 to 10) of reports through the real
  `POST /blip/ingest/v1` with a seeded `active` ingest key, to exercise the
  redact -> tail -> queue -> write path. Mark this step *soft* (like
  `blank.mjs`): if the dev rate limit or worker lag trips it, report
  "partial (expected)" rather than failing the run.
- **Post-seed:** trigger one rollup refresh so the Bench dashboards (§13) show
  data immediately, and leave the watches enabled so the viewer's live tail and
  the reactive demo work on first open.

### 21.4 Where to see it

Sign in at `/b3/login` as a castaway (shared dev password `Castaway2026!`), org
`gilligan-travel-ltd`, and open `/blip`. The smoke checklist
(`docs/guides/seeding-smoke-test.md`) gains Blip rows: the app list, the live
viewer on `fn_timing` with the "Slow frames" view, the watch list with one
firing in its history, and a Bench dashboard over the `blip:metric_rollup`
latency percentiles.

Note for screen capture (Section 22): the `docs-capture` harness logs in with its
own credential defaults (`environment.ts` defaults the cast password to
`E2eTestP@ss123!`), which differs from this seed harness's `Castaway2026!`. Before
capturing, either point the harness at the seeded password
(`SHOTS_ADMIN_PASSWORD` / `SHOTS_MEMBER_PASSWORD=Castaway2026!`) or reset the
cast's password to the capture default (`cli reset-password`), or the capture
login will fail.

---

## 22. Screen capture for new screens

Every Blip screen is captured through the existing declarative `docs-capture`
harness (`@bigbluebam/docs-capture`: `recipe`, `runner`, `manifest`, `seeding`,
`environment`), invoked through the root `docs:generate` pipeline
(`scripts/docs/generate.mjs`), the same path every other app uses. The Blip
capture recipe is a **YAML** file under `packages/docs-capture/recipes/blip/*.yaml`
validated by the Zod `RecipeSchema` / `Recipe` type in `src/recipe.ts` (it
conforms to that type rather than inventing a format). Captures land at
`docs/apps/blip/screenshots/{light,dark}/<NN>-<slug>.png` with a generated
`docs/apps/blip/meta.json` (the bridge step publishes there) — **not**
`docs/images/blip/`, which is not a real path in the pipeline.

### 22.1 The recipe enumerates each new screen

One recipe entry per screen, each declaring its route, the seeded login, the
pre-state it depends on, any interaction steps, the regions to mask, and the
output filename. The screens to capture:

| Screen | Route | Notable pre-state / steps |
|---|---|---|
| App list | `/blip` | Two seeded tracked apps with health badges |
| App detail / health | `/blip/apps/:id` | Collection on, recent-volume sparkline |
| Key management | `/blip/apps/:id` (keys) | Active + suspended + revoked rows visible |
| Client setup / quickstart | client-setup surface | The C#/Python/curl snippets with the ingest URL shown (token masked, per §22.2) |
| Live viewer + custom view | `/blip/apps/:id/types/fn_timing` | Load "Slow frames" view; expand one entry's JSON |
| Saved-view management | views surface | The two seeded views + default |
| Watch management + history | watches surface | `slow-frame` and `error-spike`; one firing in history |
| PII transform editor | transform surface | The seeded drop/truncate rules |
| Retention / rate-limit | settings surface | 14-day policy, seeded caps |
| Report-type browser + field catalog | types surface | Inferred types, the declared `elapsed_ms` metric |
| Bin viewer handoff | Bin structured view of a Blip collection | A frozen JSONL collection rendered in Bin |
| Bench dashboard over rollups | a seeded Bench dashboard | Latency percentiles + volume from `blip:*_rollup` |

### 22.2 Determinism is the whole game

Screenshots that churn on every run are worthless. The Gilligan dataset is
already deterministic (fixed UUIDs, find-or-create, fixed-seed entry RNG, fixed
clock anchor per §21.3), which makes the **data** reproducible. The remaining
volatility is in the UI, and the recipe must neutralize it:

- **Freeze or mask volatile regions:** relative timestamps ("3s ago"), absolute
  `received_at`, and the `seq` column are masked in the capture so diffs are
  stable.
- **Capture the backfill, not the live stream:** the live-tail viewer shot is
  taken against the seeded backlog with live tail paused (the §8.2 backfill
  state), never against an open socket, so the frame is fixed.
- **Pin the viewport and theme** the way the other apps' recipes do.

### 22.3 The discipline (mirrors the surface-map rule)

A Blip screen is not "done" until it has a recipe entry, the same way an endpoint
is not done until it has a row in the REST<->MCP surface map. Adding a screen and
adding its capture entry happen in the same change; a screen with no entry
silently produces no doc image. The `docs:generate` pipeline then regenerates
`docs/apps/blip/screenshots/{light,dark}/` and the per-app docs that embed them.

This is also the prompt to create the standard per-app doc set Blip needs at
launch alongside every other app: `docs/apps/blip/` with the six authored files
`help.md`, `guide.md`, `marketing.md`, `mcp-tools.md`, `_narrative.md`, and
`_marketing_hook.md`, **plus the generated `help-index.json`** (built from
`help.md` by `pnpm help:index`; `pnpm help:check` is the CI staleness gate — both
auto-discover any app dir containing a `help.md`, so no registration is needed for
the help index) and the generated `meta.json` + `screenshots/`. **`help.md` must
include a `## Client integration` section carrying the C#/Python/curl snippets
(bare ```` ``` ```` fences, no language tag — §18.3) so they render in the in-app
Help Center, and `guide.md` must carry the full quickstart; both are reproduced
from this document's Section 18. Marketing-site
wiring is only **partially** automatic: the publish step copies `marketing.md` to
`site/src/content/apps/blip.md` and screenshots to `site/public/screenshots/blip/`
on its own, but Blip must be **manually** added to the hardcoded product catalog
in `site/src/components/sections/product-grid.tsx` (and its "16 apps / sixteen"
count copy bumped) and to the MCP-tool/API catalogs in `site/src/pages/docs.tsx`,
with the captured images referenced from the guide and help content.

---

## 23. Screen-capture attachments and timelapse

This is unrelated to Section 22. Section 22 captures screenshots **of Blip** for
docs; this section is about screenshots **from the tracked app**, sent as part of
a report so they can be inspected next to the rest of the log and, for a run of
image-bearing reports, stitched into a video.

The use case is sparse: a developer attaches a frame or two to a bug report, or
samples the screen once a second through a session. Blip is built for that (a
few stills on some reports), not for streaming constant video, which is an
explicit non-goal (Section 19).

### 23.1 The wire contract

One reserved key, always meaning the same thing: `screen_captures`. Its value is
a **list**, and each element is a base64-encoded **JPEG** (high quality assumed;
no PNG/TIFF). A list rather than a single value so a developer can attach more
than one frame per report.

```json
{
  "report_type": "bug_report",
  "session_id": "a91f",
  "note": "crash on submit",
  "screen_captures": ["<base64 jpeg>", "<base64 jpeg>"]
}
```

Keep it simple and fast for the client: just inline the JPEG bytes. The caps from
Section 11.1 apply (4 MB capture-report body, 2 MB per image, 8 images per
report); over-cap reports are rejected at the edge with a clear reason. Non-JPEG
elements are dropped during the offload and counted, never failing the report.

### 23.2 Storage: offload to Bin, keep refs in the row

Inlining base64 into the `payload` JSONB would wreck the things Section 5 works
to keep fast (row size, GIN index, query payloads, the live socket, retention
bytes). So Blip never stores the base64. On the async worker (Section 4.2,
step 3) each image is decoded, validated, and `put` to object storage through
`@bigbluebam/storage` (the bootstrap S3/MinIO driver, as bin-api uses it — the
per-org `media` binding is not yet implemented), and the inline base64 is
replaced with a ref:

```jsonc
"screen_captures": [
  {
    "object_key": "blip/<tracked_app_id>/<YYYY-MM>/<seq>/0.jpg",
    "thumb_key":  "blip/<tracked_app_id>/<YYYY-MM>/<seq>/0.thumb.jpg",
    "bytes": 184213, "content_type": "image/jpeg",
    "width": 1170, "height": 2532, "sha256": "..."
  }
]
```

- A sharp-generated thumbnail (max 320px long edge) is stored next to each full
  image for fast grids and scrubbing; full image on demand.
- The **`<YYYY-MM>` segment in the key** aligns image objects with the monthly
  entry partition, so a partition drop reclaims its images with one prefix-delete
  (Section 11.2). This is the detail that keeps capture GC as cheap as the
  text-row GC.
- `capture_count` (Section 6) is set from the list length, so "entries with
  screenshots" is an index-backed filter.
- The viewer and agents never receive base64. They get refs and resolve them to
  short-TTL presigned URLs via `blip_capture_url`, the same presign path Bin uses
  for hot media (`driver.presignGet`; Bin's default TTL is the env-configurable
  `PRESIGN_GET_TTL_SECONDS`, 900s/15min — "short" but not seconds).
- **Key convention:** the proposed `blip/<tracked_app_id>/<YYYY-MM>/<seq>/0.jpg`
  works (the driver accepts arbitrary keys), but Bin's own keys are
  `<orgId>/<scope>/...` via `buildStorageKey`. To stay org-prefixed (and so a
  future per-org binding migration is clean), prefer `<orgId>/blip/<tracked_app_id>/<YYYY-MM>/<seq>/0.jpg`.

### 23.3 Viewer display

In the live viewer and in query results, an entry with `capture_count > 0` shows
a thumbnail strip inline next to its other fields (thumbnails lazy-loaded via
presigned GET of `thumb_key`). Clicking a thumbnail opens the full image. In the
JSON detail the value shows as refs, not base64. On the live tail, a freshly
arrived capture shows a "pending" placeholder (the edge stripped the base64 per
Section 4.1, step 10) that resolves to the thumbnail the moment the worker has
stored it, usually within a second given how sparse captures are.

### 23.4 Timelapse compilation

Any filtered, ordered collection of capture-bearing entries can be compiled into
a video. The intent case is a session timelapse: filter to one `session_id`,
order by `seq`, one frame per capture, fixed duration per frame.

`POST /blip/api/apps/:id/timelapse` (`blip_timelapse_create`) takes:

- `filter` (a Section 7.1 predicate; typically `session_id eq ...` and
  `screen_captures is_set`),
- `order` (default `seq asc`),
- `frame_duration_sec` (user-defined per-frame duration; default 0.5),
- `image_selection` (`first` | `all`, default `first`: which images to take from
  an entry that carries more than one),
- `max_dimension` (downscale ceiling; frames are padded to a common canvas so
  mixed orientations assemble cleanly).

It enqueues a `blip-timelapse` worker job (tracked in `blip_timelapse_jobs` with
status `queued|running|ready|failed`). The worker pulls the ordered full images,
runs **ffmpeg** to assemble an MP4 at the chosen frame duration, and stores the
result as an ordinary Bin asset with `content_type: video/mp4` (Bin has no
distinct "video asset" type — a video-MIME asset automatically picks up Bin's
transcode proxy/poster columns), sets the job to `ready` with the asset ref, and
emits `timelapse.ready` (Section 12.2). The caller polls `blip_timelapse_get` or
reacts to the event. **ffmpeg is already in the worker image** (installed for the
existing `bin-transcode` job — no Dockerfile change); the net-new worker
dependency for this feature is **sharp** (capture thumbnailing, Section 23.2),
which must be added to `apps/worker/package.json`.

```ts
/**
 * A timelapse compilation job. The compiled video is a Bin asset (videoAssetRef)
 * with its own retention, independent of entry purges (Section 11.2). Params are
 * captured so a job is reproducible and auditable.
 */
export const blipTimelapseJobs = pgTable('blip_timelapse_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  trackedAppId: uuid('tracked_app_id').notNull(),
  reportType: text('report_type'),
  params: jsonb('params').notNull(),            // { filter, order, frame_duration_sec, image_selection, max_dimension }
  status: text('status').notNull().default('queued'), // queued|running|ready|failed
  frameCount: integer('frame_count'),
  videoAssetRef: jsonb('video_asset_ref'),      // Bin ref to the compiled MP4 when ready
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
});
```

### 23.5 Seed coverage

The Gilligan seeder (Section 21) attaches a short run of JPEG frames to a handful
of `bug_report` / `sos_ping` entries under one `session_id` on the iOS tracked
app, so the viewer's capture strip and a one-click session timelapse both have
real content to show on first open.
