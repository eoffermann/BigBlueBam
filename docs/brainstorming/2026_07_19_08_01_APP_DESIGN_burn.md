# Burn - App Design Specification

> Burn watches the work a services firm is actually doing against the contract that paid for it, blocks the charge that was never in scope before it posts, and reports which client is consuming its contract fastest and exactly what caused it.
>
> Status: **FINAL**, hardened through adversarial review rounds 1 and 2. Ready for app-build-from-spec. New app. Winner of the 2026-07-19 08:01 suite-brainstorm session (Seat F, 27 of 30 points).
> Chosen internal port: **4022** (verified free; highest current is bulwark-api at 4021).
> Routes: SPA at `/burn/`, REST at `/burn/api/`, realtime at `/burn/ws`.
> Chosen final name: **Burn** (single word). App id `burn`.

**Citation discipline.** Two review rounds found citation drift, twice in the locking family, where a named file contained only a doc comment describing behavior implemented elsewhere. Every `file:line` in this document has been re-verified against the working tree at the time of writing. Where a pattern **does not exist in the tree**, this spec says so plainly and states that Burn establishes it, rather than naming the nearest-looking file. Section 12.4 makes re-verification a standing gate at implementation time.

House style: no em dashes or en dashes; no Co-Authored-By footer.

---

## 1. Overview and positioning

### 1.1 One-liner and product thesis

Burn reads the signed SOW, proposal, or engagement letter (a **Bin** asset) into a **deliverable ledger**: a typed list of what was actually sold, each item carrying a clause citation and a **priced envelope**. It then continuously classifies every unit of work the org logs against that ledger, in dollars, attributed to a Braid-resolved client, with an explicit **`unscoped` bucket that is the product**: every item in it is work someone is doing that nobody sold.

The axis is **latency plus interception**. Time trackers know hours but not scope. Project tools know tasks but not price. Accounting knows invoices but not the work. None of them has ever read the contract. Nothing at this price point blocks a charge against a contract term before it posts, which is the entire difference between a change order and a write-off.

### 1.2 What the headline number is, and how it is computed

**The platform has no cost rate.** `bill_rates.rate_amount` is the rate charged *to the client*, proven by `apps/bill-api/src/services/invoice.service.ts:583` which resolves it straight into `unit_price` on an invoice line item. Grepping every `apps/*/src/db/schema/` for `cost_rate` or `internal_rate` returns nothing. So a naive `contract_value - sum(billing_rate x hours)` is contract consumption at list price, not margin. Burn owns the missing primitive (`burn_cost_rates`, Section 3.1) and refuses to mislabel when it is absent.

#### 1.2.1 Revenue is basis-aware (round-2 blocker R2-D1... see R2-D2)

`burn_engagements.envelope_basis` is `fixed | time_and_materials | retainer | not_to_exceed`, and **the margin formula branches on it.** Round 2 correctly found that an unbranched `sum(hours x bill_rate) - sum(hours x cost_rate)` measures, on a fixed-fee SOW, "the T&M invoice we did not send, minus cost", which moves the **wrong way**: delivering in half the budgeted hours shows LESS margin and overrunning shows MORE. That fires on the Gilligan seed's own flagship engagement (Howell Luau, fixed fee $18,000), so the demo would have shipped an inverted number.

| `envelope_basis` | `revenue_basis` | Margin |
| --- | --- | --- |
| `fixed`, `not_to_exceed` | `contract_value` | `chain_contract_value - attributed_cost`; pct over chain contract value; badged **`in_progress`** until the chain is `closed` or every deliverable is complete, because a partially delivered fixed fee has no final margin |
| `retainer` | `contract_value_per_period` | the same, **per period**, with period boundaries computed in `burn_engagements.timezone` |
| `time_and_materials` | `billable_recognized` | `attributed_billable - attributed_cost` |

`revenue_basis` is stored on `burn_engagement_rollups` alongside `metric_basis` and returned on every financial response.

#### 1.2.2 The basis discriminator is structural, not a convention (round-2 R2-D8)

`metric_basis` is `true_margin` when cost-rate coverage is non-zero and `contract_consumption` otherwise. Round 2 found the discriminator stopped at the rollup while the burn-down, engagement detail, the precheck envelope block, `burn_variances.amount`, and the change-order scope table all emitted money with no basis at all. Fixed three ways:

1. **Every response carrying a dollar or a derived percentage carries `metric_basis`, `revenue_basis`, `cost_rate_coverage_pct`, and `as_of`.**
2. The shared money block in `packages/shared/src/schemas/burn.ts` is a **Zod discriminated union on `metric_basis`**, so a response is not constructible without it. Under `contract_consumption` the value is carried as `contract_consumption_pct` and **there is no `margin` key at all**, which is what stops a model from reading a field that is not there.
3. **The MCP tool is `burn_financials`.** `burn_margin` survives only as a **deprecated alias** with the identical discriminated response. Round 2's argument is correct and I accept it: an agent that calls a tool literally named `burn_margin` and reports "margin" has mislabeled the number, and the sibling `metric_basis` key is exactly the field a model drops. A tool name is a claim.

**Account-level basis is the weakest member.** `/v1/financials/accounts` ranks chains; any `contract_consumption` chain in the group forces the whole row to `contract_consumption`, and the mixed state is surfaced explicitly rather than silently averaged.

**On exports:** Section 6.1 defines `GET /v1/financials/export` (CSV), which carries the same discriminated header row. The round-2 draft claimed an export commitment with no route backing it; the route now exists.

Consequent naming throughout: permissions are `burn.financials.*`; routes are `/v1/financials`; the variance kind is `consumption_erosion`; the landing screen is the **Portfolio Board**.

### 1.3 Who it is for

The owner, principal, or delivery lead at a services firm of 2 to 50 people: agency, consultancy, design shop, engineering contractor, bookkeeping practice. A horizontal buyer, not a vertical bet.

### 1.4 Burn is not Bulwark for SOWs, and the separation is structural

| | Bulwark | Burn |
| --- | --- | --- |
| Unit of work | a **clause with a date** | **every task, ticket, hour and expense the company logs** |
| Question asked | has this obligation's deadline triggered, and have we discharged it | which priced envelope does this belong to, or does it belong to any |
| Core mechanism | deterministic timezone-anchored deadline arithmetic over a finite extracted set | a **continuous classifier** over an unbounded, growing stream |
| Output | a blocked charge, a drafted change order, a consumption or margin figure | a drafted notice |
| Touches a timesheet | never | that is its input |
| Applies a rate | never, and structurally cannot | on every work item, and owns its own cost-rate table |
| Has an attribution model | no | that is the app |
| Tables | `bulwark_*` (9) | `burn_*` (14), disjoint |

They share only the extraction pass. Burn reuses the **pattern** at `apps/bulwark-api/src/services/extraction.service.ts` and the **client** at `apps/bulwark-api/src/lib/internal-llm.client.ts`. Extraction is roughly 15 percent of Burn by weight; the rest is attribution and the gate, neither of which exists in Bulwark.

### 1.5 How it sits next to the four apps it joins

- **Bin** (`apps/bin-api/`, `@bigbluebam/storage`) holds the contract bytes.
- **Bam** (`apps/api/`) holds the work: `tasks`, `phases`, `time_entries`.
- **Bill** (`apps/bill-api/`) holds the money: `bill_rates`, `bill_expenses`, `bill_line_items`, `bill_recurring_invoices`, `bill_clients` (which carries `bond_company_id` at `bill-clients.ts:29`). Burn is the pre-transaction gate in front of Bill's money-out paths and drafts Bill line items as proposals. It never issues an invoice.
- **Bond** (`apps/bond-api/`) holds the client, resolved through `braid_resolve`.

### 1.6 v1 scope

Objects: `engagement` (with **engagement and deliverable amendment chains**), `engagement_project` link, `deliverable`, `work_item`, `attribution`, `attribution_rule`, `precheck`, `variance`, `classifier_feedback`, `cost_rate`, `engagement_rollup`, `ingest_event`, `extraction_run`, `org_settings`.
Surfaces: Portfolio Board, unscoped queue (three buckets), deliverable burn-down, gate console, variance and change-order inbox, cost rates, rules, settings.
Flagship MCP tool: `burn_precheck(work_ref)`. Secondary: `burn_attribute(work_ref)`, `burn_financials(account)`.

Non-goals are Section 13.

---

## 2. AI-native design

Two distinct AI mechanisms with different failure modes, plus a gate that is **not** an AI decision at all.

1. **Deliverable extraction** (bounded, one-shot per document, always human-reviewed).
2. **Continuous attribution** (unbounded, per work item, forever). The core.

### 2.1 The two-plane split, and the two safety invariants

- **Semantic plane (LLM, best-effort, always reviewable).** Chooses *which deliverable* a work item belongs to, from a bounded candidate set. Never computes a dollar. Never issues a block.
- **Deterministic plane (reproducible, auditable).** Computes valuation, envelope consumption, the gate verdict, and every variance.

**Invariant 1 (verdict).** In blocking mode the **only** verdict that stops a write is `deny`, and a `deny` is a pure function of `(target_deliverable_id, effective_envelope, attributed_to_date, proposed_amount, org_settings)`. Low classifier confidence produces `needs_mapping`, which posts the charge with an inline note and a queue item and **never blocks**.

**Invariant 2 (latency), new in round 2 and load-bearing.** **The synchronous precheck path is deterministic-only and never calls the llm-provider.** Round 2 found that with `work_ref_id` null in the pre-transaction case there is no prior attribution to reuse, so reaching a 0.85-confidence target would require stage-two LLM adjudication inside an 800ms budget, which a provider round trip cannot meet. The realistic steady state would have been that every gated expense either burned the full budget and failed open or fell to `needs_mapping`: **the blocking gate would have been decorative.** Section 5.3 specifies the deterministic-only path, and Section 12.1 asserts **zero llm-provider calls** on it. This removes the last route by which classifier latency touches money, and makes the gate better rather than weaker: everything it can decide, it decides fast and reproducibly.

### 2.2 Autonomy bands

| Action | Autonomy | Gate |
| --- | --- | --- |
| Extract deliverables from a Bin asset | Autonomous (worker), best-effort | `burn-extract-deliverables`; Bin `can_access` preflight |
| Confirm / edit / reject a deliverable's **content** | HITL, permission + project-scoped | `burn.deliverable.write` |
| **Confirm an envelope** (the act that makes a deliverable a gate input) | **HITL only, owner/admin, never agent-reachable** | **`burn.envelope.confirm`**; see 2.2.1 |
| Author an attribution rule | HITL; **`non_billable` and broad-scope rules are owner/admin** | `burn.rule.write` |
| Apply a deterministic rule | Autonomous, `method='rule'`, before any LLM call | |
| Attribute at or above `auto_attribute_threshold` | Autonomous | reversible; never supersedes a human decision |
| Attribute between thresholds | Queued for a human, never guessed | `pending_review` |
| Run a precheck | Autonomous, synchronous, **deterministic-only**, circuit-broken | `burn.precheck.run` |
| **Block** a money-out event | Autonomous ONLY in `blocking` mode, ONLY on a deterministic `deny`, ONLY after the calibration gate is earned | Section 5 |
| Override a block | HITL, member tier, reason of record required | `burn.precheck.override` |
| Label a verdict **wrong** | HITL, **owner/admin** | `burn.precheck.mark_wrong` |
| Label a verdict right / would-have-mapped | HITL, member tier, own row only, **feeds nothing** | see 5.4 |
| Promote the gate to blocking | HITL, owner/admin, server-side calibration gate | `burn.settings.write` |
| Auto-demote to advisory | Autonomous, one-way toward safety | `burn-calibration-recompute` |
| Revalue work items after a rate change | Autonomous, **zero LLM cost**, never re-classifies | `burn-revalue` |
| Draft a change order or Bill line item | Autonomous draft, HITL to act | `agent_proposals` |
| Delete an engagement | HITL, destructive, owner/admin | confirm token |
| Weaken the gate (off / advisory / pause) | HITL, owner/admin | confirm token |

#### 2.2.1 Envelope confirmation is not agent-reachable (round-2 blocker R2-D4)

The entire S7 fix from round 1 is "every envelope, including a `stated` one, requires human confirmation before `is_active`". Round 2 found the tool surface contradicted it: `burn_confirm_deliverable` backed `PATCH /v1/deliverables/:id` at member-tier `burn.deliverable.write` with only `asker_user_id` and no confirm token. **`asker_user_id` is a visibility parameter, not an approval.** Once `burn.*` is allowlisted in `agent_policies`, an agent chain could extract a forged `stated_price` from an attacker-influenceable PDF and confirm it in the same run, manufacturing the one object that can produce an enforced deny. Three changes:

1. **`is_active` is set on exactly one route**, `POST /v1/deliverables/:id/confirm-envelope`, gated on the **new owner/admin `burn.envelope.confirm`** permission.
2. That route writes an `agent_proposals` row (`subject_type='burn.envelope_confirm'`, refs-only) when the caller is a service account, and flips `is_active` only on `proposal.decided`. A service-account token **cannot set `is_active` on any path**, asserted in Section 12.1.
3. `burn_confirm_deliverable` (the MCP tool) can edit content and set `review_status`, and **cannot touch the envelope or `is_active`**. The bulk fast path (2.2.2) confirms deliverables as **unpriced**, which is safe by construction.

#### 2.2.2 The bulk-confirm fast path is unpriced, not even-split (round-2 R2-D6, superseding the round-1 steer)

Round 1's Open Question 3 proposed a "confirm all with even split" fast path with even-split envelopes barred from enforcing. **Round 2 showed that is unsound in both directions and I accept the correction.** An even split of chain contract value across N deliverables is a number nobody asserted. Consumption against it produces `envelope_overrun` and `consumption_erosion` variances that are artifacts of the split, and in advisory mode produces advisory denies a user will correctly label `wrong_call`, which feed `min_deny_precision` and **systematically drive precision below 0.95, making promotion unreachable for exactly the orgs that used the fast path**. And the "barred from enforcing" mitigation is worse the other way: an org promoting to `blocking` on all-even-split envelopes gets a console reading `blocking` and a gate that structurally cannot deny anything.

The fast path therefore bulk-confirms with **`envelope_amount = NULL` and `envelope_source='unpriced'`**, which the model already handles correctly end to end: a null envelope tracks hours only, can never deny, and already returns `allow_with_note` (5.5). Unpriced deliverables are **excluded from `envelope_overrun` and `consumption_erosion`**, badged "Envelope unpriced" beside the existing "Envelope unconfirmed" state, and gate promotion carries a **`priced_deliverable_coverage_pct` floor** (5.4 precondition 7) so an org cannot promote a gate with nothing to enforce against.

**HITL boundary.** Direct insert into `agent_proposals` (`0128_agent_proposals.sql`) with `approver_id=NULL` (nullable at `:37`) and explicit `expires_at = now() + 7 days` (`:41`), rather than the public `POST /v1/proposals` which mandates an approver (`apps/api/src/routes/proposals.routes.ts:40`). Subject types `burn.change_order`, `burn.line_item`, `burn.envelope_confirm`. **`proposed_payload` is refs-only.**

### 2.3 The attribution model

#### 2.3.1 What a work item is, and the one priced hour source

**Round-2 blocker R2-D1: every logged hour was consuming the envelope twice.** `apps/api/src/routes/time-entry.routes.ts:35-42` increments `tasks.time_logged_minutes` by `data.minutes` on every time-entry insert (and bumps `tasks.updated_at` in the same statement). The round-2 draft valued `bam.time_entry` at `minutes x rate` **and** `bam.task` at `time_logged_minutes` delta x rate, and put `time_logged_minutes` in the task epoch. One logged hour therefore produced a priced time-entry work item **and** a new priced task epoch. Attributed billable, consumption pct, margin, the burn-down, and `envelope_would_exceed` were all inflated roughly 2x on the primary source, and in blocking mode the gate would deny real charges at half the true burn.

**One precedence, stated once and enforced everywhere:**

| `source_type` | Source | Valuation |
| --- | --- | --- |
| `bam.time_entry` | `time_entries` (`apps/api/src/db/schema/time-entries.ts`) | **the sole priced hour source**: `minutes` x resolved rates |
| `bam.task` | `tasks` (`tasks.ts`) | **`valuation_basis='none'`, always.** Ingested for classification signal only. `time_logged_minutes` is **not** an epoch input and **not** a valuation input |
| `helpdesk.ticket` | helpdesk tickets | `none` |
| `banter.thread` | banter messages, opt-in | `none` (signal only) |
| `bill.expense` | `bill_expenses` (`bill-expenses.ts`) | conditional, see 2.3.1.1 |
| `bill.recurring` | `bill_recurring_invoices` | generated invoice total |
| `vcs.commit` | `github_integrations`, opt-in | `none` |

Dropping `time_logged_minutes` from the task epoch also removes a large churn class, since it changes on every time-entry insert. There is **no per-org `hour_source` alternative** in v1: two mutually exclusive priced paths is exactly the kind of configuration that produces a 2x number in the field, and an org not using `time_entries` simply has no priced hours, which the queue-health surface reports honestly.

##### 2.3.1.1 Expense valuation is conditional on `billable` and `status` (round-2 blocker R2-D5)

Verified in `apps/bill-api/src/db/schema/bill-expenses.ts`: `status: varchar('status', { length: 20 }).notNull().default('pending')` at `:38` and `billable: boolean('billable').notNull().default(false)` at `:40`. The round-2 draft valued `bill.expense` at `amount` unconditionally, so **by default every expense including internal costs was booked as `billable_amount` against a client envelope**, and a rejected expense was neither deleted nor epoch-changed so the anti-join never reversed it. The gate would deny real charges against consumption that was never chargeable.

- `billable = true` -> the amount is `billable_amount` and consumes the envelope.
- `billable = false` -> the amount is **`cost_amount` only**. It is a real cost against margin and is **not** envelope consumption.
- `status IN ('rejected','void')` -> `attribution_state='excluded'`, `exclusion_reason='source_voided'`, dollars reversed in the same transaction.
- Both `billable` and `status` are epoch inputs (2.3.2), so a flip of either is observed.

##### 2.3.1.2 Rate resolution is delegated, and its failure mode is specified (round-1 D2, round-2 R2-I5)

`apps/bill-api/src/services/rate.service.ts:117` documents and implements **`user+project > user > project > org`** with an **inclusive** `effective_to` (`or(isNull(effective_to), gte(effective_to, date))`). Burn does not restate it. This build adds **`POST /internal/rates/resolve`** to bill-api (guarded by `INTERNAL_SERVICE_SECRET`) delegating to the existing `resolveRate`, and a **parity test** asserts Burn's own `burn_cost_rates` resolver mirrors that four-branch order and inclusive bound.

**The reverse leg has a failure mode.** During a bill-api rolling restart, a rollback to a build without the route (404), or with `BILL_API_INTERNAL_URL` unset, rate resolution fails. **The dangerous default is null**, because it understates consumption, makes the board look healthier than reality, and makes the gate **under-block**, which is the direction the buyer cannot detect. Therefore: a rate-resolve failure marks the item `valuation_basis='unrated'` with `unrated_reason='rate_service_unavailable'`, **excludes it from every envelope and every rollup** (never values it at zero), surfaces it in queue health as "N items awaiting valuation", and is retried by the next reconcile pass and by `burn-revalue`. `BILL_API_INTERNAL_URL` is **required** on burn-api with a matching computed env hint (9.6).

**Currency.** Minor units throughout, one currency per engagement chain; mismatches flagged and excluded, never converted.

#### 2.3.2 Source observation: two epochs, three passes, monotonic identity

This subsection resolves round-1 T2/T3/D6 and round-2 R2-T2/T3/T4/T8 as one coherent design. Read it whole.

**A. Two content epochs, not one (round-2 R2-T8).** Round 1 collapsed everything into a single `source_epoch`, which meant a typo fix in a description tombstoned the work item, created a new one with no attributions, and re-classified from scratch, **destroying a human's confirmed decision and re-spending LLM budget**. That is precisely what the human-precedence invariant existed to prevent, arriving through a different door. Split:

| Hash | Inputs | Change triggers |
| --- | --- | --- |
| `classification_epoch` | fields that could change *which deliverable this is*: normalized title, normalized description, `project_id` | re-classification (subject to the invariant in 2.3.10) |
| `cost_epoch` | fields that could change *what it costs*: `minutes`, `amount`, `currency`, `billable`, `status`, `expense_date` | **revaluation only**, never re-classification |

`source_epoch` remains as the stored concatenation for the observation key. **`updated_at` is NEVER an input to either hash for any source type**, because `tasks.updated_at` bumps on board position, phase, assignee, and every time-entry insert.

Per-source inputs, each over columns that provably exist:

| `source_type` | `classification_epoch` | `cost_epoch` |
| --- | --- | --- |
| `bam.task` | `normalize(title)`, `normalize(coalesce(description_plain,''))`, `project_id` | (none; `valuation_basis='none'`) |
| `bam.time_entry` | `task_id`, `normalize(coalesce(description,''))` | `minutes`, `date`, **`user_id`** |
| `bill.expense` | `project_id`, `normalize(description)`, `coalesce(vendor,'')` | `amount`, `currency`, `expense_date`, **`billable`**, **`status`** |
| `bill.recurring` | recurring id | generated invoice id + total |
| `helpdesk.ticket` | `normalize(subject)` | `status` |
| `banter.thread` / `vcs.commit` | message or commit id | (none) |

An unchanged pair short-circuits **before candidate assembly and before any llm-provider call**: one index probe.

