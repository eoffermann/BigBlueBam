# Bursar - App Design Specification

> ## STATUS: BUILD-READY
> Three adversarial review rounds complete (13 + 11 + 13 blockers, all folded). No round 4.
> This document is the authoritative build input. Where it disagrees with the session
> submission, this document wins; where it disagrees with the monorepo, the monorepo wins and
> §25 records the discrepancy.

**Session:** 2026_07_19_20_05
**Winner:** Bursar (4.80 mean, 24 raw total), co-authored by Seat B (data/intelligence lens)
and Seat D (vertical wedge lens). Seat E withdrew its competing Ballast entry in Bursar's
favor.
**App id:** `bursar` | **API:** `bursar-api` internal `:4023` | **SPA:** `/bursar/`, dev `:3023`

> **Counting rule.** No section states a count in prose. Permissions are counted by the §17.3
> probe against the §13.1 table. Tables are enumerated by a generated RLS loop over the
> `bursar_` prefix. Bolt events, MCP tools, and nginx files are enumerated tables referenced by
> name. Seed figures have exactly one source (§19.3).

---

## Table of contents

1. Overview and positioning
2. The category boundary
3. The absence-detection engine
4. The coverage-collapse cluster
5. Adversarial input
6. Data model
7. Baseline and post-award drift
8. Detector catalog
9. `bursar_scope_gap` (advisory only)
10. Comparable totals
11. API surface
12. MCP surface
13. Permissions
14. Frontend and help
15. Background work
16. Events and integration
17. Migration plan
18. Infrastructure
19. Seed data (GILLIGAN)
20. Test plan
21. Milestones
22. Reuse ledger
23. Non-goals
24. v1.1 and beyond
25. Open questions and risks
26. Changelog

---

## 1. Overview and positioning

### 1.1 One-liner

One canonical record per vendor and per scope, so you can see what each bidder quietly left out
before you sign, and exactly what you got billed for that nobody agreed to after.

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

**This is absence detection, not summarization.** The product's entire claim is that a gap is
*reported*. §4.7's diff-completeness invariant exists because every defense in §4 terminates in
"does not auto-publish", and an unpublished node that silently vanishes from the diff delivers
the attacker's goal anyway.

**Award** freezes the accepted tree as an immutable baseline, recording both what you got and
what you knowingly did not get. **Post-purchase**, the same spine drives the mismatch set (§8).

### 1.4 Where the data comes from

Pre-award runs on uploaded documents and works on day one. **Post-award is fed predominantly by
CSV statement import, not platform events**: `bill_expenses` has no funding-source field, there
is no AP ledger in the platform, and `bill_invoices`/`bill_payments` are money-in
(`bill-invoices.ts:23 client_id`; `bill-payments.ts invoice_id NOT NULL`). Onboarding is "upload
last year's statement", not "connect your ledger".

### 1.5 Cadence

Episodic. The retention mechanism is a **weekly digest** (§15), not a daily dashboard.

---

## 2. The category boundary

| App | Counterparty role | Document state | Ledger row? |
| --- | --- | --- | --- |
| **Bill** | Customer pays *us* | invoice we issue | yes |
| **Burn** | Customer pays *us* | signed SOW | yes |
| **Bulwark** | Counterparty signed *with us* | executed contract | yes |
| **Bursar** | **We pay the vendor** | **unsigned offers from non-counterparties** | **no** |

1. **Pre-counterparty.** Bulwark extracts obligations from an *executed* contract. Bursar works
   on offers from parties who signed nothing, producing no clause, no obligation, no ledger row.
2. **Absence versus presence.** Burn and Bulwark answer "what does this commit us to." Bursar
   answers "what does this conspicuously fail to commit them to."

**The enforceable boundary is §6's table list**: Bursar defines no obligation table, no
notice-deadline table, no work-item table, no invoice table, and writes zero rows in Bill, Burn,
or Bulwark. The Bulwark handoff is an `entity_links` row plus a deep link.

---

## 3. The absence-detection engine

### 3.0 Thesis

Enumerate the candidate space deterministically (the scope tree), then ask a bounded, per-node,
closed-book question with the offer's lines as typed data: *"Here is requirement R and here are
the lines of this offer. Does any cover R? Answer by `offer_line_id`."* The model can only be
wrong about nodes we enumerated; a wrong `covered` is catchable by §3.5's predicates; a wrong
`absent` is measurable (§20.2).

### 3.1 One classification mode: full offer, all strengths

**v1 has no retrieval layer.** No embedding provider exists (`brief-embed.job.ts` and
`beacon-vector-sync.job.ts:123` both write zero vectors; `internal-llm.routes.ts` exposes only
chat). The lexical/structural fallback was also cut: with vector gone it had one channel, could
never clear the band bar, and `medium` is excluded from headlines.

Every node of every strength is classified in full-offer mode: the complete line set as a typed
`{offer_line_id, raw_text}` array. No retrieval means no retrieval-recall failure mode.

**Token math.** 300 lines at ~25 tokens = ~7,500 tokens; plus nodes, instructions, schema,
~8,500 per call. Batching 6 nodes against one shared line array amortizes the payload.

**Sliding windows** apply beyond `max_lines_per_window` (default 250, overlap 50), merged by
§3.8's lattice.

### 3.2 Stage 0 - scope-tree derivation (the ruler)

| Precedence | `derived_from` | Source | Default strength |
| --- | --- | --- | --- |
| 1 | `request` | the buyer's RFQ/RFP/SOW (a Bin asset) | `mandatory` |
| 2 | `library` | category template | `should_have` |
| 3 | `rival_offer` | union-of-rivals (§4.5) | `nice_to_have`, **never auto-published** |
| 4 | `human` | hand-added | as set |

Runs the checkpointed chunk loop ported from `extraction.engine.ts:103-173`, with **three fixes
to the port**:

**(a) Chunk-relative ordinal.** The original declares `let ordinal = 0` before the loop while
`startChunk` skips ahead on resume, producing different `dedup_key` values and **duplicate
rows** - in Bursar, a duplicated matrix row across every offer. Bursar's ordinal is
`${chunkIndex}:${indexWithinChunk}`; `test/dedup-key.resume.test.ts` asserts byte-equality.

**(b) A dropped chunk cannot report success.** The original does `log.debug; continue` on
`LlmError` and finishes `succeeded`. A tree missing a chunk would be confirmed and **every offer
would come back clean on requirements never enumerated** - invisible to the false-absence gate,
because the node does not exist. Bursar counts `chunks_failed`, lands `partial`, **blocks
`scope_status` from `derived`**, and surfaces "we could not read N sections" with chunk ranges.

**(c) Per-chunk-line span verification**, not whole-document (§5.5).

**Derivation is async-start, exactly as leveling is** (§18.6). Round 2 applied that fix to
leveling only, leaving `bursar-derive-scope` a synchronous thin caller that reproduces the same
blocker on Stage 0: a multi-chunk RFQ aborts the caller, fetch-abort does not stop the handler,
BullMQ retries, and two writers on one `last_processed_chunk` regress it - **which defeats fix
(a), since divergent ordinals are precisely what duplicates matrix rows.**
`POST /internal/run-derivation` returns 202 + run id, the worker polls, work is bounded to one
chunk per invocation, and re-entry on a live lease is rejected.

**The tree must be human-confirmed before verdicts publish.** `scope_status`:
`pending` -> `deriving` -> `derived` -> `confirmed`. An unconfirmed tree yields `provisional`
verdicts and no Bolt event. An injection-suspected request cannot reach `confirmed` (§5.5).

### 3.3 Stage 1 - parse into lines (deterministic, no LLM)

Worker `bursar-parse-offer` reads bytes via `getObjectBuffer`
(`apps/worker/src/utils/storage.ts`, which wraps `@bigbluebam/storage`; not itself a storage
export).

| Format | Path |
| --- | --- |
| plain text / email | UTF-8 decode |
| PDF with text layer | `Tj`/`TJ` show-operator extraction (`burn-extract-deliverables.job.ts:30-43`) |
| CSV / TSV / JSONL / XLSX-exported | `@bigbluebam/structured-data` codecs |
| scanned image PDF | **no OCR** -> `unparseable`, never levelled |

`parse_quality` (0.0-1.0) from extracted characters per page, structured-line ratio, and
currency/quantity token presence. Below `parse_quality_floor` (default 0.35) -> `unparseable`,
and **such an offer can never produce `absent`** - "we could not read it" is not evidence of
omission.

Lines carry `raw_text` (bounded 4,000), `char_start`/`char_end`, `page`, `ordinal`, parsed
`quantity`/`unit`/`unit_price_minor`/`extended_minor`, `line_role`
(`base`/`option`/`alternate`/`allowance`/`note`, only `base` counts toward coverage and totals).

Progress logging before the byte read, before the parse, before the handoff.

### 3.4 Stage 2 - classification

**Deterministic pre-pass, whole-document:** the exclusion lexicon (hits pinned into every
window, §3.8); the blanket-claim lexicon (§4.2); exact structural match on quantity + unit.
**No zero-candidate short-circuit.**

**LLM classification** via the internal proxy as `apps/burn-api/src/lib/llm-client.ts:59-102`,
with `X-Internal-Service: bursar`.

| Failure | Handling |
| --- | --- |
| `LlmThrottledError` (429) | **defer.** Run `partial` at checkpoint; retry resumes. Never a default verdict. |
| `LlmError` | `ambiguous`/`pending_review`, never `absent` |
| `LlmMalformedError` | truncated JSON or `finish_reason === 'length'` (§3.10). Retry at a smaller batch, **capped at 2**, then `ambiguous` |
| Node missing from a batch response | **`ambiguous`, retried individually. Never `absent`.** |
| No LLM provider configured | run **fails loudly**, `status='blocked'`, settings deep link |

**Six verdicts:** `covered` (line id + span verifying against that line + node-term overlap),
`partial` (citation + typed deltas), `excluded_explicit` (citation of the exclusion language),
`absent` (**non-empty rejected set by line id**), `ambiguous`, `not_applicable`.

### 3.5 Stage 3 - three verification predicates

1. **Span verifies against the cited line**, not the document. Defeats instruction-shaped
   injection.
2. **Rejected-candidate requirement for `absent`**: non-empty, by `offer_line_id`, each id
   validated as belonging to this offer.
3. **Node-term overlap**: minimum lexical overlap between the cited line and the node's
   distinctive terms (title tokens minus stopwords, plus unit/quantity). Below
   `node_term_overlap_floor` (default 0.25 Jaccard over stemmed tokens) -> `ambiguous`.

**Predicate 3 is NOT the defense against blanket coverage.** A blanket sentence that names the
requirements has *maximal* overlap by construction. Predicate 3 catches topically-adjacent
mis-citation. The blanket family is defeated by §4, and saying otherwise would leave the hole
behind a control that looks like it closes it.

Any predicate failing demotes `covered`/`partial`/`excluded_explicit` to
`ambiguous`/`pending_review`.

### 3.6 Stage 4 - banding and HITL

```
score = w1*evidence_strength + w2*classifier_self_report
      + w3*(span_verified_against_line ? 1 : 0) + w4*node_term_overlap
      - penalty(parse_quality below target)
      - penalty(window_coverage incomplete)
```

`test/confidence-no-nan.test.ts` asserts a finite score for every input.

| Band | Rule | Behavior |
| --- | --- | --- |
| `high` | `>= 0.85`, all three predicates pass, complete window coverage, **and §4 caps not tripped** | auto-published |
| `medium` | `0.60 - 0.85` | caution chip, `needs_review`, **excluded from every headline figure** |
| `low` | `< 0.60`, `ambiguous`, or the mandatory bar unmet | HITL, not published |

**The asymmetric rule.** False absence destroys trust in one screenshot; a false present merely
leaves the customer where they were.

> **`mandatory` + `absent` is publishable only if EITHER
> (A) the offer parsed cleanly (`parse_quality >= floor`) with complete window coverage;
> OR (B) a human has confirmed it.**

**Suspicion flags do not gate `absent`.** `blanket_suspected` and `injection_suspected` block
auto-published **`covered`** and nothing else. Round 2 had them gate the mandatory-absent bar
too, which meant **one word bought a vendor immunity from the flagship output**: writing
"turnkey" once suppressed every published gap against them. A blanket claim is evidence *for*
absence, not against it. Only parse-quality and window-coverage - the genuine "we could not read
it" conditions - precondition `absent`.

**HITL destinations:** internal adjudication is `review_status='pending_review'` at
`/bursar/review`. Anything leaving the building is a `bursar_drafts` row with a content-free
`agent_proposals` summary. **No outbound transport exists in v1.**

### 3.7 Typed deltas

`delta_kind` (`quantity`/`term`/`tier`/`allowance`/`alternate`/`option`/`geography`),
`delta_quantity`, `delta_unit`, **`delta_amount_minor`** - the last is what lets a `partial`
contribute to `gap_adjusted` (§10).

### 3.8 Window merge lattice and pinned exclusions

Real proposals put exclusions in a terminal block hundreds of lines from the priced line, so the
exclusion and its target are frequently never in the same window - a systematic false-`covered`
generator invisible to a false-absence gate.

**Merge lattice**, per `(offer, node)` across windows, highest wins:

```
excluded_explicit  >  partial  >  covered  >  ambiguous  >  absent
```

**Exclusion pinning.** Lexicon hits are pinned into every window regardless of boundaries.

**Pinned lines are exempt from the fan-out count ONLY for the verdict the exemption exists for.**
A pinned line's matches count toward fan-out **unless the resulting verdict is
`excluded_explicit`**. Round 2's blanket exemption was readable off the spec: *"Nothing is
excluded: installation, crew training and warranty are all provided under this price"* takes the
`exclusion_hit` flag, gets pinned everywhere, and was then exempt from the load-bearing defense.
`test/fanout-pinned.test.ts` covers it.

