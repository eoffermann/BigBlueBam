# Bursar - Work In Progress

**App:** Bursar (`bursar`) | **API:** `bursar-api` internal `:4023` | **SPA:** `/bursar/`, dev `:3023`
**Spec:** `docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md` (BUILD-READY, three adversarial hardening rounds)
**Branch:** `suite-brainstorm` (feature branches off it; never merged to `main` by the build)
**Session stamp:** `2026_07_19_20_05`

Bursar is the vendor-side half of the money story. Bill, Burn, and Bulwark all sit on the side where a
customer pays us or a counterparty has already signed. Bursar sits on the side where **we** pay a vendor,
and it works on documents nobody has signed yet: inbound quotes, bids, and proposals. It derives one
canonical scope tree from the buyer's own request, normalizes every incompatible inbound offer onto that
tree, and produces **the exclusion diff**: the scope items present in your request but conspicuously
**absent** from a given offer, each cited back to the line that should have covered it. When you award,
it freezes the accepted tree as an immutable baseline recording both what you got and what you knowingly
did not get, then keeps watching real spend against that baseline for price drift, scope divergence,
unbaselined vendors, and renewal cliffs. The whole product claim is that a gap is *reported*, which is
why the diff-completeness invariant (spec section 4.7) is load-bearing rather than cosmetic.

---

## Status legend

| Mark | Meaning |
| --- | --- |
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done, verified against the stated acceptance check |
| `[!]` | Blocked, see the note beneath the item |
| `[-]` | Deliberately skipped, with a written reason beneath the item |

## Progress at a glance

| Milestone | Title | Status |
| --- | --- | --- |
| M0 | Scaffold, infrastructure, and the nginx ordering gate | `[x]` |
| M1 | Migrations, Drizzle schema, and the generated RLS loop | `[ ]` |
| M2 | Vendors, payee resolution, requests, settings, Bin asset access | `[ ]` |
| M2.5 | The absence spike, classifier in the loop | `[ ]` |
| M3 | Scope derivation and the confirmed tree | `[ ]` |
| M4 | Offer ingest and deterministic parse | `[ ]` |
| M5 | The absence engine and the coverage-collapse cluster | `[ ]` |
| M6 | Matrix, Diff, review queue, realtime, help content | `[ ]` |
| M7 | Award, baseline freeze, immutability | `[ ]` |
| M8 | Spend, detectors, mismatch inbox, renewal radar, worker jobs | `[ ]` |
| M9 | Permission chain, MCP parity, catalogs, docs, seed, e2e, close-out | `[ ]` |

**Standing rule for every milestone.** Each milestone ends with: commit the work in coherent steps, push
the branch, run the `post-commit-review` skill (ci-watchdog, security-analyst, stability-reviewer,
best-practices-reviewer in parallel), and fix every issue they file with the `automated-review` label
**before** starting the next milestone. Pre-existing problems found along the way get recorded as tasks,
never waved away.

---

- [x] **M0 - Scaffold, infrastructure, and the nginx ordering gate**

  M0 exists to make a Bursar-shaped hole in the running suite without breaking the suite. It comes first
  because everything downstream needs a container that boots, a route that resolves, and a database that
  has connection headroom. It carries the single most dangerous step in the whole build: the nginx
  `location` blocks. The compose-mounted config has **no `resolver` directive**, so nginx resolves every
  `proxy_pass` upstream **at config load**. Pointing a `proxy_pass` at `bursar-api:4023` before that
  container exists makes nginx exit at startup with "host not found in upstream", which takes the
  frontend container down and makes **every app in the suite** unreachable, not just Bursar.
  `depends_on: condition: service_started` does not save you, because a never-built or crash-looping
  container still yields NXDOMAIN. M0 is also the slow milestone: `/bursar/` cannot serve until
  `docker compose build frontend` runs, which rebuilds all 23 SPAs, because the SPA dist is **not**
  bind-mounted (only nginx templates, `./docs/apps`, avatars, and certs are).

  - [x] Create `apps/bursar-api/` from `apps/burn-api/`'s skeleton: `package.json` (`@bigbluebam/bursar-api`), `tsconfig.json`, `src/server.ts` modeled on `burn-api/src/server.ts:56-178` (error handler, graceful shutdown, `/v1` mount at `:138-151`, internal routes registered outside the session gate at `:135-137`), `src/env.ts`, and `@bigbluebam/service-health` registering exactly `/health`, `/health/ready`, `/metrics`. Readiness checks **Postgres and Redis only**, never the LLM proxy or braid-api.
  - [x] Create `apps/bursar-api/Dockerfile` modeled on `apps/burn-api/Dockerfile`.
  - [x] Create `apps/bursar/` SPA scaffold from `apps/burn/` and `apps/blip/`: React 19, TanStack Query v5, Zustand, Tailwind v4, Radix.
  - [x] `apps/bursar/vite.config.ts`: set `base: '/bursar/'` (without it Vite emits `/assets/...` absolute paths, every asset 404s against the shared regex, and the symptom looks like an nginx bug), `server.port: 3023` (burn holds 3022), and dev proxies for `/bursar/api` and `/bursar/ws` to `localhost:4023`.
  - [x] Copy **every** `@bigbluebam/ui/*` alias from `apps/burn/vite.config.ts` verbatim. Burn carries twelve: `launchpad`, `org-switcher`, `notifications-bell`, `help-center`, `user-menu`, `sidebar-footer`, `help-viewer`, `markdown`, `presence-chip-strip`, `impersonation-banner`, `permissions-context`, `use-can`, plus the `@` -> `src` alias. The one that bites is `@bigbluebam/ui/markdown`, imported by `packages/ui/help-center.tsx:39` and `help-viewer.tsx:17`; because the frontend Dockerfile chains builds with `&&`, one unresolved alias breaks the **entire** frontend image. Rule is "copy them all", never a count.
  - [x] Add the `bursar-api` service to `docker-compose.yml` (internal `:4023`, `depends_on` postgres/redis/migrate, env per section 18.3) and register the SPA build.
  - [x] **Ordering step 1 of 3:** `docker compose build bursar-api && docker compose up -d bursar-api`.
  - [x] **Ordering step 2 of 3:** confirm the container is actually RUNNING, not restarting: `docker compose ps bursar-api` shows `running`, and `docker compose exec bursar-api wget -qO- http://localhost:4023/health` returns 200. Do not proceed on a crash-looping container.
  - [x] **Ordering step 3 of 3, only now:** add `location /bursar/`, `location /bursar/ws`, `location /bursar/api/` and the string `bursar` in the shared static-asset regex to all three files: `infra/nginx/nginx-with-site.conf` (regex at line 835, this is the one compose mounts at `docker-compose.yml:355`), `infra/nginx/nginx.conf` (regex 766, bare `docker run` profile, not mounted by compose), and `infra/nginx/nginx.railway.conf` (regex 975, using `set $rw_upstream_N "bursar-api.railway.internal"` plus `rewrite`). Do **not** modify `client_max_body_size`.
  - [x] Recreate the frontend: `docker compose up -d --force-recreate frontend`.
  - [x] **M0 nginx gate:** `docker compose exec frontend nginx -t` prints `syntax is ok` / `test is successful`.
  - [x] **Rollback rehearsal noted in the commit message:** if the frontend goes down, run `git checkout infra/nginx/` and `docker compose up -d --force-recreate frontend` **before** debugging bursar-api. The outage is the config, not the app.
  - [x] Four edits to the frontend Dockerfile, no fifth: (1) deps-stage `COPY apps/bursar/package.json ./apps/bursar/` at burn's `:25`; (2) the `src`, `public`, `index.html`, `tsconfig.json tsconfig.node.json vite.config.ts` COPY block at `:134-137`; (3) `&& pnpm --filter @bigbluebam/bursar build \` in the chained build at `:201`; (4) `COPY --from=build /app/apps/bursar/dist /usr/share/nginx/html/bursar` at `:228`. No fifth edit for the guide: `Dockerfile:241` copies `docs/apps/` as a whole directory.
  - [x] `docker compose build frontend` (the slow step, rebuilds 23 SPAs) then `docker compose up -d --force-recreate frontend`. Confirm `http://localhost/bursar/` serves the SPA shell rather than a white screen.
  - [x] No `pnpm-workspace.yaml` or `turbo.json` change is needed; both already glob `apps/*`. Verify rather than edit.
  - [x] **Postgres headroom.** `postgres:16-alpine` has no `command:` key today, so adding one recreates the container. Add to the `postgres` service in `docker-compose.yml`:
        `command: postgres -c max_connections=200` and `shm_size: 256mb`.
        Apply with `docker compose up -d --force-recreate postgres`. **NEVER `docker compose down -v`**; `pgdata` is a named volume and survives a `--force-recreate`. Then `docker compose restart frontend`.
  - [x] **Postgres acceptance check:** `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SHOW max_connections;"` prints `200`. Cap bursar-api's own pool at `max: 10`.
  - [~] Apply the Railway counterpart of the connection ceiling to the managed Postgres plan and record it in the deploy catalog. Without it the local fix is cosmetic.
        **Half done, and the half that is missing needs a human.** Recorded in the deploy catalog on the
        `postgres` INFRA_SERVICES entry as a `tuning` block with `applied_on_railway: false`. It could not be
        applied: Railway Postgres is a MANAGED plan, so neither this repo nor the deploy adapters can set
        `max_connections` on it. An operator has to raise it on the managed plan. Until then production keeps
        the stock ceiling of 100 and the local fix is exactly as cosmetic as this line warns.
  - [x] **Redis: VERIFY ONLY, CHANGE NOTHING.** `docker-compose.yml:36-41` already reads `--maxmemory 512mb --maxmemory-policy noeviction`. Run `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" config get maxmemory maxmemory-policy` and confirm `512mb` / `noeviction`. Do not edit that block: it also carries `--requirepass` and `--appendonly`, and a stray edit risks dropping them or flipping the eviction policy, which silently corrupts BullMQ queue state suite-wide. The actionable half of Redis hygiene is per-queue retention and lives in M8.
  - [x] `scripts/deploy/shared/services.mjs`: add the `bursar-api` entry **with its `env: {required, optional}` block** exactly as spec section 18.3 gives it. `railway-orchestrator.mjs:69-70` resolves a missing `env` block to two empty arrays without erroring, so an entry without one deploys with no `DATABASE_URL` and crash-loops behind a build that looks healthy. Required: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL`, `BOLT_API_INTERNAL_URL`. Optional: `DATABASE_READ_URL`, `BRAID_API_INTERNAL_URL`, `CORS_ORIGIN`, `LOG_LEVEL`, `MAX_DOC_BYTES`, `MAX_DOC_PAGES`, `BURSAR_LLM_TIMEOUT_MS`, `BURSAR_ENGINE_TIMEOUT_MS`. Keep the two "deliberately absent" comments for `BILL_API_INTERNAL_URL` and `BBB_PERMISSIONS_ENFORCE`.
  - [x] `services.mjs` follow-ons: add `bursar-api` to the frontend entry's `needs` and `/bursar/` to its `public_paths`; add `BURSAR_API_INTERNAL_URL` to the **bolt-api** and **worker** entries; add `BURSAR_API_URL` to the **mcp-server** entry's `env.optional` (`services.mjs:556`).
  - [x] `scripts/deploy/shared/env-hints.mjs`: add both vars as `kind: 'computed'` per the `:281-289` precedent. **The suffix asymmetry is load-bearing:** `BURSAR_API_INTERNAL_URL` is the bare origin (`plannedApp('bursar-api')`, consumed by bolt-api and worker) and `BURSAR_API_URL` carries `/v1` (`${plannedApp('bursar-api')}/v1`, because the mcp-server client requests bare resource paths, matching burn/beacon/brief/bond/board). Unresolvable optional vars are silently skipped, so without hints both are unset on Railway with no local repro; setting them identical 404s every Bursar MCP tool on Railway. Railway internal URLs use port **8080**, not 4023, or you get 502s while healthchecks pass.
  - [x] `apps/api/src/routes/system-settings.routes.ts`: add bursar to `LAUNCHPAD_CATALOG`, add `'bursar'` to `ROOT_REDIRECT_VALUES`, **and** add the `REDIRECT_MAP` entry at `:123`. Without the map entry the redirect validates and then fails to resolve.
  - [x] `.env.example`: add `BURSAR_API_URL` and `BURSAR_API_INTERNAL_URL`, modeled on `:216-238` including the disabled-by-default semantics.
  - [x] Frontend `depends_on: bursar-api` with `condition: service_started` for now; promoted to `service_healthy` at M9.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** `http://localhost/bursar/` serves the SPA; `http://localhost/bursar/api/health` returns 200; `docker compose exec frontend nginx -t` passes; `grep -c bursar infra/nginx/nginx-with-site.conf infra/nginx/nginx.conf infra/nginx/nginx.railway.conf` is non-zero for all three; `SHOW max_connections;` returns 200; the redis `config get` returns `512mb` / `noeviction` **unchanged**.

