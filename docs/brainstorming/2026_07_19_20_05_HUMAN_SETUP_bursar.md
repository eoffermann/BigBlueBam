# Human setup - Bursar (cycle 2026_07_19_20_05)

Actions that require a human keystroke. Everything not listed here was built and wired
autonomously on the `suite-brainstorm` branch.

This doc holds only three categories: an external secret or third-party account, a
harness-blocked keystroke that could not be run from the build environment, and the
standing note that promotion to trunk is the maintainer's call. Internal engineering is
never parked here.

**Open items: 2** (plus the standing promotion note).

---

## 0. Hand-label the M2.5 false-absence corpus (procurement-literate)

- [ ] **What:** produce a **>= 40-tuple** absence corpus, hand-labelled by someone who
      understands procurement, so the M2.5 false-absence spike number can be measured. This is
      the ONE genuinely human-blocked item in the flagship. All of the M5 engine machinery
      (the three predicates, the classify decision table, the six verdicts, the merge lattice,
      exclusion pinning, the four coverage-collapse defenses, banding, the diff-completeness
      invariant, the async-start engine with claim fencing) is BUILT and unit-tested now; only
      the false-absence RATE measurement needs expert labels.

- **Why the build could not do it.** A tuple is `(offer document, requirement node, the TRUE
      verdict)`. The true verdict is a judgement about whether a real vendor quote covers a
      real requirement - exactly the procurement expertise the product exists to encode. An
      autonomously-generated label would be marking its own homework: the classifier's own
      output cannot be the ground truth for measuring the classifier. The deterministic
      fixtures that do NOT need expert labels (split-blanket, single-blanket, injection,
      name-list, legitimate-subprice) were built and are asserted in CI at
      `apps/bursar-api/test/coverage-adjudication.test.ts` and `test/fanout-pinned.test.ts`.

- **Exactly which files to create** (under `apps/bursar-api/test/fixtures/`):
  - `false-absence/corpus.json` - an array of >= 40 objects
    `{ id, offer_text, node_title, node_strength, true_verdict }` where `true_verdict` is one
    of the six verdicts, labelled by the expert. Keep the offer texts realistic (multi-page,
    with a terminal exclusions block on at least one) and the node set drawn from a real RFQ.
  - `false-absence/recorded/<id>.json` - the RECORDED classifier response for each tuple, so
    CI replays deterministically (the stubs never hit the real 60s proxy). Capture these with
    the harness below.

- **How to run the spike + record the three numbers** into
  `docs/brainstorming/2026_07_19_20_05_WORK_IN_PROGRESS_bursar.md` under the M2.5 milestone:
  1. Seed the corpus files above.
  2. Run the classifier against the REAL internal proxy ONCE to capture recordings, with
     `X-Internal-Service: bursar` and `BURSAR_LLM_TIMEOUT_MS=60000` (matching the proxy's
     hardcoded 60s deadline; Burn's inherited 15000 aborts routinely and an aborted client does
     not release the proxy slot for 90s). Save each response to `recorded/<id>.json`.
  3. Replay the recordings through `adjudicateOffer` and compute:
     - **Number 1 - false-absence rate on PUBLISHED verdicts:** of the tuples the engine
       auto-published as `absent`, the fraction whose `true_verdict` is not `absent`. Target
       `<= 0.05`.
     - **Number 2 - tokens + wall-clock on the 40-page worst-case fixture** (compare against
       proxy concurrency 4/service, rate 120/min, and the caps `max_nodes_per_run` 400,
       `max_offers_per_run` 8, `max_llm_calls_per_run` 250).
     - **Number 3 - ZERO auto-published `covered`** on the injection, single-blanket, and
       split-blanket fixtures (this one is ALREADY asserted in CI today; record the count).
  4. Write the three numbers into the WIP doc. If the missed-exclusion gate on the long
     document cannot be met, record the envelope decision (5-page v1) there and adjust M5/M6
     scope, per the M2.5 checklist.

- **If you skip it:** the engine ships and every deterministic gate stays green, but the
  headline `<= 0.05 false-absence` claim is unmeasured - it must not be quoted as achieved
  until Number 1 is recorded against expert labels.

---

## 1. Raise `max_connections` on the Railway-managed Postgres

- [ ] **What:** raise `max_connections` from the stock 100 to 200 on the Railway Postgres
      service, and if the plan allows it, raise `shared_buffers` to 512MB.

- **Why it matters.** Every API service in the suite opens a connection pool (`max: 20`,
  plus a second read pool where `DATABASE_READ_URL` is set). With 24 API services plus the
  worker and the mcp-server, the theoretical ceiling is far above 100; it only works today
  because pools fill lazily. Bursar adds long-held advisory locks and a set of scheduled
  jobs, which is the workload shape that converts latent oversubscription into real
  `FATAL: sorry, too many clients already` errors. The failures would surface in *other*
  apps first, so this typically presents as a Bond or Bill outage rather than anything that
  points at Bursar.

