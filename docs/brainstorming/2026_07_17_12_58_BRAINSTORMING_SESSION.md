# Suite Brainstorm Session - 2026_07_17_12_58

**Purpose:** Select the next app the BigBlueBam suite should build, via a
competitive five-seat brainstorming protocol (ideate -> debate -> submit ->
overlap/merge -> vote), then produce a hardened design spec for the winner.

**Format:** Five stateful "ideator" seats, each on a distinct innovation lens,
each proposing five candidate apps. Seats never talk directly; the orchestrator
relays every inter-seat message. Chief goals: innovation and customer fit, in an
AI-native, adjacent-not-redundant direction.

**Seat lenses:**

| Seat | Lens |
|------|------|
| A | AI-native automation & autonomous agent workflows |
| B | Data, intelligence & analytics |
| C | Communication, collaboration & community |
| D | A vertical / industry wedge |
| E | Operator / developer experience & platform tooling |

---

## Phase 1 - Initial proposals

**Orchestrator note:** All five seats returned five apps. Early cross-seat
signals worth tracking into debate/overlap: (1) a strong collision between
Seat A's **Bulwark** (Agent Oversight & Trust Console) and Seat E's **Bailiff**
(Agent Operations Control Room) - both are a human governance/mission-control
surface over the agent fleet; (2) partial overlap on shadow/dry-run execution
between Seat A's **Backstop** and the dry-run parts of E's Bailiff/Bespoke;
(3) three separate "Bulwark" names in play (A = agent oversight, B = data-quality
auditor, plus D and E used Bulwark as a name-option), and "Bracket"/"Bedrock"/
"Baton"/"Beam"/"Brace"/"Badge" each appear across seats as either titles or
name-options. Names are not yet locked; ideas matter, not labels.

### Seat A - AI-native automation & autonomous agent workflows

### Brigade - Autonomous Mission Control
- **Names:** Brigade · Bevy · Batch
- **One-line pitch:** Give the suite a goal in plain language and a team of AI agents plans, executes, and self-corrects the multi-step work across every app until it's done.
- **Description:** Where Bolt is a trigger->condition->action rules engine, Brigade is goal-directed: it decomposes an objective ("onboard this new client end-to-end") into a live plan DAG, assigns steps to specialist agents over the 804-tool MCP catalog, and runs a plan->execute->observe->replan loop with HITL checkpoints on risky steps. Every action is a proposal that flows through the existing approval queue; the plan re-plans when a step fails or reality drifts, instead of dead-ending like a static automation.
- **Scope (in):** natural-language mission intake; editable plan DAG; per-step agent assignment via MCP; live run timeline with pause/resume/intervene; HITL approval gates on destructive/spend actions; automatic replan-on-failure; mission templates.
- **Scope (out):** no new low-level trigger rules (Bolt keeps those); no model training/fine-tuning; not a chat UI - it's a mission board, not a copilot.
- **Why build it:** Wedge is **speed + integration** - SMB teams have cross-app outcomes ("close the month," "recover churned accounts") that today require a human to babysit ten apps. No competitor orchestrates goal-directed agents *over an already-integrated suite with a shared permission/audit spine*; generic agent frameworks (LangGraph, CrewAI) start from zero integration and zero governance.
- **Reuses:** MCP tool catalog (804 tools), agent_proposals/approval queue, agent_policies kill-switch + allowlist, agent_runners/heartbeat, Bolt events, visibility preflight (can_access), RLS/permissions, unified activity view.
- **Lens fit:** The purest expression of autonomous multi-agent orchestration - agents doing real cross-suite work toward a goal, not reacting to triggers.

### Backstop - Agent Rehearsal Sandbox
- **Names:** Backstop · Bunker · Bumper
- **One-line pitch:** Before an autonomous agent touches your real data, it rehearses the whole plan against a shadow copy of your org and hands you a reviewable diff to approve or reject.
- **Description:** Backstop stands up an ephemeral copy-on-write mirror of the relevant slice of org data, lets an agent execute its full plan against the mirror, then presents the exact set of writes (rows created/changed, emails that *would* send, invoices that *would* post) as a single approvable changeset. Approve and it replays the identical tool calls against production inside a transaction-scoped run; reject and nothing ever happened. The AI-native part is faithful side-effect capture and replay of MCP tool sequences plus a semantic diff of intended vs. actual state.
- **Scope (in):** scoped shadow snapshot; dry-run execution harness intercepting MCP writes; human-readable changeset diff; one-click promote-to-prod replay; blast-radius report; per-tool "simulate vs. live" registry.
- **Scope (out):** not a full staging environment; no time-travel of historical prod state; doesn't sandbox external side effects it can't intercept (declares them instead).
- **Why build it:** Wedge is **trust** - the single biggest blocker to letting agents act autonomously in an SMB is "what if it wrecks my CRM." Nobody offers rehearse-then-diff-then-replay for agent actions over a real business suite; it converts skeptics into adopters and de-risks Brigade.
- **Reuses:** @bigbluebam/storage COW/snapshots, MCP internal /tools/call interception, confirm_action token flow, RLS org scoping, agent audit, Bolt event capture.
- **Lens fit:** Autonomy needs a safety substrate - this is the trust layer that makes hands-off agent execution defensible.

### Bylaw - SOP-to-Agent Compiler
- **Names:** Bylaw · Beckon · Bidding
- **One-line pitch:** Paste your written standard-operating-procedure and Bylaw compiles it into a supervised autonomous agent that runs the procedure on demand and adapts when steps don't match reality.
- **Description:** SMBs keep their real operating knowledge in Notion/Google-Doc SOPs that nobody executes automatically. Bylaw parses a procedure document into a typed, tool-bound executable skill - mapping each written step to concrete MCP calls, inferring parameters, and inserting decision points - then runs it as a callable agent that logs each step back against the source SOP. When a step can't be satisfied, it proposes an amendment to the SOP itself, so the doc and the automation stay in sync.
- **Scope (in):** SOP import (Brief/Beacon docs, paste, upload); step->tool compilation with confidence flags; parameter inference + gap prompts; runnable skill catalog; execution trace mapped line-by-line to the SOP; suggested SOP edits.
- **Scope (out):** doesn't author SOPs from scratch; no free-form long-horizon planning (that's Brigade); not a doc editor (Brief/Beacon own that).
- **Why build it:** Wedge is **cost + speed** - turns dormant tribal-knowledge docs into running automation with zero low-code building. Competitors make you rebuild the process in a visual builder; Bylaw executes the doc you already wrote.
- **Reuses:** Brief/Beacon retrieval + Qdrant, MCP tool catalog + schemas, agent_policies allowlist, proposals for HITL gaps, entity_links, Bolt events.
- **Lens fit:** Converts human procedural knowledge directly into autonomous agent behavior - natural language becomes executable agency.

