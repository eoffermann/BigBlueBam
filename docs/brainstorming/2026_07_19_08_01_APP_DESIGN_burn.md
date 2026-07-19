# Burn - App Design Specification

> Burn watches the work a services firm is actually doing against the contract that paid for it, blocks the charge that was never in scope before it posts, and reports which client is consuming its contract fastest and exactly what caused it.
>
> Status: design draft, **hardened through adversarial review round 1** (10 blockers, 26 majors, 8 minors; dispositions in the Changelog). New app. Winner of the 2026-07-19 08:01 suite-brainstorm session (Seat F, 27 of 30 points).
> Chosen internal port: **4022** (verified free; highest current is bulwark-api at 4021; the blueprint/bureau shared-4015 trap does not affect it).
> Routes: SPA at `/burn/`, REST at `/burn/api/`, realtime at `/burn/ws`.
> Chosen final name: **Burn** (single word). App id `burn`.

Freshest build precedent cited throughout: `docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md` and the shipped Bulwark app (`apps/bulwark-api/`, migrations `0234`-`0238`, `apps/worker/src/worker.ts:2207-2260`). Burn reuses Bulwark's extraction pattern, durable-inbox pattern, HITL-via-`agent_proposals` pattern, hand-authored-permissions sequence, and Braid/can_access client shapes. It does **not** reuse Bulwark's tables, deadline arithmetic, or firing loop.

House style: no em dashes or en dashes in this document; no Co-Authored-By footer.

---

## 1. Overview and positioning

### 1.1 One-liner and product thesis

Burn reads the signed SOW, proposal, or engagement letter (a **Bin** asset) into a **deliverable ledger**: a typed list of what was actually sold, each item carrying a clause citation and a **priced envelope**. It then continuously classifies every unit of work the org logs against that ledger, in dollars, attributed to a Braid-resolved client, with an explicit **`unscoped` bucket that is the product**: every item in it is work someone is doing that nobody sold.

The axis is **latency plus interception**. Time trackers know hours but not scope. Project tools know tasks but not price. Accounting knows invoices but not the work. None of them has ever read the contract. Nothing at this price point blocks a charge against a contract term before it posts, which is the entire difference between a change order and a write-off.

### 1.2 What the headline number actually is (round-1 blocker D1)

The single most consequential finding of review round 1: **the platform has no cost rate.** `bill_rates.rate_amount` is the rate charged *to the client*, proven by `apps/bill-api/src/services/invoice.service.ts:583` which resolves it straight into `unit_price` on an invoice line item. Grepping every `apps/*/src/db/schema/` for `cost_rate` or `internal_rate` returns nothing. Therefore `contract_value - sum(billing_rate x hours)` is **contract consumption at list price**, which is rate realization, not margin. On a pure T&M engagement it is definitionally zero margin. A principal shown "margin 34 percent" that actually means "66 percent of the contract burned at list rates" may reprice or fire a client on a wrong number.

Burn resolves this by owning the missing primitive **and** by refusing to mislabel when it is absent:

- **`burn_cost_rates`** is a Burn-owned, effective-dated, org/user/project cost-rate table (Section 3.1) with its own settings screen. An org that configures cost rates gets **true margin**, computed as `billable_amount - cost_amount`.
- An org that configures none gets **contract consumption**, labeled exactly that, everywhere: screen title, API field, MCP response, and export. There is no code path that prints the word "margin" over a consumption figure.
- Every financial response carries an explicit discriminator `metric_basis: 'true_margin' | 'contract_consumption'`, and the UI label is derived from it rather than hard-coded.
- Where a work item has no cost rate it is badged `no_cost_rate` and excluded from margin rollups exactly as `unrated` is excluded from consumption rollups. Partial coverage yields a coverage percentage displayed next to the figure, never a silently blended number.

Consequent renames throughout this spec: permissions are `burn.financials.read` / `burn.financials.read_all` (not `burn.margin.*`); routes are `/v1/financials` and `/v1/financials/accounts`; the variance kind is `consumption_erosion`; the landing screen is the **Portfolio Board**. The MCP tool keeps the name `burn_margin` because the winning submission named it as a secondary flagship and agents will reach for it, but its response is the discriminated shape above, so the tool cannot mislabel either.

### 1.3 Who it is for

The owner, principal, or delivery lead at a services firm of 2 to 50 people: agency, consultancy, design shop, engineering contractor, bookkeeping practice. A horizontal buyer, not a vertical bet.

### 1.4 Burn is not Bulwark for SOWs, and the separation is structural

| | Bulwark | Burn |
| --- | --- | --- |
| Unit of work | a **clause with a date** | **every task, ticket, hour and expense the company logs** |
| Question asked | has this obligation's deadline triggered, and have we discharged it | which priced envelope does this belong to, or does it belong to any |
| Core mechanism | deterministic timezone-anchored deadline arithmetic over a finite extracted set | a **continuous classifier** over an unbounded, growing stream |
| Output | a drafted notice | a blocked charge, a drafted change order, a consumption or margin figure |
| Touches a timesheet | never | that is its input |
| Applies a rate | never, and structurally cannot | on every work item, and owns its own cost-rate table |
| Has an attribution model | no | that is the app |
| Tables | `bulwark_*` (9) | `burn_*` (14), disjoint |

They share only the extraction pass. Burn reuses the **pattern** at `apps/bulwark-api/src/services/extraction.service.ts` and the **client** at `apps/bulwark-api/src/lib/internal-llm.client.ts` (ported, not imported, exactly as Bulwark itself ported `can-access.client.ts` from `apps/braid-api/src/lib/can-access.client.ts`). Extraction is roughly 15 percent of Burn by weight; the rest is attribution and the gate, neither of which exists in Bulwark.

Burn does not read `bulwark_obligations` in v1 (Open Question 9).

### 1.5 How it sits next to the four apps it joins

- **Bin** (`apps/bin-api/`, `@bigbluebam/storage`) holds the contract bytes. Burn references a `bin.asset` after a `can_access` preflight and never becomes a second DAM.
- **Bam** (`apps/api/`) holds the work: `tasks` (`apps/api/src/db/schema/tasks.ts`), `phases` (`phases.ts`), `time_entries` (`time-entries.ts`). Burn reads them and never writes a task except as a proposal.
- **Bill** (`apps/bill-api/`) holds the money: `bill_rates` (`bill-rates.ts`), `bill_expenses` (`bill-expenses.ts`), `bill_line_items`, `bill_recurring_invoices`, `bill_clients` (which already carries `bond_company_id` at `bill-clients.ts:29`). Burn is the pre-transaction gate in front of Bill's money-out paths and drafts Bill line items as proposals. It never issues an invoice.
- **Bond** (`apps/bond-api/`) holds the client. Burn resolves the account through `braid_resolve` so DBAs and legal entities collapse to one golden id.

### 1.6 v1 scope

Objects: `engagement` (with a first-class **amendment chain**), `engagement_project` link, `deliverable`, `work_item`, `attribution`, `attribution_rule`, `precheck`, `variance`, `classifier_feedback`, `cost_rate`, `engagement_rollup`, `ingest_event`, `extraction_run`, `org_settings`.
Surfaces: Portfolio Board, unscoped queue, deliverable burn-down, gate console, variance and change-order inbox, cost rates, settings.
Flagship MCP tool: `burn_precheck(work_ref)`. Secondary: `burn_attribute(work_ref)`, `burn_margin(account)`.

Non-goals are Section 13.

---

## 2. AI-native design

Burn has **two distinct AI mechanisms** with different failure modes and different guardrails, plus a gate that is deliberately not an AI decision at the point where it blocks money.

1. **Deliverable extraction** (bounded, one-shot per document, always human-reviewed).
2. **Continuous attribution** (unbounded, per work item, forever). The core.

### 2.1 The two-plane split, and the safety invariant

- **Semantic plane (LLM, best-effort, always reviewable).** Chooses *which deliverable* a work item belongs to, from a bounded candidate set. Never computes a dollar. Never issues a block.
- **Deterministic plane (reproducible, auditable).** Computes valuation from rates and minutes, envelope consumption by arithmetic, the gate verdict, and every variance.

**The safety invariant, now literally true (round-1 D7).** In blocking mode the **only** verdict that stops a write is `deny`, and a `deny` is a pure function of `(target_deliverable_id, envelope_amount, attributed_to_date, proposed_amount, org_settings)`. Low classifier confidence produces `needs_mapping`, which **posts the charge with an inline note and a queue item, and never blocks in v1**. Round 1 correctly observed that a blocking `needs_mapping` is produced precisely by low confidence, which falsified the invariant as originally written, and was also the one blocking verdict the calibration machinery never measured. There is now no path from classifier confidence alone to a stopped write.

### 2.2 Autonomy bands

| Action | Autonomy | Gate |
| --- | --- | --- |
| Extract deliverables from a Bin asset | Autonomous (worker), best-effort | `burn-extract-deliverables`; Bin `can_access` preflight first |
| Confirm / edit / reject a deliverable, set its envelope | HITL, permission + project-scoped | `burn.deliverable.write`; **every envelope including a `stated` one requires confirmation** (S7); reject is destructive |
| Apply a deterministic attribution rule | Autonomous, `method='rule'`, evaluated **before** any LLM call | org-authored rules (D5) |
| Attribute at or above `auto_attribute_threshold` | Autonomous | reversible; never supersedes a human decision (T8) |
| Attribute between thresholds | Queued for a human, never guessed | `pending_review` |
| Attribute below `review_threshold` | `unscoped`, reason `low_confidence` | the queue is the product |
| Run a precheck | Autonomous, synchronous, bounded, circuit-broken | `burn.precheck.run`; fail-open and **observably counted** (T5/I1) |
| **Block** a money-out event | Autonomous ONLY in `blocking` mode, ONLY on a deterministic `deny`, ONLY after the calibration gate is earned | Section 5 |
| Override a block | HITL, permission, reason of record required | `burn.precheck.override` |
| Label a verdict wrong | HITL, **owner/admin floored** | `burn.precheck.mark_wrong` (S3) |
| Promote the gate to blocking | HITL, owner/admin, server-side calibration gate | `burn.settings.write` + Section 5.4 |
| Auto-demote to advisory | Autonomous, one-way toward safety | `burn-calibration-recompute` |
| Draft a change order or Bill line item | Autonomous draft, HITL to act | `agent_proposals`; never sent, never posted unattended |
| Delete an engagement | HITL, destructive, owner/admin | `burn.engagement.delete` (confirm token) |
| Edit org settings, incl. gate mode | Permission-gated, owner/admin | `burn.settings.write`; **confirm token on gate DISABLE** (S10) |

**HITL boundary.** Direct insert into `agent_proposals` (`0128_agent_proposals.sql`) with `approver_id=NULL` (nullable at `:37`) and explicit `expires_at = now() + 7 days` (`:41`), rather than the public `POST /v1/proposals` which mandates an approver (`apps/api/src/routes/proposals.routes.ts:40`). Subject types `burn.change_order`, `burn.line_item`. **`proposed_payload` is refs-only** (`{ burn_draft_id, engagement_id, deliverable_id }`), never clause text, client name, or dollar total, so the platform `proposal_list` / `proposal_decide` tools cannot leak financials past Burn's own floor. After insert, `publishBoltEvent('proposal.created', 'platform', ...)` mirroring `proposals.routes.ts:114-134`.

### 2.3 The attribution model

#### 2.3.1 What a work item is

| `source_type` | Source | Valuation basis |
| --- | --- | --- |
| `bam.time_entry` | `time_entries` (`apps/api/src/db/schema/time-entries.ts`) | `minutes` x resolved rate |
| `bam.task` | `tasks` (`tasks.ts`) | `time_logged_minutes` delta x rate, or `none` |
| `helpdesk.ticket` | helpdesk tickets | `none` unless time is logged |
| `banter.thread` | banter messages, opt-in | `none` (signal only, never priced) |
| `bill.expense` | `bill_expenses` (`bill-expenses.ts`) | `amount` (already minor units) |
| `bill.recurring` | `bill_recurring_invoices` | generated invoice total |
| `vcs.commit` | `github_integrations`, opt-in | `none` (signal only) |

**Valuation is deterministic and never LLM-produced.** Two figures per work item, kept separate and never conflated:

- `billable_amount` (what the client is charged) from Bill's rate.
- `cost_amount` (what it costs the firm) from `burn_cost_rates`, null and badged `no_cost_rate` when unconfigured.

