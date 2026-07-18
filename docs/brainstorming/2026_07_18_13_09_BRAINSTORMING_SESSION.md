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

_(pending)_

## Phase 3 - Submissions

_(pending)_

## Phase 4 - Overlap resolution

_(pending)_

## Phase 5 - Voting

_(pending)_

## Phase 6 - Spec hardening

_(pending)_

## Winner + handoff

_(pending)_
