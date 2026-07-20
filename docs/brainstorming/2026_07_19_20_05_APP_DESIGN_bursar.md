# Bursar - App Design Specification

**Session:** 2026_07_19_20_05
**Winner:** Bursar (4.80 mean, 24 raw total), co-authored by Seat B (data/intelligence lens)
and Seat D (vertical wedge lens). Seat E withdrew its competing Ballast entry in Bursar's
favor and contributed two detectors by name.
**App id:** `bursar` | **API:** `bursar-api` internal `:4023` | **SPA:** `/bursar/`
**Status:** design, post-adversarial-round-2. See Changelog (§25).

> **Counting rule, adopted in round 2.** Three separate count contradictions survived a full
> rewrite, which is a process failure, not arithmetic. From here: **no section states a count in
> prose.** Permissions are counted by the §17.3 probe against the §13.1 table. Tables are
> enumerated by a generated RLS loop over the `bursar_` prefix (§17.1). Bolt events, MCP tools,
> and nginx files are single enumerated tables that other sections reference by name, never by
> number.

---

## Table of contents

1. Overview and positioning
2. The category boundary, defended
3. AI-native design: the absence-detection engine
4. The coverage-collapse cluster: blanket claims, fan-out, rollup, ruler capture
5. Adversarial input: injection and malicious documents
6. Data model
7. The frozen baseline and post-award drift
8. The detector catalog
9. `bursar_scope_gap` as a read-only advisory tool
10. Comparable totals
11. API surface
12. MCP surface
13. Permissions
14. Frontend, including the help system
15. Background work
16. Events and integration
17. Migration plan
18. Infrastructure
19. Seed data (GILLIGAN)
20. Test plan
21. Milestones M0..M9
22. Reuse ledger
23. Non-goals (explicit)
24. v1.1 and beyond: what was cut, and why
25. Open questions and risks
26. Changelog

---

## 1. Overview and positioning

### 1.1 One-liner

One canonical record per vendor and per scope, so you can see what each bidder quietly left
out before you sign, and exactly what you got billed for that nobody agreed to after.

### 1.2 The spine

```
bursar_vendors ──┬── bursar_requests ── bursar_scope_nodes        [the ruler]
                 ├── bursar_offers ──── bursar_offer_lines        [the raw]
                 │        ├─────────── bursar_offer_coverage      [the verdict]
                 │        └─────────── bursar_offer_totals        [the comparable]
                 ├── bursar_awards ──── bursar_baseline_items     [the freeze]
                 ├── bursar_spend_events                          [the reality]
                 └── bursar_mismatches                            [the output]
```

### 1.3 The two halves

**Pre-award (the flagship).** Derive a canonical scope tree from the buyer's own request,
normalize every incompatible inbound offer onto it, and produce **the exclusion diff**: scope
items present in your request, or in a rival offer, but ABSENT from this one, each cited to the
source line that should have covered it.

**This is absence detection, not summarization.** A model that summarizes what IS in a document
is a commodity. A model that reliably reports what SHOULD be there and is not has to enumerate
a candidate space, prove non-coverage per candidate, resist a counterparty actively trying to
collapse the diff (§4, §5), and survive its own false-positive rate.

**Award** freezes the accepted tree as an immutable baseline, recording both what you got and
**what you knowingly did not get**.

**Post-purchase.** The same spine drives the mismatch set (§8).

### 1.4 Where the data actually comes from

The pre-award half runs on uploaded documents and works on day one.

**The post-award half is fed predominantly by CSV statement import, not by platform events.**
Verified: `bill_expenses` has no funding-source field, there is no AP ledger anywhere in the
platform, and `bill_invoices`/`bill_payments` are **money-in** (`bill-invoices.ts:23 client_id`;
`bill-payments.ts invoice_id NOT NULL`). So `expense.submitted`/`expense.approved` are ingested
where they exist, and everything else arrives through `POST /v1/spend/import`. The onboarding
flow is "upload last year's statement", not "connect your ledger".

### 1.5 Cadence: episodic, not daily

A buyer runs a procurement a few times a year and reviews spend monthly. The retention
mechanism is a **weekly digest** (§15), not a dashboard nobody opens.

---

## 2. The category boundary, defended

| App | Counterparty role | Document state | Ledger row exists? |
| --- | --- | --- | --- |
| **Bill** | Customer pays *us* | invoice we issue | yes, we wrote it |
| **Burn** | Customer pays *us* | signed SOW | yes, `burn_work_items` |
| **Bulwark** | Counterparty signed *with us* | executed contract | yes, clause-derived obligations |
| **Bursar** | **We pay the vendor** | **unsigned offers from non-counterparties** | **no - nobody has one** |

1. **Pre-counterparty.** Bulwark extracts obligations from an *executed* contract. Bursar
   operates on offers from parties who have signed nothing and therefore produce no clause, no
   obligation, and no ledger row anyone else can read. The exclusion diff cannot be a Bulwark
   feature: there is nothing to extract an obligation *from* yet, and the interesting content is
   what the document does not say.
2. **Absence versus presence.** Burn and Bulwark answer "what does this commit us to." Bursar
   answers "what does this conspicuously fail to commit them to, given a ruler derived from a
   different document."

**The enforceable boundary is the table list in §6**, not a claim about rows: Bursar defines no
obligation table, no notice-deadline table, no work-item or attribution table, and no invoice
table, and writes zero rows in Bill, Burn, or Bulwark. **The Bulwark handoff is an
`entity_links` row plus a deep link.**

---

## 3. AI-native design: the absence-detection engine

### 3.0 The design thesis

Asking a model to enumerate absences is asking it to search an unbounded space with no
grounding. Bursar inverts the question: **enumerate the candidate space deterministically** (the
scope tree), then ask a **bounded, per-node, closed-book question** with the offer's lines in
front of the model as typed data - *"Here is requirement R and here are the lines of this offer.
Does any of them cover R? Answer by `offer_line_id`."*

- The model can only be wrong about nodes we already enumerated, and enumeration is auditable.
- A wrong `covered` is catchable by three verification predicates (§3.5).
- A wrong `absent` is a coverage-of-input failure, measurable against a fixture corpus (§20.2).
- Answers are constrained to an id space the engine controls.

### 3.1 One classification mode: full offer, all strengths

**v1 has no retrieval layer at all.** Round 1 removed the vector channel (no embedding provider
exists: `brief-embed.job.ts` and `beacon-vector-sync.job.ts:123` both write zero vectors, and
`internal-llm.routes.ts` exposes only chat). Round 2 removes the surviving lexical/structural
retrieval mode for the long tail, because it could never produce a publishable verdict: with
vector gone it had **one** applicable channel, so it could not clear the two-channel bar, and
`medium` is excluded from every headline figure. It cost a trigram index on an unbounded column
and a CI recall gate to produce nothing anyone would see.

So: **every node of every strength is classified in full-offer mode.** The complete line set is
passed as a typed `{offer_line_id, raw_text}` array. There is no retrieval, therefore no
retrieval-recall failure mode, no `applicable_channels` arithmetic, and no divide-by-zero in the
confidence formula.

Deleted with it: the `raw_text` trigram index, the recall CI gate, the `classification_mode`
column, and the retrieval branch of M5. (Trigram indexes remain where they earn their keep:
`bursar_payee_aliases.normalized_payee` and `bursar_baseline_items.title`.)

**Token math.** A 300-line offer at ~25 tokens/line is ~7,500 tokens of line data; plus nodes,
instructions, and response schema, ~8,500 tokens per call. Batching 6 nodes against one shared
line array amortizes the payload, so 40 nodes over a 300-line offer is ~7 calls. §3.9 bounds the
worst case.

**Sliding windows** apply to documents beyond `max_lines_per_window` (default 250, overlap 50).
Their merge rule is §3.8, which is load-bearing and was missing.

### 3.2 Stage 0 - Canonical scope-tree derivation (the ruler)

Sources in strict precedence:

| Precedence | `derived_from` | Source | Default `normative_strength` |
| --- | --- | --- | --- |
| 1 | `request` | the buyer's RFQ/RFP/SOW (a Bin asset) | `mandatory` |
| 2 | `library` | `bursar_scope_library` category template | `should_have` |
| 3 | `rival_offer` | union-of-rivals (§4.5) | `nice_to_have`, **and never auto-published** |
| 4 | `human` | hand-added or edited | as set |

Source 1 runs the checkpointed chunk loop ported from
`apps/burn-api/src/services/engines/extraction.engine.ts:103-173`, with **three fixes to the
port, not carried forward**:

**(a) Chunk-relative ordinal.** The burn original declares `let ordinal = 0` before the loop
while `startChunk` skips ahead on resume, so a crash-resumed run produces different `dedup_key`
values and **duplicates rows** - in Bursar, a duplicated matrix row across every offer. Bursar's
ordinal is `${chunkIndex}:${indexWithinChunk}`; `test/dedup-key.resume.test.ts` asserts
byte-equality across a simulated crash.

**(b) A dropped chunk can no longer report success.** The original does
`log.debug(...); continue` on `LlmError` and still finishes `succeeded`. A scope tree missing an
entire chunk would be presented as `derived`, a human would confirm it, and **every offer would
then come back clean on requirements that were never enumerated** - invisible to the
false-absence gate, because the node does not exist. Bursar counts `chunks_failed`, lands the
run `partial`, **blocks `scope_status` from reaching `derived`**, and surfaces "we could not read
N sections of this document" with the chunk ranges.

**(c) Per-chunk-line span verification** rather than whole-document (§5.5).

**The tree must be human-confirmed before verdicts are publishable.** `scope_status` goes
`derived` -> `confirmed`; an unconfirmed tree yields `provisional` verdicts and no Bolt event.
An injection-suspected request cannot reach `confirmed` until flagged spans are cleared (§5.5).

### 3.3 Stage 1 - Offer parse into lines (deterministic, no LLM)

Worker `bursar-parse-offer` owns the byte path, reading through `getObjectBuffer`
(`apps/worker/src/utils/storage.ts`, which wraps `@bigbluebam/storage`; it is **not** itself a
storage export).

| Format | Path |
| --- | --- |
| plain text / email body | UTF-8 decode |
| PDF with a text layer | `Tj`/`TJ` show-operator extraction (`burn-extract-deliverables.job.ts:30-43`) |
| CSV / TSV / JSONL / XLSX-exported | `@bigbluebam/structured-data` codecs |
| scanned image PDF | **no OCR in v1** -> `unparseable`, never levelled |

**Parse quality** (`parse_quality`, 0.0-1.0) is computed per format from extracted characters per
page, ratio of structured lines, and currency/quantity token presence. Below
`parse_quality_floor` (default 0.35) the offer is `unparseable`, and **an offer below the floor
can never produce an `absent` verdict** - "we could not read it" is not evidence of omission.

Lines carry `raw_text` (bounded 4,000 chars), `char_start`/`char_end`, `page`, `ordinal`, parsed
`quantity`/`unit`/`unit_price_minor`/`extended_minor`, and `line_role`
(`base`/`option`/`alternate`/`allowance`/`note`) where **only `base` counts toward coverage and
totals**.

Progress logging before the byte read, before the parse, before the leveling handoff.

### 3.4 Stage 2 - Classification

**Deterministic pre-pass (no LLM), whole-document:**

- **Explicit-exclusion lexicon** (`excludes`, `not included`, `out of scope`,
  `customer-provided`, `by others`, `at additional cost`, `T&M at prevailing rates`, …). This is
  the highest-value verdict class - the thing the vendor *told* you and you did not read. Hits
  are recorded per line and **pinned into every window** (§3.8).
- **Blanket-claim lexicon** (§4.2) - new in round 2.
- **Exact structural match** on quantity + unit.
- **No zero-candidate short-circuit.** Removed in round 1 and it stays removed.

**LLM classification** goes through the internal proxy as
`apps/burn-api/src/lib/llm-client.ts:59-102` does, with `X-Internal-Service: bursar` for its own
token bucket.

| Failure | Handling |
| --- | --- |
| `LlmThrottledError` (429) | **defer.** Run `partial` at checkpoint; BullMQ retries and resumes. Never a default verdict. |
| `LlmError` | node lands `ambiguous`/`pending_review`, never `absent` |
| `LlmMalformedError` | truncated/unparseable JSON, or `finish_reason === 'length'` (§3.9 makes this buildable). **Retry at a smaller batch, capped at 2 retries, then land `ambiguous`** - the round-1 spec had no terminal rule |
| **Node missing from a batch response** | **`ambiguous`, retried individually. Never `absent`.** |
| **No LLM provider configured** | the run **fails loudly** with `status='blocked'` and a settings deep link. Round 1 would have produced a silent all-`ambiguous` result indistinguishable from a hard document |

**The six verdicts:**

| Verdict | Evidence required to persist |
| --- | --- |
| `covered` | >=1 `offer_line_id` + span verifying against that line + node-term overlap (§3.5) |
| `partial` | citation + typed delta fields (§3.7) |
| `excluded_explicit` | citation of the exclusion language itself |
| `absent` | **the rejected near-miss set**, non-empty, by `offer_line_id` |
| `ambiguous` | the candidate ids |
| `not_applicable` | none |

### 3.5 Stage 3 - Three verification predicates

Round 1 had two. Round 2 adds the third, because **two were not enough to bind coverage to the
requirement** (§4.1).

**(1) Span verifies against the cited line, not the document.** The model answers with an
`offer_line_id`; the engine verifies the quoted span is a substring of **that row's `raw_text`**.
Round 1 replaced burn's whole-document `verifyCite` with this, and it defeats
instruction-shaped injection.

**(2) Rejected-candidate requirement for `absent`.** Non-empty, by `offer_line_id`, each id
validated as belonging to this offer. An `absent` with an empty rejected set while candidates
existed is downgraded to `ambiguous`. A classifier that cannot articulate why nothing counts did
not do the work.

**(3) Node-term overlap (new).** The cited line must share minimum lexical overlap with the
node's distinctive terms (title tokens minus stopwords, plus `unit` and `quantity` where
present). Below `node_term_overlap_floor` (default 0.25 Jaccard over stemmed tokens) the verdict
demotes to `ambiguous`.

**Honest limitation, stated because a reviewer will test it.** Predicate 3 is **not** the defense
against the blanket-coverage attack. A blanket sentence that names the requirements
("...including installation, crew training, warranty...") has *high* term overlap by
construction. Predicate 3 catches a different and more common failure - a model grabbing a
topically adjacent line - and it is worth having for that. The blanket attack is defeated by the
fan-out cap and the enumeration requirement in §4, and pretending otherwise would leave the real
hole open behind a predicate that looks like it covers it.

Demotion table:

| Verdict | Any predicate fails |
| --- | --- |
| `covered` | -> `ambiguous`, `pending_review` |
| `partial` | -> `ambiguous`, `pending_review` |
| `excluded_explicit` | -> `ambiguous`, `pending_review` (a fabricated exclusion is defamatory-adjacent) |
| `absent` | governed by predicate 2 |

### 3.6 Stage 4 - Confidence banding and HITL routing

```
score = w1*evidence_strength
      + w2*classifier_self_report
      + w3*(span_verified_against_line ? 1 : 0)
      + w4*node_term_overlap
      - penalty(parse_quality below target)
      - penalty(injection_suspected)
      - penalty(blanket_suspected)
      - penalty(window_coverage incomplete)
```

The round-1 formula had a `w4*(channels_agreeing / applicable_channels)` term which, in
full-offer mode, **divided by zero and produced NaN** - and `NaN >= 0.85` is false, so every
verdict would have silently failed to reach `high`. With retrieval deleted (§3.1) the term is
replaced by node-term overlap, which is always defined. `test/confidence-no-nan.test.ts` asserts
a finite score for every input combination.