**B. Valuation freshness is separate from observation identity (round-2 blocker R2-T2).** Round 2 found that neither epoch hashes any rate-determining input beyond the source row, so **the moment an org populated `burn_cost_rates`, every already-observed work item would keep `cost_amount = null` forever** and the Portfolio Board would never flip to `true_margin`. Playwright story 2 asserts exactly that flip; under the round-2 design it never happens. Fix: `burn_work_items` carries **`valuation_epoch`** (a hash of resolved `bill_rate_id`, `burn_cost_rate_id`, `user_id`, and the two rate rows' `updated_at`) and **`valued_at`**. A **`burn-revalue`** pass, triggered on any `burn_cost_rates` write and on observed `bill_rates` changes, re-resolves rates and rewrites amounts **in place**, with **zero LLM cost**. Revaluation **never supersedes an attribution and never re-classifies.** `user_id` is now a `cost_epoch` input (it exists at `apps/api/src/db/schema/time-entries.ts:12` and is the primary cost-rate axis).

**C. Three reconcile passes, all anchored on ingest time (round-2 blocker R2-T3).** Round 1 anchored pass 1 on `created_at` precisely because a business-date watermark permanently misses backdated timesheets, then anchored passes 2 and 3 on `occurred_at`, which is business time. **A timesheet entered today for work done 120 days ago was ingested by pass 1 and landed outside the window on the same sweep**: never re-hashed, never anti-joined, its dollars consuming forever. The class pass 1 exists to catch was the class passes 2 and 3 structurally excluded. And `bam.task` has no business-time column at all, so its `occurred_at` was undefined.

- **Pass 1, new rows.** Watermark on source `created_at`, with a per-`source_type` high-water mark in `burn_org_settings.last_source_watermark`.
- **Pass 2, edits.** Re-read and re-hash every work item whose **`reconcile_until`** is in the future. `reconcile_until` is a stored column set at ingest to `ingested_at + reconcile_window_days`, with its own index, so windowing is on **ingest time** and a backdated entry gets its full window.
- **Pass 3, deletes.** Anti-join over the same `reconcile_until` set; vanished rows become `excluded` / `source_deleted` with dollars reversed. `apps/bill-api/src/routes/expenses.routes.ts` exposes `PATCH /:id` and `DELETE /:id`, and neither the event path nor a watermark scan can observe an absence.

**Per-`source_type` `occurred_at` mapping**, published so it is not left to inference: `bam.time_entry` -> `date`; `bill.expense` -> `expense_date`; `bill.recurring` -> generated invoice issue date; `helpdesk.ticket` -> ticket `created_at`; `bam.task` / `banter.thread` / `vcs.commit` -> **`ingested_at`** (no business-time column exists).

A `variance_kind='phantom_consumption'` fires when reversals in one sweep exceed a threshold.

**D. The observation key is monotonic, so a reverted edit cannot collide (round-2 blocker R2-T4).** Round 2 found that minutes 60 -> 90 -> 60, or a typo fixed then reverted, produces a third hash equal to the first, hitting `UNIQUE (organization_id, source_type, source_id, source_epoch)` on a row already tombstoned with dollars reversed. Either an unhandled 23505 aborts the sweep transaction for that org, or `ON CONFLICT DO NOTHING` silently leaves it excluded forever and the envelope permanently undercounts. Neither was stated and neither is acceptable. **The four-column index is replaced by a live-row constraint:**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_work_items_live
  ON burn_work_items (organization_id, source_type, source_id)
  WHERE attribution_state <> 'excluded';
```

`source_epoch`, `classification_epoch`, and `cost_epoch` are **plain compared columns**, not part of any unique key. Pass 2 is therefore "read the live row, compare hashes; if changed, supersede it and insert a new live row in one transaction", with **no tombstone collision possible in any ordering**. Section 12.1 tests the revert case explicitly.

**E. Index path.** The sweep drives from `burn_engagement_projects -> tasks.project_id` (existing `tasks_project_id_idx`) then `time_entries.task_id` (existing `time_entries_task_id_idx` at `time-entries.ts:22`), bounded by `reconcile_until`. **The "no new platform indexes required" claim covers only the two Bam sources.** `bill_expenses` has indexes on `organization_id`, `project_id`, and `status` only (`bill-expenses.ts:50-52`) and **no `created_at` index**, so migration `0241` adds `CREATE INDEX IF NOT EXISTS idx_bill_expenses_created_at ON bill_expenses (organization_id, created_at)`. That is a Burn-owned additive index on another app's table, called out rather than assumed.

#### 2.3.3 Stage zero: deterministic rules, with guardrails

Org-authored rules in `burn_attribution_rules` evaluate in priority order before any retrieval or LLM call, matching on project, phase, label, client, title pattern, expense category, or source type, with an outcome of either a target deliverable or a **non-billable exclusion**. `method='rule'`, zero LLM budget, fully explainable.

**Rules are a gate-neutralization vector and are constrained accordingly (round-2 blocker R2-S4a).** A rule with `priority: 1`, an empty `match`, and `outcome_kind: 'non_billable'` matches every work item org-wide at stage zero: everything becomes `excluded_non_billable`, consumption goes to zero, no `deny` can ever fire, and there is no `gate_demoted_at`, no notification, and no banner. Strictly more powerful than the round-1 S3 attack and it needed no admin. Four constraints:

1. **A rule whose `match` has no discriminating key is rejected**, by both a Zod refinement and a DB `CHECK` on the JSONB.
2. **`burn.rule.write` is a distinct owner/admin permission.** Rule authoring is no longer folded into member-tier `burn.attribution.write`.
3. **`match_ceiling_pct`** (default 40): a rule that would match more than this fraction of the trailing window is rejected at write time, and a rule that begins matching more than this fraction later raises a `rule_overreach` variance.
4. **`title_pattern` is glob or substring, never a raw regex.** Round 2 is correct that the round-2 draft's "compiled with a timeout" mitigation **does not exist**: Node's `RegExp` has no timeout, so a member-authored ReDoS pattern would stall the shared worker. The false claim is deleted. If regex is ever needed it requires RE2, which is not in the tree today.

#### 2.3.4 Stage one: bounded candidate retrieval

At most `candidate_k` (default 8) deliverables across **all engagements linked to the work item's project** through `burn_engagement_projects`, from four deterministic signals: **structural** (project to chain), **precedent** (prior confirmed attributions on the same task, parent, epic, sprint, labels), **link graph** (`entity_links`), and **lexical** (Postgres FTS plus trigram; `pg_trgm` is installed at `infra/postgres/migrations/0000_init.sql:22`).

**On Qdrant.** `apps/beacon-api/src/services/embedding.service.ts:17` returns **zero vectors of dimension 1024** with a "replace with actual embedding API call" comment, and `apps/brief-api/src/services/embedding.service.ts` defers model selection to a worker that selects none. There is no working embedding provider in the tree. **Lexical retrieval is the shipped path.** The Qdrant path sits behind `burn_org_settings.embedding_enabled` (default **false**), with reserved `qdrant_point_id` / `qdrant_synced_at` columns mirroring `apps/braid-api/src/db/schema/braid-profiles.ts:46-47`. Open Question 1.

#### 2.3.5 Stage two: bounded LLM adjudication (batch path only)

**Stage two runs only in `burn-attribute-batch`, never on the synchronous gate path (Invariant 2).** The candidate set plus snapshotted text goes to `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`) through a ported client shaped like `apps/bulwark-api/src/lib/internal-llm.client.ts`. Rules enforced in code: untrusted text fenced as DATA; the model must return **an id from the supplied candidate set or the literal `unscoped`**, anything else dropping to `pending_review`; Zod-validated; the model cannot emit a dollar, rate, envelope, or verdict; bounded by `AbortController`; a timeout yields `pending_review`, not `unscoped`; a 429 from the LLM concurrency cap (9.7) yields `pending_attribution`, never `unscoped`.

#### 2.3.6 Confidence bands

| Band | Default | State | Envelope |
| --- | --- | --- | --- |
| `>= auto_attribute_threshold` | 0.90 | `auto_attributed` | counts |
| `>= review_threshold` | 0.60 | `pending_review` | does **not** count |
| `< review_threshold` | | `unscoped` / `low_confidence` | does not count |
| model returned `unscoped` | any | `unscoped` / `no_matching_deliverable` | does not count |

Thresholds are per-org, clamped by DB `CHECK`: `auto_attribute_threshold` in [0.75, 0.99], `review_threshold` in [0.30, `auto_attribute_threshold` - 0.05].

#### 2.3.7 Non-billable is a first-class state

`excluded_non_billable` with a typed reason (`internal`, `pre_sales`, `pto`, `warranty`, `overhead`, `rework`), one keystroke from the queue, writing `burn_classifier_feedback` with `decision_kind='mark_non_billable'`.

#### 2.3.8 Three queue buckets, and one honest statement about the envelope (round-2 R2-D7)

Round 2 found the round-2 draft insisted `no_matching_deliverable` and `low_confidence` were "structurally distinct and never merged" and then rendered both under a single "$X of unbilled work" header, while `aged_out`, `restatement_unmatched`, `no_active_engagement`, and `outside_engagement_window` had no tab and no stated contribution at all. Either the scope-creep number was inflated with unreviewed items or dollars hid in a bucket with no surface. Three named buckets, three figures, never summed into one headline:

| Bucket | Members | Headline |
| --- | --- | --- |
| **Sold by nobody** | `no_matching_deliverable` | **"$X of work nobody sold"** |
| **Unclassified** | `low_confidence`, `aged_out` (own tab) | "$Y unclassified" |
| **Outside any tracked contract** | `no_active_engagement`, `outside_engagement_window`, `restatement_unmatched` | "$Z outside any tracked contract" |

**And the conservative-by-construction statement, said plainly on the surface rather than buried:** neither `pending_review` nor **any** `unscoped` dollars ever count toward an envelope, so **the burn-down and the gate are always conservative**. Round 1's claim that aging out makes dollars "re-enter the reported total" was true only of the unscoped total; envelope consumption, the burn-down, and the gate remain understated either way. `GET /v1/queue-health` surfaces exactly this: the three bucket figures, the `pending_review` figure, the "awaiting valuation" figure, inflow versus resolution rate, and oldest item age, with the sentence "these dollars are not in any envelope."

Stale `pending_review` older than `pending_review_max_age_days` (default 14) demotes to `unscoped` / `aged_out`, which moves it from an invisible bucket to a visible one. Clustering by task tree and normalized title signature lets one decision close a group. Rules (2.3.3) cut inflow at the source.

#### 2.3.9 Tuning: the org's private vocabulary

Every human decision writes `burn_classifier_feedback`, which becomes a retrieval exemplar, a few-shot example (top `exemplar_k`, default 6, fenced as DATA), and a labeled calibration sample. **Explicitly not fine-tuning:** no per-org training, no weight update, no gradient. `vocabulary_version` increments on every feedback write.

#### 2.3.10 Human precedence at the source-record grain (round-2 R2-T8)

Reclassification supersedes rather than mutates, in one transaction with `SELECT ... FOR UPDATE` on the live row.

**The invariant is stated at the source-record grain, not the work-item grain:** *on a `classification_epoch` change, the new live work item **inherits** the prior live attribution when that attribution is `confirmed` or `method='human'`, carried forward with `method='human'`, revalued but **not** re-classified, and flagged for review only if a human explicitly requests it.* On a `cost_epoch`-only change there is no new classification decision at all: the row is revalued in place. Round 1's invariant was scoped to `work_item_id`, and since pass 2 inserts a **new** work item, the new row had no attributions and the invariant simply did not apply, so a typo fix silently discarded a human's decision and re-spent LLM budget.

The engine also never supersedes a `confirmed` / `method='human'` attribution on a live row; it may only raise a `pending_review` proposal alongside it.

Concurrent triage returns **409 with current state**, never a raw 23505. `POST /v1/attributions/bulk` returns per-item `{ applied, conflicted, failed }`.

### 2.4 Security model

1. **Permission enforcement is not optional for Burn (round-2 blocker R2-S1).** `docker-compose.yml` sets `BBB_PERMISSIONS_ENFORCE: ${BBB_PERMISSIONS_ENFORCE:-warn}` on every service (`:125`, `:204`, `:469`, and so on), and `packages/permissions/src/index.ts:291` is literally `if (opts.mode === 'warn') return;` with the in-process variant doing the same around `:137`. Existing apps survive because `requireCan` sits behind a legacy `requireAuth` plus role gate. **Burn has no legacy gate**: `burn.costrate.read`, `burn.financials.read_all`, `burn.precheck.mark_wrong`, and `burn.settings.write` are the only thing between a member and per-person compensation, firm-wide profitability, and the gate switch. Worse, even at `mode: 'on'` the resolver returns `'unknown'` on any non-2xx (`:259` and the catch at `:264-267`) and the gate denies only on an explicit `'deny'`, so an apps/api blip opens every floor.
   - **burn-api sets `BBB_PERMISSIONS_ENFORCE=on` unconditionally in compose and services.mjs and REFUSES TO BOOT if the resolved value is anything else.** Not a default; a boot assertion.
   - **A second, independent in-route guard** on `/v1/cost-rates`, `/v1/financials/accounts`, `/v1/financials/export`, `POST /v1/prechecks/:id/label`, and `PATCH /v1/settings` checks the org role **directly off `request.user`**, so a resolver outage cannot open them.
   - Tests assert 403 with the resolver stubbed non-2xx, and assert boot failure when the mode is not `on`. The platform-wide posture question is tracked separately and is not Burn's to solve.
2. **Financial flooring lives in one serializer, not on routes (round-2 blocker R2-S3).** Round 1 applied dollar flooring to `/v1/work-items` alone; `burn_attributions` carries its own `billable_amount` / `cost_amount` and `/v1/attributions` and `/v1/unscoped` had no annotation, so the same join ran. And the disclosure is not aggregate: for a single `bam.time_entry` row, `cost_amount / (minutes / 60)` **is that person's hourly cost rate to the cent**, which is the exact content of `burn_cost_rates` that Section 13 promises never to expose. One row sufficed.
   **`redactFinancialFields(row, viewerCaps)` is a single shared serializer** applied to every response containing a work-item or attribution projection: `/v1/work-items`, `/v1/attributions`, `/v1/unscoped`, `/v1/queue-health`, `/v1/change-orders/:id`, `burn_variances.detail`, every MCP payload, and the CSV export. Section 12.1 enumerates every member-reachable route and asserts the join fails on each.
3. **No floored quantity is emitted twice in different units, including `overage_amount` (round-2 blocker R2-S2).** The caller supplies `proposed_amount` and the round-2 draft returned an unfloored `overage_amount`, so `envelope_remaining = proposed_amount - overage_amount` in one subtraction. Sharper: a deliverable with zero consumption has `remaining == envelope_amount`, so probing each deliverable shortly after confirmation recovers `contract_value` **exactly**. Round 1's justification ("discloses nothing the caller could not compute") was false, and an implementer meeting the "no absolute recovery" test honestly would have had to weaken the test.
   - A deny to a non-`read_all` caller returns `verdict_reason`, a consumption **band**, and a **quantized** overage rounded up to `overage_bucket_amount` (default 10000 minor units, configurable), never an exact figure.
   - Repeated member prechecks against the same deliverable are rate-limited and write an audit row.
   - The Section 12.1 test probes a **newly confirmed deliverable specifically**, which is the exact case that made exact recovery possible.
4. **`can_access` preflight on every cited source record**, fail-closed on non-2xx, timeout, or missing secret, with denied items dropped and reported as "N hidden by permissions". New `SUPPORTED_ENTITY_TYPES` entries `burn.engagement` and `burn.deliverable` (added to `apps/api/src/services/visibility.service.ts:107`, following the Bulwark precedent at `:139-142`).
5. **Extracted clause text does not launder into member-readable fields (round-2 R2-S9).** The only access check was `preflightAccess(created_by, 'bin.asset', ...)`, the registrant's own visibility, and Bin's `visibility='private'` is owner-only with no org-admin bypass. Extraction writes LLM-produced `title` and `description` derived from clause text into `burn_deliverables`, served to any project member; flooring `cited_span.quote` and stopping left `description`, the same content one paraphrase removed, reaching an audience that could not open the document.
   - **`description` is floored to `burn.financials.read_all` alongside `quote`.** `title` remains the member-visible handle.
   - The source asset is **re-preflighted per reader**, not just per registrant, and deliverables whose asset the reader cannot access are dropped with a hidden count, exactly as point 4 does for cited source records.
6. **Burn's project predicate is a distinct implementation, not a port (round-2 R2-S6).** `apps/bulwark-api/src/lib/project-scope.ts` operates on a single nullable `project_id` column and its documented SK3 fallback is that a NULL project passes for **every org member**. Burn engagements have no `project_id` column, so ported literally the `unlinked` state that Section 3.1 defines as `read_all`-only would become org-wide readable, inverting the D4 fix.
   ```sql
   EXISTS (SELECT 1 FROM burn_engagement_projects ep
           JOIN project_memberships pm ON pm.project_id = ep.project_id
           WHERE ep.engagement_id = :engagement AND pm.user_id = :viewer)
   ```
   **No null or empty fallback**, so a zero-project chain is `read_all`-only by construction. And **work-item and attribution rows are scoped by the row's own `project_id`, not by chain reachability**: a member of the low-sensitivity project in a multi-project chain must not read items sourced from the project they are not in, which the Gilligan seed exercises deliberately. The parity test against `visibility.service.ts:203` (where `isProjectMember` is defined and is **not exported**) covers the single-project case only.
7. **Idempotency keys are server-derived, namespaced, and time-bounded.** `hmac(INTERNAL_SERVICE_SECRET, caller_namespace || work_ref_type || work_ref_id || proposed_amount || currency || attempt_nonce)`, prefixed `svc:` or `usr:` and enforced by a `CHECK`. On a hit, `proposed_amount`, `currency`, and `work_ref_type` are re-validated; `valid_until` (default 5 minutes) bounds replay. Recompute is **supersede-then-insert** (3.1, per round-2 R2-T7).
8. **Member-reachable paths cannot neutralize the gate.** Three vectors, all closed: rules (2.3.3), the `gate_wrong` label (2.4 point 9), and synthetic prechecks (2.4 point 10).
9. **The demotion signal is owner/admin, and split by value (round-2 R2-S7).** Round 1 moved `gate_wrong` to owner/admin. Round 2 found the round-2 draft then rendered the advisory-feedback control **inline on the note the member expense creator sees** while gating its write route on that owner/admin permission: every member who clicked got a 403, and an implementer fixing that UX bug would open the route to member tier, silently evaporating the S3 fix through a change nobody flags as security. **Split by value:**
   - `right_call` and `would_have_mapped` are **member-writable**, on a non-enforced row the caller themselves triggered, and **feed nothing** (they are UX signal and queue routing only).
   - `wrong_call` and `gate_wrong` require **`burn.precheck.mark_wrong`** and are the **only** values in the demotion numerator and the precision sample.
   - The inline member control renders exactly two options plus "flag for review", which enqueues without labeling.
10. **`POST /v1/precheck` cannot manufacture a calibration sample (round-2 R2-S8).** Precondition 1 counted "precheck rows" with no namespace restriction, so a member could script 200 `work_ref_type: 'manual'` rows in seconds and satisfy the volume gate on a synthetic sample. Also unbounded member-writable inserts into a partly never-purgeable table.
    - **Only `svc:`-namespaced rows count** toward `min_advisory_decisions` and `min_labeled_denies`.
    - A per-user rate limit and a per-org daily ceiling on `usr:` rows.
    - A `usr:` precheck must resolve `work_ref_id` to a real record, or the row is marked `non_calibrating`.
    - Because the gate path is deterministic-only (Invariant 2), a precheck is no longer an LLM amplifier at all.
11. **Cross-app writes use the platform's real dual-read pattern, not impersonation (round-2 R2-S5).** Round 1's accepted fix, "call bill-api as the decider with the decider's own credentials", **has no implementation path**: it executes in a `proposal.decided` subscription where there is no session, cookie, or API key, and the only impersonation mechanism in the tree is `X-Impersonate-User` at `apps/api/src/plugins/auth.ts:287`, which is SuperUser-only, apps/api-only, and refuses to chain. Faced with an unimplementable instruction an implementer would either silently revert to internal-secret-plus-asserted-user or invent a trusted `X-Acting-User` header, creating a general cross-service impersonation primitive with no session binding, no audit, and no scoping. The real pattern, from `apps/bulwark-api/src/subscriptions/proposal-decided.ts`:
    1. `POST /internal/permissions/dual-read` for the decider against the **named** identifier **`bill.invoice.update`** (the permission bill-api requires for the line-item write), fail closed on non-2xx.
    2. `POST /v1/agent-policies/<decider_id>/check` for the kill switch.
    3. Write through bill-api's internal path carrying **`acting_user_id` in the body** with the internal secret.
    4. bill-api records `acting_user_id` on the row and publishes it in the Bolt event.
    **No trusted acting-user header is introduced.**
12. **`llm_provider_id` org ownership is validated on write.** `apps/api/src/routes/internal-llm.routes.ts:117-126` resolves a provider by `id` and `enabled` only, **with no org predicate**, so a Burn org admin who learned another org's provider id would get that tenant's decrypted key used on their behalf. Burn validates ownership at `PATCH /v1/settings` regardless. Platform gap tracked separately.
13. **Bolt payloads carry no magnitudes.** Bolt is org-level with no per-rule visibility (`preflightBoltRule`, `visibility.service.ts:1131-1150`, gates on org match alone). Payloads carry refs plus a coarse band. `burn.*` outbound-webhook subscriptions require org-admin authorship.
14. **RLS binds per request, and every org-less path is specified (round-2 R2-I6).** All four existing plugins (`apps/api/src/plugins/rls.ts:38`, basis `:29`, braid `:30`, bulwark `:30`) issue `SELECT set_config('app.current_org_id', $1, true)` as a standalone `db.execute` on a pooled connection; the third argument is `is_local`, so a standalone statement is its own implicit transaction and the GUC is discarded on return. Burn **does not copy this**: it binds each request's queries into one transaction with `set_config(..., true)` inside it.
    **Round 2 found the claim reaper introduced a new hole:** under `BBB_RLS_ENFORCE=1`, a global scan on `(status, claimed_at)` with no GUC set returns **zero rows**, so expired claims are never released and `burn-attribute-batch` permanently stops draining for any org whose worker died mid-claim. Therefore:
    - **Internal routes** (`/v1/internal/events`, `/v1/internal/precheck`, `/v1/internal/prechecks/:id/outcome`) derive the org from the **validated payload** and set the GUC in the same transaction.
    - **`burn-claim-reaper`, `burn-retention`, and `burn-calibration-recompute` iterate orgs**, taking the per-org lock and setting the GUC per org, rather than one global scan. This also produces the flushed per-org progress logging Section 4.3 commits to.
    - The mandatory RLS test covers the reaper and one internal route.
15. **Document parsing is bounded and inert.** `MAX_DOC_BYTES` (25 MB), `MAX_DOC_PAGES` (300), a wall-clock parse cap, and a parser with **JavaScript execution and external-entity resolution disabled**. A breach records `rejected_limits` and extracts nothing partial.
16. **`/v1/internal/*` fails CLOSED on an empty secret**, rejecting 401 before any timing-safe compare. Deliberately stronger than `apps/api/src/routes/internal-llm.routes.ts:64`. Do not "align" it downward.
17. **Small-team aggregates are suppressed, not banded (round-2 R2-S10).** Aggregation protects only above a contributor count of one: a retainer chain worked solely by one person makes `attributed_cost` that person's cost, and `cost_rate_coverage_pct` independently discloses which individuals have a rate configured. For a non-`read_all` caller, when a chain's **distinct contributor count is below `min_contributors_for_cost_aggregate` (default 3)**, the fields `attributed_cost`, `margin_amount`, `margin_pct`, and `cost_rate_coverage_pct` are **suppressed entirely, not banded**; the response carries `metric_basis`, `revenue_basis`, and the consumption band only, with `suppressed_reason='insufficient_contributors'`.

### 2.5 Guardrails summary

- **agent_policies**: every `burn.*` service-account call passes the kill switch plus `matchesAllowlist('burn.*')` in `apps/mcp-server/src/lib/register-tool.ts`. Fails closed until allowlisted.
- **confirm_action** (`apps/mcp-server/src/lib/confirm-token-store.ts`): `burn_delete_engagement`, `burn_reject_deliverable`, and `burn_set_gate_mode` **when the target weakens enforcement**. Envelope confirmation is not agent-reachable at all (2.2.1).
- **Rate caps**: `attribution_llm_daily_cap` (2000) per org; a breach queues `pending_attribution`, never `unscoped`.
- **can_access preflight** on every surfaced source record, per reader.

---

## 3. Data model

**14 tables**, all org-scoped with RLS policies gated on `app.current_org_id` (2.4 point 14). Drizzle modules under `apps/burn-api/src/db/schema/`:

`burn-engagements.ts`, `burn-engagement-projects.ts`, `burn-deliverables.ts`, `burn-work-items.ts`, `burn-attributions.ts`, `burn-attribution-rules.ts`, `burn-prechecks.ts`, `burn-variances.ts`, `burn-classifier-feedback.ts`, `burn-cost-rates.ts`, `burn-engagement-rollups.ts`, `burn-ingest-events.ts`, `burn-extraction-runs.ts`, `burn-org-settings.ts`, plus **`agent-proposals.ts`** and **`entity-links.ts`** (Burn writes to both; `apps/bulwark-api/src/db/schema/` ships both), `bbb-refs.ts`, and `index.ts`.

**Every column created in SQL must be declared in Drizzle.** `scripts/db-check.mjs:454` treats a DB column absent from every Drizzle declaration as `UNKNOWN COLUMN in DB` and **exits 1** at `:486` (only type mismatches warn, at `:468`), failing `db-drift.yml:75`.

**The tsvector idiom, named (round-2 R2-B8d).** Drizzle has no first-class tsvector kind. The platform's answer is `customType<{ data: string }>({ dataType() { return 'tsvector'; } })`, at `apps/braid-api/src/db/schema/braid-profiles.ts:15-18` (whose own comment notes it mirrors the helpdesk `tickets.ts`). Burn declares both `search_tsv` columns with that exact idiom. Without naming it an implementer reaches for `text()`, which `db-check.mjs:468` downgrades to a non-fatal warning and therefore never catches.

**Join boundary.** Burn uses `organization_id`; some platform tables use `org_id` (`tasks.org_id:30`). No cross-schema FKs to source-app tables. FKs to `organizations`, `users`, `projects` are real.

### 3.1 Tables

**`burn_engagements`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `title` | varchar(512) NOT NULL | |
| `engagement_kind` | varchar(32) NOT NULL DEFAULT `'sow'` | `sow` \| `proposal` \| `engagement_letter` \| `msa` \| `retainer` \| `amendment` \| `change_order` \| `other` |
| `amends_engagement_id` | uuid | self-FK (guarded `DO $$`) ON DELETE RESTRICT. Adds to a live engagement |
| `supersedes_engagement_id` | uuid | self-FK ON DELETE RESTRICT. Genuine **restatement** only |
| `chain_root_id` | uuid NOT NULL | denormalized chain root. **All envelope math, rollups, financials, and gate evaluation resolve over it** |
| `contract_value` | bigint | minor units. `read_all`-floored |
| `contract_value_delta` | bigint | for an amendment; chain value is `sum(coalesce(contract_value_delta, contract_value))` |
| `currency` | varchar(3) NOT NULL DEFAULT `'USD'` | one per chain, enforced on insert |
| `envelope_basis` | varchar(16) NOT NULL DEFAULT `'fixed'` | `fixed` \| `time_and_materials` \| `retainer` \| `not_to_exceed`. **Drives `revenue_basis` (1.2.1)** |
| `period_length_days` | integer | required when `envelope_basis='retainer'` |
| `budget_hours` | numeric(10,2) | |
| `bin_asset_id` | uuid | nullable (manual entry) |
| `account_type` / `account_id` | varchar(32) / uuid | typically `bond.company` |
| `braid_profile_id` | uuid | golden id; null degrades to `account_id` |
| `bill_client_id` | uuid | `bill_clients.id` |
| `start_date` / `end_date` | date | |
| `timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA; retainer period boundaries |
| `status` | varchar(16) NOT NULL DEFAULT `'active'` | `draft` \| `extracting` \| `active` \| `superseded` \| `closed` |
| `extraction_status` | varchar(16) NOT NULL DEFAULT `'pending'` | `pending` \| `running` \| `extracted` \| `partial` \| `failed` \| `rejected_limits` \| `not_applicable` |
| `source_doc_hash` | varchar(64) | |
| `extracted_at` | timestamptz | |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, status)`, `(organization_id, chain_root_id)`, `(organization_id, account_type, account_id)`, `(organization_id, braid_profile_id)`, `(organization_id, bin_asset_id)`, `(amends_engagement_id)`, `(supersedes_engagement_id)`.

**Chain semantics.** **Amend** (`amends_engagement_id`): base stays `active`, its deliverables stay `is_active`, the amendment contributes `contract_value_delta` and its own deliverables, both share `chain_root_id`, and the burn-down shows a dated step up. **Restate** (`supersedes_engagement_id`): base becomes `superseded` and attributions migrate by matching `dedup_key`; unmatched attributions become `pending_review` / `restatement_unmatched` and are **never silently dropped**. Gate and rollup resolution is always the chain root.

**`burn_engagement_projects`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `engagement_id` | uuid NOT NULL | FK `burn_engagements(id)` CASCADE |
| `project_id` | uuid NOT NULL | FK `projects(id)` **CASCADE** |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, engagement_id, project_id)`, `(organization_id, project_id)`, `(engagement_id)`.

A chain with **zero** linked projects is a defined, tested state: **visible only to `burn.financials.read_all`** (enforced by the no-fallback predicate in 2.4 point 6), flagged `unlinked` on the board, and **incapable of producing a deny**.

**`burn_deliverables`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `engagement_id` | uuid NOT NULL | FK CASCADE |
| `dedup_key` | varchar(64) NOT NULL | `hash(normalized_clause_ref, deliverable_kind, ordinal)` by ascending `cited_span.char_start`; for null-section items `hash(verified_quote_content, kind)` tied to `source_doc_hash`. LLM prose is never in the identity hash |
| `clause_ref` | varchar(64) | evidence only |
| `title` | varchar(512) NOT NULL | member-visible handle |
| `description` | text | **`burn.financials.read_all`-floored (R2-S9)**: it is clause content one paraphrase removed |
| `deliverable_kind` | varchar(32) NOT NULL DEFAULT `'work_product'` | `work_product` \| `milestone` \| `recurring_service` \| `support` \| `expense_allowance` \| `other` |
| **`amends_deliverable_id`** | uuid | **self-FK (guarded `DO $$`) ON DELETE RESTRICT (R2-D3).** The deliverable-level amendment link |
| **`envelope_amount_delta`** | bigint | **the increment this amendment adds to the base deliverable's envelope (R2-D3)** |
| `envelope_amount` | bigint | base envelope. **NULL means unpriced**: hours only, can never deny |
| `envelope_hours` | numeric(10,2) | |
| `envelope_source` | varchar(24) NOT NULL DEFAULT `'proposed'` | `proposed` \| `human` \| `stated` \| **`unpriced`** (2.2.2). **`even_split` is deleted** |
| **`lifecycle_status`** | varchar(16) NOT NULL DEFAULT `'open'` | **`open` \| `complete` \| `closed` (design minor).** `closed` is what `verdict_reason='deliverable_closed'` refers to; without this column that verdict reason was unreachable |
| `cited_span` | jsonb NOT NULL DEFAULT `'{}'` | `quote` is `read_all`-floored |
| `due_date` | date | |
| `confidence` | numeric(5,2) | display only |
| `review_status` | varchar(16) NOT NULL DEFAULT `'pending_review'` | `pending_review` \| `confirmed` \| `rejected` \| `superseded` |
| `is_active` | boolean NOT NULL DEFAULT false | **set only by `POST /v1/deliverables/:id/confirm-envelope` under `burn.envelope.confirm` (2.2.1)** |
| `supersedes_deliverable_id` | uuid | self-FK ON DELETE SET NULL; **restatement only**, with the same `dedup_key` migration and `restatement_unmatched` rule as the engagement path |
| `search_tsv` | tsvector GENERATED ALWAYS AS ... STORED | below |
| `qdrant_point_id` / `qdrant_synced_at` | uuid / timestamptz | reserved |
| `reviewed_by` / `reviewed_at` | uuid / timestamptz | |
| `envelope_confirmed_by` / `envelope_confirmed_at` | uuid / timestamptz | the audit trail for the act that arms the gate |
| `extraction_run_id` | uuid | FK ON DELETE SET NULL |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**Effective envelope (round-2 blocker R2-D3).** `effective_envelope = envelope_amount + sum(envelope_amount_delta)` over the deliverable's amendment set, resolved on the chain exactly as `contract_value_delta` is at engagement level. **Consumption stays on the base row, so no attribution migration is needed and `ON DELETE RESTRICT` is never violated.** Round 2 was right that without this the flagship loop did not close: the change order is drafted off an `envelope_overrun` on a *specific* deliverable, but the only representable outcomes were a chain-level `contract_value_delta` and *new* deliverables, neither of which raises the overrun deliverable's envelope, so after approval **the same deliverable kept denying**. Section 12.1's "a stale deny does not persist after a change order expanded the envelope" was asserted against a model with no way to expand it. The burn-down now shows a **per-deliverable dated step-up**.

`search_tsv`, null-safe with an explicit regconfig (a bare concatenation over nullable columns yields NULL, gutting recall on the shipped path):

```sql
search_tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(title, '') || ' ' ||
    coalesce(description, '') || ' ' ||
    coalesce(cited_span->>'quote', ''))
) STORED
```

Indexes: `UNIQUE (organization_id, engagement_id, dedup_key)`, `(organization_id, engagement_id)`, `(organization_id, review_status)`, `(organization_id, is_active) WHERE is_active`, `(organization_id, lifecycle_status)`, `(organization_id, due_date)`, `(amends_deliverable_id)`, GIN on `search_tsv`, GIN trigram on `title`.

**`burn_work_items`** - **highest-churn table.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `source_type` / `source_id` | varchar(32) NOT NULL / uuid NOT NULL | |
| `source_epoch` | varchar(64) NOT NULL | stored concatenation; **a plain compared column, not part of any unique key (R2-T4)** |
| **`classification_epoch`** | varchar(64) NOT NULL | 2.3.2A; a change may re-classify, subject to 2.3.10 |
| **`cost_epoch`** | varchar(64) NOT NULL | 2.3.2A; a change revalues only, **never re-classifies** |
| **`valuation_epoch`** | varchar(64) | 2.3.2B: hash of `bill_rate_id`, `burn_cost_rate_id`, `user_id`, and both rate rows' `updated_at` |
| **`valued_at`** | timestamptz | last successful valuation |
| `project_id` | uuid | FK `projects(id)` ON DELETE SET NULL. **The scoping anchor for this row (2.4 point 6)** |
| `actor_id` | uuid | FK `users(id)` ON DELETE SET NULL. `read_all`-floored |
| `occurred_at` | timestamptz NOT NULL | per the 2.3.2C mapping table |
| `ingested_at` | timestamptz NOT NULL DEFAULT now() | |
| **`reconcile_until`** | timestamptz NOT NULL | `ingested_at + reconcile_window_days`; **the anchor for reconcile passes 2 and 3 (R2-T3)** |
| `title_snapshot` / `text_snapshot` | varchar(512) / text | PII-redacted on write; `text_snapshot` truncated to `TEXT_SNAPSHOT_MAX` (4000) |
| `minutes` | integer | |
| `billable_amount` / `cost_amount` | bigint | minor units; both pass through `redactFinancialFields` |
| `currency` | varchar(3) | |
| `valuation_basis` | varchar(16) NOT NULL DEFAULT `'none'` | `rate` \| `expense` \| `invoice` \| `none` \| `unrated` \| `no_cost_rate` |
| `unrated_reason` | varchar(32) | `no_rate_configured` \| `rate_service_unavailable` (2.3.1.2) \| `currency_mismatch` |
| `bill_rate_id` / `burn_cost_rate_id` | uuid | audit of the dollar figure |
| `attribution_state` | varchar(24) NOT NULL DEFAULT `'pending'` | `pending` \| `pending_attribution` \| `attributed` \| `pending_review` \| `unscoped` \| `excluded_non_billable` \| `excluded` |
| `exclusion_reason` | varchar(32) | `superseded_epoch` \| `source_deleted` \| **`source_voided`** \| `internal` \| `pre_sales` \| `pto` \| `warranty` \| `overhead` \| `rework` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**Indexes.** The live-row constraint replaces the four-column key (R2-T4):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_work_items_live
  ON burn_work_items (organization_id, source_type, source_id)
  WHERE attribution_state <> 'excluded';
```

Plus `(organization_id, attribution_state, occurred_at DESC)`, `(organization_id, project_id, occurred_at)`, `(organization_id, source_type, source_id)`, **`(organization_id, reconcile_until) WHERE reconcile_until > now()`** is not immutable-safe so it is a plain `(organization_id, reconcile_until)`, and `(organization_id, valued_at)` for the revalue scan.

**`attribution_state` denormalization mapping** (design minor): `burn_attributions.state` -> `burn_work_items.attribution_state` is `auto_attributed | confirmed -> 'attributed'`; `pending_review -> 'pending_review'`; `unscoped -> 'unscoped'`; `excluded_non_billable -> 'excluded_non_billable'`; `rejected -> 'pending'`. Stated because the two enums deliberately differ.

**Partitioning posture.** First candidate for monthly partitioning on `occurred_at` per `0220_blip_entries_partitioned.sql`; v1 ships unpartitioned at the 2-50 seat target.

**`burn_attributions`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `work_item_id` | uuid NOT NULL | FK CASCADE |
| `deliverable_id` | uuid | FK **ON DELETE RESTRICT**; null means unscoped or non-billable |
| `engagement_id` / `chain_root_id` | uuid | denormalized |
| `state` | varchar(24) NOT NULL | `auto_attributed` \| `confirmed` \| `pending_review` \| `unscoped` \| `excluded_non_billable` \| `rejected` |
| `unscoped_reason` | varchar(32) | `no_matching_deliverable` \| `low_confidence` \| `no_active_engagement` \| `outside_engagement_window` \| `restatement_unmatched` \| `aged_out` (bucketed per 2.3.8) |
| `non_billable_reason` | varchar(24) | the 2.3.7 enum |
| `confidence` | numeric(5,2) | |
| `method` | varchar(24) NOT NULL | `rule` \| `structural` \| `precedent` \| `lexical` \| `llm` \| `human` \| **`inherited`** (2.3.10 carry-forward) |
| `candidate_set` | jsonb NOT NULL DEFAULT `'[]'` | decision reproducibility |
| `rationale` | text | display only |
| `billable_amount` / `cost_amount` | bigint | snapshotted; **redacted by the shared serializer (R2-S3)** |
| `superseded_at` / `superseded_by` | timestamptz / uuid | self-FK guarded |
| `decided_by` | uuid | `read_all`-floored |
| `decided_at` | timestamptz | |
| `vocabulary_version` | integer NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, work_item_id) WHERE superseded_at IS NULL`, `(organization_id, deliverable_id) WHERE superseded_at IS NULL`, `(organization_id, chain_root_id, state) WHERE superseded_at IS NULL`, `(organization_id, state, created_at DESC)`.

**`burn_attribution_rules`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `name` | varchar(255) NOT NULL | |
| `priority` | integer NOT NULL DEFAULT 100 | ascending; first match wins |
| `match` | jsonb NOT NULL | `{ project_ids?, phase_ids?, label_ids?, account_ids?, title_pattern?, expense_categories?, source_types? }`. **`CHECK` rejects a match with no discriminating key**; `title_pattern` is **glob or substring, never regex** (2.3.3) |
| `outcome_kind` | varchar(24) NOT NULL | `attribute` \| `non_billable` |
| `outcome_deliverable_id` | uuid | FK CASCADE; required when `attribute` |
| `outcome_reason` | varchar(24) | required when `non_billable` |
| `is_enabled` | boolean NOT NULL DEFAULT true | |
| `match_count` | integer NOT NULL DEFAULT 0 | |
| `last_match_pct` | numeric(5,2) | trailing-window match fraction; a value above `match_ceiling_pct` raises `rule_overreach` |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, is_enabled, priority)`, `(outcome_deliverable_id)`.

**`burn_prechecks`** - **the reason-of-record artifact.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `idempotency_key` | varchar(160) NOT NULL | server-derived HMAC; `CHECK (idempotency_key LIKE 'svc:%' OR idempotency_key LIKE 'usr:%')` |
| **`superseded_at` / `superseded_by`** | timestamptz / uuid | **self-FK guarded (R2-T7)** |
| `valid_until` | timestamptz NOT NULL | default now + `precheck_replay_ttl_seconds` (300) |
| `is_calibrating` | boolean NOT NULL DEFAULT false | true only for `svc:` rows with a resolvable ref (2.4 point 10) |
| `work_ref_type` | varchar(32) NOT NULL | `bill.expense` \| `bill.recurring` \| `bam.task_phase_move` \| `bam.assignment` \| `subcontractor_charge` \| `manual` |
| `work_ref_id` | uuid | null in the pre-transaction case |
| `project_id` | uuid | FK ON DELETE SET NULL |
| `proposed_amount` | bigint | |
| `currency` | varchar(3) | |
| `engagement_id` / `chain_root_id` | uuid | the chain actually evaluated |
| `deliverable_id` | uuid | FK ON DELETE SET NULL |
| `verdict` | varchar(20) NOT NULL | `allow` \| `allow_with_note` \| `needs_mapping` \| `deny` |
| `verdict_reason` | varchar(40) NOT NULL | `within_envelope` \| `envelope_exhausted` \| `envelope_would_exceed` \| `no_active_engagement` \| `engagement_unlinked` \| `deliverable_closed` \| `outside_engagement_window` \| `envelope_unpriced` \| `low_confidence_target` \| `gate_unavailable` \| **`gate_not_configured`** \| `gate_off` \| `gate_paused` \| **`redis_unavailable`** |
| `mode_at_decision` | varchar(12) NOT NULL | snapshotted |
| `enforced` | boolean NOT NULL DEFAULT false | |
| `envelope_amount` / `envelope_consumed` / `envelope_remaining` | bigint | snapshots; **all `read_all`-floored on read** |
| `overage_amount` | bigint | exact stored value; **quantized to `overage_bucket_amount` on read for non-`read_all` (R2-S2)** |
| `confidence` | numeric(5,2) | |
| `clause_ref` | varchar(64) | `read_all`-floored |
| `outcome` | varchar(24) NOT NULL DEFAULT `'pending'` | `pending` \| `proceeded` \| `abandoned` \| `overridden` \| `mapped` \| `mapped_and_posted` \| `change_order_raised` \| `absorbed` |
| `advisory_feedback` | varchar(16) | `right_call` \| `would_have_mapped` (**member-writable, feeds nothing**) \| `wrong_call` (**`burn.precheck.mark_wrong` only, in the numerator**) |
| `override_reason_code` | varchar(24) | `absorbed_cost` \| `mapped_manually` \| `change_order_pending` \| `gate_wrong` (**`mark_wrong` only**) |
| `override_reason_text` | text | required, min `override_reason_min_chars` (20) on a deny override |
| `overridden_by` | uuid | `read_all`-floored |
| `overridden_at` | timestamptz | |
| `latency_ms` | integer | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

**Index (R2-T7):** `UNIQUE (organization_id, idempotency_key) WHERE superseded_at IS NULL`. Recompute on a mismatch or an expired hit is **supersede-then-insert in one transaction**, the shape 2.3.10 uses for attributions. Round 2 was right that the round-2 draft's "recompute and supersede" was unimplementable against a table with no supersession columns and a total unique index: the only two options were UPDATE in place (destroying the reason-of-record on the row) or INSERT and take a 23505 **on the money path**, where the only safe handler is fail-open.

Plus `(organization_id, verdict, created_at DESC)`, `(organization_id, enforced, created_at DESC)`, `(organization_id, mode_at_decision, is_calibrating, created_at DESC)` (the calibration scan), `(organization_id, chain_root_id)`, `(organization_id, override_reason_code) WHERE override_reason_code IS NOT NULL`.

**Retention: rows with `enforced=true`, a non-null override, a non-null `advisory_feedback`, or a non-null `superseded_at` are NEVER purged.** A superseded verdict is part of the dispute record.

**`burn_variances`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `engagement_id` / `chain_root_id` | uuid | FK CASCADE |
| `deliverable_id` | uuid | FK ON DELETE SET NULL |
| `variance_kind` | varchar(32) NOT NULL | `unscoped_work` \| `envelope_overrun` \| `envelope_at_risk` \| `silent_deliverable` \| `ungated_charge` \| `consumption_erosion` \| `phantom_consumption` \| `gate_outage` \| **`rule_overreach`** \| **`awaiting_valuation`** |
| `severity` | varchar(8) NOT NULL | `low` \| `medium` \| `high` \| `critical` |
| `dedup_key` | varchar(128) NOT NULL | |
| `amount` | bigint | `read_all`-floored on read; **never in a Bolt payload** |
| `detail` | jsonb NOT NULL DEFAULT `'{}'` | refs capped at `variance_detail_max_refs` (50); **passed through `redactFinancialFields`** |
| `status` | varchar(12) NOT NULL DEFAULT `'open'` | `open` \| `acknowledged` \| `resolved` \| `dismissed` |
| `proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL |
| `resolved_by` | uuid | |
| `detected_at` / `resolved_at` | timestamptz | |
| `sweep_marker` | timestamptz | observed sweep time, never `now()` mid-compute |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, dedup_key)`, `(organization_id, status, severity)`, `(organization_id, chain_root_id)`, `(organization_id, variance_kind, detected_at DESC)`.

**Unpriced deliverables are excluded from `envelope_overrun` and `consumption_erosion`** (2.2.2).

**`burn_classifier_feedback`** - **never purged.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `engagement_id` / `work_item_id` | uuid | FK ON DELETE SET NULL |
| `decision_kind` | varchar(24) NOT NULL | `accept` \| `reject` \| `reclassify` \| `mark_unscoped` \| `mark_scoped` \| `mark_non_billable` |
| `proposed_deliverable_id` / `corrected_deliverable_id` | uuid | FK ON DELETE SET NULL |
| `proposed_confidence` | numeric(5,2) | |
| `text_snapshot` | text | PII-redacted |
| `search_tsv` | tsvector GENERATED ALWAYS AS (`to_tsvector('english', coalesce(text_snapshot,''))`) STORED | same `customType` idiom |
| `qdrant_point_id` / `qdrant_synced_at` | uuid / timestamptz | reserved |
| `decided_by` | uuid NOT NULL | `read_all`-floored on read |
| `vocabulary_version` | integer NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, engagement_id, created_at DESC)`, `(organization_id, decision_kind, created_at DESC)`, GIN on `search_tsv`.

**`burn_cost_rates`** - the primitive the platform lacks. Shape mirrors `bill_rates`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `project_id` / `user_id` | uuid | FK CASCADE |
| `cost_amount` | bigint NOT NULL | minor units, per hour |
| `rate_type` | varchar(10) NOT NULL DEFAULT `'hourly'` | |
| `currency` | varchar(3) NOT NULL DEFAULT `'USD'` | |
| `effective_from` | date NOT NULL DEFAULT now() | |
| `effective_to` | date | **inclusive**, matching `rate.service.ts:117` |
| `note` | varchar(255) | e.g. "fully loaded incl. benefits" |
| `created_by` | uuid NOT NULL | |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | **a write here enqueues `burn-revalue` (2.3.2B)** |

Indexes: `(organization_id)`, `(organization_id, project_id, user_id, effective_from)` (a supporting b-tree, not a statement of precedence). Reads and writes floored to owner/admin.

**`burn_engagement_rollups`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `chain_root_id` | uuid NOT NULL | the rollup grain is the **chain** |
| `contract_value` | bigint | chain aggregate |
| `attributed_billable` / `attributed_cost` | bigint | |
| `unscoped_sold_by_nobody` / `unscoped_unclassified` / `unscoped_outside_contract` | bigint | the three buckets (2.3.8), never summed into one |
| `pending_review_amount` / `awaiting_valuation_amount` / `non_billable_amount` | bigint | |
| `consumption_pct` | numeric(6,2) | |
| `margin_amount` / `margin_pct` | bigint / numeric(6,2) | null unless cost coverage is non-zero |
| `cost_rate_coverage_pct` / `priced_deliverable_coverage_pct` | numeric(6,2) | the second gates promotion (5.4) |
| `distinct_contributor_count` | integer NOT NULL DEFAULT 0 | drives the 2.4 point 17 suppression |
| `metric_basis` | varchar(24) NOT NULL | `true_margin` \| `contract_consumption` |
| **`revenue_basis`** | varchar(24) NOT NULL | `contract_value` \| `contract_value_per_period` \| `billable_recognized` (1.2.1) |
| `margin_state` | varchar(16) | `in_progress` \| `final` (1.2.1) |
| `work_item_count` | integer NOT NULL DEFAULT 0 | |
| **`frozen_at`** | timestamptz | **set by `burn-retention` on purge; a frozen row is never recomputed (R2-T5)** |
| `computed_at` | timestamptz NOT NULL DEFAULT now() | served as `as_of` |

Indexes: `UNIQUE (organization_id, chain_root_id)`, `(organization_id, computed_at)`, `(organization_id, frozen_at)`.

**Refresh semantics.** A full per-chain recompute upserted in **one statement**, idempotent under retry. `GET /v1/financials` serves the rollup with `as_of`; a **missing** rollup computes that chain synchronously; a **stale** one (beyond `rollup_max_age_minutes`, 120) is served with `stale: true` and a refresh enqueued. It **never** falls back to an unbounded live aggregate.

**Frozen rows are skipped by both the hourly refresh and the on-miss compute (round-2 R2-T5).** Round 2 found the two round-1 fixes cancelled: T11 made the rollup the immutable historical record after retention purges a closed chain's work items, while T1 specified an hourly **full recompute with no exclusion**, so the first refresh after a purge would recompute from surviving rows (near zero), `DO UPDATE` a three-year-old $18,000 figure to $0, and stamp a fresh `computed_at` so it would not even read as stale. `GET /v1/financials` surfaces `final: true` alongside `as_of`.

**`burn_ingest_events`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK CASCADE |
| `source_idempotency_key` | varchar(128) NOT NULL | payload `_event_id` when present (`apps/bolt-api/src/routes/event-ingestion.routes.ts:230`), else the bolt event id |
| `bolt_event_id` | uuid | |
| `source` / `event_type` | varchar(48) / varchar(96) NOT NULL | |
| `scope_fields` | jsonb NOT NULL DEFAULT `'{}'` | id-typed, uuid-validated, non-conforming dropped |
| `occurred_at` / `logged_at` | timestamptz | |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `claimed` \| `processed` \| `skipped` |
| `claimed_by` | varchar(64) | worker instance id |
| `claimed_at` | timestamptz | **heartbeated by the holding drain (R2-T9)**; the reaper reclaims only genuinely cold rows |
| `received_at` / `processed_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, source_idempotency_key)`, `(organization_id, status, received_at)`, **`(organization_id, status, claimed_at) WHERE status='claimed'`** (the reaper scan is **per org**, per 2.4 point 14), `(source, event_type)`.

`bulwark_ingest_events` has only `status pending|processed` and no claim column (`0234_bulwark_core.sql:123-136`); it survives that shape only because its sweeps run at `concurrency: 1` under a lock. Burn's batch is both event-driven and scheduled, so rows are claimed with `UPDATE ... SET status='claimed', claimed_by, claimed_at WHERE status='pending' ... RETURNING` (or `SELECT ... FOR UPDATE SKIP LOCKED`), never a bare SELECT.

**`burn_extraction_runs`** - never purged. Columns as round 2 (`status` incl. `rejected_limits`, `last_processed_chunk`, `source_doc_hash`, `doc_bytes`, `doc_pages`, `deliverables_extracted`, `low_confidence_count`, `provider_id`, `error`, `started_at`, `finished_at`). Indexes `(organization_id, engagement_id, started_at DESC)`, `(status)`.

**`burn_org_settings`** - one row per org.

| Column | Default | Notes |
| --- | --- | --- |
| `gate_mode` | **`'advisory'`** | `off` \| `advisory` \| `blocking`; unreachable without 5.4 |
| `gate_enabled_refs` | `["bill.expense"]` | blocking only for money-out classes |
| `gate_paused_until` | | one-click pause |
| `deny_threshold` | 0.85 | |
| `map_threshold` | 0.60 | |
| `auto_attribute_threshold` | 0.90 | `CHECK BETWEEN 0.75 AND 0.99` |
| `review_threshold` | 0.60 | `CHECK BETWEEN 0.30 AND auto_attribute_threshold - 0.05` |
| `pending_review_max_age_days` | 14 | |
| `reconcile_window_days` | 90 | sets `reconcile_until` at ingest |
| `overage_bucket_amount` | 10000 | quantization for non-`read_all` denies (2.4 point 3) |
| `min_contributors_for_cost_aggregate` | 3 | 2.4 point 17 |
| `match_ceiling_pct` | 40 | rule overreach (2.3.3) |
| `max_false_positive_rate` | 0.05 | |
| `min_gate_wrong_count` | 5 | absolute floor before demotion |
| `min_gate_wrong_distinct_users` | 2 | |
| `min_advisory_decisions` | 200 | `svc:` rows only |
| `min_advisory_days_alt` | 60 | the scale-aware alternative |
| `min_advisory_days` | 14 | soak |
| `min_labeled_denies` | 10 | |
| `min_deny_precision` | 0.95 | |
| `min_priced_deliverable_coverage_pct` | 60 | 2.2.2 / 5.4 |
| `min_gate_coverage_pct` | 0.90 | below this, blocking auto-demotes |
| `min_gate_unavailable_days` | 2 | absolute floor on coverage demotion (R2-S4b) |
| `precheck_budget_ms` | 600 | `CHECK BETWEEN 100 AND 750`; **advisory and display-only**, the authoritative bound is `BURN_PRECHECK_TIMEOUT_MS` |
| `precheck_replay_ttl_seconds` | 300 | |
| `usr_precheck_daily_cap` | 200 | 2.4 point 10 |
| `override_reason_min_chars` | 20 | |
| `unscoped_alert_floor` | 10000 | |
| `candidate_k` / `exemplar_k` | 8 / 6 | |
| `attribution_llm_daily_cap` | 2000 | |
| `attribute_batch_size` | 25 | bounded so worst-case duration sits inside the claim lease (R2-T9) |
| **`claim_lease_seconds`** | 300 | **declared as a column (R2-T9); the drain heartbeats at `claim_lease_seconds / 3`** |
| `rollup_max_age_minutes` | 120 | |
| `embedding_enabled` | **false** | |
| `banter_signal_enabled` / `vcs_signal_enabled` | false | |
| `llm_provider_id` | | **org ownership validated on write** |
| `vocabulary_version` | 0 | |
| `last_source_watermark` | `'{}'` | per-`source_type` `created_at` high-water marks |
| `work_item_retention_days` | 1095 | |
| `ingest_retention_days` | 400 | |
| `last_variance_sweep_at` | | advanced only after a fully successful sweep |
| `gate_promoted_at` / `gate_demoted_at` | | audit |
| `updated_by` / `updated_at` | | |

### 3.2 Reused platform tables

`entity_links` (`0132_entity_links.sql`), `agent_proposals` (`0128_agent_proposals.sql`), `organizations`, `users`, `projects`, `project_memberships`, `actor_type`; read-only source tables via the shared DB (`tasks`, `time_entries`, `phases`, `sprints`, `bill_expenses`, `bill_rates`, `bill_invoices`, `bill_recurring_invoices`, `bill_clients`, `bond_companies`, helpdesk tickets, `bin_assets`); `llm_providers` only via `POST /internal/llm/chat`.

### 3.3 JSONB shapes (authoritative)

```jsonc
// burn_deliverables.cited_span
{ "page": 2, "section": "3.1", "quote": "Consultant shall deliver ...",
  "char_start": 4412, "char_end": 4573, "chunk_index": 1, "verified": true }

// burn_attributions.candidate_set
[ { "deliverable_id": "…", "engagement_id": "…", "signal": "structural", "score": 0.71 } ]

// burn_attribution_rules.match  (CHECK rejects an object with no discriminating key)
{ "project_ids": ["…"], "title_pattern": "retro*", "source_types": ["bam.task"] }

// burn_org_settings.last_source_watermark
{ "bam.time_entry": "2026-07-19T05:00:00Z", "bill.expense": "2026-07-19T05:00:00Z" }

// burn_variances.detail  (refs and magnitudes only, capped, serializer-redacted)
{ "work_item_ids": ["…"], "work_item_count": 37, "hours": 21.5, "overrun_pct": 23.0 }
```

### 3.4 Migration plan, with the ordering that decides whether permissions exist at all

On-disk tip is `0238_bulwark_builtin_group_defaults.sql` (200 files). **The numbers of the last two files are assigned by a generator and this spec deliberately does not name them.**

1. **`0239_burn_core.sql`** - `burn_engagements` (both self-FKs guarded, `chain_root_id`, `period_length_days`), `burn_engagement_projects`, `burn_deliverables` (incl. `amends_deliverable_id`, `envelope_amount_delta`, `lifecycle_status`, the null-safe `search_tsv` with the `'english'` regconfig, reserved qdrant columns), `burn_work_items` (incl. both epochs, `valuation_epoch`, `valued_at`, `reconcile_until`, `exclusion_reason`, `unrated_reason`, **and the partial live-row unique index, not a four-column key**), `burn_attributions`, `burn_extraction_runs`, `burn_ingest_events` (incl. claim columns and the per-org reaper index), all indexes, RLS. Seeds the **"Burn System" service-account user** for `agent_proposals` inserts (`actor_id NOT NULL`), as `0234_bulwark_core.sql` does for Bulwark. Additive only.
2. **`0240_burn_gate_variance.sql`** - `burn_prechecks` (incl. `superseded_at`/`superseded_by`, the partial unique index, `is_calibrating`, the key-prefix `CHECK`), `burn_variances`, `burn_classifier_feedback`, `burn_org_settings` (every threshold with its default **and** its `CHECK`), indexes, RLS. Additive only.
3. **`0241_burn_rates_rollups_rules.sql`** - `burn_cost_rates`, `burn_engagement_rollups` (incl. `revenue_basis`, `frozen_at`, `distinct_contributor_count`), `burn_attribution_rules` (incl. the discriminating-key `CHECK`), **plus `CREATE INDEX IF NOT EXISTS idx_bill_expenses_created_at ON bill_expenses (organization_id, created_at)`** (2.3.2E: a Burn-owned additive index on another app's table, needed because `bill-expenses.ts:50-52` indexes only `organization_id`, `project_id`, and `status`). Additive only.
4. **The generated permissions delta**, number assigned by `scripts/build-permission-delta.mjs`.
5. **The built-in group defaults**, authored at **the generated delta's number plus one**, modeled on `0238_bulwark_builtin_group_defaults.sql`.

#### 3.4.1 The ordering trap that silently locks every user out (round-2 blocker R2-B1)

`scripts/build-permission-delta.mjs:40-44` computes `migrationNum = max(all four-digit prefixes) + 1`. **If the author writes the group-defaults file as `0243` before running the generator, the generator emits `0244` and the group-defaults file runs FIRST.** Its `CROSS JOIN permissions p ... WHERE p.app = 'burn'` matches zero rows, `ON CONFLICT DO NOTHING` swallows it, migrate reports success, and the file is checksummed so **it never re-runs**. No built-in group grants any `burn.*`, so **every non-SuperUser including org Owners hits `implicit_deny` on every route.** This is verbatim the incident `0238`'s own `-- Why:` header documents for Bulwark. Round 1's Section 9.8 instruction ("land 0239-0243 on disk, then lint") would have caused it.

**The mandatory order, two migrate passes:**

```sh
# Pass 1: author and apply the three core files
pnpm lint:migrations
docker compose run --rm migrate

# Pass 2: generate permissions AGAINST an applied schema, then author defaults at NNNN+1
node scripts/generate-permission-manifest.mjs
node scripts/build-permission-codegen.mjs      # commit packages/permissions/src/generated/permissions.ts
node scripts/check-permission-catalog.mjs
node scripts/build-permission-delta.mjs        # ASSIGNS NNNN; observe it
# only now author NNNN+1_burn_builtin_group_defaults.sql
pnpm lint:migrations
docker compose run --rm migrate
```

**Post-migrate verification probe, with expected counts:**

```sql
SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
FROM permission_group_defaults d
JOIN permissions p ON p.id = d.permission_id
JOIN permission_groups pg ON pg.id = d.group_id
WHERE p.app = 'burn' GROUP BY 1;
-- expected: owner 22, admin 22, member 14, viewer 7, guest 0
```

**A zero result means the ordering inverted, and the fix is a NEW file, never an edit** to the already-applied and checksummed one.

The `HAND_AUTHORED` registration itself (`scripts/generate-permission-manifest.mjs:719`, loop at `:816` which copies flags **verbatim**), the `burn.` provenance branch, and the exclusion from `EXPLICIT_TOOL_OVERRIDES` are as in round 1. **Never use `MIGRATE_ALLOW_HEADER_RESTAMP=1`.**

---

## 4. The engines

Each worker job is a **thin HTTP caller** invoking the engine over burn-api's internal routes, following `apps/worker/src/worker.ts:2207-2260` (the Bulwark block), so business logic lives in one container and burn-api is the process holding the LLM calls.

### 4.0 The concurrency mechanism, chosen and stated once (round-2 blocker R2-T1, R2-B2)

Two rounds handed this spec a citation for a "per-org advisory lock pattern" pointing at a file containing only a doc comment. Verified now:

- `apps/worker/src/jobs/bulwark-radar-sweep.job.ts` is **29 lines with no lock of any kind**; the phrase appears only in a header comment at `:5` describing what bulwark-api does downstream. Round 1 rejected `bond-stale-deals.job.ts:127-138` for exactly this reason and round 2 folded in a second comment-only citation.
- The real implementation is `apps/bulwark-api/src/services/sweeps.service.ts:41-52`, **and it is defective**: `pg_try_advisory_lock` is **session-scoped** (not `_xact_`), acquired via `db.execute` on a **pooled** connection, released by a second `db.execute` that may land on a **different** connection, with the failure swallowed by `.catch(() => {})`. When acquire and release split, the lock stays held until the connection recycles and **every subsequent caller skips**, indistinguishable from contention, so nothing alerts. For Burn that would make the variance sweep, all three reconcile passes, the rollup refresh, and the silent-deliverable sweep permanent no-ops for that tenant. It is the same pooled-connection defect class this spec diagnoses for RLS at 2.4 point 14, and the round-2 draft adopted it uncritically two sections later.

**Burn does not copy it. Burn uses `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock` acquired inside the sweep transaction**, following the genuine implementation at `apps/braid-api/src/lib/advisory-lock.ts:79` (`await tx.execute(sql\`SELECT pg_advisory_xact_lock(${token.classHash}, ${token.keyHash})\`)`). A transaction-scoped lock is released by commit or rollback, so it is immune to pool routing and cannot leak. There is **no unlock call to get wrong.**

Three consequences stated so no implementer reintroduces the old shape:

1. **Every "lock" in this document is a Postgres transaction-scoped advisory lock, never a Redis lock.** The round-2 draft said "Redis lock" in Sections 4.2, 4.3, and 8.1 while citing a Postgres precedent; that inconsistency is removed. (Redis is still used for the circuit breaker, coverage counters, and the bindings cache, which are not locks.)
2. **The lock lives in burn-api's sweep service, not the worker job.** BullMQ `concurrency: 1` bounds the worker *container*; it does not bound the burn-api *replica set*, and burn-api runs at 2 replicas.
3. **A skipped-because-locked sweep emits a counted log line** through `@bigbluebam/logging`, so contention is visible rather than silent.

### 4.1 Deliverable-extraction engine

**Trigger.** `POST /v1/engagements` (with a `bin_asset_id`) or `POST /v1/engagements/:id/extract` enqueues `burn-extract-deliverables`, after the route `can_access`-preflighted the Bin asset.

1. **Preflight, limit, fetch.** Re-check `preflightAccess(created_by, 'bin.asset', ...)`, enforce `MAX_DOC_BYTES` / `MAX_DOC_PAGES` / the parse wall-clock cap **before parsing**, with JavaScript execution and external-entity resolution **disabled**. A breach records `rejected_limits` and extracts nothing partial. Bytes via `@bigbluebam/storage` `getStream`. Image-only scans yield zero deliverables (no OCR in v1).
2. **Conditional hash skip.** Only when `source_doc_hash` is unchanged **and** the last run `succeeded`.
3. **Chunk and checkpoint.** `last_processed_chunk` persisted; per-chunk **flushed** progress logging through `@bigbluebam/logging`, since a 40-page MSA is a multi-minute phase.
4. **Extract per chunk.** Chunk fenced as untrusted DATA; strict JSON; Zod-validated; malformed rows dropped.
5. **Verify the cite.** A failed offset match sets `verified=false` and forces `pending_review` regardless of confidence.
6. **Upsert on `dedup_key`**, so overlapping-chunk re-extraction collapses and a re-extract never orphans a confirmed deliverable.
7. **Propose the envelope. Activate nothing.** Priority: a document `stated_price`; an explicit human split; a proposed effort-weighted split; otherwise leave **unpriced**. **`is_active` is never set here.** It is set only by `POST /v1/deliverables/:id/confirm-envelope` under `burn.envelope.confirm`, showing the operator the **verified quote beside the extracted number** (2.2.1). A `stated_price` is an LLM extraction from an attacker-influenceable PDF, and cite verification proves the quote exists in the bytes, not that the number is the number the clause states.
8. **Emit** `deliverable.extracted` and `engagement.extracted`, refs only.

### 4.2 Continuous-attribution engine

**Triggers:** the bolt-api dispatch hook into `POST /v1/internal/events`; the claimed inbox drain; and the three reconcile passes of 2.3.2C owned by `burn-variance-sweep`. Because the live-row constraint is on `(org, source_type, source_id)`, the event path and the reconcile path converge on exactly one live row in every ordering.

**Pipeline per work item:** normalize -> resolve project -> resolve all chain-linked engagements -> **stage zero rules** -> value deterministically (billable and cost separately, per 2.3.1) -> assemble candidates -> **stage two adjudication (batch path only)** -> band -> write the attribution respecting 2.3.10 -> denormalize `attribution_state` -> emit `work.unscoped` (refs plus band) above the floor.

**Concurrency and the claim lease (round-2 R2-T9).** The round-2 draft gave the queue `concurrency: 1` **and** said it honors `BURN_ATTRIBUTE_CONCURRENCY` (default 2); those cannot both hold, and the limiter is inert under `concurrency: 1`. Resolved explicitly:

- **`concurrency: BURN_ATTRIBUTE_CONCURRENCY` (default 2).** The correctness mechanism is **row claiming plus the per-org transaction-scoped lock**, not single-threading, so parallelism is safe and the BullMQ `limiter: { max: 30, duration: 60000 }` is meaningful.
- **The lease is renewed, not merely long.** A batch may exceed `claim_lease_seconds` (300), and a reaper that reclaims mid-flight rows would reintroduce duplicate LLM spend with a timer instead of a race. The drain **heartbeats `claimed_at = now()` on rows it still holds every `claim_lease_seconds / 3` (100s)**, and `burn-claim-reaper` reclaims only genuinely cold rows.
- **`attribute_batch_size` (25)** bounds worst-case batch duration inside the lease.
- **`claim_lease_seconds` is a declared column** on `burn_org_settings`, not a floating constant referenced three times.

### 4.3 Variance engine (post-transaction)

`burn-variance-sweep`, every 30 minutes, **per org, inside a transaction holding `pg_advisory_xact_lock` (4.0)**, iterating orgs and setting the RLS GUC per org (2.4 point 14).

**Progress logging.** The sweep iterates every org and re-reads bounded source history: a multi-minute silent phase. Per CLAUDE.md's rule it logs a flushed line **before** the slow phase begins, then every N orgs and every N items with elapsed time.

Findings, keyed on `dedup_key`: `unscoped_work`, `envelope_overrun` (priced deliverables only), `envelope_at_risk`, **`ungated_charge`** (a money-out work item with no `burn_prechecks` row, the catch-all that makes coverage gaps visible), `consumption_erosion` (priced only), `phantom_consumption`, `rule_overreach`, `awaiting_valuation`, and `gate_outage` raised on recovery from the Redis counters (5.5.2).

### 4.4 Inverse check

`burn-silent-deliverable-sweep`, daily 03:00 UTC, per-org locked: every active deliverable with a `due_date` inside the lead window and **zero non-superseded attributions** raises `silent_deliverable`.

### 4.5 Revaluation engine (round-2 blocker R2-T2)

`burn-revalue`, triggered by any `burn_cost_rates` write and by observed `bill_rates` changes, plus a nightly catch-up. It re-resolves rates for work items whose `valuation_epoch` no longer matches, rewrites `billable_amount` / `cost_amount` / `valuation_basis` **in place**, and updates `valued_at`.

**It issues zero llm-provider calls, never supersedes an attribution, and never re-classifies.** Without it the cost-rate screen, whose entire purpose is flipping `metric_basis` to `true_margin`, would change nothing for any already-observed work item, and Playwright story 2 would fail forever.

### 4.6 Change-order drafting, and how the loop actually closes

On an `envelope_overrun` or clustered `unscoped_work`, and only when `auto_draft_change_orders` is on (**default false**), Burn drafts a change order: a deterministic scope table (deliverable, work items, hours, dollars, clause cite) plus an LLM-written narrative paragraph. The narrative is the only model output. The draft lands in `agent_proposals`, refs-only. **Nothing is sent and nothing is posted to Bill.**

On approval the `proposal.decided` subscription (the `apps/bulwark-api/src/subscriptions/proposal-decided.ts` shape):
1. re-SELECTs `agent_proposals.status` to confirm `approved`;
2. runs the decider through `POST /internal/permissions/dual-read` against **`bill.invoice.update`**, fail closed on non-2xx;
3. runs `POST /v1/agent-policies/<decider_id>/check`;
4. writes through bill-api's internal path with `acting_user_id` in the body and the internal secret, with bill-api recording `acting_user_id` on the row and publishing it in the Bolt event (2.4 point 11);
5. **creates the amendment**, and this is the step that closes the flagship loop: an amendment **engagement** (`amends_engagement_id` + `contract_value_delta`) **and, when the change order was drafted off a specific deliverable's overrun, an amendment deliverable carrying `amends_deliverable_id` + `envelope_amount_delta`** so the overrun deliverable's effective envelope actually rises (3.1). Without step 5's second half the same deliverable keeps denying after approval.

Exactly-once is a CAS on the draft row.

---

## 5. The precheck gate

Three voting seats independently named the same risk: a wrong hard block that stops money in a small firm gets the feature switched off permanently. Round 1 removed the low-confidence blocking path. Round 2 removed the last route by which classifier latency touches money, and closed three member-tier neutralization vectors.

### 5.1 What the gate is

`burn_precheck(work_ref)` registers on the moments money commits and returns an allowability verdict with a target deliverable, a quantized overage, and a clause cite. In `blocking` mode, for enabled money-out classes only, a `deny` prevents the write until a human maps it, absorbs it with a recorded reason, or converts it into a change order. Every call writes a `burn_prechecks` row. **That row is the reason-of-record artifact firms never have when a client disputes a bill.**

### 5.2 Where it hooks

- **`bill_expenses` publishes no Bolt events at all.** `apps/bill-api/src/routes/expenses.routes.ts:46` creates an expense with no `publishBoltEvent`; the only `billEvents` in `apps/bolt-api/src/services/event-catalog.ts:1437-1680` are `invoice.*`, `payment.recorded`, `recurring.invoice_generated`.
- **Bolt events publish after a write commits, so a Bolt subscription can never be a pre-transaction gate.**
- **There is no purchase-order entity in the platform.** A "subcontractor PO" is a `bill_expenses` row with a `vendor` string (`bill-expenses.ts:28`). Burn does not invent a PO object.

| Hook | Change | Class | Blocking eligible |
| --- | --- | --- | --- |
| `POST /expenses` | `burnPrecheck` preHandler at `expenses.routes.ts:46`, after `requireCan('bill.expense.create')` | `bill.expense` | yes |
| `PATCH /expenses/:id` when `amount` or `project_id` changes | same preHandler (route at `:57`) | `bill.expense` | yes |
| `POST /expenses/:id/approve` | same preHandler | `bill.expense` | yes (approval is the real money commitment) |
| `bill-recurring-generate` job | one breaker check per job, then inline calls | `bill.recurring` | yes |
| Task moved into a non-terminal, non-start phase | Bolt `task.moved`, post-hoc | `bam.task_phase_move` | **no, advisory forever** |
| Assignee change | Bolt `task.assigned`, post-hoc | `bam.assignment` | **no, advisory forever** |

`gate_enabled_refs` validation **rejects** marking the last two blocking. Two new `bill` events (`expense.created`, `expense.approved`) and one new internal route (`POST /internal/rates/resolve`) are added to bill-api by this build.

### 5.3 The verdict, and the deterministic-only path

| Verdict | Blocks in `blocking` mode |
| --- | --- |
| `allow` | no |
| `allow_with_note` (warning band, unpriced envelope, unlinked chain, currency mismatch) | no |
| `needs_mapping` | **no.** The charge posts with an inline note and a queue item |
| `deny` | **yes. The only blocking verdict** |

**The synchronous path is deterministic-only (round-2 R2-T6, Invariant 2).** The gate runs, in order and within budget:

1. **Stage zero:** `burn_attribution_rules` in priority order.
2. **Structural resolution:** `project_id` through `burn_engagement_projects` to the chain's active deliverables.
3. **Precedent:** prior confirmed attributions for the same project, task tree, epic, sprint, labels, or (for expenses) the same vendor and category.
4. **Lexical retrieval:** Postgres FTS plus trigram over deliverable titles, quotes, and confirmed exemplars.

**It never calls `POST /internal/llm/chat`.** If no deterministic target clears `deny_threshold`, the verdict is `needs_mapping`, which is already non-blocking, so this costs nothing in safety. Round 2's analysis was correct and decisive: with `work_ref_id` null there is no prior attribution and no work item to look up, so requiring a confident target would have meant a provider round trip inside 800ms, and the realistic steady state would be that every gated expense either burned the budget and failed open or fell to `needs_mapping`. **The blocking gate would have been decorative.** Section 12.1 asserts zero llm-provider calls and a p95 inside `precheck_budget_ms` on the **success** path, not only on failure paths.

**A `deny` requires all of:** a deterministic target at `confidence >= deny_threshold`; a deterministic reason (`envelope_exhausted`, `envelope_would_exceed`, `deliverable_closed` via `lifecycle_status`, `outside_engagement_window`, `no_active_engagement`); arithmetic over a **human-confirmed, priced** effective envelope (4.1 step 7, 3.1); a chain with at least one linked project; `gate_mode='blocking'` with the class enabled; and the calibration gate earned.

`no_active_engagement` degrades to `needs_mapping` unless `strict_untracked_projects=true` (default false).

### 5.4 Advisory to blocking: seven preconditions, all measurable

The precision sample is the **advisory-mode verdict-feedback control**: each non-enforced `deny` shows "This would have been blocked. Right call? Yes / No / I'd have mapped it." **Only `wrong_call` (and, once live, `gate_wrong`) enters the numerator, and only `burn.precheck.mark_wrong` holders can write it** (2.4 point 9); the member-visible control offers `right_call`, `would_have_mapped`, and "flag for review".

`PATCH /v1/settings` **rejects** `gate_mode='blocking'` server-side unless all seven hold:

1. **Volume, scale-aware and namespace-restricted:** the lesser of `min_advisory_decisions` (200) **`svc:`-namespaced, `is_calibrating` rows** or `min_advisory_days_alt` (60) days of advisory operation. A 6-person consultancy reaches 200 expenses in about ten months, and counting `usr:` rows would let a member script the gate open (2.4 point 10).
2. **Soak:** `min_advisory_days` (14) since the first advisory precheck.
3. **Labeled denies:** at least `min_labeled_denies` (10) carrying `advisory_feedback`.
4. **Precision:** at least `min_deny_precision` (0.95) on that sample.
5. **Gate coverage:** at least `min_gate_coverage_pct` (0.90) over the trailing 7 days (5.5.2), so an org cannot promote a gate that is mostly failing open or unconfigured.
6. **Priced-envelope coverage:** at least `min_priced_deliverable_coverage_pct` (60) of active deliverables on the chain are priced, so an org cannot promote a gate with nothing to enforce against (2.2.2).
7. **Explicit acknowledgement:** `acknowledge_blocking: true`, after the wizard has shown the last 20 advisory denies with their labels and outcomes.

Promotion is **per class**. `GET /v1/calibration` returns standing against all seven with the shortfall named.

**Advisory is a complete product and the console says so**, without nagging. An org with no promotion path still gets the queue, the variance inbox, change-order drafts, and the financial figures.

### 5.5 Failure modes

| Failure | Behavior |
| --- | --- |
| burn-api unreachable | **fail open**, `gate_unavailable`, Redis counters incremented, `ungated_charge` + `gate_outage` raised on recovery |
| Circuit breaker open | fail open at **zero network cost** |
| Timeout past `BURN_PRECHECK_TIMEOUT_MS` | fail open, `latency_ms` recorded |
| **`BURN_API_INTERNAL_URL` unset** | fail open, **`gate_not_configured`**, and **`burn:gate_calls` still increments** (5.5.2) so coverage reads 0 percent rather than 0/0 |
| **Redis unreachable or at `maxmemory`** | **fail open, `redis_unavailable`**, in-process breaker fallback; see 5.5.3 |
| LLM provider down | **no effect on the gate at all** (deterministic-only path) |
| Qdrant down | no effect (`embedding_enabled=false`) |
| bill-api rate-resolve unavailable | the *work item* takes `valuation_basis='unrated'` and is excluded from every envelope and rollup (2.3.1.2); the gate itself is unaffected |
| No confirmed deliverables on the chain | `needs_mapping` |
| Chain has zero linked projects | `allow_with_note`, `engagement_unlinked` |
| Envelope null (unpriced) | `allow_with_note`, `envelope_unpriced`, hours only |
| Duplicate key, matching amount and currency, inside `valid_until` | the stored row is returned |
| Duplicate key, mismatched amount/currency/ref type, or past `valid_until` | **supersede-then-insert and recompute** (3.1) |

**The sentence an implementer must not violate:** *the gate never blocks because something broke.* Availability fails **open**; authentication fails **closed** (2.4 point 16). These are deliberately inverted; do not harmonize them.

#### 5.5.1 The circuit breaker: Burn is building the platform's first one

**No circuit breaker exists in the tree.** Grepping `apps/` and `packages/` for `circuitBreaker|CircuitBreaker|halfOpen|half_open` returns **zero files**. The round-2 draft cited `apps/bulwark-api/src/services/gate.service.ts` as "the per-org shape"; that file is 113 lines of `SADD` / `SISMEMBER` on `bulwark:bindings:<org>` used as a dispatch cache, whose own header says it "must NOT be hardened into a two-phase commit". It has no state machine, no failure counter, and no half-open probe. That citation is **removed here** and retained only in Section 8.3, where the bindings-set analogy is genuinely right.

Burn establishes the breaker, in `apps/bill-api/src/lib/burn-precheck.client.ts`, on the real Redis primitive precedent `apps/bill-api/src/services/sequence.service.ts:50`:

| Item | Value |
| --- | --- |
| Counter key | `burn:breaker:fails:<org>` (INCR with TTL) |
| State key | `burn:breaker:state:<org>` (`open` with an open TTL) |
| Probe-election key | `burn:breaker:probe:<org>` (`SET ... PX ... NX`, single-flight) |
| Threshold | **`BURN_PRECHECK_BREAKER_THRESHOLD`, default 5** consecutive timeouts or 5xx |
| Open duration / probe interval | **`BURN_PRECHECK_BREAKER_PROBE_MS`, default 30000** |

**Multi-replica correctness is explicit:** the counter is a shared atomic `INCR`, not per-process state, and the half-open probe takes the `NX` election key so a recovering burn-api is probed by one replica rather than all of them simultaneously. Both env vars go into bill-api compose, `bill-api.env.optional` in `services.mjs`, `env-hints.mjs`, and `.env.example`, and the breaker gets its own unit test file. The recurring-generate loop checks the breaker **once per job**, not once per schedule (`apps/worker/src/jobs/bill-recurring-generate.job.ts:367` loops serially over due schedules).

The authoritative timeout is bill-api's **`BURN_PRECHECK_TIMEOUT_MS`** (default 800); `burn_org_settings.precheck_budget_ms` is advisory, display-only, and `CHECK`-clamped to [100, 750].

#### 5.5.2 Fail-open is observable, and unconfigured is distinguishable from unavailable

The only writer of `burn_prechecks` is burn-api, so during a burn-api outage **no row can be written**; the round-1 "written asynchronously" claim was impossible and is deleted. Instead bill-api's client:

- `INCR`s **`burn:gate_calls:<org>:<yyyymmdd>`** on **every gated write attempt, including the unconfigured no-op**, and `burn:gate_unavailable:<org>:<yyyymmdd>` (or `burn:gate_unconfigured:...`) on the failure path, both with a 30-day TTL. **This is the R2-I3 fix:** if the counters were only incremented when the client actually ran, an unset `BURN_API_INTERNAL_URL` would leave coverage at `0/0` with no defined behavior, and an org that promoted and then lost the env var would see exactly the clean console this mechanism exists to eliminate. Counting the attempt makes a missing env var read as **0 percent coverage** and trip the same demotion path.
- Logs through `@bigbluebam/logging` with the stable codes **`BURN_GATE_UNAVAILABLE`** and **`BURN_GATE_NOT_CONFIGURED`**.

`burn-calibration-recompute` drains the counters into a coverage figure; the Gate Console shows "the gate was unavailable for N of the last 7 days" and distinguishes `gate_not_configured` from `gate_unavailable`; `burn-variance-sweep` raises `gate_outage` on recovery; and coverage below `min_gate_coverage_pct` **auto-demotes blocking to advisory**.

**No `/metrics` change (round-2 R2-I3).** `packages/service-health/src/index.ts:84` registers `/metrics` returning a **fixed** JSON body, and `HealthCheckPluginOptions` has no metrics hook. Surfacing these counters there would require changing a shared package used by roughly 22 services for an observability nicety. **That clause is dropped.** The log codes, the console panel, the `gate_outage` variance, and the demotion trigger are the mechanism.

#### 5.5.3 Redis is a hard dependency and has a specified failure mode (round-2 R2-I4)

Breaker state, coverage counters, the bindings cache, the `PermissionContext` cache, and every BullMQ queue sit on the single `redis` service, which `docker-compose.yml:29-40` runs with `--maxmemory 256mb --maxmemory-policy noeviction`, and the compose comment is explicit that **at the cap writes error out by design**. The round-2 draft enumerated seven failure modes and never mentioned Redis, so read strictly a Redis failure could throw inside the preHandler and **block the expense write**, violating the one sentence that must not be violated.

- **Every Redis touch in `burn-precheck.client.ts` is wrapped and non-throwing.** On any Redis error the client falls back to a **per-process in-process breaker** and returns `allow` / `redis_unavailable`, following the graceful-degradation shape of `apps/mcp-server/src/lib/confirm-token-store.ts` (Redis-backed with an in-process fallback), which this spec already cites.
- Redis sizing is in Section 9.7, with the threshold at which `--maxmemory` must be raised.

### 5.6 Override, labeling, and auto-demotion

**Override** (member tier, `burn.precheck.override`) requires a typed code and at least `override_reason_min_chars` of free text:

- `mapped_manually` -> not a gate error; writes feedback; `outcome` goes `mapped` then `mapped_and_posted`.
- `change_order_pending` -> **the gate was right**; drafts a change order which on approval creates the amendment engagement **and deliverable** (4.6).
- `absorbed_cost` -> **the gate was right**; becomes "we absorbed $14,200 on this account".
- `gate_wrong` -> the false-positive signal, **and it requires `burn.precheck.mark_wrong` (owner/admin)**.

I **reject** raising `burn.precheck.override` wholesale above the member floor: a member who hits a block must be able to proceed, and requiring an admin for every override recreates precisely the friction that gets the feature switched off. Splitting the label from the override keeps the escape hatch at member level and moves only the demotion-driving signal up.

**Auto-demotion, two independent triggers, each with absolute floors (round-2 R2-S4b).** The round-2 draft gave the false-positive trigger floors and gave the coverage trigger none, even though its input is a counter bill-api increments on every error path and **a member bursting expense creates can trip burn-api's rate limiter, which is not 5xx but still fails open and still increments**. Both triggers now:

| Trigger | Conditions, all required |
| --- | --- |
| False positives | rolling 30-day rate above `max_false_positive_rate` (0.05) **and** at least `min_gate_wrong_count` (5) rows **and** from at least `min_gate_wrong_distinct_users` (2) users |
| Coverage | coverage below `min_gate_coverage_pct` (0.90) **and** at least `min_gate_unavailable_days` (2) days **and** attributable to **burn-api health** (breaker-open or connect failure), with **429s counted separately and never toward coverage loss** |

Expense creation is additionally rate-limited per user. On demotion Burn sets `gate_demoted_at`, emits `gate.demoted` with the trigger named, and **notifies org admins with the contributing rows named, auditably**. Re-promotion re-earns 5.4 from the demotion date.

**Three kill switches** (pause, advisory, off), all requiring a `confirm_action` token because weakening the spend control is the consequential direction.

### 5.7 What the caller sees

```jsonc
// to a project member (no burn.financials.read_all)
{
  "precheck_id": "…",
  "verdict": "deny",
  "verdict_reason": "envelope_would_exceed",
  "enforced": true,
  "engagement": { "id": "…", "title": "Castaway Rescue Retainer" },
  "deliverable": { "id": "…", "title": "Signal fire maintenance" },
  "envelope": { "band": "over", "overage_at_least": 50000, "currency": "USD" },
  "metric_basis": "contract_consumption",
  "revenue_basis": "contract_value",
  "confidence": 0.91,
  "actions": ["map_to_deliverable", "record_absorbed_cost", "raise_change_order", "override"]
}
```

`overage_at_least` is the **quantized** overage rounded up to `overage_bucket_amount` (2.4 point 3), so `proposed_amount - overage` no longer recovers `envelope_remaining`, and probing a freshly confirmed deliverable no longer recovers `contract_value` exactly. A `burn.financials.read_all` holder additionally receives `envelope.amount`, `envelope.consumed`, `envelope.remaining`, the exact `overage_amount`, and `cite`. A `needs_mapping` verdict returns `actions: ["map_to_deliverable", "dismiss"]` and `enforced: false`.

Four actions on a deny. A block that offers no path forward is a wall; a block that offers four is a decision point.

---

## 6. API surface

Base path `/burn/api/`, routes under `/v1`, mirroring `apps/basis-api/src/server.ts:88`. Success `{ data }`; errors the canonical envelope from `@bigbluebam/logging` `createErrorHandler`. Cursor pagination, `?filter[field]=value`, `?sort=-field`. Shapes in `packages/shared/src/schemas/burn.ts`, with the money block a **discriminated union on `metric_basis`** (1.2.2).

**Two cross-cutting rules bind every row below.** (a) Every response carrying a work-item or attribution projection passes through the single shared **`redactFinancialFields(row, viewerCaps)`** serializer (2.4 point 2); flooring is never per-route. (b) Every response carrying a dollar or derived percentage carries `metric_basis`, `revenue_basis`, `cost_rate_coverage_pct`, and `as_of`.

### 6.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/engagements` | List chains | `burn.engagement.read`; **project-scoped (2.4 point 6)**; `contract_value` floored; zero-project chains `read_all` only |
| POST | `/v1/engagements` | Register; accepts `project_ids[]`, `amends_engagement_id` | `burn.engagement.write`; `can_access('bin.asset')` preflight |
| GET | `/v1/engagements/:id` | Detail plus chain rollup | `burn.engagement.read`; project-scoped; cited records `can_access`-filtered **per reader** |
| PATCH | `/v1/engagements/:id` | Update metadata | `burn.engagement.write`; project-scoped |
| DELETE | `/v1/engagements/:id` | Delete | `burn.engagement.delete` (owner/admin); confirm token; refused if it is a chain root with live amendments |
| POST / DELETE | `/v1/engagements/:id/projects[/:projectId]` | Link / unlink | `burn.engagement.write`; project-scoped both sides |
| POST | `/v1/engagements/:id/extract` | Re-run extraction | `burn.engagement.write`; project-scoped; S7 limits |
| GET | `/v1/engagements/:id/burndown` | Series with **engagement and deliverable dated step-ups** | `burn.financials.read`; project-scoped; banded |
| GET | `/v1/deliverables` | List / review queue | `burn.deliverable.read`; project-scoped; **`description` and `cited_span.quote` floored to `read_all` (2.4 point 5)** |
| GET | `/v1/deliverables/:id` | Detail | `burn.deliverable.read`; project-scoped; same flooring |
| PATCH | `/v1/deliverables/:id` | Edit content, set `review_status`, set `lifecycle_status` | `burn.deliverable.write`; project-scoped; **cannot touch `envelope_amount` or `is_active`** |
| **POST** | **`/v1/deliverables/:id/confirm-envelope`** | **Set the envelope and flip `is_active`** | **`burn.envelope.confirm` (owner/admin); a service-account caller writes an `agent_proposals` row instead and `is_active` flips only on `proposal.decided` (2.2.1)** |
| POST | `/v1/deliverables/bulk-confirm-unpriced` | The fast path: confirm N deliverables as **`unpriced`** | `burn.envelope.confirm`; never even-split (2.2.2) |
| GET | `/v1/work-items` | The ledger | `burn.attribution.read`; project-scoped **by the row's own `project_id`**; serializer-redacted |
| GET | `/v1/unscoped` | The queue, **three buckets**, clustered | `burn.attribution.read`; project-scoped; `filter[bucket]`; serializer-redacted; `can_access` per cited record with a hidden count |
| GET | `/v1/queue-health` | Three bucket figures, `pending_review`, awaiting-valuation, inflow vs resolution, oldest age | `burn.attribution.read`; project-scoped; serializer-redacted; carries the "these dollars are not in any envelope" statement |
| GET | `/v1/attributions` | List | `burn.attribution.read`; project-scoped; **serializer-redacted (R2-S3)** |
| POST | `/v1/attributions` | Attribute one item | `burn.attribution.write`; project-scoped |
| PATCH | `/v1/attributions/:id` | Confirm / reclassify / unscope / **non-billable** | `burn.attribution.write`; project-scoped; supersede-then-insert under `FOR UPDATE`; **409 with current state**; writes feedback |
| POST | `/v1/attributions/bulk` | Cluster action | `burn.attribution.write`; capped at 200; **`{ applied, conflicted, failed }` per item** |
| GET | `/v1/rules` | List rules | `burn.attribution.read` |
| POST / PATCH / DELETE | `/v1/rules[/:id]` | Manage rules | **`burn.rule.write` (owner/admin)**; discriminating-key and `match_ceiling_pct` validation (2.3.3) |
| POST | `/v1/precheck` | **The gate** (user-facing) | `burn.precheck.run`; **project-scoped**; `usr:` key; **per-user rate limit + `usr_precheck_daily_cap`**; rows marked `is_calibrating=false` unless `work_ref_id` resolves; quantized overage |
| GET | `/v1/prechecks` | The gate log | **`burn.precheck.read`**; project-scoped; strips `envelope_*` and `clause_ref` without `read_all` |
| POST | `/v1/prechecks/:id/override` | Override with a reason | `burn.precheck.override` (member); project-scoped |
| POST | `/v1/prechecks/:id/label` | Set `advisory_feedback` / `override_reason_code='gate_wrong'` | **`right_call` and `would_have_mapped`: `burn.precheck.run`, own non-enforced row only. `wrong_call` and `gate_wrong`: `burn.precheck.mark_wrong` (owner/admin) (2.4 point 9)** |
| GET | `/v1/variances` | Variance inbox | `burn.variance.read`; project-scoped; `amount` floored; `detail` serializer-redacted |
| PATCH | `/v1/variances/:id` | Acknowledge / resolve / dismiss | **`burn.variance.write`** |
| GET | `/v1/financials` | Per-chain figures | `burn.financials.read`; project-scoped; banded; carries `metric_basis`, `revenue_basis`, `margin_state`, `as_of`, `final`; **suppressed per 2.4 point 17 below the contributor floor** |
| GET | `/v1/financials/accounts` | Firm-wide roll-up | **`burn.financials.read_all` (owner/admin) + the second in-route role guard (2.4 point 1)**; account basis is the **weakest member** |
| GET | `/v1/financials/export` | CSV export | **`burn.financials.read_all` + in-route guard**; header row carries the discriminator |
| GET | `/v1/cost-rates` | List cost rates | **`burn.costrate.read` (owner/admin) + in-route guard** |
| POST / PATCH / DELETE | `/v1/cost-rates[/:id]` | Manage | **`burn.costrate.write` (owner/admin) + in-route guard**; a write **enqueues `burn-revalue`** |
| POST | `/v1/change-orders` | Draft a change order | `burn.changeorder.draft` |
| GET | `/v1/change-orders/:id` | Fetch the drafted body | `burn.changeorder.draft`; **project-scoped and serializer-redacted (R2-S3/S4)** |
| GET | `/v1/calibration` | Standing against all seven preconditions, plus coverage | `burn.settings.read` |
| GET | `/v1/settings` | Org settings | `burn.settings.read` |
| PATCH | `/v1/settings` | Update, **including `gate_mode`** | `burn.settings.write` (owner/admin) + in-route guard; **server-side 5.4 check on promotion**; `llm_provider_id` org ownership validated |
| POST | `/v1/internal/precheck` | Gate call from bill-api | `INTERNAL_SERVICE_SECRET`, rejecting unconditionally when empty; `svc:` namespace; **org derived from the validated payload and the RLS GUC set in the same transaction (2.4 point 14)** |
| POST | `/v1/internal/prechecks/:id/outcome` | bill-api's post-commit callback | `INTERNAL_SERVICE_SECRET` |
| POST | `/v1/internal/events` | Ingest from bolt-api | same; org from the payload; sets the GUC in-transaction |
| GET | `/health` / `/health/ready` | Probes | `@bigbluebam/service-health`, `healthCheckPlugin` with `service: 'burn-api'` and `checks: { postgres, redis }`, mirroring `apps/bulwark-api/src/server.ts:96` |

**Health route names, verified.** `packages/service-health/src/index.ts` registers `GET /health` at **`:63`** and `GET /health/ready` at **`:67`** (the round-2 draft cited `:62`/`:66`, off by one; `/metrics` at `:84` is correct but Burn no longer uses it). **There is no `/readyz` anywhere in the platform**, though CLAUDE.md documents one. Compose healthcheck and the `services.mjs` entry both use **`/health`**.

**Deferred fail-open outcome.** On the fail-open path bill-api has no `precheck_id` to call back with, so it stamps the created expense with a `burn_gate` marker (`unavailable` or `not_configured`) in its own row metadata, which `burn-variance-sweep` reads on recovery to raise `ungated_charge` against **real rows** rather than a bare count.

### 6.2 Realtime (`/burn/ws`)

Redis PubSub, refs and coarse bands only, **project-scoped fan-out**. Rooms keyed per `(org, project)`; a frame is delivered only when the subscriber passes the 2.4 point 6 predicate for a project linked to the frame's chain. Frames carrying `read_all`-floored information go to owner/admin subscribers only.

**Frames are advisory-only.** The client **refetches the affected TanStack Query keys on reconnect** rather than replaying; no frame is load-bearing for correctness. The membership check on fan-out is served from the **Redis-cached `PermissionContext`** (`@bigbluebam/permissions`), not a DB round-trip per frame per subscriber.

Frames: `unscoped.detected { work_item_id, engagement_id, bucket, band }`, `precheck.decided { precheck_id, verdict, engagement_id }`, `variance.detected { variance_id, kind, severity, engagement_id }`, `attribution.reviewed { attribution_id, state }`, `gate.mode_changed { mode, reason }`. No client names, no clause text, no dollars.

---

## 7. Frontend

`apps/burn/`, React 19 SPA at `/burn/`, structured like `apps/bulwark/`. TanStack Query v5, Zustand, `@bigbluebam/ui`, `@bigbluebam/bureau-client`, TailwindCSS v4, Motion, and `useCan` from the generated `@bigbluebam/permissions` codegen for every permission-conditional control.

### 7.1 Portfolio Board (`/burn/`)

One card per **chain**, grouped by Braid-resolved client. Contract value, attributed, the three unscoped buckets, a burn bar, a status chip (`healthy` / `at_risk` / `overrun` / `silent` / `unlinked`), and the headline figure **labeled from `metric_basis` and `revenue_basis`**, with `margin_state='in_progress'` shown on an unfinished fixed-fee chain (1.2.1). Coverage percentage beside it. Below the contributor floor the cost figures are **absent, not banded** (2.4 point 17). The "All accounts" toggle appears only for `read_all` holders and is **absent** otherwise.

A persistent **queue-health strip**: the three bucket figures, the `pending_review` figure, "N items awaiting valuation", and the sentence "these dollars are not in any envelope."

Components: `ChainCard`, `BurnBar`, `MetricBasisLabel`, `AccountGroup`, `QueueHealthStrip`, `UnlinkedBanner`, `ContributorFloorNotice`.

### 7.2 Unscoped Queue (`/burn/unscoped`)

**Three named buckets, three separate figures, never summed** (2.3.8): "Sold by nobody" (`no_matching_deliverable`), "Unclassified" (`low_confidence`, with `aged_out` on its own tab), and "Outside any tracked contract" (`no_active_engagement`, `outside_engagement_window`, `restatement_unmatched`). Clustered by task tree and normalized title signature. Keys: `a` attribute, `c` confirm, `u` mark unscoped, `n` mark non-billable, `o` raise change order, `r` create a rule from this cluster (opens the rule editor prefilled; **visible only to `burn.rule.write` holders**).

Components: `BucketTabs`, `ClusterGroup`, `UnscopedRow`, `DeliverablePicker` (shows the envelope band and an "unpriced" badge per option), `ConfidenceBadge`, `NonBillableMenu`, `BulkActionBar` (renders per-item `applied` / `conflicted` / `failed`), `HiddenByPermissionsNotice`.

### 7.3 Engagement detail (`/burn/engagements/:id`)

Chain-aware. Deliverable ledger with clause cites (quote and description only for `read_all`), per-deliverable burn-down with **both engagement-level and deliverable-level dated step-ups**, the work-item ledger with source deep links, and the variance list. Three per-deliverable states are distinct and visible: **"Envelope unconfirmed"**, **"Envelope unpriced"**, and confirmed-and-priced. Only the third gates.

Components: `ChainTimeline`, `DeliverableTable`, `EnvelopeConfirmDialog` (**shows the verified quote beside the extracted number**; rendered only to `burn.envelope.confirm` holders), `CitedSpanPopover`, `BurndownChart`, `WorkItemLedger`.

### 7.4 Gate Console (`/burn/gate`)

Mode per class with the three kill switches; the promotion wizard showing live standing against **all seven** preconditions plus the mandatory review of the last 20 advisory denies; the "advisory is a complete product" statement; the precheck log; **gate coverage** distinguishing `gate_not_configured` from `gate_unavailable`; and the auto-demotion banner naming which of the two triggers fired and the contributing rows.

**The advisory-feedback control lives here** for the labeling values. On the Bill side (7.8) the member sees only the two non-scoring options plus "flag for review".

Components: `GateModeSwitch`, `PromotionWizard`, `CalibrationPanel`, `CoveragePanel`, `PrecheckLogTable`, `AdvisoryLabelControl` (admin), `OverrideDialog`.

### 7.5 Variance and change-order inbox (`/burn/variances`)

Severity-ordered, with the drafted change order inline. Approve routes into the standard platform proposal flow.

### 7.6 Cost rates (`/burn/settings/cost-rates`)

Owner/admin only, behind both the permission and the in-route role guard. Effective-dated rates per user and project, with a coverage readout: "cost rates cover 62 percent of attributed hours; margin is reported for those, consumption for the rest." Saving **enqueues `burn-revalue`** and the screen says so, because the whole point of this screen is that existing work items get revalued.

### 7.7 Settings and rules (`/burn/settings`, `/burn/settings/rules`)

Thresholds clamped in the UI to the same bands the DB `CHECK`s enforce. The rule editor is `burn.rule.write`-gated, rejects a match with no discriminating key inline, offers **glob or substring only** for `title_pattern`, and shows a live "this rule would have matched N of the last 200 items (X percent)" preview against `match_ceiling_pct`.

### 7.8 The one Bill SPA change (round-2 R2-I8a)

The inline advisory note and the member-facing feedback control render inside **`apps/bill/`**, which the round-2 draft's build inventory never listed. It is named here and in Section 9.4: `apps/bill/` gains a `BurnGateNotice` component rendered on the expense create and approve flows, showing the verdict note, the four actions on a deny, and exactly two labeling options plus "flag for review". The Bill SPA is built by the same `apps/frontend/Dockerfile`, so no new build stage is needed, but **the Bill SPA is a changed app and must be rebuilt.**

---

## 8. Background work, events, and integration

### 8.1 Worker jobs

Registered in `apps/worker/src/worker.ts` following the Bulwark block at `:2207-2260`. Repeatable jobs use `upsertJobScheduler`, whose real precedent is the **basis** block around `apps/worker/src/worker.ts:691-724` (the round-2 draft cited `:673-679`, which is `bearingSnapshotWorker` event handlers). Each job is a thin HTTP caller with **its own generous `AbortController` deadline distinct from `LLM_TIMEOUT_MS`**, following `apps/worker/src/jobs/bulwark-proposal-reconcile.job.ts:48`.

**Every "lock" below is a Postgres transaction-scoped advisory lock held inside burn-api's sweep transaction (4.0), not a Redis lock and not a BullMQ concurrency setting.**

| Queue | Schedule | Concurrency / lock | Purpose |
| --- | --- | --- | --- |
| `burn-extract-deliverables` | on demand | per-engagement xact lock | 4.1 |
| `burn-attribute-batch` | on demand + every 2 min | **`concurrency: BURN_ATTRIBUTE_CONCURRENCY` (2)**, per-org xact lock, row claims with **lease renewal**, `limiter: { max: 30, duration: 60000 }` | 4.2 |
| `burn-claim-reaper` | every 5 min | `concurrency: 1`, **iterates orgs setting the GUC per org (2.4 point 14)** | returns genuinely cold claims to `pending` |
| `burn-variance-sweep` | every 30 min | per-org xact lock; flushed per-org and per-N-item progress logs | 4.3 plus the three reconcile passes |
| `burn-revalue` | on cost-rate write + nightly | per-org xact lock | 4.5; **zero LLM calls**, never re-classifies |
| `burn-silent-deliverable-sweep` | daily 03:00 UTC | per-org xact lock | 4.4 |
| `burn-rollup-refresh` | hourly + on demand | per-org xact lock | one idempotent upsert per chain; **skips `frozen_at IS NOT NULL`** |
| `burn-calibration-recompute` | daily 04:00 UTC | per-org xact lock, **iterates orgs** | 5.4 / 5.6; drains the coverage counters; both demotion triggers |
| `burn-proposal-reconcile` | every 15 min | `concurrency: 1` | per `braid-proposal-reconcile.job.ts` |
| `burn-retention` | daily 05:00 UTC | per-org xact lock, **iterates orgs** | purges per settings; **sets `frozen_at` on any rollup whose chain it purges** |
| `burn-embed-sync` | registered, **scheduled off** | | behind `embedding_enabled` |

10 job families plus the reaper.

**Retention never rewrites history.** `burn-retention` exempts work items whose chain is not `closed`; for closed chains it **sets `frozen_at`** on the rollup, and both the hourly refresh and the on-miss compute skip frozen rows (3.1). Never purged at all: enforced, overridden, labeled, or superseded prechecks; `burn_classifier_feedback`; `burn_extraction_runs`.

### 8.2 Bolt events published (source `burn`)

Via `publishBoltEvent(eventType, 'burn', payload, orgId, actorId?, actorType?)`, the positional signature at `packages/shared/src/bolt-events.ts:34-41`. Registered in a new `burnEvents` block in `apps/bolt-api/src/services/event-catalog.ts` (`bulwarkEvents` is at `:2939`, `ALL_EVENTS` at `:3025`, the spread at `:3046`).

**No payload carries a dollar amount or a percentage.** Bolt is org-level with no per-rule visibility (`preflightBoltRule`, `visibility.service.ts:1131-1150`, gates on org match alone), and `GET /bolt/api/v1/events/recent` is gated on `requireAuth` plus a non-enforcing `shadowOnly(...)`. For this app the magnitude **is** the secret. Payloads carry refs plus a coarse band. `burn.*` outbound-webhook subscriptions require org-admin authorship.

**The `EventDefinition` shape the drift guard actually requires (round-2 R2-B7).** `scripts/check-bolt-catalog.mjs` parses with a regex having a **300-character window between `source:` and `event_type:`**. A block with long multi-line descriptions placed before `event_type` pushes the pair outside that window and the guard reports a **present** event as undeclared. Therefore each of the ten entries is authored on the `bulwarkEvents` model at `event-catalog.ts:2940-2960`: **`source:` first, `event_type:` immediately after and within 300 characters**, then `description`, then a fully typed `payload_schema` array. The same rule applies to the two backfilled `billEvents`.

| `event_type` | When | Payload (refs + bands only) |
| --- | --- | --- |
| `engagement.extracted` | extraction completes | `engagement.id`, `chain_root_id`, `deliverables_extracted`, `low_confidence_count` |
| `deliverable.extracted` | a deliverable persists | `deliverable.id`, `engagement.id`, `deliverable_kind`, `confidence`, `review_status` |
| `work.unscoped` | an item lands unscoped above the floor | `work_item.id`, `engagement.id`, `bucket`, `reason`, `source_type`, `band` |
| `precheck.blocked` | an enforced deny | `precheck.id`, `engagement.id`, `deliverable.id`, `verdict_reason`, `band` |
| `precheck.overridden` | a deny is overridden | `precheck.id`, `override_reason_code`, `band` |
| `gate.demoted` | auto-demotion fires | `org.id`, `from_mode`, `to_mode`, `trigger`, `window_days` |
| `gate.coverage_degraded` | coverage below the floor | `org.id`, `coverage_pct_band`, `window_days`, `cause` (`unavailable` \| `not_configured`) |
| `variance.detected` | a variance is raised | `variance.id`, `engagement.id`, `variance_kind`, `severity` |
| `deliverable.silent` | inverse check fires | `deliverable.id`, `engagement.id`, `due_date`, `days_remaining` |
| `consumption.threshold_crossed` | chain consumption crosses a band | `engagement.id`, `chain_root_id`, `band` |

10 events. Plus two new **`bill`** events published from `apps/bill-api/src/routes/expenses.routes.ts`: `expense.created` and `expense.approved`.

**The drift guard is not in CI, and this build wires it.** `check:bolt-catalog` exists at `package.json:35` but grepping `.github/workflows/*.yml` returns nothing; CLAUDE.md's claim that it is "the CI drift guard" is stale. This build **adds a `check:bolt-catalog` step to `.github/workflows/lint.yml`** next to `check:permission-catalog` (`:49`).

### 8.3 Events Burn subscribes to

A `burn-dispatch-hook.ts` in bolt-api, called alongside `dispatchToBraid` and the Bulwark hook in `apps/bolt-api/src/routes/event-ingestion.routes.ts`, forwarding to `${BURN_API_INTERNAL_URL}/v1/internal/events`, gated by a per-org Redis binding **set** on the `apps/bulwark-api/src/services/gate.service.ts` shape. **This is the one place that citation is genuinely right**: it is a `SADD` / `SISMEMBER` advisory cache over a durable table, exactly what Burn needs here, and its own header's warning against hardening it into a two-phase commit applies to Burn too.

Subscribed: `bam:task.created`, `task.updated`, `task.moved`, `task.assigned`, `task.completed`, `bam:sprint.completed`, `helpdesk:ticket.created`, `ticket.replied`, `bill:invoice.created`, `invoice.finalized`, `recurring.invoice_generated`, `bill:expense.created` (new), `bill:expense.approved` (new), `bond:deal.won`, and `banter:message.posted` when enabled.

**Durability.** Every subscribed event corresponds to a persistent source row, so the three reconcile passes (2.3.2C) recover anything dropped on the bolt-api hop, converging on the same live row. Burn does not depend on a bolt-api sending-end outbox.

**On `task.updated` volume:** because neither epoch takes `updated_at` and `bam.task` no longer hashes `time_logged_minutes` (2.3.1), a board drag or a time-entry insert resolves to unchanged epochs and short-circuits at one index probe. Subscribing to a chatty type is cheap **by construction**.

### 8.4 entity_links, unified activity, search

`entity_links` upserts on engagement register (`burn.engagement -> bond.company`, `-> bin.asset`, `-> bill.client`) and on confirmed attribution (`burn.deliverable -> <source_type>`), `ON CONFLICT DO NOTHING`. Burn flows into unified activity through the Bolt events, not the fixed `v_activity_unified` UNION (bam/bond/helpdesk only), matching Braid and Bulwark. A `search_everything` provider is a fast-follow.

### 8.5 Braid integration

A ported `braid-resolve.client.ts` (`apps/bulwark-api/src/lib/braid-resolve.client.ts`) calling `POST /v1/internal/resolve` with the internal secret and the caller's `asker_user_id`. Soft dependency: an absent URL, a missing asker, or any non-2xx degrades to the raw `bond.company` id and never fails the create.

---

## 9. Infrastructure

### 9.1 New api compose service

`burn-api` in `docker-compose.yml`, modeled on the `bulwark-api` block: `PORT: 4022`, stateless. Per-request RLS GUC binding per 2.4 point 14 (**not** a copy of the four existing plugins). `depends_on`: `migrate` (`service_completed_successfully`), `postgres` and `redis` (`service_healthy`) only.

Env: `DATABASE_URL`, `DATABASE_READ_URL`, `REDIS_URL` / `REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, **`BILL_API_INTERNAL_URL=http://bill-api:4014` (REQUIRED, per 2.3.1.2)**, `BRAID_API_INTERNAL_URL` (optional), `QDRANT_URL` / `QDRANT_API_KEY` (optional), `CORS_ORIGIN`, `NODE_ENV`, `HOST`, `LOG_LEVEL`, `LLM_TIMEOUT_MS`, `UPSTREAM_TIMEOUT_MS`, `MAX_DOC_BYTES`, `MAX_DOC_PAGES`, rate-limit knobs, and:

**`BBB_PERMISSIONS_ENFORCE: on`, set literally, not `${...:-warn}`, and asserted at boot.** burn-api reads the resolved value on startup and **exits non-zero with a named error if it is anything other than `on`**. Compose default is `warn` on every other service (`docker-compose.yml:125`, `:204`, `:469`, and so on) and `packages/permissions/src/index.ts:291` is `if (opts.mode === 'warn') return;`, so a `warn`-mode burn-api would serve per-person compensation and firm-wide profitability to any member (2.4 point 1).

Healthcheck: `curl -sf http://localhost:4022/health`.

### 9.2 bill-api wiring

- **`BURN_API_INTERNAL_URL`** (optional; unset means the gate is absent and every expense posts normally), **`BURN_PRECHECK_TIMEOUT_MS`** (default 800), **`BURN_PRECHECK_BREAKER_THRESHOLD`** (default 5), **`BURN_PRECHECK_BREAKER_PROBE_MS`** (default 30000), all four in the bill-api compose env, in `bill-api.env.optional` in `services.mjs`, in `env-hints.mjs` (9.6.2), and in `.env.example`.
- `apps/bill-api/src/lib/burn-precheck.client.ts`: `AbortController` on `BURN_PRECHECK_TIMEOUT_MS`; the Redis circuit breaker of 5.5.1 with a shared atomic counter and `NX` probe election; the coverage counters of 5.5.2 incremented on **every gated write attempt including the unconfigured no-op**; **every Redis touch wrapped and non-throwing** with an in-process fallback (5.5.3); and **`allow` on every error path**.
- The `burnPrecheck` preHandler on the four hook points in 5.2.
- Two `publishBoltEvent` calls (`expense.created`, `expense.approved`).
- **`POST /internal/rates/resolve`** delegating to `resolveRate` (`apps/bill-api/src/services/rate.service.ts:117`), guarded by `INTERNAL_SERVICE_SECRET`.
- The internal line-item write path accepting **`acting_user_id`** in the body, recording it on the row and publishing it in the Bolt event (2.4 point 11).
- One breaker check per job in `apps/worker/src/jobs/bill-recurring-generate.job.ts` (the serial loop is at `:367`).

### 9.3 Worker wiring

`BURN_API_INTERNAL_URL` and `BURN_ATTRIBUTE_CONCURRENCY` in the worker compose env and `worker.optional`; `BBB_API_INTERNAL_URL` is already present (added by the Braid build at `docker-compose.yml:258`). Queues registered per 8.1, repeatable ones via `upsertJobScheduler` on the basis pattern at `apps/worker/src/worker.ts:691-724`. Byte reads via `@bigbluebam/storage`; `BIN_API_INTERNAL_URL` is added nowhere.

### 9.4 SPA build, and the changed apps

`apps/frontend/Dockerfile` in four sites mirroring the bulwark lines: deps-stage `COPY apps/burn/package.json ./apps/burn/`; the build-stage source COPY block; `&& pnpm --filter @bigbluebam/burn build`; and production `COPY --from=build /app/apps/burn/dist /usr/share/nginx/html/burn`.

**`apps/bill/` is also a changed app** (7.8, the `BurnGateNotice` component). It is built by the same Dockerfile so no new stage is needed, but it must be rebuilt.

### 9.5 nginx routing

Edit only the two source configs (`infra/nginx/nginx.railway.conf` is generated by `scripts/gen-railway-configs.mjs`):
- `infra/nginx/nginx.conf`: `/burn/` alias plus SPA fallback, `/burn/api/ -> http://burn-api:4022/`, `/burn/ws -> http://burn-api:4022/ws` with upgrade headers.
- `infra/nginx/nginx-with-site.conf`: the same three blocks.
- **Static-asset alternation:** add `burn` to **both** source files. Verified drift: `nginx.conf:728` includes `bill`; `nginx-with-site.conf:806` and the generated `nginx.railway.conf:942` do **not**; none of the three includes `bay` or `blip`. The pre-existing `bill` / `bay` / `blip` omission is a tracked task; this build adds `burn` to both and does not unilaterally reconcile the rest.
- Then `node scripts/gen-railway-configs.mjs`. Do not hand-edit `:8080` or the `$rw_upstream_NN` index.

**`frontend.depends_on` (round-2 R2-I8c).** Adding `burn-api: service_healthy` lets the newest service block ingress for all 22 SPAs. Verified: `bulwark-api`, `basis-api`, and `braid-api` **are** in that list (`docker-compose.yml:284-326`) while `bill-api` and `bureau-api` are deliberately absent, so the precedent is mixed. **Burn follows the freshest satellite precedent and adds `burn-api`**, and the tradeoff is stated: an unhealthy burn-api will hold ingress on a cold `docker compose up`. An operator who prefers ingress availability over SPA-asset completeness should remove that one entry; nothing in Burn depends on its presence.

### 9.6 Deploy catalog, MCP, launchpad, docs

- `scripts/deploy/shared/services.mjs`: a `burn-api` `APP_SERVICES` block (port `4022`, **`healthcheck: '/health'`**, matching the bulwark block whose `healthcheck` line is at **`:297`** and whose entry begins at `:292`; the round-2 draft cited `:298`). `public_paths: ['/burn/api/','/burn/ws']`. Required env: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `BBB_API_INTERNAL_URL`, `BOLT_API_INTERNAL_URL`, `BILL_API_INTERNAL_URL`, `BBB_PERMISSIONS_ENFORCE`. Optional: `DATABASE_READ_URL`, `BRAID_API_INTERNAL_URL`, `QDRANT_URL`, `CORS_ORIGIN`, `LOG_LEVEL`, `MAX_DOC_BYTES`, `MAX_DOC_PAGES`.
  **`burn-api.needs = ['postgres','redis','api','bolt-api']`.** `bill-api` is **not** in `needs` (round-2 R2-I8b): `services.mjs:292-304` shows bulwark-api deliberately omitting its request-time deps for exactly this reason, and burn and bill are **mutually** request-time dependent, so listing either in the other's `needs` risks a cycle. The acyclic invariant is held by keeping both services' compose `depends_on` at `migrate` / `postgres` / `redis` only.
  Add `/burn/` to the `frontend` entry's `public_paths`.
- MCP: `BURN_API_URL: http://burn-api:4022/v1` in the docker-compose `mcp-server` block (mirroring `BULWARK_API_URL` at `docker-compose.yml:189`) **and** in `mcp-server.env.optional`. Do not add `burn-api` to `mcp-server.needs`. Register `burn-tools.ts` in the MCP bootstrap.
- bolt-api: `BURN_API_INTERNAL_URL=http://burn-api:4022` in its compose env and catalog.
- `node scripts/gen-railway-configs.mjs` to regenerate `nginx.railway.conf` and emit `railway/burn-api.json`.
- **Launchpad**: `'burn'` in `LAUNCHPAD_APP_IDS` (after `'bulwark'` at `apps/api/src/routes/system-settings.routes.ts:63`) and a `LAUNCHPAD_CATALOG` entry `{ id: 'burn', name: 'Burn', description: 'Scope and Margin', icon_name: 'flame', color: '#ea580c', path: '/burn/' }` (after `:101`). Not in `ROOT_REDIRECT_VALUES`. `flame` is absent from `ICONS` in `packages/ui/launchpad.tsx:65`, so add `import { Flame } from 'lucide-react'` and `'flame': Flame`, else it falls back to `Box` at `:226`.

#### 9.6.1 The full docs pipeline, not just `help.md` (round-2 R2-B6)

Adding `'burn'` to `LAUNCHPAD_CATALOG` trips three CI guards, because `scripts/docs/build-manual.mjs:78-85` derives its roster **directly from `LAUNCHPAD_CATALOG`** and `.github/workflows/lint.yml:58` runs `pnpm docs:manual:check` on committed-file drift. And `scripts/docs/extract.mjs:42-65` holds a **hardcoded** `APP_REGISTRY` (verified: `bulwark` is its last app row before `helpdesk`), so without an entry `pnpm docs:extract` never emits `docs/apps/burn/` at all.

`docs/apps/bulwark/` ships `guide.md`, `help.md`, `help-index.json`, `mcp-tools.md`, `meta.json`, and `screenshots/`. The full obligation:

1. `burn: { nginxPath: '/burn/', apiPort: 4022, apiDir: 'burn-api', appId: 'burn' }` in `APP_REGISTRY` at `scripts/docs/extract.mjs:63`, after the `bulwark` row.
2. Author `docs/apps/burn/`: `meta.json`, `guide.md`, `help.md`, `mcp-tools.md`, `marketing.md`, and `screenshots/` (gilligan only).
3. `pnpm docs:extract`, `pnpm docs:compose`, `pnpm help:index`, `pnpm docs:catalog`, `pnpm docs:manual`, `pnpm docs:publish`. `scripts/docs/publish.mjs:428-435` discovers apps by scanning `docs/apps/*/meta.json` and copies `marketing.md` to **`site/src/content/apps/burn.md`**, which is the named artifact behind "add a Burn section to the marketing site".
4. Commit `site/src/content/docs-catalog.generated.json` and `site/src/content/manual.generated.json`.
5. `burn: ['burn-tools']` in `APP_TOOL_MODULES` at `scripts/docs/lib/tool-source.mjs:85`.
6. **Rebuild the frontend image after `help:index`**: `apps/frontend/Dockerfile:232` `COPY docs/apps/` is what serves `help-index.json` to the in-app Help Center at runtime.

**`site/src/pages/docs.tsx`:** the app and tool **lists** are generated and must not be hand-coded, but the one sanctioned edit is an icon and color for the new id in `APP_ICON` / `APP_COLOR` (bulwark's entries are at `:73` and `:98`). Add exactly one `Flame` entry and one orange pairing.

- **Surface map**: update `docs/reference/mcp-endpoint-mapping.md` in the same change; zero bare dashes in the MCP column.
- **CLAUDE.md**: append the `burn-api` (internal :4022, `/burn/api/`) and `burn` SPA inventory lines, route rows, worker job names, and the MCP tool count.

#### 9.6.2 Railway variables go in `ENV_HINTS`, not a markdown file (round-2 blocker R2-I1)

`railway/env-vars.md` is **generated** by `scripts/gen-railway-configs.mjs:543` from `hintFor()` in `scripts/deploy/shared/env-hints.mjs`, which returns `{ kind: 'unknown' }` for any unlisted variable (`:325`). In `scripts/deploy/shared/railway-orchestrator.mjs`, `unknown` resolves to **SKIP** (`:125-131`); an **optional** var is then silently omitted (`:157-159`) and a **required** var **throws** (`:149-152`), aborting the deploy. Concretely, without hints:

- `BURN_API_INTERNAL_URL` is optional on bill-api, so on Railway it would never be set, the preHandler would no-op per Burn's own "an unset URL means the gate is absent", and **the flagship gate would not exist in production with no signal anywhere.** (5.5.2's `gate_not_configured` counter is the second line of defense; this hint is the first.)
- `BURN_API_URL` optional on mcp-server would leave all 17 tools on a localhost default, verbatim the recorded Banter/Bureau/Blueprint incident documented at `env-hints.mjs:202-209`.

Add to the inter-service block in `env-hints.mjs`:

```js
BURN_API_INTERNAL_URL:  { kind: 'computed', value: internal('burn-api') },
BURN_API_URL:           { kind: 'computed', value: `${internal('burn-api')}/v1` },
BILL_API_INTERNAL_URL:  { kind: 'computed', value: internal('bill-api') },
BOLT_API_INTERNAL_URL:  { kind: 'computed', value: internal('bolt-api') },
BURN_PRECHECK_TIMEOUT_MS:        { kind: 'literal', value: '800' },
BURN_PRECHECK_BREAKER_THRESHOLD: { kind: 'literal', value: '5' },
BURN_PRECHECK_BREAKER_PROBE_MS:  { kind: 'literal', value: '30000' },
BURN_ATTRIBUTE_CONCURRENCY:      { kind: 'literal', value: '2' },
```

**`BOLT_API_INTERNAL_URL` is a live pre-existing bug this build fixes.** Verified: it has **no** `ENV_HINTS` entry today, and `services.mjs` lists it as **required** on bulwark-api, so `buildServiceVariables` throws for bulwark-api on Railway before the service is created. Burn cannot list it as required without hitting the same wall, so the hint is added here and the pre-existing bulwark exposure is flagged.

**Add a coverage test** alongside `scripts/deploy/shared/railway-orchestrator.test.mjs` asserting that **every** name in **every** `APP_SERVICES[].env.{required,optional}` resolves to a non-`unknown` hint. That test is what stops the next app from reproducing this.

Also add the three new bill-api vars to **`.env.example`**.

### 9.7 Resource sizing, and the LLM concurrency cap as a deliverable

`docker-compose.yml` runs a **single** `worker` with `WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-5}` across roughly 54 queues plus 28 scheduled jobs, and there is **no `deploy.replicas`, `mem_limit`, or `cpus` anywhere in the file**, nor any replica field in the `services.mjs` catalog.

- **Replica count is an operator instruction, not a compose change.** "burn-api at 2 replicas" is set in the Railway dashboard; Burn does **not** introduce a `deploy.replicas` key, because doing so would set a precedent for 22 services in one unrelated PR. Stated plainly rather than left as an unactionable number.
- **DB pool: 10 per burn-api replica.**
- **`BURN_ATTRIBUTE_CONCURRENCY`** (default 2) bounds in-flight attribution batches independently of `WORKER_CONCURRENCY`.
- **Split the worker** into a second container when `burn-attribute-batch` depth stays above 500 for an hour, or when non-Burn scheduled jobs miss their cadence.
- **Redis sizing:** the single `redis` runs at `--maxmemory 256mb --maxmemory-policy noeviction` (`docker-compose.yml:29-40`), where writes **error out** at the cap by design. Burn adds breaker keys, two counter keys per org per day, the bindings set, and 11 queues. **Raise `--maxmemory` to 512mb when the stack exceeds 20 active orgs or when `INFO memory` shows `used_memory` above 60 percent of the cap.** 5.5.3 makes every Burn Redis touch non-throwing so a cap breach degrades rather than blocking money.
- **The `api` container is the contended one and is now sized here.** `POST /internal/llm/chat` lives on **api**, which is also the permission resolver every satellite calls, so Burn's per-org LLM load contends with the request path of all 22 other apps.

#### 9.7.1 The internal LLM concurrency cap is a specified deliverable of this build (round-2 R2-I7)

The round-2 draft called the cap "a prerequisite, not a fast-follow" in Section 9.7 and then left it in Open Question 8 as "decision needed on whether the cap lands before Burn ships". **An autonomous build reads an open question as optional.** It is moved here with a mechanism and a done criterion, because `apps/api/src/routes/internal-llm.routes.ts` today has no rate limit, no semaphore, no queue, and no concurrency guard of any kind.

- **Mechanism:** a **Redis token bucket keyed per calling service** (`llm:bucket:<service>`) in front of the `/internal/llm/chat` handler, using the same `SET ... PX ... NX` primitive family as `apps/bill-api/src/services/sequence.service.ts:50`. Default `LLM_INTERNAL_MAX_CONCURRENT_PER_SERVICE=4` and `LLM_INTERNAL_RATE_PER_MINUTE=120`, both env-configurable, both registered in `env-hints.mjs` and `.env.example`.
- **Response on exhaustion:** HTTP **429 with `Retry-After`**.
- **Client behavior on 429, defined:** `burn-attribute-batch` defers the item to **`pending_attribution`**, never `unscoped`, so throttling can never manufacture a scope-creep finding. Extraction retries the chunk from its checkpoint.
- **Done criterion:** a test in which one service saturates its bucket and a second service's `/internal/llm/chat` call still succeeds within its own budget.

### 9.8 Ordered rollout, two migrate passes, all changed services rebuilt

The `migrate` sidecar is cached via `service_completed_successfully` and does **not** re-run on a later `docker compose up -d <service>`, so a naive first start of burn-api would hit a database with no `burn_*` tables.

```sh
# ── Pass 1: core schema ────────────────────────────────────────────
pnpm lint:migrations
docker compose run --rm migrate                 # applies 0239-0241
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "\d burn_work_items"