---

- [ ] **M1 - Migrations, Drizzle schema, and the generated RLS loop**

  M1 lays down the entire `bursar_` table set in one coherent group of migrations, mirrors it in Drizzle,
  and generates RLS policies. It deliberately does **not** touch the permission chain. Round 2 of the
  spec review put permissions at M1 and that is unsatisfiable: `generate-permission-manifest.mjs` builds
  the catalog by walking **route and tool files**, which do not exist until M2 through M8 write them, so
  a group-defaults migration authored at M1 would be authored against a partial catalog **and then
  checksummed immutably**. That is exactly the trap spec section 17.2 documents, and it has burned this
  repo twice. The whole chain moves to M9.

  - [ ] Observe the current migration tip (`ls infra/postgres/migrations | tail -3`) and derive the anchor as **tip + 1**. Do not hardcode a number from the spec; four apps landed on this branch recently, so re-derive after any rebase.
  - [ ] `NNNN_bursar_core.sql`: `bursar_vendors`, `bursar_payee_aliases` (GIN trigram on `normalized_payee`, unique `(organization_id, normalized_payee)`), `bursar_requests` (with `injection_suspected`, `injection_signals`, `scope_status`, `bin_asset_id`, `bin_asset_version_id`, `source_doc_hash`), `bursar_scope_nodes` (guarded self-FK RESTRICT, unique `(organization_id, request_id, dedup_key)`, soft-archive only), `bursar_scope_library` (global built-ins with `organization_id IS NULL` and `is_global = true`, the variant RLS policy, and a `BEFORE INSERT OR UPDATE OR DELETE` immutability trigger for org callers), `bursar_org_settings`, `bursar_extraction_runs`, and the "Bursar System" sentinel user (following `0234`/`0239`, since `agent_proposals.actor_id` is NOT NULL).
  - [ ] `NNNN+1_bursar_offers_coverage.sql`: `bursar_offers` (incl. `parse_quality`, `blanket_suspected`, `unsubpriced_mandatory_count`, `evidence_concentration`, `sealed_until`, `bin_asset_version_id`, `uncompressed_bytes`), `bursar_offer_lines` (GIN tsvector on `raw_text`, **no trigram index**, that died with retrieval), `bursar_line_node_matches`, `bursar_offer_coverage` including the CHECK `verdict <> 'absent' OR decided_by = 'human' OR jsonb_array_length(rejected_candidates) > 0`, `bursar_leveling_window_results`, `bursar_offer_totals`, `bursar_leveling_runs`.
  - [ ] Confirm `decided_by` has **no** `'agent'` value. There is no agent adjudication path in v1.
  - [ ] `NNNN+2_bursar_awards_baseline.sql`: `bursar_awards` (chain via `supersedes_award_id` + `chain_root_id`, `baseline_hash`, nullable `term_start`/`term_end`), `bursar_baseline_items` (with `kind` CHECK over `included`/`excluded_at_award`/`absent_at_award`), `bursar_baseline_item_nodes`, plus **four-path immutability**: `BEFORE UPDATE` with a `WHEN` clause scoped to content columns so additive migrations are not aborted, `BEFORE DELETE`, `ON DELETE RESTRICT` from awards (a cascade does not fire a row trigger), and a `BEFORE TRUNCATE` statement trigger. Also `bursar_spend_events` (unique `(organization_id, dedup_key)`, `occurrence_ordinal`) and `bursar_spend_imports` (unique `(organization_id, file_sha256)`).
  - [ ] `NNNN+3_bursar_detectors_drafts.sql`: `bursar_mismatches`, `bursar_renewals`, `bursar_gate_checks`, `bursar_ingest_events` (with heartbeat/claim columns), `bursar_detector_feedback`, `bursar_drafts`.
  - [ ] `NNNN+4_bursar_rls.sql`: a **generated** `DO $$` loop over `information_schema` for the `bursar\_%` prefix, emitting `DROP POLICY IF EXISTS ...; CREATE POLICY ...` per `0116*.sql:23-47` (PG16 has no `CREATE POLICY IF NOT EXISTS`), with `bursar_scope_library` taking the variant policy `organization_id = current_setting('app.current_org_id', true)::uuid OR (organization_id IS NULL AND is_global)` and a `WITH CHECK` forbidding org-null inserts.
  - [ ] Every migration file: 4-digit snake_case filename, header comment block with the filename marker plus `-- Why:` and `-- Client impact:` lines, and fully idempotent DDL. Record the no-partitioning decision (spec 18.8) in the header of the offers/coverage migration.
  - [ ] Mirror every table in `apps/bursar-api/src/db/schema/`, money as `bigint` minor units with an explicit `currency varchar(3)`, cross-app refs dotted with no cross-schema FK.
  - [ ] Adopt burn's `runInOrgScope` (`burn-api/src/plugins/rls.ts:102-112`), not the older services' standalone `set_config(..., true)` form, which commits immediately and discards the GUC before the next query.
  - [ ] Add `apps/bursar-api/src/boot/assert-rls-bound.ts` logging `rls_backstop: 'absent'` at fatal level, plus `test/rls-backstop.test.ts` which starts passing the day the platform arms a non-superuser role. Every Bursar query carries an explicit `organization_id` predicate regardless.
  - [ ] Apply: `docker compose run --rm migrate`, then verify with `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 6;"`.
  - [ ] `test/rls-coverage.test.ts` asserts every `bursar_%` table has a policy.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** `pnpm db:check` reports **0 drift**; `pnpm lint:migrations` passes; `test/rls-coverage.test.ts` is green. No permission migration exists yet, by design.

---