| Band | Rule | Behavior |
| --- | --- | --- |
| `high` | `>= 0.85` AND all three predicates pass AND not blanket-suspected AND complete window coverage | auto-published |
| `medium` | `0.60 - 0.85` | published with a caution chip, `needs_review`, **excluded from every headline figure** |
| `low` | `< 0.60`, `ambiguous`, or the mandatory bar unmet | HITL, not published |

**The asymmetric rule.** False absence destroys trust in one screenshot and is strictly worse
than a false present, which merely leaves the customer where they already were.

> **`mandatory` + `absent` is publishable only if EITHER
> (A) the offer parsed cleanly (`parse_quality >= floor`), window coverage is complete, and the
> offer is neither injection- nor blanket-suspected; OR (B) a human has confirmed it.
> Otherwise it lands `ambiguous` in the review queue.**

**HITL destinations:** internal adjudication is `review_status='pending_review'` at
`/bursar/review`. Anything leaving the building is a `bursar_drafts` row (§6.1) with a
content-free `agent_proposals` summary. **Bursar never sends anything to a vendor; there is no
outbound transport in v1.**

### 3.7 Typed deltas

`partial` carried all real heterogeneity in free text, so options, alternates, allowances, and
tiers had no representation. Added: `delta_kind`
(`quantity`/`term`/`tier`/`allowance`/`alternate`/`option`/`geography`), `delta_quantity`,
`delta_unit`, **`delta_amount_minor`** - the last is what makes a `partial` valuable in
`gap_adjusted` (§10), which round 1 could not do.

### 3.8 The window merge lattice, and pinned exclusions

Round 1 specified only "absent in every window", leaving the **normal** case undefined: window 1
says `covered` on line 40, window 5 says `excluded_explicit` on line 280, and iteration order
decided. Worse, real proposals put exclusions in a terminal block hundreds of lines from the
priced line, so **the exclusion and its target are frequently never in the same window** - a
systematic false-`covered` generator invisible to a false-absence gate.

**Merge lattice**, applied per `(offer, node)` across windows, highest wins:

```
excluded_explicit  >  partial  >  covered  >  ambiguous  >  absent
```

**Exclusion pinning.** The exclusion lexicon runs as a whole-document deterministic pre-pass
(§3.4) and **its hit lines are pinned into every window** regardless of window boundaries, so a
terminal exclusions block is in front of the classifier for every node. Pinned lines are marked
so they do not inflate the fan-out count (§4.3).

**Per-window results are durable** (§6.1 `bursar_leveling_window_results`). Round 1 computed
"absent in every window" from non-durable state over a 2-D checkpoint on a 3-D loop, so a
mid-run throttle meant either re-running every window or writing `window_coverage='partial'`,
which permanently demotes a genuine absence.

**Gate:** a long-document fixture with a terminal exclusions block must produce
`excluded_explicit`, not `covered` (§20.2). **If that gate cannot be met, the v1 envelope is
declared as 5-page documents** and longer offers are surfaced as "too long to level reliably"
rather than levelled badly.

### 3.9 Cost, latency, and caps - designed, not asserted

Round 1 asserted a "per-run cap" that **existed nowhere in the spec** - a phantom
cross-reference, and exactly the shape round 1 had killed on the drift sweep.

Measured constraints, verified in code:

| Constraint | Value | Source |
| --- | --- | --- |
| Proxy concurrency per service | 4 | `apps/api/src/env.ts:115` |
| Proxy rate per service | 120/min | `apps/api/src/env.ts:116` |
| Proxy upstream deadline | hardcoded 60s | `internal-llm.routes.ts:325`, not env-tunable |
| In-flight hold after client abort | 90s | an aborted client does **not** release the slot |
| Burn's inherited `LLM_TIMEOUT_MS` | 15000 | would abort routinely on an 8.5k-token call |

**Decisions:**

- `BURSAR_LLM_TIMEOUT_MS` default **60000**, matching the proxy's own deadline. Inheriting
  burn's 15s would abort mid-generation, and because the aborted client does not release the
  concurrency slot, a run of timeouts starves Bursar's own bucket and then 429s itself.
- A **timeout retries at a smaller batch**, never the same size.
- Committed caps in `bursar_org_settings`, persisted as used on the run row
  (`llm_calls_used`, `nodes_classified`): `max_nodes_per_run` (default 400),
  `max_offers_per_run` (default 8), `max_llm_calls_per_run` (default 250).
- A **BullMQ limiter** sized under the 120/min ceiling.
- Hitting a cap stops **cleanly** at `status='partial'` with a first-class
  "levelled 6 of 15 offers - continue" affordance, never silent truncation.
- `POST /requests/:id/level` runs a **cost preflight** returning estimated calls, tokens, and
  wall-clock before the run starts, so a 400-node x 15-offer request (~500 calls, >4M input
  tokens, ~30 min) is a visible choice rather than a surprise.

**CI caveat recorded:** recorded-response stubs mean CI never exercises the real timeout path.
§20.2 marks it explicitly rather than implying coverage.

### 3.10 `finish_reason` requires an additive `apps/api` change

Round 1 specified checking `finish_reason` without noticing it is **not obtainable**:
`internal-llm.routes.ts:349,389` return `{data:{content: text}}` and discard Anthropic's
`stop_reason` and OpenAI's `finish_reason` entirely, and §18 listed no `apps/api` edit.

**This build makes one additive change**: the proxy returns
`{data: {content, finish_reason, usage}}`. Purely additive - every existing caller reads
`data.content` and is unaffected. Without it, truncation detection is guesswork and the
`LlmMalformedError` path is undetectable at its most common trigger.

---

## 4. The coverage-collapse cluster

Four separate findings across two reviewers are **one attack**: a single crafted line, or one
colluding bidder, collapsing the exclusion diff. They are solved together and stated in one
place, because they will be tested as one attack.

### 4.1 The attack, with no injection at all

A vendor writes one ordinary sentence:

> *"All requirements, including installation, crew training, warranty, data export and
> escalation cap, are fully included in this all-inclusive price."*

Under round 1's design this **succeeds completely**: the model cites that line for all 14 nodes;
the span verifies against the cited line every time; node-term overlap is high by construction
(the sentence names the requirements); `span_verified` adds weight; full-offer mode clears the
`high` bar; everything auto-publishes and the diff goes clean. No imperative, no role token, no
invisible text, so the injection pre-scan sees nothing.

Worse, round 1's own §3.7 bundling design **legitimized this shape**, and the rollup pass then
propagated it to the rest of the tree.

### 4.2 Defense 1: the blanket-claim lexicon (deterministic)

A whole-document pre-pass flags lines matching blanket-coverage patterns: `all requirements`,
`fully included`, `all-inclusive`, `turnkey`, `everything listed`, `as specified in your
RFQ/RFP`, `complete solution`, `no exclusions`, `comprehensive`. Hits set
`bursar_offer_lines.blanket_claim = true`.

A `covered` verdict citing a blanket-claim line **cannot auto-publish**; it routes to review with
`blanket_suspected = true` on the coverage row.

### 4.3 Defense 2: the fan-out cap (structural, and the real defense)

`bursar_line_node_matches` makes fan-out countable. A single line matched to more than
`blanket_fanout_cap` nodes (default **4**) causes **all** of those verdicts to route to review
and blocks auto-publish for every one of them.

This is the load-bearing defense, because it does not depend on recognizing language. A blanket
claim is definitionally high fan-out; if a vendor invents phrasing the lexicon misses, the
fan-out cap still catches it. Pinned exclusion lines (§3.8) are excluded from the fan-out count
so a legitimate global exclusion is not penalized.

### 4.4 Defense 3: bundling requires explicit enumeration, and rollup is de-transitivized

**"Bundling line" is now defined** rather than inferred: a line the **classifier** matched to
>= 2 nodes, recorded in `bursar_line_node_matches`. Round 1 had the same pass produce and consume
`allocation_weight`, with no definition.

**A bundling line may auto-publish `covered` for multiple nodes only if the line itself
enumerates them** - sub-pricing, or an itemized list the classifier can cite per node. A bundle
that enumerates ("Installation $3,200; Training $2,400; Warranty 24mo $1,800") auto-publishes. A
bare "all-inclusive turnkey" does not. This is the distinction that separates a legitimate bundle
from a blanket claim, and legitimate bundles overwhelmingly itemize.

**Downward subsumption is verdict-preserving.** It may only promote `absent` or `ambiguous`
children to `derived_covered`. It **may never overwrite `excluded_explicit` or `partial`** -
round 1's rule would have let a bundling parent erase an explicit exclusion on a child, which is
the single most valuable finding in the app. Capped at **one level** unless descendants were
explicitly enumerated by the bundling line.

**Upward rollup is de-transitivized.** A parent whose children are all covered becomes
`derived_covered`, which is **excluded from the exclusion diff and is never itself an input to
another rollup**. Round 1's rule composed recursively, so one "turnkey" line walked coverage to
the root of the tree.

**`allocation_weight` has a specified derivation ladder** (round 1 had none, while §10 built gap
valuation on top of it). `allocation_method` records which rung was used:

| Rung | Method | Usable for gap valuation? |
| --- | --- | --- |
| 1 | `explicit_subprice` - the line itemizes | yes |
| 2 | `rival_distribution` - other offers priced these nodes separately | yes |
| 3 | `quantity_unit` - node quantity x a library unit price | yes, marked `estimated` |
| 4 | `equal_split` - last resort | **no. Gap valuation REFUSES equal-split observations** |

Rung 4 exists so the data model is total, not so it can drive a headline. An equal split of a
$16,400 turnkey line across 12 nodes gives $1,367/node, and "the cheapest bid is really the most
expensive" must never be an artifact of that heuristic.

### 4.5 Defense 4: rival-derived nodes are proposals, not writes

A bidder must not be able to write the ruler. Round 1's §4.2(d) quarantine covered promotion into
`bursar_scope_library` but **phase 1 promoted into `bursar_scope_nodes`, a different table**. Two
colluding bidders - or one vendor under two `bursar_vendors` rows, since uniqueness is only on
`lower(display_name)` - satisfy the ">=2 offers" rule and inject nodes only they cover. Rivals
score `absent`. And because `gap_adjusted` is the Matrix's default sort key, the attacker
**directly manipulates the award ranking**. Rival nodes defaulting to `nice_to_have` meant they
got *less* scrutiny.

Fixed:

- Rival-derived nodes land `review_status='pending_review'` and are **excluded from
  `gap_adjusted`, from the exclusion diff, and from producing any `absent` verdict** until a
  human promotes them.
- The >=2 supporting offers must come from **distinct `braid_profile_id`** (falling back to
  distinct `bond_company_id`, then to a human decision), **not distinct `vendor_id`**.
- Injection-suspected and blanket-suspected offers cannot contribute.
- `bursar_scope_nodes.contributing_offer_ids uuid[]` records the supporting set for audit.

### 4.6 The gate

`test/fixtures/blanket-coverage/`: **one all-inclusive line over a 14-node tree must NOT produce
a fully-covered tree.** Plus >= 3 non-imperative blanket-coverage fixtures in the injection
corpus (§20.2) - round 1's 8 fixtures were all instruction-shaped, which is the class the
structural defense already handles, so they proved the wrong thing.

---

## 5. Adversarial input: injection and malicious documents

### 5.1 Structural defenses (offers and requests alike)

- **Bytes never enter the instruction role.** Candidates are a typed JSON array in a data role.
- **Answers are by `offer_line_id`, spans verify against that line only** (§3.5 predicate 1).
  Injected instruction text lives in *some* line; citing it fails verification against the
  requirement.

### 5.2 The deterministic pre-scan, scoped to what the parser can actually see

Round 1 listed six signals, **three of which the specified parser cannot implement**: the ported
`Tj`/`TJ` regex carries no graphics state (no `Tf` size, no fill colour, no `Tm`/`Td`) and never
reads `/Info` or XMP. Worse, the GILLIGAN seed's fourth offer was a zero-font-size quote and
Playwright asserted on it - **the flagship demo was asserted against a detector the spec gave no
means to build.**

v1 signals, all implementable against extracted text:

| Signal | Example |
| --- | --- |
| imperative second-person directives at a reader-model | "respond", "you must answer", "for each requirement" |
| instruction-override markers | "ignore previous", "disregard the above" |
| role tokens | `system:`, `assistant:`, `<\|im_start\|>` |
| zero-width / bidi control runs | U+200B, U+202E |
| **blanket-coverage claims** (§4.2) | "all requirements are fully included" |

**Cut to v1.1:** zero-font-size, background-colour-matched, off-page positioning, and
metadata-embedded prose. All four require graphics-state tracking with per-line `render_props`,
which is a real PDF-parsing project. §24 records it; §19 re-scopes the seed fixture to a
**blanket-coverage** offer, which is both lexicon-detectable today and a better demo, since it
showcases the §4 cluster defense.

### 5.3 Quarantine and the product finding

Injection- or blanket-suspected offers never auto-publish `covered`, never contribute
rival-derived nodes (§4.5), and carry a confidence penalty. A hit opens a `bursar_mismatches` row
(`offer_manipulation_suspected`, severity `high`) citing the offending span. "This bidder
embedded text instructing our analysis tool to mark everything as covered" is arguably the most
valuable thing this app can tell a buyer.

### 5.4 Malicious documents

- Uncompressed-size and archive entry-count ceilings **before** decompression.
- **Content-type pinning**: sniffed type must match declared `source_format`, else `unparseable`.
- Per-parse wall-clock and memory caps in a bounded child context.
- **`MAX_DOC_BYTES` default lowered to 20MB.** nginx enforces a server-level
  `client_max_body_size 25m` (`nginx-with-site.conf:18`), so round 1's 26,214,400-byte value was
  unreachable and the user would have received a bare nginx 413 instead of the "we cannot read
  this" affordance. **Judgement call:** lower Bursar's cap rather than raise nginx's, because
  raising a global body limit to accommodate one app's worst case is a suite-wide change with no
  suite-wide justification. The 413 path is still handled: the SPA maps it to "this file is
  larger than 20MB".
- **CSV formula neutralization** attaches to the two export routes named in §11
  (`GET /v1/spend/export`, `GET /v1/requests/:id/diff/export`). Round 1 claimed the mitigation
  with no endpoint to attach it to. It ships as a shared helper in `@bigbluebam/shared`, because
  bearing-api and the frontend timeline export do the same unescaped thing today (§25.10).

### 5.5 Stage 0 is defended too

Round 1 opened §4 saying every input is adversarial, then defended only offers. **The RFQ is the
higher-leverage target**: it is routinely drafted on an incumbent's template, ingested through
the same untrusted byte path, and poisoning it edits the ruler *every competitor* is measured
against - and those nodes default to `mandatory`.

- The pre-scan runs on the request document; `bursar_requests` gains `injection_suspected` and
  `injection_signals`.
- A `request_manipulation_suspected` finding opens on a hit.
- **An injection-suspected request cannot reach `scope_status='confirmed'`** until flagged spans
  are cleared.
- Stage 0 span verification is **per-chunk-line**, not whole-document - nearly free, since the
  chunk loop already knows its line boundaries, and round 1 left in place the exact property that
  makes the attack work.

### 5.6 Bid confidentiality, made enforceable

Round 1 specified `sealed_until` but left it unenforceable. All four holes closed:

- **`offer.unseal` is floored** (owner/admin only). Round 1 left it out of the floored list, so
  every member held it.