# ── Pass 2: permissions, in the ONLY safe order (3.4.1) ────────────
node scripts/generate-permission-manifest.mjs
node scripts/build-permission-codegen.mjs        # commit permissions.ts
node scripts/check-permission-catalog.mjs
node scripts/build-permission-delta.mjs          # ASSIGNS NNNN
# author NNNN+1_burn_builtin_group_defaults.sql only now
pnpm lint:migrations
docker compose run --rm migrate
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 6;"
# and the 3.4.1 group-defaults probe: owner 22, admin 22, member 14, viewer 7, guest 0

# ── Build EVERY changed service, burn-api first ────────────────────
docker compose build burn-api bill-api bolt-api worker mcp-server api frontend
docker compose up -d --force-recreate burn-api bill-api bolt-api worker mcp-server api frontend

# ── Negative verification ──────────────────────────────────────────
docker compose exec bill-api env | grep BURN_      # expect all four vars
# then POST an expense and assert a burn_prechecks row exists
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "SELECT verdict, verdict_reason, mode_at_decision FROM burn_prechecks ORDER BY created_at DESC LIMIT 1;"
```

Round 2 was right that the round-2 draft built only `burn-api` and `frontend` while Section 9.2 changes **bill-api**, 9.3 changes **worker**, 8.3 and 9.6 change **bolt-api**, and 9.6 changes **mcp-server** and **api** (`LAUNCHPAD_CATALOG`, `SUPPORTED_ENTITY_TYPES`). The sequence looked complete and produced a stack where the flagship feature was silently absent.

**For a Railway deploy the migrations must be on disk before the burn-api image is built**, because production bakes them in via `apps/api/Dockerfile` rather than bind-mounting.

---

## 10. Seed data plan (GILLIGAN, per the hard rule in CLAUDE.md)

**Gilligan Travel Ltd is the services firm**; the Howells are the client who keeps asking for things nobody sold.

**Two registration edits, verified:**
1. **`scripts/seed-all.mjs`**: `PHASE_B` is a flat array at `:82-95` iterated at `:272`. Add `'seed-burn.mjs'` after `'seed-bill.mjs'`.
2. **`scripts/seed-gilligan/run-all.mjs`**: a list of **grouped phase objects** at `:60-75`. `bill.mjs` is in **Billing** and `bin.mjs` in **Knowledge & analytics**, so Burn must follow **both**. Add a new trailing group `{ name: 'Margin', files: ['burn.mjs'] }`.

**No precedent claim:** there is no `bulwark.mjs` or `braid.mjs` in `scripts/seed-gilligan/`. Burn establishes the satellite-app gilligan seeder pattern. `.github/workflows/seed-smoke.yml` exercises the path.

**Engagements (4):**
1. *"Howell Luau Production Agreement"* - **fixed fee** $18,000, one project. The flagship: healthy on paper, bleeding through unscoped work. Because it is fixed-fee, it exercises `revenue_basis='contract_value'` and `margin_state='in_progress'` (1.2.1), the exact case whose formula round 2 found inverted.
2. *"Howell Luau Change Order 1"* - an **amendment** with `contract_value_delta` $3,200 **and an amendment deliverable carrying `amends_deliverable_id` + `envelope_amount_delta` $3,200 against the overrun catering deliverable**, so the closed loop (R2-D3) is demonstrable rather than theoretical.
3. *"Castaway Rescue Retainer"* - **retainer**, $4,500/mo, `period_length_days` 30, linked to **two** projects so the many-to-many and the per-row scoping of 2.4 point 6 are both exercised.
4. *"Coconut Supply Chain Assessment"* - not-to-exceed $6,000, one deliverable silent and due in eight days.

**Deliverables (13):** e.g. "Guest list and RSVP management" (2.1, $3,000), "Menu and coconut catering plan" (2.2, $6,500, the overrun target), "Signal fire and ambience" (2.3, $2,500), "Event day coordination" (3.1, $6,000). Each with a real `cited_span.quote`. **Eleven are confirmed and priced; two are seeded `envelope_source='unpriced'`** so the "Envelope unpriced" state and its exclusion from `envelope_overrun` are both visible, and `priced_deliverable_coverage_pct` lands at roughly 85, above the promotion floor.

**Cost rates (6):** for four of the six cast members, deliberately **partial**, so the Portfolio Board shows chains reading "Margin" and chains reading "Contract consumption" side by side with the coverage percentage. The Castaway Rescue chain is deliberately seeded with **three distinct contributors** so it clears `min_contributors_for_cost_aggregate` and the suppression path (2.4 point 17) can be demonstrated by comparison against a single-contributor chain.

**Work items (roughly 150)** derived from existing gilligan Bam tasks, time entries (`scripts/seed-gilligan/bam.mjs`), and Bill expenses (`bill.mjs`), so the ledger is a real join over seeded data. **`bam.task` rows carry `valuation_basis='none'`** and only `bam.time_entry` rows are priced (2.3.1), which the seed asserts so the 2x double count can never silently return. Expenses are seeded with a **mix of `billable=true` and `billable=false`** plus one `status='rejected'`, exercising 2.3.1.1.

**Attributions:** roughly 70 percent attributed, 10 percent `pending_review`, 8 percent `excluded_non_billable` (a retro and a PTO block), and 12 percent unscoped **split across all three buckets** so 2.3.8's three figures are all non-zero. The scope-creep story stays concrete: "Build coconut radio for the Howells" and "Third revision of Mrs. Howell's seating chart" land `no_matching_deliverable` at $1,940.

**Rules (2):** one non-billable rule on the internal retro project, one attributing "signal fire" titles, both with non-zero `match_count` and `last_match_pct` well under `match_ceiling_pct`.

**Prechecks (roughly 30):** the org in **`advisory` mode with 210 `svc:`-namespaced calibrating rows, 16 days of history, 12 labeled advisory denies at 0.96 precision, 0.99 coverage, and 85 percent priced coverage**, so the wizard shows real standing against **all seven** preconditions. Two overrides: one `change_order_pending` linking to engagement 2, one `gate_wrong` non-zero but below both the rate ceiling and the absolute-count floor.

**Variances (7):** `envelope_overrun` on catering, a clustered `unscoped_work`, `silent_deliverable`, `ungated_charge`, `consumption_erosion`, `gate_outage` over a seeded historical window, and one `awaiting_valuation`.

**Feedback (roughly 25 rows)** and **rollups computed for all four chains** so the board never renders from a live aggregate.

Capture recipes in `packages/docs-capture` using the gilligan defaults from `packages/docs-capture/src/environment.ts` (`skipper@gilligantravel.example`). Never the e2e org, never `screenshots-demo`.

---

## 11. MCP surface and permissions

### 11.1 MCP tools

`apps/mcp-server/src/tools/burn-tools.ts` via `registerTool`, client shaped like `dedupe-tools.ts:38`, env `BURN_API_URL=http://burn-api:4022/v1`. Reads and writes that surface or mutate source-scoped records carry `asker_user_id` and fail closed via `can_access`. Not added to `EXPLICIT_TOOL_OVERRIDES`.

