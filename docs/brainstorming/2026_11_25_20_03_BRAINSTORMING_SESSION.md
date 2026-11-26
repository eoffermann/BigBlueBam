# Suite Brainstorm Session - 2026_11_25_20_03

**Purpose:** pick the next app BigBlueBam should build, from seven competing seats, and produce a hardened design spec for the winner.

**Run context:** scheduled autonomous cycle (headless), branch `suite-brainstorm`, synced with `origin/main` at 17e0e7b2 before the session. All 24 Launchpad apps passed `pnpm check:app-completeness` before ideation, so no half-built app needed resuming.

---

## Coverage census

Roster source: `LAUNCHPAD_CATALOG` in `apps/api/src/routes/system-settings.routes.ts` (24 apps), plus the inventory in `CLAUDE.md`. No app is in flight: the last cycle (Bursar, 2026_07_19_20_05) is on the Launchpad and passes the completeness gate.

### Category map

| Category | Apps | Status |
|---|---|---|
| Money: billing, contracts, scope/margin, procurement/spend | Bill, Bulwark, Burn, Bursar | **dense** (4) |
| Project / task / goals | Bam, Bearing | **dense** (2) |
| Chat / real-time presence | Banter, Bureau | **dense** (2) |
| Knowledge / documents | Beacon, Brief | **dense** (2) |
| Visual collaboration (canvas, diagrams) | Board, Blueprint | **dense** (2) |
| Customer data (CRM, identity resolution) | Bond, Braid | **dense** (2) |
| Analytics / metrics | Bench, Basis | **dense** (2) |
| Workflow automation | Bolt | covered |
| Outbound email marketing | Blast | covered |
| Forms / surveys | Blank | covered |
| Scheduling / calendar | Book | covered |
| Files / DAM / structured data | Bin | covered |
| Media review and approval | Bay | covered |
| Telemetry / observability | Blip | covered |
| Customer support | Helpdesk | covered |

### Whitespace, essentials first

Horizontal capabilities most small-to-medium companies need that the suite has little or nothing for:

1. **People / HR core** - employee records, org chart, role changes, time off, policies acknowledgement. Zero apps.
2. **Onboarding and offboarding** - new-hire and leaver checklists that span every app (accounts, equipment, training, access). Zero apps.
3. **Learning and enablement / training** - courses, certifications, skills, AI-generated training from the firm's own knowledge. Zero apps.
4. **Compliance and GRC** - controls, policies, evidence collection, audits (SOC 2 / ISO / HIPAA-lite). Zero apps. (Bulwark monitors obligations inside customer/vendor contracts; it is not an internal controls program.)
5. **Health and safety** - incidents, near-misses, risk assessments, inspections. Zero apps.
6. **Office / productivity suite** - spreadsheets, presentations, shared mail/calendar essentials. Partial (Brief covers documents, Bin has a structured-data editor, Book covers calendar).
7. **Advertising / social / marketing communications / brand** - social publishing, brand kit and asset governance, ad campaigns, PR. Only outbound email (Blast) exists.
8. **Recruiting / ATS** - requisitions, candidates, interview loops, scorecards. Zero apps.
9. **IT and asset management** - devices, licenses, SaaS seats, access reviews. Zero apps.
10. **Expense and travel** - partial (Bill has expenses).
11. **E-signature**, **employee feedback / engagement surveys**, **payroll** - zero apps (Blank covers generic forms only).

### Deferred this session (single-industry verticals)

Field-service dispatch, fleet management, logistics, construction-specific, restaurant/POS, clinical/healthcare-specific, legal-practice-specific, and similar one-trade products. They were considered and set aside until the horizontal essentials above are covered (see also the standing scope decision that field-service/fleet/physical-ops are out of scope for this work-OS suite).

### Per-session steer (handed to every seat)

> Prefer the whitespace categories above, essentials first. A near-duplicate of an existing app, or a third app in a dense category, is disfavored and will be cut in Phase 4. The dense categories are: **money/contracts/spend (Bill, Bulwark, Burn, Bursar)**, project/task/goals, chat/presence, knowledge/documents, visual collaboration, customer data, and analytics/metrics. Do not pile onto them. Single-industry verticals are deferred.

---

## Phase 1 - Initial proposals

Seven `brainstorm-ideator` seats were spawned in parallel, each with its lens, the rubric, the coverage census above, and the instruction that a majority of its five proposals must land in a whitespace or covered category, each naming its closest existing app. Blocks below are verbatim.

### Seat A - AI-native automation & autonomous agent workflows

### Berth (joiner / mover / leaver autopilot)
- **Names:** Berth · Bridle · Boarding
- **One-line pitch:** Say "Maria starts Monday as a sales lead" or "Dev leaves Friday," and an agent builds, runs, and proves out the whole hire or exit across every app.
- **Description:** A joiner/mover/leaver event is compiled into a typed, reversible provisioning plan: which suite memberships, projects, Banter channels, Bond pipelines, Book pages, API keys and agent_policies to grant or revoke, plus equipment and training steps for humans to do. The agent runs each step through the MCP tool catalog. Destructive steps go through the agent_proposals HITL queue. On exit, the agent finds every orphaned asset (open deals, assigned tasks, owned docs, Bolt rules, scheduled Blast sends), proposes who should own each one, and ends with a signed "access-zero" certificate checked against @bigbluebam/permissions.
- **Scope (in):** role templates learned from what peers in the same role actually hold; plan compiler with dry-run diff; MCP-executed provisioning; orphan detection and reassignment proposals; access-zero verification; checklist tasks for human steps (laptop, keys); Bolt events `employee.joined/moved/left`.
- **Scope (out):** payroll, benefits, HRIS master record, external SaaS connectors in v1 (they show up as manual checklist steps), device MDM.
- **Why build it:** Small firms onboard and offboard by memory, so ex-staff keep access and their work gets orphaned. Okta Workflows and Rippling cost enterprise money and stop at account creation; neither reassigns the work. Axis: **completeness and trust**, a provable zero-access exit plus zero orphaned work, at no extra seat cost.
- **Reuses:** auth/users, @bigbluebam/permissions, agent_policies, MCP catalog (it is the executor), agent_proposals, Bolt, entity_links, Bam (checklist tasks), activity_log.
- **Lens fit:** a single natural-language intent becomes an autonomous, multi-app agent run with HITL gates.
- **Closest existing app:** Bolt - Bolt runs rules a human authors, one trigger at a time. Berth generates a one-off, cross-app plan per person and verifies the end state. It is a people-operations category, not a better rule engine.

### Bastion (continuous controls and evidence agent)
- **Names:** Bastion · Binder · Bailiff
- **One-line pitch:** SOC 2 / ISO 27001 readiness where an agent collects the evidence from how you already work, instead of you collecting screenshots.
- **Description:** A control library (SOC 2, ISO 27001, HIPAA-lite) is mapped to machine-checkable tests that run against the suite's own data. Access reviews come from permissions, change management from Bam and Blueprint, incident response from Helpdesk and Blip, policy acknowledgement from Beacon. Agents run the tests on a schedule, attach timestamped evidence snapshots in Bin, and open remediation proposals when a control drifts. Auditors get a token-gated evidence room.
- **Scope (in):** control framework templates; control-to-test mapping, with an AI drafting tests from control text; scheduled evidence capture; drift alerts as Bolt events; remediation proposals; policy library with attestation; auditor guest links.
- **Scope (out):** customer/vendor contract obligations (Bulwark), vendor risk questionnaires, external cloud-infra scanning in v1, legal sign-off.
- **Why build it:** Vanta and Drata start around $10k/yr and need connectors to the tools you use. The suite already is those tools, so its evidence is native and continuous. Axis: **cost and integration depth** for a 10-50 person firm facing its first SOC 2 request.
- **Reuses:** activity_log / v_activity_unified, @bigbluebam/permissions, Bin storage, Bay-style public token links, Beacon (policies), Bolt, agent_proposals, MCP.
- **Lens fit:** autonomous agents run the audit continuously, so the audit is not a once-a-year scramble.
- **Closest existing app:** Bulwark - Bulwark tracks what you promised counterparties in contracts. Bastion proves your internal controls work. It is a different object (control vs. clause) and a different buyer (auditor vs. account owner).

### Brevet (enablement compiled from real friction)
- **Names:** Brevet · Bootcamp · Primer
- **One-line pitch:** Training that writes itself from where your team actually gets stuck, and certifies people against real work, not quizzes alone.
- **Description:** An agent watches friction signals: repeated questions in Banter, Helpdesk escalations, reopened Bam tasks, Bay rejections, failed Bolt runs. It clusters them into skill gaps, then compiles micro-lessons and practice tasks grounded in the firm's own Beacon and Brief content, with citations. It assigns lessons to the people hitting the gap and marks a skill certified only when the friction signal drops for that person.
- **Scope (in):** friction-signal clustering; lesson and quiz generation with source citations; role-based learning paths; assignment and nudges; skill matrix per person; certification with expiry; stale-lesson detection when a source doc changes.
- **Scope (out):** SCORM authoring suite, video production, external course marketplace, compliance-mandated LMS content (Bastion can reference it).
- **Why build it:** SMBs have no L&D staff, and LMSs like TalentLMS sit empty because nobody authors content. Brevet authors from what already exists and targets only real gaps. Axis: **zero authoring cost plus measured outcome**.
- **Reuses:** Beacon/Brief + Qdrant retrieval, Banter, Helpdesk, Bam, expertise_for_topic, phrase-count tools, Bolt, Bench for the skill matrix.
- **Lens fit:** a closed autonomous loop (detect gap, generate lesson, assign, verify), not an authoring tool with AI help.
- **Closest existing app:** Beacon - Beacon stores knowledge. Brevet decides who needs which knowledge, teaches it, and verifies it took. That is learning and enablement, a different category from a knowledge base.