**Rate resolution is delegated, not restated (round-1 D2).** `apps/bill-api/src/services/rate.service.ts:117` documents and implements **`user+project > user > project > org`** and treats `effective_to` as **inclusive** (`or(isNull(effective_to), gte(effective_to, date))`). The round-1 draft of this spec stated `project`-only ahead of `user`-only and an exclusive bound, both wrong, and its unit test asserted the wrong order, which would have locked the bug in. Burn therefore does **not** restate the algorithm. This build adds **`POST /internal/rates/resolve`** to bill-api (guarded by `INTERNAL_SERVICE_SECRET`, the shape Bulwark's braid client uses against `POST /v1/internal/resolve`), delegating to the existing `resolveRate` so there is exactly one implementation. Burn's own `burn_cost_rates` resolver mirrors that four-branch order and inclusive bound deliberately, and a **parity test** asserts Burn's cost resolver and Bill's `resolveRate` agree across a shared fixture matrix, so drift is caught rather than assumed away. The composite index `idx_bill_rates_resolve` (`bill-rates.ts:31`) encodes no precedence and is cited only as a supporting b-tree, never as the source of the ordering.

**Currency.** Minor units throughout. One currency per engagement chain. Mismatches are flagged `currency_mismatch` and excluded from rollups, never converted (Open Question 6).

#### 2.3.2 Source observation, epochs, edits, and deletes (round-1 T2, T3, D6, solved as one redesign)

Round 1 landed three findings that were really one design hole; patching them individually would have left the seams.

**Epochs are content hashes over cost-and-classification-relevant fields only. `updated_at` is NEVER an epoch input for any source type.** `tasks.updated_at` bumps on any field change including board position, phase, assignee, and title (`apps/api/src/db/schema/tasks.ts:92`), so an `updated_at` epoch made every kanban drag a new work item, a new classification, and a new LLM call, consuming `attribution_llm_daily_cap` on no-op churn until real items deferred to `pending_attribution` on the busiest days. And `time_entries` has **no `updated_at` at all**, only `minutes`, a business `date`, `task_id`, `user_id`, `description`, and `created_at`, so there was nothing to hash for the primary source.

Per-source epoch definitions, each over columns that provably exist:

| `source_type` | `source_epoch = sha256(...)` |
| --- | --- |
| `bam.task` | `time_logged_minutes, project_id, normalize(title), normalize(coalesce(description_plain,''))` |
| `bam.time_entry` | `minutes, date, task_id, normalize(coalesce(description,''))` |
| `bill.expense` | `amount, currency, project_id, expense_date, normalize(description), coalesce(vendor,'')` |
| `bill.recurring` | generated invoice id + total |
| `helpdesk.ticket` | `status, normalize(subject)` |
| `banter.thread` / `vcs.commit` | message or commit id (immutable) |

An epoch match **short-circuits before candidate assembly and before any llm-provider call**, so a no-op re-observation costs one index probe on `UNIQUE (organization_id, source_type, source_id, source_epoch)`.

Content hashing also solves edits without a platform dependency: an edited time entry produces a different content hash and is detectable even though `time_entries` has no `updated_at`, provided the sweep re-reads the row. So reconcile has three passes:

1. **New-row watermark scan.** `created_at` is named as the sole watermark, with a per-org high-water mark persisted in `burn_org_settings.last_source_watermark` (a JSONB map per `source_type`). A `date`-based watermark would permanently miss backdated timesheets, which is the normal case; `created_at` catches every insert regardless of business date.
2. **Recency re-read.** All source rows for open engagements with `occurred_at` inside `reconcile_window_days` (default 90) are re-read and re-hashed each sweep. A changed hash creates a new observation and marks the prior `excluded` with `exclusion_reason='superseded_epoch'`, reversing its dollars in the same transaction.
3. **Bounded anti-join for deletes.** `apps/bill-api/src/routes/expenses.routes.ts` exposes both `PATCH /:id` and `DELETE /:id`, and neither the event path nor a watermark scan can observe an absence. Within the same window Burn anti-joins its work items against the source and marks vanished rows `excluded` with `exclusion_reason='source_deleted'`, reversing their dollars. Without this, deleted expenses and tasks consume the envelope forever and, in blocking mode, deny real charges against phantom consumption. A `variance_kind='phantom_consumption'` guard fires when reversals in one sweep exceed a threshold, because a large reversal usually means something upstream went wrong.

**Index path, no new platform indexes required.** The sweep drives from `burn_engagement_projects -> tasks.project_id` (existing `tasks_project_id_idx`) then `time_entries.task_id` (existing `time_entries_task_id_idx` at `time-entries.ts:22`), bounded by the recency window. It never scans `time_entries` org-wide, which would require a join through `tasks -> projects` with no supporting index, growing unboundedly with the org's entire history. `time_entries` carries no `organization_id` and no `project_id`; that is a stated platform fact the design routes around rather than a dependency it waits on.

**Stated limitation.** A time-entry edit is detected only inside `reconcile_window_days`. Edits to older entries are invisible until the platform adds `time_entries.updated_at`, listed in Open Question 13 rather than assumed.

**`burn_work_items.exclusion_reason varchar(32)`** holds these states; the round-1 draft referenced an exclusion reason with no column to store it.

#### 2.3.3 Stage zero: deterministic rules (round-1 D5)

Before any retrieval or LLM call, org-authored rules in `burn_attribution_rules` evaluate in priority order. A rule matches on project, phase, label, client, task-title regex, or expense category, and its outcome is either a target deliverable or a **non-billable exclusion** with a typed reason. Matches write `method='rule'`, cost zero LLM budget, and are fully explainable. This is how a firm encodes "the internal retro project is never billable" once instead of correcting it two hundred times.

#### 2.3.4 Stage one: bounded candidate retrieval

At most `candidate_k` (default 8) **deliverables across all engagements linked to the work item's project**, from four deterministic signals:

1. **Structural.** The work item's `project_id` resolves through `burn_engagement_projects` to **every** engagement linked to that project. Round 1 correctly observed that a single nullable `project_id` could not model an MSA covering three projects, a project covered by two concurrent SOWs, or a multi-phase engagement, and became silently ambiguous the moment two active engagements shared a project. The candidate set now disambiguates across engagements as well as within one.
2. **Precedent.** Prior `confirmed` attributions for the same task, its parent (`tasks.parent_task_id:37`), its epic (`:45`), its sprint, or its labels. The strongest single signal in practice.
3. **Link graph.** `entity_links` (`0132_entity_links.sql`) rows already connecting the source record to a Bond account, Bill client, or engagement.
4. **Lexical retrieval.** Postgres full-text plus trigram similarity over deliverable titles, cited quotes, and confirmed exemplars. `pg_trgm` is already installed at `infra/postgres/migrations/0000_init.sql:22`.

**On Qdrant, the honest platform finding.** `apps/beacon-api/src/services/embedding.service.ts:17` returns **zero vectors of dimension 1024** with a "replace with actual embedding API call" comment, and `apps/brief-api/src/services/embedding.service.ts` is transport-only with model selection deferred to a worker that selects none. There is no working embedding provider in the tree. Building Burn's precision on vector recall would ship a classifier retrieving noise. **Lexical retrieval is the shipped path.** The Qdrant path is fully specified behind `burn_org_settings.embedding_enabled` (default **false**), with `QDRANT_URL`/`QDRANT_API_KEY` optional exactly as `apps/braid-api/src/env.ts:29-31` declares them, and reserved `qdrant_point_id`/`qdrant_synced_at` columns present from migration `0239` (mirroring `apps/braid-api/src/db/schema/braid-profiles.ts:46-47`). Flipping the flag later adds a fifth signal with no schema change. Open Question 1, owned by the platform.

#### 2.3.5 Stage two: bounded LLM adjudication

The candidate set plus the snapshotted text goes to `POST /internal/llm/chat` (`apps/api/src/routes/internal-llm.routes.ts`) through a ported client shaped like `apps/bulwark-api/src/lib/internal-llm.client.ts`. Rules, enforced in code:

- Untrusted work-item text is fenced in a delimited DATA block.
- The model must return **an id from the supplied candidate set, or the literal `unscoped`**. Anything else drops to `pending_review`. Injection cannot invent a target.
- Returns `{ deliverable_id | "unscoped", confidence, rationale }`. `rationale` is display-only, truncated, never computed on.
- Zod-validated against `packages/shared/src/schemas/burn.ts`. Malformed responses fall to `pending_review`, never to a guess.
- The model **cannot emit a dollar amount, rate, envelope, or verdict**; any such field is stripped.
- Bounded by `AbortController` on `LLM_TIMEOUT_MS`. A timeout yields `pending_review`, not `unscoped`: "we could not decide" is a different claim from "nobody sold this."

#### 2.3.6 Confidence bands

| Band | Default | State | Behavior |
| --- | --- | --- | --- |
| `>= auto_attribute_threshold` | 0.90 | `auto_attributed` | counts toward the envelope; fully reversible |
| `>= review_threshold` | 0.60 | `pending_review` | queued; does **not** count toward the envelope until resolved or aged out (2.3.8) |
| `< review_threshold` | | `unscoped` / `low_confidence` | surfaces in the queue |
| model returned `unscoped` | any | `unscoped` / `no_matching_deliverable` | **the money finding** |

The two unscoped reasons are structurally distinct and never merged in any query, response, or screen. `no_matching_deliverable` is a scope-creep finding; `low_confidence` is a tuning finding. Conflating them would let a weak classifier masquerade as a business insight.

Thresholds are per-org, clamped by DB `CHECK` constraints: `auto_attribute_threshold` in [0.75, 0.99], `review_threshold` in [0.30, `auto_attribute_threshold` - 0.05].

#### 2.3.7 Non-billable is a first-class state (round-1 D5)

`attribution_state` includes **`excluded_non_billable`** with a typed reason (`internal`, `pre_sales`, `pto`, `warranty`, `overhead`, `rework`), one keystroke from the queue. Without it, a retro, a sales call, PTO, or warranty rework could only be mis-mapped to a deliverable or left in `unscoped` forever, permanently inflating the headline "$X of work nobody sold" and destroying the credibility of the one number the app exists to produce. Marking non-billable writes `burn_classifier_feedback` with `decision_kind='mark_non_billable'`, so the rule engine and the retrieval corpus both learn it.

#### 2.3.8 Queue health, and why an ignored queue corrupts the number

Round 1 identified a failure the buyer cannot detect: `pending_review` items do not count toward the envelope, so an ignored queue **understates** burn, the board reads healthier than reality, and the gate under-blocks. Four mechanisms:

1. **Clustering.** The queue groups by task tree and normalized title signature, so one decision closes a group.
2. **Aging and auto-demotion of stale reviews.** A `pending_review` attribution older than `pending_review_max_age_days` (default 14) is automatically demoted to `unscoped` / `low_confidence`, so its dollars **re-enter the reported total** rather than hiding.
3. **Queue health on the Portfolio Board**: inflow versus resolution rate, oldest item age, and **"$X sitting in pending review and therefore excluded from every envelope"** stated explicitly next to the headline figure.
4. **Deterministic rules (2.3.3)** cut inflow at the source.

#### 2.3.9 Tuning: the org's private vocabulary

Every human accept, reject, reclassify, or non-billable mark writes `burn_classifier_feedback` capturing the text snapshot, the classifier's proposal, and the correction. Those rows do three things:

1. **Retrieval exemplars.** Confirmed `(text, deliverable)` pairs join the lexical corpus, weighted above deliverable titles.
2. **Few-shot examples.** The top `exemplar_k` (default 6) most similar corrections are injected into the stage-two prompt as labeled examples, fenced as DATA identically to the item under adjudication.
3. **Measured calibration.** Each row is a labeled sample feeding `GET /v1/calibration`, gate promotion (5.4), and auto-demotion (5.6).

**Explicitly not fine-tuning.** No per-org training, no weight update, no gradient. Retrieval-corpus growth plus few-shot injection plus threshold calibration.

`burn_org_settings.vocabulary_version` increments on every feedback write so retrieval and prompt caches invalidate deterministically.

#### 2.3.10 Reversibility and the human-precedence invariant (round-1 T8)

Reclassifying supersedes rather than mutates: the prior row gets `superseded_at` and a new row is inserted, in one transaction with `SELECT ... FOR UPDATE` on the live row.

**Invariant: the attribution engine never supersedes a row with `state='confirmed'` or `method='human'`. It may only raise a `pending_review` proposal alongside it.** With `vocabulary_version` bumping on every feedback write and re-attribution triggering on epoch change, the ordinary path otherwise has the worker re-deciding items a human already decided. A user watching their own correction silently revert is the fastest way to destroy trust in the number.

Concurrent triage of the same row returns **409 with the current state** (the platform-standard stale check from `CLAUDE.md`), never a raw 23505 surfacing as a 500. `POST /v1/attributions/bulk` returns per-item results `{ applied: [], conflicted: [], failed: [] }`, never all-or-nothing.

### 2.4 Security model

1. **Reads are permission-tiered AND project-scoped.** `burn.financials.read` returns figures for engagements linked (through `burn_engagement_projects`) to a project the caller is a member of, org-admin override. `burn.financials.read_all` (owner/admin floor) is required for the firm-wide roll-up, cross-engagement comparison, `contract_value`, and `cited_span.quote`.
   **`isProjectMember` is at `apps/api/src/services/visibility.service.ts:203` and is NOT exported.** Round 1 caught the stale ":192-207" cite and the false "the same predicate" claim. Burn **ports** the predicate into `apps/burn-api/src/lib/project-scope.ts` (exactly what `apps/bulwark-api/src/lib/project-scope.ts` does) and owns a parity test against platform behavior. Every project-scoped route goes through one shared query builder; every mutating route through one shared guard.
2. **No floored quantity is emitted twice in different units (round-1 S4).** A consumption percentage plus consumed dollars yields `envelope_amount` by division, and summing across deliverables recovers `contract_value`. Non-`read_all` callers therefore receive consumption as a **coarse band** (`under_50`, `50_80`, `80_100`, `over`) and never an absolute alongside it. `GET /v1/prechecks` and `GET /v1/change-orders/:id` are both annotated project-scoped and strip `envelope_amount`, `envelope_consumed`, `contract_value`, and `clause_ref` without `read_all`. A test asserts a member cannot recover `contract_value` to within 5 percent from any combination of member-reachable responses.
3. **Per-person dollars are the secret, not `source_id` (round-1 S6, accepted with modification).** The finding is right that excluding `actor_id` is insufficient: `source_id` for a `bam.time_entry` is a `time_entries` row id and `time_entries.user_id` is readable by any project member through `/b3/api/`, so joining yields per-person cost. But both offered fixes are worse than the defect. An opaque HMAC `source_id` breaks the deep link to the source record, which is the entire evidentiary value of the queue; an owner/admin floor on `GET /v1/work-items` removes the project lead's view of their own job's ledger, a stated product requirement. **Burn's fix:** `source_id` is returned (needed for the deep link and the `can_access` preflight), but **`billable_amount` and `cost_amount` are omitted for `bam.time_entry` and `bam.task` sources for non-`read_all` callers**, replaced by a deliverable-level aggregate. The join then yields per-person *hours*, which any project member can already read in Bam, and never per-person *dollars*, which is the genuinely new disclosure. `text_snapshot` and `title_snapshot` are returned only to project members and are redacted of email addresses and `@mentions` on write. `decided_by`, `overridden_by`, and feedback authorship are floored to `read_all`. The test **attempts the join** and asserts it yields no dollar figure, rather than only asserting an absent key. Section 13's non-goal wording is narrowed to exactly this.
4. **`can_access` preflight on every cited source record.** Before rendering any cited record, `preflightAccess(asker, entity_type, entity_id)` through a ported `can-access.client.ts` (`apps/bulwark-api/src/lib/can-access.client.ts`), fail-closed on non-2xx, timeout, or missing secret. Denied items are dropped and reported as "N items hidden by permissions" so totals stay honest without leaking rows. New `SUPPORTED_ENTITY_TYPES` entries `burn.engagement` and `burn.deliverable` (added to `visibility.service.ts:107`, following the Bulwark precedent at `:139-142`).
5. **The gate is not an oracle (round-1 S1).** `POST /v1/precheck` is **project-scoped**, resolves the engagement from `project_id`/`work_ref_id`, and applies the shared guard before evaluating anything. As originally written any member could call it repeatedly against a project they are not a member of, with a fabricated pending charge, and read back exact envelope dollars and clause references, then sum them to reconstruct `contract_value`. The response is also floored: non-`read_all` callers get `overage_amount` ("you would exceed this by $X") and a band, never `envelope.amount` or `envelope.consumed`. The deny UX needs the overage, not the contract figures.
6. **Idempotency keys are server-derived and time-bounded (round-1 S2 + T9, solved together).** The key is `hmac(INTERNAL_SERVICE_SECRET, caller_namespace || work_ref_type || work_ref_id || proposed_amount || currency || attempt_nonce)`, namespaced `svc:` for the internal route and `usr:` for the user route, enforced by a `CHECK` on the prefix. On a key hit, stored `proposed_amount`, `currency`, and `work_ref_type` are re-validated and the verdict recomputed on any mismatch. `burn_prechecks.valid_until` (default now + 5 minutes) bounds replay: past it, recompute and supersede. Round 1's attack was concrete and would have worked: bank an `allow` on a 1-cent charge under a predictable key, then let the real $60,000 charge hit the unique index and be handed the stored verdict. A fresh key is required whenever `amount` or `project_id` changes.
7. **Demotion cannot be weaponized by a member (round-1 S3).** The `gate_wrong` label moves to a separate **owner/admin-floored `burn.precheck.mark_wrong`**; benign override codes stay at member level. I reject the finding's first alternative of raising `burn.precheck.override` wholesale: a member who hits a block must be able to proceed, and forcing an admin into every override recreates exactly the friction that gets the feature killed. Demotion additionally requires a **minimum absolute count of `gate_wrong` rows from a minimum count of distinct users**, not a bare rate, so a handful of rows at low volume cannot trip it. `POST /v1/internal/prechecks/:id/outcome` moves under `/v1/internal/` with `INTERNAL_SERVICE_SECRET`. Demotion notifies org admins with contributing rows named, auditably.
8. **Bin asset preflight on register**, re-checked at byte-read time against `created_by` so a later ACL change is honored.
9. **Document parsing is bounded and inert (round-1 S7).** `MAX_DOC_BYTES` (default 25 MB), `MAX_DOC_PAGES` (default 300), and a wall-clock cap on the parse phase. The PDF/OOXML parser runs with **JavaScript execution and external-entity resolution disabled**. Exceeding a limit flags the engagement for manual entry rather than partially extracting.
10. **`/v1/internal/*` fails CLOSED on an empty secret**, rejecting 401 before any timing-safe compare. Deliberately stronger than the looser multi-secret shape at `apps/api/src/routes/internal-llm.routes.ts:64`: with a single required secret an empty-vs-empty compare authorizes an unauthenticated caller. Do not "align" it downward.
11. **Cross-app writes carry the decider's own authority (round-1 S8a).** On change-order approval Burn does **not** assert a `burn.*` permission and then write into Bill. It calls bill-api **as the decider, with the decider's credentials**, and lets bill-api's own `fastify.requireCan('bill.*')` be the authority (the pattern throughout `apps/bill-api/src/routes/expenses.routes.ts`). Burn asserts `burn.changeorder.draft` **and** bill-api asserts its own; both must hold.
12. **`llm_provider_id` org ownership is validated on write.** `apps/api/src/routes/internal-llm.routes.ts:117-126` resolves the provider by `id` and `enabled` only, **with no org predicate**, so a Burn org admin who learned another org's provider id would get that tenant's decrypted key used on their behalf. Burn validates org ownership at `PATCH /v1/settings` regardless of what the platform route does. The platform gap is tracked separately and named in Open Question 12; Burn does not wait on it.
13. **Bolt payloads carry no magnitudes (round-1 S5).** The ws fan-out is project-scoped, but Bolt is org-level with no per-rule visibility: `preflightBoltRule` (`visibility.service.ts:1131-1150`) gates on org match alone, so any member could author a rule triggering on a Burn event and template the dollars into a Banter post or an email. **`amount` and `margin_pct` are removed from every Burn Bolt payload**; events carry refs plus a coarse severity band. Rule authors fetch figures through `GET /v1/financials` under their own permissions. `burn.*` outbound-webhook subscriptions additionally require org-admin authorship.
14. **RLS is a backstop that must be made to actually bind (round-1 S9).** All four existing plugins (`apps/api/src/plugins/rls.ts:38`, basis `:29`, braid `:30`, bulwark `:30`) issue `SELECT set_config('app.current_org_id', $1, true)` as a standalone `db.execute` on a pooled connection. The third argument is `is_local`, scoping the setting to the current transaction; a standalone statement is its own implicit transaction, so the GUC is discarded on return and subsequent queries may land on a different pooled connection. Under `BBB_RLS_ENFORCE=1` the policies would see an empty GUC on every query. **Burn does not copy the plugin as-is.** It binds each request's queries into one transaction with `set_config(..., true)` inside it, or checks out a connection for the request with `set_config(..., false)` and resets on release. The role-bound RLS test is **mandatory, not optional**: boot burn-api under `BBB_RLS_ENFORCE=1` and assert a query for org A returns zero org-B rows **with the app-level predicate removed**. This is a pre-existing platform defect tracked separately; Burn states the dependency and does not attempt to fix the other four plugins in this build.
15. **Not a surveillance tool**, scoped to exactly what point 3 enforces.

### 2.5 Guardrails summary

- **agent_policies**: every `burn.*` service-account call passes the kill switch plus `matchesAllowlist('burn.*')` in `apps/mcp-server/src/lib/register-tool.ts`. Not in the always-permitted core, so it fails closed until allowlisted. (Round 1 verified the glob genuinely matches `burn_precheck`.)
- **confirm_action** (`apps/mcp-server/src/lib/confirm-token-store.ts`): `burn_delete_engagement`, `burn_reject_deliverable`, and `burn_set_gate_mode` **when the target weakens enforcement** (`off`, `advisory`, or setting `gate_paused_until`). Round 1 correctly found the original boundary inverted: promotion to blocking is already protected by a server-side calibration gate, whereas disabling the firm's spend control had no second factor at all.
- **Rate caps**: `attribution_llm_daily_cap` (default 2000) per org. A cap breach queues `pending_attribution`, never `unscoped`, so it can never manufacture a false scope-creep finding.
- **can_access preflight** on every surfaced source record and on registration.

---

## 3. Data model

**14 tables.** All org-scoped, carrying `organization_id`, with RLS policies gated on `app.current_org_id` (and Section 2.4 point 14 on making that bind). Each gets a 1:1 Drizzle module under `apps/burn-api/src/db/schema/`:

`burn-engagements.ts`, `burn-engagement-projects.ts`, `burn-deliverables.ts`, `burn-work-items.ts`, `burn-attributions.ts`, `burn-attribution-rules.ts`, `burn-prechecks.ts`, `burn-variances.ts`, `burn-classifier-feedback.ts`, `burn-cost-rates.ts`, `burn-engagement-rollups.ts`, `burn-ingest-events.ts`, `burn-extraction-runs.ts`, `burn-org-settings.ts`, plus **`agent-proposals.ts`** and **`entity-links.ts`** (round-1 B3: the spec writes to both and `apps/bulwark-api/src/db/schema/` ships both modules; omitting them means `pnpm db:check` sees columns declared nowhere), `bbb-refs.ts`, and `index.ts` re-exporting all of them.

**Every column created in SQL must be declared in Drizzle**, including the generated `search_tsv` columns and the reserved `qdrant_point_id` / `qdrant_synced_at`. `scripts/db-check.mjs:454` treats a DB column absent from every Drizzle declaration as `UNKNOWN COLUMN in DB` and **exits 1** at `:486` (only type mismatches warn, at `:468`), which fails `db-drift.yml:75` and `migration-replay.yml:81`.

**Join boundary.** Burn uses `organization_id`; some platform tables use `org_id` (`tasks.org_id:30`). No cross-schema FKs to source-app tables; those are dotted `source_type` plus uuid, the `entity_links` convention. FKs to `organizations`, `users`, and `projects` are real.

### 3.1 Tables

**`burn_engagements`** - one contract, SOW, proposal, engagement letter, or **amendment**.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK `organizations(id)` ON DELETE CASCADE |
| `title` | varchar(512) NOT NULL | |
| `engagement_kind` | varchar(32) NOT NULL DEFAULT `'sow'` | `sow` \| `proposal` \| `engagement_letter` \| `msa` \| `retainer` \| `amendment` \| `change_order` \| `other` |
| `amends_engagement_id` | uuid | self-FK (guarded `DO $$`) ON DELETE RESTRICT. **The amendment chain (round-1 D3).** Set when this row ADDS to a live engagement |
| `supersedes_engagement_id` | uuid | self-FK ON DELETE RESTRICT. Reserved for a genuine **restatement** only |
| `chain_root_id` | uuid NOT NULL | denormalized root of the amendment chain, maintained on write. **All envelope math, rollups, financials, and gate evaluation resolve over the chain root** |
| `contract_value` | bigint | minor units, this row's own value. `read_all`-floored |
| `contract_value_delta` | bigint | minor units; for an amendment, the increment it adds. Chain contract value is `sum(coalesce(contract_value_delta, contract_value))` over the chain |
| `currency` | varchar(3) NOT NULL DEFAULT `'USD'` | one currency per chain, enforced on insert |
| `envelope_basis` | varchar(16) NOT NULL DEFAULT `'fixed'` | `fixed` \| `time_and_materials` \| `retainer` \| `not_to_exceed` |
| `budget_hours` | numeric(10,2) | optional hours envelope |
| `bin_asset_id` | uuid | the signed document, a `bin.asset` id, nullable (manual entry) |
| `account_type` / `account_id` | varchar(32) / uuid | typically `bond.company` |
| `braid_profile_id` | uuid | golden id when resolution succeeded; null degrades to `account_id` |
| `bill_client_id` | uuid | `bill_clients.id` (`bill-clients.ts:29` carries `bond_company_id`, the natural bridge) |
| `start_date` / `end_date` | date | |
| `timezone` | varchar(64) NOT NULL DEFAULT `'UTC'` | IANA; period boundaries for retainers and reporting |
| `status` | varchar(16) NOT NULL DEFAULT `'active'` | `draft` \| `extracting` \| `active` \| `superseded` \| `closed` |
| `extraction_status` | varchar(16) NOT NULL DEFAULT `'pending'` | `pending` \| `running` \| `extracted` \| `partial` \| `failed` \| `not_applicable` |
| `source_doc_hash` | varchar(64) | sha-256 of extracted bytes |
| `extracted_at` | timestamptz | |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | service-bumped |

Indexes: `(organization_id, status)`, `(organization_id, chain_root_id)`, `(organization_id, account_type, account_id)`, `(organization_id, braid_profile_id)`, `(organization_id, bin_asset_id)`, `(amends_engagement_id)`, `(supersedes_engagement_id)`.

**The amendment chain, in full (round-1 D3).** A change order **amends** an SOW: it adds deliverables and/or contract value while the original deliverables stay live. The round-1 draft's only relation was `supersedes_engagement_id` with `status='superseded'`, which deactivated the engagement, made its deliverables non-candidates and non-gating, left every existing attribution pointing at a dead deliverable that could not be cleaned up (`ON DELETE RESTRICT`), reset the burn-down to zero, and never rolled up `contract_value`. The end state of the flagship workflow had no representable data model. Now:

- **Amend** (`amends_engagement_id`, the normal case): the base engagement stays `active`; its deliverables stay `is_active`. The amendment contributes `contract_value_delta` and its own deliverables. Both engagements share a `chain_root_id`. Amendment deliverables are candidates for work on **any** project linked anywhere in the chain. The burn-down shows a **dated step up** in contract value at the amendment's `start_date`.
- **Restate** (`supersedes_engagement_id`, rare): the base becomes `status='superseded'`, and existing attributions are **migrated by matching `dedup_key`** from base deliverable to successor deliverable in one transaction. Any attribution whose deliverable has no `dedup_key` match becomes `pending_review` with reason `restatement_unmatched` and is surfaced in the queue. **Nothing is silently dropped**, and the `ON DELETE RESTRICT` on `burn_attributions.deliverable_id` is never violated because superseded deliverables are deactivated, not deleted.
- **Gate and rollup resolution:** always the chain root. A precheck against any engagement in a chain evaluates the chain's aggregate contract value and the union of its active deliverables. Both paths are tested (Section 12).

**`burn_engagement_projects`** - many-to-many between engagements and Bam projects (round-1 D4).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `engagement_id` | uuid NOT NULL | FK `burn_engagements(id)` ON DELETE CASCADE |
| `project_id` | uuid NOT NULL | FK `projects(id)` **ON DELETE CASCADE** |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, engagement_id, project_id)`, `(organization_id, project_id)` (the structural-signal lookup), `(engagement_id)`.

**Why CASCADE and not SET NULL.** The round-1 draft had a nullable `project_id` on the engagement itself with `ON DELETE SET NULL`, while every read and ws frame was gated on project membership. The predicate for a null project was undefined, so deleting a Bam project made a tracked engagement either invisible to everyone (silently zeroing the firm-wide roll-up) or visible to everyone (leaking financials). Now the link row simply disappears, and an engagement with **zero** linked projects is a defined, tested state: **visible only to `burn.financials.read_all` holders**, flagged `unlinked` on the Portfolio Board with a prompt to re-link, and **excluded from gate evaluation** (a precheck against an unlinked engagement can never `deny`). This is deliberately not a silent state.

**`burn_deliverables`** - one typed, clause-cited thing that was sold, with a priced envelope.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `engagement_id` | uuid NOT NULL | FK `burn_engagements(id)` ON DELETE CASCADE |
| `dedup_key` | varchar(64) NOT NULL | stable upsert and restatement-migration key: `hash(normalized_clause_ref, deliverable_kind, ordinal)` with `ordinal` by ascending `cited_span.char_start` within a `(clause_ref, kind)` group; for null-section items `hash(verified_quote_content, kind)` tied to `source_doc_hash`. LLM prose is never in the identity hash |
| `clause_ref` | varchar(64) | evidence only, nullable, non-unique |
| `title` | varchar(512) NOT NULL | |
| `description` | text | |
| `deliverable_kind` | varchar(32) NOT NULL DEFAULT `'work_product'` | `work_product` \| `milestone` \| `recurring_service` \| `support` \| `expense_allowance` \| `other` |
| `envelope_amount` | bigint | minor units. Null means unpriced; consumption tracked in hours only and it can **never** produce a deny |
| `envelope_hours` | numeric(10,2) | |
| `envelope_source` | varchar(24) NOT NULL DEFAULT `'proposed'` | `proposed` \| `human` \| `even_split` \| `stated` |
| `cited_span` | jsonb NOT NULL DEFAULT `'{}'` | `{ page, section, quote, char_start, char_end, chunk_index, verified }`; `quote` is `read_all`-floored |
| `due_date` | date | drives the silent-deliverable inverse check |
| `confidence` | numeric(5,2) | display and review ordering only |
| `review_status` | varchar(16) NOT NULL DEFAULT `'pending_review'` | `pending_review` \| `confirmed` \| `rejected` \| `superseded` (terminal, never deleted) |
| `is_active` | boolean NOT NULL DEFAULT false | true only when `review_status='confirmed'` **and a human has confirmed the envelope** (S7). Only active deliverables are candidates and gate inputs |
| `supersedes_deliverable_id` | uuid | self-FK (guarded `DO $$`) ON DELETE SET NULL |
| `search_tsv` | tsvector GENERATED ALWAYS AS ... STORED | see below |
| `qdrant_point_id` / `qdrant_synced_at` | uuid / timestamptz | reserved; null until `embedding_enabled` |
| `reviewed_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `reviewed_at` | timestamptz | |
| `extraction_run_id` | uuid | FK `burn_extraction_runs(id)` ON DELETE SET NULL |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**`search_tsv` is null-safe and regconfig-explicit (round-1 T10).** `description` is nullable and `cited_span->>'quote'` is null whenever the LLM omitted it, so a bare concatenation yields NULL and the whole tsvector is NULL, gutting stage-one recall on exactly the deliverables with the thinnest metadata, on the path that is actually shipped. The generated expression is exactly:

```sql
search_tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(title, '') || ' ' ||
    coalesce(description, '') || ' ' ||
    coalesce(cited_span->>'quote', ''))
) STORED
```

The `'english'` regconfig is named explicitly to satisfy Postgres's IMMUTABLE requirement for a generated column. The identical treatment applies to `burn_classifier_feedback.search_tsv` over `coalesce(text_snapshot,'')`.

Indexes: `UNIQUE (organization_id, engagement_id, dedup_key)`, `(organization_id, engagement_id)`, `(organization_id, review_status)`, `(organization_id, is_active) WHERE is_active`, `(organization_id, due_date)`, GIN on `search_tsv`, GIN trigram on `title`.

**`burn_work_items`** - the normalized ledger. **Highest-churn table.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `source_type` | varchar(32) NOT NULL | the enum in 2.3.1 |
| `source_id` | uuid NOT NULL | source row id; no cross-schema FK |
| `source_epoch` | varchar(64) NOT NULL | the **content hash** of 2.3.2. Never derived from `updated_at` |
| `project_id` | uuid | FK `projects(id)` ON DELETE SET NULL |
| `actor_id` | uuid | FK `users(id)` ON DELETE SET NULL. `read_all`-floored (2.4 point 3) |
| `occurred_at` | timestamptz NOT NULL | business time, not ingest time |
| `title_snapshot` | varchar(512) | classifier input, snapshotted; PII-redacted on write |
| `text_snapshot` | text | truncated to `TEXT_SNAPSHOT_MAX` (default 4000); PII-redacted on write |
| `minutes` | integer | |
| `billable_amount` | bigint | minor units; from Bill's resolved rate |
| `cost_amount` | bigint | minor units; from `burn_cost_rates`; null when unconfigured |
| `currency` | varchar(3) | |
| `valuation_basis` | varchar(16) NOT NULL DEFAULT `'none'` | `rate` \| `expense` \| `invoice` \| `none` \| `unrated` \| `no_cost_rate` |
| `bill_rate_id` | uuid | the `bill_rates` row used, for auditability |
| `burn_cost_rate_id` | uuid | FK `burn_cost_rates(id)` ON DELETE SET NULL |
| `attribution_state` | varchar(24) NOT NULL DEFAULT `'pending'` | `pending` \| `pending_attribution` \| `attributed` \| `pending_review` \| `unscoped` \| `excluded_non_billable` \| `excluded` (denormalized for cheap queue queries) |
| `exclusion_reason` | varchar(32) | `superseded_epoch` \| `source_deleted` \| `internal` \| `pre_sales` \| `pto` \| `warranty` \| `overhead` \| `rework` \| `currency_mismatch` (round-1 T2: the draft referenced this with no column) |
| `ingested_at` | timestamptz NOT NULL DEFAULT now() | |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, source_type, source_id, source_epoch)` (the idempotency atom), `(organization_id, attribution_state, occurred_at DESC)` (queue scan), `(organization_id, project_id, occurred_at)`, `(organization_id, source_type, source_id)` (the anti-join and re-read path), `(organization_id, occurred_at)`.

**Partitioning posture.** Highest-churn table; first candidate for **monthly partitioning on `occurred_at` per `0220_blip_entries_partitioned.sql`**. v1 ships unpartitioned at the 2-50 seat target with retention (3.1 `burn_org_settings`, and T11's exemption in Section 8.1).

**`burn_attributions`** - the versioned link from a work item to a deliverable.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `work_item_id` | uuid NOT NULL | FK `burn_work_items(id)` ON DELETE CASCADE |
| `deliverable_id` | uuid | FK `burn_deliverables(id)` **ON DELETE RESTRICT**; null means unscoped or non-billable |
| `engagement_id` | uuid | FK ON DELETE CASCADE; denormalized |
| `chain_root_id` | uuid | denormalized for chain rollups |
| `state` | varchar(24) NOT NULL | `auto_attributed` \| `confirmed` \| `pending_review` \| `unscoped` \| `excluded_non_billable` \| `rejected` |
| `unscoped_reason` | varchar(32) | `no_matching_deliverable` \| `low_confidence` \| `no_active_engagement` \| `outside_engagement_window` \| `restatement_unmatched` \| `aged_out` |
| `confidence` | numeric(5,2) | |
| `method` | varchar(24) NOT NULL | `rule` \| `structural` \| `precedent` \| `lexical` \| `llm` \| `human` |
| `candidate_set` | jsonb NOT NULL DEFAULT `'[]'` | the ids offered to the model, for decision reproducibility |
| `rationale` | text | display only, truncated |
| `billable_amount` / `cost_amount` | bigint | snapshotted at decision time |
| `superseded_at` | timestamptz | non-null means historical; rollups read `WHERE superseded_at IS NULL` |
| `superseded_by` | uuid | self-FK (guarded `DO $$`) ON DELETE SET NULL |
| `decided_by` | uuid | FK `users(id)` ON DELETE SET NULL; null for autonomous. `read_all`-floored |
| `decided_at` | timestamptz | |
| `vocabulary_version` | integer NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, work_item_id) WHERE superseded_at IS NULL`, `(organization_id, deliverable_id) WHERE superseded_at IS NULL`, `(organization_id, chain_root_id, state) WHERE superseded_at IS NULL`, `(organization_id, state, created_at DESC)`.

