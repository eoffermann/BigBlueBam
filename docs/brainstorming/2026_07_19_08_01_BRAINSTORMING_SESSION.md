# Suite Brainstorming Session - 2026_07_19_08_01

**Purpose:** Select the next app BigBlueBam should build, by competitive
multi-seat brainstorm (seven lenses, five proposals each, debate, merge
negotiation, and a no-self-vote final ballot), then produce an adversarially
hardened design spec for the winner.

**Orchestrator:** autonomous Startup-in-a-Box cycle, `suite-brainstorm` branch.
No human input at any phase.

## Context handed to the seats

Existing suite (22 apps): Bam (b3), Banter, Helpdesk, Beacon, Brief, Bolt,
Bearing, Board, Bond, Blast, Bench, Book, Blank, Bill, Blueprint, Bureau, Bin,
Bay, Blip, Basis, Braid, Bulwark.

Prior session outcomes (do not re-propose):

| Session | Winner | Runner-up |
| --- | --- | --- |
| 2026_07_17_12_58 | **Basis** - governed metric layer + AI causal decomposition | Bespoke - self-extending MCP tool & connector forge |
| 2026_07_18_13_09 | **Braid** - identity-resolution / golden-record CDP | Bridle - agent operations control tower |
| 2026_07_19_03_00 | **Bulwark** - AI contract-obligation monitor | Berth - external client membrane |

## Phase 1 - Initial proposals

Seven seats returned five proposals each: 35 candidate apps. Orchestrator note:
every seat grounded its work in the real monorepo, and several returned grep
evidence for the gap they were attacking (no organizational decision record; no
standup/check-in surface; no restore/revert route anywhere in the codebase; no
forecasting or experimentation surface; no brand-governance surface). Name
collisions across seats are frequent (Baton x3, Bellwether x2, Beat x2, Bloom x2,
Bylaw x2) and are disambiguated by seat letter throughout the rest of this
document.

### Seat A - AI-native automation & autonomous agent workflows

#### Baton (Seat A)
- **Name options:** Baton, Bellhop, Bandwidth
- **One-line pitch:** A per-person work arbiter that ranks everything the 22-app suite is asking of you, and progressively earns the right to handle whole classes of it without asking.

The suite now generates decisions faster than humans can absorb them: `agent_proposals` awaiting a verdict, Bolt executions that half-failed, Blip watch alerts, Bulwark notice deadlines, Bay review requests, Helpdesk SLA breaches, Bond rotting deals, Bill overdue reminders. Every one of those is a separate inbox in a separate app. Nothing in the suite answers the only question a 6-person team actually has: what do I do in the next 40 minutes, and what should I stop being asked about entirely.

The AI-native core is a **per-user delegation policy that is learned, not configured**. Baton ingests the unified decision record (`v_activity_unified`, `agent_proposals` decisions, Bolt execution outcomes, Bureau presence, Book calendar) and fits a per-user model of "what does this person actually do with this class of item": approve instantly, approve after edit, reject, snooze forever. For each class it maintains a **shadow prediction**: it predicts your decision before you make it and records whether it was right. When a class hits a user-set confidence bar (default: 12 consecutive correct shadow predictions, no reversals in 14 days), Baton offers a **delegation grant** for that class. Once granted, items in that class are handled automatically, logged, and reversible for a grace window, and any single reversal by the human instantly demotes the class back to shadow mode.

What you do with it: open one screen, see a time-boxed ranked queue ("next 40 min: 3 approvals, 1 escalation, this deal will rot Thursday"), and a second screen showing the **trust ledger** of what Baton is currently allowed to do on your behalf, what it is still auditioning for, and every autonomous action it took with an undo. It is not a notification aggregator, because aggregation is the losing half of the problem; the value is that the queue shrinks over time by design.

- **Wedge / customer fit:** Small teams are the ones who cannot afford approval fatigue: the same three people are the approver for invoices, deals, contracts, deploys and agent proposals. Today the choice is "approve everything blindly" or "the automation stays off." Enterprise tools solve this with headcount and workflow admins; SMBs have neither. The axis is **trust ramp**: no product ships a mechanism to earn autonomy incrementally with a measurable, auditable, instantly-revocable grant. Every autonomy setting in every competitor is a binary toggle a human sets in advance.
- **Scope:** Entities: `baton_items` (normalized work item with source ref + class fingerprint), `baton_classes`, `baton_shadow_predictions`, `baton_grants`, `baton_actions` (with undo payload). Screens: Next (time-boxed queue), Trust Ledger, Class detail with shadow accuracy curve, Undo log, Settings (confidence bar, blast-radius caps, never-delegate list). Flagship MCP tool: `baton_next(user_id, budget_minutes)` returning the ranked, `can_access`-filtered queue; plus `baton_grant_status(class_id)`.
- **Platform reuse:** `agent_proposals` + `proposal_decide` as the primary training signal; `agent_policies` for the kill switch and per-class allowlist enforcement already wired into `register-tool.ts`; `v_activity_unified` and `entity_links` for the decision record; `can_access` preflight on every surfaced citation; Bolt events in (all 122 catalogued) and `baton.grant.promoted` / `baton.action.reverted` out; BullMQ worker for scoring passes; `@bigbluebam/permissions` so a grant can never exceed the human's own rights.
- **Build argument:** Every agentic capability the suite already shipped (Waves 1-5, plus Bulwark's drafted notices and Braid's merge review) terminates in a human queue that nobody is triaging. Baton is the only proposal here that makes the existing investment pay off rather than adding a 23rd surface. It degrades gracefully: on day one it is a very good ranked queue, on day ninety it is doing a third of the work.

#### Behest (Seat A)
- **Name options:** Behest, Bounty, Beckon
- **One-line pitch:** State an outcome and a deadline, and the suite runs a closed autonomous loop against a certified Basis metric until the outcome is real or it tells you why it cannot be.

Bolt is a deterministic trigger-action engine: a human authors the plan and Bolt executes it. Bearing tracks goals but never touches them. There is nothing between "a human wrote every step" and "a goal sits in a dashboard rotting." Behest is the missing closed loop: the unit of work is an **outcome**, not a step.

You open a Behest: "Cut invoices overdue past 30 days below $8k by Aug 15." The AI-native core is a **planner bound to a measurable success signal**. Behest requires the outcome be expressed against a certified Basis metric (or a Bench query it then certifies), decomposes it into a typed plan over real MCP tools across Bill, Bond, Blast, Book and Banter, and executes with a control loop: act, re-read the metric, compare against the projected trajectory, and **re-plan when actual drifts from projected**. Every write-side action is classified by blast radius; anything above the Behest's authority cap lands in `agent_proposals` instead of executing, and the loop parks rather than guessing. Failure is a first-class output: Behest can close with "blocked, the metric did not respond to 3 planned levers, here is the evidence."

What you do with it: a mission screen showing the target curve versus actual, the live plan tree with which steps are done, pending human approval, or abandoned, and a full causal trace linking each executed step to the metric movement it was supposed to cause. Because success is defined by a governed metric rather than by task completion, the agent cannot declare victory by doing busywork, which is the failure mode of every "AI agent that does your work" demo.

- **Wedge / customer fit:** SMBs set quarterly goals and then have no execution capacity. Existing "AI agent" products either run one-shot task chains with no notion of whether the outcome happened, or they are enterprise RPA. The axis is **verifiable autonomy**: the loop is closed by an org-governed metric, so autonomy is bounded by measurement rather than by vibes. Nothing on the market ties an autonomous execution loop to a certified metric definition, because almost nothing has a metric layer to tie to. This suite just built one.
- **Scope:** Entities: `behest_missions` (outcome, metric ref, target, deadline, authority cap), `behest_plans` + `behest_steps` (typed tool invocations with preconditions), `behest_observations` (metric reads on a schedule), `behest_replans` (with the reason). Screens: Mission list, Mission detail (target vs actual curve + plan tree), Approval inbox, Trace. Flagship MCP tool: `behest_open(outcome, metric_ref, target, deadline, authority_cap)`; plus `behest_status(mission_id)`.
- **Platform reuse:** Basis for the certified metric and its access-scoped decomposition; Bench's internal query route for uncertified signals; the entire 847-tool MCP catalog as the action space, gated by `agent_policies` allowlists; `agent_proposals` for anything over the authority cap; `bolt_executions.evaluation_trace` conventions for step traces; internal-llm provider for planning; worker for the observation cadence.
- **Build argument:** Basis shipped and is currently a read-only truth layer with nothing acting on it. Behest is the app that turns the suite's metric governance into an actuator, and it is the single most defensible answer to "what does an AI-first business suite do that a pile of SaaS cannot": the apps are not 22 tools, they are one action space with a shared measurement plane.

#### Blaze (Seat A)
- **Name options:** Blaze, Burrow, Bight
- **One-line pitch:** Mines how your team actually works across all 22 apps, names the repeatable procedures nobody wrote down, and offers to run them.

Bolt's real adoption problem in a 2-50 person company is not the engine, it is authorship: nobody has the hour to sit down and specify a rule, and nobody knows which rules would pay. Meanwhile the org's actual procedures are already fully recorded across `activity_log`, `bond_activities`, `ticket_activity_log`, Bolt executions and `entity_links`, in the form of thousands of cross-app sequences that repeat with variation.

The AI-native core is **procedure induction over cross-app event sequences**. Blaze segments the unified activity stream into episodes anchored on entity links (deal won leads to invoice created leads to project created leads to kickoff booked leads to channel opened), clusters the episodes by shape, and induces a canonical **procedure** with its real distribution: median latency per step, who does it, how often each optional branch fires, where it stalls. Then it does the two things a rule engine cannot. First, **it proposes the automation**, emitting a concrete Bolt rule or a multi-step agent playbook into `agent_proposals` with the historical evidence and an estimated hours-saved-per-month. Second, **it detects deviation live**: this deal was won 6 days ago and the invoice step, which happens within 1 day in 91% of cases, has not happened, so something is being dropped.

What you do with it: a Procedures screen listing the induced processes with confidence and frequency, a procedure detail showing the mined flow with variance heat on each step, an Adopt button that converts a procedure into a running Bolt automation or a supervised playbook, and a Deviations feed of live episodes going off the beaten path. Steps that require judgment stay as HITL proposals; only the deterministic ones become rules.

- **Wedge / customer fit:** The customer is the team that bought a suite, uses eight of its apps, and has authored two automations. The axis is **zero-authorship automation**: process mining exists (Celonis, UiPath) and costs six figures and requires a data engineering project to build the event log. This suite already has the event log, in one Postgres, with a shared entity graph and an org boundary. That is a structural cost advantage nobody else has for SMBs.
- **Scope:** Entities: `blaze_episodes`, `blaze_procedures`, `blaze_procedure_steps` with latency/frequency stats, `blaze_deviations`, `blaze_adoptions`. Screens: Procedure catalog, Procedure detail (mined flow + variance), Deviations feed, Adoption review. Flagship MCP tool: `blaze_induce_procedures(scope, since)`; plus `blaze_deviation_check(entity_ref)`.
- **Platform reuse:** `v_activity_unified` and `entity_links` are the raw material and both already exist; Bolt's automation schema and `template-resolver` as the adoption target; `agent_proposals` for the adopt/decline decision; Qdrant for sequence embedding and clustering; worker for the nightly mining pass; `can_access` for per-viewer filtering of episode evidence.
- **Build argument:** Bolt is the suite's most under-adopted app relative to its power, and the reason is authorship cost, not capability. Blaze is the demand generator for infrastructure already paid for, and it gets more valuable with every app added to the suite.

#### Bogey (Seat A)
- **Name options:** Bogey, Backcast, Bane
- **One-line pitch:** An adversarial pre-mortem that challenges any plan, quote, or commitment with your own organization's track record, then scores itself on whether it was right.

Every commitment a small team makes is optimistic, and the correction signal arrives months later in a form nobody connects back to the original claim. The suite records both halves: the commitment (a Bam sprint plan, a Bond deal close date, a Bill quote, a Bearing key result, a Bulwark-tracked delivery obligation) and the eventual outcome. Nothing joins them.

The AI-native core is **retrospective evidence retrieval plus calibration tracking**. Point Bogey at any commitment entity and it does three things. It **retrieves comparable past commitments** from the org's own history (semantically via Qdrant over descriptions, structurally via typed fields such as scope size, client, phase composition) and reports their real outcomes: "the last 5 fixed-bid integrations you scoped at 3 weeks landed at a median of 6.5, and 4 of 5 had a scope change filed in week 2." It **issues a structured challenge** with named failure modes drawn from those cases and a probability on the stated commitment. Then, critically, it **records that prediction as a durable forecast** and grades itself when reality lands, publishing a public calibration score per prediction class. Bogey that is badly calibrated says so on its own dashboard.

- **Wedge / customer fit:** SMBs have no PMO, no estimation history, and no analyst. They repeat the same estimation error for years because the feedback loop is longer than institutional memory. Generic LLM assistants will happily challenge a plan, but with generic priors, which is worthless and everyone knows it. The axis is **grounded, self-scoring priors**: the challenge is drawn only from this org's data, and the app publishes its own hit rate rather than asking for trust.
- **Scope:** Entities: `bogey_challenges`, `bogey_comparables`, `bogey_forecasts` and `bogey_resolutions`, `bogey_calibration` per prediction class. Screens: Challenge composer, Challenge brief, Calibration dashboard, Comparables explorer. Flagship MCP tool: `bogey_challenge(entity_ref, commitment)`.
- **Platform reuse:** Qdrant; `v_activity_unified` plus per-app terminal-state fields for auto-resolution; `can_access` preflight; internal-llm provider for brief synthesis; Bolt events on commitment creation as the trigger to auto-challenge; worker for resolution sweeps.
- **Build argument:** It is the cheapest of these to build (read-mostly, no new write surface, no autonomy risk) and the most immediately demonstrable in a sales call. It creates a durable data asset, the org's calibration record, that gets more valuable and less copyable every quarter.

#### Bracket (Seat A)
- **Name options:** Bracket, Brier, Bakeoff
- **One-line pitch:** A regression harness for your automations and agents: replay real historical events against a candidate before it touches production, score it, and gate promotion on the result.

The suite has 26 Bolt tools, 847 MCP tools, agent policies, and drafted-notice generators in Bulwark, and no way whatsoever to answer "if I change this rule or this prompt, what breaks." Today the test is production. For an autonomous system with write authority over invoices and customer email, that is the single largest operational risk in the platform.

The AI-native core is **counterfactual replay with LLM-judged scoring**. Bracket captures corpora from real history: sets of past Bolt events, MCP tool call traces, and their observed outcomes, frozen and org-scoped. You point a candidate at a corpus, where a candidate is a Bolt automation version (the `bolt_automation_versions` table already exists), an agent policy change, a Bulwark extraction prompt, or a registered external agent runner. Bracket replays the corpus in a sandbox with all side effects intercepted and recorded rather than executed, then scores the run three ways: deterministic assertions, diff against the historically observed outcome, and a rubric-scored LLM judge for cases with no single right answer. The output is a scorecard with regressions named at the case level.

The second half is the **gate**: a candidate can be required to clear a threshold before promotion, and once live, Bracket keeps a shadow lane running the previous version alongside the new one on live events to catch drift the corpus did not cover. Because side effects are intercepted, a bad candidate cannot email a customer during evaluation.

- **Wedge / customer fit:** The buyer is the same admin who is currently afraid to turn autonomy on. Eval tooling exists (LangSmith, Braintrust) but targets ML engineers, requires you to build the dataset yourself, and knows nothing about your business objects. The axis is **corpus for free**: the regression corpus builds itself from history.
- **Scope:** Entities: `bracket_corpora` and `bracket_cases`, `bracket_candidates`, `bracket_runs` and `bracket_case_results`, `bracket_gates`, `bracket_shadow_lanes`. Screens: Corpus builder, Run comparison, Gate config, Shadow drift. Flagship MCP tool: `bracket_replay(candidate_ref, corpus_id)`.
- **Platform reuse:** `bolt_executions` including `evaluation_trace` and `event_id`; `bolt_automation_versions`; the MCP server's internal `POST /tools/call` route as the interception point; `agent_policies` as both candidate type and gate lever; internal-llm provider for the judge; worker queues; `agent_runners`.
- **Build argument:** Every other idea in this session increases the amount of autonomous write authority in the suite. Bracket is the only one that makes that authority safe to grant, and it is the prerequisite that turns "we shipped agent features" into "customers turned them on."

### Seat B - Data, intelligence & analytics

Seat B's grounding checks: no forecasting/simulation anywhere in `apps/`, no experimentation or causal-inference surface, no row-level data-quality layer (Blip covers app logs, not business-row health), no decision-outcome scoring, and no unstructured-prose mining beyond `phrase-count-tools.ts` (which requires you to already know the phrase). Basis is strictly retrospective; Bench is descriptive.

#### Bandit (Seat B)
- **Name options:** Bandit, Bout, Beta
- **One-line pitch:** Every deliberate change your team makes gets registered as an experiment, and Bandit picks the right causal design, watches the outcome metric, and tells you whether it actually worked.

Small teams change things constantly: a new Bolt automation, a different Blast subject line, a tightened Helpdesk SLA, a new Bond pipeline stage, a price bump in Bill. Then they argue about whether it helped. Nobody runs an experiment because running one correctly requires a data scientist. Bandit's AI core is a **design selector**: given an intervention and a target metric (a certified `basis_metrics` slug), it decides which causal design is actually admissible against the data at hand: randomized split when the surface supports assignment, difference-in-differences when there is a clean untreated comparison group, synthetic control when there is not, and interrupted time series as the fallback. It refuses when nothing is admissible, and says why. That refusal is the product's integrity.