### Bevy (agent-run people ops for a mixed human and agent workforce)
- **Names:** Bevy · Bellhop · Roster
- **One-line pitch:** The HR department you can't afford, as an agent: time off, role changes, policies, and the org chart, for both your people and your AI agents.
- **Description:** A lightweight employee record and org chart where every request is natural language, for example "can I take the 12th-16th?" or "promote Sam to team lead." The agent resolves the request against policy in Beacon, team coverage from Bam and Book, and approval chains, then executes or routes it through HITL. AI agents (`users.kind = agent`) sit on the same roster with an owner, a scope, a review cadence, and a cost, so "who works here" includes the bots.
- **Scope (in):** person and agent records; org chart; time-off with coverage-aware auto-approval; role and manager changes (emits events that Berth consumes); policy Q&A with citations; acknowledgements; agent owner and review records linked to agent_policies.
- **Scope (out):** payroll, benefits administration, performance-review authoring, recruiting/ATS.
- **Why build it:** Under 50 people, HR is the founder's inbox. BambooHR and Gusto are form-and-approval CRUD apps, and none of them model AI agents as workforce members. Axis: **no HR staff needed, plus first-mover on mixed human and agent workforce governance**.
- **Reuses:** users and users.kind, agent_runners, agent_policies, Beacon, Book (availability), Bam, agent_proposals, Bolt, permissions.
- **Lens fit:** HR requests are decided and executed by an agent, and agents themselves are managed as workforce.
- **Closest existing app:** Bureau - Bureau shows who is online right now. Bevy is the system of record for who is employed, in what role, with what leave and policy obligations. It is the people/HR core category, which the suite does not have.

### Bullhorn (autonomous social and brand publishing)
- **Names:** Bullhorn · Buzz · Broadcast
- **One-line pitch:** Your company's wins turn into on-brand social posts automatically, so you only approve, not write.
- **Description:** An agent subscribes to suite events: a shipped release in Bam, a Beacon article, a closed-won deal with a publish-consent flag in Bond, a Book webinar. It drafts channel-specific posts (LinkedIn, X, Bluesky, Mastodon) checked against a brand kit (voice rules, banned claims, logos in Bin). It routes them through Bay for approval, schedules them, then learns from engagement which event types and phrasings perform, and retunes its own drafting.
- **Scope (in):** brand kit and voice linting; event-to-post triggers; multi-channel drafting; Bay approval; scheduled publishing for 3-4 networks; engagement ingest; content calendar; claim-safety check (no confidential deal data without consent).
- **Scope (out):** paid ad buying, social listening and inbox, influencer management, email (Blast).
- **Why build it:** Buffer and Hootsuite schedule posts but do not know what happened inside your company, so the writing is still manual and posting stops when the founder is busy. Bullhorn's source material is the suite's own activity. Axis: **zero-effort content supply plus brand safety**.
- **Reuses:** Bolt events, Bin (brand assets), Bay (approval), Bond/Bam/Beacon/Book as sources, can_access preflight, agent_proposals, MCP.
- **Lens fit:** event-driven, autonomous draft, approve, publish, and learn loop. A human only clicks approve.
- **Closest existing app:** Blast - Blast sends email campaigns a human composes to known contacts. Bullhorn publishes to public social networks from internal events with brand governance. It is the advertising/social/brand category, not email.

### Seat B - Data, intelligence & analytics

### Baseline
- **Names:** Baseline · Bastion · Attest
- **One-line pitch:** Your SOC 2 / ISO 27001 controls are checked against what actually happened in your suite every night, so the audit binder writes itself and drift shows up the week it starts, not at audit time.
- **Description:** This is an internal-controls GRC engine. An LLM turns a framework (SOC 2, ISO 27001, or a custom policy set) into typed, testable control assertions. Each assertion is bound to queries over data the suite already holds: `activity_log`, `v_activity_unified`, permission grants, API-key rotation, Blip retention, Bolt executions, and Beacon policy-article ack dates. A nightly evaluator produces evidence packets with citations for every control: pass, fail, or "no data". The flagship output is the "no data" set: controls that nothing in your stack can currently prove. Remediation tasks and policy-update drafts go into `agent_proposals`.
- **Scope (in):** framework-to-assertion compiler; control library with owners; nightly evaluator with cited evidence snapshots frozen in Bin; drift alerts as Bolt events; Beacon policy attestation tracking; auditor read-only export (PDF + JSONL); MCP `baseline_control_status`, `baseline_evidence_for`.
- **Scope (out):** vendor/customer contract obligations (Bulwark); third-party vendor risk questionnaires; acting as a certified auditor; pentest or vulnerability scanning; policy authoring beyond drafts.
- **Why build it:** The axis is **cost**. Vanta and Drata charge SMBs $10-40k/yr and still need connectors to infer what happened. Baseline sits on the system of record itself, so evidence is native, cited, and continuous at near-zero marginal cost. The "unprovable control" list is something no screenshot-collector produces.
- **Reuses:** shared DB + RLS, `v_activity_unified`, @bigbluebam/permissions grants, Bolt events, Bin (frozen evidence), Beacon (policies), Bam (remediation tasks), `agent_proposals`, MCP catalog.
- **Closest existing app:** Bulwark. Bulwark watches obligations you owe counterparties under signed contracts. Baseline watches your own internal controls against a security/compliance framework, so it is a different buyer (ops/security, not legal/finance) and a different evidence source.
- **Lens fit:** Compliance becomes a continuously evaluated query over the suite's own operational data.

### Badge
- **Names:** Badge · Bouncer · Keyring
- **One-line pitch:** Quarterly access reviews done for you: Badge shows who holds access they never use, who shares a role but works nothing like their peers, and who left without being deprovisioned.
- **Description:** This is identity and access intelligence for IT-less teams. Badge joins three things: entitlements (suite permissions, API keys, service accounts, OAuth links, plus imported SaaS seat lists via CSV or SCIM pull), actual usage (activity per app and resource), and HR status. From those it computes a least-privilege recommendation per person, with evidence. Peer-group outlier detection flags grants that are anomalous for the role. The reviewer's queue is pre-decided ("revoke, 0 uses in 94 days"), so a manager confirms in bulk. Revocations execute via suite APIs or route through `agent_proposals`.
- **Scope (in):** entitlement inventory (suite-native + imported SaaS seats); usage-vs-grant scoring; peer-outlier detection; scheduled review campaigns with manager sign-off and an immutable record; orphaned-account and stale-key sweeps; seat-cost waste roll-up; Bolt `access.anomaly` events; MCP `badge_review_queue`, `badge_explain_grant`.
- **Scope (out):** being an IdP/SSO provider; device/MDM management; procurement or renewal negotiation (Bursar); payroll/HR records of truth.
- **Why build it:** The axis is **time and cost**. Okta IGA and ConductorOne target enterprises. SMBs do access reviews in spreadsheets, or skip them. Badge needs no connector for the suite's own grants and recovers wasted SaaS seat spend, which pays for itself.
- **Reuses:** @bigbluebam/permissions + Redis PermissionContext, `api_keys`/service accounts, `oauth_user_links`, `activity_log`, `agent_policies` (agent identities are reviewed too), Bolt, `agent_proposals`, Blank (bulk-attest form fallback).
- **Closest existing app:** Bursar. Bursar levels vendor bids and watches spend against an awarded baseline. Badge governs who has access to what versus what they use, which is IT/identity governance, not procurement.
- **Lens fit:** It turns raw usage telemetry into a least-privilege decision engine, including for the suite's growing agent population.