- **The seal is a service-layer predicate on every read path**, not just the offer route. Round 1
  gated the derived surfaces (matrix, diff, totals, coverage) on `coverage.read`, which `viewer`
  holds, so sealed pricing leaked through every figure computed from it.
  `test/sealed-bid-viewer.test.ts` asserts a viewer's matrix contains **no sealed column**.
- **Every unseal is logged to `activity_log` and publishes `offer.unsealed`.** Round 1 deferred
  "whether unsealing is logged" to a human policy decision. That was wrong: whether a
  confidentiality control is audited is a security requirement, not a procurement-policy choice.
  What remains a human decision (§25.7) is *who* may unseal and whether the vendor is told.
- **The whole of `bursar_org_settings` is audited**, not just the exclusion lexicon.
  `confidence_weights`, `node_term_overlap_floor`, `blanket_fanout_cap`, and
  `parse_quality_floor` sat unaudited beside the audited lexicon, so an admin could zero the
  `span_verified` weight and silently suppress findings.

### 5.7 Draft confidentiality

`bursar_drafts` fixed the container in round 1 but made confidentiality **worse**: `draft.read`
was granted to `viewer`, so read access to the org's negotiating positions became *broader* than
`agent_proposals` gave.

- **`draft.read` removed from `viewer`; `draft.approve` floored.**
- Reads are scoped to **the request owner plus explicit holders**, not org-wide - RLS is
  org-level only and cannot do this alone.
- The `agent_proposals` summary is pinned to a **content-free template**
  (`"Bursar draft awaiting review: <draft_kind> for <vendor display_name>"`), because an
  unconstrained summary reintroduces the original leak at lower volume.
- **The grounding constraint has a named enforcement point**: a single builder function
  `buildDraftGrounding(offer_id, request_id)` that can only select lines belonging to that offer
  and nodes belonging to that request. `grounding_set` is written from its output, so
  `test/draft-grounding.test.ts` asserts **the builder**, not a downstream artifact.

---

## 6. Data model

All tables prefixed `bursar_`, all org-scoped, Drizzle schema in `apps/bursar-api/src/db/schema/`
(auto-discovered by `scripts/db-check.mjs`). Money is `bigint` **minor units** with explicit
`currency varchar(3)`. Cross-app refs are dotted with no cross-schema FK.

**The table list is not counted in prose.** §17.1 generates RLS policies by looping
`information_schema` over the `bursar_` prefix, and `test/rls-coverage.test.ts` asserts every
`bursar_%` table has RLS enabled and a policy. Round 1 said "21 tables" while defining 23, and an
RLS migration authored to "all 21" would have left two org-scoped tables unprotected - silently,
because the backstop is inert today.

### 6.1 Tables

#### `bursar_vendors`
`id`, `organization_id`, `display_name`, `braid_profile_id`, `bond_company_id`, `category`,
`criticality`, `owner_user_id` (SET NULL), `status`, `notes`, `created_by`, timestamps.
Unique `(organization_id, lower(display_name))`.

#### `bursar_payee_aliases` - payee resolution is Bursar's own, not Braid's
Braid **cannot** do this: `packages/shared/src/schemas/braid.ts:142-148` constrains
`source_type` to a five-value enum with `source_id: z.string().uuid()`, so a payee string fails
Zod; and `apps/braid-api/src/services/resolve.service.ts` mints a **fresh singleton profile per
unseen pair**, so every card string would create its own golden profile - the opposite of dedup.

`id`, `organization_id`, `vendor_id` (CASCADE), `raw_payee`, `normalized_payee`, `source`,
`confidence`, `resolved_by` (`deterministic`/`trigram`/`human`), `first_seen_at`, `last_seen_at`.
Unique `(organization_id, normalized_payee)`; GIN trigram on `normalized_payee`.

Normalization: uppercase-fold, strip card noise (`*`, `SQ *`, `TST*`), strip trailing
phone/city/state, strip corporate suffixes, collapse whitespace. Trigram match above 0.45; below
the auto-accept threshold (0.65) it becomes a **human review item, never a silent join**.
Unmatched spend keeps `vendor_id NULL`, which is `unbaselined_vendor`'s input.

Braid is called only for `bond_company_id` -> golden id, per
`apps/burn-api/src/lib/braid-resolve.client.ts:19-51`, degrading to `null` on every failure.

#### `bursar_requests`
`id`, `organization_id`, `title`, `category`, `bin_asset_id`, `source_doc_hash`, `status`,
`scope_status`, `scope_confirmed_at/by`, `currency`, `budget_minor`, `due_at`, `owner_user_id`,
**`injection_suspected`**, **`injection_signals jsonb`**, `created_by`, timestamps.

#### `bursar_scope_nodes`
`id`, `organization_id`, `request_id` (CASCADE), `parent_id` (guarded self-FK, RESTRICT), `path`,
`ordinal`, `title`, `description`, `node_kind` (CHECK), `normative_strength` CHECK in
(`mandatory`,`should_have`,`nice_to_have`,`informational`), `unit`, `quantity`, `derived_from`
CHECK, **`contributing_offer_ids uuid[]`** (§4.5), `cited_span jsonb`, `confidence`,
`review_status`, `dedup_key`, `extraction_run_id`, `tree_suspect`, `archived_at`, timestamps.
Unique `(organization_id, request_id, dedup_key)`. **Deletion is soft-archive only**; coverage
FKs are RESTRICT.

#### `bursar_offers`
`id`, `organization_id`, `request_id` (CASCADE), `vendor_id`, `bin_asset_id`, `source_format`,
`source_doc_hash`, `doc_bytes`, `doc_pages`, `uncompressed_bytes`, `normalization_status` CHECK,
`parse_quality`, `injection_suspected`, `injection_signals`, **`blanket_suspected`**,
`sealed_until`, `line_count`, `total_minor`, `currency`, `valid_until`, `received_at/by`,
timestamps.
**Unique `(organization_id, request_id, vendor_id, source_doc_hash)`** - concurrent-ingest guard.

#### `bursar_offer_lines`
`id`, `organization_id`, `offer_id` (CASCADE), `ordinal`, `raw_text` (bounded 4,000),
`char_start`, `char_end`, `page`, `quantity`, `unit`, `unit_price_minor`, `extended_minor`,
`line_role` CHECK, **`blanket_claim boolean`**, **`exclusion_hit boolean`** (pinned into every
window), `parsed_by`, `created_at`.
Unique `(organization_id, offer_id, ordinal)`; GIN tsvector on `raw_text` (UI search).
**No trigram index** - deleted with the retrieval mode (§3.1).

#### `bursar_line_node_matches`
`id`, `organization_id`, `offer_line_id` (CASCADE), `scope_node_id` (RESTRICT), `coverage_id`,
`allocation_weight numeric(6,5)`, **`allocation_method varchar(24)`** (§4.4 ladder),
`match_method`, `created_at`. Unique `(organization_id, offer_line_id, scope_node_id)`.
Weights per `offer_line_id` sum to 1.0. **Fan-out is counted from this table** (§4.3).

