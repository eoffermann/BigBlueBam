# Burn spec - adversarial review round 2

**14 blockers, 24 majors, 5 minors.** Best-practices verified all eight round 1
findings (B1-B8) genuinely landed and returned zero blockers. Design, security,
stability, and infrastructure found deeper defects, largely because the round 2
spec is specific enough to be wrong in checkable ways.

---

## DESIGN (5 blockers, 3 majors)

Round 1 resolved: D2, D4, D7, D8, D9. Not resolved: D1 (discriminator landed, formula still wrong), D3 (chain modeled, loop still does not close), D5 (fixed in main line, new corruption introduced), D6 (epoch omits fields that decide whether an expense is money).

### R2-D1. blocker - Every logged hour consumes the envelope twice

`apps/api/src/routes/time-entry.routes.ts:38` increments `tasks.time_logged_minutes` by `data.minutes` on every time-entry insert. The spec values `bam.time_entry` at `minutes x rate` AND `bam.task` at `time_logged_minutes delta x rate`, and the `bam.task` epoch includes `time_logged_minutes`. So one logged hour creates a time-entry work item and a new task epoch, each priced. Attributed billable, consumption pct, margin, the burn-down, and `envelope_would_exceed` are all inflated ~2x on the primary source. In blocking mode the gate denies real charges at half the true burn. The "or `none`" in the valuation table is the only hint at a rule and is never resolved.

**Fix.** State one precedence explicitly: `bam.time_entry` is the sole priced hour source; `bam.task` is ingested with `valuation_basis='none'` for classification signal only, and its epoch drops `time_logged_minutes` entirely (which also removes a large class of churn). Test: logging 60 minutes against a task produces exactly one priced work item totalling one hour. If tasks must be the priced grain for orgs not using `time_entries`, make it an explicit per-org `hour_source` setting with the two paths mutually exclusive.

### R2-D2. blocker - `true_margin` is wrong for every non-T&M engagement

`burn_engagements.envelope_basis` enumerates `fixed | time_and_materials | retainer | not_to_exceed` and nothing in the margin formula branches on it. On a fixed-fee SOW revenue is `contract_value`, not hours times the CLIENT rate. `sum(hours x bill_rate) - sum(hours x cost_rate)` on fixed fee measures "the T&M invoice we did not send, minus cost", which moves the wrong way: delivering in half the budgeted hours shows LESS margin, overrunning shows MORE. This fires on the Gilligan seed's own flagship engagement (Howell Luau, fixed fee $18,000). D1's failure mode is relocated, not removed.

**Fix.** Make margin basis-aware in §1.2. `fixed`/`not_to_exceed`: `margin = chain_contract_value - attributed_cost`, pct over contract value, badged `in_progress` until the chain closes or all deliverables complete. `retainer`: same per period using `burn_engagements.timezone` for boundaries. `time_and_materials`: current formula is correct. Add `revenue_basis` alongside `metric_basis` on the rollup. Test: a fixed-fee chain under-burning hours reports HIGHER margin.

### R2-D3. blocker - The flagship loop still does not close: an amendment cannot expand an existing deliverable's envelope

The change order is drafted off an `envelope_overrun` on a specific deliverable. The only representable outcomes are a chain-level `contract_value_delta` and new amendment deliverables. Neither raises the overrun deliverable's `envelope_amount`, and deny arithmetic is per-deliverable, not per-chain. After approval the same deliverable is still `envelope_exhausted` and keeps denying. §12.1 asserts "a stale `deny` does not persist after a change order expanded the envelope" against a model with no way to expand it. `supersedes_deliverable_id` exists but its attribution-migration semantics are specified only for the engagement-level path, so using it either resets consumption to zero or strands attributions under `ON DELETE RESTRICT`.

**Fix.** Add `amends_deliverable_id uuid` and `envelope_amount_delta bigint` to `burn_deliverables`. Effective envelope = `envelope_amount + sum(envelope_amount_delta)` over its amendment set, resolved on the chain exactly as `contract_value_delta` is at engagement level. Consumption stays on the base row so no attribution migration is needed, and the burn-down gets a per-deliverable dated step-up. Reserve `supersedes_deliverable_id` for restatement with the same `dedup_key` migration and `restatement_unmatched` rule.

### R2-D4. blocker - `burn_confirm_deliverable` lets a service account satisfy S7's human confirmation

S7's entire fix is "every envelope including a `stated` one requires human confirmation before `is_active`". `burn_confirm_deliverable` backs `PATCH /v1/deliverables/:id` at `burn.deliverable.write`, with `asker_user_id` and no confirm token. `asker_user_id` is a visibility parameter, not an approval. Once `burn.*` is allowlisted in `agent_policies`, an agent chain can extract a forged `stated_price` and confirm it in the same run, producing the one thing that can generate an enforced deny. The autonomy table calls this row HITL while the tool surface makes it autonomous. Envelope confirmation is also at member tier, so the act deciding what the firm's spend control blocks on is the least-privileged writable surface.

**Fix.** `burn_confirm_deliverable` must not perform the confirmation. Either require a `confirm_action` token on the human-approver TTL (`apps/mcp-server/src/lib/confirm-token-store.ts`), or better, write an `agent_proposals` row (`subject_type='burn.envelope_confirm'`, refs-only) and flip `is_active` only on `proposal.decided`. Floor the envelope-confirming branch to owner/admin or add `burn.envelope.confirm`. Test: a service-account token cannot set `is_active` on any path.

### R2-D5. blocker - `bill_expenses.billable` defaults to false and `status` is absent from the epoch

Verified in `apps/bill-api/src/db/schema/bill-expenses.ts`: `billable: boolean(...).notNull().default(false)` and `status varchar(20) default 'pending'`. Burn values `bill.expense` at `amount` unconditionally and hashes `amount, currency, project_id, expense_date, description, vendor`. So by default every expense including internal costs is booked as `billable_amount` against a client envelope. A rejected expense is neither deleted nor epoch-changed, so the anti-join delete pass never reverses it. The gate denies real charges against consumption that was never chargeable.

**Fix.** Add `billable` and `status` to the `bill.expense` epoch. Value at `amount` for `billable_amount` only when `billable = true`; when false, it is a real cost against margin so it belongs in `cost_amount`, not envelope consumption. Mark `status IN ('rejected','void')` as `excluded` with `exclusion_reason='source_voided'` and reverse in-transaction. Test: rejecting an approved expense reverses its envelope consumption and a subsequent precheck no longer denies.

### R2-D6. major - Open Question 3's even-split fast path is unsound and poisons the calibration sample

