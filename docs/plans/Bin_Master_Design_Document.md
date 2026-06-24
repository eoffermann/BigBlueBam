# Bin — Master Design Document

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Status:** Design (consolidated). Supersedes and ingests the prior
`Bin_Storage_Providers_Design_Document.md` and
`BigBlueBam_Bin_Structured_Data_Editor_Design_Document.md`.
**Decisions log:** `Bin_Master_Design_Document_Decisions.md` (read alongside).

> This is the authoritative Bin spec. It has been reconciled against the
> as-built BigBlueBam suite (ports, permissions, storage, scan status, backup
> baseline, collaboration transport) and against Bay's requirements, since Bay
> relies on Bin's storage + version + scan primitives. Where a source doc
> assumed something the shipped suite does differently, the master states the
> as-built reality and the decisions log records the correction.

---

## 1. What Bin is

Bin is BigBlueBam's **storage backbone and asset workspace**. One app, three
layers:

1. **Storage substrate.** A pluggable storage-driver abstraction (S3-compatible,
   consumer drives via rclone for backups, bundled MinIO/local), per-org and
   per-platform provider configuration, scheduled backups, safe reversible
   provider migration with a write-freeze, and disaster recovery a non-engineer
   can actually perform.
2. **DAM library.** The universal media interface for the whole suite: upload,
   browse, version, scan, and serve assets and folders, backed by whatever
   provider the org configured. Every other app's attachments resolve through
   this so they transparently land on the org's chosen storage.
3. **Structured-data editor.** A content-type-gated render mode that opens a
   structured-data asset (CSV, TSV, JSON, JSONL/NDJSON, YAML) as an editable
   **grid** or **tree** instead of a download link — collaboratively over the
   suite's Yjs transport, with each saved edit committing a new immutable version
   so review and diff come for free.

The throughline: **the file is canonical, agents are first-class, and storage is
the org's to own.** A data asset's parsed-table abstraction backs both the human
editor and the agent MCP tools (one service, two clients); enterprises point Bin
at infrastructure they already run; a small team gets a "back up to my Google
Drive" wizard with no infra knowledge.

Bin is the single `bin-api` service (internal port **4016**) plus the `/bin/` SPA.
It owns no second port and no second datastore. It shares the platform
PostgreSQL, Redis, MinIO/S3, and the BullMQ `worker`.

---

## 2. Suite positioning

| Product | Owns | Does not own |
|---|---|---|
| **Bin** (this doc) | Canonical storage + provider config + backups/migration; the asset library (foldering, immutable versions, scan, search); the structured-data editor as an asset render mode | Prose co-writing; time-based/visual media review; generic doc sign-off; new-input intake |
| **Brief** (docs) | Rich-text CRDT prose; can *embed* a Bin data asset as a live or snapshot node | The data itself, its schema, its versions |
| **Bay** (media review) | Version-stacked frame/timecode/region/viewpoint annotation and per-reviewer decisions on time-based/visual media | Long-term cataloging and canonical storage (defers to Bin); tabular/document-structured data |
| **Badge** (proofing) | Generic sign-off on a static deliverable | Inline cell/path-anchored data comments; media review |
| **Blank** (forms) | Capturing *new* structured input from respondents | Editing an *existing* data file in place |

Boundaries worth stating because they blur:

- **Brief.** Brief edits prose; Bin edits typed records. They compose: a data
  asset embeds in a Brief doc (§10.5), a Brief doc can reference an asset, neither
  reimplements the other. Forcing structured data into a Brief doc type was
  rejected — prose-CRDT and typed-record-CRDT are different models.
- **Blank.** Blank is intake (build a form, collect submissions from non-members);
  Bin is editing a file that already exists. Blank's 22-type field palette is
  prior art for the widget vocabulary (§10.3); Bin lifts the type→widget mapping
  rather than inventing a parallel one.
- **Bay.** Bay anchors annotations to frames, timecodes, pixel regions, camera
  viewpoints — tabular data has none of those. Bay's review layer sits **on top of
  Bin storage** (§12): a Bay version's canonical bits are a Bin asset version; Bay
  owns the review/annotation/decision/proxy layer. Bin does not do media review.
- **Badge.** Generic non-media sign-off stays in Badge. Where an agent proposes a
  final approval a human must ratify, that routes through the unified
  `/b3/approvals` proposal surface (agent-conventions §6), not a Bin-private
  channel.

---

## 3. Where this lives in the codebase

| Concern | Home | Why |
|---|---|---|
| Storage driver abstraction (s3 / rclone / local), capability probe, secrets decryption | `packages/storage` (`@bigbluebam/storage`) | Shared by `api`, `bin-api`, `worker`, and (later) `bay-api`. **One** driver implementation — consolidates the three ad-hoc MinIO clients in `apps/api/.../upload.service.ts`, `apps/blank-api/.../storage.ts`, `apps/worker/.../storage.ts` (AB-2). |
| Provider config, bindings, backup engine, provider migration, the write-freeze preHandler | `apps/api` (+ `worker`) | Platform infrastructure beside `visibility`, `superuser`, `attachments`, platform settings. The freeze must hook the shared auth/write middleware, which lives in `apps/api`. |
| DAM: asset/folder CRUD, upload, version commit, scan flow, the structured-data session/editor service, MCP-backing routes | `apps/bin-api` | Bin is an app like Board or Bond. Registers `bin.*` entity types. The structured-editor WS handler is cloned from `brief-api`'s. |
| Codecs, shape detection, schema inference, Zod bridges, CRDT mapping | `packages/structured-data` (`@bigbluebam/structured-data`) | Pure, shared by `bin-api`, `worker`, and the SPA. One implementation of "file → Y.Doc → file." |
| Media browser, asset/folder UI, the grid + tree editor (TanStack Table + Radix), Yjs binding | `/bin/` SPA route (`apps/bin`) | Bin is an app; the editor is one of its asset render modes. |
| Live data-asset embed node | `apps/brief` | A Tiptap node referencing a `bin.asset` (§10.5). |
| AV scan job (net-new, AB-3), rclone-backed backup/migration jobs, large-file parse offload, version materialization | `worker` | New BullMQ queues; reuses the worker's storage driver. |
| Shared CRDT client lifecycle (provider/reconnect/cursor-hash/awareness/seed-once) | `packages/collab-client` (`@bigbluebam/collab-client`) | Extracted here as its second consumer after Brief (D-2); design-only until now. |

`bin-api` takes the next free internal port **4016** (registry is full 4000–4015
as-built; AB-1). nginx routes `/bin/` to the SPA, `/bin/api/*` to the service, and
`/bin/ws` (the y-websocket native path shape) to the service, matching the other
apps. nginx already exposes `/files/` (proxied to `api:4000/files/`, auth-gated,
presigned reads); Bin does not remove that — presigned reads (§9.3) supersede it
for new media and `/files/` remains the proxied-read fallback (AB-6).

Two attachment layers already exist and Bin reconciles with both rather than
replacing them:

- the original task-scoped `attachments` table (`task_id`, `uploader_id`,
  `filename`, `content_type`, `size_bytes`, `storage_key`, `thumbnail_key`, plus
  the `scan_status`/`scan_signature`/`scanned_at`/`scan_error` columns from
  migration 0131), and
- the federated cross-app substrate (`GET /v1/attachments/:id`, `GET /v1/attachments`,
  the `attachment_get` / `attachment_list` / `attachment_meta` tools).

The federated substrate is the seam: its tools become thin consumers of
`@bigbluebam/storage`, so every app's attachments transparently land on whatever
provider the org configured — the "Bin as universal storage backbone" outcome.
The task-scoped table keeps working unchanged; its `storage_key` resolves through
the active media binding like any other asset.

---

## 4. Storage substrate — driver abstraction