#### `bursar_offer_coverage`
`id`, `organization_id`, `request_id`, `offer_id`, `scope_node_id` (RESTRICT), `verdict` CHECK
(six), `matched_line_ids uuid[]`, `cited_span jsonb`, `rejected_candidates jsonb`,
**`node_term_overlap numeric(4,3)`**, `classifier_confidence`, `composite_confidence`,
`confidence_band`, `decided_by` (`deterministic`/`llm`/`human`/**`agent`**), `review_status`,
`provisional`, **`blanket_suspected`**, `window_coverage`, `subsumed_by_coverage_id`,
**`derived_covered boolean`** (§4.4), `delta_kind`, `delta_quantity`, `delta_unit`,
`delta_amount_minor`, `priced_amount_minor`, `overridden_verdict/by/at`, `leveling_run_id`,
timestamps.
Unique `(organization_id, offer_id, scope_node_id)`.
CHECK: `verdict <> 'absent' OR decided_by = 'human' OR jsonb_array_length(rejected_candidates) > 0`.

#### `bursar_leveling_window_results` - new (§3.8)
`id`, `organization_id`, `leveling_run_id`, `offer_id`, `scope_node_id`, `window_index`,
`verdict`, `cited_span jsonb`, `created_at`.
Unique `(organization_id, leveling_run_id, offer_id, scope_node_id, window_index)`.
Durable per-window results, merged by the §3.8 lattice.

#### `bursar_offer_totals` - §10
`id`, `organization_id`, `offer_id` (CASCADE), `currency`, `total_kind` CHECK in
(`stated`,`base_only`,`gap_adjusted`,`should_have_supplement`), `amount_minor`, `estimated`,
`unvalued_gap_count`, `renderable boolean`, `provenance jsonb`, `computed_at`.
Unique `(organization_id, offer_id, currency, total_kind)`.
`normalized_to_term` is **cut to v1.1** (§24) - there is no term column on offers or requests to
normalize to.

#### `bursar_leveling_runs`
`id`, `organization_id`, `request_id`, `offer_ids uuid[]`, `phase` (`enumerate`/`classify`),
`status` (`running`/`succeeded`/`partial`/`failed`/`blocked`/`rejected_limits`),
**`last_processed_offer_index`**, **`last_processed_node_index`**,
**`last_processed_window_index`** (the 3-D checkpoint, §3.8), `node_count`, `nodes_classified`,
**`llm_calls_used`**, `absent_count`, `excluded_count`, `low_confidence_count`,
**`heartbeat_at`**, **`claimed_by`**, `model_hint`, `started_at`, `finished_at`.

#### `bursar_awards`, `bursar_baseline_items`, `bursar_baseline_item_nodes`
Award chain via `supersedes_award_id` + `chain_root_id`, `baseline_hash`, `total_minor`,
`currency`, `term_start`, `term_end` (both nullable, §7.3), `auto_renew`, `renewal_notice_days`,
`timezone`, `contract_bin_asset_id`, `status`, `awarded_at/by`.

`bursar_baseline_items` carries **`kind`** CHECK in
(`included`,`excluded_at_award`,`absent_at_award`) - freezing what you knowingly did *not* get is
half the value of freezing. Node linkage is the M:N `bursar_baseline_item_nodes`.

**Immutability on four paths:** `BEFORE UPDATE` trigger with a `WHEN` clause scoped to content
columns (so additive migrations are not aborted); `BEFORE DELETE` trigger; `ON DELETE RESTRICT`
from awards (a cascade does not fire a BEFORE UPDATE trigger); and `bursar-retention` carries an
explicit exclusion list naming the table. **`TRUNCATE` bypasses both row triggers**, so a
`BEFORE TRUNCATE` statement trigger is added too - round 1 left that path open.

#### `bursar_spend_events`
`id`, `organization_id`, `vendor_id`, `award_id`, `source_type` CHECK in
(`bill.expense`,`import.csv`,`manual`), `source_id`, **`spend_import_id`**, `occurred_on`,
`amount_minor`, `currency`, `payee_raw`, **`normalized_payee`**, `description`,
`funding_source` (import-only), `external_ref`, `matched_baseline_item_id`, `match_method`,
`match_confidence`, **`dedup_key`**, timestamps.
**Unique `(organization_id, dedup_key)`** where `dedup_key` is derived from
`(normalized_payee, occurred_on, amount_minor, currency, external_ref)` via
`apps/burn-api/src/lib/idempotency-key.ts`. Index `(organization_id, normalized_payee)` for
§8 detector 3.

#### `bursar_spend_imports` - new (stability F1)
`id`, `organization_id`, `file_sha256`, `filename`, `row_count`, `rows_inserted`,
`rows_deduped`, `status`, `imported_by`, `created_at`.
Unique `(organization_id, file_sha256)`.

**Why this exists.** `POST /v1/spend/import` is the primary input for the entire post-award half
and round 1 gave it **no idempotency key at all** - while the offer path got a unique constraint
for exactly this hazard. A re-uploaded statement doubled every row, which doubles `price_drift`
magnitudes and mints phantom `scope_divergence` findings, with no way for the user to tell.
Import is now an upsert against `dedup_key` under a batch row keyed by file hash, and the UI
reports "412 rows, 0 new, 412 already imported".

#### `bursar_mismatches`, `bursar_renewals`, `bursar_scope_library`, `bursar_ingest_events`, `bursar_detector_feedback`, `bursar_extraction_runs`, `bursar_gate_checks`, `bursar_drafts`, `bursar_org_settings`

Notable changes:

- **`bursar_scope_library`** built-ins are global (`organization_id IS NULL`,
  `is_global = true`) so orgs created after the seed migration are not born with an empty
  library. Two round-2 fixes make that safe (§5 security F4):
  - **Global rows are immutable to org callers.** The API filters `is_global = false` on every
    write, and a `BEFORE INSERT OR UPDATE OR DELETE` trigger rejects org-caller writes to global
    rows. Round 1 gated library CRUD on an ordinary org action with nothing marking global rows
    seed-only, so **any org admin could edit rows every other tenant consumes** - a cross-tenant
    write path.
  - **The RLS policy is not the blanket one.** `organization_id = current_setting(...)::uuid`
    evaluates NULL (not true) for global rows, so they would become invisible the day a
    non-superuser role is armed, silently restoring the empty-library cold start. Policy is
    `organization_id = current_setting('app.current_org_id', true)::uuid OR (organization_id IS
    NULL AND is_global)`, with a `WITH CHECK` forbidding org-null inserts.
    `test/library-visibility.test.ts` asserts both halves.
- **`bursar_org_settings`** gains `llm_provider_id uuid` (round 1 omitted it though burn has one),
  `node_term_overlap_floor`, `blanket_fanout_cap`, `max_nodes_per_run`, `max_offers_per_run`,
  `max_llm_calls_per_run`, `max_lines_per_window`, `window_overlap_lines`,
  `price_drift_threshold_pct`, `renewal_lead_bands jsonb`, `parse_quality_floor jsonb`,
  `payee_match_threshold`, `payee_auto_accept_threshold`, `blanket_lexicon jsonb`,
  `exclusion_lexicon jsonb`, `digest_day`/`digest_hour`. **All of it is audited to `activity_log`
  with a before/after diff** (§5.6).
- **`bursar_drafts`** per §5.7. Body here under RLS with real `bursar.draft.*` gating; the
  `agent_proposals` row carries a content-free templated summary only. Round 1's placement was
  wrong in both directions: `apps/api/src/routes/proposals.routes.ts` gates on `shadowOnly(...)`,
  which per `packages/permissions/src/index.ts:357-377` **logs and never denies**; and any org
  admin reads every app's proposals.
- **`bursar_ingest_events`** and **`bursar_extraction_runs`** gain `heartbeat_at` + `claimed_by`
  (§18.6).

### 6.2 Reused platform tables

`agent_proposals` (ref-only), `entity_links` (**`org_id`**, not `organization_id`),
`organizations`/`users`, `bin_assets` (read-only, **`org_id`**, access-checked §6.4),
`bond_companies`, `bill_expenses` (read-only; Bursar never writes a Bill row),
`v_activity_unified`, `permissions`/`permission_group_defaults`, `activity_log`.

### 6.3 RLS posture

Policies are **generated** by a `DO $$` loop over `information_schema` for the `bursar_` prefix
(§17.1), so the set cannot drift from the table list. PG16 has no
`CREATE POLICY IF NOT EXISTS`, so the loop emits `DROP POLICY IF EXISTS ... ; CREATE POLICY ...`
per `0116*.sql:23-47`. `bursar_scope_library` takes the §6.1 variant policy.

Bursar uses **burn's `runInOrgScope`** (`apps/burn-api/src/plugins/rls.ts:102-112`) rather than
the older four services', for the reason burn's plugin documents: they issue
`set_config('app.current_org_id', $1, true)` as a standalone statement, and `is_local=true`
scopes it to the current transaction - which for a standalone statement commits immediately,
discarding the GUC before the next query runs. Those plugins are inert today only because the
role has BYPASSRLS.

**The honest caveat stays** (reviewers rated it worth keeping): today the backstop is **absent**,
because every service connects as the `bigbluebam` superuser and superusers bypass RLS
unconditionally. Every Bursar query carries an explicit `organization_id` predicate as if there
were no RLS, because there effectively is not. `boot/assert-rls-bound.ts` logs
`rls_backstop: 'absent'` at fatal level; `test/rls-backstop.test.ts` starts passing the day the
platform arms a non-superuser role.

### 6.4 Bin asset access - the round-1 fix was wrong and incomplete

Round 1 added `AND a.organization_id = ...` to the worker join. **`bin_assets` has no such
column** - `apps/bin-api/src/db/schema/bin-assets.ts:29` is **`org_id`**. So the corrected join
was a runtime 42703: the guard would fail the *query* rather than the tenant check, and the first
person to "fix" the error would delete the predicate.

Org-scoping was also not the whole hole. Bin has private and project-scoped assets
(`bin_private_not_owner` is a live `PreflightReason`), so a member who cannot see a private asset
in `/bin/` could still put its uuid in `bin_asset_id` and get its **verbatim text into Bursar as
cited spans**. And `getObjectBuffer` bypasses the `scan_status` gate entirely - Bursar is the one
app that must not parse unscanned bytes, given its own threat model.

**The v1 guard is `assertBinAssetReadable(actingUserId, orgId, assetId)`**, called at every write
path accepting a `bin_asset_id` (request create/update, offer create, award contract link):

1. `can_access('bin.asset', assetId, actingUserId)` via
   `packages/shared/src/visibility-client.ts` - `bin.asset` is already a supported type, so this
   is reuse, not a new resolver;
2. `org_id` equality as a defence-in-depth predicate;
3. **`scan_status = 'clean'`** required;
4. **404, not 403**, so the endpoint is not an existence oracle.

The worker join uses `a.org_id`. `test/bin-asset-access.test.ts` covers cross-org,
**private-same-org**, and **unscanned** cases. Filed against burn-api and bulwark-api as
pre-existing (§25.10).

---

## 7. The frozen baseline and post-award drift

### 7.1 The freeze

`POST /v1/awards` in one `runInOrgScope` transaction: insert the award; **copy** every accepted
line into `bursar_baseline_items` including `excluded_at_award` and `absent_at_award` rows; link
nodes via `bursar_baseline_item_nodes`; stamp `coverage_verdict_at_award`; compute
`baseline_hash`; set the request `awarded`; write `entity_links`; publish `award.recorded` and
`baseline.frozen`.

**409 if a leveling run holds a live lease** (§18.6), so a freeze never attests to a
half-computed diff.

### 7.2 The chain

Amendments never mutate. A new row with `supersedes_award_id` inherits `chain_root_id`; the
predecessor flips to `superseded`. Drift resolves over the chain, taking the latest active item
per `(chain_root_id, ordinal)`.

### 7.3 Drift computation

1. **Vendor resolution** via `bursar_payee_aliases` trigram, never Braid.
2. **Award selection**, including the null-term case round 1 broke on (its own GILLIGAN
   one-time-purchase scenario): a null `term_end` means open-ended, selected when
   `occurred_on >= term_start` (or unconditionally when both are null) and no bounded award
   matches; ambiguity picks the most recently awarded and records `match_method='fuzzy'`.
3. **Line matching**, deterministic only: exact description, trigram over
   `bursar_baseline_items.title`, then unit-price equality within tolerance. **No LLM matcher** -
   it was the only LLM call in a 30-minute sweep and nothing binding depends on it.
4. **Currency guard, hard precondition.** Drift is computed only when the spend event's currency
   equals the baseline item's; otherwise `currency_mismatch` and skip. Without this an FX move
   reads as double-digit price drift.

Metrics: unit-price drift, extended drift, quantity drift, cadence drift, **new-line drift**
(invoiced item matching no baseline item), and **silent line**.

**Silent-line requires a bounded term.** Round 1 made it uncomputable on the open-ended awards
§7.3 itself introduced: "never invoiced across a full term" has no meaning when `term_end` is
null. Rule: silent-line evaluates only on awards with a non-null `term_end` that has passed, or
on a rolling 12-month window for open-ended awards, and the finding states which basis it used.

**Dollars at stake are computed, never estimated.** Unquantifiable drift stores `NULL` and the UI
shows "not quantified".

---

## 8. The detector catalog

| # | `detector` | Fires when | Threshold | Job |
| --- | --- | --- | --- | --- |
| 1 | `price_drift` | unit price deviates from the frozen baseline, same currency | `price_drift_threshold_pct`, **default 10%**, min absolute $25 | `bursar-drift-sweep` |
| 2 | `scope_divergence` | invoiced line with no baseline item, or a silent baseline item (§7.3 basis stated) | any | `bursar-drift-sweep` |
| 3 | `unbaselined_vendor` | recurring spend (>=2 events in 180d) with no award, **grouped by `normalized_payee`** | >=2 events | `bursar-drift-sweep` |
| 4 | `renewal_cliff` | `notice_deadline` enters a lead band; absorbs auto-renew-unreviewed as a severity bump | bands **`t_minus_90/60/30/7`**, `alerted_bands` idempotency | `bursar-renewal-radar` |
| + | `offer_manipulation_suspected` | §5.3 | any | `bursar-parse-offer` |
| + | `request_manipulation_suspected` | §5.5 | any | `bursar-derive-scope` |

**Detector 3 groups by `normalized_payee`, not `vendor_id`** - round 1 contradicted itself, since
§6.1 states unmatched spend keeps `vendor_id NULL`, so a `vendor_id` grouping would have made the
detector fire on nothing. This is the shadow-IT bucket and, like Burn's `unscoped`, **the bucket
is the product**.

Round-1 cuts stand (§24): `dormant_seat` and `card_fragmentation` are import-only and deferred;
`duplicate_tool` deferred; `orphaned_custody` is a vendor-detail badge.

**Noise control**: `dedup_key` upsert bumps `last_seen_at`; per-org per-detector daily cap
(default 200) records `detector_capped`; `dismissed` is sticky by `dedup_key` unless the evidence
hash changes.

---

## 9. `bursar_scope_gap` as a read-only advisory tool

**The enforcing bill-api gate is cut from v1** (§24, top item). `POST /v1/gate/scope-gap` and the
MCP tool answer on demand *does this outgoing charge match something we agreed to?*, returning
`pass`/`advisory` plus cited reasons and recording a `bursar_gate_checks` audit row. **No
preHandler in bill-api, no enforcement, no blocking verdict, no composition with Burn's
precheck.**

Why: it required a bill-api migration, a second **serial** preHandler on every money-out write
(`burn-precheck.hook.ts` is a single preHandler, so a second runs after it: 400ms + 400ms), a
ported Redis breaker (without which every write pays the full timeout for any Bursar outage), a
recovery detector, and an internal auth surface - for the piece least connected to the winning
wedge.

**Internal-caller shape specified now** so v1.1 does not improvise: `POST
/v1/internal/gate/scope-gap` with `INTERNAL_SERVICE_SECRET` **plus `acting_user_id`** resolved
through viewer-caps, returning **reason codes and a check id only - never cited spans, baseline
quotes, or prices.**

---

## 10. Comparable totals

The seed narrative's punchline is "the cheapest bid is the most expensive", and round 1 could
compute **neither** it nor two of its own four total kinds.

| `total_kind` | Definition |
| --- | --- |
| `stated` | what the vendor's document says |
| `base_only` | sum of `line_role='base'` lines |
| `gap_adjusted` | `base_only` + valued **mandatory** gaps: `absent`, `excluded_explicit`, **and `partial` via `delta_amount_minor`** |
| `should_have_supplement` | the same valuation over `should_have` nodes, reported **separately** so it never silently inflates the mandatory comparison |

`normalized_to_term` is **cut to v1.1**: there is no `term_months` on offers and no
`target_term_months` on requests to normalize against, and adding both is real scope for a total
the seed does not need.

### 10.1 The valuation ladder

Round 1 said "the rival distribution" and left four cases undefined. The ladder, in order, with
`provenance.kind` recorded:

| Rung | Source | Admissible when |
| --- | --- | --- |
| 1 | `offer_line` - this offer priced it as an option/allowance | always |
| 2 | `rival_median` - median across rivals that priced it **separately** | >= 2 admissible rival observations |
| 3 | `library_unit` - node `quantity` x library unit price | library has a unit price for the category |
| 4 | *(none)* | -> the gap is `unvalued` |

**Admissibility rules**, each of which round 1 left open:

- A rival that is itself `absent` on the node contributes **nothing** (it is not an observation).
- A rival that priced it **inside a bundle** contributes only if `allocation_method` is
  `explicit_subprice` or `rival_distribution`. **Equal-split allocations are refused** (§4.4).
- A rival in a **different currency** is inadmissible, matching §7.3's currency guard.
- **Fewer than 2 admissible observations means no `rival_median`** - with two offers the "median"
  is one observation, which is not a distribution.

### 10.2 The single-offer request, and refusing to render a number

"Should I sign this one quote" is a large share of real usage and round 1 gave it nothing. When
gaps cannot be valued above rung 3, `bursar_offer_totals.renderable = false` and the UI shows:

> **Cheapest on stated price. 3 gaps unpriced** - crew training, installation, escalation cap.

That is honest and still useful: the exclusion diff is the product, and the dollar figure is a
convenience. Fabricating a total from one observation to preserve a headline would be exactly the
CFO-credibility failure §7.3 refuses elsewhere.

`gap_adjusted` remains the Matrix's default sort key **only when `renderable`**; otherwise the
Matrix sorts on `stated` and shows the unpriced-gap count as a second column.

---

## 11. API surface

Base `/bursar/api/v1/...`, mounted at `/v1` per `apps/burn-api/src/server.ts:138-151`. Cursor
pagination, `?filter[field]=`, `?sort=-field`, platform error envelope.

**Vendors:** `GET/POST /vendors`, `GET/PATCH /vendors/:id`, `DELETE /vendors/:id`
(`vendor.delete`, archive), `GET/POST /vendors/:id/aliases`,
`DELETE /vendors/:id/aliases/:alias_id`, `GET /vendors/alias-review`.

**Requests and scope:** `GET/POST /requests`, `GET/PATCH /requests/:id`,
`POST /requests/:id/derive-scope`, `GET /requests/:id/scope`,
`POST /requests/:id/scope/nodes`, `PATCH/DELETE /scope-nodes/:id` (DELETE archives),
`POST /scope-nodes/:id/promote` (`scope.write`, promotes a rival-derived node out of
`pending_review`, §4.5), `POST /requests/:id/scope/apply-library`,
`POST /requests/:id/scope/confirm` (**409 while `deriving`; blocked while
`injection_suspected`**).

**Offers:** `GET/POST /requests/:id/offers`, `POST /offers/:id/upload` (`offer.ingest`,
multipart), `GET /offers/:id`, `GET /offers/:id/lines`, `POST /offers/:id/reparse`,
`POST /offers/:id/unseal` (**`offer.unseal`, floored**), `DELETE /offers/:id`.

**Leveling and diff:** `POST /requests/:id/level` (`leveling.run`; **cost preflight**; returns
**202 + run id**, §18.6; 409 if a run holds a live lease), `GET /requests/:id/leveling-runs`
(**the authoritative progress source**), `GET /requests/:id/matrix`,
`GET /requests/:id/exclusion-diff`, `GET /requests/:id/totals`, `GET /coverage/:id`,
`POST /coverage/:id/override` (`coverage.override`), `GET /review`.

**Awards:** `POST /awards` (`award.create`), `GET /awards`, `GET /awards/:id`,
`GET /awards/:id/baseline`, `POST /awards/:id/amend` (**`award.amend`**),
`POST /awards/:id/terminate` (**`award.terminate`**). No baseline write path exists.

Round 1 referenced amend and terminate in the permission flag table while giving them **no
action**, so they would have shipped gated on `award.create` - meaning anyone who can award can
terminate a baseline chain.

**Spend:** `GET /spend`, `GET /spend/by-vendor`, `POST /spend/import` (`spend.import`;
idempotent per §6.1), `GET /spend/imports`, **`GET /spend/export`** (CSV, formula-neutralized).

**Mismatches, renewals, drafts:** `GET /mismatches`, `GET /mismatches/:id`,
`POST /mismatches/:id/resolve|dismiss`, `POST /mismatches/:id/mark-wrong`, `GET /renewals`,
`POST /renewals/:id/decide` (`renewal.decide`), `GET /drafts` (`draft.read`, owner-scoped),
`POST /drafts/clarification|negotiation-brief` (`draft.create`),
`POST /drafts/:id/approve|reject` (**`draft.approve`, floored**),
**`GET /requests/:id/diff/export`** (CSV, formula-neutralized).

**Gate, library, settings, internal:** `POST /gate/scope-gap`, `GET /gate/checks`, library CRUD
(`library.write`; **global rows rejected**), `GET/PATCH /settings`,
`POST /internal/run-derivation`, `/internal/run-leveling`, `/internal/events`,
`/internal/engines/:name`, `/health`, `/health/ready`, `/metrics`.

Internal routes register outside any session gate (`server.ts:135-137`).

### 11.1 Realtime `/bursar/ws`

Rooms `org:<id>`, `request:<id>` (`scope.progress`, `leveling.progress` with
`offer n/N, node m/M, window w/W`, `matrix.updated`), `vendor:<id>`.

No browser-side WS precedent exists in `apps/burn/src`, so: exponential backoff reconnect (1s,
capped 30s, jittered), a visible "reconnecting" state, and **`GET /requests/:id/leveling-runs`
polled at 5s as the authoritative fallback**. The WS is an optimization; the poll is the truth.

---

## 12. MCP surface

Module `apps/mcp-server/src/tools/bursar-tools.ts`, client shaped like `createBurnClient`
(`burn-tools.ts:55-80`), forwarding the caller's bearer token. Round 1 asserted "18 tools"
without naming one, which is unfalsifiable and is precisely how the Bolt 17-vs-18 contradiction
happened. The enumeration is authoritative:

| Tool | Backing endpoint |
| --- | --- |
| `bursar_level_quotes` | `POST /requests/:id/level` |
| `bursar_scope_gap` | `POST /gate/scope-gap` (**advisory, non-enforcing**) |
| `bursar_vendor_view` | `GET /vendors/:id` |
| `bursar_mismatches` | `GET /mismatches` |
| `bursar_spend_by_vendor` | `GET /spend/by-vendor` |
| `bursar_renewals_due` | `GET /renewals` |
| `bursar_exclusion_diff` | `GET /requests/:id/exclusion-diff` |
| `bursar_get_matrix` | `GET /requests/:id/matrix` |
| `bursar_get_totals` | `GET /requests/:id/totals` |
| `bursar_list_requests` | `GET /requests` |
| `bursar_get_request` | `GET /requests/:id` |
| `bursar_get_scope_tree` | `GET /requests/:id/scope` |
| `bursar_upsert_scope_node` | `POST /requests/:id/scope/nodes`, `PATCH /scope-nodes/:id` |
| `bursar_list_offers` | `GET /requests/:id/offers` |
| `bursar_get_coverage` | `GET /coverage/:id` (returns rejected candidates, `node_term_overlap`, `blanket_suspected`) |
| `bursar_get_baseline` | `GET /awards/:id/baseline` |
| `bursar_list_awards` | `GET /awards` |
| `bursar_resolve_vendor` | alias -> vendor resolution, read-only |
| `bursar_list_leveling_runs` | `GET /requests/:id/leveling-runs` |
| `bursar_draft_clarification` | `POST /drafts/clarification` -> a `bursar_drafts` row |

**`asker_user_id` narrows both visibility and financial flooring** (as `burn-tools.ts:24-33`):
bursar-api takes the **intersection** of the bearer's and the asker's capabilities. mcp-server
cannot backstop this (its own `BBB_PERMISSIONS_ENFORCE` defaults to `warn`).

**Intentionally no tool** (recorded as `— _(skip: …)_`): scope confirm and node promote (human
gates), all award write routes (**the freeze is a human act**), uploads and spend import
(multipart), coverage override and mark-wrong (**human adjudication is the calibration ground
truth**), offer unseal (confidentiality control), draft approve, settings and library writes,
`/internal/*`, `/bursar/ws`, health, both CSV exports.

Policy gating is automatic via `register-tool`'s PolicyGate on `bursar.*`; tools fail closed
until an operator allowlists it.

---

## 13. Permissions

### 13.1 The action table - the single source of truth

No section states a count. §17.3's probe counts this table.

| Action | `is_read` | floored from `member` | `viewer` | destructive | confirm |
| --- | --- | --- | --- | --- | --- |
| `bursar.vendor.read` | yes | | yes | | |
| `bursar.vendor.write` | | | | | |
| `bursar.vendor.delete` | | yes | | yes | yes |
| `bursar.request.read` | yes | | yes | | |
| `bursar.request.write` | | | | | |
| `bursar.scope.write` | | | | yes | |
| `bursar.scope.confirm` | | yes | | | |
| `bursar.offer.read` | yes | | yes | | |
| `bursar.offer.write` | | | | | |
| `bursar.offer.ingest` | | | | | |
| `bursar.offer.unseal` | | yes | | | yes |
| `bursar.leveling.run` | | | | | |
| `bursar.coverage.read` | yes | | yes | | |
| `bursar.coverage.override` | | yes | | | |
| `bursar.award.read` | yes | | yes | | |
| `bursar.award.create` | | yes | | | yes |
| `bursar.award.amend` | | yes | | yes | yes |
| `bursar.award.terminate` | | yes | | yes | yes |
| `bursar.baseline.read` | yes | | yes | | |
| `bursar.spend.read` | yes | | yes | | |
| `bursar.spend.read_all` | yes | yes | | | |
| `bursar.spend.import` | | yes | | | |
| `bursar.usage.read` | yes | | yes | | |
| `bursar.usage.attest` | | | | | |
| `bursar.mismatch.read` | yes | | yes | | |
| `bursar.mismatch.resolve` | | | | | |
| `bursar.mismatch.dismiss` | | | | yes | |
| `bursar.renewal.read` | yes | | yes | | |
| `bursar.renewal.decide` | | | | | |
| `bursar.gate.run` | | | | | |
| `bursar.draft.read` | yes | | **no** (§5.7) | | |
| `bursar.draft.create` | | | | | |
| `bursar.draft.approve` | | yes | | | |
| `bursar.detector.mark_wrong` | | yes | | | |
| `bursar.library.write` | | yes | | | |
| `bursar.settings.read` | yes | | yes | | |
| `bursar.settings.write` | | yes | | | |

`requires_superuser` is **false for every row**.

Round 1's prose said 34 while the list contained 35 and claimed 12 `.read` when the family is 13
(the 12 was the *viewer grant*, which correctly excludes `spend.read_all`), and the M1 gate
asserted `34/34/25/12/0` - a gate that **fails on a correct build** and invites someone to edit
the data to match the prose. The `is_read` column and the `viewer` column are now separate, which
is where the conflation came from.

### 13.2 Built-in group grants

`owner` and `admin` get every row. `member` gets every row not marked floored. `viewer` gets the
rows marked `viewer`. `guest` gets none. **`gate.override` does not exist** (the gate is
advisory), so the round-1 note about keeping the escape hatch member-reachable no longer applies.

### 13.3 Enforcement posture

Bursar copies Burn's **hardcoded fail-closed boot invariant**
(`apps/burn-api/src/boot/assert-permissions-enforce.ts`, asserted at `server.ts:47-54` before
anything binds a port): mode `'on'`, `onUnknown` fail-closed, **not an env var**, because
`ENV_HINTS` is a flat global map with no per-service override (burn's issue #83).

**Financial flooring** ports burn's `viewer-caps` plugin and `redact-financial-fields.ts`.
Sealed-bid filtering (§5.6) is a separate service-layer predicate on the same read paths.

---

## 14. Frontend, including the help system

`apps/bursar/`, React 19 + TanStack Query v5 + Zustand + Tailwind v4 + Radix, `base: '/bursar/'`.

| Route | Page |
| --- | --- |
| `/bursar/` | **Vendor Portfolio** - "no award on file" is a first-class column |
| `/bursar/requests` | Request list |
| `/bursar/requests/:id` | **Scope Tree editor** - citations, strength promotion, apply-library, rival-node promotion queue, Confirm scope |
| `/bursar/requests/:id/level` | **The Leveling Matrix** - sorted by `gap_adjusted` when renderable, else `stated` + unpriced-gap count. A chip opens the cited span, matched lines, and for `absent` **the rejected candidates and why** |
| `/bursar/requests/:id/diff` | **Exclusion Diff** - rival-informed first, `tree_suspect` quarantined |
| `/bursar/vendors/:id` | Vendor detail - aliases, award chain, baseline, spend, findings, `orphaned_custody` badge |
| `/bursar/mismatches` | Mismatch Inbox - "not quantified" never becomes a number |
| `/bursar/renewals` | Renewal Radar |
| `/bursar/review` | HITL queue - coverage adjudication, alias review, rival-node promotion, drafts |
| `/bursar/settings` | Thresholds, weights, lexicons, library (global rows read-only) |

**The hard UI rule:** a `medium`-band verdict is visually distinct and **excluded from every
headline aggregate**. A `data-testid` on each aggregate carries its contributing band set so
§20.3 can assert it.

### 14.1 The help system

Shipped in **M6** (authoring) and gated at **M9**:

- `docs/apps/bursar/help.md` and `docs/apps/bursar/guide.md`;
- `docs/apps/bursar/help-index.json` **generated**, verified in CI with
  `node scripts/help/build-help-index.mjs --check` (a purpose-built check mode that exits 1)
  rather than regenerating and eyeballing, which mutates the tree in CI;
- `<HelpTrigger app="bursar" />` per `apps/burn/src/components/layout/burn-layout.tsx:120`;
- **every `@bigbluebam/ui/*` alias from `apps/burn/vite.config.ts` copied verbatim.** Round 1
  said "the two vite aliases"; burn's config has ten-plus, and the reviewer's "three" also
  undercounts. The one that bites is `@bigbluebam/ui/markdown` (burn's line 22), imported by
  both `packages/ui/help-center.tsx:39` and `help-viewer.tsx:17` - and because the frontend
  Dockerfile chains builds with `&&`, an unresolved alias **breaks the whole frontend image**,
  not just Bursar. The rule is stated as "copy them all", not a count.
- `docs/apps/bursar/screenshots/` comes from the docs-capture recipe (§19), **explicitly not**
  from the bespoke braid/bulwark capture scripts.

`scripts/help/smoke-help-center.mjs` is **not** a done-criterion: it is hardcoded to Bam and takes
no app argument, so "covers Bursar" was unsatisfiable. Coverage is Playwright step 12 instead.
Filed as pre-existing that its `OUT` default is a hardcoded `D:/Documents/GitHub/...` path that
does not exist in this checkout (§25.10).

---

## 15. Background work

Locks live inside bursar-api; worker jobs are thin HTTP callers into `/v1/internal/engines/:name`.

| Job | Schedule | Does |
| --- | --- | --- |
| `bursar-derive-scope` | event | Bin bytes -> text -> `/internal/run-derivation`, chunk-checkpointed |
| `bursar-parse-offer` | event | lines, injection + blanket pre-scan, parse-quality |
| `bursar-level-request` | event | **async-start; polls the run** (§18.6) |
| `bursar-drift-sweep` | `*/30 * * * *` | detectors 1, 2, 3 |
| `bursar-renewal-radar` | `0 6 * * *` | detector 4 |
| `bursar-mismatch-reconcile` | `5,35 * * * *` | closes findings whose evidence no longer holds |
| `bursar-run-reaper` | `*/5 * * * *` | reverts cold `running` rows to `partial` (§18.6); also reaps ingest claims |
| `bursar-draft-reconcile` | `*/15 * * * *` | reflects proposal decisions onto drafts |
| `bursar-weekly-digest` | `0 13 * * 1` | the retention mechanism |
| `bursar-retention` | `20 5 * * *` | prunes; `bursar_baseline_items` on the exclusion list |

**Reconcile no longer flaps against the sweep.** Round 1 ran reconcile at `*/15` and the sweep at
`*/30`, so they interleave: the sweep opens a finding, reconcile closes it before the evidence
settles, and each cycle publishes a Bolt event. Both now take the **same per-org advisory lock
class**, and reconcile is offset to `5,35` so it always runs after a sweep tick rather than
between one and its writes.

**`bursar-drift-sweep` is bounded**: an org cursor across ticks, a per-tick row budget, a BullMQ
limiter, row claims with lease renewal, and **progress logging** (`org n/N`, `rows n/N`,
elapsed-ms) logged **before** each stall.

---

## 16. Events and integration

### 16.1 Published (source `bursar`)

The enumeration is authoritative; no count in prose.

`request.created`, `request.manipulation_suspected`, `scope.derived`, `scope.frozen`,
`offer.received`, `offer.normalized`, `offer.manipulation_suspected`, `offer.unsealed`,
`quote.leveled`, `exclusion.detected`, `award.recorded`, `baseline.frozen`, `drift.detected`,
`mismatch.opened`, `mismatch.resolved`, `renewal.approaching`, `draft.created`, `draft.decided`,
`gate.advisory`.

**Signature confirmed correct, no action needed.** Round 1 asserted CLAUDE.md was stale on
`publishBoltEvent`. **It has since been corrected** - `CLAUDE.md:434` now documents
`publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)` explicitly, including
the reason it matters (`check-bolt-catalog.mjs` extracts the first two string literals, so an
object-form call would both pass `undefined` at runtime and evade the guard). The round-1
docs-correction task is withdrawn.

Events carry **refs and scalars only, never document text or personal identifiers** - Bolt fans
out to webhooks and external runners.

### 16.2 Consumed

`expense.submitted` / `expense.approved` (bill) -> spend event; `profile.merged` (braid) ->
re-point `braid_profile_id`; `proposal.decided` (platform) -> reflect onto `bursar_drafts`.

**`invoice.paid` and `payment.recorded` remain removed** - money in, and ingesting them would
mint vendor-spend rows out of the customer's own revenue.

**There is no Bin event** (bin-api emits none), so offer ingestion is REST-triggered.

### 16.3 entity_links and visibility

Links written in the same org-scoped transaction as the row they describe
(`apps/burn-api/src/lib/entity-links.ts:36-40`), `ON CONFLICT DO NOTHING`. `entity_links` uses
`org_id`; `bursar_*` tables use `organization_id`.

**Visibility registration is a required `apps/api` change.** Round 1's preflight could not work:
no `bursar.*` types registered, and **`bill.expense` is not a supported type at all**
(`visibility.service.ts:113-153` lists `bill.invoice` and `bill.client`, no expense), so under
the treat-non-ok-as-deny convention every drift citation would silently drop. Added to
`VisibilityEntityType` and `SUPPORTED_ENTITY_TYPES` with resolver branches: `bursar.vendor`,
`bursar.request`, `bursar.offer`, `bursar.award`, `bursar.mismatch`, and **`bill.expense`**.

`bin.asset` is already supported, which is what makes §6.4's `assertBinAssetReadable` reuse
rather than new work.

---

## 17. Migration plan

### 17.1 The files

**Anchor is "current tip + 1, observed at authoring time."** Tip at authoring was
`0246_tasks_overdue_alerted.sql`. Four apps landed on this branch recently; **re-run the delta
after any rebase**.

| # | File | Contents |
| --- | --- | --- |
| NNNN | `bursar_core.sql` | vendors, payee aliases, requests, scope nodes, scope library (global built-ins + the variant policy + the global-immutability trigger), org settings, extraction runs; the "Bursar System" sentinel user (as `0234`/`0239` do, since `agent_proposals.actor_id` is NOT NULL) |
| +1 | `bursar_offers_coverage.sql` | offers, offer lines, line-node matches, coverage (+ the `absent` CHECK), window results, offer totals, leveling runs |
| +2 | `bursar_awards_baseline.sql` | awards, baseline items + item-nodes + BEFORE UPDATE (`WHEN`-scoped) / BEFORE DELETE / **BEFORE TRUNCATE** triggers, spend events, spend imports |
| +3 | `bursar_detectors_drafts.sql` | mismatches, renewals, gate checks, ingest events, detector feedback, drafts |
| +4 | `bursar_rls.sql` | **generated**: a `DO $$` loop over `information_schema.tables` where `table_name LIKE 'bursar\_%'`, emitting `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `DROP POLICY IF EXISTS ... ; CREATE POLICY ...`, with `bursar_scope_library` taking the §6.1 variant |
| +5.. | permissions (two-pass, §17.2) | |