- [ ] **M2 - Vendors, payee resolution, requests, settings, Bin asset access**

  The first real CRUD surface, and the milestone that establishes the document access boundary every
  later engine depends on. Payee resolution is Bursar's own rather than Braid's: `braid.ts:142-148`
  constrains `source_type` to a five-value enum with a uuid `source_id`, so a raw payee string fails Zod,
  and `braid-api/src/services/resolve.service.ts` mints a fresh singleton profile per unseen pair, which
  would give every card string its own golden profile, the exact opposite of dedup.

  - [ ] Vendor routes: `GET/POST /vendors`, `GET/PATCH /vendors/:id`, `DELETE /vendors/:id` (archive), `GET/POST /vendors/:id/aliases`, `DELETE /vendors/:id/aliases/:alias_id`, `GET /vendors/alias-review`. Unique `(organization_id, lower(display_name))`.
  - [ ] Payee normalization in `apps/bursar-api/src/lib/`: uppercase-fold, strip card noise (`*`, `SQ *`, `TST*`), strip trailing phone/city/state, strip corporate suffixes, collapse whitespace. Trigram match above 0.45 is a candidate; below the auto-accept threshold (0.65) it is a **human review item, never a silent join**. Unmatched spend keeps `vendor_id NULL`.
  - [ ] Braid is called **only** for `bond_company_id` -> golden id via `burn-api/src/lib/braid-resolve.client.ts:19-51`'s pattern, degrading to `null` on every failure.
  - [ ] Request routes: `GET/POST /requests`, `GET/PATCH /requests/:id`. Settings routes: `GET/PATCH /settings`, with **all** of `bursar_org_settings` audited with a before/after diff, not just the lexicons. Otherwise an admin can zero the `span_verified` weight and silently suppress findings.
  - [ ] `assertBinAssetReadable(actingUserId, orgId, assetId)`: `can_access('bin.asset', ...)` through `packages/shared/src/visibility-client.ts` (already a supported type, so this is reuse), `org_id` equality as defence in depth (`bin_assets` uses `org_id`, see `apps/bin-api/src/db/schema/bin-assets.ts:29`), `scan_status = 'clean'`, and **404 rather than 403**. Pin the resolved `bin_asset_version_id` on the referencing row.
  - [ ] Read-time re-assertion helper for the worker: re-check `scan_status='clean'` and `org_id` **immediately before the byte read**, and read **the pinned version**. Failure lands `blocked` and never parses.
  - [ ] `test/bin-asset-access.test.ts` covering all five cases: cross-org, private-same-org, unscanned, **flipped-after-attach**, **version-advanced-after-attach**.
  - [ ] Per-route permission metadata is authored inline now (so the M9 manifest generator can walk it) even though the actions do not exist in the DB yet. Interim posture is expected: with the fail-closed boot invariant, `/bursar` routes deny for non-SuperUsers from M1 to M8. Development and Playwright run as a SuperUser (Skipper is seeded as one). **Do not "fix" this by weakening the invariant.**
  - [ ] Port burn's hardcoded fail-closed boot invariant to `apps/bursar-api/src/boot/assert-permissions-enforce.ts`, asserted in `server.ts` before anything binds a port (burn does this at `server.ts:47-54`). Mode `'on'`, `onUnknown` fail-closed, **not** an env var, because `ENV_HINTS` is a flat global map with no per-service override.
  - [ ] Port burn's `viewer-caps.ts` and `redact-financial-fields.ts` financial flooring, and place the **shared seal predicate** in the same shared query/repository layer so every read of offers, lines, coverage, and totals passes through it. Endpoint-by-endpoint sealing is explicitly rejected: it was forgotten by two CSV exports and four MCP tools in an earlier round.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** all five Bin access cases in `test/bin-asset-access.test.ts` refuse (404 or `blocked`) and write nothing; vendor/request/settings CRUD round-trips; settings writes produce an audited before/after diff.

---

- [ ] **M2.5 - The absence spike, classifier in the loop**

  A deliberate measurement milestone with **no DB and no UI**, placed before any UI work because it can
  reshape the product envelope. Spec section 25 names long-document viability as the biggest unknown: the
  pinned-exclusion plus merge-lattice design is a design, not a measurement. If the missed-exclusion gate
  cannot be met, **the v1 envelope drops to 5-page documents** and longer offers are surfaced as "too
  long to level reliably" rather than levelled badly. Better to learn that now than after the Matrix UI
  is built around a promise the engine cannot keep. Hand-labelling is on the critical path here and the
  spike cannot complete without it.

  - [ ] Build the fixture corpus under `apps/bursar-api/test/fixtures/`: **at least 40** labelled absence tuples; **at least 8** instruction-shaped injection documents; **at least 3** non-imperative single-blanket documents; the **split-blanket** set (4 lines covering 3 to 4 nodes each, containing **no lexicon token**); a **name-list** fixture (nodes named without prices); a **legitimate-subprice** fixture (an itemized priced bundle, the false-positive guard); and **at least one 40-page worst-case document with a terminal exclusions block** hundreds of lines from the priced lines.
  - [ ] Fixtures are labelled by someone who understands procurement. Flag this as a human dependency in the milestone note if labelling is not yet available.
  - [ ] Implement the deterministic pre-pass standalone: the exclusion lexicon, the blanket-claim lexicon (`all requirements`, `fully included`, `all-inclusive`, `turnkey`, `everything listed`, `as specified in your RFQ/RFP`, `no additional charge`, `no exclusions`, `complete solution`, `comprehensive`), and exact structural match on quantity plus unit. **No zero-candidate short-circuit.**
  - [ ] Implement **one real full-offer classification path** against fixture text: the complete line set as a typed `{offer_line_id, raw_text}` array in a data role, answers by `offer_line_id`, closed-book, batched 6 nodes per call against one shared line array. Bytes never enter the instruction role.
  - [ ] Wire a recorded-response harness so CI can replay deterministically, but run the spike itself against the **real** internal LLM proxy at least once, with `X-Internal-Service: bursar` and `BURSAR_LLM_TIMEOUT_MS` at 60000 to match the proxy's hardcoded 60s deadline (`internal-llm.routes.ts:325`). Burn's inherited 15000 would abort routinely, and an aborted client does not release the proxy concurrency slot for 90 seconds.
  - [ ] Implement the three verification predicates well enough to measure: span verifies **against the cited line** not the document; `absent` requires a non-empty rejected-candidate set by `offer_line_id` with each id validated as belonging to this offer; node-term overlap at or above `node_term_overlap_floor` (0.25 Jaccard over stemmed tokens).
  - [ ] Implement the sliding window (`max_lines_per_window` 250, overlap 50), the merge lattice `excluded_explicit > partial > covered > ambiguous > absent`, and exclusion pinning, so the 40-page fixture is a fair test.
  - [ ] **Number 1:** measure and record the **false-absence rate with the classifier in the loop** on published verdicts. Target `<= 0.05`.
  - [ ] **Number 2:** measure and record **tokens and wall-clock on the 40-page worst-case fixture**. Compare against the verified constraints: proxy concurrency 4 per service and rate 120/min (`apps/api/src/env.ts:115-116`), and the caps `max_nodes_per_run` 400, `max_offers_per_run` 8, `max_llm_calls_per_run` 250.
  - [ ] **Number 3:** confirm **zero** auto-published `covered` on the injection fixtures, the single-blanket fixtures, **and** the split-blanket fixtures.
  - [ ] Write the three numbers into this WIP doc under this milestone. If the missed-exclusion gate on the long document cannot be met, record the envelope decision (5-page v1) here explicitly and adjust M5 and M6 scope before proceeding.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** three measured numbers are recorded here: false-absence rate with the classifier in the loop, tokens and wall-clock on the 40-page worst-case fixture, and **zero** auto-published `covered` on the injection, single-blanket, and split-blanket fixtures.

---

