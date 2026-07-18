# Suite Brainstorm Session - 2026_07_18_13_09

**Purpose:** Competitively select the next app BigBlueBam should build (five ideator
seats propose, debate, submit, merge overlaps, and vote to a single winner), then draft
and adversarially harden its design spec. Autonomous cycle run; everything stays on
`suite-brainstorm`.

**Existing suite (do not clone):** Bam (kanban), Banter (chat), Basis (governed metrics),
Bay (media review), Beacon (knowledge base), Bearing (OKRs), Bench (analytics dashboards),
Bill (invoicing), Bin (DAM), Blank (forms), Blast (email campaigns), Blip (telemetry),
Blueprint (diagrams), Board (whiteboard), Bolt (workflow automation), Bond (CRM), Book
(scheduling), Brief (docs), Bureau (virtual office), Helpdesk.

**Seat lenses:**
- Seat A - AI-native automation & autonomous agent workflows
- Seat B - Data, intelligence & analytics
- Seat C - Communication, collaboration & community
- Seat D - Vertical / industry wedge (under-served vertical)
- Seat E - Operator / developer experience & platform tooling

---

## Phase 1 - Initial proposals

Orchestrator note: five seats returned five apps each (25 total). Name collisions to
resolve later: **Beam** (A: agent-run eval vs C: async video), **Bunker** (A: rehearsal
sandbox vs E: secrets broker). A strong "agent operate-and-improve" cluster emerged across
A and E (Bosun/Beam/Bunker/Baton/Bank + Bridle/Brace/Bailiff/Bellwether), a data-trust/
activation cluster in B, an outward-facing comms cluster in C, and a coherent insurance
vertical in D.

### Seat A - AI-native automation & autonomous agent workflows

- **Bosun** (Bosun/Batch/Beckon) - a manager for *standing autonomous objectives*: declare an
  ongoing goal ("keep Bond deduped", "triage every Helpdesk ticket within 5 min") and a fleet of
  agents pursues it continuously within a budget + blast-radius allowlist, escalating when unsure.
  Wedge: "cron for outcomes, not scripts" - goal-directed, self-replanning, vs Bolt's deterministic
  rules. Reuse: agent_policies, agent_proposals, confirm_action, can_access, Bolt triggers, MCP
  /tools/call, Bench readouts, worker cadence.
- **Beam** (Beam/Backstop/Bellwether) - tracing + evaluation for agent runs: every MCP tool-call
  chain becomes an inspectable trace with cost/latency/outcome; build golden datasets + assertions
  to score and regression-test agent behavior across prompt/model/policy changes. Reuse:
  register-tool span capture, activity_log ground truth, bolt_event_trace, Bench, Basis.
- **Bunker** (Bunker/Backlot/Brink) - shadow-execution sandbox: an agent rehearses a multi-step
  cross-app plan against a forked copy of real data, shows the exact diff + blast radius, and only
  replays for real on approval. Reuse: entity_links + per-app read models to fork, can_access,
  confirm_action commit gate, MCP replay, Bolt on real commit only.
- **Baton** (Baton/Broker/Berth) - a single human-in-the-loop inbox for everything agents want
  approved across all apps, with batching, edit-then-approve, and "teach-by-correcting" that turns
  edits into reusable auto-approval policy. Reuse: agent_proposals + proposal_decide, confirm_action,
  can_access, agent_policies as promotion target, unified activity.
- **Bank** (Bank/Berth/Bram) - governed long-term memory for agents: agents write facts/preferences/
  outcomes with provenance, decay, and contradiction detection under RLS, and retrieve later. Reuse:
  Qdrant, RLS + can_access, entity_links, MCP read/write tools, worker decay sweeps.

### Seat B - Data, intelligence & analytics

- **Braid** (Braid/Blend/Beam) - AI customer-data platform that braids Bond/Helpdesk/Blast/Bill/Book
  into one golden profile per person/company via agent-driven identity resolution (fuzzy + embedding
  + graph, evidence-scored, sub-threshold routed to a human). Reuse: entity_links + fuzzy resolvers,
  search_everything, can_access, confirm_action/agent_proposals, Bolt events.
- **Buoy** (Buoy/Bulwark/Bedrock) - AI data-trust monitoring: learns the normal shape of any Bench
  data source / Bolt event stream (freshness, volume, nulls, distribution) with zero config, raises
  incidents, and an agent writes the RCA by walking entity_links + recent events. Reuse: Bench query
  route, Basis certification hooks, Bolt stream, Blip ingest pattern.
- **Bode** (Bode/Barometer/Bellwether) - AI scenario-planning: turns any governed metric/pipeline into
  a probabilistic forecast; NL "what if" questions compile to Monte-Carlo simulations with confidence
  bands + agent-narrated drivers. Reuse: Basis metrics + Bench history, Bearing write-back, Bond
  pipeline, can_access.
- **Bridge** (Bridge/Baton/Bevel) - reverse-ETL activation: describe an audience in plain English,
  compile to a governed query, continuously sync the segment into Blast/Bond/Bolt or external
  destinations with change diffing + membership explanations. Reuse: Bench query route + registry,
  Braid golden profiles, Blast/Bond/Bolt destinations, Bolt events.
- **Bracket** (Bracket/Ballot/Beta) - lightweight feature flags + experiment readouts where an AI
  statistician auto-analyzes results against governed metrics (right test, peeking guards, CIs) and
  writes the ship/kill memo. Reuse: Basis metrics, Bench joins, Bolt exposure events + auto-rollout,
  confirm_action before a flip.

### Seat C - Communication, collaboration & community

- **Bevy** (Bevy/Borough/Buzz) - public customer community + feedback/ideation board where an AI
  triage agent clusters/dedupes/routes every post into the suite as real work, keeps the entity_links
  live, and auto-posts "you asked, we built it" to upvoters when the linked task ships. Reuse:
  can_access public/internal, entity_links, Bolt events, Qdrant dedupe, proposal_create, Bin, Bay-style
  token-gated public pages.
- **Bulletin** (Bulletin/Byline/Broadcast) - AI-authored release-comms: watches completed Bam tasks +
  Bolt automations + Blip deploys and drafts channel-specific changelogs, in-product banners, and Blast
  digests from ground truth. Reuse: Bolt ingest of task.completed/deploy events, entity_links provenance,
  realtime banners, Blast dispatch, token-gated changelog page.
- **Beam** (Beam/Blurb/Byte) - async video/voice messaging (Loom-style) where each recording is
  auto-transcribed/chaptered and mined into action items that file themselves as linked tasks/activities
  with timestamp anchors. Reuse: Bin/storage, worker transcription queue, Qdrant search, entity_links +
  upsert tools, token-gated guest links.
- **Bugle** (Bugle/Bullhorn/Belfry) - live town-hall/AMA/webinar with an AI moderator that clusters +
  ranks audience questions in real time and ships a structured recap with routed follow-ups on end.
  Reuse: LiveKit + livekit-tokens, Book scheduling, realtime WS, Qdrant clustering, Beacon lookup,
  entity_links.
- **Belong** (Belong/Bloc/Badge) - living expertise directory + internal social graph inferred from
  what people actually do across the suite (unified activity, Beacon authorship, Helpdesk resolutions),
  answering "who knows this" with evidence + availability, and powering agent human-routing. Reuse:
  v_activity_unified + expertise_for_topic, Bureau presence + Book availability, can_access, Banter
  intros, find_expert MCP tool.

### Seat D - Vertical wedge: independent insurance agencies (P&C / benefits brokerages, 2-50)

The suite has the horizontal spine (Bond=clients/carriers, Bill=money, Book=meetings, Bin=documents,
Blank=intake, Beacon=KB); missing is the domain engine that reasons over policy documents and runs the
agency's core cycles. Lifecycle: quote (Broker) -> bind (Binder) -> certify (Bulwark) -> get paid
(Bursar) -> claim (Bolster), all grounded on Binder's structured policy extraction.

- **Binder** (Binder/Bind/Bracket) - AI account manager that reads carrier policy PDFs into structured
  coverage (limits/deductibles/endorsements/premium/forms) and runs the 90/60/30-day renewal cycle
  (detect premium spikes, decide re-shop vs roll, draft outreach, version the bound term). Reuse: Bin
  (OCR bytes), Bond (client/carrier via entity_links), Book, Bolt events (policy.expiring,
  premium.spiked), Beacon, Bill, confirm_action on every bind. **The foundational object the rest depend on.**
- **Broker** (Broker/Bazaar/Bid) - marketing a risk to a carrier panel: map risk to appetite, assemble
  submissions, ingest returned quotes, normalize into an apples-to-apples comparison with gap flags,
  recommend a winner -> hand to Binder. Reuse: Blank (ACORD intake), Bin (loss runs), Bond, Banter/Blast
  dispatch, Bench win-rate.
- **Bursar** (Bursar/Balance/Bounty) - reconciles messy carrier commission statements against expected
  commission per bound policy, flags shortfalls/missing/chargebacks, drafts the dispute. Reuse: Bin, Bill
  (AR + producer splits), Bond split rules, Binder expected-commission, Bolt (commission.shortfall), Bench.
- **Bulwark** (Bulwark/Buckle/Brace) - two-sided certificate-of-insurance engine: issue ACORD certs from
  real policies (validated against actual coverage) + auto-track third-party vendor COI compliance with
  auto-chasing. Reuse: Bin, Bond holders/vendors, Blank rulesets, Binder coverage-of-record, Bolt
  (coi.expiring), Book/Blast reminders, confirm_action on issuance.
- **Bolster** (Bolster/Buffer/Backup) - agent-run first-notice-of-loss intake + claims advocacy:
  conversational FNOL, coverage-check against the bound policy, file to carrier, track/nudge adjusters,
  keep the client updated. Reuse: Binder coverage, Bin+Bay loss photos, Bond, Helpdesk lifecycle, Book
  inspections, Bolt (claim.stalled), confirm_action before filing.

### Seat E - Operator / developer experience & platform tooling

