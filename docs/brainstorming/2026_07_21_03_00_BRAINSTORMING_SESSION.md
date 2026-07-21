# Suite Brainstorming Session - 2026_07_21_03_00

**Purpose:** select the next app BigBlueBam should build, then produce a build-ready,
adversarially-hardened design spec for it.

**Protocol:** seven ideator seats x five proposals each, one debate round, one submission
each, overlap resolution (near-duplicate screen + merge negotiations), a no-self-vote
scored ballot, then a spec draft hardened by five adversarial reviewers.

**Branch:** `suite-brainstorm`. Nothing here merges to `main` or `stable`.

---

## Coverage census

Authoritative roster read from `LAUNCHPAD_CATALOG` in
`apps/api/src/routes/system-settings.routes.ts` (24 apps) plus the app inventory in
`CLAUDE.md`. No app is in flight: the previous cycle (Bursar) completed and the
concurrency lock is idle, and `pnpm check:app-completeness` reports all 24 Launchpad apps
complete.

### Category map

| Category | Apps | Status |
| --- | --- | --- |
| Contracts / procurement / spend governance | Bill, Bulwark, Burn, Bursar | **DENSE (4)** |
| Analytics / metrics / BI | Bench, Basis | **DENSE (2)** |
| Visual collaboration | Board, Blueprint | **DENSE (2)** |
| Content / knowledge / docs | Beacon, Brief | **DENSE (2)** |
| Project & task management | Bam | Covered |
| Internal chat | Banter | Covered |
| CRM (sales-side) | Bond | Covered |
| Outbound email marketing | Blast | Covered |
| Forms & surveys (instrument-level) | Blank | Covered |
| Scheduling / calendar | Book | Covered |
| Workflow automation | Bolt | Covered |
| Goals & OKRs | Bearing | Covered |
| DAM / object storage / structured data | Bin | Covered |
| Media review & approval | Bay | Covered |
| App telemetry & logs | Blip | Covered |
| Customer support / ticketing | Helpdesk | Covered |
| Virtual office / presence | Bureau | Covered |
| Customer identity resolution (CDP) | Braid | Covered |

### Whitespace list (0 apps today)

Categories a small-to-medium services firm genuinely needs that the suite has little or
nothing for:

- **HR / people-ops** - onboarding & offboarding checklists, PTO and leave, org chart,
  performance reviews, compensation bands.
- **Recruiting / ATS** - req pipeline, candidate tracking, interview scorecards, offers.
- **Learning / enablement** - training paths, certifications, competency tracking.
- **Resource & capacity planning** - who is staffable on what, bench utilization,
  allocation forecasting for a services firm. (Bam tracks tasks; nothing tracks people
  as a constrained supply.)
- **Field service / dispatch / work orders** - crews, routes, on-site jobs.
- **Inventory / physical & IT asset management** - equipment, licenses, checkouts.
- **GRC / security compliance** - SOC 2 and ISO control evidence, policy attestation,
  access reviews, vendor security questionnaires. (Bulwark is *contract* obligations,
  a different object entirely.)
- **Product / roadmap / feature-request management** - customer-facing idea intake,
  prioritization, release notes.
- **Customer success / post-sale health** - adoption signals, renewal risk, QBRs.
  (Bond is pre-sale pipeline.)
- **Incident management / postmortems** - on-call, sev declaration, retro tracking.
  (Blip is telemetry ingestion, not the human incident process.)
- **E-signature**, **payroll**, **expense & travel**, **legal matter management**,
  **partner/channel management**, **localization**, **external community/forum**,
  **risk & insurance**, **ESG reporting**.

### Per-session steer handed to every seat

> Prefer the whitespace categories above. A near-duplicate of an existing app, or a
> third/fifth app in an already-dense category, is disfavored by construction. The
> currently-DENSE categories are: **contracts/procurement/spend (Bill, Bulwark, Burn,
> Bursar), analytics/metrics (Bench, Basis), visual collaboration (Board, Blueprint),
> and content/knowledge/docs (Beacon, Brief)**. Do not pile onto those. At least three
> of your five proposals must land in a whitespace category. Every proposal must name
> the closest existing app and argue why it is a *different category*, not a better
> version of that app.

---

## Phase 1 - Initial proposals

Seven seats, five proposals each, 35 candidates. Orchestrator note: the whitespace steer
worked. Only a handful of proposals touched a dense category, and every seat named its
closest existing app as instructed. Convergence across independent seats was unusually
strong, which is itself signal: five of seven seats independently proposed a
resource/capacity-planning app, five proposed incident management, and four proposed
GRC/access governance.

### Seat A - AI-native automation & autonomous agent workflows

#### Billet
- **Names:** Billet, Brigade, Bandwidth
- **One-line pitch:** An autonomous staffing agent that keeps every consultant matched to the right project by inferring real skills from the work people have actually shipped, not from a self-reported spreadsheet.
- **Description:** Billet builds a continuously-refreshed evidence graph of who is actually good at what by reading completed Bam tasks and their comment trails, Beacon articles authored, Helpdesk resolutions, Bay review notes, and Banter answers, then reasons over demand (open Bam sprints, Bond deals at proposal stage, Book commitments) versus supply (`time_entries`, PTO, Bill/Burn cost rates). The AI spine is a rolling assignment reasoner that runs on a schedule and after every relevant Bolt event, producing ranked roster changes with a per-person "why them" citation trail and a margin/utilization delta. It never reassigns unilaterally: every move lands in `agent_proposals` for a human to accept, and accepted moves write back to Bam assignments and Bearing capacity.
- **Scope (in):** evidence-derived skill graph per person, with source citations; supply/demand ledger (bookable hours, committed hours, bench hours) per week; scenario asks in plain language ("who can start a React Native build in two weeks under $110/hr cost"); ranked staffing proposals with margin and utilization impact; bench-risk radar (who rolls off in N days with nothing next); accept/reject writeback to Bam.
- **Scope (out):** payroll, PTO approval workflow, recruiting/hiring pipeline, timesheet entry UI (Bam already owns `time_entries`), invoicing (Bill), org chart.
- **Why build it:** Axis = decision quality on the single most expensive resource a services firm has. Every 2-50 person agency staffs from a spreadsheet plus one partner's memory; commercial resource-management tools (Float, Runn, Kantata) all require humans to hand-maintain a skills matrix, which decays within a quarter and is therefore never trusted. Billet's skills inventory is derived and re-derived from work artifacts the firm is already producing inside this suite, which is a capability no external tool can have because it does not own the work.
- **Closest existing app:** Bearing (goals/OKRs) tracks whether outcomes are on track; Burn tracks whether a signed engagement is profitable. Neither allocates humans to work, and neither models capacity. Billet is the allocation layer between them, a different category (resource management), not a better Bearing.
- **Reuses:** Bam tasks/sprints/`time_entries`/assignments; `expertise_for_topic` and `search_everything` MCP tools; Qdrant for semantic skill matching; Bill `POST /internal/rates/resolve` for cost rates and Burn for margin envelopes; Book availability plus `book_find_meeting_time_for_users`; `agent_proposals` HITL queue with `proposal.created`/`proposal.decided` Bolt events; `@bigbluebam/permissions` for who may see rates.
- **Lens fit:** The product is an agent that runs a recurring judgment loop over the suite's own data and hands humans decisions instead of dashboards.

#### Badge
- **Names:** Badge, Bailiff, Bouncer
- **One-line pitch:** An agent that owns the full joiner-mover-leaver lifecycle across all 24 suite apps and continuously proves, with evidence, that nobody has access they should not.
- **Description:** Badge treats access as a living claim that must be re-justified, not a checkbox set once at onboarding. An agent watches membership, role, project, and client-engagement changes, then reasons about the delta between the access a person currently holds (org memberships, project memberships, API keys, OAuth links, guest invitations, service accounts, agent policies) and the access their current role and active engagements actually justify, using observed usage from `login_history` and `v_activity_unified` as evidence. It drives onboarding and offboarding as an autonomous runbook (provision, notify, revoke, reassign owned records, verify) and converts quarterly access reviews from a two-week spreadsheet ritual into a reviewer answering agent-drafted, evidence-backed recommendations.
- **Scope (in):** person lifecycle runbooks (joiner, role change, client rolloff, leaver, contractor expiry) executed by an agent with verification steps; live "what can this person reach" map across every app; dormant-access and orphaned-key detection; campaign-based access review with per-item AI recommendation and citation; ownership reassignment on departure (records, dashboards, automations, agent runners); immutable evidence export for SOC2 / client security questionnaires.
- **Scope (out):** payroll and benefits, performance reviews, recruiting, being an IdP (it orchestrates the existing OAuth/session/API-key surfaces rather than replacing them), device management.
- **Why build it:** Axis = risk and audit cost, with a hard trust wedge. A 24-app suite means offboarding one contractor today is a 24-place manual sweep that nobody completes, and the firm cannot answer a client's "who at your shop can see our data" question without a person spending a day on it. Lumos/ConductorOne exist for enterprises at enterprise price and integrate over public APIs; Badge sits inside the permission catalog itself, so its answers are exact rather than inferred from connector scrapes.
- **Closest existing app:** Bulwark monitors obligations owed under contracts; Bam's `/b3/people` is a CRUD member-admin screen for one app's memberships. Badge is a governance category (identity lifecycle + access review) spanning all apps, with an agent doing the reasoning, not a nicer people table.
- **Reuses:** `@bigbluebam/permissions` and `docs/permissions-action-manifest.json` as the authoritative action catalog; `organization_memberships`, `project_memberships`, `api_keys`, `sessions`, `oauth_user_links`, `guest_invitations`, `login_history`, `impersonation_sessions`; `v_activity_unified`; `agent_policies` and `agent_runners` (agents are principals too); `agent_proposals` for revocation approvals; Bolt events to trigger runbooks; Bin for evidence artifacts.
- **Lens fit:** A standing autonomous control loop whose output is enforcement plus proof, with humans only in the approve seat.

