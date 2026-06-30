# BigBlueBam Blip — Implementation Decisions Log

This document tracks each material change and decision made while implementing
the Blip telemetry app from `BigBlueBam_Blip_Design_Document.md`. It is appended
to as work proceeds, newest section last. Each entry records the decision, the
reason, and any deviation from the spec (with why).

**Branch:** `feat/blip` (off `main`).
**Spec:** `docs/plans/BigBlueBam_Blip_Design_Document.md`.
**Started:** 2026-06-30.

---

## 0. Environment baseline (probed at start)

- **Docker:** v29.5.2 / Compose v5.1.3 installed. Docker Desktop daemon was NOT
  running at start; launched it and am polling for readiness. Local docker dev
  build + live screenshot generation are gated on the daemon being up.
- **Toolchain:** Node v24.15.0, pnpm 9.15.4. Root + per-app `node_modules`
  already installed.
- **Repo state:** `main`, `feat/bin`, `stable` all at `689cdf8c` at start. Doc
  work (design doc + CLAUDE.md refresh) committed to `main` as `ea9cbaf7` and
  pushed before branching `feat/blip`.

## 1. Scaffolding template

- **Decision:** Mirror `bay-api` / `bay` as the structural template (most recent
  satellite app; shares the closest shape — assets, WebSocket, public
  token-gated route, `@bigbluebam/storage`, `bbb-refs` peer stubs). bin-api is
  the secondary reference for the storage + structured-data handoff.
- **Port:** `4018` (4016 bin-api, 4017 bay-api confirmed taken).

## 2. Technical decisions discovered during priming

- **blip_entries partitioning:** created partitioned from the start
  (`CREATE TABLE blip_entries (...) PARTITION BY RANGE (received_at)` + a DEFAULT
  partition + monthly partitions for a window + the next 12 months), which is
  simpler than banter_messages' convert-in-place dance (migration 0124). The
  monthly-partition `format(...) EXECUTE` loop from 0124 is the template for the
  `blip-partition-provision` worker.
- **Permissions are GENERATED, not hand-authored.** `scripts/generate-permission-manifest.mjs`
  scans `apps/mcp-server/src/tools/*` (`registerTool` names) and `apps/*/src/routes/*`
  (route declarations) and infers `<app>.<resource>.<verb>` ids. So `blip.*`
  permissions are produced by naming MCP tools `blip_<resource>_<verb>` and routes
  consistently, then running: generate-manifest -> build-permission-delta (emits
  the next `0219_permissions_seed_actions_delta_018.sql`) -> build-permission-codegen.
  READ_VERBS / DESTRUCTIVE_VERBS drive is_read / requires_confirmation flags
  automatically. Consequence: the permissions migration is downstream of the
  routes + MCP tools, not a prerequisite.
- **Next migration numbers:** tip is `0218`. Blip core schema starts at `0219`
  (NOTE: if the permission delta also lands it will contend for a number; allocate
  Blip schema migrations first, run the permission delta generator last so it
  picks the next free number).
- **Next-free port confirmed 4018** (0210_bay_core + compose show bay-api on 4017).

---

## 3. Build sequence + deviations

- **Scaffolding cloned from bay-api/bay** then domain files rewritten. Kept
  verbatim: Dockerfile shape, env.ts, the 3 plugins (auth/permissions/redis),
  db/index.ts, bbb-refs.ts. Renamed bay->blip, port 4017->4018.
- **Schema JS keys are snake_case** (`org_id`, `tracked_app_id`), matching the
  bay template, NOT the camelCase the design doc used in illustration. db-check
  compares the SQL column name (string arg) only, so this is cosmetic and keeps
  services consistent with the rest of the satellite.
- **Core libs written first** (the spec-critical heart): `predicate.ts`
  (recursive AND/OR tree -> SQL + in-memory eval), `transform.ts` (edge PII
  redaction), `ingest-keys.ts` (token mint/parse + constant-time HMAC),
  `rate-limit.ts` (Redis Lua token bucket), `watch-eval.ts` (match fire +
  window reservoir bump), `broadcast.ts` (tail channels), `storage.ts` (capture
  keys), `queue.ts` (BullMQ producers), `send-error.ts`.
- **Hot path** (`ingest.service.ts` + `ingest.routes.ts`) and **query engine**
  (`entry.service.ts`) written directly (tie the libs together, spec-critical).
- **Migrations:** `0219_blip_core.sql` (9 non-partitioned tables) +
  `0220_blip_entries_partitioned.sql` (partitioned store + `blip_entry_seq`,
  `seq` defaults to `nextval` so any insert path gets a monotonic cursor; level
  CHECK enum; GIN jsonb_path_ops). Partitions: now-2mo .. now+12mo.
- **Shared queue contract** added to `packages/shared/src/queues.ts`
  (BLIP_INGEST/EXPORT_JSONL/TIMELAPSE/FIELD_INDEX) so api producers and worker
  consumers can't drift.
- **Parallelization:** after the contract layer, the remaining well-templated
  slices were fanned out to agents with disjoint file ownership (backend routes
  A/B, worker C, mcp E, infra F, platform G, frontend D, seeder+docs H), then
  integrated and built centrally.

## 4. Integration + deploy results

- **8 parallel agents delivered** all slices. Integration typecheck results on
  first pass: blip-api **clean** (one self-inflicted bucket-shape fix), and
  mcp-server / bench-api / api / bolt-api all **clean** (platform + MCP agents
  integrated with zero errors). Frontend: 1 error (a Python RST `` ``report_type`` ``
  double-backtick colliding with the JS template literal in client-snippets.tsx)
  — fixed. Worker: 14 strict-null/implicit-any errors — fixed by the worker agent.