Almost every provider worth supporting speaks the S3 API. The ones that do not
(consumer drives) are exactly the ones that should only ever be backup targets.
Three driver kinds, not N integrations:

| Driver kind | Covers | Hot media | Backup target |
|---|---|---|---|
| `s3` | AWS S3 (+ tiers), Cloudflare R2, GCS (interop), Backblaze B2, Wasabi, DigitalOcean Spaces, Storj, MinIO, Ceph/Garage, any S3-compatible endpoint | Yes | Yes |
| `rclone` | Google Drive, Dropbox, OneDrive, Box, 70+ other backends | No (refused at bind time) | Yes |
| `local` | Bundled MinIO / on-disk default | Yes | Yes (dev/small) |

`rclone` runs as a binary in the `worker` image (and an optional `rclone rcd`
sidecar for streaming progress). The api and bin-api never stream user bytes
through rclone; it is invoked only by backup and migration jobs. This keeps the
hot path on presigned S3 URLs and consumer-drive quirks off the request path.

### 4.1 Driver interface (`packages/storage/src/driver.ts`)

```ts
/** Static description of what a driver instance can do. Bin uses these flags to
 * decide which roles a provider may be bound to (a provider that cannot serve
 * presigned GETs may not back a hot-media binding) and which backup strategies
 * are available (manifest-diff incremental needs listObjects + a stable etag). */
export interface StorageCapabilities {
  supportsPresignedGet: boolean;     // serve user reads via a time-limited signed URL
  supportsPresignedPut: boolean;     // accept direct browser uploads (offloads the API)
  supportsMultipart: boolean;        // server-side multipart for large media
  supportsServerSideCopy: boolean;   // fast same-provider migration
  supportsVersioning: boolean;       // per-object versioning (affects incremental + rollback)
  integrityToken: 'etag' | 'crc32c' | 'md5' | 'none'; // stable per-object integrity token
  canServeHotMedia: boolean;         // may be bound to a live-media role at all
}

export interface PutResult { key: string; size: number; integrity: string; }
export interface ObjectStat { key: string; size: number; integrity: string; modifiedAt: Date; }

/** A configured, ready-to-use backend. One instance per storage_providers row.
 * Construction is cheap; credentials are injected already-decrypted by the
 * provider factory, never read from the row directly. */
export interface StorageDriver {
  readonly kind: 's3' | 'rclone' | 'local';
  readonly capabilities: StorageCapabilities;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  put(key: string, body: NodeJS.ReadableStream, opts?: { contentType?: string }): Promise<PutResult>;
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  presignGet?(key: string, ttlSeconds: number): Promise<string>;
  presignPut?(key: string, ttlSeconds: number, opts?: { contentType?: string }): Promise<string>;
  list(prefix: string, cursor?: string): Promise<{ objects: ObjectStat[]; cursor?: string }>;
  copyTo?(destKey: string, sourceKey: string): Promise<void>;
}
```

The factory resolves a `storage_providers` row to a driver, decrypting secrets
through the secrets service (§8.2) at construction time only. **Consolidation
(AB-2):** building this package also replaces `upload.service.ts`,
`apps/blank-api/.../storage.ts`, and `apps/worker/.../storage.ts` with the
`local`/`s3` driver, then repoints the `attachment_*` substrate at it (no
behaviour change) to validate the abstraction.

---

## 5. Storage substrate — data model

All substrate tables are Drizzle-defined in `apps/api/src/db/schema/storage.ts`,
numbered idempotent migrations, snake_case columns, `pnpm lint:migrations` +
`pnpm db:check` clean. New migrations follow the current tip (≈0205+).

### 5.1 Providers

```ts
export const storageProviders = pgTable('storage_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = platform
  name: text('name').notNull(),                  // "Prod S3 (us-east-1)"
  kind: text('kind').notNull(),                  // 's3' | 'rclone' | 'local'  (CHECK)
  config: jsonb('config').notNull(),             // non-secret: endpoint, region, bucket, rclone remote, base path; per-kind Zod
  capabilitiesCache: jsonb('capabilities_cache'),// last probed capabilities
  status: text('status').notNull().default('unverified'), // unverified|healthy|degraded|error
  lastCheckedAt: timestamp('last_checked_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({ uniqName: uniqueIndex('storage_providers_scope_name').on(t.orgId, t.name) }));
```

### 5.2 Secrets (separate, envelope-encrypted, never returned)

```ts
export const storageProviderSecrets = pgTable('storage_provider_secrets', {
  providerId: uuid('provider_id').primaryKey().references(() => storageProviders.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),      // AES-256-GCM of the secret bundle
  iv: text('iv').notNull(),
  keyId: text('key_id').notNull(),               // which master/KMS key wrapped this
  fingerprint: text('fingerprint').notNull(),    // sha256(access key id), shown in UI
  displayHint: text('display_hint'),             // "AKIA…7Q3F"
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

### 5.3 Bindings (what each provider is used for)

```ts
/** Binds a provider to a role. Decoupling assets from providers via a binding
 * pointer (not the provider id on every asset row) makes migration a single
 * repoint, not a mass row rewrite. role: 'media' | 'backup' (exactly one active each). */
export const storageBindings = pgTable('storage_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = platform default
  role: text('role').notNull(),                  // 'media' | 'backup'
  providerId: uuid('provider_id').notNull().references(() => storageProviders.id),
  isActive: boolean('is_active').notNull().default(true),
  supersededBy: uuid('superseded_by'),           // old binding kept as read fallback during/after migration
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  oneActive: uniqueIndex('storage_bindings_one_active').on(t.orgId, t.role).where(sql`is_active = true`),
}));
```

### 5.4 Asset reference shape

Bin assets (and the federated attachment rows) store `(binding_id, object_key,
size, integrity, content_type)`. They do **not** store the provider id directly.
Reads resolve `binding_id → active provider`, falling back to `superseded_by` if
the object is not yet confirmed present on the new provider. This is the mechanism
that makes cutover atomic and rollback free.

### 5.5 Backup policy and runs

```ts
export const backupPolicies = pgTable('backup_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = platform
  enabled: boolean('enabled').notNull().default(true),
  targetBindingId: uuid('target_binding_id').notNull().references(() => storageBindings.id),
  incrementalCron: text('incremental_cron'),     // '0 * * * *'  (hourly)  null = none
  fullCron: text('full_cron'),                    // '0 3 * * 0'  (Sun 03:00) null = none
  retainDays: integer('retain_days').notNull().default(30),
  minFullCount: integer('min_full_count').notNull().default(2), // never prune below this many fulls
  includeDatabase: boolean('include_database').notNull().default(true),
  includeObjects: boolean('include_objects').notNull().default(true),
  verifyMode: text('verify_mode').notNull().default('thorough'), // 'thorough' | 'quick' (§7.5)
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').notNull().references(() => backupPolicies.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),                  // 'incremental' | 'full'
  state: text('state').notNull().default('queued'), // queued|running|verifying|completed|failed
  basePrefix: text('base_prefix').notNull(),     // destination prefix, timestamped
  manifestKey: text('manifest_key'),             // object listing + checksums for this run
  parentRunId: uuid('parent_run_id'),            // incremental chain pointer
  objectsCopied: integer('objects_copied').default(0),
  bytesCopied: bigint('bytes_copied', { mode: 'number' }).default(0),
  dbDumpKey: text('db_dump_key'),
  schemaHead: text('schema_head'),               // last applied migration id at capture (§7.7)
  appVersion: text('app_version'),
  pgMajor: integer('pg_major'),
  scope: text('scope').notNull().default('org'), // 'org' (logical export) | 'platform' (full cluster)
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  error: text('error'),
});
```

### 5.6 Migration jobs

```ts
export const storageMigrations = pgTable('storage_migrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }), // null = platform-wide
  role: text('role').notNull(),                  // 'media' | 'backup'
  fromProviderId: uuid('from_provider_id').notNull().references(() => storageProviders.id),
  toProviderId: uuid('to_provider_id').notNull().references(() => storageProviders.id),
  state: text('state').notNull().default('scheduled'),
  scheduledFor: timestamp('scheduled_for').notNull(),
  retainSourceDays: integer('retain_source_days').notNull().default(7),
  verifyMode: text('verify_mode').notNull().default('thorough'),
  objectsTotal: integer('objects_total').default(0),
  objectsDone: integer('objects_done').default(0),
  bytesTotal: bigint('bytes_total', { mode: 'number' }).default(0),
  bytesDone: bigint('bytes_done', { mode: 'number' }).default(0),
  startedAt: timestamp('started_at'),
  frozenAt: timestamp('frozen_at'),
  cutoverAt: timestamp('cutover_at'),
  finishedAt: timestamp('finished_at'),
  cancelRequestedBy: uuid('cancel_requested_by'),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

---

## 6. Storage substrate — provider config access control

Reuses the granular permission system (`@bigbluebam/permissions`); no
`requireOrgRole` helper (AB-4). Authority is delegatable: each `bin.*` permission
defaults to the builtin Owner/Admin groups but an Owner/Admin can grant any one of
them to an individual via an `account_permissions` override (the People > Access
UI), without promoting that member's role.

| Surface | Default authority | Enforcement |
|---|---|---|
| View/create/edit org providers, bindings, backup policy | org Admin / Owner | `requireCan('bin.provider.*' / 'bin.binding.list' / 'bin.backup_policy.set')` on `/bin/api/storage/*` |
| Set/repoint a binding | org Owner (destructive, confirm) | `requireCan('bin.binding.set')` + `confirm_action` |
| Trigger an org migration | org Owner (Admin may schedule, Owner confirms) | `requireCan('bin.migration.schedule')` + confirm token |
| Platform providers, installation-defaults panel, instance-wide migration/restore | SuperUser | `requires_superuser` ids under `/superuser/storage/*` |
| Migration monitor + cancel | org Admin/Owner (org), SuperUser (platform) | freeze-exempt (§11.4) |

The existing `checkRankAbove(callerRole, targetRole, …)` rule still governs
actions on another principal's work (e.g. an Admin cannot cancel a migration an
Owner scheduled unless they are an Owner or SuperUser). SuperUser storage actions
write to `superuser_audit_log`; org-scoped actions write to `activity_log` with
`storage.*` action strings.