- [ ] **M3 - Scope derivation and the confirmed tree**

  The ruler. Everything Bursar claims about an offer is measured against this tree, so it is built before
  offers exist. Two real bugs in the ported extraction engine are fixed here rather than inherited, and
  the derivation engine is **async-start** for the same reason leveling is: `fetch` abort does not stop
  the handler, so a synchronous caller that times out lets BullMQ retry and puts a **second writer** on
  one `last_processed_chunk`, which is precisely the divergent-ordinal condition that duplicates matrix
  rows.

  - [ ] `POST /internal/run-derivation` returns **202 plus a run id**; the worker polls; work is bounded to **one chunk per invocation**; re-entry on a live lease is rejected. `BURSAR_ENGINE_TIMEOUT_MS` (default 30000) covers only the start call.
  - [ ] Port the checkpointed chunk loop from `extraction.engine.ts:103-173` with **fix (a)**: the ordinal is chunk-relative, `${chunkIndex}:${indexWithinChunk}`, not a `let ordinal = 0` declared before a resumable loop. `test/dedup-key.resume.test.ts` asserts byte-equality of `dedup_key` across a crash and resume.
  - [ ] **Fix (b):** a dropped chunk cannot report success. Count `chunks_failed`, land the run `partial`, **block `scope_status` from reaching `derived`**, and surface "we could not read N sections" with the chunk ranges. The original's `log.debug; continue` on `LlmError` finished `succeeded`, which would confirm a tree missing a chunk and make every offer come back clean on requirements that were never enumerated, invisible to the false-absence gate because the node does not exist.
  - [ ] **Fix (c):** span verification is **per-chunk-line**, not whole-document.
  - [ ] Precedence for `derived_from`: `request` (mandatory by default), `library` (`should_have`), `rival_offer` (`nice_to_have`, **never auto-published**), `human` (as set).
  - [ ] `scope_status` state machine: `pending` -> `deriving` -> `derived` -> `confirmed`. An unconfirmed tree yields `provisional` verdicts and publishes no Bolt event.
  - [ ] Stage 0 pre-scan on the request document: imperative second-person directives at a reader-model, instruction-override markers, role tokens, zero-width/bidi control runs, and blanket-coverage claims. Set `bursar_requests.injection_suspected` and `injection_signals`; open a `request_manipulation_suspected` finding; **block `confirmed`** until flagged spans are cleared. The RFQ is the higher-leverage target precisely because its nodes default to `mandatory`.
  - [ ] Routes: `POST /requests/:id/derive-scope`, `GET /requests/:id/scope`, `POST /requests/:id/scope/nodes`, `PATCH/DELETE /scope-nodes/:id` (DELETE archives), `POST /requests/:id/scope/apply-library`, `POST /requests/:id/scope/confirm` (409 while `deriving`, blocked while `injection_suspected`), and `POST /scope-nodes/:id/promote-rival`.
  - [ ] Rival-derived nodes are **proposals**: they land `pending_review`, are excluded from `gap_adjusted`, from the diff, and from producing `absent` until promoted. Supporting offers must be **distinct `braid_profile_id`** (fallback `bond_company_id`, then a human decision), **not** distinct `vendor_id`, because vendor uniqueness is only on `lower(display_name)` and one vendor under two rows could satisfy a ">= 2 offers" rule. Record `contributing_offer_ids uuid[]`. Injection- and blanket-suspected offers cannot contribute.
  - [ ] Promotion goes through `bursar.scope.promote_rival`: floored, confirm-required, and the payload **echoes `contributing_offer_ids`** so the audit records what the promoter was shown.
  - [ ] `bursar_scope_library` built-ins seeded as global rows, with the API filtering `is_global = false` on writes and `test/library-visibility.test.ts` covering both halves (org callers cannot mutate globals; globals are visible under the variant RLS policy).
  - [ ] Scope Tree editor page at `/bursar/requests/:id` (basic form is fine at this stage; polish lands in M6): citations, strength promotion, apply-library, rival-promotion queue, Confirm scope.
  - [ ] `bursar-run-reaper` (`*/5 * * * *`) reverts runs whose `heartbeat_at` exceeds the lease (default 5 min) to `partial`, **and in the same statement transactionally reverts the owning request's `scope_status`** back to `pending`. Without that, a crashed derivation wedges `scope/confirm` at 409 permanently and the flagship is dead on that request with no recovery short of psql. The same audit applies to `bursar_offers.normalization_status='parsing'`.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** a 14-node tree derives from a fixture RFQ; a crash-and-resume produces byte-identical `dedup_key` values; a failed chunk blocks `scope_status` from `derived`; and a killed derivation is unwedged by the reaper without manual psql.

---

- [ ] **M4 - Offer ingest and deterministic parse**

  Stage 1 is entirely deterministic, no LLM. It comes after the tree because a parsed offer with nothing
  to measure against is inert, and before the engine because the engine consumes typed lines. This
  milestone also computes the two **per-offer** counters that M5's load-bearing defense reads.

  - [ ] Routes: `GET/POST /requests/:id/offers`, `POST /offers/:id/upload` (multipart), `GET /offers/:id`, `GET /offers/:id/lines`, `POST /offers/:id/reparse`, `POST /offers/:id/unseal` (floored), `DELETE /offers/:id`.
  - [ ] Worker `bursar-parse-offer` reads bytes via `getObjectBuffer` from `apps/worker/src/utils/storage.ts` (which wraps `@bigbluebam/storage`; it is not itself a storage export), after re-asserting `scan_status` and `org_id` and reading the **pinned** version.
  - [ ] Format handling: plain text and email via UTF-8 decode; PDF with a text layer via `Tj`/`TJ` show-operator extraction (`burn-extract-deliverables.job.ts:30-43`); CSV/TSV/JSONL/XLSX-exported via `@bigbluebam/structured-data` codecs; **scanned image PDFs are `unparseable`, never levelled**. No OCR in v1.
  - [ ] `parse_quality` (0.0 to 1.0) from extracted characters per page, structured-line ratio, and currency/quantity token presence. Below `parse_quality_floor` (0.35) the offer is `unparseable` and **can never produce `absent`**. "We could not read it" is not evidence of omission.
  - [ ] Lines carry `raw_text` (bounded 4,000), `char_start`, `char_end`, `page`, `ordinal`, parsed `quantity`, `unit`, `unit_price_minor`, `extended_minor`, and `line_role` (`base`/`option`/`alternate`/`allowance`/`note`, with **only `base`** counting toward coverage and totals).
  - [ ] Injection pre-scan and **blanket-claim lexicon** pre-pass on the offer, setting `bursar_offer_lines.blanket_claim` and `exclusion_hit`. A hit opens a `bursar_mismatches` row (`offer_manipulation_suspected`, severity `high`) citing the span. Suspected offers never auto-publish `covered` and never contribute rival nodes, but their `absent` verdicts are **never suppressed**.
  - [ ] Compute and persist the two per-offer counters on `bursar_offers`: `unsubpriced_mandatory_count` and `evidence_concentration`, both derived from `bursar_line_node_matches`, both **per offer** so neither depends on the attacker's line count.
  - [ ] Malicious-document ceilings: uncompressed-size and entry-count limits checked **before** decompression, content-type pinning against the declared `source_format`, and per-parse wall-clock and memory caps in a bounded child context. `MAX_DOC_BYTES` default **20MB**, deliberately below nginx's server-level `client_max_body_size 25m` (`nginx-with-site.conf:18`), with the 413 mapped to "this file is larger than 20MB". Do not raise the global nginx limit for one app's worst case.
  - [ ] Progress logging before the byte read, before the parse, and before the handoff, with elapsed-ms context and flushed output.
  - [ ] Sealed-bid enforcement rides the shared seal predicate from M2. Every unseal writes `activity_log` and publishes `offer.unsealed`.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** the split-blanket fixture ingests, parses, quarantines, and opens an `offer_manipulation_suspected` finding, with `unsubpriced_mandatory_count` and `evidence_concentration` persisted on the offer row.

---

