# Bin Master Design Document — Decisions Log

A running, reviewable log of the autonomous decisions made while consolidating
the two Bin design docs into `Bin_Master_Design_Document.md`, reconciling them
against the as-built BigBlueBam suite, and (later) reconciling Bay against the
result. Each entry: the decision, the alternatives considered, and why. Skim this
after the fact; if you disagree with any call, we adjust that one without redoing
the rest.

Conventions: **AB-N** = as-built reconciliation (the source doc assumed something
that differs from the shipped suite). **D-N** = a design judgment call where the
sources were silent, vague, or in tension. **BAY-N** = a decision driven by the
Bay reconciliation phase.

---

## Phase 1 — consolidating the two Bin docs into the master

### Framing

The two source docs describe **one app, three layers**, not two products:

1. `Bin_Storage_Providers_Design_Document.md` — the **storage substrate**
   (pluggable storage drivers, provider config, backups, provider migration, the
   write-freeze) plus the **DAM library** (assets, folders, immutable versions,
   upload, AV scan, presigned serving).
2. `BigBlueBam_Bin_Structured_Data_Editor_Design_Document.md` — a **render mode
   inside Bin** for editing structured-data assets (CSV/TSV/JSON/JSONL/YAML) as a
   grid or tree, collaboratively over Yjs, committing new immutable versions.

The master presents Bin as the single `bin-api` (:4016) + `/bin/` SPA app that
owns all three layers. This framing is itself the first decision (**D-1**).

---

### D-1 — Bin is one app with three layers (substrate, DAM, structured editor)

- **Decision:** Consolidate both docs under one app. The structured-data editor
  is a content-type-gated render mode of a `bin.asset`, not a separate service or
  port (the editor doc already asserts this).
- **Why:** Both target `bin-api` :4016 and `/bin/`. The editor needs the DAM's
  asset/version/scan/permission layers to exist; the substrate needs a UI to be
  useful. One app, one nav entry, one permission catalog.

### AB-1 — Port is 4016 (not the providers doc's original "~4010")

- **Decision:** `bin-api` internal port **4016**.
- **Why:** As-built the registry is packed 4000–4015 (api 4000 … blueprint 4015,
  with bureau-api also on container-internal 4015 in its own netns). 4016 is the
  next free value. (This correction was already applied to the providers doc
  earlier; it carries into the master.) Bay, when it lands, takes **4017** (see
  BAY-1).

### AB-2 — `@bigbluebam/storage` is net-new and consolidates triplicated code

- **Decision:** The storage-driver package the providers doc proposes does not
  exist yet; building it must also absorb the three existing ad-hoc MinIO clients
  (`apps/api/src/services/upload.service.ts`,
  `apps/blank-api/src/lib/storage.ts`, `apps/worker/src/utils/storage.ts`) so
  there is one driver implementation, not a fourth.
- **Why:** Leaving the triplication in place would mean Bin's "universal storage
  backbone" claim is false on day one. Build order step 1 repoints the existing
  `attachment_*` substrate at the package to validate the abstraction with no
  behaviour change.

### AB-3 — Bin ships the suite's first real AV scanner

- **Decision:** `attachments.scan_status` is a placeholder today (nothing ever
  writes `clean`; no scanner job exists). Bin introduces the actual AV worker job
  (ClamAV by default) and, once it exists, the pre-existing task-attachment
  placeholder is wired to the same job. The `bin_assets` scan flow adds a
  `skipped` value (additive CHECK change) for deployments that disable scanning.
- **Why:** The editor and DAM both gate presigned reads on `scan_status='clean'`;
  without a scanner every read would be withheld. Bin is the right owner.

### AB-4 — Permissions via `requireCan` + `bin.*` catalog, delegatable; no `requireOrgRole`

- **Decision:** All Bin authority is expressed as `bin.<resource>.<verb>`
  permission ids gated by the `requireCan` middleware (`@bigbluebam/permissions`),
  defaulting to Owner/Admin builtin groups but delegatable to an individual via an
  `account_permissions` override. Platform-scope actions (installation defaults,
  instance-wide migration/restore) are flagged `requires_superuser`. There is no
  `requireOrgRole` helper in the codebase.
- **Why:** Matches the shipped permission model. The providers doc's original
  `requireOrgRole('admin')` gating was fictional; this was corrected earlier and
  is the master's model throughout. New `bin.*` ids ship via a
  `NNNN_permissions_seed_actions_delta_*.sql` migration + codegen, and the scanner
  for `ws.routes.ts`-style false positives is already handled by the catalog
  generator.