| Tool | Backs | Permission | confirm / asker |
| --- | --- | --- | --- |
| `burn_precheck` (**flagship**) | POST `/v1/precheck` | `burn.precheck.run` | `asker_user_id`; project-scoped; quantized overage |
| `burn_attribute` | POST `/v1/attributions` | `burn.attribution.write` | `asker_user_id` |
| **`burn_financials`** | GET `/v1/financials` (and `/accounts` with `read_all`) | `burn.financials.read` | `asker_user_id`; discriminated response |
| `burn_margin` | **deprecated alias for `burn_financials`** | `burn.financials.read` | identical response; **no `margin` key under `contract_consumption`** (1.2.2) |
| `burn_list_engagements` | GET `/v1/engagements` | `burn.engagement.read` | no |
| `burn_get_engagement` | GET `/v1/engagements/:id` | `burn.engagement.read` | `asker_user_id` |
| `burn_extract_deliverables` | POST `/v1/engagements`, `/extract` | `burn.engagement.write` | no |
| `burn_delete_engagement` | DELETE `/v1/engagements/:id` | `burn.engagement.delete` | **confirm** |
| `burn_list_deliverables` | GET `/v1/deliverables` | `burn.deliverable.read` | no; `description` floored |
| `burn_confirm_deliverable` | PATCH `/v1/deliverables/:id` (content and `review_status` only) | `burn.deliverable.write` | `asker_user_id`; **cannot set the envelope or `is_active` (2.2.1)** |
| `burn_reject_deliverable` | PATCH `/v1/deliverables/:id` (`rejected`) | `burn.deliverable.write` | **confirm** + `asker_user_id` |
| `burn_list_unscoped` | GET `/v1/unscoped` | `burn.attribution.read` | `asker_user_id`; serializer-redacted |
| `burn_reclassify_attribution` | PATCH `/v1/attributions/:id` | `burn.attribution.write` | `asker_user_id` |
| `burn_override_precheck` | POST `/v1/prechecks/:id/override` | `burn.precheck.override` | `asker_user_id`; **cannot set `gate_wrong`** |
| `burn_list_variances` | GET `/v1/variances` | `burn.variance.read` | no |
| `burn_draft_change_order` | POST `/v1/change-orders` | `burn.changeorder.draft` | no (the proposal is the HITL) |
| `burn_set_gate_mode` | PATCH `/v1/settings` (`gate_mode` / `gate_paused_until`) | `burn.settings.write` | **confirm when the target WEAKENS enforcement** |
| `burn_calibration_report` | GET `/v1/calibration` | `burn.settings.read` | no |