The second AI mechanism is **assumption auditing**. Parallel trends, pre-period fit, sample-ratio mismatch, contamination between arms, novelty decay, and multiple-comparison inflation get checked automatically on a schedule, and a violated assumption downgrades the readout from "caused" to "associated" with a plain-language reason. The LLM's job is narration and design selection; the estimate itself is deterministic statistics, so results are reproducible and auditable exactly like Basis's Class-A drivers.

Over time the org accumulates an **intervention ledger**: a durable, searchable record of every change and its measured effect, which is exactly the asset an SMB never builds.

- **Wedge / customer fit:** 2-50 person teams ship changes weekly and measure none of them. Optimizely/Statsig/Eppo start at enterprise pricing, only cover product experiments on a web surface, and require you to instrument arms yourself. Bandit's axis is **coverage plus zero setup**: it works on operational changes (SLA policies, pricing, staffing, automation rules) that no experimentation vendor touches.
- **Scope:** Entities: `bandit_interventions`, `bandit_arms`, `bandit_readouts`, `bandit_guardrails`. Screens: intervention inbox, experiment detail with effect-over-time and assumption panel, ledger/history, guardrail settings. Flagship MCP tool: `bandit_measure(intervention, metric_slug)`; plus `bandit_effect_of(entity)`.
- **Platform reuse:** Reads outcome series through Basis's certified metrics; intervention detection subscribes to Bolt events; scheduled re-estimation on the BullMQ worker; verdicts and revert recommendations land in `agent_proposals` HITL; narration through `internal-llm.routes.ts`; per-viewer access scoping via `can_access`; charts rendered by embedding Bench widgets.
- **Build argument:** The suite can now define a number (Basis), display it (Bench), and explain a past move (Basis explanations). It cannot answer the single most valuable question a business asks: **did the thing we did work?** That is a causal question, structurally different from everything shipped. It also turns Bolt from a fire-and-forget automation engine into a closed loop.

#### Bellwether (Seat B)
- **Name options:** Bellwether, Bode, Brink
- **One-line pitch:** A calibrated digital twin of your operation that answers "what happens if we do X?" by simulating your own historical flow dynamics, not by drawing a trendline.

Every entity in the suite moves through a lifecycle with measurable transition rates. Bellwether's AI core fits a **stochastic process model** per flow directly from the shared database and the activity log: transition probabilities, dwell-time distributions, per-owner throughput, seasonality, and capacity constraints. It then runs Monte Carlo simulation forward under a scenario you specify. The output is a distribution, not a point: "P(sprint 14 ships on time) = 0.38; the binding constraint is Mary Ann at 1.4x capacity in week 2."

The second mechanism is **scenario compilation**. A user asks in plain language ("what if we take the Howell contract and Ginger goes on leave in March?") and the model translates it into concrete parameter perturbations on the fitted process. This is the part no spreadsheet does, because the translation requires knowing the org's own entity graph.

Third: **backtesting as a trust surface.** Bellwether continuously re-runs itself against held-out history and publishes its own calibration. A forecast product that will not report its own hit rate is a horoscope. This one has a scoreboard on the front page.

- **Wedge / customer fit:** SMB owners and delivery leads doing capacity and cash planning in a spreadsheet with three hardcoded scenarios. Anaplan, Pigment, o9 are six-figure and require a modeler. Bellwether's axis is **model acquisition cost**: it fits the model from data the customer already has in this exact schema.
- **Scope:** Entities: `bellwether_models`, `bellwether_scenarios`, `bellwether_runs`, `bellwether_constraints`. Screens: scenario builder, fan-chart run viewer with constraint attribution, model calibration scoreboard, plan-vs-actual tracker. Flagship MCP tool: `bellwether_simulate(scenario)`; `bellwether_risk(entity)`.
- **Platform reuse:** Fits from the shared Postgres plus the partitioned `activity_log` and `v_activity_unified`; capacity from Bam sprints/time entries and Book availability; cash from Bill; pipeline from Bond with Braid golden IDs; simulation on BullMQ worker queues; results published as Bolt events; Bench widgets for rendering.
- **Build argument:** The entire data stack is rear-facing. Nothing looks forward, and forward is where decisions live. Only buildable because the suite owns the whole operational graph in one schema.

#### Ballast (Seat B)
- **Name options:** Ballast, Bulkhead, Bedrock
- **One-line pitch:** A data-trust layer that learns what your business data normally looks like and catches silent breakage, semantic drift, and junk input before it poisons a report or an agent.

Blip watches applications; nothing watches the data. The failure mode that actually hurts SMBs is silent: a Blank form gets a new option and half the submissions stop matching a routing rule; an integration stops writing `bond_deals.amount` and everything still "works" but the pipeline number quietly drops. Nobody notices for three weeks, at which point a Basis metric is wrong, a Bench dashboard is wrong, and every agent that read either is wrong.

Ballast's AI core is **learned per-column semantic expectation**. For each column and JSONB custom-field path it maintains a profile: value distribution, cardinality trajectory, null rate, freshness cadence, format grammar, referential integrity rate, and inferred semantic type. Anomaly detection is statistical, but the semantics are the AI part: the model reads column names, adjacent schema, and sample values to infer what the field means, so it can flag "this column named `close_date` now contains values 400 days in the future." It also detects **categorical drift** where a category's meaning changes rather than its frequency.

The output is a per-metric and per-dashboard **trust score with a blast radius**: this incident touches these 3 Basis metrics, these 6 Bench widgets, these 2 Bolt rules, and these agent tools.

- **Wedge / customer fit:** Any team that has started trusting a dashboard or letting agents act on data. Monte Carlo, Bigeye, Metaplane are warehouse-first and priced for data teams SMBs do not have. Ballast's axis is **zero-configuration plus blast radius**: it self-installs monitors by reading the Drizzle schema and migration history.
- **Scope:** Entities: `ballast_profiles`, `ballast_incidents`, `ballast_contracts`, `ballast_trust_scores`. Screens: trust map, incident detail with lineage, column profile explorer, contract editor. Flagship MCP tool: `ballast_trust(entity)`, callable by any agent before it acts on a number.
- **Platform reuse:** Reads the schema roots that `scripts/db-check.mjs` already auto-discovers; profiling jobs on the worker; incidents as Bolt events; degraded badges on `basis_metrics.resolve_status` and Bench widgets; `agent_proposals` triage.
- **Build argument:** The suite just shipped a governed metric layer, a golden-record CDP, and 847 agent tools reading from them, with no trust substrate underneath. The more the agents act autonomously the more expensive that gap gets.

#### Bramble (Seat B)
- **Name options:** Bramble, Bloom, Bristle
- **One-line pitch:** Mines the suite's prose into a living, self-maintaining taxonomy of what people are actually talking about, and tracks each theme's birth, growth, and death as a real metric.

The suite's most valuable data is unstructured and nobody analyzes it. Today the only tool is `helpdesk_ticket_count_by_phrase` and `bam_task_count_by_phrase`, which require you to already know the phrase. That means you can only find the problems you have already named.

Bramble's AI core is **emergent taxonomy induction with stability**. It embeds every prose artifact into Qdrant, clusters continuously, and then has an LLM label and maintain the cluster tree, handling the hard part: cluster identity over time. Themes split, merge, drift, and die, and a naive re-cluster every night produces a different taxonomy every night, which is useless for trending. Bramble treats each theme as a durable entity with a version lineage and records split/merge events explicitly, so "mentions of shipping delays" is a time series you can put on a dashboard for a year.

The novel unit of analysis is theme-by-entity: which customers, which projects, which owners are driving a rising theme, joined through Braid golden IDs.

- **Wedge / customer fit:** Support leads, founders, and account managers who know their prose contains the answer and cannot read 4,000 tickets. Viable, Enterpret, Unwrap are single-source (support only), cost more than the whole rest of an SMB stack, and require exporting your data. Bramble's axis is **cross-app corpus plus zero egress**.
- **Scope:** Entities: `bramble_themes`, `bramble_theme_events`, `bramble_mentions`, `bramble_watches`. Screens: theme board with rise/fall ranking, theme detail with drill-through, emerging-themes inbox, promotion actions. Flagship MCP tool: `bramble_themes_for(entity | window)` and `bramble_trend(theme, window)`.
- **Platform reuse:** Qdrant; the shared DB for every prose source; `can_access` on every mention drill-through; Braid `braid_resolve`; embedding + clustering on the worker; rate-change alerts as Bolt events.
- **Build argument:** 22 apps generating prose and exactly zero analysis of it. Every analytics app shipped so far operates on numbers someone already decided to count; Bramble is the only one that surfaces a problem nobody has named yet.

#### Bygone (Seat B)
- **Name options:** Bygone, Backstory, Bequest
- **One-line pitch:** Captures the decisions your team actually makes, remembers what you expected to happen, then grades those expectations against reality and builds a calibration record per person and per team.

Bygone's first AI mechanism is **decision extraction**: it watches Brief documents, Banter channels, Bureau room transcripts, and Bam epics for the linguistic shape of a commitment, and drafts a structured decision record: the choice, the alternatives considered, the stated rationale, the owner, the reversal cost, and critically the **implied prediction** with a review date. Every extraction lands in `agent_proposals` for one-click confirm or discard.

The second mechanism, which is the actual product, is **automatic grading**. On the review date, Bygone resolves the prediction against reality by querying the relevant certified Basis metric or entity state, and scores it. Over months this produces a calibration profile: this team is systematically 40% optimistic on delivery dates, well-calibrated on revenue, overconfident on hiring impact.

The third surface is **retrieval at the moment of relevance**: when someone opens a Bam epic or Bond deal touching a prior decision, Bygone surfaces the decision, its expectation, and its grade. Not a search box, a Bolt-triggered interrupt.

- **Wedge / customer fit:** Any team past about 8 people that has started forgetting itself. Existing options are an ADR folder (engineering-only, manually written, never graded) or a Notion database nobody updates. Bygone's axis is **capture cost near zero and grading, which nothing does**.
- **Scope:** Entities: `bygone_decisions`, `bygone_predictions`, `bygone_gradings`, `bygone_calibration`. Screens: decision timeline, decision detail with provenance, review queue, calibration scoreboard. Flagship MCP tool: `bygone_prior_decisions(entity | topic)`.
- **Platform reuse:** `agent_proposals` HITL; Brief, Banter, Bureau, Board as sources; Basis certified metrics as the grading oracle; `entity_links`; Qdrant; Bolt events to trigger surfacing; worker sweeps; `can_access`.
- **Build argument:** The only proposal that creates a genuinely new data asset rather than analyzing an existing one, and the one an incumbent cannot copy, because it requires simultaneous access to where decisions are discussed and where outcomes are measured. A two-year graded decision history is not portable to a competitor.

**Seat B ranking:** Bandit first, Bellwether second, Ballast third, Bramble fourth, Bygone fifth on wedge certainty but first on defensibility.

### Seat C - Communication, collaboration & community

Seat C's grounding evidence: searching `decision` across all `apps/*/src/db/schema/` returns only `bay_review_decisions`, `braid_merge_decisions`, and `dedupe_decisions` (all machine-adjudication records, none organizational). Searching `standup|check_in|checkin` across `apps/*/src/` returns zero product features. Both gaps are real.

#### Bylaw (Seat C)
- **Name options:** Bylaw, Behest, Bedrock
- **One-line pitch:** Every decision your team makes in chat, calls, docs, and whiteboards becomes a first-class, citable record, and the app tells you when you are about to re-litigate one.

No table anywhere in this monorepo represents a decision. Meanwhile the raw material is everywhere: `banter_messages`, `banter_call_transcripts` (speaker-attributed, timestamped, already persisted), Brief docs, `beacon_entries`, Bam task comments, Board rooms. The org's real reasoning lives in scrollback and evaporates.

Bylaw's AI core is a two-sided engine. **Extraction:** a worker consumes Banter messages/threads/transcripts and Brief revisions and emits candidate decisions, a normalized `{statement, rationale, alternatives_rejected, deciders, scope, reversibility, decided_at, source_citations[]}` record with every claim anchored to a message id or transcript span. Candidates land in `agent_proposals`; a named decider confirms, edits, or rejects. **Contradiction detection:** every new message in a watched channel is embedded and matched against the confirmed ledger in Qdrant. When a live thread semantically collides with a settled decision, Bylaw posts a single quiet in-thread card: "This was decided 2026-03-14 by Skipper and the Professor, 'we ship Postgres-only, no Mongo', rationale, and the three alternatives already rejected. Supersede it or continue?" Choosing supersede opens a new decision linked `supersedes` to the old one, so the ledger is a versioned graph.

The user experience is deliberately passive. Nobody files a decision. Then `bylaw_why(topic)` answers "why do we do it this way?" with a dated chain of superseding decisions and the actual quotes, and every decision carries a **decay signal**: decisions whose deciders have all left, or whose rationale referenced conditions that Bolt events show have changed, surface on a "stale rulings" board for re-ratification.

- **Wedge / customer fit:** 2-50-person teams lose decisions constantly. Existing options are a Notion page nobody updates or ADR markdown only engineers write. The axis is **cost of re-litigation**: Bylaw is the only thing that catches the repeat while it is happening, in the channel, because it is watching the conversation rather than waiting to be searched.
- **Scope:** Entities: `bylaw_decisions` (with `supersedes_id`, `status`, `reversibility`, `scope_ref`), `bylaw_citations`, `bylaw_deciders`, `bylaw_watches`. Screens: Decision ledger, decision detail with citation playback and supersession chain, proposal review queue, stale-rulings board. Flagship MCP tool: `bylaw_why(topic | entity_ref)`; secondary `bylaw_check_conflict(draft_text)`.
- **Platform reuse:** Banter (messages, threads, `banter_call_transcripts`, in-thread cards), Brief, Qdrant, `agent_proposals`, `can_access` on every citation, Bolt (`decision.recorded`, `decision.superseded`, `decision.stale`), internal llm-provider, worker queues, `entity_links`.
- **Build argument:** The highest-leverage missing primitive in the suite. Twenty-two apps generate artifacts; none captures intent. Bulwark tracks obligations imposed on us by signed contracts; Bylaw tracks commitments we made to ourselves, and its contradiction-in-flight mechanic has no analogue anywhere in the suite or the market.

#### Baton (Seat C)
- **Name options:** Baton, Byline, Bequest
- **One-line pitch:** Record a five-minute walkthrough once; Baton turns it into a chaptered, searchable artifact that answers follow-up questions in your voice while you are asleep.

The suite has Bin (bytes), Bay (frame-accurate review of media), and Beacon (written KB). It has no way for a person to transfer procedural knowledge, the "here's how the deploy actually works, ignore the doc" tour. Today that happens in a live call, which means it happens once, for one person, and is lost.

Baton's core mechanism is **artifact synthesis plus surrogate answering**. You capture screen + voice (or drop an existing Bureau/Banter recording). A worker transcribes, then the AI produces a structured artifact: auto-chapters, a step-list with the exact UI strings and commands you spoke, entity extraction that hard-links every mentioned Bam project, Bond account, Beacon article, or Blip watch into `entity_links`, and a gap report telling you what you left ambiguous ("you said 'the usual key', which credential?") so you can patch it with a fifteen-second addendum.

Then the surrogate: every artifact is embedded per-chapter in Qdrant. A colleague asks in Banter "how do I roll back a Railway deploy?" and Baton answers with the grounded three sentences plus the 40-second clip cued to the moment you said it, and cites you. When confidence is low it opens a question addressed to the recorder, whose answer is appended, so the thing gets smarter every time it fails. Artifacts carry a freshness contract flagged against Blip/Bolt change signals.

- **Wedge / customer fit:** Small teams with one person who knows each critical thing. Loom gives you a video and a transcript and nothing else. The axis is **integration + answerability**: the only walkthrough tool that lives inside the same permission model as the systems it describes, so a clip referencing a private Bond deal is invisible without deal access.
- **Scope:** Entities: `baton_captures`, `baton_chapters`, `baton_steps`, `baton_questions`, `baton_freshness_signals`. Screens: capture/upload, artifact viewer, recorder's gap inbox, org library with staleness. Flagship MCP tool: `baton_ask(question, asker_user_id)`.
- **Platform reuse:** Bin/`@bigbluebam/storage` and the existing `bin-transcode` worker, Bay for annotation, Banter as answer surface, Beacon for promotion, Qdrant, `entity_links`, `can_access`, Blip/Bolt for staleness.
- **Build argument:** Converts the suite's biggest liability, tribal knowledge in one person's head, into a permission-aware self-improving asset, and it is the only proposal that produces net-new content rather than reorganizing content that already exists.

#### Beat (Seat C)
- **Name options:** Beat, Bugle, Brisk
- **One-line pitch:** An async cadence agent that assembles the standup, the weekly, and the retro from what your systems already know, then asks each person only the one thing it genuinely could not figure out.

Standup tools (Geekbot, Range) ask all five humans the same three questions every morning and get low-information prose, because they are blind. BigBlueBam is the opposite: Bolt has a 122-event catalog, `v_activity_unified` UNIONs Bam/Bond/Helpdesk activity, Bearing holds the KRs, Bill the invoices, Blip the incidents. Ninety percent of a status update is already recorded.