### Badger - Autonomous Open-Loop Closer
- **Names:** Badger · Beagle · Bloodhound
- **One-line pitch:** A persistent agent that owns every unclosed loop in your business - unanswered emails, stalled deals, overdue invoices, pending approvals - and works each one to resolution over days without being reminded.
- **Description:** Badger continuously scans cross-app state for open loops (Bond deals gone quiet, Bill invoices overdue, Helpdesk tickets awaiting reply, Book no-shows) and owns each as a standing objective, taking multi-turn action over time: drafting and sending the follow-up, rescheduling, escalating to a human, or closing it out. Unlike a reminder/automation, it reasons about *what* the right next move is per loop and adapts its cadence based on responses. It reports its beat like a teammate in Banter.
- **Scope (in):** cross-app open-loop detector; per-loop objective tracking with state machine; autonomous multi-turn follow-through with guardrails; escalation to humans on ambiguity; daily "what I chased and closed" digest; per-loop confidence + spend caps.
- **Scope (out):** doesn't invent new outreach targets (works existing loops only); no cold outreach (Blast owns campaigns); not analytics dashboards (Bench).
- **Why build it:** Wedge is **no-good-solution-today** - "nothing falls through the cracks" is normally sold as reminders that dump work back on humans. Badger actually *does* the chasing autonomously across an integrated suite. Beats reminder tools on the axis of who does the work.
- **Reuses:** unified activity view, Bond/Bill/Helpdesk/Book APIs via MCP, Blast/email send, Banter posting, agent_policies + proposals, outbound webhooks, Bolt events.
- **Lens fit:** A standing autonomous worker with its own beat - semi-autonomous agents doing real recurring work, not one-shot tasks.

### Bulwark - Agent Oversight & Trust Console
- **Names:** Bulwark · Bastion · Bridle
- **One-line pitch:** A live command center where a human supervises every autonomous agent in the org - watch actions stream, intervene mid-run, kill a misbehaving agent, replay any incident, and see a trust score per agent.
- **Description:** As Brigade/Badger/Bylaw put more agents to work, someone needs a single pane to govern them. Bulwark streams every agent action in real time with its justification and can_access provenance, lets a supervisor pause/step-in/kill any run, and computes a rolling trust score per agent from approval-override rate, failed steps, and reversed actions. It surfaces the platform's existing agent_policies, audit, and heartbeat primitives as an operator cockpit and auto-tightens allowlists when an agent's trust drops.
- **Scope (in):** live agent-action feed with reasoning + entity provenance; intervene/pause/kill controls; per-agent trust scoring; incident replay from audit trail; policy/allowlist editor with auto-throttle on anomalies; agent roster + heartbeat health.
- **Scope (out):** doesn't define or run missions (Brigade); doesn't author policies from scratch beyond what agent_policies supports; not general log observability (Blip owns app telemetry).
- **Why build it:** Wedge is **trust + governance** - the thing that lets a wary SMB owner actually deploy autonomous agents. It's the SOC/mission-control for agents; no suite ships a human-facing trust console over its own agent fleet.
- **Reuses:** agent_policies kill-switch/allowlist + Redis invalidation, agent_audit/self_report, agent_runners/heartbeat, bolt_event_trace/observability, confirm_action, RLS, unified activity.
- **Lens fit:** Autonomy at scale demands oversight - the governance surface that keeps a fleet of working agents accountable and safe.

### Seat B - Data, intelligence & analytics

### Basis
- **Names:** Basis · Baseline · Bedrock
- **One-line pitch:** A governed metric layer that gives every number in the suite one trusted definition and then explains, in plain language, *why* it moved.
- **Description:** Basis is a semantic layer where you define metrics once (revenue = Bill paid invoices minus refunds, pipeline = Bond open deals by stage) and every app, chart, and agent reads the same certified definition. Its AI core does automatic contribution/driver analysis: when a metric shifts, it decomposes the delta across dimensions and correlates it to concrete cross-app events, returning "MRR fell 8% because 3 enterprise deals in Bond slipped from Won and 2 Bill invoices went overdue," each with a drill-down link.
- **Scope (in):** metric definition catalog with owners/lineage; NL "why did X change" causal decomposition; driver ranking by contribution; certified-metric badges Bench widgets can bind to; Bolt event on definition change.
- **Scope (out):** no chart rendering (Bench does that); no dashboards; no data warehousing/ETL of external sources in v1.
- **Why build it:** SMBs get contradictory numbers from Bench, Bond, and Bill and no one can say why a KPI moved without a manual afternoon of pivot-table archaeology. Axis: **trust + speed** - one definition of truth plus instant root-cause that no BI tool the size of a small team can afford.
- **Reuses:** Bench (binds certified metrics to widgets), Bolt events, `search_everything`/`v_activity_unified` for driver correlation, MCP catalog, RLS, `entity_links`.
- **Lens fit:** Turns scattered app data into one governed semantic truth plus causal explanation - pure decision intelligence.

### Bellwether
- **Names:** Bellwether · Barometer · Bode
- **One-line pitch:** Forecasts any suite metric and warns you before it breaks, weeks ahead of a dashboard.
- **Description:** Bellwether trains lightweight time-series and driver models on your own suite history - Bond pipeline, Bill cash flow, Helpdesk ticket volume, Bam sprint burn - and produces forward forecasts with confidence bands plus automated change-point and anomaly detection. When a metric is trending toward a threshold or breaks its seasonal pattern, it fires a Bolt event so Bolt/Banter can route the alert, turning passive charts into a predictive early-warning system.
- **Scope (in):** per-metric forecasting with confidence intervals; anomaly + change-point detection; "on track to miss/breach" threshold projection; Bolt `metric.forecast_breach` / `metric.anomaly` events; backtest accuracy display.
- **Scope (out):** no manual budgets/targets authoring (reads Bearing KRs); no external market data; no prescriptive "what to do" (Basis/Bracket territory).
- **Why build it:** Bench and Bearing tell you where you *are*; nobody in the SMB tier gets a running forecast of where they're *headed* without a data scientist. Axis: **prediction** - a capability the suite has zero of today.
- **Reuses:** Bench data-source query layer, Bearing KRs for thresholds, Bolt events, worker (BullMQ scheduled retrain/forecast), Qdrant optional, RLS.
- **Lens fit:** Predictive intelligence over the suite's own time-series - forecasting the suite cannot do now.

### Braid
- **Names:** Braid · Beam · Nexus
- **One-line pitch:** Resolves every contact, company, deal, ticket, task, and doc across all apps into one queryable knowledge graph you can ask questions of.
- **Description:** Braid runs entity resolution across the suite - the same customer scattered as a Bond company, Bill payer, Helpdesk requester, and Board comment becomes one node - and builds a typed relationship graph on top of `entity_links`. Its AI core is graph-grounded retrieval: ask "which paying customers have an open Helpdesk escalation and a slipping Bond renewal?" and it traverses resolved entities plus semantic search to answer with citations, something neither keyword search nor a vector KB can do alone.
- **Scope (in):** cross-app entity resolution + merge review; typed relationship graph; NL graph query with `can_access` visibility filtering; graph explorer UI; MCP `graph_query` tool.
- **Scope (out):** not a KB editor (Beacon owns articles); no manual graph authoring; no external data import in v1.
- **Why build it:** Beacon vector-searches documents; nobody has an entity-resolved operational graph of their *own* business. Axis: **integration/trust** - answers relational questions across apps that are impossible today without exporting everything to a warehouse.
- **Reuses:** `entity_links`, `resolve_references`, `search_everything`, Qdrant, visibility preflight `can_access`, dedupe primitives, RLS, MCP catalog.
- **Lens fit:** Semantic + structural intelligence - unifying fragmented data into one reasoning-ready graph.