**Per-window results are durable** (`bursar_leveling_window_results`), and **"continue" resumes
the same run row** - `partial` -> `running` with a new `claimed_by`, checkpoint preserved. If it
minted a new run, earlier windows would be invisible, `window_coverage` would land `partial`,
and a mandatory `absent` would demote to `ambiguous`, **permanently suppressing the headline
finding after any throttle.** The lattice reads by `(offer_id, scope_node_id)` scoped to the run.

**Gate:** a long-document fixture with a terminal exclusions block must yield
`excluded_explicit`. **If unmeetable, the v1 envelope is 5-page documents** and longer offers are
surfaced as "too long to level reliably" rather than levelled badly.

### 3.9 Cost, latency, and caps

Verified constraints: proxy concurrency 4/service and rate 120/min (`apps/api/src/env.ts:115-116`);
proxy upstream deadline **hardcoded 60s** (`internal-llm.routes.ts:325`); an aborted client does
**not** release the concurrency slot for 90s; burn's inherited `LLM_TIMEOUT_MS` of 15000 would
abort routinely.

- `BURSAR_LLM_TIMEOUT_MS` default **60000**, matching the proxy's own deadline.
- A timeout **retries at a smaller batch**, never the same size.
- Caps in `bursar_org_settings`, persisted as used on the run row: `max_nodes_per_run` (400),
  `max_offers_per_run` (8), `max_llm_calls_per_run` (250).
- A BullMQ limiter sized under 120/min.

**The cap contract, stated because round 2's worked example violated its own caps:**

| Situation | Behavior |
| --- | --- |
| Preflight | `POST /requests/:id/level` returns estimated calls, tokens, wall-clock, plus `would_exceed: {offers, calls}` |
| `max_offers_per_run` exceeded at start | **422 `rejected_limits`**, nothing runs |
| `max_llm_calls_per_run` exceeded mid-flight | stop cleanly at `status='partial'` with the "levelled 6 of 8 - continue" affordance |

**Worked example, inside the caps:** 60 nodes x 6 offers, batched 6 nodes per call =
60 calls, ~510k input tokens, ~4 min wall-clock at the concurrency ceiling. A larger request is
a visible 422 with a preflight number, not a surprise.

### 3.10 `finish_reason` requires an additive `apps/api` change

`internal-llm.routes.ts:349,389` return `{data:{content: text}}` and discard Anthropic's
`stop_reason` and OpenAI's `finish_reason`, so truncation detection is otherwise guesswork.
**This build makes one additive change**: the proxy returns `{data: {content, finish_reason,
usage}}`. Every existing caller reads `data.content` and is unaffected.

---

## 4. The coverage-collapse cluster

A single crafted line, a *set* of coordinated lines, or one colluding bidder can collapse the
exclusion diff. They are solved together because they will be tested together.

### 4.1 The two attacks

**Single blanket line.** *"All requirements, including installation, crew training, warranty,
data export and escalation cap, are fully included in this all-inclusive price."* Cited for all
14 nodes; span verifies each time; node-term overlap maximal; `high` band; diff clean.

**Split blanket - and this is the one round 2 did not stop.** Four ordinary lines:

> *"Installation, crew training and the 24-month warranty are provided at no additional charge."*
> *"Escalation cap, spares and commissioning are provided at no additional charge."* (and so on)

Fan-out is 3 per line, **under the round-2 cap of 4**. No lexicon token. The cap counted per
`offer_line_id`, and **the attacker chooses the line count**. Worse, round 2's §4.4 explicitly
accepted "an itemized list the classifier can cite per node" as enumeration, so each line
**auto-published** at `high` band. And §4.6's fixture said "*one* all-inclusive line", so the
split attack **passed CI** - the same "fixtures prove the wrong thing" failure already seen on
the injection corpus.

### 4.2 Defense 1: blanket-claim lexicon (deterministic)

Whole-document pre-pass for `all requirements`, `fully included`, `all-inclusive`, `turnkey`,
`everything listed`, `as specified in your RFQ/RFP`, `no additional charge`, `no exclusions`,
`complete solution`, `comprehensive`. Sets `bursar_offer_lines.blanket_claim`. A `covered`
verdict citing such a line cannot auto-publish.

Necessary but not sufficient: a lexicon is evadable, which is why 4.3 and 4.4 do not depend on
language at all.

### 4.3 Defense 2: cumulative per-offer caps (the load-bearing defense)

Two guards, both computed **per offer**, not per line, so neither depends on the attacker's line
count:

**(a) Unsubpriced-coverage cap.** Count distinct **`mandatory`** nodes whose only `covered`
evidence is a **non-sub-priced** citation, across **all** lines of the offer. Above
`blanket_cumulative_cap` (default 4), **all of them** route to review and none auto-publish.
The split attack yields 14 such nodes and trips immediately.

**(b) Evidence-concentration guard.**
`distinct_cited_lines / covered_mandatory_nodes` below `evidence_concentration_floor`
(default 0.5) routes all covered mandatory nodes to review. Four lines covering 14 nodes gives
0.29.

Per-line fan-out is retained as a cheap early signal (`blanket_fanout_cap`, default 4) but is no
longer the boundary.

### 4.4 Defense 3: only explicit sub-pricing enumerates

**A bundling line may auto-publish `covered` for more than one node ONLY at
`allocation_method='explicit_subprice'`** - a per-node **monetary sub-price** with a **distinct
cited span per node**.

The round-2 "or an itemized list" branch is **deleted**. A name-only list is a restatement of
the requirement, not evidence of coverage, and it is exactly the high-overlap shape §3.5 already
concedes is undetectable. "Installation $3,200; Training $2,400; Warranty 24mo $1,800"
auto-publishes. "Installation, training and warranty are provided" does not.

**"Bundling line" is defined**, not inferred: a line the classifier matched to >= 2 nodes,
recorded in `bursar_line_node_matches`.

**Downward subsumption is verdict-preserving**: may only promote `absent`/`ambiguous` children
to `derived_covered`; **may never overwrite `excluded_explicit` or `partial`**; capped at one
level unless descendants were explicitly sub-priced.

**Upward rollup is de-transitivized**: a parent whose children are all covered becomes
`derived_covered`, **excluded from the diff and never itself a rollup input**. Round 1's rule
composed recursively, walking coverage to the root.

**`allocation_weight` ladder**, recorded in `allocation_method`:

| Rung | Method | Usable for gap valuation? | Enumerates? |
| --- | --- | --- | --- |
| 1 | `explicit_subprice` | yes | **yes - the only rung that does** |
| 2 | `rival_distribution` | yes | no |
| 3 | `quantity_unit` | yes, `estimated` | no |
| 4 | `equal_split` | **no - refused** | no |

Rung 4 exists so the model is total, not so it can drive a headline: an equal split of a $16,400
turnkey line across 12 nodes gives $1,367/node, and the flagship claim must never be an artifact
of that heuristic.

### 4.5 Defense 4: rival-derived nodes are proposals

A bidder must not write the ruler. Two colluding bidders - or one vendor under two
`bursar_vendors` rows, since uniqueness is only on `lower(display_name)` - could satisfy a
">=2 offers" rule and inject nodes only they cover, and because `gap_adjusted` sorts the Matrix,
that **directly manipulates the award ranking**.

- Rival-derived nodes land `pending_review`, **excluded from `gap_adjusted`, from the diff, and
  from producing `absent`** until promoted.
- Supporting offers must be **distinct `braid_profile_id`** (fallback `bond_company_id`, then a
  human decision), **not distinct `vendor_id`**.
- Injection- and blanket-suspected offers cannot contribute.
- `contributing_offer_ids uuid[]` recorded.
- **Promotion has its own floored, confirm-required action `bursar.scope.promote_rival`**, and
  the payload must echo `contributing_offer_ids` so the audit records what the promoter was
  shown. Round 2 gated the entire ruler-capture defense on member-level unfloored
  `bursar.scope.write`, while floring `scope.confirm` for a strictly less consequential act.

### 4.6 Fixtures

`test/fixtures/coverage-collapse/`:

- **single-blanket**: one all-inclusive line over a 14-node tree -> tree NOT fully covered.
- **split-blanket**: **4 lines x 3-4 nodes, no lexicon token** -> tree NOT fully covered, and
  §4.3's cumulative caps trip.
- **name-list**: a line naming nodes without prices -> no auto-publish.
- **legitimate-subprice**: an itemized priced bundle -> auto-publishes correctly (the
  false-positive guard, so the defense does not make real bundles unusable).

### 4.7 The diff-completeness invariant

**Every §4 defense terminates in "does not auto-publish". If an unpublished node simply vanishes
from the exclusion diff, the attacker's goal is met anyway**: the buyer sees no gap on crew
training and signs. The defense would convert a false `covered` into a **silent omission**, which
§1.3 says is the entire product. Round 2's Playwright step ("none auto-published `covered`")
passes on an empty diff.

> **INVARIANT.** For a request whose tree is `confirmed`, the exclusion diff enumerates **every
> `mandatory` node, exactly once**, in exactly one of three states:
> **`published`** (a verdict cleared §3.6), **`needs_review`** (classified, band or cap withheld
> it), **`unverified`** (classification never completed - throttle, malformed, unparseable
> offer).
>
> `published + needs_review + unverified == count(mandatory nodes)`.

- A request with any node in `needs_review` or `unverified` renders a **blocking banner** and is
  **excluded from any "clean" / "no gaps" / "fully covered" affordance** anywhere in the UI.
- The Matrix and the Diff both render withheld rows explicitly, with the reason
  (`blanket_cap`, `concentration`, `band`, `throttled`, `unparseable`).
- **CI gate**: the identity above, asserted per fixture (§20.2).
- **Playwright negative**: the blanket offer produces **14 diff rows, none missing** (§20.3).

This is also the better product. The blanket-offer UI treatment is
**"this offer claims blanket coverage; here is what it does not itemize"** - a list of 14
unsubstantiated nodes, which is more useful to a buyer than either a clean diff or a silent one.

---

## 5. Adversarial input

### 5.1 Structural defenses

Bytes never enter the instruction role; candidates are a typed JSON array in a data role.
Answers are by `offer_line_id`, spans verify against that line only (§3.5 predicate 1).

### 5.2 Pre-scan signals the parser can actually see

The ported `Tj`/`TJ` regex carries no graphics state (no `Tf` size, no fill colour, no
`Tm`/`Td`) and never reads `/Info` or XMP, so **rendering-property detection is not buildable
against the specified parser.** v1 signals: imperative second-person directives at a
reader-model; instruction-override markers; role tokens; zero-width/bidi control runs; and
**blanket-coverage claims** (§4.2).

**Cut to v1.1** (§24): zero-font-size, colour-matched, off-page positioning, metadata-embedded
prose - all require graphics-state tracking with per-line `render_props`.

### 5.3 Quarantine and the product finding

Suspected offers never auto-publish `covered`, never contribute rival nodes, and carry a
confidence penalty - **but never have their `absent` verdicts suppressed** (§3.6). A hit opens a
`bursar_mismatches` row (`offer_manipulation_suspected`, severity `high`) citing the span.

### 5.4 Malicious documents

Uncompressed-size and entry-count ceilings before decompression; content-type pinning against
the declared `source_format`; per-parse wall-clock and memory caps in a bounded child context.

**`MAX_DOC_BYTES` default 20MB.** nginx enforces a server-level `client_max_body_size 25m`
(`nginx-with-site.conf:18`), so a 26MB value would be unreachable and the user would get a bare
413. **Judgement call:** lower Bursar's cap rather than raise a global limit for one app's worst
case. The 413 is mapped to "this file is larger than 20MB".

**CSV formula neutralization** (leading `=`, `+`, `-`, `@`) attaches to the two export routes
named in §11, as a shared helper in `@bigbluebam/shared` - bearing-api and the frontend timeline
export do the same unescaped thing today (§25.10).

### 5.5 Stage 0 is defended too

**The RFQ is the higher-leverage target**: routinely drafted on an incumbent's template,
ingested through the same untrusted byte path, and poisoning it edits the ruler *every*
competitor is measured against - and those nodes default to `mandatory`.

The pre-scan runs on the request document; `bursar_requests` gains `injection_suspected` and
`injection_signals`; a `request_manipulation_suspected` finding opens; **`confirmed` is blocked**
until flagged spans are cleared; and Stage 0 verification is **per-chunk-line**.

### 5.6 Bid confidentiality, enforced in one place

- **`offer.unseal` is floored**; every unseal writes `activity_log` and publishes
  `offer.unsealed`. The *audit* is a security requirement, not a policy question; *who may
  unseal* remains a human decision (§25.7).
- **The seal is a predicate in the shared query/repository layer** that every read of offers,
  lines, coverage, and totals passes through - the same placement as burn's
  `redact-financial-fields.ts` - **not endpoint-by-endpoint.** Round 2 enumerated endpoints and
  then added two CSV exports and four MCP read tools that bypassed it, reopening the finding at
  new surfaces. A shared predicate cannot be forgotten by a new route.
- `test/sealed-bid.test.ts` covers the matrix, diff, totals, coverage, **both CSV exports**, and
  the four MCP read tools.
- **All of `bursar_org_settings` is audited** with a before/after diff, not just the lexicon -
  otherwise an admin can zero the `span_verified` weight and silently suppress findings.

### 5.7 Draft confidentiality

`draft.read` is **not** granted to `viewer`; `draft.approve` is floored; reads are scoped to the
request owner plus explicit holders (RLS is org-level only and cannot do this alone); the
`agent_proposals` summary is a **content-free template**
(`"Bursar draft awaiting review: <draft_kind> for <vendor display_name>"`); and grounding is
enforced by a single builder `buildDraftGrounding(offer_id, request_id)` that can only select
lines of that offer and nodes of that request. `grounding_set` is written from its output, so
`test/draft-grounding.test.ts` asserts **the builder**.

### 5.8 Bin asset access - checked at attach AND at read

`bin_assets` uses **`org_id`** (`apps/bin-api/src/db/schema/bin-assets.ts:29`), and org-scoping
alone is insufficient: Bin has private and project-scoped assets (`bin_private_not_owner` is a
live `PreflightReason`), so a member who cannot see a private asset could still put its uuid in
`bin_asset_id` and get its **verbatim text into Bursar as cited spans**.

