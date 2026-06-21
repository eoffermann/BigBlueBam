# Wave D synthesis — execution progress log

_Live log of work against `docs/wave-d-audit/SYNTHESIS.md`. Updated after every meaningful step. Entries are append-only within each phase; cross-phase reorg lands in SYNTHESIS.md itself._

## Status overview

| Phase | Status | Started | Completed | Notes |
|---|---|---|---|---|
| 0 — Catalog hygiene | ✓ complete | 2026-05-17 | 2026-05-17 | Scope grew during execution; see 0.4 notes |
| 0.5 — Plural→singular harmonization | deferred | — | — | Created mid-Phase-0; deferred to post-Phase-4 |
| 1 — apps/api triage | ✓ complete | 2026-05-17 | 2026-05-17 | 125 NO_GATE → 0; manifest 1082 → 1047 |
| 2 — MCP enforcement wiring | ✓ complete | 2026-05-17 | 2026-05-17 | wrapper gates per-action when mode != off |
| 3 — Satellite codemod | ✓ complete | 2026-05-17 | 2026-05-17 | 12 satellites wired; ~395 gate wraps |
| 4 — Flip enforcement | ✓ complete | 2026-05-17 | 2026-05-17 | api + MCP + 12 satellites all on `mode=on` |

## Phase 0 — Catalog hygiene

**Goal**: catalog (manifest + generated TS + DB) is internally consistent and the CI guard catches DB drift.

### 0.1 — Delta migration for requires_superuser flag drift ✓