- **Why the build could not do it.** Railway Postgres is a managed plan. Neither this
  repository nor the deploy adapters in `scripts/deploy/` can set server parameters on it;
  there is no compose `command:` to override. The local dev stack was raised to 200 and
  verified, so this gap exists only in production.

- **Where:** the Railway dashboard for the Postgres service on the BigBlueBam project, under
  the service's variables or plan configuration. On plans that expose it, this is the
  `POSTGRES_MAX_CONNECTIONS` service variable; on others it requires a plan change.

- **Verify afterwards:**

  ```sh
  psql "$RAILWAY_DATABASE_URL" -c "SHOW max_connections;"
  ```

  Expect `200`. The local equivalent already returns 200:

  ```sh
  docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SHOW max_connections;"
  ```

- **If you skip it:** production keeps the stock 100 and stays at the pre-existing risk
  level. Bursar itself will still work; the risk is suite-wide connection exhaustion under
  load, which predates Bursar and which Bursar makes somewhat more likely. The deploy
  catalog records this as a `tuning` block with `applied_on_railway: false` so it is not
  silently forgotten.

---

## 2. Promotion to `main` / `stable` (standing note, no action required)

The autonomous loop never merges to trunk. All Bursar work lives on `suite-brainstorm` and
on feature branches off it. Promoting any of it to `main` and then `stable` is the
maintainer's decision, taken separately from this cycle. The loop does not wait on it.

## Remaining live-completion tail (recorded 2026-07-20)

Bursar M1-M9 is code-complete, CI-green, and backend-live at M9 (bursar-api,
worker, mcp-server all rebuilt and serving M9; migrations 0247-0259 applied;
36 permissions seeded; 20 MCP tools registered; 10 worker jobs firing). The
following finish the consumer-facing surface. None is core engineering; each is
either an external dependency or a mechanical live run.

- [ ] **Frontend `--no-cache` rebuild.** The plain `docker compose build frontend`
      reused a stale cached image (missing the bursar SPA). Fix:
      `docker compose build --no-cache frontend && docker compose up -d --force-recreate frontend`.
      Verify: `curl -s -o /dev/null -w '%{http_code}' http://localhost/bursar/` prints 200.
      (In progress at hand-off.)
- [ ] **LLM provider for the flagship flow (EXTERNAL SECRET).** The derive ->
      confirm -> level -> award chain calls the internal LLM proxy, and this dev
      stack has **0 llm_providers** configured, so the gilligan seed only produced
      the request + 5 fallback nodes + 4 offers + spend (no confirmed tree, no
      coverage, no award). Either (a) configure an org LLM provider (an
      Anthropic/OpenAI key via /b3 Settings -> AI, which cannot be self-issued),
      OR (b) preferred: extend `scripts/seed-gilligan/bursar.mjs` to
      DETERMINISTICALLY materialize the confirmed 14-node tree + the leveled
      coverage matching `BURSAR_SEED_EXPECTATIONS` (Howell crew-training absent +
      installation excluded_explicit; Radio warranty partial/term; Lagoon warranty
      absent; Professor split-blanket withheld=blanket_cap) + offer_totals + the
      Radio award/baseline, via direct inserts (the seed runs in the api container
      with DATABASE_URL). Option (b) makes the demo + e2e reproducible without any
      external key and matches spec 19's "computable provenance" intent.
- [ ] **gilligan screenshots.** Once the demo data + frontend are live, run the
      docs-capture recipe `packages/docs-capture/recipes/bursar/bursar.yaml` to
      produce `docs/apps/bursar/screenshots/`, and copy the marketing set into
      `site/public/screenshots/bursar/{light,dark}/`.
- [ ] **Live 12-step Playwright.** `E2E_ADMIN_EMAIL=skipper@gilligantravel.example
      pnpm --filter @bigbluebam/e2e test src/apps/bursar` against the seeded stack.
- [ ] **Re-add the Launchpad tile (LAST).** Only after screenshots exist and the
      12-step passes: re-add the `bursar` row to LAUNCHPAD_APP_IDS + LAUNCHPAD_CATALOG
      in apps/api/src/routes/system-settings.routes.ts (the two marker comments say
      where), rebuild api, run `pnpm docs:readme && pnpm docs:catalog`, and confirm
      `pnpm check:app-completeness` exits 0 for bursar. The completeness gate blocks
      this until the screenshots + marketing + help all exist - by design.