Beat's AI core is **differential interviewing**. For each run it drafts the full report from event data first, then computes what the data cannot explain: a task sat in review six days with no activity; a KR is at 40% with two weeks left. Only those become questions, each to exactly one person as a single Banter DM with a concrete premise: "Deploy pipeline task hasn't moved since Tuesday and the sprint closes Friday, blocked, deprioritized, or done-but-not-moved?" Silence is itself signal and is reported as such.

The output is a **decision-shaped digest**: what changed (auto), what is at risk with named owner and evidence chain, what needs a human call. Retro mode proposes pattern findings into the HITL queue rather than asserting them.

- **Wedge / customer fit:** Teams for whom recurring status meetings are the largest recoverable cost. The axis is **signal per minute of human attention**: every competitor asks everyone everything; Beat asks one person one thing because it read the event bus.
- **Scope:** Entities: `beat_cadences`, `beat_runs`, `beat_findings`, `beat_questions`/`beat_answers`, `beat_digests`. Screens: cadence config, run digest, risk board, question inbox. Flagship MCP tool: `beat_run_cadence(cadence_id)`.
- **Platform reuse:** Bolt event stream, `v_activity_unified`, Bearing KRs, Bam sprints/carry-forward, Blip watches, Banter DMs with the existing per-channel quiet-hours service and `banter_schedule_post`, `agent_proposals`, worker repeatable jobs, `can_access`.
- **Build argument:** The app that only this suite could build. Its quality ceiling is set by how much ground truth the platform emits, and BigBlueBam emits more than any competitor's customer ever will.

#### Bazaar (Seat C)
- **Name options:** Bazaar, Burrow, Beehive
- **One-line pitch:** A public or member-gated question space where an AI steward answers first from your internal knowledge, safely, routes what it cannot answer to the actual expert, and turns every resolved thread into a knowledge article.

The differentiator is that the answering agent is wired into a permissioned internal corpus and is structurally prevented from leaking it. Every candidate answer runs `can_access` against a synthetic "public" asker, so a citation to a private Bond deal or confidential Beacon article is dropped, not paraphrased. Bazaar is the first app whose entire product is that boundary.

The loop: a member posts a question. The steward searches Beacon, Brief, Helpdesk resolutions, and prior threads, drafts an answer with public-safe citations, posts it labeled machine-generated with a confidence band. If confidence is low it calls `expertise_for_topic` (already shipped) to identify the internal human most likely to know and pings exactly that person with the draft and the gap. Their edit is what gets published. Once resolved, the steward drafts a Beacon article into `agent_proposals`, so community is a knowledge intake pipeline rather than a support cost sink. Recurring unanswered questions surface as a corpus-gap report.

- **Wedge / customer fit:** SMB software teams and agencies fielding the same twelve questions in email, Slack Connect, and Helpdesk. Not a client portal (materially unlike Berth): no per-client record view, no billing, no project status. The axis is **deflection with safety**: alternatives are an unfenced LLM widget that will quote your internal wiki, or a forum with no AI at all.
- **Scope:** Entities: `bazaar_spaces`, `bazaar_threads`, `bazaar_posts`, `bazaar_answers`, `bazaar_members`, `bazaar_gaps`. Screens: space list, thread view, steward review queue, corpus-gap dashboard, moderation queue. Flagship MCP tool: `bazaar_answer_draft(thread_id)`.
- **Platform reuse:** `can_access`, `expertise_for_topic`, Beacon + `beacon_upsert_by_slug`, Helpdesk corpus, `search_everything`, Qdrant, `agent_proposals`, Banter for expert pings, Bolt, Blast for digests.
- **Build argument:** Monetizes the platform's most defensible engineering, the visibility layer, as a customer-facing product, and is the only proposal that grows the corpus from outside the org.

#### Bloom (Seat C)
- **Name options:** Bloom, Boot, Badge
- **One-line pitch:** A new hire's first thirty days, generated from what your team actually did rather than a course somebody wrote in 2024.

Bloom never writes a curriculum; it derives one. The mechanism is a **role trace diff**. Bloom profiles what people in a given role actually touched over the trailing year via `v_activity_unified`, `activity_by_actor`, Bolt events, Bam task histories, Beacon reads, Bond ownership, and builds an empirical map of the surfaces that role depends on. It diffs that against the new person's own (empty) trace and sequences the gap into small real tasks: not "read the deployment doc" but "shadow the next Blip watch that fires on the ingest queue," "you now own the Howell account's next check-in, here is the full Braid-resolved history."

Each step closes when Bolt sees the person actually do it, not on a checkbox. Where the trace shows a dependency with no supporting artifact, Bloom emits a **knowledge debt** item pointing at the person who holds it. Bloom also runs in reverse as a **departure brief**: diff a leaver's trace against everyone else's and you get the exact list of things only they touch, ranked by how often the org needed it.

- **Wedge / customer fit:** Teams where onboarding is a Notion checklist and a week of interruptions. The axis is **zero authoring cost**: every LMS requires someone to write and maintain material, which a fifteen-person company will never do. Bloom's content is the org's own event history, so it cannot go stale.
- **Scope:** Entities: `bloom_role_profiles`, `bloom_paths`, `bloom_steps`, `bloom_knowledge_debt`, `bloom_departure_briefs`. Screens: new-hire path, manager dashboard, role-profile explorer, knowledge-debt board. Flagship MCP tool: `bloom_generate_path(user_id, role)`.
- **Platform reuse:** `v_activity_unified` + `activity_by_actor`, Bolt for step completion, `expertise_for_topic`, Beacon and Brief, Bam for practice tasks, `entity_links`, `can_access`, Bearing for ramp goals, worker recompute.
- **Build argument:** The first app that uses the suite's behavioral record to change what a person knows rather than what a dashboard shows. Its departure-brief mode alone is a product SMBs would buy standalone.

### Seat D - Vertical wedge: small public agencies

**Vertical choice and justification.** Roughly 90,000 units of US local government, the overwhelming majority staffed 2 to 50, exactly BigBlueBam's target band. They are legally obligated to do things no commercial SMB is (statutory disclosure clocks, open-meeting law, uniform-guidance cost principles, protest-proof procurement), and the vendors serving those obligations (Granicus, GovQA/NextRequest, Accela, Tyler, OpenGov, Euna) price and implement for agencies 10x larger. A clerk in a 12-person city runs FOIA out of Outlook and a spreadsheet. Self-hosting matters more here than anywhere: `docker compose up` against your own Postgres and MinIO is a procurement argument, not a technical one. Deliberately different from Bulwark: Bulwark watches obligations inside an executed contract for a private buyer; these are driven by statute and public accountability, and two (Bid, Bursar) sit on the opposite side of the contract lifecycle by construction.

#### Blot (Seat D)
- **Name options:** Blot, Blackline, Bastion
- **One-line pitch:** An AI records-disclosure engine that turns a public-records request into a scoped search across every app in the suite, proposes page-level redactions with statutory citations, and defends the whole thing on a statutory clock.

A request arrives ("all communications regarding the Elm Street rezoning, Jan through June"). Blot's first AI act is **responsiveness planning**: it decomposes the request into custodians, date ranges, and semantic queries, then executes that plan across Banter, Brief, Beacon, Bam, Bond, Bin, and attached mail using Qdrant retrieval rather than keyword matching, because requesters describe subjects and records use jargon. Output is a candidate set with a per-item reasoning trace.

The second act is **exemption analysis**. Each candidate page is classified against the agency's configured statute set (state PRA, FOIA, attorney-client, personnel, security, PII, deliberative process) and Blot emits a proposed redaction box plus the cited exemption subsection and a one-line justification. Nothing is ever released autonomously; every redaction and withhold lands in `agent_proposals` for the clerk or attorney, and each decision becomes training signal for that agency's exemption log.

The third mechanism is the clock and the record of the record. Statutory deadlines are timezone-anchored and jurisdiction-configured, fired via Bolt. On production, Blot emits the exemption log / Vaughn-style index automatically from accepted proposals, so the defensibility artifact is a byproduct rather than a weekend of retyping.

Note the **permission inversion**, which is the interesting platform work: Blot must search past normal per-user ACLs under a scoped legal-authority role, then apply `can_access` semantics in reverse (nothing leaves the building unless a human affirmatively released it). No existing app exercises that.

- **Wedge / customer fit:** Small-agency clerks and public-agency counsel. Today: Outlook plus a shared drive, or NextRequest/GovQA at county scale and price. The axis is **time-to-production and defensibility**: a multi-day manual sweep becomes a reviewed hour with the exemption index free. Secondary buyer: municipal law firms handling PRA for several agencies.
- **Scope:** Entities: `blot_requests`, `blot_requesters`, `blot_search_plans`, `blot_candidates`, `blot_redactions`, `blot_exemptions`, `blot_productions`, `blot_holds`. Screens: request queue with clock radar, review workspace with proposed redaction boxes and citations, production builder, exemption log. Flagship MCP tool: `blot_plan_request(request_text)`, plus `blot_propose_redactions(candidate_id)`.
- **Platform reuse:** Qdrant + `search_everything`, `can_access`, `agent_proposals`, Bin/MinIO for source bytes and produced packages, `@bigbluebam/permissions` for the legal-authority role, Bolt for deadlines, Bay's token-gated public link pattern for delivering productions.
- **Build argument:** The one obligation in this vertical with criminal and civil teeth, unbuyable at SMB price, impossible to do well without retrieval plus reasoning. The more the agency stores in BigBlueBam the better Blot's sweep gets: the strongest platform-flywheel argument on the slate.

#### Bylaw (Seat D)
- **Name options:** Bylaw, Ballot, Gavel
- **One-line pitch:** An open-meeting-law engine that assembles the agenda packet, runs the meeting record, generates minutes and roll-call votes from audio, and converts every adopted motion into a tracked directive with an owner and a due date.