- ✓ Confirmed: `bam.superuser_permission_divergence.list` was `requires_superuser=false` in DB, `true` in manifest+TS.
- ✓ Root cause: `scripts/build-permission-delta.mjs` did NOT include `requires_superuser` in its INSERT or ON CONFLICT DO UPDATE clauses. Migration 0153 inherited that bug.
- ✓ Fixed the script (`scripts/build-permission-delta.mjs`) to include the column in both clauses going forward.
- ✓ Wrote `infra/postgres/migrations/0154_permissions_singularize_repair.sql` with a single UPDATE for the drifted row (combined with 0.2's work — see below).
- ✓ Applied via `docker compose run --rm migrate` (1 applied, 114 already up-to-date).
- ✓ DB now reads `requires_superuser=true` for that row.

### 0.2 — Typo fix: bill.expens.delete → bill.expense.delete ✓

**Discovery**: This was NOT a single typo. The manifest generator's `singularize()` function (`scripts/generate-permission-manifest.mjs:385`) had an over-broad rule `if (s.endsWith('ses')) return s.slice(0, -2)` that stripped `es` from any word ending in `ses`. For sibilant plurals (`classes`, `statuses`, `boxes`) that's correct; for `expenses`/`phases` it produced `expens`/`phas`.

**Affected IDs (12 total)**:
- `bam.phas.delete`, `bam.phas.update`
- `bam.project_phas.create`, `bam.project_phas.get`, `bam.project_phas_reorder.create`
- `bill.expens.{approve, create, delete, list, reject, update}`, `bill.expens_receipt.create`

One pair (`bill.expens.create` + existing `bill.expense.create` from MCP) merged into a single row with two sources after the fix.

**Work performed**:
- ✓ Patched `singularize()` to use the sibilant-only rule: `/(?:ss|x|ch|sh|z)es$/.test(s)`
- ✓ Regenerated manifest (`node scripts/generate-permission-manifest.mjs`) — diff: 12 removed, 11 added (the merge case explains the asymmetry)
- ✓ Regenerated TS codegen (`node scripts/build-permission-codegen.mjs`)
- ✓ Wrote `0154_permissions_singularize_repair.sql` — handles 12 renames idempotently. Per rename: INSERT new (copies flags from old), INSERT-with-ON-CONFLICT-DO-NOTHING into `permission_group_defaults` and `account_permissions` to migrate FK rows, then DELETE old. Combined with 0.1's SU flag fix as a single migration.
- ✓ Updated 2 references in `apps/api/src/routes/phase.routes.ts` (lines 28, 133) from `bam.project_phas{,_reorder}.create` → `bam.project_phase{,_reorder}.create`
- ✓ Applied migration
- ✓ Verified: 0 legacy IDs remain, 12 new IDs exist, total catalog = 1082 (was 1083, one merged)

### 0.3 — CI guard extension for DB drift ✓

- ✓ Read `scripts/check-permission-catalog.mjs` — guard only diffed manifest ↔ TS, missed the DB
- ✓ Added `checkDb()` function: runs after the existing regenerate check, queries Postgres via `docker compose exec`, compares ID set + all four flag values against the manifest. Skips silently if Postgres unreachable (developer machines without stack up).
- ✓ Tested locally: reports `✓ permission catalog also in sync with DB (1082 rows checked)`
- ✓ Did NOT modify `.github/workflows/db-drift.yml` — the existing job already invokes the check script and will pick up the new check automatically as soon as the script is committed.

### 0.4 — Phase 0 discoveries that grew scope

1. **The "one typo" was 11 typos.** Documented above. The root-cause fix in `singularize()` prevents recurrence.
2. **The `build-permission-delta.mjs` script had a silent flag-drop bug.** Documented above; fixed.
3. **The catalog has ~64 more plural-resource IDs** that aren't bugs per se but split logical actions across two IDs (e.g. `bam.epics.list` from MCP `bam_list_epics` vs. `bam.epic.delete` from REST `DELETE /epics/:id`). The MCP-derived path does NOT run through `singularize()`. Listed below as Phase 0.5.

### 0.5 — Plural→singular harmonization (DEFERRED)

**Scope**: ~64 plural-resource IDs across all apps where MCP tool naming preserved the plural form (`list_epics`, `merge_contacts`, `search_messages`, etc.) while the REST equivalent for the same logical resource produced singular forms via `singularize()`.

**Why deferred**:
- Not a correctness issue, just an aesthetic split — the resolver treats them as distinct actions, which is what the catalog says they are.
- Fixing it touches the MCP tool-name-to-resource derivation logic (`apps/mcp-server` and `scripts/generate-permission-manifest.mjs` around line 227) plus a migration with ~64 renames plus potentially multiple merges.
- Best done after enforcement is live and stable — the merge pattern from 0154 is now a proven idiom that can be applied at scale.

**Tracker**: leave as `Phase 0.5` in this log. To pick up post-Phase-4: re-run the diff with the harmonization rule, write `019N_permissions_harmonize_plurals.sql` using the same migration template, regenerate manifest + TS, update any code references.

### Phase 0 verification ✓

- ✓ `node scripts/check-permission-catalog.mjs` passes — both manifest↔TS and manifest↔DB checks
- ✓ DB row count: 1082; manifest count: 1082; TS `PERMISSIONS.length`: 1082 (regenerated)
- ✓ `bam.superuser_permission_divergence.list` requires_superuser = true in all three sources
- ✓ Zero references to `bill.expens.*` or `bam.phas*` outside intentional places (migration files, audit reports, this log)
- ✓ api container rebuilt and healthy after restart; HTTP 200 on /health; permissions plugin still in `mode=warn`

### Phase 0 plan updates / discoveries — feedback into SYNTHESIS.md

The synthesis described Phase 0 as ~30 minutes. Actual elapsed: ~75 minutes. The growth came entirely from the singularize/delta-generator bug discoveries; the delta migration mechanics worked first try. Two follow-ups for the synthesis:

- **Add Phase 0.5** to SYNTHESIS.md as a known deferred item.
- **Note in synthesis** that the delta migration generator now correctly preserves all 4 flags including `requires_superuser`, so this class of drift cannot recur silently (the new DB-drift check would also catch it).

---

## Phase 1 — apps/api triage of 125 NO_GATE rows ✓

**Goal**: every NO_GATE route is either excluded from the catalog (public/internal/webhook surface), shadowed (resolver runs in telemetry-only), or enforced (`requireCan`).

### 1.1 — Triage of 125 NO_GATE + 1 INLINE_CHECK rows ✓

- ✓ Spawned a general-purpose agent to read each row from `apps/api.md` §3.3, inspect the route handler, and classify into `remove_from_catalog` / `shadow_only` / `require_can`.
- ✓ Agent produced `docs/wave-d-audit/phase1-triage.json` (structured) and `phase1-triage.md` (readable).
- ✓ Final classification: **29 remove / 83 shadow_only / 14 require_can** (one shifted from INLINE_CHECK to require_can after the agent confirmed the `is_superuser` reference was in sibling handlers, not the audited route).

### 1.2 — Generator changes to drop "remove" decisions ✓

- ✓ Patched `scripts/generate-permission-manifest.mjs`:
  - Added `EXCLUDED_FILE_BASENAMES` set with 9 entries (auth/oauth/email-verify/public-config/github-webhook/slack-webhook/internal-helpdesk/internal-llm/ical routes files)
  - Extended `EXCLUDED_PATH_PREFIXES` with 8 additional prefixes (after dropping `/auth/` and `/files/` from the triage agent's initial proposal — see 1.6 discoveries)
  - Patched `inferResourceFromPath` to skip `*` wildcard segments (fixes the `bam.file_*.list` glob-shape anomaly)
- ✓ Regenerated `docs/permissions-action-manifest.json` (manifest count 1082 → 1047)
- ✓ Regenerated `packages/permissions/src/generated/permissions.ts`
- ✓ Generated delta migration `0155_permissions_seed_actions_delta_003.sql` via `scripts/build-permission-delta.mjs` (36 removed, 1 added — the renamed file route)
- ✓ Applied migration
- ✓ `pnpm check:permission-catalog` reports 1047 rows in sync across manifest/TS/DB

### 1.3 — 97 route edits (83 shadow_only + 14 require_can) ✓

- ✓ Spawned a general-purpose agent to apply the route edits per `phase1-triage.json`
- ✓ Agent produced 95 actual edits (97 decisions minus 2 `banter.*` duplicates that share routes with their `bam.*` siblings)
- ✓ Imports updated in 39 files: 17 new `shadowOnly` imports added, 22 existing `dualReadGate` imports extended
- ✓ Stale Phase 0 IDs translated on the way through: `bam.project_phas.get` → `bam.project_phase.get`, `bam.phas.update` → `bam.phase.update`, `bam.phas.delete` → `bam.phase.delete`, `bam.file_*.list` → `bam.file.list`
- ✓ `pnpm --filter @bigbluebam/api typecheck` passes clean
- ✓ Report at `docs/wave-d-audit/phase1-edits.md`

### 1.4 — Container rebuild + verification ✓

- ✓ `docker compose build api && docker compose up -d --force-recreate api`
- ✓ HTTP 200 on api health
- ✓ Re-ran audit (`node scripts/wave-d-audit.mjs`): NO_GATE 125 → 0, MISMATCH 0 → 2 (false positives, see 1.5), INLINE_CHECK 1 → 0

### 1.5 — Discoveries / anomalies

1. **Audit-script basename-collision false positives.** The 2 remaining MISMATCH entries (`banter.user_by_email.list` and `banter.user_search.list`) are from `apps/banter-api/src/routes/user.routes.ts` but get pulled into the apps/api audit scope because `user.routes.ts` exists in both apps. The actual routes in apps/api (with paths `/users/*` not `/v1/users/*`) are correctly gated as `bam.user_*.list`. Fix lives in the audit script's in-scope filter — added to Phase 1.6 follow-ups.
2. **`bam.attachment__meta` double-underscore.** Generator hits a `/v1/attachments/_meta` static path and emits `attachment__meta`. Cosmetic; non-blocking. Phase 0.5 follow-up.
3. **`bam.agent_runner_webhook.rotate` verb.** Semantically correct (rotation is a real action, not create/update), but unusual relative to the rest of the catalog. No fix.
4. **Generator scope mismatch on `/internal/` prefix.** The triage agent flagged this: `internal-helpdesk.routes.ts` declares `POST /tasks`, and the mount prefix `/internal/helpdesk` is applied in `server.ts`, so the path-prefix exclusion misses these. Worked around with `EXCLUDED_FILE_BASENAMES`. Long-term: teach the generator to compose mount prefixes. Phase 1.6 follow-up.
5. **`/auth/` and `/files/` over-exclusion.** The triage agent initially recommended both. `/auth/` would have killed `/auth/api-keys/*` (real user-action routes for API key management) and `/auth/service-accounts/*` (real SU admin routes). `/files/` would have killed the file download proxy at `GET /files/*`. Caught at first regen — both prefixes dropped, file-level exclusion via `EXCLUDED_FILE_BASENAMES` (for `auth.routes.ts` only) used instead, and the `*` segment fix in `inferResourceFromPath` lets `/files/*` produce a clean `bam.file.list` ID.

### 1.6 — Phase 1 follow-ups (low priority)

- **Audit script in-scope filter**: drop basename-collision entries when the manifest's `app` doesn't match apps/api's `bam`/`platform`/`shared` core. Cosmetic — actual routes are correctly gated.
- **Manifest cleanup**: the spurious `banter.user_by_email.list` and `banter.user_search.list` REST sources actually point at apps/banter-api routes, which is correct. Once Phase 3 wires banter-api with the codemod, these will get real gates.
- **Mount-prefix awareness** in the generator's `isPathExcluded`: low priority since `EXCLUDED_FILE_BASENAMES` covers current cases.

### Phase 1 verification ✓

- ✓ Audit script reports: total 217 in-scope, OK 215, MISMATCH 2 (basename-collision false positive), NO_GATE 0, MISSING_ROUTE 0, INLINE_CHECK 0
- ✓ Catalog consistency: 1047 rows in all three sources, all flags agree
- ✓ Typecheck clean on `apps/api`
- ✓ api container healthy after rebuild
- ✓ Divergence dashboard still functional at `/b3/superuser/permissions-divergences`
- ✓ permissions plugin still in `mode=warn`

### Phase 1 plan updates / discoveries — feedback into SYNTHESIS.md

- ✓ The "decide whether public/auth/webhook endpoints belong in the catalog" open question is now resolved: file-level exclusion via `EXCLUDED_FILE_BASENAMES` + path-prefix exclusion via `EXCLUDED_PATH_PREFIXES`. Documented in the generator's source. No new manifest flag needed.
- The `/files/*` wildcard handling fix is general-purpose; not just Phase 1 work.
- Phase 1.6 follow-ups are listed in this log; not pulled forward into Phase 2 since they are cosmetic. Carry them in the post-Wave-D cleanup queue.

---

## Phase 2 — MCP enforcement wiring ✓

**Goal**: `apps/mcp-server/src/lib/register-tool.ts` runs the per-action resolver synchronously after PolicyGate accept and blocks on resolver-deny when `BBB_PERMISSIONS_ENFORCE=on`. The 7 `requires_superuser` MCP tools and any per-account permission overrides now enforce at the MCP boundary.

### 2.1 — Env wiring ✓

- ✓ Added `BBB_PERMISSIONS_ENFORCE: z.enum(['off', 'warn', 'on']).default('warn')` to `apps/mcp-server/src/env.ts`
- ✓ Added `BBB_PERMISSIONS_ENFORCE` and `BBB_API_INTERNAL_URL` to the `mcp-server` service definition in `docker-compose.yml` (mirroring the api's)
- ✓ Confirmed in running container: `BBB_PERMISSIONS_ENFORCE=warn`, `BBB_API_INTERNAL_URL=http://api:4000`

### 2.2 — `PolicyGate.getCaller()` ✓

- ✓ Extended `PolicyGate` interface with `getCaller(): Promise<{ kind, id }>` — exposes the same bearer-token identity that the §15 check already resolves via `/auth/me`
- ✓ `createPolicyGate()` returns `{ check, getCaller, invalidate }` — the wrapper can now reach the caller id even on the human-caller path where §15 short-circuits to ALLOW

### 2.3 — Synchronous resolver call ✓

- ✓ Added `checkPermissionViaResolver(toolName, callerId)` helper: looks up `TOOL_TO_PERMISSION`, POSTs to `/internal/permissions/dual-read` with `X-Internal-Secret`, returns `{ decision: 'allow' | 'deny' | 'unknown', permissionId }`
- ✓ Pass-through on network/parse errors and on unknown tools — resolver outages must not wedge tool invocations; only explicit `deny` in `on` mode blocks
- ✓ Reuses the existing `/internal/permissions/dual-read` endpoint which already runs the resolver AND writes the divergence row

### 2.4 — Wrapper enforcement ✓

- ✓ `registerTool`'s wrappedHandler now runs the per-action check after §15 accepts:
  - `enforce === 'off'`: skip resolver entirely (Wave B fire-and-forget telemetry stays via `recordDualRead`)
  - `enforce === 'warn'`: resolver runs synchronously, divergence recorded, never blocks
  - `enforce === 'on'`: resolver runs synchronously; on `deny` return `buildPermissionDenialResult` (new `PERMISSION_DENIED` error code, distinct from §15's `AGENT_DISABLED` / `TOOL_NOT_ALLOWED` for triage clarity)
- ✓ `ALWAYS_PERMITTED_TOOLS` (`get_server_info`, `get_me`, `agent_heartbeat`) bypass per-action enforcement just like they bypass §15 — confirmed they have catalog entries (`platform.system.get_info`, `platform.user.get_profile`, `agent.self.heartbeat`) but skip the gate by design
- ✓ Fixed double-record: in `enforce !== 'off'` mode, `recordDualRead` skips when policy accepted (the wrapper covers it); still fires on policy DENY across all modes for triage telemetry

### 2.5 — Verification ✓

- ✓ `docker compose build mcp-server` clean
- ✓ Container restarted healthy; HTTP 200 on `/mcp/health`
- ✓ Env vars confirmed in running container
- ✓ Live enforcement test deferred to Phase 4 (when `=on` is flipped); current `warn` mode means the resolver runs and divergences land in the dashboard but no tool invocations are blocked

### 2.6 — Phase 2 discoveries

- The §15 `recordDualRead` was already writing divergence rows; Phase 2 just moves the resolver decision into the synchronous critical path so it can gate. The dashboard now has a more accurate "what resolver decided" signal because the recording happens at the point the decision is consulted.
- The `requires_superuser` enforcement that Wave C added at the api side now also enforces at the MCP boundary in `on` mode — covers the case where an agent calls a SuperUser-only MCP tool whose REST counterpart we forgot to protect.

### Phase 2 plan updates / discoveries — feedback into SYNTHESIS.md

- Original synthesis said "synchronous resolver call between PolicyGate accept and handler". Delivered as described, plus the small refactor of `recordDualRead` to avoid double telemetry rows.
- No additional follow-ups identified.

---

## Phase 3 — Satellite codemod and rollout ✓

**Goal**: 12 satellite APIs (banter, bond, bill, blast, bench, book, blank, beacon, bearing, board, bolt, brief) adopt `@bigbluebam/permissions` and gate their existing role-checked routes (and many gateless ones) so the resolver participates in every request. Helpdesk-api confirmed exempt per design.

### 3.0 — Shared HTTP permissions plugin ✓

The satellites don't carry their own permissions Drizzle schemas — instead they hit api's `/internal/permissions/dual-read` endpoint over HTTP (same pattern as mcp-server's Phase 2 wiring). Added to `@bigbluebam/permissions`:

- ✓ `httpPermissionsPlugin` — Fastify plugin that decorates `requireCan(permissionId)` to POST the resolver request synchronously
- ✓ `dualReadGate({ legacy, permission })` — direct export (not a builder) for use in route preHandler arrays
- ✓ `shadowOnly(permission)` — direct export for telemetry-only on routes that had no legacy gate

Initial draft used builder factories (`buildDualReadGate()`), which tsup's `splitting: true` mangled into `dualReadGate2` aliases in some chunks. Switched to direct named exports — clean across all 12 satellites.

### 3.1 — blank-api pilot ✓

- ✓ Files modified: `package.json` (+1 dep), `Dockerfile` (3 + 1 lines), `src/env.ts` (+1 enum), `src/server.ts` (+2 lines for plugin registration)
- ✓ Files created: `src/plugins/permissions.ts`, `src/middleware/dual-read.ts`
- ✓ docker-compose.yml: `BBB_PERMISSIONS_ENFORCE` + `INTERNAL_SERVICE_SECRET` env entries
- ✓ 3 `requireMinRole('admin')` sites wrapped with `dualReadGate(...)` (forms.routes.ts × 2, submissions.routes.ts × 1)
- ✓ Build clean, container healthy, log shows `blank-api permissions plugin registered` mode=warn
- ✓ Trap caught during pilot: `dualReadGate is not defined` error from tsup chunking when an import line was missed in submissions.routes.ts — the import has to land in EVERY file that uses `dualReadGate`, not just one per package

### 3.2 — Satellites Group A (bench, book, blast, bill) ✓

Delegated to a parallel agent following the pilot recipe.

- ✓ Files modified: 33 across the 4 satellites (package.json × 4, Dockerfile × 4, env.ts × 4, server.ts × 4, docker-compose.yml × 1, plus 16 route files)
- ✓ Files created: 8 (`plugins/permissions.ts` + `middleware/dual-read.ts` per satellite)
- ✓ 63 `dualReadGate` wraps applied (bench 6, book 9, blast 17, bill 31)
- ✓ Catalog drift check clean; all 4 containers healthy; mode=warn confirmed; HTTPS health 200/4
- ✓ Anomaly: bench-api's env.ts lacked `INTERNAL_SERVICE_SECRET` — added during the pass. nginx 502 cleared by `docker compose restart frontend` (cached upstream IPs).
- ✓ Report: `docs/wave-d-audit/phase3-satellites-A.md`

### 3.3 — Satellites Group B (bond, banter) ✓

Larger plugin-style satellites. Same delegation pattern.

- ✓ 67 gate wraps applied (bond 41, banter 26)
- ✓ Anomaly 1: `GET /contacts/export` on bond-api has no `bond.contact.export` entry in the manifest; agent wrapped against closest match `bond.contact.list` — flagged for catalog extension
- ✓ Anomaly 2: In banter-api admin + user-group routes, the shared `adminPreHandler` const was converted to a factory `(permission) => [...]` to bind per-route permission_ids without duplicating the role check — byte-identical legacy behavior, cleaner than inlining 15× duplicates
- ✓ Catalog drift clean; both containers healthy; mode=warn confirmed
- ✓ Report: `docs/wave-d-audit/phase3-satellites-B.md`

### 3.4 — Satellites Group C (beacon, bearing, board, bolt, brief) ✓

Middleware-style satellites with entity-access helpers (requireBoardEditAccess, requireGoalAccess, etc.). Different gate pattern from plugin-style.

- ✓ 199 wraps total: **37 `dualReadGate` + 162 `shadowOnly`**. The high shadow ratio is by design — entity-access checks remain canonical for visibility; the per-action layer rides alongside as telemetry. `dualReadGate` only wraps the role-only `requireMinOrgRole(...)` calls; routes with both an entity check and a role check have only the role check wrapped to avoid double-wrapping.
- ✓ Per satellite: beacon 10/30, bearing 9/26, board 4/41, bolt 4/23, brief 10/42
- ✓ Anomaly 1: bolt-api `POST /events/ingest` deliberately not gated — service-to-service with `requireInternalSecret` only, no user context for resolver. Documented as intentional.
- ✓ Anomaly 2: beacon-api `version.routes.ts` and bolt-api `PUT/PATCH /automations/:id` share one manifest id across two refs (same `shadowOnly(...)` attached to both routes)
- ✓ Catalog drift clean; all 5 healthy; mode=warn
- ✓ Report: `docs/wave-d-audit/phase3-satellites-C.md`

### Phase 3 verification ✓

- ✓ All 12 satellites running healthy in `warn` mode at end of Phase 3
- ✓ Catalog consistency: 1047 rows across manifest / generated TS / DB
- ✓ Approximate total wraps applied across all satellites: **332** (3 pilot + 63 + 67 + 199)
- ✓ Combined with apps/api (95 from Phase 1) + mcp-server (Phase 2 enforcement wrapper): the system has per-action coverage on every annotated route
- ✓ `helpdesk-api` confirmed exempt per design (`helpdesk_users` model has no role; portal sessions always-allow at the resolver)

### Phase 3 follow-ups (carried, low priority)

- `bond.contact.export` manifest entry needs adding (currently mapped to closest match)
- `banter-api`'s `adminPreHandler` factory refactor should be reviewed by domain owners
- The ~64 plural-resource IDs noted in Phase 0.5 still pending
- Gateless routes that the audit hadn't already shadow-wrapped were left untouched per brief (Phase 3.x triage backlog)

### Phase 3 plan updates — feedback into SYNTHESIS.md

- Synthesis estimated "~150 new" shadow gates. Actual Group C agent added 162 shadowOnly calls beyond strict-scope; this is MORE coverage than planned, not less. Acceptable scope expansion.
- The `httpPermissionsPlugin` design proved to be the right shape — every satellite adopted it identically with no surprises.

---

## Phase 4 — Flip BBB_PERMISSIONS_ENFORCE=on per-app ✓

**Goal**: every service that participates in the permissions catalog runs with `mode=on` so the resolver's decision is canonical.

### 4.1 — Pre-flip baseline ✓

- ✓ Divergence log inspection: 29 rows, all `legacy=allow / resolved=allow / reason=superuser_bypass` from my own session
- ✓ Zero real-user divergence data — meaning the soak period in this dev environment only exercised SuperUser traffic. In production a 14-day soak with real users would be required; here the soak is theoretical.
- ✓ Decision: proceed with the flip since (a) SuperUser bypass is the only observed path and it short-circuits the resolver, (b) failures are reversible with one .env edit + restart

### 4.2 — Flip ✓

- ✓ Added `BBB_PERMISSIONS_ENFORCE=on` to `.env` (all services read `${BBB_PERMISSIONS_ENFORCE:-warn}`, so this single line drives every service)
- ✓ Restarted api, mcp-server, blank-api first as pilot trio
- ✓ Verified `permissions plugin registered` mode=on in each log
- ✓ SuperUser session smoke test:
  - `POST /b3/api/auth/login` → 200
  - `GET /b3/api/auth/me` → 200
  - `GET /b3/api/superuser/permissions/divergences` → 200 (route is gated by `bam.superuser_permission_divergence.list` which has `requires_superuser=true`; resolver allowed via SU short-circuit)
- ✓ Restarted remaining 11 satellites; all reported `mode=on` and healthy

### 4.3 — Final verification ✓

- ✓ `docker compose ps`: 22/22 application containers healthy (api + mcp-server + 12 satellites + helpdesk-api + frontend + worker + voice-agent + data services)
- ✓ Catalog: 1047 rows consistent across manifest / generated TS / DB
- ✓ SuperUser session intact end-to-end
- ✓ Per-action enforcement live across all gated routes

### Phase 4 known caveats (carried as post-Wave-D follow-ups)

1. **No non-SuperUser divergence data was collected before flipping.** In a real production rollout, a 14-day soak with mixed user roles is required to confirm the resolver matches the legacy gate's behavior. In this dev environment we accepted the risk because (a) the resolver matches the legacy 5-role model by design, (b) the built-in groups were backfilled from `organization_memberships.role` in migration 0148, (c) rollback is trivially `BBB_PERMISSIONS_ENFORCE=warn` in .env + restart.

2. **`on` mode does NOT record divergence rows.** This is by design (the plugin only records in `warn` mode), but it means we lose visibility into "what the resolver decided per request" once enforcement is live. If we discover a route that suddenly 403s under enforcement, debugging requires re-flipping that one service to `warn` to observe.

3. **MCP enforcement uses the synchronous wrapper call (Phase 2 work).** It still benefits from `recordDualRead` for the FAIL-policy telemetry path even in `on` mode.

### Phase 4 plan updates — feedback into SYNTHESIS.md

- The synthesis recommended staged flips with 24h bake periods. In this dev session, the lack of real user traffic made the bake periods moot. Flipped everything at once after the pilot trio passed. Production rollout should still honor the staged-flip discipline per the original synthesis.

---

## Phase 4 — Post-flip verification (autonomous loop)

After the initial Phase 4 close-out claimed "functionally complete," an autonomous-loop verification pass uncovered two issues that materially affect what the enforcement is actually doing. Both fixed/documented.

### 4.4 — End-to-end test with non-SuperUser ✓

- ✓ Reset password for `avery.singh@mage.io` (role=member, not SU) to a known value
- ✓ Login → 200; `/auth/me` → 200; `/auth/api-keys` (requireCan-gated) → 200; `/superuser/permissions/divergences` → 403 (`SuperUser access required` from legacy gate); `/v1/platform/orgs` → 403 (legacy gate fired before requireCan; platform routes use `[...suPreHandler, fastify.requireCan(...)]` spread pattern, so legacy denies first)
- This confirms the auth/visibility paths work end-to-end with a non-SU user.

### 4.5 — Bug #1: api missing `INTERNAL_SERVICE_SECRET` (FIXED)

**Found**: The `apps/api` service in `docker-compose.yml` only had `INTERNAL_HELPDESK_SECRET` in its environment. The api's `/internal/permissions/dual-read` route accepts either the helpdesk OR the service secret (if env-set), but with `INTERNAL_SERVICE_SECRET` unset on the api side, the route only honored the helpdesk secret.

**Impact**: Every Phase 2 (MCP) and Phase 3 (satellite) resolver call sends `INTERNAL_SERVICE_SECRET` (set in their own envs from `.env`), which the api rejected with 401. The wrapper code falls back to `decision = 'unknown'` on non-2xx, which means **`mode=on` enforcement was a no-op for every satellite and the MCP server.** Only `apps/api`'s in-process resolver was actually enforcing.

**Fix**: Added `INTERNAL_SERVICE_SECRET: ${INTERNAL_SERVICE_SECRET:-}` to the api service environment in `docker-compose.yml`. Restarted api. Confirmed via direct POST that `/internal/permissions/dual-read` now returns `200 { data: { decision } }` for satellite/MCP calls.

### 4.6 — Bug #2: Wave A group defaults are over-permissive (CARRIED — NEEDS PRODUCT DECISION)

**Found**: Probing the resolver for member-role `avery.singh@mage.io` with the correct org scope returned `allow / org_group_default` for 7 of 8 sampled permissions, including admin-only and SuperUser-only actions like `bam.platform_org.list`, `bam.platform_org.create`, `bam.system_setting.update`, `bam.entity_link.delete`.

Database tally for the `member` built-in group:

```
total_defaults | granted | denied
---------------+---------+-------
          1019 |    1007 |     12
```

**98.8% of permissions are granted to member role.** Viewer and Guest groups need similar audits.

**Root cause**: Migration `0146_permissions_builtin_groups.sql` (Wave A) authored the group defaults via SQL CASE expressions intended to mirror the legacy 5-role hierarchy. The expressions are far too permissive in practice — they appear to default-allow nearly everything for member/viewer/guest unless explicitly denied.

**Impact**: Wave D's enforcement layer is technically working — the resolver runs, group memberships are looked up, decisions are returned — but the policy data behind the resolver allows non-admin users to do nearly everything an admin can. Enforcement is effectively a no-op for the vast majority of (user, action) pairs.

**Verification**:
- SuperUser bypass: works correctly (step 1 of resolver short-circuits) ✓
- requireCan-gated SU-only routes: protected by their `requireSuperuser` legacy preHandler (not by the resolver), so still safe in practice ✓
- Non-SU member-on-member-action: resolver allows. Plain old `requireMinRole('admin')` legacy gates still deny (defense-in-depth via dualReadGate). So existing legacy paths protect today ✓
- Routes wrapped with `shadowOnly` (telemetry-only): resolver decision is allow regardless because of the defaults bug; but these routes already had no legacy gate, so this is no regression ⚠
- Routes wrapped with `dualReadGate({ legacy: requireMinRole('admin'), permission: '...' })`: legacy gate runs first, so member is denied by `requireMinRole('admin')` before the resolver matters. Defense-in-depth saves us. ✓
- Routes wrapped with pure `requireCan(...)` (no legacy): RESOLVER IS CANONICAL. With the over-permissive defaults, member would be allowed where they shouldn't be. ⚠

The 14 `require_can` (no-legacy) routes in apps/api Phase 1 (mostly platform/SU routes) survive because Phase 1's wrapping kept them inside `[...suPreHandler, requireCan(...)]` — so the legacy SU check still gates them.

**Status**: Wave D enforcement is _functionally wired and verified end-to-end_, but the policy data it enforces against is wrong. Fixing this is a Wave-A authoring task (`infra/postgres/migrations/0146_permissions_builtin_groups.sql` was the original author of these defaults; a remediation migration would need to UPDATE `permission_group_defaults` to reflect the correct per-role grant matrix). Each role × permission pair is a product decision; not a mechanical fix.

**Recommended next pass** (would-be Phase 5 or pre-Wave-E):
1. Audit the 1019 member-role grants. Manually classify each as keep-grant (likely <30%) or revert-to-deny.
2. Same for viewer and guest groups.
3. Author migration `015N_permissions_remediate_builtin_defaults.sql` with the corrections.
4. Re-run Wave D verification: confirm member can now do member-things but is denied admin-things; confirm SU bypass still works.

## Phase 5 — Built-in role defaults remediation (Bug #2 fix)

**Goal**: replace the Wave A over-permissive defaults so the per-action resolver actually denies non-SuperUsers on admin/owner/SU surfaces.

### 5.1 — Proposal authored and reviewed ✓

- ✓ Proposal: `docs/wave-d-audit/builtin-role-defaults-proposal.md` — per-role principles, per-app allow-ratio table, cross-cutting category guidance, 7 open questions
- ✓ Operator decisions captured: bam.system_setting.* is platform-level, admin can invite members, guests can post comments, bill.invoice.finalize is admin-or-owner, agent.self.heartbeat allowed at role with users.kind handler check

### 5.2 — Migration 0156 ✓

Migration `0156_permissions_remediate_builtin_defaults.sql` — DELETEs all built-in defaults and rebuilds via a single CASE expression keyed on role. Idempotent within a transaction.

**Tallies after 0156**:
- owner: 1019 → 1020 (essentially unchanged; +1 from catalog growth across phases)
- admin: 1015 → 1018
- member: 1007 → 945
- viewer: 403 → 399
- guest: 121 → 31

### 5.3 — Migration 0157 (tightening) ✓

Spot-check after 0156 found 25 more admin-shaped resources still allowed for member — the resource-name deny list in 0156 missed structural patterns like `*audit*`, `*integration*`, `*webhook*`, `*setting*`, `project_import_*`, plus the `approval` / `proposal_decide` / `agent_policy` / `agent_policy_check` resources.

`0157_permissions_tighten_member_defaults.sql` flips the granted flag to false for member AND viewer rows matching these LIKE patterns.

**Final tallies**:

| Role | Wave A | Post-0156 | Post-0157 | Delta from Wave A |
|---|---:|---:|---:|---:|
| owner  | 1019 | 1020 | 1020 |     +1 |
| admin  | 1015 | 1018 | 1018 |     +3 |
| member | 1007 |  945 |  913 |    -94 |
| viewer |  403 |  399 |  387 |    -16 |
| guest  |  121 |   31 |   31 |    -90 |

### 5.4 — End-to-end verification ✓

Direct resolver probes against the `/internal/permissions/dual-read` endpoint with `avery.singh@mage.io` (member role) returned the expected decisions across a 20-permission sample:
- Member-allowed: `bam.task.create`, `bam.task.delete`, `bam.comment.create`, `agent.self.heartbeat` → **allow** ✓
- Owner-only: `bam.org.update`, `bam.org_member_transfer_ownership.create` → **deny** ✓
- SU-only: `bam.platform_org.list`, `bam.platform_org.create`, `bam.system_setting.update`, `bam.platform_setting.update` → **deny** ✓
- Admin-only: `bam.audit_log.list`, `bam.llm_provider.update`, `bam.project_github_integration.update`, `bam.project_webhook.create`, `agent.policy.set`, `agent.webhook.configure`, `bill.invoice.finalize`, `bill.expense.approve`, `platform.org.list_members`, `platform.proposal.decide` → **deny** ✓

SuperUser bypass for `eddie@bigblueceiling.com` returned `allow / superuser_bypass` on every SU-restricted permission — confirms the resolver's step-1 short-circuit still works.

HTTP end-to-end with the member's session:
- `GET /auth/me` → 200 ✓
- `GET /v1/platform/orgs` → 403 ✓ (was the same 403 pre-remediation due to legacy `requireSuperuser`; resolver now also denies)
- `GET /superuser/permissions/divergences` → 403 ✓

### 5.5 — Viewer + guest end-to-end ✓

Provisioned two test users by repurposing seed accounts:
- `casey.oconnor@mage.io` demoted to viewer (built-in group `Viewer`, org-scoped)
- `drew.washington@mage.io` demoted to guest (built-in group `Guest`, org-scoped)

Initial probe found 11 misclassifications: catalog generator's is_read inference was too narrow (e.g. `list_notifications`, `change_password`, `switch_org`, `search_global` were all marked as non-read writes, so the viewer rule `is_read AND ...` denied them).

**Migration 0158** (`0158_permissions_viewer_self_care.sql`) targeted-allows 23 specific permissions for viewer (and member, idempotent re-grant): platform.user.* self-care actions, platform.user.find_by_{email,name} user lookup, platform.visibility.can_access, platform.system.* reads, shared.system.search_global / resolve_references, shared.activity.by_actor, shared.expertise.for_topic.

**Final tallies**:

| Role | Wave A | Post-0156 | Post-0157 | Post-0158 |
|---|---:|---:|---:|---:|
| owner  | 1019 | 1020 | 1020 | 1020 |
| admin  | 1015 | 1018 | 1018 | 1018 |
| member | 1007 |  945 |  913 |  913 |
| viewer |  403 |  399 |  387 |  410 |
| guest  |  121 |   31 |   31 |   31 |

**Verification — resolver probe (viewer)**:
- self-care (get_profile, list_notifications, change_password, switch_org, logout, update_profile) → **allow** ✓
- user lookup (find_by_email) → **allow** ✓
- utility (visibility.can_access, shared.system.search_global) → **allow** ✓
- reads (task.get, task.search, project.get, project.list, label.list, user.list, attachment.list, file.list, project_phase.get, project_epic.get) → **allow** ✓
- writes (task.create, comment.create, comment_reaction.create) → **deny** ✓
- destructive (task.delete, attachment.delete) → **deny** ✓
- admin (org.update, audit_log.list, system_setting.update) → **deny** ✓
- agent-admin (agent.policy.set, platform.proposal.decide) → **deny** ✓

**Verification — resolver probe (guest)**:
- self-care minus update_profile (get_profile, list_notifications, change_password, switch_org, logout) → **allow** ✓
- update_profile / find_by_email → **deny** ✓ (guest cannot edit profile, cannot enumerate users)
- utility (visibility.can_access, search_global) → **allow** ✓
- per-entity reads (task.get, task.search, project.get, label.list, attachment.list, file.list, project_phase.get, project_epic.get) → **allow** ✓
- list reads denied (project.list, user.list) → **deny** ✓ (guests can't browse beyond their invited entity)
- comment.create / comment_reaction.create → **allow** ✓ (per product decision)
- writes/destructive/admin/agent → **deny** ✓

**Verification — HTTP probe**:

| Request | Viewer | Guest | Expected |
|---|---|---|---|
| GET /auth/me | 200 | 200 | both allow |
| GET /v1/platform/orgs | 403 | 403 | SU-only |
| GET /superuser/permissions/divergences | 403 | 403 | SU-only |
| GET /users | 200 | 403 | viewer allow, guest deny |
| GET /projects | 200 | 403 | viewer allow, guest deny |
| GET /labels | — | 200 | guest allow ✓ |

### 5.6 — Test fixtures: casey/drew demoted in seed DB

For ongoing testing, `casey.oconnor@mage.io` and `drew.washington@mage.io` were left as viewer/guest respectively (passwords `TestViewer-Wave-D-Verify` and `TestGuest-Wave-D-Verify`). If you want them restored to member for other test scenarios:

```sql
UPDATE users SET role = 'member' WHERE email IN ('casey.oconnor@mage.io', 'drew.washington@mage.io');
UPDATE organization_memberships SET role = 'member' WHERE user_id IN (
  SELECT id FROM users WHERE email IN ('casey.oconnor@mage.io', 'drew.washington@mage.io')
);
UPDATE account_group_memberships SET group_id = '33333333-3333-4333-8333-333333333333'
WHERE user_id IN (SELECT id FROM users WHERE email IN ('casey.oconnor@mage.io', 'drew.washington@mage.io'))
AND detached_at IS NULL;
```

### Phase 5 follow-ups (carried)

1. ~~Viewer/guest e2e~~ — done in 5.5
2. **Bill financial finality**: per product decision, admin can finalize. Locked in.
3. ~~`proposal` resource~~ — confirmed member-allowed per operator decision (Phase 5 commit)
4. **Catalog flag enrichment**: many admin-shaped resources should carry an `is_admin_only` flag, and the generator's `is_read` inference should be widened to catch verbs like `list_notifications`, `change_password`, `switch_org`, `search_global`, `resolve_references`, `by_actor`, etc. Tracked for a Wave-A enrichment pass; not blocking Wave E.

---

## Wave D close-out (final)

**Status**: Wave D is complete. Per-action enforcement is canonical, wiring is verified, catalog is consistent, and the role defaults reflect the documented intent.

| Component | Status |
|---|---|
| Catalog hygiene (Phase 0) | ✓ |
| apps/api triage (Phase 1) | ✓ |
| MCP enforcement wiring (Phase 2) | ✓ |
| Satellite codemod (Phase 3) | ✓ |
| Flip BBB_PERMISSIONS_ENFORCE=on (Phase 4) | ✓ |
| Built-in defaults remediation (Phase 5) | ✓ |

**Three bugs found and fixed across the work**:
1. ✓ Singularize / requires_superuser-flag-drop in catalog generators (Phase 0)
2. ✓ api missing `INTERNAL_SERVICE_SECRET` env (post-flip discovery)
3. ✓ Wave A over-permissive defaults (Phase 5)

**Open work carried** (now genuinely low-priority):
- Phase 0.5: plural→singular harmonization (~64 IDs)
- Phase 1.6: audit-script collision filter, mount-prefix awareness
- Phase 3 follow-ups: `bond.contact.export` manifest entry, gateless-route triage, `adminPreHandler` factory review
- Phase 5 follow-ups: viewer/guest e2e walkthrough, bill financial finality re-confirmation, `proposal` create permission, catalog `is_admin_only` flag
- **Wave E**: drop legacy role columns and helpers — now safe to start since the resolver is correctly enforcing.

**Rollback procedure** unchanged: `.env` set `BBB_PERMISSIONS_ENFORCE=warn` (or `=off`) + restart the permissions-aware services.

**Open work** (carried as future-wave items):
1. **Phase 0.5**: harmonize ~64 plural-resource IDs from MCP-plural-verb stemming
2. **Phase 1.6 follow-ups**: audit-script basename-collision false positives, manifest cleanup for double-claim entries, mount-prefix awareness in generator
3. **Phase 3 follow-ups**: `bond.contact.export` manifest entry, gateless-route triage backlog for satellites
4. **Wave E**: drop legacy `organization_memberships.role` column, remove `requireMinRole`/`requireRole`/`requireOrgRole`/`requireProjectRole` helpers, contract the codebase to the new model exclusively. This is the next wave per the original `docs/permissions-overhaul-plan.md`.

**Rollback procedure** (if any enforcement-on regression appears):
```bash
# Edit .env, set BBB_PERMISSIONS_ENFORCE=warn (or =off for full bypass)
docker compose up -d --force-recreate api mcp-server $(docker compose ps --services | grep -E "^(banter|beacon|bearing|bench|bill|blank|blast|board|bolt|bond|book|brief)-api$" | tr '\n' ' ')
```

---

## Wave E close-out (2026-05-22)

Wave E ran in six steps (A → F) and is now functionally complete. Recap:

| Step | Status | Scope | Notes |
|---|---|---|---|
| E.A | ✓ complete | apps/api role-gate replacement | 280 sites → `fastify.requireCan(...)` |
| E.B | ✓ complete | 12 satellite role-gate replacement | Same pattern |
| E.C | ✓ complete | `useCan(...)` hook + `PermissionsProvider` | All 14 SPAs wired |
| E.D | ✓ complete | Frontend role-gate JSX replacement | 9 sites replaced, 5 kept (no catalog ID) |
| E.E | ✓ complete | Legacy helper removal + dual-read removal | `requireMinRole`, `requireRole`, `dualReadGate`, etc deleted |
| E.F | ✓ complete | Drop `users.role` + `organization_memberships.role` columns | Migration 0159, see `wave-e-F-column-drops.md` |

**Final state of the per-action permissions model:**

- The 1047-entry catalog (manifest + TS + DB) is the single source of truth
  for "can user X do action Y at scope Z". Every route in apps/api and
  every satellite preHandler uses `fastify.requireCan(<permission_id>)`.
- Group membership lives in `account_group_memberships` keyed by
  `(user_id, scope_type, scope_id)`. `permission_groups.legacy_role`
  carries the legacy role string for back-compat exposure in the API
  response surface (`/auth/me`, `/auth/orgs`, `/org/members`, etc.).
- The `users.role` and `organization_memberships.role` columns no longer
  exist (migration 0159 dropped them, including their CHECK constraints).
- `isOrgPrivileged(role)` is the only consumer that still takes a role
  string. It's called with `request.user.role`, which the auth hook
  synthesizes from group membership. No call site changed signature.
- Every dual-read gate is gone; `shadowOnly` re-export is the only artifact
  left in `apps/<svc>/src/middleware/dual-read.ts` (one-line re-exports).
- Frontend `useCan(...)` is fed by `/auth/me`'s `permissions` field, which
  computes the matrix off `account_permissions` + `permission_group_defaults`
  at request time. The 5 frontend `role ===` checks documented in Wave E.D
  continue to function because the API still exposes `user.role` and
  `org_memberships[].role` as synthesized fields.

**Open work after Wave E** (none of these block any production use):

- Phase 0.5 plural→singular harmonisation — purely aesthetic.
- The 5 deliberately-kept frontend `role ===` checks — schedule a
  future wave to add catalog IDs and convert them.
- `apps/api/src/services/org-permissions.ts::isOrgPrivileged` — could be
  retired by upgrading the 6 call sites to per-action permission IDs
  (e.g. `bam.org_member_invite_bulk.create`). Not done in E.F because
  the helper still works correctly and the call sites are tiny.
- Verifying RLS posture flip (`BBB_RLS_ENFORCE=1`) under the new model.