### Baton
- **Names:** Baton · Bridge · Handover
- **One-line pitch:** Baton maps what each person uniquely knows and owns before they leave, then turns it into a cited handover dossier and a ramp plan for whoever comes next.
- **Description:** This is on/offboarding driven by a work-graph. Baton continuously builds an ownership graph from tasks, deals, tickets, Beacon/Brief authorship, Bolt rules, API keys, and recurring Book events. It scores "bus factor" per asset: things only one person touches. On an offboarding trigger, an agent compiles a handover dossier: open commitments, sole-owned assets, undocumented tribal knowledge inferred from that person's chat/ticket answers. It also proposes reassignment plus the access cut list. On onboarding, it generates a role-specific 30/60/90 plan from what predecessors and peers actually did. It then measures real ramp (first independently closed task/ticket/deal) instead of checkbox completion.
- **Scope (in):** ownership graph + bus-factor heatmap; offboarding dossier + reassignment proposals; access/credential cut list; onboarding plan generator with buddy suggestion (`expertise_for_topic`); ramp-time measurement; Bolt `person.offboarding_started` / `ramp.milestone`; MCP `baton_dossier`, `baton_sole_owned`.
- **Scope (out):** HRIS record of truth, payroll, benefits, I-9/e-verify; device shipping; generic checklist builder (Bolt + Bam already do that).
- **Why build it:** The axis is **knowledge-loss risk, which no SMB tool addresses**. BambooHR and Rippling onboarding are static checklists. Nothing on the market can see who is a single point of failure, because nothing else holds the work graph. Baton can, because the suite does.
- **Reuses:** `entity_links`, `v_activity_unified`, `expertise_for_topic`, Beacon (dossier published as an article), Bam (handover tasks), permissions/api_keys, Bolt, `agent_proposals`, `can_access` preflight on every cited item.
- **Closest existing app:** Beacon. Beacon stores knowledge people chose to write down. Baton finds the knowledge nobody wrote down, scores the risk of losing it, and orchestrates the transfer around a person's lifecycle event.
- **Lens fit:** People lifecycle events become graph analytics over who-owns-what.

### Bellwether
- **Names:** Bellwether · Barometer · Pulse
- **One-line pitch:** Bellwether spots team-level burnout, overload, and disengagement weeks early from how the work actually flows, and only interrupts people with a survey when the signal says to ask.
- **Description:** This is engagement intelligence with privacy by construction. Team-level aggregates only, k-anonymity floor of 5, no per-person scores ever exposed. Bellwether derives leading indicators from work metadata: after-hours activity share, carry-forward streaks, WIP per person, meeting load from Book, ticket backlog per agent, response-latency drift. A change-point model flags teams whose pattern shifted. Instead of fixed quarterly surveys, it triggers a targeted 3-question Blank pulse to that team. An LLM then summarizes free-text into themes and drafts a manager action brief, which goes through the HITL queue.
- **Scope (in):** signal catalog with transparent formulas; team-level change-point detection; adaptive pulse triggering via Blank; anonymous free-text theming; manager brief + suggested actions; employee-visible "what we measure" page; MCP `bellwether_team_signals`.
- **Scope (out):** individual productivity scoring or surveillance (structurally prevented); performance reviews; compensation; message-content reading (metadata only).
- **Why build it:** The axis is **signal latency and survey fatigue**. Culture Amp and Lattice depend on periodic self-report that lags reality and annoys staff. Bellwether reads the leading signal already in the system and spends survey questions only where they matter, at SMB price.
- **Reuses:** `activity_log`, Bam sprints/carry-forward, Book, Helpdesk, Banter metadata, Blank (pulses), Bolt, `agent_proposals`, RLS + permissions (team-scope gating).
- **Closest existing app:** Basis/Bench. Those govern and chart business metrics a user defines. Bellwether is an employee-experience product with its own privacy model, adaptive survey loop, and manager-action workflow. Its output is an intervention, not a dashboard.
- **Lens fit:** Engagement becomes a privacy-bounded inference problem over work exhaust.

### Boost
- **Names:** Boost · Bootcamp · Primer
- **One-line pitch:** Boost finds the skill gaps your work data is already revealing, such as repeat escalations, reopened tickets, and stalled tasks, and auto-builds short lessons from your own docs to close them, then checks whether they worked.
- **Description:** This is learning and enablement aimed by evidence. Boost mines failure signals: tickets escalated or reopened by topic, tasks bounced back in review, repeated "how do I" questions in Banter, low-confidence Beacon searches. It clusters them into a per-team skill-gap map. For each gap it generates a micro-module grounded only in Beacon/Brief sources it can cite: summary, worked example, 5-question check. It assigns the module to the people the gap touches. Effectiveness is measured by whether the underlying failure rate dropped for completers, not by quiz scores.
- **Scope (in):** gap detection + clustering; cited micro-module generator (from Beacon/Brief only, stale-source flagging); assignment + spaced-repetition nudges via Banter; outcome-based effectiveness (before/after failure rate); required-training tracking (e.g. security awareness, feeds Baseline-style attestation); MCP `boost_gaps`, `boost_assign`.
- **Scope (out):** SCORM authoring suite or video course production; external course marketplace; certifications for regulated professions; performance management.
- **Why build it:** The axis is **relevance and proof of impact**. LMSs (TalentLMS, Trainual) host content someone had to write and measure completion. Boost writes the content from existing docs and targets it at measured failure, then proves (or disproves) that training moved the outcome.
- **Reuses:** Helpdesk + `helpdesk_find_similar_tickets`, `*_count_by_phrase` trend tools, Beacon/Brief + Qdrant retrieval, Banter (nudges), Blank (checks), Bolt, `can_access`, MCP catalog.
- **Closest existing app:** Beacon. Beacon is the knowledge store. Boost decides who needs which knowledge, based on evidence of failure, delivers it, and measures behavioral change, which is the training/enablement category.
- **Lens fit:** Training is driven by and judged on operational outcome data, not completion counts.

### Seat C - Communication, collaboration & community

### Bugle: announcements that confirm they were understood
- **Names:** Bugle · Bulletin · Herald
- **One-line pitch:** Send a company announcement once, and Bugle makes sure each person got it, understood it, and acted on it.
- **Description:** Leadership writes one source announcement, such as a policy change, reorg or launch. An agent then produces a version for each audience (role, team, locale), picks the channel for each person (Banter post, email, digest) and asks each recipient a short question to check understanding instead of an "I read it" box. It reads the follow-up questions that come in through Banter threads and Helpdesk, groups them, finds the points that confused people, drafts a clarification or FAQ for the sender to approve, and shows sentiment and understanding broken down by team.
- **Scope (in):** source announcement and audience-specific versions; audience targeting from org/team/role; acknowledgment plus a short understanding check; required-acknowledgment deadlines with automatic nudges; grouping of confusion signals; drafted clarifications sent to agent_proposals; a dashboard of reach and understanding by team; MCP tools so agents can draft, target and query announcements.
- **Scope (out):** chat itself (Banter), external email marketing (Blast), wiki pages (Beacon), formal policy-attestation evidence for audits.
- **Why build it:** Axis is **closed-loop proof that a message landed**. Small and mid-size firms announce in a chat channel and hope people saw it. Staffbase and Simpplr cost enterprise prices and only measure opens. No tool in this price range measures understanding and automatically repairs the gaps.
- **Reuses:** auth/RLS, org/team membership, Banter scheduled posts and channels, worker email queue, Bolt (`announcement.published` / `ack.overdue` triggers), agent_proposals, can_access, Bench for rollups.
- **Lens fit:** internal communication, the company-to-employee channel the suite does not have.
- **Closest existing app:** Banter. Banter is many-to-many conversation; Bugle is one-to-many communication that is tracked per person, has deadlines and a feedback loop. It is a different job, not a better chat.

### Barometer: continuous employee listening
- **Names:** Barometer · Buzz · Pulse
- **One-line pitch:** Know how your team is really doing before people quit, without sending yet another survey.
- **Description:** An agent runs short, adaptive check-ins by conversation. Each one is 2 or 3 questions, chosen because the previous answers left a gap. It merges those with opt-in, aggregate-only work signals (after-hours activity, carry-forward pile-up in Bam, sprint load) into themes per team. A k-anonymity floor is enforced at query time, so no single person's answers can be singled out. It drafts "you said, we did" replies and action items for managers to approve, and tracks whether each theme improves afterwards.
- **Scope (in):** adaptive conversational check-ins delivered in Banter or email; theme extraction; a k-anonymity gate (minimum group size, enforced by the server); opt-in workload signals from Bam and Book; manager action plans routed through agent_proposals into Bam tasks; theme trends over time.
- **Scope (out):** performance reviews, individual surveillance or per-person scoring, generic survey building (Blank), HRIS records.
- **Why build it:** Axis is **signal with less survey fatigue and real anonymity**. Culture Amp and Lattice Engagement charge per seat for quarterly surveys that people ignore. Small firms do nothing until an exit interview. Here the AI asks fewer, better questions and closes the loop, which is the step that actually keeps people from leaving.
- **Reuses:** auth/RLS, permissions (manager vs. HR viewing scopes), Banter delivery, Bam/Book activity, Bolt (`theme.emerged`, `pulse.declined`), agent_proposals, Basis/Bench for certified trend metrics.
- **Lens fit:** upward communication, the employee's voice reaching leadership on a regular schedule.
- **Closest existing app:** Blank. Blank builds forms; Barometer is a listening system with its own questioning agent, an anonymity guarantee and action tracking. A form builder cannot provide any of those three.