#### Blaze
- **Names:** Blaze, Bosun, Brace
- **One-line pitch:** An AI incident commander that runs the response, assembles the cross-app timeline while the incident is still burning, and hands you a written postmortem before the retro meeting.
- **Description:** When a Blip watch fires, a Bolt execution flatlines, or a human declares an incident, Blaze opens a war room and an agent takes the commander's clerical job: it correlates Blip log entries, Bolt execution failures, deploy and config activity from `v_activity_unified`, affected Helpdesk tickets, and Banter chatter into one causal timeline; it pages the right responder using observed system expertise rather than a static rota; and it keeps the stakeholder comms cadence on schedule with drafted updates. On resolution it writes a blameless postmortem with an explicit counterfactual section ("this would have been caught 40 minutes earlier if watch X existed") and files the corrective actions as Bam tasks with owners.
- **Scope (in):** incident declaration (manual, or automatic from Blip watches / Bolt failure events); severity assessment and expertise-based paging with escalation; auto-assembled evidence timeline with citations; scheduled stakeholder updates drafted for one-click send; blast-radius estimate (which clients, deals, and SLAs are exposed); postmortem generation with corrective actions written back to Bam; recurrence detection across past incidents.
- **Scope (out):** log ingestion and retention (Blip owns it), metric dashboards (Bench/Basis), customer ticketing (Helpdesk), status-page hosting, on-call payroll/comp.
- **Why build it:** Axis = time-to-understanding, and content that only an owner of the whole stack can produce. PagerDuty and incident.io mostly route humans and host a chat channel; the expensive part of an incident is reconstructing what happened, and that reconstruction requires reading across telemetry, automation, work items, and conversations, which is exactly the data this suite already holds under one auth model. For a services firm that runs systems for clients, an automatic client-ready incident narrative is directly billable trust.
- **Closest existing app:** Blip detects and stores signal; Helpdesk manages customer conversations. Neither runs a response process or produces analysis. Blaze is the response-and-learning category on top of Blip's signal, and consumes Blip rather than duplicating it.
- **Reuses:** Blip watches/`blip_watch_events` and saved views; Bolt event catalog plus `bolt_event_trace`/`bolt_recent_events` observability tools; `v_activity_unified` and `activity_by_actor`; Bureau for instant war-room presence and LiveKit voice; Banter for the incident channel; `expertise_for_topic` for paging; internal LLM proxy (`apps/api/src/routes/internal-llm.routes.ts`) for narrative synthesis; Bam for corrective actions; Bin for artifacts.
- **Lens fit:** An agent that occupies an operational role (incident commander's staff work) rather than offering a form for a human to fill in.

#### Baton
- **Names:** Baton, Bloom, Bootcamp
- **One-line pitch:** Enablement with no course authoring: an agent watches how work actually gets done at your firm, spots what a specific person does not yet know, and coaches them in the flow of that work.
- **Description:** Baton derives the curriculum instead of receiving it. An agent mines how your best people actually resolve things (Helpdesk resolution paths, Bam task trails, Beacon articles, Bay review comments, accepted Bulwark/Bursar decisions) into typed "plays," then compares each person's demonstrated behavior against those plays to produce a per-person gap model. Interventions are delivered where the work happens (a Banter nudge with the relevant play before someone touches an unfamiliar workflow, a two-question check inside Bam) and competence is certified by grading real artifacts the person produced, not quiz scores. New-hire ramp becomes an agent-run program that adapts weekly to what the hire got wrong.
- **Scope (in):** auto-mined play library with provenance and an expert owner who can correct it; per-person gap model with evidence; in-flow micro-coaching via Banter/Bam surfaces; role ramp plans that self-adjust; artifact-based competence certification (agent grades a real deliverable against the play, human confirms); manager view of team capability drift; export of certification evidence for client audits.
- **Scope (out):** SCORM/course authoring, video hosting (Bin holds bytes), compliance-training legal attestation (that is Badge's evidence lane), performance reviews and compensation, external customer academies.
- **Why build it:** Axis = cost of ramp and content freshness. Every LMS (Docebo, Lessonly, TalentLMS) fails at small services firms for the same reason: someone has to write and re-write the courses, and nobody has time, so the content is stale on day 90. Baton has zero authoring cost because the curriculum is extracted from the firm's own live work, which is only possible for a vendor that owns the work systems. Ramp time on a 12-person consultancy is a direct margin line.
- **Closest existing app:** Beacon is a knowledge base: a human writes an article and another human searches for it, pull-only. Baton is push, targeted, and diagnostic; it decides who needs what and intervenes, and it writes nothing into Beacon's editorial surface. Different category (enablement) built on Beacon as one input.
- **Reuses:** Beacon entries and Qdrant semantic retrieval; Helpdesk resolution history and `helpdesk_find_similar_tickets`; Bam task/comment history and `bam_task_count_by_phrase`; `expertise_for_topic`; Banter for delivery plus scheduled posts with quiet hours; `agent_proposals` for expert sign-off on mined plays; Bin/Bay for artifacts and grading; Bearing to tie capability goals to outcomes.
- **Lens fit:** The AI is the entire authoring and assessment staff; remove it and there is no product left.

#### Bosun
- **Names:** Bosun, Bridle, Belfry
- **One-line pitch:** The console where a small firm hires, budgets, tests, and fires its AI agents, with replayable evidence of what every agent did and permission to do it.
- **Description:** The platform already has agent identity, heartbeats, policies, kill switches, HITL proposals, and 885 MCP tools, but no place to define an agent as a durable *job* and prove it is any good. Bosun lets a non-engineer describe an agent's objective in plain language, and it compiles that into a scoped role: an allowlisted slice of the MCP tool catalog, a permission identity, a budget in dollars and tool calls, a trigger set of Bolt events or schedules, and an escalation rule that routes uncertain actions to `agent_proposals`. Every run is recorded as a replayable trace, and Bosun auto-derives regression suites from past traces so a prompt or model change is gated by an eval that a human can read, with automatic rollback and quarantine when an agent's success rate or spend goes off the rails.
- **Scope (in):** agent definition from a natural-language objective, compiled to tool allowlist + permission scope + budget + triggers; full run traces with tool-call inputs/outputs and cost; eval suites auto-derived from traces plus human-labeled goldens; side-by-side A/B of two agent versions on the same replay set; live fleet console with spend, success rate, escalation rate, and a one-click kill switch; automatic quarantine on regression or budget breach.
- **Scope (out):** deterministic if-this-then-that rule building (Bolt owns that and Bosun triggers off it), model hosting or fine-tuning, writing the agent runtimes themselves (it governs any runner that heartbeats), a chat UI.
- **Why build it:** Axis = trust and cost control, the two things blocking every SMB from letting an agent touch real customer data. A 15-person firm will never hire an ML-ops engineer, yet the moment an agent can email a client or move money-adjacent records, "we think it works" is not good enough. LangSmith/Braintrust are developer libraries for teams that already write agent code; Bosun is scoped to this suite's own tool catalog and permission model, so an eval can assert business outcomes ("did it correctly refuse to touch a deal the asker cannot see") rather than string similarity.
- **Closest existing app:** Bolt is deterministic automation: known trigger, known action, execution log. Bosun governs the nondeterministic case, where the action is chosen at runtime, which needs budgets, evals, replay, and rollback that a rules engine has no concept of. Complementary, not competitive: Bolt events are Bosun's most common trigger.
- **Reuses:** `agent_runners`, `agent_policies` (kill switch + glob allowlists) and the `register-tool.ts` policy middleware; `agent_proposals` HITL queue; MCP internal `POST /tools/call` and the 885-tool catalog; outbound agent webhooks with HMAC + backoff; Bolt event catalog and `bolt_event_trace`; `@bigbluebam/permissions`; Blip for trace telemetry; Bench/Basis for spend reporting.
- **Lens fit:** This is the lens itself productized: the operating system for autonomous work inside the suite.

### Seat B - Data, intelligence & analytics

#### Billet
- **Names:** Billet, Berth, Ballast
- **One-line pitch:** A forward-looking staffing simulator that tells you, weeks ahead, exactly which person-shaped hole your firm is about to fall into, and drafts the assignment plan that fills it.
- **Description:** Billet builds a probabilistic supply-and-demand model of the firm: demand from Bond pipeline deals (stage probability, expected start, deal size), committed Bam sprints/epics, and Helpdesk load; supply from Book working hours and calendar events, plus a learned *effective* capacity per person derived from `time_entries` actuals versus plan (a nominal 40h person who reliably delivers 23h of throughput on integration work is modeled as 23h, not 40h). It infers a supply-side skill vector per person from work actually delivered (extending the existing `expertise_for_topic` signal fusion into a staffable competence graph), runs a constrained assignment solve against cost (`burn_cost_rates`) and price (`bill_rates`), and re-forecasts on every Bolt event. Shortfalls, bench idle, and single-person dependencies arrive as cited, dated, dollar-quantified warnings with candidate staffing plans drafted into `agent_proposals`.
- **Scope (in):** capacity ledger per person per week with confidence bands; demand model from weighted Bond pipeline + committed Bam work; learned effective-capacity and skill-vector inference from actuals; constrained assignment solver with margin-aware alternatives; "what breaks if this deal closes / this person leaves / this project slips two weeks" scenario runs; shortfall and idle-bench alerts as Bolt events; staffing plans as HITL proposals; `billet_*` MCP tools so an agent can ask "who is free and qualified for a Postgres migration in September."
- **Scope (out):** no timesheet entry UI (Bam owns `time_entries`), no charts or dashboards (Bench), no margin accounting or invoice gating (Burn), no PTO approval workflow, no recruiting.
- **Why build it:** Every services firm runs capacity in a spreadsheet that is stale the day it is written. Float, Runn, and Resource Guru all require humans to hand-enter allocations, and none of them can see the deal pipeline, the actual hours, the calendar, and the internal cost rate at once. Axis: **zero manual entry plus forward accuracy**. Billet is the only capacity tool whose inputs are already in the same Postgres database as the work, which means the forecast is derived, continuously corrected against outcomes, and free of the entry decay that kills every competitor.
- **Closest existing app:** Burn. Burn measures dollars already burned against a signed scope, backward-looking and per-contract. Billet models labor not yet spent across the whole firm, forward-looking and per-person. Bench renders numbers someone else computed; Billet computes a number nobody in the suite has.
- **Reuses:** `time_entries`, Bond deals/stages, Bam sprints, `book_working_hours` + `book_events`, `burn_cost_rates` and `bill_rates` resolvers, `expertise_for_topic`, `agent_proposals` HITL queue, `publishBoltEvent`, `@bigbluebam/permissions` (compensation data is owner/admin floored, same posture as `burn_cost_rates`), Braid for client identity, MCP tool catalog.
- **Lens fit:** Supply and capacity data, the one operational dataset the suite already generates and currently throws away.

#### Bastion
- **Names:** Bastion, Bailiff, Attest
- **One-line pitch:** Continuous compliance evidence that harvests itself from your own platform, including the control nobody else can evidence: what your AI agents did and who approved it.
- **Description:** Bastion maps controls (SOC 2, ISO 27001, or a custom framework) to *live queries* against platform truth rather than to uploaded screenshots: access reviews from `organization_memberships` plus `@bigbluebam/permissions` plus `login_history`, key hygiene from `api_keys` rotation state, privileged action review from `superuser_audit_log`, change evidence from `activity_log` and Bolt executions, monitoring evidence from `blip_watches` and `blip_watch_events`. An evidence-decay model scores every control by freshness, coverage, and contradiction, so a control silently rotting is itself an alert. The flagship surface is **agent governance attestation**: `users.kind='agent'` actors, `agent_policies` kill switches and allowlists, MCP tool invocation audit, and `agent_proposals` approve/deny records compose into a defensible answer to "prove a human approved every autonomous action that touched customer data."
- **Scope (in):** control catalog with framework mappings; evidence collectors as scheduled queries with signed, timestamped evidence packets written to Bin; drift and decay detection with Bolt alerts; quarterly access review campaigns driven by real usage rather than a roster export; policy attestation via Blank forms and Blast reminders; auditor-facing read-only export bundle; agent-governance control pack; `bastion_*` MCP tools.
- **Scope (out):** no external SaaS agent/scanner fleet in v1 (evidence is platform-internal plus manual upload); no penetration testing, no vulnerability scanning; no contract obligation tracking (Bulwark); no vendor questionnaires (Bursar).
- **Why build it:** Vanta and Drata charge $10k to $25k a year and spend most of their value integrating *other* people's systems to reconstruct evidence. If a firm runs on BigBlueBam, the evidence is already inside the same database, so collection cost approaches zero. Axis: **cost plus evidence provenance**, and beyond that, an uncontested capability: no compliance vendor today can attest an AI agent workforce, and every firm shipping agent-operated workflows in 2026 is about to be asked to.
- **Closest existing app:** Bulwark. Bulwark watches obligations owed under a signed contract to a counterparty. Bastion watches internal controls owed to a framework and an auditor, and its evidence source is the platform's own audit substrate rather than a PDF. Different category, no shared table.
- **Reuses:** `superuser_audit_log`, `login_history`, `sessions`, `api_keys` (including the 7-day rotation grace window), `oauth_user_links`, `activity_log` and `v_activity_unified`, `agent_policies`, `agent_runners` heartbeats, `agent_proposals`, `@bigbluebam/permissions` action catalog, Bin storage via `@bigbluebam/storage`, Blank, Blast, Bolt, MCP.
- **Lens fit:** Compliance evidence as a queryable dataset instead of a screenshot folder.

#### Blaze
- **Names:** Blaze, Brace, Bunker
- **One-line pitch:** An incident that investigates itself: the timeline, the ranked cause hypotheses, and the postmortem assemble from evidence while you are still on the call.
- **Description:** When a `blip_watches` alert, a Bolt failure burst, or a Helpdesk ticket surge crosses threshold, Blaze opens an incident and starts fusing evidence in real time: `blip_entries` in the blast radius, Bolt execution failures, `activity_log` changes immediately preceding onset, Banter channel chatter, similar-ticket clustering via `helpdesk_find_similar_tickets`, and Bin/Bay artifacts. It maintains a live ranked list of causal hypotheses, each with the specific evidence supporting and contradicting it, and updates as responders act. Its durable asset is **defect memory**: every resolved incident becomes a retrievable signature, so the next incident opens pre-loaded with "83% match to INC-114, that was connection-pool exhaustion after the migrate sidecar reran, fix was X," and recurring causes are promoted into Bearing goals or Bam tasks automatically.
- **Scope (in):** incident lifecycle (declare, sev, roles, comms) with a Bureau room and a Banter channel auto-provisioned; live auto-assembled timeline with evidence citations; ranked hypothesis board with confidence and refuting evidence; similarity match against defect memory on open; drafted postmortem with citations queued in `agent_proposals`; recurrence and action-item follow-through tracking; status page via a public token-gated route in the Bay guest-link pattern; `blaze_*` MCP tools so an agent responder can pull the timeline.
- **Scope (out):** no log ingestion or storage (Blip owns it), no on-call rostering or phone paging in v1 (notify via Banter, Blast, Bureau summon), no uptime probing, no ticket queue (Helpdesk).
- **Why build it:** PagerDuty and incident.io are routers and forms: a human still reconstructs the timeline afterward from memory, and the postmortem is written by the most exhausted person in the room. Axis: **time-to-cause**. Blaze wins because the evidence and the alert already live in the same stack, so causal correlation across logs, deploys, chat, and customer impact is a join instead of five integrations, and the defect memory compounds with every incident so a small team stops re-solving the same outage.
- **Closest existing app:** Blip. Blip detects and stores signal (watches, entries, throttled Bolt events) and stops there. Blaze owns the human and agent response, the causal reasoning across sources Blip never sees (chat, tickets, deploy activity), and the institutional memory. Blip is the sensor, Blaze is the investigation.
- **Reuses:** `blip_watches` / `blip_watch_events` / `blip_entries`, Bolt executions and observability tools (`bolt_event_trace`, `bolt_recent_events`), Helpdesk similarity and phrase-count tools, Banter channels, Bureau rooms and summons via `@bigbluebam/bureau-client`, `v_activity_unified`, Qdrant for signature retrieval, `agent_proposals`, Bay-style public token links, MCP.
- **Lens fit:** Operational evidence fusion, turning scattered exhaust into a ranked causal answer with a memory.

#### Bloom
- **Names:** Bloom, Badge, Merit
- **One-line pitch:** Performance conversations backed by what people actually shipped, cited across all 24 apps, instead of whatever the manager remembers from the last three weeks.
- **Description:** Bloom maintains a continuous, evidence-cited contribution record per person, assembled from real work: Bam tasks closed and their carry-forward history, Brief documents authored, Beacon articles written and read, Helpdesk tickets resolved and reopened, Bay review decisions, Banter answers others marked useful, Bond activities, Blaze incident participation. Every claim in a review draft carries a clickable citation, and every citation is filtered through the existing `can_access` visibility preflight for the specific reader, so a peer reviewer never sees an artifact they were not entitled to see. The AI spine is evidence selection and narrative synthesis under an access constraint, plus recency-bias correction: it deliberately surfaces high-impact contributions from month two that the manager has forgotten, and flags growth patterns (scope trend, review rework rate, unblocking others) rather than raw counts.
- **Scope (in):** rolling contribution ledger per person with citations; review cycles (self, manager, peer, upward) with AI-drafted, evidence-cited first drafts always routed through `agent_proposals` before a human sees them; goal linkage to Bearing key results; access-scoped peer feedback; 1:1 agenda assembly from open threads across apps; promotion-packet export to Bin; `bloom_*` MCP tools.
- **Scope (out):** not an HRIS: no payroll, no benefits, no PTO balances, no org-chart-of-record in v1; no compensation decisions or ratings algorithms; the AI never issues a rating, it only assembles cited evidence a human rates.
- **Why build it:** Lattice and 15Five collect self-reported prose because the work lives in fifteen disconnected SaaS tools and is unreachable. Here it is one Postgres database with a working cross-app visibility resolver. Axis: **evidence over recall**, which is also the legal-defensibility axis for any firm that has ever had a disputed termination. There is no product today that can cite a person's actual output because no other vendor owns the substrate.
- **Closest existing app:** Bearing. Bearing tracks goals and key results as declared targets against declared progress. Bloom tracks demonstrated contribution as observed artifacts, and the unit is a person rather than an objective. HR/people-ops is a category the suite has zero apps in.
- **Reuses:** `v_activity_unified`, `can_access` visibility preflight (this app is the strongest existing justification for that service), `search_everything`, `entity_links`, Bearing key results, `agent_proposals`, `@bigbluebam/permissions`, Bin export storage, Book for review-cycle scheduling, Blast reminders, MCP.
- **Lens fit:** People data, the suite's richest untapped dataset, made queryable without leaking anything.

#### Bellwether (Seat B variant - customer success)
- **Names:** Bellwether, Bridge, Barometer
- **One-line pitch:** Post-sale account health scored from the relationship graph, so you find out you are single-threaded on a $400k client before the one person who knows them leaves.
- **Description:** Bellwether models each client account as a decaying relationship graph over Braid-resolved people: who on your side talks to whom on theirs, how often, how fast each side replies, and how that trend is moving. It fuses that with delivery signal (Bam slippage and carry-forward rate, Burn overrun, Bill days-to-pay drift, Helpdesk reopen rate and sentiment, Book meeting cadence collapse, Bay approval latency) into a per-account risk score whose output is not a number but a **counterfactual explanation**: "renewal risk moved from 0.2 to 0.6 driven by 31 days without executive-sponsor contact plus two reopened tickets; comparable accounts that recovered did X." It also computes bus-factor exposure directly on the graph ("if Alice leaves, 71% of the relationship weight on this account leaves with her") and drafts interventions into `agent_proposals`.
- **Scope (in):** relationship graph per account built from Bond activities, Banter and Blast interaction, Book attendance, Helpdesk correspondence, all identity-resolved through `braid_resolve`; account health score with counterfactual driver explanation; single-threading and bus-factor exposure; renewal and expansion radar keyed to Bill recurring cycles and Bulwark contract terms; drafted interventions and warm-intro paths as HITL proposals; `bellwether_*` MCP tools; risk-change Bolt events.
- **Scope (out):** no deal pipeline or opportunity management (Bond), no invoicing (Bill), no contract clause extraction (Bulwark), no email sending (Blast), no dashboards (Bench), no NPS survey engine beyond reusing Blank.
- **Why build it:** Gainsight and ChurnZero are enterprise-priced and score health from product telemetry, which a services firm does not have. A services firm's churn signal is relational and delivery-shaped, and it is spread across CRM, tickets, invoices, calendar, and delivery, which is exactly why nobody scores it today. Axis: **a signal with no existing product for this customer**, plus bus-factor exposure, which is a computation no CS tool performs at all because none of them own an identity-resolution layer like Braid.
- **Closest existing app:** Bond. Bond ends at closed-won: it is pre-sale pipeline and contact records. Bellwether starts at closed-won and is about the health and fragility of a relationship already earned. Different category (customer success, zero apps today), different unit of analysis (the account graph, not the deal).
- **Reuses:** Braid `braid_resolve` golden profiles and cross-app timeline, Bond activities, Bill recurring/overdue signals, Burn variance events, Helpdesk tickets, Book attendance, Banter and Blast engagement, Qdrant for comparable-account retrieval, `agent_proposals`, `publishBoltEvent`, `can_access`, MCP.
- **Lens fit:** Relationship and delivery data fused into a predictive signal, the classic intelligence problem the suite has all the inputs for and none of the output.

### Seat C - Communication, collaboration & community

#### Bridge
- **Names:** Bridge, Broker, Vestibule
- **One-line pitch:** A governed outside-the-org workspace where your subcontractors, channel partners, and client-side stakeholders get answers from an agent that is allowed to speak for you, and nothing else leaks.
- **Description:** Bridge gives every external counterparty (sub, referral partner, reseller, client PM) a scoped room whose primary interface is a boundary agent, not a channel. The agent answers their questions by retrieving across Bam, Beacon, Brief, Bill, and Book, but every citation is run through the platform's `can_access` visibility preflight for a designated internal sponsor, so anything not permitted is silently dropped rather than redacted-in-view. Outbound commitments (dates, prices, scope statements) are never sent unattended: they land in `agent_proposals` for one-click human release. Bridge also keeps a reciprocity ledger per counterparty (referrals given vs received, response latency, deal-registration collisions detected via `braid_resolve`) so partner health is measured from real traffic, not a survey.
- **Scope (in):** counterparty records + tiers; scoped rooms with token-gated external access (no BigBlueBam seat required); the boundary agent with per-room retrieval policy and mandatory `can_access` filtering; proposal-gated outbound messages and file shares; deal-registration conflict detection across partners; reciprocity/response-time ledger; MCP tools so a partner's own agent can talk to yours machine-to-machine.
- **Scope (out):** not a chat product (no threads/DMs/emoji UX competing with Banter); no commissions or payouts (Bill's job); no contract terms enforcement (Bulwark's job); no public forum or self-serve signup.
- **Why build it:** Axis is **trust plus cost**. Services firms today hand externals either a Slack Connect channel with zero governance and no audit, or nothing but email. There is no product that lets a small firm expose an *agent* to outsiders with a provable permission membrane. Bridge is the first surface in the suite where a non-member interacts with company knowledge safely, which is exactly the capability every other app will want later.
- **Closest existing app:** Bureau (virtual office) and Banter. Different category: both are inside-the-org presence/messaging for seated members. Bridge's users are people who will never have an account, and its unit of work is a permission-filtered answer, not a message.
- **Reuses:** `guest_invitations` + Bay's proven public token-gated route pattern (`/bay/api/v1/public/review/:token`); `apps/api/src/services/visibility.service.ts` `can_access`; `agent_proposals` + `proposal_create/decide` MCP tools; `braid_resolve` for counterparty identity; `@bigbluebam/permissions` (`bridge.room.*`); Bolt events; `entity_links`; internal llm-provider route.
- **Lens fit:** This is communication and community pointed strictly outward, at the counterparties the suite currently has no surface for at all.

#### Bolster
- **Names:** Bolster, Badge, Bloom
- **One-line pitch:** Turns the work your team already shipped into the training that gets the next hire billable, and certifies competence from real delivery evidence instead of quiz scores.
- **Description:** Bolster reads the firm's own delivery record (Beacon articles, Brief docs, Bam task histories, Helpdesk resolutions, Bay review threads) and synthesizes cohort-based enablement paths for a named role, with each module citing the internal artifacts it was built from. The AI spine is competence inference: instead of "did you pass the quiz," Bolster watches for evidence in real work (this person closed three tickets in this category unaided, authored a Beacon entry that survived review, ran a Bay review with no rework) and proposes certification into `agent_proposals` for a human to confirm. When source artifacts change, affected modules are flagged stale automatically via Bolt events.
- **Scope (in):** role definitions and skill graph; AI-generated paths with citations to internal artifacts; cohorts with a shared agent facilitator; evidence-based competence signals with HITL certification; staleness detection on source-artifact change; onboarding plan generation for a new hire from their assigned role.
- **Scope (out):** no video hosting or authoring studio (bytes live in Bin); no external/customer academy in v1; no LMS compliance training catalog purchase; no performance reviews or compensation.
- **Why build it:** Axis is **speed to billable**. A 15-person services firm loses margin every time a new hire ramps on tribal knowledge. Off-the-shelf LMSs require someone to author content the firm does not have time to write; Bolster's content *is* the firm's delivery history, which no external LMS can see. Nothing in the suite converts work product into capability.
- **Closest existing app:** Beacon (knowledge base). Different category: Beacon stores authored articles for lookup. Bolster is sequenced, cohorted, and assessed, and its object is a *person's* readiness, not a document.
- **Reuses:** Beacon's Qdrant semantic retrieval; `expertise_for_topic` (already composes Beacon/Brief/Bond/Bam signals) as the seed competence signal; Bin/`@bigbluebam/storage` for media; Book for cohort sessions; Bolt for staleness triggers; `agent_proposals` for certification HITL.
- **Lens fit:** Enablement cohorts are community, the internal kind the suite has zero coverage of.

#### Bulletin
- **Names:** Bulletin, Bugle, Klaxon
- **One-line pitch:** When something breaks, Bulletin decides who has to be told, writes each audience its own honest version, and turns the whole conversation into the postmortem.
- **Description:** Bulletin is incident *communication*, not incident detection. A Blip watch, a Helpdesk surge, or a human declares an incident; Bulletin then computes the blast radius by walking `entity_links` and Bond/Bill relationships to find which clients, contracts, and internal owners are actually affected, and drafts audience-differentiated updates (client-facing, internal, executive, public status page) from one shared incident state. Every outbound draft goes through `agent_proposals`; the commander approves, and Bulletin fans out via Blast, Banter, and the public status page simultaneously. When it closes, the postmortem is generated from the real timeline of decisions and messages, with contractual notice obligations cross-checked against Bulwark.
- **Scope (in):** incident lifecycle + severity + roles; AI blast-radius computation over entity links and client records; multi-audience draft generation with per-audience tone and disclosure policy; proposal-gated fan-out; token-gated public status page; auto-drafted postmortem with timeline and action items pushed to Bam; notice-obligation cross-check against Bulwark.
- **Scope (out):** no monitoring, log ingest, or alert rules (Blip owns that); no on-call paging rotations in v1; no root-cause telemetry analysis.
- **Why build it:** Axis is **trust under pressure**. Small firms lose clients not from the outage but from the silence and from telling three stakeholders three inconsistent things. Statuspage plus a doc plus a Slack channel is the current stack and none of them know which clients are affected. Bulletin knows, because the suite already holds the contracts, the projects, and the telemetry.
- **Closest existing app:** Blip (telemetry/logs). Different category: Blip's output is a detected condition; Bulletin's output is a set of humans correctly informed and a defensible record that they were.
- **Reuses:** Blip watch events on the Bolt bus; `entity_links`; Bond + Bill for affected-client resolution; Blast for external send; Banter for internal fan-out; Bulwark for notice deadlines; `agent_proposals`; Bay-style public token route for the status page.
- **Lens fit:** Crisis communication is the highest-stakes external communication a firm does, and the suite has no surface for it.

#### Bellwether (Seat C variant - voice of customer)
- **Names:** Bellwether, Bard, Chorus
- **One-line pitch:** Every claim your team makes about what clients want gets traced back to the exact sentence a real client said, and Bellwether tells you when that sentence stopped being true.
- **Description:** Bellwether continuously harvests the customer's literal voice from everywhere it already lands in the suite (Helpdesk ticket bodies, Bay review annotations, Blank free-text responses, Bond notes, Banter transcription output from calls) and builds a governed utterance corpus with speaker, account, date, and access scope preserved. The AI spine is claim grounding: you assert "mid-market clients want faster turnaround," and Bellwether either supports it with quoted, attributable utterances and a confidence figure, or refuses and shows the counter-evidence. It runs standing themes with drift alerts, so a theme that was true last quarter and is fading fires a Bolt event rather than sitting in a slide deck forever.
- **Scope (in):** multi-source utterance ingest with provenance; per-viewer access-scoped retrieval (an utterance you cannot see never grounds a claim shown to you); claim submission and grounding verdicts with citations; standing themes with drift detection; account-level sentiment trajectory tied to Braid golden profiles; MCP tools so any agent in the suite can ask "what do customers say about X" and get cited answers.
- **Scope (out):** no numeric BI dashboards (Bench/Basis own metrics); no survey builder (Blank owns forms); no CRM records; no automatic outbound to customers.
- **Why build it:** Axis is **evidence, and cost of getting it**. Enterprise VoC platforms start at five figures and require you to pipe data into them; Bellwether's data is already inside the walls and already permission-modeled. The wedge is the refusal: a system that will say "your belief is not supported by what clients actually said" is something a services firm cannot get any other way.
- **Closest existing app:** Basis (metric layer). Different category: Basis governs numbers and explains why a number moved. Bellwether governs *quotes*, and its atomic unit is an attributed human sentence, which Basis cannot represent.
- **Reuses:** the `banter-transcription` worker job; Helpdesk, Bay, Blank, and Bond via the shared DB; Braid for account resolution; Qdrant for semantic retrieval; `visibility.service.ts` `can_access` for per-viewer grounding; Bolt for drift events.
- **Lens fit:** Voice of customer is the inbound half of external communication, and today it evaporates into ticket archives.

#### Babel (Seat C variant)
- **Names:** Babel, Brogue, Polyglot
- **One-line pitch:** One locale layer for everything your company says out loud, so a Beacon article, a Blast campaign, a Blank form, and a Book page never drift out of sync across languages.
- **Description:** Babel is a suite-wide localization spine rather than a translation button per app. It registers every outward-facing artifact across Beacon, Blast, Blank, Book, Bay guest links, and Helpdesk macros as a localizable unit, maintains a firm-specific glossary and tone profile, and produces locale variants with the firm's terminology enforced. The AI spine is drift management: Babel subscribes to Bolt change events on source artifacts, computes semantic (not textual) deltas, and re-drafts only the affected segments into `agent_proposals` for a reviewer who reads that language. It also detects the reverse case, an inbound Helpdesk ticket or Blank submission in a language nobody on the team reads, and routes it with a grounded translation plus the original preserved.
- **Scope (in):** localizable-unit registry across apps; glossary and tone profile with enforcement; locale variant generation and storage; semantic drift detection on source change with segment-level re-draft proposals; reviewer queue per locale; inbound-language detection and routing; MCP tools for agents to request or check localized content.
- **Scope (out):** no authoring UI (each source app keeps its editor); no machine-translation of internal chat in v1; no real-time speech interpretation; no per-word vendor marketplace.
- **Why build it:** Axis is **integration**. Existing TMS products (Crowdin, Lokalise, Phrase) are built for code strings and require connectors per surface; none of them can see a services firm's CRM-adjacent artifacts, and none can tell you that your Spanish onboarding form now contradicts your English one. Because Babel sits inside the suite on the Bolt bus, sync is a subscription rather than an integration project.
- **Closest existing app:** Brief (documents). Different category: Brief owns one document's content and collaboration. Babel owns the *relationship between equivalent artifacts in different languages across many apps*, and never becomes the editor for any of them.
- **Reuses:** Bolt event subscriptions from every publisher app; `entity_links` for source-to-variant linkage; `agent_proposals` for review; Qdrant for semantic delta scoring; `@bigbluebam/permissions` for per-locale reviewer roles; Bin for localized media assets.
- **Lens fit:** Localization is the literal mechanics of communicating with a community you do not share a language with, and it is untouched by all 24 apps.

### Seat D - Vertical wedge: skilled trades and field services

Seat D's chosen vertical, in its own words: **skilled trades and field services** (HVAC,
electrical, plumbing, restoration, solar, commercial facilities maintenance; 5-50
employees, 3-25 trucks). Justification: every one of the 24 shipped apps assumes knowledge
work performed at a desk by a person with a browser. Nothing in the suite models a truck, a
technician, a job site, a serial number, a permit, or a part. That segment is also exactly
BigBlueBam's stated 2-50 user target, buys software on a company card, and is currently
forced to choose between a $400/mo ServiceTitan seat stack or a whiteboard.

#### Beeline
- **Names:** Beeline, Brace, Rollcall
- **One-line pitch:** Before a truck rolls, it predicts what the job actually is from the customer's own words and refuses the dispatch if that tech, that truck, and that permit status cannot finish it in one visit.
- **Description:** Beeline ingests the raw intake artifact (call transcript, Blank form, Helpdesk ticket, photo from the customer) and produces a typed *job hypothesis*: probable fault, required skill tier, required parts, required permit, expected duration, with citations back to the words that implied each. It then runs `beeline_precheck`, a deterministic, circuit-broken gate modeled on `burn_precheck`, against the proposed assignment and returns fit / short / blocked with the exact missing item. The AI spine is the hypothesis, not the calendar: scheduling tools take the dispatcher's guess as fact, Beeline treats the assignment as a claim to be falsified before it costs a truck roll.
- **Scope (in):** intake-to-hypothesis extraction with citations; skill/part/permit requirement graph per job type; the precheck gate with fit/short/blocked plus named remedy; revisit-cause post-mortem that feeds the requirement graph; day-board showing at-risk assignments; HITL reroute proposals into `agent_proposals`.
- **Scope (out):** it is not a calendar or a route optimizer, does not own customer records, does not do GPS tracking or timesheets, and never auto-dispatches unattended.
- **Why build it:** axis is **revisit rate**. Trades run 20-30% callback/second-visit rates and each rolled truck is $150-300 of unbillable labor plus a customer apology. No dispatch product on the market will *refuse* a dispatch, because none of them know what the job is. This turns intake text into an enforceable readiness assertion, which is only possible with retrieval plus reasoning.
- **Reuses:** `POST /internal/llm` proxy for extraction, `agent_proposals` HITL queue, `publishBoltEvent('job.blocked','beeline',...)` so Bolt rules can chase parts, Book availability for the technician calendar, Braid `braid_resolve` for the customer, Bin for intake photos, `@bigbluebam/permissions` fail-closed per-action, MCP `register-tool`.
- **Closest existing app:** Book (scheduling). Different category: Book sells time slots against stated availability; Beeline asserts *capability* and blocks work, more sibling to Burn's spend gate than to a calendar.
- **Lens fit:** The single most expensive daily decision in a trades business is which van goes to which address, and today it is made from a one-line note.

#### Bunker
- **Names:** Bunker, Bushel, Tailgate
- **One-line pitch:** Knows what is actually on each truck without anyone ever scanning anything, by inferring stock from supplier invoices, job photos, and completed work orders.
- **Description:** Bunker maintains a per-truck *belief-state* ledger: every SKU carries a quantity and a confidence, updated by evidence rather than by discipline. Supplier invoice PDFs and photos of the bin wall land in Bin and are parsed into stock deltas; closed jobs decrement the parts the work implies; disagreements surface as a ranked reconciliation queue ("your ledger says 4 condensate pumps on Van 3, three jobs consumed pumps and no invoice restocked it"). The AI spine is probabilistic reconciliation across noisy multi-modal evidence, which is the only mechanism that survives contact with a technician who will not scan a barcode.
- **Scope (in):** per-truck and per-shelf ledgers with confidence; invoice/photo/receipt ingest to stock delta; consumption inference from closed jobs; reorder and restock proposals; a "before you drive to the supply house" answer for a named part across the fleet; serialized-tool custody.
- **Scope (out):** no barcode/RFID hardware requirement, no purchase-order approval workflow (that is Bursar), no multi-warehouse WMS, no supplier price negotiation.
- **Why build it:** axis is **labor hours recovered per tech per week**. The failure mode is not shrink, it is a $95/hr technician spending 90 minutes at a supply house counter mid-job. Every incumbent inventory tool assumes scanning compliance that field crews have never once achieved; an evidence-inferred ledger with honest uncertainty is a category no CRUD inventory app can be.
- **Reuses:** Bin + `@bigbluebam/storage` for invoice/photo bytes, `POST /internal/llm` for line-item extraction, Bill for cost basis, Bolt events on `stock.depleted`, `agent_proposals` for reorder approval, `@bigbluebam/structured-data` codecs for supplier CSV catalogs.
- **Closest existing app:** Bin (files and structured data). Different category: Bin stores bytes and rows; Bunker maintains a contested physical-world state estimate over time and answers "where is the part right now."
- **Lens fit:** A trades P&L is labor and materials; the suite currently models neither for a mobile workforce.

#### Bequest
- **Names:** Bequest, Badge, Journeyman
- **One-line pitch:** Turns the work your best technicians already do into a proven skill matrix and targeted drills for the apprentices replacing them.
- **Description:** Bequest derives competency from evidence rather than from course completions: closed jobs, Bay-reviewed job photos, voice notes, callback outcomes, and a master tech's five-minute debrief become per-skill evidence rows with confidence and recency decay. It then generates the missing piece, a targeted micro-drill or shadow-assignment for the specific gap, and captures the retiring master's tacit reasoning by interviewing them about the jobs it saw them close. The skill matrix it produces is the same one Beeline gates dispatch against, so the credential is load-bearing rather than decorative.
- **Scope (in):** skill taxonomy per trade with evidence-backed levels; automatic evidence capture from closed work; decay and re-certification prompts; master-tech debrief interviews producing reusable diagnostics; gap-targeted drills and shadow-assignment proposals; apprentice hour logs for licensure boards.
- **Scope (out):** not a video LMS, no SCORM, no compliance-training checkbox library, does not do payroll or performance reviews.
- **Why build it:** axis is **time-to-billable for a new hire** and the retirement cliff. Trades lose master techs faster than they can mint them, and every LMS on the market sells video seat-time that nobody watches. Deriving a truthful skill matrix from work performed is impossible without retrieval over multi-modal job records, and no incumbent even attempts it.
- **Reuses:** Bam time entries and tasks as the work record, Bay annotations/decisions as review evidence, Beacon for the articles a debrief generates, `expertise_for_topic` on the platform read plane, Bin for media, `agent_proposals` for level-up approval, Bolt `skill.certified` events.
- **Closest existing app:** Beacon (knowledge base). Different category: Beacon stores articles a human chose to write; Bequest measures a *person* against a *skill* from work they did and gates their assignments.
- **Lens fit:** Labor capability, not labor hours, is the growth ceiling in every trade; the suite has no people-capability system at all.

#### Bellwether (Seat D variant - installed-asset service memory)
- **Names:** Bellwether, Bedrock, Premise
- **One-line pitch:** A permanent service memory for every piece of equipment at every address you have ever touched, that tells you which unit is about to fail before the customer calls a competitor.
- **Description:** Bellwether builds a dossier per *installed asset*, not per customer: make, model, serial (read from the nameplate photo the tech already takes), install date, every visit, every part replaced, every fault code, across fifteen years and multiple owners of the building. On top of that it runs survival-style reasoning over your own history plus model-level priors to rank which units in your installed base are entering their replacement window, and drafts the outreach. The AI spine is entity resolution over the physical world: matching a blurry nameplate and a scribbled note from 2019 to the same condenser on the same roof.
- **Scope (in):** address and asset graph with lifecycle history; nameplate OCR and model/serial normalization; failure and replacement-window ranking with cited history; proactive outreach and maintenance-agreement proposals; warranty-window tracking; handoff dossier when a building changes owner.
- **Scope (out):** does not send campaigns itself (Blast does), no IoT sensor ingest in v1, no pricing/quoting engine, does not own the customer contact record (Bond and Braid do).
- **Why build it:** axis is **revenue per existing customer**. A trades firm's most valuable asset is the installed base it cannot query; the knowledge lives in paper folders and one dispatcher's head, so replacements go to whoever knocks first. There is no SMB-priced product that maintains an equipment-level, multi-decade service record, and doing it requires resolving messy physical-world identities, which is exactly what a rules engine cannot do.
- **Reuses:** Braid `braid_resolve` for the customer/company golden id and its evidence-trail pattern for asset clustering, Bin + Bay for nameplate photos, Bond for the contact, Blast for the outreach send, Bench/Basis for installed-base metrics, Bolt `asset.replacement_due` events, `entity_links` for cross-app binding.
- **Closest existing app:** Braid (identity resolution) and Bond (CRM). Different category: Braid resolves *people and companies*, Bond tracks *deals*; Bellwether resolves and remembers *machines bolted to buildings*, whose owner changes but whose history should not.
- **Lens fit:** Post-sale health in trades is not NPS, it is whether you know the compressor on that roof is eleven years old.

#### Bailiff
- **Names:** Bailiff, Bulkhead, Lienwatch
- **One-line pitch:** Watches the statutory clocks that quietly void your money and your right to work: license renewals, permit inspection sequencing, and mechanic's-lien notice windows in every jurisdiction you operate in.
- **Description:** Bailiff maintains two things: a credential ledger for your own people, trucks, and entities (licenses, endorsements, DOT, workers-comp class codes), and a jurisdiction rule graph built by reading the actual statute and municipal code text for the counties you work in. It then binds every open job's address, scope, and dollar value to the deadlines those rules generate, and fires with citations: "Job 412, Travis County, preliminary notice due in 6 days or the $38k receivable is unsecured." Drafts the notice into `agent_proposals`; a human sends it. The AI spine is statute-to-deadline synthesis grounded per-jurisdiction, which is precisely the thing a hardcoded rules table cannot scale across 3,000 US counties.
- **Scope (in):** credential ledger with expiry and blocking status; jurisdiction rule graph with cited source text; per-job deadline derivation from address plus scope plus amount; permit inspection sequencing (rough-in before cover); notice drafting into HITL; a "can this crew legally work this job" check callable by Beeline.
- **Scope (out):** does not file anything with a government, is not legal advice, does not manage the contract you signed (Bulwark does), no e-signature, no OSHA training content.
- **Why build it:** axis is **unrecoverable loss avoided**. A missed preliminary-notice window converts a collectible receivable into a write-off with zero remedy, and an expired license can void a job mid-build. Small contractors have no counsel and no clerk; the alternative today is a lawyer at $400/hr or nothing.
- **Reuses:** `POST /internal/llm` for statute extraction with clause citations, Bulwark's deadline-math and timezone-anchored firing pattern as a proven sibling, `agent_proposals` for drafted notices, Bill for receivable amounts at risk, Bolt events for chase automations, Bin for license and permit scans, fail-closed `@bigbluebam/permissions` boot invariant.
- **Closest existing app:** Bulwark (contract obligations). Different category, and Seat D checked the boundary in the code: `bulwark_compliance_docs` and vendor tiers are scoped through `contract_id -> project_id`, so Bulwark only knows obligations that exist *because a counterparty signed something*. Bailiff's obligations come from statute and from your own credential inventory, exist with no contract at all, and are keyed to a physical address rather than a document.
- **Lens fit:** In regulated physical work the binding constraints are a license, a permit, and a filing deadline, none of which the suite can currently see.

### Seat E - Operator / developer experience & platform tooling

#### Bastion (Seat E variant)
- **Names:** Bastion, Badge, Warrant
- **One-line pitch:** Continuous least-privilege review and audit-evidence generation for every human, agent, and service account in your workspace, including the ones you forgot you granted.
- **Description:** Bastion is the suite's access-governance plane. It joins the generated permission catalog (`docs/permissions-action-manifest.json`, 1,481 actions across 24 apps, 143 flagged destructive) against what each principal actually *did* (`v_activity_unified`, `activity_log.actor_type`, MCP tool-invocation audit, `agent_policies` allowlists) and reasons about the delta: this person can delete invoices, has never opened Bill, and left the project in March. The AI spine is an entitlement-reasoning engine that infers each principal's real role from behavior, writes a cited, plain-language justification for every over-grant, and drafts revocations, API-key rotations, and allowlist tightenings into `agent_proposals` for a named approver. At quarter close it assembles the auditor packet itself: reviewer, decision, timestamp, evidence rows, exceptions with reasons.
- **Scope (in):** principal inventory across `users.kind` human/agent/service plus `bbam_svc_` service accounts, API keys, sessions, `oauth_user_links`; usage-vs-grant drift scoring per action id; scheduled and event-triggered access-review campaigns with per-reviewer queues; non-human-identity governance (agent runner heartbeat staleness, tool-allowlist blast radius, kill-switch state); policy attestation (read-and-sign, with an AI reader that answers questions about the policy); immutable evidence export (PDF/CSV to Bin) mapped to SOC 2 CC6 control language; separation-of-duties conflict detection across apps (approves the invoice *and* issues the payment).
- **Scope (out):** it is not an IdP and does not authenticate anyone; it never silently revokes (every write goes through HITL proposals plus `confirm_action`); no vulnerability scanning, no endpoint/device agents, no external SaaS connectors in v1 (the suite's own estate is the wedge).
- **Why build it:** Axis is **evidence cost and trust**. A 30-person services firm burns two to three weeks of screenshots per SOC 2 access review, and the auditor still only sees grants, never usage. Vanta/Drata sell integrations that guess at usage from thin API surfaces; BigBlueBam already *owns* both sides of the join at row level, so Bastion produces evidence competitors structurally cannot. And nobody, at any price, governs autonomous agents as first-class principals today, which is exactly the risk a customer takes on the day they turn our 885 MCP tools loose.
- **Reuses:** `@bigbluebam/permissions` catalog + resolver, `agent_policies` + register-tool middleware, `agent_proposals` HITL queue, `v_activity_unified`, api-key rotation (migration 0117), RLS/`app.current_org_id`, Bin for evidence artifacts, Bolt events for review-due and revocation-approved, Blast for reviewer nudges, MCP tools so an agent can run its own review.
- **Closest existing app:** Blip (logs what happened) and the platform `agent_policies` table (a config surface, not a product). Different category: Blip answers "what did the system emit," Bastion answers "who should still be able to do what, and prove it to an auditor." Neither exists as an app today; GRC is a 0-app whitespace category.
- **Lens fit:** This is the operator's control room over the platform's own authority surface, which is now larger than any single admin can hold in their head.

#### Brigade
- **Names:** Brigade, Blaze, Klaxon
- **One-line pitch:** An AI incident commander that runs the response from first alert to written postmortem, so the 2 a.m. outage produces a fix instead of a Slack scroll.
- **Description:** When a Blip watch fires or a human hits the panic button, Brigade opens an incident: it drafts the severity call, assembles a responder roster from `expertise_for_topic` plus recent ownership of the touched code/tasks, opens a Bureau room and summons them into it, and posts a live status page for the affected client. Throughout, an incident-scribe agent maintains the authoritative timeline by fusing Banter messages, Bureau call transcripts, Bam task transitions, Bill/Bond context, and raw Blip events into a single causal narrative, asking clarifying questions in-channel when the record is ambiguous. On resolve it writes the postmortem: contributing factors, the counterfactual ("this would have been a 4-minute incident if the watch threshold were X"), and action items that it files as Bam tasks and, where mechanizable, as proposed Bolt guard rules.
- **Scope (in):** incident lifecycle (declare/sev/roles/resolve) with per-org sev definitions; on-call schedule with rotations, overrides, and escalation chains (page via Blast/email, Banter, Bureau ring); auto-assembled responder roster with the reasoning shown; live auto-scribed timeline and post-hoc correction; AI postmortem draft with cited evidence rows; action-item follow-through tracking (an incident is not closed until its items are); client-facing status page under a token-gated public route; recurrence detection across incidents ("this is the fourth incident whose root cause is the same expired credential").
- **Scope (out):** not a metrics store or log viewer (Blip owns ingest, retention, watches); not a rules engine (Bolt owns triggers/actions; Brigade proposes rules, Bolt executes them); no synthetic monitoring or APM agents in v1; not a customer ticket queue (Helpdesk owns that, Brigade links to it).
- **Why build it:** Axis is **speed under stress plus institutional memory**. PagerDuty pages you and stops; incident.io costs more per seat than a 20-person shop will pay and still requires a human scribe. The postmortem is the artifact everyone agrees matters and nobody writes, because writing it costs two hours after a night of no sleep. Brigade writes it from evidence the suite already holds, which is only possible because chat, calls, tasks, telemetry, and client context sit in one database.
- **Reuses:** Blip watches/alerts as the trigger edge, Bolt event bus and proposed-rule authoring, Bureau rooms + summon/knock + LiveKit and its transcription worker, Banter channels, Bam task creation for action items, `expertise_for_topic`, Bond/Braid for "which clients are affected," Bin for attached artifacts, `can_access` preflight before the scribe cites anything cross-app.
- **Closest existing app:** Blip. Different category: Blip is detection and forensics on machine data; Brigade is coordination of *humans* plus the organizational learning loop. Incident management and postmortems is a 0-app whitespace category.
- **Lens fit:** The single most operator-shaped workflow there is, and the one where an agent's ability to watch every channel at once genuinely beats a human coordinator.

#### Berth
- **Names:** Berth, Billet, Bandwidth
- **One-line pitch:** Continuously re-solved staffing for a services firm: who is on what next month, priced against pipeline probability, with every assignment explained.
- **Description:** Berth is the demand-and-supply solver a consultancy currently runs in a spreadsheet. Demand comes from Bond deals (weighted by stage probability and expected start), signed Burn deliverable envelopes, and open Bam sprint load; supply comes from Bam time entries, Book calendars, PTO, skills inferred from actual delivered work, and Bill/Burn cost-and-bill rates. An allocation agent re-solves the roster whenever reality moves (a deal slips, a sprint overruns, someone is out sick), scores each candidate plan on utilization, margin, skill fit, continuity, and burnout risk, and pushes the delta as explained swap proposals rather than silently rewriting the plan. It answers the two questions a principal asks weekly: can we say yes to this deal, and who is quietly at 130 percent.
- **Scope (in):** rolling 13-week capacity grid by person, role, and client; probabilistic demand from Bond pipeline with an explicit "if we win it" scenario toggle; assignment proposals with reasoning and named tradeoff ("this protects the Howell margin but puts Gilligan at 112 percent for two weeks"); bench visibility with a decay clock and suggested internal work; skill inference from delivered tasks/tickets rather than self-reported profiles; hiring and subcontract signals ("you are structurally short one backend from week 6"); what-if sandboxing.
- **Scope (out):** not payroll, not PTO approval workflow (it consumes PTO, does not adjudicate it), not a timesheet UI (Bam time entries stay authoritative), not margin accounting or invoicing (Burn and Bill own money-out and money-in), no per-hour task scheduling; it plans people-to-engagement, not hour-to-hour dispatch.
- **Why build it:** Axis is **the data is already here**. Float, Runn, and Forecast all begin with "import your projects, import your people, import your rates, import your pipeline," which is a two-week onboarding a 20-person agency never finishes, and their forecast is stale the day after import. Berth starts from live rows in the same database, so it is correct on day one and self-correcting thereafter. Resource and capacity planning is the highest-value 0-app whitespace for exactly BigBlueBam's target customer, a small services firm.
- **Reuses:** Bond deals/stages, Burn deliverable burn-down and cost rates plus its `POST /internal/rates/resolve` sibling in bill-api, Bam sprints/tasks/time entries, Book availability and `book_find_meeting_time_for_users`, Bearing for capacity goals, Bench materialized views for the utilization rollups, `agent_proposals` for swap approval, Bolt events on plan drift.
- **Closest existing app:** Burn (and Bench). Different category: Burn watches money against a signed scope retrospectively and gates charges; Berth allocates *people forward in time* against demand that has not been signed yet. Bench charts what happened; Berth decides what happens next.
- **Lens fit:** The operator role here is the delivery lead, and the tool is the one that turns their week of chasing availability into reviewing a solved plan.

#### Bailiwick
- **Names:** Bailiwick, Bedrock, Estate
- **One-line pitch:** The live inventory of every environment, credential, domain, license, and access grant your firm holds on behalf of clients, reconciled against what is actually out there.
- **Description:** Every agency accumulates an invisible estate: staging URLs, DNS and certs, cloud accounts, third-party API keys, seat licenses, admin logins on the client's CMS, a subcontractor still in a Slack workspace. It lives in a spreadsheet and a shared vault, and it is wrong. Bailiwick keeps a typed asset graph (asset, owner, client, cost, credential reference, expiry, who has access) and runs a reconciliation agent that continuously compares the *claimed* estate against observed reality: cert and domain expiry probes, endpoint liveness through Blip ingest, license seat counts versus actual logins, Bill expense lines that imply a subscription nobody registered. It reasons about lifecycle events too: when a Bond engagement closes or a Burn contract ends, it produces the offboarding decommission list and chases it to zero.
- **Scope (in):** asset and license registry with typed classes and client ownership via Braid; credential *references* with rotation-due tracking; automated discovery signals (cert/DNS expiry, endpoint health, Bill expense-to-asset inference, orphan detection from unowned assets); seat-utilization reasoning ("you pay for 12 Figma seats, 4 humans used it this quarter"); engagement offboarding checklists generated from the estate and driven to completion; renewal and expiry radar with owner escalation; hardware/device assignment for the same joiner-leaver flow.
- **Scope (out):** it is not a password manager and stores no secrets (it stores references, custodian, and rotation state, and points at the vault); no agent installed on client infrastructure; it does not negotiate or level vendor bids (Bursar owns that) and does not pay anything (Bill does).
- **Why build it:** Axis is **liability elimination at zero configuration**. Ask any 25-person agency what they still have production access to at a client they stopped serving 18 months ago and the honest answer is "no idea," which is both a breach waiting to happen and a line item in the SOC 2 finding. Snipe-IT is asset CRUD with no intelligence; spreadsheets rot. The wedge is that the reconciliation is autonomous and the client linkage already exists in Bond/Braid/Burn, so decommission becomes a consequence of closing an engagement instead of a task nobody files.
- **Reuses:** Braid golden client identity, Bond engagements, Burn/Bursar for contract end dates and vendor spend (it consumes Bursar's baseline, it does not duplicate leveling), Bill expense lines as a discovery signal, Blip ingest for liveness probes, Bin for artifacts and exports, Bolt for expiry events, `agent_proposals` for decommission approval, permissions/RLS for who may see credential custodianship.
- **Closest existing app:** Bursar. Different category: Bursar governs *vendor spend* against an awarded baseline, in dollars; Bailiwick governs the *technical and access estate*, in things, and its output is decommission and exposure rather than price drift. Inventory and IT asset management is a 0-app whitespace category.
- **Lens fit:** Pure operator whitespace, and the reconciliation loop is unbuildable by hand at any real scale.

#### Bridle
- **Names:** Bridle, Bellwether, Harness
- **One-line pitch:** The operations plane for your AI agents: replay real traffic against a candidate agent before you promote it, then watch cost, drift, and blast radius in production.
- **Description:** The suite exposes 885 MCP tools, agent runners with heartbeats, per-agent kill switches and glob allowlists, HMAC webhooks, and a proposal queue. What it has no product for is *operating that fleet*. Bridle records production agent invocations as replayable traces, then runs a candidate policy, prompt, model, or allowlist against a curated suite of those traces in a shadow lane and reports behavioral regressions with a judge that explains each divergence, not just a diff. Promotion is a governed release: canary a share of traffic, watch cost per outcome, tool-error rate, proposal-rejection rate, and human-override rate, and auto-roll-back on a tripped circuit. It also keeps the honest ledger nobody has: what did the agents cost this month, what did they actually accomplish, and which tool grants were never once used and should be revoked.
- **Scope (in):** trace capture and curation into eval sets; offline replay with LLM-judge plus deterministic assertions (did it call the right tool, did it respect `can_access`, did it stay inside its allowlist); canary rollout and automatic rollback tied to the existing kill switch; cost and outcome accounting per agent, per tool, per client; drift detection (tool-call distribution, latency, rejection rate) with alerting through Bolt; a "why did the agent do that" trace explorer that reconstructs reasoning from the audit trail; unused-grant reporting that feeds Bastion.
- **Scope (out):** not a log viewer (Blip owns ingest and retention; Bridle consumes it), not a rules engine (Bolt owns triggers), not a prompt IDE or model host, no fine-tuning, and it does not author agents; it operates the ones you run.
- **Why build it:** Axis is **trust before autonomy**. Every customer's real objection to handing agents write access is "what happens the day it goes wrong at 3 a.m. across 24 apps," and today the only answers are a kill switch and hope. LangSmith and Braintrust are developer tools sold to AI teams, priced and shaped for people building models, not for a 20-person agency that just wants its automations not to email the wrong client. Bridle is the governance layer that makes the rest of the suite's agentic surface commercially safe to switch on, which raises the ceiling on every other app.
- **Reuses:** `agent_runners` heartbeat/capabilities, `agent_policies` kill switch + allowlist middleware in `register-tool.ts`, the MCP internal `POST /tools/call` route as the replay execution path, `agent_proposals` outcomes as ground-truth labels, outbound-webhook delivery stats, Blip for the raw event stream, Bench for the cost dashboards, `agent_audit` and `activity_log.actor_type`.
- **Closest existing app:** Blip. Different category: Blip is generic application telemetry with watches; Bridle is a pre-production *evaluation and release* system whose unit is an agent behavior, not a log line, and whose core act (replay a real trace against a candidate policy and adjudicate the divergence) has no analogue anywhere in the suite. Zero apps in agent operations today.
- **Lens fit:** The developer-experience play: it is the CI/CD and observability discipline the suite already applies to code, applied to the non-deterministic thing we are now shipping the most of.

### Seat F - Engineering & software development

#### Blaze (Seat F variant - incident command with executable postmortems)
- **Names:** Blaze, Brigade, Siren
- **One-line pitch:** When production breaks, Blaze reconstructs what happened from evidence the suite already holds, then turns every postmortem finding into a live detector that proves it never happens silently again.
- **Description:** Declaring an incident opens a war room that auto-assembles a cited timeline by pulling Blip watch events and log fingerprints, Bolt execution traces, Banter thread messages, Bam task/phase transitions, and Bureau call presence into one causal-factor graph, with each node carrying its source link. The AI spine is twofold: (1) signal-shape retrieval, where the incident's factor graph is embedded in Qdrant so a new alert storm retrieves prior incidents with a matching *shape* rather than matching text and proposes the step that actually resolved them; (2) the recurrence guard, where every "we should have caught this sooner" finding is compiled into a concrete Blip watch or Bolt rule and registered in a guard-efficacy ledger that tracks whether the guard ever fired, was muted, or drifted dead. Action items are not tickets; they are detectors with a heartbeat.
- **Scope (in):** declare/sev/roles/resolve lifecycle; auto-assembled evidence timeline with per-item citations; live scribe that writes the running narrative from Banter + Bolt + Blip as it happens; contributing-factor graph with human editing; similar-incident retrieval by signal shape; guard compilation to Blip watches / Bolt rules with an efficacy ledger; postmortem doc published to Beacon; org-level "top unguarded failure modes" view.
- **Scope (out):** on-call rotations and paging (out of scope entirely, v1 rides Bolt notification actions); log search and dashboards (Blip owns those); public status pages; a second issue tracker (remediation work items are created *in Bam* via `task_upsert_by_external_id`, never duplicated here).
- **Why build it:** Axis = *evidence assembly time and remediation durability*. A 2-50 person services firm running incident response today does it in a chat thread and a doc nobody reopens; the timeline costs hours of human archaeology and 70% of action items rot. Blaze is the only tool that can build the timeline automatically, because it sits inside the same platform as the telemetry, the automations, the chat, and the tasks; incident.io/PagerDuty are outside your stack and can only ingest what you push to them. And no competitor closes the loop by converting a finding into a detector whose firing history is audited.
- **Reuses:** Blip (watch events, log fingerprints, watch creation API), Bolt (execution traces via `bolt_event_trace`/`bolt_recent_events`, plus rule creation as the guard target), Banter (thread ingest, incident channel), Bam (`task_upsert_by_external_id` for remediation), Beacon (published postmortem + runbook retrieval), Bureau (who was on the call), Qdrant, `agent_proposals` for guard approval, `can_access` preflight before citing anything cross-app, RLS/permissions, MCP tools.
- **Closest existing app:** Blip. Blip answers "what is the system emitting right now"; Blaze answers "what chain of causes produced this outage, and what detector now stands where the gap was." Different category: Blip is an observability data plane, Blaze is a response and learning system that *consumes* it and *writes back* detectors.
- **Lens fit:** Incident response and postmortems are the highest-stakes recurring ritual in software engineering, and the suite currently has the raw signals but no place where an engineer runs the event.

#### Beckon
- **Names:** Beckon, Bellwether, Demand
- **One-line pitch:** Beckon harvests every scattered "we need X" across support, sales, chat, and forms into ranked demand clusters, each priced in real dollars with the receipts attached.
- **Description:** Feature demand at a services firm arrives as a Helpdesk ticket, a line in a Bond deal note, a Banter aside, a Blank survey answer, and a Bay review comment, and it never adds up. Beckon continuously embeds and clusters those signals into canonical demand items, resolves each requester to a Braid golden id so twelve mentions from three accounts count as three, then attaches money: open Bond pipeline explicitly citing the gap, Bill revenue of the accounts asking, and Helpdesk handling hours the gap consumes. The second AI move is the deflection test: before anything enters the roadmap, Beckon retrieves Beacon and Brief to check whether the capability already exists, and routes satisfiable clusters to enablement instead of engineering, with the citation that proves it.
- **Scope (in):** signal harvesters over Helpdesk, Bond activities/notes, Banter, Blank submissions, Bay comments; embedding-based clustering with human merge/split review; Braid-resolved requester rollup; dollar attribution (pipeline at risk, ARR of asking accounts, support cost); build-vs-deflect classification with citations; ranked roadmap board with themes and status; auto-generated "you asked, we shipped" recipients list handed to Blast; MCP `beckon_demand_for(topic)` so any agent can ask what customers actually want.
- **Scope (out):** sprint execution, estimates, or task boards (Bam owns delivery); a public feature-voting portal in v1; anything resembling a second document editor or roadmap-as-Gantt.
- **Why build it:** Axis = *attribution*. Productboard and Canny collect requests but cannot tell you what a request is worth, because they do not sit next to your CRM, your invoices, and your identity graph; the suite does, and Braid already turns "Jim at Acme" and "j.smith@acme.co" into one golden id. For a 2-50 person shop the alternative today is a spreadsheet nobody trusts, and the concrete win is killing the loudest-customer bias by pricing every request.
- **Reuses:** Braid (`braid_resolve` for requester rollup), Bond (deals/activities), Bill (account revenue), Helpdesk (tickets + `helpdesk_find_similar_tickets`), Banter, Blank, Bay, Qdrant clustering, Beacon/Brief for the deflection check, Blast for the shipped-notification, `can_access` preflight, `agent_proposals` for cluster merges, Bench/Basis for the demand metrics, MCP.
- **Closest existing app:** Bam. Bam manages work that has already been decided; Beckon decides what should be worked on by turning unstructured customer voice into priced evidence. Different category: intake and prioritization upstream of the tracker, not a nicer backlog inside it.
- **Lens fit:** Product/roadmap intake is the missing front end of the engineering pipeline; without it Bam is a machine with no principled input.

#### Billet (Seat F variant - artifact-learned staffing and delivery forecasting)
- **Names:** Billet, Berth, Roster
- **One-line pitch:** Billet answers "who can we actually put on this, starting when, and what is the probability it lands on time" using skills learned from real work output rather than self-reported spreadsheets.
- **Description:** Billet builds a skills-and-throughput graph per person from artifacts, not resumes: what they actually closed in Bam, what they authored in Beacon and Brief, what they were consulted on in Banter, and which incidents they resolved (extending the existing `expertise_for_topic` signal composition into a durable, time-decayed model). It then runs a Monte Carlo delivery simulator over each candidate staffing plan, sampling that person's *observed* cycle-time distribution per work type rather than a flat velocity, and returns P50/P90 finish dates. The third piece is the collision detector: a proposed assignment is continuously checked against Book calendars, Bearing key results, and Burn's priced deliverable envelopes, so Billet raises "this plan is a 62% chance of breaching the priced envelope on the Acme SOW" before anyone signs the plan, not after.
- **Scope (in):** artifact-learned skill graph with evidence links and decay; per-person availability from Book plus committed allocations; scenario planner (drag people onto engagements, see forecast shift); Monte Carlo P50/P90 delivery forecast from Bam sprint history; bench/utilization view with named gap-fill suggestions; collision alerts against Burn envelopes and Bearing key results; hiring/subcontract signal when no internal plan clears the bar; MCP `billet_who_can(skill, from_date)`.
- **Scope (out):** timesheets and time capture (Bam time entries own that), payroll or comp, invoicing (Bill), contract scope authority (Burn is authoritative, Billet only reads and warns), performance reviews.
- **Why build it:** Axis = *ground truth*. Float, Runn, and Resource Guru all depend on a human keeping skills and allocations current, which decays within a quarter; Billet's inputs are work products that update themselves. For a services firm, mis-staffing is the single largest margin leak, and the suite already knows the priced envelope (Burn), the calendar (Book), the work (Bam), and the goals (Bearing). No external tool can join those four.
- **Reuses:** `expertise_for_topic` service composition (Beacon/Brief/Bond/Bam signals) as the seed model, Bam sprints/tasks/time entries for cycle-time history, Book (`book_find_meeting_time_for_users`, availability), Burn (priced deliverable envelopes, read-only), Bearing (key results), Bill (bill/cost rates via bill-api's `/internal/rates/resolve`), Bench for utilization dashboards, permissions/RLS, `agent_proposals` for plan approval, MCP.
- **Closest existing app:** Burn. Burn watches money already spent against a contract; Billet decides who does the future work and forecasts whether that plan will fit. Different category: forward-looking capacity allocation versus backward-looking spend attribution; Billet consumes Burn's envelope as a constraint.
- **Lens fit:** Capacity planning is the operational core of running an engineering org, and it is the one decision the suite currently forces into a spreadsheet.

#### Ballast
- **Names:** Ballast, Bracket, Gauntlet
- **One-line pitch:** Ballast tells you which parts of your product no test actually guards, by tracing every real production defect back to the change that introduced it and the test that was never written.
- **Description:** Ballast ingests CI runs, test results, and coverage from any pipeline via a bearer-token endpoint, then does the join nobody does by hand: it links each production error fingerprint from Blip and each defect-flavored Helpdesk ticket back through change sets to the commit and the Bam task that shipped it, and asks which assertion would have caught it. The output is an unguarded-surface map, ranked by customer impact rather than by line coverage, plus a flaky-test tribunal that classifies intermittent failures by statistical signature (time-of-day, ordering, concurrency, environment) and quarantines them with an evidence packet instead of a shrug. Before a release, `ballast_precheck(change_set)` returns a cited risk brief: what this change touches, what it has historically broken, and what is unguarded in it.
- **Scope (in):** CI/test/coverage ingest with a stable results schema; escaped-defect linkage (Blip fingerprint or Helpdesk ticket to change set to Bam task); unguarded-surface map ranked by incident and support cost; flaky-test classification, quarantine, and de-quarantine with evidence; per-change-set risk brief and MCP `ballast_precheck`; proposed test cases written into `agent_proposals` for a human to accept; test-suite cost view (minutes spent per defect actually caught).
- **Scope (out):** running or hosting CI, being a test runner, log search and live tailing (Blip), code review or a git host, generating application code.
- **Why build it:** Axis = *outcome-linked quality signal*. Every CI dashboard reports coverage percentage, which correlates poorly with escaped defects; nobody outside your stack can link a production error to the ticket the customer filed to the change that caused it, because that join requires telemetry, support, and the tracker in one permission model. A 2-50 person team has no QA function at all, so "which of my tests are theater and what is actually exposed" is unanswerable today at any price.
- **Reuses:** Blip (error fingerprints, ingest-token pattern to copy, retention), Helpdesk (defect-flavored tickets, similar-ticket dedupe), Bam (tasks, the existing per-project `github_integrations` PR linkage as the change-set seed), Bolt (release-gate events), `agent_proposals` HITL for proposed tests, Bin for artifact and report storage, Bench for trend widgets, permissions/RLS, MCP.
- **Closest existing app:** Blip. Blip is runtime observability of a running system; Ballast is pre-release risk reasoning over change sets, and its primary corpus is CI and test data that Blip does not model at all. Different category: Blip says "an error occurred", Ballast says "this class of error recurs, here is the change that keeps causing it and the guard that does not exist."
- **Lens fit:** Quality governance is engineering's most under-tooled discipline for small teams, and the suite has both halves of the join sitting unused.

#### Bastion (Seat F variant - live-probe compliance and questionnaire answering)
- **Names:** Bastion, Bailiff, Attest
- **One-line pitch:** Bastion keeps your SOC 2 / security-questionnaire evidence continuously true by probing your actual running system for it, instead of asking you to upload screenshots once a year.
- **Description:** Each control (access review, key rotation, least privilege, data retention, change management, encryption at rest) is bound to one or more executable evidence probes that query the platform's own control planes: the generated permissions catalog and grant history, API key rotation records, `agent_policies` kill switches and tool allowlists, RLS posture, Bin object ACLs and storage bindings, Blip retention policies, and the `schema_migrations` checksum ledger as change-management proof. Probes re-run on a schedule, so every control carries a freshness timestamp and a pass/fail with the raw result attached. The AI spine is inbound questionnaire answering: drop a customer's security XLSX or Word questionnaire into Bin and Bastion drafts each answer from the live evidence with citations, flags every question it cannot substantiate rather than guessing, and routes the whole draft into `agent_proposals` for a human to sign. It never returns an unsourced answer.
- **Scope (in):** control library mapped to executable probes; scheduled probe execution with freshness and drift alerts via Bolt; access-review campaigns driven off real permission grants with attest/revoke actions; policy publication and per-employee attestation tracking; inbound questionnaire ingest, cited drafting, and unsubstantiated-question flagging; auditor-ready evidence export from Bin; vendor security posture rollup fed by Bursar's vendor records.
- **Scope (out):** being a certifying auditor; contract obligation extraction (Bulwark owns that); endpoint/MDM agents on laptops; penetration testing; a second permissions admin UI (Bastion reads the permission catalog, it does not grant).
- **Why build it:** Axis = *evidence that cannot go stale*. Vanta and Drata cost $10-25k/year, and their integrations still cannot see inside a custom stack, so the hardest controls end up as manually uploaded screenshots that are false within a week. Bastion's probes run against the same database and the same permission catalog the product enforces, which makes it strictly more truthful than any external compliance vendor for anything the firm built itself. The commercial wedge for a services firm is blunt: security questionnaires block deals, and answering one currently costs a founder a day.
- **Reuses:** `@bigbluebam/permissions` catalog and grant history, `agent_policies` and agent audit trail, API key rotation records, RLS posture flags, `schema_migrations` checksum ledger, Bin (questionnaire ingest, evidence export), the internal llm-provider route for drafting, `agent_proposals` HITL, Bolt (drift events, attestation reminders), Bursar (vendor list), Blank (attestation collection), MCP.
- **Closest existing app:** Bulwark. Bulwark extracts obligations from executed *customer contracts* and watches deadlines; Bastion extracts nothing from documents and instead interrogates the *running system* for control state, then answers inbound questionnaires. Different category: internal security posture and evidence generation versus external contractual obligation tracking. Bastion's inputs are database and permission state; Bulwark's inputs are PDFs.
- **Lens fit:** Compliance evidence in a modern shop is an engineering artifact (permissions, keys, retention, migrations), not a paperwork exercise, and only an app inside the stack can prove it.

### Seat G - Creative & marketing

#### Baton (Seat G variant - brand governance)
- **Names:** Baton, Bevel, Brandmark
- **One-line pitch:** Every file, email, deck, and form your firm ships is auto-checked against the right brand system, yours or your client's, before it leaves the building.
- **Description:** Baton ingests a brand book (PDF/asset set in Bin) plus a corpus of already-approved exemplars and derives a machine-checkable *brand system* per brand: palette with tolerance, type ramp, logo clear-space and misuse rules, voice/tone register, banned claims, mandatory legal marks. It then runs a multimodal conformance pass on outbound artifacts and returns a cited violation ledger ("logo at 8px clear-space, rule 3.2 of Acme Brand Book v4, page 11"), not a vibe score. A deterministic, circuit-broken `baton_precheck` sits in front of Blast send and Bay external review-link creation, exactly the gate shape Burn already established in front of Bill's money-out paths, so an off-brand asset cannot reach a client or a mailing list unnoticed. Fixes are drafted as proposals into `agent_proposals`, never auto-applied to bytes.
- **Scope (in):** brand-system extraction from brand books + exemplar corpus, per-brand rule ledger with human override/waiver, multimodal conformance check on Bin assets (raster, video poster frames, PDF) and text surfaces (Blast templates, Brief docs, Blank forms), advisory-or-blocking pre-send gate with fail-closed permission enforcement, violation ledger with clause citation, drift alerts when a brand book is superseded, MCP tools (`baton_check`, `baton_precheck`, `baton_brands_list`).
- **Scope (out):** no asset storage (Bin owns bytes), no human review workflow or annotation (Bay owns that), no design editing or auto-retouching, no DAM taxonomy, no campaign sending.
- **Why build it:** A services firm operates under N client brand systems simultaneously and enforces all of them from memory and PDF skim; the axis is **trust plus rework cost**, and one logo-misuse recall on a client campaign costs more than the app. No DAM, review tool, or design suite checks an artifact against *someone else's* brand rules at send time. Closest existing app: **Bay**, which is human-in-the-loop review of a single asset; Baton is automated, policy-derived, and suite-wide, a different category (governance gate vs. approval workspace) that makes Bay's human review cheaper by pre-filtering the mechanical failures.
- **Reuses:** Bin assets/versions (`media_meta` probe metadata, scan gate, proxy/poster transcode), the api's internal LLM proxy `POST /internal/llm/chat` with the `x-internal-service` token bucket, `agent_proposals` HITL queue + `proposal_*` MCP tools, `@bigbluebam/permissions` fail-closed `app.resource.verb` checks, `publishBoltEvent` (positional) for `brand.violation_detected` / `brand.waiver_granted`, Bond companies for brand ownership, Bay review-link creation as a gate point, Blast templates as a check target.
- **Lens fit:** Brand governance across a creative firm's entire output is the core unsolved creative-ops problem, and it is the one place AI judgment beats a checklist.

#### Babel (Seat G variant)
- **Names:** Babel, Brogue, Bespeak
- **One-line pitch:** Keep every customer-facing surface in the suite alive in every language you sell in, and know the moment a translation goes stale.
- **Description:** Babel treats localization as a *derived-state problem*, not a translation inbox. It registers localizable surfaces across the suite (Blast campaigns and templates, Blank form copy, Book public booking pages, Beacon public articles, Bill invoice templates, Bay guest-review chrome), maintains a per-locale glossary, tone register, and translation memory in Qdrant, and produces locale variants with a transcreation mode for marketing copy (intent-preserving rewrite) distinct from strict mode for legal/financial strings. The spine is a source-hash lineage graph: when a source string changes, every derived variant is marked stale, a re-localization proposal lands in `agent_proposals`, and Bolt fires `locale.variant_stale` so a campaign can be blocked from sending in a stale language.
- **Scope (in):** locale registry + surface registration, glossary/do-not-translate/tone profile per locale, translation memory with vector reuse scoring, transcreation vs strict modes, staleness lineage + reviewer queue, per-locale variant serving API that Blast/Blank/Book read at render time, `babel_localize` / `babel_stale_list` MCP tools, RTL and locale-format (date/currency) checks.
- **Scope (out):** no general document editor (Brief), no knowledge authoring (Beacon), no in-house MT model, no per-user UI chrome i18n of the SPAs themselves, no vendor/LSP procurement (Bursar).
- **Why build it:** The axis is **coverage decay**. Every firm that ships two languages ends up with a silently rotting second language because nothing links the translation to the source revision. Existing TMS products are standalone silos with an import/export gap; Babel's variants live behind the same surfaces that already render the source, so there is nothing to sync. Closest existing app: **Blast**, which sends one campaign in one language; Babel is a cross-app derived-content layer with its own lineage model, not an email feature, a different category (content state management vs. delivery).
- **Reuses:** Qdrant vector store already used by Beacon/Brief/Bond, internal LLM proxy, `entity_links` for source-to-variant lineage, `agent_proposals`, Blast templates/campaigns, Blank forms, Book public pages, Beacon entries, Bolt events, shared Zod schemas.
- **Lens fit:** Localization is marketing production work that no one owns; whitespace category, explicitly listed, and squarely creative.

#### Billet (Seat G variant - creative staffing)
- **Names:** Billet, Berth, Brigade
- **One-line pitch:** Staff creative work from evidence of who actually did it well, not from who remembers doing it, and see the capacity cliff before you sign the deal.
- **Description:** Billet builds a craft-skill graph per person from *produced artifacts*, not self-reported resumes: which Bam tasks they closed in which phase, which Bin assets they authored, which Bay decisions their work passed or failed on the first round, whose Brief docs got cited, how their time entries actually distributed across disciplines. It forecasts committed load from Bam sprints plus weighted Bond pipeline, then proposes staffing plans that satisfy craft-fit, availability, cost rate (from Bill's rate resolver), and continuity-of-client constraints, with an explanation for every assignment and a named second choice. When a deal stage-advances in Bond, Billet re-runs the forecast and flags the specific week and the specific discipline that breaks.
- **Scope (in):** evidence-derived skill graph with confidence + decay, capacity calendar (PTO-agnostic v1, honors Book events), committed vs. probabilistic load, staffing proposals into `agent_proposals`, bench/overallocation radar per discipline, first-pass-approval quality signal from Bay decisions, `billet_staff` / `billet_capacity_forecast` / `billet_who_can` MCP tools.
- **Scope (out):** no timesheet entry UI (Bam `time_entries` owns it), no payroll, no HR records or performance reviews, no invoicing or margin math (Burn/Bill), no recruiting pipeline.
- **Why build it:** The axis is **speed and accuracy of the single highest-leverage decision a services firm makes**. Spreadsheet resourcing and every standalone PSA tool ask a human to hand-maintain a skills matrix, which is stale within a quarter; Billet's matrix is a derivative of work the platform already records, so it cannot go stale. Closest existing app: **Bam**, which schedules *tasks* inside a known project; Billet schedules *people* across projects and unwon pipeline, a different category (supply/demand planning vs. execution tracking), and it is the whitespace of resource and capacity planning.
- **Reuses:** Bam tasks/sprints/`time_entries`/projects, Bond deals + stage probabilities, Bay decisions as a quality signal, Bin asset authorship, Bill `POST /internal/rates/resolve`, Braid for client continuity, Book for individual availability, Bench for the historical query plane, `agent_proposals`, permissions/RLS.
- **Lens fit:** Creative capacity and staffing is the operational bottleneck of every creative firm; explicitly named whitespace.

#### Boast
- **Names:** Boast, Banner, Bellwether
- **One-line pitch:** Turn work you already delivered into provable, consented, ready-to-cite proof, and answer "what evidence do we have for that claim?" in seconds instead of a week.
- **Description:** Boast mines completed engagements for defensible proof points: outcome metrics from Basis certified metrics, before/after artifacts from Bin, approval velocity from Bay, delivery record from Bam, spend/margin context from Burn, support health from Helpdesk. Each proof point carries a citation chain back to the source record and an access-scoped visibility flag, so a claim can be graded *usable publicly*, *usable under NDA*, or *internal only*. On top of that sits a reference-availability ledger per customer with consent scope, expiry, and fatigue counters (how many times you asked this client for a logo, quote, or call this quarter), and a claim-substantiation service: paste a proposed marketing claim, get back the supporting evidence, the strength grade, and the exact reason it fails if it does.
- **Scope (in):** proof-point extraction with citation chains, consent + NDA + expiry + fatigue ledger per customer, reference matching (find a referenceable customer resembling this open deal), claim substantiation API and MCP tool (`boast_substantiate`, `boast_find_reference`, `boast_proof_points`), drafted case-study skeletons into `agent_proposals`, `reference.consent_expiring` Bolt events.
- **Scope (out):** no CRM ownership (Bond), no email sending (Blast), no long-form publishing or CMS (Brief/Beacon), no NPS/survey collection (Blank), no legal contract review (Bulwark).
- **Why build it:** The axis is **provenance under time pressure**. Every services firm has proof buried in delivered work and no index of it, so proposals get written with invented numbers and the same three clients get burned out as references. Nothing on the market connects a marketing claim to the delivery record that substantiates it. Closest existing app: **Bond**, which tracks the relationship and the deal; Boast tracks the *evidence and the permission to use it*, a different category (advocacy/proof asset management vs. pipeline management), and it is the customer-advocacy whitespace.
- **Reuses:** Basis certified metrics as the only numeric source it will cite, Braid `braid_resolve` for one golden customer identity across Bond/Bill/Book, Bam project completion records, Bay approval history, Bin artifacts, Helpdesk history, `can_access` visibility preflight to enforce the public/NDA/internal grading, `agent_proposals`, `entity_links`, `search_everything`.
- **Lens fit:** Customer advocacy and proof assets are pure marketing work with no tool anywhere in the suite.

#### Bloc
- **Names:** Bloc, Bazaar, Bridge
- **One-line pitch:** Run your referral partners and subcontractor network as a real channel: registered deals, co-branded assets that satisfy both brand systems, and attribution neither side can dispute.
- **Description:** Bloc is a two-sided partner surface where partners get a scoped external workspace (token-gated, the way Bay already serves guest reviewers) to register deals, request co-marketing funds, and co-produce assets. The AI spine is threefold: a fit engine that reads both sides' delivered-work profiles and proposes which partner to route a specific opportunity to and why; a dual-brand co-production check that validates a co-branded artifact against *both* brand systems at once; and a deterministic attribution ledger that resolves overlapping partner claims on the same account by replaying Bolt-observed first-touch events and Braid golden identity, producing a split with a defensible audit trail rather than a shouting match. Fund requests and attribution overrides route to `agent_proposals`.
- **Scope (in):** partner directory with tiering, deal registration with conflict/overlap detection, co-op fund request and drawdown ledger, scoped guest partner portal, dual-brand co-produced asset workflow, attribution replay with dispute resolution, partner-fit recommendations, `bloc_register_deal` / `bloc_attribute` / `bloc_partner_fit` MCP tools.
- **Scope (out):** no internal pipeline management (Bond owns deals), no invoicing or partner payouts (Bill), no vendor sourcing/RFP leveling (Bursar, Bloc is revenue-side, Bursar is spend-side), no contract obligation tracking (Bulwark), no email delivery (Blast).
- **Why build it:** The axis is **disputable revenue**. Small firms get 20-40% of pipeline from partners and track it in a shared spreadsheet, so deal-source conflicts get settled by whoever complains loudest and co-op money goes unclaimed. Enterprise PRM products start at price points a 2-50 person firm will not pay and assume a channel team exists. Closest existing app: **Bond**, which is the internal CRM for your own sellers; Bloc is an external, permissioned counterparty surface with its own attribution arbitration model, a different category (channel management vs. CRM), and it is the partner/channel whitespace.
- **Reuses:** Bay's token-gated public-guest pattern (`/bay/api/v1/public/review/:token`) for the partner portal, Braid golden identity to detect that two partners registered the same real company, Bolt event history for attribution replay, Bond companies/deals read-only, Baton (if built) or a local brand ruleset for dual-brand checks, Bin for co-branded assets, `agent_proposals`, permissions/RLS, `publishBoltEvent` for `partner.deal_registered` / `partner.attribution_disputed`.
- **Lens fit:** Partner and channel co-marketing is marketing distribution, and the co-produced-asset problem is a creative problem in disguise.

### Orchestrator note on Phase 1 convergence

Counting independently-proposed apps by category, before any debate:

| Category | Seats proposing | Names used |
| --- | --- | --- |
| Resource & capacity planning | **5** (A, B, E, F, G) | Billet x4, Berth |
| Incident management & postmortems | **5** (A, B, C, E, F) | Blaze x3, Brigade, Bulletin |
| GRC / access governance | **4** (A, B, E, F) | Bastion x3, Badge |
| Learning & enablement | 3 (A, C, D) | Baton, Bolster, Bequest |
| Agent operations | 2 (A, E) | Bosun, Bridle |
| Localization | 2 (C, G) | Babel x2 |
| Partner / channel | 2 (C, G) | Bridge, Bloc |
| Trades field ops | 1 (D) | Beeline, Bunker, Bellwether-D, Bailiff |
| Customer success | 1 (B) | Bellwether-B |
| Voice of customer | 1 (C) | Bellwether-C |
| Product / roadmap intake | 1 (F) | Beckon |
| Test & quality governance | 1 (F) | Ballast |
| IT asset & estate | 1 (E) | Bailiwick |
| HR / performance | 1 (B) | Bloom |
| Brand governance | 1 (G) | Baton-G |
| Customer advocacy | 1 (G) | Boast |

Three categories drew four or five independent seats each. "Bellwether" was independently
chosen as a name by four seats for four different apps, and "Billet" by four seats for
substantially the same app. The debate round is therefore mostly about which of the three
convergent categories is strongest, and about whether the single-seat originals (Beckon,
Ballast, Bailiwick, Boast, Bloc, the trades wedge) can survive against a bloc.

## Phase 2 - Debate

One round was run. Each seat received the full 35-proposal slate with its own collisions named
explicitly and was asked to take ALIGN / OPPOSE / IGNORE stances, revise its block, and state a
strategy. A second round was not needed: the seats consolidated harder and faster than the
protocol requires, and by the end of round one the three convergent blocs had largely resolved
themselves through voluntary withdrawal rather than orchestrator intervention.

### The withdrawal ledger

Seats withdrew or reframed nine of their own proposals unprompted:

| Withdrawn / reframed | Seat | Conceded to | Stated reason |
| --- | --- | --- | --- |
| Blaze-A | A | Blaze-F | "Five seats proposed incident command; the version that closes the loop into executable detectors should win, and it is not mine. I am dropping my entry rather than diluting the field." |
| Badge's access-review half | A | Bastion-E | Removed itself from the four-way GRC pile-up; Badge became pure lifecycle execution. |
| Bastion-B | B | Bastion-F + Bastion-E | "Bastion-E's permission-catalog join beats my control-to-query mapping." Contributed the agent-governance evidence pack. |
| Blaze-B | B | Blaze-F | "My defect memory is signature retrieval, theirs turns the finding into a live detector with a guard-efficacy ledger." Contributed Qdrant signature retrieval. |
| Bellwether-C | C | Boast | "Boast's consent/NDA/expiry/fatigue ledger is a real mechanism I did not have." Handed over the utterance corpus for free. |
| Bulletin (reframed) | C | n/a | Pulled out of the incident bloc entirely and rebuilt as communication debt. |
| Bequest | D | Baton-A / Bolster winner | "I am not going to spend my seat defending the third-best version of it." |
| Brigade | E | Blaze-F | "I am dropping Brigade rather than run a fifth entrant in the densest cluster on the slate." |
| Bastion-F | F | Bastion-E | "I am not going to defend a weaker fourth entrant out of pride." Donated questionnaire answering and the `schema_migrations` checksum probe. |
| Billet-G | G | Billet-F | "It was the weakest of five." |

### Seat-by-seat calls

**Seat A** conceded the incident bloc outright and amputated Badge's access-review half, repositioning
Badge as uncontested people-ops lifecycle execution with ownership succession as the novel core. It
opposed Bastion-B and Bastion-F as "reports and probes over a ledger another app has to produce,"
opposed Bailiff as a fifth contracts-clock app, and opposed both Babels as a thin wedge at 2-50
people. Strategy, in its words: "I am not going to win a five-way bloc on framing alone, so I spent
that capital to buy credibility and moved my weight to the one place on this board nobody else
occupies."

**Seat B** withdrew two of its three bloc entries and spent the freed slots on uncontested
whitespace, introducing a new proposal, **Bevy** (recruiting where the requisition is generated from
a proven capacity shortfall priced in margin, the bar is calibrated on the firm's own shipped
artifacts, and the model is corrected by whether the hire actually ramped). Its stated portfolio
thesis: "Billet tells you how short you are, Bevy fills the gap against a bar calibrated on your own
work, Bloom measures whether the hire actually delivered, and Bellwether watches whether the revenue
paying for all of it is quietly rotting." It kept exactly two non-negotiables in the capacity merge:
effective capacity learned from `time_entries` actuals versus plan, and a cost-versus-price margin
consequence on every proposed assignment.

**Seat C** merged Babel on Seat G's framing, conceded Bellwether-C to Boast without a fight, merged
Bolster with Baton-A, and made the round's most consequential move: **pulling Bulletin out of the
incident bloc and rebuilding it as communication debt**, the gap between what each client stakeholder
believes and what is actually true. Its argument: "the interesting half of my idea was never the
incident at all: it was the belief-versus-truth gap, which applies on an ordinary Tuesday when a
project quietly slipped and nobody told the client." It also flagged a structural observation the
other seats picked up: seven proposals across six seats independently reinvented artifact-derived
skill inference, which "means that is a platform capability, not an app" - `expertise_for_topic`
already ships half of it.

**Seat D** withdrew Bequest, ceded the contested Bellwether name (renaming to Bedrock), and refused
to concede the vertical. Its case: "five independent seats reaching for staffing-capacity and five
for incident-command did not discover latent customer demand; they landed in the densest,
most-written-about regions of horizontal SaaS," and the blocs "will now spend the merge round sanding
each other's edges." Its distribution argument was the sharpest single point in the round: every
horizontal proposal sells app #25 to a customer who already bought 24, whereas a trades wedge "makes
the existing 24 apps sellable to a company that cannot use BigBlueBam at all today." It also
conceded openly that it was not leading with Bailiff, its most portable engine, precisely because
portability would land it inside the four-seat GRC crowd.

**Seat E** dropped Brigade, narrowed Berth to a single question ("can we say yes to this deal" on
unsigned pipeline, a verdict rather than a grid), and offered an unusually candid merge position on
Bastion: "if the choice is a merged Bastion with Seat F leading versus no Bastion in the Final 7, I
take the merge and hand F the pen. I would rather co-own the best app on the slate than solo-own the
third best." It concentrated on its estate-reconciliation app, renamed Bedrock, as "0-app
whitespace, the only entrant in its category."

**Seat F** conceded GRC leadership to Seat E and capacity leadership to Seat B, holding exactly two
components hostage through the capacity merge (Monte Carlo P50/P90 from observed cycle-time
distributions, and collision detection against Burn's priced envelopes). It made one hard objection
inside the incident merge it otherwise leads: **on-call rotation scheduling is the clone surface**,
"the one component that makes the merged app describable as PagerDuty without changing a word."
It then concentrated everything behind Ballast and widened it to absorb release and change
management, converting the buyer from "an engineer who likes tests" to "the delivery lead who eats
rework cost and the founder who has to prove change control to a client."

**Seat G** withdrew Billet-G, merged Babel, offered to layer Bloc on top of Bridge rather than
compete with it, and consolidated rights-and-licensing clearance into Baton, "which turns my flagship
from a taste argument into a dollar-exposure argument." It introduced a new proposal, **Buzz**
(instrumenting what AI assistants tell a buyer who asks "who should I hire for this," then closing
each gap and re-running the panel to prove the delta), noting its entire infrastructure already sits
in the monorepo unused for this purpose.

### Cross-seat endorsements given without self-interest

Several seats went out of their way to praise rivals on the record, which is signal worth preserving:

- **Beeline** (D) drew unsolicited praise from C ("the most original single sentence on this slate"),
  E ("refusal is what separates AI-native from AI-decorated"), F ("the strongest single mechanic on
  the whole slate; an AI that declines is more valuable than one that predicts"), and G.
- **Beckon** (F) was endorsed by C ("the best single mechanism on the slate outside my own"), D ("if
  a horizontal wins, it should be this one"), E, and G.
- **Bridge** (C) was endorsed by E ("the most genuinely new category on the slate that is not mine")
  and A (complementary to Badge).
- **Bloom** (B) drew respect from F and non-contest from A.

### Orchestrator note

The debate produced far more consolidation than a normal round. Ten proposals were withdrawn or
reframed by their own authors, three name collisions were resolved voluntarily, and the three
convergent blocs each produced a clear consensus leader (Blaze-F for incident, Bastion-E for GRC, a
merged Billet built on B's effective-capacity spine and F's Monte Carlo for capacity). Notably,
multiple seats independently arrived at the same structural insight about the vote itself: a merged
bloc app reaches the ballot with its sharpest mechanic traded away *and* with every co-owner
abstaining from scoring it, while a single-seat app is scored on its merits by six voters. That
insight visibly shaped where seats placed their final bets, and it pushed the strongest players
toward uncontested categories rather than toward the crowded consensus.

One new name collision was created during the round: Seat D renamed Bellwether-D to **Bedrock** and
Seat E renamed Bailiwick to **Bedrock** in the same round, unaware of each other. Flagged to both at
submission time.

## Phase 3 - Submissions

Each seat was asked for its single strongest app as ballot text. Two seats (B and C) had
hedged in debate and were forced to choose; two seats (F and G) overrode their own stated
debate champions on ballot arithmetic.

| Seat | Submission | Category | Census status |
| --- | --- | --- | --- |
| A | **Badge** | HR / people-ops: workforce lifecycle execution and ownership succession | Whitespace |
| B | **Bevy** | Recruiting / talent acquisition | Whitespace |
| C | **Bulletin** | Stakeholder communication assurance (communication debt) | Whitespace |
| D | **Beeline** | Field service / dispatch / work orders | Whitespace |
| E | **Bastion** | GRC / security compliance and access governance | Whitespace |
| F | **Beckon** | Product demand intake and roadmap prioritization | Whitespace |
| G | **Buzz** | External market perception / answer-engine visibility | Whitespace (not even on the census list) |

Every one of the seven landed in a whitespace category. The steer held completely.

### The two overrides

**Seat F dropped Ballast for Beckon**, in its own words: *"I said Ballast in debate; three seats
endorsing Beckon on the record changes the ballot math, and Beckon sits in a listed whitespace
category with a horizontal buyer while Ballast's buyer is only the subset of firms that ship
software. Ballast's zero rivals meant no competition; it also meant no constituency."*

**Seat G dropped Baton for Buzz**, in its own words: *"Baton is the safer app; Buzz is the app no
other seat could have proposed. With 22 of 35 proposals sitting in four dogpiles that will split
their own votes, the scored winner is the entrant with no rival, no name collision, and a category
the census does not even list - and Buzz's infrastructure argument is stronger than Baton's
precedent argument, because 'the pattern has been proven elsewhere' is weaker than 'the three
components already exist and are running.'"*

### Ballot text (abridged; full submissions were relayed to every voting seat)

**Badge (Seat A)** - The day someone joins, changes role, or walks out the door, an agent executes
the entire 24-app consequence, finds the forty things they silently owned, and proves the sweep
actually finished. The novel core is ownership succession: a departing person is the sole owner of
Bench dashboards and scheduled reports, Bolt rules, Bill recurring invoice schedules, Blast
campaigns, Blip watches, API keys, and agent runners. Badge enumerates all of it, ranks each orphan
by blast radius (does it move money, does it email a client, does it fire unattended), reasons about
the successor from co-activity and topical expertise, and routes every transfer through the HITL
queue. Onboarding runs in reverse: provision from a peer's observed access profile, not a role
template nobody maintains. *"The damage this prevents is not a security finding, it is a recurring
invoice that quietly stops generating and a scheduled report that dies six weeks after someone left,
discovered by a client rather than by the firm."*

**Bevy (Seat B)** - Hiring where the requisition must prove itself in dollars before it opens, the
bar is calibrated on the firm's own shipped work, and the scoring model is corrected by whether the
hire actually ramped. The tracker is explicitly the throwaway half; the product is the two ends
nobody owns. A requisition cannot be opened by assertion: Bevy derives the shortfall from time-entry
actuals against working hours, committed work, and probability-weighted pipeline, prices it against
cost and bill rates, and issues a requisition that auto-expires when the shortfall closes. Work
samples are scored against the distribution of what the team actually shipped, per criterion, with
citations. At 90 and 180 days each hire's observed ramp is compared to the forecast that justified
the requisition and the scoring weights are corrected by outcome. Continuous four-fifths
adverse-impact monitoring can halt a requisition; no candidate is ever auto-rejected.

**Bulletin (Seat C)** - Tracks the gap between what each client stakeholder currently believes and
what is actually true, and tells you who is owed a conversation before the silence costs you the
account. Models communication debt as a first-class liability: a per-stakeholder *belief state*
inferred from what actually left the building (sends and their delivery signal, review threads,
meetings and transcripts, invoices delivered, notices), held against *truth state* from schedules,
scope and margin, balances, and obligations. A materiality classifier scores each divergence by
consequence and by role, so a two-day slip is noise to a client CFO and urgent to their delivery
lead. *"Every CRM, PSA, and project tool on the market records the interactions that happened.
Bulletin's atomic unit is the interaction that should have happened and did not."* Third instance of
a shape this codebase already validated twice: Burn's `unscoped` bucket and Bursar's absence engine.

**Beeline (Seat D)** - Before a truck rolls, predicts what the job actually is from the customer's
own words and refuses the dispatch if that technician, that truck, and that permit status cannot
finish it in one visit. Turns raw intake (call transcript, form, ticket, customer photo) into a typed
job hypothesis with per-claim citations, then runs `beeline_precheck`, a deterministic circuit-broken
gate modeled on the shipped `burn_precheck`, returning fit / short / blocked with the exact missing
item and a named remedy. *"Blocked is the product. Every scheduling tool ever built accepts the
dispatcher's guess as fact."* Carries the session's only market-expansion argument: every other
finalist sells app #25 to a customer who already bought 24; Beeline sells the first app to a
nine-truck HVAC contractor who cannot use the suite at all today.

**Bastion (Seat E)** - Continuous least-privilege adjudication and audit evidence for every human,
agent, and service account, proving not just who can act but whether they should still be able to.
Reads what each principal is granted from the generated 1,481-action permission catalog, reads what
each principal actually did from the unified activity view, and adjudicates the delta in cited plain
language. Control posture is verified by executable probes against the running system rather than
asserted in a document. The flagship is non-human-identity governance: agents and service accounts as
first-class reviewable principals with allowlist blast radius, heartbeat staleness, and kill-switch
state as reviewable facts. *"No shipping GRC product governs autonomous agents, and that is exactly
the risk a customer assumes on the day they enable 885 MCP tools with write access."* Three seats
donated their strongest mechanics into this entry.

**Beckon (Seat F)** - Never asks a customer to file a request; infers what they need from
conversations that already happened, refuses any claim it cannot cite, and prices each surviving
demand cluster in real dollars. Three moves no request-collection tool makes: grounding refusal (an
asserted belief without a citable source is discarded rather than smoothed into plausible narrative),
dollar attribution (clusters resolved through golden ids so twelve mentions from three accounts count
as three, then priced by pipeline at risk, account revenue, and support hours consumed), and the
deflection test (retrieve the knowledge base before anything enters the roadmap, and route satisfiable
clusters to enablement with the citation that proves it). *"Every product-request tool ever built
starts by asking someone to file the request, which is why the corpus is always a biased fraction of
what customers said. Beckon has no intake surface at all."*

**Buzz (Seat G)** - Find out what AI assistants tell a buyer who asks "who should I hire for this,"
then fix the specific gap and prove the fix worked. Runs a scheduled panel of buyer-intent prompts
across the org's configured LLM providers, extracts entity-resolved mentions of the firm and its
competitors, and scores share of answer, sentiment, factual-error rate against a ground-truth fact
sheet, and which sources the model cited. Then closes the loop: each gap is attributed to a fixable
substrate, the remediation is drafted for a human, and after it ships Buzz re-runs the identical panel
and reports the delta. *"The measurement instrument and the product are the same thing; the data does
not exist until Buzz generates it by probing a system you do not control, and the output is a
controlled before/after experiment rather than a chart."*

## Phase 4 - Overlap resolution

### Step 1: near-duplication screen against the shipped 24

Each submission was screened against the existing suite before any pairwise comparison. **All seven
survived.** None is a second CRM, knowledge base, analytics layer, contract monitor, or ticketing
system:

| Submission | Closest shipped app | Verdict |
| --- | --- | --- |
| Badge | Bam's `/b3/people` (a member-admin screen for one app, no lifecycle concept, no cross-app ownership) | Different category: lifecycle execution |
| Bevy | Bond (a pipeline for revenue) | Different category: a pipeline for capacity; no app holds a candidate |
| Bulletin | Bond (records interactions that occurred) | Different category: its unit is the interaction that did not occur |
| Beeline | Book (sells time slots against stated availability) | Different category: asserts capability and blocks work |
| Bastion | Bulwark (obligations under a signed contract) and `agent_policies` (a config surface) | Different category: internal control adjudication, inputs are DB and permission state, not PDFs |
| Beckon | Bam (executes work already decided) | Different category: intake and prioritization upstream of the tracker |
| Buzz | Bench (charts data you own), Blip (observes your own logs) | Different category: probes a system you do not control and manufactures the data |

No submission was cut for near-duplication.

### Step 2: pairwise comparison

Six of the seven are mutually distinct. Adjacencies worth noting but not requiring merge:

- **Bevy and Badge** are both people-shaped but disjoint by explicit scope: Bevy ends at accepted
  offer and excludes onboarding runbooks; Badge begins at joiner and excludes recruiting.
- **Bulletin and Beckon** both read unstructured cross-app signal, but their outputs share nothing:
  a per-stakeholder belief gap versus a priced demand cluster.

**One genuine collision: Badge (A) vs Bastion (E).** Bastion's scope-in list contains "Joiner-mover-leaver
runbooks as the remediation actuator, cross-app, HITL-gated," which is Badge's core mechanism. The seats
had disagreed about this on the record, with Seat F arguing for a clean split at the point of grant and
Seat E arguing that separating find-the-problem from fix-the-problem yields "a worse product twice." A
merge negotiation was opened between exactly those two seats under the 10-turn rule.

_(Negotiation transcript and outcome recorded below.)_

## Phase 4 - Overlap resolution

_(pending)_

## Phase 5 - Voting

_(pending)_

## Phase 6 - Spec hardening

_(pending)_