Public bodies are procedurally fragile: agendas must be posted N hours ahead with sufficient descriptive detail, items not on the agenda cannot be acted on, quorum and roll-call must be recorded, and the minutes are the legal record. First, **agenda sufficiency review**: Bylaw reads each proposed item and its backing packet and flags items whose title is too vague to satisfy notice requirements, with the statutory standard cited, before posting. Second, **live record construction**: it consumes meeting audio (Banter's transcription worker and Bureau/LiveKit rooms) and aligns the transcript to the agenda, detecting motions, seconds, amendments, and votes, so draft minutes and a roll-call tally exist minutes after adjournment instead of two weeks later.

Third, and this is the part nobody sells: **directive extraction**. "Staff shall return with a revised fee schedule in 60 days" is an obligation the council will absolutely ask about, and it currently dies in a PDF. Bylaw extracts each adopted motion into a typed directive with owner, due date, and citation back to the exact minute, pushes it into Bam and Bearing, and reports directive status back onto the next agenda automatically.

- **Wedge / customer fit:** City clerks, school-district boards, special-district boards, HOA/authority secretaries. Granicus/Legistar is priced and scoped for large bodies; small boards use Word, a Zoom recording, and hope. The axis is **cycle time plus procedural risk**.
- **Scope:** Entities: `bylaw_bodies`, `bylaw_meetings`, `bylaw_agenda_items`, `bylaw_packet_items`, `bylaw_motions`, `bylaw_votes`, `bylaw_directives`, `bylaw_notice_rules`. Screens: meeting builder, notice-compliance preflight, live meeting console, minutes review diff, directive tracker. Flagship MCP tool: `bylaw_extract_record(meeting_id)`.
- **Platform reuse:** Bureau/LiveKit and the banter-transcription worker, Brief for packets, Bin for recordings, Bam and Bearing for directives, Bolt for posting deadlines, Blast for notice distribution, Bay-style public links for published packets.
- **Build argument:** The only proposal that produces a legally operative artifact and then feeds accountability back into apps the suite already has. Gives Bureau and Banter transcription a serious business use case.

#### Bid (Seat D)
- **Name options:** Bid, Bazaar, Behest
- **One-line pitch:** A protest-proof solicitation engine: it shreds an RFP into a machine-checkable compliance matrix, evaluates responses against published criteria with evidence citations, and records a scoring trail that survives a bid protest.

Public procurement fails in two specific ways at small-agency scale. On the buy side, an agency receives eight 90-page proposals and scores them in a conference room with no durable record of why, which is what a losing bidder's protest attacks. On the sell side, small firms lose on responsiveness technicalities they never saw. Bid attacks both with one engine.

The core mechanism is the **requirement shred**: an LLM pass over the solicitation produces a typed matrix of every mandatory submittal, certification, format constraint, and evaluation criterion with its point weight and a pointer to the source clause. That matrix runs against each response to produce a responsiveness verdict per requirement with the citation to the exact page that satisfies it, or a flagged gap. Evaluators do not receive a score; they receive evidence, per criterion, side by side, and score with the AI's citations in view. Every score change is captured with rationale.

Bid emits an evaluation record mapping each awarded point to a cited passage and a named evaluator, which is the packet a protest response is built from. Vendor-side, the same shred runs against your own draft and tells you which mandatory items are missing before you submit.

This sits deliberately **pre-award, upstream of Bulwark**, which begins at execution. Award in Bid hands the executed contract to Bulwark's obligation ledger; that is the intended handoff, not an overlap.

- **Wedge / customer fit:** Agency purchasing officers and the small professional-services firms that live on public work. Bonfire, Euna, Periscope are e-procurement portals: they collect documents, they do not read them. The axis is **evaluation labor and protest exposure**, plus a genuine second market in the vendors who respond.
- **Scope:** Entities: `bid_solicitations`, `bid_requirements`, `bid_responses`, `bid_response_evidence`, `bid_criteria`, `bid_scores`, `bid_evaluators`, `bid_addenda`, `bid_awards`. Screens: solicitation builder, requirement matrix, evaluator workspace, responsiveness board, award and protest packet. Flagship MCP tool: `bid_shred(solicitation_id)` and `bid_evaluate_response(response_id)`.
- **Platform reuse:** Bin, Blank for intake, Bay's public token-gated links for vendor submission without accounts, Bond for vendor records, Braid for vendor identity resolution across DBAs, `agent_proposals`, Bolt for addenda and deadlines, Bulwark as downstream award handoff.
- **Build argument:** Two-sided market from one codebase, a hard money axis on both sides, and the cleanest complement to a product the suite already shipped. Least dependent on the customer being a government: private RFPs shred identically.

#### Bursar (Seat D)
- **Name options:** Bursar, Bequest, Bounty
- **One-line pitch:** A grant-funds compliance engine that classifies every expense, timesheet, and drawdown against the actual award terms and federal cost principles, and blocks the unallowable charge before the auditor finds it.

Any agency or nonprofit spending more than $750K in federal funds gets a Single Audit, and the common failure mode is not fraud, it is a hundred small charges that were never allowable, never allocable, or landed outside the period of performance. Repayment plus a finding on the public record is the penalty.

Bursar's AI core is a **transaction-level allowability classifier**. It ingests the award document and derives the governing rule set: allowed cost categories, indirect rate and base, match and in-kind requirements, period of performance, prior-approval triggers, procurement thresholds. Then every Bill expense line, invoice, and time entry is scored against that rule set with a citation to the specific award term or 2 CFR 200 subsection, plus a confidence. High-confidence allowable passes silently; anything ambiguous or adverse becomes a proposal with the citation attached, before the money moves.

The second mechanism is **allocation reasoning**. When a shared cost spans three grants, Bursar proposes the split from the configured methodology and records the basis, which is precisely the documentation auditors demand and grantees never have. Reporting artifacts (SEFA schedule, FFR figures, drawdown packet, subrecipient monitoring) generate from the same evidence chain.

- **Wedge / customer fit:** Small municipalities, school districts, community-health and social-service nonprofits, small research shops. Incumbents are enterprise ERP fund-accounting modules costing more than the grants of a 20-person org. The axis is **money at risk**: a five-figure disallowance dwarfs the price of the app, and the check happens before the spend, which nothing else in the market does.
- **Scope:** Entities: `bursar_awards`, `bursar_terms`, `bursar_funds`, `bursar_allocations`, `bursar_classifications`, `bursar_matches`, `bursar_drawdowns`, `bursar_subrecipients`, `bursar_findings`. Screens: award ledger, live allowability inbox, allocation designer, match/in-kind tracker, report generator. Flagship MCP tool: `bursar_classify_charge(expense_id)`.
- **Platform reuse:** Bill as primary source of truth via shared DB, Bam time entries, Bin for award documents, the internal llm-provider route used by Bulwark's extraction service, `agent_proposals`, Bolt for period-of-performance and drawdown deadlines, Bench dashboards, Basis for certified spend metrics.
- **Build argument:** Converts Bill from a billing app into a fund-accounting-grade system without rewriting Bill, and its value is denominated directly in dollars the customer would otherwise repay.

#### Bollard (Seat D)
- **Name options:** Bollard, Bailiwick, Badge
- **One-line pitch:** Permit and license intake where an AI plan-check agent reads the application against the agency's own adopted code and returns cited correction letters in minutes instead of weeks.

The permit counter is where small agencies are most visibly bad: an application sits, a reviewer eventually reads it against a municipal code they half-remember, and the applicant gets a correction letter six weeks later citing three items, then waits again. The routing workflow is the boring part and every incumbent sells only that.

Bollard's core is the **code corpus as a queryable authority**. The agency loads its adopted ordinances, zoning tables, adopted building-code amendments, and design standards into an indexed corpus (Beacon-backed, Qdrant-retrieved). An application then gets an AI plan-check pass: setbacks, use permissibility in the zone, parking counts, occupancy, submittal completeness, fee calculation, each returned as a finding with the ordinance section quoted verbatim. Reviewers accept, edit, or reject each finding through the HITL queue. The agent never issues a permit; it eliminates the reading.

The second mechanism is **routing derived from the findings rather than a static flowchart**: a grease interceptor pulls in environmental health; a corner lot pulls in traffic sight-line review. Inspections schedule through Book, results attach through Bay/Bin, and the applicant tracks everything through a token-gated public status page with no account.

- **Wedge / customer fit:** Small city and county community-development, building, and licensing departments, plus special-event and business-license desks. Accela and Tyler EnerGov are incumbents and a 15-person city cannot afford either the license or the six-month configuration. The axis is **turnaround time**, which is politically salient in a way that makes budget appear.
- **Scope:** Entities: `bollard_record_types`, `bollard_applications`, `bollard_code_sources`, `bollard_findings`, `bollard_reviews`, `bollard_conditions`, `bollard_inspections`, `bollard_fees`, `bollard_issuances`. Screens: intake, application review with findings and cited code side by side, correction-letter builder, inspection calendar, public status portal. Flagship MCP tool: `bollard_plan_check(application_id)`.
- **Platform reuse:** Blank for application forms and conditional logic, Beacon + Qdrant for the code corpus, Bin for plan sets, Bay for markup and its 48-hex public-token guest pattern, Book for inspections, Bill for fees, Bolt for status transitions, `agent_proposals`.
- **Build argument:** The highest-visibility public-facing surface in the vertical and the one where an AI agent's advantage (reading a 900-page code against a 40-page application) is most obviously superhuman. Proves out "adopted code as a retrieval corpus," a pattern resellable to any regulated vertical.

**Deliberately out of scope across Seat D's five:** records retention and defensible destruction, elections, payroll, utility billing, and anything requiring a state-specific financial-system integration in v1.

### Seat E - Operator / developer experience & platform tooling

Seat E's grounding notes: `apps/api/src/routes/org.routes.ts` has `transfer-ownership` but no work-reassignment path on member removal; there is no restore/revert/undo route anywhere in `apps/api/src/routes/` (activity_log is append-only and partitioned); Bolt's `ai-assist.routes.ts` does prompt-to-rule generate and rule explain only, with no mining of historical executions; retention exists only per-app; `permissions_divergence_log` exists but is a SuperUser-only engineering dashboard, not an org-admin surface. All five proposals are deliberately aimed at an owner, ops lead, or office manager rather than an engineer, per the recorded lesson from Bespoke and Bridle.

#### Baton (Seat E)
- **Name options:** Baton, Bequeath, Bridge
- **One-line pitch:** When someone joins, leaves, or changes role, Baton reconstructs what that person actually owned across all 22 apps, extracts the knowledge only they had, and hands it to a named successor as a reviewed plan.

Removing a member today is an account operation. The work is not: a departing account manager leaves Bond deals mid-stage, Bam tasks with implicit context, Book recurring meetings, Bill invoices they were chasing, Beacon articles nobody else can edit, Bin folders, an API key, and possibly an agent runner they configured. Nothing in the suite finds any of that, and nothing captures what they knew.

The AI-native core is two reasoners over evidence the platform already holds. The first is **ownership reconstruction**: not "rows where assignee_id = X" but a judgment about what each owned artifact is, whether it is live, and what happens if it stalls. It reads `v_activity_unified`, `entity_links`, and per-app state to build a typed inventory ranked by decay risk (a Bond deal at 80 percent with a dated close beats a stale Bam backlog card). The second is **successor inference**: it reuses `expertise_for_topic` and `activity_by_actor` to nominate a specific person per item with a cited reason, rather than dumping everything on the manager.

The third piece is the one no other product attempts: **tacit-knowledge extraction**. Baton reads the departing person's own trail (Banter threads, task comments, Brief docs, Helpdesk replies, Beacon edits) and drafts role-scoped Beacon articles: how they actually handled the awkward customer, the undocumented step in the monthly close, which vendor contact really answers. Every draft, every reassignment, every access revocation goes into `agent_proposals`. Baton sends nothing and moves nothing unattended.

Run it in reverse and it is onboarding. Run it with nobody leaving and it is a bus-factor report: "four things in this company have exactly one person who understands them."

- **Wedge / customer fit:** The owner or ops lead of a 12-person company on the day their only salesperson resigns. Rippling and BetterCloud deprovision accounts; they have no idea what the work was. Knowledge-base tools require the departing person to write things down, least of all in the two weeks after they quit. The axis is **continuity risk at the moment of highest cost**.
- **Scope:** Entities: `baton_transitions`, `baton_inventory_items`, `baton_knowledge_drafts`. Screens: Transition workspace, Knowledge capture review, Bus-factor map, Settings. Flagship MCP tool: `baton_plan_transition(user_id, direction, effective_date)`.
- **Platform reuse:** `v_activity_unified` and `activity_by_actor`, `entity_links`, `expertise_for_topic`, `search_everything`, `can_access` so a successor is never shown an item they cannot see, `agent_proposals`, internal-llm, worker queues, Beacon for published output, permissions catalog for revocation.
- **Build argument:** Subtract the AI and you have a checklist, which is exactly what every SMB already fails to complete. The failure mode is a rejected draft, never an irreversible act. It monetizes an event guaranteed to happen at every customer, and it makes 22 apps feel like one company.

#### Backstop (Seat E)
- **Name options:** Backstop, Bygone, Ballast
- **One-line pitch:** The suite's undo button for the agent era: it explains what a change actually did across every app, traces its blast radius, and drafts a safe reversal.

BigBlueBam now has 847 MCP tools, service accounts, outbound webhooks, and Bolt rules that write to 22 apps. An agent running overnight can touch hundreds of records across five apps in one chain. The platform records all of it and can reverse none of it. There is no restore route in the codebase. The honest position today is: if something went wrong, read the append-only log and fix it by hand.

Backstop's core mechanism is **causal blast-radius reconstruction**. A change is not one row edit; it is an edit that fired a Bolt rule that upserted a Bond contact that triggered a Blast segment recompute. Backstop stitches `activity_log`, `bolt_event_trace`, execution records, and `entity_links` into a directed causal graph and then does the part that is irreducibly a reasoning problem: deciding which downstream effects are consequences to be undone and which are independent work that happened to follow. It then synthesizes a reversal plan as an ordered set of concrete tool calls, in dependency order, annotated with what cannot be reversed (an email already sent, an invoice already paid) and what a reversal would clobber because a human has since edited it.

The operator surface is deliberately plain-language: "Last night the intake agent modified 84 records. 61 were routine. 23 changed a customer's billing contact, and 4 of those flowed into invoices." Every reversal executes through `agent_proposals` with a preflighted diff. Nothing auto-reverts.

This is not Bridle. Bridle governed agents prospectively at run time. Backstop is retrospective, covers every actor equally (human, rule, integration, or agent), and its product is the restore, not the dashboard.

- **Wedge / customer fit:** The owner being asked to trust autonomous agents with customer and billing data who has no answer to "what if it is wrong." Nothing at SMB price offers cross-application, causally-aware reversal; the alternatives are a database backup that also destroys everything good since Tuesday, or per-app version history that knows nothing about the app next door. The axis is **trust, sold as reversibility**, and it is the precondition for the customer letting the rest of the suite act autonomously at all.
- **Scope:** Entities: `backstop_episodes`, `backstop_effects`, `backstop_plans` and `backstop_plan_steps`. Screens: Episode timeline, Blast-radius graph, Reversal review with per-step diff, Watchlist. Flagship MCP tool: `backstop_explain(actor_id | episode_id, window)`.
- **Platform reuse:** `activity_log` and `v_activity_unified`, `bolt_event_trace` and `bolt_recent_events`, agent identity and `agent_audit` from Wave 1, `entity_links`, `agent_proposals`, the MCP internal `POST /tools/call` route as the execution arm, `can_access` gating on every displayed citation.
- **Build argument:** The only proposal that could not exist outside this monorepo: built entirely from platform seams the suite already shipped and that no competitor has. Subtracting the reasoning leaves a raw event log, and its own failure mode is a proposal a human rejects.

#### Bellwether (Seat E)
- **Name options:** Bellwether, Bloodhound, Burrow
- **One-line pitch:** Discovers how your company actually gets work done by mining what people really did across the suite, writes it down, offers to automate it, and then tells you when someone goes off the path.

Every small company has a dozen undocumented processes that live in one person's head. Bolt can execute a rule once a human has written it, but neither Bolt nor its ai-assist route knows what your team does. The gap is discovery.

Bellwether does **process induction over evidence**. It reads the unified activity stream and Bolt executions and finds recurring multi-app sequences with variant analysis: "in the last quarter, a Bond deal reaching Won was followed within three days by a Bam project from a template, a Bill invoice, and a Book kickoff, seventeen times. Three times the invoice never appeared. Median gap from Won to invoice is nine days, and the three longest all belong to one owner." That is process mining, a category priced for enterprises and modeled on data an SMB does not have. This suite has the data by construction.

Two outputs follow. A **living operations manual**: each discovered process becomes a Beacon article that regenerates as behavior drifts, so documentation stops rotting. And a **conformance monitor**: once confirmed by a human, deviations raise a plain-language flag ("this Won deal has no invoice and it has been eleven days"). Where a step is deterministic, Bellwether drafts the Bolt rule. Bellwether never executes anything; discovery and conformance are its product, Bolt remains the runtime.

- **Wedge / customer fit:** The operations lead who suspects things are falling through cracks and cannot prove where. Celonis and Signavio start well above this market and require event logs you do not have. The axis is **cost and integration**: zero instrumentation, because the event log is already the suite's own activity stream.
- **Scope:** Entities: `bellwether_processes`, `bellwether_variants`, `bellwether_deviations`. Screens: Discovered processes, Process detail with variant and timing breakdown, Deviation inbox, Manual. Flagship MCP tool: `bellwether_discover(scope, window)`.
- **Platform reuse:** `v_activity_unified`, `bolt_recent_events` and execution history, `entity_links`, Bolt for rule authoring handoff, Beacon for published manuals, Bearing, `agent_proposals`, worker nightly mining.
- **Build argument:** Converts the suite's biggest latent asset, a genuine cross-application event log for a whole company, into something a non-technical owner reads on a Monday morning. Raises the value of Bolt without duplicating it: Bolt's weakest link is that someone must think of the rule.

#### Backlot (Seat E)
- **Name options:** Backlot, Bunker, Bivouac
- **One-line pitch:** A disposable, realistic, fully fake copy of your workspace where new hires, new agents, and risky changes can rehearse before touching anything real.

A new hire has to learn on live customer data, and the way they learn is by making a mistake in front of a customer. A new agent or Bolt rule has to be trusted with production writes before anyone has watched it work. The standard answer is a staging environment, which no 20-person company maintains and no office manager could use if it existed.

Backlot mints a **coherent synthetic mirror** of the org. This is the AI-native part and it is harder than it sounds: masking a database yields gibberish, because a Bond deal, its Bam project, its Bill invoice, its Banter thread, and its Bin files must stay mutually consistent or the copy teaches nothing. Backlot walks `entity_links` and the per-app schemas to preserve referential and narrative integrity, generating plausible-but-fictional companies, people, threads and documents that keep the shape, volume and timing of the real workspace while containing no real person or number. The suite already proves this pattern works in the small: the gilligan dataset exists because coherent themed data is the only kind worth showing anyone.

Then comes **rehearsal**. Point an agent or a Bolt rule at a backlot and let it run at speed, then read the diff report: what it would have changed, where it hesitated, which proposals it generated, which policies it tripped. Same for a person. Backlots are RLS-isolated, expire on a timer, and can never emit outbound mail, webhooks, or invoices.

- **Wedge / customer fit:** The manager onboarding a hire or turning on an agent; the felt sentence is "let it practice on fake data first." Tonic and Gretel sell to data engineers and produce tables, not a working workspace. The axis is **trust and speed of adoption**.
- **Scope:** Entities: `backlots`, `backlot_mappings`, `backlot_runs` and `backlot_diffs`. Screens: Backlot list with countdown, Create wizard, Rehearsal run report, Trainee scorecard. Flagship MCP tool: `backlot_rehearse(backlot_id, agent_id | automation_id)`.
- **Platform reuse:** RLS and `app.current_org_id` for hard isolation, the whole schema surface, `entity_links`, `@bigbluebam/storage`, agent policies and the kill switch as outbound guard, worker queues, the existing `scripts/seed-*.mjs` architecture as prior art.
- **Build argument:** The cheapest way to make everything else in the suite adoptable, and the only proposal that pays back on day one of a trial. Risk acknowledged: closer to infrastructure than the other four, which is the trap this seat fell into twice, so it ranks below Baton and Backstop.

#### Bastion (Seat E)
- **Name options:** Bastion, Bulkhead, Bracket
- **One-line pitch:** Answers "who at my company can see the payroll invoices, and why" in plain English, watches for access that drifts away from how people actually work, and drafts the fix.

The suite has a real permissions substrate: an `app.resource.verb` catalog generated from a 25,000-line manifest, a Redis-cached `PermissionContext`, RLS policies, and a `permissions_divergence_log`. All of it is engineer-facing, and the divergence dashboard is SuperUser-only. An org admin at a 20-person company has no way to answer the two questions they are actually asked.

Bastion's mechanism is **effective-access reasoning plus behavioral comparison**. It computes the true effective reach of a principal by resolving the permission catalog, project memberships, RLS scope, guest invitations, API keys with their scopes, and service accounts into one answer, then explains it in a sentence with the specific grant that caused it. It compares granted reach against observed behavior and surfaces the delta: standing access nobody has exercised in ninety days, an API key with `read_write` that only ever reads, a guest link outliving its engagement, a service account whose allowlist is broader than the tools it calls. Each finding becomes a scoped revocation proposal, and it covers agent principals on equal footing with humans, which the compliance market has no answer for yet.

- **Wedge / customer fit:** The founder filling in a SOC 2 or customer security questionnaire, or reacting to a departure. SailPoint and Veza are enterprise-priced and see only the identity provider, never the meaning of the data. The axis is **cost plus depth**.
- **Scope:** Entities: `bastion_reviews`, `bastion_findings`, `bastion_attestations`. Screens: Person access explainer, Findings inbox, Review campaign with sign-off, Agent and key inventory. Flagship MCP tool: `bastion_effective_access(principal_id)`.
- **Platform reuse:** `@bigbluebam/permissions` resolver and catalog, `permissions_divergence_log`, RLS, `api_keys` including the rotation grace window, `guest_invitations`, `service-account.routes.ts`, `agent_policies`, `can_access`, `v_activity_unified`, `agent_proposals`.
- **Build argument:** Turns platform machinery the suite already paid for into a surface a non-engineer buys, and it is the natural companion to Baton's revocation half. Ranked fifth because the reasoning is thinner: a determined engineer could get most of the way with queries.

**Seat E ranking:** Baton, Backstop, Bellwether, Backlot, Bastion. The two it will fight for are Baton (guaranteed high-pain event, unmistakably non-technical buyer) and Backstop (impossible outside this codebase; the suite cannot credibly sell autonomous agents until someone builds the undo).

### Seat F - Engineering & software development

#### Brunt (Seat F)
- **Name options:** Brunt, Bellwether, Blastwave
- **One-line pitch:** Before a code change ships, Brunt tells you in business language what it will break: which customers, which invoices, which help articles, which promises.

Brunt ingests your repos (the suite already has `github_integrations` + `github-webhook.routes.ts`, but it only flips a Bam phase on PR open/merge and understands nothing about the code) and builds a **consequence graph**: code symbols and modules on one side, business surfaces on the other. The business side is not invented, it is already in this platform: Bam tasks, Beacon articles, Blank forms, Bill rate/line-item rules, Bond deal fields, Bulwark contract obligations, Blip watches, the permissions catalog, the 847-tool MCP surface, and Bolt rules.

The AI-native core is a two-stage binder. Stage one: an LLM (via the existing internal `/internal/llm/chat` proxy) reads each changed module and emits **behavioral claims** ("this endpoint returns X", "this job runs nightly", "this field is required") stored as typed, code-cited rows, not prose. Stage two: those claims are embedded into Qdrant and matched against the business surfaces above, producing bindings with confidence and evidence. When a PR opens, Brunt diffs the claims, walks the bindings, and posts a blast-radius card: "Beacon article 'Refund policy' now describes behavior this PR removed. Bulwark obligation #14 promises 4-hour export SLA; this PR moves export to the nightly worker. Bolt rule 'Notify on invoice.overdue' listens to an event this PR renames." Each finding is a Bam task or an `agent_proposals` row, which is also the training signal that improves binding confidence.

A non-engineer opens Brunt and sees one screen: what are we about to break, and who feels it. An engineer opens the same PR card and sees the code cites.

- **Wedge / customer fit:** A 2-50 person company with one or two devs has no staff architect and no release manager. The failure mode is not a bug (CI catches bugs), it is the silent lie: docs that describe a product you no longer have, a support macro pointing at a deleted button, an SLA you quietly stopped meeting. Nothing on the market maps a diff to non-code consequences, because no vendor owns the docs, the CRM, the invoices, and the contracts at once. The axis is **integration breadth no point-solution can copy**.
- **Scope:** Entities: `brunt_repos`, `brunt_symbols`, `brunt_claims`, `brunt_bindings`, `brunt_impacts`. Screens: Blast Radius per PR, Consequence Graph explorer, Stale Surfaces inbox, Bindings review. Flagship MCP tool: `brunt_impact_of(ref)`, which accepts a branch, PR, or plain-English proposed change.
- **Platform reuse:** existing `github_integrations` + webhook route, `internal-llm.routes.ts`, Qdrant, `entity_links`, `agent_proposals`, Bolt (`impact.detected`, `surface.stale`), worker queues, permissions + `can_access`, Bam task creation.
- **Build argument:** The only app on this list that cannot be built by anyone else: GitHub, Linear, and Sentry each see a fifth of the graph. It also makes every other app in the suite more valuable the moment it ships, because each new app is one more surface Brunt protects.

#### Burn (Seat F)
- **Name options:** Burn, Ballast, Bounty
- **One-line pitch:** Burn watches engineering work against the contract that paid for it and tells you, this week, which client you are losing money on and exactly which un-agreed work caused it.

For an agency or small product shop, margin dies of scope creep nobody logged. Burn reads the signed SOW or proposal (Bin asset, extracted the way Bulwark already extracts obligations), decomposes it into a **deliverable ledger** with a priced envelope per deliverable, then continuously classifies incoming reality (Bam tasks, time entries, commits and PR titles, Banter threads, Helpdesk tickets) into those deliverables using an LLM classifier plus embedding retrieval, with an explicit `unscoped` bucket.

The `unscoped` bucket is the product. Every item there is work someone is doing that nobody sold. Burn scores it in dollars using Bill's existing `bill_rates`, attributes it to a Bond account, and raises it while it is still three hours old instead of at invoice time. The output is a drafted change order or Bill line item queued in `agent_proposals`, never sent unattended. Burn also runs the inverse: contracted deliverables with zero attributed activity as the deadline approaches.

- **Wedge / customer fit:** Services firms of 2-50 people who reconcile scope at month-end in a spreadsheet, by which point the work is done, unbillable, and awkward to charge for. Time trackers know hours but not scope; PM tools know tasks but not price; accounting knows invoices but not code. The axis is **latency**: creep detected in hours, not at billing.
- **Scope:** Entities: `burn_engagements`, `burn_deliverables`, `burn_attributions`, `burn_variances`. Screens: Margin board by client, Unscoped queue, Deliverable burn-down, Change-order drafts. Flagship MCP tool: `burn_attribute(work_ref)`; secondary `burn_margin(account)`.
- **Platform reuse:** Bin + the Bulwark extraction pattern, Bill (`bill_rates`, `bill_line_items`, `bill_expenses`), Bond, Bam tasks + time entries, Braid `braid_resolve`, `agent_proposals`, Bolt (`scope.variance_detected`), worker queues.
- **Build argument:** The engineering-lens idea whose value a CFO reads without translation, and it monetizes work the suite already stores but never joins. It also gives Bill a reason to exist beyond invoice printing.

#### Burden (Seat F)
- **Name options:** Burden, Bazaar, Bloat
- **One-line pitch:** Burden reconciles every dependency, vendor, and API key your code actually uses against every subscription you actually pay for, and flags the ones on either side that should not be there.

Two ledgers that never meet: what the software depends on (lockfiles, imports, env vars, outbound hostnames, OAuth apps, webhook targets) and what the company pays for (Bill expenses, recurring invoices, vendor contracts in Bin). Burden builds both automatically and joins them with an LLM-assisted matcher, because "Stripe" in a lockfile, "STRIPE_SECRET_KEY" in an env template, and "Stripe Payments Inc, $89/mo" on a card statement do not join on any key.

Three outputs, each with an owner and a dollar figure. **Paying, not using**: a vendor billed monthly with no code path touching it for 90+ days, pure recoverable cash. **Using, not paying**: a service in the critical path on someone's personal card or a free tier about to rate-limit you, the outage you have not had yet. **Using, exposed**: a dependency whose license conflicts with how you ship, an abandoned package, or a vendor whose contract has an auto-renew window closing in 11 days. The AI does the judgment calls a scanner cannot: reading a license against your distribution model, reading a termination clause, estimating blast radius.

- **Wedge / customer fit:** Small companies leak 20-30% of SaaS spend on unattributable subscriptions and simultaneously run production on a free tier and a founder's credit card. SaaS-spend tools see the card statement and guess; SCA tools see the lockfile and ignore money; neither reads the contract. The axis is **the join**. Also arrives free with the security-questionnaire answer every SMB now gets asked for.
- **Scope:** Entities: `burden_components`, `burden_vendors`, `burden_links`, `burden_findings`. Screens: Supply ledger, Waste inbox with cancel-draft, Renewal radar, Questionnaire export. Flagship MCP tool: `burden_reconcile(scope)`; secondary `burden_what_if_removed(component)`.
- **Platform reuse:** Bill (`bill_expenses`, `bill_recurring_invoices`), Bin + Bulwark-style clause extraction, existing GitHub integration, `agent_proposals`, Bolt (`vendor.waste_detected`, `renewal.window_open`), Bench dashboards, worker scheduled jobs.
- **Build argument:** The only idea here that pays for itself in month one in cash the customer can point at, which makes it the easiest thing the suite has ever had to sell.

#### Bind (Seat F)
- **Name options:** Bind, Brace, Bevel
- **One-line pitch:** Bind keeps the thing you said you were building and the thing that actually got built provably attached to each other, statement by statement.

Every small team writes intent somewhere in this suite already: a Brief doc, a Blueprint diagram, a Bam epic, a Blank intake form, a Bearing key result. Then the code diverges quietly, and six months later nobody can tell which parts of the plan are real. Bind decomposes intent artifacts into **atomic requirements**, one testable statement each, and maintains a live binding from each requirement to code evidence with a state machine: `unbuilt` to `claimed` to `evidenced` to `drifted` to `abandoned`.

The AI-native mechanism is adversarial rather than generative. When a PR claims to satisfy requirement R, Bind does not take the claim: it re-derives what the diff actually does, then argues the two against each other and returns a verdict with the specific gap ("R says exports are idempotent; this handler has no dedupe key"). Drift detection runs the other direction on a schedule. Bind can also generate the missing conformance test as a Bam task rather than pretending prose is proof.

The screen a founder looks at is a single conformance bar per initiative: 41 requirements, 23 evidenced, 6 drifted, 12 never built, and the 12 are named.

- **Wedge / customer fit:** Teams selling to regulated or enterprise-adjacent buyers get asked "show me that the feature works as documented" and have nothing but a screenshot. Jama and Polarion cost enterprise money, require a full-time admin, and do not read code. The axis is **cost and automation**: traceability as a byproduct of working normally.
- **Scope:** Entities: `bind_requirements`, `bind_evidence`, `bind_verdicts`, `bind_drift_events`. Screens: Conformance board, Requirement detail with evidence trail, PR verdict card, Drift inbox. Flagship MCP tool: `bind_conformance(initiative)`; secondary `bind_verify(requirement_id, pr_ref)`.
- **Platform reuse:** Brief + Blueprint + Bam epics + Bearing as intent sources, GitHub integration, internal LLM proxy, Qdrant, `entity_links`, `agent_proposals`, Bolt (`requirement.drifted`), Bam task creation, permissions.
- **Build argument:** Turns the suite's existing writing surfaces from inert documents into enforced contracts, raising the value of apps already shipped instead of adding an isolated silo.

#### Bequest (Seat F)
- **Name options:** Bequest, Bygone, Bearings
- **One-line pitch:** Bequest answers "why is it like this?" about your own system, with the actual decision, the actual thread, and the actual commit, including for the people who have left.

Beacon holds what someone deliberately sat down and wrote. The expensive knowledge is the other kind: the reason a retry is 7 seconds, the customer who forced the weird tax rule, the approach tried in 2024 that failed. That evidence exists, scattered across git history, PR discussion, Banter threads, Helpdesk tickets, Bam task comments, Board sessions, and nobody will ever assemble it by hand.

Bequest mines it into a **rationale graph**: candidate decisions extracted from the trail, each with a claim, a date, participants, alternatives considered, and the causal chain that produced it. The AI-native part is corroboration and contradiction. A decision claimed in a Banter thread is upgraded when the commit that implements it is found; flagged `superseded` when later code contradicts it; flagged `orphaned` when everyone attached to it has left, which is a literal bus-factor readout per subsystem. Queries are answered in natural language with citations, and Bequest volunteers rationale unprompted: open a file or Bam task touching a subsystem and the relevant history surfaces, including "the last person who tried this reverted it, here is why."

Second surface: onboarding. Point Bequest at a new hire and it generates a ramp path through the rationale graph ordered by what they are about to touch, and it knows when the graph has a hole worth interviewing a human about.

- **Wedge / customer fit:** For a 2-50 person team, one departure can take 40% of the operating knowledge. Wikis fail because writing them is unpaid work with no deadline. Code-chat tools read the code but not the argument. The axis is **zero authoring cost**. Not redundant with Beacon: Bequest's output can be promoted into Beacon as a human-owned article once corroborated.
- **Scope:** Entities: `bequest_decisions`, `bequest_evidence`, `bequest_contradictions`, `bequest_subsystems` with bus-factor score. Screens: Ask, Subsystem dossier, Bus-factor map, Orphaned-knowledge queue, Ramp path. Flagship MCP tool: `bequest_why(subject)`.
- **Platform reuse:** `v_activity_unified`, `search_everything`, Banter/Helpdesk/Bam comment corpora, GitHub integration, Qdrant, internal LLM proxy, `expertise_for_topic`, `can_access` (mandatory here, mined knowledge crosses permission boundaries by nature), Beacon promotion path, worker indexing.
- **Build argument:** The app that gets better the longer a customer stays, because its raw material is their own accumulated history in the suite. That is the retention flywheel none of the other 22 apps has.

### Seat G - Creative & marketing

Seat G's grounding: Blast is email-only, Bin is storage + structured data, Bay is annotate/decide on versions, Board is canvas. There is no brand-governance surface, no external/multi-channel distribution plane, no creative-attribute performance model, and no customer-language mining anywhere in `apps/`. `docs/marketing-voice.md` exists as hand-written prose for the marketing site only; it is not machine-readable and nothing enforces it.

#### Badge (Seat G)
- **Name options:** Badge, Banner, Canon
- **One-line pitch:** A machine-enforceable brand system that every AI writer and human draft in the suite must clear before it ships.

BigBlueBam has 847 MCP tools and a dozen apps whose AI drafts customer-facing text: `blast_draft_email_content`, `blast_suggest_subject_lines`, Bulwark's drafted notices, Beacon articles, Bond outreach, Helpdesk replies, proposals in the HITL queue. Nothing governs how any of it sounds. Badge turns brand into a typed, versioned, queryable object: voice rules with positive/negative exemplars, an approved claim library where each claim carries an evidence link (a Bench metric, a Bay-approved case study, a signed customer quote), a terminology map, visual rules bound to Bin assets, and per-audience registers.

The AI-native core is a **compliance pass, not a chatbot**: `badge_check(text|asset, channel, audience)` returns a scored diff, flagged spans, the rule violated, a rewritten span that satisfies it, and a hard block on any unsubstantiated claim (the claim library is the allowlist; "the fastest CRM on the market" fails unless a claim record with evidence backs it). Badge registers as a pre-publish gate on Blast sends, Beacon publishes, and Bay approval decisions via Bolt, and exposes itself to every other agent so a drafting agent calls Badge before it writes. Second mechanism: **rule induction**, point Badge at 200 of your best-performing shipped assets and it infers the voice rules you never wrote down, then asks you to confirm each as a proposal.

- **Wedge / customer fit:** A 2-50 person team has no brand manager. Their consistency today is one Google Doc three people have read and every contractor ignores, and their AI output drifts to generic LLM-voice within a week. The axis is **trust at scale**: the more of your writing an agent does, the more you need something that says no. Every competitor's answer is a PDF style guide; nobody has a callable API that blocks a non-compliant send. Frontify and Bynder start around five figures a year and are asset portals, not compliance engines.
- **Scope:** Entities: `badge_rules`, `badge_claims`, `badge_terms`, `badge_kits`, `badge_audiences`, `badge_checks`. Screens: brand home, rule editor with live try-it pane, claim library with evidence status, violation feed, induction review queue. Flagship tool: `badge_check`; runners-up `badge_rewrite`, `badge_claim_verify`, `badge_induct_rules`.
- **Platform reuse:** `llm-provider.service.ts` + internal LLM route, `agent_proposals`, Bolt events as pre-publish hook, Bin for visual kits, Qdrant for exemplar retrieval, `agent_policies` so a policy can require `badge_check` before any `blast_send_campaign`, permissions catalog.
- **Build argument:** The only proposal that gets more valuable with every app the suite adds, because it taxes the thing the suite already does most: generate text. Structurally impossible to clone as "another Canva" since it has no canvas. It directly hardens the suite's loudest marketing claim by making the AI accountable to something.

#### Bloom (Seat G)
- **Name options:** Bloom, Bough, Bevy
- **One-line pitch:** One long asset in, a lineage-tracked tree of channel-native derivatives out, with reuse and decay tracked per branch.

Small teams under-publish not because they lack ideas but because turning one good thing into fifteen shippable things is grinding manual work. Bloom takes a source artifact already in the suite (a Brief doc, a Beacon article, a Bay-approved video, a webinar transcript in Bin, a closed-won Bond deal's story) and expands it into a **derivative graph**: thread, short-form script with shot list, email module for Blast, sales one-pager, FAQ entries back into Beacon, form intro copy, image crops from the master in Bin.

The AI-native mechanism is not "generate variants," it is the **graph with provenance and propagation**. Every derivative keeps a typed edge to its source and to the specific source span it came from. When the source changes (the price in the Brief doc updates, the case study gets un-approved in Bay, a Badge claim loses its evidence) Bloom walks the graph, marks every affected descendant stale, and proposes the patched version into the HITL queue. It also tracks **saturation**: which source assets have been squeezed dry, which are under-exploited, and which derivative shapes historically earn their keep.

- **Wedge / customer fit:** The axis is **cost per published unit**. Opus and Repurpose.io are stateless converters: you feed them a file, they hand back clips, and nothing knows the clip exists next week when the claim in it becomes false. Nobody offers stale-derivative propagation, because nobody else owns both the source document store and the distribution surface.
- **Scope:** Entities: `bloom_sources`, `bloom_derivatives`, `bloom_edges`, `bloom_recipes`, `bloom_staleness`. Screens: source library with saturation heat, expansion canvas, derivative editor, stale-propagation review queue. Flagship tool: `bloom_expand(source_ref, recipes[])`; plus `bloom_trace(derivative)`.
- **Platform reuse:** `entity_links`, Bin/Bay for masters and approval state, Brief and Beacon as sources, Blast as sink, worker queues, Qdrant for near-duplicate detection, Badge if it ships.
- **Build argument:** Monetizes content the customer already paid to create and that already sits in the suite's stores. The staleness graph is a genuinely novel primitive, only buildable by someone who owns the whole corpus.

#### Beat (Seat G)
- **Name options:** Beat, Bellwether, Barometer
- **One-line pitch:** Decomposes every creative you ship into typed attributes and learns which attributes, not which assets, actually drive outcomes.

Blast already records opens, clicks, and device analytics. That tells you campaign #47 beat campaign #46. It does not tell you why, so it never compounds. Beat runs feature extraction over every shipped creative and tags it with a structured attribute vector: hook archetype, reading grade, concreteness, proof type, CTA verb class, length, dominant color, face-present, first-three-seconds motion, offer type, send timing.

Then it fits a small honest model over outcomes and reports **attribute-level effects with confidence intervals and sample counts**, refusing to claim significance it does not have. The output is not a dashboard, it is a **generative prior**: `beat_brief(goal, audience)` emits the attribute profile most likely to work for this org's list, which Blast/Bloom consume as drafting constraints. It also runs cheap holdout experiments: when two variants differ on exactly one attribute, Beat banks the contrast automatically instead of requiring anyone to set up an A/B test.

- **Wedge / customer fit:** The axis is **learning rate at low volume**. SMB teams send 4 campaigns a month; classic A/B testing needs traffic they will never have, so they run on vibes forever. Attribute-level pooling across all their creative, plus cross-org priors as a cold start, extracts signal from volumes where per-asset testing is statistically dead.
- **Scope:** Entities: `beat_creatives`, `beat_attributes`, `beat_extractions`, `beat_outcomes`, `beat_effects`, `beat_contrasts`. Screens: attribute leaderboard, creative autopsy, brief generator, contrast log. Flagship tool: `beat_brief`; plus `beat_explain(creative_id)`.
- **Platform reuse:** Blast engagement + send log, Blank submissions, Bond deal outcomes for down-funnel truth, Bin for media, Bench for chart rendering (same discipline Basis took), Basis for certified denominators, worker queues, `llm-provider` for multimodal tagging.
- **Build argument:** The feedback half of a loop the suite currently only has the front half of: we can generate and send, and count, but nothing turns counting back into generating.

#### Buzz (Seat G)
- **Name options:** Buzz, Bellow, Babel
- **One-line pitch:** Mines the exact words your customers already used, in tickets, calls, CRM notes, and form answers, into a living positioning, objection, and proof library.

The suite is sitting on the highest-value marketing asset most teams own and doing nothing with it: Helpdesk tickets, Bond activities and notes, Blank free-text, Banter customer channels, Bay guest reviewer comments, call transcripts. Buzz clusters that corpus into recurring **jobs-to-be-done, objections, trigger events, competitor mentions, and delight moments**, each rendered as a phrase in the customer's own vocabulary, backed by citations.

The AI-native mechanism is **evidence-bound synthesis under visibility control**. Every claim carries a citation set, and every citation runs through `can_access` for the person viewing it, so a marketer sees the aggregate pattern and the redacted count without gaining read access to a support ticket they should not see. It also watches drift: when objection volume shifts or a new competitor name surges, Buzz raises it. Outputs are usable objects, not a report: an objection-and-response library Bond serves as battlecards, message candidates Blast can test, FAQ drafts for Beacon, and claim candidates with evidence attached if Badge ships.

- **Wedge / customer fit:** The axis is **research a team of five could never afford**. Message testing is a $20-50k agency engagement or a full-time PMM; the SMB alternative is guessing. Chattermill and Enterpret are support-analytics products priced for enterprise that sit outside your CRM, so they cannot tie a phrase to a closed-won deal.
- **Scope:** Entities: `buzz_corpora`, `buzz_clusters`, `buzz_phrases`, `buzz_citations`, `buzz_objections`, `buzz_shifts`. Screens: language map, cluster detail with cited excerpts, objection library, drift feed, turn-into export rail. Flagship tool: `buzz_language_for(topic|segment)`.
- **Platform reuse:** `v_activity_unified`, Helpdesk/Bond/Blank/Banter corpora, `visibility.service.ts` + `can_access` (mandatory), Qdrant, `phrase-count-tools` and `expertise-tools` as primitives to extend, `agent_proposals` for every promotion.
- **Build argument:** Highest ratio of value to new data: creates a new product out of rows the customer already stores, and is the cleanest demonstration of the platform's visibility preflight doing real work.

#### Blitz (Seat G)
- **Name options:** Blitz, Bugle, Barrage
- **One-line pitch:** State a launch goal and a date; Blitz compiles it into a dated, cross-app execution plan and then runs it, adapting as reality diverges.

A product launch is not an email. It is a Blast sequence, a Beacon doc, a Book demo slot, a Blank signup form, a Bond segment, a Bam task board, a Bill promo, plus twelve dependencies. Today a team assembles that by hand across nine apps and forgets four things. Blitz makes the campaign a first-class object and **compiles** it: given a goal ("300 signups for the v2 launch by Sept 12, audience = trial-lapsed"), it plans the beat sheet, resolves the audience against Bond/Braid, drafts each asset in the app that owns it, wires dependency edges, and hands the plan back for one approval.

Adaptation is the hard part and the actual product. Blitz holds a live model of plan versus reality, pulling actuals from Blast engagement, Book bookings, Blank submissions, Bond stage movement, and when a beat underperforms or a dependency slips it re-plans the remaining beats and files the change as a proposal with the projected delta that justifies it. It never sends unattended.

- **Wedge / customer fit:** The axis is **integration**, the one axis a suite wins by construction. HubSpot Marketing Hub and Marketo cost thousands a month and still only orchestrate what is inside them; they cannot create your project board, your booking page, and your invoice promo. Bolt automates events and is deliberately reactive: it has no notion of a goal, a date, or a plan that can be behind schedule. Blitz is the goal-directed planner Bolt is not.
- **Scope:** Entities: `blitz_campaigns`, `blitz_beats`, `blitz_dependencies`, `blitz_targets`, `blitz_replans`. Screens: goal intake, compiled timeline, pacing view against target, replan review queue. Flagship tool: `blitz_compile(goal, audience, deadline)`.
- **Platform reuse:** Nearly the whole suite as executors via internal `POST /tools/call`, Bolt for event wiring, `agent_proposals` for every write, Bam, Bench/Basis for measurement, Braid for audience resolution, Book/Blank/Bill/Beacon/Blast as beat targets.
- **Build argument:** The strongest possible demonstration of why the suite exists at all, one intent fanning out across nine apps and coming back with a coordinated result, using the MCP catalog as an execution substrate rather than a chat convenience. Its risk is breadth.

**Seat G ranking:** Badge first, Buzz second, Beat third, Bloom fourth, Blitz fifth on scope risk despite the best demo.

## Phase 2 - Debate

One debate round was run. Each seat received the full Phase 1 slate (via this
document), a collision map naming every cluster its proposals sat in, and, for
three seats, a specific challenge the orchestrator judged most likely to decide
the vote: Seat D was asked why a vertical wedge beats a horizontal app for #23;
Seat E was asked to defend against the same customer-fit critique that sank its
two prior runners-up; Seat F was asked to answer "Burn is just Bulwark for SOWs."

**Orchestrator note on what happened.** The round did an unusual amount of work.
**Eleven of the 35 proposals were withdrawn or merged by their own authors**, with
no orchestrator intervention and no merge negotiation required. Every one of the
five name collisions was resolved by voluntary concession. Three of the seven
clusters flagged in the collision map were fully resolved inside the debate
itself, which is why Phase 4 below is short. A second debate round was considered
and rejected: the ideas were converging rather than still colliding, and the
remaining disagreements were genuine product disagreements that a vote resolves
better than another round of argument.

Full verbatim debate replies are preserved in the session transcript. Recorded
below: every stance call, every structural change, each seat's revised slate, and
each seat's strategy statement in its own words.

### Cluster resolutions

| Cluster | Contenders entering debate | Outcome |
| --- | --- | --- |
| Decision / rationale ledger | B/Bygone, C/Bylaw, F/Bequest | **Fully resolved.** B withdrew Bygone and donated prediction-grading; F withdrew Bequest and donated code-corroboration. C's Bylaw (renamed **Buttress**) absorbed both and stands alone. |
| Process induction | A/Blaze, E/Bellwether | **Mutually conceded - orphaned.** Each seat withdrew its own version in favour of the other's. See the note below. |
| Prose to themes | B/Bramble, G/Buzz | **Resolved.** G withdrew Buzz, conceding theme-identity-over-time was the hard part it had hand-waved, and folded Buzz's output objects into its own Badge. Bramble uncontested. |
| Goal-directed execution | A/Behest, G/Blitz | **Resolved.** G withdrew Blitz as "a weaker twin," flagging the certified-metric adoption cliff Behest should absorb. |
| Agent safety / rehearsal | A/Bracket, E/Backstop, E/Backlot | **Partly resolved.** E withdrew Backlot in favour of Bracket. Backstop and Bracket both stand, with an agreed partition (forward gate vs backward undo). |
| Knowledge continuity on departure | C/Baton, C/Bloom, E/Baton, F/Bequest | **Resolved by boundary.** C withdrew Bloom, merged Baton+Bloom into **Byline** (never-written-down knowledge). E renamed Baton to **Brace** and narrowed to executed handover, ceding onboarding paths and bus-factor mapping. F withdrew Bequest. |
| Money vs governing document | F/Burn, F/Burden, D/Bursar | **Partly resolved.** D conceded it would not fight to advance both, asking only that Burn carry a pre-transaction block. Both remain on the board. |

### The mutual concession (Blaze / Bellwether)

Seat A conceded Blaze to Seat E's Bellwether, judging E's "living operations
manual plus conformance monitor" framing more legible to a non-technical ops lead
and its own framing vulnerable to the charge of being a Bolt feature. In the same
round, Seat E conceded Bellwether to Seat A's Blaze, judging A's specification
better on per-step latency and branch-frequency distributions, the hours-saved
estimate attached to each proposal, and correctly naming Bolt's `template-resolver`
as the adoption target.

Each surrendered the ground to the other. Both were offered the chance to reclaim
it at submission time and neither did, each preferring a different app from its
own slate. Process induction therefore leaves the session carried by nobody. Two
other seats (B, C, F, G all noted it independently) had separately flagged the pair
as one app that should not consume two finalist slots, and F added a substantive
objection: induced procedures at 2-50 person data volumes will be dominated by a
handful of high-frequency sequences the owner already knows about, with a long tail
too sparse to cluster. The idea is recorded here as a live candidate for a future
session rather than a rejected one.

### Name concessions

All five collisions cleared voluntarily. A vacated **Baton** (to C and E) and
renamed to **Behalf**. D vacated **Bylaw** (to C) and renamed to **Gavel**. G
vacated **Bloom** and **Beat** (both to C) and renamed to **Bough** and
**Barometer**. C then renamed four of its own five anyway (Bylaw to Buttress, Beat
to Brisk, Baton to Byline, Bloom withdrawn), observing that it was "the most
collided seat by name and the least collided by mechanism" and wanted the free
objections removed. B renamed **Bellwether** to **Bode**, trading the word rather
than arguing over it, and claimed **Ballast** against two rival seats' alternates.
E renamed **Baton** to **Brace**.

### Post-debate slates

| Seat | Revised five |
| --- | --- |
| A | **Behalf** (was Baton), **Bracket**, **Behest**, **Bogey** (re-aimed to commitment-time interrupt only, ceding forecasting to B), **Billet** (new - hire an AI role-holder with a job description, bounded authority, durable role memory, and a performance review it can fail) |
| B | **Bandit**, **Bode** (was Bellwether), **Ballast**, **Bramble** (merge-ready), **Beam** (new - the only outward-facing proposal on the board) |
| C | **Buttress** (Bylaw + B's Bygone), **Brisk** (was Beat), **Byline** (Baton + Bloom, re-aimed so the AI is the interviewer rather than the recorder), **Bearer** (new - informal promises to outsiders, matched against fulfilling artifacts), **Bazaar** |
| D | **Bid**, **Blot** (v1 re-scoped to ingest an external corpus, removing its own cold-start dependency), **Gavel** (was Bylaw), **Bursar**, **Bollard** (v1 narrowed to conformance-pass only) |
| E | **Backstop**, **Brace** (was Baton, narrowed to executed handover), **Banish** (new - erasure with retention adjudication and a signed certificate), **Beachhead** (new - entity archaeology over messy real-world files), **Bastion** |
| F | **Brunt** (absorbed Bind), **Burn**, **Boomerang** (new - match shipped capability back to the customers who asked for it), **Burden** (added upstream-deprecation reading), **Barnacle** (new - price technical debt in delay-days and incident-dollars) |
| G | **Badge** (widened from brand linter to outbound truth gate), **Bolster** (new - advocacy-window detection with rights and consent expiry), **Bough** (was Bloom), **Barometer** (was Beat, re-aimed to prospective contrast design after Bandit), **Bevel** (new - data-bound design compiler) |

### Notable arguments made

**Seat D's cold-start critique**, which several seats then answered directly and
which shaped the rest of the session: it counted how many rival proposals are worth
nothing on day 30 of a trial (Behalf needs 12 correct predictions per class; process
induction needs a quarter of mined episodes; Bogey, Bequest and Beat need a year of
graded history; Behest needs a certified metric library no customer has yet;
Bramble and Buzz need a corpus), argued the suite has shipped three consecutive
deepening layers that do not sell themselves, and framed the axis for #23 as
**acquisition versus deepening**. It then applied the same test to its own slate and
re-scoped Blot to ingest an external corpus.

**Seat G's adjacency objection to the whole vertical**: each of Seat D's five
requires a per-jurisdiction statutory corpus (state PRA exemptions, open-meeting
notice standards, 2 CFR 200, adopted municipal code) that the customer cannot supply
and BigBlueBam would have to acquire and maintain per state, which is "a content
business bolted to a software business."

**Seat A against Backstop, using Seat E's own scope text**: the expensive agent
failures are exactly the irreversible ones (Blast sends, Bill invoices, Bulwark
notices, Helpdesk replies), so an undo that cannot undo the class of damage that
costs money "is a comfort object." Seat F made the adjacent point that the reliably
deliverable half of Backstop is the explanation, and explanation is worth more
before a change than after it.

**Seat B against Behest's headline**: a control loop that reads a metric, sees it
move, and attributes the movement to its own actions "is not verification, it is
post hoc ergo propter hoc with a worker queue."

**Seat E's three-way partition of "blast radius"**, offered so voters would not
score three apps as duplicates: Brunt's radius is prospective and originates in a
code diff; Ballast's is a data-quality incident propagating into metrics and
dashboards; Backstop's is retrospective and originates in writes that already
happened, and is the only one whose output is a reversal rather than a warning.

**Seat F's answer to the Bulwark challenge**: Bulwark's unit of work is a clause
with a date and its output is a notice; Burn's unit is every task, commit, ticket
and hour the company logs, and its question is which priced envelope this belongs
to, or whether it belongs to any. "Bulwark never touches a timesheet, never computes
a rate, and structurally cannot: it has no attribution model."

**Repo dependency, raised by both A and G against Seat F**: Brunt, Bind and Bequest
require a connected code repository, and most 2-50 BigBlueBam customers do not write
software. Seat G noted the suite's own canonical demo customer is a travel company,
and added that the fraction of the base that is a dev shop already has GitHub,
Linear, and Sentry. Both seats named Burn as the exception that escapes the critique.

### Seat strategies, in their own words

**Seat A:** "I am playing two horses and one option. Behalf and Bracket are the
horses because they are the only proposals on a 35-app board that address the actual
binding constraint on this suite, which is not that it lacks capabilities but that
customers will not switch the existing ones on."

**Seat B:** "I am concentrating, not defending a portfolio. I gave up my fifth-ranked
app outright and conceded the framing on my fourth, because both were in collisions I
would lose on merit and because a seat that fights for everything is discounted when
it fights for anything."

**Seat C:** "I was the most collided seat by name and the least collided by mechanism,
so I spent this round separating those two facts... conceding to E where E is genuinely
better buys credibility I intend to spend on the three-way decision-ledger fight."

**Seat D:** "Six seats proposed apps whose customer is an existing BigBlueBam customer,
which means every one of them competes for the same wallet and adds zero new logos...
The suite does not have a distribution problem it can mine its way out of."

**Seat E:** "I killed two of my own five before anyone had to argue with me, because in
a seven-seat field the cheapest thing I can buy is credibility for the two I am actually
defending... My lead is Backstop, and its strongest argument is not mine at all, it is
the shape of this board: five of seven seats proposed granting more autonomous write
authority to a platform with no restore path."

**Seat F:** "I came in with five and I am leaving with four real ones, because two of my
five were losing on purpose. Bequest was third in a three-way where the other two had
better mechanics and better evidence, so conceding it early buys me more credibility
than defending it would have won me votes."

**Seat G:** "Badge is the only concept on the board no seat contested, and the slate's
own center of gravity argues for it: five seats independently concluded the suite's next
problem is making agent autonomy trustworthy, and every one of them guards inputs,
behavior, permissions, or reversal. None guards the sentence that reaches the customer,
which is the only failure that is public, legally exposed, and unreversible."

## Phase 3 - Submissions

Each seat submitted one app. Two seats changed course from what they had signalled
during debate: Seat A **reclaimed process induction** (which it and Seat E had
conceded to each other) and withdrew all four of its other proposals in its favour,
folding Behalf's earned-autonomy ramp into it as the adoption mechanism. Seat E
**abandoned Backstop**, its declared lead, and submitted Banish instead, stating
plainly that Seat A and Seat F had landed a real hit and that "the honest
consequence of accepting that argument is that the gate belongs before the
destructive act, not after." Seat E also declined to reclaim process induction:
"I conceded it on the merits and nothing has changed except who is standing there."

### SUBMISSION - Seat A: Blaze

*Discovers how your company actually gets work done by mining what your people
really did across all 22 apps, writes it down in plain language, tells you when
someone goes off the path, and earns the right to automate the parts that never vary.*

**Core mechanism: process induction over an event log that has no case identifier**,
and that qualifier is the engineering problem. Celonis and Signavio assume an event
log where every row carries a case id, which is why deploying them is a data-engineering
project. This platform's log has none. Stage one infers episode membership: Blaze walks
`entity_links` where explicit edges exist, and where they do not (most interesting
cases, since a Banter thread and a Helpdesk ticket about the same situation are rarely
linked) infers membership from temporal proximity, actor overlap, Braid-resolved
counterparty identity, and semantic similarity of surrounding prose via Qdrant. Stage
two is variant alignment and naming: aligning noisy episodes into a canonical procedure
with its true statistical shape (per-step median and tail latency, branch frequency,
who performs each step, where episodes stall), then having an LLM name it in the
company's own vocabulary. Stage three is the two surfaces the customer buys: a **living
operations manual** (each confirmed procedure becomes a Beacon article that regenerates
as behaviour drifts) and a **conformance monitor** with thresholds derived from observed
variance rather than guessed. Stage four is the adoption ramp folded in from Behalf:
observed, then shadow (predict the step before it happens, record whether right, costing
and risking nothing), then adopted (draft a Bolt automation via `template-resolver` into
`agent_proposals` with evidence, shadow accuracy, and estimated hours saved per month).
Judgment steps never leave shadow mode by design.

**Wedge:** the ops lead of a 6-to-40-person company certain things are falling through
cracks and unable to prove where. Axis is **zero instrumentation**: every process-mining
vendor's dominant cost is constructing the event log, and this suite emits one by
construction. Second-order fit: Bolt is the suite's most underused app relative to its
power and the reason is authorship cost, not capability.

**Defence against its objections, offered pre-emptively.** *A feature of Bolt:* Bolt is
a runtime executing an authored rule; Blaze is retrospective inductive analysis with no
rule in hand, and two of its three deliverables produce no automation at all. *A GROUP BY
on activity_log:* there is no case identifier, so the sequences do not exist until
something infers them; strip the LLM and embedding retrieval and you cannot segment
episodes at all. *Insufficient SMB volume* (the objection that killed Behalf): the unit
is an org-wide procedure, not one person's decision class - seventeen Won-to-invoice
episodes in a quarter is ordinary for a six-person company and ample for latency
distributions; the manual and conformance monitor are valuable at n=8, and only the
automation ramp needs a larger sample. Backfits against history, so it has findings on
install day.

**Reuse:** `v_activity_unified`, partitioned `activity_log`, `entity_links`,
`bolt_recent_events`/`bolt_event_trace`/`bolt_executions`, `braid_resolve`, Qdrant,
internal llm-provider, Bolt automation schema + `template-resolver`, `agent_proposals`,
Beacon + `beacon_upsert_by_slug`, `can_access`, worker. No new infrastructure dependency.
Flagship tool `blaze_discover(scope, window)`; secondary `blaze_deviation_check(entity_ref)`,
`blaze_procedure_for(entity_ref)`.

### SUBMISSION - Seat B: Bandit

*Every deliberate change your team makes gets registered as an experiment, and Bandit
picks the causal design the data can actually support, watches the outcome, and tells you
whether the change worked, did nothing, or cannot be judged and why.*

**Core mechanism: a design selector with an admissibility refusal.** Given an intervention
and an outcome expressed as a certified `basis_metrics` slug, Bandit reasons about what
the data structurally permits: randomized split where the surface supports assignment,
difference-in-differences where a genuinely untreated comparison group exists, synthetic
control where it does not but a weighted composite tracks the treated unit pre-period,
interrupted time series as fallback, and **"not identifiable"** when nothing holds, with a
plain statement of what is confounded and what would have to be true to fix it. "That
refusal is the product's spine. A tool that will not tell you when it cannot tell you is
not measuring anything." Second mechanism: **continuous assumption auditing** (parallel
trends, synthetic-control pre-fit error, sample-ratio mismatch, cross-arm contamination,
novelty decay, multiple-comparison inflation), where a broken assumption automatically
demotes a readout from "caused" to "associated" with the named violation. The LLM selects
designs and narrates; the estimate is deterministic statistics, so readouts are
reproducible and auditable. Third: a **self-calibration scoreboard** - every effect
Bandit called "caused" is silently re-measured later and the front page publishes the hit
rate.

**Cold start, addressed directly:** Bandit does not wait for interventions to accumulate
because they already happened and the platform recorded them. On install it runs a
**retrospective backfill sweep** over `activity_log`, Bolt event and execution history,
Blast send history, Bill rate and recurring-invoice changes, Bond pipeline configuration
changes, Helpdesk SLA settings and Bam workflow changes, looking for timestamped step
changes in configuration, and scores each retrospectively against every certified metric
it plausibly touched using interrupted time series and synthetic control, which need only
history. Day one the customer sees a ranked board of the changes they made last year and
what each one did.

**Wedge:** the owner who changes something operationally significant most weeks and has
never once known whether it mattered. Optimizely/Statsig/Eppo are enterprise-priced,
web-surface-only, and require you to instrument arms. Axis is **coverage plus zero
instrumentation** - it measures pricing, SLA policy, staffing, automation rules and
outreach cadence, which no experimentation vendor touches because those changes do not
happen on a web page. Second axis is **honesty as a feature**.

**Reuse:** Basis certified metrics via the bench-api internal query route (the pattern
`apps/basis-api/src/lib/bench-client.ts` established), Bolt event catalog,
`v_activity_unified`, worker, `agent_proposals`, `internal-llm.routes.ts`, `can_access`,
Bench widgets for rendering. "New surface area is four tables, one API, one SPA, and a
worker job - Bandit is deliberately parasitic on infrastructure that already exists."
Flagship `bandit_measure(intervention, metric_slug)`; secondary `bandit_effect_of(entity_ref)`.

### SUBMISSION - Seat C: Buttress

*Every decision your team makes in chat, calls, and docs becomes a citable record bound
to the artifact that proves or disproves it, and the app interrupts you in the channel
when you start re-arguing one you already settled.*

**The gap, verified:** searching `decision` across every `apps/*/src/db/schema/` returns
exactly three hits, all machine-adjudication records. Twenty-two apps generate artifacts
and none captures intent.

**Four mechanisms.** *Extraction:* a worker emits candidate decisions as
`{statement, rationale, alternatives_rejected, deciders, scope, reversibility, decided_at,
implied_prediction, review_date, source_citations[]}`, every field anchored to a message id
or transcript span, landing in `agent_proposals` for a named decider. *Contradiction in
flight* - the mechanism that makes it a product rather than a database: every new message
in a watched channel is embedded and matched against the confirmed ledger in Qdrant, and
on collision Buttress posts one quiet in-thread card with the date, deciders, verbatim
rationale, and alternatives already rejected, offering supersede or continue. Supersede
links via `supersedes_id`, making the ledger a versioned graph. "Retrieval-on-entity-open
fires too late: by the time you open the epic, the channel has already burned an hour."
*Grading* (donated by Seat B): where a decision carried an implied prediction, the review
date resolves it against a certified `basis_metrics` slug or entity state and scores it,
accruing per-person and per-team calibration. *Enactment binding* (donated by Seat F):
each decision binds to the artifact that enacts it, upgrading to `implemented` when the
enacting evidence is found (the commit via `github_integrations` for engineering
decisions; the Bolt event, Bill rate change, Blank form field or Beacon article for
everything else) and demoting to `contradicted` when later evidence silently reverses it -
"the specific failure a wiki can never catch: the policy is still on the page and the
system stopped doing it four months ago."

**Cold start, addressed:** the extraction worker's first pass runs over trailing history,
not the live stream. A customer with six months of Banter gets a populated candidate queue
on the first afternoon; confirming twenty takes twenty minutes. Contradiction detection is
live from the first confirmed decision.

**Wedge:** axis is **cost of re-litigation**. Existing options (an ADR folder only
engineers write, a Notion page nobody updates) fail because capture is unpaid work with no
deadline. Buttress's capture cost is one click on a proposal a machine already drafted. No
product does contradiction detection against a confirmed decision graph, because it
requires simultaneous access to where decisions are argued, measured, and enacted.

**Reuse:** Banter messages/threads/`banter_call_transcripts`/in-thread cards, Brief, Board,
Qdrant, `agent_proposals` + `proposal_decide`, `can_access`, Basis as grading oracle, the
`github_integrations` webhook seam, `entity_links`, Bolt events out, internal llm-provider,
worker. Flagship `buttress_why(topic | entity_ref)`; secondary `buttress_check_conflict(draft_text)`,
callable by any of the 847 tools before acting.

### SUBMISSION - Seat D: Bid

*A protest-proof solicitation engine: it shreds an RFP into a machine-checkable compliance
matrix, evaluates every response against the published criteria with page-level evidence
citations, and records a scoring trail that survives a bid protest.*

Seat D considered switching to Blot, "the stronger pure mechanism," but judged Seat G's
jurisdictional-corpus objection decisive and submitted the one app on its slate that
requires **zero jurisdictional corpus**.

**Core mechanism: the requirement shred.** An LLM pass over the solicitation produces a
typed relational matrix of every obligation the document imposes - mandatory submittals,
certifications, format and page constraints, deadlines, and each scored criterion with its
point weight - every row carrying a verbatim pointer back to the clause that created it.
Not summarization: rows in `bid_requirements` with types and weights, independently
checkable, addressable by an MCP tool, and diffable when an addendum lands. Addenda are
first-class; issuing one re-runs the shred and shows exactly which requirements changed.
Second mechanism: **evidence binding, not scoring**. Each response runs against the matrix
to produce a per-requirement responsiveness verdict citing the exact page and passage that
satisfies it, or a flagged gap. "Bid deliberately does not hand the evaluator a score...
an AI that scores bids is a legal liability, an AI that finds and cites the passage a human
must read is pure labor removal." Third: the **evaluation record** as byproduct, mapping
each awarded point to a cited passage and a named evaluator - the packet a protest response
is built from. Run in reverse it is the vendor product: shred the solicitation against your
own draft and get the mandatory items you have not satisfied before you submit.

**Answer to the jurisdictional-corpus objection:** "The objection is correct about four of
my five proposals and does not apply to this one." v1 requires no jurisdictional content at
all, because the solicitation is a self-contained authority stating its own submittals,
page limits, criteria, weights and deadlines. Two optional layers are both customer-supplied
and strictly additive: an evaluation policy (3-8 settings from the customer's own purchasing
manual) and an optional boilerplate library of the customer's own past proposal content.
"There is no path where a stale BigBlueBam-maintained corpus makes the app wrong, because
there is no BigBlueBam-maintained corpus." Same property removes cold start: useful on
minute one against a live RFP, with no history in the suite.

**Wedge:** two buyers, one codebase. Buy side - agency purchasing officers and any org
running a competitive selection. Sell side, the larger volume market - professional-services
firms of 2-50 that live on RFP responses. Bonfire/Euna/Periscope collect documents on a
deadline and do not read them. AI RFP-response tools address the vendor side only, have no
evaluation half, and sit outside the CRM.

**Reuse:** Bin + `@bigbluebam/storage`, Blank for intake, Bay's 48-hex token-gated public
route so vendors submit without accounts, Bond, `braid_resolve` (detecting that three
"competing" bidders share a principal), internal llm-provider and Bulwark's
`extraction.service.ts` pattern, Qdrant, `agent_proposals`, Bolt, worker, `can_access` for
evaluator isolation (which matters legally - evaluators frequently must not see each
other's scores before consensus). Flagship `bid_shred(solicitation_id)` and
`bid_evaluate_response(response_id)`. Explicitly out of v1: e-signature, sealed-bid
cryptographic timing, advertisement syndication, and any state-specific procurement-code
checking - "the only place a jurisdictional corpus could creep in, and it is banned from v1
by design."

### SUBMISSION - Seat E: Banish

*Someone asks you to delete their data; Banish finds every trace of that person across all
22 apps, works out what you are legally required to keep, erases the rest, and hands you
proof.*

**First mechanism: trace discovery beyond the foreign key.** Structured rows are the easy
half and Braid already solved them - `braid_resolve` returns a stable golden id for one
real-world person across Bond, Bill and Book, "which is precisely the find-every-row-for-this-human
primitive, built once and currently pointed in only one direction." The hard remainder is
unstructured and is where data actually hides: a name in a Banter thread, a phone number in
a task comment, an address in a Brief doc, a face and signature in a Bin asset, their words
quoted inside somebody else's Helpdesk reply. Retrieved semantically via Qdrant and
`search_everything`, each proposed as a redaction target with surrounding context and a
confidence score so humans triage the ambiguous ones rather than all of them.

**Second mechanism, the product: retention adjudication.** Almost nothing can simply be
deleted. A Bill invoice carries a statutory retention period and erasing it is itself a
violation. A Bulwark-tracked obligation may require the counterparty record to survive. An
active dispute is a legal hold. An aggregate a certified Basis metric depends on must not
silently change under a dashboard already shown to a board. Banish classifies every trace
into erase, redact-in-place, retain-with-cited-basis, or escalate, stating the reason for
every retain. "`ON DELETE CASCADE` is the wrong answer to this problem executed instantly
and irreversibly, which is exactly the failure mode the suite cannot tolerate."

**Third surface, standing value between requests:** the same engine runs on a schedule
across the whole org answering "what are you still holding that you no longer have a basis
to hold?" - form submissions from a campaign that ended two years ago, guest comments on a
closed project, call transcripts nobody has opened. Each becomes a minimization proposal.
That is the artifact that answers the security questionnaire and shrinks breach blast radius.

Every destructive action is a proposal, every run does a dry pass first, and the output is
an **erasure certificate**: a dated per-system record of what was erased, what was retained
and under which basis, with named human sign-off, generated from accepted decisions.

**Wedge:** two dated buying triggers - a deletion request from a named human (reaching
almost any team selling to EU, UK or California customers), and the enterprise customer or
insurer who will not sign until you can demonstrate a deletion path. OneTrust and Transcend
are five and six figures and are fundamentally connector frameworks: you build an
integration per system, and once built it finds rows and cannot reason about your invoices.
Axis is **completeness and proof at a price a 20-person company pays**. Distinct from Blot,
which decides what must be released under compulsion; Banish decides what must be destroyed
under obligation.

**Reuse:** `braid_resolve` as identity spine ("the single heaviest reuse of a just-shipped
app on this board"), Qdrant + `search_everything`, `can_access` and `@bigbluebam/permissions`
(a reviewer must not gain read access to a ticket by adjudicating it), `agent_proposals`
with no unattended path, Bin + `@bigbluebam/storage` including transcode-worker derivatives,
Bill and Bulwark as retention-obligation inputs read via shared DB and never edited, Basis
for the dependency check preventing a deletion silently altering a certified metric, Bolt
for the statutory clock, worker. Existing per-app retention jobs remain in place; Banish is
the subject-oriented basis-aware layer above them. Flagship `banish_discover(subject_ref)`;
secondary `banish_hold(entity_ref, reason)` and `banish_basis_for(entity_ref)`.

**Build argument, its fourth point:** "Two seats argued convincingly that the failures worth
spending engineering on are the irreversible ones, so the guard belongs in front of the act.
Erasure is the most irreversible act in the entire suite: there is no undo, ever, by
definition... Banish is a forward gate on the one operation where a forward gate is the only
possible gate."

### SUBMISSION - Seat F: Burn

*Burn watches the work your team is actually doing against the contract that paid for it,
blocks the charge that was never in scope before it happens, and tells you this week which
client you are losing money on and exactly what caused it.*

Seat F confirmed Burn over Brunt, conceding that "two rival seats landed the same correct
objection: it presumes the customer writes software, and the segment that does already owns
GitHub, Linear and Sentry."

Burn reads the signed SOW or engagement letter (a Bin asset, extracted through the same
internal llm-provider path Bulwark uses) into a **deliverable ledger**: a typed list of what
was actually sold, each with a clause citation and a priced envelope derived from contract
value and Bill's `bill_rates`.

**Core mechanism: continuous attribution**, distinct from extraction. Every unit of work the
org logs - Bam tasks, time entries, Helpdesk tickets, Banter threads, commit and PR titles
where a repo happens to be connected, Bill expenses, subcontractor invoices - is classified
against that ledger by an LLM classifier over embedding retrieval, producing a
`work item → deliverable` link with confidence, dollar cost, and Braid-resolved account.
There is an explicit **`unscoped` bucket and the bucket is the product**: every item in it is
work someone is doing that nobody sold. Low-confidence attributions are queued, not guessed.

**Two tiers, and the first is a gate rather than a report** (folding in Seat D's concrete
scope request). *Pre-transaction:* `burn_precheck(work_ref)` registers on the moments money
commits - an expense logged in Bill, a subcontractor PO, a recurring charge, a task moved
into an in-progress phase, an assignee change onto a job at rate - returning an allowability
verdict with target deliverable, envelope remaining, and clause cite. For money-out events
the org can configure a **hard block** so the charge does not post until a human maps it to
a deliverable, approves it as absorbed cost with a recorded reason, or converts it to a
change order. "That reason-of-record is the artifact firms never have when a client disputes
the bill." *Post-transaction:* the standing variance report catches what arrives without
passing a gate. The inverse check runs too: contracted deliverables with zero attributed
activity as their deadline approaches.

Every write is a proposal; each human accept, reject or reclassify tunes the attribution
model for that org's vocabulary, "which matters enormously, because 'the reporting thing'
means something specific at every firm and nothing generic."

**Wedge:** services firms of 2-50, a horizontal buyer rather than a vertical bet. Time
trackers know hours but not scope, project tools know tasks but not price, accounting knows
invoices but not the work, "and none of them has ever read the contract." Kantata,
Projectworks and Scoro start above this market and still only report variance after the
fact. Axis is **latency plus interception** - "the entire difference between a change order
and a write-off. Nothing at this price point blocks a charge against a contract term."

**Not Bulwark for SOWs:** "Bulwark extracts a finite set of obligations and fires against
their deadlines; its unit of work is a clause with a date and its output is a notice. Burn's
unit of work is every task, ticket, hour and expense the company logs... Bulwark never
touches a timesheet, never applies a rate, never computes a dollar of margin, and
structurally cannot: it has no attribution model."

**Reuse:** Bin + Bulwark extraction pattern + internal llm route; Bill as money plane and
pre-transaction hook point; Bam tasks/phases/time entries; Bond; `braid_resolve`; Qdrant;
`agent_proposals`; Bolt in and out; worker; `can_access` so a project lead sees their own
job's variance and not the firm's whole P&L. Flagship `burn_precheck(work_ref)`; secondary
`burn_attribute(work_ref)`, `burn_margin(account)`.

### SUBMISSION - Seat G: Badge

*Nothing leaves this company addressed to a customer until Badge has checked that we are
allowed to say it, and that it sounds like us.*

The evidence is in our own repo: the house style for the marketing site lives in
`docs/marketing-voice.md` as hand-written prose no code path reads. Twenty-two apps can
generate customer-facing text and zero of them can be told what the company is permitted to
claim.

Badge turns brand and claim authority into a typed, versioned, callable object: voice rules
with positive and negative exemplars; a **claim library** where every assertable claim
carries an evidence binding to a certified `basis_metrics` slug, a Bay-approved asset or
review decision, an executed-contract clause in Bulwark's obligation ledger, a Bin-stored
source document, or a named human attestation with owner and expiry; a terminology map;
visual rules bound to Bin assets; per-audience registers.

**Core mechanism: a compliance pass, not a chatbot.** `badge_check(text | asset, channel,
audience)` returns flagged spans, the specific rule each violates, a conforming rewrite, and
a hard block on any unsubstantiated claim - the claim library is an allowlist, so "the
fastest CRM on the market" fails unless a claim record with live evidence backs it. Badge
registers as a pre-publish gate on Blast sends, Beacon publishes and Bay approvals via Bolt,
and because `agent_policies` enforcement already runs inside
`apps/mcp-server/src/lib/register-tool.ts` on every service-account invocation, an org can
make a passing `badge_check` a precondition of `blast_send_campaign` for every agent it
runs. "The gate is not advisory."

**Three mechanisms beyond a linter, all on shipped infrastructure.**
*Claim-versus-commitment checking:* cross-references outbound claims against Bulwark's typed
clause-cited obligation ledger, so a campaign cannot promise a four-hour SLA when the signed
contract says twenty-four. "No standalone brand tool can do this at any price, because none
of them has ever read your contracts." *Evidence decay and republication audit:* claims are
live objects - when the Basis metric behind "99.9% uptime" falls below its certified
threshold, when a case study is un-approved in Bay, when an attestation expires, Badge walks
`badge_publications` and re-audits everything already published citing that evidence.
"Your public surface stops being a snapshot and becomes a set of assertions with expiry
dates." *Rule induction:* point Badge at 200 shipped assets and it infers the voice rules
nobody wrote down, each landing in `agent_proposals`. Adoption cost is a directory of past
work, not a week of writing guidelines.

**Dependency discipline** (in response to the orchestrator's warning): v1 depends only on
shipped surfaces - Bulwark obligations, Basis certified metrics, Bay review decisions, Bin
assets, all in the tree today. "Explicitly additive, never load-bearing: if a customer-proof
app or a theme-mining app is built later, they become two more evidence source types."

**Wedge:** a 2-50 team has no brand manager, no comms review, no legal read on marketing
copy, and the moment they turn on AI drafting their output collapses into generic model-voice
within a week. Primary axis **trust at scale**; secondary axis **claim exposure**, which is
money - "an unsubstantiated performance claim in an email to a prospect who later becomes a
customer is a misrepresentation problem, and it is currently generated by software the
customer bought from us." Frontify and Bynder are asset portals with a PDF stapled on and
cannot block a send because they do not own the send. Grammarly Business and Writer enforce
tone and terminology but have no concept of evidence and cannot block anything.

**Reuse:** `llm-provider.service.ts` and the internal LLM route using the same client pattern
as `apps/bulwark-api/src/lib/internal-llm.client.ts`; `agent_policies` + existing
`register-tool.ts` middleware as the gate, with no new enforcement machinery; `agent_proposals`;
Bolt pre-publish hooks and `claim.evidence_stale` / `check.blocked` out; Bulwark, Basis, Bay,
Bin as the four v1 evidence types; Qdrant; permissions catalog separating who authors a rule
from who requests an exception from who grants one; worker for the re-audit sweep. Flagship
`badge_check(content, channel, audience)`; supporting `badge_claim_verify`, `badge_rewrite`,
`badge_induct_rules`, `badge_publication_audit`.

**Build argument:** "Five seats independently concluded that the suite's next problem is
making its own autonomy trustworthy, and the surviving trust apps partition cleanly: Ballast
guards the data going in, Bracket guards a behavior change before promotion, Backstop
reverses damage after the fact, Bastion governs who can reach what. Every one of them is an
internal control. Badge covers the only segment that is external, public, and unreversible...
You can roll back a record. You cannot roll back a claim."

## Phase 4 - Overlap resolution

All seven submissions were compared pairwise. **No perfect overlaps and no merge
negotiations were required**, which is a direct consequence of how much work the debate
round did: eleven proposals were withdrawn or merged by their own authors before submission,
and every cluster the orchestrator flagged in the collision map was either resolved or
explicitly partitioned by the seats themselves.

Pairs examined and judged **distinct**:

- **Bid / Burn** - the closest pair, and the only one that warranted serious consideration.
  Both extract a governing contract document into a typed, machine-checkable matrix via the
  same internal llm-provider seam. They were judged distinct on unit of work and lifecycle
  position: Bid evaluates *external responses from third parties, pre-award*, and its product
  is cited evidence for a human evaluator; Burn attributes *internal work, post-signature*,
  and its product is a blocked charge and a drafted change order. A merged app would be
  incoherent - it would have two different buyers, two different screens, and two different
  moments. Both seats had already anticipated this: Seat D conceded during debate that it
  would not fight to advance both its Bursar and Seat F's Burn, and Seat F folded Seat D's
  pre-transaction-block request into Burn's specification. The shared extraction pass is
  reuse of a proven path, which the rubric rewards.
- **Blaze / Bandit** - both read the cross-app event log, but Blaze induces *what procedure
  is happening* and Bandit estimates *whether a change caused an effect*. Different questions,
  different outputs, non-overlapping tables. Seat A explicitly positioned them as complementary
  during debate ("a Behest replan is a Bandit intervention with a known treatment date").
- **Bandit / Buttress** - Buttress grades a decision's implied prediction against a certified
  metric; Bandit estimates an intervention's causal effect. Adjacent and mutually
  reinforcing, but the units differ (a stated expectation versus a treatment effect) and
  Buttress's grading half was donated by Seat B itself, which would not have donated a
  mechanism it considered its own submission's core.
- **Banish / Badge** - both are gates on an irreversible act, but one guards destruction of
  internal data and the other guards outbound assertion. No shared entity.
- **Banish / Bid** - opposite directions over a partially shared corpus, as Seat E noted:
  Bid concerns documents arriving for evaluation, Banish concerns records leaving. Seat D
  had separately placed records destruction out of its own scope in Phase 1.
- All remaining pairs are distinct without argument.

**Result: seven surviving apps, no collapses, no discards.** The slate proceeds intact to
the vote.

## Phase 5 - Voting

One round. Each seat scored all six rival finalists 1-5 and abstained on its own
submission, so every app was scored by exactly six seats out of a possible 30.
No tie occurred and no second round was needed.

### Vote matrix

| App (seat) | A | B | C | D | E | F | G | **Total** |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **Burn** (F) | 5 | 4 | 4 | 4 | 5 | — | 5 | **27** |
| **Buttress** (C) | 4 | 5 | — | 4 | 3 | 4 | 5 | **25** |
| **Blaze** (A) | — | 4 | 3 | 4 | 5 | 4 | 4 | **24** |
| **Banish** (E) | 3 | 4 | 4 | 5 | — | 4 | 4 | **24** |
| **Badge** (G) | 4 | 3 | 5 | 3 | 4 | 5 | — | **24** |
| **Bandit** (B) | 4 | — | 4 | 3 | 4 | 3 | 4 | **22** |
| **Bid** (D) | 3 | 3 | 3 | — | 3 | 3 | 3 | **18** |

(— = abstention on own submission.)

### Reading the result

**Burn won on consistency rather than on passion.** It is the only finalist that
no seat scored below 4, and it took 5s from three different seats (A, E, G) whose
lenses have almost nothing in common: AI-native automation, operator experience,
and creative/marketing. Every other app in the top five drew at least one 3.

The apps immediately behind it were more polarizing. Badge took two 5s and two 3s.
Buttress took two 5s and a 3. Blaze took a 5 and a 3. Banish took a 5 and a 3. The
seats were not disagreeing about quality; they were disagreeing about which axis the
suite should optimize for, and the three leaders each embodied a different answer:
Burn for dollar-denominated value to the broadest buyer, Banish for a legal trigger
the customer cannot decline, Badge for a mechanism no competitor can replicate.
Burn was the app most seats could accept as second-best on their own axis.

**Three seats named Burn as what they would build if their own were off the board**
(A, E, G), more than any other app. Buttress, Badge, and Banish each drew one such
nod (from B, from C and F, and from D respectively).

**Bid finished last on a remarkably uniform score: 3 from all six seats.** Nobody
disliked it and nobody was excited by it. The recurring reason, given independently
by four seats, was adjacency rather than quality: Bid works on an uploaded document
and does not get materially better as the customer's history accumulates in the
suite, so it is the one finalist that "would work nearly as well as a standalone
product" (Seat A), reuses "platform plumbing but almost none of the platform's
accumulated data" (Seat F), and has "the weakest platform flywheel here" (Seat G).
Seat D's disciplined scoping decision to drop the jurisdictional corpus was widely
praised and did not translate into points.

### The dominant criticism of the winner

Notably, the objection most often raised against Burn was raised by seats that
scored it 4 or 5 anyway, and it was the same objection every time: **classifier
precision on the hard block.** Seat B: "a hard block is only tolerable if the
classifier is right, and a firm that gets two wrong blocks in week one turns the
gate off permanently and never turns it back on." Seat C: "a wrong hard block stops
money, which is the most expensive kind of false positive a small firm can be handed."
Seat D: "a misclassified charge that will not post in a 10-person firm on a Friday
is the thing that gets the feature switched off permanently... the per-org tuning
loop mitigates this over time and does nothing in month one."

Three independent seats converging on one failure mode is the strongest signal this
session produced about how the app must be built. It is carried into the design spec
as a first-class constraint: the gate defaults to advisory, and hard blocking is
earned per-org on measured classifier accuracy rather than switched on at install.

Seat E, which built its own submission on the forward-gate-before-an-irreversible-act
principle, was asked to judge whether Burn and Badge could legitimately claim it. Its
answer on Burn: "Its forward-gate claim is the weakest of the three that make it,
since a posted expense is reversible, but the irreversibility it actually relies on
is relational (work done and unbilled cannot be charged for later without a fight)
and that one holds."

### Result

**Winner: Burn (Seat F)** - 27 of a possible 30. A margin-protection engine that
reads the signed statement of work into a priced deliverable ledger, continuously
attributes every logged task, hour, ticket and expense against it, surfaces
everything that lands in the `unscoped` bucket as work nobody sold, and gates the
charge before it posts.

**Runner-up: Buttress (Seat C)** - 25. The decision ledger that interrupts a
re-argument in the channel while it is happening, having won its three-way collision
outright during debate and absorbed donated mechanisms from two rival seats.

Full spec: `docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md`.
Session log: `docs/brainstorming/2026_07_19_08_01_BRAINSTORMING_SESSION.md` (this file).

## Phase 6 - Spec hardening

Three adversarial rounds against `2026_07_19_08_01_APP_DESIGN_burn.md`, five
reviewers per round (design, security, stability, best-practices, infrastructure)
in rounds 1 and 2, four in the scoped round 3.

| Round | Blockers | Majors | Spec size | Outcome |
| --- | :-: | :-: | :-: | --- |
| 1 | 10 | 26 | 1165 lines | 43 of 44 findings accepted |
| 2 | 14 | 24 | 1634 lines | All accepted; best-practices verified all 8 round 1 items landed |
| 3 | 7 | 15 | 1822 lines | All 22 accepted, none rejected |
| final | - | - | 2014 lines | Build-ready |

Full findings are preserved at `2026_07_19_08_01_SPEC_REVIEW_burn_round{1,2,3}.md`.

**The counts do not fall monotonically and that is not the signal to read.** The
spec grew 1165 to 2014 lines across the rounds, so later reviewers had more
surface and more specificity to attack. What changed is the *character* of the
findings: round 1 found original design defects, round 2 found defects the added
detail exposed, and round 3 found almost exclusively consequences of round 2's
own fixes while verifying the great majority of round 2 as genuinely landed.
Round 3 produced no finding requiring a design change.

### The findings that changed the product

**Round 1 - margin is not margin.** The spec computed margin from `bill_rates`,
which `apps/bill-api/src/services/invoice.service.ts:548-592` resolves into
invoice line items as `unit_price`: it is the rate charged TO THE CLIENT. No
internal cost rate exists anywhere in the platform. So the headline number was
contract consumption at list price, definitionally zero margin on a T&M
engagement. Resolved by owning `burn_cost_rates` as a new primitive AND
guaranteeing no code path prints "margin" over a consumption figure, via a
`metric_basis` discriminator on every financial response.

**Round 2 - every logged hour counted twice.** `apps/api/src/routes/time-entry.routes.ts:38`
increments `tasks.time_logged_minutes` on every time-entry insert, and the spec
priced both `bam.time_entry` and the `bam.task` delta. Every headline number was
inflated roughly 2x on the primary source, and in blocking mode the gate would
have denied real charges at half the true burn. Resolved by making
`bam.time_entry` the sole priced hour source and removing `time_logged_minutes`
from every epoch.

**Round 2 - the blocking gate was decorative.** With `work_ref_id` null in the
pre-transaction case there is no prior attribution, so reaching a confident target
required stage-two LLM adjudication inside an 800ms budget. Every gated expense
would have either timed out and failed open or fallen to `needs_mapping`.
Resolved by making the synchronous precheck path deterministic-only, so it never
calls the LLM and classifier latency cannot touch money.

**Round 3 - invoices double-counted on a second source.** `bill_line_items`
carries `time_entry_ids uuid[]` and `invoice.service.ts:462-493` builds line items
directly from `time_entries`, so an invoice is a restatement of hours already
priced. The same failure class as the round 2 finding, one source over. Resolved
by stating that invoices and recurring invoices are revenue restatements, not
consumption.

**Round 3 - `not_to_exceed` booked revenue the firm cannot invoice.** Grouped with
`fixed`, so a $6,000 NTE that delivered $2,000 reported margin against the full
cap. The round 1 defect inverted, and it overstates, which is the direction the
buyer cannot detect. It fired on a seeded Gilligan chain and no test covered it.

**Round 3 - the change-order loop still did not close.** The amendment deliverable
had no defined activation path: created inactive the envelope never rises after an
approved change order, created active it becomes an attribution candidate and
splits consumption off the base row where variance detection cannot see it.
Resolved by making it a pure envelope-delta carrier with its own activation state.

### A self-inflicted finding worth recording

The orchestrator directed `BBB_PERMISSIONS_ENFORCE=on` unconditionally on burn-api
to close a security blocker (Burn would have been the first app with no legacy
gate behind the non-enforcing permissions plugin). That made the var **required**
in the deploy catalog, and required vars with no `ENV_HINTS` entry cause
`railway-orchestrator.mjs:149-152` to throw. The security fix reproduced the exact
Railway deployment blocker the infrastructure reviewer had raised one round
earlier. Cheap to fix, and a clean demonstration of why multiple adversarial
lenses earn their cost: a fix in one dimension is a defect in another, and no
single reviewer sees both.

### Live bugs found in shipped code

The review's most valuable output was arguably not the spec. Three defects in
already-shipped code surfaced and are tracked:

1. **`canResolve` on `httpPermissionsPlugin` is a hardcoded `return true`**
   (`packages/permissions/src/index.ts:307-319`). Every satellite api uses that
   plugin, so `apps/bulwark-api/src/routes/deadlines.routes.ts:21-23`, which calls
   it to decide whether to include floored fields, **floors nothing**. The file's
   own comment documents the exact leak it was written to prevent. Independent of
   `BBB_PERMISSIONS_ENFORCE`, since `canResolve` ignores `mode` entirely.
2. **`BOLT_API_INTERNAL_URL` is required on bulwark-api with no `ENV_HINTS` entry**,
   so Railway provisioning throws. bulwark-api may never have been created.
3. **Sixteen further catalog env names have no hint**, including
   `BULWARK_API_URL`, `BASIS_API_URL`, `BRAID_API_URL`, and `BLIP_API_URL` on
   mcp-server, meaning those apps' MCP tools fall back to a localhost default in
   production. This is the recorded Banter/Bureau/Blueprint incident, still open.

Plus the RLS GUC discarded on a standalone statement across four apps, Bulwark's
session-scoped advisory lock leaking on a pooled connection, `check:bolt-catalog`
never wired into CI, and nginx alternation drift. Ten platform defects tracked in
total, none dismissed as pre-existing.

### The one partial rejection, sustained across all three rounds

Round 1's S3(a) proposed raising `burn.precheck.override` wholesale above the
member floor, because a member could override denies as `gate_wrong` and
self-service-demote the org's gate. The spec took the finding's second alternative
(split the label into an owner/admin-floored `burn.precheck.mark_wrong`) and
rejected the first, arguing that forcing an admin into every override recreates
precisely the friction that gets the feature switched off permanently, which is
the risk the entire design exists to defeat. Argued in the spec's §5.6.

### Residuals carried into the build

Six, named explicitly in the spec's §16 rather than left implicit: the nine-service
blast radius (with a recommendation to land the shared-package consolidation and
the env-hints coverage test as separate preceding PRs); the LLM concurrency cap
landing on the `api` container that all 22 apps use for permission resolution; the
16 quarantined unhinted env names; the two platform defects Burn routes around
rather than fixes; the `time_entries` edit window (that table has no `updated_at`);
and extraction quality being best-effort on a legally consequential document.

## Result

**Winner: Burn (Seat F)**, 27 of a possible 30.
**Runner-up: Buttress (Seat C)**, 25.

- Session log: `docs/brainstorming/2026_07_19_08_01_BRAINSTORMING_SESSION.md`
- Design spec: `docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md`
- Review rounds: `docs/brainstorming/2026_07_19_08_01_SPEC_REVIEW_burn_round{1,2,3}.md`