### 6.1 SuperUser installation-defaults panel

A `/superuser/storage/*` panel (not visible to org admins) sets platform-level
rows (`org_id = null`) that new orgs inherit and that constrain what orgs may do:
default media + backup providers, a default backup-policy template, an allowlist
of permitted driver kinds (a managed SaaS may require `s3`; an air-gapped deploy
may permit only `local`/on-prem MinIO), a "may orgs configure their own providers
or are they locked to platform storage" toggle, and a toggle to **allow
Convenience recovery mode for S3-style backup destinations** (§7.4, default ON
with a plain-language warning rather than forbidden — small teams on S3 should not
be forced into a scheme they cannot operate, producing backups they cannot
restore). These defaults read through the same provider/binding resolution path,
so a new org with no rows of its own transparently uses the platform binding.

---

## 7. Storage substrate — backups, restore, disaster recovery

This backup engine supersedes the as-built floor (`docs/guides/operations.md`'s
`backup.sh`: a 6-hourly `pg_dump` to S3, a direct MinIO data-volume copy — not a
tar — and a Redis `BGSAVE`/RDB copy, with MinIO cross-region replication; the core
design doc additionally specifies Redis AOF + hourly RDB, 7-day retention). That
floor stays valid for a bare deployment; Bin replaces it with scheduled,
policy-driven, provider-targeted backups a non-engineer can configure and, more
importantly, restore (AB-5).

Two deliberate choices, called out because they diverge from the floor:

- **Redis is not included in Bin backups** (cache/sessions/queues are
  reconstructable; session loss on restore is acceptable). This is a new decision,
  not an inheritance — the current `backup.sh` *does* snapshot Redis.
- **Post-restore consistency check.** There is no `node dist/cli.js
  verify-integrity` command today (the CLI's real subcommands are create-admin,
  create-user, grant/revoke-superuser, create-api-key, create-service-account,
  reset-password, list-orgs, revoke-*). Bin ships this check as net-new — a
  `node dist/cli.js restore` companion consistency pass — run automatically at the
  end of a full restore and offered after a selective one.

RPO/RTO targets from the core design doc are a ceiling, not a floor: RPO < 6h
(hourly incrementals push it well below), RTO < 1h for Tier 1–2 and < 15m for
Tier 3+ with orchestration.

### 7.1 What a backup contains

- **Database.** Platform backup = whole cluster `pg_dump` (custom, compressed),
  including `schema_migrations`. Org backup = an org-scoped logical export (the
  rows for that `org_id` across every table, in restorable order, plus the schema
  head it was taken at) — not a whole-cluster dump (which would leak tenants and
  bloat every org's backup). The DB is captured whole each run (small,
  consistency-critical); WAL archiving (§7.4) is the DB-level incremental path.
- **Objects.** The media provider's contents, per the run type.
- **Manifest.** Per-run object listing with sizes + integrity tokens, parent-run
  pointer, captured schema head, app version, and PostgreSQL major version
  (§7.7 uses these to decide whether/how to restore).

### 7.2 Incremental vs full

- **Incremental** copies only objects new/changed since the parent run (manifest
  diff by integrity token / version / mtime) plus the DB dump. Cheap, frequent.
- **Full / consolidated** copies the complete object set into a fresh
  self-contained prefix, collapsing the incremental chain into one restore point,
  then prunes. This is the run you can restore from without walking a chain.

Independent cadences (e.g. hourly incremental + weekly full) are BullMQ
repeatable jobs keyed off the policy's cron fields.

### 7.3 Retention

`retainDays` is the duration; `minFullCount` is a floor (never prune below N
fulls). Pruning runs after each full and removes incrementals orphaned by a pruned
full. An optional GFS preset (daily/weekly/monthly tiers) can be offered in the
wizard.

### 7.4 Enterprise PITR (optional)

When Postgres is self-managed, an operator can enable WAL archiving to the backup
binding; Bin then treats the logical dump as the periodic base and archived WAL as
the incremental DB stream, enabling restore to an arbitrary moment. Advanced
toggle, off by default, surfaced only when the deployment supports it.

### 7.5 Restore (system still running)

The single most important design point: most real restore needs are surgical, not
catastrophic. "I deleted a folder, get it back" must not freeze anyone; "roll the
whole org back to Sunday" is rare, dangerous, and must be hard to do by accident.
Two distinct modes, chosen deliberately at the entry point (Bin > Backups &
Recovery > Restore; platform restores under `/superuser/storage`). Both open on a
restore timeline (reverse-chronological list built from `backup_runs` + manifests:
"Sun 03:00 full, 12.4 GB", "Mon 09:00 incremental").

- **Selective restore (routine, no freeze).** Pick a restore point, browse/search
  the snapshot read-only, select what to bring back, choose **Restore alongside
  current** (default, into a "Restored YYYY-MM-DD" location; nothing existing
  touched) or **Replace current versions**, confirm. Runs as a background job: it
  re-inserts the chosen rows (or clears their soft-delete) and copies the
  underlying objects from the backup destination into the org's **current** active
  media provider, so restored assets point at today's binding. The rest of the org
  keeps working.