### Bullhorn: social and PR desk that drafts from real company news
- **Names:** Bullhorn · Byline · Broadside
- **One-line pitch:** Your company's social channels and press outreach run from what is actually happening inside the business, in your brand voice, with you approving every post.
- **Description:** An agent watches internal Bolt events (a release shipped in Bam, a Bearing goal hit, an asset approved in Bay, a Bond deal won with publicity consent) and drafts LinkedIn and X posts plus short press pitches. Every draft runs through a brand-voice and claim checker that flags unsupported numbers and missing approvals. Approved posts go into a publishing calendar. Social listening groups mentions and drafts replies, and a crisis mode prepares holding statements. Nothing is published without a human approving it.
- **Scope (in):** an event-to-story feed; channel-specific drafts; a brand voice profile learned from approved posts; claim and citation checks; an approval queue; scheduling and publishing to 2 or 3 networks; mention listening with drafted replies; a media contact list with pitch tracking; MCP tools.
- **Scope (out):** paid ad buying, email campaigns (Blast), creative asset production (Bin and Bay own assets), influencer marketplaces.
- **Why build it:** Axis is **content supply plus integration**. Buffer and Hootsuite schedule posts you still have to write. A small team's real bottleneck is knowing what to say, and the suite already knows every win. That is something a standalone scheduler cannot copy.
- **Reuses:** Bolt event stream, Bay approvals, Bin assets, Bond (customer-story consent), agent_proposals, worker queues for scheduled publishing, permissions.
- **Lens fit:** external communication and community, the company talking to the market.
- **Closest existing app:** Blast. Blast sends email to an owned list; Bullhorn handles public social, press and listening, which is a different audience, channel and risk profile.

### Buddy: AI onboarding companion
- **Names:** Buddy · Berth · Bootcamp
- **One-line pitch:** Every new hire gets a personal onboarding guide that builds their first 90 days, introduces them to the right people and answers the questions they are afraid to ask.
- **Description:** From a role and team, the agent builds a 30/60/90 plan: Bam tasks for access and setup, required Beacon reading, and Book introductions with the people `expertise_for_topic` identifies as owners of the hire's areas. The hire can ask it anything in Banter and gets cited answers. Questions it cannot answer are grouped and become drafted Beacon articles routed to the owner, so the next hire does not hit the same gap. Managers see whether the hire is on track or stuck.
- **Scope (in):** role-based plan generation; provisioning checklist tasks; introductions booked through Book; a cited Q&A companion; turning knowledge gaps into drafted Beacon articles; milestone check-ins; a manager's ramp view; templates per role.
- **Scope (out):** offer letters and e-signature, payroll and HRIS core records, recruiting, a full training/LMS authoring tool.
- **Why build it:** Axis is **time-to-productivity at zero HR headcount**. Small firms onboard with a stale doc and a busy manager. BambooHR and Rippling onboarding are static checklists. Buddy writes the plan, makes the introductions and fixes the knowledge base as it goes.
- **Reuses:** Bam (tasks), Beacon (Qdrant retrieval plus article drafts), Book (`book_find_meeting_time_for_users`), Banter DMs, `expertise_for_topic`, can_access, agent_proposals, Bolt (`hire.started`, `milestone.missed`).
- **Lens fit:** introducing a new person into a team's network of people and knowledge is a communication problem.
- **Closest existing app:** Beacon. Beacon stores knowledge; Buddy is a time-boxed, person-specific onboarding program that uses Beacon as one input.

### Baton: role-handover agent
- **Names:** Baton · Bequest · Relay
- **One-line pitch:** When someone leaves or changes roles, Baton makes sure nothing they owned or knew leaves with them.
- **Description:** When a departure or role change is triggered, the agent lists everything the person owns across the suite: open Bam tasks, Bond deals, Helpdesk tickets, Bolt rules, Bearing key results, Book pages, Blip watches and so on. It proposes a successor for each item based on expertise and current load. It then runs a structured exit interview that targets what the records do not cover, such as undocumented processes and relationship context, and writes a cited handover packet. Reassignments are applied in batches only after approval, and an orphan sweep catches anything missed.
- **Scope (in):** a cross-app ownership inventory; successor suggestions; batch reassignment through agent_proposals; an agent-led knowledge-capture interview; a handover packet published to Beacon or Brief; introduction messages to external contacts (drafted only); an orphaned-ownership sweep on a schedule.
- **Scope (out):** final pay and benefits, legal separation documents, device recovery and IT asset management, account deprovisioning beyond the suite.
- **Why build it:** Axis is **risk of losing what departing people own and know**. In a 10 to 50 person company, one departure can leave deals, automations and customer relationships with no owner. Nothing on the market inventories ownership across a whole work suite, because no single vendor owns all of it. BigBlueBam does.
- **Reuses:** entity_links, the unified activity view, per-app MCP reassign tools, `expertise_for_topic`, agent_proposals, Beacon/Brief, Bolt (`handover.started`, `orphan.detected`), permissions.
- **Lens fit:** passing context and relationships from one person to the next is a communication handoff.
- **Closest existing app:** Bam. The People area in Bam (`/b3/people`) manages accounts and memberships; Baton transfers work, knowledge and relationships across all 24 apps.

### Seat D - People, HR & workplace operations

### Baton (joiner/mover/leaver lifecycle)
- **Names:** Baton · Berth · Handover
- **One-line pitch:** When someone joins, changes role, or leaves, an agent finds everything they own or can reach across the suite and runs the handoff for you. Nothing gets orphaned.
- **Description:** Baton starts from an HR event, such as a hire date, a role change or a last day. It builds a cited footprint of everything that person touches in all 24 apps: Bam tasks and sprints, Bond deals, Helpdesk queues, Bolt rules they authored, API keys and service accounts, Book booking pages, Bin shares, Bay guest links, Bureau room ownership, Beacon articles they verify, and Bulwark obligations they own. It then drafts a reassignment and revocation plan into the agent_proposals queue. For joiners and movers, it learns a role template from what peers in the same role actually hold and proposes the delta. After execution it re-scans and reports any residue.
- **Scope (in):** person lifecycle events (manual, Blank form, or CSV/HRIS webhook); a cross-app footprint scanner; reassignment and revocation plans with an owner chosen per item; role templates learned from peers; HITL execution through existing MCP tools; a post-execution residue re-scan; a dated audit packet per transition.
- **Scope (out):** payroll and benefits; full HRIS records; device and MDM management; identity providers outside the suite (export a checklist only).
- **Why build it:** Axis: completeness. External HRIS and IT tools (Rippling, BambooHR) cannot see a departing rep's Bolt automations, open Bay guest links, or a verifier role on a Beacon article. Only a suite-native agent can enumerate that. Small teams lose deals, tickets and data at every departure because nobody owns the checklist.
- **Reuses:** auth/users/org memberships, @bigbluebam/permissions, api_keys, entity_links, v_activity_unified, agent_proposals, the MCP tool catalog as the execution arm, Bolt (`person.departed` and similar events), Braid for golden-profile resolution of external contacts the person owned.
- **Closest existing app:** Bam /b3/people. That screen is user CRUD and membership. Baton is the cross-app ownership-transfer process. It edits nothing itself and acts through each app's tools.
- **Lens fit:** onboarding and offboarding is the core people-ops ritual that every small firm improvises on a sticky note.

### Bastion (continuous controls and audit evidence)
- **Names:** Bastion · Buckler · Attest
- **One-line pitch:** Pick SOC 2 or ISO 27001, and an agent maps each control to proof the suite already holds, collects it continuously, and tells you which controls have drifted before an auditor does.
- **Description:** Bastion keeps a controls library (SOC 2, ISO 27001 and a lean "security questionnaire" baseline). An agent binds each control to an evidence query over live platform data: API-key rotation age, login_history and MFA coverage, agent_policies kill switches, Baton offboarding residue, Beacon policy-doc verification status, backup runs, and Blip retention. Bastion snapshots that evidence on a schedule into immutable Bin objects and raises a drift finding as a Bam task the moment a control fails. It also drafts answers to incoming security questionnaires, each answer citing its evidence. Unanswerable questions route to HITL.
- **Scope (in):** framework templates; control-to-evidence binding (AI-proposed, human-confirmed); scheduled evidence snapshots; a drift radar; questionnaire autofill with citations; an auditor share link (token-gated, read-only, like Bay guest links).
- **Scope (out):** acting as a certification body; endpoint and cloud scanning of non-suite infrastructure (accepts uploaded evidence instead); customer or vendor contract obligations (that is Bulwark).
- **Why build it:** Axis: cost and integration. Vanta and Drata start around $10k a year and still need connectors into every tool. Here the evidence sources are the platform's own tables. A 15-person firm facing its first enterprise security review today does it in spreadsheets.
- **Reuses:** activity_log, superuser-audit-log, login_history, api_keys, agent_policies, platform_backups, Beacon versions and verifications, Bin and @bigbluebam/storage (immutable evidence), Bam (remediation tasks), Bolt, agent_proposals, the Bench internal query route.
- **Closest existing app:** Bulwark. Bulwark tracks obligations owed under external contracts. Bastion proves internal controls to auditors. The counterparty, the artifact and the cadence are all different.
- **Lens fit:** compliance and GRC is a function large firms staff as a whole department, and small firms meet it with a panicked spreadsheet.