### AB-5 — Backup baseline facts corrected from the providers doc

- **Decision:** Carry the corrected baseline into the master: the as-built backup
  floor is `docs/guides/operations.md`'s `backup.sh` (6-hourly `pg_dump` + direct
  MinIO volume copy + Redis `BGSAVE`), Redis **is** backed up today, RTO is
  "< 1h Tier 1–2 / < 15m Tier 3+", and there is **no** `verify-integrity` CLI
  command (Bin ships the post-restore consistency check as net-new). "Bin drops
  Redis from its backups" is a new deliberate choice, not an inheritance.
- **Why:** These were factual errors in the original providers doc, already
  corrected in the reconciliation; the master states them accurately.

### AB-6 — `avatar_url`/`/files/` serving precedent and the relaxed-path lesson

- **Decision:** Presigned reads are served through nginx → `api:4000/files/`
  (auth-gated), not direct nginx→MinIO. Stored references that point at served
  objects use root-relative paths (`/files/…`, and `/avatars/…` for the bundled
  defaults), so any Bin URL stored in a column must accept a relative path, not a
  strict absolute URL — the same lesson the avatar feature hit with
  `z.string().url()`.
- **Why:** Matches the just-shipped storage/serving conventions; avoids a repeat
  of the avatar validation bug.

### D-2 — Structured editor stays on the hand-rolled Yjs WS handler; forces `@bigbluebam/collab-client` extraction

- **Decision:** The editor's collaboration clones `brief-api/src/ws/handler.ts`
  (y-websocket native path + y-protocols + Redis fan-out + debounced bytea
  persistence) and is the second consumer that triggers extracting the
  design-only `@bigbluebam/collab-client` shared package. No Hocuspocus.
- **Why:** Consistent with the full-suite synchronous-editing decision (stay on
  the hand-rolled handler) and Brief's repaired wiring; reuses the seed-once and
  awareness lessons rather than re-deriving them.

### D-3 — Canonical artifact = immutable Bin version; Yjs is a buffer

- **Decision:** Unlike Brief (where `yjs_state` *is* the doc), the structured
  editor treats the immutable, format-bearing Bin asset version as canonical and
  the Y.Doc as a live buffer (`bin_data_sessions.yjs_state`). Only an explicit or
  autosaved **commit** serializes the Y.Doc back to the native format and mints a
  new immutable version.
- **Why:** Round-trip fidelity, free diff/review across versions, and reuse of the
  immutable-version model the DAM and Bay both depend on. (Adopts the editor
  doc's core model verbatim; recorded here because it's load-bearing for Bay.)

### D-4 — Resolve the editor's open decisions (OD-1…OD-8) to v1 defaults

The editor doc left eight open decisions. To keep the master implementable I take
the recommended option for each and record them; revisit any individually:

- **OD-1 commit cadence →** explicit "Save version" + debounced buffer flush on
  Brief's 30s pattern.
- **OD-2 large-file ceiling →** load whole-file into one Y.Doc below ~50k rows /
  ~25 MB; above it, open paged + read-only with a "check out a slice" editable
  path. Threshold is config, tuned by profiling.
- **OD-3 branches/drafts →** one session per (asset, branch); `branch` column
  reserved, defaulting `main`. Named branches deferred (additive later).
- **OD-4 diff granularity →** cell-level diff always; row-level summary with
  drill-down for very wide tables.
- **OD-5 Y.Text promotion →** `longtext`-typed fields only get character-merge
  `Y.Text`; everything else is an LWW scalar register; manual per-column promote.
- **OD-6 CSV codec →** extract a shared CSV codec into
  `@bigbluebam/structured-data` and migrate Blank/Bench/Bearing onto it over time
  (papaparse). Not a hard blocker for v1 Bin, but the codec lives in the package
  from the start.
- **OD-7 uniformity threshold →** start at 0.7 union-key coverage to pick grid vs
  tree; tunable.
- **OD-8 commit-time validation →** block on invalid cells by default; per-org /
  per-asset "warn-and-record-exception" policy available.

### D-5 — Provider/backup engine is phased behind the DAM + editor MVP

- **Decision:** The master keeps the full provider-driver / backup / migration /
  write-freeze design, but sequences it after the DAM library + structured editor
  MVP in the build order. v1 ships on the bundled MinIO `local`/`s3` driver; the
  `rclone` consumer-drive backup path, scheduled backups, provider migration, and
  the disaster-recovery wizard are later phases.