- [ ] **M5 - The absence engine and the coverage-collapse cluster**

  The flagship. Everything before it was scaffolding for this. It classifies, verifies, bands, defends
  against coverage collapse, and guarantees the diff is complete. The order matters inside the milestone
  too: the defenses in section 4 all terminate in "does not auto-publish", and if an unpublished node
  simply vanishes from the diff, the attacker's goal is met anyway (the buyer sees no gap on crew
  training and signs). So the diff-completeness invariant is built **with** the defenses, not after them.

  - [ ] Full-offer classification only. No retrieval layer of any kind: no embedding provider exists (`brief-embed.job.ts` and `beacon-vector-sync.job.ts:123` both write zero vectors), and the lexical/structural fallback was cut because with vectors gone it had one channel and could never clear the band bar.
  - [ ] Six verdicts implemented: `covered`, `partial`, `excluded_explicit`, `absent`, `ambiguous`, `not_applicable`.
  - [ ] Failure handling table: `LlmThrottledError` (429) **defers** (run lands `partial` at a checkpoint, retry resumes, never a default verdict); `LlmError` yields `ambiguous`/`pending_review`, **never `absent`**; `LlmMalformedError` (truncated JSON or `finish_reason === 'length'`) retries at a smaller batch **capped at 2** then `ambiguous`; a node missing from a batch response is **`ambiguous`, retried individually, never `absent`**; no LLM provider configured makes the run fail loudly at `status='blocked'` with a settings deep link.
  - [ ] Additive change in `apps/api/src/routes/internal-llm.routes.ts`: return `{data: {content, finish_reason, usage}}` instead of `{data: {content}}` (`:349,389`). Every existing caller reads `data.content` and is unaffected. Without this, truncation detection is guesswork.
  - [ ] Three verification predicates, with any failure demoting `covered`/`partial`/`excluded_explicit` to `ambiguous`/`pending_review`. Document in code that **predicate 3 is not the defense against blanket coverage** (a blanket sentence naming the requirements has maximal overlap by construction); it catches topically-adjacent mis-citation.
  - [ ] Banding: `high` at `>= 0.85` with all three predicates passing, complete window coverage, **and no section 4 cap tripped**, auto-published; `medium` at 0.60 to 0.85, caution chip, `needs_review`, **excluded from every headline figure**; `low` below 0.60 or `ambiguous` or the mandatory bar unmet, HITL, not published. `test/confidence-no-nan.test.ts` asserts a finite score for every input.
  - [ ] The asymmetric mandatory-absent rule: `mandatory` + `absent` publishes only if **either** the offer parsed cleanly (`parse_quality >= floor`) with complete window coverage, **or** a human has confirmed it. **Suspicion flags do not gate `absent`.** `blanket_suspected` and `injection_suspected` block auto-published **`covered`** and nothing else, because otherwise writing "turnkey" once buys a vendor immunity from the flagship output.
  - [ ] **Defense 1**, blanket-claim lexicon (already computed at M4): a `covered` verdict citing such a line cannot auto-publish.
  - [ ] **Defense 2**, cumulative per-offer caps (the load-bearing one): (a) unsubpriced-coverage cap, counting distinct **mandatory** nodes whose only `covered` evidence is a non-sub-priced citation across **all** lines of the offer, and above `blanket_cumulative_cap` (default 4) routing **all of them** to review; (b) evidence-concentration guard, `distinct_cited_lines / covered_mandatory_nodes` below `evidence_concentration_floor` (default 0.5) routing all covered mandatory nodes to review. Per-line fan-out (`blanket_fanout_cap`, default 4) is retained only as a cheap early signal.
  - [ ] **Defense 3**, only explicit sub-pricing enumerates: a bundling line (defined as a line matched to two or more nodes, recorded in `bursar_line_node_matches`) may auto-publish `covered` for more than one node **only** at `allocation_method='explicit_subprice'`, meaning a per-node monetary sub-price with a distinct cited span per node. The "or an itemized list" branch is **deleted**. Downward subsumption is verdict-preserving (may only promote `absent`/`ambiguous` children to `derived_covered`, may **never** overwrite `excluded_explicit` or `partial`, capped at one level unless descendants were explicitly sub-priced). Upward rollup is de-transitivized (a parent whose children are all covered becomes `derived_covered`, is excluded from the diff, and is **never itself a rollup input**).
  - [ ] The `allocation_weight` ladder recorded in `allocation_method`: rung 1 `explicit_subprice` (usable for gap valuation, **the only rung that enumerates**), rung 2 `rival_distribution`, rung 3 `quantity_unit` (usable but `estimated`), rung 4 `equal_split` (**refused** for gap valuation). Weights per line sum to 1.0.
  - [ ] **Defense 4** carried from M3: rival-derived nodes stay proposals.
  - [ ] Window merge lattice `excluded_explicit > partial > covered > ambiguous > absent` per `(offer, node)` across windows, reading by `(offer_id, scope_node_id)` scoped to the run.
  - [ ] Exclusion pinning: lexicon hits are pinned into every window regardless of boundaries, because real proposals put exclusions in a terminal block hundreds of lines from the priced line. **The pinning exemption is scoped to the verdict it exists for**: a pinned line's matches count toward fan-out **unless the resulting verdict is `excluded_explicit`**. A blanket exemption is readable off the spec ("Nothing is excluded: installation, crew training and warranty are all provided under this price" takes the flag and escapes the defense). `test/fanout-pinned.test.ts` covers it.
  - [ ] Per-window results are durable in `bursar_leveling_window_results`, and **"continue" resumes the same run row**: `partial` -> `running` with a new `claimed_by`, checkpoint preserved. Minting a new run would make earlier windows invisible, land `window_coverage` at `partial`, and permanently demote a mandatory `absent` to `ambiguous` after any throttle.
  - [ ] **Claim fencing.** Every checkpoint, window-result, and coverage write is conditioned on `WHERE id = $run AND claimed_by = $me AND status = 'running'`, and a **zero-row update aborts the slice immediately**. Slices of one run execute serially. A bare status flag does not fence a still-alive writer, which is how the reaper would otherwise create the race it was added to fix.
  - [ ] Async-start leveling: `POST /internal/run-leveling` returns **202 plus a run id**, the worker polls, work proceeds in bounded slices (one offer per invocation) as `burn-attribute-batch` does. The advisory lock cannot span an LLM run (`burn-api/src/lib/advisory-lock.ts` states no transaction holding the lock may contain an outbound HTTP call), so the 409 keys off run status, backed by `heartbeat_at` and `claimed_by` heartbeated on **every** checkpoint commit.
  - [ ] The cap contract: `POST /requests/:id/level` preflight returns estimated calls, tokens, wall-clock, and `would_exceed: {offers, calls}`; `max_offers_per_run` exceeded at start returns **422 `rejected_limits`** and nothing runs; `max_llm_calls_per_run` exceeded mid-flight stops cleanly at `status='partial'` with a "levelled 6 of 8, continue" affordance. A BullMQ limiter sized under 120/min.
  - [ ] Typed deltas: `delta_kind` (`quantity`/`term`/`tier`/`allowance`/`alternate`/`option`/`geography`), `delta_quantity`, `delta_unit`, and `delta_amount_minor` (the one that lets a `partial` contribute to `gap_adjusted`).
  - [ ] Comparable totals: `stated`, `base_only`, `gap_adjusted` (`base_only` plus valued mandatory gaps from `absent`, `excluded_explicit`, and `partial` via `delta_amount_minor`), and `should_have_supplement` reported separately. `normalized_to_term` is **not** built in v1.
  - [ ] The valuation ladder with admissibility: rung 1 `offer_line` (this offer priced it as an option or allowance, one observation suffices because it is the vendor's own price); rung 2 `rival_median` (**requires two or more admissible observations**); rung 3 `library_unit`; otherwise the gap is `unvalued`. A rival that is itself `absent` contributes nothing; a rival pricing it inside a bundle contributes only at `explicit_subprice` or `rival_distribution`; **equal-split observations are refused**; a different-currency rival is inadmissible.
  - [ ] Refusing to render a number: when gaps cannot be valued above rung 3, `renderable = false`, `gap_adjusted` does **not** sort the Matrix, and the UI falls back to `stated` plus an unpriced-gap count.
  - [ ] **The section 4.7 diff-completeness invariant.** For a `confirmed` tree, the exclusion diff enumerates **every `mandatory` node exactly once** in exactly one of `published`, `needs_review`, or `unverified`, and `published + needs_review + unverified == count(mandatory nodes)`. Persist `withheld_reason varchar(24)` on coverage (`blanket_cap`, `concentration`, `band`, `throttled`, `unparseable`). Implement as a **CI gate asserted per fixture**.
  - [ ] Routes: `GET /requests/:id/leveling-runs` (authoritative progress), `GET /requests/:id/matrix`, `GET /requests/:id/exclusion-diff`, `GET /requests/:id/totals`, `GET /coverage/:id`, `POST /coverage/:id/override`, `GET /review`.
  - [ ] Unit tests per spec 20.1: `verifyCiteAgainstLine` including text-elsewhere-in-document yielding a miss; `nodeTermOverlap`; `computeDedupKey` resume equality; `compositeConfidence` finite for every input; the `classifyCoverage` decision table (six verdicts by three predicates by four strengths); missing-node to `ambiguous`; malformed retry capped at 2; **every pair** of the window merge lattice; cumulative fan-out and evidence-concentration caps; the pinned-line exemption scoped to `excluded_explicit`; rollup rules both directions; the allocation ladder including equal-split refusal; totals including admissibility and `renderable=false`; **`blanket_suspected` does NOT suppress `absent`**; claim fencing (a zero-row conditional update aborts the slice).
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** every spec 20.2 corpus gate passes: false-absence rate `<= 0.05` on published verdicts; **0** auto-published `covered` on injection; **0** on single-blanket with the 14-node tree not fully covered; **0** on split-blanket with the cumulative caps tripping; the legitimate sub-priced bundle **does** auto-publish; the long document's terminal exclusions block yields `excluded_explicit`; and diff completeness holds per fixture.

---

- [ ] **M6 - Matrix, Diff, review queue, realtime, help content**

  The UI that makes the engine legible, plus the help content that ships now and is gated at M9. It comes
  after M5 because the two hard UI rules are statements about engine output, not about layout, and they
  cannot be built against an engine that does not yet produce `withheld_reason`. The frontend shell is
  not optional decoration: Bursar must be indistinguishable from `/b3/` and `/burn/` in chrome.

  - [ ] **Shell parity, modeled on `apps/blip/` and `apps/burn/`.** Shared sidebar including `SidebarPlatformFooter`; shared top bar with `LaunchpadTrigger`, breadcrumb, `OrgSwitcher`, the Banter quick-link, `NotificationsBell`, `HelpTrigger`, and `UserMenu`, all imported from `@bigbluebam/ui/*`; `<Launchpad currentApp="bursar" />`; `PermissionsProvider` plus the auth store.
  - [ ] Copy the sibling app's `globals.css` theme tokens **verbatim**: the blue primary ramp, no new accent color, no bespoke palette.
  - [ ] `apps/bursar/src/main.tsx` calls `mountBureauClient(...)` so the Bureau docked-box widget appears, and `initSystemErrorReporter({ service: 'bursar' })`.
  - [ ] Pages: `/bursar/` Vendor Portfolio with "no award on file" as a first-class column; `/bursar/requests` list; `/bursar/requests/:id` Scope Tree editor; `/bursar/requests/:id/level` the Leveling Matrix; `/bursar/requests/:id/diff` the Exclusion Diff; `/bursar/vendors/:id` vendor detail with aliases, award chain, baseline, spend, findings, and an `orphaned_custody` badge; `/bursar/mismatches` Mismatch Inbox; `/bursar/renewals` Renewal Radar; `/bursar/review` the HITL queue; `/bursar/settings`.
  - [ ] Matrix behavior: sorted by `gap_adjusted` **only when `renderable`**, else by `stated` with an unpriced-gap count as a second column. A chip opens the cited span, the matched lines, and for `absent` the rejected candidates. **Withheld rows render explicitly with their `withheld_reason`.**
  - [ ] Diff behavior satisfying the 4.7 invariant: every mandatory node appears exactly once; a **blocking banner** renders when any node is `needs_review` or `unverified`; blanket offers render under "this offer claims blanket coverage; here is what it does not itemize", listing the unsubstantiated nodes.
  - [ ] **UI rule 1:** a `medium`-band verdict is visually distinct and excluded from every headline aggregate, with a `data-testid` carrying its contributing band set so Playwright can assert it.
  - [ ] **UI rule 2:** no "clean" / "no gaps" / "fully covered" affordance renders anywhere while any mandatory node is `needs_review` or `unverified`.
  - [ ] Mismatch Inbox renders "not quantified" as text and **never** converts it into a number.
  - [ ] Settings page: thresholds, weights, lexicons, and the library with global rows read-only.
  - [ ] Realtime `/bursar/ws` with rooms `org:<id>`, `request:<id>` (`scope.progress`, `leveling.progress` carrying `offer n/N, node m/M, window w/W`, `matrix.updated`), and `vendor:<id>`. No browser WS precedent exists in `apps/burn/src`, so implement exponential backoff (1s, capped 30s, jittered), a visible "reconnecting" state, and **`GET /requests/:id/leveling-runs` polled at 5s as the authoritative fallback**.
  - [ ] `docs/apps/bursar/help.md` and `docs/apps/bursar/guide.md`, authored per the `help-doc-authoring` standard (User Story format, source priority, conventions).
  - [ ] Generate `docs/apps/bursar/help-index.json` and verify with `node scripts/help/build-help-index.mjs --check`, which exits 1 on drift, rather than regenerating in CI.
  - [ ] Wire `<HelpTrigger app="bursar" />` into the layout, following `apps/burn/src/components/layout/burn-layout.tsx:120`.
  - [ ] Note that `scripts/help/smoke-help-center.mjs` is **not** usable as a done-criterion: it is hardcoded to Bam, takes no app argument, and its `OUT` default is a hardcoded `D:/Documents/GitHub/...` path absent from this checkout. File that as a pre-existing defect task. Help coverage is proven by Playwright step 12 at M9.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** Playwright steps 1 through 8 pass against seeded data, including step 8's negative (Professor's Lab Supply shows `offer_manipulation_suspected`, zero auto-published `covered`, **and** the diff renders all 14 mandatory nodes with `withheld_reason='blanket_cap'`). A step 8 that passes on an empty diff is the failure this replaces.