**At attach**, `assertBinAssetReadable(actingUserId, orgId, assetId)`:
`can_access('bin.asset', …)` via `packages/shared/src/visibility-client.ts` (already a supported
type, so this is reuse); `org_id` equality as defence in depth; **`scan_status = 'clean'`**;
**404, not 403**. The resolved `bin_asset_version_id` is **pinned** on the referencing row.

**At read**, the worker re-asserts `scan_status='clean'` and `org_id` **immediately before the
byte read** and reads **the pinned version**. Parsing is async, so between attach and parse
`scan_status` can flip to infected, visibility can flip to private, and `current_version_id` can
advance to different bytes - and Bursar lifts that content verbatim into `cited_span`. A failed
re-assertion lands `blocked`, never parses.

`test/bin-asset-access.test.ts`: cross-org, private-same-org, unscanned, **flipped-after-attach**,
**version-advanced-after-attach**.

---

## 6. Data model

All tables prefixed `bursar_`, org-scoped, Drizzle schema in `apps/bursar-api/src/db/schema/`.
Money is `bigint` minor units with explicit `currency varchar(3)`. Cross-app refs are dotted with
no cross-schema FK.

**No table count in prose.** §17.1 generates RLS policies by looping `information_schema` over
the `bursar_` prefix; `test/rls-coverage.test.ts` asserts every `bursar_%` table is covered.

### 6.1 Tables

**`bursar_vendors`** - `id`, `organization_id`, `display_name`, `braid_profile_id`,
`bond_company_id`, `category`, `criticality`, `owner_user_id` (SET NULL), `status`, `notes`,
`created_by`, timestamps. Unique `(organization_id, lower(display_name))`.

**`bursar_payee_aliases`** - payee resolution is **Bursar's own, not Braid's**.
`packages/shared/src/schemas/braid.ts:142-148` constrains `source_type` to a five-value enum with
`source_id: z.string().uuid()`, so a payee string fails Zod; and
`apps/braid-api/src/services/resolve.service.ts` **mints a fresh singleton profile per unseen
pair**, so every card string would create its own golden profile - the opposite of dedup.

`id`, `organization_id`, `vendor_id` (CASCADE), `raw_payee`, `normalized_payee`, `source`,
`confidence`, `resolved_by`, `first_seen_at`, `last_seen_at`.
Unique `(organization_id, normalized_payee)`; GIN trigram on `normalized_payee`.

Normalization: uppercase-fold, strip card noise (`*`, `SQ *`, `TST*`), strip trailing
phone/city/state, strip corporate suffixes, collapse whitespace. Trigram above 0.45; below
auto-accept (0.65) it is a **human review item, never a silent join**. Unmatched spend keeps
`vendor_id NULL`. Braid is called only for `bond_company_id` -> golden id
(`burn-api/src/lib/braid-resolve.client.ts:19-51`), degrading to `null` on every failure.

**`bursar_requests`** - plus `injection_suspected`, `injection_signals jsonb`, `scope_status`,
`scope_confirmed_at/by`, `bin_asset_id`, **`bin_asset_version_id`**, `source_doc_hash`.

**`bursar_scope_nodes`** - `parent_id` (guarded self-FK, RESTRICT), `path`, `ordinal`, `title`,
`description`, `node_kind`, `normative_strength` CHECK
(`mandatory`,`should_have`,`nice_to_have`,`informational`), `unit`, `quantity`, `derived_from`,
`contributing_offer_ids uuid[]`, `cited_span jsonb`, `confidence`, `review_status`, `dedup_key`,
`extraction_run_id`, `tree_suspect`, `archived_at`, timestamps.
Unique `(organization_id, request_id, dedup_key)`. **Soft-archive only**; coverage FKs RESTRICT.

**`bursar_offers`** - plus `parse_quality`, `injection_suspected`, `injection_signals`,
`blanket_suspected`, **`unsubpriced_mandatory_count`**, **`evidence_concentration`** (§4.3, both
computed per offer and persisted for auditability), `sealed_until`, `bin_asset_version_id`,
`uncompressed_bytes`. Unique `(organization_id, request_id, vendor_id, source_doc_hash)`.

**`bursar_offer_lines`** - `raw_text` (bounded 4,000), `char_start`, `char_end`, `page`,
`quantity`, `unit`, `unit_price_minor`, `extended_minor`, `line_role`, `blanket_claim`,
`exclusion_hit`, `parsed_by`. Unique `(organization_id, offer_id, ordinal)`; GIN tsvector on
`raw_text` (UI search only). **No trigram index** - deleted with retrieval.

**`bursar_line_node_matches`** - `offer_line_id` (CASCADE), `scope_node_id` (RESTRICT),
`coverage_id`, `allocation_weight numeric(6,5)`, `allocation_method varchar(24)`, `match_method`.
Unique `(organization_id, offer_line_id, scope_node_id)`. Weights per line sum to 1.0. **Both
§4.3 caps are computed from this table.**

**`bursar_offer_coverage`** - `verdict` CHECK (six), `matched_line_ids uuid[]`, `cited_span`,
`rejected_candidates`, `node_term_overlap`, `classifier_confidence`, `composite_confidence`,
`confidence_band`, `decided_by` (`deterministic`/`llm`/`human`), `review_status`,
**`withheld_reason varchar(24)`** (§4.7), `provisional`, `blanket_suspected`, `window_coverage`,
`subsumed_by_coverage_id`, `derived_covered`, `delta_*`, `priced_amount_minor`,
`overridden_*`, `leveling_run_id`.
Unique `(organization_id, offer_id, scope_node_id)`.
CHECK `verdict <> 'absent' OR decided_by = 'human' OR jsonb_array_length(rejected_candidates) > 0`.

**`decided_by` has no `'agent'` value in v1.** Round 2 added it with no write path, gate, or
permission - an unspecified enum value is an invitation, and the natural implementation would
write a verdict that skipped every §3.5 predicate and every §4 cap: the collapse attack with a
service token instead of a document. The `absent` CHECK exempts only `human`, so it would not
have constrained it either. There is no agent adjudication path in v1 (coverage override has no
MCP tool), so the value is simply removed. §24 records the reintroduction conditions.

**`bursar_leveling_window_results`** - `leveling_run_id`, `offer_id`, `scope_node_id`,
`window_index`, `verdict`, `cited_span`. Unique on all five. Durable per-window results.

**`bursar_offer_totals`** - `currency`, `total_kind` CHECK
(`stated`,`base_only`,`gap_adjusted`,`should_have_supplement`), `amount_minor`, `estimated`,
`unvalued_gap_count`, `renderable boolean`, `provenance jsonb`, `computed_at`.
`normalized_to_term` is cut to v1.1 (no term columns to normalize against).

**`bursar_leveling_runs`** / **`bursar_extraction_runs`** - `status`
(`running`/`succeeded`/`partial`/`failed`/`blocked`/`rejected_limits`),
`last_processed_offer_index`, `last_processed_node_index`, `last_processed_window_index` (the 3-D
checkpoint), `last_processed_chunk` (extraction), `chunks_failed`, `llm_calls_used`,
**`heartbeat_at`**, **`claimed_by`**, counts, timestamps.

**`bursar_awards`** / **`bursar_baseline_items`** / **`bursar_baseline_item_nodes`** - chain via
`supersedes_award_id` + `chain_root_id`, `baseline_hash`, nullable `term_start`/`term_end` (§7.3),
`auto_renew`, `renewal_notice_days`, `timezone`, `contract_bin_asset_id`, `awarded_at/by`.
Baseline items carry **`kind`** CHECK (`included`,`excluded_at_award`,`absent_at_award`).

**Immutability on four paths**: `BEFORE UPDATE` with a `WHEN` clause scoped to content columns
(so additive migrations are not aborted); `BEFORE DELETE`; `ON DELETE RESTRICT` from awards (a
cascade does not fire a row trigger); **`BEFORE TRUNCATE` statement trigger**; and
`bursar-retention` carries an explicit exclusion list naming the table.

**`bursar_spend_events`** - `source_type` CHECK (`bill.expense`,`import.csv`,`manual`),
`spend_import_id`, `occurred_on`, `amount_minor`, `currency`, `payee_raw`, `normalized_payee`,
`funding_source` (import-only), `external_ref`, `matched_baseline_item_id`, `match_method`,
`match_confidence`, `dedup_key`, **`occurrence_ordinal integer`**.
Unique `(organization_id, dedup_key)`. Index `(organization_id, normalized_payee)`.

**The dedup recipe is a plain local `sha256`** over the canonicalized tuple
`(normalized_payee, occurred_on, amount_minor, currency, external_ref, occurrence_ordinal)`,
implemented in `apps/bursar-api/src/lib/spend-dedup-key.ts`.

Two round-2 errors fixed. First, **the `idempotency-key.ts` citation was wrong**: it is an HMAC
over `BurnPrecheckRequest` against a `.strict()` type, it lives in burn-api where bursar-api
cannot import it, and keying dedup on a **rotatable secret** means every row re-imports after a
rotation. Second, the recipe **discarded legitimate identical same-day charges** - two genuine
$4.99 same-payee charges with no external ref collapsed to one, the import reported "already
imported", and every downstream figure under-reported with no signal. That is the mirror of the
doubling bug and harder to notice. `occurrence_ordinal` is the row's index within its dedup group
**in the source file**, so the second genuine $4.99 gets ordinal 1 and its own row.

**`bursar_spend_imports`** - `file_sha256`, `filename`, `row_count`, `rows_inserted`,
`rows_deduped`, `status`, `imported_by`. Unique `(organization_id, file_sha256)` **with
`ON CONFLICT ... DO UPDATE SET status='running'`**, and a non-`succeeded` batch **resumes the
upsert loop**. Round 2's bare unique constraint made a crashed import un-retryable: die at row
200 of 412 and the re-upload collides, the natural implementation short-circuits "already
imported, 0 new", and 212 rows are missing forever - even though row-level dedup already makes
the retry safe. **"0 new" is derived from `rows_deduped`, never from the batch row's existence.**

**`bursar_scope_library`** - built-ins are **global** (`organization_id IS NULL`,
`is_global = true`) so orgs created after the seed migration are not born with an empty library.
Two guards make that safe: global rows are **immutable to org callers** (API filters
`is_global = false` on writes, plus a `BEFORE INSERT OR UPDATE OR DELETE` trigger), and the RLS
policy is the variant
`organization_id = current_setting('app.current_org_id', true)::uuid OR (organization_id IS NULL AND is_global)`
with a `WITH CHECK` forbidding org-null inserts - the blanket policy evaluates NULL (not true)
for global rows, so they would vanish the day a non-superuser role is armed.
`test/library-visibility.test.ts` covers both halves.

**`bursar_org_settings`** - `llm_provider_id`, `node_term_overlap_floor`,
`blanket_fanout_cap`, **`blanket_cumulative_cap`**, **`evidence_concentration_floor`**,
`max_nodes_per_run`, `max_offers_per_run`, `max_llm_calls_per_run`, `max_lines_per_window`,
`window_overlap_lines`, `price_drift_threshold_pct`, `renewal_lead_bands`, `parse_quality_floor`,
`payee_match_threshold`, `payee_auto_accept_threshold`, `blanket_lexicon`, `exclusion_lexicon`,
`digest_day`/`digest_hour`, `retention_days`. **All audited** (§5.6).

Also: **`bursar_mismatches`**, **`bursar_renewals`**, **`bursar_ingest_events`** (+ heartbeat/claim),
**`bursar_detector_feedback`**, **`bursar_gate_checks`**, **`bursar_drafts`** (§5.7).

### 6.2 Reused platform tables

`agent_proposals` (ref-only), `entity_links` (**`org_id`**), `organizations`/`users`,
`bin_assets` (read-only, **`org_id`**, access-checked §5.8), `bond_companies`, `bill_expenses`
(read-only), `v_activity_unified`, `permissions`/`permission_group_defaults`, `activity_log`.

### 6.3 RLS posture

Policies are **generated** by a `DO $$` loop over `information_schema` for the `bursar_` prefix,
emitting `DROP POLICY IF EXISTS ... ; CREATE POLICY ...` (PG16 has no `CREATE POLICY IF NOT
EXISTS`) per `0116*.sql:23-47`, with `bursar_scope_library` taking the §6.1 variant.

Bursar uses **burn's `runInOrgScope`** (`burn-api/src/plugins/rls.ts:102-112`), not the older
services' - they issue `set_config('app.current_org_id', $1, true)` as a standalone statement,
and `is_local=true` scopes it to the current transaction, which for a standalone statement
commits immediately, discarding the GUC before the next query. Those plugins are inert today
only because the role has BYPASSRLS.

**The honest caveat stands.** Today the backstop is **absent**: every service connects as the
`bigbluebam` superuser, and superusers bypass RLS unconditionally. Every Bursar query carries an
explicit `organization_id` predicate as if there were no RLS, because there effectively is not.
`boot/assert-rls-bound.ts` logs `rls_backstop: 'absent'` at fatal level;
`test/rls-backstop.test.ts` starts passing the day the platform arms a non-superuser role.

---

## 7. Baseline and post-award drift

### 7.1 The freeze

`POST /v1/awards` in one `runInOrgScope` transaction: insert the award; **copy** every accepted
line into `bursar_baseline_items` including `excluded_at_award` and `absent_at_award` rows; link
nodes via `bursar_baseline_item_nodes`; stamp `coverage_verdict_at_award`; compute
`baseline_hash`; set the request `awarded`; write `entity_links`; publish `award.recorded` and
`baseline.frozen`. **409 if a leveling run holds a live lease.**

### 7.2 The chain

A new row with `supersedes_award_id` inherits `chain_root_id`; the predecessor flips to
`superseded`. Drift resolves over the chain, latest active item per `(chain_root_id, ordinal)`.

### 7.3 Drift computation

1. **Vendor resolution** via trigram, never Braid.
2. **Award selection**, including null terms: null `term_end` means open-ended, selected when
   `occurred_on >= term_start` (or unconditionally when both are null) and no bounded award
   matches; ambiguity picks the most recent and records `match_method='fuzzy'`.
