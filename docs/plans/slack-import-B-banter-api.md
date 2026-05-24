# Slack Import — Agent B (banter-api routes + service)

## Scope completed

HTTP surface + service layer for the Slack workspace import flow, landing in
`apps/banter-api`. Six endpoints under `/v1/admin/import/slack/`, each gated
by `fastify.requireCan('banter.admin_import.*')`. Worker enqueue stub plus
durable status row writes; no worker code touched (Agent C scope).

## Files changed

- **NEW** `apps/banter-api/src/routes/slack-import.routes.ts` — 6 endpoints
  (upload, preview, start, status, list, delete) per the design doc §9.
- **NEW** `apps/banter-api/src/services/slack-import.service.ts` — MinIO
  helpers, fast-scan `buildPreview()`, `loadImportRow()`, `validateMapping()`,
  BullMQ queue init (`slack-import` queue, jobs named `import-<id>`), and
  the `banter:import:cancel:<id>` Redis publish for abort signalling.
- **NEW** `apps/banter-api/src/db/schema/slack-imports.ts` — Drizzle table
  decl matching migration `0165_banter_slack_imports.sql`.
- **NEW** `apps/banter-api/test/slack-import.routes.test.ts` — 17 unit tests
  covering `validateMapping`, the start-body Zod schema, the cleanup_stubs
  query coercion, the slack-import object key helper, and a wiring sanity
  check on permission IDs.
- **MOD** `apps/banter-api/src/server.ts` — registered the new routes.
- **MOD** `apps/banter-api/src/db/schema/index.ts` — exported
  `banterSlackImports`.
- **MOD** `apps/banter-api/src/env.ts` — added
  `BANTER_SLACK_IMPORT_MAX_BYTES` (default `5_368_709_120` = 5 GB).
- **MOD** `apps/banter-api/package.json` — added `node-stream-zip@^1.15.0`.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @bigbluebam/banter-api typecheck` | clean |
| `pnpm --filter @bigbluebam/banter-api test` | 9 files, 167 tests, all pass (17 new) |
| `docker compose build banter-api && up -d --force-recreate banter-api` | success |
| `curl https://localhost/banter/api/health` | 200 |

## Live-stack smoke (eddie SU)

- `GET /v1/admin/import/slack/` → `{"data":[]}` (200) then after uploads
  returns the two test rows
- `POST /v1/admin/import/slack/upload` with the 868-byte test export →
  201 `{import_id, preview:{channels_detected:1, users_detected:1, messages_estimated:50, workspace_name:"slack-workspace", dms_detected:0}}`
- `GET /v1/admin/import/slack/:id/preview` → full users + channels (200)
- `GET /v1/admin/import/slack/:id/status` → row including `status:"pending"`,
  `progress_total:50` (200)
- `POST /v1/admin/import/slack/:id/start` with missing user mapping → 400
  with detailed `{field, issue}` validation entries
- Same with full mapping → 202 `{import_id, status:"queued"}`
- Re-`POST /start` on a queued row → 409 `INVALID_STATE`
- `DELETE /v1/admin/import/slack/:id` → 200 `{aborted:true, deleted:{...}}`
- `DELETE …?cleanup_stubs=true` → 200, same envelope; row flips to `status:"aborted"`

## Live-stack smoke (avery member — should be denied)

All six endpoints return **HTTP 403** with the resolver-driven envelope
`{"error":{"code":"PERMISSION_DENIED","message":"Permission denied: banter.admin_import.<verb>","details":[{"permission_id":"…"}]}}`.

This was verified after the env clears any prior lockout for the avery
account. The banter-api permissions plugin runs in `on` mode (confirmed
from container startup log: `mode: on, msg: banter-api permissions plugin
registered`), so the resolver-deny path is exercised end-to-end.

## Anomalies / sharp edges

1. **PowerShell `Compress-Archive` produces zip entries with backslashes**
   that `node-stream-zip` rejects as "Malicious entry". This is purely a
   test-rig issue (real Slack exports use forward slashes); documented here
   so future testers don't waste time chasing it. The fix in test code is
   to build the zip via `System.IO.Compression.ZipFile.CreateEntryFromFile`
   with `\\` → `/` rewrites.

2. **UTF-8 BOM tolerance**: `JSON.parse` rejects a leading BOM silently
   inside our helper, which dropped channel/user counts to zero during
   initial smoke (the first export.zip I built via `Set-Content -Encoding
   utf8` carried a BOM on every json file). `buildPreview()` now strips a
   leading `﻿` before parsing — this matches Slack's actual exports
   (no BOM) but tolerates the common Windows-authored fixture case.

3. **Date binding via raw `sql` template**: postgres-js's tagged-template
   bind path does NOT accept `Date` instances natively in `db.execute()`
   for some queries — surfaced as `TypeError: The "string" argument must be
   of type string... Received an instance of Date` from the `cleanup_stubs`
   path. Worked around by ISO-stringifying and casting `::timestamptz` on
   the SQL side. Drizzle's typed helpers don't have this problem; the raw-
   `sql` path used in the abort transaction does.

## Boundaries respected

- Did NOT modify any worker code (Agent C scope).
- Did NOT touch the frontend (Agent D scope).
- Did NOT edit existing migrations or write new ones. Did create the
  matching Drizzle declaration for `banter_slack_imports` since Agent A
  shipped the migration but hadn't yet added the Drizzle schema — this was
  blocking my service code, and falls within the design doc spec.
- Did NOT add Drizzle decls for the `banter_messages` / `banter_message_*`
  metadata column changes from migration 0167 — used raw `sql` in the abort
  transaction instead, sidestepping the schema churn. Agent A may want to
  enrich those Drizzle decls later for typed access from the worker.

## Things the synthesis pass should check

1. The Bam-side `/b3/settings` UI (Agent D's scope) must POST multipart to
   `/banter/api/v1/admin/import/slack/upload`. The Bam frontend's existing
   `apiClient` mostly targets `/b3/api/...` — make sure the cross-app path
   works through nginx (it should: nginx proxies `/banter/api/` to the
   banter-api container).

2. `banter.admin_import.*` permissions resolved correctly in `on` mode for
   eddie (allowed) and avery (denied) on the live stack. This implicitly
   confirms migration 0168 / 0169 (Agent A's permission catalog + role
   defaults work) — if Agent C or D sees `PERMISSION_DENIED` for an admin,
   first re-run the permission seeders.

3. The BullMQ enqueue currently fails silently if the queue connection
   is unavailable (returns `null` from `enqueueSlackImport`). The design
   doc §10 expects the worker to have a startup reconciler that picks up
   `status='queued'` rows whose `bullmq_job_id` is null. Agent C owns
   building that reconciler.

4. The upload endpoint buffers the entire .zip in memory to compute the
   preview. For very large workspaces (multi-GB) this becomes painful.
   The design doc §1 Step 1 explicitly favors a fast metadata-only scan;
   long-term we may want to stream the upload straight to MinIO and pull
   only `channels.json` + `users.json` back via S3 ranged GETs. v1 ships
   with the simpler buffer-then-scan; raise `BANTER_SLACK_IMPORT_MAX_BYTES`
   and ensure adequate node-memory headroom for now.