### Bloom (training generated from your own knowledge)
- **Names:** Bloom · Bootcamp · Primer
- **One-line pitch:** Your training writes itself from your own docs and recertifies only the people affected when a policy changes.
- **Description:** Bloom compiles Beacon articles, Brief docs, and resolved Helpdesk tickets into role-scoped learning paths: short lessons plus generated scenario checks, graded by an LLM with a rubric and every question citing its source passage. When a source changes (beacon_versions), Bloom diffs the change, decides whether it is material, and assigns a micro-recertification on just the delta to just the people whose role path includes it. Gap signals, such as reopened tickets or repeated reviewer rework on a topic, propose new lessons. Completion and attestation records feed Bastion as training evidence.
- **Scope (in):** path generation from sources; scenario quizzes with an LLM grader and citations; delta recertification on source change; policy attestation; role-based assignment (via Baton role templates); gap-signal proposals; completion records.
- **Scope (out):** a SCORM marketplace; authoring video courses; certifications from external bodies; performance management.
- **Why build it:** Axis: maintenance cost. A traditional LMS (TalentLMS, Trainual) goes stale the day after authoring, and every policy change means re-sending the whole course to everyone. Bloom keeps content bound to the source of truth and retrains surgically.
- **Reuses:** Beacon (entries, versions, verifications), Brief, Helpdesk, Qdrant retrieval, the llm-provider, Bolt (`entry.updated` triggers recert), Blank for the attestation UI pattern, Bench for completion dashboards, agent_proposals.
- **Closest existing app:** Beacon. Beacon stores what is true. Bloom proves who knows it, and re-proves it when the content changes. It is a learning and attestation system, not a knowledge base.
- **Lens fit:** training and enablement is whitespace that every firm needs and few small firms do at all.

### Brace (workplace incident and employee-relations case desk)
- **Names:** Brace · Buoy · Casebook
- **One-line pitch:** One confidential intake for injuries, near-misses, harassment and grievances. An agent classifies each one, starts the right legal clocks, and drives the case to closure.
- **Description:** Reports arrive from any channel: a Blank form, a Banter DM to a bot, a voice note, or an anonymous link. Brace classifies the report (injury and its recordability under OSHA 300/301-style rules, near-miss, harassment, policy violation, grievance), redacts it for need-to-know visibility, and starts statutory and policy clocks, such as serious-injury reporting windows and investigation SLAs. It drafts an investigation plan and interview questions, and proposes corrective actions as Bam tasks. Across cases it detects patterns, such as repeat locations, managers or hazards, that no single case reveals.
- **Scope (in):** multi-channel and anonymous intake; AI classification and recordability determination with citations to the rule text; a confidentiality ACL per case (stricter than RLS defaults); deadline clocks; investigation workspace; corrective actions linked to Bam; incident-log export; cross-case pattern alerts.
- **Scope (out):** workers' comp claims filing; legal advice (it flags matters for counsel); industry-specific hazard modules such as construction or clinical.
- **Why build it:** Axis: trust and speed. Small firms handle a harassment complaint or an injury in email and miss reporting windows, which creates liability. EHS suites (Intelex, EHS Insight) and ER tools (HR Acuity) are priced for enterprises. This is horizontal because every employer, including office-only ones, has these duties.
- **Reuses:** Blank (intake), Banter (bot intake), voice-agent, Bin (evidence and photos), @bigbluebam/permissions (case-level ACL), Bam (corrective actions), Bolt (clock events), agent_proposals, can_access visibility preflight.
- **Closest existing app:** Helpdesk. Helpdesk serves external customers' requests. Brace serves internal duty-of-care cases, with confidentiality, statutory clocks and investigation workflow that a ticket queue lacks.
- **Lens fit:** health and safety plus employee relations are the people-risk essentials that firms of every size are legally obligated to handle.

### Bravo (evidence-based performance reviews)
- **Names:** Bravo · Brag · Tally
- **One-line pitch:** Review season without the blank page. Each person gets a cited record of what they actually shipped, owned and moved, and managers get a draft review with bias checks.
- **Description:** Bravo builds each employee's evidence ledger from work already in the suite: Bam tasks closed, Bearing key results moved, Helpdesk CSAT, Brief docs authored, Beacon articles verified, and Bay approvals. It does this employee-first: the person curates and annotates their ledger before the manager sees it. At review time it drafts self and manager reviews where every claim cites evidence. It also flags recency bias (evidence clustered in the last month), uneven language across a team, and contribution types that are invisible in task counts, such as unblocking others. Calibration views compare ratings to evidence density.
- **Scope (in):** a per-person evidence ledger with employee curation; review cycles and templates; cited draft generation; bias and consistency linting; calibration; can_access-filtered evidence so a reviewer never sees what they cannot access.
- **Scope (out):** compensation planning; productivity surveillance or real-time scoring; 360 survey design (it uses Blank).
- **Why build it:** Axis: quality per hour. Lattice and 15Five are survey shells that start from memory. Bravo starts from cited records the suite already holds, and it cuts the 4 to 8 manager-hours per report per cycle that small-firm managers spend reconstructing the year.
- **Reuses:** v_activity_unified, Bam, Bearing, Helpdesk, Brief, Beacon, Bay, the can_access visibility preflight, the llm-provider, Blank (peer feedback), Bench, agent_proposals.
- **Closest existing app:** Bearing. Bearing tracks goals and key results for teams. Bravo evaluates people across all work, including work tied to no goal. It is a separate HR category.
- **Lens fit:** performance management is a core people-ops cycle that small firms skip or fake.

### Seat E - Operator / developer experience & platform tooling

### Bastion: identity and access lifecycle
- **Names:** Bastion · Badge · Keyring
- **One-line pitch:** One ledger of who can get into what across the suite and your other SaaS tools, with an agent that handles joiners, movers and leavers and runs your quarterly access reviews.
- **Description:** Bastion builds an access graph per person from the suite's own grants (`@bigbluebam/permissions`, project/channel memberships, API keys, `oauth_user_links`). It also infers which outside SaaS tools are in use from Bill expenses and imported seat CSVs. When a Bolt event fires (hire, role change, termination), an agent works out the access the person should now have from their role, compares it with what they actually have, and drafts the grants, revocations and handoffs into `agent_proposals`. A leaver's deals, tasks, docs and Bolt rules get reassigned before their account is locked. The same graph drives continuous access reviews: the agent pre-certifies grants that are clearly fine and sends only the odd ones (dormant, too broad, granted outside policy) to a manager with the evidence attached.
- **Scope (in):** person-to-resource access graph; role templates; joiner/mover/leaver runbooks that check they actually completed; ownership-transfer planner for a leaver's suite objects; SaaS seat inventory (CSV/expense-inferred); access-review campaigns with agent pre-certification; dormant-seat report.
- **Scope (out):** being an IdP or SSO provider; SCIM connectors to every vendor in v1 (external revocations are tracked tasks that need confirmation); device MDM; payroll/HRIS records.
- **Why build it:** Small firms have no IT department, so offboarding is a memory test and access reviews never happen. The tools that do this (Okta Lifecycle, Vanta access reviews, Zluri) cost enterprise money and can't see inside your work apps. Bastion can, because the suite is the system of record. Axis: **cost plus depth of integration**. It reassigns a leaver's open deals and Bolt rules itself instead of telling you to go and do it.
- **Reuses:** permissions resolver, auth/sessions/API keys, `oauth_user_links`, `agent_proposals`, Bolt events, `entity_links`, `activity_by_actor` (for dormancy), Bill expenses, Bin (CSV imports).
- **Closest existing app:** Braid. Braid resolves customer identities into golden records; Bastion governs employee access, a different subject and job. It is IT and access management, not a better CRM.
- **Lens fit:** this is the operator's core job of keeping access correct, done by an agent that can see every app.

### Binder: continuous compliance evidence
- **Names:** Binder · Bailiwick · Proofline
- **One-line pitch:** Pick SOC 2 or ISO 27001 and an agent maps each control to evidence your workspace already produces, keeps it current, and hands the auditor a finished packet.
- **Description:** Binder ships control frameworks as data. For each control, an agent proposes an evidence query against signals the platform already has: activity_log, `agent_audit`, RLS posture, API-key rotation, session policy, Blip retention, Bastion access reviews, Beacon policy pages, Helpdesk incident tickets. The queries run on a schedule and each snapshot is frozen as a hashed Bin asset. When a control drifts (a key not rotated, a review overdue), Binder opens a remediation task in Bam. Controls that have no automated signal get a drafted request to a named owner, with a sample of what acceptable evidence looks like.
- **Scope (in):** framework catalog (SOC 2, ISO 27001, a custom framework); control-to-evidence mapping proposed by the agent; scheduled collection with immutable snapshots; drift detection that files Bam tasks; owner evidence requests; auditor read-only portal and export packet.
- **Scope (out):** issuing attestations; vendor risk questionnaires (Bursar's area); customer contract obligations (Bulwark's); legal advice; HR policy authoring beyond linking to Beacon.
- **Why build it:** Vanta and Drata start around $10k a year and mostly collect screenshots through connectors. A 15-person firm facing its first enterprise security questionnaire can't justify that. Binder gets most of its evidence from the platform the team already works in, so the integration cost is close to zero. Axis: **cost plus evidence that can be trusted**, because snapshots are immutable and every one cites the query that produced it.
- **Reuses:** activity_log and `agent_audit`, Blip, Bin (immutable snapshots), Bam (remediation tasks), Beacon (policies), Bolt (drift events), permissions (auditor guest role), MCP catalog (evidence queries are tool calls).
- **Closest existing app:** Bulwark. Bulwark tracks obligations in external contracts with customers and vendors; Binder proves your own internal controls to an auditor. Different counterparty, artifact and buyer.
- **Lens fit:** compliance evidence is operator telemetry turned into proof, and nobody should be collecting it by hand.