- **Field-index job correction:** `CREATE INDEX CONCURRENTLY` is not allowed on a
  partitioned parent; switched to a plain `CREATE INDEX IF NOT EXISTS ... ON
  blip_entries ((payload->>'field'))` which Postgres cascades to partitions.
- **Migrations applied** (0219/0220/0221): `blip_entries` is partitioned (15
  monthly partitions + default), both Bench rollup MVs registered in
  `bench_materialized_views` at `*/5`.
- **Permissions:** added `blip` to APP_PREFIXES + an EXPLICIT_TOOL_OVERRIDES block
  so the 38 MCP tools map to the canonical 30 `blip.<resource>.<verb>` ids (§16),
  matching the routes' `requireCan` ids. Generated delta `0222` (30 added, 0
  removed); applied; 30 rows in `permissions WHERE app='blip'`.
  Note: `blip.view.share` (in §16) has no tool/route so it is intentionally not
  in the catalog.
- **CI guards green:** lint:migrations (184 files, 0), check-bolt-catalog (148
  pairs OK), check-permission-catalog (artifact + DB), help:index (blip indexed).
- **Railway config** regenerated (`railway/blip-api.json` + 12 nginx refs).

## 5. Live deploy + screenshot findings (fixes)

- **Full stack was already up.** Applied migrations via `docker compose run --rm
  migrate`; built + started `blip-api` (healthy on 4018); rebuilt `frontend`
  (picks up nginx `/blip/*` routes + the baked SPA).
- **End-to-end verified through nginx:** `/blip/` -> 200 (SPA), `/blip/api/v1/apps`
  -> 401 (proxied auth), `/blip/ingest/v1` -> 401 INVALID_KEY (public edge).
- **Seeder ran clean:** 2 apps, ~4,800 entries, 45/39 catalog fields, 14 views,
  4 watches, 6 keys, 2 firings, rollups refreshed — and the **live ingest path
  passed 5/5 (202)** against the real blip-api, proving key-resolve -> HMAC ->
  rate-limit -> transform -> tail -> enqueue end to end.
- **Screenshot capture** authored `packages/docs-capture/recipes/blip/blip.yaml`
  (11 screens) and ran the docs-capture CLI as the Gilligan admin (skipper,
  `DOCS_CAPTURE_PASSWORD=Castaway2026!`): 11/11 captured, 0 failed.
- **Bug found + fixed via screenshot analysis (the value of the capture pass):**
  1. Recipe `/blip` (no trailing slash) fell through nginx to the marketing site
     -> changed to `/blip/`.
  2. **`/v1` prefix mismatch:** the frontend api-client base URL was `/blip/api`
     but the backend routes mount under `/v1`, so data calls 404'd ("Could not
     load app — Route GET /apps/<id> not found"). Fixed the base URL to
     `/blip/api/v1` (one line; covers every REST hook). The static Client-setup
     page (no data) rendered perfectly throughout, confirming SPA/auth/layout/
     §18.3 snippets were correct; only data pages were affected. Rebuilt frontend
     + re-captured.

## 6. Data-correctness bug caught in verification (seeder payload)

- **Symptom:** `jsonb_typeof(payload)` was `string` for all 4,806 bulk-seeded
  entries (only the 10 live-ingest rows were objects). The promoted columns are
  separate, so the viewer rendered fine, but `payload->>'field'` queries + the
  GIN index were dead on seeded rows, and the `_seed='gilligan'` idempotency
  guard always missed (so re-runs would have duplicated).
- **Root cause:** `scripts/seed-gilligan/blip.mjs` inserted
  `${JSON.stringify(r.payload)}::jsonb` — postgres-js re-serialized the already
  stringified string into a JSON *scalar*. Fixed to `${tx.json(r.payload)}` (the
  correct postgres-js jsonb idiom).
- **Verified after re-seed:** all 4,826 payloads are `object`; `_seed` reachable
  (4,806); field-path query works (1,459 rows have a `fn` field); re-run is now
  idempotent ("already seeded, skipping backlog").

## 7. Launchpad + commit notes

- **Launchpad:** added Blip to the catalog (`LAUNCHPAD_APP_IDS` + `LAUNCHPAD_CATALOG`
  in `apps/api/src/routes/system-settings.routes.ts`: id `blip`, icon `activity`,
  color `#0891b2`, path `/blip/`) and mapped the `activity` icon in
  `packages/ui/launchpad.tsx`. Per a follow-up request, also made the Launchpad
  render apps **alphabetically by display name** (a render-time sort in
  `launchpad.tsx`). Verified live: catalog returns 19 apps incl. Blip, enabled,
  and the captured Launchpad screenshot shows alphabetical order with Blip between
  Blast and Blueprint.
- **help-index CRLF tooling quirk (local-only, pre-existing):** `help:check` flags
  all non-blip apps as STALE on this Windows checkout because
  `scripts/help/build-help-index.mjs` produces empty indexes from CRLF `help.md`
  files (autocrlf), while blip's LF `help.md` builds correctly (toc:26, matches).
  On CI (Linux/LF) the committed indexes are valid. Non-blip indexes were restored
  to HEAD (unchanged); only `docs/apps/blip/help-index.json` is committed. Tracked
  as a latent cross-platform tooling issue in build-help-index.mjs (CRLF handling).

_(entries appended below as implementation proceeds)_
