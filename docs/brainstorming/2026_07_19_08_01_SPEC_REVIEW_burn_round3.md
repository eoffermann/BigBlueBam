# Burn spec - adversarial review round 3 (final)

**7 blockers, 15 majors.** Scoped verification pass, not a fresh review.

**Round 2 findings verified RESOLVED:** R2-D1, D4, D5, D6, D7, D8 (in substance);
R2-S1, S4, S5, S6, S7, S8, S9 (response layer); R2-T1 (citation and mechanism),
T3, T4, T6, T7, T9; R2-I2 (for the five named services), I3, I4, I5, I6, I7.

**Character of this round:** almost every finding is a consequence of a round 2
fix rather than an original defect. The fixes are now generating the findings,
which is what a converging spec looks like. All fixes below are mechanical or
narrow; none requires a design change.

---

## DESIGN (2 blockers, 3 majors)

### R3-D1. blocker - `not_to_exceed` books revenue the firm can never invoice

Grouped with `fixed`, so it gets `revenue_basis='contract_value'`. But NTE is T&M with a ceiling: the firm bills actual work up to the cap, never the cap. A $6,000 NTE that delivered $2,000 reports `margin = 6000 - attributed_cost`, booking $4,000 that will never be invoiced. This is R2-D2's defect inverted, and it **overstates**, which is the direction the buyer cannot detect. It fires on the seeded "Coconut Supply Chain Assessment" chain, and §12.1 tests `fixed`, `retainer`, and T&M but never NTE.

**Fix.** Split the row: `not_to_exceed` gets `revenue_basis='billable_recognized_capped'` with `revenue = min(attributed_billable, effective_cap)` and `margin = revenue - attributed_cost`, behaving as T&M until the cap binds. Keep `margin_state='in_progress'` until the chain closes. Envelope and deny arithmetic against the cap are unchanged. Add the fourth basis to the §12.1 assertion.

### R3-D2. blocker - The amendment deliverable has no defined activation path and no attribution exclusion

Two unresolved forks, both bad. (a) Created inactive, §2.2.1's rule that `is_active` is set only by `POST /confirm-envelope` means the effective envelope never rises after an approved change order and **the flagship loop still does not close** - story 3's "a new $300 expense now posts instead of being denied" fails. If `proposal.decided` flips it instead, that is a second writer of `is_active`, contradicting §2.2.1 and §12.1. (b) Created active, it is a deliverable on a chain linked to the same project, so §2.3.4 and §5.3 surface it as an attribution candidate. Work attributes to the amendment row instead of the base, **splitting consumption off the base row** - exactly what the base-row invariant exists to prevent. Base consumption understates, the gate under-blocks, and because the amendment's own `envelope_amount` is NULL it is unpriced and therefore excluded from `envelope_overrun` and `consumption_erosion`, so the split dollars are invisible to variance detection too.

**Fix.** State that an amendment deliverable (`amends_deliverable_id IS NOT NULL`) is a **pure envelope-delta carrier**: never an attribution target, excluded from candidate assembly in §2.3.4 and from structural/precedent/lexical resolution in §5.3, never in `DeliverablePicker`, and any attribution naming it resolves to its base row. Give its activation its own named state (`delta_confirmed_by` / `delta_confirmed_at`, set on `proposal.decided`) so `is_active` keeps exactly one writer. Add to §12.1: after a change order, the base deliverable's consumption includes post-amendment work and no attribution rows point at the amendment deliverable.

### R3-D3. major - Retainer per-period margin has nowhere to live

§1.2.1 says retainer margin is computed "per period", but `burn_engagement_rollups` is `UNIQUE (organization_id, chain_root_id)` with no period columns, and `GET /v1/financials` serves the rollup rather than computing live. An implementer must silently pick current, trailing, or lifetime, and the seeded Castaway Rescue Retainer renders whichever with no label. §12.1's "a retainer chain computes per period" has no storable output to assert against.