**`burn_attribution_rules`** - deterministic org rules evaluated before any LLM call (round-1 D5b).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `name` | varchar(255) NOT NULL | |
| `priority` | integer NOT NULL DEFAULT 100 | ascending; first match wins |
| `match` | jsonb NOT NULL DEFAULT `'{}'` | `{ project_ids?, phase_ids?, label_ids?, account_ids?, title_regex?, expense_categories?, source_types? }` |
| `outcome_kind` | varchar(24) NOT NULL | `attribute` \| `non_billable` |
| `outcome_deliverable_id` | uuid | FK ON DELETE CASCADE; required when `attribute` |
| `outcome_reason` | varchar(24) | required when `non_billable`; one of the 2.3.7 reasons |
| `is_enabled` | boolean NOT NULL DEFAULT true | |
| `match_count` | integer NOT NULL DEFAULT 0 | so an operator can see which rules actually fire |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, is_enabled, priority)`, `(outcome_deliverable_id)`. `title_regex` is length-capped and compiled with a timeout to avoid catastrophic backtracking.

**`burn_prechecks`** - every gate decision. **The reason-of-record artifact.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `idempotency_key` | varchar(160) NOT NULL | **server-derived HMAC** (2.4 point 6), `CHECK (idempotency_key LIKE 'svc:%' OR idempotency_key LIKE 'usr:%')` |
| `valid_until` | timestamptz NOT NULL | default now + `precheck_replay_ttl_seconds` (300). Past it, recompute and supersede |
| `work_ref_type` | varchar(32) NOT NULL | `bill.expense` \| `bill.recurring` \| `bam.task_phase_move` \| `bam.assignment` \| `subcontractor_charge` \| `manual` |
| `work_ref_id` | uuid | null in the pre-transaction case |
| `project_id` | uuid | FK `projects(id)` ON DELETE SET NULL |
| `proposed_amount` | bigint | minor units |
| `currency` | varchar(3) | |
| `engagement_id` | uuid | FK ON DELETE SET NULL |
| `chain_root_id` | uuid | the chain actually evaluated |
| `deliverable_id` | uuid | FK ON DELETE SET NULL |
| `verdict` | varchar(20) NOT NULL | `allow` \| `allow_with_note` \| `needs_mapping` \| `deny` |
| `verdict_reason` | varchar(40) NOT NULL | `within_envelope` \| `envelope_exhausted` \| `envelope_would_exceed` \| `no_active_engagement` \| `engagement_unlinked` \| `deliverable_closed` \| `outside_engagement_window` \| `low_confidence_target` \| `gate_unavailable` \| `gate_off` \| `gate_paused` |
| `mode_at_decision` | varchar(12) NOT NULL | snapshotted |
| `enforced` | boolean NOT NULL DEFAULT false | true only when the verdict actually stopped a write |
| `envelope_amount` / `envelope_consumed` / `envelope_remaining` / `overage_amount` | bigint | snapshots; the first three are `read_all`-floored on read, `overage_amount` is not |
| `confidence` | numeric(5,2) | target-selection confidence |
| `clause_ref` | varchar(64) | `read_all`-floored on read |
| `outcome` | varchar(24) NOT NULL DEFAULT `'pending'` | `pending` \| `proceeded` \| `abandoned` \| `overridden` \| `mapped` \| `mapped_and_posted` \| `change_order_raised` \| `absorbed` (round-1 D7: `mapped_and_posted` closes the previously incomplete state machine) |
| `advisory_feedback` | varchar(16) | **the advisory-mode label (round-1 D8)**: `right_call` \| `wrong_call` \| `would_have_mapped`; settable on a NON-enforced row |
| `override_reason_code` | varchar(24) | `absorbed_cost` \| `mapped_manually` \| `change_order_pending` \| `gate_wrong` |
| `override_reason_text` | text | required, min `override_reason_min_chars` (default 20) when overriding a deny |
| `overridden_by` | uuid | FK `users(id)` ON DELETE SET NULL. `read_all`-floored |
| `overridden_at` | timestamptz | |
| `latency_ms` | integer | gate budget telemetry |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, idempotency_key)`, `(organization_id, verdict, created_at DESC)`, `(organization_id, enforced, created_at DESC)`, `(organization_id, mode_at_decision, created_at DESC)` (the calibration scan), `(organization_id, chain_root_id)`, `(organization_id, override_reason_code) WHERE override_reason_code IS NOT NULL`, `(organization_id, advisory_feedback) WHERE advisory_feedback IS NOT NULL`.

**Retention: rows with `enforced=true`, a non-null override, or a non-null `advisory_feedback` are NEVER purged.** They are the dispute record and the calibration sample.

**`burn_variances`** - a post-transaction finding, including the inverse check.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `engagement_id` | uuid | FK ON DELETE CASCADE |
| `chain_root_id` | uuid | |
| `deliverable_id` | uuid | FK ON DELETE SET NULL |
| `variance_kind` | varchar(32) NOT NULL | `unscoped_work` \| `envelope_overrun` \| `envelope_at_risk` \| `silent_deliverable` \| `ungated_charge` \| `consumption_erosion` \| `phantom_consumption` \| `gate_outage` |
| `severity` | varchar(8) NOT NULL | `low` \| `medium` \| `high` \| `critical` |
| `dedup_key` | varchar(128) NOT NULL | stable per finding so a re-sweep updates rather than duplicates |
| `amount` | bigint | exposure in minor units; `read_all`-floored on read, never in a Bolt payload |
| `detail` | jsonb NOT NULL DEFAULT `'{}'` | refs and magnitudes; work-item id list capped at `variance_detail_max_refs` (default 50) |
| `status` | varchar(12) NOT NULL DEFAULT `'open'` | `open` \| `acknowledged` \| `resolved` \| `dismissed` |
| `proposal_id` | uuid | FK `agent_proposals(id)` ON DELETE SET NULL |
| `resolved_by` | uuid | FK `users(id)` ON DELETE SET NULL |
| `detected_at` / `resolved_at` | timestamptz | |
| `sweep_marker` | timestamptz | the observed sweep time, never `now()` mid-compute |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (organization_id, dedup_key)`, `(organization_id, status, severity)`, `(organization_id, chain_root_id)`, `(organization_id, variance_kind, detected_at DESC)`.

**`burn_classifier_feedback`** - the tuning corpus and calibration sample. Survives deletion of the attribution it came from. **Never purged.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `engagement_id` | uuid | FK ON DELETE SET NULL |
| `work_item_id` | uuid | FK ON DELETE SET NULL |
| `decision_kind` | varchar(24) NOT NULL | `accept` \| `reject` \| `reclassify` \| `mark_unscoped` \| `mark_scoped` \| `mark_non_billable` |
| `proposed_deliverable_id` / `corrected_deliverable_id` | uuid | FK ON DELETE SET NULL |
| `proposed_confidence` | numeric(5,2) | the calibration input |
| `text_snapshot` | text | PII-redacted exemplar text |
| `search_tsv` | tsvector GENERATED ALWAYS AS (`to_tsvector('english', coalesce(text_snapshot,''))`) STORED | |
| `qdrant_point_id` / `qdrant_synced_at` | uuid / timestamptz | reserved |
| `decided_by` | uuid NOT NULL | FK `users(id)`. `read_all`-floored on read |
| `vocabulary_version` | integer NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id, engagement_id, created_at DESC)`, `(organization_id, decision_kind, created_at DESC)`, GIN on `search_tsv`.

**`burn_cost_rates`** - the missing primitive (round-1 D1). Burn-owned, deliberately mirroring `bill_rates`' shape and resolution semantics so the two are comparable and testable against each other.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `project_id` | uuid | FK `projects(id)` ON DELETE CASCADE |
| `user_id` | uuid | FK `users(id)` ON DELETE CASCADE |
| `cost_amount` | bigint NOT NULL | minor units, per hour |
| `rate_type` | varchar(10) NOT NULL DEFAULT `'hourly'` | |
| `currency` | varchar(3) NOT NULL DEFAULT `'USD'` | |
| `effective_from` | date NOT NULL DEFAULT now() | |
| `effective_to` | date | **inclusive**, matching `rate.service.ts:117` |
| `note` | varchar(255) | e.g. "fully loaded incl. benefits" |
| `created_by` | uuid NOT NULL | FK `users(id)` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `(organization_id)`, `(organization_id, project_id, user_id, effective_from)` (supporting b-tree for the four-branch resolver, not a statement of precedence). Reads and writes are floored to `burn.costrate.read` / `burn.costrate.write`, both owner/admin: an employee's cost rate is the most sensitive figure in the system.

**`burn_engagement_rollups`** - materialized figures (round-1 T1).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `chain_root_id` | uuid NOT NULL | the rollup grain is the **chain**, not the row |
| `contract_value` | bigint | chain aggregate |
| `attributed_billable` / `attributed_cost` | bigint | |
| `unscoped_amount` | bigint | |
| `pending_review_amount` | bigint | the "excluded from every envelope" figure surfaced in 2.3.8 |
| `non_billable_amount` | bigint | |
| `consumption_pct` | numeric(6,2) | |
| `margin_amount` / `margin_pct` | bigint / numeric(6,2) | **null unless cost-rate coverage is non-zero** |
| `cost_rate_coverage_pct` | numeric(6,2) | how much of the attributed work had a cost rate |
| `metric_basis` | varchar(24) NOT NULL | `true_margin` \| `contract_consumption` |
| `work_item_count` | integer NOT NULL DEFAULT 0 | |
| `computed_at` | timestamptz NOT NULL DEFAULT now() | served as `as_of` |

Indexes: `UNIQUE (organization_id, chain_root_id)`, `(organization_id, computed_at)`.

**Refresh semantics.** A full per-chain recompute upserted in **one statement** (`INSERT ... ON CONFLICT (organization_id, chain_root_id) DO UPDATE SET ...`), idempotent under retry, never read-modify-write. `GET /v1/financials` serves the rollup with an explicit `as_of`. When a rollup is **missing**, the route computes that one chain synchronously and upserts it. When it is **stale** beyond `rollup_max_age_minutes` (default 120), it serves the stale figure with `as_of` and a `stale: true` flag and enqueues a refresh. It **never** silently falls back to an unbounded live aggregate over the two highest-cardinality tables, which is what the round-1 draft implied for every card on every page load. The rollup is also the **immutable historical record** for retention purposes (T11).

**`burn_ingest_events`** - the durable event inbox, with the claim columns `bulwark_ingest_events` lacks.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `source_idempotency_key` | varchar(128) NOT NULL | payload `_event_id` when present (`apps/bolt-api/src/routes/event-ingestion.routes.ts:230`), else the bolt event id |
| `bolt_event_id` | uuid | trace |
| `source` / `event_type` | varchar(48) / varchar(96) NOT NULL | |
| `scope_fields` | jsonb NOT NULL DEFAULT `'{}'` | id-typed fields only, uuid-validated, non-conforming dropped |
| `occurred_at` | timestamptz | business time when present |
| `logged_at` | timestamptz NOT NULL | transport time |
| `status` | varchar(12) NOT NULL DEFAULT `'pending'` | `pending` \| `claimed` \| `processed` \| `skipped` |
| `claimed_by` | varchar(64) | worker instance id (round-1 T6) |
| `claimed_at` | timestamptz | lease start; a reaper returns rows older than `claim_lease_seconds` (default 300) to `pending` |
| `received_at` | timestamptz NOT NULL DEFAULT now() | |
| `processed_at` | timestamptz | |

Indexes: `UNIQUE (organization_id, source_idempotency_key)`, `(organization_id, status, received_at)` (the claim scan), `(status, claimed_at) WHERE status='claimed'` (the reaper scan), `(source, event_type)`.

**Why the claim columns.** `infra/postgres/migrations/0234_bulwark_core.sql:123-136` shows `bulwark_ingest_events` has only `status pending|processed` and no claim column; Bulwark gets away with that shape only because its sweeps run at `concurrency: 1` under a per-org advisory lock. Burn's batch job is both event-driven and scheduled every 2 minutes, so two concurrent runs would SELECT the same pending rows and both process them: duplicate llm-provider spend against a capped budget, and two writers racing the partial unique index. Rows are claimed with `UPDATE ... SET status='claimed', claimed_by, claimed_at WHERE status='pending' ... RETURNING` (or `SELECT ... FOR UPDATE SKIP LOCKED`), never a bare SELECT.

**`burn_extraction_runs`** - audit plus chunk checkpoint. Same shape and rationale as `bulwark_extraction_runs`. **Never purged.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `engagement_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `status` | varchar(16) NOT NULL DEFAULT `'running'` | `running` \| `succeeded` \| `partial` \| `failed` \| `rejected_limits` |
| `chunk_count` | integer | |
| `last_processed_chunk` | integer NOT NULL DEFAULT -1 | a retry resumes at `+1` |
| `source_doc_hash` | varchar(64) | |
| `doc_bytes` / `doc_pages` | bigint / integer | recorded against the S7 limits |
| `deliverables_extracted` / `low_confidence_count` | integer NOT NULL DEFAULT 0 | |
| `provider_id` | uuid | |
| `error` | text | |
| `started_at` | timestamptz NOT NULL DEFAULT now() | |
| `finished_at` | timestamptz | |

Indexes: `(organization_id, engagement_id, started_at DESC)`, `(status)`.

**`burn_org_settings`** - per-org tunables, one row per org, modeled on `basis_org_settings` (`0226_basis_core.sql`).

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` / `organization_id` | uuid PK / uuid NOT NULL UNIQUE | | FK ON DELETE CASCADE |
| `gate_mode` | varchar(12) NOT NULL | **`'advisory'`** | `off` \| `advisory` \| `blocking`. Blocking is never the default and is unreachable without 5.4 |
| `gate_enabled_refs` | jsonb NOT NULL | `["bill.expense"]` | classes the gate evaluates; blocking applies only to money-out classes |
| `gate_paused_until` | timestamptz | | one-click pause; gate returns `allow`/`gate_paused` |
| `deny_threshold` | numeric(5,2) NOT NULL | 0.85 | minimum target confidence before a deterministic deny may be enforced |
| `map_threshold` | numeric(5,2) NOT NULL | 0.60 | below this the verdict is `needs_mapping` (non-blocking in v1) |
| `auto_attribute_threshold` | numeric(5,2) NOT NULL | 0.90 | `CHECK BETWEEN 0.75 AND 0.99` |
| `review_threshold` | numeric(5,2) NOT NULL | 0.60 | `CHECK (review_threshold BETWEEN 0.30 AND auto_attribute_threshold - 0.05)` |
| `pending_review_max_age_days` | integer NOT NULL | 14 | stale reviews demote so dollars re-enter the total |
| `reconcile_window_days` | integer NOT NULL | 90 | the re-read and anti-join window |
| `max_false_positive_rate` | numeric(5,2) NOT NULL | 0.05 | |
| `min_gate_wrong_count` | integer NOT NULL | 5 | **absolute floor before demotion fires** (S3) |
| `min_gate_wrong_distinct_users` | integer NOT NULL | 2 | (S3) |
| `min_advisory_decisions` | integer NOT NULL | 200 | promotion, with the 60-day alternative in 5.4 |
| `min_advisory_days` | integer NOT NULL | 14 | |
| `min_labeled_denies` | integer NOT NULL | 10 | promotion (D8) |
| `min_deny_precision` | numeric(5,2) NOT NULL | 0.95 | |
| `min_gate_coverage_pct` | numeric(5,2) NOT NULL | 0.90 | below this, blocking auto-demotes (T5) |
| `precheck_budget_ms` | integer NOT NULL | 600 | `CHECK BETWEEN 100 AND 750`, strictly below the bill-api client default of 800 (T4/I2). **Advisory and display-only**; the authoritative bound is `BURN_PRECHECK_TIMEOUT_MS` in bill-api |
| `precheck_replay_ttl_seconds` | integer NOT NULL | 300 | |
| `override_reason_min_chars` | integer NOT NULL | 20 | |
| `unscoped_alert_floor` | bigint NOT NULL | 10000 | below this no `work.unscoped` event |
| `candidate_k` / `exemplar_k` | integer NOT NULL | 8 / 6 | |
| `attribution_llm_daily_cap` | integer NOT NULL | 2000 | |
| `rollup_max_age_minutes` | integer NOT NULL | 120 | |
| `embedding_enabled` | boolean NOT NULL | **false** | Open Question 1 |
| `banter_signal_enabled` / `vcs_signal_enabled` | boolean NOT NULL | false | opt-in |
| `llm_provider_id` | uuid | | **org ownership validated on write** (2.4 point 12) |
| `vocabulary_version` | integer NOT NULL | 0 | |
| `last_source_watermark` | jsonb NOT NULL | `'{}'` | per-`source_type` `created_at` high-water marks (2.3.2) |
| `work_item_retention_days` | integer NOT NULL | 1095 | |
| `ingest_retention_days` | integer NOT NULL | 400 | |
| `last_variance_sweep_at` | timestamptz | | advanced only after a fully successful sweep |
| `gate_promoted_at` / `gate_demoted_at` | timestamptz | | audit |
| `updated_by` | uuid | | FK `users(id)` ON DELETE SET NULL |
| `updated_at` | timestamptz NOT NULL | now() | |

### 3.2 Reused platform tables