**17 tools plus one deprecated alias.**

**No-tool enumeration, complete:**
- `PATCH /v1/engagements/:id`, `POST`/`DELETE /v1/engagements/:id/projects` -> skip: metadata and link management, SPA-surfaced.
- **`POST /v1/deliverables/:id/confirm-envelope` and `/bulk-confirm-unpriced` -> skip: deliberately not agent-reachable (2.2.1). This is a security boundary, not an oversight.**
- `GET /v1/engagements/:id/burndown`, `GET /v1/deliverables/:id` -> skip: resolver-done-internally.
- `GET /v1/work-items`, `/v1/attributions`, `/v1/queue-health` -> skip: resolver-done-internally (`burn_list_unscoped` is the agent slice).
- `POST /v1/attributions/bulk` -> skip: UI bulk surface; an agent uses the single-item tool so each decision is individually auditable.
- `GET`/`POST`/`PATCH`/`DELETE /v1/rules` -> skip: **rule authoring can neutralize the gate (2.3.3) and is owner/admin human-only.**
- `GET /v1/prechecks` -> skip: UI surface.
- **`POST /v1/prechecks/:id/label` -> skip: the calibration label drives auto-demotion and is deliberately not agent-writable (2.4 point 9).**
- `PATCH /v1/variances/:id` -> skip: triage is a UI action.
- `GET`/`POST`/`PATCH`/`DELETE /v1/cost-rates` -> skip: compensation data, owner/admin SPA-only.
- `GET /v1/financials/export` -> skip: file download surface.
- `GET /v1/change-orders/:id` -> skip: proposal-inbox fetch path.
- `GET`/`PATCH /v1/settings` beyond `gate_mode` -> skip: SPA-surfaced.
- `POST /v1/internal/*`, `/burn/ws`, `/health`, `/health/ready` -> skip: internal / realtime / probe.