**Fix.** Either (a) add `period_start`/`period_end` and change the unique key to `(organization_id, chain_root_id, period_start)` with non-retainer chains carrying a single NULL-period row, or (b) state the rollup row is always the **current** period for a retainer, add `period_start`/`period_end`/`period_index` as descriptive columns, and expose prior periods through a separate burn-down series. Name it in §3.1, §8.1, and the §12.1 assertion, and carry period bounds on the money response alongside `as_of`.

### R3-D4. major - Invoice-derived valuation double-counts the hours R2-D1 just de-duplicated

Verified in the tree: `bill_line_items` carries `time_entry_ids uuid[]` and `apps/bill-api/src/services/invoice.service.ts:462-493` builds line items directly from `time_entries`. An invoice is therefore a **restatement of hours already priced as `bam.time_entry`**, so valuing it at its total prices the identical work twice - R2-D1's exact failure class on a second source. Separately Burn subscribes to `bill:invoice.created` and `invoice.finalized` but no `bill.invoice` source type exists in the enum, so an implementer will invent one and reach for the neighbouring `bill.recurring` rule ("generated invoice total"), landing the double count by default. Even on the clean recurring path, a retainer chain consumes from both the $4,500/mo generated invoice and the hours logged against it - the seeded Castaway Rescue chain.

**Fix.** State the second precedence rule as explicitly as the first: **invoices and recurring invoices are revenue restatements, not consumption.** Give `bill.recurring` `valuation_basis='none'` when the generated invoice's line items resolve to already-ingested `time_entry_ids` or an already-ingested `bill.expense` (via `bill_expenses.invoice_id`), pricing only the genuinely-new flat-fee remainder. Add `bill.invoice` to the enum with the same rule, or delete `invoice.created`/`invoice.finalized` from §8.3 and say why. Test: invoicing 10 already-ingested hours does not change `attributed_billable`.

### R3-D5. major - The mandatory money-block fields and the contributor-floor suppression contradict each other

§6.1(b) and §1.2.2 require **every** money response to carry `metric_basis`, `revenue_basis`, `cost_rate_coverage_pct`, and `as_of`, made structural by a discriminated union a response "is not constructible without". §2.4(17) then requires `cost_rate_coverage_pct`, `margin_amount`, and `margin_pct` to be **suppressed entirely, not banded**, below `min_contributors_for_cost_aggregate`. These cannot both hold. The Gilligan seed deliberately creates a single-contributor chain to demonstrate suppression, so this fires on the first member-tier Portfolio Board load: either Zod validation fails, or the implementer loosens the union to optional, which re-opens the "a model drops the sibling key" hole R2-D8 closed.

**Fix.** Make suppression a **third discriminant member** rather than an absence. Add `metric_basis='suppressed'` (or a `disclosure` discriminant with `full | suppressed`) carrying `suppressed_reason`, `revenue_basis`, `as_of`, and the consumption band only, with no cost, margin, or coverage keys. That preserves the not-constructible-without-a-discriminator property and the absent-not-banded property, and gives `ContributorFloorNotice` a typed thing to render. Restate §6.1(b) as "carries `metric_basis` and `as_of`; remaining fields are per-variant."

---

## SECURITY (2 blockers, 3 majors)

### R3-S1. blocker - `redactFinancialFields(row, viewerCaps)` never says how `viewerCaps` is derived, and the only in-tree probe returns `true` unconditionally