An even split of chain contract value across N deliverables is a number nobody asserted. Consumption against it produces `envelope_overrun` and `consumption_erosion` variances that are artifacts of the split, and in advisory mode produces advisory denies a user will correctly label `wrong_call`. Those labels feed `min_deny_precision`, so the fast path systematically drives precision below 0.95 and makes promotion unreachable for exactly the orgs that used it. The proposed mitigation is worse in the other direction: an org promoting to `blocking` with all-even-split envelopes gets a console showing `blocking` and a gate that structurally cannot deny anything.

**Fix (supersedes the orchestrator's earlier steer).** Do not invent a "barred from enforcing" envelope class. Bulk-confirm with `envelope_amount = NULL` and `envelope_source='unpriced'`, which the model already handles end to end: a null envelope tracks hours only and can never deny, and §5.5 already returns `allow_with_note`. Exclude unpriced deliverables from `envelope_overrun` and `consumption_erosion`, badge them "Envelope unpriced" beside the existing "Envelope unconfirmed" state, and gate promotion on a `priced_deliverable_coverage_pct` floor.

### R2-D7. major - Queue decay dumps `aged_out` dollars into the "work nobody sold" headline

§2.3.6 insists `no_matching_deliverable` and `low_confidence` are "structurally distinct and never merged". Then §2.3.8 auto-demotes stale `pending_review` to `unscoped/aged_out`, and §7.2 renders two tabs under a single "$X of unbilled work" header. `aged_out`, `restatement_unmatched`, `no_active_engagement`, and `outside_engagement_window` are all in the enum with no tab and no stated contribution. Either the scope-creep number is inflated with unreviewed items or dollars hide in a bucket with no surface. Separately, §2.3.8's claim that demotion makes dollars "re-enter the reported total" is true only of the unscoped total; envelope consumption, the burn-down, and the gate remain understated either way, so the under-blocking half of D5 is unfixed and unstated.

**Fix.** "$X of work nobody sold" counts `no_matching_deliverable` only. Report `low_confidence` + `aged_out` as a separate "$Y unclassified" figure with `aged_out` given its own tab. Give `no_active_engagement` and `outside_engagement_window` a third "outside any tracked contract" tab. State plainly that neither `pending_review` nor `unscoped` dollars ever count toward an envelope, so the burn-down and gate are conservative by construction, and surface that on `GET /v1/queue-health`.

### R2-D8. major - `metric_basis` stops at the rollup; most money surfaces carry a figure with no basis

Only `burn_engagement_rollups` carries `metric_basis`. The burn-down series, engagement detail, the precheck envelope block, `burn_variances.amount`, and the change-order scope table all emit money with no basis and no coverage pct. There is no export route anywhere in §6.1, so the export commitment is unbacked. `/v1/financials/accounts` ranks a `true_margin` chain against a `contract_consumption` chain with no stated rule. And `burn_margin` as a tool name is itself a mislabeling path: an agent that calls a tool named `burn_margin` and reports "margin" has mislabeled it, and the sibling `metric_basis` key is exactly what a model drops.

**Fix.** Put `metric_basis`, `cost_rate_coverage_pct`, and `as_of` on every response carrying a dollar or derived percentage, and make the shared Zod money block a **discriminated union on `metric_basis`** so a response cannot be constructed without it. Define account-level basis as the weakest member: any `contract_consumption` chain forces the row to `contract_consumption`, with the mixed state surfaced. Rename the tool `burn_financials`, registering `burn_margin` only as a deprecated alias whose response under `contract_consumption` carries the value under `contract_consumption_pct` with no `margin` key at all. Either add the export route or drop the export claim.

### Folded design minors
`burn_prechecks.verdict_reason` includes `deliverable_closed` but `burn_deliverables` has no closed state; add `lifecycle_status` or delete the reason. `burn.attribution.write` "also authorizes rule management" puts rule authoring at member tier where a rule can blanket-mark a project non-billable; give it `burn.rule.write` at owner/admin. `burn_work_items.attribution_state` uses `attributed` while `burn_attributions.state` uses `auto_attributed`/`confirmed`; name the denormalization mapping.

---

## SECURITY (4 blockers, 5 majors, 1 minor)

Round 1 resolved: S2, S5, S7, S10, S9 (as far as a spec can go). Not resolved: S1, S3, S4, S6, S8a.

### R2-S1. blocker - Burn's entire access model rests on a permission gate that does not enforce by default

`docker-compose.yml` sets `BBB_PERMISSIONS_ENFORCE: ${BBB_PERMISSIONS_ENFORCE:-warn}` on every service, and `packages/permissions/src/index.ts:291` is literally `if (opts.mode === 'warn') return;` - no deny, ever. The in-process variant does the same at `:137`. Existing apps survive because `requireCan` sits behind a legacy `requireAuth` + role gate; the plugin comment at `:120` says so. **Burn has no legacy gate**: `burn.costrate.read`, `burn.financials.read_all`, `burn.precheck.mark_wrong`, and `burn.settings.write` are the only thing between a member and per-person compensation, firm-wide profitability, and the gate switch. Even at `mode: 'on'`, the resolver returns `'unknown'` on any non-2xx (`:260-268`) and the gate denies only on explicit `'deny'`, so an apps/api blip opens every floor.

**Fix.** State in §9.1 that burn-api sets `BBB_PERMISSIONS_ENFORCE=on` unconditionally and **refuses to boot otherwise**. Add a second independent in-route guard for `/v1/cost-rates` and `/v1/financials/accounts` checking the org role directly off `request.user`, so a resolver outage cannot open them. Test: assert 403 with the resolver stubbed non-2xx, and assert boot fails when mode is not `on`. [Platform posture tracked separately.]

### R2-S2. blocker - `overage_amount` is unfloored and reconstructs `envelope_remaining` in one call

The caller supplies `proposed_amount` and receives `overage_amount`, so `envelope_remaining = proposed_amount - overage_amount`. One subtraction. §2.4 point 2 states "no floored quantity is emitted twice in different units" and §2.4 point 5 breaks it on the flagship route. §5.7's justification ("discloses nothing the caller could not compute") is false. Sharper: a deliverable with zero consumption has `remaining == envelope_amount`, so probing each deliverable shortly after confirmation recovers `contract_value` EXACTLY. The §12.1 "no absolute recovery" test would fail against an honest implementation, so an implementer will weaken the test rather than the response.

**Fix.** Floor `overage_amount` like the other three. Return a deny to a non-`read_all` caller as a band plus a quantized overage (round up to a configurable bucket), or only `verdict_reason` plus "exceeds remaining budget". Add rate limiting and an audit row on repeated member prechecks against the same deliverable. Rewrite the test to probe a newly confirmed deliverable specifically.

### R2-S3. blocker - The S6 dollar-flooring was applied to one route of three

`burn_attributions` carries its own `billable_amount`/`cost_amount` and its `/v1/attributions` row has no S6 annotation; `/v1/unscoped` likewise. The join runs identically: attribution to `work_item_id` to `source_id` to `time_entries.user_id`. Worse than the original finding because the disclosure is not aggregate: for one `bam.time_entry` row, `cost_amount / (minutes / 60)` IS that person's hourly cost rate to the cent, the exact contents of `burn_cost_rates` which §13 promises never to expose. One row suffices. The §12.1 test only exercises `/v1/work-items`.

**Fix.** Move flooring off the route into the serializer: one shared `redactFinancialFields(row, viewerCaps)` applied to every response containing a work-item or attribution projection (`/v1/work-items`, `/v1/attributions`, `/v1/unscoped`, `/v1/queue-health`, `/v1/change-orders/:id`, `burn_variances.detail`, the MCP payloads, any CSV export). Make the test enumerate every member-reachable route.

### R2-S4. blocker - Two member-tier paths still neutralize the gate

(a) `burn.attribution.write` is member tier and authorizes `POST /v1/rules`. A rule with `priority: 1`, `match: {}` (the schema's own default), `outcome_kind: 'non_billable'` matches every work item org-wide at stage zero. Everything becomes `excluded_non_billable`, consumption goes to zero, no `deny` can ever fire, with no `gate_demoted_at`, no notification, no banner, and a healthy-looking board. Strictly better than the S3 attack and needs no admin. (b) Coverage-driven demotion (§5.5.2) received none of S3's floors; its input is bill-api's counter incremented on every error path, and a member bursting expense creates can trip burn-api's rate limiter, which is not 5xx but still fails open and still increments. (c) `title_regex` is member-authored and §3.1 claims it is "compiled with a timeout" - **Node's RegExp has no timeout**; that mitigation does not exist, and a ReDoS pattern stalls the shared worker.

**Fix.** (a) Reject a rule whose `match` has no discriminating key (CHECK + Zod refinement); floor `non_billable` rules and any null/empty-scope rule to owner/admin via `burn.rule.write`; cap the fraction of items one rule may sweep and raise a variance when a new rule matches more than N pct of the trailing window. (b) Apply S3's treatment to coverage demotion: minimum absolute count of unavailable days, attributable to burn-api health (breaker-open or connect failure) not 4xx, count 429s separately and never toward coverage loss, rate-limit expense creation per user. (c) Use RE2 or restrict `title_regex` to glob/substring; drop the false timeout claim.

### R2-S5. major - The accepted S8a fix has no implementation path

"Call bill-api as the decider with the decider's own credentials" executes in a `proposal.decided` subscription where there is no session, cookie, or API key. The only impersonation mechanism in the tree is `X-Impersonate-User` at `apps/api/src/plugins/auth.ts:287`, which is SuperUser-only, apps/api-only, and refuses to chain. bill-api has no internal route and no acting-user plugin. Faced with an unimplementable instruction, an implementer either reverts to internal-secret-plus-asserted-user (S8a reopened silently) or invents an `X-Acting-User` header bill-api must trust, creating a general cross-service impersonation primitive with no session binding, no audit, no scoping.

**Fix.** Adopt the real platform pattern from `apps/bulwark-api/src/subscriptions/proposal-decided.ts`: call `POST /internal/permissions/dual-read` for the decider against the specific `bill.*` identifier the write requires, fail closed on non-2xx, pass the decider through `POST /v1/agent-policies/<id>/check`, then write through bill-api's internal path carrying `acting_user_id` in the body with the internal secret. Name the `bill.*` identifier. Require bill-api to record `acting_user_id` on the row and publish it in the Bolt event. Do NOT introduce a trusted acting-user header.

### R2-S6. major - The ported `project-scope.ts` predicate inverts the D4 fix

The file the spec instructs porting (`apps/bulwark-api/src/lib/project-scope.ts`) operates on a single nullable `project_id` column and its documented SK3 fallback is that a NULL project passes for **every org member**. Burn engagements have no `project_id` column, so the predicate must become an EXISTS over the join table; ported literally, the `unlinked` state that §3.1 defines as `read_all`-only becomes org-wide readable. Second, any-vs-all semantics for a multi-project chain are undefined and the seed exercises them: a member of the low-sensitivity project reads the whole chain's rollup, ledger, and work items including items sourced from the project they are not in.

**Fix.** State that Burn's predicate is a distinct implementation, not a port: `EXISTS (SELECT 1 FROM burn_engagement_projects ep JOIN project_memberships pm ON pm.project_id = ep.project_id WHERE ep.engagement_id = ... AND pm.user_id = :viewer)` with **no null/empty fallback**. Specify that work-item and attribution rows are scoped by the row's own `project_id`, not chain reachability. Add both cases to §12.1; keep the parity test against `visibility.service.ts:203` for the single-project case only.

### R2-S7. major - The advisory-feedback control is rendered to members but its write route is admin-floored

§5.4 places "Right call? Yes / No / I'd have mapped it" inline on the note the expense creator sees; §6.1 gates `POST /v1/prechecks/:id/label` on `burn.precheck.mark_wrong` (owner/admin). Every member who clicks gets a 403. An implementer fixing that UX bug opens the route to `burn.precheck.override` (member), and §5.6 counts `gate_wrong`/`wrong_call` together toward the demotion numerator - so S3's fix evaporates through a UX repair nobody flags as a security change.

**Fix.** Split by value: `right_call` and `would_have_mapped` are member-writable on a non-enforced row the caller triggered and feed nothing; `wrong_call` and `gate_wrong` require `burn.precheck.mark_wrong` and are the only values in the demotion numerator. The inline control renders only the two member-writable options plus "flag for review". Extend the test beyond `gate_wrong` to assert `wrong_call` is also 403 at member tier.

### R2-S8. major - `POST /v1/precheck` is member-tier, unrate-limited, and its rows count toward promotion

Precondition 1 counts "precheck rows" with no restriction to the `svc:` namespace or to real money-out paths. A member scripts 200 rows with `work_ref_type: 'manual'` in seconds, satisfying the volume gate on a synthetic sample; with 10 admin-labeled denies the org promotes on calibration that measured nothing. Also unbounded member-writable inserts into a partially never-purgeable table, and each call may trigger LLM adjudication, making it a member-reachable amplifier against `attribution_llm_daily_cap` and the shared llm seam.

**Fix.** Count only `svc:`-namespaced rows toward `min_advisory_decisions` and `min_labeled_denies`. Add a per-user rate limit and a per-org daily ceiling on `usr:` rows. Require `work_ref_id` to resolve to a real record for a `usr:` precheck, or mark `manual` rows non-calibrating. Test: 500 member-generated prechecks do not move promotion standing.

### R2-S9. major - Extraction launders Bin document text into member-readable fields

The only access check is `preflightAccess(created_by, 'bin.asset', ...)`, the registrant's own visibility. Bin's `visibility='private'` is owner-only with no org-admin bypass, so a registrant can point Burn at a private asset. Extraction writes LLM-produced `title` and `description` derived verbatim from clause text into `burn_deliverables`, served to any project member. The spec floors `cited_span.quote` and stops; `description` is the same content one paraphrase removed - an MSA's rate schedule or exclusivity terms reaching an audience that could not open the document.

**Fix.** Floor `description` to `burn.financials.read_all` alongside `quote`, leaving `title` as the member-visible handle. Re-preflight the source asset **per reader**, not just per registrant, and drop deliverables whose asset the reader cannot access with a "N hidden by permissions" count, as §2.4 point 4 already does for cited source records. Add the test.

### R2-S10. minor - No minimum-contributor floor on cost aggregates

Aggregation protects only above a contributor count of one. A retainer chain worked solely by one person makes `attributed_cost` that person's cost, and `cost_rate_coverage_pct` independently discloses which individuals have a rate configured (a member who knows the work-item composition reads coverage as a linear equation over contributors).

**Fix.** Enumerate the banded fields explicitly and suppress `attributed_cost`, `margin_amount`, `margin_pct`, and `cost_rate_coverage_pct` entirely (not banded) for non-`read_all` callers when the chain's distinct contributor count is below 2 or 3; return `metric_basis` and consumption band only.

---

## STABILITY (4 blockers, 5 majors)

Round 1 resolved: T1, T2, T5/I1, T10, T11-ws. Partially: T3, T4/I2, T6, T8, T9/S2, T11-retention. Not resolved: T7.

### R2-T1. blocker - The corrected advisory-lock citation is wrong again, and the real precedent is defective

`apps/worker/src/jobs/bulwark-radar-sweep.job.ts` is 29 lines with no lock of any kind; "per-org advisory lock" appears only in a doc comment describing what bulwark-api does downstream. Round 1 rejected `bond-stale-deals.job.ts:127-138` for exactly this reason and round 2 folded in a second comment-only citation. The real implementation is `apps/bulwark-api/src/services/sweeps.service.ts:41-52` and **it is defective**: `pg_try_advisory_lock` is SESSION-scoped (not `_xact_`), acquired via `db.execute` on a pooled connection, released via a second `db.execute` that may land on a different connection, with the failure swallowed by `.catch(() => {})`. When lock and unlock split, the lock stays held until the connection recycles, and from then on every caller skips - indistinguishable from contention, so nothing alerts. For Burn that means the variance sweep, three reconcile passes, rollup refresh, and silent-deliverable sweep become permanent no-ops for that tenant. Same pooled-connection class of defect the spec itself diagnoses for RLS at §2.4 point 14, adopted uncritically two sections later.

**Fix.** Cite `apps/bulwark-api/src/services/sweeps.service.ts:41-52` as the shape and state explicitly that Burn does NOT copy it as-is, in the voice §2.4(14) uses for RLS. Use `pg_advisory_xact_lock`/`pg_try_advisory_xact_lock` inside the sweep transaction following `apps/braid-api/src/lib/advisory-lock.ts:79`, or a Redis `SET key token PX ttl NX` lease with token-checked release following `apps/bill-api/src/services/sequence.service.ts:50`. **Pick one and say which** - §4.2/§4.3/§8.1 currently say "Redis lock" while the cited precedent is Postgres. State that the lock lives in burn-api's sweep service, not the worker job, since BullMQ `concurrency: 1` bounds the worker container and not the burn-api replica set. A skipped-because-locked sweep emits a counted log line.

### R2-T2. blocker - The epoch hashes no rate-determining input, so configuring cost rates never revalues anything

`billable_amount`/`cost_amount` are functions of `(minutes, user_id, project_id, effective-dated rate rows)`. The `bam.time_entry` epoch is `minutes, date, task_id, description` - it omits `user_id` entirely (which exists at `apps/api/src/db/schema/time-entries.ts:12` and is the primary cost-rate axis) and omits every rate table. Nothing else triggers revaluation. So the moment an org populates `burn_cost_rates` (the screen whose entire purpose is flipping `metric_basis` to `true_margin`), every already-observed work item keeps `cost_amount = null` forever. Playwright story 2 asserts the board flips to Margin with 100 pct coverage after two rates are added; under this design it never flips. Same freeze applies to any retroactive `bill_rates` correction.

**Fix.** Separate observation identity from valuation freshness. Keep the content hash as the source-observation key; add a `valuation_epoch` (hash of resolved `bill_rate_id`, `burn_cost_rate_id`, `user_id`, and the rate rows' `updated_at`) plus `valued_at` on `burn_work_items`. Add `user_id` to the `bam.time_entry` epoch. Specify a revaluation path that is **not the classifier**: a `burn-revalue` pass triggered on any cost-rate write and on `bill_rates` changes, re-resolving rates and rewriting amounts in place with **zero LLM cost**. State that revaluation never supersedes an attribution and never re-classifies. Test: adding a cost rate for a user with 40 existing work items moves coverage and issues no llm-provider call.

### R2-T3. blocker - Pass 1 is anchored on `created_at` and passes 2-3 on `occurred_at`

§2.3.2 pass 1 justifies `created_at` precisely because "a `date`-based watermark would permanently miss backdated timesheets, which is the normal case." Then passes 2 and 3 operate on rows "with `occurred_at` inside `reconcile_window_days`", and `occurred_at` is business time. A timesheet entered today for work done 120 days ago is ingested by pass 1, materialized with `occurred_at` 120 days back, and lands OUTSIDE the window on the same sweep: never re-hashed (edits invisible), never anti-joined (deletion invisible, dollars consume forever). The class pass 1 exists to catch is the class passes 2-3 structurally exclude. Separately `bam.task` has no business-time column at all, so `occurred_at` for a task is undefined; under the plausible mapping a long-lived task falls out of the window while `time_logged_minutes` keeps accruing, and pass 2 is the only mechanism that can observe that accrual.

**Fix.** Anchor passes 2 and 3 on **ingest time**: re-read and anti-join over `burn_work_items` where `greatest(ingested_at, occurred_at)` is inside the window, or add `reconcile_until timestamptz` per work item set to `ingested_at + reconcile_window_days` with an index on it. Publish a per-`source_type` `occurred_at` mapping table alongside the epoch table. For `bam.task` either use `ingested_at` for windowing or drop `time_logged_minutes` from valuation entirely (see R2-D1). Note `bill_expenses` has indexes on `organization_id`, `project_id`, `status` only - no `created_at` index - so the "no new platform indexes required" claim covers only the two Bam sources.

### R2-T4. blocker - An edit that reverts a value collides with the unique index against an already-excluded row

Pass 2 says a changed hash creates a new observation and marks the prior `excluded`, reversing its dollars. Consider minutes 60 -> 90 -> 60, or a typo fixed then reverted. The third observation's hash equals the first's, so the INSERT hits `UNIQUE (organization_id, source_type, source_id, source_epoch)` on a row already `excluded/superseded_epoch` with dollars reversed. Either an unhandled 23505 aborts the sweep transaction for that org (and with R2-T1's lock defect, possibly permanently), or `ON CONFLICT DO NOTHING` silently leaves it excluded forever so the envelope permanently undercounts and the gate under-blocks. Neither is stated; §12.1 tests shrink, grow, and delete, never revert.

**Fix.** Make the observation key monotonic: keep `UNIQUE (organization_id, source_type, source_id) WHERE attribution_state <> 'excluded'` as the live-row constraint and store `source_epoch` as a plain compared column, so pass 2 is "compare hash; if changed, supersede the live row and insert a new live row" with no tombstone collision possible. If the four-column index is kept, specify the conflict handler as an explicit resurrect (`ON CONFLICT ... DO UPDATE SET attribution_state='pending', exclusion_reason=NULL, ...`) re-applying the dollars and preserving any prior human attribution. Add the revert case to §12.1.

### R2-T5. major - Retention's "immutable historical record" is overwritten by the hourly full recompute

T11's fix is that after `burn-retention` purges a closed chain's work items, the rollup serves the frozen figure with its `as_of`. T1's fix specifies refresh as "a full per-chain recompute upserted in one statement", hourly, with no exclusion for closed or purged chains. The first refresh after a purge recomputes from surviving rows (near zero) and `DO UPDATE`s the historical row, replacing a three-year-old $18,000 figure with $0 and stamping a fresh `computed_at` so it does not even read as stale. The two accepted fixes cancel each other. `GET /v1/financials` on a missing rollup does the same on demand.

**Fix.** Add `frozen_at timestamptz` (or `is_final boolean`) to `burn_engagement_rollups`, set by `burn-retention` when it purges. Both the hourly refresh and the synchronous on-miss compute skip rows where `frozen_at IS NOT NULL`; `GET /v1/financials` surfaces `final: true` alongside `as_of`. State it in both §3.1 and §8.1. Test: purge a closed chain, run the refresh, assert the figure is unchanged.

### R2-T6. major - The gate needs a confident target, which needs an LLM call, which cannot fit in the timeout

In the pre-transaction case `work_ref_id` is null, so there is no prior attribution to reuse and no work item to look up. The gate must run stage zero (rules), stage one (retrieval), and, whenever those do not produce a 0.85-confidence target, stage two: `POST /internal/llm/chat`. A provider round trip is seconds, not sub-600ms. §5.5 lists "LLM provider down or slow" as degrading to `needs_mapping`, which is non-blocking - so the realistic steady state is that every gated expense either burns the full 800ms and fails open, or falls to `needs_mapping`. **The blocking gate is decorative.** §12.1 tests failure paths but never asserts a p95 latency for the success path, and the seed data is generated rather than measured, so the promotion wizard would show 0.96 precision on a sample the gate produced without exercising the slow path.

**Fix.** State explicitly that the synchronous precheck path is **deterministic-only** - rules, structural resolution through `burn_engagement_projects`, precedent lookup, lexical retrieval - and that stage two is **never invoked on the gate path**. If no deterministic target clears `deny_threshold`, the verdict is `needs_mapping` (already non-blocking, so this costs nothing in safety). Give the precheck path its own budget breakdown and assert in §12.1 that `POST /v1/internal/precheck` issues **zero llm-provider calls** and completes under `precheck_budget_ms` at p95. This removes the last route by which classifier latency touches money.

### R2-T7. major - "Recompute and supersede" on a precheck key hit is unimplementable against the stated schema

`burn_prechecks` has `UNIQUE (organization_id, idempotency_key)` and **no** `superseded_at`, `superseded_by`, or attempt-sequence column, unlike `burn_attributions` which has both. So on a mismatch or past-`valid_until` hit there are only two implementable behaviors: UPDATE in place, destroying the prior verdict on the row §5.1 calls "the reason-of-record artifact"; or INSERT and take a 23505 on the money path where the only safe handler is fail-open.

**Fix.** Add `superseded_at` and `superseded_by` to `burn_prechecks`, change the index to `UNIQUE (organization_id, idempotency_key) WHERE superseded_at IS NULL`, and specify recompute as supersede-then-insert in one transaction, the shape §2.3.10 already uses for attributions. State that a superseded precheck is retained under the retention exemptions since the superseded verdict is part of the dispute record.

### R2-T8. major - The human-precedence invariant is scoped to the wrong entity

The invariant reads "the attribution engine never supersedes a row with `state='confirmed'` or `method='human'`". Attributions are keyed to `work_item_id`. Pass 2 does not edit a work item - it inserts a NEW work item with a new epoch and tombstones the old. The new work item has no attributions, so the invariant does not apply and the engine classifies from scratch. A user who mapped "Third revision of Mrs. Howell's seating chart" loses that decision the moment anyone fixes a typo in the description, which is an epoch input. That is exactly the failure T8 was written to prevent, arriving through the door T2/T3 opened, and it re-spends LLM budget on items already decided.

**Fix.** State the invariant at the **source-record** grain: on an epoch change the new work item inherits the prior live attribution when it is `confirmed`/`human`, carried forward with `method='human'`, revalued but not re-classified, and flagged for review only when the new epoch changed classification-relevant fields (title, description, project) as opposed to cost-relevant ones (minutes, amount). Make that split explicit as two hashes, `classification_epoch` and `cost_epoch`, so a minutes edit revalues without re-deciding. Test: confirm an attribution, edit the source minutes, assert one llm-provider call total and the human decision preserved.

### R2-T9. major - The claim lease has no renewal and the two concurrency knobs contradict each other

`burn-attribute-batch` is a thin HTTP caller with "its own generous AbortController deadline", draining an inbox where each item may cost an LLM round trip. A batch will routinely exceed the 300s `claim_lease_seconds`. `burn-claim-reaper` runs every 5 minutes returning claimed-longer-than-lease rows to `pending`, so the next drain claims and re-processes rows the first is still mid-flight on - reintroducing the duplicate spend and index race T6 exists to prevent, now with a timer instead of a race. Separately §8.1 gives the queue `concurrency: 1` AND says it honors `BURN_ATTRIBUTE_CONCURRENCY` (default 2); those cannot both hold. The limiter is inert under `concurrency: 1`. And `claim_lease_seconds` is referenced three times but is not a column in `burn_org_settings` nor a named env var.

**Fix.** Add lease renewal: the drain heartbeats `claimed_at = now()` on rows it still holds every N seconds and the reaper only reclaims genuinely cold rows; state the renewal interval as a fraction of the lease. Bound batch size so worst-case duration sits inside the lease and say what it is. Resolve the knob contradiction explicitly (either `concurrency: BURN_ATTRIBUTE_CONCURRENCY` with the per-org lock and claims as the correctness mechanism and keep the limiter, or `concurrency: 1` and delete both). Declare `claim_lease_seconds` as a column or env constant.

### Folded stability note
§5.5.1's circuit breaker cites `apps/bulwark-api/src/services/gate.service.ts` as "the per-org shape". That file is a Redis SET of event bindings used as a dispatch cache whose own header says it "must NOT be hardened into a two-phase commit" - no state machine, no failure counter, no half-open. Third comment-or-wrong-file citation in the locking/breaker family. The breaker also needs a multi-replica design: "open after N consecutive timeouts" across independent bill-api replicas needs an atomic shared counter, and the half-open probe needs single-flight election or every replica probes a recovering burn-api simultaneously. Name `apps/bill-api/src/services/sequence.service.ts:50` as the real Redis primitive precedent and specify counter key, state key, open TTL, and probe election.

---

## BEST PRACTICES (0 blockers, 5 majors, 3 minors)

**All eight round 1 findings verified resolved against the real files.** Migration tip confirmed `0238` (200 files) so `0239`-`0243` is right; `event-catalog.ts` anchors exact; `publishBoltEvent` signature exact; zero em dashes and zero en dashes.

### R2-B1. major - The built-in-group-defaults migration is a silent no-op if numbered before the generated delta

`scripts/build-permission-delta.mjs:42,48` computes `migrationNum = max(all four-digit prefixes) + 1`. If the author writes `0243_burn_builtin_group_defaults.sql` before running the generator (which §9.8's "Land 0239-0243 on disk, then lint them" literally instructs), the generator emits `0244_permissions_seed_actions_delta_023.sql` and the group-defaults file runs FIRST. Its `CROSS JOIN permissions p ... WHERE p.app = 'burn'` matches zero rows, `ON CONFLICT DO NOTHING` swallows it, migrate reports success, and the file is checksummed so it never re-runs. **No built-in group grants any `burn.*`, so every non-SuperUser including org Owners hits `implicit_deny` on every route.** This is verbatim the incident `0238`'s own `-- Why:` header documents for Bulwark.

**Fix.** Make §9.8's ordering unambiguous: author `0239`-`0241`, run `build-permission-delta.mjs` (which assigns NNNN), then author group-defaults as NNNN+1. Add a post-migrate verification probe: `SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted) FROM permission_group_defaults d JOIN permissions p ON p.id = d.permission_id JOIN permission_groups pg ON pg.id = d.group_id WHERE p.app = 'burn' GROUP BY 1;` with expected counts stated (owner 20, admin 20, member 14, viewer 5, guest 0). A zero result means the ordering inverted and the fix is a NEW file, never an edit.

### R2-B2. major - The per-org lock is specified as Redis on a file containing no lock

Round 1's T7 reproduced one file over. See R2-T1 for the full analysis and fix. Correct §8.1's "per-org Redis lock" column to the chosen mechanism for `burn-variance-sweep`, `burn-silent-deliverable-sweep`, `burn-rollup-refresh`, `burn-calibration-recompute`, and `burn-retention`.

### R2-B3. major - The circuit breaker cites a Redis SET cache, and its thresholds have no name, default, or env registration

`gate.service.ts` is 113 lines of `SADD`/`SISMEMBER` on `bulwark:bindings:<org>`. Grepping `apps/` and `packages/` for `circuitBreaker|CircuitBreaker|halfOpen|half_open` returns **zero files**: Burn is building the suite's first circuit breaker, in bill-api, a service Burn does not own. §5.5.1 names "open after N consecutive timeouts" and "half-open probe on an interval" without naming N or the interval, so unlike `BURN_PRECHECK_TIMEOUT_MS` the two values deciding whether the money gate is on have no env var, no default, no `services.mjs` entry, and no Railway variable. §12.1's "breaker opens after N consecutive failures" test has no N to assert.

**Fix.** Drop the `gate.service.ts` breaker citation (keep it for §8.3's binding set where it is genuinely right) and state plainly that no breaker exists in the platform and Burn is establishing it. Name `BURN_PRECHECK_BREAKER_THRESHOLD` (default 5) and `BURN_PRECHECK_BREAKER_PROBE_MS` (default 30000), add both to bill-api compose env and `bill-api.env.optional`, and name the Redis key shape `burn:breaker:<org>`. State whether it lands in `burn-precheck.client.ts` only or is promoted to a shared package, and give it its own unit test file.

### R2-B4. major - The thirteen Playwright stories have no registration point, so none would run

`apps/e2e/playwright.config.ts` builds each suite from an explicit `appProject(name)` call whose `testDir` is `./src/apps/${name}/tests`, and the `projects` array is hand-maintained ending at `appProject('helpdesk')`. With no `appProject('burn')` entry, a `burn.spec.ts` is picked up by neither the projects list nor the `setup` dependency chain that provides `.auth/admin.json` storage state. The entire §12.2 suite is dead code that silently never executes. §12.4's nine gates never mention e2e registration or `pnpm test`.

**Fix.** Add both edits by file: `appProject('burn')` in the `projects` array of `apps/e2e/playwright.config.ts` alphabetically among the `b*` entries, and specs at `apps/e2e/src/apps/burn/tests/burn.spec.ts` mirroring `apps/e2e/src/apps/bulwark/tests/bulwark.spec.ts`. Note the suite runs against the gilligan-seeded stack and depends on the `setup` project.

### R2-B5. major - `can-access.client.ts` is ported for the fourth time against a documented consolidation precedent

It already exists in `apps/basis-api/src/lib/`, `apps/braid-api/src/lib/`, and `apps/bulwark-api/src/lib/`. CLAUDE.md records the opposite precedent explicitly: `packages/storage` exists because it "consolidates the previously-triplicated MinIO clients." `can_access` is the suite's fail-closed visibility preflight, and four independent copies means a fix to the fail-closed path or a `SUPPORTED_ENTITY_TYPES` change lands in one and silently not the other three. `braid-resolve.client.ts`, `internal-llm.client.ts`, and `project-scope.ts` are at two copies each heading the same way.

**Fix.** State in §14 that this build promotes `can-access.client.ts` into a shared package (`@bigbluebam/visibility-client`, or a subpath on `@bigbluebam/shared` per the `bulwark-arm-key` node-builtin pattern since it needs `INTERNAL_SERVICE_SECRET`) with the three existing apps migrated in the same change. If judged out of scope, say so explicitly and record a tracked task naming the three copy paths - do not let a fourth copy land silently under the word "reuse."

### R2-B6. minor - The docs obligation stops at `help.md`

`docs/apps/bulwark/` ships `guide.md`, `help.md`, `help-index.json`, `mcp-tools.md`, `meta.json`, and `screenshots/`. §9.6.1 names only `help.md` + `help:index` + `docs:manual` + `docs:catalog`. `scripts/docs/publish.mjs:428-435` discovers apps by scanning `docs/apps/*/meta.json` and copies `marketing.md` to `site/src/content/apps/<app>.md`. None of `docs:extract`, `docs:compose`, `docs:publish`, `marketing.md`, or `site/src/content/apps/burn.md` appears in the spec, so "add a Burn section to the marketing site" has no named artifact.

**Fix.** Extend §9.6.1 with the remaining pipeline and note that `apps/frontend/Dockerfile:232` `COPY docs/apps/` is what serves `help-index.json` to the in-app Help Center at runtime, so the frontend image must be rebuilt after `help:index`.

### R2-B7. minor - §8.2 gives payload field names but not the `EventDefinition` shape the drift guard requires

`scripts/check-bolt-catalog.mjs` parses with a regex having a **300-character window** between `source:` and `event_type:`. A `burnEvents` block with long multi-line descriptions before `event_type` pushes the pair outside that window and the guard reports the event as undeclared even though it is present.

**Fix.** State that each of the ten entries carries a `description` and a fully typed `payload_schema` array on the `bulwarkEvents` model at `event-catalog.ts:2940-2960`, and that `source:` must precede `event_type:` within 300 characters. Same for the two backfilled `billEvents`.

### R2-B8. minor - Citation drift in three places, plus the one Drizzle idiom with no stated precedent

(a) §9.3 cites "the basis scheduler pattern at `worker.ts:673-679`" - those lines are `bearingSnapshotWorker` handlers; the basis `upsertJobScheduler` calls are at `:691-724`. (b) §6.1/§14 cite `service-health/src/index.ts:62,66,84` - actual are `:63`, `:67`, `:84`. (c) §9.6 cites `services.mjs:298` - the bulwark block starts at `:292` and the healthcheck line is `:297`. (d) §3 requires `search_tsv` in Drizzle but names no idiom; Drizzle has no first-class tsvector kind and the platform's answer is `customType<{ data: string }>({ dataType: () => 'tsvector' })` at `apps/braid-api/src/db/schema/braid-profiles.ts:15-18`. Without naming it an implementer reaches for `text()`, which `db-check.mjs:468` downgrades to a non-fatal warning and therefore never catches.

**Fix.** Correct the three references and add the `customType` precedent by file and line. Add a standing rule to §12.4 that every file:line citation is re-verified against git at implementation time.

---

## INFRASTRUCTURE (1 blocker, 6 majors, 1 minor bundle)

Round 1 resolved: I3, I6, I2. Partially: I1, I4, I5. Not resolved: I7.

### R2-I1. blocker - The Railway variable path is `ENV_HINTS`, not `railway/env-vars.md`

`railway/env-vars.md` is GENERATED by `scripts/gen-railway-configs.mjs:543` from `hintFor()` in `scripts/deploy/shared/env-hints.mjs`, which returns `kind: 'unknown'` for any unlisted var. In `railway-orchestrator.mjs`, `unknown` resolves to SKIP (`:126-131`); an **optional** var is then silently omitted (`:157-159`) and a **required** var **throws** (`:149-152`), aborting the deploy. Concretely: (a) `BURN_API_INTERNAL_URL` is optional on bill-api, so on Railway it is never set, the preHandler no-ops per the spec's own "an unset URL means the gate is absent and every expense posts normally", and **the flagship gate does not exist in production with no signal anywhere**; (b) `BURN_API_URL` optional on mcp-server means all 17 tools fall back to a localhost default, verbatim the recorded Banter/Bureau/Blueprint incident at `env-hints.mjs:202-209`; (c) the spec's burn-api **required** list includes `BOLT_API_INTERNAL_URL`, which has no hint today, so `buildServiceVariables` throws before burn-api is ever created.

**Fix.** Add to the "Inter-service URLs" block in `env-hints.mjs`: `BURN_API_INTERNAL_URL: { kind: 'computed', value: internal('burn-api') }`, `BURN_API_URL: { kind: 'computed', value: \`${internal('burn-api')}/v1\` }`, `BURN_PRECHECK_TIMEOUT_MS: { kind: 'literal', value: '800' }`, `BURN_ATTRIBUTE_CONCURRENCY: { kind: 'literal', value: '2' }`, plus the two breaker vars from R2-B3. Add a coverage test alongside `railway-orchestrator.test.mjs` asserting every name in every `APP_SERVICES[].env.{required,optional}` has a non-`unknown` hint. Either supply the missing `BOLT_API_INTERNAL_URL` hint in this build or move it to `optional` on burn-api. [Pre-existing missing hints tracked separately.]

### R2-I2. major - The ordered rollout builds only burn-api and frontend, omitting every service the spec changes

§9.2 changes **bill-api** (the preHandler on four hook points, the client, `POST /internal/rates/resolve`, two `publishBoltEvent` calls); §9.3 changes **worker** (9 queue families plus the reaper); §8.3/§9.6 change **bolt-api**; §9.6 changes **mcp-server** and **api** (`LAUNCHPAD_CATALOG`, `SUPPORTED_ENTITY_TYPES`). None is rebuilt. Same class as I4: the sequence looks complete and produces a stack where the flagship feature is silently absent.

**Fix.** Extend to `docker compose build burn-api bill-api bolt-api worker mcp-server api frontend && docker compose up -d --force-recreate <same>`, state burn-api first, and add the negative verification: `docker compose exec bill-api env | grep BURN_` shows both vars, and a `POST /bill/api/v1/expenses` produces a `burn_prechecks` row.

### R2-I3. major - The `/metrics` exposure is unimplementable, and coverage cannot distinguish unconfigured from unavailable

`packages/service-health/src/index.ts:84` registers `/metrics` returning a FIXED JSON body and `HealthCheckPluginOptions` (`:20-25`) has no metrics hook; surfacing `burn:gate_unavailable:*` requires changing a shared package used by ~22 services, which the spec never budgets. Worse: the counters are INCR'd by bill-api's client, so if `BURN_API_INTERNAL_URL` is unset (the Railway default per R2-I1) the client never runs and **neither counter increments**. Coverage is `0/0`, the spec defines no behavior for that case, and the auto-demotion trigger cannot fire. An org that promoted and then lost the env var sees exactly the clean console I1 existed to eliminate.

**Fix.** Either add `extraMetrics?: () => Promise<Record<string, unknown>>` to `HealthCheckPluginOptions` and own that shared-package change with its blast radius stated, or drop the `/metrics` clause and rely on log code + console + variance. Define the `0/0` case: bill-api increments `burn:gate_calls` on **every gated write attempt including the unconfigured no-op**, so a missing env var reads as 0 pct coverage and trips the same demotion path, and the console distinguishes `gate_not_configured` from `gate_unavailable`.

### R2-I4. major - Redis is a hard dependency of the gate and §5.5 has no row for it

Breaker state, coverage counters, per-org locks, the bindings cache, the `PermissionContext` cache, and 9 BullMQ queues all sit on the single `redis` service, which `docker-compose.yml:29-53` runs at `--maxmemory 256mb --maxmemory-policy noeviction` - at the cap **writes error out** by design. The spec enumerates burn-api-down, breaker-open, timeout, LLM-down, Qdrant-down, currency-mismatch, and never says what the preHandler does when Redis is unreachable or at cap. Read strictly, a Redis failure could throw inside the preHandler and **block the expense write**, violating "the gate never blocks because something broke."

**Fix.** Add a Redis row specifying fail-open with an in-process breaker fallback, following `apps/mcp-server/src/lib/confirm-token-store.ts` (Redis-backed with graceful in-process fallback), which the spec already cites elsewhere. State that every Redis touch in `burn-precheck.client.ts` is wrapped and non-throwing. Add Redis sizing to §9.7 and state when `--maxmemory` must be raised.

### R2-I5. major - The reverse leg of the coupling has no failure mode

The spec is exhaustive about bill-api -> burn-api failing open and silent about burn-api -> bill-api `POST /internal/rates/resolve`. During a bill-api rolling restart, a rollback to a build without the route (404), or with `BILL_API_INTERNAL_URL` unset on Railway (optional, therefore skipped), rate resolution fails. Nothing says whether the work item takes `valuation_basis='unrated'`, whether the batch retries, or whether `billable_amount` lands null. The dangerous default is null: consumption understated, board healthier than reality, gate **under-blocks** - the undetectable-by-the-buyer direction, arriving through a deployment seam.

**Fix.** Add a §5.5 row and a §2.3.1 paragraph: a rate-resolve failure marks the item `valuation_basis='unrated'` with a typed reason, **excludes it from every envelope and rollup** (never values it at zero), surfaces it in queue health as "N items awaiting valuation", and is retried by the next reconcile pass. Promote `BILL_API_INTERNAL_URL` to **required** on burn-api with a matching computed hint. Add a fourth negative test: with bill-api returning 404, assert no work item receives a non-null `billable_amount` and no rollup changes.

### R2-I6. major - The mandatory RLS GUC binding is per-request, but four paths are org-less or cross-org

Under `BBB_RLS_ENFORCE=1` a global reaper scan on `(status, claimed_at)` with no `app.current_org_id` set returns **zero rows**, so expired claims are never released and `burn-attribute-batch` permanently stops draining for any org whose worker died mid-claim. Same for `burn-retention` and `burn-calibration-recompute` if they scan globally, and for `POST /v1/internal/events`, which has no session. This is new in round 2, introduced by the claim reaper; the T6 fix was accepted without checking the RLS interaction.

**Fix.** State in §2.4 point 14 and §8.1 how internal and cross-org paths bind: internal routes derive the org from the validated payload and set the GUC in the same transaction; the reaper, retention, and calibration jobs **iterate orgs**, taking the per-org lock and setting the GUC per org rather than one global scan (which also gives the flushed per-org progress logging §4.3 commits to). Add the reaper and one internal route to the mandatory RLS test.

### R2-I7. major - The escalated LLM cap is still an open question with no mechanism, and the contended container is unsized

§9.7 calls the cap "a prerequisite, not a fast-follow", then Open Question 8 says "decision needed on whether the cap lands before Burn ships". An autonomous build will read the open question and ship without it. `apps/api/src/routes/internal-llm.routes.ts` has no rate limit, no semaphore, no queue, no concurrency guard. The route lives on the **api** container, which is also the permission resolver every satellite calls, so Burn's 2000-call/day/org load contends with the request path of all 21 other apps. §9.7 sizes burn-api and the worker and never mentions api. Separately "burn-api starts at 2 replicas" is unactionable: there is no `deploy.replicas`, `mem_limit`, or `cpus` anywhere in `docker-compose.yml` and no replica field in the services.mjs catalog.

**Fix.** Move the cap into §9.7 as a specified deliverable with a mechanism (Redis token-bucket or in-process semaphore keyed per calling service in front of `internal-llm.routes.ts`, returning 429 with `Retry-After`), a defined client behavior on 429 (defer to `pending_attribution`, never `unscoped`), and a done criterion. Add `api` to the sizing paragraph. Replace "2 replicas" with either a compose `deploy.replicas` addition Burn owns and the precedent it sets, or a statement that replica count is Railway-dashboard-only and 2 is an operator instruction.

### R2-I8. minor bundle - Four smaller deployment gaps

(a) The advisory-feedback control renders "inline on bill-api's advisory note", requiring a change to `apps/bill/` (the Bill SPA) that appears nowhere in §9.4's build inventory; name it as a changed app or move the control to the Gate Console only and update story 4. (b) `burn-api.needs = [...,'bill-api']` contradicts `services.mjs:301-304` where bulwark-api deliberately omits request-time deps; drop it and state that the burn/bill request-time dependency is mutual and the acyclic invariant is held by keeping both services' compose `depends_on` at `migrate`/`postgres`/`redis` only. (c) Adding `burn-api: service_healthy` to `frontend.depends_on` lets the newest service block ingress for all 21 SPAs; `bill-api` and `bureau-api` are deliberately absent from that list today (`docker-compose.yml:284-326`), so match that precedent or state the tradeoff. (d) §9.8 says "land 0239-0243 then lint then migrate" but §3.4 step 4 requires `build-permission-delta.mjs` (which needs 0239-0241 applied) before 0243 can be numbered; reorder into two migrate passes. Also add the three new env vars to `.env.example`.