- `entity_links` (`0132_entity_links.sql`): `burn.engagement -> bond.company`, `-> bin.asset`, `-> bill.client`; `burn.deliverable -> <source>` on confirmed attribution (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`). **Declared as a Drizzle module** (B3).
- `agent_proposals` (`0128_agent_proposals.sql`): change-order and line-item drafts. **Declared as a Drizzle module** (B3).
- `organizations`, `users`, `projects`, `actor_type` enum.
- Read-only source tables via the shared DB: `tasks`, `time_entries`, `phases`, `sprints`, `bill_expenses`, `bill_rates`, `bill_invoices`, `bill_line_items`, `bill_recurring_invoices`, `bill_clients`, `bond_companies`, `bond_deals`, helpdesk tickets, `bin_assets`.
- `llm_providers`: only via `POST /internal/llm/chat`.

### 3.3 JSONB shapes (authoritative)

```jsonc
// burn_deliverables.cited_span
{
  "page": 2, "section": "3.1",
  "quote": "Consultant shall deliver a brand identity system including logo, ...",
  "char_start": 4412, "char_end": 4573, "chunk_index": 1,
  "verified": true          // source_text.slice(start,end) fuzzy-matched the quote, tied to source_doc_hash
}

// burn_attributions.candidate_set (decision reproducibility)
[
  { "deliverable_id": "…", "engagement_id": "…", "signal": "structural", "score": 0.71 },
  { "deliverable_id": "…", "engagement_id": "…", "signal": "precedent",  "score": 0.66 }
]

// burn_attribution_rules.match
{
  "project_ids": ["…"],
  "title_regex": "^(retro|standup|internal)",
  "expense_categories": ["Meals"],
  "source_types": ["bam.task"]
}

// burn_org_settings.last_source_watermark
{ "bam.time_entry": "2026-07-19T05:00:00Z", "bill.expense": "2026-07-19T05:00:00Z" }

// burn_variances.detail (refs and magnitudes only, capped)
{ "work_item_ids": ["…"], "work_item_count": 37, "hours": 21.5, "overrun_pct": 23.0 }
```

### 3.4 Numbered, idempotent migration plan

On-disk tip is `0238_bulwark_builtin_group_defaults.sql`; latest permissions delta is `0237_permissions_seed_actions_delta_022.sql`. Numbers below are **provisional**: if an unrelated migration lands first every number shifts and the relative order holds. Every file carries the required header block (filename marker, `-- Why:`, `-- Client impact:`) and idempotent DDL per the `CLAUDE.md` conventions, and passes `pnpm lint:migrations`.

1. **`0239_burn_core.sql`** - `burn_engagements` (both self-FKs guarded `DO $$`, `chain_root_id`), `burn_engagement_projects`, `burn_deliverables` (incl. the explicit null-safe `search_tsv` generated column with the `'english'` regconfig, and the reserved qdrant columns), `burn_work_items` (incl. `exclusion_reason` and the four-column unique idempotency index), `burn_attributions` (partial unique live index, `ON DELETE RESTRICT` to deliverables), `burn_extraction_runs`, `burn_ingest_events` (incl. `claimed_by`/`claimed_at` and the reaper index), all indexes, RLS policies. Also seeds the **"Burn System" service-account user** that autonomous worker actions and direct `agent_proposals` inserts (`actor_id NOT NULL`) are attributed to, exactly as `0234_bulwark_core.sql` seeds the Bulwark sentinel. Additive only.
2. **`0240_burn_gate_variance.sql`** - `burn_prechecks` (incl. `valid_until`, the `idempotency_key` prefix `CHECK`, `advisory_feedback`), `burn_variances`, `burn_classifier_feedback` (incl. its `search_tsv`), `burn_org_settings` (every threshold with its default **and its `CHECK` constraint**, including `precheck_budget_ms BETWEEN 100 AND 750`), indexes, RLS. Additive only.
3. **`0241_burn_rates_rollups_rules.sql`** - `burn_cost_rates`, `burn_engagement_rollups`, `burn_attribution_rules`, indexes, RLS. Additive only.
4. **`0242_permissions_seed_actions_delta_023.sql`** - **generated**, never hand-written. `burn_` is not in `APP_PREFIXES`, so the rows are hand-authored. Strict sequence, following the Bulwark procedure exactly:
   - (a) land `0239`-`0241` on disk;
   - (b) register the **20** `burn.*` rows (Section 11.2) in the `HAND_AUTHORED` array at `scripts/generate-permission-manifest.mjs:719`. The loop at `:816` copies flags **verbatim** rather than inferring them, so each row carries explicit `app:'burn'`, `is_read`, `is_destructive`, `requires_confirmation`, `requires_superuser`;
   - (c) add an `if (c.id.startsWith('burn.')) { migrationLabel = '<this delta>'; sourceFile = 'burn.routes.ts'; }` provenance branch, matching the `basis.` / `braid.` / `bulwark.` convention;
   - (d) do NOT add `burn_*` to `EXPLICIT_TOOL_OVERRIDES`;
   - (e) run `node scripts/generate-permission-manifest.mjs` (writes `docs/permissions-action-manifest.json`) **then `node scripts/build-permission-codegen.mjs`** (the only writer of `packages/permissions/src/generated/permissions.ts`) and **commit the regenerated `permissions.ts`**;
   - (f) run `scripts/check-permission-catalog.mjs`, which passes only because (e) committed;
   - (g) run `scripts/build-permission-delta.mjs` to emit this migration with a generator-assigned number. Strip any proposed removal or deactivation of unrelated rows before landing.
   - **Immutability warning (round-1 I4).** If `build-permission-delta.mjs` reassigns a number after the file has already been applied to any database including a developer's own, that is a checksum mismatch under `apps/api/src/migrate.ts` and the fix is a **new file**, never an edit to the applied one. Do not reach for `MIGRATE_ALLOW_HEADER_RESTAMP=1`.
5. **`0243_burn_builtin_group_defaults.sql`** - the file **immediately after** the generated delta (`NNNN+1`). Backfills `burn.*` into the built-in role matrix, modeled on `0238_bulwark_builtin_group_defaults.sql`, with the custom tiering in Section 11.2. `INSERT ... ON CONFLICT DO NOTHING`. Additive only.

Bolt event registration, the bolt-api dispatch hook, the bill-api precheck preHandler, `POST /internal/rates/resolve`, the two new `bill` events, and the `SUPPORTED_ENTITY_TYPES` additions are TypeScript edits, not migrations.

---

## 4. The engines

All engines run as BullMQ workers in `apps/worker`. Following the Bulwark precedent (`apps/worker/src/worker.ts:233-257`), each job is a **thin HTTP caller** invoking the engine over burn-api's internal routes, so business logic lives in one container and burn-api is the process holding the LLM calls (Section 9.7 sizing).

### 4.1 Deliverable-extraction engine

**Trigger.** `POST /v1/engagements` (with a `bin_asset_id`) or `POST /v1/engagements/:id/extract` enqueues `burn-extract-deliverables { org_id, engagement_id }`, after the route `can_access`-preflighted the Bin asset.

**Pipeline:**
1. **Preflight and fetch.** Re-check `preflightAccess(created_by, 'bin.asset', bin_asset_id)`, then read bytes via `@bigbluebam/storage` `getStream` (the sole byte path; `BIN_API_INTERNAL_URL` is added nowhere). **Enforce the S7 limits before parsing**: `MAX_DOC_BYTES` (25 MB), `MAX_DOC_PAGES` (300), a wall-clock parse cap, and a parser configured with JavaScript execution and external-entity resolution **disabled**. A limit breach records `status='rejected_limits'` and flags the engagement for manual entry rather than partially extracting. Compute `source_doc_hash`. Image-only scans yield zero deliverables and are flagged (no OCR in v1).
2. **Conditional hash skip.** Skip only when `source_doc_hash` is unchanged AND the last run's status was `succeeded`. A `partial` or `failed` run resumes.
3. **Chunk and checkpoint.** Overlapping section-anchored chunks; `last_processed_chunk` persisted so a retry resumes. Per-chunk progress logged through `@bigbluebam/logging` with **flushed** output: extraction of a 40-page MSA is a multi-minute phase and CLAUDE.md's progress-logging rule forbids silence.
4. **Extract per chunk.** `POST /internal/llm/chat` with the chunk fenced as untrusted DATA, demanding strict JSON `{ title, description, deliverable_kind, clause_ref, stated_price?, cited_span, confidence }`. Zod-validate; drop malformed rows.
5. **Verify the cite.** Fuzzy-match `source_text.slice(char_start, char_end)` against the returned `quote`. A failed verification sets `cited_span.verified=false` and forces `pending_review` regardless of confidence.
6. **Compute `dedup_key`** per 3.1 and upsert `ON CONFLICT (organization_id, engagement_id, dedup_key)`, so overlapping-chunk re-extraction collapses to one deliverable and a re-extract never orphans a confirmed one.
7. **Propose the envelope, activate nothing.** Deterministic priority: (a) a `stated_price` in the document, `envelope_source='stated'`; (b) an explicit human split; (c) a **proposed** split of chain contract value weighted by the LLM's relative-effort estimate; (d) an even split.

**Every envelope requires human confirmation before `is_active` becomes true, `stated` included (round-1 S7).** The round-1 draft read "every **non**-`stated` envelope requires human confirmation", which contradicted its own next paragraph and would lead an implementer to auto-activate `stated` envelopes. A `stated_price` is an LLM extraction from an attacker-influenceable PDF: cite verification checks that the quote exists in the source bytes, not that the reported number is the number the clause states, and it does nothing at all when injected text is genuinely present in the document. A forged `stated_price` that auto-activated would become a gate input, the one thing that can produce an enforced deny; set high, it would silently absorb unscoped work as in-scope and destroy the revenue-recovery finding. The confirmation UI shows the operator the **verified quote alongside the extracted number**, side by side.

8. **Emit.** `deliverable.extracted` per row, `engagement.extracted` on completion. Refs only, no amounts (2.4 point 13).

### 4.2 Continuous-attribution engine

**Triggers, layered for durability:**
1. **Event-driven.** bolt-api's dispatch hook forwards subscribed events to `POST /v1/internal/events`, which persists a `burn_ingest_events` row and enqueues `burn-attribute-batch`.
2. **Claimed inbox drain.** `burn-attribute-batch` claims `status='pending'` rows (3.1), recovering a lost enqueue after a successful INSERT.
3. **Source reconcile**, the three passes of 2.3.2, owned by `burn-variance-sweep`.

Because `burn_work_items` has a deterministic content-hash unique key, the event path and the reconcile path converge on exactly one row. Every Burn input is a persistent source row, so reconcile closes the drop gap end to end and Burn does **not** depend on a bolt-api sending-end outbox.

**Pipeline per work item:** normalize -> resolve project -> resolve **all** chain-linked engagements -> apply **rules (stage zero)** -> value deterministically (billable and cost, separately) -> assemble candidates -> adjudicate -> band -> write attribution respecting the human-precedence invariant -> denormalize `attribution_state` -> emit `work.unscoped` (refs plus severity band) when it lands unscoped at or above `unscoped_alert_floor`.

**Concurrency (round-1 T6).** The scheduled drain runs at `concurrency: 1` under a per-org Redis lock, rows are claimed rather than bare-selected, a stale-claim reaper returns leases older than `claim_lease_seconds` to `pending`, and the queue carries a BullMQ `limiter: { max: 30, duration: 60000 }`. Without this the every-2-minutes schedule and the event trigger overlap, double-draining the inbox into duplicate llm-provider spend against a capped budget and racing the partial unique index.

### 4.3 Variance engine (post-transaction)

`burn-variance-sweep`, every 30 minutes, **at `concurrency: 1` under a per-org Redis advisory lock with a TTL exceeding the worst-case sweep**, on the pattern in `apps/worker/src/jobs/bulwark-radar-sweep.job.ts`.

**Citation correction (round-1 T7).** The round-1 draft cited "`bond-stale-deals.job.ts:127-138`" as the advisory-lock pattern. That file contains no lock of any kind; lines 127-138 are a comment explaining why the rotting marker is updated after the emit. An implementer following that citation would have shipped an unlocked 30-minute sweep, and because this job also carries the source-reconcile pass, overlapping runs would double-write `burn_variances`, double-materialize work items, and make `last_variance_sweep_at` ambiguous. The correct precedent is `bulwark-radar-sweep.job.ts`.

**Progress logging.** The sweep iterates every org and re-reads bounded source history: a multi-minute phase. Per CLAUDE.md's rule it logs a flushed line **before** the slow phase, then every N orgs and every N items with elapsed time, not merely start and end lines.

Findings produced, keyed on `dedup_key` so a re-sweep updates rather than duplicates:

- `unscoped_work`: unscoped items for a chain crossing a dollar or count threshold.
- `envelope_overrun`: attributed billable exceeds `envelope_amount`.
- `envelope_at_risk`: crosses 80 percent with the due date more than 20 percent away.
- `ungated_charge`: a money-out work item with no corresponding `burn_prechecks` row. **The catch-all that makes gate coverage gaps visible rather than silent**, including every charge that posted during a fail-open window.
- `consumption_erosion`: chain-level attributed billable against contract value crossing configured bands.
- `phantom_consumption`: reversals in one sweep exceeding a threshold (2.3.2).
- `gate_outage`: raised on recovery from the Redis counters (Section 5.5), covering the window.

### 4.4 Inverse check (silent deliverables)

`burn-silent-deliverable-sweep`, daily at 03:00 UTC, per-org locked: every active deliverable with a `due_date` inside the lead window and **zero non-superseded attributions** raises a `silent_deliverable` variance. Contracted work nobody has started is as much a financial event as work nobody sold, and it is invisible in every tool this market uses.

### 4.5 Change-order and line-item drafting

On an `envelope_overrun` or clustered `unscoped_work`, and only when `auto_draft_change_orders` is on (**default false**), Burn drafts a change order: a deterministic scope table (deliverable, work items, hours, dollars, clause cite) plus an LLM-written narrative paragraph. The narrative is the only model output; every number and reference is computed. The draft lands in `agent_proposals` with a refs-only payload. **Nothing is sent, nothing is posted to Bill.**

On approval, the `proposal.decided` subscription (the `apps/bulwark-api/src/subscriptions/proposal-decided.ts` pattern) re-SELECTs `agent_proposals.status` to confirm `approved`, resolves the decider, fail-closes that decider through `POST /v1/agent-policies/<decider_id>/check`, asserts `burn.changeorder.draft`, and then **calls bill-api as the decider with the decider's own credentials** so bill-api's `fastify.requireCan('bill.*')` is the authority for the write into Bill (2.4 point 11). Exactly-once is a CAS on the draft row. A change order approved this way also creates the **amendment engagement** (`amends_engagement_id` + `contract_value_delta`), which is what makes the D3 chain the end state of the flagship workflow rather than a dangling concept.

---

## 5. The precheck gate

**The most important section in the specification.** Three voting seats independently identified the same risk: a wrong hard block that stops money in a small firm gets the feature switched off permanently and never switched back on. Round 1 then found that the original design's `needs_mapping` verdict blocked on low classifier confidence, which falsified the safety claim, and that the promotion criterion measured a signal the spec never captured. Both are fixed below.

### 5.1 What the gate is

`burn_precheck(work_ref)` registers on the moments money commits and returns an **allowability verdict** with a target deliverable, the overage if any, and a clause cite. In `blocking` mode, for enabled money-out classes only, a `deny` prevents the write until a human maps it to a deliverable, approves it as absorbed cost with a recorded reason, or converts it into a change order. Every call writes a `burn_prechecks` row whether it allowed, denied, or fell open. **That row is the reason-of-record artifact firms never have when a client disputes a bill.**

### 5.2 Where it hooks, and an honest platform finding

The submission names "an expense logged in Bill, a subcontractor PO, a recurring charge, a task moved into an in-progress phase, an assignee change onto a job at rate." Checking the tree:

- **`bill_expenses` publishes no Bolt events at all.** `apps/bill-api/src/routes/expenses.routes.ts:46` creates an expense with no `publishBoltEvent` call, and the only `billEvents` in `apps/bolt-api/src/services/event-catalog.ts:1437-1680` are `invoice.*`, `payment.recorded`, and `recurring.invoice_generated`.
- **Bolt events are post-hoc by construction.** They publish after a write commits. **A Bolt subscription can never be a pre-transaction gate.** Any spec claiming otherwise is wrong.
- **There is no purchase-order entity anywhere in the platform.** A "subcontractor PO" in BigBlueBam today is a `bill_expenses` row with a `vendor` string (`bill-expenses.ts:28`). Burn treats it as such and does not invent a PO object.

**The gate is therefore a synchronous inline call requiring named bill-api changes:**

| Hook | Change required | Class | Blocking eligible |
| --- | --- | --- | --- |
| `POST /expenses` | new `burnPrecheck` preHandler at `apps/bill-api/src/routes/expenses.routes.ts:46`, after `requireCan('bill.expense.create')` | `bill.expense` | yes |
| `PATCH /expenses/:id` when `amount` or `project_id` changes | same preHandler (route at `:57`) | `bill.expense` | yes |
| `POST /expenses/:id/approve` | same preHandler | `bill.expense` | yes (the strongest hook: approval is the real money commitment) |
| `bill-recurring-generate` worker job | one breaker check per job, then inline calls | `bill.recurring` | yes |
| Bam task moved into a non-terminal, non-start phase | **Bolt `task.moved` subscription, post-hoc** | `bam.task_phase_move` | **no, advisory forever** |
| Bam assignee change | **Bolt `task.assigned` subscription, post-hoc** | `bam.assignment` | **no, advisory forever** |

The last two are structurally post-hoc. `gate_enabled_refs` validation **rejects** marking them blocking. Blocking a kanban drag would be an unacceptable product and is also technically impossible on the current event model.

**Two new Bolt events from bill-api** so the post-hoc variance path sees expenses at all: `expense.created` and `expense.approved` on source `bill`, registered in `billEvents`. Useful to Bolt rule authors independently.

**One new internal route on bill-api**: `POST /internal/rates/resolve` (2.3.1 / D2), so rate precedence has exactly one implementation.

### 5.3 The verdict, and why only `deny` blocks

| Verdict | Meaning | Blocks in `blocking` mode |
| --- | --- | --- |
| `allow` | within envelope, gate off, paused, or unavailable | no |
| `allow_with_note` | allowed, envelope crosses a warning band, or the deliverable is unpriced; note surfaced and stored | no |
| `needs_mapping` | the gate could not confidently pick a target | **no in v1.** The charge posts with an inline note and a queue item |
| `deny` | a deterministic reason holds | **yes. The only blocking verdict** |

**D7, resolved as option (a).** Round 1 was right that from the user's side a blocking `needs_mapping` and a `deny` are the same event (the expense does not post), that `needs_mapping` is produced precisely by low classifier confidence, and that §5.4/§5.6 measured precision only on denies, so the most likely class of wrong block never counted toward promotion and could never trigger auto-demotion. An org could promote on 0.97 deny precision and then be blocked daily with the safety valve dormant. Making `needs_mapping` non-blocking makes the invariant in 2.1 **literally** true rather than nearly true, and the session's dominant criticism of Burn was exactly this failure mode. A charge that posts with an inline note plus a queue item still surfaces the work, which is the whole point of the unscoped bucket.

**A `deny` requires all of:**
1. A target deliverable selected with `confidence >= deny_threshold` (0.85), and
2. A deterministic reason: `envelope_exhausted`, `envelope_would_exceed`, `deliverable_closed`, `outside_engagement_window`, or `no_active_engagement`, and
3. That reason computed by arithmetic over **human-confirmed** envelopes (4.1 step 7), and
4. The deliverable belongs to a chain with at least one linked project (3.1: an `unlinked` engagement can never deny), and
5. `gate_mode='blocking'` with the class in `gate_enabled_refs`, and
6. The calibration gate earned (5.4).

The LLM contributes exactly one thing to a block: *which* envelope to check. It never produces the block.

**`no_active_engagement`** degrades to `needs_mapping` unless the org sets `strict_untracked_projects=true` (default false). Out of the box, work on projects Burn does not know about flows freely and shows up in the variance report.

### 5.4 Advisory to blocking: the earned progression, now measurable

**D8, resolved.** Round 1 correctly found the original precondition unmeasurable: deny precision was to be measured from the `gate_wrong` label, whose only source was the override flow, which exists only when a deny actually stopped a write. In advisory mode nothing is stopped (`enforced=false` for every verdict), so there was no override and no label. The fix is an explicit **advisory-mode verdict-feedback control**:

- On the gate console's advisory log and **inline on bill-api's advisory note**, each non-enforced `deny` shows: *"This would have been blocked. Right call? [Yes] [No] [I'd have mapped it]"*.
- The answer writes `burn_prechecks.advisory_feedback` (`right_call` | `wrong_call` | `would_have_mapped`) on the non-enforced row. `wrong_call` is the advisory-mode equivalent of `gate_wrong` and, like it, is floored to `burn.precheck.mark_wrong` (S3).
- **That is the precision sample.** Deny precision is `right_call / (right_call + wrong_call)` over labeled advisory denies, plus the enforced-mode `gate_wrong` signal once blocking is live.

`PATCH /v1/settings` **rejects** `gate_mode='blocking'` server-side, not merely hiding a UI control, unless all of:

1. **Volume, scale-aware:** the **lesser** of `min_advisory_decisions` (200) precheck rows **or** `min_advisory_days_alt` (60) days of advisory operation. A 6-person consultancy logging roughly 20 expenses a month would reach 200 in about ten months, calibrating the gate for a firm larger than the stated 2-50 wedge; the 60-day alternative fixes that.
2. **Soak:** at least `min_advisory_days` (14) days since the first advisory precheck.
3. **Labeled denies:** at least `min_labeled_denies` (10) advisory denies carrying `advisory_feedback`. Without an absolute floor a single labeled deny could read as 100 percent precision.
4. **Precision:** at least `min_deny_precision` (0.95) on that sample.
5. **Coverage:** gate coverage at or above `min_gate_coverage_pct` (0.90) over the trailing 7 days (5.5), so an org cannot promote a gate that is mostly failing open.
6. **Explicit acknowledgement:** `acknowledge_blocking: true`, after the wizard has shown the last 20 advisory denies with their labels and outcomes. You do not get to turn this on without reading what it would have done.

Promotion is **per class**: an org may block `bill.expense` while leaving `bill.recurring` advisory. Each class earns its own calibration.

`GET /v1/calibration` returns standing against every precondition with the shortfall named, so the console reads "142 of 200 decisions (or 41 of 60 days), 9 of 14 days soaked, 7 of 10 labeled denies, precision 0.97, coverage 0.99" rather than a disabled button with no explanation.

**Advisory is a complete product, and the console says so.** Per D8(c) and Open Question 11, the wizard reports standing without nagging. An org with no promotion path still gets the unscoped queue, the variance inbox, change-order drafts, and the financial figures. The console states this in plain language rather than presenting advisory as a probationary state.

### 5.5 Failure modes, enumerated, and made observable

| Failure | Behavior | Rationale |
| --- | --- | --- |
| burn-api unreachable from bill-api | **fail open**, `verdict='allow'`, `verdict_reason='gate_unavailable'`, **Redis counter incremented by bill-api**, `ungated_charge` variance raised on recovery | A gate that stops the firm's money because a container is restarting is the exact catastrophe the seats named |
| Circuit breaker open | fail open at **zero network cost** | see below |
| Precheck exceeds `BURN_PRECHECK_TIMEOUT_MS` | fail open, `latency_ms` recorded | Availability failures must never block money |
| LLM provider down or slow | the gate skips stage two, uses rules plus structural and precedent signals; if no target clears `deny_threshold` the verdict is `needs_mapping` (non-blocking) or `allow_with_note` | Degrades to a weaker but honest verdict |
| Qdrant down | no effect (`embedding_enabled=false` by default) | Soft dependency |
| No confirmed deliverables on the chain | `needs_mapping`, never `deny` | An empty ledger must not block anything |
| Engagement has zero linked projects | `allow_with_note`, `verdict_reason='engagement_unlinked'` | A defined state, not a silent one |
| Envelope is null (unpriced) | `allow_with_note`, hours tracked only | Cannot deny against a number nobody set |
| Duplicate precheck within `valid_until` with matching amount and currency | the stored row is returned | An HTTP retry does not double count |
| Duplicate key with a **mismatched** amount, currency, or ref type, or past `valid_until` | **recompute and supersede** | Closes S2's banked-verdict attack and T9's stale replay |
| Currency mismatch | `allow_with_note`, flagged | Never block on a units problem |

**The single sentence an implementer must not violate:** *the gate never blocks because something broke.*

**Note on the two opposite postures.** Availability fails **open** (this section). Authentication fails **closed** (2.4 point 10). These are deliberately inverted and an implementer must not "harmonize" them.

#### 5.5.1 The circuit breaker and the client-side budget (round-1 T4 / I2)

`precheck_budget_ms` lives in `burn_org_settings`, a Burn table. bill-api has no burn schema and no burn Drizzle module, so the only way to learn the value is to ask burn-api, which is the very thing the budget bounds. And with no breaker, a Burn outage imposes a permanent 800ms latency floor on every gated write indefinitely; `apps/worker/src/jobs/bill-recurring-generate.job.ts:367` loops serially over due schedules, so an outage becomes N x 800ms of added runtime.

- The authoritative timeout is a **bill-api-side env constant `BURN_PRECHECK_TIMEOUT_MS`** (default 800), added to the bill-api compose env and to `bill-api.env.optional` in `scripts/deploy/shared/services.mjs`. `burn_org_settings.precheck_budget_ms` is **advisory and display-only**, `CHECK`-clamped to [100, 750], strictly below the client default.
- `apps/bill-api/src/lib/burn-precheck.client.ts` carries a **Redis-backed circuit breaker** on the per-org shape in `apps/bulwark-api/src/services/gate.service.ts`: open after N consecutive timeouts or 5xx, short-circuit to `allow` / `gate_unavailable` at zero network cost, half-open probe on an interval.
- The recurring-generate loop checks the breaker **once per job**, not once per schedule.

#### 5.5.2 Fail-open is observable (round-1 T5 / I1)

The round-1 draft claimed that when burn-api is unreachable a "precheck row is written asynchronously". That is impossible: the only writer of `burn_prechecks` is burn-api, which is by hypothesis unreachable. During an outage there would be no row, no event, no counter, and no effect on calibration, so an org in blocking mode whose gate had failed open for three weeks would see a console identical to an org with nothing to block. And because `burn-variance-sweep` is itself a burn-api HTTP caller, it never runs during the outage either.

The claim is deleted and replaced with:

- bill-api's client `INCR`s `burn:gate_unavailable:<org>:<yyyymmdd>` (TTL 30 days) and `burn:gate_calls:<org>:<yyyymmdd>`, and logs through `@bigbluebam/logging` with the stable code **`BURN_GATE_UNAVAILABLE`**. Redis counters are the only record that survives the outage.
- `burn-calibration-recompute` drains those counters into a coverage figure: **"X percent of money-out writes reached the gate in the last 7 days."**
- The count is exposed on `/metrics`, already registered by `@bigbluebam/service-health` at `packages/service-health/src/index.ts:84`.
- On recovery, `burn-variance-sweep` reads the counters and raises a **`gate_outage` variance covering the window**.
- The Gate Console shows **"the gate was unavailable for N of the last 7 days"** next to the auto-demotion banner.
- **Coverage below `min_gate_coverage_pct` auto-demotes blocking to advisory**, on the same one-way-toward-safety principle as the false-positive demotion. A gate that is mostly failing open should not be presented as a control.
- A `gate.coverage_degraded` Bolt event is emitted by the recompute job on recovery (refs and band only).

### 5.6 Override, labeling, and auto-demotion

**Override** requires `burn.precheck.override` (member tier), a typed `override_reason_code`, and free text of at least `override_reason_min_chars`. Every override writes `outcome`, `overridden_by`, `overridden_at`, and emits `precheck.overridden` (refs only). The codes:

- `mapped_manually`: the user picked the right deliverable. Not a gate error. Writes `burn_classifier_feedback` (`reclassify`) that tunes the model. Outcome `mapped`, then `mapped_and_posted` once the write lands (D7: the round-1 state machine had no transition for this).
- `change_order_pending`: legitimately out of scope, being converted. **The gate was right.** Drafts a change order, which on approval creates the amendment engagement (4.5).
- `absorbed_cost`: legitimately out of scope and the firm is eating it. **The gate was right.** Becomes "we absorbed $14,200 on this account."
- `gate_wrong`: **the false-positive signal, and it is floored to `burn.precheck.mark_wrong` (owner/admin)**, not to `burn.precheck.override`.

**Why the split (round-1 S3).** Two calibration inputs were member-writable, and the member tier holds nearly every `burn.*` permission. A member who wanted the gate off could override a handful of denies as `gate_wrong`, push the rolling 30-day rate past `max_false_positive_rate` (0.05, a handful of rows at low volume), and autonomously demote the org to advisory. Promotion was server-enforced and un-bypassable; demotion had no equivalent guard and was reachable by the least-privileged tier. I **reject** the finding's first alternative of raising `burn.precheck.override` wholesale above the member floor: a member who hits a block must be able to proceed, and requiring an admin for every override recreates precisely the friction that gets the feature switched off. Splitting the label from the override keeps the escape hatch at member level and moves only the demotion-driving signal up.

**Auto-demotion** requires **all three** conditions, not a bare rate:
1. Rolling 30-day false-positive rate above `max_false_positive_rate` (0.05), **and**
2. At least `min_gate_wrong_count` (5) distinct `gate_wrong` / `wrong_call` rows, **and**
3. From at least `min_gate_wrong_distinct_users` (2) distinct users.

When it fires, Burn sets `gate_demoted_at`, emits `gate.demoted`, and **notifies org admins with the contributing rows named, auditably**. Coverage-driven demotion (5.5.2) is a separate, independent trigger. The system takes itself off blocking before the human loses patience and kills the whole feature. Re-promotion requires re-earning 5.4 from the demotion date.

**Kill switches, three, in increasing convenience:**
1. `gate_paused_until` (one click, "pause for 24 hours").
2. `gate_mode='advisory'` (one click).
3. `gate_mode='off'`.

All three **require a `confirm_action` token at the MCP layer** (S10): weakening the firm's spend control is the consequential direction, and promotion is already protected by the server-side calibration gate.

### 5.7 What the caller sees

The gate returns a compact envelope that bill-api renders inline. **The numeric block is floored** (S1): non-`read_all` callers get the overage and a band, never absolute contract figures.

```jsonc
// as returned to a project member (no burn.financials.read_all)
{
  "precheck_id": "…",
  "verdict": "deny",
  "verdict_reason": "envelope_would_exceed",
  "enforced": true,
  "engagement": { "id": "…", "title": "Castaway Rescue Retainer" },
  "deliverable": { "id": "…", "title": "Signal fire maintenance" },
  "envelope": { "band": "over", "overage_amount": 45000, "currency": "USD" },
  "confidence": 0.91,
  "actions": ["map_to_deliverable", "record_absorbed_cost", "raise_change_order", "override"]
}
```

A `burn.financials.read_all` holder additionally receives `envelope.amount`, `envelope.consumed`, `envelope.remaining`, and `cite: { section, page }`. A `needs_mapping` verdict returns `actions: ["map_to_deliverable", "dismiss"]` and `enforced: false` (D7).

Note the four actions on a deny. A block that offers no path forward is a wall; a block that offers four is a decision point. The overage figure is what makes it arguable rather than arbitrary, and it discloses nothing the caller could not compute from their own charge.

---

## 6. API surface

Base path `/burn/api/`, routes under `/v1`, mirroring `apps/basis-api/src/server.ts:88`. Success `{ data }`; errors the canonical envelope from `@bigbluebam/logging` `createErrorHandler`. Cursor pagination on every list endpoint, `?filter[field]=value`, `?sort=-field`. Shapes in `packages/shared/src/schemas/burn.ts`.

### 6.1 REST endpoints

| Method | Path | Purpose | Auth / notes |
| --- | --- | --- | --- |
| GET | `/v1/engagements` | List engagements (chain-aware) | `burn.engagement.read`; **project-scoped**; `contract_value` omitted without `read_all`; zero-project chains only to `read_all` |
| POST | `/v1/engagements` | Register (optionally from a Bin asset); enqueues extraction; accepts `project_ids[]` and `amends_engagement_id` | `burn.engagement.write`; **`can_access('bin.asset')` preflight** |
| GET | `/v1/engagements/:id` | Detail plus chain rollup | `burn.engagement.read`; **project-scoped**; cited records `can_access`-filtered |
| PATCH | `/v1/engagements/:id` | Update metadata, value, dates, account | `burn.engagement.write`; **project-scoped** |
| DELETE | `/v1/engagements/:id` | Delete (not the Bin asset) | `burn.engagement.delete` (owner/admin); confirm token via MCP; refused if it is a chain root with live amendments |
| POST | `/v1/engagements/:id/projects` | Link a project | `burn.engagement.write`; **project-scoped** on both sides |
| DELETE | `/v1/engagements/:id/projects/:projectId` | Unlink | `burn.engagement.write`; **project-scoped** |
| POST | `/v1/engagements/:id/extract` | Re-run extraction | `burn.engagement.write`; **project-scoped**; conditional hash skip; S7 limits |
| GET | `/v1/engagements/:id/burndown` | Burn-down series with the dated amendment step-ups | `burn.financials.read`; **project-scoped**; banded without `read_all` |
| GET | `/v1/deliverables` | List / review queue via `filter[review_status]=pending_review` | `burn.deliverable.read`; **project-scoped**; `cited_span.quote` floored |
| GET | `/v1/deliverables/:id` | Detail plus verified cite | `burn.deliverable.read`; **project-scoped** |
| PATCH | `/v1/deliverables/:id` | Confirm / edit / **confirm envelope** / reject | `burn.deliverable.write`; **project-scoped**; `rejected` needs confirm token; **`is_active` only ever set here, never by the worker (S7)** |
| GET | `/v1/work-items` | The ledger | `burn.attribution.read`; **project-scoped**; **per-item `billable_amount`/`cost_amount` omitted for `bam.*` sources without `read_all` (S6)**; `actor_id` floored |
| GET | `/v1/unscoped` | **The unscoped queue**, clustered | `burn.attribution.read`; **project-scoped**; filters `reason`, `min_amount`, `engagement_id`, `since`, `cluster`; every cited record `can_access`-preflighted with a hidden count |
| GET | `/v1/queue-health` | Inflow vs resolution, oldest age, `pending_review` dollars excluded from envelopes | `burn.attribution.read`; **project-scoped** |
| GET | `/v1/attributions` | List with filters | `burn.attribution.read`; **project-scoped** |
| POST | `/v1/attributions` | Attribute one work item on demand | `burn.attribution.write`; **project-scoped** |
| PATCH | `/v1/attributions/:id` | Confirm / reclassify / mark unscoped / **mark non-billable** | `burn.attribution.write`; **project-scoped**; supersede-then-insert under `FOR UPDATE`; **409 with current state on stale check**; writes `burn_classifier_feedback` |
| POST | `/v1/attributions/bulk` | Confirm / reclassify / mark a selected set or cluster | `burn.attribution.write`; capped at `bulk_max` (200); **returns `{ applied, conflicted, failed }` per item, never all-or-nothing** |
| GET | `/v1/rules` | List attribution rules | `burn.attribution.read` |
| POST / PATCH / DELETE | `/v1/rules[/:id]` | Manage deterministic rules | `burn.attribution.write` |
| POST | `/v1/precheck` | **The gate** (user-facing) | `burn.precheck.run`; **project-scoped (S1)**; server-derived `usr:` key; floored envelope block; bounded |
| GET | `/v1/prechecks` | The gate log | **`burn.precheck.read`** (S10); **project-scoped**; strips `envelope_amount`/`consumed`/`clause_ref` without `read_all` (S4) |
| POST | `/v1/prechecks/:id/override` | Override with a recorded reason | `burn.precheck.override`; **project-scoped**; typed code plus minimum-length text |
| POST | `/v1/prechecks/:id/label` | Set `advisory_feedback` or `gate_wrong` | **`burn.precheck.mark_wrong`** (owner/admin, S3/D8) |
| GET | `/v1/variances` | Variance inbox | `burn.variance.read`; **project-scoped**; `amount` floored; sort `-severity` |
| PATCH | `/v1/variances/:id` | Acknowledge / resolve / dismiss | **`burn.variance.write`** (S10: a mutation must not be authorized by an `is_read:true` permission) |
| GET | `/v1/financials` | Per-chain figures with `metric_basis` and `as_of` | `burn.financials.read`; **project-scoped**; banded without `read_all` |
| GET | `/v1/financials/accounts` | **Firm-wide roll-up by client** | **`burn.financials.read_all` (owner/admin)** |
| GET | `/v1/cost-rates` | List cost rates | **`burn.costrate.read` (owner/admin)** |
| POST / PATCH / DELETE | `/v1/cost-rates[/:id]` | Manage cost rates | **`burn.costrate.write` (owner/admin)** |
| POST | `/v1/change-orders` | Draft a change order for a variance | `burn.changeorder.draft`; creates the `agent_proposals` row |
| GET | `/v1/change-orders/:id` | Fetch the drafted body | `burn.changeorder.draft`; **project-scoped (S4)**; strips floored figures without `read_all` |
| GET | `/v1/calibration` | Classifier and gate calibration, promotion standing, coverage | `burn.settings.read` |
| GET | `/v1/settings` | Org settings | `burn.settings.read` |
| PATCH | `/v1/settings` | Update, **including `gate_mode`** | `burn.settings.write` (owner/admin); **server-side 5.4 precondition check on any promotion**; **`llm_provider_id` org ownership validated (S8b)** |
| POST | `/v1/internal/precheck` | Service-to-service gate call from bill-api | `INTERNAL_SERVICE_SECRET`; **rejects unconditionally when the sole secret is empty**; `svc:` key namespace; no MCP tool |
| POST | `/v1/internal/prechecks/:id/outcome` | bill-api's post-commit callback | `INTERNAL_SERVICE_SECRET` (round-1 D9/S3c: bill-api holds the secret, not a session); no MCP tool |
| POST | `/v1/internal/events` | Ingest trigger from bolt-api | same; persists to `burn_ingest_events`, enqueues; no MCP tool |
| GET | `/health` / `/health/ready` / `/metrics` | Probes | `@bigbluebam/service-health` |

One shared query builder enforces the ported project-membership predicate with an org-admin override for every row annotated "project-scoped"; one shared mutating guard applies the same before any write.

**Health route names (round-1 B2 / I3).** `packages/service-health/src/index.ts` registers exactly `GET /health` (`:62`), `GET /health/ready` (`:66`), and `/metrics` (`:84`). **There is no `/readyz` anywhere in the platform**; the name has propagated as prose into several server.ts comments and into CLAUDE.md itself, which is how it reached the round-1 draft. Registration is `healthCheckPlugin` with `service: 'burn-api'` and a `checks: { postgres, redis }` map, mirroring `apps/bulwark-api/src/server.ts:96`. The compose healthcheck and the `services.mjs` entry both use **`/health`**, matching `scripts/deploy/shared/services.mjs:298`. An implementer who writes `/readyz` into either gets a container that never reports healthy, `frontend` never starts (it has `depends_on: burn-api: condition: service_healthy`), and Railway reproduces the recorded healthcheck-loop failure.

**Deferred fail-open outcome (round-1 D9).** On the fail-open path bill-api has no `precheck_id` to call back with, so the outcome loop would be silently open exactly when `ungated_charge` detection matters most. bill-api therefore records the fail-open in the Redis counters of 5.5.2 **and** stamps the created expense with a `burn_gate: 'unavailable'` marker in its own row metadata, which `burn-variance-sweep` reads on recovery to raise the `ungated_charge` and `gate_outage` variances against real rows rather than against a count alone.

### 6.2 Realtime (`/burn/ws`)

Redis PubSub, refs and coarse bands only, **project-scoped fan-out, not org-wide**. Rooms keyed per `(org, project)`; a frame is delivered only when the subscriber passes the ported membership predicate on a project linked to the frame's chain (org-admin override). Frames carrying `read_all`-floored information are restricted to owner/admin subscribers. An org-wide financial stream would leak client profitability to every seat.

**Frames are advisory-only (round-1 T11).** The client **refetches the affected TanStack Query keys on reconnect** rather than replaying a backlog; no frame is load-bearing for correctness, and a missed frame costs a refresh, not a wrong number. The membership predicate on fan-out is served from the **Redis-cached `PermissionContext`** the REST builder already uses (`@bigbluebam/permissions`), not a DB round-trip per frame per subscriber.

Frames: `unscoped.detected { work_item_id, engagement_id, band }`, `precheck.decided { precheck_id, verdict, engagement_id }`, `variance.detected { variance_id, kind, severity, engagement_id }`, `attribution.reviewed { attribution_id, state }`, `gate.mode_changed { mode, reason }`. No client names, no clause text, no dollars.

---

## 7. Frontend

`apps/burn/`, a React 19 SPA served by nginx at `/burn/`, structured like `apps/bulwark/` and `apps/braid/`. TanStack Query v5 for server state, Zustand for local UI state, `@bigbluebam/ui` for every primitive, `@bigbluebam/bureau-client` for the docked-call box, TailwindCSS v4, Motion for transitions, `useCan` from the generated `@bigbluebam/permissions` codegen for every permission-conditional control.

### 7.1 Portfolio Board (`/burn/`)

The landing screen. One card per active **chain** grouped by Braid-resolved client. Each card: contract value, attributed, unscoped, a burn bar, a status chip (`healthy` / `at_risk` / `overrun` / `silent` / `unlinked`), and the figure labeled from `metric_basis`: **"Margin"** only when cost rates cover the work, **"Contract consumption"** otherwise, with the coverage percentage beside it (D1). A member sees only their projects' chains; the "All accounts" toggle appears only for `burn.financials.read_all` holders and is **absent**, not disabled, otherwise. Non-`read_all` callers see bands, not absolutes (S4).

A persistent **queue-health strip** (D5): inflow versus resolution rate, oldest item age, and "$X in pending review, excluded from every envelope."

Components: `ChainCard`, `BurnBar`, `MetricBasisLabel`, `AccountGroup`, `QueueHealthStrip`, `UnlinkedBanner`.

### 7.2 Unscoped Queue (`/burn/unscoped`)

The product. Dense, keyboard-driven, **clustered by task tree and normalized title signature** so one decision closes a group. Per row: source badge, title, date, dollars (subject to the S6 flooring), the classifier's proposal with confidence, rationale on hover. Actions bound to keys: `Attribute to...` (`a`), `Confirm` (`c`), `Mark unscoped` (`u`), **`Mark non-billable` (`n`)**, `Raise change order` (`o`), and `Create a rule from this` (`r`), which opens the rule editor prefilled from the cluster. Separate tabs for `no_matching_deliverable` (scope creep) and `low_confidence` (tuning), never merged. A running "$X of unbilled work" header.

Components: `ClusterGroup`, `UnscopedRow`, `DeliverablePicker` (searchable, shows envelope band per option), `ConfidenceBadge`, `NonBillableMenu`, `BulkActionBar` (rendering per-item `applied` / `conflicted` / `failed` results, T8), `HiddenByPermissionsNotice`.

### 7.3 Engagement detail (`/burn/engagements/:id`)

Chain-aware. Three panes: the deliverable ledger with clause cites and per-deliverable burn-down; the attributed work-item ledger with source deep links; the variance list. The burn-down renders the **dated amendment step-ups** (D3). A **"Deliverables pending review"** banner when extraction produced unconfirmed rows, and an explicit **"Envelope unconfirmed"** state per deliverable, because until an envelope is confirmed it gates nothing (S7). The confirmation control shows the **verified quote beside the extracted number**.

Components: `ChainTimeline`, `DeliverableTable`, `EnvelopeConfirmDialog`, `CitedSpanPopover` (quote rendered only for `read_all`), `BurndownChart`, `WorkItemLedger`.

### 7.4 Gate Console (`/burn/gate`)

Where Section 5 becomes legible:
- Current mode **per class**, with the three kill switches on the same screen.
- The promotion wizard: the six preconditions with live standing from `GET /v1/calibration`, the mandatory review of the last 20 advisory denies **with the inline "Right call? Yes / No / I'd have mapped it" control** (D8), and `acknowledge_blocking`.
- **"Advisory is a complete product"** stated in the wizard, with no nagging toward promotion for an org that has no path there.
- The precheck log with verdict, target, overage, outcome, and override reason.
- **Gate coverage**: "the gate was unavailable for N of the last 7 days" and "X percent of money-out writes reached the gate" (T5/I1).
- Prominent auto-demotion banner when `gate_demoted_at` is recent, naming which trigger fired (false-positive rate or coverage) and the contributing rows.

Components: `GateModeSwitch`, `PromotionWizard`, `CalibrationPanel`, `CoveragePanel`, `PrecheckLogTable`, `AdvisoryFeedbackControl`, `OverrideDialog` (reason minimum enforced client-side and server-side).

### 7.5 Variance and change-order inbox (`/burn/variances`)

Variance list by severity with the drafted change order inline. Approve routes into the standard platform proposal flow.

### 7.6 Cost rates (`/burn/settings/cost-rates`)

Owner/admin only. Effective-dated cost rates per user and project, with a coverage readout: "cost rates cover 62 percent of attributed hours; margin is reported for those, consumption for the rest." This screen is what converts the Portfolio Board's label from consumption to margin, and the copy says so.

### 7.7 Settings and rules (`/burn/settings`, `/burn/settings/rules`)

Thresholds with plain-language explanations, clamped in the UI to the same bands the DB `CHECK`s enforce; signal toggles; retention; LLM provider selector; and the deterministic rule editor with a live "this rule would have matched N of the last 200 items" preview.

---

## 8. Background work, events, and integration

### 8.1 Worker jobs

BullMQ workers in `apps/worker`, registered in `apps/worker/src/worker.ts` following the Bulwark block at `:2207-2260`. Thin HTTP callers into burn-api internal routes, each with **its own generous `AbortController` deadline distinct from `LLM_TIMEOUT_MS`**, following `apps/worker/src/jobs/bulwark-proposal-reconcile.job.ts:48` (I5). Every job is `concurrency: 1` where noted and takes a **per-org Redis lock**, on the `bulwark-radar-sweep.job.ts` pattern.

| Queue | Schedule | Concurrency / lock | Purpose |
| --- | --- | --- | --- |
| `burn-extract-deliverables` | on demand | per-engagement lock | 4.1; checkpointed, resumable, S7 limits |
| `burn-attribute-batch` | on demand + every 2 min | **`concurrency: 1`, per-org lock, `limiter: { max: 30, duration: 60000 }`** | 4.2; **claims** inbox rows; honors `BURN_ATTRIBUTE_CONCURRENCY` |
| `burn-claim-reaper` | every 5 min | `concurrency: 1` | returns `claimed` rows older than `claim_lease_seconds` to `pending` |
| `burn-variance-sweep` | every 30 min | **`concurrency: 1`, per-org lock** | 4.3 plus the three reconcile passes; flushed per-org and per-N-item progress logs |
| `burn-silent-deliverable-sweep` | daily 03:00 UTC | per-org lock | 4.4 |
| `burn-rollup-refresh` | hourly + on demand | per-org lock | full per-chain recompute upserted in one statement (T1) |
| `burn-calibration-recompute` | daily 04:00 UTC | per-org lock | 5.4 / 5.6; drains the Redis coverage counters; drives both demotion triggers |
| `burn-proposal-reconcile` | every 15 min | `concurrency: 1` | expired or externally-decided proposals, per `braid-proposal-reconcile.job.ts` |
| `burn-retention` | daily 05:00 UTC | per-org lock | purges per settings; see the exemptions below |
| `burn-embed-sync` | registered, **scheduled off** | | the Qdrant path behind `embedding_enabled` |

9 scheduled/queued job families plus the reaper.

**Retention never rewrites history (round-1 T11).** Purging a work item cascades its attributions, so the dollars behind a three-year-old closed chain's figure would vanish and the number would change retroactively, for an app whose output an owner may have shown a client. Therefore: `burn-retention` **exempts work items whose chain is not `closed`**, and for closed chains the **`burn_engagement_rollups` row is the immutable historical record**, served with its `as_of` after the underlying rows are purged. Never purged at all: enforced or overridden or labeled prechecks, `burn_classifier_feedback`, `burn_extraction_runs`.

### 8.2 Bolt events published (source `burn`)

Via `publishBoltEvent(eventType, 'burn', payload, orgId, actorId?, actorType?)`, the positional signature at `packages/shared/src/bolt-events.ts:34-41` (round 1 verified the spec's usage is correct). Bare names with `source: 'burn'` separate. Registered in a new `burnEvents` block in `apps/bolt-api/src/services/event-catalog.ts` (the `bulwarkEvents` block is at `:2939`, `ALL_EVENTS` at `:3025`, the spread at `:3046`) .

**No payload carries a dollar amount or a percentage (round-1 S5).** Bolt is org-level with no per-rule visibility (`preflightBoltRule`, `visibility.service.ts:1131-1150`, gates on org match alone), so any member could author a rule on a Burn event and template the figures into a Banter post or an email; `GET /bolt/api/v1/events/recent` is gated on `requireAuth` plus a non-enforcing `shadowOnly(...)`. For this app the magnitude **is** the secret. Payloads carry refs plus a coarse `severity` or `band`. Rule authors fetch numbers from `GET /v1/financials` under their own permissions. `burn.*` outbound-webhook subscriptions additionally require org-admin authorship.

| `event_type` | When | Payload (refs + bands only) |
| --- | --- | --- |
| `engagement.extracted` | an extraction run completes | `engagement.id`, `chain_root_id`, `deliverables_extracted`, `low_confidence_count` |
| `deliverable.extracted` | a deliverable is persisted | `deliverable.id`, `engagement.id`, `deliverable_kind`, `confidence`, `review_status` |
| `work.unscoped` | an item lands unscoped at or above the floor | `work_item.id`, `engagement.id`, `reason`, `source_type`, `band` |
| `precheck.blocked` | an enforced deny | `precheck.id`, `engagement.id`, `deliverable.id`, `verdict_reason`, `band` |
| `precheck.overridden` | a deny is overridden | `precheck.id`, `override_reason_code`, `band` |
| `gate.demoted` | auto-demotion fires | `org.id`, `from_mode`, `to_mode`, `trigger` (`false_positive_rate` \| `coverage`), `window_days` |
| `gate.coverage_degraded` | coverage falls below the floor | `org.id`, `coverage_pct_band`, `window_days` |
| `variance.detected` | a new variance is raised | `variance.id`, `engagement.id`, `variance_kind`, `severity` |
| `deliverable.silent` | inverse check fires | `deliverable.id`, `engagement.id`, `due_date`, `days_remaining` |
| `consumption.threshold_crossed` | chain consumption crosses a band | `engagement.id`, `chain_root_id`, `band` |

10 events.

**Two new `bill` events this build also adds**, registered in the existing `billEvents` block and published from `apps/bill-api/src/routes/expenses.routes.ts`: `expense.created` and `expense.approved`. Genuinely missing from the platform today; Burn's post-hoc variance path needs them and Bolt rule authors benefit independently.

**The drift guard is not currently wired into CI, and this build wires it (round-1 B4).** `check:bolt-catalog` exists at `package.json:35`, but grepping `.github/workflows/*.yml` returns nothing: CLAUDE.md's claim that it is "the CI drift guard" is stale. This build **adds a `check:bolt-catalog` step to `.github/workflows/lint.yml`** next to the existing `check:permission-catalog` step at `:49`, and runs it manually before merge. Referenced as a platform gap Burn closes, not as a safety net that already exists.

### 8.3 Events Burn subscribes to

Through a `burn-dispatch-hook.ts` in bolt-api called alongside `dispatchToBraid` and the Bulwark hook in `apps/bolt-api/src/routes/event-ingestion.routes.ts`, forwarding to `${BURN_API_INTERNAL_URL}/v1/internal/events`, gated by a per-org Redis binding set (`burn:bindings:<org_id>`) on the `apps/bulwark-api/src/services/gate.service.ts` shape, an advisory cache over the durable table.

Subscribed: `bam:task.created`, `bam:task.updated`, `bam:task.moved`, `bam:task.assigned`, `bam:task.completed`, `bam:sprint.completed`, `helpdesk:ticket.created`, `helpdesk:ticket.replied`, `bill:invoice.created`, `bill:invoice.finalized`, `bill:recurring.invoice_generated`, `bill:expense.created` (new), `bill:expense.approved` (new), `bond:deal.won`, and `banter:message.posted` when enabled.

**Durability.** Every subscribed event corresponds to a persistent source row, so the three-pass reconcile (2.3.2) recovers anything dropped on the bolt-api hop, converging on the same row through the content-hash key. Burn does not depend on a bolt-api sending-end outbox, though it benefits if one ships.

**Note on `task.updated` volume.** Because the epoch is a content hash and never `updated_at` (2.3.2), a `task.updated` event for a board drag resolves to an unchanged epoch and short-circuits at one index probe, before candidate assembly and before any LLM call. Subscribing to a chatty event type is therefore cheap by construction, not by luck.

### 8.4 entity_links, unified activity, search

- **entity_links:** on engagement register, upsert `burn.engagement -> bond.company`, `-> bin.asset`, `-> bill.client`; on confirmed attribution, upsert `burn.deliverable -> <source_type>` (`link_kind='related_to'`, `ON CONFLICT DO NOTHING`).
- **unified activity:** Burn flows through the Bolt events above, not into the fixed `v_activity_unified` UNION (bam/bond/helpdesk only), matching Braid and Bulwark.
- **search_everything:** a Burn provider is a fast-follow, not v1 (Open Question 10).

### 8.5 Braid integration

At engagement register and on account change, Burn resolves the account to a Braid golden id through a ported `braid-resolve.client.ts` (`apps/bulwark-api/src/lib/braid-resolve.client.ts`), calling `POST /v1/internal/resolve` with the internal secret and the caller's `asker_user_id`. Soft dependency: an absent `BRAID_API_INTERNAL_URL`, a missing asker, or any non-2xx degrades to the raw `bond.company` id and never fails the create. This is what makes "which client is consuming its contract fastest" correct when the same customer appears as three legal entities across Bond, Bill, and Book.

---

## 9. Infrastructure

### 9.1 New api compose service

`burn-api` in `docker-compose.yml`, modeled on the `bulwark-api` block: `PORT: 4022`, stateless, horizontally scalable. Per-request RLS GUC binding per 2.4 point 14 (**not** a copy of the existing broken plugin). `depends_on`: `migrate` (`service_completed_successfully`), `postgres` and `redis` (`service_healthy`) only.

Env: `DATABASE_URL`, `DATABASE_READ_URL=${DATABASE_READ_URL:-}`, `REDIS_URL` / `REDIS_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` (non-empty; internal routes fail closed when empty), `BBB_API_INTERNAL_URL=http://api:4000`, `BOLT_API_INTERNAL_URL=http://bolt-api:4006`, `BILL_API_INTERNAL_URL=http://bill-api:4014` (rate resolution + change-order line items), `BRAID_API_INTERNAL_URL=${BRAID_API_INTERNAL_URL:-http://braid-api:4020}`, `QDRANT_URL` / `QDRANT_API_KEY` (optional, unused while `embedding_enabled=false`), `CORS_ORIGIN`, `NODE_ENV`, `HOST`, `LOG_LEVEL`, `LLM_TIMEOUT_MS`, `UPSTREAM_TIMEOUT_MS`, `MAX_DOC_BYTES`, `MAX_DOC_PAGES`, rate-limit knobs, `BBB_PERMISSIONS_ENFORCE`.

Healthcheck: `curl -sf http://localhost:4022/health` (B2/I3: **`/health`**, never `/readyz`).

### 9.2 bill-api wiring (the gate hook)

- `BURN_API_INTERNAL_URL=${BURN_API_INTERNAL_URL:-http://burn-api:4022}` and **`BURN_PRECHECK_TIMEOUT_MS=${BURN_PRECHECK_TIMEOUT_MS:-800}`** in the bill-api compose env **and** in `bill-api.env.optional` in `scripts/deploy/shared/services.mjs` (T4/I2). Both **optional**: an unset URL means the gate is absent and every expense posts normally. bill-api must never fail to start because Burn is not deployed.
- `apps/bill-api/src/lib/burn-precheck.client.ts`: `AbortController` on `BURN_PRECHECK_TIMEOUT_MS`, internal-secret header, **Redis circuit breaker** (5.5.1), Redis coverage counters and the `BURN_GATE_UNAVAILABLE` log code (5.5.2), and **`allow` on every error path**.
- The `burnPrecheck` preHandler on the four hook points in 5.2.
- The two `publishBoltEvent` calls for `expense.created` / `expense.approved`.
- **`POST /internal/rates/resolve`** delegating to the existing `resolveRate` (`apps/bill-api/src/services/rate.service.ts:117`), guarded by `INTERNAL_SERVICE_SECRET`.
- One breaker check per job in `apps/worker/src/jobs/bill-recurring-generate.job.ts` (the serial loop is at `:367`).

`bill-api.needs` gains nothing: Burn is a degradable request-time dependency.

### 9.3 Worker wiring

- Confirm `BBB_API_INTERNAL_URL: http://api:4000` is present on the worker service (added by the Braid build at `docker-compose.yml:258`).
- Add `BURN_API_INTERNAL_URL` and **`BURN_ATTRIBUTE_CONCURRENCY`** to the worker compose env and to `worker.optional` in `services.mjs`.
- Register the queues in `apps/worker/src/worker.ts`, repeatable ones on the basis scheduler pattern at `worker.ts:673-679`.
- Byte reads via `@bigbluebam/storage`; `BIN_API_INTERNAL_URL` is added nowhere.

### 9.4 SPA build

Edit `apps/frontend/Dockerfile` in four sites mirroring the bulwark lines: deps-stage `COPY apps/burn/package.json ./apps/burn/`; build-stage source COPY block; `&& pnpm --filter @bigbluebam/burn build`; production `COPY --from=build /app/apps/burn/dist /usr/share/nginx/html/burn`.

### 9.5 nginx routing

`infra/nginx/nginx.railway.conf` is generated from `infra/nginx/nginx-with-site.conf` by `scripts/gen-railway-configs.mjs`. Edit only the two source configs, after the bulwark blocks:
- `infra/nginx/nginx.conf`: `/burn/` alias plus SPA fallback, `/burn/api/ -> http://burn-api:4022/`, `/burn/ws -> http://burn-api:4022/ws` with upgrade headers.
- `infra/nginx/nginx-with-site.conf`: the same three blocks.
- **Static-asset alternation, and the drift it sits on (round-1 I6).** `burn` goes into the alternation in **both** source files. Verified: `infra/nginx/nginx.conf:728` includes `bill`; `nginx-with-site.conf:806` and the generated `nginx.railway.conf:942` do **not**; and none of the three includes `bay` or `blip`. "Insert only the `burn` token" would silently preserve that drift. The pre-existing `bill` / `bay` / `blip` omission is recorded as a tracked task so the two source files converge; this build adds `burn` to both and does not unilaterally reconcile the rest in the same pass.
- Then `node scripts/gen-railway-configs.mjs`. Do not hand-edit `:8080` or the `$rw_upstream_NN` index.
- Ingress crash-safety: add `burn-api` (`condition: service_healthy`) to the `frontend` service `depends_on`.

### 9.6 Deploy catalog, MCP, launchpad, docs

- `scripts/deploy/shared/services.mjs`: a `burn-api` `APP_SERVICES` block (port `4022`, **`healthcheck: '/health'`** matching `:298`, `public_paths: ['/burn/api/','/burn/ws']`, required env incl. `DATABASE_URL`/`REDIS_URL`/`SESSION_SECRET`/`INTERNAL_SERVICE_SECRET`/`BBB_API_INTERNAL_URL`/`BOLT_API_INTERNAL_URL`, optional incl. `DATABASE_READ_URL`/`BILL_API_INTERNAL_URL`/`BRAID_API_INTERNAL_URL`/`QDRANT_URL`/`CORS_ORIGIN`/`LOG_LEVEL`). `burn-api.needs = ['postgres','redis','api','bolt-api','bill-api']`. Add `/burn/` to the `frontend` entry's `public_paths` and `burn-api` to its `needs`.
- MCP wiring: `BURN_API_URL: http://burn-api:4022/v1` in the docker-compose `mcp-server` block (mirroring `BULWARK_API_URL` at `docker-compose.yml:189`) **and** in `mcp-server.env.optional` in `services.mjs`. Do not add `burn-api` to `mcp-server.needs`, matching braid/basis/bulwark. Register `burn-tools.ts` in the MCP bootstrap.
- bolt-api: `BURN_API_INTERNAL_URL=http://burn-api:4022` in its compose env and catalog, alongside `BULWARK_API_INTERNAL_URL` (`docker-compose.yml:267`).
- `node scripts/gen-railway-configs.mjs` to regenerate `nginx.railway.conf` and emit `railway/burn-api.json`.
- **Railway variable set (round-1 I7).** Railway service variables are **not** derived from compose. Add the `burn-api` variable set and the **new `frontend` variables** to the Railway project, and regenerate / update `railway/env-vars.md` in the same change.
- **Launchpad**: in `apps/api/src/routes/system-settings.routes.ts`, add `'burn'` to `LAUNCHPAD_APP_IDS` (after `'bulwark'` at `:63`) and a `LAUNCHPAD_CATALOG` entry `{ id: 'burn', name: 'Burn', description: 'Scope and Margin', icon_name: 'flame', color: '#ea580c', path: '/burn/' }` (after `:101`). Do **not** add to `ROOT_REDIRECT_VALUES`. `flame` is absent from `ICONS` in `packages/ui/launchpad.tsx:65`, so add `import { Flame } from 'lucide-react'` and `'flame': Flame`, or the launchpad falls back to `Box` at `:226`.

#### 9.6.1 The three doc guards that `LAUNCHPAD_CATALOG` triggers (round-1 B1, blocker)

Adding `'burn'` to `LAUNCHPAD_CATALOG` is not inert. `scripts/docs/build-manual.mjs:78-85` derives its app roster **directly from `LAUNCHPAD_CATALOG`**, so `manual.generated.json` immediately gains a Burn entry (a `stubEntry()` at `:91` if `docs/apps/burn/help.md` is absent), and `.github/workflows/lint.yml:58` runs `pnpm docs:manual:check`, which fails on committed-file drift. Separately `scripts/docs/extract.mjs:42-65` holds a **hardcoded** `APP_REGISTRY`; with no `burn` entry `pnpm docs:extract` never emits `docs/apps/burn/` at all. And `lint.yml:55` runs `pnpm help:check` (`scripts/help/build-help-index.mjs --check`, exit 1 at `:226`). Four required edits, none optional:

1. Add `burn: { nginxPath: '/burn/', apiPort: 4022, apiDir: 'burn-api', appId: 'burn' }` to `APP_REGISTRY` at `scripts/docs/extract.mjs:63`, immediately after the `bulwark` row.
2. Author `docs/apps/burn/help.md` and run `pnpm help:index`.
3. Run `pnpm docs:manual` and commit the regenerated `site/src/content/manual.generated.json`.
4. Add `burn: ['burn-tools']` to `APP_TOOL_MODULES` in `scripts/docs/lib/tool-source.mjs` (after the bulwark entry at `:85`), run `pnpm docs:catalog`, and commit the regenerated `site/src/content/docs-catalog.generated.json`.

**`site/src/pages/docs.tsx` (round-1 B5).** The blanket "never hand-edit" in the round-1 draft over-read the convention. CLAUDE.md is precise: the app and tool **lists** are generated and must not be hand-coded, but the one sanctioned edit is adding an icon and color for the new id in `APP_ICON` / `APP_COLOR`, otherwise it falls back to a neutral `Server` icon. The bulwark entries are at `docs.tsx:73` and `:98`. Add exactly one `Flame` entry and one orange class pairing alongside them, and nothing else.

- **Surface map**: update `docs/reference/mcp-endpoint-mapping.md` in the same change. Every REST row's MCP column is a backtick tool name or a sanctioned skip cell with a reason; keep the coverage counts in sync and the zero-bare-dash grep green.
- **Marketing site**: add a Burn section, GILLIGAN-only screenshots, rebuild the site image. Update the MCP tool count and the "N apps" narrative in both `CLAUDE.md` and `site/`.
- **CLAUDE.md**: append the `burn-api` (internal :4022, `/burn/api/`) and `burn` SPA inventory lines, the route rows, the worker job names, and the MCP tool count.

### 9.7 Resource sizing and the LLM seam (round-1 I5)

`docker-compose.yml` runs a **single** `worker` service with `WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-5}` shared across roughly 54 queues plus 28 scheduled jobs, with no `mem_limit`, `cpus`, or `deploy.replicas` anywhere. Burn adds nine job families, one on a 2-minute cadence doing LLM work, one hourly rollup over the highest-churn table, and a 30-minute sweep re-reading bounded source history across every org. `attribution_llm_daily_cap` is a per-org DB column: it bounds one tenant's spend and bounds nothing about worker CPU, burn-api's DB pool, or contention on the shared `POST /internal/llm/chat` route that Beacon, Brief, Braid, and Bulwark also use.

- **burn-api** starts at **2 replicas** with a DB pool of **10 per replica**. It is the process holding the LLM calls; the worker jobs are thin HTTP callers, so each worker call carries **its own generous `AbortController` deadline distinct from `LLM_TIMEOUT_MS`**, per `apps/worker/src/jobs/bulwark-proposal-reconcile.job.ts:48`.
- **`BURN_ATTRIBUTE_CONCURRENCY`** (default 2) is the operator knob bounding in-flight attribution batches independently of `WORKER_CONCURRENCY`.
- **Split the worker** into a second container when `burn-attribute-batch` queue depth stays above 500 for an hour or when non-Burn scheduled jobs start missing their cadence. Both thresholds are stated so an operator has a trigger rather than a vibe.
- **Burn is the forcing function for a platform-level concurrency cap on the internal llm-provider seam**, and this is named as a **prerequisite, not a fast-follow**: without one, a large Burn tenant can starve Beacon, Brief, Braid, and Bulwark of the shared route. Open Question 8.

### 9.8 Ordered rollout (round-1 I4)

CLAUDE.md documents that the `migrate` sidecar is cached via `service_completed_successfully` and does **not** re-run on a subsequent `docker compose up -d <service>`. Section 9.1 gives burn-api a migrate dependency, which on an existing long-running stack is satisfied instantly by the cached completion, so a naive first `docker compose up -d burn-api` starts against a database with **no `burn_*` tables**, producing exactly the 42703 / "relation does not exist" class CLAUDE.md devotes a troubleshooting section to. The required sequence:

```sh
# 1. Land 0239-0243 on disk, then lint them
pnpm lint:migrations

# 2. Apply them explicitly. The migrate service bind-mounts ./infra/postgres/migrations,
#    so no rebuild is needed on a developer host.
docker compose run --rm migrate

# 3. Verify the tables and the ledger
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "\d burn_work_items"
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 6;"

# 4. Only now build and start the app
docker compose build burn-api frontend
docker compose up -d --force-recreate burn-api frontend
```

**Two rules that bite if ignored.** (a) The generated `0242` permission delta is **immutable once applied anywhere, including your own dev DB**: if `build-permission-delta.mjs` reassigns a number afterward, that is a checksum mismatch in `apps/api/src/migrate.ts` and the fix is a **new file**, never an edit, and never `MIGRATE_ALLOW_HEADER_RESTAMP=1`. (b) For a Railway deploy the migrations must be **on disk before the burn-api image is built**, because production bakes them into the image via `apps/api/Dockerfile` rather than bind-mounting them.

---

## 10. Seed data plan (GILLIGAN, per the hard rule in CLAUDE.md)

Every screenshot in every shipped doc must be the gilligan dataset. The frame: **Gilligan Travel Ltd is the services firm**, and the Howells are the client who keeps asking for things nobody sold.

**Two registration edits, named exactly (round-1 B6):**

1. **`scripts/seed-all.mjs`**: `PHASE_B` is a flat `const PHASE_B = [...]` at `:82-95`, iterated at `:272`. Add `'seed-burn.mjs'` to that array **after `'seed-bill.mjs'`**.
2. **`scripts/seed-gilligan/run-all.mjs`**: this is a list of **grouped phase objects** at `:60-75`, not a flat list. `bill.mjs` is in the **Billing** group and `bin.mjs` is in the **Knowledge & analytics** group, so "after bill and bin" does not identify a location. Burn must run after **both** groups. Add a new **trailing group**: `{ name: 'Margin', files: ['burn.mjs'] }`, placed last.

**No precedent claim.** There is no `bulwark.mjs` and no `braid.mjs` in `scripts/seed-gilligan/` at all; the round-1 draft's claim of following a Bulwark seeding precedent was false. Burn establishes the pattern for a satellite app's gilligan seeder. `.github/workflows/seed-smoke.yml` exercises the seed path, so the new group must not break it.

**Engagements (4, exercising the amendment chain):**
1. *"Howell Luau Production Agreement"* - fixed fee, $18,000, linked to the gilligan Bam project and Bond company. Bin asset: a generated PDF SOW seeded by `bin.mjs`. The flagship demo: healthy on paper, bleeding through unscoped work.
2. *"Howell Luau Change Order 1"* - **an amendment** (`amends_engagement_id` to #1, `contract_value_delta` $3,200), so the chain, the dated burn-down step-up, and the chain-root rollup are all demonstrable rather than theoretical.
3. *"Castaway Rescue Retainer"* - monthly retainer, $4,500/mo, T&M envelope, linked to **two** projects so the many-to-many is exercised.
4. *"Coconut Supply Chain Assessment"* - not-to-exceed $6,000, with one deliverable already silent, due in eight days, to demo the inverse check.

**Deliverables (13):** e.g. under the Luau agreement "Guest list and RSVP management" (clause 2.1, $3,000), "Menu and coconut catering plan" (2.2, $6,500), "Signal fire and ambience" (2.3, $2,500), "Event day coordination" (3.1, $6,000); the change order adds "Extended cocktail service" ($3,200). Each carries a realistic `cited_span.quote` from the seeded SOW so the cite popover shows real text, and **each is seeded `is_active` with a confirmed envelope**, since nothing gates until a human confirms (S7).

**Cost rates (6):** seeded for four of the six cast members, deliberately leaving **partial coverage** so the Portfolio Board demonstrates the D1 behavior: chains with full coverage read "Margin", the rest read "Contract consumption", with the coverage percentage visible. This is the single most important thing the seed data must show.

**Work items (roughly 150):** derived from the existing gilligan Bam tasks and time entries (`scripts/seed-gilligan/bam.mjs`) plus gilligan Bill expenses (`bill.mjs`), so Burn's ledger is a real join over data the suite already seeds rather than an invented island.

**Attributions:** roughly 70 percent `auto_attributed` / `confirmed`, 10 percent `pending_review`, 8 percent `excluded_non_billable` (a seeded retro and a PTO block, so the non-billable state is visible), 12 percent `unscoped` split across both reasons. The scope-creep story is concrete: the Professor's "Build coconut radio for the Howells" and "Third revision of Mrs. Howell's seating chart" land `no_matching_deliverable` at $1,940, so the queue header shows a real figure.

**Attribution rules (2):** one non-billable rule on the internal retro project, one attributing "signal fire" titles to deliverable 2.3, both with non-zero `match_count`.

**Prechecks (roughly 30):** the org seeded in **`advisory` mode with 210 decisions, 16 days of history, 12 labeled advisory denies at 0.96 precision, and 0.99 coverage**, so the promotion wizard is fully demonstrable and the calibration panel shows real numbers against all six preconditions rather than an empty state. Two seeded overrides: one `change_order_pending` (gate was right, and it links to engagement #2, closing the loop) and one `gate_wrong` so the false-positive rate renders non-zero but below both the rate ceiling and the absolute-count floor.

**Variances (6):** one `envelope_overrun` on Luau catering, one clustered `unscoped_work`, one `silent_deliverable`, one `ungated_charge`, one `consumption_erosion`, one `gate_outage` covering a seeded historical window.

**Classifier feedback (roughly 25 rows)** so the vocabulary and calibration surfaces are populated, and **rollups** computed for all four chains so the board never renders from a live aggregate.

Capture recipes go in `packages/docs-capture` using the gilligan defaults from `packages/docs-capture/src/environment.ts` (`skipper@gilligantravel.example` as admin). Never the e2e org, never `screenshots-demo`.

---

## 11. MCP surface and permissions

### 11.1 MCP tools

New `apps/mcp-server/src/tools/burn-tools.ts` via `registerTool`, HTTP client shaped like `dedupe-tools.ts:38`. Env `BURN_API_URL=http://burn-api:4022/v1`. Reads and writes that surface or mutate source-scoped records require `asker_user_id` (`docs/reference/agent-conventions.md`) and fail closed via `can_access`. Destructive tools use the Redis confirm-token store. `burn_*` is not added to `EXPLICIT_TOOL_OVERRIDES`.

| Tool | Backs | Permission | confirm / asker |
| --- | --- | --- | --- |
| `burn_precheck` (**flagship**) | POST `/v1/precheck` | `burn.precheck.run` | `asker_user_id`; **project-scoped**; floored envelope |
| `burn_attribute` | POST `/v1/attributions` | `burn.attribution.write` | `asker_user_id` |
| `burn_margin` | GET `/v1/financials` (and `/accounts` when the asker holds `read_all`) | `burn.financials.read` | `asker_user_id`; returns `metric_basis` + `as_of`, so it can never mislabel (D1) |
| `burn_list_engagements` | GET `/v1/engagements` | `burn.engagement.read` | no |
| `burn_get_engagement` | GET `/v1/engagements/:id` (embeds chain, deliverables, rollup) | `burn.engagement.read` | `asker_user_id` |
| `burn_extract_deliverables` | POST `/v1/engagements` and `/engagements/:id/extract` | `burn.engagement.write` | no |
| `burn_delete_engagement` | DELETE `/v1/engagements/:id` | `burn.engagement.delete` | **confirm** |
| `burn_list_deliverables` | GET `/v1/deliverables` | `burn.deliverable.read` | no |
| `burn_confirm_deliverable` | PATCH `/v1/deliverables/:id` (confirm + envelope) | `burn.deliverable.write` | `asker_user_id` |
| `burn_reject_deliverable` | PATCH `/v1/deliverables/:id` (`rejected`) | `burn.deliverable.write` | **confirm** + `asker_user_id` |
| `burn_list_unscoped` | GET `/v1/unscoped` | `burn.attribution.read` | `asker_user_id` |
| `burn_reclassify_attribution` | PATCH `/v1/attributions/:id` (incl. non-billable) | `burn.attribution.write` | `asker_user_id` |
| `burn_override_precheck` | POST `/v1/prechecks/:id/override` | `burn.precheck.override` | `asker_user_id`; reason code + text required by schema |
| `burn_list_variances` | GET `/v1/variances` | `burn.variance.read` | no |
| `burn_draft_change_order` | POST `/v1/change-orders` | `burn.changeorder.draft` | no (the proposal is the HITL) |
| `burn_set_gate_mode` | PATCH `/v1/settings` (`gate_mode` / `gate_paused_until` only) | `burn.settings.write` | **confirm when the target WEAKENS enforcement** (`off`, `advisory`, or a pause). Promotion is already server-gated by 5.4 (S10) |
| `burn_calibration_report` | GET `/v1/calibration` | `burn.settings.read` | no |

**17 tools.**

**No-tool endpoint enumeration, complete** (so the surface map has zero bare dashes):
- `PATCH /v1/engagements/:id` -> skip: metadata edit, SPA-surfaced.
- `POST` / `DELETE /v1/engagements/:id/projects[/:projectId]` -> skip: link management, SPA-surfaced.
- `GET /v1/engagements/:id/burndown` -> skip: resolver-done-internally (`burn_get_engagement` embeds the rollup).
- `GET /v1/deliverables/:id` -> skip: resolver-done-internally.
- `GET /v1/work-items`, `GET /v1/attributions`, `GET /v1/queue-health` -> skip: resolver-done-internally (`burn_list_unscoped` is the agent-relevant slice).
- `POST /v1/attributions/bulk` -> skip: UI bulk-review surface; an agent uses the single-item tool so each decision is individually auditable.
- `GET` / `POST` / `PATCH` / `DELETE /v1/rules[/:id]` -> skip: rule authoring is a deliberate human configuration surface.
- `GET /v1/prechecks` -> skip: gate log is a UI surface.
- `POST /v1/prechecks/:id/label` -> skip: the calibration label is an owner/admin UI judgment, deliberately not agent-writable, because it drives auto-demotion (S3).
- `PATCH /v1/variances/:id` -> skip: triage is a UI action.
- `GET` / `POST` / `PATCH` / `DELETE /v1/cost-rates[/:id]` -> skip: compensation data, owner/admin SPA-only, never agent-reachable.
- `GET /v1/change-orders/:id` -> skip: the proposal inbox fetch path.
- `GET` / `PATCH /v1/settings` beyond `gate_mode` -> skip: settings SPA-surfaced.
- `POST /v1/internal/precheck`, `/v1/internal/prechecks/:id/outcome`, `/v1/internal/events`, `/burn/ws`, `/health`, `/health/ready`, `/metrics` -> skip: internal / realtime / probe.

**agent_policies:** every `burn_*` service-account call fails closed until `burn.*` is allowlisted. Round 1 verified the glob genuinely matches `burn_precheck`.

### 11.2 The 20 hand-authored permission rows

Each with explicit `app:'burn'`, `is_read`, `is_destructive`, `requires_confirmation`, `requires_superuser`:

| Permission | `is_read` | Notes |
| --- | --- | --- |
| `burn.engagement.read` | true | |
| `burn.engagement.write` | false | |
| `burn.engagement.delete` | false | `is_destructive:true, requires_confirmation:true`; **owner/admin** |
| `burn.deliverable.read` | true | |
| `burn.deliverable.write` | false | reject confirm at the tool layer |
| `burn.attribution.read` | true | |
| `burn.attribution.write` | false | also authorizes rule management |
| `burn.precheck.run` | false | it writes a precheck row |
| `burn.precheck.read` | **true** | **new (S10)**: `GET /v1/prechecks` must not be gated on an `is_read:false` permission |
| `burn.precheck.override` | false | member tier: the escape hatch must stay reachable |
| `burn.precheck.mark_wrong` | false | **new (S3/D8)**; **owner/admin**; the only writer of `gate_wrong` / `wrong_call` |
| `burn.variance.read` | true | |
| `burn.variance.write` | **false** | **new (S10)**: a mutation must not be authorized partly by an `is_read:true` permission, which would break viewer-tier backfill semantics |
| `burn.changeorder.draft` | false | |
| `burn.financials.read` | true | project-scoped; banded |
| `burn.financials.read_all` | true | **owner/admin**; absolutes, `contract_value`, clause quotes, per-person fields |
| `burn.costrate.read` | true | **owner/admin**; compensation data |
| `burn.costrate.write` | false | **owner/admin** |
| `burn.settings.read` | true | |
| `burn.settings.write` | false | **owner/admin**; owns `gate_mode` |

**20 permissions.** Only `burn.engagement.delete` is manifest-destructive; the deliverable-reject and gate-weakening confirm boundaries live at the MCP tool layer via `confirm-token-store.ts`, consistent with the Bulwark BP7 precedent.

**Built-in tiering in `0243`:** owner and admin get all `burn.*` (`NOT requires_superuser`); **member gets all except `burn.financials.read_all`, `burn.costrate.read`, `burn.costrate.write`, `burn.precheck.mark_wrong`, `burn.engagement.delete`, and `burn.settings.write`**; viewer gets `is_read AND NOT requires_superuser` except `burn.financials.read_all` and `burn.costrate.read`; guest none.

---

## 12. Test plan

### 12.1 Unit (Vitest, `@bigbluebam/db-stubs`)

**Valuation and rates (D1, D2)**
- **Parity test:** Burn's cost resolver and Bill's `resolveRate` (`apps/bill-api/src/services/rate.service.ts:117`) agree across a shared fixture matrix on **`user+project > user > project > org`** and on **inclusive** `effective_to`. The round-1 draft's test asserted `project` ahead of `user` and an exclusive bound and would have locked both bugs in.
- `POST /internal/rates/resolve` returns the same row as a direct `resolveRate` call for every fixture.
- No cost rate yields `valuation_basis='no_cost_rate'`, a null `cost_amount`, exclusion from margin rollups, and `metric_basis='contract_consumption'` on the rollup.
- Partial cost-rate coverage reports `cost_rate_coverage_pct` and **never** blends a partial margin into a whole-chain figure.
- **No response, export, or rollup carries the string "margin" when `metric_basis='contract_consumption'`.**
- Currency mismatch flags and excludes, never converts, never blocks.

**Source observation (T2, T3, D6)**
- A task moved across the board three times, with no change to `time_logged_minutes`, `project_id`, `title`, or `description`, produces **one** work item, **zero** additional classifications, and **zero** llm-provider calls. `updated_at` is asserted to be absent from every epoch input.
- An epoch match short-circuits before candidate assembly, verified by asserting the LLM client is never invoked.
- A backdated time entry (business `date` last month, `created_at` today) **is** picked up by the `created_at` watermark scan.
- An edited time entry inside `reconcile_window_days` produces a new content hash, a new observation, the prior marked `excluded/superseded_epoch`, and dollars net to the new value. An edit outside the window is asserted **not** detected, matching the stated limitation.
- A deleted expense and a deleted task are marked `excluded/source_deleted` by the anti-join and their dollars reversed; a subsequent precheck against that envelope no longer denies. Edit-shrinks-cost, edit-grows-cost, and delete-removes-cost each tested separately.
- A reversal burst raises `phantom_consumption`.
- The reconcile query plan is asserted to use `tasks_project_id_idx` and `time_entries_task_id_idx` and never to scan `time_entries` org-wide.

**Amendment chain (D3)**
- An amendment leaves the base `active`, its deliverables `is_active`, adds `contract_value_delta` to the chain total, and produces a **dated step-up** in the burn-down.
- A precheck against any engagement in a chain evaluates the chain root's aggregate and the union of active deliverables.
- Amendment deliverables are candidates for work on any project linked anywhere in the chain.
- A restatement migrates attributions by `dedup_key`; **unmatched attributions become `pending_review/restatement_unmatched` and are never silently dropped**; the `ON DELETE RESTRICT` is never violated.

**Engagement-to-project cardinality (D4)**
- An MSA linked to three projects, and a project covered by two concurrent SOWs, both produce a candidate set spanning engagements.
- Deleting a Bam project removes the link row and leaves the engagement in the **defined** zero-project state: visible only to `read_all`, flagged `unlinked`, and **incapable of producing a deny**.
- The ported membership predicate matches platform `isProjectMember` behavior (`visibility.service.ts:203`) across a fixture matrix.

**Attribution**
- A model response naming a deliverable id **not in the candidate set** drops to `pending_review`.
- An injection string in a task title does not change the target.
- Band boundaries write the correct state; `CHECK` constraints reject out-of-band thresholds.
- An LLM timeout yields `pending_review`, **not** `unscoped`.
- A daily-cap breach yields `pending_attribution`, **not** `unscoped`.
- `no_matching_deliverable` and `low_confidence` never merge in any query or response.
- **Human precedence (T8):** the engine never supersedes `state='confirmed'` or `method='human'`; it raises a `pending_review` alongside. Asserted after a `vocabulary_version` bump and after an epoch change.
- Concurrent triage returns **409 with current state**, not a raw 23505.
- `POST /v1/attributions/bulk` returns per-item `applied` / `conflicted` / `failed`.
- A stale `pending_review` past `pending_review_max_age_days` demotes to `unscoped/aged_out` and its dollars **re-enter** the reported total; `queue-health` reports the excluded figure before and after.
- A deterministic rule matches before any LLM call, writes `method='rule'`, and consumes zero LLM budget.
- `excluded_non_billable` items are absent from both the envelope and the unscoped headline.

**Gate precision (the critical suite)**
- **`needs_mapping` never blocks** (D7): in blocking mode the write posts, `enforced=false`, an inline note is returned, and a queue item exists.
- A `deny` is impossible below `deny_threshold`, against an unconfirmed deliverable or envelope, against a null envelope, against a chain with zero confirmed deliverables, and against an `unlinked` engagement.
- **A `stated` envelope cannot set `is_active` without human confirmation** (S7), asserted directly against the worker path.
- `no_active_engagement` yields `needs_mapping` by default and `deny` only under `strict_untracked_projects`.
- `enforced=false` in advisory mode for every verdict including `deny`.
- `bam.task_phase_move` and `bam.assignment` are rejected by `gate_enabled_refs` validation if marked blocking.
- **Fail-open:** unreachable burn-api, an open circuit breaker, a `BURN_PRECHECK_TIMEOUT_MS` overrun, and an LLM outage each yield `allow` with the correct `verdict_reason`; the Redis coverage counter increments; a `BURN_GATE_UNAVAILABLE` log line is emitted; and `ungated_charge` plus `gate_outage` variances are raised on recovery against the marked expense rows.
- The breaker opens after N consecutive failures and short-circuits at **zero network cost**; `bill-recurring-generate` checks it once per job, not per schedule.

**Idempotency and replay (S2, T9)**
- A caller-supplied key is **rejected**; the key is server-derived HMAC and namespaced `svc:` / `usr:`, enforced by the `CHECK`.
- **The banked-verdict attack fails:** an `allow` stored for a 1-cent charge is not returned for a $60,000 charge; the mismatch triggers recompute and supersede.
- A hit past `valid_until` recomputes rather than replaying; a stale `deny` does not persist after a change order expanded the envelope, and a stale `allow` does not persist after exhaustion.
- Two legitimately identical expenses on the same day do not collide (the attempt nonce distinguishes them); an HTTP retry of one attempt does not write a second row.

**Promotion, labeling, demotion (D8, S3)**
- `PATCH /v1/settings` with `gate_mode='blocking'` is **rejected server-side** with the specific shortfall named when any of the six preconditions fails. Asserted against the API directly, not the UI.
- The scale-aware volume floor: an org with 41 advisory decisions but **61 days** of advisory operation satisfies precondition 1.
- Fewer than `min_labeled_denies` labeled denies blocks promotion even at 1.00 measured precision.
- Coverage below `min_gate_coverage_pct` blocks promotion and, once blocking, **auto-demotes**.
- **A member cannot demote the gate:** `POST /v1/prechecks/:id/label` with `gate_wrong` is **403** for the member tier; only `burn.precheck.mark_wrong` holders succeed.
- Demotion requires all three of rate, absolute count, and distinct-user count; a single admin marking five rows wrong does **not** demote.
- Demotion notifies org admins with the contributing rows named.
- `mapped_manually` writes feedback and transitions `mapped` then `mapped_and_posted`; `gate_wrong` counts toward the FP rate while `mapped_manually`, `absorbed_cost`, and `change_order_pending` do not.
- An override of a deny without `override_reason_text` of at least the minimum is rejected **at the API**.

**Extraction**
- `dedup_key` is stable across overlapping-chunk re-extraction and re-extraction; two deliverables in one clause get distinct keys and both persist.
- A cite failing offset verification forces `pending_review` regardless of confidence.
- Extraction resumes from `last_processed_chunk`.
- `MAX_DOC_BYTES` / `MAX_DOC_PAGES` / parse-clock breaches record `rejected_limits` and extract nothing partial; the parser is asserted to run with JavaScript and external entities disabled.

**Rollups (T1)**
- `GET /v1/financials` **never** issues an unbounded live aggregate over `burn_work_items` joined to `burn_attributions`; a missing rollup computes one chain synchronously, a stale one serves `as_of` with `stale: true` and enqueues a refresh.
- The refresh is a single idempotent upsert statement; two concurrent refreshes converge.

**Security**
- **The gate is not an oracle (S1):** a non-project member calling `POST /v1/precheck` with a fabricated charge against another project's engagement gets a scoped rejection, not envelope figures.
- **No absolute recovery (S4):** a test asserts a member cannot recover `contract_value` to within 5 percent from any combination of member-reachable responses, including `/v1/prechecks`, `/v1/change-orders/:id`, `/v1/financials`, and `/v1/engagements/:id/burndown`.
- **The surveillance join is attempted (S6):** a test joins `GET /v1/work-items` `source_id` values to `time_entries.user_id` through `/b3/api/` as a project member and asserts **no dollar figure is obtainable**; per-person hours are permitted, per-person dollars are not. `text_snapshot` PII redaction is asserted on write.
- `can_access`: a cited Bam task the asker cannot see is dropped from `/v1/unscoped` and counted, not returned.
- ws frames are project-scoped; the membership check is served from the cached `PermissionContext`, asserted by counting DB round-trips.
- `/v1/internal/*` returns 401 unconditionally when `INTERNAL_SERVICE_SECRET` is empty, before any compare.
- `agent_proposals.proposed_payload` contains no clause text, client name, or dollar total.
- **Bolt payloads (S5):** every published `burn` event is asserted free of `amount`, `margin_pct`, and any absolute figure.
- **Cross-app authority (S8a):** the change-order approval path is asserted to call bill-api **as the decider**, and a decider lacking the relevant `bill.*` permission is rejected **by bill-api**, not merely by Burn.
- **`llm_provider_id` (S8b):** setting a provider id belonging to another org is rejected at `PATCH /v1/settings` regardless of the platform route's behavior.
- **RLS, mandatory not optional (S9):** boot burn-api under `BBB_RLS_ENFORCE=1` and assert a query for org A returns **zero** org-B rows **with the app-level predicate removed**, on every `burn_*` table. This is the test that proves the GUC actually binds, which the four existing plugins would fail.
- Application-level org scoping: a service-layer query for org A returns zero org-B rows on every `burn_*` table.

**Permissions**
- Manifest test: `burn.engagement.delete` lands `is_destructive:true, requires_confirmation:true`; every row carries an explicit `is_read`; `burn.precheck.read` and `burn.variance.read` are `is_read:true`, `burn.variance.write` is `is_read:false`.
- Tiering after `0243`: an Owner GETs 200 on `/v1/financials/accounts` and `/v1/cost-rates`; a Member is 403 on both, on `POST /v1/prechecks/:id/label`, on `DELETE /v1/engagements/:id`, and on `PATCH /v1/settings`; a Viewer is read-only and 403 on the floored reads.
- `register-tool` policy test: `burn.*` fails closed until allowlisted.
- `burn_set_gate_mode` requires a confirm token for `off`, `advisory`, and a pause, and does **not** for a promotion to `blocking` (S10).

### 12.2 Playwright user stories (GILLIGAN dataset only)

1. **The unscoped discovery.** The Skipper opens `/burn/`, sees the Howell Luau chain at `at_risk` labeled **"Contract consumption"** (not "Margin", because cost-rate coverage is partial), clicks through to the unscoped queue, and reads "$1,940 of work nobody sold." He opens "Third revision of Mrs. Howell's seating chart," sees `no_matching_deliverable` at 0.93, and clicks **Raise change order**. A proposal appears in the approval inbox. Nothing is sent.
2. **Cost rates change the label.** The Skipper adds the two missing cost rates at `/burn/settings/cost-rates`. The Portfolio Board card flips to **"Margin"** with 100 percent coverage, and the figure changes. The negative check: before the edit, the word "Margin" appears nowhere on the page.
3. **The change order becomes an amendment.** Approving the proposal creates "Howell Luau Change Order 1," the burn-down shows a **dated step up** in contract value, the original deliverables stay live, and the chain rollup reflects $21,200.
4. **The advisory gate teaches, and gets graded.** The Professor logs a $340 expense in Bill against the Luau project. It **posts** (advisory) with an inline note: "This would exceed the 'Menu and coconut catering plan' envelope by $185." The note carries **"Right call? Yes / No / I'd have mapped it."** The Skipper answers Yes; `advisory_feedback='right_call'` appears in the gate console.
5. **Earning the block.** The Skipper opens `/burn/gate`, sees all six preconditions with live standing ("210 of 200 decisions, 16 of 14 days, 12 of 10 labeled denies, precision 0.96, coverage 0.99"), steps through the mandatory review of the last 20 advisory denies, checks the acknowledgement, and promotes **`bill.expense` only**. The class chip flips; `bill.recurring` stays advisory.
6. **The block, and the four ways out.** Gilligan logs a $600 expense against the Luau project. It is **blocked**, showing "you would exceed this by $450" and **not** the contract value. He picks **Record absorbed cost**, is forced to type at least 20 characters, and the charge posts with `outcome='absorbed'` and the reason permanently attached.
7. **`needs_mapping` does not block.** Mary Ann logs an ambiguous $120 expense the classifier cannot place. It **posts** with a "map this charge" note and appears in the queue. The negative check: no block dialog appears and the expense exists in Bill.
8. **The wrong block, and the system's response.** An expense is blocked incorrectly. Mary Ann (a member) opens the override dialog and finds **no `gate_wrong` option**; she uses `mapped_manually`. The Skipper (admin) then labels the row `gate_wrong` from the gate console. A seeded fixture pushes rate, count, and distinct users past all three thresholds; `burn-calibration-recompute` runs; the console shows the auto-demotion banner naming the trigger and the contributing rows. The gate is back to advisory without anyone turning the feature off.
9. **The gate goes dark and is caught.** burn-api is stopped. Two expenses post normally (fail-open). On recovery the gate console shows "the gate was unavailable for 1 of the last 7 days" and coverage below 100 percent, and the variance inbox holds a `gate_outage` plus two `ungated_charge` findings naming the real expense rows.
10. **The silent deliverable.** The daily sweep raises `silent_deliverable` on the Coconut Supply Chain item due in eight days with zero attributed activity, at `high`.
11. **Permission boundary.** Gilligan (project member, not admin) opens `/burn/`, sees only his projects' chains, has **no** "All accounts" toggle and no cost-rate screen, and receives 403 on direct `GET /burn/api/v1/financials/accounts` and `GET /burn/api/v1/cost-rates`.
12. **Tuning visibly works.** A reclassification of "coconut radio" work is followed by a similar new task attributed correctly on the first pass, with `method='precedent'` in the detail pane. Creating a rule from the cluster then attributes the next one with `method='rule'` and no LLM call.
13. **Non-billable stops inflating the headline.** Marking the seeded retro block `non_billable/internal` drops the unscoped headline figure and the item leaves the queue without being mapped to any deliverable.

### 12.3 Integration harness

Add a Burn flow to `apps/integration-tests`: expense create in bill-api triggers a real precheck against a seeded chain, the verdict shapes the response, `expense.created` reaches bolt-api, the dispatch hook forwards to burn-api, the work item materializes, attribution runs, and the rollup changes. Plus three negatives: with `BURN_API_INTERNAL_URL` unset every expense posts normally and bill-api behaves exactly as today; with burn-api stopped the breaker opens and latency returns to baseline; and with the breaker open, coverage counters still increment.

### 12.4 Convention gates (round-1 B8)

The behavioral suite above is necessary and not sufficient. **All nine must pass before merge**, and any pre-existing failure they surface gets a task recorded rather than waved off, per CLAUDE.md's "pre-existing is not a dismissal" rule:

```sh
pnpm lint                      # Biome
pnpm lint:migrations           # lint.yml:46
pnpm typecheck
pnpm db:check                  # db-drift.yml:75 - fatal on an undeclared column (B3)
pnpm check:permission-catalog  # lint.yml:49
pnpm help:check                # lint.yml:55 (B1)
pnpm docs:catalog:check        # lint.yml:58 area
pnpm docs:manual:check         # lint.yml:58 (B1)
pnpm check:bolt-catalog        # NOT currently in any workflow; this build adds it (B4)
```

B1, B3, and B4 are all instances of this gap: each was a CI guard the round-1 spec relied on or tripped without naming.

---

## 13. Non-goals (explicit)

Burn is **not**:

1. **A time tracker.** It reads `time_entries`; it never asks anyone to log time and ships no timer.
2. **An invoicing engine.** Bill invoices. Burn drafts a line item as a proposal and a human posts it, through bill-api, under that human's own `bill.*` permissions.
3. **A contract repository or a DAM.** Bin holds bytes. Burn holds a reference.
4. **Bulwark.** No deadlines, no notices, no clause obligations, no timezone arithmetic. Section 1.4 makes this structural.
5. **A general ledger or an accounting system.** No chart of accounts, no journal entries, no tax, no revenue recognition. Burn reports contracted-versus-delivered, not GAAP.
6. **A performance-management or surveillance tool**, in a precisely bounded sense (2.4 point 3, narrowed from the round-1 wording). There is no per-person view, no utilization leaderboard, and no individual ranking; `actor_id`, `decided_by`, and `overridden_by` are floored to `burn.financials.read_all`; and **per-person dollars are not obtainable by any member-reachable query or join**, which is the property the test suite actually asserts. Per-person *hours* remain visible to project members because Bam already exposes them and Burn does not pretend otherwise.
7. **An autonomous actor with money authority.** It never sends, never posts, never charges. Its strongest autonomous act is declining to let something else post, bounded by all of Section 5, and it can never take that action because something broke.
8. **A resource planner or forecaster.** No capacity model, no staffing projection. Bearing owns goals; Bench owns analytics.
9. **A proposal or estimating tool.** Burn reads the contract that was signed. Bid evaluates responses pre-award; Burn is strictly post-signature.
10. **An OCR pipeline.** Image-only scanned contracts extract zero deliverables and are flagged for manual entry.
11. **A payroll or compensation system.** `burn_cost_rates` is an operator-entered figure used for one arithmetic purpose. Burn never computes pay, never syncs to payroll, and floors the table to owner/admin.

---

## 14. Reuse ledger

| Capability | Reuses (real file / package) | Genuinely new in Burn |
| --- | --- | --- |
| App scaffolding (Fastify, plugins, health, project scope) | `apps/bulwark-api/src/server.ts` (`healthCheckPlugin` at `:96`), `apps/bulwark-api/src/plugins/{auth,permissions,redis}.ts`, `apps/bulwark-api/src/lib/project-scope.ts`, `@bigbluebam/service-health` (`/health`, `/health/ready`, `/metrics` at `packages/service-health/src/index.ts:62,66,84`), `@bigbluebam/logging` | `burn-api` at 4022 |
| RLS request binding | `apps/api/src/boot/rls-boot.ts`, `BBB_RLS_ENFORCE`, `0116_rls_foundation.sql` | **a transaction- or connection-scoped GUC binding** rather than a copy of the four existing plugins, which do not bind (S9), plus a mandatory role-bound test |
| Document bytes | `@bigbluebam/storage` `getStream` (as `bin-transcode` / `bin-av-scan` do), `bin_assets` (`0205_bin_dam.sql`) | `can_access`-preflighted engagement assets, bounded and inert parsing (S7) |
| Document understanding | `apps/bulwark-api/src/services/extraction.service.ts` (pattern), `apps/bulwark-api/src/lib/internal-llm.client.ts` (ported), `apps/api/src/routes/internal-llm.routes.ts`, `llm_providers` | deliverable extraction with verified cites, deterministic `dedup_key`, human-confirmed envelopes |
| **Attribution classifier** | the internal llm-provider seam; Postgres FTS + `pg_trgm` (`0000_init.sql:22`) | **the two-stage bounded classifier, the rule engine, content-hash epochs, the confidence bands, the exemplar tuning loop, queue health. The genuinely new engineering.** |
| Vector retrieval (deferred) | `apps/beacon-api/src/lib/qdrant.ts`, `apps/braid-api/src/env.ts:29-31`, `braid-profiles.ts:46-47` | reserved columns plus a flag; **off by default because `embedding.service.ts:17` returns zero vectors** |
| Billing-rate resolution | `apps/bill-api/src/services/rate.service.ts:117` (`resolveRate`), used as `unit_price` at `invoice.service.ts:583` | **`POST /internal/rates/resolve`** so there is one implementation, plus a parity test |
| **Cost rates** | shape mirrors `bill_rates` (`bill-rates.ts`) | **`burn_cost_rates`, the primitive the platform lacks entirely (D1)** |
| Gate hook point | `apps/bill-api/src/routes/expenses.routes.ts:46,57`, `apps/worker/src/jobs/bill-recurring-generate.job.ts:367` | **the synchronous fail-open preHandler, the Redis circuit breaker, coverage counters, and two missing `bill` Bolt events** |
| Work plane | `tasks` (`apps/api/src/db/schema/tasks.ts`), `time_entries` (`time-entries.ts`), `phases`, `sprints` | normalization into `burn_work_items` with content-hash idempotency and delete detection |
| Client identity | `apps/bond-api` `bond_companies`, ported `apps/bulwark-api/src/lib/braid-resolve.client.ts`, `entity_links` (`0132_entity_links.sql`) | golden-id-anchored chain rollups |
| Visibility guardrail | `apps/api/src/services/visibility.service.ts` (`SUPPORTED_ENTITY_TYPES:107`, `isProjectMember:203` **not exported**, `preflightBoltRule:1131`), ported `can-access.client.ts` | `burn.engagement` / `burn.deliverable` types; the banded financial floor; the anti-join surveillance test |
| HITL inbox | `agent_proposals` (`0128_agent_proposals.sql:37,41`), `proposals.routes.ts:40,114-134`, `apps/bulwark-api/src/subscriptions/proposal-decided.ts`, `braid-proposal-reconcile.job.ts` | refs-only drafts; **approval executes as the decider under bill-api's own `requireCan`** |
| Durable event ingestion | `bulwark_ingest_events` (`0234_bulwark_core.sql:123-136`), `event-ingestion.routes.ts`, `apps/bulwark-api/src/services/gate.service.ts` (per-org Redis cache) | **claim/lease columns and a reaper**, which the Bulwark table lacks; a three-pass source reconcile |
| Bolt events + drift guard | `publishBoltEvent` (`packages/shared/src/bolt-events.ts:34-41`), `event-catalog.ts:2939,3025,3046`, `scripts/check-bolt-catalog.mjs` (`package.json:35`) | 10 `burn` events (no magnitudes) + 2 backfilled `bill` events + **wiring the guard into `lint.yml`** |
| Confirm-action | `apps/mcp-server/src/lib/confirm-token-store.ts` | tokens on delete, reject, and **gate weakening** |
| MCP registration and policy gate | `register-tool.ts` (kill switch + allowlist + `/v1/agent-policies/:id/check`), `dedupe-tools.ts:38` | 17 `burn_*` handlers |
| Permissions | `scripts/generate-permission-manifest.mjs:719,816`, `build-permission-codegen.mjs`, `check-permission-catalog.mjs`, `build-permission-delta.mjs`, `0238_bulwark_builtin_group_defaults.sql` | 20 `burn.*` rows + custom tiering |
| Worker locking, retry, DLQ, scheduling | **`apps/worker/src/jobs/bulwark-radar-sweep.job.ts`** (the real per-org advisory-lock precedent), `worker.ts:2207-2260`, `:673-679`, `bulwark-proposal-reconcile.job.ts:48` (worker-side deadline), `agent-webhook-dispatch.job.ts` | 9 `burn-*` job families + a claim reaper |
| High-churn partitioning | `0220_blip_entries_partitioned.sql` | `burn_work_items` / `burn_ingest_events` fast-follow |
| Frontend shell | `@bigbluebam/ui`, `@bigbluebam/bureau-client`, `@bigbluebam/permissions` `useCan`, `apps/bulwark/` structure, `packages/ui/launchpad.tsx:65,226` | 7 Burn screens, `flame` icon |
| Docs and CI guards | `scripts/docs/extract.mjs:42-65`, `scripts/docs/build-manual.mjs:78-91`, `scripts/docs/lib/tool-source.mjs:85`, `scripts/help/build-help-index.mjs:226`, `.github/workflows/lint.yml:46-58`, `db-drift.yml:75` | four doc-guard edits + `docs/apps/burn/help.md` |
| Deploy and nginx | `scripts/deploy/shared/services.mjs:298`, `gen-railway-configs.mjs`, `apps/frontend/Dockerfile`, `railway/env-vars.md` | one app id `burn`, port 4022 |
| Seed and screenshots | `scripts/seed-all.mjs:82-95,272`, `scripts/seed-gilligan/run-all.mjs:60-75`, `packages/docs-capture/src/environment.ts` | `seed-gilligan/burn.mjs` in a new trailing **Margin** group (no prior satellite-app precedent exists) |
| Shared schemas | `packages/shared/src/schemas/index.ts:18-20`, `packages/shared/src/index.ts:13-16` (the `node:crypto` subpath trap) | `schemas/burn.ts` + its re-export line, and `burn-precheck-key.ts` on a **subpath export** (B7) |

**On `packages/shared` (round-1 B7).** `packages/shared/src/schemas/index.ts` explicitly re-exports `./basis.js`, `./braid.js`, `./bulwark.js`; a new `burn.ts` is invisible without the matching `export * from './burn.js';` line. Separately, `packages/shared/src/index.ts:13-16` documents that `bulwark-arm-key.ts` is deliberately **not** re-exported because importing `node:crypto` drags it into the frontend bundle and breaks the rollup production build. The precheck idempotency-key HMAC that S2 now requires is exactly that kind of module: it lives in its own file exposed via a **subpath export** (`@bigbluebam/shared/burn-precheck-key`), never through `schemas/index.ts`.

---

## 15. Open questions and risks

1. **No working embedding provider in the tree (owner: platform).** `apps/beacon-api/src/services/embedding.service.ts:17` returns zero vectors; `apps/brief-api/src/services/embedding.service.ts` defers model selection to a worker that selects none. Burn ships **lexical retrieval** as the real path and Qdrant behind `embedding_enabled=false`. Decision: is a real embedding provider on the roadmap? Burn works without it (rules plus structural plus precedent signals dominate at 2-50 seat scale), but cold-start precision on a brand-new engagement is materially better with it.
2. **The gate requires bill-api changes owned outside this app.** A fail-open preHandler on four hook points, a circuit breaker, two new Bolt events, and `POST /internal/rates/resolve`. There is no way to gate money post-hoc, so this is not optional. Confirm the Bill maintainers accept an optional, fail-open, sub-second preHandler on the expense path.
3. **Envelope confirmation is real adoption friction, now unavoidable.** S7 removed the `stated`-price shortcut, so a 12-deliverable SOW needs 12 confirmations before the gate does anything. Recommendation, and the open question: offer a **"confirm all with even split"** fast path, but mark those `envelope_source='even_split'` and **exclude even-split envelopes from producing enforced denies** until individually edited. Confirm this is the right trade.
4. **`ungated_charge` coverage is honest but incomplete.** Retroactively logged hours and charges entered outside the four gated paths are caught post-hoc, not intercepted. The spec claims interception only for those four hooks. Confirm this is acceptable positioning against the marketing claim.
5. **Non-priced signals.** Banter threads and commit titles improve target selection and contribute zero dollars. Confirm this is right (recommendation: it is; pricing chat time produces numbers a customer cannot defend).
6. **Multi-currency chains.** One currency per chain; mismatches flagged and excluded rather than converted. FX conversion needs a rate source the platform does not have.
7. **`burn_work_items` volume.** A 50-seat firm could produce low six figures of rows per year. Retention plus the `0220_blip_entries_partitioned.sql` monthly-partition pattern is the answer; v1 ships unpartitioned. Confirm the trigger threshold.
8. **Platform-level LLM concurrency cap, named as a prerequisite (round-1 I5).** `attribution_llm_daily_cap` bounds one tenant's spend and bounds nothing about contention on the shared `POST /internal/llm/chat` route that Beacon, Brief, Braid, and Bulwark also use. Burn is the first genuinely high-volume consumer and therefore the forcing function. Decision needed on whether the cap lands before Burn ships or Burn ships with `BURN_ATTRIBUTE_CONCURRENCY` as the only throttle. Per-org LLM cost accounting also does not exist today and Burn would be the first app to need it.
9. **Bulwark cross-read.** Burn could read `bulwark_obligations` on the same `bin_asset_id` to enrich deliverables with payment and retention terms. Deliberately not in v1 to keep the tables disjoint. Fast-follow.
10. **`search_everything` provider.** Deferred, matching Braid and Bulwark.
11. **The residual product risk, stated plainly.** Even with every mechanism in Section 5, an org that promotes to blocking and then hits a run of `needs_mapping` verdicts on legitimately new work will feel friction, though those no longer stop money. The unmitigated case is an org whose work genuinely does not decompose against its own contracts, and the honest answer is that **advisory is the product for them and blocking is not**. Per D8(c) the gate console says exactly that rather than nagging them toward promotion.
12. **Pre-existing platform defects Burn depends on and does not fix.** Both are tracked separately as tasks; Burn states the dependency and works around it: (a) the **RLS GUC does not bind** in any of the four existing plugins (S9), so Burn implements its own request binding and makes the role-bound test mandatory; (b) **`/internal/llm/chat` resolves a provider with no org predicate** (`internal-llm.routes.ts:117-126`), so Burn validates `llm_provider_id` org ownership on write. Also tracked separately and referenced rather than assumed: `check:bolt-catalog` is absent from CI (this build adds it), CLAUDE.md documents a `/readyz` that does not exist, and the three nginx configs have already drifted on the static-asset alternation.
13. **`time_entries` has no `updated_at`.** Edits to entries older than `reconcile_window_days` are undetectable. Adding the column is a platform dependency, not a Burn change; until then the limitation is stated in 2.3.2 and tested for explicitly.
14. **No human-provided secret required.** Every dependency is internal. The only new env are internal service URLs, `BURN_PRECHECK_TIMEOUT_MS`, `BURN_ATTRIBUTE_CONCURRENCY`, and the reused `INTERNAL_SERVICE_SECRET`. `QDRANT_URL` is optional and unused by default.

---

## Changelog

### Round 1 (10 blockers, 26 majors, 8 minors)

Every finding was verified against the monorepo before folding; every cited line reference in the review held. **43 of 44 findings accepted or accepted-with-modification. One partial rejection**, argued below at S3.

**Design**
- `[design] D1 ACCEPT (BLOCKER, hybrid of both options)` - `bill_rates` is the client rate (`invoice.service.ts:583` -> `unit_price`) and no cost rate exists anywhere. Added **`burn_cost_rates`** as a Burn-owned primitive with its own screen and permissions, **and** shipped option (a)'s honesty: absent cost rates the product says "contract consumption" everywhere, never "margin", with a `metric_basis` discriminator on every response, a coverage percentage, and no code path that prints the wrong word. Renamed permissions to `burn.financials.*`, routes to `/v1/financials`, the variance to `consumption_erosion`, and the screen to Portfolio Board. Kept the MCP tool name `burn_margin` because the winning submission named it and agents will reach for it; the discriminated response makes it unable to mislabel. Sections 1.2, 3.1, 7.1, 7.6, 12.1. (from review round 1)
- `[design] D2 ACCEPT (BLOCKER)` - the spec's stated precedence and exclusive `effective_to` were both wrong against `rate.service.ts:117`, and its own test asserted the error. Removed the restatement entirely; added `POST /internal/rates/resolve` to bill-api and a parity test. Sections 2.3.1, 5.2, 9.2, 12.1. (from review round 1)
- `[design] D3 ACCEPT (BLOCKER)` - split `amends_engagement_id` + `contract_value_delta` from `supersedes_engagement_id`, added `chain_root_id`, made the chain the unit for envelope math, rollups, financials, and the gate, and specified restatement attribution migration by `dedup_key` with unmatched rows surfacing as `pending_review/restatement_unmatched`. Sections 3.1, 4.5, 12.1, 12.2. (from review round 1)
- `[design] D4 ACCEPT (MAJOR)` - added `burn_engagement_projects` many-to-many with `ON DELETE CASCADE`; the structural signal now returns all chain-linked engagements and the candidate set disambiguates across them; the zero-project state is defined, `read_all`-only, flagged, and gate-incapable. Corrected the stale `isProjectMember` cite to `:203` and stated plainly that Burn **ports** it. Sections 2.3.4, 2.4, 3.1, 12.1. (from review round 1)
- `[design] D5 ACCEPT (MAJOR)` - added `excluded_non_billable` with typed reasons, `burn_attribution_rules` evaluated before any LLM call, queue clustering, a queue-health surface naming the dollars excluded from every envelope, and auto-demotion of stale `pending_review` so hidden dollars re-enter the total. Sections 2.3.3, 2.3.7, 2.3.8, 3.1, 7.2. (from review round 1)
- `[design] D6 ACCEPT (MAJOR, folded with T2/T3)` - see T2/T3. Added the bounded anti-join delete pass, `exclusion_reason`, dollar reversal in-transaction, and a `phantom_consumption` guard. Section 2.3.2. (from review round 1)
- `[design] D7 ACCEPT (MAJOR, option a per the coordinator's steer)` - `needs_mapping` is **non-blocking in v1**, making 2.1's invariant literally true. Added it to 5.7's actions and added `mapped_and_posted` to the outcome state machine. Chose (a) over (b) because the session's dominant criticism, raised independently by three seats, was precisely that a wrong block kills the feature, and (b) would have kept a low-confidence path to a stopped write. Sections 2.1, 5.3, 5.6, 5.7. (from review round 1)
- `[design] D8 ACCEPT (MAJOR)` - added the advisory-mode verdict-feedback control (`right_call` / `wrong_call` / `would_have_mapped`) on both the console and bill-api's inline note, writing `advisory_feedback` on non-enforced rows; that is now the precision sample. Made the volume floor scale-aware (lesser of 200 decisions or 60 days) with a `min_labeled_denies` floor of 10, and moved "advisory is a complete product" into the console copy. Sections 3.1, 5.4, 7.4, 12.1. (from review round 1)
- `[design] D9 ACCEPT (MINOR)` - the outcome route moved to `POST /v1/internal/prechecks/:id/outcome` under `INTERNAL_SERVICE_SECRET`; on the fail-open path bill-api stamps the created expense with a `burn_gate: 'unavailable'` marker so recovery raises `ungated_charge` against real rows, closing the loop that was open exactly when it mattered most. Sections 6.1, 5.5.2. (from review round 1)

**Security**
- `[security] S1 ACCEPT (BLOCKER)` - `POST /v1/precheck` is project-scoped through the shared guard, and the numeric block is floored: non-`read_all` callers get `overage_amount` and a band, never absolutes. Sections 2.4(5), 5.7, 6.1, 12.1. (from review round 1)
- `[security] S2 ACCEPT (BLOCKER, folded with T9)` - server-derived HMAC key, `svc:`/`usr:` namespacing enforced by `CHECK`, re-validation of amount/currency/ref-type on hit, plus T9's `valid_until`. The banked-verdict attack is now a named test. Sections 2.4(6), 3.1, 12.1. (from review round 1)
- `[security] S3 ACCEPT WITH MODIFICATION (BLOCKER); one sub-option REJECTED` - split the label from the override: new owner/admin-floored `burn.precheck.mark_wrong` owns `gate_wrong`/`wrong_call`; benign codes stay member-level. Added absolute-count and distinct-user floors to demotion, moved the outcome route internal, and added audited admin notification. **Rejected the alternative of raising `burn.precheck.override` wholesale above the member floor**: a member who hits a block must be able to proceed, and requiring an admin for every override recreates exactly the friction that gets the feature switched off permanently, which is the risk the whole design exists to avoid. Sections 2.4(7), 5.6, 11.2. (from review round 1)
- `[security] S4 ACCEPT (MAJOR)` - no floored quantity is emitted twice in different units; non-`read_all` callers get coarse bands; `/v1/prechecks` and `/v1/change-orders/:id` are project-scoped and stripped; added the "cannot recover `contract_value` to within 5 percent" test. Sections 2.4(2), 6.1, 12.1. (from review round 1)
- `[security] S5 ACCEPT (MAJOR)` - removed `amount` and `margin_pct` from every Bolt payload; refs plus coarse bands only; `burn.*` webhook subscriptions require org-admin authorship. Correct: with `preflightBoltRule` gating on org match alone, the magnitude is the secret. Sections 2.4(13), 8.2, 12.1. (from review round 1)
- `[security] S6 ACCEPT WITH MODIFICATION (MAJOR)` - the diagnosis is right and both proposed fixes are worse than the defect: an opaque `source_id` breaks the deep link that is the queue's evidentiary value, and an owner/admin floor on `/v1/work-items` removes the project lead's own-job view that the product requires. Instead **`billable_amount` and `cost_amount` are omitted for `bam.*` sources for non-`read_all` callers**, so the join yields per-person hours (already visible in Bam) and never per-person dollars (the new disclosure); snapshots are PII-redacted; `decided_by`/`overridden_by` are floored. Kept the finding's strongest demand: the test **attempts the join**. Narrowed Section 13's non-goal to exactly what is enforced. Sections 2.4(3), 6.1, 12.1, 13. (from review round 1)
- `[security] S7 ACCEPT (MAJOR)` - deleted the "non-" from step 7: **every** envelope including `stated` requires human confirmation before `is_active`, with the verified quote shown beside the extracted number. Added `MAX_DOC_BYTES`, `MAX_DOC_PAGES`, a parse wall-clock cap, and JavaScript / external-entity resolution disabled. Sections 2.4(9), 4.1, 12.1. (from review round 1)
- `[security] S8 ACCEPT (MAJOR)` - (a) change-order approval calls bill-api **as the decider with the decider's credentials** so bill-api's own `requireCan` is the authority; both permissions must hold. (b) `llm_provider_id` org ownership validated on write regardless of the platform route. Sections 2.4(11), 2.4(12), 4.5, 12.1. (from review round 1)
- `[security] S9 ACCEPT (MAJOR, as a stated dependency per the coordinator)` - Burn does **not** copy the broken plugin; it binds the GUC in a transaction or on a request-scoped connection, and the role-bound RLS test is **mandatory, not optional**, asserting zero cross-org rows with the app-level predicate removed. The platform-wide defect in the four existing plugins is tracked separately and named in Open Question 12; Burn does not attempt to fix it here. Sections 2.4(14), 12.1, 15. (from review round 1)
- `[security] S10 ACCEPT (MINOR)` - added `burn.variance.write` and `burn.precheck.read` (20 permissions, not 15) and **inverted the confirm boundary**: the token is now required when `burn_set_gate_mode` weakens enforcement (`off`, `advisory`, pause), not when it promotes, since promotion is already server-gated by 5.4. Sections 6.1, 11.1, 11.2. (from review round 1)

**Stability**
- `[stability] T1 ACCEPT (BLOCKER)` - added `burn_engagement_rollups` at chain grain with `UNIQUE (organization_id, chain_root_id)`, snapshot columns, and `computed_at`. Refresh is one idempotent upsert statement. `/v1/financials` serves `as_of`, computes a missing chain synchronously, serves a stale one flagged, and **never** falls back to an unbounded live aggregate. Sections 3.1, 8.1, 12.1. (from review round 1)
- `[stability] T2 ACCEPT (BLOCKER, folded with T3/D6)` - epochs are **content hashes over cost-and-classification-relevant fields only**; `updated_at` is never an epoch input for any source; an epoch match short-circuits before candidate assembly and before any LLM call; added `exclusion_reason`. Section 2.3.2, 12.1. (from review round 1)
- `[stability] T3 ACCEPT (BLOCKER, folded with T2/D6)` - named `created_at` as the sole watermark with a persisted per-source high-water mark, added the bounded recency re-read that makes edits detectable **without** `time_entries.updated_at`, and specified the index path through `burn_engagement_projects -> tasks -> time_entries` using only existing indexes so no org-wide scan is needed. Stated the out-of-window edit limitation plainly and listed the platform dependency (Open Question 13). Sections 2.3.2, 12.1, 15. (from review round 1)
- `[stability] T4 ACCEPT (MAJOR, folded with I2)` - the authoritative timeout is bill-api's `BURN_PRECHECK_TIMEOUT_MS`; `precheck_budget_ms` is advisory, display-only, and `CHECK`-clamped to [100,750]. Added a Redis circuit breaker on the `gate.service.ts` shape, and the recurring-generate loop checks it once per job. Sections 5.5.1, 9.2. (from review round 1)
- `[stability] T5 ACCEPT (MAJOR, folded with I1)` - deleted the impossible "written asynchronously" claim. Added bill-api-side Redis counters, the `BURN_GATE_UNAVAILABLE` log code, `/metrics` exposure, a coverage figure on the console, a `gate_outage` variance raised on recovery, a `gate.coverage_degraded` event, and **coverage-driven auto-demotion**. Sections 5.5.2, 8.1, 8.2, 12.1. (from review round 1)
- `[stability] T6 ACCEPT (MAJOR)` - added `claimed_by`/`claimed_at` to `burn_ingest_events` (which `bulwark_ingest_events` lacks, verified at `0234:123-136`), claim-not-select drain, a stale-claim reaper, `concurrency: 1` plus per-org locks on the drain, rollup, and silent sweep, and a named BullMQ limiter. Sections 3.1, 4.2, 8.1. (from review round 1)
- `[stability] T7 ACCEPT (MAJOR)` - the `bond-stale-deals.job.ts:127-138` citation was wrong (that range is a comment about the rotting marker, no lock anywhere in the file). Replaced with `bulwark-radar-sweep.job.ts`, specified per-org lock keys with a TTL, and added the flushed per-N-orgs / per-N-items progress-logging cadence CLAUDE.md requires. Sections 4.3, 8.1. (from review round 1)
- `[stability] T8 ACCEPT (MAJOR)` - stated the human-precedence invariant explicitly, specified supersede-then-insert in one transaction under `FOR UPDATE` with 409-plus-current-state on a stale check, and defined `POST /v1/attributions/bulk` as per-item results. Sections 2.3.10, 6.1, 12.1. (from review round 1)
- `[stability] T9 ACCEPT (MAJOR, folded with S2)` - bill-api mints a request-scoped key stable across that attempt's retries and echoes it; added `valid_until` with recompute-and-supersede past it; a fresh key is required when amount or project changes. Sections 2.4(6), 3.1, 5.5, 12.1. (from review round 1)
- `[stability] T10 ACCEPT (MINOR)` - both `search_tsv` columns are now specified as `to_tsvector('english', coalesce(...) || ' ' || coalesce(...))` with the regconfig named, since a bare concatenation over nullable columns yields NULL and would gut recall on the shipped path. Section 3.1, 3.4. (from review round 1)
- `[stability] T11 ACCEPT (MINOR)` - retention exempts work items whose chain is not `closed`, and the rollup row is the immutable historical record served with `as_of` after purge. ws frames declared advisory-only with refetch-on-reconnect and the membership predicate served from the cached `PermissionContext`. Sections 6.2, 8.1. (from review round 1)

**Best practices**
- `[best-practices] B1 ACCEPT (BLOCKER)` - added all four required edits: the `APP_REGISTRY` entry at `extract.mjs:63`, `docs/apps/burn/help.md` plus `pnpm help:index`, `pnpm docs:manual` with the committed regeneration, and the existing `docs:catalog` commitment. Section 9.6.1. (from review round 1)
- `[best-practices] B2 ACCEPT (MAJOR, folded with I3)` - replaced `/readyz` with `/health` and `/health/ready` throughout, named the `healthCheckPlugin` registration shape, and kept the compose healthcheck on `/health`. Sections 6.1, 9.1, 9.6. (from review round 1)
- `[best-practices] B3 ACCEPT (MAJOR)` - added `agent-proposals.ts` and `entity-links.ts` to the Drizzle module list, stated that the generated tsvector and reserved qdrant columns must be declared, and added `db:check` and `lint:migrations` to the verification list. `db-check.mjs:454/486` exits 1 on an undeclared column, so this was a CI-fatal omission. Sections 3, 3.2, 12.4. (from review round 1)
- `[best-practices] B4 ACCEPT (MAJOR)` - `check:bolt-catalog` exists at `package.json:35` but is in no workflow. Changed the claim: the guard is run manually **and added to `.github/workflows/lint.yml`** as part of this build, framed as a platform gap Burn closes. Sections 8.2, 12.4. (from review round 1)
- `[best-practices] B5 ACCEPT (MINOR)` - reworded to permit exactly the one sanctioned `docs.tsx` edit (a `Flame` entry in `APP_ICON` and an orange `APP_COLOR` pairing, matching the bulwark rows at `:73`/`:98`), correcting the round-1 draft's over-broad prohibition. Section 9.6.1. (from review round 1)
- `[best-practices] B6 ACCEPT (MINOR)` - named both registration sites by file and line (`seed-all.mjs:82-95` flat array; `run-all.mjs:60-75` grouped objects) and specified a new trailing `{ name: 'Margin', files: ['burn.mjs'] }` group after both the Billing and Knowledge groups. **Dropped the false Bulwark seeding-precedent claim**: no `bulwark.mjs` or `braid.mjs` exists in `scripts/seed-gilligan/`. Section 10. (from review round 1)
- `[best-practices] B7 ACCEPT (MINOR)` - stated the `export * from './burn.js';` line in `schemas/index.ts` and required the S2 HMAC module to ship on its own subpath export, never through the browser-facing barrel, per the `bulwark-arm-key.ts` note at `packages/shared/src/index.ts:13-16`. Section 14. (from review round 1)
- `[best-practices] B8 ACCEPT (MINOR)` - added Section 12.4 listing all nine convention gates with their workflow lines, and the rule that a pre-existing failure gets a recorded task rather than a wave-off. (from review round 1)

**Infrastructure**
- `[infrastructure] I1 ACCEPT (MAJOR, folded with T5)` - see T5, plus the recovery path: `burn-variance-sweep` reads the surviving Redis counters and raises `gate_outage` covering the window, and the console shows unavailability days next to the demotion banner. Sections 5.5.2, 4.3. (from review round 1)
- `[infrastructure] I2 ACCEPT (MAJOR, folded with T4)` - see T4, plus `BURN_PRECHECK_TIMEOUT_MS` added to the bill-api compose env and `bill-api.env.optional`, and the DB value `CHECK`-clamped strictly below the client default. Sections 5.5.1, 9.2. (from review round 1)
- `[infrastructure] I3 ACCEPT (MAJOR, folded with B2)` - `healthcheck: '/health'` in the services.mjs block (matching `:298`) and `curl -sf .../health` in compose, with the frontend `depends_on` consequence spelled out. Sections 9.1, 9.6. (from review round 1)
- `[infrastructure] I4 ACCEPT (MAJOR)` - added Section 9.8, an explicit ordered rollout with `docker compose run --rm migrate`, the two verification probes, the build-and-recreate step, the permission-delta immutability rule, and the Railway build-order caveat. (from review round 1)
- `[infrastructure] I5 ACCEPT (MAJOR)` - added Section 9.7: burn-api replica count and pool size, burn-api named as the LLM-holding process with worker-side deadlines distinct from `LLM_TIMEOUT_MS`, a `BURN_ATTRIBUTE_CONCURRENCY` knob, two concrete worker-split triggers, and the platform LLM concurrency cap named as a **prerequisite** in Open Question 8. (from review round 1)
- `[infrastructure] I6 ACCEPT (MINOR)` - `burn` goes into the alternation in **both** source files; recorded the verified pre-existing `bill` (present in `nginx.conf:728`, absent in `nginx-with-site.conf:806` and `nginx.railway.conf:942`) and `bay`/`blip` drift as a tracked task rather than silently preserving or unilaterally reconciling it. Section 9.5. (from review round 1)
- `[infrastructure] I7 ACCEPT (MINOR)` - added the Railway variable set for `burn-api` and the new `frontend` variables, plus `railway/env-vars.md` regeneration, to the Section 9.6 checklist. (from review round 1)

**Verified-and-held claims from round 1, left untouched:** port 4022 free; migration numbering correct against the on-disk tip; route collisions none; the positional `publishBoltEvent` usage; `pg_trgm` already installed; the `burn.*` agent-policy glob; and the deterministic-plane invariant construction, which round 1 found sound and D7 has now made airtight.

### New open questions created by this rework

- **Open Question 3** is new: S7's removal of the `stated`-price shortcut makes envelope confirmation unavoidable, which is real adoption friction on a 12-deliverable SOW. The proposed "confirm all with even split" fast path, with even-split envelopes barred from producing enforced denies, needs a human decision.
- **Open Question 8** is escalated from a fast-follow to a **prerequisite**: the platform LLM concurrency cap.
- **Open Question 13** is new: `time_entries` has no `updated_at`, so out-of-window edits are undetectable. Stated and tested rather than assumed away.





