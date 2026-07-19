# Burn spec - adversarial review round 1

Five adversaries reviewed `2026_07_19_08_01_APP_DESIGN_burn.md` against the real
monorepo. **10 blockers, 26 majors, 8 minors.**

Claims that were verified and HELD: port 4022 is genuinely free (highest is
bulwark-api 4021; the blueprint/bureau shared-4015 trap does not affect it);
migration numbering 0239-0242 is correct against the on-disk tip
`0238_bulwark_builtin_group_defaults.sql`; `/burn/`, `/burn/api/`, `/burn/ws`
collide with nothing in nginx; `publishBoltEvent` is positional
`(eventType, source, payload, orgId, actorId?, actorType?)` per
`packages/shared/src/bolt-events.ts:34-41` and the spec's usage is right;
`pg_trgm` is already installed at `0000_init.sql:22`; the `burn.*` agent-policy
allowlist glob genuinely matches `burn_precheck`; and the deterministic-plane
invariant (a `deny` is never a model output) is well constructed, with no path
found from classifier confidence alone to an enforced block.

---

## DESIGN

### D1. blocker - "Margin" is computed from client billing rates; no cost rate exists in the platform

`bill_rates.rate_amount` is the rate charged TO THE CLIENT: `apps/bill-api/src/services/invoice.service.ts:548-592` resolves it to build invoice line items as `unit_price`. Grepping every `apps/*/src/db/schema/` for `cost_rate`/`internal_rate` returns nothing. So `contract_value - sum(cost_amount)` is contract consumption at list price, i.e. rate realization, not margin. On a T&M engagement it is definitionally zero margin. A principal shown "margin 34%" that actually means "66% of the contract burned at list rates" may reprice or fire a client on a wrong number.

**Fix, pick one.** (a) Rename throughout: `cost_amount` to `consumed_amount`, `cost_basis` to `valuation_basis`, board metric to "contract consumption" / "envelope burn", and delete the word margin from the product including the `burn.margin.*` permission ids and `margin_erosion`. Or (b) own the missing primitive: add `burn_cost_rates` (org/user/project, effective-dated, minor units) with its own settings screen, resolve cost separately from price, badge `no_cost_rate` and exclude from rollups exactly as `unrated` is handled. Option (b) is the honest version of the pitch; (a) is the smaller build. Do not ship "margin" against `bill_rates`.

### D2. blocker - Stated rate-resolution precedence contradicts Bill's implementation

`apps/bill-api/src/services/rate.service.ts:116` implements `user+project > user > project > org`. The spec has project-only beating user-only, and its §12.1 unit test asserts the wrong order, locking the bug in. Two further mismatches: Bill treats `effective_to` as INCLUSIVE (`gte(billRates.effective_to, date)`) while the spec writes `< coalesce(effective_to, infinity)`; and the cited `idx_bill_rates_resolve` encodes no precedence, it is a plain composite b-tree.