burn-api is a satellite, so it registers `httpPermissionsPlugin`. That plugin's `canResolve` is a hardcoded stub: `packages/permissions/src/index.ts:307-319` is literally `// The HTTP plugin doesn't expose a synchronous probe today. ... return true;`. The single in-tree precedent for field flooring in a satellite is `apps/bulwark-api/src/routes/deadlines.routes.ts:21-23`, which calls `fastify.canResolve(...)` and **therefore already floors nothing**. An implementer copies that precedent, `viewerCaps` reports `read_all` for every caller, and `cost_amount` ships on `/v1/work-items` to every project member. `cost_amount / (minutes / 60)` for one time entry is that person's hourly cost to the cent - R2-S3 reopened at a 100 percent rate rather than only during a resolver blip. The R2-S1 boot assertion does not help: `canResolve` ignores `mode` entirely, and the second in-route guards cover five routes, none of which is `/v1/work-items`.

**Fix.** State in §2.4(2) that `viewerCaps` is built by an explicit fail-closed `POST /internal/permissions/dual-read` for `burn.financials.read_all` and `burn.costrate.read` (the shape at `apps/bulwark-api/src/subscriptions/proposal-decided.ts:88`, where anything other than explicit `'allow'` is `false`), resolved **once per request** and threaded into the serializer. Explicitly forbid `fastify.canResolve` as the source. Add a §12.1 assertion that with the resolver stubbed non-2xx, `/v1/work-items` returns no `cost_amount`. [The `canResolve` stub and the live Bulwark flooring bypass are tracked separately as a platform task.]

### R3-S2. blocker - On MCP surfaces the serializer's identity is ambiguous between bearer and `asker_user_id`

burn-api sees a service-account bearer; `asker_user_id` narrows the row set but is, per §2.2.1, "a visibility parameter, not an approval". If `viewerCaps` keys off the bearer, an agent acting for a member asker returns fully unfloored `cost_amount` and `envelope_*` - per-person compensation delivered to a member through the agent channel. Bulwark hit this exact hazard and wrote a specific rule (`deadlines.routes.ts:11-19`), resolving it by failing the body closed whenever any asker context exists. Burn inherits it on eight surfaces and states no rule. mcp-server cannot backstop this: `register-tool.ts:512` reads `BBB_PERMISSIONS_ENFORCE ?? 'off'` from **mcp-server's** env (compose default `warn`), so its per-action check never denies, and `checkPermissionViaResolver` returns `'unknown'` as pass-through on failure.

**Fix.** Adopt Bulwark's rule verbatim in §2.4(2) and §11.1: when `asker_user_id` is present and differs from the bearer, `viewerCaps` is the **intersection** of bearer and asker capabilities, and any unresolvable asker fails the floored fields closed. Test: an admin service-account bearer with `asker_user_id` set to a plain member gets no `cost_amount` from `burn_list_unscoped`.

### R3-S3. major - The deny verdict is itself an oracle, so quantizing `overage_amount` does not stop exact recovery

The caller controls `proposed_amount` and the verdict flips at `proposed_amount > envelope_remaining`. Binary search recovers `envelope_remaining` **exactly** in ~24 probes regardless of bucket coarseness; on a freshly confirmed deliverable that is `envelope_amount`, and summing gives `contract_value`. `usr_precheck_daily_cap` (200) permits ~8 full recoveries per member per day. §12.1's "not recoverable to within 5 percent" is unsatisfiable by an honest implementation - verbatim the failure mode R2-S2 warned would cause an implementer to weaken the test instead of the response.

**Fix.** Add a per-(member, deliverable) daily probe cap far below the org cap (5 is sufficient, since a real charge is prechecked once), and quantize the **decision input**: evaluate the deny against `envelope_remaining` rounded down to `overage_bucket_amount` for non-`read_all` callers, so the boundary carries at most one bucket of information per deliverable regardless of probe count. Restate the assertion as "not recoverable to finer than `overage_bucket_amount`". Raise a variance on repeated near-boundary prechecks against one deliverable.

### R3-S4. major - `search_tsv` is a member-queryable text oracle over the two fields R2-S9 just floored

The R2-S9 fix removes `description` and `quote` from the response but leaves both inside a GIN-indexed generated column on a table members can list with the suite's standard `?filter[field]=value` convention. If the implementer adds the obvious `filter[q]` over `search_tsv` (which the FTS index and §2.3.4's lexical retrieval both invite), a member confirms the presence of any term in the floored clause text one probe at a time, reconstructing a rate schedule or exclusivity terms without reading a floored field. Same for `burn_classifier_feedback.search_tsv` over `text_snapshot`. Field flooring that leaves the field searchable is not flooring.

**Fix.** State in §3.1 and §6.1 that **no member-reachable endpoint may filter, sort, rank, or highlight on `search_tsv` or any `read_all`-floored column**; a `q` filter on `/v1/deliverables` for a non-`read_all` caller matches `title` only, via the separate GIN trigram index already declared. `search_tsv` is reserved for internal candidate assembly and `read_all` callers. Add the negative test.

### R3-S5. major - Per-person cost rates are recoverable by differencing cost aggregates over time

Above `min_contributors_for_cost_aggregate` (3), a member receives `attributed_cost` and a burn-down **series**. §13 non-goal 6 explicitly preserves per-person hours to project members, and §12.1's own surveillance test performs the `source_id` to `time_entries.user_id` join. So the attacker has, per day, the exact per-person hour vector and one aggregate cost scalar. Three or more daily snapshots on a 3-contributor chain solve the cost-rate vector by least squares, recovering exactly what §13 point 11 promises is floored behind two guards. The burn-down series hands over the time dimension in a single request. R2-S10 hardened the one-contributor snapshot and left the time series untouched, and §6.1 says "banded" without ever defining a band width.

**Fix.** Define the cost band in §2.4(17) as **deterministic bucketing to a fixed grid** (not rounding of a moving value), wide enough that a one-person day cannot move the bucket, applied to `attributed_cost`, `margin_amount`, and every burn-down point for non-`read_all` callers. Or simply floor `attributed_cost` and `margin_amount` to `read_all` and give members `consumption_pct` only, which is what the §1.2.1 basis model already needs. Test: ten daily snapshots plus the Bam hours join do not resolve any individual's rate to within one band.

---

## STABILITY (2 blockers, 5 majors)

### R3-T1. blocker - The blanket xact-lock rule puts multi-minute LLM work inside an open Postgres transaction

R2-T1's fix is correct for the sweeps and wrong generalized. `pg_advisory_xact_lock` cannot outlive its transaction, so a per-engagement xact lock on extraction means the whole chunked extraction runs in one transaction. §4.1 step 3 persists `last_processed_chunk` per chunk for resumability, and those writes are not durable until commit, so a crash rolls back every checkpoint and a 40-page MSA restarts from chunk zero, re-spending the full LLM budget on every retry. Same shape on `burn-attribute-batch`: 25 items x one LLM call each held open, at `concurrency: 2` across 2 replicas, is up to 4 long idle-in-transaction sessions on the highest-churn table, blocking autovacuum on `burn_work_items` and stalling `burn-variance-sweep` behind the same per-org lock for minutes.

**Fix.** Scope the blanket rule to the SQL-only sweeps (`burn-variance-sweep`, `burn-silent-deliverable-sweep`, `burn-rollup-refresh`, `burn-calibration-recompute`, `burn-retention`, `burn-revalue`). Add a hard rule: **no transaction holding an advisory xact lock may contain an outbound HTTP call.** For `burn-extract-deliverables` and `burn-attribute-batch` the mutual-exclusion mechanism is the row claim plus the live-row upsert (§4.2 already names claims as the correctness mechanism), with the xact lock taken only around the short claim and short commit transactions, and each chunk checkpoint committed in its own transaction.

### R3-T2. blocker - `burn_attributions` amount snapshots are outside the revalue path

`deliverable_id` lives on the attribution, not the work item, so every per-deliverable consumption figure - including the gate's deny arithmetic in §5.3 - must join `burn_attributions`. Revalue rewrites amounts in place on `burn_work_items` and explicitly "never supersedes an attribution", and nothing says it updates the snapshot. Two outcomes, neither stated: if consumption sums the attribution snapshot, adding cost rates leaves `attributed_cost` null forever and the board never flips to Margin (R2-T2's exact failure relocated, and story 2 still fails); if consumption sums the work item, the snapshot diverges permanently and the gate and rollup disagree about the same dollars with no reconciliation path.

**Fix.** Name one authoritative source for every money aggregate. Either (a) declare the attribution amounts a denormalized cache that `burn-revalue` updates in the same transaction as the work item, parallel to the `attribution_state` denormalization mapping already published, with a §12.1 assertion they never diverge; or (b) delete the columns and make every consumption and rollup query join `burn_work_items` for amounts, keeping the attribution as the classification decision only. **(b) is cleaner and removes a whole staleness class.** Say which.

### R3-T3. major - `burn-revalue` has no failure semantics, so a transient bill-api hiccup demotes valued rows to `unrated`

§2.3.1.2's `unrated` rule was written for **first** valuation, where excluding rather than zeroing is correctly conservative. Revalue re-runs valuation on rows that already have good dollars. A rolling bill-api restart during the nightly pass rewrites `valuation_basis='unrated'` over a correct `billable_amount`, and those items drop out of consumption and the rollup wholesale. Consumption collapses, the burn-down looks healthy, the gate under-blocks - the direction the buyer cannot detect, which is the failure R2-I5 was written to prevent, arriving through the job R2-T2 added.

**Fix.** State that revaluation is fail-safe and monotonic in information: on a resolve failure it leaves `billable_amount`, `cost_amount`, `valuation_basis`, and `valued_at` **untouched**, increments a retry counter, and surfaces "N items awaiting revaluation" separately. `unrated` may only be written to a row that has never been successfully valued (`valued_at IS NULL`). Negative test: with `/internal/rates/resolve` returning 404, run `burn-revalue` and assert no previously-valued work item changes and no rollup moves.

### R3-T4. major - `burn-revalue`'s trigger set is incomplete and its selection predicate is not computable

(a) "Triggered by observed `bill_rates` changes" has no mechanism: `apps/bill-api/src/routes/rates.routes.ts` publishes no Bolt events and the catalog has no `rate.*` entry, so a client-rate correction is invisible until the nightly pass. (b) The nightly pass selects "work items whose `valuation_epoch` no longer matches", which is circular: computing the current epoch requires resolving `bill_rate_id` and `burn_cost_rate_id`, and that is one HTTP call per item. The declared `(organization_id, valued_at)` index does not narrow the set. So the catch-up is one bill-api round trip per work item per night, unbatched, with no backoff, against a service whose failure currently downgrades the row.

**Fix.** Add `rate.created` / `rate.updated` to `billEvents` in this build (Burn already adds `expense.created`/`expense.approved`, so the pattern and drift-guard registration are budgeted) and subscribe in §8.3. Give `POST /internal/rates/resolve` a **batch form** taking `(user_id, project_id, date)` tuples. Scope the on-write trigger to the set derivable from the rate row itself (`user_id`, `project_id`, and the `effective_from`/`effective_to` range against `occurred_at`) rather than a full-table epoch comparison. State the nightly pass as a bounded sweep over `valued_at < now() - interval` with a per-run item cap and flushed progress logging.

### R3-T5. major - Retention sets `frozen_at` without recomputing first

R2-T5 stopped the hourly refresh from overwriting the record but never established **what** the record is. `burn-retention` runs at 05:00 and stamps `frozen_at` on a row the hourly job last touched up to 60 minutes earlier and which may be served with `stale: true` up to `rollup_max_age_minutes` (120). That stale figure becomes immutable and uncorrectable, because both write paths now skip it. Worse, a **missing** rollup is computed synchronously on read: if a closed chain has no rollup row at purge time, retention freezes nothing, the work items are gone, and the first `GET /v1/financials` computes and persists **$0** as the permanent record.

**Fix.** Specify retention as one transaction per chain: recompute the rollup to final, set `frozen_at` and `margin_state='final'`, **then** purge the work items. Make the freeze an upsert so a missing row is created rather than skipped. Assert in §12.1 that the frozen figure equals the **pre-purge computed** figure, not merely "unchanged after the refresh runs", which passes trivially on a stale or absent row.

### R3-T6. major - `method='human'` vs `method='inherited'` contradiction lapses the human-precedence invariant on the second edit

The invariant's predicate is `state='confirmed' OR method='human'`. §2.3.10 line 290 writes the carry-forward as `method='human'`; §3.1 line 519 and the changelog write it as `method='inherited'`, which satisfies neither arm. Under the schema reading the first edit inherits correctly, and the **second** epoch change finds neither `confirmed` nor `human` and re-classifies from scratch - R2-T8's failure with a one-edit delay. §12.1's test edits once and passes either way.

**Fix.** Keep `inherited` as the audit-visible method and change the invariant predicate to `state='confirmed' OR method IN ('human','inherited')`, stated in both §2.3.10 and §3.1. Extend the test to **two** successive `classification_epoch` changes, asserting the human decision survives both with zero llm-provider calls.

### R3-T7. major - No conflict handler for the first insert under the new live-row unique index

The supersede-then-insert path is safe because it holds `SELECT ... FOR UPDATE` on an existing live row. When no live row exists - the common case for a newly created expense - the bolt-dispatch path (`POST /v1/internal/events`, which takes no per-org lock) and reconcile pass 1 can both see "no live row" and both insert, hitting the index with a 23505. Nothing states the handler. Unhandled it aborts the org's sweep transaction; `ON CONFLICT DO NOTHING` silently drops the newer observation. §4.2's "converge on exactly one live row in every ordering" is an assertion with no mechanism, and §12.1 exercises only sequential orderings.

**Fix.** State the ingest write once as `INSERT ... ON CONFLICT (organization_id, source_type, source_id) WHERE attribution_state <> 'excluded' DO UPDATE SET ...` with compare-and-set on `classification_epoch`/`cost_epoch` (DO NOTHING only when both hashes are equal), used identically by the event path and pass 1. Add a concurrency case asserting simultaneous event-path and pass-1 observation of the same source record yields one live row, correct dollars, and no aborted sweep.

---

## INFRASTRUCTURE (1 blocker, 4 majors)

### R3-I1. blocker - Burn's own catalog declares four env names with no hint, one required, so burn-api is never created on Railway

§9.6 declares `BBB_PERMISSIONS_ENFORCE` **required** on burn-api. `hintFor('BBB_PERMISSIONS_ENFORCE')` returns `{kind:'unknown'}`, and `railway-orchestrator.mjs:149-152` throws on a required var resolving to SKIP. The deploy aborts before the service exists - the exact failure R2-I1 was raised to prevent, reproduced by Burn itself. `MAX_DOC_BYTES`, `MAX_DOC_PAGES`, and `BRAID_API_INTERNAL_URL` are optional-with-no-hint, so they are silently omitted: Burn's braid counterparty resolution is simply absent in production with no signal.

**Fix.** Add to the §9.6.2 block: `BBB_PERMISSIONS_ENFORCE: { kind: 'literal', value: 'warn' }` (matching the `${BBB_PERMISSIONS_ENFORCE:-warn}` default at `docker-compose.yml:125` and 19 other sites; burn-api's compose entry sets `on` explicitly), `BRAID_API_INTERNAL_URL: { kind: 'computed', value: internal('braid-api') }`, and literal hints for `MAX_DOC_BYTES` / `MAX_DOC_PAGES`. Reconcile §9.8's "expect all four vars" against §9.6.2's "add the three new bill-api vars to `.env.example`" - there are four.

### R3-I2. major - The coverage test cannot be committed green: 16 pre-existing catalog names resolve to `unknown`

Running the assertion against the current catalog yields 17 missing names; the spec adds a hint for one. An autonomous build writes the test, sees red, and does the cheapest thing: narrows it to burn-api or comments it out. Either way the guard that was supposed to stop the next app does not exist, and the blocker is nominally closed while the hazard is live. `BULWARK_API_URL`, `BASIS_API_URL`, `BRAID_API_URL`, and `BLIP_API_URL` are all `mcp-server:optional` with no hint - verbatim the Banter/Bureau/Blueprint localhost-default incident at `env-hints.mjs:202-209`, still open on four apps.

**Fix.** State that the test lands with an explicit, named, dated allowlist of the 16 pre-existing names and a comment that the allowlist is **append-forbidden** (new entries fail review), so it is green on day one and closed for new apps. `BOLT_API_INTERNAL_URL` stays out of the allowlist since this build fixes it. [The 16 are tracked separately.]

### R3-I3. major - The coverage test lands in a suite nothing executes

`pnpm-workspace.yaml` covers only `apps/*` and `packages/*`, root `test` is `turbo run test`, so `scripts/` is not in the workspace graph. `scripts/deploy/shared/vitest.config.mjs` exists but is referenced by no workflow; the only script-level test CI runs is `scripts/db-check.coverage.test.mjs`, invoked by an explicit `node` line in `db-drift.yml:72`. The new test would sit inert exactly like the seven files next to it. The spec already demonstrates it knows this pattern: §8.2 correctly observes `check:bolt-catalog` is in `package.json` but no workflow, and adds a step.

**Fix.** Mirror §8.2. Add a root `check:env-hints` script running the deploy-shared vitest config (or plain `node --test`), and a `- name: Check env-hints coverage` step in `.github/workflows/lint.yml` next to `check:permission-catalog` at `:49`.

### R3-I4. major - The shared subpath needs a `tsup.config.ts` entry the spec never names

`packages/shared/tsup.config.ts` uses an explicit entry array: `entry: ['src/index.ts', 'src/bulwark-arm-key.ts']`. The subpath is a **two-file contract**: the `exports` map in `package.json` and that entry. §14.1 cites the `bulwark-arm-key` pattern via the `src/index.ts:13-16` comment, which documents the non-re-export but not the build entry. A build agent that adds only the `exports` block ships a package whose `./visibility-client` resolves to a `dist/visibility-client.js` that does not exist, and `docker compose build` fails for burn-api, basis-api, braid-api, and bulwark-api simultaneously with a module-resolution error that reads like a workspace-linking problem.

**Fix.** §14.1 names all three edits: `src/visibility-client.ts`, the `"./visibility-client"` block in `packages/shared/package.json` `exports` (types/import/require, mirroring `:11-15`), and appending `'src/visibility-client.ts'` to the `entry` array in `packages/shared/tsup.config.ts`.

### R3-I5. major - §9.8 does not rebuild the three services §14.1 modifies, and the three clients differ materially

R2-I2 recurring one section later. The three copies are **not** a mechanical triplication: bulwark exports `preflightAccess` (45 lines); braid exports `preflightAccess` + `preflightMany` (71 lines); basis exports `canAccessEntity` + `entityTypeForDimension` + `resolveVisibleValues` with a `DIMENSION_ENTITY_TYPE` map (92 lines). §14.1 says only "migrated in the same change, with their per-app files deleted". An operator following §9.8 verbatim ends with three services running images built from deleted source, and nothing probes the fail-closed visibility path in any of them.

**Fix.** Add `basis-api braid-api bulwark-api` to both the `docker compose build` and `up -d --force-recreate` lines in §9.8, plus one verification probe per app asserting `can_access` still denies for a non-visible entity. In §14.1 name the consolidated surface concretely: `preflightAccess` and `preflightMany` move to shared; the basis-only `DIMENSION_ENTITY_TYPE` / `entityTypeForDimension` / `resolveVisibleValues` layer stays in `apps/basis-api/src/lib/` as a thin wrapper over the shared primitive, since it is Class-B decomposition logic rather than a visibility client.