- **Why:** The editor and Bay need the asset/version/scan/storage-driver
  primitives first; the multi-provider/backup machinery is independently valuable
  but not on the critical path to a usable Bin. Keeps the first shippable slice
  small and the highest-risk editor round-trip work front-loaded.

### D-6 — Net-new dependencies kept minimal and MIT/permissive

- **Decision:** Accept the editor doc's dependency delta — TanStack Table v8 +
  TanStack Virtual (headless grid, avoids AG Grid's enterprise-licensed editing),
  `yaml` (eemeli, comment-preserving round-trip), `json-schema-to-zod` +
  `zod-to-json-schema` (schema bridges), `papaparse` (CSV) — plus, for the
  substrate, the S3 client already in use (MinIO) and `rclone` as a worker binary
  (not an npm dep) for the consumer-drive backup path.
- **Why:** Protects the MIT-everywhere positioning; everything is permissive.

---

## Phase 2 — reconciling Bay against the final Bin

**Finding:** Bay works as a review layer *on top of* Bin's primitives with **no
substantive Bin rework**. Bin's storage driver, immutable-version model, AV scan,
presigned serving, and entity-links are exactly the building blocks Bay needs; Bin
kept them app-agnostic on purpose (§12). The reconciliation is therefore mostly
updating the Bay doc to consume Bin, plus four small decisions (one of which — the
trusted-derived-artifact allowance — is a tiny Bin master addition).

### BAY-1 — Bay's API port is 4017

- **Decision:** `bay-api` internal port **4017**.
- **Why:** As-built the registry is full 4000–4015; Bin takes 4016, so Bay is the
  next free value. The Bay doc's provisional ":4005 / maybe :4004" predates the
  current registry and is stale.

### BAY-2 — Worker-derived artifacts are trusted; they bypass user-upload AV scan

- **Decision:** Bin's scan gate applies to user-supplied uploads. Trusted-worker
  derivatives of an already-scanned source (Bay transcode proxies, thumbnails,
  filmstrips, waveforms) are written `scan_status='clean'` (or `'skipped'`) and
  not re-queued. Added to Bin master §9.3.
- **Why:** Without this Bay's own generated proxies would be withheld by the
  `clean`-gated presigned read, and we'd be scanning bytes the platform itself
  produced. The original upload is still scanned; derivatives inherit the verdict.
- **Alternative rejected:** scanning every derived object — wasteful and would
  stall Bay playback on the platform's own output.

### BAY-3 — Bay stores all bytes through `@bigbluebam/storage`, not a private bucket

- **Decision:** Bay puts/gets originals and proxies through the shared storage
  driver against the org's active **media** binding, under a
  `bay/<asset>/<version>/role.<ext>` keyspace. A Bay upload's canonical original is
  registered as a `bin.asset` version and linked from `bay_asset_versions` via
  `entity_links`; Bay retains its media-specific metadata (fps_num/den,
  color_space, loudness_lufs, proxy roles) and its review tables.
- **Why:** This is the whole point of "Bay relies on Bin's tech stack" — one
  storage abstraction, one provider/binding/migration/backup story, no parallel
  MinIO client. Bin requires no Bay-specific code; Bay is a driver consumer like
  the federated attachment substrate.
- **Alternative rejected:** Bay keeping its own `bay/`-prefixed MinIO storage (the
  original Bay doc's model) — that reimplements DAM storage and bypasses the org's
  provider config, backups, and migration.

### BAY-4 — Bay federates from day one (Bin ships first)

- **Decision:** Remove the Bay doc's "Bay owns its own storage until Bin ships,
  then federates" sequencing. The build order is Bin then Bay, so Bay federates
  immediately.
- **Why:** Matches the actual implementation order in this effort.

**Net Bin rework:** one paragraph added to Bin master §9.3 (trusted derived
artifacts) and the §12 "Consumed by Bay" section expanded with BAY-1…4. No schema
or interface change to Bin was required — confirmation that the master's
app-agnostic storage/version/scan design was sufficient.

---

## Phase 3 — implementation reconciliations

### D-7 — Proxied bytes are the default upload/serve path; presigned is an opt-in optimization

- **Decision:** bin-api ships **both** an in-service proxied path
  (`POST /assets/:id/upload` multipart in, `GET /assets/:id/raw` stream out) and
  the presigned path (`POST /assets/:id/versions` → presigned PUT,
  `GET /assets/:id/download` → presigned GET). The **proxied path is the default**
  the SPA uses; presigned is reserved for deployments that configure a
  browser-reachable provider endpoint.
- **Why:** The master §9.2 leaned on presigned-to-browser ("bytes skip the API").
  That requires the storage provider to be reachable from the browser. The
  bundled local MinIO sits on the internal docker network as
  `S3_ENDPOINT=http://minio:9000` with **no host/public mapping**, and SigV4
  signs the host, so a presigned URL cannot simply be host-swapped. The as-built
  suite already solved this for every other attachment surface by proxying bytes
  through the service (`apps/api` `POST /upload` + `GET /files/*` streaming from
  MinIO server-side) — see AB-2/AB-6. Bin matches that precedent so it works on
  the bare stack and in any deployment without exposing the object store.
- **Discovered by:** a live smoke test — the presigned PUT to `minio:9000`
  returned `000` (host unreachable), which would have surfaced only in the
  browser otherwise. "Check and test, don't assume."
- **Future:** add an optional `S3_PUBLIC_ENDPOINT` (browser-reachable) used only
  for presign host generation, plus an nginx/public mapping, to re-enable the
  bytes-skip-the-API optimization for large media. Tracked as a follow-up; not
  required for v1 correctness.

### AV-scan — autonomous serving gate via a worker sweep

- **Decision:** The §9.3 scanner ships as a per-minute worker sweep
  (`bin-av-scan`) that claims `pending` bin_assets, fetches the active version
  bytes, scans, and writes the verdict. Modes: `eicar` (default — dependency-free
  signature scan that flags the EICAR test string and otherwise marks `clean`),
  `clamav` (clamd INSTREAM), `off` (mark `skipped`).
- **Why:** Mirrors the as-built `blank-file-process` sweep, needs no new
  bin-api→queue wiring or `bullmq` dependency in bin-api, and is resilient to a
  missed enqueue. The `eicar` default keeps the pipeline autonomous on a bare
  stack (no clamd container) while still making the infected path testable with
  synthetic data.
- **Trade-off:** up to ~1 minute upload→servable latency. Acceptable for v1; a
  targeted on-completion enqueue can reduce it later.

### D-8 — Structured-editor commits are trusted; marked clean immediately

- **Decision:** When the structured editor commits an edit it mints a new
  immutable version through the normal proxied upload path (which resets
  `scan_status='pending'`), then immediately flips it to `clean`.
- **Why:** A structured commit is a **server-side re-serialization** of data that
  was already scanned clean, plus user cell edits — not an opaque external upload.
  Structured text (CSV/JSON/YAML) is not executable, so the AV gate adds latency
  (read-after-write would 409 until the next sweep) without materially reducing
  risk. Same "trusted derived artifact" principle as BAY-2.
- **Scope:** applies only to the structured-editor commit path, not to raw
  asset uploads (those still go pending → scanned).

### D-9 — Tree-shaped assets are editable via path patches

- **Decision:** JSON/YAML (tree-shaped) assets are editable through
  `PATCH /data/:assetId/tree` with `{ patches: [{ path, value }] }`, where `path`
  is an array like `["passengers", 2, "vip"]`. The server walks the path, coerces
  the incoming string to the existing leaf's type (number/boolean), and commits a
  new immutable version (same path as record patch/append). The SPA wires both
  scalar leaves and the embedded arrays-of-similar-dicts grids to this endpoint.
- **Why:** Editing is the feature users value most; limiting it to record-shaped
  assets left JSON/YAML read-only. Path patching keeps the immutable-version model
  (D-3) without a per-keystroke version.
- **Follow-up:** structural edits (add/remove keys, reorder, retype) and an MCP
  `bin_data_patch_tree` tool for agent parity are not yet built.

### Permissions — bin MCP tools are resource-first; need explicit overrides

- **Reconciliation:** `scripts/generate-permission-manifest.mjs` infers permission
  ids from MCP tool names with a **verb-first** convention
  (`<app>_<verb>_<resource>`, e.g. `blueprint_read_nodes`). Bin's tools follow the
  master's **resource-first** names (`bin_asset_create`, `bin_data_read`), which
  the inference mis-derives. Each bin tool is therefore registered in
  `EXPLICIT_TOOL_OVERRIDES` mapping to the same permission id its REST endpoint
  uses, so the tool and endpoint share one permission and the catalog stays
  consistent. (Caught as drift after the MCP layer landed; fixed with delta 0209.)