**Fix.** Do not restate the algorithm. Add `POST /internal/rates/resolve` to bill-api (same pattern Basis uses against bench-api's internal query route) and call it, or lift `resolveRate` into a shared package. Replace the §12.1 test with a parity test asserting Burn's valuation is identical to `resolveRate` across a fixture matrix. If direct-DB reads are kept, reproduce the four-branch order and inclusive `effective_to` verbatim and own a drift test.

### D3. blocker - Change orders modeled as supersession, destroying the ledger

A change order AMENDS an SOW: it adds deliverables and/or contract value while the original deliverables stay live. The spec's only relation is `supersedes_engagement_id` with `status='superseded'`, which deactivates the engagement, making its deliverables non-candidates and non-gating. Every existing attribution then points at a dead deliverable that cannot be cleaned up (`burn_attributions.deliverable_id` is `ON DELETE RESTRICT`), the burn-down resets to zero, and `contract_value` does not roll up. The end state of the flagship workflow has no representable data model. Nothing defines whether a precheck reads the chain root or leaf.

**Fix.** Split the relations: add `amends_engagement_id` and `contract_value_delta`. Make "engagement chain" first-class: envelope math, rollups, `GET /v1/margin`, and the gate all resolve over the chain root; amendment deliverables become candidates for the whole chain; the burn-down shows a dated step up in contract value. Reserve `superseded` for a genuine restatement and specify its attribution migration (re-point by `dedup_key`; unmatched goes to `pending_review`, never silently dropped). Test both.

### D4. major - One engagement = one project on a nullable, delete-nulled column that is also the read-scoping predicate

Two holes on one column. (a) An MSA covering three Bam projects, a project covered by two concurrent SOWs, and a multi-phase engagement cannot be modeled; the "structural signal" that resolves the engagement is a single `project_id` lookup that becomes ambiguous the instant two active engagements share a project, and the spec never says what happens then. (b) `project_id` is nullable and `ON DELETE SET NULL`, but every read and ws frame is gated on project membership; the predicate for a null project is undefined, so deleting a Bam project makes a tracked engagement either invisible to everyone (silently zeroing the firm-wide P&L) or visible to everyone (leaking margin). Note `isProjectMember` is at `visibility.service.ts:203` and is NOT exported, so the spec's ":192-207" cite is stale and "the same predicate" is a reimplementation.

**Fix.** Add `burn_engagement_projects` many-to-many. Make the structural signal return all engagements linked to the project and let the bounded candidate set disambiguate across engagements as well as deliverables. State that a zero-project engagement is visible only to `burn.margin.read_all` holders and test that case. Either export `isProjectMember` or state plainly that Burn ports it.

### D5. major - The unscoped queue has no decay design and no non-billable state, so it becomes the ignored inbox AND corrupts the margin number

No grouping, aging, bulk-by-cluster, queue-health metric, or closure policy. The spec's own seed data implies ~22% of items need attention; a 20-person firm reaches four figures within a quarter. The corruption is worse than the UX: `pending_review` items DO NOT COUNT toward the envelope, so an ignored queue UNDERSTATES burn, the margin board reads healthier than reality, and the gate under-blocks. The app fails in the direction its buyer cannot detect. Separately there is no `non_billable` state anywhere in `attribution_state`, so a retro, a sales call, PTO, or warranty rework can only be mis-mapped to a deliverable or left in `unscoped` forever, permanently inflating the headline "$X of work nobody sold".

**Fix.** (a) Add `excluded_non_billable` with a typed reason (`internal`, `pre_sales`, `pto`, `warranty`, `overhead`), one keystroke from the queue, writing `burn_classifier_feedback` with a `mark_non_billable` decision kind. (b) Add deterministic org rules evaluated BEFORE the LLM (non-billable projects, phases, labels, clients) with `method='rule'`. (c) Cluster the queue by task tree / title signature so one decision closes a group. (d) Surface queue health on the margin board (inflow vs resolution rate, oldest item age, dollars sitting in `pending_review` and therefore excluded from every envelope) and auto-demote stale `pending_review` to `unscoped/low_confidence` after N days so the dollars re-enter the reported total rather than hiding.

### D6. major - Mutable and deleted source rows unhandled; `source_epoch` freezes stale dollars

`apps/api/src/db/schema/time-entries.ts` has NO `updated_at`, only `created_at`, so the epoch scheme has nothing to hash for its primary source. `apps/bill-api/src/routes/expenses.routes.ts` exposes both `PATCH /:id` (:57) and `DELETE /:id` (:68). A DELETED row of any source is never observed: the event path has no delete subscription and the reconcile pass "re-queries since a watermark", which can never see an absence. Deleted expenses and tasks consume the envelope forever, and in blocking mode deny real charges against phantom consumption.

**Fix.** Define per-source epochs only against columns that exist; for `time_entries` either add `updated_at` in a migration owned by this build or declare the source immutable and say so. Add a bounded anti-join reconcile step per source type marking vanished rows `excluded` reason `source_deleted` and reversing their dollars in the same transaction. Test edit-shrinks-cost, edit-grows-cost, delete-removes-cost. Add a `variance_kind='phantom_consumption'` guard.

### D7. major - `needs_mapping` blocks, falsifying the central safety invariant, and is the one blocking verdict the calibration machinery does not measure

§5.3 says `needs_mapping` blocks in blocking mode; §2.1 and §5.3 prose claim "a semantic disagreement degrades to `needs_mapping`, never to `deny`". From the user's side both are the same event: the expense does not post. `needs_mapping` is produced PRECISELY BY LOW CLASSIFIER CONFIDENCE, so "a classifier miss cannot produce the catastrophic false block" is false as written. Worse, §5.4 measures precision "on `deny` verdicts" and §5.6 computes the false-positive rate "over enforced denies", so the most likely class of wrong block never counts toward promotion precision and can never trigger auto-demotion. An org can promote on 0.97 deny precision and then be blocked daily with the safety valve dormant.

**Fix, pick one.** (a) `needs_mapping` is non-blocking in v1: the charge posts with an inline note and the item goes to the queue. This makes §2.1's invariant literally true and is the safer v1. Or (b) it blocks, in which case it carries its own precision precondition in §5.4, its own `gate_wrong`-equivalent reason code, and inclusion in §5.6's denominator, and §2.1/§5.3 stop claiming a classifier miss cannot block. Either way add `needs_mapping` to §5.7's returned actions and complete the `burn_prechecks.outcome` state machine, which has no transition for "mapped, then posted" distinct from `mapped`.

### D8. major - The promotion criterion measures a signal the spec never captures, and its volume floor is unreachable for the target customer

Precondition 3 is deny precision >= 0.95, and the only defined source of the `gate_wrong` label is the OVERRIDE flow, which exists only when a deny actually stopped a write. In advisory mode nothing is stopped (`enforced=false` for every verdict, asserted in §12.1), so there is no override and no label. Precondition 3 is unmeasurable as specified. Separately, 200 prechecks: a 6-person consultancy logs ~20 expenses a month, reaching 200 in roughly ten months. The gate is calibrated for a firm larger than the stated 2-50 wedge.

**Fix.** (a) Define an explicit advisory-mode verdict-feedback control on the gate console and on bill-api's inline advisory note ("this would have been blocked. Right call? yes / no / I'd have mapped it") writing `override_reason_code` on a non-enforced precheck row, and make that the precision sample. (b) Make the volume floor scale-aware: lesser of 200 decisions or 60 days, with a minimum count of labeled denies (>= 10). (c) Move Open Question 11's honest position into the product surface: state that advisory is a complete product, that the wizard reports standing without nagging, and that an org with no promotion path still gets the queue, the variance inbox, and change-order drafts.

### D9. minor - `POST /v1/prechecks/:id/outcome` is bill-api's post-commit callback but is specified with session auth and `burn.precheck.run`; bill-api holds `INTERNAL_SERVICE_SECRET`, not a session. Needs an `/v1/internal/` sibling. Also, on the fail-open path bill-api has no `precheck_id` to call back with, so the outcome loop is silently open exactly when `ungated_charge` detection matters most.

---

## SECURITY

### S1. blocker - `POST /v1/precheck` is not project-scoped, making the gate a contract-terms oracle

Every read row in §6.1 carries an explicit project-scoped annotation and §6.1 closes by saying the shared builder enforces project membership "for every row annotated project-scoped". `POST /v1/precheck` carries no such annotation. It accepts a caller-supplied `project_id`, `proposed_amount`, and a NULLABLE `work_ref_id`, and returns `envelope: { amount, consumed, remaining }`, `deliverable.title`, and `clause_ref` verbatim. Any member holding `burn.precheck.run` (granted to the entire member tier) can call it repeatedly against a project they are not a member of with a fabricated pending charge and read back exact envelope dollars and clause references for every deliverable. Summing envelopes reconstructs `contract_value`, the field floored to `burn.margin.read_all`.

**Fix.** Annotate it project-scoped and route it through the shared guard: resolve the engagement from `project_id`/`work_ref_id` and apply `isProjectMember` (org-admin override) before evaluating. Floor the numeric envelope block: return `remaining` and a band only, gating `envelope.amount`/`consumed` on `burn.margin.read_all`. The deny UX needs "you would exceed this by $X", not absolute contract figures.

### S2. blocker - Caller-supplied `idempotency_key` shared across user-facing and internal precheck routes is a gate bypass

The key is caller-supplied, unique on `(organization_id, idempotency_key)`, and both routes write into the same namespace. Nothing binds the key to the charge it authorizes. If bill-api derives it from anything predictable (the expense id, a client request id, a payload hash), a member first calls `POST /v1/precheck` with that key and a 1-cent `proposed_amount`, banking an `allow`. When the real $60,000 charge goes through, the preHandler's internal precheck hits the unique index and is handed the stored `allow`. The block never fires and the reason-of-record records an allow never computed for the real amount.

**Fix.** Make the key server-derived and non-forgeable: `hmac(INTERNAL_SERVICE_SECRET, caller_namespace || work_ref_type || work_ref_id || proposed_amount || currency)`. Namespace the internal route separately from the user route (`svc:` vs `usr:` prefix, enforced by CHECK or at insert). On an idempotency hit, re-validate that stored `proposed_amount`, `currency`, and `work_ref_type` match, and recompute otherwise.

### S3. blocker - Auto-demotion is driven by member-writable signals, giving any member a self-service kill switch on the firm's spend control

Two calibration inputs are member-writable. `burn.precheck.override` with `override_reason_code='gate_wrong'` is the false-positive signal, and the member tier is granted every `burn.*` permission except `read_all`, `engagement.delete`, and `settings.write`. Separately `POST /v1/prechecks/:id/outcome` is gated on `burn.precheck.run` (member) yet is described as bill-api's service callback, with no internal-secret path and no restriction on who may set `outcome`. A member who wants the gate off overrides a handful of denies as `gate_wrong`, pushes the rolling 30-day rate past `max_false_positive_rate` (default 0.05, a handful of rows at low volume), and the org is autonomously demoted to advisory. Promotion is server-enforced and un-bypassable; demotion has no equivalent guard and is reachable by the least-privileged tier.

**Fix.** (a) Raise `burn.precheck.override` above the member floor, or split it: benign codes stay, a separate owner/admin-floored `burn.precheck.mark_wrong` carries `gate_wrong`. (b) Require a minimum absolute count of distinct `gate_wrong` rows from distinct `overridden_by` users before demotion fires, not a bare rate. (c) Move the outcome route under `/v1/internal/` with `INTERNAL_SERVICE_SECRET`, or require the caller be the user who triggered the precheck. (d) Notify org admins on demotion with contributing override rows named, auditably.

### S4. major - The `burn.margin.read_all` floor leaks through four derived surfaces

Consumption percentage plus consumed dollars yields `envelope_amount` by division; summing across deliverables recovers `contract_value`. Beyond that arithmetic: `GET /v1/prechecks` is member-gated and returns `envelope_amount`, `envelope_consumed`, `envelope_remaining`, `clause_ref`. `GET /v1/change-orders/:id` is gated on `burn.changeorder.draft` (member) with no project-scoped annotation and no margin floor, yet the change-order body is "a deterministic scope table (deliverable, work items, hours, dollars, clause cite)", exactly the floored content.

**Fix.** Never emit both a percentage and an absolute on the same floored quantity: return consumption as a coarse band (`under_50`/`50_80`/`80_100`/`over`) for non-`read_all` callers, or absolutes only. Annotate both routes project-scoped and strip `envelope_amount`/`consumed`/`contract_value`/`clause_ref` without `read_all`. Add a test asserting a member cannot recover `contract_value` to within 5% from any combination of member-reachable responses.

### S5. major - Bolt event payloads carry margin magnitudes onto an org-wide, project-unaware bus

The ws fan-out is correctly project-scoped; §8.2 then publishes the same data to Bolt with no scoping: `work.unscoped { amount }`, `precheck.blocked { amount }`, `variance.detected { amount }`, `margin.threshold_crossed { margin_pct }`. Bolt rules are org-level with no per-rule visibility enum (`preflightBoltRule` at `visibility.service.ts:1131-1150` gates on org match alone), so any member can author a rule triggering on `burn:margin.threshold_crossed` and template the figures into a Banter post or email. `GET /bolt/api/v1/events/recent` is gated on `requireAuth` plus `shadowOnly(...)`, which is non-enforcing telemetry. "Refs and magnitudes only" treats magnitudes as safe; for this app the magnitude IS the secret.

**Fix.** Drop `amount` and `margin_pct` from Bolt payloads; publish refs plus a coarse severity band. Rule authors fetch the number through `GET /v1/margin` under their own permissions. If a magnitude must ship, restrict `burn.*` Bolt subscriptions to org-admin authorship and say so in §8.2.

### S6. major - "Not a surveillance tool" is reconstructible from the refs that remain

`actor_id` is excluded, but `GET /v1/work-items` returns `source_type` + `source_id` + `cost_amount`. For `source_type='bam.time_entry'`, `source_id` is a `time_entries` row id, and `time_entries` carries `user_id` and is readable by any project member through `/b3/api/`. Joining yields per-person cost and utilization in dollars. `title_snapshot`/`text_snapshot` are unredacted free text that routinely names people. `burn_attributions.decided_by`, `burn_classifier_feedback.decided_by`, and `burn_prechecks.overridden_by` are further per-person surfaces never floored.

**Fix.** Either (a) `source_id` is opaque to non-`read_all` callers (return an HMAC'd handle usable only for a Burn-side deep link that itself preflights), or (b) drop the non-goal's "enforced in the response shapes" claim and put an owner/admin floor on `GET /v1/work-items`. Add a test that ATTEMPTS THE JOIN and asserts it fails, rather than only asserting the `actor_id` key is absent.

### S7. major - §4.1 step 7 contradicts its own closing invariant, opening an SOW-prompt-injection path into the money gate

Step 7 reads "Every NON-`stated` envelope requires human confirmation before `is_active` becomes true", implying a `stated` envelope does not. The next paragraph says no deliverable is ever a gate input until a human confirms it. An implementer reading step 7 literally auto-activates `stated` envelopes. A `stated_price` is an LLM extraction from an attacker-influenceable PDF. Cite verification checks that the QUOTE exists in the source bytes; it does not check that the reported price is the price the clause states, and does nothing when injected text is genuinely present in the document. A forged `stated_price` that auto-activates becomes a gate input, which is the one thing that can produce an enforced deny, or set high, silently absorbs unscoped work as in-scope and destroys the revenue-recovery finding.

**Fix.** Delete the "non-" from step 7: every envelope requires human confirmation before `is_active`, `stated` included, showing the operator the verified quote alongside the extracted number. Add document-parsing limits absent entirely today: `MAX_DOC_BYTES`, a page cap, a wall-clock cap on the parse phase, and a statement that the PDF/OOXML parser runs with JavaScript execution and external-entity resolution disabled.

### S8. major - Trusted-callee gaps: cross-app privilege escalation on proposal approval, and an unvalidated `llm_provider_id`

(a) On approval Burn "asserts the decider holds `burn.changeorder.draft`, then creates the Bill line item through bill-api as that user". A Burn permission authorizes a write into Bill. `apps/bill-api/src/routes/expenses.routes.ts` shows Bill gates its own writes on `bill.*` identifiers via `fastify.requireCan`; a Burn-side assertion does not consult those. (b) `PATCH /v1/settings` accepts `llm_provider_id` with no org-ownership validation, and `apps/api/src/routes/internal-llm.routes.ts:117-126` resolves the provider by `id` and `enabled` only, with NO ORG PREDICATE. A Burn org admin who learns another org's provider id gets that tenant's decrypted key used on their behalf.

**Fix.** (a) Call bill-api as the decider with the decider's own credentials and let bill-api's `requireCan` be the authority; assert both permissions. (b) Validate on write that `llm_provider_id` belongs to the caller's org. Raise the platform gap: `/internal/llm/chat` should take an org id and scope the lookup. [Tracked separately as a pre-existing platform task.]

### S9. major - The RLS backstop named in §2.5 does not actually bind

All four existing plugins (`apps/api/src/plugins/rls.ts:38`, `basis-api:29`, `braid-api:30`, `bulwark-api:30`) issue `SELECT set_config('app.current_org_id', $1, true)` as a standalone `db.execute` on a pooled connection. The third argument `true` is `is_local`, scoping the setting to the current transaction; a standalone statement is its own implicit transaction, so the GUC is discarded when it returns, and subsequent queries may land on a different pooled connection. Under `BBB_RLS_ENFORCE=1` policies see an empty GUC on every query. The comment at `apps/api/src/plugins/rls.ts:22` refers to `request.withRls`, which does not exist in the tree.

**Fix.** Do not copy the plugin as-is. Either bind every request's queries into one transaction with `set_config(..., true)` inside it, or use `set_config(..., false)` on a connection checked out for the request and reset on release. Make the role-bound RLS test MANDATORY, not optional: boot burn-api under `BBB_RLS_ENFORCE=1` and assert a query for org A returns zero org-B rows WITH THE APP-LEVEL PREDICATE REMOVED. [Tracked separately as a pre-existing platform task.]

### S10. minor - `PATCH /v1/variances/:id` is gated on `burn.variance.read` plus `burn.attribution.write`, authorizing a mutation partly with an `is_read:true` permission, which breaks viewer-tier backfill semantics. Add `burn.variance.write` (16 permissions, not 15). `GET /v1/prechecks` is gated on `burn.precheck.run` (`is_read:false`); add `burn.precheck.read`. The `confirm_action` boundary is inverted: `burn_set_gate_mode` requires a confirm token when the target is `blocking` (already protected by the server-side calibration gate) but not when the target is `off`/`advisory`, nor for `gate_paused_until`. Require the token on gate DISABLE.

---

## STABILITY

### T1. blocker - `burn-margin-rollup` writes to a table that does not exist in the data model

§8.1 says the job "materializes per-engagement and per-account rollups so the margin board is not a live aggregate over `burn_work_items`", but §3.1 enumerates exactly ten tables and none is a rollup. As written the margin board (the default landing screen) is a live GROUP BY over the two highest-cardinality tables, joined and filtered on `superseded_at IS NULL`, for every card on every page load.

**Fix.** Add an eleventh table `burn_engagement_rollups` (and an account-grain sibling or a grouped read over it) with `UNIQUE (organization_id, engagement_id)`, snapshot columns for contracted/attributed/unscoped/margin, and `computed_at`. Specify refresh as a full per-engagement recompute upserted in one statement (idempotent under retry, no read-modify-write). Specify what `/v1/margin` returns when the rollup is missing or stale: serve it with an explicit `as_of`, never silently fall back to an unbounded live aggregate.

### T2. blocker - `source_epoch` from `tasks.updated_at` makes every kanban drag a new work item and a new LLM call

`apps/api/src/db/schema/tasks.ts:92` bumps `updated_at` on ANY field change including position, phase, assignee, title, description. A task moved across the board three times produces three new epochs, three work items, three classifications, and two tombstones, with zero change in cost or scope. At 50 seats this consumes `attribution_llm_daily_cap` (default 2000) on no-op re-observation; once the cap trips, real items defer to `pending_attribution`, so genuine scope creep goes undetected on the busiest days. The idempotency claim is false for the highest-volume source. Also, §4.2 says the prior row is "marked `excluded` with reason `superseded_epoch`" but `burn_work_items` has no column to store an exclusion reason.

**Fix.** Define the epoch as a hash of cost-and-classification-relevant fields only: `time_logged_minutes`, `project_id`, and a normalized hash of `title || description`. State explicitly that `updated_at` is NEVER an epoch input for any source type. Add `exclusion_reason varchar(32)`. State that an epoch match short-circuits before candidate assembly and before any llm-provider call, so a no-op re-observation costs one index probe.

### T3. blocker - The source-reconcile pass cannot see backdated time entries, so the "no outbox needed" durability claim is false

`apps/api/src/db/schema/time-entries.ts` has NO `updated_at`, NO `organization_id`, and NO `project_id`, only `minutes`, a business `date`, and `created_at`. The spec never names the watermark column. If it is `date`, every timesheet entered late (the normal case) is permanently invisible to reconcile and the durability argument collapses. If it is `created_at`, the org-scoping join must go `time_entries -> tasks -> projects` on every 30-minute pass with no supporting index, an unbounded scan growing with the org's entire history. Because there is no `updated_at`, an edited time entry has no epoch to change and its dollars are frozen at first observation forever.

**Fix.** Name `created_at` as the sole reconcile watermark, persist a per-org high-water mark, and specify the required covering index on the join path (or add `organization_id`/`project_id` to `time_entries` as a named platform dependency). State plainly that time-entry EDITS are undetectable until the platform adds `time_entries.updated_at`, and list that as a dependency.

### T4. major - No circuit breaker on the gate, and the timeout budget lives inside the dependency it bounds

`precheck_budget_ms` is a column in `burn_org_settings`, a Burn table; bill-api cannot read it without calling Burn, which is the thing the budget bounds. There is no breaker, so a Burn outage imposes a permanent 800ms latency floor on every gated write indefinitely. `apps/worker/src/jobs/bill-recurring-generate.job.ts:367` loops serially over due schedules, so an outage becomes N x 800ms of added runtime.

**Fix.** Make the timeout a bill-api-side env constant `BURN_PRECHECK_TIMEOUT_MS` (default 800), with the Burn setting advisory-only for display and CHECK-clamped strictly below it. Add a Redis-backed circuit breaker to `burn-precheck.client.ts`: open after N consecutive timeouts/5xx, short-circuit to `allow`/`gate_unavailable` at zero network cost, half-open probe on an interval, following the per-org Redis cache shape in `apps/bulwark-api/src/services/gate.service.ts`. The recurring-generate loop checks the breaker once per job, not once per schedule.

### T5. major - Fail-open is unobservable; a silently degraded gate is indistinguishable from a healthy one

§5.5 claims that when burn-api is unreachable a "precheck row [is] written asynchronously". Impossible: the only writer of `burn_prechecks` is burn-api, which is by hypothesis unreachable. During an outage there is no row, no event (`gate.unavailable` is not in the §8.2 list), no counter, and no effect on calibration. An org in blocking mode whose gate has failed open for three weeks sees a console identical to an org with nothing to block.

**Fix.** Delete the "written asynchronously" claim. Have bill-api's client `INCR` a Redis key `burn:gate_unavailable:<org>:<yyyymmdd>` with a TTL and log through `@bigbluebam/logging` with a stable code `BURN_GATE_UNAVAILABLE`, drained by `burn-calibration-recompute`. Surface gate coverage on the console ("X% of money-out writes reached the gate in the last 7d"), expose the count on `/metrics` (already registered by `@bigbluebam/service-health`), raise a `gate_outage` variance covering the window on recovery, and auto-demote blocking to advisory when coverage falls below a floor, on the same one-way-toward-safety principle.

### T6. major - `burn-attribute-batch` can overlap itself and double-drain the inbox; `burn_ingest_events` has no claim or lease

The job is both event-driven and scheduled every 2 minutes. `burn_ingest_events` copies `bulwark_ingest_events`, verified at `infra/postgres/migrations/0234_bulwark_core.sql:123-136` as having only `status pending|processed` and NO claim column. Two concurrent runs SELECT the same pending rows and both process them: duplicate llm-provider spend against a capped budget, and two writers racing the partial unique index. Bulwark only gets away with this shape because its sweeps run at `concurrency: 1` under a per-org advisory lock.

**Fix.** `concurrency: 1` on the scheduled drain plus a per-org Redis lock; claim rows with `UPDATE ... SET status='claimed', claimed_by, claimed_at WHERE status='pending' ... RETURNING` (or `SELECT ... FOR UPDATE SKIP LOCKED`) rather than a bare SELECT; add `claimed_by`/`claimed_at` and a stale-claim reaper returning rows older than a lease TTL to `pending`. Apply the same lock to `burn-margin-rollup` and `burn-silent-deliverable-sweep`, keyed per org. Add a BullMQ `limiter: { max, duration }` on the batch queue and name the value.

### T7. major - The advisory-lock citation points at a file with no lock in it

§4.3 cites "a Redis advisory lock (the `bond-stale-deals.job.ts:127-138` pattern)". That file contains no lock of any kind; lines 127-138 are a comment explaining why the rotting marker is updated after the emit. An implementer following the citation ships an unlocked 30-minute sweep, and because that job also carries the source-reconcile pass, overlapping runs double-write `burn_variances` and double-materialize work items, making `last_variance_sweep_at` ambiguous. The genuine precedent is `apps/worker/src/jobs/bulwark-radar-sweep.job.ts`.

**Fix.** Cite `bulwark-radar-sweep.job.ts` and specify per-org lock keys with a TTL exceeding the worst-case sweep. Specify the progress-logging cadence: the sweep iterates every org and re-queries full source history, a multi-minute silent phase, and CLAUDE.md's progress-logging rule requires flushed per-interval output (log every N orgs and every N items with elapsed time), not just start/end lines.

### T8. major - Two attribution races are asserted away rather than specified

(a) Nothing forbids `burn-attribute-batch` from superseding an attribution whose `state='confirmed'` and `method='human'`. Since `vocabulary_version` bumps on every feedback write and re-attribution triggers on source epochs changing, the ordinary path has the worker re-deciding items a human already decided. A user watching their correction silently revert is the fastest way to destroy trust in the number. (b) The partial unique index means two users triaging the same `needs_mapping` row produce a raw 23505 on the loser, surfacing as a 500 rather than the platform-standard 409-with-stale-check that CLAUDE.md mandates. The bulk endpoint (capped at 200) has no stated partial-failure shape.

**Fix.** State the invariant: "the attribution engine never supersedes a row with `state='confirmed'` or `method='human'`; it may only raise a `pending_review` proposal alongside it." Specify supersede-then-insert in one transaction with `SELECT ... FOR UPDATE` on the live row, returning 409 with current state on a stale-check miss. Specify `POST /v1/attributions/bulk` as per-item results (`{ applied: [], conflicted: [], failed: [] }`), never all-or-nothing.

### T9. major - `idempotency_key` is undefined at its only caller and never expires, so it replays stale verdicts

`apps/bill-api/src/routes/expenses.routes.ts` has no idempotency field in `createExpenseSchema`, and `work_ref_id` is null in the pre-transaction case, so there is no natural key. If bill-api derives it from request content, two legitimately identical expenses (same vendor, amount, day) collide and the second replays the first's verdict. If it generates one per request, an HTTP retry writes a second row and orphans the outcome callback. Worse, with no TTL a `deny` issued before a change order expanded the envelope keeps being returned afterward, and a stale `allow` keeps letting charges through after the envelope is exhausted. The verdict is a snapshot of envelope state cached forever under a key with no invalidation.

**Fix.** bill-api mints a request-scoped key (client header if present, else generated per attempt and stable across that attempt's retries) and echoes it in the response. Add `valid_until` to `burn_prechecks` (~5 min); on a key hit past `valid_until`, recompute and supersede rather than replay. Require a fresh key whenever `amount` or `project_id` changes. [Interacts with S2: the key must also be non-forgeable.]

### T10. minor - The `search_tsv` generated columns will be NULL for most rows

`description` is nullable and `cited_span->>'quote'` is null whenever the LLM omitted it, so the concatenation yields NULL and the whole tsvector is NULL. Since lexical retrieval is the SHIPPED path (Qdrant off by default), this guts stage-one recall on exactly the deliverables with the thinnest metadata. The generated expression also needs an explicit regconfig to satisfy Postgres's IMMUTABLE requirement.

**Fix.** `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(cited_span->>'quote',''))`, stated explicitly for both tables with the regconfig named in the migration plan.

### T11. minor - Retention silently rewrites historical margin, and `/burn/ws` has no reconnect semantics

Purging a work item cascades its attributions (`ON DELETE CASCADE`), so the dollars behind a three-year-old closed engagement's margin figure vanish and the number changes retroactively, for an app whose output an owner may have shown a client. §8.1 exempts prechecks, feedback, and extraction runs but not this. Separately §6.2 specifies frames and project-scoped rooms but says nothing about reconnect, and the per-frame `isProjectMember` check is specified without a cache, making it a DB round-trip per frame per subscriber.

**Fix.** Exempt work items whose engagement is not `closed`, or make the rollup table from T1 the immutable historical record and serve purged periods from it with an `as_of`. State that ws frames are advisory-only, that the client refetches affected queries on reconnect rather than replaying, and that the membership predicate is served from the Redis-cached `PermissionContext` the REST builder uses.

---

## BEST PRACTICES

### B1. blocker - Adding `burn` to `LAUNCHPAD_CATALOG` breaks two CI drift guards the spec never mentions

`scripts/docs/build-manual.mjs:78-85` derives its roster directly from `LAUNCHPAD_CATALOG`. The moment `'burn'` lands there, `manual.generated.json` gains a Burn entry (a `stubEntry()` at :91 if `docs/apps/burn/help.md` is absent), and `.github/workflows/lint.yml:58` runs `pnpm docs:manual:check`, which fails on committed-file drift. Separately `scripts/docs/extract.mjs:42-65` holds a HARDCODED `APP_REGISTRY`; with no `burn` entry, `pnpm docs:extract` never emits `docs/apps/burn/` at all. `lint.yml:55` also runs `pnpm help:check` (`scripts/help/build-help-index.mjs --check`, exit 1 at :226).

**Fix.** Add to §9.6: (a) a `burn: { nginxPath: '/burn/', apiPort: 4022, apiDir: 'burn-api', appId: 'burn' }` entry at `scripts/docs/extract.mjs:63` immediately after the `bulwark` row; (b) author `docs/apps/burn/help.md` and run `pnpm help:index`; (c) run `pnpm docs:manual` and commit the regenerated `site/src/content/manual.generated.json`. Name all three alongside the existing `pnpm docs:catalog` commitment.

### B2. major - `/readyz` does not exist anywhere in the platform

`packages/service-health/src/index.ts` registers exactly `GET /health` (:62), `GET /health/ready` (:66), and `/metrics` (:84). There is no `/readyz`, and grep finds none in nginx.conf, docker-compose.yml, or services.mjs. The name has already propagated as prose into three server.ts comments and CLAUDE.md itself.

**Fix.** Replace `/readyz` with `/health/ready` throughout §6.1 and §9.6. State the plugin registration explicitly: `healthCheckPlugin` with `service: 'burn-api'` and a `checks: { postgres, redis }` map, mirroring `apps/bulwark-api/src/server.ts:96`. Keep the compose healthcheck on `/health`. [CLAUDE.md correction tracked separately.]

### B3. major - The Drizzle schema module list omits `agent-proposals.ts` and `entity-links.ts`, and never declares the generated tsvector columns

The spec inserts into `agent_proposals` and upserts `entity_links` but lists neither as a Drizzle module; `apps/bulwark-api/src/db/schema/` ships both. Separately `scripts/db-check.mjs:454` treats a DB column absent from every Drizzle declaration as `UNKNOWN COLUMN in DB` and EXITS 1 (:486) - fatal, not a warning (only type mismatches warn, :468). A `search_tsv tsvector GENERATED ALWAYS AS (...) STORED` created in 0239 but not declared fails `db-drift.yml:75` and `migration-replay.yml:81`.

**Fix.** Add both modules to the §3 list, re-exported from `index.ts`. State that both `search_tsv` columns and the reserved `qdrant_point_id`/`qdrant_synced_at` columns are declared in their Drizzle modules. Add `pnpm db:check` and `pnpm lint:migrations` to the §12 verification list.

### B4. major - The spec leans on the Bolt catalog drift guard as a CI safety net, but it is not wired into any workflow

`check:bolt-catalog` exists at `package.json:35`, but grepping `.github/workflows/*.yml` returns nothing. CLAUDE.md's claim that it is "the CI drift guard" is stale. The rest of §8.2 is accurate (`event-catalog.ts:2939` is `bulwarkEvents`, `:3025` is `ALL_EVENTS`, `:3046` the spread), only the enforcement claim is not.

**Fix.** Change §8.2 to say the guard must be run manually AND added as a CI step as part of this build: add a `check:bolt-catalog` step to `.github/workflows/lint.yml` next to `check:permission-catalog`. Note it as a platform gap Burn is closing. [Tracked separately.]

### B5. minor - §9.6's blanket "never hand-edit `site/src/pages/docs.tsx`" over-reads the convention

CLAUDE.md is precise: the app/tool LISTS are generated and must not be hand-coded, but the one sanctioned edit is adding an icon/color for the new id in `APP_ICON`/`APP_COLOR`, otherwise it falls back to a neutral Server icon. `docs.tsx:73` and `:98` carry the bulwark entries. The spec correctly anticipates the parallel gap in `packages/ui/launchpad.tsx` then contradicts itself on `docs.tsx`.

**Fix.** Reword to permit exactly that one edit, naming the `Flame` icon and an orange class pairing, matching the bulwark rows.

### B6. minor - Seed registration names the phase but not the two hardcoded arrays that gate it

`scripts/seed-all.mjs:82-95` is a flat `const PHASE_B = [...]` iterated at :272. `scripts/seed-gilligan/run-all.mjs:67-71` is a list of GROUPED phase objects, not a flat list, so "after `bill.mjs` and `bin.mjs`" does not identify a location: `bill.mjs` is in the Billing group and `bin.mjs` in Knowledge & analytics, so Burn must come after BOTH groups. Also there is NO `bulwark.mjs` and no `braid.mjs` in `scripts/seed-gilligan/` at all, so the claimed precedent does not exist and Burn is establishing it. `.github/workflows/seed-smoke.yml` exercises the seed path, and gilligan is the only permitted screenshot source.

**Fix.** Name both edits by file and line. Specify a new trailing group in `run-all.mjs` (e.g. `{ name: 'Margin', files: ['burn.mjs'] }`) placed after both groups. Drop the Bulwark seeding-precedent claim.

### B7. minor - The shared Zod schema file needs an `index.ts` re-export, and the node-builtin trap applies

`packages/shared/src/schemas/index.ts:18-20` explicitly re-exports `./basis.js`, `./braid.js`, `./bulwark.js`; a new `burn.ts` is invisible without the matching line. Also `packages/shared/src/index.ts:13-16` documents that `bulwark-arm-key.ts` is deliberately NOT re-exported because importing `node:crypto` pulls it into the frontend bundle and breaks the rollup production build.

**Fix.** State the `index.ts` re-export line. Add: any Burn shared module needing a node builtin (for example a precheck idempotency-key HMAC, which S2 now requires) must live in its own file exposed via a subpath export, never through `schemas/index.ts`.

### B8. minor - §12 has no green-CI checklist

The behavioral test plan is thorough but never enumerates the convention gates: `pnpm lint`, `lint:migrations`, `typecheck`, `db:check`, `check:permission-catalog`, `help:check`, `docs:catalog:check`, `docs:manual:check`, `check:bolt-catalog`. Five are live steps in `lint.yml:46-58` and `db-drift.yml:75`. Findings B1, B3, and B4 are all instances of this gap.

**Fix.** Add §12.4 "Convention gates" listing those nine commands as a required pre-merge pass, stating that any pre-existing failure they surface gets a task recorded rather than waved off.

---

## INFRASTRUCTURE

### I1. major - The gate can be fail-open indefinitely with no operator-visible signal, and the detection mechanism lives inside the service that is down

Same root as T5, with the deployment consequence: an org that promoted to blocking and loses burn-api for a week gets a silently disabled money gate, a clean-looking console, and zero artifacts covering the window. Nothing in §9 names a log code, counter, or banner. Note `burn-variance-sweep` is also a burn-api HTTP caller, so it never runs during the outage either.

**Fix.** As T5, plus: on burn-api recovery, `burn-variance-sweep` reads the Redis counters (the only record that survives) and raises a `gate_outage` variance covering the window. Surface "the gate was unavailable for N of the last 7 days" on the Gate Console next to the auto-demotion banner.

### I2. major - The gate's timeout budget is stored in burn-api's DB but must bound a call made from bill-api

Same root as T4, with the deployment detail: bill-api has no burn schema, no burn Drizzle module, and the only way to learn the value is to ask burn-api, which may be unreachable. During a burn-api rolling restart every `POST /expenses`, `PATCH /expenses/:id`, and `POST /expenses/:id/approve` pays the full 800ms on all four hook points for the restart duration; on Railway that is a multi-second tail with no upstream limit named.

**Fix.** As T4, plus: add `BURN_PRECHECK_TIMEOUT_MS` to the bill-api compose env AND to `bill-api.env.optional` in `scripts/deploy/shared/services.mjs` alongside `BURN_API_INTERNAL_URL`. CHECK-clamp `precheck_budget_ms` strictly below the documented client default.

### I3. major - `/readyz` in the Railway-relevant probe path

Same as B2, with the deployment consequence spelled out: every entry in `scripts/deploy/shared/services.mjs` sets `healthcheck: '/health'`, and `gen-railway-configs.mjs` writes that into `railway/<service>.json`. An implementer who puts `/readyz` in the compose healthcheck or the services.mjs entry gets a container that never reports healthy, `frontend` never starts (it has `depends_on: burn-api: condition: service_healthy`), and Railway reproduces the recorded healthcheck-loop failure.

**Fix.** As B2. Set `healthcheck: '/health'` in the services.mjs block and `curl -sf http://localhost:4022/health` in compose, matching `scripts/deploy/shared/services.mjs:298`.

### I4. major - The build sequence never says to run `docker compose run --rm migrate`

CLAUDE.md documents that the migrate sidecar is cached via `service_completed_successfully` and does NOT re-run on a subsequent `docker compose up -d <service>`. §9.1 correctly gives burn-api a migrate dependency, which on an existing long-running stack is satisfied instantly by the cached completion. So the first `docker compose up -d burn-api` starts against a database with no `burn_*` tables, producing the 42703 / "relation does not exist" class CLAUDE.md devotes a troubleshooting section to.

**Fix.** Add an explicit ordered rollout block to §9: land 0239-0242, `pnpm lint:migrations`, `docker compose run --rm migrate`, verify with `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "\d burn_work_items"` and a `schema_migrations` tail, then `docker compose build burn-api frontend && docker compose up -d --force-recreate burn-api frontend`. State the immutability rule for the generated 0241 permission delta: if `build-permission-delta.mjs` reassigns a number after the file has been applied to a dev DB, that is a checksum mismatch and the fix is a NEW file, never an edit. State that the migrations must land on disk before the burn-api image is built for a Railway deploy.

### I5. major - No resource sizing for the first genuinely high-volume LLM consumer in the suite

`docker-compose.yml` runs a single `worker` service with `WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-5}` shared across ~54 queues plus 28 scheduled jobs, with no `mem_limit`, `cpus`, or `deploy.replicas` anywhere. Burn adds 9 queues, one on a 2-minute cadence doing LLM work, one hourly rollup over the highest-churn table, and a 30-minute sweep re-querying `time_entries`, `bill_expenses`, and `tasks` across every org. `attribution_llm_daily_cap` is a per-org DB column: it bounds one tenant's spend but bounds nothing about worker CPU, burn-api's DB pool, or contention on the shared `POST /internal/llm/chat` route that Beacon, Brief, Braid, and Bulwark also use.

**Fix.** State in §9.1 the expected burn-api replica count and DB pool size, and that burn-api is the process holding the LLM calls (worker jobs are thin HTTP callers, so the worker's call needs its own generous AbortController deadline distinct from `LLM_TIMEOUT_MS`, following `apps/worker/src/jobs/bulwark-proposal-reconcile.job.ts:48`). Add a platform-level concurrency cap on the internal llm-provider seam, or state explicitly that Burn is the forcing function for one and that it is a prerequisite, not a fast-follow. Give an operator a `BURN_ATTRIBUTE_CONCURRENCY` knob and document when to split `worker` into a second container.

### I6. minor - The three nginx configs have already drifted on the static-asset alternation

`infra/nginx/nginx.conf:728` includes `bill`; `nginx-with-site.conf:806` and the generated `nginx.railway.conf:942` do not. None include `bay` or `blip`. "Insert only the `burn` token into each file's existing alternation" silently preserves the drift.

**Fix.** §9.5 should say `burn` goes into the alternation in BOTH source files, and should record the existing `bill`/`bay`/`blip` omission as a tracked task so the two source files converge before `gen-railway-configs.mjs` runs. [Tracked separately.]

### I7. minor - Railway variable set and env-vars doc

Add `railway/env-vars.md` regeneration and the `frontend` service's Railway variable set to the §9.6 checklist, since Railway service variables are not derived from compose.