Generating the policies is what makes §6's "no count in prose" enforceable: the migration cannot
miss a table, and `test/rls-coverage.test.ts` asserts every `bursar_%` table is covered.

### 17.2 The permission procedure - the full chain

Round 1's procedure was missing its first two steps in a way that reproduces the incident it
warns about: `build-permission-delta.mjs` **diffs the manifest**, and the manifest is generated
by `generate-permission-manifest.mjs` walking route and tool files. Run as round 1 wrote it, the
delta would emit **zero `bursar.*` rows**, and the group defaults would then be authored against
an empty catalog.

```sh
# Pass 1 - core schema.
docker compose run --rm migrate                    # applies NNNN..NNNN+4

# Pass 2 - the FULL chain, in order.
node scripts/generate-permission-manifest.mjs      # routes + tools -> manifest
#   hand-review the flags against the §13.1 table here
node scripts/build-permission-codegen.mjs
node scripts/build-permission-delta.mjs            # emits <observed>_permissions_seed_actions_delta_0NN.sql
node scripts/check-permission-catalog.mjs
docker compose run --rm migrate

# ONLY NOW author <observed>+1_bursar_builtin_group_defaults.sql.
docker compose run --rm migrate
```

The trap (verbatim from the `0238` and `0243` headers): the generator computes its number as
`max(prefixes)+1`, so a group-defaults file authored **first** runs **first**, its `CROSS JOIN
permissions WHERE app='bursar'` matches zero rows, `ON CONFLICT DO NOTHING` swallows it, migrate
reports success, the file is checksummed as applied, and **it can never re-run** - leaving every
non-SuperUser at `implicit_deny` on every `/bursar` route. This has happened twice.

### 17.3 The probe is the gate

```sql
SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
FROM permission_group_defaults d
JOIN permissions p ON p.id = d.permission_id
JOIN permission_groups pg ON pg.id = d.group_id
WHERE p.app = 'bursar' GROUP BY 1;
```