### Bracket
- **Names:** Bracket · Brink · Boardroom
- **One-line pitch:** A what-if simulator that runs business scenarios against your real suite data and tells you the likely outcome.
- **Description:** Bracket lets a team model decisions - "hire two reps," "raise price 10%," "cut sprint scope 20%" - as scenarios wired to live suite data: Bond conversion rates, Bill revenue and burn, Bam team capacity. It runs Monte Carlo projections over historical distributions and returns ranged outcomes plus an LLM narrative that explains the drivers and the risk, replacing the fragile spreadsheet nobody trusts.
- **Scope (in):** scenario builder over suite metrics; assumption sliders; Monte Carlo outcome ranges; LLM narrative + sensitivity ("most sensitive to churn"); save/compare scenarios; share link.
- **Scope (out):** no accounting/GL (Bill owns money-of-record); no forecasting engine of its own (consumes Bellwether if present); no external financial modeling templates.
- **Why build it:** SMB planning happens in brittle spreadsheets with hand-typed assumptions and no probability. Axis: **no good solution today** - grounded, probabilistic decision support at a team's price point.
- **Reuses:** Bench queries, Bond/Bill/Bam data, Bellwether forecasts (if built), worker for simulation jobs, MCP catalog, RLS.
- **Lens fit:** Decision-support simulation on real data - turning intelligence into forward choices.

### Bulwark (Seat B)
- **Names:** Bulwark · Burnish · Trueup
- **One-line pitch:** A continuous AI auditor that scores the health of your business data and flags duplicates, staleness, gaps, and cross-app contradictions before they cost you.
- **Description:** Bulwark watches every app's data and computes a live "data health" score, surfacing entity duplicates, stale records, missing required fields, and contradictions across apps (a Bond deal marked Won with no Bill invoice; a Helpdesk contact with a different company than Bond). Its AI core clusters and ranks issues by business impact and proposes fixes as reviewable proposals, so bad data gets caught and corrected instead of silently poisoning every report and forecast.
- **Scope (in):** cross-app data-quality rules + AI-detected anomalies; impact-ranked issue queue; duplicate/contradiction detection; fix proposals via `agent_proposals`; per-app + org health score; Bolt `data.issue_detected` events.
- **Scope (out):** no schema migrations; not a general validation framework for app forms (Blank owns forms); no auto-apply without approval in v1.
- **Why build it:** Every downstream insight, forecast, and agent decision is only as good as the data, and SMB teams have no data-quality tooling at all. Axis: **trust** - the foundation layer that makes Basis, Bellwether, and Braid believable.
- **Reuses:** `dedupe_decisions`/dedupe primitives, `agent_proposals`, `entity_links`, `search_everything`, Bolt events, worker sweeps, RLS.
- **Lens fit:** Data-quality intelligence - the trust substrate under all analytics.

### Seat C - Communication, collaboration & community