---

- [ ] **M7 - Award, baseline freeze, immutability**

  The hinge between the two halves. Once an award is recorded, the accepted tree becomes an immutable
  record of both what you got and what you knowingly did not get, and that record is what M8's detectors
  measure reality against. It comes after the UI because the award action is driven from the Matrix, and
  because the freeze must capture verdicts the engine has actually produced.

  - [ ] `POST /v1/awards` executes in **one `runInOrgScope` transaction**: insert the award; **copy** every accepted line into `bursar_baseline_items` including the `excluded_at_award` and `absent_at_award` rows; link nodes via `bursar_baseline_item_nodes`; stamp `coverage_verdict_at_award`; compute `baseline_hash`; set the request to `awarded`; write `entity_links`; publish `award.recorded` and `baseline.frozen`. Return **409 if a leveling run holds a live lease**.
  - [ ] Baseline `kind` CHECK enforced over `included`, `excluded_at_award`, `absent_at_award`.
  - [ ] Award chain: a new row with `supersedes_award_id` inherits `chain_root_id` and flips the predecessor to `superseded`. Drift resolves over the chain, latest active item per `(chain_root_id, ordinal)`. Modeled on `burn_engagements` (`0239:13-48`).
  - [ ] Routes: `POST /awards`, `GET /awards`, `GET /awards/:id`, `GET /awards/:id/baseline`, `POST /awards/:id/amend`, `POST /awards/:id/terminate`. **No baseline write path exists**, by design.
  - [ ] Four-path immutability verified by test: `BEFORE UPDATE` with a content-column `WHEN` clause (so additive migrations are not aborted), `BEFORE DELETE`, `ON DELETE RESTRICT` from awards (a cascade does not fire a row trigger), and the `BEFORE TRUNCATE` statement trigger. `bursar-retention` carries an explicit exclusion list naming the baseline table.
  - [ ] `entity_links` rows written in the same org-scoped transaction as the row they describe (`burn-api/src/lib/entity-links.ts:36-40`) with `ON CONFLICT DO NOTHING`. Note the column-name asymmetry: `entity_links` uses `org_id`, `bursar_*` tables use `organization_id`.
  - [ ] Bulwark handoff is an `entity_links` row plus a deep link. Bursar writes **zero** rows in Bill, Burn, or Bulwark, and defines no obligation, notice-deadline, work-item, or invoice table.
  - [ ] Baseline UI renders with **no edit control on any baseline row**.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** Playwright step 9 passes: award to Radio Parts, then assert **structurally** that `included + excluded_at_award + absent_at_award == node count`, the warranty node is `included` with `delta_kind='term'`, and no edit control exists on any baseline row.

---

