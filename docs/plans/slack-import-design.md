# Slack workspace → Banter import — design

**Status**: scaffold for review. Implementation will follow after sign-off on the design forks listed in §13.

**Goal**: a non-engineer org admin can take a Slack workspace export (the .zip file Slack itself produces from Settings → Import / Export Data) and import it into Banter — channels, messages, threads, reactions, files, pins — scoped to a project of their choosing, in well under an hour for a typical small/medium workspace.

**Non-goals (v1)**:
- Real-time Slack ↔ Banter sync (this is a one-shot import)
- Slack workspaces with > ~100k messages or > ~50 GB of attachments (works, but the UX/perf isn't optimized for it — a streaming-ingest mode is a v2 concern)
- Non-Slack chat platforms (Discord, Teams, Mattermost) — separate importers, same plumbing
- Slack Enterprise Grid multi-workspace exports (the format is similar but has cross-workspace channels — out of scope for v1)
- DM import (see §5; deferred to v2 unless the operator explicitly requests)
- E2E encrypted channels (Slack doesn't expose them in exports anyway)

---

## 1. UX flow (from `/b3/settings`)

A new **"Slack Import"** card lives under `/b3/settings` (the existing Bam settings page; the same place `system-settings`-style operator tools live). The card is visible only when `useCan('banter.admin_import.create')` returns true — which, per §6, means the user is at least org admin (with SuperUser bypass).

### Step 1 — Upload

Card UI:
- Drag-and-drop or "Choose file" for the `.zip` export
- File-size limit (configurable; default 5 GB)
- On select, the UI POSTs to `POST /banter/api/v1/admin/import/slack/upload` (multipart). The api stashes the file in MinIO under `slack-imports/<org_id>/<import_id>.zip` and returns `{ data: { import_id, file_size, channels_detected, users_detected, messages_estimated } }` after a fast metadata scan (reads only `channels.json` + `users.json` from the archive — no full unpack yet).

### Step 2 — Mapping wizard

The card transitions to a multi-section preview with:

**A. Target project**
- Radio: "Create a new project" (input for name + key) vs "Use existing project" (typeahead from `/b3/api/projects`)
- Help text: every imported channel will land in a new `banter_channel_groups` row named after this project + the source workspace name + today's date

**B. User mapping**
- Auto-mapped (read-only list): Slack users whose `profile.email` matches an existing BAM user in this org. Shows N matches.
- Unmatched (table with per-row dropdown): Slack user → action selector. Options:
  - `Create stub user` (default) — creates a placeholder user with the Slack display name + email if present, marked `is_active=false`, no password. Owner can promote later.
  - `Map to existing user` (typeahead from this org's users) — operator-chosen target
  - `Skip user` — their messages get imported under a system "Slack Migration" bot user, with original author name preserved in `metadata.slack_author_name`
- "Match by display name" button (best-effort — looser than email match; needs operator confirmation per row before applying)

**C. Channel mapping**
- Table of every Slack channel with columns: `Slack name`, `Slack type` (public/private/dm/mpdm), `Members`, `Messages`, `Mapping`
- Per-row mapping action: `Import as new`, `Merge into existing` (typeahead of org's existing banter channels), `Skip`
- Default: public/private channels → import as new; dms/mpdms → skip (operator can opt in)
- For each row to import, fields: target name (defaults to slack name), topic, channel type (`public`/`private`)

**D. Options**
- Toggle: "Preserve original timestamps" (default ON) — messages keep their original Slack timestamps. Off makes everything appear to have arrived at import time.
- Toggle: "Import attachments" (default ON) — re-uploads files to MinIO. Off skips files (saves disk + time for huge workspaces).
- Toggle: "Import reactions" (default ON)
- Toggle: "Import pins" (default ON)
- Toggle: "Notify members on import completion" (default OFF) — when on, every mapped existing user gets a Banter notification "X channels imported from Slack into project Y"
- Toggle: "Dry run" (default OFF) — runs the entire pipeline without writing anything; produces a diff report
- Number input: "Daily message rate cap" (default 5000) — for very large workspaces, throttles the worker so import doesn't saturate the DB

### Step 3 — Confirmation + start

- "Start Import" button — disabled if mapping has errors (e.g. a channel mapped to "Merge" but no target picked)
- Confirmation modal: shows the totals (X channels, Y messages, Z users, ~MB of attachments)
- POST `POST /banter/api/v1/admin/import/slack/{import_id}/start` with the mapping body. Returns `202 Accepted` with the import_id; the worker takes over.

### Step 4 — Progress + completion

- The card replaces itself with a live progress view (polls `GET /banter/api/v1/admin/import/slack/{import_id}/status` every 2s, or subscribes via the existing Banter WebSocket on a new `import:status:<import_id>` channel)
- Shows phases: `Unpacking → Mapping users → Importing channels (N/M) → Importing messages (X/Y) → Importing attachments (X/Y) → Reconciling → Done`
- Each phase has a progress bar + ETA + an optional "View details" expansion showing per-channel counters
- On completion: summary card with totals + a "View imported channels" deep link to Banter's channel browser filtered by the new channel_group
- On failure: error message + an "Abort & clean up" button (calls `DELETE` on the import, which removes all rows touched by it — see §7 on idempotency keys that make this possible)

---

## 2. Slack export format reference

Slack workspace exports come as a `.zip` with this top-level shape:

```
my-workspace-export.zip
├── channels.json          // all public channels metadata
├── groups.json            // private channels (if export was authorized for them)
├── dms.json               // 1-on-1 DMs (only if exported by a workspace owner with corporate export)
├── mpims.json             // multi-party DMs
├── users.json             // every user that appears in any of the above
├── <channel-name>/        // one directory per channel/group/dm
│   ├── 2024-01-01.json    // one file per day with messages from that day
│   ├── 2024-01-02.json
│   └── ...
└── ...
```

Per-day message JSON shape (simplified):

```json
[
  {
    "type": "message",
    "user": "U01ABCDEF",
    "text": "Hello :wave:",
    "ts": "1704067200.000100",
    "thread_ts": "1704067100.000050",     // present on replies; matches parent's ts
    "reply_count": 3,                       // present on thread parents
    "reactions": [{"name": "thumbsup", "users": ["U01ABCDEF"], "count": 1}],
    "files": [{"id": "F01...", "name": "diagram.png", "url_private": "https://files.slack.com/..."}],
    "edited": {"user": "U01ABCDEF", "ts": "1704067260.000000"},
    "blocks": [...]                         // Slack's Block Kit JSON; we ignore for v1
  }
]
```

Key fields the importer relies on:
- `ts` is the Slack message identifier — globally unique within a workspace, format `<unix_seconds>.<microseconds>`. This is our idempotency key.
- `thread_ts === ts` for the parent; `thread_ts !== ts` for replies.
- `files[].url_private` requires the export's bearer token for downloads (NOT present in plain exports); for **standard exports**, files are NOT included — they're referenced by URL but require the Slack workspace to still be alive + the importer's user to have access. For **corporate exports** (workspace-owner-authorized), files are included locally under `files/` (path varies).

The importer must handle both: if a file is referenced by a Slack URL we can't reach, it's recorded as a stub attachment with the original metadata + a note "File not in export."

---

## 3. Architecture

```
┌──────────────────────────┐
│ /b3/settings (apps/      │
│   frontend)              │
│   Slack Import card      │
└─────────┬────────────────┘
          │  multipart upload + JSON polling
          ▼
┌──────────────────────────┐         ┌─────────────────────────┐
│ banter-api               │  jobs   │ apps/worker             │
│   /v1/admin/import/slack │ ──────► │   slack-import handler  │
│     /upload              │  via    │                         │
│     /:id/start           │  BullMQ │   - unpack .zip to tmp  │
│     /:id/status          │         │   - map users           │
│     /:id (DELETE)        │         │   - create channel grp  │
│                          │         │   - import channels     │
│   stores file in MinIO   │         │   - import messages     │
│   under slack-imports/   │         │   - import reactions    │
└──────────────────────────┘         │   - import files (MinIO)│
                                      │   - import pins         │
                                      │   - publish status      │
                                      └──────────┬──────────────┘
                                                 │
                                                 ▼ Postgres (banter_*)
                                                 ▼ MinIO (attachments)
                                                 ▼ Redis (status pubsub)
```

**Why this split**: the upload + admin UX is short-lived HTTP traffic that fits Fastify cleanly. The actual import is long-running (minutes to hours for big workspaces), state-machined, retryable — exactly what BullMQ + the worker process exist for. Status is fanned out via Redis pubsub on `banter:import:status:<import_id>` so the UI can subscribe via the existing WebSocket plumbing (no new transport).

---

## 4. Schema changes

Three additions, one migration. All idempotent per `CLAUDE.md` migration conventions.

### 4a. `banter_channel_groups.project_id` (nullable FK)

```sql
ALTER TABLE banter_channel_groups
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS banter_channel_groups_project_id_idx
  ON banter_channel_groups (project_id) WHERE project_id IS NOT NULL;
```

This is the project linkage. Existing groups stay un-linked (NULL); imports always set it.

### 4b. `banter_slack_imports` (new table)

```sql
CREATE TABLE IF NOT EXISTS banter_slack_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  channel_group_id    uuid REFERENCES banter_channel_groups(id) ON DELETE SET NULL,
  initiated_by        uuid NOT NULL REFERENCES users(id),
  workspace_name      text NOT NULL,
  workspace_url       text,                   -- e.g. https://acme.slack.com
  source_filename     text NOT NULL,
  source_size_bytes   bigint NOT NULL,
  source_minio_key    text NOT NULL,          -- slack-imports/<org_id>/<id>.zip
  mapping             jsonb NOT NULL,         -- user + channel mapping + options from §1 Step 2
  status              text NOT NULL DEFAULT 'pending',  -- pending|unpacking|mapping|importing|reconciling|done|failed|aborted
  phase               text,                   -- finer-grained, set by worker
  progress_total      integer NOT NULL DEFAULT 0,
  progress_done       integer NOT NULL DEFAULT 0,
  totals_imported     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {users, channels, messages, files, reactions, pins}
  totals_skipped      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message       text,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS banter_slack_imports_org_id_idx ON banter_slack_imports (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS banter_slack_imports_status_idx ON banter_slack_imports (status) WHERE status NOT IN ('done', 'failed', 'aborted');
```

This is the per-import audit + status row. One per upload, even if the import is aborted and restarted (a new row is created).

### 4c. `slack_source` JSONB additions to `banter_messages.metadata`

No schema change — `banter_messages.metadata` is already JSONB. The importer writes:

```json
{
  "slack_source": {
    "import_id": "<uuid>",
    "workspace": "acme",
    "channel": "engineering",
    "ts": "1704067200.000100",
    "thread_ts": "1704067100.000050",
    "original_author_name": "alice"   // present when author_id was mapped to the system migration bot
  }
}
```

The `(import_id, ts)` pair is the idempotency key. A unique partial index makes re-imports a no-op:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS banter_messages_slack_source_unique
  ON banter_messages ((metadata #>> '{slack_source,import_id}'), (metadata #>> '{slack_source,ts}'))
  WHERE metadata ? 'slack_source';
```

Same idea for attachments + reactions — they get a `slack_source` block on their existing JSONB columns and a matching unique partial index.

---

## 5. User mapping strategy

Three actions per Slack user, chosen in the Step 2 wizard:

### 5a. Auto-match (default for users with email in Slack export)

- Slack export's `users.json` includes `profile.email` for non-deactivated users (the export-owner's permission level determines coverage)
- Lookup query: `SELECT id FROM users WHERE LOWER(email) = LOWER($slack_email) AND id IN (SELECT user_id FROM organization_memberships WHERE org_id = $org_id)`
- If found → that user is the message author for everything they wrote
- The wizard shows these in a "Auto-mapped (N)" collapsed section; operator can override

### 5b. Stub user creation

For unmapped Slack users where the operator wants their messages preserved:

```sql
INSERT INTO users (
  id, org_id, email, display_name, role, kind, is_active, is_superuser, ...
) VALUES (
  gen_random_uuid(),
  $org_id,
  $slack_email_or_null,
  $slack_display_name,
  'member',
  'human',
  false,                  -- inactive — can't log in until promoted
  false,
  ...
);
```

Plus a row in `organization_memberships` so the user is bound to the org. The membership gets the built-in `Viewer` group so an accidentally-promoted stub can read but not write.

Stub users are tagged in metadata: `users.notification_prefs = { "slack_stub": true, "imported_at": "...", "slack_workspace": "..." }`. The owner can later promote a stub via the existing `/b3/superuser/people/:id` flow.

### 5c. System "Slack Migration" bot

A single platform-level user `system+slack-migration@bigbluebam.internal` (created lazily on first import). When the operator chooses "Skip user" for a Slack user, that user's messages are imported with the bot as author + the original Slack author name preserved in `metadata.slack_source.original_author_name`. The Banter UI renders these as "<original_author_name> via Slack Migration".

This is the safety hatch for "I don't want to recreate this person's user" — preserves the conversation without auto-creating accounts.

### 5d. DMs (deferred, mentioned for completeness)

If the operator opts into DM import (default OFF):
- Each Slack DM (`dms.json` entries) becomes a Banter DM thread between the two mapped users
- Multi-party DMs (`mpims.json`) become Banter group DMs
- If either side is "skipped" (no mapped user), the whole DM is skipped (DMs imply two real participants; can't be imported under the migration bot meaningfully)

---

## 6. Permission model

Three new catalog permissions (added via the HAND_AUTHORED block in `scripts/generate-permission-manifest.mjs`):

```
banter.admin_import.create   requires_superuser=false   (admin/owner level)
banter.admin_import.status   is_read=true               (admin/owner level)
banter.admin_import.abort    is_destructive=true        (admin/owner level)
```

In the built-in role defaults (current migrations 0156-0158):
- Owner: all three granted (already true via "owner allows everything except platform.* and bam.platform_*")
- Admin: all three granted
- Member: all three denied
- Viewer: all three denied
- Guest: all three denied

SuperUser bypasses all of this via the resolver's step-1 short-circuit. The `useCan('banter.admin_import.create')` check on the settings card is the UI gate; the backend routes enforce via `fastify.requireCan(...)` independently.

---

## 7. Idempotency + retry semantics

Imports must be safe to re-run end-to-end. Three layers:

1. **The `banter_slack_imports` row** is the durable audit. Aborting an import sets `status='aborted'`; re-running creates a fresh row but reuses the same MinIO upload (the user can re-trigger from the row's status detail page).
2. **Message idempotency** via the unique partial index on `(metadata->slack_source->import_id, metadata->slack_source->ts)`. Re-running an import with the same `import_id` is a true no-op on already-imported messages.
3. **File idempotency** via deterministic MinIO keys: `attachments/<org_id>/slack-imports/<import_id>/<slack_file_id>.<ext>`. Re-uploads overwrite; the metadata row in `banter_message_attachments` has the same `(import_id, slack_file_id)` uniqueness as messages.

**Partial failure**: if the worker crashes mid-import, BullMQ retries the job. The worker's first action is "advance the cursor" — it queries the `banter_slack_imports` row's `totals_imported` to figure out where it left off, and resumes. Because of the idempotency keys, replaying earlier work is harmless.

**Abort cleanup**: `DELETE /v1/admin/import/slack/:id` does the following in a single transaction:
- Mark `status='aborted'`
- DELETE from `banter_messages WHERE metadata->slack_source->import_id = $id`
- DELETE from `banter_message_attachments WHERE metadata->slack_source->import_id = $id`
- DELETE from `banter_message_reactions WHERE metadata->slack_source->import_id = $id`
- DELETE from `banter_channels WHERE channel_group_id = $channel_group_id AND created_at >= $started_at` (i.e. channels created by this import)
- DELETE from `banter_channel_groups WHERE id = $channel_group_id`
- Optionally also DELETE from `users WHERE notification_prefs->'slack_stub' = true AND notification_prefs->>'imported_at' >= $started_at AND notification_prefs->>'slack_workspace' = $workspace` (only stubs from THIS import, never auto-mapped or pre-existing users)

The stub-user cleanup is opt-in (a separate UI button "Also remove stub users") because aborting is sometimes a "redo with different mapping" operation where the stubs should persist.

---

## 8. Files + attachments

For each Slack message with `files[]`:

1. If the export includes the file locally (corporate export):
   - Read from the local path
   - Upload to MinIO at `attachments/<org_id>/slack-imports/<import_id>/<slack_file_id>.<original_ext>`
   - INSERT row into `banter_message_attachments` with size, mime type, original filename, and the `slack_source` metadata

2. If the file is referenced by URL only (standard export):
   - Attempt download with the importer's Slack bearer token (operator provides during Step 2 if they have one; optional)
   - On success: same as (1)
   - On failure (no token, expired URL, file deleted): insert a "stub attachment" row with `is_stub=true` (new column), `original_url=<slack url>`, original filename, mime type. The Banter UI renders these as a non-clickable "File: diagram.png (not migrated)"

The `is_stub` column needs to be added to `banter_message_attachments`:

```sql
ALTER TABLE banter_message_attachments
  ADD COLUMN IF NOT EXISTS is_stub boolean NOT NULL DEFAULT false;

ALTER TABLE banter_message_attachments
  ADD COLUMN IF NOT EXISTS original_url text;
```

---

## 9. Endpoints

All under `/banter/api/v1/admin/import/slack/` in a new file `apps/banter-api/src/routes/slack-import.routes.ts`. Each gated by `fastify.requireCan('banter.admin_import.<verb>')`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/upload` | `banter.admin_import.create` | Multipart upload, returns `{ import_id, preview }` (channels + users detected, est. messages) |
| POST | `/:id/start` | `banter.admin_import.create` | Confirm mapping + options, enqueue worker job |
| GET | `/:id/status` | `banter.admin_import.status` | Poll status (also published via WS) |
| GET | `/:id/preview` | `banter.admin_import.status` | Return the parsed users + channels for the mapping wizard |
| DELETE | `/:id` | `banter.admin_import.abort` | Abort + cleanup |
| GET | `/` | `banter.admin_import.status` | List recent imports for this org (history) |

Request/response shapes are detailed in the implementation PR; spec stays at this level here.

---

## 10. Worker job (`apps/worker/src/handlers/slack-import.ts`)

Phase machine:

```
pending → unpacking → mapping_users → creating_channel_group →
importing_channels → importing_messages → importing_files →
importing_reactions → importing_pins → reconciling → done
```

Each phase updates `banter_slack_imports.{status, phase, progress_done, progress_total}` and publishes `banter:import:status:<import_id>` on Redis.

**Critical implementation notes**:

- **Streaming unzip**: use `node-stream-zip` or similar — never load the whole archive into memory. A 50 GB export should work on a 4 GB worker.
- **Chunked message inserts**: batch inserts in groups of 500 messages per transaction. Larger batches risk WAL pressure on busy postgres instances.
- **Thread reconciliation**: messages can arrive out of order across day files. The worker imports parents first (`thread_ts === ts`), then a second pass for replies. The reply's `thread_parent_id` resolves by looking up the parent's new UUID via the `slack_source.ts → message.id` mapping cache.
- **Rate limiting**: respect the `daily_message_rate_cap` from the mapping options. The worker sleeps between batches if the import would otherwise exceed the cap.
- **Memory bound**: the user-id mapping cache (Slack user_id → BAM user_id) lives in memory for the duration. For workspaces with > 100k users that's still <10 MB, so unbounded is fine.
- **Cancellation check**: at the top of every batch loop, re-read `banter_slack_imports.status`. If it's `aborted`, stop and trigger the abort cleanup.

---

## 11. Tests

- `apps/banter-api/test/slack-import.routes.test.ts` — endpoint auth + Zod validation + upload size limit
- `apps/banter-api/test/slack-import.upload.test.ts` — multipart handling with a tiny canned .zip fixture
- `apps/worker/test/slack-import.handler.test.ts` — drive the worker with a 2-channel 5-message fixture; assert the right rows land + idempotent re-run
- `apps/worker/test/slack-import.cleanup.test.ts` — abort partway through a fixture import; assert all import-tagged rows are gone after cleanup
- Fixture: a real-shaped 3-channel 50-message workspace export stored at `apps/worker/test/fixtures/slack-mini-workspace.zip` (~50 KB, no actual files; messages reference fake file ids that the importer should stub)

End-to-end manual smoke (documented in the implementation PR):
1. Operator (eddie SU) uploads the fixture from `/b3/settings`
2. Wizard auto-maps eddie, prompts for 4 unmapped users (chooses stubs)
3. Picks "Create new project" with name "Slack Migration Demo"
4. Starts the import; watches the progress card flip through phases
5. After completion, navigates to Banter, sees a new channel group "Slack: acme-mini (Slack Migration Demo)" with 3 channels
6. Opens a channel, scrolls back; sees ~50 messages with correct timestamps + reactions
7. Returns to `/b3/settings`, sees the import in history; clicks Abort + opts into stub cleanup
8. Verifies the channel group, channels, messages, and 4 stub users are gone; eddie's own user is untouched

---

## 12. Migration sequence

1. `0163_banter_channel_groups_project_id.sql` — adds `project_id` FK + index to `banter_channel_groups`
2. `0164_banter_slack_imports.sql` — creates the `banter_slack_imports` table + indices
3. `0165_banter_message_attachments_stub_fields.sql` — adds `is_stub` + `original_url` to `banter_message_attachments`
4. `0166_banter_messages_slack_source_unique.sql` — adds the unique partial index on `metadata.slack_source.{import_id, ts}`
5. `0167_permissions_seed_actions_delta_006.sql` — adds the 3 new `banter.admin_import.*` permissions to the catalog

All idempotent. None destructive.

---

## 13. Design forks needing sign-off before implementation

These are the calls that need to be made before code lands. My recommended default is in **bold**.

1. **DM import default**: ON or OFF? Recommend **OFF** in v1 — DMs are privacy-sensitive and the mapping UX is more complex (both sides must be real users). Operator can opt in per import.

2. **Stub-user cleanup on abort**: separate toggle or always-on? Recommend **separate toggle** (off by default) — the most common abort reason is "redo with different mapping" and the stubs should persist.

3. **File download credentials**: how does the operator supply a Slack bearer token for standard exports? Recommend **a separate Step 2D field** for the bearer token (password input, never stored — used only during this import job and discarded). Acceptable that "no token + standard export = files become stubs."

4. **Where the upload endpoint lives**: `apps/banter-api` or `apps/api`? Recommend **`apps/banter-api`** since the data lands there and the worker reads from there too. The Bam settings UI just calls the cross-app endpoint via the existing nginx proxy (`/banter/api/...`).

5. **WebSocket vs polling for status**: build a new `import:status:*` channel on the Banter WS, or just poll the REST endpoint every 2s? Recommend **start with polling** (simpler, no new WS surface), upgrade to WS in a follow-up if the UX feels laggy.

6. **Project linkage location**: `project_id` on `banter_channel_groups` (my pick) vs on each `banter_channels` row? Recommend **on the group** — a project owns a thematic bundle of channels, which is exactly what a group represents. Lets the operator move all imported channels to a different project later by editing one FK.

7. **System "Slack Migration" bot user — created where + named what?** Recommend **lazily-created on first import**, email `system+slack-migration@bigbluebam.internal`, display_name `Slack Migration`, kind=`service`, marked `is_active=false`. Mirrors the existing helpdesk-system user pattern.

8. **Re-import behavior when target channels already exist**: skip, merge, or refuse? Recommend **the wizard handles it per-channel** — operator picks "Import as new" (with auto-renamed `engineering-2` if conflict) or "Merge into existing" or "Skip". The default is "Import as new" with a conflict warning.

9. **What happens to existing Banter channels when the import's containing project is later deleted?** With `ON DELETE SET NULL` on the project FK, the channel group becomes project-less but the channels survive. Recommend **this default** — destroying a project shouldn't accidentally destroy chat history.

---

## 14. Out of scope, tracked for follow-up

- v2: streaming-ingest mode for >100k message workspaces (current design loads each channel's day-files sequentially into memory; fine for ~10k messages per channel)
- v2: Discord / Mattermost / Teams importers (same plumbing, different parser)
- v2: incremental re-import (re-upload an updated export to catch new messages since the first import)
- v2: real-time Slack ↔ Banter sync (different architecture; not "import")
- v2: per-channel retention policy import (Slack's retention settings → Banter's `message_retention_days`)
- Slack Enterprise Grid multi-workspace exports (cross-workspace channel handling)
- E2E encrypted channels (Slack doesn't export them; would need explicit operator-supplied keys)

---

## Sign-off checklist

Before implementation starts, operator should confirm:

- [ ] §13 design forks: green-light the recommended defaults, or override
- [ ] §6 permission model: confirm admin can import (not just owner)
- [ ] §10 worker memory bound: 4 GB worker container is large enough for the streaming approach
- [ ] §4 schema additions: no objections to adding `project_id` to channel groups + the new `banter_slack_imports` table

Once those land, implementation breaks down naturally into 3-4 parallel agents:
- Agent A: schema migrations + permissions catalog
- Agent B: backend routes + service in banter-api
- Agent C: worker job + fixtures
- Agent D: frontend Slack Import card in /b3/settings
- (Optional Agent E: integration test that round-trips the fixture)

Estimated build time: **~2 weeks** with parallel agents, **~3-4 weeks** sequential.