**agent_policies:** every `burn_*` service-account call fails closed until `burn.*` is allowlisted.

### 11.2 The 22 hand-authored permission rows

| Permission | `is_read` | Floor / note |
| --- | --- | --- |
| `burn.engagement.read` | true | |
| `burn.engagement.write` | false | |
| `burn.engagement.delete` | false | `is_destructive:true, requires_confirmation:true`; **owner/admin** |
| `burn.deliverable.read` | true | |
| `burn.deliverable.write` | false | content and `review_status` only |
| **`burn.envelope.confirm`** | false | **owner/admin; the only permission that can set `is_active` (2.2.1)** |
| `burn.attribution.read` | true | |
| `burn.attribution.write` | false | no longer covers rules |
| **`burn.rule.write`** | false | **owner/admin (2.3.3)** |
| `burn.precheck.run` | false | writes a precheck row; also writes the two non-scoring labels on own rows |
| `burn.precheck.read` | true | |
| `burn.precheck.override` | false | **member tier: the escape hatch must stay reachable** |
| `burn.precheck.mark_wrong` | false | **owner/admin; the only writer of `wrong_call` / `gate_wrong`** |
| `burn.variance.read` | true | |
| `burn.variance.write` | false | a mutation is never authorized by an `is_read:true` permission |
| `burn.changeorder.draft` | false | |
| `burn.financials.read` | true | project-scoped; banded; contributor-floor suppressed |
| `burn.financials.read_all` | true | **owner/admin** + second in-route role guard |
| `burn.costrate.read` | true | **owner/admin** + in-route guard |
| `burn.costrate.write` | false | **owner/admin** + in-route guard |
| `burn.settings.read` | true | |
| `burn.settings.write` | false | **owner/admin** + in-route guard; owns `gate_mode` |