3. **Line matching, deterministic only**: exact description, trigram over
   `bursar_baseline_items.title`, then unit-price equality within tolerance. **No LLM matcher.**
4. **Currency guard, hard precondition**: drift computed only on currency equality; otherwise
   `currency_mismatch` and skip. Without it an FX move reads as double-digit price drift.

Metrics: unit-price, extended, quantity, cadence, **new-line drift**, and **silent line**.
Silent-line evaluates only on awards with a non-null elapsed `term_end`, or a rolling 12-month
window for open-ended awards, **and the finding states which basis it used**.

**Dollars at stake are computed, never estimated.** Unquantifiable drift stores `NULL` and the UI
shows "not quantified".

---

## 8. Detector catalog

| `detector` | Fires when | Threshold | Job |
| --- | --- | --- | --- |
| `price_drift` | unit price deviates from the frozen baseline, same currency | `price_drift_threshold_pct` default **10%**, min absolute **$25** | `bursar-drift-sweep` |
| `scope_divergence` | invoiced line with no baseline item, or a silent baseline item (basis stated) | any | `bursar-drift-sweep` |
| `unbaselined_vendor` | recurring spend (>=2 events in 180d) with no award, **grouped by `normalized_payee`** | >=2 events | `bursar-drift-sweep` |
| `renewal_cliff` | `notice_deadline` enters a lead band; absorbs auto-renew-unreviewed as a severity bump | bands `t_minus_90/60/30/7`, `alerted_bands` idempotency | `bursar-renewal-radar` |
| `offer_manipulation_suspected` | §5.3 | any | `bursar-parse-offer` |
| `request_manipulation_suspected` | §5.5 | any | `bursar-derive-scope` |

`unbaselined_vendor` groups by `normalized_payee` because unmatched spend keeps `vendor_id NULL`
- a `vendor_id` grouping would fire on nothing. This is the shadow-IT bucket, and like Burn's
`unscoped`, **the bucket is the product**.

**Noise control**: `dedup_key` upsert bumps `last_seen_at`; per-org per-detector daily cap
(default 200) records `detector_capped`; `dismissed` is sticky by `dedup_key` unless the evidence
hash changes.

---

## 9. `bursar_scope_gap` (advisory only)

**The enforcing bill-api gate is cut from v1** (§24, top item). `POST /v1/gate/scope-gap` and the
MCP tool return `pass`/`advisory` plus cited reasons and record a `bursar_gate_checks` row. **No
preHandler in bill-api, no enforcement, no blocking verdict, no composition with Burn's
precheck.**

Why: a bill-api migration, a **serial** second preHandler on every money-out write
(`burn-precheck.hook.ts` is a single preHandler, so a second runs after it: 400ms + 400ms), a
ported Redis breaker, a recovery detector, and an internal auth surface - for the piece least
connected to the winning wedge.

**Internal-caller shape specified now** so v1.1 does not improvise: `POST
/v1/internal/gate/scope-gap` with `INTERNAL_SERVICE_SECRET` **plus `acting_user_id`** through
viewer-caps, returning **reason codes and a check id only - never cited spans, baseline quotes,
or prices.**

---

## 10. Comparable totals

| `total_kind` | Definition |
| --- | --- |
| `stated` | what the vendor's document says |
| `base_only` | sum of `line_role='base'` lines |
| `gap_adjusted` | `base_only` + valued **mandatory** gaps: `absent`, `excluded_explicit`, **and `partial` via `delta_amount_minor`** |
| `should_have_supplement` | the same over `should_have` nodes, reported **separately** |

### 10.1 The valuation ladder

| Rung | `provenance.kind` | Source | Admissible when |
| --- | --- | --- | --- |
| 1 | `offer_line` | **this** offer priced it as an option/allowance | always - one observation suffices, it is the vendor's own price |
| 2 | `rival_median` | median across rivals pricing it **separately** | **>= 2 admissible observations** |
| 3 | `library_unit` | node `quantity` x library unit price | library has a unit price |
| 4 | — | none | the gap is `unvalued` |

**Admissibility:** a rival that is itself `absent` contributes nothing; a rival pricing it inside
a bundle contributes only at `explicit_subprice` or `rival_distribution` (**equal-split
observations are refused**, §4.4); a **different-currency** rival is inadmissible, matching §7.3;
**fewer than 2 admissible observations means no `rival_median`** - with two offers the "median"
is one observation.

### 10.2 Refusing to render a number

When gaps cannot be valued above rung 3, `renderable = false` and the UI shows:

> **Cheapest on stated price. 3 gaps unpriced** - crew training, installation, escalation cap.

`gap_adjusted` sorts the Matrix **only when `renderable`**; otherwise it sorts on `stated` and
shows the unpriced-gap count as a second column. Fabricating a total from one observation to
preserve a headline would be the CFO-credibility failure §7.3 refuses elsewhere.

---

## 11. API surface

Base `/bursar/api/v1/...`, mounted at `/v1` per `burn-api/src/server.ts:138-151`. Cursor
pagination, `?filter[field]=`, `?sort=-field`, platform error envelope.

**Vendors:** `GET/POST /vendors`, `GET/PATCH /vendors/:id`, `DELETE /vendors/:id`
(`vendor.delete`, archive), `GET/POST /vendors/:id/aliases`,
`DELETE /vendors/:id/aliases/:alias_id`, `GET /vendors/alias-review`.

**Requests and scope:** `GET/POST /requests`, `GET/PATCH /requests/:id`,
`POST /requests/:id/derive-scope`, `GET /requests/:id/scope`, `POST /requests/:id/scope/nodes`,
`PATCH/DELETE /scope-nodes/:id` (DELETE archives),
**`POST /scope-nodes/:id/promote-rival`** (`scope.promote_rival`, floored, confirm-required,
payload echoes `contributing_offer_ids`), `POST /requests/:id/scope/apply-library`,
`POST /requests/:id/scope/confirm` (409 while `deriving`; blocked while `injection_suspected`).

**Offers:** `GET/POST /requests/:id/offers`, `POST /offers/:id/upload` (`offer.ingest`,
multipart), `GET /offers/:id`, `GET /offers/:id/lines`, `POST /offers/:id/reparse`,
`POST /offers/:id/unseal` (`offer.unseal`, floored), `DELETE /offers/:id`.

