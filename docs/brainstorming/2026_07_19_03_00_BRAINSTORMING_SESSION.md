# BigBlueBam Suite Brainstorm - 2026_07_19_03_00

**Purpose:** Select the next app the BigBlueBam suite should build, then produce a
build-ready, adversarially-hardened design spec for it.

**Protocol:** Seven ideator seats, each proposing five candidate apps under a distinct
innovation lens, then debate, single-app submission, overlap resolution (collapse /
merge-negotiate / discard), and a no-self-vote final ballot. The winner goes to a spec
writer and five adversarial reviewers.

**Suite as of this session (21 shipped products):** Bam, Banter, Basis, Bay, Beacon,
Bearing, Bench, Bill, Bin, Blank, Blast, Blip, Blueprint, Board, Bolt, Bond, Book,
Braid, Brief, Bureau, Helpdesk.

**Seats and lenses:**

| Seat | Lens |
| --- | --- |
| A | AI-native automation and autonomous agent workflows |
| B | Data, intelligence and analytics |
| C | Communication, collaboration and community |
| D | A vertical / industry wedge |
| E | Operator / developer experience and platform tooling |
| F | Engineering and software development |
| G | Creative and marketing |

---

## Phase 1 - Initial proposals

Thirty-five candidates, five per seat. Orchestrator note: the seats converged on
several names independently (Baton proposed by A, C and G for three different products;
Bellwether by B, E and G; Bridge by C, E and F; Brace by D and E; Broker by A and E).
Name collision is not idea collision, and Phase 4 will judge on substance rather than
label. The more interesting signal is thematic: five of seven seats independently
proposed some form of "simulate or verify a change before it lands," and four
independently proposed "mine the cross-app event stream for what fell through the
cracks." Those are the two ideas the suite's own shape is pushing toward.

### Seat A - AI-native automation and autonomous agent workflows

#### Brigade - the agent workforce

- **Names:** Brigade · Brood · Bevy
- **One-line pitch:** Hire, charter, and supervise a roster of autonomous agents that hold standing missions across your whole suite, the way you'd manage staff.
- **Description:** Bolt is deterministic: event, condition, action, all authored up front. Brigade is goal-directed: you write a *charter* in plain language ("keep the Bond pipeline hygienic; nothing sits >7 days without a next step"), attach a tool allowlist, a spend budget, an escalation policy, and a cadence. The agent then plans its own loop each cycle, reads via `search_everything` / composite views, decides, acts through the 833-tool MCP catalog, and files anything above its authority as an `agent_proposal` for a human. Every cycle produces a reviewable trajectory (plan, tool calls, diffs, outcome), and a supervisor model grades whether the charter was actually advanced, feeding a standing performance record per agent.
- **Wedge:** 2-50 person teams who cannot hire an ops person. Today they either buy an agent platform that has no idea what's in their CRM/helpdesk/docs, or they wire brittle Zapier chains. Brigade's axis is **integration depth**: the agent is born inside the data, with identity (`users.kind='agent'`), RLS scoping, per-tool policy, and audit already enforced by the platform. No connector tax, no OAuth zoo, no data egress.
- **Scope:** Entities - `brigade_agents` (charter, allowlist glob, budget, cadence, autonomy tier), `brigade_missions`, `brigade_cycles` (trajectory + cost + verdict), `brigade_interventions`. Surfaces - roster page, charter editor, live cycle timeline, proposal inbox, per-agent scorecard. Flagship MCP tool: `brigade_dispatch(charter_or_agent_id, context)`, spawns a supervised, budgeted, policy-checked run and returns a trajectory id. **Out:** no model hosting, no general chat UI, no code execution sandbox.
- **Platform reuse:** `agent_policies` + register-tool kill switch (already fail-closes service accounts), `agent_proposals`, `agent_runners` heartbeat, `internal-llm.routes.ts` + `llm-providers` for model access, MCP `/tools/call` internal route, `can_access` visibility preflight, worker/BullMQ for cadence, Bolt events for triggers and for `agent.cycle.*` emissions, `@bigbluebam/permissions`.
- **Build argument:** This *is* the lens. The suite has agent identity, policy, audit, and proposals but nowhere for an agent to actually live and work.

#### Bunker - shadow execution and agent evals

- **Names:** Bunker · Backstop · Bellwether
- **One-line pitch:** Every agent action runs first against a copy-on-write shadow of your real data, gets scored, and only promotes to production once it passes your recorded regression suite.
- **Description:** Bunker forks org state into a shadow overlay (writes intercepted at the MCP call boundary and journaled instead of committed), replays the agent's proposed actions there, and renders the exact diff a human would see. A critic model scores each trajectory against the charter and against policy assertions ("never email a contact twice in 24h", "never discount past 15%"). Recorded real incidents become **golden trajectories**, a regression suite that reruns on every prompt change, model swap, or tool-catalog update, so you find out that the next model broke your refund flow before your customers do.
- **Wedge:** The single reason SMBs won't let agents write: they can't preview or regression-test them. Axis is **trust**. There is no vendor selling "staging environment for your agents' effects on your own SaaS data," because no vendor owns the data plane. We do.
- **Scope:** Entities - `bunker_shadow_sessions`, `journaled_writes`, `assertions`, `golden_trajectories`, `eval_runs`. Surfaces - diff viewer, assertion editor, eval dashboard with pass/fail per model, promote/reject. Flagship MCP tool: `bunker_dry_run(tool_calls[])`, returns structured diff + assertion verdicts. **Out:** not a load tester, not a general test framework, no schema-level DB branching (journal, not fork).
- **Platform reuse:** MCP register-tool wrapper (the interception seam already exists for policy checks), `confirm_action` token flow, Drizzle schemas across every app for diff rendering, Blip for trajectory telemetry, `@bigbluebam/permissions`.
- **Build argument:** Autonomy is bounded by verifiability; this is the safety substrate that makes every other agent surface deployable.

#### Baton - dropped-handoff detection and automation induction

- **Names:** Baton · Bloodhound · Breach
- **One-line pitch:** Watches your cross-app event stream and finds the work that quietly fell through the cracks, then writes the automation that would have caught it.
- **Description:** Baton consumes the unified Bolt event stream plus `v_activity_unified` and mines *process*, not records: it learns the org's implicit workflows (deal won, project created, invoice sent) as frequent trajectories, then flags live instances that deviated - the commitment made in Banter that never became a task, the ticket escalated to a name that was on PTO, the invoice shadowing a deal that never closed. Crucially it closes the loop: recurring gaps are compiled into a concrete draft Bolt automation (trigger/condition/action JSON) proposed for one-click adoption. Bolt automates what you thought of; Baton finds what you didn't.
- **Wedge:** Small teams lose revenue to dropped handoffs, not to bad tools. Axis is **discovery**. Process mining today (Celonis et al.) is enterprise-priced, needs a data-engineering project, and stops at a chart. Baton is zero-config because the event bus is already canonical, and it ends in an executable rule.
- **Scope:** Entities - `baton_traces` (correlated cross-app chains via `entity_links`), `baton_patterns`, `baton_gaps`, `baton_suggestions`. Surfaces - gap inbox, trajectory map, suggested-automation review. Flagship MCP tool: `baton_explain_gap(entity)`, returns the expected chain, where it broke, who owns it, the proposed fix. **Out:** does not execute fixes itself (hands to Bolt/Brigade), no BPMN modeling.
- **Platform reuse:** `bolt_event_trace` / `bolt_recent_events`, event catalog (122 registered events), `entity_links`, `v_activity_unified`, Braid golden ids for cross-app entity identity, Bolt template resolver for emitting draft automations, Qdrant for trajectory embedding.
- **Build argument:** Automation that authors itself from observed behavior, the inverse of hand-written rules.

#### Broker - learned LLM routing and AI spend control

- **Names:** Broker · Bursar · Ballast
- **One-line pitch:** One gateway for every AI call in the suite that learns which model is good enough for each job and routes to the cheapest one that still passes.
- **Description:** Every AI feature across 21 apps currently resolves a provider and calls it. Broker becomes that seam: it classifies each request by task signature, shadow-samples a fraction across a candidate model set, scores outputs with a judge model plus captured human accept/reject signals from the surface that made the call, and continuously fits a routing policy per task class. It also enforces per-org, per-agent, per-app budgets with degradation ladders instead of hard failures, caches semantically equivalent calls, and keeps a full prompt/response ledger for audit and replay.
- **Wedge:** AI cost is the fastest-growing unbudgeted line item for the exact team size we target, and quality/price rankings churn monthly. Axis is **cost with evidence**. LLM gateways exist, but none of them can score quality using downstream product signals, because they sit outside the product. We sit inside it.
- **Scope:** Entities - `broker_task_classes`, `broker_routes` (policy versions), `broker_calls` (ledger), `broker_budgets`, `broker_evals`. Surfaces - spend dashboard by app/agent/task, route explorer with quality-vs-cost frontier, budget editor, prompt replay. Flagship MCP tool: `broker_complete(task_class, messages, quality_floor)`, a routed, budgeted, logged completion. **Out:** not a model host, not a fine-tuning platform, no BYO-inference cluster.
- **Platform reuse:** `internal-llm.routes.ts` and `llm-provider.service.ts` (the proxy seam already exists), Redis for semantic cache, Blip for call telemetry, Bench for spend reporting, Bill for chargeback, worker for policy refits.
- **Build argument:** The economic and quality control plane without which an agent workforce is financially unbounded.

#### Bequest - procedural memory for agents