### Butler: internal employee service desk agent
- **Names:** Butler · Bellhop · Concierge
- **One-line pitch:** Employees ask for what they need ("give me access to the Acme project", "how do I file travel", "my laptop died") and an agent resolves most of it within policy, sending the rest to the right person.
- **Description:** This is employee service management (IT, ops and office requests) run by an agent. It is not a ticket queue. Each request type is a catalog item with a policy and an MCP action plan: who can ask, what auto-approves, what needs a manager's approval through `agent_proposals`, and which tools carry it out. The agent answers from Beacon, carries out permitted actions directly (add to project, create channel, reset an API key, book a room in Bureau), and leaves an audit trail. Its deflection-gap report lists the requests it couldn't resolve, which tells the operator what to automate or document next.
- **Scope (in):** request catalog with per-item policy; intake from Banter DM, a web form and email; autonomous execution through the MCP catalog under `agent_policies` allowlists; manager approvals; answers grounded in Beacon; deflection and gap analytics.
- **Scope (out):** external customer support (Helpdesk); a full ITIL CMDB; hardware procurement (Bursar); payroll questions that need HRIS data.
- **Why build it:** Freshservice and Jira Service Management are ticket queues that still need a human to do the work. In a small firm "IT" is the founder answering Slack DMs. Butler does the work itself, because every resolution is an MCP tool call it is already allowed to make. Axis: **speed** (seconds instead of a day) and **staffing** (no service desk team).
- **Reuses:** MCP catalog with `agent_policies`, `agent_proposals`, Banter (intake), Beacon (answers), Blank (catalog forms), Bastion role templates when present, Bolt, `can_access` preflight.
- **Closest existing app:** Helpdesk. Helpdesk is a portal where human agents answer external customers' tickets; Butler serves internal employees and executes the resolution itself.
- **Lens fit:** the operator's inbox, made agent-operable from start to finish.

### Brick: agent-native spreadsheet
- **Names:** Brick · Bento · Grid
- **One-line pitch:** A spreadsheet where any cell can be a live, permission-checked query into the suite and any column can be filled by an agent, so operational trackers stop going stale.
- **Description:** Brick is a collaborative grid (Yjs CRDT, reusing `@bigbluebam/structured-data`) with two kinds of cell beyond plain values. `=SUITE(...)` formulas call read-only MCP tools or certified Basis metrics, and every viewer's results are filtered by `can_access` for that viewer. Agent columns take a natural-language instruction per row ("summarize this deal's last touch", "classify risk"), and their values are cached, carry the source they came from, and refresh when the underlying Bolt event fires. Sheets can also be written to by agents through MCP, which makes them an agent-operable staging surface for bulk changes; applying a staged change still goes through proposals.
- **Scope (in):** grid with formulas; live suite-query cells with per-viewer scoping; agent columns with source provenance; event-driven recompute; staging bulk writes back to apps through `agent_proposals`; import and export (CSV/XLSX).
- **Scope (out):** charts and dashboards (Bench); metric definitions (Basis); file storage (Bin); presentations; Excel macro compatibility.
- **Why build it:** Small teams run on Google Sheets copy-pasted from their tools, and those sheets are wrong by Tuesday and leak data that people shouldn't see. Brick's cells are live and enforce permissions per viewer. Axis: **trust** (permission-correct live data) and **integration** (no export/import loop).
- **Reuses:** `@bigbluebam/structured-data` (Yjs, codecs), MCP read tools, Basis, `can_access`, Bolt, `agent_proposals`, Bin (file import).
- **Closest existing app:** Bin. Bin's structured-data editor edits stored data files. Brick is a computational sheet (formulas, live queries, agent columns), which puts it in the office/productivity category, not file management.
- **Lens fit:** gives operators the tool they actually build trackers in, wired into the platform instead of exported from it.

### Bosun: suite configuration from intent
- **Names:** Bosun · Baseline · Ballast
- **One-line pitch:** Describe your company ("12-person design agency, client work, monthly invoicing") and an agent configures the whole suite to fit, then keeps the configuration from drifting.
- **Description:** Bosun treats the configuration of all 24 apps as one declarative workspace plan: project templates, phases, Bond pipelines, Bill terms, Bolt rules, permission groups, Banter channels, retention settings. An agent drafts the plan from a plain-language description and an interview, shows a diff against the live state, and applies it through MCP in staged, reversible proposals. After that it watches for drift and misconfiguration (orphaned Bolt rules, permission groups nobody is in, apps that are on but unused) and proposes fixes, so a non-technical operator gets the result of an experienced administrator.
- **Scope (in):** a single workspace-plan schema covering all apps; drafting the plan from an interview; diff, apply and rollback through `agent_proposals`; a drift and misconfiguration linter; plan templates for common company shapes.
- **Scope (out):** infrastructure and deployment (`deploy.sh`); a new automation engine (Bolt); per-app UIs; data migration from other vendors.
- **Why build it:** The suite's breadth is its weakness at first contact. 24 apps are 24 settings pages, and the target buyer has no administrator. Bosun turns breadth into time-to-value. Axis: **onboarding speed** for the customer organization (hours rather than weeks). No competitor can do this because none has an MCP surface this complete.
- **Reuses:** full MCP catalog, `agent_proposals`, `agent_policies`, Bolt observability (`catalog.drift_detected`), permissions, system settings and `LAUNCHPAD_CATALOG`.
- **Closest existing app:** Bolt. Bolt runs event-triggered automations; Bosun declares and reconciles the configuration of every app. It is platform administration, not a second automation builder.
- **Lens fit:** the platform tool the operator needs most, administration done through intent rather than settings pages.

### Seat F - Engineering & Software Development

### Bastion: continuous compliance evidence from engineering systems
- **Names:** Bastion · Bedrock · Attest
- **One-line pitch:** SOC 2 / ISO 27001 readiness that collects its own evidence from your repos, deploys, and suite activity, so the audit is a weekly report and not a six-week scramble.
- **Description:** You declare a control framework (SOC 2 CC-series, ISO 27001 Annex A, or a custom one). An AI mapper links each control to machine-checkable evidence sources: branch-protection and review-before-merge from the existing Bam GitHub integration, access changes in `activity_log`, deploy records, Blip retention policies, and Beacon policy articles with acknowledgment. Agents re-test controls on a schedule and produce a clause-cited evidence packet. When a control drifts (for example a PR merged with no review, or an ex-employee still holding an API key), the agent drafts a remediation into `agent_proposals` and opens a Bam task. The auditor gets a token-gated read-only evidence room.
- **Scope (in):** framework/control library; control-to-evidence mapping (AI-proposed, human-confirmed); scheduled control tests; drift detection and remediation proposals; policy authoring linked to Beacon with per-person attestation; evidence-room export; MCP tools (`bastion_control_status`, `bastion_evidence_for`).
- **Scope (out):** vendor/customer contract obligations (that is Bulwark); pen-testing or vulnerability scanning; legal opinions; cloud-infrastructure CSPM beyond what webhooks and APIs expose.
- **Why build it:** Vanta and Drata cost $10-30k/yr, which prices out the 2-50 person teams BigBlueBam targets, and those teams still hand-screenshot their evidence. Bastion wins on **cost and integration depth**: the evidence already lives inside the suite (activity log, GitHub integration, Beacon, Blip), so there are far fewer connectors to buy or maintain.
- **Reuses:** Bam GitHub integration and `activity_log`, `v_activity_unified`, Beacon (policies), Blip (retention/log evidence), Bin (evidence artifacts), `agent_proposals`, Bolt events (`control.failed`), @bigbluebam/permissions, RLS.
- **Closest existing app:** Bulwark. It tracks obligations *to outside parties written in contracts*; Bastion tests the org's *own internal controls* against a framework. The evidence, the buyer and the output (an audit packet) are all different.
- **Lens fit:** It turns the engineering systems of record (repos, reviews, deploys, keys) into compliance evidence automatically.

### Badge: AI access governance and joiner/mover/leaver for SaaS and the suite
- **Names:** Badge · Bouncer · Keyring
- **One-line pitch:** Know who has access to what across your tools, and have an agent provision, right-size, and revoke it when people join, change roles, or leave.
- **Description:** Badge keeps an identity-to-entitlement graph covering suite roles, API keys, and service accounts, plus connected SaaS (GitHub org, Google Workspace, Slack, AWS IAM via read APIs). An agent compares actual access with role baselines that it infers from peer groups. It flags toxic combinations, stale keys, and orphaned accounts, then runs quarterly access reviews in which managers approve in one click and the agent stages the revocations. Joiner/mover/leaver events produce a full provisioning plan that sits as a proposal until a human approves it.
- **Scope (in):** entitlement inventory (suite plus 4-5 read connectors); peer-group baseline inference; anomaly and stale-access detection; access-review campaigns; JML playbooks as `agent_proposals`; license/seat waste report; MCP tools for agents.
- **Scope (out):** a full IdP/SSO (it federates with existing OAuth providers); hardware asset tracking; MDM; payroll/HRIS records.
- **Why build it:** Small teams offboard by memory, and access reviews happen only when an auditor asks. Okta Identity Governance and ConductorOne are enterprise-priced. Badge wins on **trust and cost**, plus seat savings that cover its own price.
- **Reuses:** `users.kind`, API-key rotation tables, `agent_policies`, oauth_providers, @bigbluebam/permissions, `agent_proposals`, Bolt (`access.anomaly`, `member.removed`), and it feeds Bastion-style evidence.
- **Closest existing app:** none. `/b3/people` is user CRUD for the suite only, while Badge governs entitlements across external SaaS, which is IT/access-management whitespace.
- **Lens fit:** Engineering-grade identity and secrets hygiene, made operable by a non-technical office manager.