**Expected values are computed from the §13.1 table, not restated here.** M1's acceptance is:
`owner = admin = (row count of §13.1)`, `member = (rows not floored)`,
`viewer = (rows marked viewer)`, `guest = 0`. A CI assertion parses §13.1 and compares, so prose
and data cannot diverge again.

---

## 18. Infrastructure

### 18.1 nginx - three files, and the one compose actually mounts

`docker-compose.yml:355` bind-mounts **`infra/nginx/nginx-with-site.conf`**;
`infra/nginx/nginx.conf` is the bare `docker run` profile and **is not mounted by compose at
all**.

| File | Role | Assets regex |
| --- | --- | --- |
| `infra/nginx/nginx-with-site.conf` | **what compose mounts** | 835 |
| `infra/nginx/nginx.conf` | bare `docker run` profile | 766 |
| `infra/nginx/nginx.railway.conf` | Railway | 975 |

Each gets `location /bursar/`, `/bursar/ws`, `/bursar/api/` (Railway using
`set $rw_upstream_N "bursar-api.railway.internal"` + `rewrite`), **and `bursar` in the shared
static-asset regex**.

**M0 acceptance:** `grep -c bursar infra/nginx/*.conf` non-zero for all three.

`client_max_body_size` is **not** modified; `MAX_DOC_BYTES` is set below the server-level 25m
instead (§5.4).

### 18.2 The frontend Dockerfile - four edits, and no fifth