- **Names:** Bequest · Bedrock · Bloom
- **One-line pitch:** Your agents remember how your company actually does things, distilled from what they and your people have already done.
- **Description:** Beacon stores documents humans wrote; Bequest stores behavior nobody wrote down. Each agent cycle and each notable human resolution is captured as an episode (situation, actions, outcome, who corrected it). A consolidation job clusters episodes and distills them into **procedures**, compact, cited, versioned playbooks ("Howell-tier accounts get a call before an invoice reminder"), each carrying a confidence score derived from how often following it produced a good outcome. Agents retrieve procedures, not raw history, at decision time; when a human overrides an agent, that correction is the highest-weight training signal and updates the procedure immediately.
- **Wedge:** Agents that are identical on day 90 to day 1 are toys. Axis is **compounding**: switching cost rises every week, and the org's know-how survives model and staff turnover. No competitor can build this without the cross-app action history we already log.
- **Scope:** Entities - `bequest_episodes`, `bequest_procedures` (versioned, cited, scored), `bequest_corrections`, `bequest_retrievals`. Surfaces - procedure library with provenance, correction feed, "why did the agent do that" trace, per-procedure trust curve. Flagship MCP tool: `bequest_recall(situation)`, returns ranked procedures with citations and confidence. **Out:** not a document KB (defers to Beacon), no per-user personal notes, no model fine-tuning.
- **Platform reuse:** Qdrant (already the suite's vector store for Beacon/Brief/Bond), `v_activity_unified` and `activity_by_actor` for episode capture, `agent_proposals` decisions as labeled correction data, worker for consolidation, `can_access` gating on every retrieval so a procedure never leaks a fact the asker can't see.
- **Build argument:** The learning loop, agents whose competence accrues to the org rather than to the model vendor.

### Seat B - Data, intelligence and analytics

#### Brink

- **Names:** Brink · Bough · Ballast
- **One-line pitch:** Ask "what happens if we do X" and get a simulated forward projection of your pipeline, cash, capacity and delivery dates, built from your own suite history.
- **Description:** Brink learns a coupled forward model from real cross-app history (Bond deal transitions, Bill invoice/payment lag, Book capacity, Bam sprint velocity, Blast response curves) and runs Monte Carlo scenarios over it. The AI's job is the hard part a dashboard cannot do: infer the transition/lag distributions per org, propose the causal wiring between levers and outcomes, then translate a plain-language scenario ("hire two engineers in September, push the Q4 launch six weeks, cut ad spend 30%") into a parameterized perturbation of that model and narrate the resulting distribution with the three drivers that dominate the variance.
- **Wedge:** Founders/ops leads at 5-50 person teams who plan in a spreadsheet that nobody trusts and nobody updates. Basis tells you why a number *moved*; Bench charts what *happened*; nothing in the suite or in SMB tooling answers *what will happen if*. Axis: **forward-looking decision support with no modeling skill and no spreadsheet maintenance**, using data the customer already has in-suite. Now: the coupled data (CRM + billing + capacity + delivery) finally all lives in one platform, which is precisely what makes the joint model possible and what Runway/Causal/Pigment cannot do without a six-week integration project.
- **Scope:** `brink_models` (fitted org model + version lineage), `brink_levers` (typed decision variables), `brink_scenarios`, `brink_runs` (distribution + percentile bands), `brink_assumptions` (each with provenance and an override), comparison surfaces for scenario-vs-scenario and forecast-vs-actual backtest. Surfaces: scenario composer, fan-chart run view, lever inspector, backtest scorecard. Flagship MCP tool: `brink_simulate(scenario_nl | levers[], horizon)` returning percentile bands, driver attribution and assumption citations.
- **Platform reuse:** Bench internal query route for governed source reads; Basis metric definitions as the outcome variables (a Brink target *is* a certified Basis metric, so the forecast and the actual are the same definition); Bond/Bill/Book/Bam via shared DB reads; worker/BullMQ for fit + Monte Carlo jobs; Bolt events (`scenario.threshold_crossed`) to trigger automations; permissions + RLS for per-viewer scoping; MCP for agent-driven planning loops.
- **Build argument:** It is the only proposal that adds a *tense* the suite does not have. Twenty-one apps record and explain the past; zero project the future. It compounds with Basis and Bench instead of competing with them, and "what if" is the single question every buyer asks that the suite currently cannot answer.

#### Bedrock

- **Names:** Bedrock · Brine · Bevel
- **One-line pitch:** A trust layer that continuously learns what your data is *supposed* to look like across all 21 apps, then finds the rot, contradictions and silent staleness before a decision is made on it.
- **Description:** Bedrock profiles every field in every app, infers per-org expectations (value distributions, formats, referential shape, update cadence, cross-app agreement rules) and then flags violations as scored, explained issues: a Bond deal with a close date in the past and no stage change in 90 days, a Bill customer whose address contradicts the Braid golden profile, an invoice with a currency that appears in 0.2% of rows, a metric feed that stopped updating. The AI both *authors the rules it was never told* and drafts a repair proposal with evidence, routed through the existing `agent_proposals` approval queue rather than silently editing anything.
- **Wedge:** Any team whose CRM and billing data has quietly decayed, which is all of them. Data quality tools (Monte Carlo, Soda, Great Expectations) are warehouse-shaped, priced for data teams, and require you to write expectations by hand. Axis: **zero-configuration trust, at application level, for teams with no data engineer**. Now: the suite has enough cross-app redundancy (Bond + Bill + Book + Braid overlap on the same customers) that contradiction detection is finally possible without external reference data.
- **Scope:** `bedrock_profiles` (per field/entity learned shape), `bedrock_expectations` (inferred + human-pinned), `bedrock_issues` (scored, deduped, with evidence), `bedrock_repairs` (proposal-backed), `bedrock_scores` (per-app/per-entity trust score, exposed as a badge other apps can read). Surfaces: trust scorecard, issue triage queue, expectation editor, field profile drill-down. Flagship MCP tool: `bedrock_assess(entity_type, entity_id)` returning a trust score, the open issues and the suggested repairs, so any agent can preflight the data before acting on it.
- **Platform reuse:** shared DB reads across every app schema; `agent_proposals` + `proposal_decide` for human-in-the-loop repair; Braid golden profiles as the arbitration source for identity conflicts; Bolt (`data.issue_opened`, `data.trust_degraded`) for routing; permissions/RLS; worker for nightly profiling sweeps; MCP so *other* agents gate their writes on a trust check.
- **Build argument:** It is the app that makes every other app's AI safer. Every agentic feature in the suite currently assumes its inputs are clean; Bedrock is the first product that verifies that assumption, and it becomes a required preflight in the same way `can_access` is a required visibility preflight.

#### Bounty

- **Names:** Bounty · Beam · Bramble
- **One-line pitch:** A standing research desk of agents that watches the outside world for the accounts, competitors and topics you care about, and lands verified, cited facts directly into Bond, Beacon and Bam.
- **Description:** Every byte in the suite today is first-party. Bounty is the outside-in half: you declare standing *briefs* ("track funding, leadership changes, hiring and product launches for my top 40 accounts"; "watch these three competitors' pricing pages"), and a scheduled agent loop does retrieval, cross-source corroboration, novelty detection against what the suite already knows, and confidence scoring, then writes structured facts with source citations onto real entities via existing upsert tools. The AI is the entire mechanism: dedupe against prior knowledge, decide what is genuinely new, decide what is trustworthy enough to write versus queue for review.
- **Wedge:** Sales, partnerships and founders at SMBs who cannot afford a research analyst and get no signal from ZoomInfo-class enrichment (static firmographics, no narrative, priced per seat at enterprise rates). Axis: **continuous, cited, entity-attached external intelligence that arrives as data rather than as a newsletter**, at a price point that assumes zero analyst headcount. Now: retrieval-plus-corroboration agents are finally reliable enough to write into a CRM under a confidence gate.
- **Scope:** `bounty_briefs` (standing research mandates), `bounty_sources` (allowlisted domains/feeds with trust weights), `bounty_findings` (claim + evidence + confidence + novelty), `bounty_deliveries` (what got written where), digest surface, per-account intel timeline. Deliberately out: no general web browsing UI, no scraping of gated/paywalled content, no unattributed claims. Flagship MCP tool: `bounty_brief_run(brief_id)` and `bounty_facts_for(entity)` returning cited claims scoped to a Bond/Braid entity.
- **Platform reuse:** Qdrant for novelty-vs-known retrieval; Beacon as the durable knowledge sink; `bond_upsert_contact` / `beacon_upsert_by_slug` / `entity_links` as the write plane; Braid to resolve "which company is this article about" to a golden id; worker for scheduled brief runs; Bolt (`finding.published`) to fire alerts; `can_access` preflight before any shared-surface post.
- **Build argument:** It is the only proposal that expands the suite's *data perimeter* rather than rearranging what is inside it. Every other data app in the suite gets better when there is external ground truth attached to entities, and it is the most defensible thing to sell: nobody else is writing cited outside-world facts onto an SMB's own CRM records.

#### Binder

- **Names:** Binder · Bract · Bushel
- **One-line pitch:** Turns the contracts, invoices, statements and spec PDFs sitting in Bin into typed, reconciled, queryable entities with provenance back to the exact page and clause.
- **Description:** Binder classifies each document, infers or applies an extraction schema, pulls typed fields with per-field confidence and a page/bbox citation, then *reconciles* the result against the suite: does this vendor invoice match a Bill expense, does this signed contract's payment terms match the Bond deal, does this renewal date exist in Book. The AI does schema induction from a handful of examples (not brittle per-vendor templates), plus the reconciliation reasoning that turns a parsed document into an assertion about an existing record, with disagreements raised as proposals.
- **Wedge:** Any team drowning in inbound documents whose contents never become data: agencies, services firms, anyone with vendor contracts and supplier invoices. Docparser/Rossum/Ramp-style tools are single-purpose and end at extraction; the value is in the reconciliation, which requires knowing the customer's CRM and billing records. Axis: **extraction plus reconciliation in one system that already owns the counterpart records**, so the output is an actionable discrepancy rather than a CSV.
- **Scope:** `binder_doc_types`, `binder_schemas` (induced, versioned), `binder_extractions` (field + confidence + page citation), `binder_reconciliations` (match/mismatch/missing against a suite record), obligation and key-date registry lifted out of contracts. Out of scope: e-signature, document authoring (Brief), storage (Bin). Surfaces: document-vs-extraction split view with click-to-source highlighting, reconciliation queue, obligations calendar. Flagship MCP tool: `binder_extract(asset_id, schema?)` returning typed fields with citations and proposed reconciliations.
- **Platform reuse:** Bin as the asset store and `@bigbluebam/storage` for bytes; `@bigbluebam/structured-data` codecs and shape detection; Bill/Bond/Book as reconciliation targets; worker for OCR/extraction pipelines; `agent_proposals` for low-confidence fields; Qdrant for similar-document retrieval to bootstrap schemas; Bolt (`obligation.due`, `document.mismatch`).
- **Build argument:** Bin has been accumulating files with no path from bytes to data since it shipped; Binder is the missing edge of that graph and the highest-certainty ROI story here (one caught invoice discrepancy pays for the seat).

#### Bellwether

- **Names:** Bellwether · Bode · Bight
- **One-line pitch:** Unsupervised watch over every entity stream in the suite that surfaces the changes you never thought to build a dashboard for.
- **Description:** Basis explains a metric you defined; Bench charts a question you asked; Blip watches logs you instrumented. Bellwether asks nothing of you: it monitors raw entity event streams across all apps, learns per-org seasonality and baselines, detects level shifts, emerging cohorts and co-movements between unrelated apps (support ticket theme spikes leading churn in Bond, a Book no-show pattern preceding invoice lateness in Bill), and writes a short ranked briefing of only the things that are genuinely surprising. The AI does anomaly detection, cross-app correlation-with-lag, and, critically, the *suppression* judgment that keeps the briefing to three items rather than three hundred.
- **Wedge:** Operators who do not know what to look at, which is the honest state of most SMB leadership. BI tools require you to already know the question; alerting tools require you to already know the threshold. Axis: **question-free discovery** with a hard ranked-scarcity contract, priced for teams with no analyst.
- **Scope:** `bellwether_streams` (registered entity/event feeds), `bellwether_baselines` (learned seasonality), `bellwether_signals` (scored, with lag and correlate), `bellwether_briefings` (ranked, dated, with feedback), `bellwether_feedback` (per-signal useful/noise, which trains suppression). Surfaces: daily briefing, signal detail with the two co-moving series, stream registry. Out: user-defined dashboards, user-defined thresholds, chart authoring. Flagship MCP tool: `bellwether_signals(since, min_score)` so agents subscribe to surprise rather than polling.
- **Platform reuse:** `v_activity_unified` and Bolt event history as the primary stream source; Basis metric snapshots as one input series; Bench for any drill-through rendering; worker for nightly baseline recompute; Banter/Blast for briefing delivery; RLS + `can_access` so a briefing never leaks a signal from data the reader cannot see.
- **Build argument:** It is the cheapest to build of the five (it consumes streams the platform already emits) and the most habit-forming: a daily artifact that people open. Its risk is adjacency to Basis, which is why its contract is strictly *undeclared* signals. If a metric exists in Basis, Bellwether defers to it.

### Seat C - Communication, collaboration and community

Seat C's grounding note: Banter already has `call-transcripts` and a transcription
service, Bay already has token-gated public guest review links, the Bam api has
`guest-invitations`/`guest.routes.ts`, the platform ships `v_activity_unified`,
`entity_links`, `expertise.service.ts`, Qdrant, and 833 MCP tools.

#### Baton

- **Names:** Baton · Bequest · Handoff
- **One-line pitch:** When someone joins, leaves, goes on leave, or changes roles, Baton reconstructs everything they carried in their head and hands it to the next person as a living, verified briefing.
- **Description:** Baton treats *context transfer* as a first-class object. Point it at a person and a scope ("everything Mary Ann owns for the Howell account") and it reads across the whole suite through the platform read plane: their tasks in Bam, deals in Bond, tickets in Helpdesk, docs in Brief, entries in Beacon, channel and thread participation in Banter, calls in Bureau, invoices in Bill. It then synthesizes a *successor package*: the relationships only they hold (people who message them and nobody else), the undocumented decisions they made, the recurring obligations no one else knows about, and the tacit knowledge implied by questions only they ever answer. The AI part is not summarization; it is **absence modeling**: inferring what will break when this person is gone by finding single-threaded dependencies that exist nowhere in any document. Each item becomes a claim with evidence links and a confidence score, routed to the departing person for a one-click "confirm / correct / this is stale" pass while they are still available, then re-rendered as an onboarding path for the successor with the Beacon articles it wrote along the way.
- **Wedge:** Small-to-medium teams (2 to 50) where every departure is a crisis because one person held three functions. There is no product here at all: enterprise "knowledge retention" is consulting, and the SMB alternative is a Google Doc written in the last two days of notice, when the person is least motivated. The trigger is universal, dated, and painful: turnover, parental leave, contractor rolloff, PTO, promotion. Why now: cross-app retrieval over a unified activity view plus vector search is exactly what makes the impossible part (finding the unwritten) possible, and this suite already has that plane built.
- **Scope:** `handoff` (departing actor, successor, scope, deadline), `claim` (inferred obligation/relationship/knowledge item, evidence refs, confidence, verification state), `coverage_gap`, `briefing` (rendered successor view), `continuity_risk_score` per person. Surfaces: continuity dashboard (bus-factor heatmap for the org, running continuously, not just at exit), handoff workspace with the confirm/correct queue, successor briefing reader with cross-app deep links. Flagship MCP tool: `baton_reconstruct_context(user_id, scope)` returning the ranked, evidence-linked claim set. Companion: `baton_bus_factor(project_id)`.
- **Platform reuse:** `v_activity_unified` and `activity_by_actor` for the raw trail; `search_everything` and `resolve_references` for cross-app fan-out; `can_access` visibility preflight so a successor never sees something the departing person could but they cannot; Qdrant for semantic clustering of a person's contributions; Beacon `beacon_upsert_by_slug` to durably write the recovered knowledge; `entity_links` for the evidence graph; Bam `task_upsert_by_external_id` for the successor's onboarding tasks; Bolt events on `handoff.created` / `claim.unverified`; `agent_proposals` for the human-in-the-loop confirmation queue; worker/BullMQ for the standing recompute; permissions/RLS throughout.
- **Build argument:** It is the only one of my five that is *literally impossible* without cross-app AI retrieval, and it is the one that monetizes the suite's breadth rather than adding another surface. Every other app in the portfolio makes an existing job faster; Baton does a job nobody currently does at all. It also gets more valuable with every app the suite ships, which no competitor with one data silo can match.

#### Bind

- **Names:** Bind · Brace · Pact
- **One-line pitch:** Bind extracts every promise your team makes in chat, docs, meetings, and tickets, and tracks whether it was actually kept.
- **Description:** Commitments are made in prose and die there: "I'll get you the deck Friday," "we'll waive the setup fee," "I'll take the migration." Bind is a listener across Banter messages and threads, Banter call transcripts, Brief comments, Board chat, Helpdesk ticket messages, and Bond activities. It classifies utterances into commitments with a promisor, a promisee, an obligation, a due signal (including fuzzy ones like "next week", "after the launch"), and a confidence, then **actively hunts for the discharge evidence**: a Bam task moving to done, a Bill invoice sent, a Bin asset uploaded, a Book meeting held, a Bay approval recorded. What a dumb tool cannot do is close the loop: linking a natural-language promise to the structured artifact that satisfies it, and distinguishing a real commitment from banter, hedging, or a conditional. Unmatched commitments surface as a per-person "open promises" ledger and a per-relationship reliability signal, with a nudge path rather than a shame path.
- **Wedge:** SMB service teams and agencies where the gap between "said in Slack" and "in the tracker" is where clients get lost. Task managers only track things someone bothered to type in twice. The buyer pain is dropped client promises and internal follow-through; the axis is *trust and recall*, not speed. Why now: reliable commitment extraction from messy multi-party dialogue is a recent capability, and the suite owns both the utterance side and the fulfillment side, so verification is possible instead of just detection.
- **Scope:** `commitment` (promisor, promisee, obligation text, source ref, due signal, confidence), `discharge_evidence`, `ledger` per person and per external counterparty, `reliability_signal`. Surfaces: "My open promises" inbox, "Promises made to this client" on a Bond company, escalation view of overdue and unevidenced items. Flagship MCP tool: `bind_open_commitments(actor_or_account)`; companion `bind_link_evidence(commitment_id, entity_ref)`.
- **Platform reuse:** Banter message and transcript reads plus its search route; Helpdesk `ticket_messages`; Brief comments; Bond activities; `entity_links` for the promise-to-artifact edge; Bolt for `commitment.detected` / `commitment.overdue` and for letting customers automate nudges; `agent_proposals` for low-confidence items needing a human yes/no; `can_access` so a promise is only ever shown to people entitled to its source; Bam for optional task promotion; worker for the sweep.
- **Build argument:** The highest-frequency pain of the five, and it feeds every other app rather than competing with them (it *creates* Bam tasks, enriches Bond accounts, closes Helpdesk loops). Risk to acknowledge: extraction precision is the whole product, so a bad v1 is a nuisance generator, which is why the confirm queue is core scope and not a nicety.

#### Bridge

- **Names:** Bridge · Bevel · Liaison
- **One-line pitch:** A shared workspace with your client or partner where an AI membrane translates between what your team says internally and what the customer should see.
- **Description:** Today collaborating with an outside party means either inviting them into your mess or maintaining a parallel fiction by hand. Bridge is a two-sided room per external relationship (client, vendor, partner) that composites internal reality into an external narrative. Every internal artifact proposed for sharing passes a **membrane**: an AI redaction and translation layer that strips internal-only content (margins, blockers phrased bluntly, unrelated accounts, staff names you have not exposed), rewrites jargon and ticket-speak into the customer's register, and flags anything it will not auto-share for human release. In the other direction it normalizes inbound client mess (a forwarded email thread, a screenshot, a rambling voice note) into typed suite objects: a Helpdesk ticket, a Bam task, a Bond activity, a Bay review request. It also keeps a *shared narrative*: a continuously regenerated "where we are" page the client can read at any hour without asking, which is the single most common status-meeting eliminator.
- **Wedge:** Agencies, consultancies, MSPs, and studios, the exact 2-to-50 shape this suite targets, all of whom currently duct-tape a Notion page plus a shared Slack Connect channel plus weekly status calls. Bay covers guest media review and the Bam api has guest invitations, but neither is a durable external *relationship* surface, and neither has a redaction membrane. The axis is trust plus labor: the client gets always-current visibility, the team stops hand-writing status.
- **Scope:** `bridge` (external org, membership, brand), `share_proposal` (internal ref, membrane verdict, redaction diff), `narrative` (regenerated status doc with provenance), `inbound_intake`. Surfaces: external portal (token or guest-auth), internal membrane console showing exactly what the client can see, per-share diff review. Flagship MCP tool: `bridge_render_external(entity_ref, bridge_id)` returning the redacted, translated payload plus a withheld-items list; companion `bridge_intake(blob)`.
- **Platform reuse:** Bam `guest-invitations` and `guest.routes.ts` as the auth foundation, Bay's public token-gated review pattern as prior art; `can_access` preflight as the hard floor beneath the AI membrane so redaction failures cannot leak entitled-only data; Bond for the relationship record and Braid for resolving who the external human actually is; Brief for narrative rendering; Bill, Book, Bay, Helpdesk as sharable object types; Bolt for share and intake events; storage package for attachments.
- **Build argument:** The clearest revenue story of my five, because it is the surface the customer's customer sees, which makes it the hardest thing to churn away from. Honest weakness: the membrane is a safety-critical AI feature, so it must be belt-and-suspenders with `can_access` doing the entitlement work and the model doing only tone and disclosure judgment.

#### Bloom

- **Names:** Bloom · Bramble · Weave
- **One-line pitch:** Bloom maps how communication actually flows through your team and tells you where it is about to fail.
- **Description:** Every message, thread reply, call, mention, review, and co-edit in the suite is an edge in a real social graph. Bloom builds that graph continuously and reasons over its *shape*: who has become a bottleneck routing information between two clusters, which new hire has not formed a single reciprocal tie in three weeks, which channel has gone one-directional, whose questions go unanswered, which two teams that must coordinate have zero overlap, where a decision is stuck because the people arguing are not the people who can approve. It pairs structure with content, so it can say not just "these clusters are disconnected" but "these clusters are both independently working the same problem." The platform has `expertise_for_topic`, which answers "who knows X"; Bloom answers the different and harder question of "how does knowledge move, and where is the flow broken." Output is prescriptive and privacy-preserving: it reports on patterns and aggregates, never on the contents of any individual's messages.
- **Wedge:** Managers and founders of distributed teams who cannot see their org because it happens in text. Organizational network analysis exists but only as six-figure enterprise consulting with a survey instrument that is stale on delivery; Bloom is continuous, passive, and costs nothing extra to collect because the suite already holds the exhaust. Axis: cost and freshness, by two orders of magnitude. Why now: remote and hybrid work made informal ties invisible, and the suite finally has enough communication surface area (Banter, Bureau, Board, Brief, Helpdesk) for the graph to be honest.
- **Scope:** `interaction_edge` (rolled up, weighted, decaying), `cluster`, `broker`, `risk_finding` (isolation, bottleneck, silo, unanswered, single-thread), `intervention`. Surfaces: network map, per-person integration view for the person's own eyes, manager risk digest. Flagship MCP tool: `bloom_flow_risks(scope)`. Hard scope rule: no message content is ever exposed in output, and individual-level views are opt-in and self-visible by default.
- **Platform reuse:** `v_activity_unified` and `activity_query`; Banter channel and thread graph; Bureau presence, knocks, and summons as strong-tie signal; Board and Brief collaborator tables as co-work edges; Helpdesk assignment; the worker for rollups; Bench to publish the graph metrics as dashboards; Basis if the org wants the flow metrics governed and certified; Bolt for `flow.risk_detected`; RLS and permissions for the visibility posture.
- **Build argument:** It is the purest expression of my lens and the most defensible against the "chatbot bolted on" critique, since there is no CRUD product hiding underneath at all. Its risk is political: surveillance perception can kill it, which is why aggregate-only reporting and self-visible individual views are in scope rather than optional.

#### Bulletin

- **Names:** Bulletin · Bazaar · Commons
- **One-line pitch:** A public community space for your users where every question gets a grounded answer immediately, and every unanswered one becomes a documentation task.
- **Description:** The suite can talk to customers one-to-one (Helpdesk) and one-to-many (Blast) but has no many-to-many surface, so customers cannot help each other and the company's answers are trapped in private tickets. Bulletin is a member-facing community where the AI is the founding member: every new post is answered within seconds by a synthesis grounded in Beacon articles, resolved Helpdesk tickets, and prior threads, with citations and an explicit confidence, and is clearly labeled as machine-drafted pending human confirmation. The loop is what matters: questions the AI *cannot* answer well are the highest-signal documentation backlog in the business, so they auto-file as Beacon gaps and Bam tasks with the demand count attached. It also runs the unglamorous work that kills small communities: spam and abuse triage, duplicate merging, thread summarization for late arrivals, escalation of a frustrated poster into a real Helpdesk ticket with context attached, and a weekly "what the community learned" digest routed through Blast.
- **Wedge:** SMB software and service companies whose support cost scales linearly with customers, and who cannot justify Discourse plus Zendesk plus a community manager salary. Cold-start is the reason most community tools fail; a community that is never empty and never slow to answer is a different product from a forum. Axis: deflection cost per ticket, plus the compounding one where the community output improves the knowledge base automatically.
- **Scope:** `space`, `thread`, `post`, `grounded_answer` (with citations and confidence), `knowledge_gap`, `moderation_action`, `reputation`. Surfaces: public or member-gated community SPA, moderator console, gap backlog. Flagship MCP tool: `bulletin_answer_grounded(question, space_id)` returning answer plus citations plus a gap verdict; companion `bulletin_gaps(space_id)`.
- **Platform reuse:** Beacon plus Qdrant as the retrieval spine and `beacon_upsert_by_slug` to write back; Helpdesk for escalation and resolved-ticket corpus; Braid to identify the poster as a known contact; Bond and Bill to gate member-only spaces by account status; Blast for digests; Bin for uploads; Bolt for `thread.unanswered` and `gap.detected`; Bay's public-token pattern for anonymous access; permissions for the moderator tier.
- **Build argument:** The most obvious commercial demand of my five and the only one that touches the customer's customers at scale. Its weakness against the rubric is real and I will name it rather than have someone name it for me: public forums exist, so Bulletin only wins on the grounded-answer plus knowledge-gap loop, which means if that loop is not the centerpiece it degrades into a clone. I rank it fifth for that reason.

**Seat C's own ranking, which it committed to defend:** Baton, Bind, Bridge, Bloom,
Bulletin. "Baton and Bind are the two that cannot be built by anyone who does not
already own twenty-one apps' worth of cross-app context, which is precisely the moat
this suite has and has never yet cashed in."

### Seat D - Vertical wedge (construction and specialty trades)

**Chosen vertical: construction and specialty-trade contractors (2-50 person subs and
small GCs).** Seat D's justification: it is the largest under-digitized industry with
the highest ratio of unstructured evidence (plan sets, spec books, jobsite photos,
voice, PDFs of contracts) to structured data, which is exactly what an LLM-native
product eats and what a CRUD tool cannot. Existing options are enterprise-priced GC
platforms (Procore, Autodesk Build) that subs are forced into as read-only guests, or
Buildertrend-class tools that are just a project tracker with a photo bucket. Margin
leakage in trades is a documented 5-15% of contract value and it leaks through
documents nobody has time to read. The suite already stores every substrate this
vertical needs (Bin for files, Bay for image review, Bill for cost, Bam for tasks,
Bolt for events, Book for scheduling, Blank for forms) and has zero domain reasoning
on top of it.

#### Bid

- **Names:** Bid · Bevel · Bracket
- **One-line pitch:** Drop in a plan set and Bid returns a priced, line-itemed estimate with every quantity traceable back to the sheet and detail it came from.
- **Description:** Bid ingests PDF/DWG drawing sets and spec books into Bin, runs page classification, scale detection, and symbol/assembly extraction, then produces a quantity takeoff where each line links to a sheet coordinate and the spec section that governs it. It prices against the contractor's own historical actuals pulled from Bill invoices and Bam labor, not a generic national cost book, and it flags scope gaps ("no flashing detail on any elevation") and spec-vs-drawing conflicts. The AI part is not OCR: it is reading a 400-page spec book against a 90-sheet drawing set and telling you what is missing, which no human estimator does exhaustively at 2am on a bid deadline.
- **Wedge:** Sub-contractors bidding 15-40 jobs a month at a 20% hit rate. Estimating is the bottleneck and the single biggest source of underbidding. Digital takeoff tools (Bluebeam, STACK) still require a human to trace every quantity by hand; nothing under $1k/mo reads the specs at all. Axis: speed (hours to minutes per bid) and margin accuracy from your own cost history.
- **Scope:** bid, plan_set, sheet, takeoff_line, assembly, cost_source, exclusion. Surfaces: plan viewer with AI-drawn quantity overlays and accept/reject per line, estimate sheet, exclusion/qualification generator, bid-vs-actual retro. Flagship MCP tool: `bid_takeoff_from_plans(plan_set_id, trade)`, traceable line items with confidence and source citations.
- **Platform reuse:** Bin (plan storage, versions), Bay (sheet markup/annotation primitives), Qdrant (spec-section retrieval), Bill (historical actuals + turning the won bid into a schedule of values), Bond (the GC/owner as a deal), Bolt (`bid.submitted`, `bid.won`), worker/BullMQ for the heavy page-parse pipeline, `@bigbluebam/storage`, RLS/permissions.
- **Build argument:** Highest willingness-to-pay moment in the entire vertical (money is decided at bid time), and it is the natural front door: every downstream app in this lens consumes the bid's line items as its baseline.

#### Brace

- **Names:** Brace · Boot · Berm
- **One-line pitch:** Field crews talk and take photos; Brace turns the day into a signed daily log, T&M tickets, and safety records without anyone opening a form.
- **Description:** A foreman speaks 40 seconds into a phone at the end of the day and photographs whatever mattered. Brace transcribes, geo/time-correlates the photos, and reconciles what was said against the day's scheduled scope from Bam, producing a structured daily report, per-worker hours, material used, weather delay entries, and a flagged list of anything that reads as extra work outside contracted scope. It auto-drafts the T&M ticket for that extra work with photo evidence attached and routes it for signature. The AI does the thing nobody in the trades will ever do voluntarily: turn tacit field knowledge into an evidentiary record, at zero data-entry cost.
- **Wedge:** Every sub loses change-order money because the field never documented it. Existing daily-log features are forms, and forms in the field do not get filled out. Axis: capture cost approaching zero, which is the only thing that has ever made field documentation actually happen.
- **Scope:** day_log, crew_entry, photo_evidence, tm_ticket, delay_event, safety_observation. Surfaces: mobile-first voice capture, day timeline, T&M ticket with signature capture, weekly rollup. Flagship MCP tool: `brace_ingest_field_capture(audio, photos, job_id)`, returns structured day log + candidate extras.
- **Platform reuse:** voice-agent (existing Python/LiveKit STT service), Bin (photo bytes), Bay (annotation on photo evidence), Bam (scheduled scope for the day), Bill (T&M to invoice line), Blank (signature-bearing submissions), Bolt (`extra_work.detected`), worker for transcription jobs.
- **Build argument:** It is the daily-habit app, the one that generates the proprietary data the other four reason over. Without Brace, Baseline and Backcharge are reasoning over an empty record.

#### Baseline

- **Names:** Baseline · Beam
- **One-line pitch:** Forensic delay analysis for contractors who could never afford a forensic scheduling consultant.
- **Description:** Baseline holds the as-planned schedule and continuously reconciles it against as-built reality from field logs, photo timestamps, RFI response latency, and weather data, maintaining a live windows-analysis of which activities slipped, who owned the driving cause, and how much time and money that slip is worth. When a GC threatens liquidated damages, Baseline produces a cited, defensible time-impact narrative in hours instead of a $40-80k consultant engagement in months. The AI attributes causation across thousands of small events, which is precisely the labor that makes forensic scheduling expensive.
- **Wedge:** Subs facing backcharges and LD threats settle blind because proving entitlement costs more than the claim. Nothing exists below the six-figure-claim threshold. Axis: cost, by two orders of magnitude, on a capability with no low-end option at all.
- **Scope:** baseline_schedule, activity, update_window, delay_event, causation_link, entitlement_claim. Surfaces: as-planned vs as-built ribbon, driving-path explorer, causation evidence panel, claim narrative export. Flagship MCP tool: `baseline_analyze_window(job_id, from, to)`, returns delay events with owner attribution and cited evidence.
- **Platform reuse:** Bam (activities/dependencies as the schedule spine), Brace or Bin (as-built evidence), Bill (cost of delay), Bench (reporting surfaces), Brief (claim narrative document), Qdrant (evidence retrieval), Bolt (`delay.detected`, `float.consumed`).
- **Build argument:** The single highest dollar-per-user outcome in the vertical, and it is pure AI reasoning with no meaningful non-AI version. It is the clearest answer to "what could this product do that no human tool could."

#### Bulwark

- **Names:** Bulwark · Bailiff
- **One-line pitch:** An agent that reads your contracts and then spends the whole job making sure you don't breach them.
- **Description:** Bulwark ingests the prime/subcontract, general conditions, and exhibits, and extracts an obligation ledger: notice windows for claims, lien deadlines by state, insurance limits and additional-insured requirements, retainage terms, flow-down clauses, and the specific pay-when-paid language. It then watches the live job through Bolt events and fires proactively: "a delay event was logged Tuesday; your contract requires written notice within 5 days or you waive the claim; here is the drafted notice." It also runs the vendor compliance side, chasing expiring COIs and lien waivers from lower tiers autonomously. The AI is doing continuous obligation monitoring, tying contract clauses to real-time job events, which no static document repository can.
- **Wedge:** Small contractors waive real claims constantly by missing a 5-day notice clause nobody read. Contract review is a lawyer at $400/hr, once, at signing, and then never again. Axis: trust and risk avoidance, delivered continuously rather than as a one-time review.
- **Scope:** contract, obligation, notice_deadline, waiver_risk, compliance_doc (COI/W-9/waiver/certified payroll), vendor_tier. Surfaces: obligation ledger per job, deadline radar, drafted-notice queue, vendor compliance matrix. Flagship MCP tool: `bulwark_extract_obligations(contract_asset_id)` and `bulwark_check_notice_risk(job_id)`.
- **Platform reuse:** Bin (contract documents), Bolt (event triggers are the entire mechanism), Blast (autonomous COI chase emails), Blank (vendor doc collection), Bond (vendors/GCs), Bill (retainage and pay-app terms), agent proposals table for human-in-the-loop before any notice goes out.
- **Build argument:** It is the most Bolt-native idea in my set: it turns the existing event bus into a legal early-warning system, which is a platform capability multiplier and not just a new silo.

#### Backcharge

- **Names:** Backcharge · Bump · Billet
- **One-line pitch:** Turns undocumented extra work into priced, evidence-backed change orders and then chases them to signature and payment.
- **Description:** Backcharge continuously diffs what is actually being built and directed against the contracted scope of work from the bid, using field logs, RFI answers, drawing revisions, and email/chat directives. When a GC's superintendent says "just add two more circuits" in a Banter thread or an RFI response silently changes scope, it flags a candidate change order, prices it from the original bid's unit rates, assembles the evidence packet, and drafts the submission. It then manages the pursuit: aging, follow-up, and escalation. The AI catches constructive change directives buried in ordinary communication, which is the specific failure mode that eats contractor margin.
- **Wedge:** The industry norm is that 30-50% of extra work is never billed because catching it requires someone comparing every daily communication against a scope document. Change-order modules in existing tools are forms you fill out after you already noticed. Axis: revenue recovery, directly measurable in dollars, which makes the sale trivially self-funding.
- **Scope:** scope_baseline, directive, change_candidate, change_order, pricing_line, pursuit_state. Surfaces: candidate inbox with evidence, CO builder, pursuit pipeline, recovery scoreboard. Flagship MCP tool: `backcharge_detect_scope_change(job_id, since)`, returns candidates with cited directives and priced impact.
- **Platform reuse:** Banter and Helpdesk (directive text), Bam (scope tasks), Bill (CO becomes an invoice line), Bond (pipeline mechanics for CO pursuit), Qdrant (scope-vs-directive semantic diff), Bolt, Braid (resolving the same GC PM across Bond/Banter/email).
- **Build argument:** The clearest ROI story of the five and the easiest thing to prove in a demo: point it at a finished job's history and show the customer the money they already left on the table.

### Seat E - Operator / developer experience and platform tooling

#### Bridge - AI connector foundry

- **Names:** Bridge · Binder · Bracket
- **One-line pitch:** Describe an outside system in a sentence and Bridge builds, authenticates, and maintains a live two-way integration between it and your BigBlueBam suite, and repairs itself when the vendor changes their API.
- **Description:** Bridge ingests a third party's OpenAPI spec, docs URL, or a handful of sample payloads and synthesizes a typed connector: auth flow, entity mapping onto suite objects (Bond contact, Bill invoice, Bam task, Bin asset), pagination, rate-limit policy, and a set of Bolt event sources. The AI does the part nobody can buy today: it *derives the mapping* by reasoning over real sample records rather than making you hand-configure fields, and it runs a continuous conformance loop. When a vendor response starts failing schema validation, the agent diffs old vs new payloads, proposes a patched mapping, and files it into the existing `agent_proposals` approval queue instead of silently dropping data.
- **Wedge:** Small teams whose data lives in Stripe/Shopify/QuickBooks/HubSpot/Gusto and who currently pay Zapier per task or pay a contractor $8k for a one-off sync that rots in six months. Axis: **integration cost and durability.** Zapier and Make give you triggers, not a maintained typed data contract; iPaaS vendors charge enterprise prices. Why now: nearly every SaaS ships an OpenAPI spec, and models are finally good enough to read one and produce a correct mapping under test.
- **Scope:** `connectors`, `connector_versions`, `mappings`, `credentials` (envelope-encrypted), `sync_runs`, `conformance_findings`. Surfaces: connector catalog, mapping inspector with side-by-side sample-record preview, sync run log, drift review queue. Flagship MCP tool: `bridge_synthesize_connector({ spec_url | samples, target_entity })` returning a dry-run mapping plus test results.
- **Platform reuse:** Bolt (connectors register as event sources and consume Bolt actions), `@bigbluebam/shared` Zod as the contract language for every mapping, worker/BullMQ for sync + backoff, agent proposals for drift approval, permissions + RLS for credential scoping, Blip for sync telemetry, Braid to dedupe inbound people/companies against golden records.
- **Build argument:** Every other app in the suite is worth more the moment outside data flows into it. Bridge is the only proposal here that raises the ceiling on all 21 existing products, and it converts the suite's biggest objection ("it doesn't talk to my Stripe") into a sentence a customer types.

#### Broker - publish your business as a governed agent surface

- **Names:** Broker · Bazaar · Bailiff
- **One-line pitch:** Turn your company's data and processes into a safe, metered, auditable MCP endpoint that your customers', partners', and vendors' AI agents can actually use.
- **Description:** Broker lets an org compose a *published* tool surface from suite data and Bridge connectors ("check my order status", "book an install slot", "submit a claim") and hand it to outside agents. The AI is the guardrail, not the plumbing: a policy compiler turns plain-language rules ("resellers may see their own orders, never margin") into enforced per-caller scopes, an intent-risk classifier scores each inbound call, and an anomaly agent watches call sequences for extraction patterns (an outside agent walking your customer list one lookup at a time) and throttles or escalates before damage. Every exchange is replayable and priced.
- **Wedge:** SMBs who are already being asked "do you have an agent endpoint?" by larger customers and whose only options are (a) nothing, (b) a raw API with no per-caller policy, or (c) an enterprise API-gateway stack they can't staff. Axis: **trust and time-to-publish**, hours rather than a quarter, with the audit trail an enterprise buyer demands. Why now: agent-to-agent commerce is arriving and nobody has an SMB-grade safe front door.
- **Scope:** `surfaces`, `published_tools`, `audiences`, `caller_identities`, `policies`, `call_ledger`, `risk_findings`. Surfaces: surface builder (pick tools, write policy in prose, see the compiled scope), caller directory, live call ledger with replay, anomaly review. Flagship MCP tool: `broker_publish_surface({ tools, audience, policy_prose })` returning the compiled policy plus a red-team report of what the audience could extract.
- **Platform reuse:** the existing 833-tool MCP catalog and `register-tool` policy middleware (extended from internal service accounts to external callers), `visibility.can_access` preflight per response, `@bigbluebam/permissions`, agent identity/audit tables, outbound webhooks for callbacks, Bill for metering and invoicing calls, Blip for the call ledger.
- **Build argument:** This is the only idea that makes BigBlueBam a *platform other companies' agents pay to talk to*, and it monetizes per-call rather than per-seat. It also uniquely reuses the single most valuable asset we already built and today only expose inward: the MCP catalog.

#### Badge - access reasoning and least-privilege agent

- **Names:** Badge · Bastion · Bulwark
- **One-line pitch:** Ask in plain English who can reach what across all 21 apps, simulate any permission change before it lands, and let an agent run your access reviews.
- **Description:** Badge builds a live authorization graph across the suite's `app.resource.verb` catalog, org memberships, project scoping, guest links, API keys, and service accounts, then joins it against `activity_log` to see what people *actually* touch. The AI answers counterfactuals no ACL screen can: "if I move Dana to Contractor, what breaks?", "what does this departing employee still hold?", "which of the 47 permissions on this role has nobody exercised in 90 days?" It drafts least-privilege role proposals with evidence, and runs quarterly recertification as an agent workflow that nudges owners in Banter and files decisions for audit.
- **Wedge:** Teams of 10-50 chasing SOC 2 / customer security questionnaires with no security hire. Axis: **cost and coverage**. Vanta/Drata start around $10-20k/yr and read your *other* SaaS from the outside; Badge sits inside the suite where the actual grants live and costs a fraction. Why now: 21 apps plus agent service accounts means permission surface has outgrown any human's ability to hold it in their head. Also the first product that governs *agent* privilege, which no compliance vendor covers well.
- **Scope:** `access_snapshots`, `effective_grants` (materialized), `simulations`, `review_campaigns`, `attestations`, `risk_findings`. Surfaces: "who can see this?" search, person access dossier, change simulator with diff, recertification campaign console, evidence export. Flagship MCP tool: `badge_simulate_change({ subject, proposed_change })` returning gained/lost capability with the affected real records.
- **Platform reuse:** `@bigbluebam/permissions` resolver + generated catalog, RLS GUC posture, `visibility.service.ts`, unified `v_activity_unified` for usage evidence, agent identity/policy tables for agent privilege, Bench for evidence reporting, Bolt for campaign nudges, Banter for owner prompts.
- **Build argument:** It is the cheapest to build well (the permission catalog and activity plane already exist) and the fastest to a paid checkbox, because "we need this for our SOC 2" is a budget line rather than a preference.

#### Brace - on-call agent and incident memory

- **Names:** Brace · Bunker · Blaze
- **One-line pitch:** When something breaks, Brace has already correlated the alert with the change that caused it, drafted the diagnosis, and told the one person who can fix it.
- **Description:** Blip raises watches; Brace owns everything after. It opens an incident, then an investigation agent pulls the correlated slice (Blip log windows, Bolt execution failures, Bridge sync errors, deploy/config changes, Helpdesk ticket spikes) and produces a ranked causal hypothesis with the exact evidence lines cited, not a summary. It routes by *demonstrated expertise* (who has touched this code path, this Bolt rule, this customer before) rather than a static rotation, and it maintains incident memory so recurrence is detected across months: "this is the fourth time the Stripe connector failed after a token refresh; here is the fix that worked in March."
- **Wedge:** Small teams running something customers depend on, where "on-call" is two people and a phone. Axis: **time-to-diagnosis and no rotation tax.** PagerDuty/incident.io sell routing and timelines and leave diagnosis to you; they also can't see inside your product's data the way a suite-native tool can. Why now: the correlation-plus-citation step is exactly what models became reliable at, and Blip already produces the substrate.
- **Scope:** `incidents`, `signals`, `hypotheses` (with evidence refs), `timeline_events`, `responders`, `retros`, `recurrence_clusters`. Surfaces: incident room (live timeline + hypothesis panel), severity triage, retro drafter, recurrence board. Flagship MCP tool: `brace_diagnose({ incident_id })` returning ranked hypotheses with cited Blip entries and Bolt execution ids.
- **Platform reuse:** Blip watches/entries/transforms as the signal source, Bolt observability (`bolt_event_trace`, `bolt_recent_events`), `expertise_for_topic` for routing, Bureau summon/knock for pulling a responder into a live room, Banter for the incident channel, Beacon for publishing the retro, Brief for the retro doc.
- **Build argument:** It is the sharpest demonstration in this set that the suite's *cross-app* data is a moat. No standalone incident tool can see your logs, automations, tickets, and people graph at once, and diagnosis quality is a function of exactly that breadth.

#### Bellwether - consequence simulation before you ship a change

- **Names:** Bellwether · Beta · Bluff
- **One-line pitch:** Replay your own history against a proposed change (an automation rule, a price, a policy, a workflow) and see what it would actually have done before anyone lives with it.
- **Description:** Bellwether captures a versioned, replayable substrate of past org events (Bolt events, Blip entries, Bond stage transitions, Bill invoices, Book bookings) and runs a candidate change against it counterfactually. Bolt's existing AI-assist writes you a rule; Bellwether tells you that rule would have fired 1,400 times last quarter, emailed the same customer nine times, and misfired on the two deals that mattered. Where deterministic replay is impossible (human responses, external systems), the AI builds a calibrated behavioral model from your own history and reports confidence intervals rather than a fake number, plus a plain-language list of the surprises it found that you did not ask about.
- **Wedge:** Any operator who has broken something with a well-intentioned automation, pricing tweak, SLA change, or permission edit. Axis: **change confidence with no staging environment**. The alternative today is "turn it on Friday and watch," and A/B tooling is priced and shaped for consumer-scale traffic, which SMBs do not have. Why now: replay plus a learned response model is only newly tractable, and the suite is the rare place where the whole causal chain from event to invoice is in one store.
- **Scope:** `scenarios`, `baselines` (frozen event windows), `candidates` (a diff against current config), `simulation_runs`, `findings`, `promotions`. Surfaces: scenario builder, run comparison (baseline vs candidate with divergence highlighting), surprise feed, one-click promote-to-live. Flagship MCP tool: `bellwether_simulate({ candidate, window })` returning divergence metrics, affected entity samples, and unrequested findings.
- **Platform reuse:** Bolt event history and rule definitions, Blip's retained partitioned entries as the replay tape, Bench/Basis for metric definitions used as outcome measures, Braid golden records so replayed customer effects are counted per real person, worker/BullMQ for long simulation runs, agent proposals for promote approval.
- **Build argument:** It is the least clonable idea on this list. It is worthless without a deep, unified event history, which is precisely what the suite has and no point solution can assemble. It also makes every automation the suite sells safer to adopt, which lifts Bolt, Blast, Bill, and Bond activation together.

### Seat F - Engineering and software development

Seat F's grounding note: `apps/api/src/routes/github-integration.routes.ts` +
`github-webhook.routes.ts` are the *entire* code surface today (234 + 288 lines,
push/PR webhook to task state transition via `decidePrTransition`, nothing more). No
code indexing, no review, no ownership, no release/incident concept anywhere in the
suite. Qdrant is already wired (Beacon/Brief/Bond), and `llm-provider.service.ts`
gives org-scoped encrypted BYO-LLM keys for free.

#### Blame

- **Names:** Blame · Bough · Bedrock
- **One-line pitch:** Ask your codebase *why* it is the way it is, and get an answer backed by the commit, the ticket, the doc, and the argument that produced it.
- **Description:** Blame continuously indexes repo content (AST-chunked, not line-chunked) into Qdrant and joins it against the causal trail the suite already stores: the Bam task, the Brief spec, the Beacon decision record, the Banter thread, the Helpdesk ticket that triggered the change. The AI is not a code-search box; it builds and maintains a **why-graph** where every symbol has provenance edges to the human intent that created it, and answers two questions no tool answers today: "why does this exist / what happens if I delete it" and "what else must change if I change this." Impact analysis is hybrid: static call/dependency traversal for reachability, retrieval-augmented reasoning for the non-obvious couplings (config keys, migration ordering, event names, doc claims) that static analysis structurally cannot see.
- **Wedge:** Buyer is the 5-30 dev team where two people hold all the context and one of them is leaving. The pain is not "I can't find the code," it's "I don't dare touch it." GitHub code search, Sourcegraph, and Copilot all see the code but none of them see the *decision*; they cannot join a symbol to the Slack argument and the spec revision, because they do not own those surfaces. BigBlueBam does own them. Axis: **context completeness**, an answer quality no code-only vendor can reach.
- **Scope:** `repos`, `symbols`, `chunks`, `provenance_edges`, `impact_queries`, `stale_claims`. Surfaces: repo browser with a "why" rail, an impact-radius view for any symbol/file/PR, and a doc-drift inbox (docs in Brief/Beacon that the code has since contradicted). Flagship MCP tool: `blame_impact_of(change_spec)`, ranked list of affected symbols, docs, tests, migrations, owners, plus confidence and evidence per hop.
- **Platform reuse:** Qdrant + Beacon's `embedding.service.ts` pattern, `entity_links` (already the durable cross-app link table), `expertise_for_topic` for owner inference, `llm_providers` BYO keys, Bin for repo blob storage, MCP `can_access` preflight, RLS.
- **Build argument:** It is the substrate the other four want. Ship Blame and every future engineering feature in the suite gets code-awareness for free; skip it and Bar/Bridge/Blaze each rebuild a worse half of it.

#### Blaze

- **Names:** Blaze · Brigade · Bell
- **One-line pitch:** An AI incident commander that opens the war room, names the likely cause, keeps the timeline, and hands you the postmortem already written.
- **Description:** A Blip watch fires; Blaze declares an incident and runs it. The AI does the coordination work a human IC does badly under stress: it correlates the anomaly window against recent deploys and merged PRs, ranks candidate causes with evidence, pages the inferred owner (from code ownership + Bam activity, not a stale rota), opens a Bureau/LiveKit room with the right people summoned, and narrates a live timeline into Banter. Every action, message, log excerpt, and dashboard state is captured as it happens, so the postmortem is a *derived artifact* rather than a Monday-morning archaeology dig. It lands in Beacon with follow-up tasks already filed in Bam and linked back to the incident.
- **Wedge:** Buyer is the SMB team that just got its first real customers and has no PagerDuty/incident.io budget or headcount for an on-call program. Today they get a Blip alert in a channel and improvise. The wedge is that everyone else sells alerting *or* paging *or* status pages as three products; the suite already has telemetry (Blip), presence and instant rooms (Bureau/LiveKit), chat (Banter), KB (Beacon), and tasks (Bam). Blaze is the thin, high-value AI spine across them. Axis: **time-to-coordinated-response**, plus cost (one product instead of three subscriptions).
- **Scope:** `incidents`, `severities`, `timeline_events`, `hypotheses`, `responders`, `postmortems`, `action_items`. Surfaces: incident console (live timeline + hypothesis board), incident history, postmortem editor, public/internal status page. Flagship MCP tool: `blaze_declare(signal_ref, severity?)`, creates incident, returns ranked hypotheses with evidence and the summoned responder set.
- **Platform reuse:** Blip watches as trigger source, Bolt event bus (`incident.declared` / `.mitigated` / `.resolved`), Bureau + `@bigbluebam/bureau-client` docked call box, `livekit-tokens`, Banter, Beacon, Bam task creation, worker/BullMQ for SLA and escalation timers, agent proposals for HITL on risky mitigations.
- **Build argument:** Highest reuse-to-new-code ratio in my five and the most visceral demo: an alert becomes a staffed war room and a finished postmortem with zero human coordination.

#### Bar

- **Names:** Bar · Bailiff · Bevel
- **One-line pitch:** Every change is reviewed against what it was *supposed* to do, not just against the linter.
- **Description:** Bar is a conformance gate, not another static analyzer. When a PR opens, it resolves the change back to its intent (the Bam task, the Brief spec section, the Helpdesk ticket, the Bearing key result) and reasons about the diff against that intent: does it implement the stated acceptance criteria, does it silently expand scope, does it violate a decision recorded in Beacon, does it break a documented API the surface map claims, does it touch a certified Basis metric's definition. It also learns house rules from your own merged history and review comments rather than from a generic ruleset, and emits a verdict with cited evidence plus a signed **conformance record** attached to the change. Repeated human overrides retrain the rule, so the gate gets quieter over time instead of louder.
- **Wedge:** Buyer is the team where review is the bottleneck and where the expensive bugs are not syntax errors but "we shipped something that does not match what we promised the customer." CodeRabbit/Greptile review the diff in isolation because that is all they can see; they have no ticket, no spec, no metric contract. Axis: **defect class covered**, spec drift and scope creep, which no diff-only reviewer can detect.
- **Scope:** `reviews`, `intent_links`, `findings`, `house_rules`, `overrides`, `conformance_records`. Surfaces: review inbox, per-change verdict page with evidence trail, house-rules panel with learned-rule provenance, override analytics. Flagship MCP tool: `bar_review(change_ref)`, findings array with `severity`, `intent_source`, `evidence[]`, `suggested_fix`, and a merge verdict.
- **Platform reuse:** Blame's index if built (degrades gracefully to its own), `agent_proposals` for human-in-the-loop verdicts, Bolt events, permissions package for merge-gate authority, `llm_providers`, existing `github-integrations` webhook plumbing.
- **Build argument:** It is the only idea here that turns the suite's own scattered intent records into enforcement. It makes Brief, Bearing, and Helpdesk *load-bearing* instead of decorative.

#### Buoy

- **Names:** Buoy · Belt · Bake
- **One-line pitch:** Kills flaky tests and slow pipelines automatically, so a red build always means something is actually broken.
- **Description:** Buoy ingests every CI run (JUnit/JSON reports plus logs) and models each test as a time series rather than a pass/fail. The AI separates genuine regressions from flakes by correlating failures against the diff, the runner, concurrency, time-of-day, and co-failure clusters; when it establishes flakiness with confidence it quarantines the test, files an owned Bam task with a reproduction hypothesis and the exact rerun command, and keeps the signal honest. It also does the work nobody has time for: auto-bisect to the introducing commit, detection of the slowest and least-valuable tests (high runtime, never catches a bug), and pipeline shape recommendations backed by measured wall-clock savings.
- **Wedge:** Buyer is any team whose developers have started saying "just re-run it." That sentence is the moment CI stops being a safety net, and it happens to every team at roughly 200 tests. There is no affordable product for this; the incumbents are enterprise-priced or DIY scripts. Axis: **trust in the build signal**, with a hard, measurable ROI in CI minutes and developer wait time.
- **Scope:** `pipelines`, `runs`, `test_cases`, `failure_clusters`, `quarantines`, `bisect_jobs`, `cost_reports`. Surfaces: suite health dashboard, per-test forensic timeline, quarantine queue with expiry, flake leaderboard, cost/duration report. Flagship MCP tool: `buoy_triage(run_id)`, per-failure classification (`regression` | `flake` | `infra` | `env`) with confidence, suspected commit, and recommended action.
- **Platform reuse:** Blip's ingest pattern (bearer-token ingest, field indexing, retention sweeps) applied to CI artifacts, worker/BullMQ for bisect jobs, Bolt events (`build.regressed`, `test.quarantined`), Bam task creation, Bench for reporting, Bin for artifact/log storage.
- **Build argument:** The narrowest, most provable value of the five. You can put a dollar figure on it in week one, which makes it the easiest thing to actually sell.

#### Bridge

- **Names:** Bridge · Bore · Burrow
- **One-line pitch:** Declare a migration once and Bridge drives it to completion across every repo and service, step by verified step, over months.
- **Description:** You state an intent ("remove this column suite-wide," "move all services off this library," "expand-contract this API"). Bridge plans it into an ordered dependency graph of concrete steps, then executes as a long-running campaign: opens scoped PRs, tracks which call sites remain, and refuses to advance to the contract step until it has verified in production telemetry that the old path is genuinely dead. That last part is the AI-native core. It fuses static reachability with live Blip evidence and Basis metric checks to answer "is it actually safe to delete this yet," which is exactly the question that leaves half-finished migrations rotting in every codebase for years. Campaigns survive reassignment, reprioritization, and staff turnover because the plan, not a person, holds the state.
- **Wedge:** Buyer is the team on its second or third year of a codebase, carrying four abandoned migrations. Codemod tools do the mechanical edit and then abandon you; PM tools track the campaign but understand nothing about the code. Nobody owns the multi-month middle. Axis: **completion rate**, the only tool that closes migrations instead of starting them.
- **Scope:** `campaigns`, `steps`, `targets` (call sites/files/services), `verifications`, `waivers`, `rollback_plans`. Surfaces: campaign board with per-target burndown, step gate view showing evidence for/against advancing, waiver queue, org-wide "open campaigns" roll-up. Flagship MCP tool: `bridge_plan(intent)`, ordered step graph with per-step exit criteria, blast radius, and the verification query that will prove each step complete.
- **Platform reuse:** Blame's dependency graph, Blip live telemetry as the deadness oracle, Basis certified metrics as gates, Bolt for step transitions, Bam for the human work items, worker/BullMQ for the long-running campaign ticks, agent proposals for advance/rollback approvals.
- **Build argument:** The most differentiated idea I have. It is the only one with no credible incumbent at any price point, and the expand-contract discipline this very repo enforces by hand is the proof the problem is real.

### Seat G - Creative and marketing

Seat G's grounding note: no app in the suite covers brand governance, social/multi-channel
publishing, creative-attribute performance, competitive positioning, or campaign
orchestration. Blast owns email only, Bay owns review/approval workflow, Bin owns bytes.
Basis decomposes *governed numeric metrics*; nothing reasons about *creative content*.

#### Bevel

- **Names:** Bevel · Badge · Bulwark
- **One-line pitch:** A brand system that reads your approved work, learns the rules nobody wrote down, and blocks off-brand artifacts before they ship.
- **Description:** Bevel ingests your existing approved corpus (Bin assets, Blast sends, Beacon articles, Brief docs, Bay-approved creative) and induces a machine-checkable brand model: voice vectors, tone bands, lexicon and banned-claim lists, palette and type tolerances, logo clear-space, legal/claim substantiation rules. Every new artifact gets scored pre-publish with *specific, cited diffs* ("this subject line is 2.1 sigma off your voice centroid; nearest approved exemplar is X; 'guaranteed' is a banned claim per policy Y"). The AI is the product: a style guide is a PDF, a linter needs rules a human must author, and neither can learn a brand from examples or judge a hero image's crop against clear-space intent. Bevel does both, and it re-learns as approved work accumulates.
- **Wedge:** Agencies running multiple client brands and 5-50 person marketing teams where brand drift is constant and enforcement is one overloaded brand manager. Axis: **trust + speed**, eliminating the human review bottleneck that today sits between "creative done" and "creative live." Now, because vision+language models finally judge subjective brand fit reliably enough to cite evidence.
- **Scope:** `brand`, `brand_rule` (learned or authored, each with provenance), `exemplar`, `check_run`, `violation`, `waiver`. Surfaces: brand home (the induced guide, human-editable), check console, per-artifact verdict card embedded in Bay/Blast/Beacon. Flagship MCP tool: `bevel_check_artifact(brand_id, artifact_ref)`, verdict + cited violations + suggested rewrite.
- **Platform reuse:** Bin (source bytes via `@bigbluebam/storage`), Bay (verdict rides the review decision), Blast/Beacon/Brief (corpus + pre-send gate), Qdrant (voice/visual embeddings), Bolt (`artifact.checked`, `brand.violation` events to block or route), agent_proposals for waivers, permissions + RLS per brand.
- **Build argument:** Every other app in the suite *produces* creative; none of them can tell you if it is on-brand. Bevel is the one idea that makes 6 existing apps better on day one, and it is unbuildable as CRUD.

#### Baton

- **Names:** Baton · Barrage · Bloom
- **One-line pitch:** Write one brief; a creative-director agent plans and drafts the entire multi-artifact campaign across the suite as reviewable proposals.
- **Description:** You give Baton a goal and constraints ("launch the fall service tier to lapsed SMB accounts, 3 weeks, budget-light"). It plans a dependency graph of artifacts (Bond segment, Blast sequence, landing form in Blank, booking page in Book, asset requests into Bay, task plan into Bam, follow-up nurture in Bolt) then *executes it* through the MCP catalog, landing every write as an `agent_proposal` a human approves or edits. It replans when reality moves: an asset gets rejected in Bay, Baton reshuffles the sequence and rewrites the dependent copy. The AI is the planner and the executor; no CRUD tool can hold a campaign's cross-app dependency graph in its head.
- **Wedge:** Small marketing teams and agencies who lose 60-80% of campaign time to assembly and coordination, not to ideas. Axis: **speed and integration**, a one-line brief to a fully wired, human-reviewable campaign in minutes. No competitor can do this because no competitor owns the CRM, the email tool, the forms, the scheduler, and the DAM behind one auth boundary.
- **Scope:** `brief`, `campaign_plan`, `plan_node` (typed artifact + target app + tool call), `run`, `proposal_batch`, `replan_event`. Surfaces: brief intake, plan graph canvas (approve/edit/reject per node), run timeline, live campaign dashboard. Flagship MCP tool: `baton_plan_campaign(brief)`, plan graph, plus `baton_execute_node(node_id)`.
- **Platform reuse:** The single biggest consumer of the 833-tool MCP catalog and the agent_proposals approval queue; Bolt for triggers and replan events; Bond/Blast/Blank/Book/Bay/Bam as execution targets; Bevel as the pre-flight gate; visibility preflight (`can_access`) for anything it cites.
- **Build argument:** This is the app only BigBlueBam can ship. It converts the suite's breadth from a checklist feature into a compounding moat, and it is the purest expression of "agent-operable surfaces" in the whole slate.

#### Bellwether

- **Names:** Bellwether · Beam · Bloom
- **One-line pitch:** Learns which *creative attributes* drive results, not which assets, so your next ad is better, not just measured.
- **Description:** Bellwether runs vision and language models over every published artifact (Blast emails, Bay-approved video and stills, social posts, landing copy) and decomposes each into attributes: hook archetype, promise type, reading level, CTA placement, dominant palette, face-vs-product, first-3-seconds motion, length. It joins those attributes to outcomes across the suite (Blast engagement, Blank submissions, Book bookings, Bond pipeline) and reports at the attribute level with confidence and sample size: "curiosity hooks beat benefit hooks by 34% on lapsed segments, n=41, holds across 3 quarters." Then it generates the next creative variant conditioned on the winning attributes. Distinct from Basis, which decomposes governed numeric metrics via deterministic drivers; Bellwether's inputs are unstructured pixels and prose, and its drivers are inferred content features.
- **Wedge:** Anyone spending on creative without a data team. Today the choice is enterprise creative-analytics platforms priced at agency scale, or nothing. Axis: **cost + integration**, it works because the suite already holds both the creative and the outcome, so there is no tagging, no pixel plumbing, no attribution project.
- **Scope:** `artifact_fingerprint`, `attribute` (taxonomy, extensible), `outcome_link`, `experiment`, `finding`, `variant_suggestion`. Surfaces: attribute leaderboard, finding feed with evidence, artifact teardown view, "make me another one like the winners" generator. Flagship MCP tool: `bellwether_explain_performance(artifact_ref | segment)`, ranked attribute effects with evidence.
- **Platform reuse:** Bin/Bay for bytes, Blast engagement events, Blank submissions, Book bookings, Bond deals, Braid to unify the person across all of them (this is where golden records finally pay off in marketing), Bench for chart rendering, worker/BullMQ for extraction jobs, Qdrant for similarity.
- **Build argument:** It is the only proposal that closes the loop from output back to input. The suite currently measures marketing but cannot make it better. It also monetizes Braid and Basis rather than duplicating them.

#### Bullhorn

- **Names:** Bullhorn · Blurb · Broadcast
- **One-line pitch:** Publish a *claim*, not a post. The agent renders channel-native variants, schedules them, and retires the ones that stop working.
- **Description:** The atomic unit in Bullhorn is a message claim with its evidence and expiry, not a scheduled text blob. From one claim the agent generates channel-native renderings (long-form, short social, thread, image caption, community reply) that respect each channel's idiom and the Bevel brand model, then paces them so the same claim is not repeated into fatigue. It watches engagement and either forks a claim into a better-performing framing, throttles it, or retires it. It also drafts *responses* to inbound mentions with the claim library as grounding, so replies stay consistent. A scheduler is a queue; Bullhorn is a claim lifecycle manager, which is the part humans actually do badly.
- **Wedge:** SMB and agency social/content teams currently paying for a scheduler that does zero thinking. Axis: **integration + cost**. The claim library is grounded in the org's own Beacon knowledge and Bond wins, so the copy is factually anchored rather than generically generated, and it ships inside a suite they already pay for.
- **Scope:** `claim` (with evidence refs + expiry), `rendering`, `channel_connection`, `schedule_slot`, `fatigue_signal`, `inbound_mention`, `reply_draft`. Surfaces: claim library, calendar, per-channel queue, mention inbox. Flagship MCP tool: `bullhorn_render_claim(claim_id, channel)`, brand-checked draft + suggested slot.
- **Platform reuse:** Beacon and Brief as evidence sources, Bin for media, Bevel for the brand gate, Bellwether for the fatigue and performance signal, Bolt for scheduling triggers and event fan-out, banter-style scheduled-post worker patterns already proven in `apps/worker`.
- **Build argument:** It is the missing distribution surface (Blast covers owned email and nothing covers everything else) and the claim-lifecycle framing keeps it from being a Buffer reskin.

#### Bloodhound

- **Names:** Bloodhound · Bracket · Sightline
- **One-line pitch:** An always-on analyst that watches your competitors and your own win/loss, and keeps your positioning document honest.
- **Description:** Bloodhound continuously crawls a tracked competitive set (sites, pricing pages, ad copy, changelogs, review sites, job posts) and diffs them over time, while simultaneously mining your own Bond win/loss notes, Helpdesk tickets, and Banter deal chatter for the language customers actually use. It maintains a *living* positioning artifact (claims, proof points, objection handlers, competitor counters) and raises alerts when reality diverges: a competitor drops a differentiator you still lead with, or three lost deals cite a gap your messaging ignores. The AI is doing synthesis across unstructured internal and external text on a schedule; there is no CRUD version of this.
- **Wedge:** Founders and marketing leads at 10-50 person companies who have no product-marketing hire and whose positioning deck is 14 months stale. Axis: **no good solution today at this price**. Competitive-intel platforms start at enterprise pricing and see only the external half; Bloodhound is the only one that also reads your own lost deals.
- **Scope:** `competitor`, `watch_source`, `snapshot` + `diff`, `positioning_doc` (versioned), `claim_card`, `objection`, `divergence_alert`. Surfaces: competitor timeline, positioning workspace, battlecard generator, alert feed. Flagship MCP tool: `bloodhound_positioning_delta(scope)`, divergences with internal + external evidence.
- **Platform reuse:** Bond (win/loss, deal notes), Helpdesk (ticket themes), Banter (channel signal), Beacon (publish battlecards as knowledge), Brief (positioning doc surface), Qdrant, worker for scheduled crawls, Bolt for alert routing, visibility preflight on every internal citation.
- **Build argument:** It is the highest-leverage upstream app. It changes what the other marketing apps *say*, not just how fast they say it, and it is the only one whose data moat (your own loss reasons) no external vendor can replicate.

## Phase 2 - Debate

_Pending._

## Phase 3 - Submissions

_Pending._

## Phase 4 - Overlap resolution

_Pending._

## Phase 5 - Voting

_Pending._

## Phase 6 - Spec hardening

_Pending._

## Outcome

_Pending._