**22 permissions.** Only `burn.engagement.delete` is manifest-destructive; the reject and gate-weakening confirm boundaries live at the MCP tool layer.

**Built-in tiering:** owner and admin get all 22; **member gets all except `burn.envelope.confirm`, `burn.rule.write`, `burn.precheck.mark_wrong`, `burn.financials.read_all`, `burn.costrate.read`, `burn.costrate.write`, `burn.engagement.delete`, and `burn.settings.write`** (14); viewer gets the `is_read` rows except `burn.financials.read_all` and `burn.costrate.read` (7); guest none. These are the counts the 3.4.1 probe asserts.

---

## 12. Test plan

### 12.1 Unit (Vitest, `@bigbluebam/db-stubs`)

**Valuation, the double count, and basis**
- **Logging 60 minutes against a task produces exactly ONE priced work item totalling one hour** (R2-D1). A `bam.task` work item always has `valuation_basis='none'`, and `time_logged_minutes` appears in no epoch and no valuation.
- **Fixed-fee margin moves the right way (R2-D2):** a `fixed` chain that under-burns hours reports **higher** margin than the same chain over-burning; `revenue_basis='contract_value'`; `margin_state='in_progress'` until the chain closes. A `retainer` chain computes per period in the engagement timezone. A `time_and_materials` chain uses `attributed_billable - attributed_cost`.
- **Expense conditionality (R2-D5):** `billable=false` contributes to `cost_amount` and **not** to envelope consumption; `status='rejected'` marks the item `excluded/source_voided` and reverses in-transaction, and **a subsequent precheck no longer denies**.
- **Parity test:** Burn's cost resolver and Bill's `resolveRate` (`rate.service.ts:117`) agree across a fixture matrix on `user+project > user > project > org` and **inclusive** `effective_to`. `POST /internal/rates/resolve` returns the same row as a direct call.
- **Rate-resolve failure (R2-I5):** with bill-api returning 404, **no work item receives a non-null `billable_amount`, no rollup changes**, the item is `unrated/rate_service_unavailable`, and it appears in queue health as awaiting valuation.
- **No response carries the string "margin" when `metric_basis='contract_consumption'`**, and the Zod money union **cannot be constructed** without a `metric_basis`.

**Epochs, reconcile, and revaluation**
- A task moved across the board three times with no title, description, or project change produces **one** work item, **zero** classifications, **zero** llm-provider calls. `updated_at` is asserted absent from every epoch input.
- **Revaluation (R2-T2):** adding a cost rate for a user with 40 existing work items **moves `cost_rate_coverage_pct` and issues zero llm-provider calls**; the attribution is not superseded and the classification is unchanged.
- **A `cost_epoch`-only change revalues without re-deciding; a `classification_epoch` change on a `confirmed`/`human` attribution CARRIES IT FORWARD** with `method='inherited'` (R2-T8). Test: confirm an attribution, edit the source minutes, assert **one** llm-provider call total and the human decision preserved.
- **Backdated windowing (R2-T3):** a timesheet with `date` 120 days ago and `created_at` today is ingested by pass 1 **and is inside passes 2 and 3** because `reconcile_until` is anchored on `ingested_at`. An edit and a delete of that row are both observed.
- **The revert case (R2-T4):** minutes 60 -> 90 -> 60 produces exactly one live row with the correct dollars, **no 23505**, and no permanently-excluded row. Asserted in both orderings.
- Delete of an expense and of a task each mark `excluded/source_deleted` and reverse; `phantom_consumption` fires on a reversal burst.
- The reconcile plan uses `tasks_project_id_idx` and `time_entries_task_id_idx` and never scans `time_entries` org-wide; the `bill_expenses` created_at scan uses the new `idx_bill_expenses_created_at`.

**Chains and envelopes**
- **The loop closes (R2-D3):** a change order approved on an `envelope_overrun` creates an amendment deliverable with `envelope_amount_delta`; the base deliverable's **effective envelope rises**; **the next precheck on it returns `allow`, not `deny`**; consumption is not reset; no attribution is migrated; the burn-down shows a per-deliverable dated step-up.
- An amendment leaves the base `active` and adds `contract_value_delta`; a restatement migrates by `dedup_key` and unmatched attributions become `pending_review/restatement_unmatched`, never silently dropped.
- **Envelope confirmation (R2-D4, S7):** `is_active` cannot be set by `PATCH /v1/deliverables/:id`, by `burn_confirm_deliverable`, or by **any service-account token on any path**; only `POST /confirm-envelope` under `burn.envelope.confirm` sets it, and a service-account caller gets an `agent_proposals` row instead.
- **Unpriced (R2-D6):** a bulk-confirmed unpriced deliverable returns `allow_with_note/envelope_unpriced`, **never a deny**, and is excluded from `envelope_overrun` and `consumption_erosion`. Promotion is blocked when `priced_deliverable_coverage_pct` is below the floor.
- `lifecycle_status='closed'` is what makes `verdict_reason='deliverable_closed'` reachable.

**Attribution**
- A model response naming an id outside the candidate set drops to `pending_review`; an injection string does not change the target; an LLM timeout yields `pending_review`, a daily-cap or **429** yields `pending_attribution`, never `unscoped`.
- **The three buckets never merge** in any query, response, or screen (R2-D7), and `queue-health` reports the `pending_review` and awaiting-valuation figures with the "not in any envelope" statement.
- **Rules (R2-S4a):** a rule with an empty `match` is **rejected** by both the Zod refinement and the DB `CHECK`; a `non_billable` rule requires `burn.rule.write`; a rule exceeding `match_ceiling_pct` is rejected at write and raises `rule_overreach` if it drifts there later; **`title_pattern` rejects regex metacharacters** (there is no regex timeout in Node and the spec no longer claims one).
- Concurrent triage returns **409 with current state**; bulk returns per-item results.

**The gate**
- **`POST /v1/internal/precheck` issues ZERO llm-provider calls** and completes under `precheck_budget_ms` at **p95 on the success path**, not only on failure paths (R2-T6). The LLM client is stubbed to throw so any call fails the test loudly.
- `needs_mapping` never blocks; `enforced=false` in advisory mode for every verdict; task-phase and assignment classes are rejected if marked blocking.
- A deny is impossible below `deny_threshold`, against an unconfirmed or unpriced envelope, against an empty chain, or against an `unlinked` chain.
- **Fail-open**, each with the right `verdict_reason`: unreachable burn-api, open breaker, timeout, **`BURN_API_INTERNAL_URL` unset (`gate_not_configured`)**, and **Redis unreachable (`redis_unavailable`)**. In every case the expense **posts**.
- **The unconfigured case reads as 0 percent coverage, not 0/0** (R2-I3): `burn:gate_calls` increments on the unconfigured no-op, and the demotion path can fire.
- The breaker opens after `BURN_PRECHECK_BREAKER_THRESHOLD` (5) and short-circuits at zero network cost; the counter is shared across replicas; the half-open probe is single-flight under the `NX` key; `bill-recurring-generate` checks it once per job.

**Idempotency and supersession**
- The key is server-derived and namespaced; a caller-supplied key is rejected.
- **The banked-verdict attack fails:** an `allow` stored for a 1-cent charge is not returned for a $60,000 charge.
- **Recompute is supersede-then-insert (R2-T7):** a mismatched or expired hit produces a **new live row and a retained superseded row**, with **no UPDATE-in-place and no 23505 on the money path**. The superseded row is exempt from retention.

**Promotion, labeling, demotion**
- `gate_mode='blocking'` is **rejected server-side** with the specific shortfall named when any of the **seven** preconditions fails, asserted against the API directly.
- **500 member-generated `usr:` prechecks do not move promotion standing** (R2-S8); only `svc:` calibrating rows count; the per-user rate limit and `usr_precheck_daily_cap` bind.
- The scale-aware floor: 41 decisions with 61 advisory days satisfies precondition 1.
- **Label split (R2-S7):** a member CAN write `right_call` and `would_have_mapped` on their own non-enforced row; a member is **403 on `wrong_call`** and **403 on `gate_wrong`**; neither member-writable value enters the demotion numerator.
- **Coverage demotion has floors (R2-S4b):** a burst of 429s does not reduce coverage; demotion requires `min_gate_unavailable_days` and burn-api-health attribution.
- False-positive demotion requires rate **and** absolute count **and** distinct users; a single admin marking five rows does not demote.

**Security**
- **Enforcement (R2-S1):** burn-api **fails to boot** when `BBB_PERMISSIONS_ENFORCE` is not `on`; with the resolver stubbed non-2xx, `/v1/cost-rates` and `/v1/financials/accounts` still return **403** via the second in-route guard.
- **The gate is not an oracle (S1):** a non-project member gets a scoped rejection from `POST /v1/precheck`, not envelope figures.
- **No absolute recovery (R2-S2):** the test probes a **newly confirmed deliverable** and asserts `proposed_amount - overage` does **not** yield `envelope_remaining`, and that `contract_value` is not recoverable to within 5 percent from any combination of member-reachable responses.
- **The surveillance join, enumerated (R2-S3):** for **every** member-reachable route (`/v1/work-items`, `/v1/attributions`, `/v1/unscoped`, `/v1/queue-health`, `/v1/change-orders/:id`, variance `detail`, every MCP payload, the CSV export) the test joins `source_id` to `time_entries.user_id` through `/b3/api/` and asserts **no dollar figure is obtainable**, and specifically that `cost_amount / hours` never yields a per-person rate.
- **Clause text (R2-S9):** `description` is absent for a non-`read_all` caller; a deliverable whose Bin asset the **reader** cannot access is dropped with a hidden count, even though the registrant could see it.
- **The predicate (R2-S6):** a zero-project chain is invisible to a plain org member (no null fallback); in a two-project chain, a member of project A **cannot** read work items whose own `project_id` is B; the parity test against `visibility.service.ts:203` covers the single-project case only.
- **Contributor floor (R2-S10):** on a chain with one contributor, `attributed_cost`, `margin_amount`, `margin_pct`, and `cost_rate_coverage_pct` are **absent**, with `suppressed_reason='insufficient_contributors'`.
- **Cross-app authority (R2-S5):** the approval path calls `POST /internal/permissions/dual-read` for **`bill.invoice.update`** and fails closed on non-2xx; **no acting-user header exists anywhere in the code**; bill-api records `acting_user_id` and publishes it.
- `/v1/internal/*` returns 401 unconditionally on an empty secret; `agent_proposals.proposed_payload` holds no clause text, client name, or dollar total; every published `burn` event is asserted free of `amount` and any percentage.
- `llm_provider_id` from another org is rejected at `PATCH /v1/settings`.
- **RLS, mandatory (S9) and extended (R2-I6):** under `BBB_RLS_ENFORCE=1`, a query for org A returns **zero** org-B rows on every `burn_*` table **with the app-level predicate removed**; and **the claim reaper and `POST /v1/internal/events` both still function**, proving the org-iterating and payload-derived GUC paths bind.

**Rollups and retention**
- `GET /v1/financials` never issues an unbounded live aggregate; a missing rollup computes one chain synchronously; a stale one is served with `as_of` and `stale: true`.
- **Frozen rollups (R2-T5):** purge a closed chain, run the hourly refresh **and** an on-miss compute, and assert the figure is **unchanged** and `final: true`.

**Permissions**
- Manifest: `burn.engagement.delete` carries the destructive flags; every row has an explicit `is_read`; `burn.variance.write` and `burn.rule.write` are `is_read:false`.
- **The group-defaults probe from 3.4.1 returns owner 22, admin 22, member 14, viewer 7, guest 0.** A zero row for any group fails the suite, which is the automated form of the R2-B1 blocker.
- Tiering: an Owner GETs 200 on `/v1/financials/accounts` and `/v1/cost-rates`; a Member is 403 there, on `POST /v1/rules`, on `POST /v1/deliverables/:id/confirm-envelope`, on `POST /v1/prechecks/:id/label` with `wrong_call`, on `DELETE /v1/engagements/:id`, and on `PATCH /v1/settings`.
- `register-tool`: `burn.*` fails closed until allowlisted.

**Concurrency**
- Two concurrent sweeps for one org: one proceeds, the other **skips and emits the counted log line**; the lock is `pg_advisory_xact_lock` inside the transaction and **releases on rollback** (asserted by forcing an error mid-sweep and confirming the next sweep acquires).
- **Lease renewal (R2-T9):** a batch running longer than `claim_lease_seconds` is **not** reclaimed by the reaper because the drain heartbeats; a genuinely dead claim **is** reclaimed after the lease.

### 12.2 Playwright user stories (GILLIGAN only)

**Registration (round-2 R2-B4).** `apps/e2e/playwright.config.ts` builds each suite from an explicit `appProject(name)` whose `testDir` is `./src/apps/${name}/tests`, and the hand-maintained `projects` array currently ends at `appProject('helpdesk')` (verified: `board`, `bolt`, `bulwark`, `bond`, `book`, `braid`, `brief`, `helpdesk` at `:59-66`). **Without an `appProject('burn')` entry, a `burn.spec.ts` is picked up by neither the projects list nor the `setup` dependency chain that provides `.auth/admin.json`, so the entire suite would be dead code that silently never executes.** Two edits: add `appProject('burn')` among the `b*` entries, and place specs at `apps/e2e/src/apps/burn/tests/burn.spec.ts` mirroring `apps/e2e/src/apps/bulwark/tests/bulwark.spec.ts`. The suite runs against the gilligan-seeded stack and depends on the `setup` project.

1. **The unscoped discovery.** The Skipper opens `/burn/`, sees the Howell Luau chain at `at_risk` labeled **"Contract consumption"** with `in_progress`, opens the queue, and reads **"$1,940 of work nobody sold"** in the *Sold by nobody* bucket, with separate non-zero figures in *Unclassified* and *Outside any tracked contract*. He raises a change order. Nothing is sent.
2. **Cost rates flip the label and revalue history.** The Skipper adds the two missing cost rates. **`burn-revalue` runs**, existing work items gain `cost_amount`, and the card flips to **"Margin"** at 100 percent coverage. Negative check: before the edit the word "Margin" appears nowhere on the page.
3. **The change order closes the loop.** Approving the proposal creates the amendment engagement **and** the amendment deliverable; the burn-down shows both step-ups; **and a new $300 expense against the catering deliverable now posts instead of being denied.**
4. **The advisory gate teaches, and the member can only say two things.** The Professor logs a $340 expense in Bill. It **posts** with the inline note showing the quantized overage and exactly **"Right call? Yes / I'd have mapped it / Flag for review"**. He clicks Yes. Negative check: no "No, wrong call" option is rendered, and a direct API call with `wrong_call` returns 403.
5. **Earning the block.** `/burn/gate` shows live standing against all **seven** preconditions including coverage 0.99 and priced coverage 85 percent. The Skipper reviews the last 20 advisory denies, acknowledges, and promotes **`bill.expense` only**.
6. **The block, and the four ways out.** Gilligan logs $600. It is **blocked**, showing "exceeds by at least $50,000-bucketed overage" and **not** the contract value. He records absorbed cost with a 20-character reason; the charge posts with the reason permanently attached.
7. **`needs_mapping` does not block.** An ambiguous $120 expense **posts** with a "map this charge" note and a queue item. Negative check: no block dialog, and the expense exists in Bill.
8. **The wrong block, and the system's response.** Mary Ann (member) overrides with `mapped_manually`; the Skipper (admin) labels the row `gate_wrong`. A fixture pushes rate, count, and distinct users past all three thresholds; the console shows the auto-demotion banner naming the trigger.
9. **The gate goes dark and is caught.** burn-api is stopped; two expenses post normally; on recovery the console shows unavailability days, coverage below 100 percent, and the inbox holds `gate_outage` plus two `ungated_charge` findings naming **real expense rows**.
10. **Unconfigured is distinguishable from unavailable.** With `BURN_API_INTERNAL_URL` unset, expenses post and the console shows **`gate_not_configured`** with 0 percent coverage, not a clean board.
11. **The silent deliverable.** The daily sweep raises `silent_deliverable` on the Coconut item due in eight days.
12. **Permission boundary.** Gilligan sees only his projects' chains, has no "All accounts" toggle, no cost-rate screen, and no rule editor, and gets 403 on direct `GET /burn/api/v1/financials/accounts` and `/v1/cost-rates`.
13. **Tuning visibly works.** A reclassification is followed by a similar task attributed with `method='precedent'`; creating a rule from the cluster attributes the next one with `method='rule'` and no LLM call.
14. **Non-billable stops inflating the headline.** Marking the retro block `non_billable/internal` drops the *Sold by nobody* figure and removes the item without mapping it to any deliverable.

### 12.3 Integration harness

In `apps/integration-tests`: expense create in bill-api triggers a real precheck against a seeded chain, `expense.created` reaches bolt-api, the dispatch hook forwards, the work item materializes, attribution runs, and the rollup changes. **Five negatives:** `BURN_API_INTERNAL_URL` unset (everything posts, coverage counters still increment); burn-api stopped (breaker opens, latency returns to baseline); breaker open (counters still increment); **bill-api returning 404 on `/internal/rates/resolve` (no work item gets a non-null `billable_amount` and no rollup changes)**; and Redis unreachable (expenses still post).

### 12.4 Convention gates

All ten must pass before merge, and any pre-existing failure gets a recorded task rather than a wave-off, per CLAUDE.md's "pre-existing is not a dismissal" rule:

```sh
pnpm lint                      # lint.yml:43
pnpm lint:migrations           # lint.yml:46
pnpm typecheck
pnpm test                      # unit + the new e2e project registration
pnpm db:check                  # db-drift.yml:75 - FATAL on an undeclared column
pnpm check:permission-catalog  # lint.yml:49
pnpm help:check                # lint.yml:55
pnpm docs:catalog:check        # lint.yml:58 area
pnpm docs:manual:check         # lint.yml:58
pnpm check:bolt-catalog        # NOT in any workflow today; this build adds it to lint.yml
```

**Standing citation rule.** Every `file:line` in this specification is **re-verified against the working tree at implementation time** before it is relied on. Two review rounds found citation drift, twice in the locking family, where a named file contained only a doc comment. Where a pattern is absent from the tree the spec says Burn establishes it; those statements (no circuit breaker, no LLM concurrency guard, no satellite gilligan seeder, no e2e project) are load-bearing and should be re-checked, not assumed.

---

## 13. Non-goals (explicit)

Burn is **not**:

1. **A time tracker.** It reads `time_entries`; it ships no timer.
2. **An invoicing engine.** Bill invoices. Burn drafts a line item as a proposal, written through bill-api under a real decider's dual-read-verified `bill.invoice.update`.
3. **A contract repository or DAM.** Bin holds bytes.
4. **Bulwark.** No deadlines, notices, or clause obligations.
5. **A general ledger.** No chart of accounts, journals, tax, or revenue recognition. Burn reports contracted-versus-delivered, not GAAP, and labels the basis of every figure it prints.
6. **A performance-management or surveillance tool**, in a precisely bounded sense: no per-person view, no utilization leaderboard, no individual ranking; `actor_id`, `decided_by`, and `overridden_by` are `read_all`-floored; and **per-person dollars are not obtainable from any member-reachable route or join**, which is the property Section 12.1 enumerates and asserts route by route. Per-person **hours** remain visible to project members because Bam already exposes them.
7. **An autonomous actor with money authority.** It never sends, posts, or charges. Its strongest autonomous act is declining to let something else post, and it can never take that action because something broke.
8. **A resource planner or forecaster.**
9. **A proposal or estimating tool.** Burn is strictly post-signature.
10. **An OCR pipeline.**
11. **A payroll or compensation system.** `burn_cost_rates` is an operator-entered figure used for one arithmetic purpose, floored to owner/admin behind two independent guards, and suppressed entirely below the contributor floor.

---

## 14. Reuse ledger