- **Bridle** (Bridle/Baton/Brace) - flight-recorder + control tower for the org's OWN agents: stitches
  agent_runners heartbeats, v_activity_unified (actor_type=agent), agent_policies decisions, proposals,
  and MCP invocations into one replayable timeline per run; an AI baselines each agent's normal behavior,
  flags drift, and drafts a tightened allowlist/kill-switch as a proposal. Reuse: agent_policies +
  register-tool middleware, agent_runners, unified activity + audit, agent_proposals, Bolt events,
  webhooks, can_access. **Distinct from Blip (watches the customer's software).**
- **Brace** (Brace/Bulwark/Berm) - blast-radius simulator: builds a live dependency graph from
  entity_links + permissions catalog/resolver + Bolt event subscriptions + MCP bindings, and an AI
  simulates a proposed change (permission revoke, policy edit, webhook swap, migration) to return a
  ranked "what breaks / who's affected / which agents lose access" report + staged rollout + rollback.
  Reuse: permissions catalog + resolver, entity_links, Bolt catalog + subscriptions, agent_policies,
  confirm_action, audit log.
- **Bailiff** (Bailiff/Bursar/Badge) - continuous AI access-review + compliance evidence: reasons over
  grant-vs-actual-usage (permissions catalog vs v_activity_unified), proposes least-privilege revocations,
  runs review campaigns, and auto-drafts SOC2 / vendor-questionnaire answers with cited evidence from the
  audit log. Reuse: permissions catalog + resolver, unified activity + audit, agent_proposals, users.kind,
  Bolt events, RLS.
- **Bunker** (Bunker/Batten/Bastion) - agent-native secrets + connector-credential broker: agents request
  short-lived, purpose-scoped credentials through an agent_policies + confirm_action gate instead of
  holding long-lived keys; an AI hunts stale/over-scoped secrets and drafts rotations; every checkout is
  audited. Reuse: agent_policies + register-tool gate, confirm_action, audit log, permissions, Bolt events,
  webhooks, secret-box crypto pattern.
- **Bellwether** (Baffle/Banner/Bellwether) - feature flags + progressive rollouts with an autonomous
  guardrail: a rollout defines success/guardrail metrics (Blip + Bench), and an AI operator advances the
  rings when metrics hold and auto-reverts on breach, narrating each decision to the audit log; agents
  can gate their own risky behaviors behind flags. Reuse: Blip telemetry + Bench query route, Bolt events,
  agent_policies (agent-readable flags), audit log, confirm_action.

## Phase 2 - Debate

**Orchestrator note.** One full debate round was run. Each seat received the other
four seats' Phase 1 blocks plus orchestrator-flagged tensions. The round resolved
every hard collision cleanly, so a second round was not needed: two `Beam` name
collisions (Seat A renamed its agent-tracing app to **Backstop**, Seat C renamed its
async-video app to **Blurb**); two `Bunker` collisions (Seat A renamed its sandbox to
**Backlot**, Seat E renamed its secrets broker to **Batten**, leaving neither on the
name); the feature-flags overlap (Seat B's **Bracket** vs Seat E's old **Bellwether**)
resolved by E retiring Bellwether and conceding product feature-flags to B; and the
big agent-oversight collision (Seat A's **Backstop** eval vs Seat E's **Bridle**
runtime observability) carved by lifecycle stage - Backstop gates the deploy
(pre-prod regression), Bridle watches the run (prod governance), with E arguing for a
single merged surface. Post-debate marquees are clearly separated: A -> Bosun,
B -> Braid, C -> Bevy, D -> Binder, E -> Bridle.

### Seat A (AI-native automation & autonomous agent workflows) - revised block + debate notes

Two defensive renames (kill collisions with Seat C's Beam and Seat E's Bunker), one repositioning (eval-only, ceding live observability to Bridle), and Bosun hardened as the keystone.

#### App 1: Bosun  *(marquee - no direct rival)*
- **Names:** Bosun / Batch / Beckon
- **One-liner:** A manager for *standing autonomous objectives* - declare an ongoing goal ("keep Bond deduped," "triage every inbound Helpdesk ticket in 5 min," "chase all stale deals") and a fleet of agents pursues it continuously within a budget, rehearsing high-impact steps and escalating when unsure.
- **The wedge:** Bolt is deterministic (event X -> fixed steps Y). Bosun is goal-directed: a mission owns an objective, a success metric, a token/cost budget, a blast-radius allowlist, and a cadence; the agent plans and re-plans its own steps across MCP tools, rehearses anything irreversible before committing, and opens a proposal instead of acting when confidence or impact crosses a threshold. Nothing in the suite owns the *objective* as a first-class, self-correcting, budget-bounded object.
- **Who it's for + the pain:** SMB ops leads (2-50) who can't staff a 24/7 back-office and today choose between brittle Bolt rules that shatter on edge cases or nothing getting done off-hours. They want to hand an agent an outcome and a leash, not author every branch.
- **Scope (v1):** Objects: `mission` (objective, success metric, budget, cadence, allowlisted apps/tools, escalation policy), `mission_run`, `mission_finding`. Actions: create/pause/adjust a mission; set budget + kill switch; live run timeline; approve/deny escalations (routes to Baton); rehearse-before-commit on high-impact steps (via Backlot); replay a run; per-mission spend/impact ledger.
- **Platform reuse:** `agent_policies` (kill switch + glob allowlist) as the enforcement floor; `agent_proposals` for escalations; `confirm_action` for destructive steps; `can_access` on every touched entity; Bolt events as mission triggers; MCP `/tools/call` as the execution plane; Bench query route for the success metric; worker for cadence.
- **Why it wins:** Highest-ambition, most on-lens swing: it turns 804 MCP tools from things an agent *can* call into things an agent *pursues a goal with*, safely. Beats Bolt on the "I don't know all the steps" (adaptivity) axis and beats a raw LLM loop on the *trust* axis (budget, allowlist, rehearsal, escalation, audit). Every other seat's idea - B's segments, D's insurance cycles, C's community triage - becomes more valuable when Bosun can run it as a standing objective.

#### App 2: Backlot  *(was Bunker - renamed to dodge E's secrets "Bunker")*
- **Names:** Backlot / Brink / Bevel
- **One-liner:** A shadow-execution sandbox where an agent rehearses a multi-step, cross-app *action plan* against a forked copy of your real data, shows the exact projected diff and blast radius, and only replays it for real once approved.
- **The wedge:** The scariest moment in autonomy is the first irreversible cross-app write. Backlot forks the relevant slice of state, lets the agent run its whole plan against the fork, and renders a previewable diff ("will move 12 deals, email 3 contacts, delete 1 draft invoice") before a single real mutation; approve -> replay the identical tool sequence for real. This is a *rehearse-then-commit* primitive that exists nowhere.
- **Who it's for + the pain:** SMB admins who want autonomy but are rightly terrified of an agent nuking their CRM or double-billing, stuck choosing "trust it blind" or "approve every step."
- **Scope (v1):** Objects: `rehearsal` (plan + forked snapshot), `projected_change`, `commit`. Actions: submit a plan (from Bosun/Baton or ad hoc) to rehearse; view projected changes grouped by app with blast-radius counts; veto individual changes; commit (replay) or discard; auto-rehearse any action above an impact threshold.
- **Platform reuse:** `entity_links` + per-app read models to build the fork; `can_access` to scope what's forkable; `confirm_action` semantics for the commit gate; MCP `/tools/call` recorded/replayed; Bolt events emitted only on real commit; storage for snapshots.
- **Why it wins:** Converts "high-impact autonomous action" from a leap of faith into a reviewable, revertible preview - the trust axis, the #1 blocker to SMBs letting agents act. Distinct from E's Brace (which simulates the blast radius of a *human config/schema/permission change*): Backlot rehearses an *agent's action plan* against live-shaped data and can commit it. Brace is change-management for humans; Backlot is a safety rail for autonomy.

#### App 3: Baton  *(no direct rival)*
- **Names:** Baton / Broker / Berth
- **One-liner:** A single human-in-the-loop cockpit for everything agents want you to approve across all 20 apps, with batching, edit-then-approve, and teach-by-correcting that turns your edits into reusable auto-approval policy.
- **The wedge:** `agent_proposals` exists as a table + three MCP tools but has *no product surface* - no unified triage, no batching, no learning. Baton groups pending agent actions across apps, lets you approve/reject/edit-then-approve, and turns every correction into a labeled example that proposes a policy ("auto-approve refunds under $50 from repeat customers") you can promote into `agent_policies`. The agent->human handoff becomes a product that gets cheaper over time.
- **Who it's for + the pain:** The manager supervising Bosun missions and per-app agents, drowning in scattered per-app confirmations that teach the system nothing.
- **Scope (v1):** Objects: `review_item`, `decision`, `learned_rule`. Actions: unified cross-app inbox; batch approve/reject; edit-then-approve with diff; SLA + escalation on stale items; promote a correction pattern into a `learned_rule` (feeds Bosun escalation + agent_policies); decision audit trail.
- **Platform reuse:** `agent_proposals` + `proposal_decide` backbone; `confirm_action` tokens; `can_access` so reviewers see only what they may; `agent_policies` as the promotion target; unified activity for audit; `proposal.decided` Bolt events.
- **Why it wins:** The missing UI/learning layer on a capability the platform already half-built - cheap to ship, instantly useful, and the teach-by-correction loop is genuinely AI-native (your labels shrink future toil). Beats "approve everything forever" on the speed/toil axis and is the human counterpart every autonomous feature needs.

#### App 4: Backstop  *(was Beam - renamed off C's "Beam", repositioned to eval-only vs Bridle)*
- **Names:** Backstop / Benchmark / Batten
- **One-liner:** CI for agents - freeze real agent runs into golden datasets, write assertions, and get a pass/fail scorecard on every prompt/model/policy change *before you ship it*.
- **The wedge:** This is pre-production evaluation, not live monitoring. Bridle (Seat E) is the runtime control tower - watch live traces, baseline behavior, flag drift, tighten policies. Backstop is the *gate before* runtime: capture a run, tag it into an `eval_set`, define assertions ("must call `can_access` before posting," "resolution matched ground truth"), and diff scorecards across versions so you know a change made agents *better* before it touches production. No suite app does regression testing of agent behavior; without it, every prompt tweak is a blind deploy.
- **Who it's for + the pain:** The team deploying Bosun missions and per-app agents who today has no way to know whether last week's prompt change made things better or worse until customers feel it.
- **Scope (v1):** Objects: `eval_set`, `assertion`, `run_capture`, `scorecard`. Actions: capture a run into a golden set; author assertions (rule + LLM-judge); run an eval set against a model/prompt/policy version; diff two scorecards; block a deploy on regression; cost/quality trend per agent.
- **Platform reuse:** `register-tool.ts` wrapper for span capture (already intercepts every service-account call); unified activity for outcome ground-truth; Bench for scorecard charts; Basis to certify an agent-quality metric; RLS for per-org isolation. Composes with Bridle: Backstop gates the deploy, Bridle watches the run.
- **Why it wins:** You can't improve what you can't test - the CI/QA axis. Cleanly separable from Bridle by lifecycle stage (pre-prod test vs prod monitor), so it's additive, not a duplicate. If the session insists on one agent-oversight app, I concede *live observability* to Bridle and keep *eval*; they are different user moments.

#### App 5: Bank
- **Names:** Bank / Bram / Behold
- **One-liner:** A governed long-term memory for agents - agents write what they learn (facts, preferences, past outcomes) and retrieve it later, with provenance, decay, and contradiction detection, under RLS.
- **The wedge:** Beacon is human-authored knowledge; Braid (Seat B) resolves *customer identities* into golden profiles from source records. Bank is neither: it's *agent-written, machine-first* memory - episodic ("last time we tried X for customer Y it failed") and semantic ("this client always pays net-60"), each with source, confidence, timestamp, scope, and decay, plus a contradiction queue when two memories disagree. Agents get durable cross-session recall a stateless loop can't match.
- **Who it's for + the pain:** Any team running recurring agent work where every run starts amnesiac, re-derives context, repeats mistakes, and re-asks humans the same things.
- **Scope (v1):** Objects: `memory` (content, kind, provenance, confidence, scope, decay), `retrieval`, `contradiction`. Actions: `memory_write` / `memory_search` MCP tools; scope to org/project/entity; human curate/pin/forget; contradiction queue; provenance trace back to the writing run.
- **Platform reuse:** Qdrant (already in-stack) for vectors; RLS + `can_access` for per-scope isolation; `entity_links` to attach memories to records; MCP catalog for read/write; worker for decay sweeps.
- **Why it wins:** Memory is the difference between an agent that *learns your business* and one that resets nightly - the compounding-moat axis, and orthogonal to Braid (agent memory vs customer identity are different substrates serving different consumers). AI-native by construction (vector recall + contradiction reasoning, not CRUD) and it multiplies Bosun/Baton value by giving them a shared brain.

**Seat A debate notes.** *Seat E - Bridle (the big collision):* Align with a hard boundary. Bridle = *production* observability + anomaly-governance + drift/policy-tightening; Backstop = *pre-production* eval/regression testing. Different lifecycle stage, different user moment - they compose (Backstop gates the deploy, Bridle watches the run). Concedes live observability to E and keeps eval; does **not** cede it entirely because agent regression-testing is a distinct category. *Brace:* Oppose-lite/boundary - Brace simulates a human config-change's blast radius; Backlot rehearses an agent action plan against forked data and can commit it. *Bunker (secrets):* name collision only, resolved by rename to Backlot. *Seat B - Braid vs Bank:* Differentiate, not rival - Braid resolves customer identities for humans; Bank is agent-written working memory. *Seat C - Beam collision:* resolved by renaming to Backstop. *Belong:* differentiate - Belong routes to humans by expertise, Baton routes agent proposals to approvers, Bank stores agent memory. *Seat D (insurance):* Ignore as rivals - orthogonal vertical, but D is a customer of A's layer (needs Bosun's budget+allowlist, Backlot's rehearse-then-commit, Baton's approvals). **Strategy:** Concentrate behind **Bosun** as the keystone - no rival, most on-lens, hardened by folding rehearsal (Backlot) and escalation (Baton) in as first-class safety mechanisms. Bosun is the submission; Baton and Bank are cheap high-leverage standalones that double as reasons Bosun is safe.

### Seat B (Data, intelligence & analytics) - revised block + debate notes

Keeps **Braid** as marquee (the unification substrate) and **Buoy** as backstop; conceded flag ownership to Seat E's Bellwether and re-aimed Bracket as the causal-analysis / decision-memo layer; renamed Bode's alt off "Bellwether"; declared Bridge depends on Braid.

#### App 1: Braid  *(marquee)*
- **Names:** Braid / Bind / Beacon(taken)->Bond(taken)->Braid
- **One-liner:** An identity-resolution and golden-record engine - an AI stitches duplicate/partial contact and company records scattered across Bond, Blast, Helpdesk, Book, and Bill into one canonical profile with full provenance, and keeps it merged as new data arrives.
- **The wedge:** Every app invents its own copy of "a person." Braid resolves them: fuzzy-match + embedding similarity proposes merges, a human (or policy) confirms, and a canonical `party` entity is linked back to every source row via `entity_links` with a survivorship rule set and full lineage. It stays live - new records are matched on arrival, not in a quarterly batch. Standalone MDM/CDP tools (Segment, etc.) sit *outside* the systems of record and can only guess; Braid resolves *inside* the suite that owns the rows.
- **Who it's for + the pain:** SMB ops/rev teams whose "customer" exists five times under five spellings, so every count is wrong, every email double-sends, and no one trusts the CRM.
- **Scope (v1):** Objects: `party` (canonical), `party_source_link`, `merge_proposal`, `survivorship_rule`. Actions: AI-propose merges (fuzzy + embedding), human/policy confirm-merge, unmerge with audit, survivorship field resolution, live match-on-ingest, expose canonical id to every app via entity_links.
- **Platform reuse:** `entity_links` as the backbone; Qdrant for embedding match; `can_access`; Bond/Blast/Helpdesk/Book/Bill as sources; Bolt events (`party.merged`, `party.split`); `agent_proposals` for merge HITL; MCP resolver tools.
- **Why it wins:** The trust foundation every data feature stands on - Bench counts, Blast sends, Bond pipelines are all wrong until identity is resolved. Only possible inside the suite that owns the source rows; a genuinely AI-hard problem (fuzzy + embedding + survivorship reasoning), not CRUD.

#### App 2: Buoy  *(backstop - data-trust monitoring)*
- **Names:** Buoy / Bellwether(conceded)->Buoy / Bulwark(taken)->Buoy
- **One-liner:** An AI data-observability watchdog - it learns the normal shape of every app's key tables and metrics and raises an alert with a plain-language diagnosis when data goes wrong (a pipeline stalls, a field starts arriving null, volume craters).
- **The wedge:** Distinct from Blip (customer *software* telemetry) and Bridle (agent behavior): Buoy watches *your business data's health*. It baselines row-volume, null-rate, distribution, and freshness per table/metric, and when Bond deal-creation drops 80% or Bill invoice totals spike, it diagnoses the likely cause from recent activity + schema changes and routes it. It's the "why is this dashboard suddenly wrong" alarm no SMB has.
- **Who it's for + the pain:** The ops lead who finds out three weeks late that a broken integration stopped creating records, after decisions were made on bad numbers.
- **Scope (v1):** Objects: `monitor` (table/metric + expectation), `baseline`, `incident`, `diagnosis`. Actions: auto-profile a table/metric, learn baseline, detect anomaly (volume/null/freshness/distribution), AI-diagnose from recent activity, route to owner, snooze/resolve.
- **Platform reuse:** Bench query route for profiling; Basis certified metrics as monitored inputs; `v_activity_unified` + schema history for diagnosis; Bolt events (`data.anomaly`); Bench for trend charts; worker for scheduled profiling; RLS.
- **Why it wins:** Data-trust on the *freshness/correctness* axis - complements Braid (identity trust) to make the whole data layer trustworthy. AI-native (baseline learning + causal diagnosis), and only possible where the data and the activity log live together.

#### App 3: Bracket  *(re-aimed - causal analysis / decision memos)*
- **Names:** Bracket / Bearing(taken)->Bracket / Brief(taken)->Bracket
- **One-liner:** An AI analyst that answers "why did this number move and what should we do" - it takes a metric change, runs a structured driver + cohort + correlation analysis across the suite, and writes a cited decision memo.
- **The wedge:** Re-aimed off feature-flags (conceded to Seat E's Bellwether). Where Basis says *what a metric is* and decomposes an exact delta, Bracket does the open-ended *investigation*: pulls related activity, segments by cohort, tests plausible drivers, and produces a narrative recommendation with citations back to the source rows. It's the junior data analyst an SMB can't hire.
- **Who it's for + the pain:** The founder staring at a dropped conversion rate with no analyst to ask "why, and what do we do about it."
- **Scope (v1):** Objects: `investigation`, `hypothesis`, `finding`, `memo`. Actions: start from a metric/Basis delta, auto-generate hypotheses, test each via Bench queries, rank by evidence, write a cited memo, route to a decision owner.
- **Platform reuse:** Basis deltas as the trigger; Bench query route; `v_activity_unified`; `can_access` on cited rows; Brief for the memo doc; Bolt events; MCP analyst tools.
- **Why it wins:** The reasoning layer on top of Basis - turns "the number moved" into "here's why and what to do." AI-native by construction; distinct from Basis (definition + exact decomposition) and Buoy (health alarm).

#### App 4: Bode  *(forecasting)*
- **Names:** Bode / Bearing(taken)->Bode / Beacon(taken)->Bode
- **One-liner:** An AI forecasting and scenario engine - projects any Basis metric forward with confidence bands and lets you ask "what if" against levers grounded in real suite data.
- **The wedge:** Takes certified Basis metrics and Braid-resolved history, fits a forecast, and lets a user model scenarios ("what if we cut churn 2pts") with the projection grounded in actual pipeline/billing/activity data rather than a spreadsheet guess.
- **Who it's for + the pain:** The founder building a board-deck forecast in a fragile spreadsheet with no statistical grounding.
- **Scope (v1):** Objects: `forecast`, `scenario`, `lever`, `projection`. Actions: fit a forecast on a Basis metric, set confidence bands, define levers, run scenarios, compare to actuals over time.
- **Platform reuse:** Basis metrics, Bench query route, Braid history, `v_activity_unified`, Bolt events, worker for scheduled refits.
- **Why it wins:** Forward-looking intelligence grounded in real data - a downstream consumer of Basis/Braid, not a rival.

#### App 5: Bridge  *(activation - depends on Braid)*
- **Names:** Bridge / Bond(taken)->Bridge / Blast(taken)->Bridge
- **One-liner:** A reverse-ETL / audience-activation layer - build a segment once against the golden Braid profile and sync it to Blast, Bond, and external destinations, kept live.
- **The wedge:** Depends on Braid: a segment is defined against the canonical `party`, so "high-value churned customers" means the same set everywhere and stays current. Syncs to Blast campaigns, Bond views, and external tools.
- **Who it's for + the pain:** The marketer hand-exporting CSVs that are stale the moment they're built.
- **Scope (v1):** Objects: `segment`, `sync`, `destination`, `membership`. Actions: define a segment on canonical profiles, preview membership, sync to Blast/Bond/external, keep live, audit membership changes.
- **Platform reuse:** Braid canonical profiles, `entity_links`, Blast/Bond as destinations, Bolt events, worker for live sync, `can_access`.
- **Why it wins:** Turns resolved identity into action - the activation half of Braid. Clean downstream consumer.

**Seat B debate notes.** *Seat A / Bank vs Braid:* differentiate - Bank is agent working-memory; Braid is customer identity. Adjacent, not rival. *Seat E / Bellwether (flags):* conceded product feature-flags entirely; re-aimed Bracket to causal analysis / decision memos so it no longer touches flags. *Seat E / Buoy overlap risk:* held Buoy as *business-data* observability, explicitly distinct from Blip (software telemetry) and Bridle (agent behavior). *Bode renamed* off "Bellwether" alt to avoid the collision. *Bridge* declared a hard dependency on Braid (activation needs the golden record). **Strategy:** Concentrate on **Braid** as marquee - the trust foundation every other data feature (and half the suite's counts) depends on - with **Buoy** as the clean-territory backstop. Bracket/Bode/Bridge round out a coherent data-intelligence stack that all consumes Braid, making the slate read as one deliberate bet on a trustworthy data layer.

### Seat C (Communication, collaboration & community) - revised block + debate notes

Will submit **Bevy**, which subsumes Bulletin's changelog as a feature; renamed Beam -> **Blurb** to resolve the collision with Seat A.

#### App 1: Bevy  *(marquee)*
- **Names:** Bevy / Borough / Buzz
- **One-liner:** A public customer community + feedback/ideation board where an AI triage agent clusters, dedupes, and routes every post into the rest of the suite as real work - and closes the loop with an auto-authored "Shipped" feed.
- **The wedge:** Every post is a first-class entity the AI links via `entity_links` to a Bam task, Bond deal, Beacon article, or Helpdesk ticket, and keeps that link *live*. Incoming posts fan through a triage agent that semantically merges duplicates (Qdrant), tags sentiment/urgency, and drafts replies for human approval via `proposal_create`. When a linked task ships, Bevy auto-generates a "you asked, we built it" changelog entry from the completed Bam/Bolt/Blip activity and notifies every upvoter. Standalone community tools (Canny/Discourse) structurally cannot close the loop into delivery because they don't sit inside the system that builds the fix.
- **Who it's for + the pain:** SMB founder/product teams (2-50) drowning in feature requests scattered across email, Helpdesk, and DMs, with no way to see demand or tie it to what's being built. Today they hand-copy requests and never reply.
- **Scope (v1):** Objects: `spaces`, `posts`, `votes`, `comments`, `statuses`, `shipped_entries`. Actions: submit post (human/agent), AI-cluster-merge duplicates, link post->Bam/Bond/Helpdesk, change status w/ auto-notify upvoters, agent-draft reply into approval queue, auto-generate public roadmap + "Shipped" feed from linked-task states.
- **Platform reuse:** `can_access` gates public vs internal per space; `entity_links` for the loop; Bolt events (`bevy.post.created`, `bevy.status.changed`, consumes `task.completed`); Qdrant dedupe; `proposal_create` HITL; Bin attachments; token-gated public pages (Bay pattern); Blast for digest email; full MCP triage surface.
- **Why it wins:** The suite's missing outward-facing edge and its highest-leverage AI play - the model does the triage/dedup/loop-closing labor SMBs never staff, defensible precisely because feedback lands inside the system that ships the fix.

#### App 2: Bulletin
- **Names:** Bulletin / Byline / Broadcast
- **One-liner:** AI-authored release-comms: watches what the team shipped and drafts changelogs, in-product banners, and customer digests across every channel.
- **The wedge:** The changelog writes itself from ground truth - a generation agent reads completed Bam tasks, Bolt automations, and Blip deploy telemetry, groups them into human-readable narratives, and emits channel-specific variants. Positioned as the *leaner standalone* alternative if Bevy's outward community is judged too big for v1; the two share the "shipped feed" engine.
- **Who it's for + the pain:** SMB teams that ship constantly but announce nothing because writing release notes is a chore that falls off the backlog.
- **Scope (v1):** Objects: `releases`, `entries`, `channels`, `audiences`. Actions: agent-draft release from linked Bam/Bolt/Blip activity, human edit/approve, publish public changelog page, push in-product banner via WS, hand off digest to Blast, per-entry audience targeting.
- **Platform reuse:** Consumes Bam/Bolt/Blip events via Bolt ingest; `entity_links` for provenance; realtime WS banners; Blast dispatch; token-gated public page; MCP tools.
- **Why it wins:** Universal SMB pain on the axis of *effort* - turns a dreaded recurring hour into review-and-approve, only possible where both the "what shipped" signal and the comms channels live together.

#### App 3: Blurb  *(renamed from Beam to resolve collision with Seat A)*
- **Names:** Blurb / Byte / Bump
- **One-liner:** Async video/voice messaging where every recording is auto-transcribed, chaptered, and mined by AI into action items that file themselves into the suite.
- **The wedge:** The recording is an input to work, not a dead link. On upload the agent transcribes, chapters, summarizes, extracts decisions/action-items, and creates linked Bam tasks or Bond activities via `entity_links` back to the exact timestamp. Viewers reply with timestamp-anchored text or their own video. Loom/Vidyard stop at the transcript; they can't turn "at 2:14 I asked you to update the deck" into a tracked task.
- **Who it's for + the pain:** Distributed SMB teams doing async standups, walkthroughs, and client updates who lose every ask buried in a 6-minute video nobody rewatches.
- **Scope (v1):** Objects: `recordings`, `chapters`, `transcripts`, `threads`, `reactions`. Actions: record/upload screen+cam, AI transcribe+chapter+summarize, extract->create linked task/activity, timestamp-anchored comment, token-gated share, semantic search across recordings.
- **Platform reuse:** Bin/MinIO + `@bigbluebam/storage`; worker transcription queue (Banter precedent); Qdrant + `search_everything`; `entity_links` + task/activity upsert MCP tools; token-gated guest links; `can_access` on viewer scope.
- **Why it wins:** Genuinely-new surface on the axis of *integration* - AI converts passive video into tracked work, which a standalone recorder cannot because it has nowhere to file the output.

#### App 4: Bugle
- **Names:** Bugle / Bullhorn / Belfry
- **One-liner:** Live town-hall / AMA / webinar events with an AI moderator that clusters and ranks audience questions in real time and ships a structured recap the instant it ends.
- **The wedge:** The AI runs the room - clusters duplicate questions ("14 people asked this"), ranks by votes+relevance, flags anything already answered in Beacon, and on end emits a recap with decisions and unanswered questions auto-routed to owners. Slido/Zoom Webinar have raw upvoting; none *understand* the questions or route the follow-ups into a work system.
- **Who it's for + the pain:** SMB leaders running all-hands or customer webinars where Q&A is chaos, duplicates dominate, and every promised follow-up evaporates.
- **Scope (v1):** Objects: `events`, `questions`, `clusters`, `votes`, `recaps`. Actions: schedule (via Book), join session, submit/upvote question, AI cluster+rank live queue, mark-answered, auto-generate recap with routed tasks, publish recording.
- **Platform reuse:** LiveKit + `@bigbluebam/livekit-tokens`; Book scheduling; realtime WS queue; Qdrant clustering; Beacon lookup; `entity_links` follow-up routing; token-gated attendee links.
- **Why it wins:** Synchronous complement to Bevy on the axis of *live cognition* - AI doing moderation labor a small team can't spare a person for, with follow-ups plugged straight into delivery.

#### App 5: Belong
- **Names:** Belong / Bloc / Badge
- **One-liner:** A living expertise directory and internal social graph that AI builds automatically from what people actually do across the suite, so anyone (or any agent) can find "who knows this."
- **The wedge:** Inferred, not self-reported. An agent reads `v_activity_unified`, Beacon authorship, Helpdesk resolutions, and Bam/Bond ownership (leveraging the existing `expertise_for_topic` tool) to compute per-person expertise with evidence and availability, and exposes a `find_expert` MCP tool that every other app's routing agent can call. **Distinct from Seat B's Braid:** Braid resolves *customer/contact* records into golden profiles (data layer); Belong maps *internal human* expertise for routing - different subjects, not redundant.
- **Who it's for + the pain:** Growing SMB teams (20-50) where nobody knows who owns what, onboarding is tribal, and requests bounce before reaching the right person.
- **Scope (v1):** Objects: `profiles`, `expertise_signals`, `endorsements`, `intros`. Actions: agent-compute expertise, browse/search people by topic with evidence, request-intro (routes via Banter), human confirm/adjust inferred skills, expose `find_expert` MCP tool, availability from Book/Bureau.
- **Platform reuse:** `v_activity_unified` + `expertise_for_topic`; Bureau presence + Book availability; `can_access` so private signals never leak; Banter intro handoffs; MCP `find_expert` consumed suite-wide.
- **Why it wins:** The connective tissue the agentic suite lacks - a self-maintaining human-routing layer on the axis of *trust/speed*, uniquely possible because only this platform holds the cross-app work signal to infer expertise from.

**Seat C debate notes.** *Seat A / Baton:* align as consumer, not competitor - Bevy's triage replies and Bugle's routed follow-ups emit `proposal_create` items that flow into Baton. *Bulletin <-> Bevy (internal):* light merge - Bevy absorbs Bulletin's "shipped feed" engine as its public roadmap/changelog surface; Bulletin kept as the leaner standalone fallback. *Seat B / Braid vs Belong:* oppose any "redundant people-directory" framing - Braid = customer golden-record resolution, Belong = internal human expertise graph; different subject, different consumer. *Ignore:* all of Seat D's insurance vertical, Seat E's control-plane apps - clean of comms/community territory. **Strategy:** The slate owns uncontested human-and-customer-facing territory in a field crowded with agent-infra (A, E), data (B), and a vertical (D). Submit **Bevy** - strongest innovation story (a closed loop no standalone tool can replicate), clearest SMB pain, and it subsumes Bulletin's cheaper changelog play as one feature, so the submission carries Bulletin's universal appeal *and* Bevy's defensibility. Bulletin stays as the leanest-v1 fallback; Blurb/Bugle/Belong round out a coherent comms/community suite but Bevy is the spear.

### Seat D (vertical / industry wedge - insurance) - revised block + debate notes

Collapsing toward **Binder as the keystone submission**, folding renewal outreach + a basic COI issue into its v1 so it ships as one complete app; the other four stay as the roadmap Binder unlocks.

#### App 1: Binder  *(keystone / submission)*
- **Names:** Binder / Bind / Bracket
- **One-liner:** An AI account manager that reads carrier policy PDFs into structured, queryable coverage and runs the renewal cycle - including client outreach and certificate issuance - end to end.
- **The wedge:** An agent OCRs dec pages into a structured Policy object (limits, deductibles, key endorsements, effective/expiration, premium, forms), then owns the renewal timeline: detects premium spikes or coverage erosion, drafts the client renewal summary, and issues an ACORD 25 certificate from the bound policy on request. Every legacy AMS stores the policy as a dead attachment; the moat is turning it into reasoning-grade data plus running the cycle against it. v1 deliberately scopes extraction to **two common P&C lines (commercial GL + commercial auto)** so it ships in one cycle, not the whole AMS.
- **Who it's for + the pain:** The CSR/account manager at a 2-50 person P&C agency tracking hundreds of renewals in spreadsheets, silently missing remarket windows and carrying E&O risk.
- **Scope (v1):** Objects: Policy, Coverage line, Renewal, Term (versioned), Certificate. Actions: ingest dec page -> structured policy (GL + auto); auto-generate 90/60/30 renewal timeline; fire remarket trigger on premium spike >X% or coverage shrink; draft plain-English client renewal summary; issue + AI-validate a COI against the bound coverage; bind and supersede prior term with history.
- **Platform reuse (maximal):** Bin (doc storage + OCR bytes), Bond (client/carrier via entity_links), Book (renewal review meetings), Bill (premium/fee posting), Bolt events (`policy.expiring`, `premium.spiked`), Beacon (coverage-explainer KB), Blast/Banter (renewal outreach), RLS + can_access, `confirm_action` gating every bind and cert issue.
- **Why it wins:** It creates the one object no incumbent has - structured, agent-queryable coverage - and immediately spends it on the two moments agencies feel most: renewals (retention/E&O) and certs (daily grind, compliance risk). A domain workflow an agent runs end to end, grounded on five existing apps, buyable by a segment whose only "modern" option is a $200/user filing cabinet.

#### App 2: Bursar
- **Names:** Bursar / Balance / Bounty
- **One-liner:** An agent that reconciles messy carrier commission statements against what each policy should have paid and recovers the difference.
- **The wedge:** Parses inconsistent carrier statement PDFs/CSVs, matches each line to a Binder policy, computes expected commission (rate x premium x split), flags shortfalls/chargebacks, and drafts the dispute. Hard-dollar ROI on money the agency didn't know it was owed.
- **Who it's for + the pain:** Agency principal/bookkeeper leaking 2-5% of revenue to unreconciled commissions.
- **Scope (v1):** Objects: Statement, Commission line, Expectation, Discrepancy, Split. Actions: ingest statement; auto-match to policies; compute expected vs paid; queue discrepancies; draft dispute letter; post reconciled revenue/splits to Bill.
- **Platform reuse:** Bin, Bill, Bond, Binder (expected-commission source), Bolt (`commission.shortfall`), Bench, `confirm_action`.
- **Why it wins:** Fuzzy-statement-line -> structured-policy matching is exactly what AI beats humans at, and it self-funds the suite. Only possible on top of Binder's structured data.

#### App 3: Broker
- **Names:** Broker / Bazaar / Bid
- **One-liner:** An agent that markets one risk to a carrier panel and returns an apples-to-apples quote comparison with coverage-gap flags.
- **The wedge:** Maps an intake to each carrier's appetite, assembles submissions, ingests returned quotes, normalizes them into a comparison matrix, flags gaps, recommends a winner, and hands it to Binder.
- **Who it's for + the pain:** The commercial producer re-keying the same ACORD app into 6-10 portals and eyeballing incomparable quote PDFs.
- **Scope (v1):** Objects: Submission, Carrier appetite, Quote, Comparison. Actions: build submission from Blank intake; match to appetite; dispatch packet; ingest + normalize quotes; produce comparison + gap analysis; promote winner to Binder.
- **Platform reuse:** Blank, Bin, Bond, Banter/Blast, Bench, Beacon.
- **Why it wins:** Front-of-funnel that feeds Binder; normalizing heterogeneous quotes into a defensible recommendation is genuinely AI-hard.

#### App 4: Bulwark
- **Names:** Bulwark / Buckle / Brace
- **One-liner:** Two-sided COI engine - issue validated certs from real policies, and auto-track third-party vendor compliance.
- **The wedge:** Basic COI *issuance* lives inside Binder v1; Bulwark is the standalone expansion - the **tracking** side (ingest inbound vendor COIs, check against a requirement ruleset, auto-chase expiring/non-compliant vendors) plus bulk issuance and additional-insured/waiver logic.
- **Who it's for + the pain:** Agencies serving contractors/property managers, and insureds tracking whether subs' coverage is actually valid.
- **Scope (v1):** Objects: Certificate, Holder, Requirement, Vendor COI. Actions: ingest third-party COI; validate against ruleset; auto-remind non-compliant; bulk-issue; audit trail.
- **Platform reuse:** Bin, Bond, Blank, Binder, Bolt (`coi.expiring`), Book/Blast, can_access.
- **Why it wins:** Compliance/E&O trust axis; an agent that cross-checks certs against actual coverage is something no incumbent hits.

#### App 5: Bolster
- **Names:** Bolster / Buffer / Backup
- **One-liner:** Agent-run FNOL intake and claims advocacy grounded in the client's actual policy coverage.
- **The wedge:** Conversational loss intake, coverage-check against the bound Binder policy, files FNOL, tracks/nudges adjusters, keeps the client updated - agency shifts from clerk to advocate.
- **Who it's for + the pain:** The CSR handling claims by phone tag with zero client visibility.
- **Scope (v1):** Objects: Claim, Loss event, Adjuster, Status update. Actions: conversational FNOL; coverage-check; file to carrier; nudge on stall; draft client updates; escalate disputes.
- **Platform reuse:** Binder, Bin + Bay, Bond, Helpdesk, Book, Bolt (`claim.stalled`), can_access, `confirm_action`.
- **Why it wins:** Claims are the retention moment-of-truth and the most painful manual workflow; policy-grounded advocacy has no SMB solution today.

**Seat D debate notes.** *Align (reuse, not merge - stays vertical):* Seat B / Braid (identity resolution) consumed under Binder's entity_links for carrier/named-insured dedup; Seat A / Baton + Seat E / Bridle as the HITL/control surface Binder's `confirm_action`-gated bind/cert/FNOL steps route into; Seat B / Bode forecasting as a downstream consumer of Binder data. *Oppose (to clear vote space):* the twin feature-flags proposals (B's Bracket-flags, E's old Bellwether) as near-duplicates; the Beam name collision (A tracing vs C video) as a signal of thin differentiation. *Reach vs depth:* opposes the strong horizontals (Bosun, Buoy, Bailiff) not on merit but on the argument that five horizontal platform tools with no end-user workflow leave the suite unable to be *sold into a specific buyer* - Binder is the only proposal with a named customer who has budget and no modern option. *Ignore:* Bunker (both), Bank, Beam-video, Bevy, Bugle, Belong, Bridge, Brace-sim. **Strategy:** Submit **Binder** - the keystone that manufactures the structured-policy object all four siblings need, with renewal outreach and basic COI issuance folded into v1 so it ships as a complete, sellable app; shippability protected by scoping extraction to two P&C lines. The pitch to voters: four excellent horizontals make the suite more powerful for people who already own it; Binder makes it *purchasable by a market that currently owns nothing modern* - the only proposal that opens a new buyer, grounded on the exact primitives the platform seats are hardening.

### Seat E (operator / developer experience & platform tooling) - revised block + debate notes

Submits **Bridle**; retired Bellwether (flags conceded to Seat B's Bracket); renamed Bunker -> **Batten** to dodge Seat A's collision; absorbed the autonomous-rollout half of Bellwether into Brace and Beam's eval into Bridle's replay module.

#### App 1: Bridle  *(marquee)*
- **Names:** Bridle / Baton / Brace
- **One-liner:** The agent operations control tower - live flight-recorder, anomaly governance, and kill-switch for the org's own AI agents across all 20 apps, with pre-ship eval as a downstream module.
- **The wedge:** Owns the *runtime* agent-operations plane: it stitches `agent_runners` heartbeats, `v_activity_unified` (actor_type='agent'), `agent_policies` decisions, `agent_proposals`, and per-tool MCP invocations into one replayable timeline. Its AI core baselines each agent's normal tool-mix/cost/target-set, flags drift in production, and drafts a tightened allowlist or kill-switch as a `proposal`. The same trace substrate feeds an *eval module* (replay past runs against a new prompt/model/policy version, assert on outcomes) - so Bridle governs live AND regression-tests, one surface, one trace store. Distinct from Blip (customer software) and Bolt (runs automations); Bridle watches and reins in the automators.
- **Who it's for + the pain:** The org admin who enabled agents and now has no idea what they did, what they cost, or how to stop the next bad one. Today: tailing logs across 20 APIs.
- **Scope (v1):** Objects: agent-run, action-event, anomaly, guardrail-proposal, eval-suite. Actions: `bridle_trace_run`, `bridle_agent_summary`, `bridle_flag_anomaly`, `bridle_propose_policy`, `bridle_kill`, `bridle_replay` (dry-run a past run against current policy/model - the eval hook).
- **Platform reuse:** `agent_policies` + register-tool middleware, `agent_runners`/heartbeat, `v_activity_unified` + audit log, `agent_proposals`, Bolt events (`agent.anomaly`, `policy.tightened`), webhooks, `can_access`, entity_links, MCP register-tool.
- **Why it wins:** The app that makes shipping agents *safe enough to sell*, on the **trust/governability** axis no external tool can match - it's the only thing sitting on our unified audit+policy+MCP substrate. Every other seat's feature grows the agent surface; Bridle is what lets an SMB admin trust it.

#### App 2: Brace
- **Names:** Brace / Berm / Buffer
- **One-liner:** A blast-radius simulator plus autonomous rollout guardrail - it predicts what breaks before you apply a risky change, then stages the change ring-by-ring and auto-rolls-back if the prediction materializes.
- **The wedge:** Builds a live dependency graph from `entity_links`, the permissions catalog + resolver, and the Bolt event/subscription catalog, then an AI simulates a proposed permission/policy/config/migration change and returns "what breaks, who's affected, which agents lose `can_access`." It doesn't stop at prediction: it applies behind a guard, watches Blip/Bolt signals during a staged rollout, and reverts autonomously on breach (absorbing the autonomous-rollout half of old Bellwether, minus product feature-flags, conceded to Seat B's Bracket).
- **Who it's for + the pain:** The admin/operator about to change access or config who currently discovers the blast radius in production at 2am.
- **Scope (v1):** Objects: change-plan, impact-finding, rollout-ring, rollback-step. Actions: `brace_simulate`, `brace_explain_finding`, `brace_stage`, `brace_autopilot` (advance/hold/revert on metrics), `brace_rollback`.
- **Platform reuse:** permissions catalog + resolver, `entity_links`, Bolt event catalog + subscriptions, `agent_policies`, `confirm_action`, Blip telemetry + Bench query route, audit log, RLS.
- **Why it wins:** Wins on **speed + safety of change** - collapses "will this break something?" from a nervous Slack thread into a deterministic-plus-AI simulation with an autonomous rollback net. No SMB solution owns the whole-suite dependency graph the way we can.

#### App 3: Bailiff
- **Names:** Bailiff / Bursar / Badge
- **One-liner:** Continuous AI-driven access review and compliance evidence - reads the audit log, proposes least-privilege revocations, and auto-drafts the SOC2/vendor-questionnaire answers buyers demand.
- **The wedge:** Turns the permissions catalog + `v_activity_unified` audit log into a living compliance surface: an AI correlates who (human/agent/service) *can* do what against what they *actually used*, drafts "revoke this unused admin grant" proposals, and answers auditor questions from the audit log with citations. Intelligence is grant-vs-usage reasoning + evidence generation, not CRUD.
- **Who it's for + the pain:** The founder/admin facing a customer security review or first SOC2 with no GRC staff, today screenshotting settings into a spreadsheet.
- **Scope (v1):** Objects: review-campaign, grant-finding, evidence-pack, control-mapping. Actions: `bailiff_start_review`, `bailiff_recommend_revocations`, `bailiff_decide`, `bailiff_generate_evidence`, `bailiff_answer_questionnaire`.
- **Platform reuse:** permissions catalog + resolver, `v_activity_unified` + audit log, `agent_proposals`, `can_access`, users.kind, Bolt events (`access.revoked`, `review.completed`), RLS, MCP register-tool.
- **Why it wins:** Wins on **cost + trust** - replaces a GRC contractor and unlocks enterprise deals for 2-50-person teams. AI-native because the value is reasoning + evidence generation over substrate only we have end-to-end. Cleanest-territory backup to Bridle.

#### App 4: Batten  *(was Bunker - renamed to dodge Seat A's collision)*
- **Names:** Batten / Bastion / (was Bunker)
- **One-liner:** An agent-native secrets and connector-credential broker - agents check out short-lived, policy-gated, purpose-scoped credentials instead of holding long-lived keys, and an AI hunts stale/over-scoped secrets and drafts rotations.
- **The wedge:** Not Vault-with-a-chatbot: credential issuance is gated by `agent_policies` + `confirm_action`, so an agent gets a TTL'd, scoped secret only if policy allows, every checkout is audited, and an AI reasons over usage to flag over-scoped/never-rotated keys. Today secrets are scattered across per-app env and files like `book-api/src/lib/secret-box.ts`.
- **Who it's for + the pain:** The operator wiring integrations and enabling agents, who pastes long-lived secrets into env files with no rotation, revocation, or attribution.
- **Scope (v1):** Objects: secret, lease, rotation-plan, checkout-event. Actions: `batten_store`, `batten_lease`, `batten_revoke`, `batten_audit_stale`, `batten_propose_rotation`, `batten_rotate`.
- **Platform reuse:** `agent_policies` + register-tool gate, `confirm_action`, audit log, `@bigbluebam/permissions`, Bolt events (`secret.leased`, `secret.rotated`), webhooks, RLS, `secret-box` crypto pattern.
- **Why it wins:** Wins on **trust + integration** - the credential plane needed to safely let agents touch external systems, differentiated from Vault by being agent-broker-native and policy-gated. Reinforces the Bridle governance narrative.

#### App 5: Ballast
- **Names:** Ballast / Billet / Balance
- **One-liner:** Agent-spend and quota governance - attributes LLM/compute/storage cost per agent, app, and run, forecasts burn, and trips a budget kill-switch through agent_policies before an agent blows the month.
- **The wedge:** Replaces old Bellwether (flags conceded to Bracket). Distinct from Bench (dashboards) because it's *enforcement*, not reporting: budgets are policy objects that, on breach, fire the kill switch or throttle a runner. AI forecasts per-agent burn and flags anomalous spend ("this summary agent 40x'd its token use after a prompt change"). Only possible because we meter agent invocations at the MCP register-tool layer.
- **Who it's for + the pain:** The operator/founder who turned on agents and got a surprise token bill, with no per-agent attribution or cap.
- **Scope (v1):** Objects: budget, spend-record, forecast, throttle-rule. Actions: `ballast_set_budget`, `ballast_attribute` (per agent/app/run), `ballast_forecast`, `ballast_alert`, `ballast_throttle` (via agent_policies).
- **Platform reuse:** MCP register-tool metering hook, `agent_policies` kill-switch/throttle, `v_activity_unified`, Bolt events (`budget.breached`), Bench query route for reporting, audit log, RLS.
- **Why it wins:** Wins on **cost control** - the FinOps plane for an agent workforce, an axis no SMB tool covers because they don't meter at the tool-call layer. Pairs tightly with Bridle to form a complete agent control plane (behavior + spend).

**Seat E debate notes.** *Seat A / Beam (agent tracing + eval) - MERGE-ALIGN, but Bridle owns the surface:* two planes of one product sharing a trace store; Bridle governs live (anomaly, kill-switch, policy) and absorbs Beam's golden-dataset/assertion eval as Bridle's `bridle_replay`/eval module, conceding the eval naming; non-negotiables in any merge are runtime anomaly-governance, the kill-switch, and policy-write proposals. *Seat A / Bunker (sandbox rehearsal) - ALIGN (renamed mine to Batten):* their shadow-execution sandbox is a natural feeder for Brace's `brace_simulate`. *Seat A / Baton (HITL approval inbox) - ALIGN:* the human approval surface E's `*_propose_*` actions route into. *Seat B / Bracket (flags) - CONCEDE/IGNORE:* retired Bellwether, ceded product feature-flags, kept only autonomous *change* rollout inside Brace. *Seat A Bosun/Bank, Seat B Buoy/Braid/Bode/Bridge, all of Seat C, Seat D - IGNORE.* Dropped "Bulwark" as a Brace alt (Seat D uses it). **Strategy:** Submit **Bridle** - strongest fit for the lens and the session's biggest unmet need; nothing else makes an agent swarm safe enough to sell, and it uniquely sits on the audit+policy+MCP substrate. Prepared to win or merge the agent-operations space against Seat A's Backstop by arguing one surface not two, absorbing eval as a module while holding kill-switch/anomaly/policy non-negotiable. Bailiff is the clean-territory backup; Brace/Batten/Ballast round out a coherent operator control plane.

## Phase 3 - Submissions

Each seat submitted its single strongest post-debate app.

### SUBMISSION - Seat A: Bosun
- **One-liner:** A manager for standing autonomous objectives - declare an ongoing goal ("keep Bond deduped," "triage every inbound Helpdesk ticket in 5 min," "chase all stale deals") and a fleet of agents pursues it continuously within a budget, rehearsing high-impact steps and escalating when unsure.
- **The wedge / why it wins:** Bolt is deterministic (event X -> fixed steps Y); Bosun is goal-directed - a mission owns an objective, a success metric, a token/cost budget, a blast-radius allowlist, and a cadence, and the agent plans and re-plans its own steps across the 804 MCP tools, rehearses anything irreversible before committing, and opens a proposal instead of acting when confidence or impact crosses a threshold. Nothing in the suite owns the *objective* as a first-class, self-correcting, budget-bounded object, so it beats Bolt on the "I don't know all the steps" (adaptivity) axis and a raw LLM loop on the trust axis (budget, allowlist, rehearsal, escalation, audit). Force multiplier for every other seat's idea: B's segment activations, C's community triage, and D's insurance renewal cycles all become more valuable the moment Bosun can run them as safe, standing missions. Chosen over Baton/Backstop/Backlot/Bank because those are safety *components* of trustworthy autonomy, whereas Bosun is the keystone that creates the demand for them.
- **Scope (v1):** Objects: `mission` (objective, success metric, cost/token budget, cadence, allowlisted apps/tools, escalation policy), `mission_run`, `mission_finding`. Actions: create/pause/adjust a mission; set budget + kill switch; live run timeline; approve/deny escalations; rehearse-before-commit on high-impact steps; replay a run; per-mission spend/impact ledger.
- **Platform reuse:** `agent_policies` (kill switch + glob allowlist); `agent_proposals` + `proposal_decide` for escalations; `confirm_action` tokens for destructive steps; `can_access` on every touched entity; Bolt events as mission triggers and MCP `/tools/call` (`register-tool.ts` wrapper) as the execution plane; Bench internal query route for success-metric readouts; unified activity log for audit; the worker for the cadence scheduler.

### SUBMISSION - Seat B: Braid
- **One-liner:** An AI customer-data platform that braids Bond, Helpdesk, Blast, Bill, and Book records into one golden profile per real-world person or company, with agent-driven identity resolution.
- **The wedge / why it wins:** It is the unification substrate under the whole suite, not analytics on it (Bench) or a metric definition (Basis). The AI-native core is autonomous identity resolution: an agent clusters identities across apps using fuzzy match + embedding similarity + graph signals, attaches a confidence score and evidence trail, and routes sub-threshold merges to a human via `confirm_action`. `entity_links` stores links today but nothing *decides* them, and every other app's numbers get more trustworthy the moment Braid exists. No SMB-priced tool does evidence-scored, human-reviewed identity resolution across a whole app suite - it beats the manual reconciliation spreadsheet on the trust axis and compounds with each new app.
- **Scope (v1):** Objects: `braid_profile` (golden record), `braid_identity` (source-app member), `braid_merge_decision`. Actions: (1) agent auto-cluster identities into profiles with confidence scores; (2) human review queue to confirm/split/reject a merge; (3) survivorship rules pick the winning field value; (4) query a golden profile's full cross-app timeline; (5) emit `profile.merged`/`profile.split` Bolt events; (6) MCP `braid_resolve(entity)` returning the golden id for any app record.
- **Platform reuse:** Existing `entity_links` table + fuzzy resolvers as inputs; `search_everything` for candidate discovery; `can_access` on every cited source record; `confirm_action` + `agent_proposals` for HITL merges; RLS + Bolt events; consumed downstream by Bond, Blast, Bill, and (if built) Bridge.

### SUBMISSION - Seat C: Bevy
- **One-liner:** A public customer community + feedback/ideation board where an AI triage agent clusters, dedupes, and routes every post into the rest of the suite as tracked delivery work, then closes the loop with an auto-authored "Shipped" feed.
- **The wedge / why it wins:** Every post is a first-class entity the AI links via `entity_links` to a Bam task, Bond deal, Beacon article, or Helpdesk ticket, keeping the link live - when the linked task ships, Bevy auto-generates a "you asked, we built it" entry from the completed Bam/Bolt/Blip activity and notifies every upvoter. A triage agent semantically merges duplicates, tags sentiment/urgency, and drafts replies for human approval. This is the suite's only outward-facing, customer-facing surface and its highest-leverage AI play: it does the triage, dedup, and loop-closing labor SMBs never staff, and it's structurally defensible because standalone community tools (Canny/Discourse) sit outside the system that builds the fix and therefore cannot close the loop. Subsumes a standalone changelog product (Bulletin) as one built-in feature.
- **Scope (v1):** Objects: `spaces`, `posts` (idea/question/bug), `votes`, `comments`, `statuses`, `shipped_entries`. Actions: submit post (human or agent), AI-cluster-merge duplicates, link post->Bam/Bond/Helpdesk entity, change status with auto-notify upvoters, agent-draft reply into approval queue, auto-generate public roadmap + "Shipped" feed from linked-task states.
- **Platform reuse:** `can_access` (public vs internal per space); `entity_links` (cross-app loop + provenance); Bolt events (`bevy.post.created`, `bevy.status.changed`, consumes `task.completed`); Qdrant (semantic dedupe clustering); `proposal_create` (HITL reply approval); Bin + `@bigbluebam/storage` (screenshot attachments); token-gated public pages (Bay guest-link pattern); Blast (digest email); full MCP tool surface for agent-run triage.

### SUBMISSION - Seat D: Binder
- **One-liner:** An AI account manager that reads carrier policy PDFs into structured, queryable coverage and runs the renewal cycle - including client outreach and certificate issuance - end to end.
- **The wedge / why it wins:** Every legacy agency management system (Applied Epic, AMS360, EZLynx) stores the policy as a dead PDF attachment; Binder is the only proposal here that turns it into reasoning-grade coverage data and then spends that data on the two moments a small agency feels most - renewals (retention and E&O risk) and certificate issuance (the daily grind). It's a full domain workflow an agent runs end to end, grounded on five existing apps, sold to a 2-50 person buyer whose only "modern" option today is a $200/user filing cabinet. Four excellent horizontal tools make the suite more powerful for people who already own it; Binder makes the suite *purchasable by a market that owns nothing modern* - it opens a new buyer instead of deepening an existing one.
- **Scope (v1):** Objects: Policy, Coverage line, Renewal, Term (versioned), Certificate. Actions: ingest a dec page -> structured Policy for two common P&C lines (commercial GL + commercial auto, deliberately scoped to ship in one cycle); auto-generate the 90/60/30-day renewal timeline; fire a remarket trigger on premium spike >X% or coverage erosion; draft the plain-English client renewal summary; issue and AI-validate an ACORD 25 certificate against the bound coverage; bind and supersede the prior term with full history. Every high-stakes write (bind, cert issue) is `confirm_action`-gated.
- **Platform reuse:** Bin (`@bigbluebam/storage` + OCR bytes for policy docs), Bond (client/carrier records via `entity_links`), Book (renewal review scheduling), Bill (premium/fee posting), Bolt events (`policy.expiring`, `premium.spiked`), Beacon (coverage-explainer KB), Blast/Banter (renewal outreach dispatch), `@bigbluebam/permissions` + RLS + `can_access`, and the platform `confirm_action` flow. Optionally consumes Seat B's Braid resolver for carrier/named-insured dedupe.

### SUBMISSION - Seat E: Bridle
- **One-liner:** The agent operations control tower - live flight-recorder, anomaly governance, and kill-switch for the org's own AI agents across all 20 apps, with replay-based eval as a downstream module.
- **The wedge / why it wins:** Nothing today observes or governs the agents an org has turned loose inside BigBlueBam - Blip watches customer software and Bolt runs automations, but no one watches the automators. Bridle stitches agent heartbeats, the unified agent audit trail, policy decisions, proposals, and per-tool MCP calls into one replayable timeline, then an AI baselines each agent's normal behavior, flags production drift, and drafts a tightened allowlist or kill-switch for a human to approve. The same trace store powers offline eval (replay a past run against a new prompt/model/policy version and assert on outcomes), so it governs live AND regression-tests on one surface. It wins on the trust/governability axis no external tool can touch, because it only exists on our own audit + agent_policies + MCP substrate - it is the app that makes shipping agents safe enough to sell.
- **Scope (v1):** Objects: agent-run, action-event, anomaly, guardrail-proposal, eval-suite. Actions: `bridle_trace_run` (full replay of one run), `bridle_agent_summary` (cost/tool-mix/blast profile), `bridle_flag_anomaly`, `bridle_propose_policy` (write to agent_policies via proposal), `bridle_kill` (fire the kill switch), `bridle_replay` (dry-run a past run against current policy/model - the eval hook).
- **Platform reuse:** `agent_policies` + `apps/mcp-server/src/lib/register-tool.ts` middleware, `agent_runners`/heartbeat, `v_activity_unified` + audit log, `agent_proposals`, Bolt events (`agent.anomaly`, `policy.tightened`), outbound webhooks, `can_access` (`apps/api/src/services/visibility.service.ts`), `entity_links`, MCP register-tool.

## Phase 4 - Overlap resolution

**Orchestrator pairwise analysis.** The five submissions were compared pairwise. All ten
pairs classify as **Distinct** - no perfect overlaps to collapse, no very-similar pairs
warranting a merge negotiation. Reasoning for the non-obvious pairs:

- **Bosun (A) vs Bridle (E)** - the only pair sharing a domain (agent operations) and the
  one flagged as a hard tension pre-debate. They are opposite ends of the autonomy
  lifecycle, not the same app: **Bosun drives** autonomy (declares objectives and makes a
  fleet of agents pursue them), **Bridle governs** it (observes, baselines, flags drift,
  and can kill the agents already running). A team plausibly wants both, and Bridle would
  naturally watch Bosun's own missions. They share substrate (`agent_policies`, the MCP
  `register-tool` wrapper, the unified audit log) but the user-facing job is inverse -
  produce autonomous action vs supervise/audit it. Distinct, complementary, not redundant.
  The debate already carved the closest sub-collision (A's Backstop eval vs Bridle's
  runtime observability) by lifecycle stage; neither seat submitted that eval app, so no
  live overlap remains.
- **Braid (B) vs Binder (D)** - Braid is a horizontal identity-resolution substrate;
  Binder is a vertical insurance workflow that *optionally consumes* Braid's resolver.
  Consumer relationship, not overlap. Distinct.
- **Bevy (C)** is the only outward/customer-facing surface; **Binder (D)** the only vertical
  wedge. Neither collides with anything. Distinct.

**Outcome:** all five apps survive Phase 4 and proceed to the Phase 5 final vote:
**Bosun, Braid, Bevy, Binder, Bridle.**

## Phase 5 - Voting

All five apps survived Phase 4, so a single vote round was held over the full slate.
Each seat scored every app 1-5 and abstained on its own.

### Vote matrix (round 1)

| Voter | Bosun (A) | Braid (B) | Bevy (C) | Binder (D) | Bridle (E) |
|---|---|---|---|---|---|
| Seat A | ABSTAIN | 4 | 3 | 4 | 5 |
| Seat B | 4 | ABSTAIN | 4 | 3 | 5 |
| Seat C | 4 | 5 | ABSTAIN | 3 | 3 |
| Seat D | 4 | 5 | 3 | ABSTAIN | 4 |
| Seat E | 4 | 5 | 3 | 4 | ABSTAIN |
| **Total** | **16** | **19** | **13** | **14** | **17** |

**Result:** Braid wins outright with **19**; Bridle is runner-up with **17**. No tie at the
top, so no runoff round is needed.

### Rationale highlights

- **Braid (19, winner):** the only app three separate seats scored a 5 (C, D, E). The
  recurring argument: identity resolution is a universal SMB pain, it is genuinely AI-hard
  (fuzzy + embedding + survivorship reasoning, not CRUD), it reuses the most existing apps
  as fuel (Bond/Helpdesk/Blast/Bill/Book via `entity_links`), and it is the foundational
  data layer every other app - including the other four finalists - silently needs. Seat D
  explicitly called it the layer "every other app (including mine) silently needs."
- **Bridle (17, runner-up):** scored a 5 by both agent-platform seats (A and E's neighbors)
  as the highest-leverage platform move now that 20 apps are agent-operable; docked by C
  and D for being infra-facing / overlapping the existing `agent_policies` kill-switch
  rather than opening a new buyer.
- **Bosun (16):** consistent 4s - admired as the most AI-native swing, but repeatedly
  docked for scope-realism risk and for magnifying the agent risk that governance (Bridle)
  must then contain.
- **Binder (14):** sharpest concrete pain and clearest "no good SMB tool today," but capped
  by voters as a narrow vertical that reuses the least horizontal platform.
- **Bevy (13):** the closed feedback-to-delivery loop won partial credit, but four seats
  independently flagged that a public feedback board is the slate's most clone-adjacent
  category (Canny/Discourse), so its moat rides entirely on the triage agent.

## Winner + handoff

**Winner: Braid** - an AI customer-data platform whose agent-driven identity-resolution
core braids Bond, Helpdesk, Blast, Bill, and Book records into one confidence-scored
golden profile per real-world person or company, with human-in-the-loop merge review,
survivorship rules, and a `braid_resolve(entity)` MCP tool consumed suite-wide. It is the
unification substrate under the whole suite - distinct from Bench (analytics on the data)
and Basis (metric definitions over the data) - and it makes every downstream count, send,
and pipeline more trustworthy the moment it exists.

**Runner-up: Bridle** (agent operations control tower, 17).

- Session log: `docs/brainstorming/2026_07_18_13_09_BRAINSTORMING_SESSION.md`
- Design spec: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (drafted in Phase 6)

Proceeding to Phase 6 (spec draft -> adversarial hardening), then Phase 7 (autonomous
build) - no pause for human review.

## Phase 6 - Spec hardening

Spec: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (drafted, then hardened over
adversarial rounds). Five adversaries per round: design, security, stability,
best-practices, infrastructure.

### Round 1 - findings and dispositions

Round 1 was heavy: **7 blockers + 21 majors** across the five focuses, all grounded in real
monorepo files. Highlights of what the reviewers caught (full detail folded into the spec's
own "Changelog - Round 1"):

- **Design (1 blocker, 6 major):** two claimed v1 source types (`blast.subscriber`,
  `book.booker`) have NO backing row in the real schema - Blast recipients are computed
  from segments over `bond_contacts`, and Book's person lives in `book_event_attendees`
  (per-booking, email-keyed). Source list re-derived from real tables. Also: golden id must
  be stable across merge/split (lazy singleton profiles, reactivate-on-unmerge); the
  proposals inbox does not execute the merge (dual-inbox reconciliation); reject-suppression
  must key on immutable identity pairs not ephemeral profile ids; per-membership link
  confidence must be stored; the N-way "bridging record" merge was unmodeled.
- **Security (2 blockers, 4 major):** the golden profile's denormalized PII columns are
  org-readable and silently downgrade Bond's per-owner access; `braid_resolve` was a
  deanonymization oracle (no `can_access` on the input record, leaked `identity_count`).
  Read plane reworked to per-viewer attribute assembly + asker-gated resolve. Linkage
  disclosure via Bolt events, search oracle, and the missing `SUPPORTED_ENTITY_TYPES`
  branches (a security decision, not a scoping TODO) all addressed.
- **Stability (2 blockers, 5 major):** concurrent ingest created duplicate golden profiles
  with no serialization (advisory-lock per blocking key); the merge was non-transactional
  and non-resumable (single Drizzle txn + post-commit best-effort side effects);
  compare-and-swap on candidate status kills the retry / human-vs-worker double-merge;
  split must suppress future auto-merge to stop flapping; the nightly rescan needed a
  watermark + batching + progress logging; source-down needs bounded backoff + DLQ.
- **Best-practices (3 major):** the `braid.*` permission rows won't be reproduced by the
  manifest generator unless hand-authored (the exact Basis trap); the surface-map skips used
  non-sanctioned reasons and `/candidates/:id/reject` needed a real tool (MCP-parity gate);
  CLAUDE.md inventory + MCP count updates were missing. Plus a Testing section, the shared
  `@bigbluebam/service-health` plugin, and the em-dash surface-map convention.
- **Infrastructure (2 blockers, 3 major):** `nginx.railway.conf` is auto-generated (the
  hand-edit instruction was wrong - edit `nginx-with-site.conf` and regenerate); the worker
  service was never wired for the engine that runs in it (needs `QDRANT_URL`,
  `BBB_API_INTERNAL_URL`, source internal URLs); the event -> queue enqueue transport was
  unspecified; the Dockerfile "five places" is actually four (no deps-stage source COPY);
  Qdrant posture contradiction (lazy collection creation, never fatal at boot).

Verified-and-held-up (so round 2 does not re-litigate): `publishBoltEvent` positional
signature, the four bare event names passing the Bolt catalog guard, port 4020 free,
migration tip 0229 (so 0230/0231 is correct), confirm-token gating + `braid.*` fail-closed,
the immutable merge-decision audit, and the LLM PII-isolation via opaque identity tokens.

All findings were batched to `brainstorm-spec-writer` to fold in. Round 2 (re-review of the
revised spec) follows; the loop repeats until a round returns no blocker/major findings
(cap 3 rounds).

### Round 2 - findings and dispositions

Round 2 re-reviewed the revised spec. All seven round-1 blockers verified closed, but the
rewrite introduced new coherence gaps: **2 blockers + 14 majors**. The striking pattern is
convergence - three independent reviewers (design, security, best-practices) all flagged the
same `braid.profile.resolve` permission-tier contradiction, and the proposal-bridge and
advisory-lock issues each showed up across multiple focuses. The findings clustered into
four themes plus residue:

- **Theme 1 - the `braid.profile.resolve` permission tier (design + security + best-practices):**
  the spec listed resolve as admin-tier in one section, omitted it from the 8-row catalog in
  another, and designed it for non-admin callers in a third - while the flagship wedge needs
  non-admins to resolve. Resolved by making it a 9th permission row (non-admin-grantable,
  guarded by input-record `preflightAccess` + `identity_count` suppression + rate limit).
- **Theme 2 - the `proposal.decided` bridge (security blocker + design + stability):** the
  subscription that turns a platform proposal-approval into a merge executed outside the
  confirm-token, the `braid.*` kill-switch, and the merge permission tier (a fail-open on the
  kill switch); plus the proposal had no defined approver and the event payload carried no
  candidate id to act on. Resolved by re-checking the kill-switch + merge tier in the
  subscription, inserting proposals with a null approver into the org-admin queue, modeling
  the subject as the candidate, and adding an at-least-once reconciliation sweep.
- **Theme 3 - the lazy-resolve minting path (design + stability):** the round-1 "resolve
  never 404s, lazily seeds a profile" fix minted profiles in braid-api outside the worker's
  advisory lock, reintroducing the duplicate-profile race. Resolved by routing resolve
  through the same advisory lock, identity-first, deferring clustering to the worker.
- **Theme 4 - advisory-lock scope (stability blocker):** the round-1 lock keyed on only the
  strongest blocking key, so two records sharing just a phone took different locks and still
  double-minted - the exact N-way case it was added for. Resolved by locking every present
  blocking key (stackable `pg_advisory_xact_lock`, sorted to avoid deadlock).
- **Residue:** read-plane scalar leaks (`email_suppressed`/`confidence` outside the
  per-viewer re-assembly), the `helpdesk.user` branch risking the permissive triage
  precedent, reconciliation markers the rescan needs (`qdrant_synced_at`, source-side
  watermark), and the infra finding that per-app `BBB_RLS_ENFORCE=1` is not achievable as a
  braid-local knob (RLS enforcement is a cluster-global `api`-owned role flip and the compose
  connection is superuser) - reframed to the reused per-request GUC plugin plus an
  application-level org-scoping test.

Verified-and-held-up in round 2: the transactional merge, the CAS executor, split-suppression
identity keying, the worker-reads-source-via-shared-Postgres model, Railway auto-generation,
the Launchpad icon, the four-site Dockerfile, the `publishBoltEvent` positional signature, the
`matchesAllowlist('braid.*')` fail-closed guarantee, and the refs-only merge/split payloads.

Batched to `brainstorm-spec-writer` as the final (round-3-cap) fold.

### Round 3 - findings and dispositions (the cap round)

Round 3 re-reviewed the twice-hardened spec. Both round-2 blockers verified closed and
**no new blocker** was found; **infrastructure came back fully clean** (blocker + major
free). The remaining findings were **8 majors** - every one a narrow refinement to machinery
already present, not an architectural hole, clustered on three roots:

- **The proposal-inbox contract (design, 3 majors):** round 2 wired only the approve->merge
  leg. Round 3 added the reject / request_revision branch (a proposal-inbox reject must reach
  the identity-atom suppression path), made `braid_propose_merge` create the backing
  `braid_match_candidates` row (so an agent-proposed merge does not silently no-op after a
  human approves), and handled `agent_proposals.expires_at` (NOT NULL + the platform expiry
  sweep) so the two HITL surfaces cannot silently diverge.
- **The outbox / lock machinery (stability, 3 majors):** the reconciliation markers must
  stamp the observed `updated_at` version, not `now()` (else a merge landing during a rescan
  replay is silently marked synced and never emitted); the all-keys advisory lock needed a
  single shared, org-namespaced, identically-sorted helper with a stated lock-class order
  (the cited `org.service.ts` precedent is `FOR UPDATE`, not advisory); and the "real
  next-day fallback" degrades to new-rows-only for any source whose mutation path does not
  bump `updated_at` (none of the source tables carry a moddatetime trigger), so per-source
  bump verification became a precondition.
- **The permission manifest (best-practices, 1 major) + the decisions read surface
  (security, 1 major):** the round-2 `EXPLICIT_TOOL_OVERRIDES` fix collided with the
  hand-authored flags (the generator infers flags from the verb, and merge/split/reject/
  resolve are in neither verb set, while `HAND_AUTHORED` has no flag-updating else-branch),
  so the two truth-flip permissions would land marked non-destructive - resolved by
  following the Basis satellite deferral (no tool overrides; hand-authored rows are the sole
  source). And the merge-decisions read surface (`/decisions` + the `braid_get_profile`
  embed) bypassed the per-viewer machinery that round 2 built for the timeline, re-exposing
  `affected_identity_ids` - gated admin-only / fail-closed-filtered.

Because round 3 is the adversarial-loop cap (3 rounds) and every finding is a concrete,
reviewer-specified refinement with zero blockers, the round-3 findings were folded in as the
closing pass and the spec proceeds to the build. Round 3 verified-and-held-up: the all-keys
lock structure, the CAS/`FOR UPDATE` exactly-once split, the reconcile sweep, the source-diff
rescan, the RLS reframing, the 9-row/13-tool/4-event counts, and the surface-map/Bolt-catalog
conventions.

**Outcome: spec converged after 3 adversarial rounds** (7 blockers + 21 majors round 1,
2 blockers + 14 majors round 2, 0 blockers + 8 majors round 3, each fully folded in).
Proceeding to Phase 7 - the autonomous build via `app-build-from-spec`.

## Winner + handoff

_(pending)_