**Leveling and diff:** `POST /requests/:id/level` (cost preflight; **202 + run id**;
**422 `rejected_limits`** if `max_offers_per_run` exceeded; 409 on a live lease),
`GET /requests/:id/leveling-runs` (**authoritative progress**), `GET /requests/:id/matrix`,
`GET /requests/:id/exclusion-diff` (**satisfies §4.7's invariant**), `GET /requests/:id/totals`,
`GET /coverage/:id`, `POST /coverage/:id/override`, `GET /review`.

**Awards:** `POST /awards` (`award.create`), `GET /awards`, `GET /awards/:id`,
`GET /awards/:id/baseline`, `POST /awards/:id/amend` (`award.amend`),
`POST /awards/:id/terminate` (`award.terminate`). No baseline write path exists.

**Spend:** `GET /spend`, `GET /spend/by-vendor` (both carry `spend.read_all` as **route-file
permission metadata** so the manifest generator emits the action - burn's pattern for financial
flooring), `POST /spend/import` (`spend.import`), `GET /spend/imports`,
**`GET /spend/export`** (CSV, neutralized).

**Mismatches, renewals, drafts:** `GET /mismatches`, `GET /mismatches/:id`,
`POST /mismatches/:id/resolve|dismiss`, `POST /mismatches/:id/mark-wrong`, `GET /renewals`,
`POST /renewals/:id/decide`, `GET /drafts` (owner-scoped), `POST /drafts/clarification|negotiation-brief`,
`POST /drafts/:id/approve|reject`, **`GET /requests/:id/diff/export`** (CSV, neutralized).

**Gate, library, settings, internal:** `POST /gate/scope-gap`, `GET /gate/checks`, library CRUD
(global rows rejected), `GET/PATCH /settings`, `POST /internal/run-derivation` (**202**),
`/internal/run-leveling` (**202**), `/internal/events`, `/internal/engines/:name`, `/health`,
`/health/ready`, `/metrics`.

Internal routes register outside any session gate (`server.ts:135-137`).

### 11.1 Realtime `/bursar/ws`

Rooms `org:<id>`, `request:<id>` (`scope.progress`, `leveling.progress` with
`offer n/N, node m/M, window w/W`, `matrix.updated`), `vendor:<id>`. No browser WS precedent
exists in `apps/burn/src`, so: exponential backoff (1s, capped 30s, jittered), a visible
"reconnecting" state, and **`GET /requests/:id/leveling-runs` polled at 5s as the authoritative
fallback.**

---

## 12. MCP surface

`apps/mcp-server/src/tools/bursar-tools.ts`, client shaped like `createBurnClient`
(`burn-tools.ts:55-80`), forwarding the caller's bearer token.

| Tool | Backing endpoint |
| --- | --- |
| `bursar_level_quotes` | `POST /requests/:id/level` |
| `bursar_scope_gap` | `POST /gate/scope-gap` (advisory, non-enforcing) |
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
| `bursar_get_coverage` | `GET /coverage/:id` (rejected candidates, overlap, `withheld_reason`) |
| `bursar_get_baseline` | `GET /awards/:id/baseline` |
| `bursar_list_awards` | `GET /awards` |
| `bursar_resolve_vendor` | alias resolution, read-only |
| `bursar_list_leveling_runs` | `GET /requests/:id/leveling-runs` |
| `bursar_draft_clarification` | `POST /drafts/clarification` -> a `bursar_drafts` row |

The four offer/coverage/totals/matrix read tools pass through the **shared seal predicate**
(§5.6). `asker_user_id` narrows both visibility and financial flooring: bursar-api takes the
**intersection** of the bearer's and the asker's capabilities, because mcp-server cannot backstop
it (its own `BBB_PERMISSIONS_ENFORCE` defaults to `warn`).

**Intentionally no tool** (`— _(skip: …)_`): scope confirm and rival promotion (human gates), all
award write routes (**the freeze is a human act**), uploads and spend import (multipart),
coverage override and mark-wrong (**human adjudication is the calibration ground truth**), offer
unseal, draft approve, settings and library writes, `/internal/*`, `/bursar/ws`, health, both CSV
exports.

---

## 13. Permissions

### 13.1 The action table - the single source of truth

| Action | `is_read` | floored | `viewer` | destructive | confirm |
| --- | --- | --- | --- | --- | --- |
| `bursar.vendor.read` | yes | | yes | | |
| `bursar.vendor.write` | | | | | |
| `bursar.vendor.delete` | | yes | | yes | yes |
| `bursar.request.read` | yes | | yes | | |
| `bursar.request.write` | | | | | |
| `bursar.scope.write` | | | | yes | |
| `bursar.scope.confirm` | | yes | | | |
| `bursar.scope.promote_rival` | | yes | | | yes |
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
| `bursar.mismatch.read` | yes | | yes | | |
| `bursar.mismatch.resolve` | | | | | |
| `bursar.mismatch.dismiss` | | | | yes | |
| `bursar.renewal.read` | yes | | yes | | |
| `bursar.renewal.decide` | | | | | |
| `bursar.gate.run` | | | | | |
| `bursar.draft.read` | yes | | **no** | | |
| `bursar.draft.create` | | | | | |
| `bursar.draft.approve` | | yes | | | |
| `bursar.detector.mark_wrong` | | yes | | | |
| `bursar.library.write` | | yes | | | |
| `bursar.settings.read` | yes | | yes | | |
| `bursar.settings.write` | | yes | | | |

`requires_superuser` is false for every row.

**`bursar.usage.read` and `bursar.usage.attest` are deleted.** They existed only in this table -
no table, route, tool, or UI anywhere - as leftovers from the cut `dormant_seat` detector. Because
`generate-permission-manifest.mjs` walks **routes and tools**, it could never emit them, so the
§17.3 probe would compare a generated catalog against a larger table and **fail on a correct
build**. Recorded in §24.

**`bursar.spend.read_all` is retained** but declared as **route-file permission metadata** on
`GET /spend` and `GET /spend/by-vendor` (burn's pattern for financial flooring), so the generator
emits it. Without that declaration it would have the same phantom problem.

### 13.2 Group grants

`owner` and `admin`: every row. `member`: every row not floored. `viewer`: the rows marked
`viewer`. `guest`: none. There is no `gate.override` (the gate is advisory).

### 13.3 Enforcement posture

Bursar copies Burn's **hardcoded fail-closed boot invariant**
(`burn-api/src/boot/assert-permissions-enforce.ts`, asserted at `server.ts:47-54` before anything
binds a port): mode `'on'`, `onUnknown` fail-closed, **not an env var**, because `ENV_HINTS` is a
flat global map with no per-service override (burn's issue #83).

Financial flooring ports burn's `viewer-caps` and `redact-financial-fields.ts`. The seal
predicate (§5.6) sits in the same shared layer.

---

## 14. Frontend and help

`apps/bursar/`, React 19 + TanStack Query v5 + Zustand + Tailwind v4 + Radix.

**`apps/bursar/vite.config.ts` must set `base: '/bursar/'`** - without it Vite emits `/assets/...`
absolute paths, every asset 404s against the shared regex, and the result is a white screen that
looks like an nginx bug. Dev `server.port: 3023` (burn holds 3022), with `/bursar/api` and
`/bursar/ws` dev proxies to `localhost:4023`.

| Route | Page |
| --- | --- |
| `/bursar/` | **Vendor Portfolio** - "no award on file" is a first-class column |
| `/bursar/requests` | Request list |
| `/bursar/requests/:id` | **Scope Tree editor** - citations, strength promotion, apply-library, **rival-promotion queue**, Confirm scope |
| `/bursar/requests/:id/level` | **The Leveling Matrix** - sorted by `gap_adjusted` when renderable, else `stated` + unpriced-gap count. A chip opens the cited span, matched lines, and for `absent` the rejected candidates. **Withheld rows render explicitly with their `withheld_reason`** |
| `/bursar/requests/:id/diff` | **Exclusion Diff** - **satisfies §4.7**: every mandatory node appears exactly once; a blocking banner when any node is `needs_review`/`unverified`; blanket offers render "this offer claims blanket coverage; here is what it does not itemize" |
| `/bursar/vendors/:id` | Vendor detail - aliases, award chain, baseline, spend, findings, `orphaned_custody` badge |
| `/bursar/mismatches` | Mismatch Inbox - "not quantified" never becomes a number |
| `/bursar/renewals` | Renewal Radar |
| `/bursar/review` | HITL queue - coverage adjudication, alias review, rival promotion, drafts |
| `/bursar/settings` | Thresholds, weights, lexicons, library (global rows read-only) |

**Two hard UI rules.** A `medium`-band verdict is visually distinct and **excluded from every
headline aggregate** (a `data-testid` carries its contributing band set). And **no "clean" /
"no gaps" affordance renders while any mandatory node is `needs_review` or `unverified`** (§4.7).

### 14.1 The help system

Shipped in **M6**, gated at **M9**:

- `docs/apps/bursar/help.md` and `guide.md`;
- `help-index.json` **generated**, verified with `node scripts/help/build-help-index.mjs --check`
  (a purpose-built check mode that exits 1) rather than regenerating in CI;
- `<HelpTrigger app="bursar" />` per `apps/burn/src/components/layout/burn-layout.tsx:120`;
- **every `@bigbluebam/ui/*` alias from `apps/burn/vite.config.ts` copied verbatim** - burn
  carries twelve. The one that bites is `@bigbluebam/ui/markdown`, imported by
  `packages/ui/help-center.tsx:39` and `help-viewer.tsx:17`; because the frontend Dockerfile
  chains builds with `&&`, an unresolved alias **breaks the whole frontend image**. The rule is
  "copy them all", never a count.
- `docs/apps/bursar/screenshots/` comes from the docs-capture recipe, **not** the bespoke
  braid/bulwark capture scripts.

`scripts/help/smoke-help-center.mjs` is **not** a done-criterion: it is hardcoded to Bam and takes
no app argument. Coverage is Playwright step 12. Its hardcoded `D:/Documents/GitHub/...` `OUT`
default is filed as pre-existing (§25.10).

---

## 15. Background work

Locks live inside bursar-api; worker jobs are thin HTTP callers into `/v1/internal/engines/:name`.

| Job | Schedule | Does |
| --- | --- | --- |
| `bursar-derive-scope` | event | **async-start, one chunk per invocation** (§3.2) |
| `bursar-parse-offer` | event | lines, injection + blanket pre-scan, parse quality, §4.3 per-offer counters |
| `bursar-level-request` | event | **async-start, bounded slices** (§18.6) |
| `bursar-drift-sweep` | `*/30 * * * *` | detectors 1-3 |
| `bursar-renewal-radar` | `0 6 * * *` | detector 4 |
| `bursar-mismatch-reconcile` | `5,35 * * * *` | closes findings whose evidence no longer holds |
| `bursar-run-reaper` | `*/5 * * * *` | §18.6 |
| `bursar-draft-reconcile` | `*/15 * * * *` | reflects proposal decisions |
| `bursar-weekly-digest` | `0 13 * * 1` | the retention mechanism |
| `bursar-retention` | `20 5 * * *` | prunes; baseline items excluded |

**Queue authoring:** every Bursar queue sets `removeOnComplete: 100` and `removeOnFail: 500`.
Redis runs `noeviction` (§18.5), so unbounded job retention is what would eventually make writes
error out suite-wide. This is the actionable half of what round 2 mislabelled as a Redis config
change.

**Reconcile does not flap against the sweep**: both take the **same per-org advisory lock class**,
and reconcile is offset to `5,35` so it always runs after a sweep tick.

**`bursar-drift-sweep` is bounded**: org cursor across ticks, per-tick row budget, BullMQ limiter,
row claims with lease renewal, and progress logging (`org n/N`, `rows n/N`, elapsed-ms) **before**
each stall.

---

## 16. Events and integration

### 16.1 Published (source `bursar`)

`request.created`, `request.manipulation_suspected`, `scope.derived`, `scope.frozen`,
`offer.received`, `offer.normalized`, `offer.manipulation_suspected`, `offer.unsealed`,
`quote.leveled`, `exclusion.detected`, `award.recorded`, `baseline.frozen`, `drift.detected`,
`mismatch.opened`, `mismatch.resolved`, `renewal.approaching`, `draft.created`, `draft.decided`,
`gate.advisory`.

**Signature confirmed correct.** `CLAUDE.md:434` documents
`publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)` explicitly, including
why it matters (`check-bolt-catalog.mjs` extracts the first two string literals, so an object-form
call would pass `undefined` at runtime **and** evade the guard). No docs correction needed.

Events carry **refs and scalars only** - Bolt fans out to webhooks and external runners.

### 16.2 Consumed

`expense.submitted` / `expense.approved` (bill) -> spend event; `profile.merged` (braid) ->
re-point `braid_profile_id`; `proposal.decided` -> reflect onto `bursar_drafts`.

**`invoice.paid` and `payment.recorded` are excluded** - money in. **There is no Bin event**
(bin-api emits none), so offer ingestion is REST-triggered.

### 16.3 entity_links and visibility

Links written in the same org-scoped transaction as the row they describe
(`burn-api/src/lib/entity-links.ts:36-40`), `ON CONFLICT DO NOTHING`. `entity_links` uses
`org_id`; `bursar_*` tables use `organization_id`.

**Required `apps/api` change**: `visibility.service.ts:113-153` lists `bill.invoice` and
`bill.client` but **no `bill.expense`**, so under treat-non-ok-as-deny every drift citation would
silently drop. Added to `VisibilityEntityType` and `SUPPORTED_ENTITY_TYPES` with resolvers:
`bursar.vendor`, `bursar.request`, `bursar.offer`, `bursar.award`, `bursar.mismatch`, and
**`bill.expense`**. `bin.asset` is already supported, which is what makes §5.8 reuse.

---

## 17. Migration plan

### 17.1 Files

**Anchor is "current tip + 1, observed at authoring time"** (tip was
`0246_tasks_overdue_alerted.sql`). Four apps landed on this branch recently; **re-run the delta
after any rebase**.

| # | File | Contents |
| --- | --- | --- |
| NNNN | `bursar_core.sql` | vendors, payee aliases, requests, scope nodes, scope library (global built-ins + variant policy + immutability trigger), org settings, extraction runs; the "Bursar System" sentinel user (as `0234`/`0239`, since `agent_proposals.actor_id` is NOT NULL) |
| +1 | `bursar_offers_coverage.sql` | offers, lines, line-node matches, coverage (+ the `absent` CHECK), window results, totals, leveling runs |
| +2 | `bursar_awards_baseline.sql` | awards, baseline items + item-nodes + UPDATE/DELETE/**TRUNCATE** triggers, spend events, spend imports |
| +3 | `bursar_detectors_drafts.sql` | mismatches, renewals, gate checks, ingest events, detector feedback, drafts |
| +4 | `bursar_rls.sql` | **generated** `DO $$` loop over `information_schema` for `bursar\_%` |
| **M9** | permissions (two-pass, §17.2) | **authored at M9, not M1** |

### 17.2 The permission procedure, and why it belongs at M9

`build-permission-delta.mjs` diffs the manifest, and the manifest is generated by
`generate-permission-manifest.mjs` **walking route and tool files**. So the catalog can only be
complete once the routes and tools exist.

**Round 2 put this at M1, which is unsatisfiable**: at M1 no routes exist, the manifest yields a
handful of ids, the group-defaults file is authored against a partial catalog - **and is then
checksummed and immutable**, which is precisely the trap §17.2 itself documents. The full chain
therefore runs at **M9**:

```sh
node scripts/generate-permission-manifest.mjs      # routes + tools -> manifest
#   hand-review flags against the §13.1 table here
node scripts/build-permission-codegen.mjs
node scripts/build-permission-delta.mjs            # emits <observed>_permissions_seed_actions_delta_0NN.sql
node scripts/check-permission-catalog.mjs
docker compose run --rm migrate
# ONLY NOW author <observed>+1_bursar_builtin_group_defaults.sql
docker compose run --rm migrate
```

The ordering trap (verbatim from the `0238`/`0243` headers): the generator computes its number as
`max(prefixes)+1`, so a group-defaults file authored **first** runs **first**, its `CROSS JOIN
permissions WHERE app='bursar'` matches zero rows, `ON CONFLICT DO NOTHING` swallows it, migrate
reports success, the file is checksummed as applied, and **it can never re-run** - leaving every
non-SuperUser at `implicit_deny` on every `/bursar` route. This has happened twice.

**Interim posture M1-M8:** `bursar.*` actions do not exist, so with the fail-closed invariant
(§13.3) every `/bursar` route denies for non-SuperUsers. Development and Playwright run as a
SuperUser (Skipper is seeded as one) until M9 lands the catalog. Stated so nobody "fixes" the
denial by weakening the invariant.

### 17.3 The probe is the gate

```sql
SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
FROM permission_group_defaults d
JOIN permissions p ON p.id = d.permission_id
JOIN permission_groups pg ON pg.id = d.group_id
WHERE p.app = 'bursar' GROUP BY 1;
```

**The CI assertion parses §13.1 and recomputes**; it does not trust a literal. As a sanity target
only, §13.1 currently yields `owner = admin = 36`, `member = 22`, `viewer = 10`, `guest = 0`
(36 rows, 14 floored, 12 `is_read`, 10 viewer after excluding `spend.read_all` and `draft.read`).
**If this line disagrees with the table, the table wins.**

---

## 18. Infrastructure

### 18.1 nginx - three files, and hard M0 ordering

`docker-compose.yml:355` bind-mounts **`infra/nginx/nginx-with-site.conf`**;
`infra/nginx/nginx.conf` is the bare `docker run` profile and **is not mounted by compose**.

| File | Role | Assets regex |
| --- | --- | --- |
| `infra/nginx/nginx-with-site.conf` | **what compose mounts** | 835 |
| `infra/nginx/nginx.conf` | bare `docker run` profile | 766 |
| `infra/nginx/nginx.railway.conf` | Railway | 975 |

Each gets `location /bursar/`, `/bursar/ws`, `/bursar/api/` (Railway using
`set $rw_upstream_N "bursar-api.railway.internal"` + `rewrite`), **and `bursar` in the shared
static-asset regex**.

> **ORDERING IS MANDATORY.** There is **no `resolver` directive** in the compose-mounted conf, so
> nginx resolves upstreams **at config load**. Adding `proxy_pass http://bursar-api:4023/` while
> no such container exists makes nginx **exit at startup** with "host not found in upstream",
> **taking the frontend container down and every app in the suite unreachable** on the dev stack
> this cycle must test on. `condition: service_started` does not prevent it - a never-built or
> crash-looping container still yields NXDOMAIN.
>
> 1. Add `apps/bursar-api/Dockerfile` and the compose service.
> 2. `docker compose up -d bursar-api` and **confirm it is running**.
> 3. **Only then** add the three nginx blocks and `docker compose up -d --force-recreate frontend`.
>
> **M0 gate:** `docker compose exec frontend nginx -t`.
> **Rollback if the frontend goes down:** `git checkout infra/nginx/` and recreate frontend
> *before* debugging bursar-api - the outage is the config, not the app.

`client_max_body_size` is **not** modified; `MAX_DOC_BYTES` is set below it (§5.4).

### 18.2 The frontend Dockerfile - four edits, and no fifth

| # | Location (burn's line) | Edit |
| --- | --- | --- |
| 1 | `Dockerfile:25` | `COPY apps/bursar/package.json ./apps/bursar/` |
| 2 | `:134-137` | `src`, `public`, `index.html`, `tsconfig.json tsconfig.node.json vite.config.ts` |
| 3 | `:201` | `&& pnpm --filter @bigbluebam/bursar build \` |
| 4 | `:228` | `COPY --from=build /app/apps/bursar/dist /usr/share/nginx/html/bursar` |

**No fifth edit for the guide**: `Dockerfile:241` copies `docs/apps/` as a directory.

**The SPA dist is NOT bind-mounted** - only nginx templates, `./docs/apps`, avatars, and certs
are. So **`/bursar/` serving requires `docker compose build frontend`, which rebuilds all 23
SPAs and is the slow step of M0; budget for it.** By contrast, nginx-only changes need just
`--force-recreate` (the conf **is** bind-mounted at `:355`), and a guide change needs a rebuild
for Railway but not for the local dev stack.

**No `pnpm-workspace.yaml` or `turbo.json` change is needed** - both glob `apps/*`.

### 18.3 The `services.mjs` entry, verbatim

`railway-orchestrator.mjs:69-70` resolves a missing `env` block to two empty arrays - **not an
error** - so an entry without one deploys with no `DATABASE_URL` and crash-loops behind a
healthy-looking build. Modeled on burn-api at `services.mjs:335-346`:

```js
{
  name: 'bursar-api',
  description: 'Bursar API — vendor-side procurement, exclusion diff, spend baseline',
  dockerfile: 'apps/bursar-api/Dockerfile',
  port: 4023,
  healthcheck: '/health',
  start_command: 'node dist/server.js',
  required: true,
  // BILL_API_INTERNAL_URL deliberately ABSENT: the enforcing spend gate is cut from v1 (§9),
  // so there is no bill-api call site. Adding it would be dead configuration.
  // BBB_PERMISSIONS_ENFORCE deliberately ABSENT: enforcement is a hardcoded boot invariant,
  // not an env-driven setting (burn issue #83, §13.3).
  needs: ['postgres', 'redis', 'api', 'bolt-api'],
  public_paths: ['/bursar/api/', '/bursar/ws'],
  env: {
    required: ['DATABASE_URL','REDIS_URL','SESSION_SECRET','INTERNAL_SERVICE_SECRET',
               'BBB_API_INTERNAL_URL','BOLT_API_INTERNAL_URL'],
    optional: ['DATABASE_READ_URL','BRAID_API_INTERNAL_URL','CORS_ORIGIN','LOG_LEVEL',
               'MAX_DOC_BYTES','MAX_DOC_PAGES','BURSAR_LLM_TIMEOUT_MS','BURSAR_ENGINE_TIMEOUT_MS'],
  },
}
```

Also: add `bursar-api` to the frontend's `needs` and `/bursar/` to its `public_paths`; add
`BURSAR_API_INTERNAL_URL` to the **bolt-api** and **worker** entries; add `BURSAR_API_URL` to the
**mcp-server** entry's `env.optional` (`services.mjs:556`).

### 18.4 `env-hints.mjs` - and the `/v1` asymmetry

**Unresolvable optional vars are silently skipped**, so without hints both vars would be unset on
Railway with no local repro. Both get `kind:'computed'` entries per `env-hints.mjs:281-289`:

```js
// Consumed by bolt-api and worker. Bare origin, no suffix.
BURSAR_API_INTERNAL_URL: { kind: 'computed', value: plannedApp('bursar-api') },
// Carries /v1 because the mcp-server's bursar client requests bare resource paths, matching
// every other satellite client (burn, beacon, brief, bond, board, ...).
BURSAR_API_URL: { kind: 'computed', value: `${plannedApp('bursar-api')}/v1` },
```

**The suffix asymmetry is load-bearing**, and `env-hints.mjs:286-289` is explicit about why.
Setting them to identical values 404s every Bursar MCP tool on Railway with no local repro.

**Railway `:8080` rule:** internal URLs must use 8080, not 4023, or you get 502s while
healthchecks pass.

### 18.5 Shared-resource prerequisites

**Postgres - real work.** `postgres:16-alpine` has **no `command:` key today**, so adding one
recreates the container. `max_connections=100` is already oversubscribed (each API opens
`max: 20` plus a read pool), and Bursar adds jobs and long-held advisory locks - converting
latent oversubscription into `too many clients` errors that will look like a **Bond or Bill
outage**.

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

**Redis - VERIFY ONLY, CHANGE NOTHING.**

> `docker-compose.yml:36-41` **already reads `--maxmemory 512mb --maxmemory-policy noeviction`.**
> Round 2 instructed raising the cap; that was **factually wrong** - it is already at the target.
>
> **Do not edit this block.** The block carries a five-line comment explaining that this instance
> backs BullMQ queue state and that eviction **silently corrupts** it. A builder told to change a
> block that already reads the target value will change *something*, and the only remaining knob
> is the policy - producing exactly the suite-wide corruption the comment warns against.
>
> Verification only:
> `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" config get maxmemory maxmemory-policy`
> -> `512mb`, `noeviction`.

The actionable half is per-queue retention, which lives in §15 (queue authoring), not here.

**Railway counterpart (M0).** The Postgres connection ceiling needs its production equivalent
applied to the managed plan and recorded in the deploy catalog, or the local fix is cosmetic.

### 18.6 Long runs: async start, leases, and fencing

**(a) Async-start, for BOTH engines.** `burn-shared.ts:28` defaults `BURN_ENGINE_TIMEOUT_MS` to
180000; leveling runs take tens of minutes and multi-chunk derivation can exceed it too. Worse,
`fetch` abort does not stop the handler, so a BullMQ retry starts a **second writer** on the same
run row. `POST /internal/run-leveling` and `POST /internal/run-derivation` both return **202 +
run id**; the worker polls; work proceeds in bounded slices (one offer, or one chunk, per
invocation) as `burn-attribute-batch` does. `BURSAR_ENGINE_TIMEOUT_MS` (default 30000) covers
only the start call.

**(b) Leases, because the lock cannot span the work.**
`apps/burn-api/src/lib/advisory-lock.ts` states the hard rule that no transaction holding the
lock may contain an outbound HTTP call, so the lock **cannot span an LLM run**; the 409 keys off
run status. `heartbeat_at` + `claimed_by` on `bursar_leveling_runs` and `bursar_extraction_runs`,
heartbeated on **every checkpoint commit**; `bursar-run-reaper` reverts runs whose heartbeat
exceeds the lease (default 5 min) to `partial`. The mechanism exists at `attribution.engine.ts:80`
and `sweeps.engine.ts:76`.

**(c) The reaper must fence the original writer, or it creates the race it was added to fix.**
A single node can exceed the lease without a checkpoint (60s deadline + malformed retries +
throttle deferral). The reaper flips to `partial`, re-entry is permitted, and the still-alive
original writes behind the new one - regressing the checkpoint and re-billing LLM work. A bare
status flag does not fence; burn's precedent is a row claim.

> **Every** checkpoint, window-result, and coverage write is conditioned on
> `WHERE id = $run AND claimed_by = $me AND status = 'running'`.
> **A zero-row update aborts the slice immediately.** Slices of one run execute **serially**.

**(d) The status reaper must also unwedge the request.** `bursar_requests.scope_status='deriving'`
has no reaper of its own, so a crashed derivation wedges `scope/confirm` at 409 **permanently** -
the request can never reach `confirmed`, so per §3.2 it yields only `provisional` verdicts and
publishes no Bolt event, and **the flagship is dead on that request with no recovery short of
psql.** The reaper **transactionally reverts the owning request's `scope_status`** (to `pending`)
in the same statement that reverts the cold run. The same audit applies to
`bursar_offers.normalization_status='parsing'`.

### 18.7 Health, and the frontend dependency

`@bigbluebam/service-health` registers exactly `/health`, `/health/ready`, `/metrics`. Readiness
checks **Postgres and Redis only** - not the LLM proxy, not braid-api - so an upstream outage
never cascades into "bursar not ready" (`burn-api/src/server.ts:118-120`).

The frontend depends on bursar-api with **`condition: service_started`** through the build,
promoted to `service_healthy` at M9. The established pattern is `service_healthy`, but it makes
the newest service a hard boot dependency of the dev stack, and the precedent is already
inconsistent (the frontend's `needs` omits bin, bay, blip). Note this does **not** protect
against §18.1's NXDOMAIN failure, which is a config-load problem, not a dependency problem.

### 18.8 Data growth

`bursar_offer_lines`, `bursar_offer_coverage`, `bursar_spend_events`,
`bursar_leveling_window_results` are unbounded. **v1 decision, recorded in the migration header:
no partitioning.** Episodic volume; premature partitioning on `organization_id` complicates RLS.
Retention is the control. One GIN tsvector remains; the `raw_text` trigram index is gone.

### 18.9 Catalog and docs registration

| File | Change |
| --- | --- |
| `scripts/deploy/shared/services.mjs` | §18.3 |
| `scripts/deploy/shared/env-hints.mjs` | §18.4 |
| `docker-compose.yml` | bursar-api service; `BURSAR_API_URL` on mcp-server (`:190` precedent); `BURSAR_API_INTERNAL_URL` on worker and bolt-api; **postgres only** (§18.5) |
| `apps/api/src/routes/system-settings.routes.ts` | `LAUNCHPAD_CATALOG` += bursar; `ROOT_REDIRECT_VALUES` += `'bursar'`; **and `REDIRECT_MAP` (`:123`)** - without it the redirect validates and then fails to resolve |
| `apps/api/src/routes/internal-llm.routes.ts` | additive `{content, finish_reason, usage}` (§3.10) |
| `apps/api/src/services/visibility.service.ts` | 5 `bursar.*` types + `bill.expense` + resolvers |
| `scripts/docs/lib/tool-source.mjs` | `APP_TOOL_MODULES` += `bursar: ['bursar-tools']`; `pnpm docs:catalog` |
| `docs/reference/mcp-endpoint-mapping.md` | full section; bare-dash check prints `0`; **and `## Surface summary` counts updated** |
| `apps/bolt-api/src/services/event-catalog.ts` | `bursarEvents` per §16.1 |
| `.env.example` | both vars, modeled on `:216-238` incl. disabled-by-default semantics |

---

## 19. Seed data (GILLIGAN)

**`scripts/seed-gilligan/bursar.mjs`, registered in `run-all.mjs`** (`PHASES` at `:60-79`), in the
**Billing** phase (needs `bond.mjs` companies and `bill.mjs` expenses). Plus
`packages/docs-capture/recipes/bursar/bursar.yaml`.

**Vendors (5)** with messy aliases: Howell Industries Salvage (`HOWELL IND *SALVAGE`,
`Howell Industries Inc`, `THURSTON HOWELL III HLDG`), Radio Parts & Coconut Wire Co, Lagoon
Freight Lines, Island Weather Feed, Professor's Lab Supply.

**Request:** "Lagoon Rescue Beacon Procurement", owner Skipper, budget $18,000, category
`hardware_purchase`, **14 nodes** - `mandatory` including "On-island installation and
commissioning", "Crew training for six", "24-month parts warranty"; library-derived `should_have`
"Data export on termination", "Price escalation cap".

### 19.1 The four offers, with admissible provenance

| Offer | `stated` | Gaps | Valuation (rung) | `gap_adjusted` |
| --- | --- | --- | --- | --- |
| **Howell Industries Salvage** (PDF) | **$16,400** | crew training `absent`; installation `excluded_explicit` | training **rung 2**: Radio $2,400 + Lagoon $2,600 -> $2,500. installation **rung 2**: Radio $3,200 + Lagoon $2,900 -> $3,050. Both have **2 admissible observations** | **$21,950** |
| **Radio Parts & Coconut Wire** (spreadsheet) | $19,100 | warranty `partial` (12 vs 24 months, `delta_kind='term'`) | **rung 1**: Radio's own sheet carries an optional line "24-month warranty upgrade +$600", so this is `offer_line` - **one observation suffices at rung 1** | **$19,700** |
| **Lagoon Freight Lines** (email text) | $17,800 | warranty `absent` (mandatory); escalation cap `absent` (`should_have`) | warranty **rung 2**: Howell $1,100 + Radio $1,300 -> $1,200. escalation cap **unvalued** (a term; nobody priced it) | **$19,000** + `should_have_supplement` unvalued, "1 gap unpriced" |
| **Professor's Lab Supply** (PDF) | $15,900 | — | **split-blanket claim** (§19.2) | not computed; withheld |

Round 2 labelled Radio's $600 as rung 1 while sourcing it from a *rival*, which is rung 2 and
needs two observations - so the figure was unproducible. Fixed by making it genuinely rung 1:
**Radio's own offer prices the upgrade.** Lagoon's $1,200 now has the two rival observations rung
2 requires. **Every figure above is computable from §10.1 as written.**

**Award goes to Radio Parts**, not the lowest `gap_adjusted` - Lagoon's absent warranty is
disqualifying on a rescue beacon. Deliberate: Bursar informs the decision, it does not make it.
Radio's baseline is **14 `included` rows** (warranty included with `delta_kind='term'`), zero
`excluded_at_award`, zero `absent_at_award`.

### 19.2 The fourth offer demonstrates the §4 cluster

Professor's Lab Supply submits **four coordinated lines**, none containing a lexicon token:

> *"Installation, crew training and the 24-month warranty are provided at no additional charge."*
> *"Data export, escalation cap and commissioning are provided at no additional charge."*
> *(two more covering the remaining nodes)*

Fan-out is 3-4 per line, **under the per-line cap** - which is exactly why §4.3's caps are
cumulative. It trips both: 14 unsubpriced mandatory nodes (cap 4) and evidence concentration
4/14 = 0.29 (floor 0.5). Result: **zero auto-published `covered`**, an
`offer_manipulation_suspected` finding, and a diff that renders **all 14 nodes** as
`needs_review` with `withheld_reason='blanket_cap'` under the banner *"this offer claims blanket
coverage; here is what it does not itemize."*

### 19.3 One source for the numbers

This is the third round a seed-number mismatch has surfaced. The seeder **exports a
`BURSAR_SEED_EXPECTATIONS` constant** (offer totals, gap counts, node count, baseline
composition) from `scripts/seed-gilligan/bursar.expectations.mjs`, and **the Playwright suite
imports it** rather than restating literals. A seed change that breaks an assertion breaks it at
the one place both read.

**Post-award**, one live example per detector: `price_drift` (Island Weather Feed 40% above
baseline), `scope_divergence` ("expedited lagoon delivery", no baseline line),
`unbaselined_vendor` (Professor's Lab Supply, four recurring charges, no award), `renewal_cliff`
(Island Weather Feed at `t_minus_60`), plus an `orphaned_custody` badge.

**Never seeded:** `e2e-admin@bigbluebam.test`, "E2E Test Organization", "screenshots-demo".

---

## 20. Test plan

### 20.1 Unit (Vitest + `@bigbluebam/db-stubs`)

`verifyCiteAgainstLine` (incl. text-elsewhere-in-document -> miss); `nodeTermOverlap`;
**`computeDedupKey` resume equality**; **`compositeConfidence` finite for every input**;
`classifyCoverage` decision table (six verdicts x three predicates x four strengths);
missing-node -> `ambiguous`; malformed retry capped at 2; **window merge lattice, every pair**;
**cumulative fan-out and evidence-concentration caps**; **pinned-line exemption scoped to
`excluded_explicit`** (`test/fanout-pinned.test.ts`); rollup (downward may not overwrite
`excluded_explicit`/`partial`; upward `derived_covered` never a rollup input);
`allocation_method` ladder and **equal-split refusal**; totals incl. admissibility and
`renderable=false`; **`blanket_suspected` does NOT suppress `absent`**; payee normalization;
**spend dedup incl. two genuine same-day identical charges producing two rows**; **import
resume after a mid-file crash**; baseline triggers UPDATE/DELETE/cascade/**TRUNCATE**; drift
currency precondition, null-term selection, silent-line basis; **claim fencing (a zero-row
conditional update aborts the slice)**; boot invariants; `rls-coverage`, `library-visibility`,
`sealed-bid` (incl. both CSV exports and the four MCP tools), `draft-grounding`,
`bin-asset-access` (cross-org, private, unscanned, **flipped-after-attach**,
**version-advanced**).

### 20.2 Corpus gates (CI, deterministic via recorded responses)

Fixtures: **>= 40 labelled absence tuples**; **>= 8 instruction-shaped injection**; **>= 3
non-imperative single-blanket**; **the split-blanket set (4 lines x 3-4 nodes, no lexicon
token)**; **name-list**; **legitimate-subprice**; **>= 1 long document with a terminal exclusions
block**.

| Gate | Threshold |
| --- | --- |
| False-absence rate | `<= 0.05` on published verdicts |
| Injection resistance | **0** auto-published `covered` |
| Single-blanket resistance | **0** auto-published; 14-node tree not fully covered |
| **Split-blanket resistance** | **0** auto-published; cumulative caps trip |
| **Legitimate sub-priced bundle** | **does** auto-publish (false-positive guard) |
| Missed exclusion (long document) | terminal block yields `excluded_explicit` |
| **Diff completeness (§4.7)** | `published + needs_review + unverified == count(mandatory nodes)`, **per fixture** |

**Recorded caveat:** stubs mean CI never exercises the real 60s timeout or the proxy's
concurrency behavior.

### 20.3 Playwright (GILLIGAN only), as Skipper

Assertions import `BURSAR_SEED_EXPECTATIONS` (§19.3).

1. `/bursar/`, open the request, see the seeded node count, click a citation popover.
2. Promote "Price escalation cap" to `mandatory`; **Confirm scope**.
3. Matrix: four offer columns; red `absent` chip at (Crew training, Howell).
4. Click it: **rejected candidates and reasons render**.
5. **The rival-promotion queue shows N pending rival-derived nodes, and none of them appear in
   the diff.** Then promote one and assert it appears. (Round 2 asserted "rival-informed absence
   present on the first view", which §4.5 **forbids** - rival nodes are excluded from the diff
   and from producing `absent` until promoted, and every seeded absence is request- or
   library-derived. The assertion was unsatisfiable.)
6. Diff: Howell's `excluded_explicit` ranks above all-offers-absent notes; "installation by
   others" is on the page.
7. **`gap_adjusted(Howell) > gap_adjusted(Radio)`** - the punchline, from the expectations
   constant.
8. **Professor's Lab Supply: `offer_manipulation_suspected`, zero auto-published `covered`,
   AND the diff renders all 14 mandatory nodes** with `withheld_reason='blanket_cap'` - the §4.7
   negative. A passing step 8 on an empty diff is the failure this replaces.
9. Award to Radio Parts. Assert **structurally**:
   `included + excluded_at_award + absent_at_award == node count`, the warranty node is
   `included` with `delta_kind='term'`, and **no edit control exists on any baseline row**.
10. `/bursar/mismatches`: `price_drift` cites a baseline item with a real figure.
    `/bursar/renewals`: Island Weather Feed in `t_minus_60`.
11. **Negative:** no headline aggregate whose `data-testid` band set includes `medium`; and no
    "clean"/"no gaps" affordance renders while any node is `needs_review`.
12. **Help:** the HelpTrigger opens and the Bursar guide loads.

### 20.4 Integration

bill expense -> `expense.submitted` -> `bursar_ingest_events` -> spend event -> drift ->
`mismatch.opened`. Bin access: all five §5.8 cases 404 or block and write nothing.

### 20.5 Convention gates

`pnpm db:check` (0 drift), `pnpm lint:migrations`, `check-bolt-catalog.mjs`,
`check-permission-catalog.mjs`, the §17.3 probe-vs-table assertion, the surface-map bare-dash
check printing `0` **plus a fresh `## Surface summary`**, `pnpm docs:catalog` no-diff,
`build-help-index.mjs --check`, `grep -c bursar infra/nginx/*.conf` non-zero x3,
`docker compose exec frontend nginx -t`, `tsc --noEmit`, Biome.

---

## 21. Milestones

| M | Scope | Done when |
| --- | --- | --- |
| **M0** | Scaffold; four Dockerfile edits; **`docker compose build frontend`** (rebuilds 23 SPAs - the slow step); `vite.config.ts` base + port 3023; **nginx in the mandatory §18.1 order**; `services.mjs` **with the env block**; `env-hints.mjs` **with the `/v1` asymmetry**; launchpad + `REDIRECT_MAP`; **Postgres ceiling + Railway counterpart**; **Redis verify-only** | `/bursar/` serves; `/bursar/api/health` 200; `nginx -t` passes; `grep -c bursar infra/nginx/*.conf` x3; `SHOW max_connections` = 200; redis `config get` = 512mb/noeviction **unchanged** |
| **M1** | **Migrations + Drizzle + the generated RLS loop only.** No permission chain (§17.2). | `db:check` 0 drift; `rls-coverage` green |
| **M2** | Vendors, payee normalization + trigram + alias review, requests, settings, **`assertBinAssetReadable` + version pinning** | all five §5.8 cases refuse |
| **M2.5** | **THE ABSENCE SPIKE, classifier in the loop.** Deterministic pre-pass **plus one real full-offer classification path** against fixture text via a recorded-response harness. No DB, no UI. | **Three numbers:** false-absence rate with the classifier in the loop; measured tokens and wall-clock on a **40-page worst-case fixture**; **zero** auto-published `covered` on injection + single-blanket + **split-blanket** fixtures |
| **M3** | Scope derivation (**async-start**), fixed ordinal, chunk-failure handling, global library, tree editor, confirm gate, Stage 0 pre-scan | 14-node tree; crash-resume byte-identical keys; a failed chunk blocks `derived`; a killed derivation is unwedged by the reaper |
| **M4** | Offer ingest + parse, all formats, `parse_quality`, injection + blanket pre-scan, **per-offer §4.3 counters**, malicious-document ceilings | split-blanket fixture quarantines and opens a finding |
| **M5** | **The absence engine**: full-offer classification, three predicates, rejected-candidate enforcement, banding, **§4 cluster incl. §4.7 invariant**, window lattice + pinning + same-row resume, typed deltas, two-phase leveling, totals, **claim fencing** | all §20.2 gates pass, including diff completeness |
| **M6** | Matrix + Diff UI (withheld rows, blocking banner), ws + polling fallback, review queue, help.md/guide.md | Playwright 1-8 |
| **M7** | Award, freeze, `kind`, M:N links, four-path immutability, Bulwark handoff | Playwright 9 |
| **M8** | Spend import (idempotent, resumable, ordinal), expense ingest, four detectors, inbox, renewal radar, worker jobs, digest | Playwright 10-11 |
| **M9** | **The full permission chain (§17.2) + group defaults**; MCP tools + mcp-server env; Bolt events; visibility registration incl. `bill.expense`; surface map + summary; docs catalog; help gate **against a rebuilt image**; seeder + expectations constant; e2e; integration; **promote frontend `depends_on` to `service_healthy`** | all §20.5 gates green; §17.3 probe matches §13.1 |

---

## 22. Reuse ledger

| Capability | Reused from | New |
| --- | --- | --- |
| Fastify skeleton, error handler, shutdown | `burn-api/src/server.ts:56-178` | nothing |
| Health / readiness / metrics | `@bigbluebam/service-health` | nothing |
| Logging + system-error recording | `@bigbluebam/logging` | nothing |
| RLS binding | `burn-api/src/plugins/rls.ts:102-112` | generated policy loop |
| Permissions boot invariant | `burn-api/src/boot/assert-permissions-enforce.ts` | §13.1 catalog |
| Financial flooring | `burn-api/src/plugins/viewer-caps.ts`, `redact-financial-fields.ts` | the shared **seal predicate** |
| LLM access | `burn-api/src/lib/llm-client.ts` | `LlmMalformedError`; **additive proxy `finish_reason`/`usage`** |
| Checkpointed extraction | `extraction.engine.ts:103-173` | **chunk-relative ordinal + chunk-failure handling (2 bugs fixed)** |
| Citation verification | `extraction-logic.ts` `verifyCite` | **per-line + node-term overlap** |
| Byte path from Bin | `worker/src/utils/storage.ts` `getObjectBuffer` | **`assertBinAssetReadable` + version pinning + read-time re-assertion** |
| Visibility client | `packages/shared/src/visibility-client.ts` (`bin.asset` supported) | 6 new types incl. `bill.expense` |
| Structured decode | `@bigbluebam/structured-data` | row-to-line mapping |
| Braid golden-id | `burn-api/src/lib/braid-resolve.client.ts:19-51` | **payee matching is Bursar's own** |
| Lease + heartbeat reaping | `attribution.engine.ts:80`, `sweeps.engine.ts:76` | **run reaper + request unwedge + claim fencing** |
| Bounded slice re-enqueue | `burn-attribute-batch` | leveling and derivation slices |
| Advisory lock discipline | `burn-api/src/lib/advisory-lock.ts` (no HTTP in lock) | nothing |
| Cross-app links | `burn-api/src/lib/entity-links.ts` | five link specs |
| HITL | `agent_proposals` (ref-only) | `bursar_drafts` |
| Bolt publish | `publishBoltEvent` positional (`CLAUDE.md:434`) | §16.1 entries |
| Amendment chain | `burn_engagements` (`0239:13-48`) | award chains |
| Worker registration | `worker.ts:2464-2496` | 10 jobs |
| MCP module + PolicyGate | `burn-tools.ts:55-80`, `register-tool.ts` | §12 tools |
| Help system | `burn-layout.tsx:120`, `build-help-index.mjs --check` | Bursar content |
| SPA shell, money rendering | `apps/burn/src/`, `@bigbluebam/ui` | the Leveling Matrix |
| Seeding | `scripts/seed-gilligan/run-all.mjs:60-79` | `bursar.mjs` + expectations constant |

**Genuinely new:** the absence-detection engine (full-offer closed-book classification, three
verification predicates, the rejected-candidate requirement by line id, the §4 coverage-collapse
cluster with cumulative per-offer caps, the diff-completeness invariant, the window merge
lattice), the comparable-totals valuation ladder, and the immutable baseline that records what
you knowingly did not get.

---

## 23. Non-goals

1. No vendor marketplace or discovery.
2. **No PO issuance, no approval workflow, no enforcing gate** (§9).
3. No three-way match.
4. No payments or AP execution. Zero rows written in Bill.
5. No e-signature.
6. No obligation or notice tracking from executed contracts (Bulwark's).
7. No customer-facing invoicing.
8. **No outbound transport at all.**
9. **No hand-maintained asset register as a primary input path, ever.**
10. No OCR.
11. No FX conversion; the UI **refuses to sum across currencies**.
12. **No embedding/vector retrieval.**
13. **No retrieval layer of any kind.**
14. **No PDF rendering-property detection.**
15. **No agent-decided coverage verdicts** (`decided_by='agent'` does not exist in v1).

---

## 24. v1.1 and beyond

| Cut | Why | Precondition |
| --- | --- | --- |
| **The enforcing bill-api gate** (top item) | bill-api migration + serial preHandler + ported breaker + composition semantics + recovery detector + internal auth surface | advisory-gate usage showing people act on verdicts; §9 has the internal shape |
| **Runtime calibration breaker** | §20.2 covers pre-ship; the runtime breaker needs production volume | >= 3 orgs, >= 30 adjudicated absences each |
| **Vector retrieval** | no embedding provider; every vector path writes zeros | a platform-wide embedding path |
| **Lexical/structural retrieval** | one channel could never clear the band bar | a second channel returns |
| **`normalized_to_term` total** | no term columns; needs a real term model (renewals, mid-term amendments, evergreen), not two columns | a term model lands |
| **PDF rendering-property signals** | needs graphics-state tracking and per-line `render_props` | a parser with graphics state |
| **`decided_by='agent'`** | no write path, gate, or permission; would bypass every §3.5 predicate and §4 cap | a floored, PolicyGate-gated action writing rows that are **always `pending_review`**, never auto-published, never inputs to rollup or totals |
| **`usage.read` / `usage.attest`** | orphaned by the `dormant_seat` cut; unemittable by the manifest generator | the dormant-seat detector returns |
| **`dormant_seat`, `card_fragmentation`** | no third-party telemetry; `bill_expenses` has no funding-source field | CSV import proves out |
| **`duplicate_tool`** | needs several awarded vendors per category | orgs reach ~10 awards |
| **`auto_renew_unreviewed`** | folded into `renewal_cliff` severity | n/a |
| **`orphaned_custody` as a detector** | a one-line join | shipped as a badge |
| **Partitioning** | episodic volume; complicates RLS | measured row counts |
| **OCR**, **FX normalization** | real dependencies; honest failure acceptable | customer demand |
| **`BURSAR_API_INTERNAL_URL` on bill-api** | dead config until the gate exists | ships with the gate |

---

## 25. Open questions and risks

1. **Long-document viability is the biggest unknown.** §3.8's pinned exclusions plus the lattice
   are a design, not a measurement. If the missed-exclusion gate cannot be met, **the v1 envelope
   is 5-page documents**. M2.5 measures it on a 40-page fixture. **Most likely to reshape scope.**
2. **Hand-labelling is on the critical path.** 40 absence tuples, 8 injection, 3 single-blanket,
   the split-blanket set, name-list, legitimate-subprice, and the long-document fixture - labelled
   by someone who understands procurement. **M2.5 cannot complete without it.**
3. **The cumulative caps are judgement calls.** `blanket_cumulative_cap` 4 and
   `evidence_concentration_floor` 0.5 are chosen, not derived. The `legitimate-subprice` fixture
   is the false-positive guard, but a real customer with genuinely bundled quotes may need them
   tuned. Per-org configurable.
4. **Cost.** Full-offer mode is more expensive per node than retrieval would have been. The trade
   is accuracy on the class that matters. Revisit when a real embedding path exists.
5. **Node-term overlap could suppress legitimate coverage** where a vendor's vocabulary differs
   entirely ("beacon commissioning" vs "on-island installation"). The floor is low and failure
   demotes to `ambiguous` rather than `absent`, so it is queue volume, not a wrong claim.
6. **Scope-library content is a moat and a cost.** Six categories needing curation; now global,
   so the investment is made once.
7. **Who may unseal, and whether the vendor is told.** The audit is a requirement (§5.6); the
   policy is a **human decision**.
8. **The weekly digest's delivery channel** - Banter, Blast, or in-app. **Human decision** before
   M8.
9. **The advisory gate may see no use.** If telemetry shows nobody calls it, that is evidence
   *against* prioritizing the enforcing gate in v1.1.
10. **Pre-existing defects to file as tasks**, not work around:
    - `burn-extract-deliverables.job.ts:56-61` and bulwark's equivalent: `bin_assets` joined with
      no org predicate and no `can_access`/`scan_status` check - cross-tenant and private-asset
      document read.
    - `extraction.engine.ts`: `let ordinal = 0` before a resumable loop (dedup-key divergence ->
      duplicate rows), and `log.debug; continue` on `LlmError` letting a run that dropped a whole
      chunk report `succeeded`.
    - `proposals.routes.ts`: `shadowOnly` gating means proposal routes **never deny**, and any org
      admin reads every app's proposals.
    - `brief-embed.job.ts` upserts into a `brief_documents` Qdrant collection **nothing creates**
      (the only `createCollection` is private to beacon-api at `qdrant.service.ts:59-90`).
    - `visibility.service.ts` has no `bill.expense` type - any citation of an expense is silently
      dropped platform-wide.
    - `scripts/help/smoke-help-center.mjs` is hardcoded to Bam and its `OUT` default is a
      hardcoded `D:/Documents/GitHub/...` path absent from this checkout.
    - CSV export escaping: bearing-api and the frontend timeline export write unescaped
      formula-capable cells today; §5.4's helper should be shared.
    - **No `resolver` directive in the nginx configs**, so any reference to a not-yet-running
      upstream takes the whole frontend down at config load. Affects every future app addition,
      not just Bursar (§18.1).

---

## 26. Changelog

### Round 3 (final) - 13 blockers, ~20 majors. All accepted or accepted-with-modification. Two rejections.

**The split-blanket cluster (design + security, converged independently)**

- [security][design] **Four coordinated sub-cap lines defeat the entire §4 cluster.** ACCEPTED in
  full, as the round's central finding. Three fixes: (1) the **"or an itemized list" enumeration
  branch is deleted** - only `explicit_subprice` (per-node monetary sub-price with a distinct
  cited span) enumerates; (2) **the caps are cumulative per offer**, not per line - an
  unsubpriced-mandatory-node count plus an evidence-concentration guard, neither depending on the
  attacker's line count; (3) a **split-blanket fixture** (4 lines x 3-4 nodes, no lexicon token)
  added to §4.6 and the §20.2 gate, alongside a `legitimate-subprice` false-positive guard.
  Round 2's fixture said "*one* all-inclusive line", so the split attack passed CI - the same
  "fixtures prove the wrong thing" failure already seen on the injection corpus (§4.1).
- [security] **Every defense terminates in "does not auto-publish", which converts a false
  `covered` into a silent omission.** ACCEPTED, and this is the more important half. New **§4.7
  diff-completeness invariant**: every `mandatory` node of a confirmed tree appears exactly once
  as `published` / `needs_review` / `unverified`; the identity is a CI gate per fixture; a
  blocking banner and suppression of every "clean" affordance in the UI; and Playwright step 8
  now asserts **14 rows, none missing** rather than "none auto-published", which passed on an
  empty diff.

**DESIGN**

- [design] **`usage.read` / `usage.attest` exist only in §13.1**, orphaned by the `dormant_seat`
  cut, and unemittable by `generate-permission-manifest.mjs` (which walks routes and tools), so
  the probe would **fail on a correct build**. ACCEPTED - both deleted, recorded in §24.
  `spend.read_all` is retained but declared as **route-file permission metadata** (burn's
  financial-flooring pattern) so the generator emits it.
- [design] **Playwright step 5 asserts an outcome §4.5 forbids.** ACCEPTED - rewritten to assert
  the promotion queue and the *absence* of rival nodes from the diff, with the absence assertion
  moved post-promotion; §14's "rival-informed first" phrasing corrected.
- [design] **`blanket_suspected` suppressed published mandatory `absent` verdicts**, so writing
  "turnkey" once bought immunity from the flagship output. ACCEPTED as a **product bug**, not a
  nit: suspicion flags now gate auto-published `covered` **only**; parse-quality and
  window-coverage remain the genuine absence preconditions (§3.6). The reviewer's UI treatment
  ("this offer claims blanket coverage; here is what it does not itemize") is adopted as the
  §4.7 / §19.2 demo.
- [design] **Two of three seeded totals still unproducible**, one level deeper. ACCEPTED - Radio's
  $600 is made genuinely rung 1 (its own optional line, where one observation suffices) and
  Lagoon's $1,200 given the two rival observations rung 2 requires. **All three figures now
  compute from §10.1 as written**, and §19.3 makes the seeder export a single
  `BURSAR_SEED_EXPECTATIONS` constant the Playwright suite imports - this was the third round a
  seed-number mismatch surfaced.
- [design] **§3.9's worked example violated its own caps** and `rejected_limits` had no trigger.
  ACCEPTED - explicit cap contract (preflight `would_exceed`; 422 at start on offers; `partial`
  mid-flight on calls) and the example replaced with 60 nodes x 6 offers, inside the caps.

**SECURITY**

- [security] **Pinned exclusion lines were exempt from fan-out with no verdict restriction**, so
  *"Nothing is excluded: installation, training and warranty are all provided"* takes the flag and
  escapes the load-bearing defense. ACCEPTED - the exemption is scoped to the verdict it exists
  for: a pinned line's matches count toward fan-out **unless the verdict is
  `excluded_explicit`**, with a unit test (§3.8).
- [security] **The seal predicate omitted the two CSV exports and four MCP tools.** ACCEPTED, and
  generalized per the reviewer: the seal moves into the **shared query/repository layer** every
  read passes through (burn's `redact-financial-fields.ts` placement) rather than
  endpoint-by-endpoint, so a new route cannot forget it (§5.6).
- [security] **Bin access checked at attach only**, while parse is async - `scan_status` can flip,
  visibility can flip, `current_version_id` can advance. ACCEPTED - **version pinned at attach**,
  and `scan_status`/`org_id` **re-asserted in the worker immediately before the byte read**,
  failing to `blocked` (§5.8), with two new test cases.
- [security] **Rival promotion gated on member-level unfloored `scope.write`.** ACCEPTED - new
  floored, confirm-required `bursar.scope.promote_rival`, payload echoing
  `contributing_offer_ids` (§4.5, §11, §13.1).
- [security] **`decided_by='agent'` has no write path, gate, or permission.** ACCEPTED, taking the
  **drop** branch: an unspecified enum value is an invitation, the natural implementation would
  bypass every predicate and cap, and the `absent` CHECK exempts only `human` so it would not
  constrain it. There is no agent adjudication path in v1. §24 records the reintroduction
  conditions.

**STABILITY**

- [stability] **Async-start applied to leveling only; derivation still synchronous**, reproducing
  the round-2 blocker on Stage 0 - and **defeating the chunk-relative `dedup_key` fix**, since
  two writers on one checkpoint produce exactly the divergent ordinals that duplicate matrix rows.
  ACCEPTED - identical 202 contract, one chunk per invocation, live-lease re-entry rejection
  stated for both engines in the same place (§3.2, §18.6).
- [stability] **`scope_status='deriving'` has no reaper**, so a crashed derivation wedges
  `confirm` at 409 forever and the flagship is dead on that request with no recovery short of
  psql. ACCEPTED - the reaper **transactionally reverts the owning request's `scope_status`** in
  the same statement as the cold run; same audit for `normalization_status` (§18.6d).
- [stability] **The reaper creates the two-writer race it was added to fix.** ACCEPTED, and this
  is the subtlest finding of the round: a bare status flag does not fence a still-alive writer.
  **Every checkpoint/window/coverage write is conditioned on
  `WHERE id = $run AND claimed_by = $me AND status = 'running'`, and a zero-row update aborts the
  slice**; slices execute serially (§18.6c).
- [stability] **"Continue" must resume the same run row**, or earlier windows go invisible and a
  mandatory `absent` permanently demotes to `ambiguous` after any throttle. ACCEPTED (§3.8).
- [stability] **Spend `dedup_key` discarded legitimate identical same-day charges** - the mirror
  of the doubling bug and harder to notice. ACCEPTED - `occurrence_ordinal` within the source
  file's dedup group. **And the `idempotency-key.ts` citation is dropped**: verified it is an HMAC
  over `BurnPrecheckRequest` against a `.strict()` type, in an app bursar-api cannot import, keyed
  on a **rotatable secret** (every row would re-import after rotation). Replaced with a local
  `sha256` over the canonicalized tuple (§6.1).
- [stability] **`UNIQUE (org, file_sha256)` made a crashed import un-retryable.** ACCEPTED -
  `ON CONFLICT DO UPDATE SET status='running'`, non-`succeeded` batches resume the upsert loop,
  and "0 new" derives from `rows_deduped`, never from the batch row's existence (§6.1).

**BEST-PRACTICES**

- [best-practices] **The M1 done-when is unsatisfiable**: the catalog is generated from route
  files M2-M8 have not written, so M1 would author group defaults against a partial catalog **and
  checksum it immutably** - the exact trap §17.2 documents. ACCEPTED - **M1 is migrations +
  Drizzle + the RLS loop only; the full permission chain moves to M9**, stated explicitly in both
  §17.1 and §21, plus the M1-M8 interim posture (SuperUser-only `/bursar` access) so nobody
  "fixes" the denial by weakening the fail-closed invariant.
- [best-practices] **Playwright step 9 asserts baseline counts that do not follow from the seed**
  (11 + 2 = 13 against 14 nodes, and Radio has no `excluded_explicit`). ACCEPTED - §19.1 states
  Radio's baseline as 14 `included`, and step 9 asserts **structurally**
  (`included + excluded + absent == node count`, warranty `included` with `delta_kind='term'`).
- [best-practices] Count re-derivation. ACCEPTED - reconciled after the `usage.*` deletion and the
  `promote_rival` addition; §17.3 states the sanity target once, explicitly subordinate to the
  table, with the CI assertion recomputing.
- Confirmed RESOLVED by the reviewer: the generated RLS loop, and the "copy every alias verbatim"
  rule (burn carries **twelve**).

**INFRASTRUCTURE**

- [infrastructure] **No `resolver` directive**, so adding a `proxy_pass` to a non-existent
  upstream makes nginx exit at config load and **takes the whole suite down**. ACCEPTED as the
  highest-severity infrastructure finding: hard M0 ordering (container first, confirmed running,
  nginx last), `nginx -t` as an M0 gate, and an explicit rollback note. Also filed as a
  platform-wide pre-existing hazard affecting every future app addition (§25.10).
- [infrastructure] **`BURSAR_API_URL` needs `/v1`; `BURSAR_API_INTERNAL_URL` does not.** ACCEPTED -
  verified at `env-hints.mjs:286-289` with the rationale; both spelled out separately (§18.4).
- [infrastructure] **The Redis premise was false.** ACCEPTED, and this reverses a round-2 edit of
  mine: `docker-compose.yml:36-41` **already reads `--maxmemory 512mb --maxmemory-policy
  noeviction`**. The reviewer's danger analysis is exactly right - a builder told to change a
  block that already reads the target will change the only remaining knob, the policy, causing
  the suite-wide BullMQ corruption the block's own comment warns against. Rewritten as
  **"verify only, change nothing"**, with the actionable half (per-queue retention) moved to §15
  and the Railway counterpart kept as the only real work (§18.5).
- [infrastructure] **M0 does not budget for the frontend rebuild.** ACCEPTED - the SPA dist is not
  bind-mounted (only nginx templates, `docs/apps`, avatars, certs are), so `/bursar/` needs
  `docker compose build frontend`, rebuilding 23 SPAs. Noted as M0's slow step, with the contrast
  that nginx-only changes need just `--force-recreate` (§18.2).
- [infrastructure] **`vite.config.ts` needs `base` and a non-colliding dev port.** ACCEPTED -
  `base: '/bursar/'` (without it every asset 404s and it looks like an nginx bug) and port 3023
  (burn holds 3022), plus dev proxies (§14).

### Rejections

- [design, rejected] **"Add `term_months` / `target_term_months`"** to rescue
  `normalized_to_term`. REJECTED again, consistent with round 2, in favor of the reviewer's own
  alternative (cut to v1.1). Comparing a 12-month to a 36-month quote needs a real term model -
  renewal alignment, mid-term amendments, evergreen terms - not two columns, and two columns would
  leave a half-built model someone later has to undo. Recorded in §24 with the precondition.
- [security, partial-rejection] **"Node-term overlap defeats blanket coverage."** The predicate is
  ACCEPTED (§3.5 predicate 3); the claim about what it defends is REJECTED, unchanged from round
  2 and now reinforced by the split-blanket attack, which has *maximal* term overlap by
  construction. §3.5 states the limitation explicitly. The defenses are §4.3's cumulative caps and
  §4.4's sub-pricing requirement.

### Rounds 1-2 (carried forward)

Braid payee resolution moved in-house; embedding dependency removed; retrieval deleted entirely;
money-in events dropped; two-phase leveling; typed deltas; baseline `kind` + M:N node links;
soft-archive; currency guard and null-term selection; detectors cut from nine to four;
`bursar_drafts`; `assertBinAssetReadable`; help system; gilligan seeder; three nginx files; four
Dockerfile edits; the corrected permission chain; positional `publishBoltEvent` (confirmed);
window merge lattice; per-offer parse quality; Stage 0 injection defense; sealed bids; the
`services.mjs` env block; `env-hints.mjs`.

### Kept unchanged (praised across all three rounds)

- The **rejected-candidate requirement**, hardened twice (engine-supplied ids belonging to the
  offer; no `deterministic` exemption).
- The **honest RLS posture** in §6.3, including the "the backstop is absent today" caveat.
- The **§17.2 two-pass permission diagnosis**, correct from the start, completed in round 2 and
  correctly sequenced in round 3.