### Bulletin: release communications autopilot
- **Names:** Bulletin · Broadcast · Herald
- **One-line pitch:** Every shipped change becomes the right message for each audience (changelog, customer notice, sales enablement note, help-article update) without a PM writing it four times.
- **Description:** Bulletin listens to merged PRs (via the Bam GitHub integration), completed Bam tasks, and sprint closes. An agent clusters these into releases and classifies each change by audience impact. It then drafts audience-tiered artifacts: a public changelog page, an in-app "what's new" feed, an internal sales/support brief, and diffs against affected Beacon/Helpdesk articles. It also drafts targeted customer notices to the Bond accounts that asked for the feature (traced through Helpdesk tickets and entity_links). Everything goes through an approval queue before it publishes.
- **Scope (in):** change ingest and release clustering; audience classification; multi-tier drafting with brand voice; stale-doc detection against Beacon/Helpdesk KB; "you asked, we shipped" requester matching; hosted changelog plus embeddable widget; HITL publish.
- **Scope (out):** bulk email delivery (it hands off to Blast); feature flags or deployment itself; roadmap voting portal (v2).
- **Why build it:** Release notes are where engineering meets marketing, and small teams skip them. LaunchNotes and Beamer are just editors, and none of them close the loop to the customers who requested a change. The axis is **speed plus closed-loop customer communication** from data no standalone tool can see.
- **Reuses:** Bam GitHub integration, Bam tasks and sprints, Helpdesk tickets, Bond contacts, entity_links, Beacon, Blast (send), `agent_proposals`, Bolt (`release.published`).
- **Closest existing app:** Blast. Blast sends campaigns you author; Bulletin *derives* the messaging from shipped work and routes it per audience, which is product-marketing communication rather than an email tool.
- **Lens fit:** It turns the engineering output stream into marketing and customer communication.

### Bespoke: agent-built internal tools for non-engineers
- **Names:** Bespoke · Bodge · Toolsmith
- **One-line pitch:** Describe the internal tool you need ("a PTO approval screen", "a weekly inventory checklist") and an agent assembles a governed mini-app on top of the suite's own data and actions.
- **Description:** Bespoke composes small apps (forms, tables, approval buttons, scheduled actions) out of the existing MCP tool catalog of over 800 tools and Bin structured data. It does not generate free code. The output is a declarative spec that runs through the user's own permissions and `can_access`, so the tool can never exceed its builder's rights. Each generated tool is itself agent-operable, versioned, and diffable, and the agent repairs it when an underlying tool schema changes.
- **Scope (in):** natural language to declarative app spec; a component set (table, form, detail, button bound to an MCP tool, schedule); permission-scoped execution; versioning and diff review; a gallery of templates; schema-drift self-repair.
- **Scope (out):** arbitrary code execution; external database connectors in v1; public-facing sites; pixel-level design.
- **Why build it:** Small teams with no engineers live in spreadsheets, while Retool and Airtable Interfaces need a builder plus integrations. Bespoke wins on **integration (zero connectors) and trust** (every action already has permissions, audit and a kill switch).
- **Reuses:** MCP tool catalog and internal `/tools/call`, `agent_policies`, `can_access`, Bin structured data, Blank (form rendering patterns), Bolt (scheduled triggers), @bigbluebam/ui.
- **Closest existing app:** Bolt. Bolt automates event→action rules with no UI; Bespoke produces human-facing screens. It is a productivity/internal-tools category, not a better rule engine.
- **Lens fit:** It brings the developer-platform surface (MCP, schemas, versioning) to non-engineers.

### Bootcamp: ramp-up engine that learns from your own systems
- **Names:** Bootcamp · Ballast · Primer
- **One-line pitch:** New hires, in any role, get a personalized ramp plan and quizzes generated from your actual docs, code, tickets, and deals, and managers see real time-to-productivity.
- **Description:** For each role, an agent mines the org's corpus (Beacon, Brief, Helpdesk resolutions, Bond playbooks, repo READMEs and architecture via the GitHub integration) into a cited curriculum. It then sequences that curriculum per hire, using "first task" picks from Bam, shadow tickets in Helpdesk, and Book sessions with the expertise-for-topic owner. It checks understanding with grounded quizzes, measures ramp from real activity (first merged PR, first resolved ticket), and flags curriculum items that cite stale docs.
- **Scope (in):** role curricula generated from the corpus; per-hire plans; grounded assessments; buddy/expert matching via `expertise_for_topic`; ramp metrics from `v_activity_unified`; stale-source alerts back to doc owners.
- **Scope (out):** a SCORM/LMS course marketplace; compliance-training certification tracking (v2); HR records and payroll.
- **Why build it:** Onboarding at small firms is "read the wiki and ask Dave." LMS products need content authoring that nobody has time for. Bootcamp wins on **speed and zero authoring**, because the content already exists in the suite.
- **Reuses:** Beacon/Brief/Qdrant retrieval, `expertise_for_topic`, `v_activity_unified`, Bam (starter tasks), Book (pairing sessions), Helpdesk, the GitHub integration, Bolt (`member.joined`), `agent_proposals`.
- **Closest existing app:** Beacon. Beacon stores knowledge; Bootcamp sequences, assesses and measures learning per person, which is learning and enablement rather than a knowledge base.
- **Lens fit:** Engineering-style onboarding (codebase walkthroughs, first-PR metrics) generalized to every role.

### Seat G - Creative, Marketing & Brand

### Bugle: social publishing that drafts from what the business actually did
- **Names:** Bugle · Bullhorn · Buzz
- **One-line pitch:** Your company's real work, like shipped features, closed deals, events and new hires, becomes on-brand social posts on every network, ready for one-click approval.
- **Description:** Bugle subscribes to Bolt events across the suite (a Bam epic shipped, a Bond deal won with permission to name the client, a Book webinar published, a Beacon article released). It treats each one as a story candidate. An agent then writes channel-native variants (LinkedIn long form, X thread, Instagram caption plus a crop pulled from Bin), proposes a time slot using the account's own engagement history, and files each post into `agent_proposals` for human approval. Inbound replies and mentions are sorted into the right home: a support complaint becomes a Helpdesk ticket, a buying signal becomes a Bond activity, and plain noise is ignored. It is publishing driven by events, not a calendar someone has to fill.
- **Scope (in):** connected accounts for LinkedIn, X, Facebook/Instagram, Bluesky and Threads; an event-to-story candidate feed; generating a variant per channel; an approval queue (`agent_proposals`); a schedule and publish worker; a unified inbox for replies and mentions with AI routing to Helpdesk and Bond; engagement metrics per post written to Bench; MCP tools (`bugle_draft_from_entity`, `bugle_schedule`, `bugle_inbox_triage`).
- **Scope (out):** paid boosting and ads (that is Billboard); influencer marketplaces; broad social listening across the whole web; video editing; email (Blast).
- **Why build it:** Small teams know they should post and don't, because the bottleneck is deciding what to say, not scheduling it. Hootsuite, Buffer and Sprout give you a blank calendar at $99 to $400 per seat per month. Bugle's wedge is **content supply plus integration**: the suite already knows what happened this week, so the hard part is gone. Replies flow into Helpdesk and Bond, which no standalone scheduler can do.
- **Reuses:** Bolt event ingest, `agent_proposals` for approvals, Bin for media, Bay for creative sign-off on visual posts, Helpdesk and Bond for routing replies, Braid to resolve who an engaging account is, Bench for metrics, the worker for publish jobs, and auth, RLS and permissions.
- **Closest existing app:** Blast. Blast sends owned email to a consented list. Bugle publishes in public on rented networks and handles conversations in both directions. They are different channels, different rules and different loops.
- **Lens fit:** This is the core of marketing comms for an SMB: being visibly active in public, staffed by an agent instead of a social media manager.