- [ ] **M8 - Spend, detectors, mismatch inbox, renewal radar, worker jobs**

  The post-award half, and the retention mechanism. It comes last among the functional milestones because
  every detector reads a frozen baseline. Post-award is fed **predominantly by CSV statement import, not
  platform events**: `bill_expenses` has no funding-source field, there is no AP ledger in the platform,
  and `bill_invoices`/`bill_payments` are money-in. Onboarding is "upload last year's statement", not
  "connect your ledger".

  - [ ] Spend routes: `GET /spend`, `GET /spend/by-vendor` (both carrying `bursar.spend.read_all` as **route-file permission metadata** so the M9 manifest generator emits the action, following burn's financial-flooring pattern), `POST /spend/import`, `GET /spend/imports`, `GET /spend/export` (CSV).
  - [ ] Spend dedup key in `apps/bursar-api/src/lib/spend-dedup-key.ts`: a **plain local `sha256`** over the canonicalized tuple `(normalized_payee, occurred_on, amount_minor, currency, external_ref, occurrence_ordinal)`. Do **not** reuse burn's `idempotency-key.ts`: it is an HMAC over `BurnPrecheckRequest` against a `.strict()` type, it lives in an app bursar-api cannot import, and keying dedup on a **rotatable secret** means every row re-imports after a rotation.
  - [ ] `occurrence_ordinal` is the row's index within its dedup group **in the source file**, so two genuine identical same-day charges produce two rows. Without it the import silently under-reports and says "already imported", which is the mirror of the doubling bug and harder to notice.
  - [ ] Import resumability: `UNIQUE (organization_id, file_sha256)` **with `ON CONFLICT ... DO UPDATE SET status='running'`**, and a non-`succeeded` batch **resumes the upsert loop**. **"0 new" is derived from `rows_deduped`, never from the batch row's existence.** A bare unique constraint makes a crash at row 200 of 412 un-retryable and loses 212 rows forever.
  - [ ] CSV formula neutralization (leading `=`, `+`, `-`, `@`) as a **shared helper in `@bigbluebam/shared`**, attached to both `GET /spend/export` and `GET /requests/:id/diff/export`. File the pre-existing unescaped exports in bearing-api and the frontend timeline export as tasks.
  - [ ] Drift computation: vendor resolution via trigram **never Braid**; award selection including null terms (a null `term_end` is open-ended, selected when `occurred_on >= term_start` or unconditionally when both are null and no bounded award matches, with ambiguity picking the most recent and recording `match_method='fuzzy'`); **line matching deterministic only** (exact description, then trigram over `bursar_baseline_items.title`, then unit-price equality within tolerance, **no LLM matcher**); and a **hard currency precondition** (drift computed only on currency equality, otherwise `currency_mismatch` and skip, because without it an FX move reads as double-digit price drift).
  - [ ] Dollars at stake are **computed, never estimated**. Unquantifiable drift stores `NULL` and the UI shows "not quantified".
  - [ ] Silent-line drift evaluates only on awards with a non-null elapsed `term_end`, or a rolling 12-month window for open-ended awards, **and the finding states which basis it used**.
  - [ ] Four detectors: `price_drift` (`price_drift_threshold_pct` default 10%, minimum absolute $25), `scope_divergence` (invoiced line with no baseline item, or a silent baseline item with the basis stated), `unbaselined_vendor` (two or more events in 180 days with no award, **grouped by `normalized_payee`** because unmatched spend keeps `vendor_id NULL` and a `vendor_id` grouping would fire on nothing), and `renewal_cliff` (bands `t_minus_90/60/30/7`, `alerted_bands` idempotency, absorbing auto-renew-unreviewed as a severity bump). The `unbaselined_vendor` bucket is the shadow-IT bucket and, like Burn's `unscoped`, **the bucket is the product**.
  - [ ] Noise control: `dedup_key` upsert bumps `last_seen_at`; a per-org per-detector daily cap (default 200) records `detector_capped`; `dismissed` is sticky by `dedup_key` unless the evidence hash changes.
  - [ ] Routes: `GET /mismatches`, `GET /mismatches/:id`, `POST /mismatches/:id/resolve|dismiss`, `POST /mismatches/:id/mark-wrong`, `GET /renewals`, `POST /renewals/:id/decide`, `GET /drafts` (owner-scoped), `POST /drafts/clarification|negotiation-brief`, `POST /drafts/:id/approve|reject`, `POST /gate/scope-gap` (**advisory only**, returns `pass`/`advisory` plus cited reasons and records a `bursar_gate_checks` row, with **no bill-api preHandler and no enforcement**), `GET /gate/checks`, and library CRUD rejecting global rows.
  - [ ] Draft confidentiality: `bursar.draft.read` is **not** granted to `viewer`; `draft.approve` is floored; reads are scoped to the request owner plus explicit holders (org-level RLS cannot do this alone); the `agent_proposals` summary is a **content-free template** (`"Bursar draft awaiting review: <draft_kind> for <vendor display_name>"`); and grounding comes from a single builder `buildDraftGrounding(offer_id, request_id)` that can only select lines of that offer and nodes of that request, with `test/draft-grounding.test.ts` asserting **the builder**.
  - [ ] Register ten worker jobs in `apps/worker/src/worker.ts` (following `worker.ts:2464-2496`), all thin HTTP callers into `/v1/internal/engines/:name` since the locks live inside bursar-api: `bursar-derive-scope` (event), `bursar-parse-offer` (event), `bursar-level-request` (event), `bursar-drift-sweep` (`*/30 * * * *`), `bursar-renewal-radar` (`0 6 * * *`), `bursar-mismatch-reconcile` (`5,35 * * * *`), `bursar-run-reaper` (`*/5 * * * *`), `bursar-draft-reconcile` (`*/15 * * * *`), `bursar-weekly-digest` (`0 13 * * 1`), `bursar-retention` (`20 5 * * *`, with baseline items excluded).
  - [ ] **Queue authoring:** every Bursar queue sets `removeOnComplete: 100` and `removeOnFail: 500`. Redis runs `noeviction`, so unbounded job retention is what would eventually make writes error out suite-wide. This is the actionable half of Redis hygiene.
  - [ ] Reconcile does not flap against the sweep: both take the **same per-org advisory lock class**, and reconcile is offset to `5,35` so it always runs after a sweep tick.
  - [ ] `bursar-drift-sweep` is bounded: an org cursor across ticks, a per-tick row budget, a BullMQ limiter, row claims with lease renewal, and progress logging (`org n/N`, `rows n/N`, elapsed-ms) **before** each stall, flushed.
  - [ ] Consume `expense.submitted` / `expense.approved` (bill) into spend events, `profile.merged` (braid) to re-point `braid_profile_id`, and `proposal.decided` onto `bursar_drafts`. **Exclude `invoice.paid` and `payment.recorded`** (money in). There is **no Bin event** (bin-api emits none), so offer ingestion stays REST-triggered.
  - [ ] Resolve the open human decision on the weekly digest's delivery channel (Banter, Blast, or in-app) and record the choice here before shipping `bursar-weekly-digest`.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.

  **Done when:** Playwright steps 10 and 11 pass: `/bursar/mismatches` shows a `price_drift` citing a baseline item with a real figure, `/bursar/renewals` shows Island Weather Feed in `t_minus_60`, no headline aggregate's `data-testid` band set includes `medium`, and no "clean" / "no gaps" affordance renders while any node is `needs_review`.

---

- [ ] **M9 - Permission chain, MCP parity, catalogs, docs, seed, e2e, close-out**

  The gate milestone. Permissions land here and only here, because `generate-permission-manifest.mjs`
  builds the catalog by walking route and tool files, which are only complete now. MCP parity is a hard
  requirement, not a nice-to-have: **every REST endpoint and every human UI action gets a `bursar_*`
  tool**, and normally endpoints and their tools land in the same commit rather than "tool later". Where
  earlier milestones added an endpoint, its tool is verified present here and the gap is treated as a
  defect. The permission two-pass ordering trap has burned this repo twice and is spelled out below.

  **Permission chain (two passes, numbers observed not hardcoded)**

  - [ ] Run `node scripts/generate-permission-manifest.mjs` (walks routes and tools into the manifest).
  - [ ] **Hand-review the generated flags against the spec 13.1 action table.** Confirm `bursar.usage.read` and `bursar.usage.attest` do **not** appear (deleted with the `dormant_seat` cut; they were unemittable by a route/tool walker and would fail the probe on a correct build), and confirm `bursar.spend.read_all` **does** appear via its route-file permission metadata.
  - [ ] Run `node scripts/build-permission-codegen.mjs`.
  - [ ] Run `node scripts/build-permission-delta.mjs`, which emits `<observed>_permissions_seed_actions_delta_0NN.sql`. **Observe the number it chose; do not assume one.**
  - [ ] Run `node scripts/check-permission-catalog.mjs`.
  - [ ] Apply pass one: `docker compose run --rm migrate`.
  - [ ] **ONLY NOW** author `<observed+1>_bursar_builtin_group_defaults.sql`. **The trap:** `build-permission-delta.mjs` computes its number as `max(prefix)+1` over the whole migrations directory, so a group-defaults file authored **first** runs **first**, its `CROSS JOIN permissions WHERE app='bursar'` matches zero rows, `ON CONFLICT DO NOTHING` swallows it, migrate reports success, the file is checksummed as applied, and **it can never re-run**, leaving every non-SuperUser at `implicit_deny` on every `/bursar` route.
  - [ ] Apply pass two: `docker compose run --rm migrate`.
  - [ ] Group grants per spec 13.2: `owner` and `admin` get every row; `member` gets every row not floored; `viewer` gets only the rows marked viewer (which excludes `spend.read_all` and `draft.read`); `guest` gets none. There is no `gate.override`, because the gate is advisory.
  - [ ] Run the spec 17.3 probe and assert it against a **parse of the 13.1 table**, not a literal:
        `SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted) FROM permission_group_defaults d JOIN permissions p ON p.id = d.permission_id JOIN permission_groups pg ON pg.id = d.group_id WHERE p.app = 'bursar' GROUP BY 1;`
        Sanity target only: `owner = admin = 36`, `member = 22`, `viewer = 10`, `guest = 0`. **If the probe disagrees with the table, the table wins.**

  **MCP parity (hard gate)**

  - [ ] Author `apps/mcp-server/src/tools/bursar-tools.ts`, client shaped like `createBurnClient` (`burn-tools.ts:55-80`), forwarding the caller's bearer token. Register every tool through `registerTool()`.
  - [ ] Implement the tool set from spec section 12: `bursar_level_quotes`, `bursar_scope_gap`, `bursar_vendor_view`, `bursar_mismatches`, `bursar_spend_by_vendor`, `bursar_renewals_due`, `bursar_exclusion_diff`, `bursar_get_matrix`, `bursar_get_totals`, `bursar_list_requests`, `bursar_get_request`, `bursar_get_scope_tree`, `bursar_upsert_scope_node`, `bursar_list_offers`, `bursar_get_coverage`, `bursar_get_baseline`, `bursar_list_awards`, `bursar_resolve_vendor`, `bursar_list_leveling_runs`, `bursar_draft_clarification`.
  - [ ] Add `bursar.*` to the `agent_policies` allowlist, and attach `confirm_action` to **every destructive tool**.
  - [ ] The four offer/coverage/totals/matrix read tools pass through the **shared seal predicate**. `asker_user_id` narrows both visibility and financial flooring, and bursar-api takes the **intersection** of the bearer's and the asker's capabilities, because mcp-server cannot backstop it (its own `BBB_PERMISSIONS_ENFORCE` defaults to `warn`).
  - [ ] **REST-row cross-walk:** walk every route registered in `apps/bursar-api/src/routes/` and confirm each has either a tool or an explicit skip reason. Documented skips: scope confirm and rival promotion (human gates), all award write routes (the freeze is a human act), uploads and spend import (multipart), coverage override and mark-wrong (human adjudication is the calibration ground truth), offer unseal, draft approve, settings and library writes, `/internal/*`, `/bursar/ws`, health, and both CSV exports.
  - [ ] **UI-action cross-walk:** enumerate every button, menu item, and context action in `apps/bursar/src/` and confirm each maps to a tool or a documented skip. A button with no tool is **not** caught by a REST-row scan, which is why this step is separate.
  - [ ] Add `BURSAR_API_URL` to the mcp-server service env in `docker-compose.yml` (following the `:190` precedent) and `BURSAR_API_INTERNAL_URL` to worker and bolt-api.

  **Catalogs, events, visibility**

  - [ ] `apps/bolt-api/src/services/event-catalog.ts`: add `bursarEvents` covering `request.created`, `request.manipulation_suspected`, `scope.derived`, `scope.frozen`, `offer.received`, `offer.normalized`, `offer.manipulation_suspected`, `offer.unsealed`, `quote.leveled`, `exclusion.detected`, `award.recorded`, `baseline.frozen`, `drift.detected`, `mismatch.opened`, `mismatch.resolved`, `renewal.approaching`, `draft.created`, `draft.decided`, `gate.advisory`.
  - [ ] Every publisher uses the **positional** `publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)` form documented at `CLAUDE.md:434`. `check-bolt-catalog.mjs` extracts the first two string literals, so an object-form call passes `undefined` at runtime **and** evades the guard. Events carry refs and scalars only, because Bolt fans out to webhooks and external runners.
  - [ ] `apps/api/src/services/visibility.service.ts`: add `bursar.vendor`, `bursar.request`, `bursar.offer`, `bursar.award`, `bursar.mismatch`, **and `bill.expense`** to `VisibilityEntityType` and `SUPPORTED_ENTITY_TYPES` with resolvers. `bill.expense` is missing today (`:113-153` lists `bill.invoice` and `bill.client` only), so under treat-non-ok-as-deny every drift citation would silently drop platform-wide. `bin.asset` is already supported, which is what made the M2 work reuse.

  **Docs, launchpad, marketing**

  - [ ] Confirm the Launchpad registration from M0 is live: `LAUNCHPAD_CATALOG`, `ROOT_REDIRECT_VALUES`, and `REDIRECT_MAP` all contain bursar, and the tile appears in the Launchpad from another app.
  - [ ] `scripts/docs/lib/tool-source.mjs`: `APP_TOOL_MODULES` gains `bursar: ['bursar-tools']`. Run `pnpm docs:catalog` and commit the regenerated `site/src/content/docs-catalog.generated.json`. Re-running must produce **no diff**. Do not hand-edit `site/src/pages/docs.tsx` beyond optionally adding an `APP_ICON` / `APP_COLOR` entry for `bursar`.
  - [ ] `docs/reference/mcp-endpoint-mapping.md`: add the full Bursar section covering every REST endpoint, its MCP tool or an explicit `— _(skip: <reason>)_`, the UI call sites, **and update the `## Surface summary` counts**. Self-check must print `0`: `grep -cE '^\| \`[^|]+\` \| — \|' docs/reference/mcp-endpoint-mapping.md`.
  - [ ] Update the marketing site's per-app MCP tool counts through the generated catalog (not by hand) and confirm `/docs` renders the Bursar entry with its tool list.
  - [ ] `CLAUDE.md`: add `bursar-api/` and `bursar/` to the `apps/` inventory with their ports and one-line descriptions, add the `/bursar/`, `/bursar/api/`, and `/bursar/ws` rows to the nginx route table, add bursar-api to the migrate `service_completed_successfully` dependency list, and update the mcp-server tool-count line via `pnpm docs:catalog`.
  - [ ] Help gate: run `node scripts/help/build-help-index.mjs --check` **against a rebuilt frontend image**, since `docs/apps/` is copied as a directory at `Dockerfile:241` and a stale image serves stale help.

  **Seed and capture (gilligan only)**

  - [ ] `scripts/seed-gilligan/bursar.mjs`, registered in `run-all.mjs` (`PHASES` at `:60-79`) in the **Billing** phase, since it needs `bond.mjs` companies and `bill.mjs` expenses.
  - [ ] Seed five vendors with messy aliases: Howell Industries Salvage (`HOWELL IND *SALVAGE`, `Howell Industries Inc`, `THURSTON HOWELL III HLDG`), Radio Parts & Coconut Wire Co, Lagoon Freight Lines, Island Weather Feed, Professor's Lab Supply.
  - [ ] Seed the request "Lagoon Rescue Beacon Procurement", owner Skipper, budget $18,000, category `hardware_purchase`, **14 nodes**, with mandatory nodes including "On-island installation and commissioning", "Crew training for six", and "24-month parts warranty", plus library-derived `should_have` nodes "Data export on termination" and "Price escalation cap".
  - [ ] Seed the four offers with computable provenance: Howell (PDF, stated $16,400, crew training `absent` and installation `excluded_explicit`, both valued at rung 2 from two rival observations, `gap_adjusted` $21,950); Radio Parts (spreadsheet, stated $19,100, warranty `partial` at 12 vs 24 months with `delta_kind='term'`, valued at **rung 1** from Radio's own optional "24-month warranty upgrade +$600" line, `gap_adjusted` $19,700); Lagoon Freight (email text, stated $17,800, warranty `absent` valued rung 2 at $1,200, escalation cap `unvalued`, `gap_adjusted` $19,000 plus an unvalued `should_have_supplement`); Professor's Lab Supply (PDF, stated $15,900, the **split-blanket** demo with four coordinated lines and no lexicon token, totals withheld).
  - [ ] The award goes to **Radio Parts**, not the lowest `gap_adjusted`, because Lagoon's absent warranty is disqualifying on a rescue beacon. Radio's baseline is **14 `included` rows** with the warranty carrying `delta_kind='term'`, zero `excluded_at_award`, zero `absent_at_award`. Bursar informs the decision; it does not make it.
  - [ ] Seed post-award examples, one per detector: `price_drift` (Island Weather Feed 40% above baseline), `scope_divergence` ("expedited lagoon delivery" with no baseline line), `unbaselined_vendor` (Professor's Lab Supply, four recurring charges, no award), `renewal_cliff` (Island Weather Feed at `t_minus_60`), plus an `orphaned_custody` badge.
  - [ ] Export `BURSAR_SEED_EXPECTATIONS` from `scripts/seed-gilligan/bursar.expectations.mjs` (offer totals, gap counts, node count, baseline composition) and have the Playwright suite **import it** rather than restating literals. This is the third round a seed-number mismatch surfaced; one source is the fix.
  - [ ] **Never seed** `e2e-admin@bigbluebam.test`, "E2E Test Organization", or "screenshots-demo". Gilligan only.
  - [ ] `packages/docs-capture/recipes/bursar/bursar.yaml` capture recipe, producing `docs/apps/bursar/screenshots/`. Use the docs-capture engine, **not** the bespoke braid/bulwark capture scripts.

  **Verification and close-out**

  - [ ] Full 12-step Playwright user-story pass as Skipper against gilligan data, with assertions importing `BURSAR_SEED_EXPECTATIONS`: (1) `/bursar/`, open the request, see the seeded node count, click a citation popover; (2) promote "Price escalation cap" to `mandatory` and Confirm scope; (3) Matrix shows four offer columns with a red `absent` chip at (Crew training, Howell); (4) clicking it renders rejected candidates and reasons; (5) the rival-promotion queue shows N pending rival-derived nodes and **none appear in the diff**, then promote one and assert it appears; (6) Diff ranks Howell's `excluded_explicit` above all-offers-absent notes and "installation by others" is on the page; (7) `gap_adjusted(Howell) > gap_adjusted(Radio)`, the punchline; (8) Professor's Lab Supply shows `offer_manipulation_suspected`, zero auto-published `covered`, **and all 14 mandatory nodes in the diff** with `withheld_reason='blanket_cap'`; (9) award to Radio Parts with the structural baseline assertions; (10) mismatches and renewals render real figures; (11) the two negatives (no `medium` in any headline band set, no "clean" affordance while anything is `needs_review`); (12) the HelpTrigger opens and the Bursar guide loads.
  - [ ] Integration test: a bill expense produces `expense.submitted` -> `bursar_ingest_events` -> a spend event -> drift -> `mismatch.opened`. Plus all five Bin access cases 404 or block and write nothing.
  - [ ] Convention gates, all green: `pnpm db:check` (0 drift), `pnpm lint:migrations`, `node scripts/check-bolt-catalog.mjs`, `node scripts/check-permission-catalog.mjs`, the 17.3 probe-versus-table assertion, the surface-map bare-dash check printing `0` plus a fresh `## Surface summary`, `pnpm docs:catalog` producing no diff, `node scripts/help/build-help-index.mjs --check`, `grep -c bursar infra/nginx/*.conf` non-zero for all three files, `docker compose exec frontend nginx -t`, `tsc --noEmit`, and Biome.
  - [ ] Promote the frontend's `depends_on: bursar-api` from `condition: service_started` to `condition: service_healthy`.
  - [ ] File every pre-existing defect found along the way as a task rather than working around it, including: `burn-extract-deliverables.job.ts:56-61` and bulwark's equivalent joining `bin_assets` with no org predicate and no `can_access`/`scan_status` check; `extraction.engine.ts`'s pre-loop `let ordinal = 0` and its `log.debug; continue` on `LlmError`; `proposals.routes.ts` `shadowOnly` gating meaning proposal routes never deny and any org admin reads every app's proposals; `brief-embed.job.ts` upserting into a `brief_documents` Qdrant collection nothing creates; the missing `bill.expense` visibility type (fixed here, but note the platform-wide history); `scripts/help/smoke-help-center.mjs` hardcoded to Bam with a `D:/Documents/GitHub/...` `OUT` default; unescaped CSV exports in bearing-api and the frontend timeline export; and the platform-wide absence of an nginx `resolver` directive, which makes every future app addition capable of taking the suite down at config load.
  - [ ] Commit, push, run `post-commit-review`, clear every `automated-review` issue.
  - [ ] Run the `close-out` skill as the final audit before declaring the cycle done.

  **Done when:** every spec 20.5 convention gate is green and the 17.3 probe matches a parse of the 13.1 action table.

---

## Open human decisions carried by this build

These are recorded in spec section 25 as human decisions, not build decisions. Surface them rather than
picking silently.

- [ ] **Who may unseal a sealed bid, and whether the vendor is told.** The audit trail is a security requirement and is built regardless; the policy is a human call.
- [ ] **The weekly digest's delivery channel** (Banter, Blast, or in-app). Needed before M8 ships `bursar-weekly-digest`.
- [ ] **Fixture hand-labelling.** 40 absence tuples, 8 injection, 3 single-blanket, the split-blanket set, name-list, legitimate-subprice, and the 40-page long-document fixture, labelled by someone who understands procurement. **M2.5 cannot complete without it.**
- [ ] **The cumulative cap values.** `blanket_cumulative_cap` 4 and `evidence_concentration_floor` 0.5 are chosen, not derived. Per-org configurable; the `legitimate-subprice` fixture is the false-positive guard.
- [ ] **Long-document viability.** If M2.5's measurement cannot meet the missed-exclusion gate, the v1 envelope drops to 5-page documents and longer offers are surfaced as "too long to level reliably". This is the risk most likely to reshape scope.