### Bevy - AI community & Q&A that answers itself
- **Names:** Bevy · Bulletin · Burrow
- **One-line pitch:** A branded customer community forum where AI agents draft grounded answers, dedupe questions, and route the hard ones to your real experts.
- **Description:** An external-facing community/help forum (think Discourse/Circle) that is agent-operated by construction: every new question is embedded, checked against past threads and Beacon articles, and answered by an agent with a cited draft that a human can one-click endorse. Unanswered or low-confidence threads are routed to the internal expert via `expertise_for_topic`, and every resolved thread is proposed back into Beacon so the knowledge base compounds instead of rotting.
- **Scope (in):** public/gated community spaces, threaded posts + reactions, agent auto-draft with citations, human endorse/override, dedupe-on-post, expert routing, resolved-thread -> Beacon proposal.
- **Scope (out):** internal team chat (that's Banter), email newsletters (Blast), private 1:1 support tickets (Helpdesk).
- **Why build it:** The suite has no external audience surface; small teams pay for Discourse/Circle *plus* a separate AI answer bot and still babysit both. Bevy beats them on **trust + maintenance cost** - answers are grounded in the org's own Beacon knowledge with visible citations, and the community feeds knowledge back automatically.
- **Reuses:** Qdrant retrieval + Beacon, `expertise_for_topic`, dedupe primitives, `can_access` visibility, Banter reactions, `beacon_upsert_by_slug`, Bolt events, auth/RLS/permissions.
- **Lens fit:** Community - how a team's audience talks to it and to each other, with AI as the always-on first responder.

### Baton - meetings that write themselves into the rest of the suite
- **Names:** Baton · Byline · Bridge
- **One-line pitch:** An AI that sits in any live call, and instead of dumping a transcript, files the decisions, action items, and follow-ups directly into Bam, Bond, and Bearing.
- **Description:** Baton is a meeting-intelligence layer over the suite's existing LiveKit surfaces (Board, Bureau, Banter calls). It transcribes live, then an agent extracts a structured record - decisions, owners, due dates, blockers - and executes it through the MCP write plane: tasks upserted in Bam, deal notes on Bond, key-result nudges in Bearing, a decision record filed. It closes the loop by DMing each owner their commitments and tracking whether they land.
- **Scope (in):** live transcription capture, decision/action/owner extraction, cross-app write-back via MCP, per-owner commitment digest, searchable meeting records, HITL confirm before mutating.
- **Scope (out):** hosting the call itself (Board/Bureau/Banter already do), scheduling (Book), raw video storage beyond a Bin pointer.
- **Why build it:** Otter/Fireflies stop at a transcript and a summary; the human still re-types everything into their tools. Baton wins on **integration** - it's the only meeting agent with first-class MCP authority over the same suite where the work actually lives, so a decision in a call becomes a task in seconds.
- **Reuses:** LiveKit, `voice-agent` STT, Banter call-transcript pipeline, MCP write plane (`task_upsert_by_external_id`, `bond_upsert_contact`), proposals/HITL, Bolt.
- **Lens fit:** Collaboration - turning the highest-bandwidth channel (talking) into durable, routed shared work.

### Beam - async video/voice messages that become actionable objects
- **Names:** Beam · Byte · Bobbin
- **One-line pitch:** Record a screen or voice message once; AI turns it into a chaptered, searchable, task-generating artifact - and can re-cut personalized versions per recipient.
- **Description:** A Loom-style async messaging app made AI-native: on record, an agent transcribes, auto-titles, chapters, and extracts any "asks" into draft tasks or replies. Its wedge move is generative personalization - record one product walkthrough and Beam produces per-recipient variants (name, use-case emphasis, trimmed sections) so a founder can "async broadcast" without recording ten takes.
- **Scope (in):** screen/cam/voice capture, auto transcript + chapters + summary, ask-to-task extraction, per-recipient generated variants, view/engagement signals, embed links.
- **Scope (out):** live conferencing (Board/Bureau), long-form hosting/DAM (Bin owns the bytes), email sends (Blast).
- **Why build it:** Loom has no real AI and no suite integration; small teams use it to reduce meetings but then lose the content in a video graveyard. Beam beats it on **speed + integration** - one recording fans out to many tailored recipients and drops straight into the suite as tasks and searchable text.
- **Reuses:** Bin storage/transcode, `voice-agent` STT, MCP task write plane, `bin-transcode` worker, Bolt, storage presign.
- **Lens fit:** Communication - high-bandwidth async messaging that scales one voice to many audiences.

### Ballot - async decision-making with an AI facilitator
- **Names:** Ballot · Behest · Verdict
- **One-line pitch:** Structured decision threads where an AI facilitator synthesizes the arguments, detects consensus or the real blocker, and produces a signed, auditable decision record.
- **Description:** A dedicated home for decisions that today rot across Slack threads and doc comments. A proposer opens a decision with options; participants argue async; an agent continuously summarizes positions, clusters objections, flags who hasn't weighed in, and proposes when consensus (or a clean disagree-and-commit) is reached - then mints an immutable decision record linked to the work it governs. This is human governance, distinct from the platform's internal agent-approval queue.
- **Scope (in):** decision docs with options, threaded positions/objections, AI position-synthesis + consensus/blocker detection, quorum/stakeholder tracking, signed decision records, entity links to affected tasks/deals/docs.
- **Scope (out):** agent-action approvals (`agent_proposals` already covers that), general docs (Brief), project boards (Bam).
- **Why build it:** There is genuinely **no good tool** for team decision records; Slack forgets, docs bury it, and nobody can later reconstruct *why*. Ballot wins on **trust** - every decision is synthesized, attributed, and permanently retrievable, with the AI doing the thankless job of reading the whole thread.
- **Reuses:** Brief editor primitives, Banter threading/reactions, `entity_links`, activity log (append-only audit), `can_access`, Bolt, LLM synthesis.
- **Lens fit:** Collaboration & community - the connective tissue that turns discussion into committed, remembered group choices.

### Bullhorn - live audience events with an AI co-host
- **Names:** Bullhorn · Backstage · Broadcast
- **One-line pitch:** Run a live webinar or town hall where an AI co-host clusters the audience's questions in real time, drafts grounded answers, and turns the whole event into follow-up.
- **Description:** A live broadcast/event app for reaching an audience at scale, where the AI is the producer: it de-duplicates and clusters an unbounded Q&A firehose into the handful of questions actually worth asking, feeds the host a live cue card with Beacon-cited draft answers, and after the event auto-generates a highlight reel, a recap, and a segmented follow-up handed to Blast. Attendee questions and interest signals flow into Bond.
- **Scope (in):** live streamed session (host + panel), scalable audience Q&A with AI clustering/dedupe, live cue cards with cited answers, post-event highlight reel + recap, follow-up handoff to Blast/Bond.
- **Scope (out):** small-group internal meetings (Board/Bureau/Baton), 1:1 scheduling (Book), the email send itself (Blast owns delivery).
- **Why build it:** Zoom Webinar/StreamYard give you a stream and a chat you can't keep up with; small teams drown in audience Q&A and drop the follow-up entirely. Bullhorn wins on **integration + audience scale** - AI makes a two-person team run like a webinar production crew, and the event doesn't die when the stream ends.
- **Reuses:** LiveKit SFU, Bin storage/transcode for reels, Beacon retrieval, Blast for follow-up, Bond for attendee capture, dedupe primitives, Bolt.
- **Lens fit:** Community & reaching audiences - one-to-many live communication with AI as the crew that makes it scale.

### Seat D - Vertical wedge (field services / skilled trades)

### Brace
- **Names:** Brace · Bracket · Snapfix
- **One-line pitch:** A field tech photographs or films the broken equipment and gets an AI-diagnosed fault, repair scope, and priced estimate before leaving the truck.
- **Description:** The tech captures a short clip or photos on-site; a vision model identifies the make/model/nameplate, reads serial and error codes, cross-checks against a repair-pattern corpus, and returns a ranked list of probable faults with the parts, labor hours, and a line-item estimate. The mechanism is multimodal diagnosis grounded in the customer's own equipment history plus a trade-specific fault library, not a generic chatbot.
- **Scope (in):** on-site multimodal capture (photo/video/voice note); OCR of nameplates/error codes; fault ranking with confidence; auto-built estimate lines pushed to Bill; job-photo attachment to the customer record in Bond.
- **Scope (out):** it does not do invoicing/payment (Bill), scheduling (Book), or generic CRM (Bond); no consumer-facing marketplace.
- **Why build it:** Field services / skilled trades (HVAC, appliance, plumbing). Incumbents (ServiceTitan, Housecall Pro) are $200-400/tech/mo CRUD with no real diagnosis; a junior tech still guesses. Axis: **speed + trust** - first-visit-fix rate and estimate-at-door with a defensible AI diagnosis no generic FSM tool offers.
- **Reuses:** Bin/Bay (media capture + review), storage, Qdrant vectors, Bill (estimate lines), Bond (customer/equipment), MCP tools, auth/RLS.
- **Lens fit:** Pure trades workflow - the diagnostic moment at the equipment - that no horizontal app in the suite touches.

### Bedrock (Seat D)
- **Names:** Bedrock · Bailiwick · Sitemind
- **One-line pitch:** A living per-site equipment memory that remembers every asset, warranty, and past repair at a property and briefs the next tech before they arrive.
- **Description:** Every service visit writes structured facts (asset, serial, install date, warranty window, prior symptoms, parts used) into a per-site knowledge graph. When a new job is booked at that address, an agent auto-generates a pre-visit brief: what's installed, what failed before, what's still under warranty, and what to bring. The AI mechanism is retrieval over an entity-resolved site graph, so recurring truck-rolls stop starting from zero.
- **Scope (in):** site/asset graph with entity resolution; warranty-clock tracking with expiry alerts via Bolt; auto pre-visit brief; MCP tools so agents can query "what's at 14 Coconut Rd."
- **Scope (out):** not a diagnosis engine (Brace) and not scheduling (Book); no accounting.
- **Why build it:** Field services / property maintenance. Today this knowledge lives in a tech's head or scattered PDFs; churn destroys it. Axis: **integration + trust** - institutional site memory that reduces repeat diagnostics and catches warranty coverage competitors let lapse.
- **Reuses:** Beacon (knowledge/graph + Qdrant), Bond (companies/sites), Bolt (warranty-expiry events), entity_links, MCP catalog, RLS.
- **Lens fit:** Asset-history graph specific to service verticals; generic knowledge bases don't model recurring physical sites.

### Beeline
- **Names:** Beeline · Berth · Dispatch
- **One-line pitch:** An AI dispatcher that reads every inbound job request and auto-assigns the right tech by skill, location, parts-on-hand, and SLA - and re-optimizes the day when a job runs long.
- **Description:** Incoming requests (from Blank forms, Helpdesk, or the voice agent) are parsed into structured jobs; a dispatch agent scores each open tech against skill match, drive-time, truck inventory, and promised windows, then proposes assignments a human can accept or override. When a morning job overruns, it re-sequences the remaining board and notifies affected customers. The mechanism is continuous constraint-solving over live field state, not a static calendar.
- **Scope (in):** intake parsing to structured jobs; skill/geo/parts-aware assignment proposals; live re-optimization on overrun; customer ETA notifications; proposal queue for human approval.
- **Scope (out):** not the calendar UI itself (leans on Book) and not routing hardware/GPS trackers; no payroll.
- **Why build it:** Field services with multiple techs. Small shops dispatch by whiteboard and gut; enterprise routing suites are unaffordable. Axis: **cost + speed** - autonomous dispatch for 2-50-tech shops priced far below ServiceTitan's dispatch tier.
- **Reuses:** Book (scheduling substrate), Blank (intake), voice-agent, Bolt (events), agent proposals (§9), book_find_meeting_time, MCP, RLS.
- **Lens fit:** Multi-tech field dispatch is a trades-specific optimization problem, distinct from generic meeting scheduling.

### Badge
- **Names:** Badge · Bulwark · Inspecta
- **One-line pitch:** Guided AI inspections that turn photos and a walkthrough into a code-referenced, pass/fail report with flagged violations in minutes.
- **Description:** The inspector follows an adaptive checklist that branches on what the AI sees; each item is backed by captured photo/video evidence, and a model flags likely code violations with the specific reference and remediation. It compiles a client-ready report and a re-inspection punch list automatically. The mechanism is vision-grounded evidence capture plus retrieval over the applicable code/standard set, not a static form.
- **Scope (in):** adaptive checklist templates per trade/jurisdiction; evidence capture with AI violation flags + code citations; auto-generated report PDF; punch list feeding follow-up jobs.
- **Scope (out):** not generic form-building (Blank) and not legal certification of code correctness; no permit-office filing integration in v1.
- **Why build it:** Trades/property inspections (electrical, home, rental compliance). Existing inspection apps are dumb form fillers; the code lookup and violation judgment stay manual. Axis: **speed + trust** - defensible, evidence-linked reports produced on-site instead of that evening at a desk.
- **Reuses:** Blank (form/logic engine), Bay (annotated media review), Bin (evidence storage), Beacon (code corpus retrieval), Bill (remediation quotes), MCP, RLS.
- **Lens fit:** Jurisdictional code inspection is a vertical workflow no horizontal form tool encodes.

### Bushel
- **Names:** Bushel · Bundle · Restock
- **One-line pitch:** A truck-inventory agent that predicts the parts each tech needs for tomorrow's jobs, auto-reorders low stock, and files warranty claims from used-parts logs.
- **Description:** It tracks per-truck part stock, then reads tomorrow's assigned jobs (from Beeline/Book) and the site history (Bedrock) to predict likely parts consumption, generating a nightly restock list and auto-reorder proposals against supplier catalogs. When a warranty-covered part is consumed, it drafts the claim from the captured evidence. The mechanism is demand forecasting over the scheduled job graph plus warranty-eligibility reasoning.
- **Scope (in):** per-truck stock ledger; job-driven parts forecast; reorder proposals; warranty-claim drafting from used-part + evidence; low-stock Bolt alerts.
- **Scope (out):** not a full ERP/procurement system and not supplier payment; no barcode-hardware requirement (photo/manual count fallback).
- **Why build it:** Field services parts logistics. Techs miss jobs for want of a $12 part; warranty dollars go unclaimed. Axis: **cost** - fewer return trips and recovered warranty revenue, a spend line generic FSM tools ignore.
- **Reuses:** Bin (structured-data ledger), Beeline/Book (job schedule), Bedrock (warranty data), Bill (claims/credits), Bolt (stock alerts), worker (nightly forecast), MCP, RLS.
- **Lens fit:** Van-stock forecasting tied to a live job board is a trades-specific supply problem, not generic inventory.

### Seat E - Operator / developer experience & platform tooling

### Bailiff - Agent Operations Control Room
- **Names:** Bailiff · Baton · Bridle
- **One-line pitch:** A live control room that watches every AI agent operating your suite, flags misbehavior in real time, and lets an operator replay, dry-run, or quarantine any agent with one click.
- **Description:** Bailiff runs a supervisor agent over the `agent_audit`/heartbeat/`agent_proposals` streams and the 804-tool MCP catalog, learning each agent's normal tool-call fingerprint (which tools, at what rate, against which entities, at what cost) and raising anomalies when an agent drifts, loops, escalates privilege, or burns budget. Operators get a per-agent timeline, a "why did it do this" causal trace stitched from Bolt events, and a dry-run sandbox that re-executes a proposed agent plan against a shadow context before it touches real data. It is the governance layer above `agent_policies` - not just a kill switch, but the system that tells you *when* to pull it.
- **Scope (in):** cross-agent activity timeline; behavioral-baseline anomaly detection; per-run cost/token attribution; one-click quarantine (writes an `agent_policies` kill switch); plan dry-run/replay against shadow state; anomaly-to-`agent_proposals` HITL routing.
- **Scope (out):** authoring agents or workflows (that's Bolt); app/infra log observability (that's Blip); no model hosting or prompt IDE.
- **Why build it:** SMB teams are turning agents loose across 20 apps with a kill switch and an audit log but no way to *see* misbehavior before it costs money or data - the axis is **trust + cost control at agent scale**, which no incumbent (Datadog, LangSmith) covers across a governed multi-app tool catalog.
- **Reuses:** `agent_audit`/identity/heartbeat, `agent_policies` (writes kill switches), `agent_proposals` (HITL), Bolt observability (`bolt_event_trace`), MCP tool catalog, `can_access` preflight, Bench-style dashboards.
- **Lens fit:** Pure operator experience - the mission control for the humans responsible for the agents running the platform.

### Bespoke - Self-Extending Tool & Connector Forge
- **Names:** Bespoke · Brace · Forge
- **One-line pitch:** Describe a tool or an external integration in plain language and Bespoke generates it, sandbox-tests it against real endpoints, and publishes it into the MCP catalog under policy - no code deploy.
- **Description:** Bespoke turns the 804-tool catalog from a ship-code-to-extend surface into a self-service one: an authoring agent drafts the tool schema and a handler bound to existing REST endpoints (or an outbound HTTP connector to Stripe/GitHub/Slack), runs it in an isolated sandbox with synthetic and shadow data, diffs the output against the operator's stated intent, then registers it with an `agent_policies` allowlist entry and a Bolt-catalog event stub. Versioning, rollback, and a "who can invoke this" gate are first-class.
- **Scope (in):** NL-to-tool schema+handler generation; sandbox execution with shadow data; external connector scaffolding (auth, pagination, mapping); version/rollback; auto-registration into `agent_policies` allowlists and the Bolt catalog.
- **Scope (out):** not a general low-code app builder; not internal workflow orchestration (Bolt); does not host third-party marketplace tools.
- **Why build it:** Extending an agent platform today means a developer, a PR, and a deploy; Bespoke wins on **speed + integration** by letting operators safely mint governed tools/connectors in minutes, which is the difference between a static catalog and a living one.
- **Reuses:** MCP tool catalog + `register-tool` policy middleware, `agent_policies` allowlists, outbound webhooks/SSRF guards, Bolt event catalog + drift guard, sandbox against existing REST APIs, permissions plugin.
- **Lens fit:** Developer/integrator experience - the extensibility studio for the suite's own tool surface.

### Bastion - Least-Privilege & Access-Review Copilot
- **Names:** Bastion · Bulwark · Badge
- **One-line pitch:** An AI that watches how permissions are actually used across humans and agents, then proposes exactly which grants to revoke to reach least privilege - as reviewable diffs, not a spreadsheet.
- **Description:** Bastion mines `activity_log`, `agent_audit`, and the `app.resource.verb` permission catalog to build a real-usage graph per identity, spots over-provisioned humans, agents, and service accounts (granted X, never used X in 90 days; agent allowlist wider than its behavior), and emits tightening recommendations as `agent_proposals` carrying concrete RLS/`agent_policies` diffs an operator approves or rejects. It also runs "what breaks if I revoke this" blast-radius simulation before any change lands.
- **Scope (in):** per-identity usage-vs-grant graph; over-privilege detection for human/agent/service accounts; least-privilege diff generation (permissions + `agent_policies` + RLS); revoke blast-radius simulation; scheduled access-review campaigns with sign-off.
- **Scope (out):** not an IdP/SSO or auth provider (OAuth already exists); not runtime enforcement (that's the permissions plugin/RLS it recommends *to*).
- **Why build it:** SMBs can't staff a security team but now carry dozens of agents and service accounts with static, over-broad grants - the axis is **trust/compliance made cheap**, delivering SOC2-grade access review with zero analyst headcount, which nothing in the SMB tier does across a multi-app + multi-agent estate.
- **Reuses:** permissions plugin/catalog, RLS policies, `agent_policies`, `agent_audit` + `activity_log`, `agent_proposals` for approvals, `can_access`.
- **Lens fit:** Operator/admin trust tooling - governance of who (and which agent) can do what.

### Broom - Cross-Suite Data Lifecycle & DSAR Orchestrator
- **Names:** Broom · Bracket · Custodian
- **One-line pitch:** Point Broom at a person or company and it finds every record about them across all 20 apps, then executes a compliant export, delete, or retention sweep as one governed operation.
- **Description:** Broom uses `entity_links` and cross-app search to assemble a complete data map for any subject spanning Bond, Banter, Bill, Bin, Blip and the rest, with an AI classifier that tags PII/sensitive fields the schema doesn't label. It then runs GDPR/CCPA data-subject requests (export or erasure) and org-wide retention policies as a single auditable, HITL-gated job - replacing the today-reality of running deletes by hand in each app and hoping you got them all.
- **Scope (in):** subject-centric data map across apps via `entity_links`+cross-app search; AI PII/sensitivity classification; DSAR export + erasure execution; org-wide retention schedules with legal-hold exceptions; full audit trail of every touched entity.
- **Scope (out):** not per-app log retention (Blip already does telemetry retention); not a backup/DR product; does not make the legal determination, only executes the operator's.
- **Why build it:** A multi-app suite multiplies compliance surface, and no SMB-priced tool answers "where is all of this customer's data and delete it everywhere" across twenty products - the axis is **trust/compliance with completeness guarantees** you cannot get by scripting each app.
- **Reuses:** `entity_links`, `search_everything` cross-app fan-out, storage/attachment dispatcher, `agent_proposals` for erasure approval, Blip retention machinery as a pattern, activity log for audit.
- **Lens fit:** Operator data-lifecycle and compliance tooling spanning the whole platform.

### Belay - Migration & Release-Safety Copilot
- **Names:** Belay · Bedrock · Beam
- **One-line pitch:** A safety rope for schema and config changes: Belay reviews every migration for idempotency, expand-contract correctness, and checksum-immutability traps, then predicts the blast radius across services, MCP tools, and clients before you promote.
- **Description:** Belay reads a proposed migration or config/flag change and an AI reviewer checks it against the suite's hard rules (idempotent guards, immutable-once-applied checksum hazards, expand-contract staging, RLS policy impact), then traces which Drizzle schemas, REST endpoints, MCP tools, and UI call sites the change touches to score deployment risk and draft the exact rollout/rollback sequence. It gates `main`-to-`stable` promotion and can auto-open the follow-up contract-phase migration.
- **Scope (in):** migration lint + semantic review (idempotency, expand-contract, destructive-ALTER guards, checksum-drift traps); dependency/blast-radius map from schema to MCP tools/UI; risk-scored promotion gate; drafted rollout+rollback plan; config/feature-flag drift detection across services.
- **Scope (out):** not a CI runner or a general code reviewer; does not apply migrations itself (defers to the `migrate` service); not app telemetry (Blip).
- **Why build it:** This suite already lost a day to a `-- noqa:` checksum incident that stalled prod migrations - SMB teams without a platform engineer hit exactly this class of bug, and the axis is **release safety/speed** with zero-downtime confidence that generic CI linters can't provide because they don't know the suite's expand-contract and immutability rules.
- **Reuses:** migration lint rules + `schema_migrations` checksums, db-drift guard, Bolt catalog drift guard, MCP surface map (`mcp-endpoint-mapping.md`), branch-model promotion flow, permissions/RLS impact model.
- **Lens fit:** Developer/operator platform tooling - the guardrail for evolving the platform itself.

---

## Phase 2 - Debate

**Orchestrator note:** One full debate round. The dominant dynamic was the
agent-governance collision (A's Bulwark vs E's Bailiff, plus A's Backstop vs the
dry-run in Bailiff/Bespoke). Both seats de-escalated into complementary pieces
rather than fighting for one slot: Seat A dropped **Bulwark**, folded live
intervene/kill into **Brigade**, and added **Bridle** (earned-autonomy ladder that
*promotes* agents); Seat E re-aimed **Bailiff** to agent FinOps/SRE (cost, budgets,
reliability SLOs, anomaly baselines) and explicitly conceded the intervene/kill
console and the rehearsal sandbox. Net: agent governance is now partitioned, not
duplicated. Secondary dynamic: **Braid** (Seat B's entity-resolution graph) became
a shared substrate three seats want to ride - D's Bedrock, E's Broom both aligned
to consume it. Name collisions resolved: Seat B renamed Bulwark -> **Burnish**;
Seats D dropped the Bracket/Bulwark aliases. Merges to concentrate strength: B
merged Bellwether+Bracket; C merged Bevy+Bullhorn.

**Post-debate current slates (carried into Selection):**

| Seat | Current five |
|------|--------------|
| A | Brigade, Backstop, Bylaw, Badger, **Bridle** (dropped Bulwark) |
| B | Basis, **Bellwether** (+Bracket merged), Braid, **Burnish** (renamed), **Benchmark** (new) |
| C | Baton, **Bevy** (+Bullhorn merged), Beam, Ballot, **Babel** (new) |
| D | **Brace** (flagship), Bedrock, Badge, Beeline, Bushel |
| E | **Bespoke** (flagship), Bastion, Broom, Belay, **Bailiff** (re-aimed to FinOps/SRE) |

### Seat A - debate reply

**Stances:** Align+cede on E/Bailiff (reactive control room -> E's; Brigade+Bridle
produce and graduate the agents it polices; dropped colliding Bulwark). Align on
E/Bespoke (agents consume the tools it mints). Align on B/Braid (grounding for
Brigade/Badger). Weak-align on C/Baton (a callable specialist agent Brigade could
orchestrate). Ignore the rest (different lenses).

**Key changes:** Dropped **Bulwark**; folded pause/step-in/kill into **Brigade**;
sharpened **Backstop** as whole-plan rehearsal (vs shallow single-step dry-run in
Bailiff/Bespoke); added **Bridle**:

> ### Bridle - Earned-Autonomy Ladder
> - **Names:** Bridle · Ballast · Badge
> - **One-line pitch:** Agents earn more autonomy by building a track record - Bridle scores each agent and automatically graduates it from "propose everything" to "act freely" (and demotes it when trust drops).
> - **Description:** Rather than a reactive quarantine cockpit (E's Bailiff), Bridle governs the *forward* direction of autonomy: it computes a rolling trust score per agent per action-class from approval-override rate, reversal/failure rate, and Backstop diff acceptance, then auto-adjusts each agent's agent_policies allowlist and HITL thresholds along a defined ladder (Shadow -> Suggest -> Supervised -> Autonomous). New skills start locked and graduate as evidence accrues; a bad streak auto-demotes and hands the incident to Bailiff.
> - **Why build it:** Wedge is **trust** as an *enabler* - the reason SMBs never turn agents loose is all-or-nothing autonomy. A graduated ladder driven by evidence is the missing dial; no suite offers earned, automatically-adjusted autonomy.
> - **Lens fit:** Governs *how much* real work each agent is trusted to do autonomously - the throttle on the whole agent fleet.

**Debate notes (verbatim):** "Strategy is to own 'agents doing real work' and cede
'watching/policing agents' to Seat E - so I dropped colliding Bulwark, folded its
oversight into Brigade, and replaced it with Bridle, an *earned-autonomy ladder*
that complements Bailiff instead of duplicating it (Bridle promotes; Bailiff
quarantines). Aligns: Bailiff and Bespoke (E) as complements/upstream, Braid (B) as
grounding, Baton (C) as a callable specialist agent. My flagship is Brigade
(goal-directed orchestration is the one thing no other seat proposed and Bolt can't
do); Backstop is its trust wedge; Bylaw and Badger are self-contained
autonomous-worker plays. I've pre-positioned so my surviving apps don't depend on
winning the governance fight with E."

### Seat B - debate reply

**Stances:** Align B/Braid <- D/Bedrock (Braid powers Bedrock's per-site graph).
Align B/Braid <- E/Broom (Braid supplies the resolved-entity map Broom needs).
Oppose D/Bushel as a standalone forecaster (should be a Bellwether metric, not its
own engine). Ignore A/Badger as a threat (process loops vs data defects - different
object). Name-collision-only on A/Bulwark -> renamed to Burnish.

**Key changes:** Merged Bellwether+Bracket into one predict-and-simulate engine;
renamed Bulwark -> **Burnish** with a hard data-content-quality wedge (not agent
governance); added **Benchmark**:

> ### Benchmark - privacy-preserving peer comparison
> - **One-line pitch:** Tells a team how its own metrics stack up against anonymized peers - "your win rate is bottom-quartile for teams your size."
> - **Description:** Opt-in, k-anonymous, differential-privacy aggregate stats across consenting orgs, riding Basis's certified metric definitions so comparisons are apples-to-apples. No row-level data leaves an org. LLM lead/lag narrative.
> - **Why build it:** Axis **no good solution today** - live, definition-consistent peer intelligence at a team's price point.

**Debate notes (verbatim):** "Two ALIGN plays (Braid<-Bedrock[D], Braid<-Broom[E])
plant Braid as the shared entity-resolution substrate two other seats need. One
OPPOSE (Bushel[D]) reframes a vertical forecaster as a mere Bellwether metric. I
resolved the three-way 'Bulwark' collision by renaming to Burnish and hard-drawing
its wedge as data-content quality vs agent/access governance. I merged
Bellwether+Bracket to concentrate my strongest bet and used the freed slot for
Benchmark, which compounds Basis into population-level intelligence no one else
touches. Basis is my likely single submission - the most defensible 'not a clone,
clearly AI-native, clear trust wedge' idea in my hand - with Braid as the fallback
that has two allied seats behind it."

### Seat C - debate reply

**Stances:** Align A/Badger (Baton = clean commitment-capture layer that feeds
Badger the chaser). Align B/Braid (C's conversation records are edges Braid's graph
lacks - upstream feeder). Ignore all of A's agent-ops, B's analytics, D's vertical,
E's governance (no comms collision). No seat contests Baton/Beam/Ballot.

**Key changes:** Merged Bevy+Bullhorn into one external-audience platform (async
community + live events); added **Babel** (real-time language layer over
Baton/Bevy/Beam); re-aimed Ballot copy to preempt Brief/agent_proposals confusion.

> ### Babel - the suite's real-time language layer
> - **One-line pitch:** A live interpreter agent that lets teams and their audiences meet, chat, and read across languages without anyone switching tools.
> - **Description:** Live call interpretation (captions + TTS) in Baton/Bevy, auto-localized Bevy threads, per-language Beam variants, one org brand-term glossary keeping translations consistent everywhere.
> - **Why build it:** Axis **integration + cost** - one consistent language layer across every conversation the suite hosts, with a glossary no generic translator respects.

**Debate notes (verbatim):** "My lens has almost no direct competitors, so my
strategy is concentration, not defense. I merged Bevy+Bullhorn into a single
external-audience platform to stop them splitting votes. I aligned rather than
fought with Seat A's Badger (Baton = capture, Badger = chase) and Seat B's Braid (my
conversation records are edges their graph lacks) - positioning my apps as the
connective tissue everyone else's analytics/automation needs, which is a voting
asset. Baton is my spearhead - cleanest integration story, no collisions,
first-class MCP write authority nobody else's meeting tool can match."

### Seat D - debate reply

**Stances:** Oppose B/Bracket (retired the Bracket alias; on substance no conflict).
Align B/Braid (Bedrock becomes Braid's vertical proof-point). Light-align A/Bylaw
(Badge/Beeline rules are SOPs Bylaw would compile). Pre-empt the "just
Bill+Bin+Blank assembled" attack: the load-bearing part of Brace/Badge is a
multimodal model doing expert judgment no CRUD assembly can produce. Ignore all of
E.

**Key changes:** Concentrated identity on the two on-site multimodal
expert-judgment moments (**Brace** diagnosis = flagship, **Badge** inspection);
framed Bedrock/Beeline/Bushel as the vertical spine. Retired colliding aliases.

**Debate notes (verbatim):** "I'm the only vertical seat, so my risk isn't a clone -
it's the 'too niche / just assembled' charge. I'm concentrating on the two on-site
multimodal expert-judgment moments (Brace flagship, Badge) that provably cannot
emerge from assembling Bill/Bin/Blank, and framing Bedrock/Beeline/Bushel as the
spine those hang on. I align with B's Braid (Bedrock becomes its vertical
proof-point) and A's Bylaw to borrow horizontal credibility without ceding the
vertical wedge. For selection I'll lead with Brace: field services is a real, large
SMB market with expensive non-AI incumbents, and 'AI does the on-site expert
judgment' is a new capability, not a re-skin."

### Seat E - debate reply

**Stances:** Align+cede A/Bulwark (conceded the human intervene/kill trust console
to A; re-aimed Bailiff to agent FinOps/reliability). Align A/Backstop (removed
dry-run/COW sandbox from Bailiff entirely; conceded rehearsal to Backstop). Align
B/Braid (Broom consumes Braid's resolved-entity map). Ignore B's end-user
analytics, all of C, all of D.

**Key changes:** Re-aimed **Bailiff** to a de-conflicted "Agent Cost & Reliability
Control Plane" (FinOps/SRE: cost attribution, budgets/quotas, anomaly baselines,
SLO/chargeback - explicitly NOT the kill switch or the sandbox). Kept Bespoke
(flagship), Bastion, Broom, Belay.

**Debate notes (verbatim):** "A owns the agent-builder stack, so I stop fighting for
the generic agent-governance slot and concentrate on the four platform surfaces no
other seat touches - extensibility (Bespoke, flagship), access trust (Bastion), data
lifecycle (Broom), and release safety (Belay) - while keeping a differentiated,
de-conflicted Bailiff as FinOps/SRE-for-agents. I concede the intervene/kill console
and the rehearsal sandbox to Seat A; if forced to merge Bailiff I keep
anomaly-detection + spend-governance as non-negotiable."

---

## Phase 3 - Submissions

Each seat submitted one app (full text; "why this one" reason quoted).

**SUBMISSION - Seat A: Brigade** (Autonomous Mission Control). Goal-directed
multi-agent orchestration: NL objective -> plan DAG -> plan/execute/observe/replan
over the 804-tool MCP catalog, HITL gates, pause/step-in/kill mid-mission, replan
on failure. Wedge **speed + integration**. Why this one: "the one idea no other seat
proposed and that Bolt structurally cannot become; Backstop/Bylaw/Badger/Bridle all
slot in as features around it."

**SUBMISSION - Seat B: Basis** (governed metric layer + causal why). Define each
metric once; every app/chart/agent reads the certified definition; AI decomposes any
delta and correlates it to concrete cross-app events ("MRR fell 8% because 3 Bond
deals slipped and 2 Bill invoices went overdue"). Wedge **trust + speed**. Why this
one: "most defensible on every rubric axis at once; sits cleanly above Bench; the
foundation Bellwether/Benchmark build on."

**SUBMISSION - Seat C: Baton** (meetings that write themselves into the suite).
Meeting-intelligence layer over LiveKit surfaces; extracts decisions/owners/dates
and executes them through the MCP write plane (Bam tasks, Bond notes, Bearing
nudges), then DMs owners their commitments and tracks landing. Wedge **integration**.
Why this one: "zero collisions and the strongest integration wedge - the only app
whose value literally *is* the rest of the suite."

**SUBMISSION - Seat D: Brace** (on-site multimodal fault diagnosis). Tech points a
phone at broken equipment; vision model reads nameplate/serial/error codes, ranks
faults against a trade corpus + site history, emits priced estimate lines. Wedge
**speed + trust**. Why this one: "my only idea whose core is a multimodal AI judgment
that provably cannot be assembled from existing apps - the strongest rebuttal to the
'too niche / just Bill+Bin' attack."

**SUBMISSION - Seat E: Bespoke** (self-extending tool & connector forge). Describe a
tool/integration in plain language; an authoring agent generates schema+handler,
sandbox-tests against real endpoints, and publishes into the MCP catalog under
policy - no code deploy. Wedge **speed + integration**. Why this one: "the only app
that makes the platform itself extensible, uncontested by every seat, AI-native by
construction rather than compliance plumbing."

---

## Phase 4 - Overlap resolution

**Orchestrator pairwise analysis of the five submissions:**

| Pair | Verdict | Reason |
|------|---------|--------|
| Brigade × Basis | Distinct | Agent orchestration vs governed metric layer. No shared surface. |
| Brigade × Baton | Distinct | Baton is a narrow meeting->action specialist agent; Brigade is a general goal-directed mission board. Baton would be a *callable step* inside Brigade, not the same product. Different primary surface and wedge. |
| Brigade × Brace | Distinct | Horizontal orchestration vs vertical on-site vision diagnosis. |
| Brigade × Bespoke | Distinct (complementary) | Bespoke *creates* MCP tools; Brigade *consumes* them to run missions. Opposite ends of the same platform, not the same app. |
| Basis × Baton | Distinct | Metric semantics vs meeting capture. |
| Basis × Brace | Distinct | |
| Basis × Bespoke | Distinct | |
| Baton × Brace | Distinct | |
| Baton × Bespoke | Distinct | |
| Brace × Bespoke | Distinct | |

**Outcome:** No perfect overlap (no collapse) and no "very similar but not
identical" pair (no forced merge negotiation, no discards). This is a direct result
of Phase 2: the two agent-platform seats (A, E) deliberately de-conflicted their
flagships, and B/C/D each held a distinct lane. **Five surviving apps proceed to the
vote:** Brigade, Basis, Baton, Brace, Bespoke.

---

## Phase 5 - Voting

Single round. Each seat scored every finalist 1-5 and abstained on its own app.
No self-votes cast.

**Vote matrix (seat x app):**

| Seat \ App | Brigade | Basis | Baton | Brace | Bespoke |
|---|---|---|---|---|---|
| A | abstain | 4 | 3 | 4 | 5 |
| B | 3 | abstain | 4 | 4 | 5 |
| C | 4 | 5 | abstain | 3 | 4 |
| D | 3 | 4 | 4 | abstain | 3 |
| E | 4 | 5 | 3 | 4 | abstain |
| **Total** | **14** | **18** | **14** | **15** | **17** |

**Selected reasons (verbatim highlights):**
- Basis: C "makes every other app's data trustworthy"; E "solves a real, unmet SMB
  pain, is AI-native, and reuses entity_links + cross-app search cleanly"; A
  "certified-once metric layer + AI causal 'why did it move' is a real trust wedge,
  cleanly adjacent to Bench" (docked to 4 as edging toward known territory).
- Bespoke: A & B both 5 ("highest-leverage... makes the entire suite compound over
  time"); but D scored it 3 ("operator/dev plumbing most SMB teams never touch")
  and C 4 ("sandboxed self-extension carries the highest trust/safety risk"), which
  cost it the top spot.
- Brace: consistent 4s from A/B/E on the multimodal wedge; C/D lower on horizontal
  fit.
- Brigade & Baton tied at 14: both dinged as "crowded category" (mission-control
  frameworks; meeting note-takers) despite genuine AI-native integration.

**Outcome:** No tie at the top. **Winner: Basis (18 points)**, one point clear of
Bespoke (17). No elimination round required.

### WINNER - Basis (Seat B)

- **One-line pitch:** A governed metric layer that gives every number in the suite
  one trusted definition and then explains, in plain language, *why* it moved.
- **Description:** A semantic layer where each metric is defined once (revenue = Bill
  paid invoices minus refunds; pipeline = Bond open deals by stage) and every app,
  chart, and agent reads the same certified definition. Its AI core does automatic
  contribution analysis: when a metric shifts it decomposes the delta across
  dimensions and correlates it to concrete cross-app events, returning "MRR fell 8%
  because 3 enterprise Bond deals slipped from Won and 2 Bill invoices went overdue,"
  each drill-down linked.
- **Scope (in):** metric catalog with owners/lineage; NL "why did X change" causal
  decomposition; driver ranking by contribution; certified-metric badges Bench
  widgets bind to; Bolt event on definition change.
- **Scope (out):** no chart rendering (Bench); no dashboards; no external-source ETL
  in v1.
- **Wedge:** trust + speed - one definition of truth plus instant root-cause that no
  BI tool the size of a small team can afford.
- **Reuses:** Bench (binds certified metrics), Bolt events,
  `search_everything`/`v_activity_unified` for driver correlation, MCP catalog, RLS,
  `entity_links`.

---

## Phase 6 - Spec hardening

_Pending._

---

## Outcome

**Winner: Basis** - a governed metric layer with AI causal "why did it move"
decomposition (Seat B, Data/intelligence lens). 18 points.

**Runner-up: Bespoke** - self-extending MCP tool & connector forge (Seat E). 17
points. Worth flagging for a future session: two seats scored it a perfect 5, and
it is the highest-leverage *platform* play on the slate; it lost only on SMB
end-user reach and self-extension safety risk.

The winning app now proceeds to Phase 6: a full design spec is drafted by
`brainstorm-spec-writer` and hardened across adversarial review rounds. See
`2026_07_17_12_58_APP_DESIGN_basis.md`.