### Blazon: brand governance as an executable policy every agent must pass
- **Names:** Blazon · Badge · Brandbook
- **One-line pitch:** Turn your brand guidelines into a live checker that reviews every email, post, doc and image before it goes out, and fixes what it can.
- **Description:** Blazon turns a brand book (a PDF in Bin, or one written in the app) into a structured, versioned policy covering voice and tone, banned and required terms, product naming, claims that need substantiation, legal disclaimers, logo clear-space and color rules, and accessibility contrast. A `brand_check(artifact)` MCP tool and a pre-publish hook score any outgoing artifact (a Blast campaign, a Bugle post, a public Brief doc, a Bin image, a Bay asset). Every finding cites the rule it breaks and comes with a suggested fix. Image and layout checks use vision models against the asset rules. Every other agent in the suite has to clear this check, which matters because the suite is filling up with agents that produce text.
- **Scope (in):** ingesting and authoring brand policy, with version lineage; text checks (voice, terminology, claims, disclaimers); visual checks (logo misuse, palette, contrast); auto-fix suggestions; pre-send gates for Blast, Bugle and Bay that warn or block depending on per-org settings; an approved-claims library with a cited source for each; a dashboard showing which teams and agents drift most; MCP tools (`brand_check`, `brand_fix`, `brand_rule_explain`).
- **Scope (out):** asset storage (Bin); the review and approval workflow (Bay); designing or generating creative; trademark registration and legal clearance.
- **Why build it:** Large companies pay Frontify, Acrolinx or Writer $20k to $100k+ a year, plus a brand team, for this. Small companies have a PDF nobody reads. Now that agents write most outbound content, an off-brand or unsubstantiated claim can go out at machine speed. The axis is **trust and cost**: enterprise-grade governance at SMB price, enforced at the moment of publishing instead of in a review meeting.
- **Reuses:** Bin (brand assets, the source PDF), the internal llm-provider, MCP register-tool hooks, Blast, Bay and Bugle as gate points, `agent_proposals` for overrides, Bolt (`brand.violation` events), and permissions for who can change policy.
- **Closest existing app:** Bay. Bay is a person approving one specific media file. Blazon is an automatic rule set applied to every artifact from every app and agent. It sits upstream of Bay and makes Bay reviews shorter rather than replacing them.
- **Lens fit:** This is the branding function itself: guidelines that enforce themselves.

### Billboard: guardrailed autonomous ad operations tied to revenue
- **Names:** Billboard · Bidder · Bannerad
- **One-line pitch:** An ad agent that runs your Google, Meta and LinkedIn campaigns within a budget and rules you set, and judges them on closed deals, not clicks.
- **Description:** Billboard connects ad accounts and pulls spend and performance. Using Braid, it joins conversions to Bond deals and Bill revenue, so every campaign has a real cost per won deal. An agent paces budget, pauses losing ad sets, shifts spend between campaigns, and generates new creative and copy variants (checked by Blazon). It acts on its own only inside hard guardrails: a daily cap, a maximum change per action, and channels on an allowlist. Anything outside those limits becomes a proposal for a human. Every change is logged with the reason the agent gave.
- **Scope (in):** connectors for Google Ads, Meta and LinkedIn Ads; ingesting spend and performance; offline conversion upload from Bond stage changes; attribution to revenue via Braid and Bill; a guardrail policy engine; autonomous pacing and pause actions; generating creative variants; an audit trail of changes; MCP tools (`ads_status`, `ads_propose_shift`, `ads_cost_per_won_deal`).
- **Scope (out):** programmatic and DSP buying; TV, print and out-of-home; agency billing; building a full multi-touch attribution model in v1 (it uses deterministic first-touch and last-touch plus a CRM join).
- **Why build it:** Small companies either overpay agencies (10 to 20% of spend) or leave Smart Campaigns on autopilot, optimizing for platform metrics they can't connect to revenue. The axis is **outcome truth plus cost**: the suite owns the CRM and invoicing data that the ad platforms can't see, so it can optimize for paid invoices.
- **Reuses:** Braid (identity join), Bond (deal stages), Bill (revenue), Basis (a certified CAC metric), Bench (reporting), Bolt (`campaign.underperforming` events), `agent_proposals`, Bin and Blazon for creative, and the worker for sync jobs.
- **Closest existing app:** Blast. Blast is owned email to a list you already have. Billboard is paid reach to people not yet in Bond, with budget autonomy as the core mechanism.
- **Lens fit:** This is advertising: the most expensive marketing line item small companies run blind.

### Byline: PR and communications desk with a message house as its source of truth
- **Names:** Byline · Bulletin · Herald
- **One-line pitch:** One place to set what the company says, pitch it to the right journalists, track the coverage, and have a holding statement ready before a crisis lands.
- **Description:** Byline keeps a versioned "message house" (core narrative, proof points, approved spokespeople, topics off limits). It also keeps a media list enriched by an agent that reads each journalist's recent coverage to score how relevant they are to a given announcement. For each announcement it drafts the release, personalized pitches and an FAQ, then sends everything through approval. It watches coverage and summarizes reach and sentiment against the message house ("did they say what we meant?"). For incidents (a Blip outage, a Helpdesk spike), Bolt triggers drafting of holding statements and internal talking points that a human approves before anything goes out.
- **Scope (in):** message house and spokesperson registry; a media contact list (stored as Bond contacts with a press role); relevance scoring per announcement; drafts of the release, pitch and FAQ; an approval queue; coverage monitoring and a clip book; crisis playbooks triggered by Bolt events; internal announcement versions posted to Banter; MCP tools (`pr_draft_release`, `pr_pitch_targets`, `pr_crisis_draft`).
- **Scope (out):** paid newswire distribution (export only); a buying database of journalists; social publishing (Bugle); investor relations filings.
- **Why build it:** Cision and Muck Rack cost $7k to $20k+ a year, so small companies simply don't do PR or hire a freelancer. The axis is **cost plus speed in a crisis**: the suite sees the outage or ticket spike first and can have an approved statement ready in minutes, not hours.
- **Reuses:** Bond (contacts), Braid, Beacon (facts and proof points), Blip and Helpdesk events through Bolt, Banter (internal comms), `agent_proposals`, Blazon (voice), and Bin (press kit).
- **Closest existing app:** Beacon. Beacon stores internal knowledge. Byline manages external narrative and media relationships, which is a different audience, workflow and success metric.
- **Lens fit:** This is the PR and corporate communications function that small firms currently improvise.

### Backdrop: presentations built from live suite data, kept current
- **Names:** Backdrop · Brio · Podium
- **One-line pitch:** Ask for "the Q4 board deck" or "the Acme renewal pitch" and get an on-brand presentation whose numbers and slides stay true as the data changes.
- **Description:** Backdrop stores a deck as a typed graph of slides. Each slide is bound to sources: a Basis certified metric, Bearing goals, a Bond account view, Bench charts, Beacon passages. It is not a pile of pasted screenshots. An agent assembles a deck from an intent plus the brand template from Blazon. It also re-checks the bindings before the deck is presented, flagging and offering to refresh any slide whose figure has moved or whose source the viewer can't access (`can_access`). Decks export to PPTX and PDF, and can be presented live with speaker notes.
- **Scope (in):** a slide editor (layouts, text, images, charts); source-bound blocks with freshness badges; generating a deck from intent and from templates; brand theme enforcement; viewer-scoped redaction through `can_access`; PPTX and PDF export, and PPTX import; present mode; MCP tools (`deck_generate`, `deck_refresh`, `slide_bind`).
- **Scope (out):** animation and transitions beyond basics; webinar hosting (Bureau and Book); full PowerPoint feature parity; free-form whiteboarding (Board).
- **Why build it:** Presentations are the remaining big gap in the office suite, and every QBR, board update and sales pitch is rebuilt by hand from stale screenshots. Gamma and Tome generate pretty slides with no ground truth behind them. The axis is **trust**: every number traces back to a governed source and refreshes, and permissions mean one deck can be shown safely to different audiences.
- **Reuses:** Basis, Bench, Bearing, Bond and Beacon as bound sources; Blazon for themes; Bin for images and export storage; `can_access` visibility preflight; Bolt (`metric.changed` for staleness); and permissions.
- **Closest existing app:** Board. Board is a free-form collaborative canvas. Backdrop is a linear, data-bound narrative document for an audience. Bench renders charts, while Backdrop tells a story with them.
- **Lens fit:** This is marketing and sales communications, the pitch deck being the most-used brand artifact a company has.

### Orchestrator note on Phase 1

35 proposals, every one in a whitespace or covered category, none in a dense one and none a vertical. The field is heavily clustered, which the debate must sort out:

- **Compliance / GRC controls evidence** (SOC 2 / ISO 27001 from suite data): 5 seats (A Bastion, B Baseline, D Bastion, E Binder, F Bastion). Same idea in five framings.
- **Joiner / mover / leaver, ownership handover**: 5 seats (A Berth, B Baton, C Baton, D Baton, E Bastion-JML).
- **Learning & enablement from friction / own docs**: 5 seats (A Brevet, B Boost, C Buddy-onboarding, D Bloom, F Bootcamp).
- **Access governance / reviews (IT)**: B Badge, E Bastion, F Badge.
- **Social publishing from suite events**: A Bullhorn, C Bullhorn, G Bugle.
- **Employee listening / engagement**: B Bellwether, C Barometer.
- **Distinct singletons**: A Bevy (HR core + agent workforce), C Bugle (internal announcements), D Brace (incident / ER case desk), D Bravo (performance reviews), E Butler (employee service desk), E Brick (spreadsheet), E Bosun (suite config), F Bulletin (release comms), F Bespoke (internal tools), G Blazon (brand governance), G Billboard (ads), G Byline (PR), G Backdrop (presentations).

The name "Bastion" was used by four seats for three different apps, and "Baton" by three seats; names are settled at merge/selection time.

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

## Outcome

_(pending)_