- **Full / point-in-time restore (rollback, freeze-gated).** For corruption, a bad
  bulk op, ransomware. Destructive: pick a restore point (or a precise moment via
  PITR), choose scope (this org, or SuperUser-only the whole instance), read the
  plain consequence ("This replaces all data in [org] with its state at [time]…
  ~340 items created since then will be removed"), keep the **safety snapshot**
  (default ON — back up current state first so the rollback is itself reversible),
  type-to-confirm the org/instance name + Owner authority + `confirm_action`. Bin
  acquires the scope-matched write freeze (§11), takes the safety snapshot,
  restores the DB dump (replaying WAL to the chosen moment for PITR),
  **forward-migrates to the current schema head** (§7.7), restores objects,
  verifies, cuts over, releases the freeze, invalidates sessions. Mechanically
  this is migration run in reverse against a backup source, with the same
  cancel-before-cutover safety.

Verification depth is the operator's explicit choice wherever a copy is verified
(backups, migrations, restores): **Thorough** (default — reads back every object's
integrity token; one byte differs anywhere, it's caught; cost grows with store
size) vs **Quick** (a random sample plus every object's size; a targeted
single-object corruption can slip but a systemic failure is still caught; cost
roughly flat). The control is `verify_mode`; `Quick` maps to the existing
`BACKUP_VERIFY_SAMPLE` percentage. Every restore is logged with actor, mode,
scope, restore point, item count, outcome; a full restore also records the
safety-snapshot id.

### 7.6 Disaster recovery (bare install, no surviving system)

The case to get right for a 2–3 person team with no engineers who set Bin up once,
never thought about it again, and just lost the machine. A backup is only as good
as your ability to read it after everything is gone, and two secrets normally live
in the dead machine's `.env`: the credentials to reach the backup destination, and
the master key (`BIN_SECRETS_KEY`) that decrypts the provider credentials inside
the DB dump. Recovery must anchor to something the team still has.

- **OAuth/consumer backup (novice path, e.g. Google Drive):** the anchor is their
  Google login. On a fresh install they click "Sign in with Google," which
  re-grants access to the same Drive where the backups are. No stored credential
  survives the machine, and none needs to.
- **S3-style backup (enterprise path):** the anchor is the **Recovery Kit** — a
  one-page artifact (download, print, emailed to all org owners) with the backup
  destination coordinates and, in Protected mode, the Recovery Code, shown once
  with a forced "I have saved this."

Every backup destination carries a `recovery/` area the backup engine writes and
refreshes: `recovery/keybundle.enc` (the master key + a plaintext-relative copy of
the active provider coordinates, AES-256-GCM under an Argon2id-derived recovery
secret) and `recovery/manifest.json` (unencrypted, human-readable: which restore
points exist, when, format version, recovery security level — what the first-run
screen reads). One explicit setup choice governs the recovery secret:

| Recovery security level | What unlocks the keybundle | What the team must keep | Default for |
|---|---|---|---|
| **Convenience** | A key stored beside the keybundle (`recovery/autounlock.key`); possession of the destination suffices | Nothing beyond access to the backup destination (their Google login, or the Recovery Kit for S3) | Novice / small team |
| **Protected** | A key derived from a human-held Recovery Code; the destination alone is not enough | The Recovery Code, off-system | Enterprise / regulated |

Convenience mode is the honest small-team tradeoff: anyone who can read your backup
destination can restore your data — usually exactly the property a team wants when
that destination is their own private Drive, and it means no separate secret to
lose. For OAuth destinations Convenience is always offered (re-auth is the anchor);
for S3 it is offered by default but disablable platform-wide by a SuperUser (§6.1).

First-run restore is a wizard, not a CLI runbook: a fresh `docker compose up`
detects an empty DB and shows **Start fresh** or **Restore from a backup**. Novice
path: choose Google Drive → "Sign in with Google" → Bin scans for the backup
folder, reads `recovery/manifest.json`, shows what it found ("Latest full: Sunday
3:00 AM; most recent change captured 47 minutes ago"), auto-unlocks from
`autounlock.key`, one confirmation, restores DB → forward-migrates →
re-wraps recovered provider credentials under the new install's freshly generated
master key → restores objects → done (sessions not restored, by design). Enterprise
path is identical except entering the destination from the Recovery Kit and the
Recovery Code. A headless `node dist/cli.js restore --from-backup` exists for
operators who prefer it; the wizard is the supported path for this audience.

Recovery stays trustworthy over time: recovery status on the Bin dashboard ("Last
backup 2h ago. Recovery: Convenience via Google Drive, reachable"), regeneration
of the keybundle/kit when contents change (with owners re-prompted to save in
Protected mode), and an optional periodic recovery-check job that verifies the
keybundle and latest restore point are present and readable. The one honest limit:
in Protected mode, losing both the destination access and the Recovery Code means
the data is unrecoverable by design (that is what encryption means); the
mitigations (email the kit to every owner, force a save, allow escrow with a
teammate, nag when status degrades) are all there, and Convenience mode removes
this failure entirely for teams who accept its tradeoff.

### 7.7 Restoring across schema versions

Governing principle: **backups are forward-restorable, never backward.**
BigBlueBam migrations are forward-only, numbered, append-only, idempotent, and
checksum-guarded (the runner aborts on a checksum mismatch of an already-applied
migration) — precisely the regime that makes old backups restorable.

- **Whole-database restore just works.** A `pg_dump` includes `schema_migrations`,
  so a year-old dump carries its own record of which migrations had been applied.
  Restore the dump into an empty DB (now at the old head, e.g. `0247`), run the
  standard migrate runner (applies `0248…` current head in order), and the old
  data is carried forward exactly as a continuously-running install would have
  arrived. Two ordering rules the engine must enforce: **do not auto-migrate
  before restoring** (a normal boot would create a fresh current-schema DB the old
  dump collides with — the wizard brings services up in a restore mode that defers
  migration), and **refuse newer-than-code dumps** (a dump whose head exceeds the
  image's highest migration has no forward path; refuse with "upgrade to ≥ version
  X, then restore").
- **Org-level restore across versions is harder** and uses **stage-and-forward**:
  spin up a throwaway scratch DB, restore the org export into it, run the migrate
  runner against it (bringing that copy to current schema), then do the logical
  org-row copy from scratch into the live instance (delete the org's current rows
  inside the freeze, insert the now-current rows), tear the scratch DB down. This
  avoids per-table backward-compat shims and never exposes the live DB to
  old-shaped rows. A fast path skips staging when the backup's head already equals
  the live head (the common recent-backup case).
- **Preconditions:** migration history is append-only and immutable (checksum
  mismatch is a hard error, not a silent skip); data-transform migrations are safe
  against genuinely old shapes (tested with old-shape fixtures), not just
  last-week's data; migrations are idempotent. A CI check should restore the oldest
  still-supported backup format into a scratch DB and forward-migrate to head every
  release, so "can we still restore a year-old backup" is answered by the build.

---

## 8. Storage substrate — provider migration and the write freeze

A migration copies everything from the source provider to the destination, then
atomically repoints the binding. While it runs, writes are frozen so nothing is
written to the source after the manifest is taken. Migration is always
**copy-then-cutover, never move**; the source is retained as a read fallback for
`retainSourceDays`, making rollback free.

### 8.1 State machine

```
[*] → scheduled → freezing → copying → verifying → cutover → completed → [*]
        │            (queues paused)      │           (binding repointed,
        │                                 │            freeze released)
        └→ cancelled                  failed → rolledback → [*]
  copying → cancelled (source untouched, dest GC'd)
```

Sequence: **scheduled** (pick from/to + time + source retention; destination must
be `healthy`; affected users get advance notice) → **freezing** (set the freeze
flag, pause write-bearing BullMQ queues except migration, drain in-flight) →
**copying** (enumerate source into a manifest; `copyTo` when same family, else
stream via worker S3-to-S3 or rclone cross-family; parallel, resumable, progress
written continuously) → **verifying** (compare size + integrity token per object,
or a sampled subset) → **cutover** (one transaction: new binding active, old
binding `superseded_by`, old left readable; asset rows untouched — they point at
the binding) → **release** (clear freeze, resume queues) → **teardown** (later,
optional, reversible: after `retainSourceDays` delete source objects and
deactivate the old binding).

### 8.2 The freeze mechanism

Source of truth is a row; the hot check is Redis so it costs nothing per request.

- **Org freeze:** `organizations.write_frozen_until` + `write_freeze_reason` +
  `write_freeze_migration_id` (new additive columns — they do not exist today),
  mirrored to Redis `freeze:org:{orgId}`.
- **Platform freeze:** a `platform_settings` row mirrored to `freeze:platform`.
  (`platform_settings` exists today as a thin singleton — `public_signup_disabled`,
  `helpdesk_signup_disabled`, `updated_*`; these are additive.)

Freeze scope follows operation scope with no exceptions: an org-scoped operation
freezes only that org (`freeze:org:{orgId}`); other tenants keep working. Only a
SuperUser platform op sets `freeze:platform`. The `preHandler` in the shared auth
plugin runs on every non-idempotent route (POST/PATCH/PUT/DELETE): if the caller's
scope is frozen and the route is not on the migration-control allowlist, it
returns **HTTP 423 Locked** with `{ error: 'STORAGE_OPERATION_IN_PROGRESS',
operation, scope, operation_id, eta_seconds, message }`. This one chokepoint
covers: API writes (blocked), MCP write tools (mcp-server proxies to the API so
the 423 propagates; mapped to a friendly tool error), Bolt automations (compile to
MCP tool calls, inherit the 423, fail closed and retry after), and worker jobs
(write-bearing queues paused in the freezing step; the migration queue stays
active). Reads (GET) are never frozen; media GETs resolve through the binding
(source pre-cutover, new provider post-cutover). The freeze fails closed: if the
Redis mirror is unavailable the preHandler falls back to the DB row rather than
assuming "not frozen."

### 8.3 Monitor and cancel

The migration-control allowlist exempts exactly `GET /…/storage/migrations/:id`
(state, progress, ETA, recent log) and `POST /…/storage/migrations/:id/cancel`.
Org migrations gate to that org's Admin/Owner; platform to SuperUser. Everyone
else hitting a write route gets the 423, which the frontend renders as a
full-screen blocking notice with the live ETA (recomputed from `bytesDone /
elapsed`). Cancel before cutover is always safe (source untouched, partial dest
GC'd); after cutover it is a re-point back to the intact old binding, surfaced as
"roll back." User-facing notices: on schedule (banner + notification to affected
users, window + duration), 24h/1h/15m reminders (configurable), the blocking 423
screen during, and a completion/rollback notice after.

---

## 9. DAM library — assets, folders, versions, upload, scan, serving

### 9.1 Assets and folders

```ts
export const binAssets = pgTable('bin_assets', { /* id, org_id, project_id?, folder_id?,
  name, content_type, current_version_id?, binding_id, object_key, size, integrity,
  scan_status, visibility, created_by, created_at, archived_at … */ });
export const binFolders = pgTable('bin_folders', { /* id, org_id, project_id?, parent_id?,
  name, created_by, created_at … */ });
export const binAssetVersions = pgTable('bin_asset_versions', { /* id, asset_id,
  version_number, binding_id, object_key, size, integrity, content_type,
  uploaded_by, created_at … (immutable; monotonic per asset) */ });
```

Assets store `(binding_id, object_key, size, integrity, content_type)` (§5.4) and
a denormalized `current_version_id`. **Versions are immutable** — each upload or
structured-editor commit mints a new `bin_asset_versions` row; you never edit a
version in place. This immutable-version primitive is what Bay (§12) and the
structured editor (§10) both build on.

### 9.2 Upload

```
Client                bin-api                 active media provider
  | request upload      |                            |
  |-------------------->| resolve media binding      |
  |                     | -> provider.presignPut()   |
  |   signed PUT url     |<---------------------------|
  |<--------------------|                            |
  |---- PUT bytes -------------------------------------->|   (browser → provider, bytes skip the API)
  | confirm complete    |                            |
  |-------------------->| stat() verify size/etag    |
  |                     | INSERT bin asset/version   |
  |   asset metadata     |                            |
  |<--------------------|                            |
```

When the active provider lacks `supportsPresignedPut` (rare, never for a hot
binding since rclone is refused there), bin-api falls back to a proxied multipart
upload. Reads are symmetric: `presignGet` for a time-limited URL, proxied stream
only as a fallback.

### 9.3 Upload limits and virus scanning (AB-3)

Bin centralizes the upload safety rules the suite already applies (core design doc
§19): a configurable max object size (currently 25 MB, raised per binding for
media-heavy orgs), content-type validation, and no public bucket (presigned URLs
only). Scanning reuses the federated attachment substrate's existing
`scan_status` *field* but must supply the scanner that field has always
anticipated — **today nothing writes `clean`; no AV worker job exists**. Bin is
the suite's first scanner, not a consumer of an existing one. `bin_assets` carries
`scan_status` (`pending` | `clean` | `infected` | `error`, plus a new `skipped`
value via an additive CHECK change). Flow:

1. On upload completion bin-api inserts the asset with `scan_status='pending'` and
   enqueues a **net-new** AV scan job (ClamAV by default, a cloud scanner where
   configured). Once it exists, the pre-existing `attachments.scan_status`
   placeholder is wired to the same job.
2. A `pending` asset is uploadable and listable but not served by a presigned GET;
   reads return "scan in progress" so an unscanned object is never handed to
   another user.
3. `clean` → readable. `infected` → quarantined (kept for audit, never served;
   uploader + org admins notified). `error` → unreadable, retried, never served on
   a failed scan.
4. `skipped` covers deployments that disable scanning (explicit SuperUser choice);
   behaves like `clean` for serving, visible in audit as unscanned.

Backups copy assets regardless of scan status, but the manifest records the
status, so a restore never silently promotes a quarantined object to readable.

### 9.4 Entity-type registration (required gate)

Per agent conventions, every entity an agent can cite or surface is registered in
`SUPPORTED_ENTITY_TYPES` (`apps/api/src/services/visibility.service.ts`) with a
`can_access` branch; unregistered types deny by default. The dotted `app.entity`
naming and the `documentVisibilityPredicate` ↔ preflight lockstep are the
established pattern.

| entity_type | physical table | visibility rule (summary) |
|---|---|---|
| `bin.asset` | `bin_assets` | org-scoped; if `project_id` set, project member or org admin/owner; if `visibility='Private'`, owner only |
| `bin.folder` | `bin_folders` | inherits parent folder/project rule; org admin/owner override |
| `bin.data_comment` | `bin_data_comments` | inherits the parent `bin.asset` predicate exactly |

The preflight predicate mirrors Bin's own access predicate, kept in lockstep
exactly as `documentVisibilityPredicate` and the brief preflight are. Until these
branches exist, agents must not surface Bin entities. `agent-conventions.md` §2
gets these rows.

---

## 10. Structured-data editor

A content-type-gated render mode of a `bin.asset`. When someone opens a CSV/TSV/
JSON/JSONL/YAML file in Bin, Bin renders an editable grid or tree derived from the
parsed structure and a resolved schema, instead of a download link or raw blob.
It owns no new service: codecs/shape/inference/CRDT-mapping live in
`@bigbluebam/structured-data`; session lifecycle, the WS handler, version commit,
and validation live in `bin-api`; the UI is a `/bin/` render mode.

### 10.1 Two shapes, not five formats

Format is a serialization detail. Parsed structure collapses into a **record**
shape (a grid) or a **tree** shape (a collapsible key/value editor). The detector
runs on the parsed value, not the extension:

| Detected structure | Shape | Render |
|---|---|---|
| CSV / TSV | record (always) | Grid |
| JSONL / NDJSON | record (each line a row) | Grid |
| JSON array of mostly-uniform objects | record | Grid |
| JSON array of scalars / ragged objects | record (synthesized `value` col) or tree if deeply nested | Grid or tree |
| JSON single nested object | tree | Tree |
| YAML list of uniform mappings | record | Grid |
| YAML document (nested / comments / anchors) | tree | Tree |

"Mostly-uniform" = union of keys across a sample with a uniformity ratio above a
threshold (D-4 OD-7, start 0.7); below it opens as a tree. A "View as grid / View
as tree" toggle lets the user override where both are viable. Both shapes share
one cell-editor vocabulary, so the surface is two containers over one widget set.

### 10.2 Schema — three tiers, normalized to Zod

Priority order: **sidecar** (a companion `<name>.schema.json` or column-types
sidecar linked via `entity_links`; wins if present) → **pinned** (an inferred
schema a human/agent confirmed and froze onto the asset, in `bin_data_schemas`) →
**inferred** (sample the first N records, default >200, infer per-field type;
always produces a usable schema so the editor is never blocked). Inference yields
per field one of `string`, `integer`, `number`, `boolean`, `date`, `datetime`,
`enum` (low-cardinality string set), nullability, and a `longtext` hint (long or
newline-bearing strings). Enum detection is what makes the editor feel finished —
a low-cardinality column becomes a dropdown.

All three tiers normalize to a **Zod** schema (the suite's validation spine). The
bridges are MIT off-the-shelf: `json-schema-to-zod` (sidecar → Zod) and
`zod-to-json-schema` (pinned/inferred Zod → portable sidecar export). One
pipeline → editor widgets (client), save-time validation (server), portable JSON
Schema export.

### 10.3 Type-to-widget mapping (lifted from Blank)

| Zod type | Widget |
|---|---|
| `string` | text input |
| `string` + `longtext` | multiline / optionally `Y.Text` cell (§10.4) |
| `string` + `enum` | `Select` (Radix) |
| `number` / `integer` | number input with stepper |
| `boolean` | `Switch` (Radix) |
| `date` / `datetime` | date picker |
| nullable | clear-to-null affordance on any widget |
| nested object / array (tree only) | recursive node (Radix `Collapsible`) |

In-session validation is **advisory** (invalid cells flagged, not blocked, so a
collaborator's mid-edit state never blocks yours); commit-time validation is
**enforcing** (§10.4, D-4 OD-8: block by default, per-asset/org warn-and-record
policy).

### 10.4 Collaboration — a CRDT over a versioned file (D-3)

Yjs is used up front (not a 409 stale-guard) because the primary case is genuinely
cooperative multi-editor sessions on substantial files. The engineering is
reconciling a CRDT with Bin's immutable, format-bearing version model:

| | Brief | Bin data editor |
|---|---|---|
| Canonical thing | `yjs_state` *is* the document | the immutable asset **version** (native format) is the document |
| Yjs role | the document | a **live editing buffer** over the current version |
| Between edits | debounced flush of `yjs_state` | debounced flush of the buffer to `bin_data_sessions.yjs_state`; **no version per keystroke** |
| Durable write | implicit | explicit/autosaved **commit** → serialize Y.Doc to format → new immutable version |

Lifecycle: **open** (server loads the current version, builds a Y.Doc, seeds
`bin_data_sessions`) → **edit** (clients sync over `/bin/ws`, buffer flushes on a
debounce) → **commit** (serialize → write a new immutable version → advance
`base_version_id`). The buffer survives reconnects without polluting version
history; only commits produce versions.

**Transport (D-2).** Identical shape to Brief's repaired wiring: y-websocket
native path (`wss://host/bin/ws/<assetId>`), y-protocols sync + awareness, Redis
fan-out across `bin-api` instances, debounced binary persistence to
`bin_data_sessions.yjs_state`. The handler is cloned from
`apps/brief-api/src/ws/handler.ts` (~400 lines), authenticated against the
`bin.asset` predicate. Seed the Y.Doc **once on first sync** from the loaded file,
never re-seed on editor rebuild (the Yjs duplicate/clobber bug). This is the
forcing function to extract `@bigbluebam/collab-client` (the editor is its second
consumer after Brief).

**CRDT mapping — record shape:**

```
root: Y.Map
  ├─ "meta": Y.Map { shape, dialect, schemaSource, columns: Y.Array<Y.Map> }
  ├─ "rows": Y.Array<Y.Map>   each row: { "__rid": <uuid>, <colId>: <scalar | Y.Text> }
  └─ columns Y.Array<Y.Map>: { "__cid", "key", "type", "order", "enumValues"? }
```

Row order is the `rows` Y.Array order (concurrent insert/delete merge natively).
A cell edit is `row.set(colId, value)` — LWW register per key (correct for a typed
scalar; two people setting the same cell want one deterministic winner, not a
merged scalar). `__rid` is a generated UUID carried as a row field, never
surfaced, the stable anchor for comments/diffs across reorders. Column defs + order
live in `meta.columns` so schema edits merge and are seen live.

**CRDT mapping — tree shape:** recursive — objects → `Y.Map`, arrays → `Y.Array`,
scalars → register values; a node typed `longtext` is promoted to `Y.Text` for
character-level merge (D-4 OD-5: `longtext`-only by default, manual per-column
promote; avoid per-cell `Y.Text` on a wide grid). Each node carries a stable
`__nid`; tree comments alternatively anchor by JSON Pointer (more legible in
diffs).

**Commit and validation:** on commit bin-api reads the Y.Doc, validates every
row/field against the resolved Zod schema (invalid cells block by default or are
recorded as exceptions per policy), serializes to native format via the codec
preserving dialect/key-order/indent/YAML-comments (§10.6), writes the bytes as a
new immutable version through Bin's version path (presigned PUT, `stat()` verify,
scan flow), advances `base_version_id`, and records the commit in the unified
activity feed. Because versions are immutable and a commit is additive, there is
no destructive overwrite; `confirm_action` is reserved for commits dropping more
than a threshold share of rows and for schema repin.

**Awareness/presence:** cursor/selection awareness rides the ephemeral
`bin:awareness:<assetId>` channel (never persisted, <1 KB, relayed verbatim);
"who is here" chips come from Bureau's `PresenceChipStrip` in the editor header.
Two separate systems on purpose (in-document awareness vs suite-wide presence).

**Large-file ceiling (D-4 OD-2):** below ~50k rows / ~25 MB the whole file loads
into one Y.Doc; above it the asset opens **paged + read-only** with a "check out a
slice" path that loads a bounded row range into an editable Y.Doc and commits it
back as a partial update. The paged path is designed in from the start so the
ceiling is graceful.

### 10.6 Round-trip fidelity

The codec records a `dialect` descriptor at load (`meta.dialect` +
`bin_data_sessions.dialect`) and replays it at serialize:

- **CSV/TSV:** preserve delimiter, quote char, quoting style, line endings, header
  presence, column order (`papaparse`).
- **JSON (record):** stable key order, captured indentation, arrays-of-objects
  round-trip cleanly.
- **JSON (tree):** preserve key order; unedited subtrees byte-stable where
  guaranteeable, structurally identical otherwise.
- **JSONL/NDJSON:** one object per line, order preserved, a row edit rewrites
  exactly one line.
- **YAML (the hard one):** edit only through the `yaml` library's Document/CST API
  (the only way to preserve comments, key order, block-vs-flow style). Files with
  anchors/merge keys are gated: by default a safe-subset path preserves and warns;
  a file that cannot be edited losslessly opens read-only with an explicit
  "convert to a plain editable copy" action (mints a new asset, leaves the
  original untouched). `yaml` is the only net-new parser.

### 10.7 Comments (the review half)

Because versions are immutable, review is largely free: a structured diff between
version N and N+1 (rows added/removed/changed, cells changed) renders in the grid,
seeded from the audit viewer's existing diff-style JSON renderer (D-4 OD-4:
cell-level always, row-summary with drill-down for very wide tables). Inline
comments anchor to a coordinate, not a byte offset — record: `{ rid, colId? }`;
tree: `{ pointer }` (JSON Pointer). Comments are markdown, threaded, resolvable,
authored by humans or agents identically, stored in `bin_data_comments`, gated by
`bin.data_comment`. Formal sign-off (a human other than the editor ratifies)
routes through Badge's `/b3/approvals`, not a Bin-private channel.

### 10.5 Brief embedding

A data asset embeds in a Brief document as a custom Tiptap node:

```
node "structuredDataEmbed"
  attrs: { assetId, versionPin?, view: 'table' | 'tree', mode: 'snapshot' | 'live' }
```

`snapshot` (default) renders a pinned version statically (stable, cheap, exports
clean — a document should not silently change under a reader). `live` mounts the
same grid/tree read-only bound to the asset's Yjs room, so an embedded table
updates as someone edits it in Bin. The embed stores only a reference plus render
prefs, never a copy, so there is one source of truth; permission is resolved at
render time against the `bin.asset` predicate (a reader who cannot see the asset
sees a "no access" placeholder, keeping Brief from becoming a permission side
channel).

---

## 11. Structured-editor data model

All Drizzle-defined in `apps/bin-api/src/db/schema/`, snake_case, numbered
idempotent migrations.

```ts
/** Live editing buffer over a Bin asset. One active session per (asset, branch).
 * Holds the CRDT binary between commits so a session survives reconnects without
 * minting a version per keystroke — the structural analogue of
 * brief_documents.yjs_state, but explicitly a buffer over an immutable file. */
export const binDataSessions = pgTable('bin_data_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => binAssets.id, { onDelete: 'cascade' }),
  baseVersionId: uuid('base_version_id').notNull(),
  branch: text('branch').notNull().default('main'),   // reserved (D-4 OD-3)
  shape: text('shape').notNull(),                     // 'record' | 'tree' (CHECK)
  yjsState: customType_bytea('yjs_state'),            // debounced CRDT snapshot (reuse Brief's bytea type)
  dialect: jsonb('dialect').notNull(),
  schemaSource: text('schema_source').notNull(),      // 'sidecar' | 'pinned' | 'inferred'
  schemaJson: jsonb('schema_json'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastFlushedAt: timestamp('last_flushed_at'),
}, (t) => ({ oneActive: uniqueIndex('bin_data_sessions_one_active').on(t.assetId, t.branch) }));

export const binDataSchemas = pgTable('bin_data_schemas', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => binAssets.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),                   // 'pinned' | 'sidecar'
  schemaJson: jsonb('schema_json').notNull(),
  sidecarAssetId: uuid('sidecar_asset_id'),
  pinnedBy: uuid('pinned_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({ onePinned: uniqueIndex('bin_data_schemas_one_pinned').on(t.assetId).where(sql`source = 'pinned'`) }));

export const binDataComments = pgTable('bin_data_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => binAssets.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull(),            // version the comment was anchored against
  shape: text('shape').notNull(),                     // 'record' | 'tree'
  anchor: jsonb('anchor').notNull(),                  // record: { rid, colId? } ; tree: { pointer }
  body: text('body').notNull(),                       // markdown
  authorId: uuid('author_id').references(() => users.id),
  threadParentId: uuid('thread_parent_id'),
  resolved: boolean('resolved').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

Schema sidecars link through `entity_links` (a `bin.asset` of content-type
`application/schema+json` linked to the data asset); the `binDataSchemas` row with
`source='sidecar'` caches the resolution.

---

## 12. Consumed by Bay (the primitives Bay relies on)

Bay (media review) predates Bin and currently reimplements storage. The intended
end state: **Bin owns canonical storage + the immutable-version model + the AV
scan + entity links; Bay layers review on top.** Bin must therefore expose these
as app-agnostic building blocks, not bin-internal details:

1. **The storage driver package** (`@bigbluebam/storage`) is consumable by
   `bay-api` and the worker, so Bay's originals and transcode proxies land on the
   org's configured provider via the same driver/binding resolution, not a private
   `bay/` MinIO prefix.
2. **The immutable-version primitive.** A Bay version's canonical bits are a Bin
   asset version (sourced from or promoted to a `bin.asset`), federated through
   `entity_links` and `attachment_list`/`attachment_get`. Bay keeps its
   review-specific tables (annotations, decisions, reviews, transcode-proxy media
   rows) but does not duplicate canonical-storage/version cataloging.
3. **The AV scan flow.** Bay uploads inherit Bin's scan-status gate rather than
   shipping a parallel scanner.
4. **Presigned serving** via `/files/` and the binding resolver.

The Bay reconciliation (Phase 2, separate pass) verifies this composition holds
and, if Bay needs something Bin does not yet expose, Bin is reworked to provide it
(decisions logged as **BAY-N**). Bin's design here deliberately keeps the storage,
version, and scan layers free of any Bin-app-specific assumptions so Bay can sit
on them.

---

## 13. Permissions catalog

Granular `bin.<resource>.<verb>` ids via `requireCan`, seeded through a
`NNNN_permissions_seed_actions_delta_*.sql` migration + codegen regen (AB-4).
Defaults to builtin Owner/Admin groups; delegatable per `@bigbluebam/permissions`.

| Permission | Default grant | Flags | Backs |
|---|---|---|---|
| `bin.asset.read` / `.list` | reader | read | browse/open assets + folders |
| `bin.asset.create` / `.update` | writer | — | upload, rename, move |
| `bin.asset.archive` | writer | destructive | soft-delete |
| `bin.data.read` | asset reader | read | open/read a data asset, list comments |
| `bin.data.edit` | asset writer | — | join the editing session, mutate the Y.Doc |
| `bin.data.commit` | asset writer | — | materialize a new version |
| `bin.data.comment` | asset reader | — | create/resolve comments |
| `bin.schema.pin` | org admin (delegatable) | confirm | pin/repin the schema |
| `bin.provider.list` | Admin/Owner | read | list providers (secrets never returned) |
| `bin.provider.create` / `.update` / `.test` | Admin/Owner | — / read | configure providers |
| `bin.binding.list` | Admin/Owner | read | view bindings |
| `bin.binding.set` | Owner | destructive, confirm | repoint a role binding |
| `bin.backup_policy.set` / `bin.backup.run` / `bin.backup.list` | Admin/Owner | — / read | backups |
| `bin.restore.run` | Owner | destructive, confirm | restore from a point (freeze-gated) |
| `bin.migration.schedule` / `.cancel` | Owner | destructive | provider migration |
| `bin.migration.get` | Admin/Owner | read | monitor (freeze-exempt) |

Platform-scope variants (installation defaults, platform providers, instance-wide
migration/restore under `/superuser/storage/*`) are flagged `requires_superuser`
and are intentionally **not** delegatable. Schema repin and a commit/restore that
drops more than a threshold share of rows route through `confirm_action`.

---

## 14. API and MCP surface

REST under `/bin/api/*`; every write tool inherits the 423 freeze behaviour and is
registered through `register-tool.ts` (which enforces the `agent_policies` kill
switch and the `bin.*` allowlist on every service-account call). One service backs
both the editor and agents; an agent patch is applied server-side to the live
Y.Doc (or a freshly loaded one) and broadcast like any other update, so an agent
appending rows shows up live in every open editor. The REST↔MCP surface map
(`docs/reference/mcp-endpoint-mapping.md`) is updated in the same change Bin lands;
WebSocket upgrade routes (`/bin/ws`) are excluded from the permission catalog scan
(they are realtime channels, not authz actions).

**Storage admin** (`/bin/api/storage/*`, `/superuser/storage/*`):
`storage_provider_list/create/update/test`, `storage_binding_list/set`,
`backup_policy_get/set`, `backup_run_now`, `backup_run_list`, `backup_restore`,
`storage_migration_schedule/status/cancel`. Destructive ones (`backup_restore`,
`storage_migration_schedule`, `storage_binding_set` onto a different provider)
route through `confirm_action`.

**DAM** (`/bin/api/assets/*`, `/bin/api/folders/*`): asset/folder CRUD, upload
(presign + complete), version list/get, archive — with `bin_asset_*` MCP tools.

**Structured editor** (`/bin/api/data/*`): one service for editor + agents.

| REST | MCP tool | Purpose |
|---|---|---|
| `GET /data/:assetId` | `bin_data_read` | read as records/tree; `where`, `columns`, `limit`, `offset` |
| `POST /data/:assetId/session` | `bin_data_open_session` | open/resume session; returns shape, schema, ws room |
| `PATCH /data/:assetId/rows` | `bin_data_patch` | apply cell/row patches (agent path) |
| `POST /data/:assetId/rows` | `bin_data_append_rows` | append rows |
| `POST /data/:assetId/validate` | `bin_data_validate` | validate buffer/version against schema |
| `POST /data/:assetId/infer-schema` | `bin_data_infer_schema` | infer on a sample → JSON Schema |
| `POST /data/:assetId/pin-schema` | `bin_data_pin_schema` | pin a schema (confirm) |
| `POST /data/:assetId/commit` | `bin_data_commit_version` | serialize → new immutable version |
| `GET /data/:assetId/diff` | `bin_data_diff_versions` | structured diff between two versions |
| `GET/POST /data/:assetId/comments` | `bin_data_comment_list` / `_create` | anchored comments |
| `POST /data/comments/:id/resolve` | `bin_data_comment_resolve` | resolve a thread |

---

## 15. Deployment and configuration

New/changed env on api + worker (additive; existing `S3_*` becomes the
bootstrap/default `local` provider — `S3_*` are the live vars, `MINIO_ROOT_*` are
only MinIO's own bootstrap creds):

| Variable | Default | Notes |
|---|---|---|
| `BIN_SECRETS_KEY` | required in prod | 32-byte master key for envelope encryption; back with KMS in cloud |
| `BIN_SECRETS_KEY_ID` | `local-1` | key identifier stored on each secret for rotation |
| `RCLONE_BIN` | `/usr/local/bin/rclone` | path in the worker image |
| `MIGRATION_COPY_CONCURRENCY` | `16` | parallel object copies during migration |
| `BACKUP_VERIFY_SAMPLE` | `full` | `full` or an integer percentage for large stores |
| `FREEZE_GRACE_SECONDS` | `15` | in-flight write drain window before copy starts |

The `worker` image gains the `rclone` binary plus new BullMQ queues
(`bin-av-scan`, `bin-backup`, `bin-migrate`, `bin-data-parse` for large-file parse
offload and version materialization). nginx gains `/bin/`, `/bin/api/`, `/bin/ws`.
docker-compose gains the `bin-api` service (:4016) and `bin` SPA build (baked into
the frontend nginx image like the other SPAs). No changes to the data services
themselves; providers are swapped through Bin config, not env edits.

---

## 16. Security

- Secrets are envelope-encrypted, stored apart from the provider row, never
  returned; the UI shows a fingerprint + masked hint only. Test-connection returns
  a boolean + latency, not the secret.
- A provider that fails its capability probe for the role it is bound to is
  rejected at bind time; an `rclone` provider can never back `media`.
- Cross-org isolation: org-scoped providers/bindings filtered by `org_id`; the
  binding resolver fails closed if the active org does not match. Only SuperUsers
  cross the boundary, only through `/superuser/*`.
- The freeze fails closed (DB-row fallback if Redis is unavailable).
- All migration/restore ops logged (`activity_log` / `superuser_audit_log`) with
  actor, scope, from/to provider, outcome.
- The master key is recoverable by design through the keybundle (§7.6), not left
  to chance in a lost `.env`. The recovery security level is the explicit
  confidentiality-vs-recoverability tradeoff, surfaced in plain language.
- Uploads: enforce size + content-type, no public bucket, magic-byte validation,
  SVG blocked for uploads (matching the existing attachment rule); presigned URLs
  short-TTL, raw keys never exposed.

---

## 17. Build order

Front-loads the highest-risk editor round-trip work and the storage-driver
consolidation; phases the multi-provider/backup machinery after a usable MVP
(D-5).

1. **`@bigbluebam/storage`**: driver interface, `s3` + `local` drivers, capability
   probe. Repoint the existing `attachment_*` substrate at it (no behaviour
   change, validates the abstraction; consolidates the three ad-hoc clients).
2. **`@bigbluebam/structured-data`**: codecs (CSV, JSONL, JSON, YAML), shape
   detector, inference, Zod bridges. Pure, independently testable.
3. **CRDT mapping** (record then tree) + the deterministic file→Y.Doc→file round
   trip, with golden-file fidelity tests per format. *(Steps 2–3 are the
   highest-risk, highest-leverage work and gate everything; heaviest test burden.)*
4. **Bin DAM core**: provider + binding data model, asset/folder/version schema,
   upload (presign + complete), the AV scan worker job, presigned serving, entity
   registration, the org config UI. Everything runs on the bootstrap `local`
   provider.
5. **`bin-api` structured-editor**: session lifecycle + WS handler (cloned from
   brief-api) + commit path + validation. Extract/consume `@bigbluebam/collab-client`.
6. **`/bin/` SPA**: asset browser + the TanStack Table grid + Radix tree + widget
   mapping + awareness + Bureau presence; comments + version diff view.
7. **MCP tool layer** over the same service.
8. **Brief `structuredDataEmbed` node** (snapshot first, then live).
9. **Freeze mechanism**: shared preHandler, Redis mirror, queue pausing, the 423
   contract, the blocking frontend notice.
10. **Migration engine** on the freeze: state machine, copy/verify/cutover,
    monitor + cancel, source retention/teardown.
11. **Backup engine**: policy model, repeatable jobs, incremental manifest diff,
    full/consolidated runs, retention, run-history UI, the keybundle writer + the
    recovery security-level choice (a backup that cannot be read later is not a
    backup).
12. **SuperUser installation-defaults panel** + platform-wide migration +
    driver-kind allowlist.
13. **Restore flow** (reuses freeze): selective restore first, then the first-run
    disaster-recovery wizard (OAuth re-auth bootstrap + recovery-status dashboard).
    Optional WAL-archiving PITR last.
14. **rclone driver** + the novice "back up to Google Drive" wizard.

Steps 1–8 are an independently shippable, immediately useful Bin (enterprises can
point at their own S3 on day one via step 4; the editor + DAM are the user-facing
value). The freeze (step 9) is the prerequisite for migration and restore, so it
lands before either. The keybundle (step 11) must ship with the very first backup,
never bolted on later, or early adopters will have backups they cannot recover.

---

## 18. Resolved decisions

Every architectural judgment call is recorded in
`Bin_Master_Design_Document_Decisions.md` (AB-1…AB-6 as-built reconciliations,
D-1…D-6 design calls, and the OD-1…OD-8 resolutions). No open decisions remain at
the spec level; remaining choices are implementation-time (exact Argon2id params
for the recovery-code KDF, copy concurrency per provider family, the large-file
threshold, the uniformity ratio), to be tuned by profiling.