| # | Location (burn's line) | Edit |
| --- | --- | --- |
| 1 | `Dockerfile:25` | `COPY apps/bursar/package.json ./apps/bursar/` |
| 2 | `:134-137` | `src`, `public`, `index.html`, `tsconfig.json tsconfig.node.json vite.config.ts` |
| 3 | `:201` | `&& pnpm --filter @bigbluebam/bursar build \` |
| 4 | `:228` | `COPY --from=build /app/apps/bursar/dist /usr/share/nginx/html/bursar` |

**No fifth edit for the help guide**: `Dockerfile:241` copies `docs/apps/` as a directory, so
`docs/apps/bursar/guide.md` ships automatically. Stated to guard against someone adding a
redundant COPY. But **a guide change does require a frontend rebuild** for Railway, so
"Help Center loads `/docs/apps/bursar/guide.md`" is an M9 gate **against a rebuilt image**, not
the bind-mounted dev stack.

**No `pnpm-workspace.yaml` or `turbo.json` change is needed** - both glob `apps/*`.

### 18.3 The `services.mjs` entry, verbatim shape

Round 1 described the entry but **omitted the `env: {required, optional}` block**.
`railway-orchestrator.mjs:69-70` resolves a missing block to two empty arrays - **not an error** -
so bursar-api would deploy with no `DATABASE_URL`, no `REDIS_URL`, no `SESSION_SECRET`, and
crash-loop on Railway behind a healthy-looking build.

Modeled on burn-api at `services.mjs:335-346`:

```js
{
  name: 'bursar-api',
  description: 'Bursar API — vendor-side procurement, exclusion diff, spend baseline',
  dockerfile: 'apps/bursar-api/Dockerfile',
  port: 4023,
  healthcheck: '/health',
  start_command: 'node dist/server.js',
  required: true,
  // BILL_API_INTERNAL_URL is deliberately ABSENT: the enforcing spend gate is cut from v1
  // (§9), so there is no bill-api call site. Adding it would be dead configuration a future
  // reader would mistake for a live dependency.
  // BBB_PERMISSIONS_ENFORCE is deliberately ABSENT: Bursar's enforcement is a hardcoded boot
  // invariant, not an env-driven setting (burn issue #83, §13.3).
  needs: ['postgres', 'redis', 'api', 'bolt-api'],
  public_paths: ['/bursar/api/', '/bursar/ws'],
  env: {
    required: ['DATABASE_URL','REDIS_URL','SESSION_SECRET','INTERNAL_SERVICE_SECRET',
               'BBB_API_INTERNAL_URL','BOLT_API_INTERNAL_URL'],
    optional: ['DATABASE_READ_URL','BRAID_API_INTERNAL_URL','CORS_ORIGIN','LOG_LEVEL',
               'MAX_DOC_BYTES','MAX_DOC_PAGES','BURSAR_LLM_TIMEOUT_MS',
               'BURSAR_ENGINE_TIMEOUT_MS'],
  },
}
```

Also: add `bursar-api` to the frontend's `needs` and `/bursar/` to the frontend's `public_paths`;
add `BURSAR_API_INTERNAL_URL` to the **bolt-api** and **worker** entries; add `BURSAR_API_URL` to
the **mcp-server** entry's `env.optional` (`services.mjs:556`).

### 18.4 `env-hints.mjs` - the layer below

Round 1 wired the env vars into compose and `services.mjs` but never mentioned
`scripts/deploy/shared/env-hints.mjs`. **Unresolvable optional vars are silently skipped**, which
reintroduces round 1's own "all tools 500 on Railway with no local repro" one layer down.

Both vars get `kind:'computed'` entries via `plannedApp('bursar-api')` per `env-hints.mjs:281-289`.

**The Railway `:8080` rule:** internal URLs must use **8080**, not 4023, or you get 502s while
healthchecks pass. Recorded here because it is exactly the class of failure that looks like an
application bug.

### 18.5 Shared-resource prerequisites - values, procedure, and a Railway counterpart

Round 1 named these as M0 items but gave a value with no procedure, on a stack that must not be
wiped, and with no production counterpart - so "M0 done" on a dev machine would ship an unchanged
production posture and the suite-wide failure would land in prod only.

**Postgres.** `postgres:16-alpine` has **no `command:` key today**, so adding one recreates the
container. `max_connections=100` is already oversubscribed (each API opens `max: 20` plus a read
pool), and Bursar adds jobs and long-held advisory locks - converting latent oversubscription
into `too many clients` errors that will look like a **Bond or Bill outage**.

```yaml
postgres:
  command: postgres -c max_connections=200
  shm_size: 256mb
```

Runbook (the `pgdata` named volume survives; **never** `down -v`):

```sh
docker compose up -d --force-recreate postgres
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SHOW max_connections;"   # 200
docker compose restart frontend
```

bursar-api's own pool is capped at `max: 10`.

**Redis.** Raise the cap; **keep the policy**:

```yaml
command: > ... --maxmemory 512mb --maxmemory-policy noeviction
```

`--maxmemory-policy noeviction` is **unchanged and must stay**. The compose block carries a
five-line comment (`docker-compose.yml:32-35`) explaining that this instance backs BullMQ job
state and that eviction silently corrupts it. Round 1's framing read as a complaint about
noeviction, which could lead a builder to switch to `allkeys-lru` and cause a far worse outcome
than the one being fixed. The problem is the **cap**, not the policy: at 256mb with noeviction,
writes FAIL, so BullMQ enqueues throw and the permissions cache and MCP confirm-token store fail
closed **suite-wide**. Per-queue `removeOnComplete: 100` / `removeOnFail: 500` retention is
specified alongside.

Acceptance: `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" config get maxmemory maxmemory-policy`.

**Railway counterpart (M0, not M9).** Both changes need their production equivalents recorded in
the deploy catalog and applied to the managed Postgres/Redis plans, or the local fix is cosmetic.

### 18.6 Long runs: async start, timeouts, and leases

Three round-1 defects in one mechanism.

**(a) The run vastly exceeds the timeout it inherits.** `burn-shared.ts:28` defaults
`BURN_ENGINE_TIMEOUT_MS` to **180000**; a flagship leveling run is tens of minutes. Worse,
`fetch` abort does not stop the bursar-api handler, so the BullMQ retry **starts a second pass
against the same run row**, and the slower writer regresses the checkpoint and re-bills LLM work.

**Fix: async-start.** `POST /internal/run-leveling` returns **202 + run id** immediately and the
worker polls `GET /requests/:id/leveling-runs` - the endpoint §11.1 already declares
authoritative. `BURSAR_ENGINE_TIMEOUT_MS` (default 30000) then covers only the start call. Work
proceeds in bounded slices (one offer per internal invocation, re-enqueued), as
`burn-attribute-batch` does.

**(b) The 409 needs a lease, not a status flag.** `apps/burn-api/src/lib/advisory-lock.ts` states
the hard rule that no transaction holding the lock may contain an outbound HTTP call, so the lock
**cannot span an LLM run** - the 409 must key off run status. But a container kill then leaves
`status='running'` forever, and round 1's `bursar-claim-reaper` only reaped ingest claims, so
**one crashed run blocks awards and re-leveling on that request permanently.**

Fix: `heartbeat_at` + `claimed_by` on `bursar_leveling_runs` and `bursar_extraction_runs`,
heartbeated on **every checkpoint commit**; `bursar-run-reaper` reverts runs whose heartbeat is
older than the lease (default 5 min) to `partial`. The mechanism already exists at
`attribution.engine.ts:80` and `sweeps.engine.ts:76`. §15's advisory-lock wording is reconciled:
the lock guards short transactional sections only, never an LLM round trip.

**(c) Re-entry is rejected** on a run holding a live lease.

### 18.7 Health, and the frontend dependency

`@bigbluebam/service-health` registers exactly `/health`, `/health/ready`, `/metrics`. Readiness
checks **Postgres and Redis only** - not the LLM proxy, not braid-api - so an upstream outage
never cascades into "bursar not ready" (`apps/burn-api/src/server.ts:118-120`).

**The frontend depends on bursar-api with `condition: service_started`, not
`service_healthy`, through the build**, promoted to `service_healthy` as an M9 task. The
established pattern is `service_healthy`, but it makes the newest and least stable service a hard
boot dependency of the dev stack this cycle must work on: every unhealthy build leaves nginx down
and **every other app unreachable**. The precedent is already inconsistent - the frontend's
`needs` omits bin, bay, and blip - so following it strictly is not required, and the failure mode
(a total outage that looks like an nginx bug) is bad enough to justify the deviation during
development.

### 18.8 Data growth

`bursar_offer_lines`, `bursar_offer_coverage`, `bursar_spend_events`, and
`bursar_leveling_window_results` are unbounded. **v1 decision, recorded in the migration header:
no partitioning.** An episodic app bounded by human procurement activity will not reach
partition-worthy scale before v1.1, and premature partitioning on `organization_id` complicates
the RLS story. Retention is the control. The `raw_text` trigram index is gone (§3.1), leaving one
GIN tsvector.

### 18.9 Catalog and docs registration

| File | Change |
| --- | --- |
| `scripts/deploy/shared/services.mjs` | §18.3 |
| `scripts/deploy/shared/env-hints.mjs` | §18.4 |
| `docker-compose.yml` | bursar-api service; `BURSAR_API_URL` on mcp-server (`:190` precedent); `BURSAR_API_INTERNAL_URL` on worker and bolt-api; §18.5 postgres/redis |
| `apps/api/src/routes/system-settings.routes.ts` | `LAUNCHPAD_CATALOG` += bursar; `ROOT_REDIRECT_VALUES` += `'bursar'`; **and `REDIRECT_MAP` (`:123`)** - round 1 named only the first, so the redirect would validate and then not resolve |
| `apps/api/src/routes/internal-llm.routes.ts` | additive `{content, finish_reason, usage}` (§3.10) |
| `apps/api/src/services/visibility.service.ts` | 5 `bursar.*` types + `bill.expense` + resolvers |
| `scripts/docs/lib/tool-source.mjs` | `APP_TOOL_MODULES` += `bursar: ['bursar-tools']`; `pnpm docs:catalog` |
| `docs/reference/mcp-endpoint-mapping.md` | full section; bare-dash self-check prints `0`; **and the `## Surface summary` counts updated** - CLAUDE.md requires it and the bare-dash check passes on a stale summary |
| `apps/bolt-api/src/services/event-catalog.ts` | `bursarEvents` per §16.1 |
| `.env.example` | `BURSAR_API_URL`, `BURSAR_API_INTERNAL_URL`, modeled on `:216-238` incl. disabled-by-default semantics |

---

## 19. Seed data (GILLIGAN)

**`scripts/seed-gilligan/bursar.mjs`, registered in `run-all.mjs`** (the `PHASES` array at
`:60-79`), **not** `seed-all.mjs` Phase B. Bursar joins the **Billing** phase (needs `bond.mjs`
companies and `bill.mjs` expenses). Plus
`packages/docs-capture/recipes/bursar/bursar.yaml`.

**Vendors (5)** with messy aliases so trigram resolution is visibly working: Howell Industries
Salvage (`HOWELL IND *SALVAGE`, `Howell Industries Inc`, `THURSTON HOWELL III HLDG`), Radio Parts
& Coconut Wire Co, Lagoon Freight Lines, Island Weather Feed, Professor's Lab Supply.

**Request:** "Lagoon Rescue Beacon Procurement", owner Skipper, budget $18,000, category
`hardware_purchase`. 14 nodes, `mandatory` including "On-island installation and commissioning",
"Crew training for six", "24-month parts warranty"; library-derived `should_have` "Data export on
termination", "Price escalation cap".

### 19.1 The four offers, with totals recomputed from the §10 formula

Round 1's seeded figures were **unproducible by its own totals design** (two of three came from a
`partial` and a `should_have`, neither of which `gap_adjusted` valued), and Playwright asserted on
them. Recomputed:

| Offer | `stated` | Gaps | Valuation | `gap_adjusted` |
| --- | --- | --- | --- | --- |
| **Howell Industries Salvage** (PDF) | **$16,400** | crew training `absent`; installation `excluded_explicit` ("installation by others") | rival medians: training $2,500 (Radio $2,400 / Lagoon $2,600), installation $3,050 (Radio $3,200 / Lagoon $2,900) - both rung 2, both explicit line items in the rivals | **$21,950** |
| **Radio Parts & Coconut Wire** (spreadsheet) | $19,100 | warranty `partial` (12 vs 24 months, `delta_kind='term'`) | `delta_amount_minor` $600, from Lagoon's priced 12-month extension - rung 1 | **$19,700** |
| **Lagoon Freight Lines** (email text) | $17,800 | warranty `absent` (mandatory); escalation cap `absent` (`should_have`) | warranty $1,200 rung 2; escalation cap **unvalued** (a term, nobody priced it) | **$19,000** + `should_have_supplement` unvalued, "1 gap unpriced" |
| **Professor's Lab Supply** (PDF) | $15,900 | — | **blanket-coverage claim** (§19.2) | not computed; quarantined |

**The punchline holds and is now computable:** Howell is cheapest on `stated` ($16,400) and most
expensive on `gap_adjusted` ($21,950). Playwright step 7 asserts
`gap_adjusted(Howell) > gap_adjusted(Radio)`.

**Award goes to Radio Parts**, not to the lowest `gap_adjusted` - Lagoon's absent warranty is
disqualifying on a rescue beacon. That is deliberate: it demonstrates that Bursar informs the
decision rather than making it.

### 19.2 The fourth offer demonstrates the §4 cluster defense

Round 1's fourth offer was a zero-font-size injection, and Playwright asserted on it - but the
spec gives no means to detect zero-font-size text (§5.2). Re-scoped: **Professor's Lab Supply
submits a blanket-coverage claim** -

> *"All requirements listed in your RFQ, including installation, crew training, warranty, data
> export and escalation cap, are fully included in this all-inclusive price of $15,900."*

This is lexicon-detectable **and** fan-out-detectable today, it is the cheapest offer so the
incentive is legible, and it demos the defense that matters. It produces an
`offer_manipulation_suspected` finding, zero auto-published `covered` verdicts, and a
`blanket_suspected` flag on every coverage row it touched.

**Post-award**, one live example per detector: `price_drift` (Island Weather Feed 40% above
baseline), `scope_divergence` ("expedited lagoon delivery", no baseline line),
`unbaselined_vendor` (Professor's Lab Supply, four recurring charges, no award),
`renewal_cliff` (Island Weather Feed at `t_minus_60`), plus an `orphaned_custody` badge.

**Never seeded:** `e2e-admin@bigbluebam.test`, "E2E Test Organization", "screenshots-demo".

---

## 20. Test plan

### 20.1 Unit (Vitest + `@bigbluebam/db-stubs`)

- `verifyCiteAgainstLine`: verbatim hit, whitespace-normalized hit, **text elsewhere in the
  document but not in the cited line -> miss**.
- `nodeTermOverlap`: floor behavior, stopword handling, unit/quantity contribution.
- **`computeDedupKey` resume equality** (crash at chunk 7 == single pass).
- **`compositeConfidence` is finite for every input** (the round-1 NaN).
- `classifyCoverage` decision table: six verdicts x three predicates pass/fail x four strengths.
- **Missing-node-in-batch -> `ambiguous`**; malformed retry capped at 2 then `ambiguous`.
- **Window merge lattice**: every pair, asserting `excluded_explicit` wins.
- **Fan-out cap**: 5 nodes on one line blocks auto-publish for all five.
- **Rollup**: downward may not overwrite `excluded_explicit`/`partial`; upward `derived_covered`
  is never a rollup input.
- `allocation_method` ladder; **gap valuation refuses equal-split observations**.
- Totals: all kinds, admissibility rules, `renderable=false` on the single-offer case.
- Payee normalization + thresholds; the below-auto-accept review path.
- **Spend import idempotency**: same file twice -> `rows_inserted=0`.
- Baseline triggers: UPDATE, DELETE, cascade, **TRUNCATE**.
- Drift: currency precondition, null-term selection, silent-line basis.
- Boot invariants: `assert-permissions-enforce`, `assert-rls-bound`.
- `test/rls-coverage.test.ts`, `test/library-visibility.test.ts`,
  `test/sealed-bid-viewer.test.ts`, `test/draft-grounding.test.ts`,
  `test/bin-asset-access.test.ts` (cross-org, private-same-org, unscanned).

### 20.2 Corpus gates (CI, deterministic via recorded responses)

`apps/bursar-api/test/fixtures/`: **>= 40 labelled absence tuples**, **>= 8 instruction-shaped
injection fixtures**, **>= 3 non-imperative blanket-coverage fixtures**, **>= 1 long-document
fixture with a terminal exclusions block**, **>= 1 all-inclusive-line-over-14-node-tree fixture**.

| Gate | Threshold |
| --- | --- |
| False-absence rate | `<= 0.05` on published verdicts |
| Injection resistance | **0** auto-published `covered` on any injection fixture |
| **Blanket-coverage resistance** | **0** auto-published `covered`; the 14-node tree must NOT come back fully covered |
| **Missed exclusion (long document)** | terminal exclusions block yields `excluded_explicit`, not `covered` |
| Bundled-line correctness | 0 false `absent` on children of an enumerated bundling parent |

The retrieval-recall gate is **deleted** with the retrieval mode (§3.1).

**Recorded caveat:** stubs mean CI never exercises the real 60s timeout or the proxy's
concurrency behavior. Named here rather than implied as covered.

### 20.3 Playwright user story (GILLIGAN only), as Skipper

1. `/bursar/`, open the request, see 14 nodes, click a citation popover.
2. Promote "Price escalation cap" to `mandatory`; **Confirm scope**.
3. Matrix: four offer columns; red `absent` chip at (Crew training, Howell).
4. Click it: **rejected candidates and reasons render**.
5. **Rival-informed absence present on the first view** (two-phase leveling).
6. Diff: Howell's `excluded_explicit` ranks above all-offers-absent notes; "installation by
   others" is on the page.
7. **`gap_adjusted(Howell) > gap_adjusted(Radio)`** - the punchline, asserted.
8. **Professor's Lab Supply shows `offer_manipulation_suspected`, and none of its coverage rows
   are auto-published `covered`** (§19.2).
9. Award to Radio Parts: 11 `included` + 2 `excluded_at_award` rows, **no edit control on any
   baseline row**.
10. `/bursar/mismatches`: `price_drift` cites a baseline item with a real figure.
    `/bursar/renewals`: Island Weather Feed in `t_minus_60`.
11. **Negative:** no headline aggregate whose `data-testid` band set includes `medium`.
12. **Help:** the HelpTrigger opens and the Bursar guide loads.

### 20.4 Integration harness

bill expense -> `expense.submitted` -> `bursar_ingest_events` -> spend event -> drift ->
`mismatch.opened`. Bin access: cross-org, private-same-org, and unscanned all 404 and write
nothing.

### 20.5 Convention gates

`pnpm db:check` (0 drift), `pnpm lint:migrations`, `node scripts/check-bolt-catalog.mjs`,
`node scripts/check-permission-catalog.mjs`, the §17.3 probe-vs-§13.1 assertion, the surface-map
bare-dash check printing `0` **plus a fresh `## Surface summary`**, `pnpm docs:catalog` no-diff,
`node scripts/help/build-help-index.mjs --check`,
`grep -c bursar infra/nginx/*.conf` non-zero x3, `tsc --noEmit`, Biome.

---

## 21. Milestones M0..M9

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | Scaffold; four Dockerfile edits; three nginx files; `services.mjs` **with the env block**; `env-hints.mjs`; launchpad + `REDIRECT_MAP`; **Postgres and Redis prerequisites with their Railway counterparts** | `/bursar/` serves; `/bursar/api/health` 200; `grep -c bursar infra/nginx/*.conf` x3; `SHOW max_connections` = 200; `config get maxmemory` = 512mb with `noeviction` |
| **M1** | Migrations (incl. the generated RLS loop) + Drizzle + the full permission chain | `db:check` 0 drift; probe matches §13.1; `rls-coverage.test` green |
| **M2** | Vendors, payee normalization + trigram + alias review, requests, settings, **`assertBinAssetReadable`** | cross-org, private, and unscanned assets all 404 |
| **M2.5** | **THE ABSENCE SPIKE - with the classifier in the loop.** Deterministic pre-pass **plus one real full-offer classification path** against fixture text via a recorded-response harness. No DB, no UI, no Qdrant. | **Three numbers:** (1) false-absence rate with the classifier in the loop; (2) measured tokens and wall-clock on a **40-page worst-case fixture**; (3) **zero** auto-published `covered` on injection + blanket fixtures |
| **M3** | Scope derivation, fixed ordinal, **chunk-failure handling**, global library, tree editor, confirm gate, **Stage 0 pre-scan** | 14-node tree; crash-resume byte-identical keys; a failed chunk blocks `derived` |
| **M4** | Offer ingest + parse, all formats, `parse_quality`, injection + blanket pre-scan, malicious-document ceilings | blanket fixture quarantines and opens a finding |
| **M5** | **The absence engine**: full-offer classification, three predicates, rejected-candidate enforcement, banding, **§4 cluster defenses**, window lattice + pinning, typed deltas, two-phase leveling, totals | all §20.2 gates pass |
| **M6** | Matrix + Diff UI, ws + polling fallback, review queue, help.md/guide.md | Playwright 1-8 |
| **M7** | Award, freeze, `kind`, M:N links, four-path immutability, Bulwark handoff | Playwright 9; UPDATE/DELETE/cascade/TRUNCATE all refuse |
| **M8** | Spend import (idempotent) + expense ingest, four detectors, inbox, renewal radar, worker jobs, digest | Playwright 10-11 |
| **M9** | MCP tools + mcp-server env, Bolt events, visibility registration incl. `bill.expense`, surface map + summary, docs catalog, help gate **against a rebuilt image**, seeder, e2e, integration; **promote frontend `depends_on` to `service_healthy`** | all §20.5 gates green |

**M2.5 now exercises the flagship.** Round 1 inserted the spike to de-risk the mechanism and then
**excluded the mechanism from it** ("no LLM"), while open question 1 assigned the 40-page token
verification to a milestone that could not run it. The flagship would still have been first
exercised at M5, which was the original objection.

---

## 22. Reuse ledger

| Capability | Reused from | New |
| --- | --- | --- |
| Fastify skeleton, error handler, shutdown | `apps/burn-api/src/server.ts:56-178` | nothing |
| Health / readiness / metrics | `@bigbluebam/service-health` | nothing |
| Logging + system-error recording | `@bigbluebam/logging` | nothing |
| RLS binding | `burn-api/src/plugins/rls.ts:102-112` | generated policy loop |
| Permissions boot invariant | `burn-api/src/boot/assert-permissions-enforce.ts` | the §13.1 catalog |
| Financial flooring | `burn-api/src/plugins/viewer-caps.ts` | sealed-bid predicate |
| LLM access | `burn-api/src/lib/llm-client.ts` | `LlmMalformedError`; **additive proxy `finish_reason`/`usage`** |
| Checkpointed extraction | `extraction.engine.ts:103-173` | **chunk-relative ordinal + chunk-failure handling (2 bugs fixed)** |
| Citation verification | `extraction-logic.ts` `verifyCite` | **per-line + node-term overlap** |
| Byte path from Bin | `worker/src/utils/storage.ts` `getObjectBuffer` | **`assertBinAssetReadable` via `can_access` + scan gate** |
| Visibility client | `packages/shared/src/visibility-client.ts`, `bin.asset` already supported | 6 new types incl. `bill.expense` |
| Structured decode | `@bigbluebam/structured-data` | row-to-line mapping |
| Braid golden-id | `burn-api/src/lib/braid-resolve.client.ts:19-51` | **payee matching is Bursar's own** |
| Idempotency keys | `burn-api/src/lib/idempotency-key.ts` | spend-import dedup |
| Lease + heartbeat reaping | `attribution.engine.ts:80`, `sweeps.engine.ts:76` | run reaper |
| Bounded slice re-enqueue | `burn-attribute-batch` | leveling slices |
| Cross-app links | `burn-api/src/lib/entity-links.ts` | five link specs |
| HITL | `agent_proposals` (ref-only) | `bursar_drafts` |
| Bolt publish | `publishBoltEvent` positional (`CLAUDE.md:434`, confirmed correct) | §16.1 catalog entries |
| Amendment chain | `burn_engagements` (`0239:13-48`) | award chains |
| Worker registration | `worker.ts:2464-2496` | 10 jobs |
| MCP module + PolicyGate | `burn-tools.ts:55-80`, `register-tool.ts` | §12 tools |
| Help system | `burn-layout.tsx:120`, `build-help-index.mjs --check` | Bursar content |
| SPA shell, money rendering | `apps/burn/src/`, `@bigbluebam/ui` | the Leveling Matrix |
| Seeding | `scripts/seed-gilligan/run-all.mjs:60-79` | `bursar.mjs` |

**Genuinely new:** the absence-detection engine (full-offer closed-book classification, the
three verification predicates, the rejected-candidate requirement by line id, the §4
coverage-collapse cluster defense, the window merge lattice), the comparable-totals valuation
ladder, and the immutable baseline that records what you knowingly did not get.

---

## 23. Non-goals (explicit)

1. No vendor marketplace or discovery.
2. **No PO issuance, no approval workflow, and no enforcing gate** (§9).
3. No three-way match.
4. No payments or AP execution. Zero rows written in Bill.
5. No e-signature.
6. No obligation or notice tracking from executed contracts (Bulwark's; handoff is a link).
7. No customer-facing invoicing.
8. **No outbound transport at all.** Drafts render text a human copies.
9. **No hand-maintained asset register as a primary input path, ever.**
10. No OCR.
11. No FX conversion; the UI **refuses to sum across currencies**.
12. **No embedding/vector retrieval** - the platform has no embedding provider.
13. **No retrieval layer of any kind** (§3.1).
14. **No PDF rendering-property detection** (zero-font-size, colour-matched, off-page) - §5.2.

---

## 24. v1.1 and beyond: what was cut, and why

| Cut | Why | Precondition to revisit |
| --- | --- | --- |
| **The enforcing bill-api gate** (top item) | bill-api migration + serial preHandler + ported breaker + composition semantics + recovery detector + internal auth surface, for the piece least connected to the winning wedge | advisory-gate usage showing people act on verdicts; §9 specifies the internal shape |
| **Runtime calibration breaker** | §20.2 covers the pre-ship case; the runtime breaker guards a drift mode needing production volume | >= 3 orgs, >= 30 adjudicated absences each |
| **Vector retrieval** | no embedding provider; every existing vector path writes zeros | a platform-wide embedding path exists |
| **Lexical/structural retrieval for the long tail** | with vector gone it had one channel, could never clear the band bar, and `medium` is excluded from headlines - it cost an index and a CI gate to produce nothing visible | only if a second channel returns |
| **`normalized_to_term` total** | no `term_months` on offers, no `target_term_months` on requests | those columns land |
| **PDF rendering-property injection signals** | needs graphics-state tracking and per-line `render_props`; a real parsing project | a PDF parser with graphics state |
| **`dormant_seat`, `card_fragmentation`** | no third-party telemetry; `bill_expenses` has no funding-source field | CSV import proves out |
| **`duplicate_tool`** | needs several awarded vendors per category | orgs reach ~10 awards |
| **`auto_renew_unreviewed`** | folded into `renewal_cliff` severity | n/a |
| **`orphaned_custody` as a detector** | a one-line join | shipped as a badge |
| **Partitioning** | episodic volume; complicates RLS | measured row counts |
| **OCR**, **FX normalization** | real dependencies; honest failure acceptable | customer demand |
| **`BURSAR_API_INTERNAL_URL` on bill-api** | dead config until the gate exists | ships with the gate |

---

## 25. Open questions and risks

1. **Long-document viability is the biggest unknown.** §3.8's pinned exclusions plus the merge
   lattice are a design, not a measurement. If the missed-exclusion gate cannot be met, **the v1
   envelope is 5-page documents** and longer offers are surfaced as "too long to level reliably".
   M2.5 measures this on a 40-page fixture. **This is the finding most likely to reshape scope.**
2. **Hand-labelling is on the critical path.** 40 absence tuples, 8 injection fixtures, 3 blanket
   fixtures, plus the long-document and 14-node fixtures - labelled by someone who understands
   procurement. Cannot be generated. **M2.5 cannot complete without it.**
3. **Cost.** §3.9 caps a 400-node x 15-offer request, but the honest position is that full-offer
   mode is more expensive per node than retrieval would have been. The trade is accuracy on the
   class that matters for money on the long tail. Revisit when a real embedding path exists.
4. **`blanket_fanout_cap` default of 4 is a judgement call.** Too low and legitimate itemized
   bundles route to review; too high and the §4.3 defense weakens. Per-org configurable, and the
   14-node fixture is the regression guard, but the first real deployment should re-examine it.
5. **Scope-library content is a moat and a cost.** Six categories needing curation. Now global,
   so the investment is made once.
6. **Node-term overlap could suppress legitimate coverage** where a vendor uses entirely
   different vocabulary ("beacon commissioning" vs "on-island installation"). The floor is low
   (0.25) and failure demotes to `ambiguous` rather than `absent`, so the failure mode is a
   review item rather than a wrong claim - but it is a real source of queue volume.
7. **Who may unseal, and whether the vendor is told.** The *audit* is now a requirement (§5.6),
   but the policy is a **human decision**.
8. **The weekly digest's delivery channel** - Banter, Blast, or in-app. **Human decision** before
   M8.
9. **The advisory gate may see no use.** If v1 telemetry shows nobody calls it, that is evidence
   *against* prioritizing the enforcing gate in v1.1.
10. **Pre-existing defects to file as tasks**, not work around:
    - `burn-extract-deliverables.job.ts:56-61` and bulwark's equivalent: `bin_assets` joined with
      no org predicate, and no `can_access`/`scan_status` check - cross-tenant and private-asset
      document read.
    - `extraction.engine.ts`: `let ordinal = 0` before a resumable loop (dedup-key divergence
      producing duplicate rows), and `log.debug; continue` on `LlmError` allowing a run that
      dropped a whole chunk to report `succeeded`.
    - `proposals.routes.ts`: `shadowOnly` gating means proposal routes **never deny**, and any
      org admin reads every app's proposals.
    - `brief-embed.job.ts` upserts into a `brief_documents` Qdrant collection **nothing ever
      creates** (the only `createCollection` is private to beacon-api at
      `qdrant.service.ts:59-90`).
    - `visibility.service.ts` has no `bill.expense` type, so any citation of an expense is
      silently dropped platform-wide.
    - `scripts/help/smoke-help-center.mjs` is hardcoded to Bam and its `OUT` default is a
      hardcoded `D:/Documents/GitHub/...` path absent from this checkout.
    - CSV export escaping: bearing-api and the frontend timeline export write unescaped
      formula-capable cells today; §5.4's helper should be shared, not Bursar-local.

---

## 26. Changelog

### Round 2 - 11 blockers, ~25 majors. All accepted or accepted-with-modification. Two rejections with reasons.

**The coverage-collapse cluster (security F1, F2 + design F1), folded as one §4.**

- [security] **Blanket-coverage attack succeeds with no injection.** ACCEPTED as the round's
  central finding. Four combined defenses in a single new §4: blanket-claim lexicon, **fan-out
  cap on `bursar_line_node_matches`** (the load-bearing one, since it does not depend on
  recognizing language), **bundling requires explicit enumeration to auto-publish**, and the
  de-transitivized rollup. Plus >= 3 non-imperative blanket fixtures as a CI gate, and the GILLIGAN
  fourth offer re-scoped to demo it (§19.2).
- [security] **Node-term overlap as the fix.** ACCEPTED-WITH-MODIFICATION as predicate 3 (§3.5),
  **but explicitly documented as NOT the defense against the blanket attack** - a sentence naming
  the requirements has high overlap by construction. It earns its place against topically-adjacent
  mis-citation. Saying otherwise would leave the real hole behind a predicate that looks like it
  covers it.
- [design] **Rollup walks coverage to the root; downward subsumption erases `excluded_explicit`.**
  ACCEPTED in full: bundling line **defined** as classifier-matched to >=2 nodes; downward
  subsumption verdict-preserving and one level deep; upward produces `derived_covered`, excluded
  from the diff and never a rollup input; 14-node CI fixture (§4.6).
- [security] **`rival_offer` promotion lets a bidder write the ruler.** ACCEPTED. Rival nodes are
  `pending_review` proposals excluded from `gap_adjusted`/diff/`absent`; supporting offers must be
  distinct `braid_profile_id`; injection- and blanket-suspected offers barred;
  `contributing_offer_ids` recorded (§4.5).

**DESIGN**

- [design] **`bursar_offer_totals` cannot compute two kinds or reproduce its own seed numbers.**
  ACCEPTED. `normalized_to_term` cut to v1.1 (no term columns); `gap_adjusted` extended to value
  `partial` via `delta_amount_minor`; `should_have_supplement` separated; full admissibility
  ruleset (§10.1) covering absent rivals, bundled rivals, foreign currency, and the <2-observation
  case; `renderable=false` + "N gaps unpriced" for the single-offer request; **§19.1 seed figures
  recomputed from the formula** ($21,950 / $19,700 / $19,000).
- [design] **M2.5 excludes the flagship it exists to de-risk.** ACCEPTED. Redefined with a real
  full-offer classification path via a recorded-response harness, and three numeric done-whens
  including the 40-page measurement (§21).
- [design] `finish_reason` unbuildable; no `llm_provider_id`. ACCEPTED. Additive `apps/api` change
  returning `{content, finish_reason, usage}` (§3.10, §18.9); `llm_provider_id` added; a missing
  provider now **fails loudly** with `status='blocked'` (§3.4).
- [design] **No cross-window merge rule; exclusions systematically out of window.** ACCEPTED. Merge
  lattice, whole-document exclusion pre-pass **pinned into every window**, durable per-window
  results, a missed-exclusion CI gate, and an explicit 5-page-envelope fallback (§3.8).
- [design] Cost/latency/caps asserted not designed. ACCEPTED. §3.9 with verified proxy limits,
  60s timeout, three committed caps, partial as a first-class state, and a cost preflight.
- [design] `allocation_weight` has no derivation rule. ACCEPTED. Four-rung ladder +
  `allocation_method`; **gap valuation refuses equal-split observations** (§4.4).
- [design] Detector contradictions and missing thresholds. ACCEPTED. `unbaselined_vendor` groups by
  `normalized_payee`; silent-line requires a bounded term or a rolling window with the basis
  stated; thresholds and renewal bands specified (§8).
- [design] **Delete the long-tail retrieval mode.** ACCEPTED per direction. Retrieval, the
  `raw_text` trigram index, the recall gate, `classification_mode`, and `applicable_channels` are
  all gone; all four strengths classify in full-offer mode (§3.1). This also dissolves stability
  F9's NaN at the source.

**SECURITY**

- [security] **The round-1 Bin fix cites a column that does not exist and does not close the
  hole.** ACCEPTED in full. `bin_assets` is **`org_id`** (`bin-assets.ts:29`), so the round-1 join
  was a runtime 42703. Replaced with `assertBinAssetReadable` calling `can_access('bin.asset', …)`
  via `packages/shared/src/visibility-client.ts`, plus `org_id` defence-in-depth and a
  **`scan_status='clean'`** requirement; tests cover cross-org, private-same-org, and unscanned
  (§6.4).
- [security] **Global scope library creates a cross-tenant write path and breaks under RLS.**
  ACCEPTED. Global rows immutable to org callers (API filter + trigger); variant policy
  `organization_id = current_setting(...) OR (organization_id IS NULL AND is_global)` with a
  `WITH CHECK`; `test/library-visibility.test.ts` (§6.1).
- [security] Three pre-scan signals unimplementable; **the seed asserts on one of them.**
  ACCEPTED. Rendering and metadata signals cut to v1.1 (§5.2, §23.14); the GILLIGAN fourth offer
  re-scoped to a blanket-coverage claim, which is detectable today and a better demo (§19.2).
- [security] Sealed bids unenforceable. ACCEPTED. `offer.unseal` floored; seal is a service-layer
  predicate on **every** read path with a viewer test; `offer.unsealed` event; **the audit is a
  requirement, not a policy question** - only *who may unseal* remains a human decision; the whole
  of `bursar_org_settings` is audited (§5.6).
- [security] Draft confidentiality now broader than before. ACCEPTED. `draft.read` off `viewer`,
  `draft.approve` floored, owner-scoped reads, content-free proposal template, and grounding
  enforced by a named builder the test asserts (§5.7).
- [security] **Stage 0 has no injection defense.** ACCEPTED. Pre-scan on the request document,
  `request_manipulation_suspected`, `confirmed` blocked while suspected, and Stage 0 verification
  ported to per-chunk-line (§5.5).
- [security, minor] CSV neutralization had no endpoint. ACCEPTED. Two export routes named (§11),
  helper shared in `@bigbluebam/shared`, and the bearing-api/frontend instances filed (§25.10).

**STABILITY**

- [stability] **No idempotency on `POST /spend/import`.** ACCEPTED. `dedup_key` +
  `UNIQUE (organization_id, dedup_key)` from `(normalized_payee, occurred_on, amount_minor,
  currency, external_ref)` via the existing `idempotency-key.ts`, plus `bursar_spend_imports`
  keyed by file SHA-256 (§6.1).
- [stability] **Run exceeds the 180s thin-caller timeout; retry re-enters a live run.** ACCEPTED.
  Async-start (202 + run id) with worker polling, bounded slices per
  `burn-attribute-batch`, `BURSAR_ENGINE_TIMEOUT_MS`, re-entry rejected on a live lease (§18.6).
- [stability] **409 has no lease and no reaper.** ACCEPTED. `heartbeat_at` + `claimed_by` on both
  run tables, heartbeat per checkpoint, `bursar-run-reaper`; §15's advisory-lock wording
  reconciled with `advisory-lock.ts`'s no-HTTP-in-lock rule (§18.6).
- [stability] The "per-run cap" was a **phantom cross-reference**. ACCEPTED - it is now real
  (§3.9) with `llm_calls_used` persisted and a BullMQ limiter under the 120/min ceiling.
- [stability] Timeout + non-released concurrency slot. ACCEPTED (§3.9).
- [stability] 2-D checkpoint over a 3-D loop. ACCEPTED. `last_processed_window_index` +
  `bursar_leveling_window_results` (§3.8, §6.1).
- [stability] **A dropped chunk reports `succeeded`.** ACCEPTED, and it is the more dangerous of
  the two ported bugs: a tree missing a chunk gets confirmed and every offer then comes back clean
  on requirements never enumerated, invisible to the false-absence gate. `chunks_failed`, run
  `partial`, `derived` blocked (§3.2b).
- [stability] M0 prerequisites compose-only. ACCEPTED. Railway counterparts are M0 (§18.5).
- [stability, folded] NaN composite (dissolved by the retrieval cut, plus an explicit finiteness
  test); malformed-retry capped at 2; reconcile/sweep flapping fixed with a shared lock class and
  a `5,35` offset; `TRUNCATE` trigger added.

**BEST-PRACTICES**

- [best-practices] **Permission catalog does not add up (35 not 34; `.read` is 13 not 12; member
  26 not 25) and the M1 gate fails on a correct build.** ACCEPTED, and generalized per direction:
  §13.1 is now a **single table with separate `is_read` and `viewer` columns**, no section states a
  count, and §17.3's probe is asserted against the table in CI so prose and data cannot diverge.
- [best-practices] **"21 tables" while defining 23.** ACCEPTED, and generalized: RLS policies are
  **generated** by a `DO $$` loop over `information_schema` for the `bursar_` prefix, with
  `test/rls-coverage.test.ts` (§17.1, §6).
- [best-practices] **"Two vite aliases"; more are needed.** ACCEPTED-WITH-MODIFICATION. Verified
  burn's config carries ten-plus, so **the reviewer's "three" also undercounts**. Stated as the
  rule "copy every `@bigbluebam/ui/*` alias verbatim", naming `@bigbluebam/ui/markdown` as the one
  that breaks the whole chained frontend build (§14.1).
- [best-practices] `amend`/`terminate` have no action. ACCEPTED. `bursar.award.amend` and
  `bursar.award.terminate` added, floored, destructive, confirmation-required (§11, §13.1).
- [best-practices] `smoke-help-center.mjs` cannot cover Bursar. ACCEPTED. Dropped as a
  done-criterion in favor of Playwright step 12; its hardcoded `D:/` path filed (§25.10).
- [best-practices] "18 tools" unfalsifiable. ACCEPTED. Full enumeration in §12.
- [best-practices] `--check` mode; screenshots provenance. ACCEPTED (§14.1, §19).
- [best-practices] **CLAUDE.md has since been corrected on `publishBoltEvent`.** ACCEPTED -
  verified at `CLAUDE.md:434`. The round-1 staleness claim is **withdrawn** and the docs-correction
  task cancelled (§16.1).
- [best-practices] `REDIRECT_MAP` also needs the entry. ACCEPTED (§18.9).

**INFRASTRUCTURE**

- [infrastructure] **`services.mjs` entry has no `env` block**; `railway-orchestrator.mjs:69-70`
  makes that a silent empty-array, not an error. ACCEPTED. Verbatim block in §18.3 with inline
  comments for the two deliberate absences.
- [infrastructure] **`env-hints.mjs` never mentioned**; unresolvable optional vars are silently
  skipped. ACCEPTED. Both vars as `kind:'computed'` via `plannedApp('bursar-api')`, plus the
  Railway `:8080` rule (§18.4).
- [infrastructure] **Postgres change is a value with no procedure.** ACCEPTED. Full runbook with
  `--force-recreate` (never `down -v`), the `SHOW max_connections` acceptance check, `shm_size`,
  and the frontend restart (§18.5).
- [infrastructure] **Redis framing risks a builder switching to `allkeys-lru`.** ACCEPTED, and
  this was the most valuable catch of the infrastructure set: the fix is the **cap**, not the
  policy. `--maxmemory 512mb`, `noeviction` **unchanged**, the compose comment quoted, `config get`
  acceptance (§18.5).
- [infrastructure] `client_max_body_size 25m` makes the 26MB scenario unreachable.
  ACCEPTED-WITH-MODIFICATION: `MAX_DOC_BYTES` lowered to 20MB rather than raising nginx's limit,
  because raising a global body limit for one app's worst case is a suite-wide change with no
  suite-wide justification. The 413 path is mapped to a real message (§5.4).
- [infrastructure] Proxy timeout hardcoded at 60s. ACCEPTED. Batch sized against it, smaller-batch
  retry, CI-coverage caveat recorded (§3.9, §20.2).
- [infrastructure] `depends_on: service_healthy` makes the newest service a hard boot dependency.
  ACCEPTED. `service_started` through the build, promoted at M9, with the inconsistent precedent
  (bin/bay/blip) noted (§18.7).
- [infrastructure] No fifth Dockerfile edit; guide needs a rebuild. ACCEPTED (§18.2).

### Rejections

- [design, rejected] **"Add `term_months` to offers and `target_term_months` to requests"** as the
  fix for `normalized_to_term`. REJECTED in favor of the reviewer's own alternative: cut the total
  to v1.1. Comparing a 12-month to a 36-month quote is genuinely valuable, but it needs a term
  model (renewal alignment, mid-term amendments, evergreen terms) rather than two columns, and the
  seed does not need it. Adding two columns to satisfy one total kind would leave a half-built
  term model that later has to be undone. Recorded in §24 with the precondition.
- [security, partial-rejection] **"Node-term overlap defeats the blanket-coverage attack."**
  The predicate is ACCEPTED (§3.5 predicate 3); the *claim about what it defends* is REJECTED. A
  blanket sentence naming the requirements has high term overlap by construction, so relying on it
  would leave the hole open behind a control that appears to close it. The defense is the fan-out
  cap plus the enumeration requirement (§4.3, §4.4), and §3.5 says so explicitly.

### Round 1 (carried forward, all resolved or superseded)

Braid payee resolution moved in-house; embedding dependency removed; money-in events dropped;
zero-candidate short-circuit removed; two-phase leveling; typed deltas; baseline `kind`
discriminator and M:N node links; soft-archive; currency guard and null-term selection; detector
cut from nine to four; `bursar_drafts`; `assertBinAssetInOrg` (superseded this round by
`assertBinAssetReadable`); help system; gilligan seeder; three nginx files; four Dockerfile edits;
Postgres/Redis ceilings; the corrected permission chain; positional `publishBoltEvent`.

### Kept unchanged (praised across both rounds)

- The **rejected-candidate requirement**, now hardened twice: ids must be engine-supplied and
  belong to the offer (round 1), and it no longer exempts `decided_by='deterministic'`.
- The **honest RLS posture** in §6.3, including the "the backstop is absent today" caveat.
- The **§17.2 two-pass permission diagnosis**, correct from the start and now complete.