| Capability | Reuses (verified file / package) | Genuinely new in Burn |
| --- | --- | --- |
| App scaffolding, health | `apps/bulwark-api/src/server.ts:96` (`healthCheckPlugin`), `@bigbluebam/service-health` (`/health` at `:63`, `/health/ready` at `:67`), `@bigbluebam/logging` | `burn-api` at 4022; **`BBB_PERMISSIONS_ENFORCE=on` with a boot assertion** |
| Project-scope predicate | `apps/api/src/services/visibility.service.ts:203` (`isProjectMember`, **not exported**) for the parity case | **a distinct EXISTS-over-join-table predicate with no null fallback**, because the ported Bulwark version's NULL-passes-for-all-members fallback would invert the design |
| RLS request binding | `0116_rls_foundation.sql`, `BBB_RLS_ENFORCE`, `apps/api/src/boot/rls-boot.ts` | **transaction-scoped GUC binding**, not a copy of the four plugins that do not bind; plus org-iterating jobs and payload-derived internal routes |
| **Advisory locking** | `apps/braid-api/src/lib/advisory-lock.ts:79` (`pg_advisory_xact_lock` inside the tx) | Burn's sweep service. **Deliberately NOT `apps/bulwark-api/src/services/sweeps.service.ts:41-52`**, whose session-scoped lock on a pooled connection can leak permanently |
| Document bytes and parsing | `@bigbluebam/storage` `getStream`, `bin_assets` (`0205_bin_dam.sql`) | bounded, inert parsing with per-reader preflight |
| Document understanding | `apps/bulwark-api/src/services/extraction.service.ts` (pattern), `.../lib/internal-llm.client.ts`, `apps/api/src/routes/internal-llm.routes.ts` | verified cites, deterministic `dedup_key`, **human-only envelope confirmation** |
| **Attribution classifier** | the internal LLM seam; Postgres FTS + `pg_trgm` (`0000_init.sql:22`) | **the whole engine**: two epochs, three reconcile passes, monotonic identity, the rule stage, banding, exemplar tuning, three-bucket queue |
| **Revaluation** | none; no comparable path exists | `burn-revalue`, `valuation_epoch`, `valued_at` |
| Vector retrieval (deferred) | `apps/beacon-api/src/lib/qdrant.ts`, `braid-profiles.ts:46-47` | reserved columns behind a flag; **off, because `embedding.service.ts:17` returns zero vectors** |
| Billing-rate resolution | `apps/bill-api/src/services/rate.service.ts:117`, consumed at `invoice.service.ts:583` | **`POST /internal/rates/resolve`** (one implementation) plus a parity test and a specified failure mode |
| **Cost rates** | shape mirrors `bill_rates` (`bill-rates.ts`) | **`burn_cost_rates`, the primitive the platform lacks entirely** |
| Gate hook point | `apps/bill-api/src/routes/expenses.routes.ts:46,57`, `apps/worker/src/jobs/bill-recurring-generate.job.ts:367` | the fail-open preHandler, two missing `bill` events, `acting_user_id` on the internal write |
| **Circuit breaker** | **none exists**; grepping `apps/` and `packages/` for `circuitBreaker\|halfOpen` returns zero files. Redis primitive precedent: `apps/bill-api/src/services/sequence.service.ts:50` | **the suite's first breaker**, multi-replica-correct, with named env vars |
| **Internal LLM concurrency cap** | **none exists**; `internal-llm.routes.ts` has no limiter | **a Redis token bucket with a 429 contract and a defined client behavior** |
| Client identity | `apps/bond-api`, ported `apps/bulwark-api/src/lib/braid-resolve.client.ts`, `entity_links` (`0132_entity_links.sql`) | golden-id-anchored chain rollups |
| **Visibility preflight** | **`can-access.client.ts` already exists in `apps/basis-api/src/lib/`, `apps/braid-api/src/lib/`, and `apps/bulwark-api/src/lib/`** | **this build promotes it to a shared package and migrates all three** (see below) |
| HITL inbox | `agent_proposals` (`0128_agent_proposals.sql:37,41`), `proposals.routes.ts:40,114-134`, `apps/bulwark-api/src/subscriptions/proposal-decided.ts`, `braid-proposal-reconcile.job.ts` | refs-only drafts; **dual-read authorization, no impersonation primitive** |
| Durable event ingestion | `bulwark_ingest_events` (`0234_bulwark_core.sql:123-136`), `event-ingestion.routes.ts`, `apps/bulwark-api/src/services/gate.service.ts` (the bindings SET, cited only here) | **claim columns with lease renewal and a per-org reaper**, plus the three-pass reconcile |
| Bolt events + drift guard | `publishBoltEvent` (`bolt-events.ts:34-41`), `event-catalog.ts:2939,2940-2960,3025,3046`, `scripts/check-bolt-catalog.mjs` (`package.json:35`) | 10 magnitude-free events, 2 backfilled `bill` events, **and wiring the guard into `lint.yml`** |
| Permissions | `scripts/generate-permission-manifest.mjs:719,816`, `build-permission-codegen.mjs`, `build-permission-delta.mjs:40-44`, `0238_bulwark_builtin_group_defaults.sql` | 22 rows, custom tiering, **and the two-pass ordering with a verification probe** |
| Worker scheduling and deadlines | `apps/worker/src/worker.ts:2207-2260`, `:691-724` (basis `upsertJobScheduler`), `bulwark-proposal-reconcile.job.ts:48` | 10 job families plus a reaper |
| tsvector in Drizzle | `apps/braid-api/src/db/schema/braid-profiles.ts:15-18` (`customType<{ data: string }>`) | two null-safe generated columns |
| Frontend shell | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/permissions` `useCan`, `apps/bulwark/`, `packages/ui/launchpad.tsx:65,226` | 7 Burn screens plus **one `apps/bill/` component** |
| Docs and CI guards | `scripts/docs/extract.mjs:42-65`, `build-manual.mjs:78-85`, `publish.mjs:428-435`, `lib/tool-source.mjs:85`, `apps/frontend/Dockerfile:232`, `.github/workflows/lint.yml:43-58` | the full `docs/apps/burn/` artifact set |
| e2e | `apps/e2e/playwright.config.ts:59-66`, `apps/e2e/src/apps/bulwark/tests/bulwark.spec.ts` | **`appProject('burn')` plus the spec directory** |
| Deploy and Railway | `scripts/deploy/shared/services.mjs:292-297`, `env-hints.mjs:325`, `railway-orchestrator.mjs:125-159`, `gen-railway-configs.mjs:543` | 8 new `ENV_HINTS` entries **plus a coverage test** |
| Seed | `scripts/seed-all.mjs:82-95,272`, `scripts/seed-gilligan/run-all.mjs:60-75`, `packages/docs-capture/src/environment.ts` | `seed-gilligan/burn.mjs` in a new trailing **Margin** group; **no satellite precedent exists** |
| Shared schemas | `packages/shared/src/schemas/index.ts:18-20`, `packages/shared/src/index.ts:13-16` (the `node:crypto` subpath trap) | `schemas/burn.ts` with its re-export line, and `burn-precheck-key.ts` on a **subpath export** |

### 14.1 `can-access.client.ts` is consolidated in this build, not copied a fourth time (round-2 R2-B5)

Verified: `can-access.client.ts` exists at `apps/basis-api/src/lib/`, `apps/braid-api/src/lib/`, and `apps/bulwark-api/src/lib/`. CLAUDE.md records the opposite precedent explicitly, that `packages/storage` exists because it "consolidates the previously-triplicated MinIO clients". `can_access` is the suite's **fail-closed visibility preflight**: four independent copies means a fix to the fail-closed path or a `SUPPORTED_ENTITY_TYPES` change lands in one and silently not the other three. A fourth copy must not land under the word "reuse."

**This build promotes it to `@bigbluebam/shared/visibility-client`**, a **subpath export** (not the browser-facing barrel) following the `bulwark-arm-key.ts` pattern documented at `packages/shared/src/index.ts:13-16`, because it needs `INTERNAL_SERVICE_SECRET` and must never reach an SPA bundle. **The three existing apps are migrated in the same change**, with their per-app files deleted and their existing tests re-pointed.

`braid-resolve.client.ts`, `internal-llm.client.ts`, and `project-scope.ts` are at two copies each and heading the same way; they are **recorded as a tracked follow-up** rather than consolidated here, because Burn's own `project-scope` is a distinct implementation (2.4 point 6) and folding a divergent variant into a shared package in the same PR would be a worse change than the duplication.

---

## 15. Open questions and risks

Everything the build needs to proceed is specified. These are genuine unknowns, and **none of them gates the build**.

1. **No working embedding provider in the tree (owner: platform).** Lexical retrieval is the shipped path; Qdrant is behind a default-false flag. Burn works without it; cold-start precision on a brand-new engagement would be better with it.
2. **The gate requires bill-api changes owned outside this app** (a fail-open preHandler, a breaker, two events, two internal routes). There is no way to gate money post-hoc, so this is not optional. Confirm the Bill maintainers accept it.
3. **`ungated_charge` coverage is honest but incomplete.** Retroactively logged hours and charges entered outside the four hooks are caught post-hoc, not intercepted. Confirm the positioning against the marketing claim.
4. **Non-priced signals** (Banter, commits) improve target selection and contribute zero dollars. Recommendation: correct as is.
5. **Multi-currency chains** are pinned to one currency; FX conversion needs a rate source the platform lacks.
6. **`burn_work_items` volume** at the top of the band; retention plus the `0220_blip_entries_partitioned.sql` pattern is the answer. Confirm the partition trigger threshold.
7. **Bulwark cross-read** (enriching deliverables with payment terms from `bulwark_obligations` on the same asset) is deliberately out of v1.
8. **`search_everything` provider** deferred, matching Braid and Bulwark.
9. **The residual product risk.** An org whose work genuinely does not decompose against its own contracts will not reach promotion, and **advisory is the product for them**. The gate console says so rather than nagging.
10. **Pre-existing platform defects Burn works around, all tracked separately:** the RLS GUC does not bind in any of the four existing plugins; `/internal/llm/chat` resolves a provider with no org predicate; `BBB_PERMISSIONS_ENFORCE` defaults to a non-enforcing `warn` platform-wide; `check:bolt-catalog` is absent from CI (this build adds it); CLAUDE.md documents a `/readyz` that does not exist; the three nginx configs have drifted on the static-asset alternation; and **`BOLT_API_INTERNAL_URL` has no `ENV_HINTS` entry while being `required` on bulwark-api, which throws in `buildServiceVariables` on Railway today** (this build adds the hint and the coverage test that prevents recurrence).
11. **`time_entries` has no `updated_at`.** Content-hash epochs make edits detectable anyway, but only inside `reconcile_window_days`. Adding the column is a platform change, not Burn's.
12. **No human-provided secret required.** New env are internal URLs, four `BURN_*` knobs, and two `LLM_INTERNAL_*` knobs.

---

## 16. Is this spec build-ready?

**Yes, with two named caveats that are dependencies rather than defects.**

**All 14 round-2 blockers are resolved in the spec text**, each with a stated mechanism, a schema change where one was needed, and a test that would fail if the fix regressed: R2-D1 (one priced hour source), R2-D2 (basis-aware revenue), R2-D3 (`amends_deliverable_id` + `envelope_amount_delta`), R2-D4 (`burn.envelope.confirm`, not agent-reachable), R2-D5 (expense `billable`/`status`), R2-S1 (`enforce=on` boot assertion plus second guards), R2-S2 (quantized overage), R2-S3 (one serializer), R2-S4 (rule constraints, coverage floors, no regex), R2-T1 (`pg_advisory_xact_lock`), R2-T2 (`valuation_epoch` and `burn-revalue`), R2-T3 (`reconcile_until`), R2-T4 (monotonic live-row key), R2-B1 (two-pass migration ordering plus the probe), R2-I1 (`ENV_HINTS` plus a coverage test).

**Two caveats an implementer must see before starting:**

1. **This build changes five services it does not own** (bill-api, bolt-api, worker, mcp-server, api) plus `apps/bill/`, and promotes `can-access.client.ts` into a shared package with three apps migrated. That is a large blast radius for one PR and it may be worth landing the consolidation (14.1) and the `ENV_HINTS` coverage test (9.6.2) as separate preceding PRs. **Nothing in the design depends on them landing together.**
2. **The internal LLM concurrency cap (9.7.1) is specified as a deliverable of this build, on a route owned by the `api` container.** It has a mechanism, defaults, a 429 contract, a defined client behavior, and a done criterion, so it is buildable as written, but it is the one piece of Burn that lands outside Burn's own boundary and touches a path all 22 other apps use. If a reviewer wants it split out, split it **before** Burn ships rather than after, because Burn is the load that makes it necessary.

**No blocker is being let through quietly.** The one finding I partially rejected is R2-S3's sibling from round 1 (raising `burn.precheck.override` wholesale), argued in 5.6; every round-2 finding was accepted or accepted with a stated modification.

---

## Changelog

### Round 1 (10 blockers, 26 majors, 8 minors) - all accepted or accepted-with-modification, one partial rejection

Round-1 dispositions are preserved in summary; each was verified as landed by round 2's best-practices adversary, which returned **zero blockers** on B1-B8.

**Design:** D1 (cost rates plus consumption honesty), D2 (delegated rate resolution), D3 (engagement chain), D4 (many-to-many projects), D5 (non-billable, rules, queue health), D6 (folded with T2/T3), D7 (`needs_mapping` non-blocking), D8 (advisory feedback control, scale-aware floor), D9 (internal outcome route). **Security:** S1 (project-scoped precheck), S2 (server-derived key), S3 (label split; **rejected** raising `override` wholesale), S4 (no double-unit emission), S5 (no magnitudes on Bolt), S6 (dollar flooring, accepted with modification), S7 (all envelopes confirmed), S8 (decider authority, provider validation), S9 (RLS binding, mandatory test), S10 (`variance.write`, `precheck.read`, inverted confirm). **Stability:** T1 (rollups), T2/T3 (content epochs, watermark), T4/I2 (client-side timeout, breaker), T5/I1 (observable fail-open), T6 (claims), T7 (lock citation), T8 (human precedence), T9 (key TTL), T10 (null-safe tsvector), T11 (retention, ws). **Best practices:** B1-B8 all landed. **Infrastructure:** I1-I7 all landed.

### Round 2 (14 blockers, 24 majors, 5 minors) - all accepted or accepted-with-modification

**Design**
- `R2-D1 ACCEPT (BLOCKER)` - verified `time-entry.routes.ts:35-42` increments `tasks.time_logged_minutes` on every insert; every hour was priced twice. `bam.time_entry` is now the sole priced hour source, `bam.task` is `valuation_basis='none'`, and `time_logged_minutes` is out of the epoch. Sections 2.3.1, 2.3.2, 10, 12.1.
- `R2-D2 ACCEPT (BLOCKER)` - margin is now basis-aware with `revenue_basis` on the rollup; a fixed-fee chain under-burning hours reports higher margin, tested. Sections 1.2.1, 3.1, 12.1.
- `R2-D3 ACCEPT (BLOCKER)` - added `amends_deliverable_id` and `envelope_amount_delta`; effective envelope resolves over the amendment set with consumption on the base row, so the flagship loop actually closes. Sections 3.1, 4.6, 12.1, 12.2 story 3.
- `R2-D4 ACCEPT (BLOCKER)` - envelope confirmation moved to its own route and the new owner/admin `burn.envelope.confirm`; a service-account caller gets an `agent_proposals` row and can never set `is_active`. Sections 2.2.1, 6.1, 11.1, 11.2.
- `R2-D5 ACCEPT (BLOCKER)` - verified `billable` defaults false and `status` defaults `'pending'` at `bill-expenses.ts:38,40`; valuation is now conditional, both fields are epoch inputs, and `rejected`/`void` reverses. Sections 2.3.1.1, 2.3.2, 12.1.
- `R2-D6 ACCEPT (MAJOR, supersedes the round-1 steer)` - the even-split fast path is deleted; bulk confirm writes `envelope_amount = NULL` / `envelope_source='unpriced'`, and promotion carries a `priced_deliverable_coverage_pct` floor. The argument that a fabricated envelope poisons the precision sample and makes promotion unreachable is correct. Sections 2.2.2, 3.1, 5.4.
- `R2-D7 ACCEPT (MAJOR)` - three named queue buckets with three figures never summed, `aged_out` on its own tab, and the "these dollars are not in any envelope" statement surfaced rather than implied. Sections 2.3.8, 6.1, 7.2.
- `R2-D8 ACCEPT (MAJOR)` - `metric_basis` plus `revenue_basis` plus coverage plus `as_of` on every money response, enforced by a Zod discriminated union with **no `margin` key** under consumption; tool renamed `burn_financials` with `burn_margin` as a deprecated alias; export route added. The "a tool name is a claim" argument is right. Sections 1.2.2, 6.1, 11.1.
- `Design minors ACCEPT` - added `burn_deliverables.lifecycle_status` (making `deliverable_closed` reachable), split `burn.rule.write` out of `burn.attribution.write`, and published the `attribution_state` denormalization mapping. Sections 3.1, 11.2.

**Security**
- `R2-S1 ACCEPT (BLOCKER)` - verified `${BBB_PERMISSIONS_ENFORCE:-warn}` and `if (opts.mode === 'warn') return;` at `packages/permissions/src/index.ts:291`, plus `'unknown'` on non-2xx. burn-api sets `on` unconditionally and **refuses to boot** otherwise, with a second in-route role guard on the five most sensitive routes. Sections 2.4(1), 9.1, 12.1.
- `R2-S2 ACCEPT (BLOCKER)` - `overage_amount` is quantized for non-`read_all` callers; the recovery test now probes a freshly confirmed deliverable, which is the case that made exact recovery possible. Sections 2.4(3), 5.7, 12.1.
- `R2-S3 ACCEPT (BLOCKER)` - flooring moved off routes into one shared `redactFinancialFields` serializer applied to eight surfaces; the test enumerates every member-reachable route. The single-row `cost_amount / hours` disclosure was the sharpest finding of the round. Sections 2.4(2), 6.1, 12.1.
- `R2-S4 ACCEPT (BLOCKER)` - (a) empty-match rules rejected by `CHECK` and Zod, `burn.rule.write` at owner/admin, `match_ceiling_pct` with a `rule_overreach` variance; (b) coverage demotion gains absolute-day floors, health attribution, and 429s counted separately; (c) **the "compiled with a timeout" claim is deleted as false** and `title_pattern` is glob or substring only. Sections 2.3.3, 5.6, 12.1.
- `R2-S5 ACCEPT (MAJOR)` - the round-1 "call as the decider with their credentials" fix was unimplementable (`X-Impersonate-User` at `auth.ts:287` is SuperUser-only and refuses to chain). Replaced with dual-read against the named `bill.invoice.update` plus `acting_user_id` in the body, and an explicit prohibition on inventing a trusted acting-user header. Sections 2.4(11), 4.6, 12.1.
- `R2-S6 ACCEPT (MAJOR)` - Burn's predicate is a distinct EXISTS over the join table with **no null fallback**, and work-item rows scope by their own `project_id`, not chain reachability. Sections 2.4(6), 12.1.
- `R2-S7 ACCEPT (MAJOR)` - the label is split by value: two member-writable non-scoring values on own rows, `wrong_call`/`gate_wrong` at `burn.precheck.mark_wrong`. This closes the UX-repair path that would have silently undone round 1's S3. Sections 2.4(9), 5.4, 6.1, 7.4.
- `R2-S8 ACCEPT (MAJOR)` - only `svc:` calibrating rows count toward promotion; per-user rate limit and daily cap on `usr:` rows; and since the gate path is now deterministic-only, a precheck is no longer an LLM amplifier. Sections 2.4(10), 5.4, 6.1.
- `R2-S9 ACCEPT (MAJOR)` - `description` floored alongside `quote`, and the source asset re-preflighted **per reader** with a hidden count. Sections 2.4(5), 3.1, 6.1.
- `R2-S10 ACCEPT (MINOR)` - cost aggregates are **suppressed entirely, not banded**, below `min_contributors_for_cost_aggregate`. Sections 2.4(17), 3.1, 7.1.

**Stability**
- `R2-T1 ACCEPT (BLOCKER)` - verified `bulwark-radar-sweep.job.ts` is 29 lines with the phrase only in a header comment, and that `sweeps.service.ts:41-52` uses a **session-scoped** lock on a pooled connection with a swallowed release. Burn uses `pg_advisory_xact_lock` per `apps/braid-api/src/lib/advisory-lock.ts:79`, in burn-api's sweep service, and **every "Redis lock" mention is corrected**. Sections 4.0, 4.3, 8.1.
- `R2-T2 ACCEPT (BLOCKER)` - added `valuation_epoch`, `valued_at`, `user_id` in the cost epoch, and the `burn-revalue` job with zero LLM cost. Without it the cost-rate screen changed nothing and Playwright story 2 could never pass. Sections 2.3.2B, 3.1, 4.5, 8.1, 12.1.
- `R2-T3 ACCEPT (BLOCKER)` - passes 2 and 3 anchor on `reconcile_until` (ingest-derived), the per-source `occurred_at` mapping is published, and the missing `bill_expenses` `created_at` index is added in `0241`. Sections 2.3.2C, 2.3.2E, 3.4.
- `R2-T4 ACCEPT (BLOCKER)` - the four-column unique key is replaced by a partial live-row constraint, making the revert case structurally impossible to collide. Sections 2.3.2D, 3.1, 12.1.
- `R2-T5 ACCEPT (MAJOR)` - added `frozen_at`; both the hourly refresh and the on-miss compute skip frozen rows, so retention and rollups no longer cancel. Sections 3.1, 8.1, 12.1.
- `R2-T6 ACCEPT (MAJOR)` - **the synchronous precheck path is deterministic-only and never calls the llm-provider**, with a zero-calls and p95-success-path assertion. This is the change that makes the blocking gate real rather than decorative. Sections 2.1, 5.3, 12.1.
- `R2-T7 ACCEPT (MAJOR)` - added `superseded_at`/`superseded_by` and a partial unique index; recompute is supersede-then-insert, so the reason-of-record is never destroyed and there is no 23505 on the money path. Sections 3.1, 5.5.
- `R2-T8 ACCEPT (MAJOR)` - the invariant is restated at the **source-record** grain with carry-forward (`method='inherited'`), and the two-epoch split means a minutes edit revalues without re-deciding. Sections 2.3.2A, 2.3.10, 12.1.
- `R2-T9 ACCEPT (MAJOR)` - lease renewal by heartbeat, `attribute_batch_size` bounding worst-case duration, `claim_lease_seconds` declared as a column, and the knob contradiction resolved in favor of `concurrency: BURN_ATTRIBUTE_CONCURRENCY` with claims plus the per-org lock as the correctness mechanism. Sections 3.1, 4.2, 8.1.
- `Folded stability note ACCEPT` - the `gate.service.ts` breaker citation is removed (retained only in 8.3 where it is right), `sequence.service.ts:50` is named as the real Redis primitive, and the breaker is given multi-replica semantics with a shared counter and `NX` probe election. Section 5.5.1.

**Best practices**
- `R2-B1 ACCEPT (MAJOR, treated as a blocker)` - verified `build-permission-delta.mjs:40-44` is `max + 1`. The rollout is now two migrate passes with the generator assigning NNNN before the defaults file is authored at NNNN+1, plus the group-defaults verification probe with expected counts, which is also a test. This is the difference between a working app and one where every Owner hits `implicit_deny`. Sections 3.4.1, 9.8, 12.1.
- `R2-B2 ACCEPT (MAJOR)` - folded with R2-T1; the 8.1 lock column now names the transaction-scoped Postgres mechanism for all five sweeps.
- `R2-B3 ACCEPT (MAJOR)` - the breaker citation is dropped, **the spec states plainly that no breaker exists in the tree and Burn establishes the first one**, and `BURN_PRECHECK_BREAKER_THRESHOLD` (5) and `BURN_PRECHECK_BREAKER_PROBE_MS` (30000) are named with defaults, compose entries, catalog entries, hints, and their own test file. Sections 5.5.1, 9.2, 9.6.2.
- `R2-B4 ACCEPT (MAJOR)` - verified `playwright.config.ts:59-66` ends at `appProject('helpdesk')`; without registration all 14 stories were dead code. Both edits named. Section 12.2.
- `R2-B5 ACCEPT (MAJOR)` - `can-access.client.ts` is promoted to `@bigbluebam/shared/visibility-client` on a subpath export with all three existing apps migrated in this change. The other three two-copy clients are recorded as a tracked follow-up with the reason stated. Section 14.1.
- `R2-B6 ACCEPT (MINOR)` - the full docs pipeline is specified (`docs:extract`, `docs:compose`, `docs:publish`, `marketing.md` to `site/src/content/apps/burn.md`), plus the `apps/frontend/Dockerfile:232` rebuild requirement for the in-app Help Center. Section 9.6.1.
- `R2-B7 ACCEPT (MINOR)` - the `EventDefinition` shape is specified with `source:` preceding `event_type:` inside the guard's 300-character window, on the `event-catalog.ts:2940-2960` model. Section 8.2.
- `R2-B8 ACCEPT (MINOR)` - all three citations corrected after independent verification (`worker.ts:691-724` not `:673-679`; service-health `:63`/`:67` not `:62`/`:66`; `services.mjs:292/:297` not `:298`), the `customType` tsvector idiom named at `braid-profiles.ts:15-18`, and a standing re-verification rule added to 12.4.

**Infrastructure**
- `R2-I1 ACCEPT (BLOCKER)` - verified `hintFor()` returns `unknown` at `env-hints.mjs:325` and that `unknown` maps to SKIP, with required throwing at `railway-orchestrator.mjs:149-152`. Eight hints added plus a coverage test over every catalog env name. **Also confirmed and flagged: `BOLT_API_INTERNAL_URL` has no hint today while being `required` on bulwark-api, so bulwark's Railway path throws; this build fixes it.** Sections 9.6.2, 15(10).
- `R2-I2 ACCEPT (MAJOR)` - the rollout builds and recreates burn-api, bill-api, bolt-api, worker, mcp-server, api, and frontend, with the negative verification probes. Section 9.8.
- `R2-I3 ACCEPT (MAJOR, second option per the coordinator)` - the `/metrics` clause is **dropped**; a shared package used by 22 services is not changed for an observability nicety. The log codes, console panel, and `gate_outage` variance remain, and **`burn:gate_calls` increments on every gated write attempt including the unconfigured no-op**, so a missing env var reads as 0 percent coverage rather than 0/0. Sections 5.5.2, 12.1, 12.2 story 10.
- `R2-I4 ACCEPT (MAJOR)` - a Redis row added to 5.5 (fail open, `redis_unavailable`, in-process fallback on the `confirm-token-store.ts` model), every Redis touch in the client wrapped and non-throwing, and Redis sizing with a raise threshold in 9.7. Verified `--maxmemory 256mb --maxmemory-policy noeviction` at `docker-compose.yml:29-40` with the comment confirming writes error at the cap. Sections 5.5, 5.5.3, 9.7.
- `R2-I5 ACCEPT (MAJOR)` - the reverse leg is specified: a rate-resolve failure yields `unrated/rate_service_unavailable`, excluded from every envelope and rollup, surfaced in queue health, retried; `BILL_API_INTERNAL_URL` promoted to **required** with a hint; a fourth integration negative added. Sections 2.3.1.2, 5.5, 9.1, 12.3.
- `R2-I6 ACCEPT (MAJOR)` - internal routes derive the org from the validated payload and set the GUC in-transaction; the reaper, retention, and calibration jobs **iterate orgs**; both are in the mandatory RLS test. This defect was introduced by round 1's own T6 fix. Sections 2.4(14), 8.1, 12.1.
- `R2-I7 ACCEPT (MAJOR)` - the LLM cap is **moved out of the open questions into 9.7.1 as a specified deliverable** with a Redis token-bucket mechanism, named defaults, a 429 contract, defined client behavior, and a done criterion; `api` is added to the sizing paragraph; and "2 replicas" is restated as an explicit Railway-dashboard operator instruction rather than an unactionable compose claim. Sections 9.7, 9.7.1, 16.
- `R2-I8 ACCEPT (MINOR bundle)` - (a) `apps/bill/` named as a changed app with the `BurnGateNotice` component and story 4 updated; (b) `bill-api` dropped from `burn-api.needs` with the mutual-dependency reasoning stated; (c) `frontend.depends_on` follows the freshest satellite precedent (bulwark, basis, braid are all present) with the ingress tradeoff stated explicitly; (d) the rollout reordered into two migrate passes; (e) the three new bill-api vars added to `.env.example`. Sections 7.8, 9.4, 9.5, 9.6, 9.8.

### Findings rejected

**One partial rejection across both rounds**, restated here so it is not lost: round 1's S3(a) alternative of raising `burn.precheck.override` wholesale above the member floor. A member who hits a block must be able to proceed; requiring an admin for every override recreates exactly the friction that gets the feature switched off permanently, which is the risk the entire gate design exists to defeat. The finding's own second alternative, splitting the `gate_wrong` label into an owner/admin permission, is taken instead and round 2's R2-S7 extends the same split to `wrong_call`. Argued at 5.6.

Every other finding across both rounds was accepted or accepted with a stated modification.





