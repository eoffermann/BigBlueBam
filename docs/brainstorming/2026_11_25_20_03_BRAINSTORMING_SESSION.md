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

One debate round. Each seat read all seven Phase 1 blocks from this document (rather than having them relayed seven times) along with the orchestrator note on clustering, then took align/oppose/ignore stances and revised its five. Replies below are verbatim.

### Seat A - debate reply

### Bevy (agent-run people ops and employee request desk, for a mixed human and agent workforce)
- **Names:** Bevy · Bellhop · Roster
- **One-line pitch:** You get an HR and ops department without hiring one. Employees ask in plain language for time off, a role change, access, equipment or a policy answer, and an agent decides and carries out the request within policy, with a manager approving only the exceptions.
- **Description:** Bevy is the suite's missing people system of record: person and agent records, org chart, managers, roles, employment status, leave balances. On top of it sits a request desk where every request type is a catalog item with a policy and an MCP action plan. The agent reads the policy from Beacon, checks coverage in Bam and Book, applies the approval chain, then carries the request out through the MCP catalog: it books leave, adds the person to a project, rotates a key, or opens a checklist task for a physical step. Exceptions go through agent_proposals. AI agents (`users.kind = agent`) are on the same roster with a human owner, a scope linked to agent_policies, a review date and a cost, so the question "who works here" includes the bots.
- **Scope (in):** person and agent records and org chart; status and role changes, which emit Bolt `person.*` events that the joiner/mover/leaver app consumes; time off with coverage-aware auto-approval; a request catalog with per-item policy, auto-approve rules and MCP execution under agent_policies; cited policy Q&A; acknowledgements; agent owner and review records; a "requests we could not resolve" gap report.
- **Scope (out):** payroll, benefits, recruiting, performance reviews, the cross-app ownership handover itself (Baton/Berth), external customer support (Helpdesk).
- **Why build it:** Under 50 people, HR and IT are the founder's inbox. BambooHR and Gusto are form-and-approval CRUD apps. Freshservice and JSM are queues where a human still does the work. Bevy resolves the request itself, because each resolution is an MCP call it is already allowed to make. Axes: **staffing** (no HR/IT headcount), **speed** (seconds, not days), and **first-mover on governing agents as workforce members**.
- **Reuses:** users / users.kind, agent_runners, agent_policies, MCP catalog and internal /tools/call, agent_proposals, Beacon, Book, Bam, Banter (intake), Blank (catalog forms), Bolt, permissions, can_access.
- **Lens fit:** an autonomous agent decides and executes the request; humans handle exceptions only.
- **Closest existing app:** Bam /b3/people. That screen is account and membership CRUD. Bevy is the HR system of record plus an agent that executes employee requests, and Helpdesk serves external customers only.

### Baton / Berth (joiner / mover / leaver autopilot, merged-ready)
- **Names:** Baton · Berth · Bridle
- **One-line pitch:** When someone joins, changes role or leaves, an agent works out everything they own or can reach across all apps, runs the handoff, and proves nothing was orphaned and no access remains.
- **Description:** A lifecycle event, from Bevy or entered manually, is compiled into a typed, reversible plan. The plan covers grants and revocations (memberships, API keys, guest links, agent_policies) and successor assignment for every owned object (deals, tasks, tickets, Bolt rules, Book pages, Bulwark obligations), with successors chosen by expertise_for_topic and current load. The agent executes the plan through MCP, with destructive steps routed through agent_proposals. It then re-scans and issues an access-zero / orphan-zero certificate checked against @bigbluebam/permissions. For joiners and movers, the role template is learned from what peers in the same role actually hold.
- **Scope (in):** cross-app footprint scanner; plan compiler with a dry-run diff; peer-learned role templates; successor proposals; HITL execution through MCP; a residue re-scan and a dated certificate (which the GRC app ingests as evidence); a bus-factor view of sole-owned assets; a cited handover dossier.
- **Scope (out):** HRIS records (Bevy); payroll; MDM; external SaaS connectors in v1 (those become tracked manual steps).
- **Why build it:** Rippling and Okta Workflows stop at account creation and cannot see a departing rep's Bolt rules or Bay guest links. Axis: **completeness and provability**.
- **Reuses:** permissions, api_keys, entity_links, v_activity_unified, expertise_for_topic, MCP catalog, agent_proposals, Bolt, Beacon (dossier).
- **Lens fit:** one intent becomes a verified autonomous multi-app run.
- **Closest existing app:** Bolt. Bolt runs rules a human authors. This app generates a per-person plan and verifies the end state.

### Bastion (continuous controls agent; I back the merged GRC entry)
- **Names:** Bastion · Binder · Attest
- **One-line pitch:** SOC 2 / ISO 27001 where agents re-test every control against what actually happened in the suite and tell you which controls nothing can currently prove.
- **Description:** This is the merged form of B, D, E, F and my own version. The framework is compiled into typed control assertions, each bound to queries over the suite's own data. Assertions are re-tested on a schedule, with evidence frozen and hashed in Bin. A "no data" list names the controls nothing can prove. Drift produces remediation proposals. Security questionnaires are auto-answered from cited evidence, and auditors get a token-gated evidence room.
- **Scope (in):** framework-to-assertion compiler; scheduled tests; immutable evidence; unprovable-control list; drift into Bam tasks; questionnaire autofill; auditor room; ingestion of the Baton certificate and the Bevy access-review / acknowledgement records.
- **Scope (out):** contract obligations (Bulwark), vendor risk, pentesting, attestation issuance.
- **Why build it:** Vanta and Drata cost $10-40k a year and depend on connectors. Here the evidence is native. Axis: **cost and integration depth**.
- **Reuses:** v_activity_unified, permissions, api_keys, agent_audit, Blip, Beacon, Bin, Bam, Bolt, agent_proposals.
- **Lens fit:** the audit becomes a continuous agent-run test suite.
- **Closest existing app:** Bulwark. Bulwark covers obligations to counterparties, while Bastion covers internal controls proven to an auditor.

### Brevet (enablement aimed at measured friction, retrained on source change)
- **Names:** Brevet · Bloom · Primer
- **One-line pitch:** Training that writes itself from your own docs, goes only to the people whose work shows a gap, and retrains only the affected people when a policy changes.
- **Description:** Two triggers start a lesson. The first is friction signals (repeat Banter questions, reopened tickets, Bay rejections, low-confidence Beacon searches), clustered into skill gaps. The second is material source changes (beacon_versions diffs). The agent compiles cited micro-lessons and scenario checks with an LLM grader, assigns them to exactly the affected people, and certifies a skill only when the person's friction signal drops.
- **Scope (in):** gap clustering; cited lesson generation; delta recertification; role paths seeded from Bevy roles; outcome-based certification; completion and attestation records exported to Bastion.
- **Scope (out):** SCORM marketplace, video authoring, external certifications, performance management.
- **Why build it:** In TalentLMS or Trainual, content goes stale and nobody authors it. Axis: **zero authoring cost and proven impact**.
- **Reuses:** Beacon/Brief + Qdrant, Helpdesk, Banter, phrase-count tools, expertise_for_topic, Blank, Bolt, Bench.
- **Lens fit:** a closed detect, teach, verify loop that runs without an L&D staff.
- **Closest existing app:** Beacon. Beacon stores knowledge, while Brevet proves who knows it.

### Beckon (agent-run recruiting pipeline; replaces my Bullhorn)
- **Names:** Beckon · Bounty · Scout
- **One-line pitch:** Open a role and an agent writes the job post from what the job actually involves, screens applicants against a cited rubric, books the interview loop and drafts the decision packet. A human makes every hire/no-hire call.
- **Description:** This is the only ATS on the board. The requisition is grounded in the work graph: what the predecessor and peers actually do in Bam, Bond and Helpdesk becomes the job description and a structured, job-related rubric. Applications arrive through a Blank-backed careers page. The agent scores each one against the rubric with cited evidence, never on demographics. It schedules panels via `book_find_meeting_time_for_users`, collects structured scorecards, and flags inconsistent or biased scorecard language. On offer accept it creates the Bevy record and fires the joiner event.
- **Scope (in):** requisitions with work-grounded JD and rubric; careers page and intake; cited rubric screening with mandatory human disposition; interview-loop scheduling; scorecards and calibration; adverse-impact monitoring report (NYC LL144 / EU AI Act aware); candidate comms drafted and sent via the worker; hire handoff to Bevy and Baton.
- **Scope (out):** sourcing and job-board scraping, background checks, offer e-signature, automated rejection without human review.
- **Why build it:** Greenhouse and Lever are priced and built for recruiting teams. A 15-person firm hires from a spreadsheet and an inbox, and loses candidates to slow scheduling. Axes: **speed to hire** and **structured, auditable fairness** at SMB cost. It is also whitespace that no other seat proposed.
- **Reuses:** Blank, Book, Bond-style contact model, Braid (dedupe candidates), Bin (resumes), v_activity_unified, agent_proposals, Bolt (`candidate.*`), permissions (hiring-team ACL).
- **Lens fit:** the agent runs the pipeline end to end, and the human keeps the decision.
- **Closest existing app:** Bond. Bond manages sales prospects. Beckon manages candidates under employment-law constraints, with interview loops and scorecards. It is a different object and a different legal regime.

**Debate notes (Seat A)**

**Align:**
- **D Baton, B Baton, C Baton, E Bastion-JML.** I fold my Berth into D's Baton, the HR-lens framing with the widest footprint list. I contribute the plan compiler with dry-run diff, the access-zero certificate, and B's bus-factor dossier. One joiner/mover/leaver entry should reach the final, not five.
- **B Baseline, D Bastion, E Binder, F Bastion.** I back a single merged GRC entry. B's "unprovable controls" list and D's questionnaire autofill are the strongest parts, and my own Bastion adds nothing beyond them. I concede authorship to whoever submits it.
- **D Bloom + B Boost + F Bootcamp.** The strongest learning app combines friction-triggered gaps (Boost/Brevet) with delta recertification on source change (Bloom). That is what my revised Brevet now is.
- **E Butler.** Butler is the request-execution half of Bevy. The merge is a people-and-workplace request desk that also holds the employee and agent record, which is stronger than either half alone. I invite E to merge.
- **G Bugle.** I withdraw my Bullhorn in favor of G, whose marketing lens makes G the natural owner. Fold C's Bullhorn (press and crisis) into G's Byline.

**Oppose:**
- **B Badge, F Badge, E Bastion-access as a standalone app.** Access review is the leaver step of the joiner/mover/leaver app plus one evidence feed of the GRC app. A third app would be a near-duplicate of whichever of those two wins.
- **E Bosun.** This is product onboarding for the suite itself, not a horizontal capability a customer buys. It belongs in the platform as a feature.
- **F Bespoke.** An internal-tools builder overlaps Bolt and Blank and is not an essential department function. It is a Retool alternative with no named whitespace.
- **C Buddy.** Splits between Baton (provisioning) and Brevet/Bloom (ramp curriculum), leaving no distinct core.

**Ignore:** Bellwether/Barometer (they should merge with each other), Brace, Bravo, Brick, Backdrop, Blazon, Billboard, Byline, Bulletin, Bugle-internal.

**Strategy:** Three of the five clusters (GRC, joiner/mover/leaver, learning) will each collapse to one finalist, and my versions there add little beyond D's and B's. So I concede authorship in those clusters and put my weight on two uncontested apps in the essentials list. **Bevy** is the only HR-core proposal, the first essential on the census, and is agent-executed by construction, which matters more if it absorbs Butler. **Beckon** takes recruiting/ATS, which no other seat claimed. I will submit Bevy, framed as the system of record that every lifecycle app (Baton, Bastion, Brevet, Beckon) feeds on, so it reaches the final as infrastructure the other winners need rather than as a rival to them.

### Seat B - debate reply

### Baseline
- **Names:** Baseline · Attest · Bastion
- **One-line pitch:** Every night your SOC 2 / ISO 27001 controls are checked against what actually happened in the suite. The audit binder writes itself, and the controls nothing can prove are listed first.
- **Description:** An LLM compiles a framework (SOC 2, ISO 27001, or a custom policy set) into typed, testable control assertions. A human confirms each one. Each assertion is bound to an evidence query over data the suite already holds: `v_activity_unified`, permission grants, API-key age, `agent_policies`, Blip retention, Bolt executions, and Beacon policy acknowledgements. A nightly evaluator freezes cited evidence snapshots (hashed Bin objects, each recording the query that produced it) and labels every control pass, fail, or **unprovable**. The data-lens core is the **evidence coverage graph**: which controls have native proof, which rely on manual uploads, and which have nothing. It ranks gaps by audit risk and drafts the cheapest fix for each into `agent_proposals`, whether that is a Bolt rule, a policy draft, or an owner request. The same evidence graph autofills inbound security questionnaires, citing evidence for every answer.
- **Scope (in):** framework-to-assertion compiler; control library with owners; nightly evaluator with immutable cited snapshots; evidence coverage graph + gap ranking; drift alerts as Bolt `control.drifted`; Beacon policy attestation; security-questionnaire autofill with citations; token-gated auditor room + export packet; MCP `baseline_control_status`, `baseline_evidence_for`, `baseline_coverage_gaps`.
- **Scope (out):** customer/vendor contract obligations (Bulwark); vendor-risk questionnaires sent outward (Bursar territory); acting as a certification body; pentest, CSPM, or endpoint scanning (uploaded evidence only); access reviews themselves (consumes Badge output as evidence).
- **Why build it:** The axis is **cost + evidence trust**. Vanta and Drata cost $10-40k/yr, need connectors, and mostly collect screenshots. Here the evidence source is the system of record itself, each snapshot cites its query, and the "unprovable" list tells a 15-person firm exactly what to fix before its first enterprise security review.
- **Reuses:** shared DB + RLS, `v_activity_unified`, `agent_audit`, @bigbluebam/permissions, `api_keys`, `agent_policies`, Bin/@bigbluebam/storage, Beacon, Bam (remediation tasks), Bolt, `agent_proposals`, Bay-style token links, MCP.
- **Closest existing app:** Bulwark. Bulwark tracks clauses owed to outside counterparties. Baseline proves internal controls to an auditor, so the object, buyer, and evidence source are all different.
- **Lens fit:** Compliance becomes a continuously evaluated query, with a measured coverage map over the suite's operational data.

### Badge
- **Names:** Badge · Keyring · Bouncer
- **One-line pitch:** One graph of everything each person (or agent) can reach and owns. It runs joiners, movers, and leavers end to end and turns quarterly access reviews into a pre-decided ten-minute sign-off.
- **Description:** This merges my Badge and Baton. Badge keeps a person-to-entitlement-and-ownership graph that covers both what someone can access and what work they own:
  - **What they can access:** suite grants via @bigbluebam/permissions, project/channel memberships, API keys, service accounts, `oauth_user_links`, and imported SaaS seat lists.
  - **What they own:** tasks, deals, tickets, Bolt rules, Book pages, Bay guest links, Beacon verifier roles, and Bulwark obligations, via `entity_links` and `v_activity_unified`.

  The data-lens mechanisms are:
  1. **Peer-group baselines** inferred from what people in the same role actually hold and use. These drive joiner/mover deltas and flag grants that are anomalous for the role.
  2. **Usage-versus-grant scoring.** Reviews arrive pre-decided ("revoke: 0 uses in 94 days, no peer holds it"), so managers confirm in bulk.
  3. **Bus-factor scoring.** Sole-owned assets surface before anyone leaves.

  On a leaver event, Badge drafts a reassignment plan with successors chosen by expertise and current load, plus a revocation plan, into `agent_proposals`. It runs a short knowledge-capture interview on the gaps the records do not cover, then re-scans and issues an access-zero residue report. AI agents (`users.kind = agent`) are reviewed on the same graph.
- **Scope (in):** access + ownership graph; peer-baseline role templates; JML plans executed through the MCP catalog with HITL; orphan and residue sweeps; bus-factor heatmap; access-review campaigns with an immutable record; stale-key and dormant-seat report with SaaS seat-cost waste; Bolt `person.left`, `access.anomaly`; MCP `badge_footprint`, `badge_review_queue`, `badge_explain_grant`.
- **Scope (out):** IdP/SSO; SCIM write-connectors in v1 (external revocations are confirm-tracked tasks); MDM/devices; HRIS record of truth, payroll, benefits; onboarding curricula (the learning app).
- **Why build it:** The axis is **completeness + cost**. Okta IGA, ConductorOne, and Rippling are enterprise-priced and cannot see a departing rep's Bolt automations, open Bay guest links, or sole-owned customer relationships. Badge can, because the suite is the system of record. Reclaimed seat spend pays for it.
- **Reuses:** permissions resolver + Redis PermissionContext, `api_keys`, `oauth_user_links`, `agent_policies`, `entity_links`, `v_activity_unified`, `activity_by_actor`, `expertise_for_topic`, Braid (external contacts owned), Bin (CSV import), Bolt, `agent_proposals`, MCP as executor.
- **Closest existing app:** Bam `/b3/people`, which is account and membership CRUD. Badge is cross-app access governance plus ownership transfer, the IT/identity category the suite lacks.
- **Lens fit:** Least-privilege and handover decisions are inferred from usage, peer baselines, and ownership concentration, not from someone's memory.

### Bellwether
- **Names:** Bellwether · Barometer · Pulse
- **One-line pitch:** Bellwether catches team-level overload and disengagement weeks early from how work is flowing, and sends people a 3-question check-in only when the signal says to ask.
- **Description:** This is engagement intelligence with privacy built in. It reports team-level aggregates only, the server enforces a k-anonymity floor of 5, and no per-person score exists anywhere. A change-point model watches transparent leading indicators: after-hours share, carry-forward streaks, WIP per head, Book meeting load, Helpdesk backlog per agent, and response-latency drift. When a team's pattern shifts, an adaptive conversational check-in (C's Barometer mechanism) asks that team only the 2-3 questions the signal cannot answer. Free text is themed, and the manager gets a "you said, we did" action brief through HITL. Bellwether then measures whether the signal recovered after the action.
- **Scope (in):** published signal catalog with formulas; team change-point detection; adaptive check-ins via Banter/Blank; anonymous theming; manager action briefs into Bam via `agent_proposals`; did-it-work follow-through; employee-visible "what we measure" page; MCP `bellwether_team_signals`.
- **Scope (out):** individual scoring or surveillance (structurally impossible); message content (metadata only); performance reviews; compensation; generic survey builder (Blank).
- **Why build it:** The axis is **signal latency + survey fatigue**. Culture Amp and Lattice charge per seat for quarterly self-report that lags reality by months. Bellwether reads the leading signal already in the system and spends survey questions only where they buy information.
- **Reuses:** `activity_log`, Bam sprints/carry-forward, Book, Helpdesk, Banter (delivery + metadata), Blank, Bolt, `agent_proposals`, permissions (manager vs HR scopes), RLS.
- **Closest existing app:** Blank or Bench. Blank builds forms and Bench charts metrics. Bellwether is a listening system with its own questioning agent, an anonymity guarantee, and intervention tracking.
- **Lens fit:** Engagement becomes privacy-bounded inference over work exhaust, and survey questions are spent only where the data cannot answer.

### Boost
- **Names:** Boost · Bootcamp · Primer
- **One-line pitch:** Training that targets the skill gaps your work data reveals, writes itself from your own docs, retrains only the people affected when a policy changes, and proves it worked.
- **Description:** This combines A Brevet, D Bloom, and F Bootcamp around one discriminator: **outcome-measured learning**. Gap detection mines failure signals: escalated or reopened tickets by topic, review bounce-backs, repeat "how do I" threads, and low-confidence Beacon searches. It clusters them into a per-team skill-gap map. Micro-modules are generated only from citable Beacon/Brief sources. When a source changes (`beacon_versions`), a materiality diff triggers recertification of just the delta for just the affected roles. New-hire ramp plans are the same engine pointed at a role. Effectiveness is a before/after comparison of the triggering failure rate for completers versus non-completers, so a lesson that does not move the outcome is flagged for rewrite.
- **Scope (in):** friction-gap clustering; cited lesson + scenario-check generation; delta recertification on source change; role ramp plans with `expertise_for_topic` buddies; outcome-based effectiveness; required-training/attestation records (exported as Baseline evidence); nudges via Banter; MCP `boost_gaps`, `boost_assign`, `boost_effect`.
- **Scope (out):** SCORM marketplace, video authoring, external certifications, performance management, HR records.
- **Why build it:** The axis is **zero authoring cost + proof of impact**. TalentLMS and Trainual sit empty because nobody writes content, and they measure completion, not behavior. Boost writes content from what exists and shows whether it changed the work.
- **Reuses:** Helpdesk + `helpdesk_find_similar_tickets`, `*_count_by_phrase`, Beacon/Brief + Qdrant, `beacon_versions`, Banter, Blank, Bolt, `can_access`, `agent_proposals`.
- **Closest existing app:** Beacon. Beacon stores what is true. Boost decides who needs it, teaches it, and measures whether behavior changed.
- **Lens fit:** Learning is aimed by operational data and judged by operational data.

### Billet (new, replaces solo Baton, which folded into Badge)
- **Names:** Billet · Beckon · Bullpen
- **One-line pitch:** Billet is hiring where the role profile is derived from what successful people in that role actually do, every candidate is scored on structured evidence, and an adverse-impact monitor runs on every stage.
- **Description:** Billet is an AI-native recruiting system (ATS). It derives a job's competency profile from the work graph of current incumbents (what they own, which skills `expertise_for_topic` attributes to them, and what their first 90 days contained), not from a recycled job description. It generates the posting and a structured interview kit tied to that profile. It summarizes each interviewer's notes into rubric-anchored evidence and flags ungrounded ratings ("culture fit" with no cited behavior). The data-lens core is a **continuous adverse-impact monitor**: selection-rate ratios per stage (the four-fifths rule) and rubric-drift detection between interviewers. This produces the bias-audit artifact that NYC LL144-style rules now require of automated hiring tools. AI never auto-rejects. Every advance or decline goes through human decision, logged.
- **Scope (in):** requisitions with work-graph-derived profiles; posting generation + careers page; applicant intake (Blank); structured kits + scorecards; interview scheduling via Book; evidence-anchored debrief summaries; adverse-impact and interviewer-calibration dashboard; offer approval via `agent_proposals`; hand-off to Badge `person.joined` on hire; MCP `billet_pipeline`, `billet_debrief`.
- **Scope (out):** sourcing and scraping of candidates, job-board programmatic ad buying, background checks, e-signature of offers (export), payroll/HRIS.
- **Why build it:** The axis is **hire quality + legal defensibility at SMB price**. Greenhouse and Ashby are $6-25k/yr and their AI features add bias risk without an audit. Small firms hire from inboxes with unstructured interviews. Billet is the only option whose role profile comes from real work data and that produces its own fairness audit.
- **Reuses:** Blank (application forms), Book (`book_find_meeting_time_for_users`), Bond-style contact model via Braid (dedupe candidates), `expertise_for_topic`, `v_activity_unified`, Bin (resumes), Bolt (`candidate.stage_changed`, `hire.made`), `agent_proposals`, permissions (hiring-team scoping), RLS.
- **Closest existing app:** Bond. Bond is a sales pipeline of customers. Billet is a hiring pipeline with structured evaluation, fairness auditing, and candidate-privacy rules a CRM lacks, which puts it in the recruiting/ATS whitespace no seat has covered.
- **Lens fit:** Hiring decisions are grounded in incumbent work data and continuously audited for statistical fairness.

**Debate notes (Seat B)**

- **Align: A Bastion, D Bastion, E Binder, F Bastion with my Baseline.** It is one app in five framings. The merged version should keep my evidence-coverage graph with "unprovable" ranking, D's questionnaire autofill, F's GitHub-integration evidence, and A/E's token-gated auditor room.
- **Align: E Bastion-IAM, F Badge with my Badge.** One access-governance app. My Badge now absorbs JML ownership transfer, so it also aligns with **A Berth, C Baton, D Baton**. Access and ownership are one graph about the same person, so merging the two clusters frees a slate seat instead of spending two.
- **Align: C Barometer with my Bellwether.** C's adaptive conversational check-in plus my passive change-point trigger is stronger than either: ask only when the data shifts, and ask only what the data cannot answer.
- **Align: A Brevet, D Bloom, F Bootcamp with my Boost.** Combined: Brevet's friction gaps, Bloom's delta recertification, Bootcamp's ramp plans, and my outcome-effect measurement as the discriminator. **C Buddy** belongs inside this, not as a separate app.
- **Align: D Brace.** This is the only health-and-safety/ER proposal, it is horizontal, and the statutory clocks plus cross-case pattern detection are genuinely AI-native.
- **Align: E Brick.** It is the strongest office-productivity entry. Live permission-scoped suite cells are a wedge no sheet vendor has.
- **Align: G Backdrop.** Same office-productivity reasoning: data-bound decks are a real trust axis.
- **Oppose: A Bevy.** Time-off, org chart, and a policy Q&A chatbot is BambooHR plus chat. The agent-workforce roster is the only novel piece, and it belongs inside Badge (agents reviewed on the same graph).
- **Oppose: E Butler.** An internal request queue is Helpdesk pointed inward, and its access requests duplicate the Badge/JML cluster.
- **Oppose: E Bosun.** This is platform administration, not a customer business function; it should be a feature of the platform, not an app.
- **Oppose: F Bespoke.** It overlaps Bolt + Blank + Brick, and "internal tools builder" is not a horizontal essential.
- **Oppose: F Bulletin.** Release notes only serve software companies, which makes it a near-vertical; its customer-notice half is Blast.
- **Oppose: G Byline.** PR desks are a lower-frequency need than social; fold the crisis-statement trigger into the winning social app.
- **Oppose: D Bravo.** It sits closest to "productivity surveillance". A cited per-person work ledger at review time will fail trust with SMB staff, and Lattice already owns the category.
- **Align: G Bugle, A/C Bullhorn.** One social app; G's reply-routing into Helpdesk/Bond is the best version.
- **Align: G Blazon.** Brand governance is a credible standalone essential and the gate every agent passes.
- **Ignore: C Bugle (announcements), G Billboard.**

**Strategy:** Every one of my Phase 1 ideas landed in a crowded cluster, so I am playing two ways at once. (1) **Win the merges.** I bring a distinct data-lens discriminator into each cluster: Baseline's evidence coverage graph with "unprovable" ranking; Badge's merged access + ownership graph with peer baselines and bus-factor; Boost's outcome-measured effectiveness; Bellwether's signal-triggered listening. These are concrete pieces the merged spec cannot drop, which makes me a necessary co-owner. (2) **Add an unclaimed singleton.** I folded Baton into Badge to collapse two clusters into one slot, and used the freed seat for Billet. Recruiting/ATS is listed whitespace that no seat proposed, and its adverse-impact monitor is a data-lens mechanism with a regulatory wedge. If forced to pick one submission, I expect it to be Badge (the broadest merged app, spanning two clusters) or Billet (no competition), depending on how the orchestrator collapses clusters.

### Seat C - debate reply

### Bellman: announcements that confirm they were understood
- **Names:** Bellman · Clarion · Broadcast
- **One-line pitch:** Send a company announcement once, and Bellman makes sure each person got it, understood it, and did what it asked.
- **Description:** A leader writes one source message (a policy change, reorg, office closure, incident notice or launch). An agent rewrites it for each audience by role, team and locale, and picks each person's channel (Banter, email or digest). Each recipient answers a one- or two-question understanding check instead of clicking "I read it." The agent groups the follow-up questions that come back through Banter threads and Helpdesk, finds which sentences confused which teams, and drafts a clarification for the sender to approve. It shows understanding by team as a heatmap, and enforces required-acknowledgment deadlines with escalating nudges.
- **Scope (in):** one source message, rewritten per audience; targeting from org, team and role; understanding checks; required acknowledgments with deadlines and nudges; grouping of confusion signals; drafted clarifications routed to agent_proposals; an understanding dashboard by team; signed acknowledgment records that GRC and learning apps can use as evidence of policy delivery; MCP tools `bellman_draft`, `bellman_target`, `bellman_status`.
- **Scope (out):** chat (Banter); external email marketing (Blast); wiki or policy storage (Beacon); skill training and course paths (the learning app); control testing (the GRC app).
- **Why build it:** The axis is **closed-loop proof that a message landed.** Small firms post in a channel and hope people saw it. Staffbase and Simpplr are priced for enterprises and only measure opens. Nothing at SMB price measures understanding and then fixes the gaps it finds. It is also the rail that the GRC and learning finalists would otherwise each rebuild separately: "did everyone acknowledge the new policy?"
- **Reuses:** auth/RLS, org and team membership, Banter channels and `banter_schedule_post`, the worker email queue, Helpdesk (inbound questions), Bolt (`announcement.published`, `ack.overdue`), agent_proposals, can_access, Bench.
- **Lens fit:** internal communication from the company to employees, which the suite does not have.
- **Closest existing app:** Banter. Banter is many-to-many conversation. Bellman is one-to-many communication that is tracked per person, has deadlines and verifies understanding. It is a different job, not a better chat.

### Barometer: continuous employee listening (offered as a merge with Seat B's Bellwether)
- **Names:** Barometer · Bellwether · Pulse
- **One-line pitch:** Know how each team is really doing weeks before people quit, and ask people questions only when there is a reason to.
- **Description:** **Detection:** team-level leading signals from work metadata only (after-hours activity share, carry-forward streaks, WIP, meeting load from Book, ticket backlog), run through change-point detection. This is Bellwether's engine. **Asking:** when a team's pattern shifts, an agent runs a short adaptive conversational check-in with that team only. My Barometer contributes this part. **Privacy:** a k-anonymity floor of 5, enforced server-side, so no per-person scores ever exist. **Closing the loop:** the agent groups the answers into themes, drafts a manager action brief for approval, and publishes a "you said, we did" reply. It then tracks whether the signal recovers.
- **Scope (in):** a transparent signal catalog; change-point detection per team; adaptive conversational pulses (Banter or Blank); anonymous free-text theming; the k-anonymity gate; manager briefs routed to agent_proposals; action follow-up as Bam tasks; an employee-visible "what we measure" page.
- **Scope (out):** individual scoring or surveillance (structurally impossible); reading message content (metadata only); performance reviews and compensation.
- **Why build it:** The axis is **signal latency and survey fatigue.** Culture Amp and Lattice run quarterly self-report surveys that lag reality. This product reads the leading signal first, spends questions only where they matter, and closes the loop. Closing the loop is the step that actually keeps people from leaving.
- **Reuses:** activity_log, Bam, Book, Helpdesk, Banter, Blank, Bolt (`theme.emerged`), agent_proposals, permissions (manager and HR scopes), Basis/Bench.
- **Lens fit:** upward communication, the employee's voice reaching leadership without anyone having to ask for it first.
- **Closest existing app:** Blank and Bench. Blank builds forms and Bench charts metrics. Barometer is an engagement system with its own privacy model, its own questioning agent and an action loop.

### Bouquet: recognition for work nobody else noticed
- **Names:** Bouquet · Beam · Kudos
- **One-line pitch:** Bouquet finds the people quietly holding the team together and makes sure they get thanked.
- **Description:** An agent reads the work graph for help that normally goes unseen: a question answered in Banter that unblocked a task, a reviewer who caught a defect, a Helpdesk save, a Beacon article that deflected tickets. It prompts the person who was helped with a drafted one-tap thank-you, and that person can edit or skip it. Recognitions build up into a values-tagged feed and a per-team "who is unseen" view, which corrects the visibility bias where loud work gets credit and glue work does not. With the employee's consent, the history flows to performance reviews as cited evidence.
- **Scope (in):** helped-by detection from Banter, Bam, Helpdesk and Beacon; drafted thank-you prompts; the peer recognition feed; company-value tagging; a team-level recognition distribution, including who is never recognized; manager nudges; an employee-owned export to a review app; MCP `bouquet_recognize`.
- **Scope (out):** points and gift-card marketplaces (v2 at most); performance ratings; compensation.
- **Why build it:** The axis is **coverage and fairness.** Bonusly and Kudos depend on people remembering to give thanks, so recognition goes to the visible few. Only a suite that holds the work graph can see the invisible contributions. Recognition is also the cheapest retention lever a small firm has.
- **Reuses:** v_activity_unified, entity_links, `expertise_for_topic`, Banter, Helpdesk, Beacon, Bolt (`recognition.given`), can_access (so a thank-you never cites something the reader cannot see), Bench.
- **Lens fit:** community inside the company, making peer-to-peer appreciation automatic.
- **Closest existing app:** Banter. Banter has reactions on messages. Bouquet detects help that happened anywhere across the suite and turns it into recognition. It belongs to employee engagement, not chat.

### Baton: handover of work and knowledge (my Buddy and Baton combined; aligned with Seat B's Baton)
- **Names:** Baton · Relay · Bequest
- **One-line pitch:** When someone leaves or changes roles, everything they owned and knew moves to the right people, and their successor gets a ramp plan built from it.
- **Description:** **Ownership graph:** a continuously updated map of who owns what across the suite, with a bus-factor score showing where one person is the only owner. **Departure:** on a departure trigger, the agent proposes successors by expertise and current load, runs an exit interview aimed at what the records do not show, and writes a cited handover dossier. It drafts introductions for external contacts (drafts only). **Arrival:** the incoming person's 30/60/90 plan is built from that dossier, with introductions booked through Book and a cited Q&A companion that answers their questions.
- **Scope (in):** the ownership graph with bus-factor scores; successor proposals with batch reassignment through agent_proposals; the exit knowledge interview; the dossier published to Beacon; drafted external handoffs; a successor ramp plan; an orphan sweep.
- **Scope (out):** granting and revoking access (Badge/Bastion's job); HRIS records (Bevy); payroll; devices.
- **Why build it:** The axis is **risk of losing what departing people own and know.** No HR or IT tool can see who is the only owner of a Bolt rule or a deal relationship.
- **Reuses:** entity_links, v_activity_unified, `expertise_for_topic`, Book, Beacon, the per-app MCP reassign tools, agent_proposals, Bolt.
- **Lens fit:** passing context and relationships from one person to the next.
- **Closest existing app:** Bam `/b3/people`. That screen is account and membership management. Baton transfers work and knowledge.

### Bonfire: an AI-moderated customer community
- **Names:** Bonfire · Bazaar · Commons
- **One-line pitch:** A branded community where customers help each other, an agent answers from your docs, and every bug, idea and champion lands in the right app.
- **Description:** Bonfire is a public or members-only forum. An agent drafts answers from Beacon in-thread and labels them as AI answers. It holds a draft back when its confidence is low and asks a human expert instead. It turns threads into Helpdesk tickets, Bam bugs or feature-demand counts, and spots customer champions, which it writes to Bond via Braid. Good answers from community members are proposed as Beacon articles, so the community grows the knowledge base.
- **Scope (in):** spaces and threads; SSO or magic-link membership; the cited AI answer agent with confidence gating; routing to Helpdesk, Bam and Bond; champion scoring; community-to-Beacon article proposals; moderation, including spam and toxicity checks.
- **Scope (out):** internal chat (Banter); 1:1 support (Helpdesk); courses and paid memberships; social networks (Bugle).
- **Why build it:** The axis is **integration plus deflection.** Discourse and Circle are standalone islands, and Khoros is enterprise-priced. Bonfire's answers come from the KB and its threads feed the CRM and the backlog automatically.
- **Reuses:** Beacon/Qdrant, Helpdesk, Bam, Bond, Braid, Blazon (voice), agent_proposals, Bolt, the public-token pattern from Bay.
- **Lens fit:** an external community, many-to-many with customers.
- **Closest existing app:** Helpdesk. Helpdesk handles private 1:1 tickets. Bonfire is a public many-to-many community that cuts down tickets.

**Debate notes (Seat C)**

| Seat / app | Stance | Reason |
|---|---|---|
| G Bugle | **Align** (I withdraw my Bullhorn) | Three seats proposed event-driven social publishing. G's marketing lens owns it, and G's version adds inbox routing to Helpdesk and Bond. I am releasing the "Bugle" name to G and renaming my internal-comms app Bellman. |
| A Bullhorn | **Align** | Same app as G Bugle. It should merge into Bugle. |
| G Byline | **Oppose** | PR and media relations are less essential horizontally than social for a 2-50 person firm (the Cision buyer is mid-market and up). Its "internal announcement versions posted to Banter" overlaps Bellman. Crisis holding statements should be a feature of Bugle. |
| F Bulletin | **Oppose** | This is a release-notes feature split between two homes. The customer-facing changelog belongs in Bugle and the internal sales/support brief belongs in Bellman. On its own it is narrower than either. |
| B Bellwether | **Align** | Merge with my Barometer as described above. Bellwether's detection engine plus Barometer's adaptive conversational asking and "you said, we did" loop beats either half alone. I will accept Bellwether as the name. |
| B Baton | **Align** | I folded my Buddy and Baton into this. The work graph plus ownership-transfer plus successor-ramp version is the strongest in the joiner/mover/leaver cluster. |
| A Berth, D Baton | **Align** | They should merge into B Baton. |
| E Bastion (JML part) | **Oppose** | Bundling the access lifecycle with the transfer of work recreates two apps in one. Access governance should be Badge; work and knowledge handover should be Baton. |
| B Badge / F Badge | **Align** | Badge is the clean home for access governance. |
| GRC cluster (A Bastion, B Baseline, D Bastion, E Binder, F Bastion) | **Ignore**, with one note | Back one survivor. Baseline's "no data" control set is the sharpest framing. Policy-acknowledgment delivery should consume Bellman's signed understanding records rather than each GRC app building its own attestation UI. |
| D Bloom | **Align**, with a boundary | Bloom's delta recertification is the right learning app, but it teaches skills. Notifying people that a policy changed, and checking they understood, is Bellman's rail, which Bloom should call. |
| A Brevet, B Boost, F Bootcamp | **Align** | Merge into one learning finalist with Bloom. My Buddy is withdrawn from that cluster. |
| D Bravo | **Align** | Bouquet feeds Bravo cited recognition evidence, with the employee's consent. The two are complementary, not duplicates. |

**Strategy:** My best bet for the final seven is **Bellman**. After the merges it is the only app in internal communications, and it is the one category in my lens that nobody else proposed. It is an SMB-essential function (every firm announces things and none can prove the message landed). It is AI-native at its core (per-audience rewriting, understanding checks, grouping of confusion, drafted fixes). It is also a shared rail the likely GRC and learning finalists need, which gives other seats a reason to vote for it rather than against it. My second path is the Barometer/Bellwether merge, where I concede the name and keep the asking agent and the closed loop. I left the social, joiner/mover/leaver and learning clusters to the seats that own them, so I am not splitting votes against my own entries.

### Orchestrator note on Phase 2

The debate did most of the overlap work itself. Each crowded cluster now has a clear survivor or named owner: GRC converges on **Baseline** (B), with D, E and A explicitly conceding and F offering its GitHub-evidence and questionnaire pieces; social publishing converges on **Bullhorn** (G's merged social + PR desk), with A and C withdrawing; engagement converges on a merged **Bellwether/Barometer** (B + C). Two clusters remain contested on boundaries: joiner/mover/leaver vs. access governance (B folded them into one **Badge**; C, D and E argue they are two apps: Baton for work handover, Badge for access), and learning (B **Boost**, A **Brevet** and D's re-aimed **Bloom** for mandated training). Several seats pivoted into unclaimed whitespace: recruiting (A **Beckon**, B **Billet**, D **Beckon**, so recruiting itself is now a three-seat cluster), e-signature (E **Biro**), customer proof (G **Boast**), recognition (C **Bouquet**), customer community (C **Bonfire**). One round was enough: seats are converging rather than colliding, so a second round would add text but not resolution.

### Seat D - debate reply

### Brace (workplace incident, speak-up and employee-relations case desk). FLAGSHIP
- **Names:** Brace · Buoy · Casebook
- **One-line pitch:** One confidential intake for injuries, near-misses, harassment, grievances and whistleblower reports. An agent classifies each report, starts the legal clocks it triggers, and drives the case to a documented close.
- **Description:** Reports come in through a Blank form, a Banter DM to a bot, a voice note, or an anonymous tokenized link. The reporter gets a reply channel without being identified. An agent classifies each report and cites the rule text it relied on. **Injury cases:** recordable or not under OSHA 300/301-style criteria, and whether a short regulator-notification window applies (8 hours for a fatality, 24 hours for an in-patient hospitalization, amputation or loss of an eye). **Whistleblower cases:** for firms with 50 or more staff in the EU, the 7-day acknowledgement and 3-month feedback duties. **Other cases:** near-miss, harassment, policy breach or grievance. Brace then scopes visibility to need-to-know, starts the deadline clocks, and drafts an investigation plan, interview questions and corrective actions. Corrective actions become Bam tasks. Across cases it detects patterns, such as the same location, manager, hazard or retaliation timing, that no single case shows. Every conclusion, notification and closure is a HITL proposal. Nothing goes to a regulator or an accused party unattended.
- **Scope (in):** multi-channel and anonymous intake with a two-way anonymous mailbox; classification with citations; jurisdiction-aware statutory and policy clocks; a per-case confidentiality ACL that is stricter than org RLS, with conflict-of-interest exclusion (the accused and their manager chain are auto-excluded); an investigation workspace and an evidence locker in Bin with hashes; corrective actions linked to Bam, with effectiveness checks; incident-log export in 300/300A form; cross-case pattern and retaliation alerts; MCP tools `brace_case_status`, `brace_clock_due`, `brace_pattern_scan`.
- **Scope (out):** workers' comp claim filing; legal advice (it flags the case for counsel); hazard modules for a single industry; customer complaints (Helpdesk); general employee requests (Butler).
- **Why build it:** Axis: **legal-deadline trust at SMB cost**. Every employer, office-only ones included, owes duty-of-care reporting and an investigation trail. Small firms run it in email, miss the 8-hour and 24-hour windows, and cannot show a retaliation-free process later. Enterprise tools (Intelex, HR Acuity, NAVEX) are priced for compliance departments.
- **Reuses:** Blank (intake), Banter (bot intake), voice-agent, Bin and @bigbluebam/storage (evidence), @bigbluebam/permissions (case ACL), the can_access preflight, Bam (corrective actions), Bolt (`case.clock_due`, `case.pattern_detected`), agent_proposals, and the control-evidence app's feeds (incident-response controls).
- **Closest existing app:** Helpdesk. Helpdesk serves external customers' requests in a shared queue. Brace handles internal duty-of-care cases where confidentiality, conflict exclusion and statutory clocks are the product, which a ticket queue structurally cannot offer.
- **Lens fit:** health and safety plus employee relations is the people-risk function the law requires of every employer, and small firms improvise it.

### Beckon (structured, bias-audited hiring). NEW, replaces my Bastion
- **Names:** Beckon · Bullpen · Scout
- **One-line pitch:** Hiring where the scorecard comes from what the role actually does, every screening judgment cites the résumé line it rests on, and an adverse-impact monitor runs before anyone is rejected.
- **Description:** A hiring manager names a role. Beckon drafts a competency scorecard and job description from two inputs: the work current holders of that role actually do (aggregate patterns in v_activity_unified, filtered by can_access) and a short intake interview. Applications arrive through a Blank form, and résumés are stored in Bin. The agent scores each candidate against the scorecard with cited evidence, in a blind mode that redacts name, school, dates and photo. It proposes structured interview kits and schedules panels through Book. Panelist feedback stays sealed until each panelist submits, which prevents anchoring. A four-fifths-rule adverse-impact monitor runs on every stage transition. The AI advises and never auto-rejects: every disposition is a human decision, and each one is logged to support NYC LL144-style automated-employment-decision-tool (AEDT) bias audits and candidate notice. A hire emits `candidate.hired`, which is the joiner event for the handover app.
- **Scope (in):** scorecards derived from real work; job description drafts; application intake; cited blind screening; interview kits; panel scheduling; sealed scorecards; an adverse-impact dashboard; candidate-data retention and deletion sweeps (GDPR); offer-stage handoff; MCP tools `beckon_pipeline`, `beckon_explain_score`.
- **Scope (out):** job-board ad buying (a Billboard-type concern); background checks; e-signature on offers; payroll setup; sourcing by scraping.
- **Why build it:** Axis: **quality of hire plus legal safety of AI screening**. Greenhouse and Lever start at about $6k a year and add AI screening as a black box. Small firms hire from an inbox and a spreadsheet. Beckon's scorecard is grounded in the org's own work graph, which no standalone ATS holds. Its audit trail makes it safe to use AI in hiring at all. No other seat covers recruiting.
- **Reuses:** Blank, Bin, Book (`book_find_meeting_time_for_users`), Banter (panel nudges), v_activity_unified, expertise_for_topic (panel selection), the can_access preflight, agent_proposals, Bolt, Bench, and the retention-sweep pattern from Blip.
- **Closest existing app:** Bond. Bond runs a sales pipeline of customers. Candidates carry different legal duties (adverse-impact, AEDT notice, deletion), have a different evaluator and follow a different lifecycle. A recruiting pipeline built on CRM is exactly the shortcut that creates liability.
- **Lens fit:** recruiting is the start of the people lifecycle, and it is pure whitespace in the census.

### Bravo (performance reviews from cited evidence, owned by the employee)
- **Names:** Bravo · Brag · Tally
- **One-line pitch:** Review season without the blank page. Each person curates a cited record of what they shipped and moved, and the manager's draft review can only cite what the employee's record and their own access support.
- **Description:** Bravo is employee-first by construction. The ledger (closed Bam work, moved Bearing KRs, Helpdesk CSAT, authored Brief and Beacon pages, Bay approvals) is visible to its owner, who annotates it, adds work the suite never saw, and chooses what to share. At cycle time the agent drafts self and manager reviews in which every sentence cites evidence. It lints for recency bias, gendered or uneven language across a team, and invisible glue work. Calibration compares ratings against evidence density. No scores, rankings or real-time metrics exist anywhere, which stops it becoming a surveillance tool.
- **Scope (in):** an evidence ledger the employee curates; review cycles; cited drafts; bias and consistency lint; calibration; Blank-based peer input; can_access filtering on every citation.
- **Scope (out):** compensation; productivity scoring; continuous monitoring; team engagement (Bellwether/Barometer).
- **Why build it:** Axis: **manager-hours and fairness**. Lattice and 15Five start from memory. Bravo starts from cited records the suite already holds and cuts 4 to 8 hours of reconstruction per report per cycle.
- **Reuses:** v_activity_unified, Bam, Bearing, Helpdesk, Brief, Beacon, Bay, can_access, llm-provider, Blank, agent_proposals.
- **Closest existing app:** Bearing. Bearing tracks team goals. Bravo evaluates individuals across all work, including work outside any goal.
- **Lens fit:** performance management, the people-ops cycle small firms fake.

### Bloom (mandatory training and policy recertification, retrained only on what changed). Re-aimed
- **Names:** Bloom · Bootcamp · Primer
- **One-line pitch:** Required training (harassment prevention, security awareness, safety, policy handbooks) generated from your own policies and kept legally current. When a policy changes, only the affected people retrain, and only on the change.
- **Description:** Bloom is re-aimed away from friction-driven learning (Boost, Brevet and Bootcamp own that) to the mandated-training obligation. **Policy-bound courses:** it compiles policy-bound modules from Beacon and Brief sources, with cited scenario checks graded by an LLM against a rubric. **Jurisdiction rules:** it tracks requirements by jurisdiction and role, for example the California, New York and Illinois harassment-prevention mandates, plus annual security awareness for SOC 2. **Delta recertification:** when a source changes (beacon_versions), the agent diffs it, judges whether the change is material, and assigns recertification on just the delta to just the people whose role path covers it. Completions and attestations are signed evidence for the control-evidence app and for Brace's corrective actions ("retrain team X").
- **Scope (in):** a mandate catalog by jurisdiction and role; modules generated from policy, with citations; scored scenario checks; delta recertification; attestation; due-date clocks and nudges; an evidence export.
- **Scope (out):** friction-driven skill-gap learning; SCORM authoring; video production; external certifications.
- **Why build it:** Axis: **cost of staying compliant**. Firms buy generic off-the-shelf compliance courses (KnowBe4, EasyLlama) that do not reflect their actual policy, then re-send the whole course to everyone on every change.
- **Reuses:** Beacon (entries, versions, verifications), Brief, Qdrant, llm-provider, Bolt (`entry.updated`), Banter nudges, Bench, agent_proposals.
- **Closest existing app:** Beacon. Beacon stores policy. Bloom proves who has been trained on which version, as legally required.
- **Lens fit:** compliance training, which every employer owes and small firms skip.

### Baton (joiner/mover/leaver handover). Offered to the merge
- **Names:** Baton · Berth · Handover
- **One-line pitch:** When someone joins, moves or leaves, an agent finds everything they own or can reach across the suite, runs the handoff, and proves nothing was left behind.
- **Description:** Baton takes a cross-app footprint scan (tasks, deals, queues, Bolt rules, API keys, Book pages, Bin shares, Bay guest links, Bulwark obligations) and drafts reassignment and revocation proposals through agent_proposals. It learns role templates from peers. My differentiator is the post-execution **residue re-scan** with an access-zero certificate. I will fold this into the cluster winner.
- **Scope (in):** lifecycle events (including `candidate.hired` from Beckon); footprint scan; HITL plan execution via MCP; role templates; residue re-scan; audit packet.
- **Scope (out):** payroll; HRIS master record; MDM; external SaaS beyond a checklist.
- **Why build it:** Axis: **completeness**. Only a suite-native agent can enumerate a leaver's Bolt rules and Bay guest links.
- **Reuses:** permissions, api_keys, entity_links, v_activity_unified, agent_proposals, MCP, Bolt, Braid.
- **Closest existing app:** Bam /b3/people. That screen is user CRUD. Baton is the cross-app ownership transfer.
- **Lens fit:** onboarding and offboarding.

**Debate notes (Seat D)**

**Align:** **Seat B Baseline:** align. Its "no data" set of controls is the sharpest mechanism among the five GRC entries, so I withdraw my Bastion in its favor. Bloom attestations and Brace incident-response records feed its evidence. **Seats A Bastion, E Binder, F Bastion (GRC):** align, folding into Baseline. Five seats claiming one idea means one survivor, and Baseline has the most distinctive mechanism. **Seat B Baton:** align. The bus-factor ownership graph plus measured ramp is the strongest JML framing. My residue re-scan and access-zero certificate (shared with Seat A's Berth) should be merged into it. **Seat A Berth, Seat C Baton:** align into the single JML app above. Neither is distinct enough to justify its own seat. **Seat A Bevy:** align, as an adjacency rather than an overlap. A people-core record (who is employed, role, manager) is what Brace's conflict exclusion, Beckon's hire event and Bravo's cycle all key off. If Bevy survives, my apps get stronger. **Seat C Bugle (announcements):** align. Its understanding check plus Bloom's delta recertification would together give a "policy change, proven understood" loop. I am open to Bloom being the training half of that. **Seats B Boost, A Brevet, F Bootcamp:** align with each other. I re-aimed Bloom out of their cluster to mandated training, which none of them cover. **Seat C Buddy:** align. It is onboarding, so it belongs in the JML cluster or Boost, not as a standalone app. **Seat E Butler:** align as a neighbor. It is the general employee request desk, and Brace explicitly excludes those requests while taking confidential cases.

**Oppose:** **Seat E Bastion (identity and access with JML):** oppose as framed. It fuses two clusters (access governance and JML) into one app. Last session's merge record found that access lifecycle and human handover are different categories, and fusing them blurs both. **Seat B Bellwether vs. Seat C Barometer:** neither opposed nor aligned with my apps, but they are near-duplicates of each other and should collapse into one. Bravo stays out of their way: it covers individuals, uses no metrics, and is owned by the employee.

**Ignore:** G Billboard, G Byline, G Backdrop, E Brick, E Bosun, F Bespoke, F Bulletin, and the social-publishing trio. None is a threat or an ally to my lens.

**Strategy:** five of the seven slots are being fought over by clusters of five near-identical apps, and each cluster will collapse to one owner. Co-claiming them is a losing position, so I conceded GRC to Baseline and JML to Seat B's Baton, and I am supplying mechanisms (residue re-scan, attestation evidence) to make those winners stronger. My bet is on the two whitespace slots nobody else touched: **Brace**, my flagship (health and safety plus employee relations is explicitly an essential in the census, it is legally mandated for every employer, it has hard statutory clocks that make the AI's value measurable, and it overlaps no other seat), and **Beckon**, recruiting (census whitespace, also unclaimed, and defensible because it is grounded in the work graph and audited for adverse impact). Bravo and the re-aimed Bloom are kept as distinct backups that do not collide with any cluster.

### Seat E - debate reply

### Badge: access and SaaS-seat governance for teams with no IT staff
- **Names:** Badge · Bouncer · Keyring
- **One-line pitch:** One inventory of who can get into what, in the suite and across your SaaS and devices, with an agent that runs access reviews and recovers wasted seats.
- **Description:** Badge builds an access graph per person and per agent. It takes suite-native grants from `@bigbluebam/permissions`, API keys, service accounts, `oauth_user_links` and `agent_policies`. It adds external SaaS seats from imported lists or read connectors, plus seats inferred from Bill expense lines, and a lightweight device and asset register. Each grant is scored against actual use (`v_activity_unified`) and against what peers in the same role hold. Review campaigns arrive pre-decided ("revoke: 0 uses in 94 days"), so a manager confirms in bulk. Revocations go out as `agent_proposals`, and each campaign is saved as an immutable review record. Badge does not run the joiner/mover/leaver process. It consumes the `person.*` events from whichever lifecycle app wins, and it supplies the "access-zero" check that app needs.
- **Scope (in):** entitlement inventory (suite plus CSV/connector SaaS seats plus a device/asset register); usage-vs-grant and peer-outlier scoring; stale-key and orphaned-account sweeps; agent identities reviewed like humans; review campaigns with an immutable record; seat-waste roll-up in dollars; `badge_access_zero(person)` verification tool; Bolt `access.anomaly`.
- **Scope (out):** joiner/mover/leaver orchestration and handover of owned work (the lifecycle cluster); IdP/SSO; MDM enforcement; procurement and renewals (Bursar).
- **Why build it:** Small firms skip access reviews until an auditor or a breach forces them, and Okta IGA and ConductorOne are priced for enterprises. Axis: **cost**. Recovered seats pay for the product, and suite grants need no connector.
- **Reuses:** permissions plus Redis PermissionContext, api_keys and rotation, `oauth_user_links`, `agent_policies` and `agent_runners`, `v_activity_unified`, Bill expenses, Bin imports, Bolt, `agent_proposals`.
- **Closest existing app:** Bursar. Bursar levels vendor bids and watches spend against a baseline. Badge governs who holds access versus what they use, which is IT and identity governance.
- **Lens fit:** this is the operator's core security chore, run as a decision engine instead of a spreadsheet.

### Butler: internal service desk that resolves requests itself
- **Names:** Butler · Bellhop · Concierge
- **One-line pitch:** Employees ask for what they need in plain language ("add me to the Acme project", "new keyboard", "how do I file travel?") and an agent fulfils most of it within policy in seconds.
- **Description:** Butler is employee service management for IT, ops and facilities requests, with fulfilment done by an agent instead of a ticket queue. Each catalog item is a policy plus an MCP action plan: who may ask, what auto-approves, what needs a manager's approval through `agent_proposals`, and which tools execute it. The agent answers from Beacon with citations and executes permitted actions directly (memberships, channels, Bureau rooms, key rotation, Badge grants), keeping an audit trail of every step. Its deflection-gap report is the product's feedback loop: the top unresolved request types become drafted catalog items or Beacon articles for an operator to approve.
- **Scope (in):** a request catalog with policy for each item; intake via Banter DM, a web form and email; execution through MCP under `agent_policies` allowlists; manager approvals; cited answers; gap mining that turns unresolved requests into proposed catalog items; SLA and analytics.
- **Scope (out):** external customer support (Helpdesk); HR records and leave (an HR-core app's domain, which Butler can front); ITIL CMDB; purchasing (Bursar).
- **Why build it:** Freshservice and JSM queue tickets for humans to work. In a 20-person firm the "service desk" is the founder's DMs. Axis: **speed and staffing**. Resolution takes seconds and no desk is staffed, because every fix is an MCP call the agent is already permitted to make.
- **Reuses:** MCP catalog plus `/tools/call`, `agent_policies`, `agent_proposals`, `can_access`, Banter, Beacon/Qdrant, Blank, Bolt, Badge.
- **Closest existing app:** Helpdesk. Helpdesk is humans answering external customers. Butler serves internal staff and carries out the resolution itself.
- **Lens fit:** the operator's inbox, made agent-operable from start to finish.

### Brick: agent-native spreadsheet (absorbs Seat F Bespoke)
- **Names:** Brick · Bento · Grid
- **One-line pitch:** A spreadsheet whose cells can be live, permission-correct queries into the suite, whose columns an agent can fill in, and whose buttons can take real actions, so trackers stop going stale and simple internal tools need no builder.
- **Description:** Brick is a collaborative grid built on `@bigbluebam/structured-data` (Yjs). `=SUITE()` formulas call read-only MCP tools or certified Basis metrics, and results are filtered through `can_access` for each viewer. Agent columns apply a natural-language instruction per row, show where each value came from, and recompute when the relevant Bolt event fires. Action cells bind a row to an MCP write tool and run as the clicking user, so bulk writes go through `agent_proposals`. This covers Bespoke's "PTO screen / inventory checklist" use case in the most familiar productivity surface there is, without generating new code.
- **Scope (in):** grid, formulas and import/export (CSV/XLSX); live suite-query cells; agent columns with provenance; event-driven recompute; action cells and staged bulk writes; sheet templates (tracker, checklist, approval log); MCP `brick_read/write/fill_column`.
- **Scope (out):** charts and dashboards (Bench); metric definitions (Basis); presentations (Backdrop); macros or VBA parity; free-form app UIs.
- **Why build it:** Teams run on Google Sheets pasted from their tools, so the data is wrong by Tuesday and leaks rows the viewer shouldn't see. Retool and Airtable need a builder plus connectors. Axis: **trust and integration**. Cells are live, scoped to each viewer, and need zero connectors.
- **Reuses:** `@bigbluebam/structured-data`, MCP read/write tools, Basis, `can_access`, Bolt, `agent_proposals`, Bin.
- **Closest existing app:** Bin. Bin edits stored data files. Brick is a computational sheet (formulas, live queries, agent columns, actions), which places it in the office/productivity whitespace.
- **Lens fit:** the operator's real tool, wired into the platform's tool catalog instead of exported from it.

### Bosun: suite configuration from intent
- **Names:** Bosun · Ballast · Keel
- **One-line pitch:** Describe your company and an agent configures all 24 apps to fit, then catches drift and misconfiguration before it bites.
- **Description:** Bosun treats every app's settings (project templates, pipelines, Bill terms, Bolt rules, permission groups, channels, retention) as one declarative workspace plan. An agent drafts the plan from an interview, shows a diff against the live state, and applies it through MCP in staged, reversible proposals. A continuous linter flags orphaned Bolt rules, empty permission groups, apps that are on but unused, and settings that contradict each other.
- **Scope (in):** a plan schema covering all apps; drafting the plan from an interview; diff, apply and rollback through `agent_proposals`; a drift and misconfiguration linter; templates by company shape.
- **Scope (out):** infrastructure and deploys; automation authoring (Bolt); data migration from other vendors.
- **Why build it:** The suite's breadth is its weakness on day one, and the buyer has no administrator. Axis: **time-to-value** (hours, not weeks).
- **Reuses:** full MCP catalog, `agent_proposals`, `agent_policies`, `catalog.drift_detected`, permissions, `LAUNCHPAD_CATALOG`.
- **Closest existing app:** Bolt. Bolt runs event rules; Bosun reconciles the configuration of every app. It is platform administration.
- **Lens fit:** administration through intent, the most direct platform-tooling play.

### Biro: suite-wide e-signature (replaces Binder; Binder conceded to the GRC cluster)
- **Names:** Biro · Blot · Inkwell
- **One-line pitch:** Send anything in the suite for signature, an offer letter, an SOW, a policy acknowledgement or a quote, and an agent prepares the packet, checks it, chases the signers and files the executed copy where it belongs.
- **Description:** Biro is a single signing service that every app can call through `biro_request_signature(entity)`. An agent assembles the packet from the source record, places fields, diffs the document against the org's approved template to flag changed clauses before it is sent, and works out the signing order from roles. Executed copies are hashed into Bin with an audit certificate. A Bolt `document.signed` event then hands off to the apps downstream: Bulwark extracts obligations, Burn reads the SOW, a lifecycle app starts onboarding.
- **Scope (in):** signing packets and field placement; template-deviation check; signer routing and reminders; token-gated guest signing (the Bay guest-link pattern); a tamper-evident audit certificate; executed copy stored in Bin; Bolt events; MCP tools.
- **Scope (out):** contract negotiation and redlining; obligation tracking (Bulwark); notarization and qualified e-signatures in v1.
- **Why build it:** DocuSign charges per envelope and per seat and knows nothing about the record being signed. Axis: **cost and integration**. Signing is a platform primitive the suite's contract apps already need upstream.
- **Reuses:** Bin/`@bigbluebam/storage`, the Bay guest-token pattern, Bolt, `agent_proposals`, permissions, Bond and Book contacts.
- **Closest existing app:** Bulwark. Bulwark monitors contracts after they are executed; Biro gets them executed. It is an e-signature whitespace category.
- **Lens fit:** a shared, agent-callable platform primitive that other apps build on.

**Debate notes (Seat E)**

**Align:** **D Bastion (GRC):** this is the strongest of the five GRC framings, because questionnaire autofill with citations and joiner/mover/leaver residue as evidence are concrete wedges. I withdraw Binder and back D's Bastion as the cluster's survivor. Badge feeds it the access-review evidence. **B Badge / F Badge (access governance):** these overlap my original Bastion. My revised Badge is the merge: suite-native grants, SaaS and device inventory, seat-waste dollars and `access_zero`. It gives joiner/mover/leaver to the lifecycle cluster so it does not collide with it. I am offering the merged block to B and F. **D Baton / A Berth (joiner/mover/leaver):** I conceded lifecycle orchestration. Badge provides the access-zero verification and Butler can serve as the front door for move requests. Either should win the cluster, and D Baton's cited footprint scan is the most complete. **F Bespoke:** I absorbed it into Brick. A grid with action cells delivers the internal-tools wedge on a surface every SMB already uses, and Brick also fills the spreadsheet gap in the office suite. **G Backdrop:** I align as a sibling, not a merge. Presentations and spreadsheets are the two missing office essentials, and they should share the data-binding approach (`can_access`, Basis bindings). **A Bevy:** a complement rather than a conflict. Bevy owns the HR record and leave, while Butler is the fulfilment front door that can route HR asks to it.

**Oppose:** **F Bespoke standalone:** "describe a tool, get a mini-app" is Retool AI or Airtable Interfaces re-skinned. Without a familiar surface it is a builder looking for users, and the wedge survives only inside Brick. **B Baseline, A Bastion, F Bastion:** each is near-identical to D Bastion. Only one GRC app should reach the slate, and splitting the cluster's votes risks losing it. **A Bullhorn / C Bullhorn:** near-duplicates of G Bugle, which is the most complete of the three because it routes replies into Helpdesk and Bond. **G Billboard:** it depends on connectors to three ad platforms plus spend autonomy, so its v1 wedge relies more on integrations than on the AI, and it carries real money risk for SMBs.

**Strategy:** I moved my weight out of the three crowded clusters, where I would only split votes, and into categories no other seat holds. Butler (internal service desk) and Brick (office spreadsheet plus internal tools) are singletons in whitespace categories. Badge is the obvious merge home for access governance. Biro fills e-signature as a platform primitive the contract apps already need upstream. Bosun is a long shot. My likely submission is Butler or Brick. Butler shows the AI-native thesis most clearly (fulfilment instead of a queue) and no other seat proposed it. Brick wins on how essential it is, and it has a ready ally in F if Bespoke does not advance.

### Seat F - debate reply

### Bulletin: product change communications autopilot (releases, incidents, doc drift)
- **Names:** Bulletin · Broadcast · Herald
- **One-line pitch:** Every change you ship, and every outage you have, becomes the right message for each audience (changelog, in-app "what's new", status page, customer notice, internal sales/support brief, updated help articles) without anyone writing it four times.
- **Description:** Bulletin listens to merged PRs (via Bam's existing GitHub integration), completed Bam tasks, sprint closes, and Blip watch alerts. An agent clusters these into *change events* (a release or an incident) and classifies each item by which audience it affects. It then drafts tiered artifacts: a public changelog with an embeddable widget, a hosted status page with incident updates, an internal support/sales brief, and line-level diffs against every Beacon and Helpdesk KB article the change made stale. A "you asked, we shipped" pass traces Helpdesk tickets and Bond accounts through `entity_links` to the change and drafts targeted notices to the exact customers who requested it. Every artifact passes the `agent_proposals` queue before it publishes.
- **Scope (in):** change ingest and clustering; audience-impact classification; changelog, in-app feed, and status page; incident update drafting from Blip alerts; stale-doc detection with suggested edits; requester matching and closed-loop notices; HITL publish; MCP tools (`bulletin_draft_release`, `bulletin_stale_docs`, `bulletin_incident_update`).
- **Scope (out):** public social posting (it emits a `release.published` event that a social app can consume); bulk email delivery (handed to Blast); feature flags or deployment; uptime probing itself (Blip owns signals).
- **Why build it:** Small software teams skip release notes, leave help articles wrong for months, and never tell the customer who asked for a feature that it shipped. LaunchNotes, Beamer, and Statuspage are separate editors, and none of them can see tickets, CRM, and code at once. The axis is **closed-loop customer communication plus speed**, from cross-app data no standalone tool has.
- **Reuses:** Bam GitHub integration (`github-integration.service.ts`, webhook routes), Bam tasks/sprints, Blip watches, Helpdesk tickets, Bond contacts, `entity_links`, Beacon/Helpdesk KB, Blast (send), `agent_proposals`, Bolt (`release.published`, `incident.updated`).
- **Closest existing app:** Blast. Blast sends campaigns a human authors to a list. Bulletin *derives* product-change messaging from shipped work and incidents and routes it per audience, including fixing stale docs. That is product communication, not an email tool, and it is not social publishing either.
- **Lens fit:** It turns the engineering output stream into customer and internal communication.

### Bastion: continuous compliance evidence, plus an outward trust center (merge-ready)
- **Names:** Bastion · Binder · Attest
- **One-line pitch:** SOC 2 / ISO 27001 readiness that collects its own evidence from your repos, deploys, and suite activity, then answers your customers' security questionnaires from that same evidence.
- **Description:** Same core as the GRC cluster: framework library, AI control-to-evidence mapping, scheduled re-tests, drift remediation proposed into `agent_proposals`, and an auditor evidence room. Two engineering-specific parts that the other framings lack. First, change-management controls are tested straight from the GitHub integration (review-before-merge, branch protection, deploy-to-ticket traceability). Second, an outward trust center plus a questionnaire autopilot answers inbound security questionnaires (SIG, CAIQ, custom spreadsheets) with citations to live control status, sending low-confidence answers to a human.
- **Scope (in):** controls, evidence, drift, and remediation; policy attestation via Beacon; auditor room; trust-center page; questionnaire ingest (Bin) and cited answer drafting; MCP tools.
- **Scope (out):** vendor/customer contract obligations (Bulwark); vulnerability scanning; CSPM.
- **Why build it:** Vanta/Drata plus SafeBase/Conveyor costs over $20k/yr. Small B2B teams lose deals while they wait on questionnaires. The axis is **cost, and sales velocity from the same evidence**.
- **Reuses:** GitHub integration, `activity_log`/`v_activity_unified`, Beacon, Blip retention, Bin, Bond (which deal is waiting on the questionnaire), `agent_proposals`, Bolt.
- **Closest existing app:** Bulwark. Bulwark covers obligations owed to counterparties under contracts; Bastion proves internal controls and turns that proof into sales trust.
- **Lens fit:** Engineering systems of record become compliance proof and sales collateral.

### Badge: access and credential governance (folds into the JML merge)
- **Names:** Badge · Keyring · Bouncer
- **One-line pitch:** Know who, and which agent, holds access to what across the suite and your SaaS, with access reviews and leaver revocation done for you.
- **Description:** An entitlement graph with peer-group baselines, stale-access and toxic-combination detection, review campaigns, and JML revocation plans as proposals. The engineering-specific part, which I hold as non-negotiable in any merge, is **non-human credentials**: `bbam_`/`bbam_svc_` keys, rotation grace windows, `agent_policies` allowlists, and service accounts with no living owner.
- **Scope (in):** entitlement inventory (suite plus GitHub/Google/Slack read connectors); agent and service-account credential hygiene; reviews; revocation proposals; seat-waste report.
- **Scope (out):** IdP/SSO; MDM; HRIS records.
- **Why build it:** Small teams offboard by memory, and nobody owns the agent credentials that are now multiplying. The axis is **trust and cost** (the seat savings pay for it).
- **Reuses:** `users.kind`, API-key rotation (0117), `agent_policies`, `agent_runners`, oauth_providers, @bigbluebam/permissions, `agent_proposals`, Bolt.
- **Closest existing app:** none. `/b3/people` is suite user CRUD only.
- **Lens fit:** Secrets and identity hygiene for a mixed human and agent workforce.

### Bespoke: agent-built internal tools (offered to the Brick merge)
- **Names:** Bespoke · Bodge · Toolsmith
- **One-line pitch:** Describe the internal tool you need and an agent assembles a governed mini-app (table, form, action buttons, schedule) over suite data and the MCP tool catalog.
- **Description:** The output is a declarative spec, not free code. Each button binds to an MCP tool and runs under the builder's permissions and `can_access`. Tools are versioned and diffable, and the agent repairs them when a tool schema changes.
- **Scope (in):** natural language to spec; component set; permission-scoped execution; versioning; schema-drift self-repair.
- **Scope (out):** arbitrary code; external DB connectors; public sites.
- **Why build it:** The axis is **zero-connector integration and trust**, against Retool/Airtable Interfaces.
- **Reuses:** MCP catalog and `/tools/call`, `agent_policies`, `can_access`, Bin structured data, Bolt schedules, @bigbluebam/ui.
- **Closest existing app:** Bolt. Bolt automates headless rules; Bespoke builds human-facing screens.
- **Lens fit:** The developer platform surface, handed to non-engineers.

### Bonafide: security questionnaire and trust-center desk (standalone fallback if GRC collapses without it)
- **Names:** Bonafide · Bona · Vouch
- **One-line pitch:** Drop in a customer's 300-row security questionnaire and get it back cited and 80% answered in an hour, with a public trust page that answers most of them before they get sent.
- **Description:** Bonafide keeps an answer library grounded in Beacon policies, engineering facts (from the GitHub integration, Blip retention settings, and backup configuration), and prior answered questionnaires stored in Bin. An agent maps each incoming question to that library, cites its sources, flags answers whose source has changed since they were last given, and routes low-confidence rows to the owner identified by `expertise_for_topic`. The response is tied to the Bond deal, so sales can see which deal the questionnaire is blocking.
- **Scope (in):** questionnaire ingest (xlsx/csv/portal paste); cited answer drafting; answer library with staleness tracking; trust page with gated NDA documents; per-deal tracking; HITL.
- **Scope (out):** control monitoring or audits (the GRC app); contract negotiation (Bulwark).
- **Why build it:** Questionnaires stall small B2B deals for weeks, and SafeBase/Conveyor are enterprise-priced. The axis is **sales cycle speed**.
- **Reuses:** Beacon/Qdrant, Bin, Bond, `expertise_for_topic`, `agent_proposals`, Bolt.
- **Closest existing app:** Helpdesk. Helpdesk answers customer support requests, whereas Bonafide answers security due-diligence questions with citations and owners. The work is different and so is the buyer.
- **Lens fit:** Engineering facts, translated for buyers' security teams.

**Debate notes (Seat F)**

**Align:** **GRC cluster (A Bastion, B Baseline, D Bastion, E Binder):** Align on a single compliance app. My non-negotiables in that merge are GitHub-sourced change-management controls and the questionnaire/trust-center output, which turn a cost centre into a sales tool. **JML cluster (A Berth, B/C/D Baton, E Bastion-IAM) with access governance (B Badge):** Align on one lifecycle app. Revoking a leaver's access *is* the handover's last step, so splitting them yields two weak apps. My Badge contributes non-human credential governance, which nobody else covered. **Learning cluster (A Brevet, B Boost, D Bloom, C Buddy):** Align, and I withdraw Bootcamp. Brevet/Boost's friction-driven targeting is the strongest framing. Bootcamp's "measure ramp from real activity (first merged PR, first resolved ticket)" should be folded in. **E Brick:** Align with Bespoke. A spreadsheet whose rows grow action buttons bound to MCP tools is a stronger office/productivity entry than either app alone. **C Bugle (internal announcements):** Conditional align with Bulletin as "change communications" (internal plus product changes). I would merge only if the release/incident/doc-drift core survives.

**Oppose:** **E Bosun:** Oppose. Suite self-configuration is an admin convenience, not a horizontal essential that firms staff departments for. It belongs as a platform feature. **B Bellwether:** Oppose. Inferring burnout from work telemetry is a trust liability for 10-person teams. C Barometer's consent-based listening is the safer version of the same category.

**Ignore:** A Bevy, D Brace, D Bravo, E Butler, G Blazon, G Billboard, G Byline, G Backdrop.

**Boundary note:** A/C Bullhorn and G Bugle (social publishing) do not overlap Bulletin. Bulletin emits `release.published` for them to consume, and it owns the in-product changelog, status page, and doc drift, which social tools do not touch.

**Strategy:** My best shot at the final seven is **Bulletin**. It is the only release/incident/doc-drift communication app in the field, it sits clearly in the comms whitespace, and only this suite can do it, because it needs code, tickets, CRM, and KB in one tenant. I am deliberately feeding my clustered ideas (Bastion, Badge, Bootcamp, Bespoke) into the merges where they add a distinct, defensible part (engineering evidence plus questionnaires, agent-credential governance, ramp metrics, MCP-bound actions). That way I have a stake in whichever merged apps survive without spending my submission on a five-way collision. Bonafide is a fallback in case the GRC merge drops the outward-facing trust work.

### Seat G - debate reply

### Bullhorn: social and PR desk that drafts from what the business actually did (my Bugle and Byline merged, aligned with A and C Bullhorn)
- **Names:** Bullhorn · Byline · Broadside
- **One-line pitch:** Your company's real wins, like releases, deals, events and hires, become on-brand social posts and press pitches, and a holding statement is ready before a crisis lands. You approve; you don't write.
- **Description:** An agent subscribes to Bolt events across the suite (a Bam release, a Bond win with publicity consent, a Book webinar, a Bearing milestone, a Blip outage) and turns each one into a story candidate. It writes channel-native social variants and, when the story is newsworthy enough, a press release plus personalized pitches to journalists, scored by how relevant each journalist's recent coverage is. Every draft passes a Blazon brand and claims check and lands in `agent_proposals`. Replies and mentions are routed: complaints to Helpdesk, buying signals to Bond, coverage into a clip book that is scored against a versioned message house. Incident events trigger drafted holding statements for human sign-off.
- **Scope (in):** an event-to-story feed; social variants per channel (LinkedIn, X, Bluesky, Threads, Meta); a message house and spokesperson registry; release and pitch drafts; a media list stored as Bond contacts with a press role; an approval queue; a schedule and publish worker; a mention inbox with AI routing; a coverage clip book; crisis drafts triggered by Bolt events; engagement written to Bench; MCP tools (`bullhorn_draft_from_entity`, `bullhorn_schedule`, `bullhorn_crisis_draft`).
- **Scope (out):** paid boosting (Billboard); newswire distribution (export only); buying journalist databases; broad web listening; email (Blast); internal announcements (C's Bugle).
- **Why build it:** Buffer, Hootsuite and Sprout give you an empty calendar, and Cision and Muck Rack cost $7k to $20k a year. Small teams skip both because the bottleneck is knowing what to say. The axis is **content supply plus speed in a crisis**: the suite already knows the wins and sees the outage first.
- **Reuses:** Bolt, `agent_proposals`, Bin, Bay (visual sign-off), Bond, Braid, Helpdesk, Blip, Beacon (facts), Blazon, Bench, the worker, `can_access`.
- **Closest existing app:** Blast. Blast is owned email to a consented list. Bullhorn covers public social and earned media, with two-way conversations and a different risk profile.
- **Lens fit:** This is the core of external marketing comms and PR for a firm with no comms staff.

### Blazon: brand and claims governance as an executable policy every agent must pass
- **Names:** Blazon · Brandbook · Hallmark
- **One-line pitch:** Your brand guidelines and approved claims become a live checker that reviews every email, post, deck, doc and image before it leaves the building, and fixes what it can.
- **Description:** Blazon compiles a brand book into a versioned, typed policy. The text rules cover voice, terminology, product naming and required disclaimers. The visual rules cover logo clear-space, palette and contrast. Its most distinctive object is a **claims register**: every public statement of fact ("40% faster", "SOC 2 compliant", "trusted by Acme") is bound to its proof (a Basis metric, a Bond consent flag, a Bin document) and expires when the proof does. `brand_check(artifact)` is an MCP tool and a pre-send hook on Blast, Bullhorn, Bay, Backdrop and public Brief docs. It returns findings that cite the broken rule, plus suggested fixes, and blocks or warns depending on per-org settings. Agents are the main users, and that is the point: once agents write most outbound content, Blazon is what keeps them on brand and keeps their claims true.
- **Scope (in):** ingesting and authoring policy with version lineage; text and vision checks; auto-fix suggestions; a claims register with proof bindings and expiry (a Basis metric moving or a Bond consent being revoked invalidates the claim everywhere it is used); pre-send gates; an override flow through `agent_proposals`; a drift report by app, team and agent; MCP `brand_check`, `brand_fix`, `claim_verify`.
- **Scope (out):** asset storage (Bin); human approval workflow (Bay); generating creative; trademark clearance.
- **Why build it:** Frontify, Acrolinx and Writer cost $20k to $100k+ a year. Small firms have a PDF nobody opens, and now agents publish at machine speed. The axis is **trust**: no SMB tool ties public claims to live proof. A FTC or advertising-standards problem from a stale "40% faster" is a real liability, and Blazon catches it at the moment of sending.
- **Reuses:** Bin, the llm-provider, the MCP register-tool hook pattern, Basis (proof), Bond (consent), Blast, Bay and Bullhorn as gates, `agent_proposals`, Bolt (`claim.expired`, `brand.violation`), permissions.
- **Closest existing app:** Bay. Bay is a person approving one asset. Blazon is automatic policy plus proof-of-claim across every app and agent. It shortens Bay reviews rather than duplicating them.
- **Lens fit:** This is the brand function itself, with the claims discipline that large firms staff legal and marketing ops for.

### Billboard: guardrailed autonomous ad operations judged on revenue
- **Names:** Billboard · Bidder · Beam
- **One-line pitch:** An ad agent that runs your Google, Meta and LinkedIn campaigns within hard budget rules and judges them on paid invoices, not clicks.
- **Description:** Billboard pulls spend and performance from ad accounts. Using Braid, it joins conversions to Bond deals and Bill payments, so each campaign carries a real cost per won deal and a payback period. Inside hard guardrails (a daily cap, a maximum percentage shift per action, allowlisted channels), the agent paces budget, pauses losers and rotates in new creative variants that have passed Blazon. Anything outside those limits becomes a proposal. Every change is logged with the reason the agent gave. It also uploads Bond stage changes back to the platforms as offline conversions, so the platforms' own bidding starts optimizing for revenue.
- **Scope (in):** v1 connectors for Google Ads, Meta and LinkedIn (read plus a narrow write set covering budget, status and ad rotation); offline conversion upload; revenue attribution through Braid, Bond and Bill (deterministic first-touch and last-touch); a guardrail policy engine; autonomous pacing; creative variants; an audit trail; MCP `ads_status`, `ads_propose_shift`, `ads_cost_per_won_deal`.
- **Scope (out):** DSP and programmatic buying; offline media; agency billing; a modeled multi-touch attribution engine.
- **Why build it:** Small firms pay agencies 10 to 20% of spend or let Smart Campaigns optimize toward clicks they can't tie to money. The axis is **outcome truth plus cost**: only the suite holds the CRM and invoice data that closes the loop. Platform API access (Google developer token, Meta app review) is a known one-time gating cost, not a design risk.
- **Reuses:** Braid, Bond, Bill, Basis (certified CAC), Bench, Bolt (`campaign.underperforming`), `agent_proposals`, Blazon, Bin, the worker.
- **Closest existing app:** Blast. Blast is owned email to people already in Bond. Billboard is paid reach to strangers, with budget autonomy as its core mechanism.
- **Lens fit:** This is advertising, the largest marketing line item small firms run blind.

### Backdrop: presentations built from live suite data, kept current
- **Names:** Backdrop · Brio · Podium
- **One-line pitch:** Ask for "the Q4 board deck" or "the Acme renewal pitch" and get an on-brand presentation whose every number traces to its source and stays current.
- **Description:** A deck is a typed graph of slides. Each slide is bound to sources: a Basis certified metric, Bearing goals, a Bond account view, a Bench chart, Beacon passages. An agent assembles a deck from an intent plus the Blazon theme. Before each presentation it re-checks the bindings, flags and offers to refresh any slide whose figure has moved, and redacts anything the current viewer can't see (`can_access`). The result is one deck that can be shown to the board, the team or a customer, each audience seeing a correctly scoped version.
- **Scope (in):** a slide editor (layouts, text, images, charts); source-bound blocks with freshness badges; generation from intent and from templates; theme enforcement; per-viewer redaction; PPTX and PDF export and PPTX import; present mode with speaker notes; MCP `deck_generate`, `deck_refresh`, `slide_bind`.
- **Scope (out):** rich animation; webinar hosting; full PowerPoint parity; free-form canvas (Board); spreadsheets (Brick).
- **Why build it:** Presentations are the office-suite gap. Every QBR and board update is rebuilt by hand from stale screenshots, and Gamma and Tome generate pretty slides with no ground truth behind them. The axis is **trust**: governed, refreshable, permission-scoped numbers.
- **Reuses:** Basis, Bench, Bearing, Bond, Beacon, Blazon, Bin, `can_access`, Bolt (`metric.changed`), permissions. It shares a live-binding cell primitive with E's Brick if both are built.
- **Closest existing app:** Board. Board is a free-form collaborative canvas. Backdrop is a linear, audience-facing narrative bound to data. Bench renders charts, and Backdrop tells the story with them.
- **Lens fit:** The deck is the most-used brand and sales artifact a company produces.

### Boast: customer proof engine (case studies, testimonials, references)
- **Names:** Boast · Bouquet · Proofpoint
- **One-line pitch:** The suite notices which customers are winning with you, asks them at the right moment, and turns their yes into approved case studies, quotes and reference calls.
- **Description:** An agent scores advocacy readiness from signals no standalone tool sees together: Helpdesk CSAT and closed-without-escalation streaks, Bond renewals and expansions, Bill paid-on-time history, Bearing outcomes shared with the client, and positive mentions surfaced by Bullhorn. At a high moment (just renewed, ticket praised) it drafts a personalized ask, then runs the consent flow (a Blank form with usage scopes: logo, quote, named case study, reference calls). It drafts the case study from the actual engagement record with cited metrics. Each approved quote is registered as a claim in Blazon, so it expires when consent is revoked, and is offered to Bullhorn, Backdrop and Blast. Reference requests from Bond deals are matched to the best-fit advocate and rate-limited so no customer is overused.
- **Scope (in):** advocacy scoring; ask timing and drafts through `agent_proposals`; scoped consent capture and revocation; case study and testimonial drafting with cited metrics; a proof library with usage tracking; reference matching with per-advocate fatigue caps; MCP `proof_find`, `proof_request_reference`.
- **Scope (out):** review-site management (G2/Capterra posting); incentive and reward stores; a community forum; NPS survey building (Blank).
- **Why build it:** UserEvidence, Influitive and Champion cost $15k+ a year, and small firms ask for testimonials ad hoc and at bad times. The axis is **timing and consent integrity**: the suite knows exactly when a customer is happy and holds consent in one place that every outbound channel respects.
- **Reuses:** Helpdesk, Bond, Bill, Braid (one customer across apps), Blank (consent), Bearing, Blazon (claims register), Bullhorn, Backdrop, Blast, Bolt (`advocate.ready`, `consent.revoked`), `agent_proposals`.
- **Closest existing app:** Bond. Bond tracks deals and relationships. Boast turns post-sale success into consented, reusable marketing proof, which is a product-marketing function and not a CRM view.
- **Lens fit:** Customer proof is the highest-converting marketing asset and the one small firms collect worst.

**Debate notes (Seat G)**

- **A Bullhorn: Align.** It is the same core as my Bugle. The merged Bullhorn above adds PR, message house and crisis, which makes it a full external-comms desk rather than a scheduler. I offer to co-own it.
- **C Bullhorn: Align.** This is the closest match: social plus PR plus crisis is exactly my Bugle+Byline merge. The merged block above is my proposed shared text.
- **F Bulletin: Align (as a source, not a merge).** Release clustering and requester matching are strong, but they are product communication. Bullhorn should consume `release.published` from it rather than absorb it. If only one survives, Bulletin's release stream folds into Bullhorn's event feed.
- **E Brick: Align (as siblings).** Brick and Backdrop are the two office-suite gaps and share the same live, `can_access`-scoped binding primitive. They are complementary rather than competing, and both should survive the overlap phase as separate categories.
- **C Bugle (internal announcements): Ignore, but keep the boundary.** It is internal comms, mine is external. I renamed mine to avoid the name clash.
- **E Bespoke: Oppose (mild).** Natural language to internal tools on top of MCP overlaps heavily with Bolt plus Blank plus Brick. Its category is "Retool for the suite", which is not a horizontal business function that firms staff departments for.
- **Five-way GRC cluster (A Bastion, B Baseline, D Bastion, E Binder, F Bastion): Ignore on substance.** It is a strong essential and should collapse to one. I note Blazon's claims register is marketing-claims substantiation, not internal controls, so it is not in that cluster.

**Strategy:** Social publishing is a three-seat cluster that will be collapsed, so I am aligning with A and C behind one merged Bullhorn instead of fighting for my own Bugle. I am also folding my Byline into it so the merged app is clearly stronger than any single version. That frees my submission slot for an app nobody else proposed. My lead candidates are **Blazon** (brand and claims governance, an uncontested singleton, and the gate every other outbound app and agent calls) and **Backdrop** (presentations, the office-suite essential, distinct from Brick). Billboard and Boast stay in my five as distinct, defensible lens coverage, and both feed Blazon's claims register, so the portfolio holds together.

## Phase 3 - Submissions

Each seat submitted its single strongest app. Verbatim:

**SUBMISSION - Seat A:**

### Bevy (agent-run people core: the employee record that runs itself, for humans and AI agents)
- **Names:** Bevy · Roster · Bellhop
- **One-line pitch:** You get the HR department a 2-50 person company never hires. One people record, covering both staff and AI agents, where an agent decides routine HR matters within policy, works out what each change touches across every app, and applies it.
- **Description:** Bevy is the suite's missing people system of record: persons and agents, org chart, managers, roles, employment status, leave balances, policy acknowledgements. The AI mechanism is not a chat box on HR forms. It has three parts:
  1. **Policy-decided requests.** Leave, schedule and role-change requests are evaluated against cited Beacon policy, team coverage (Bam load, Book calendars) and the approval chain. The agent auto-decides the clear cases and routes only real exceptions to agent_proposals.
  2. **Change-impact compilation.** A role or manager change is compiled into its cross-app consequences (approval chains, Bam project roles, Bolt rule owners, Book routing, Banter channels, agent_policies scopes). The agent shows the diff, and it is applied through MCP on approval, so the org model is executable rather than a static chart.
  3. **Agent-workforce governance.** Every `users.kind = agent` has a named human owner, a scope bound to agent_policies, a cost line, and a review date. Bevy flags orphaned agents, for example when an agent's owner left, and expired reviews, so the question "who works here" includes the bots.
- **Scope (in):** person and agent records; org chart and reporting lines; employment-status lifecycle events (`person.joined/moved/leaving`, emitted on Bolt for the joiner/mover/leaver, access, learning and GRC apps to consume); leave with coverage-aware auto-decision; change-impact diff and MCP apply for role and manager changes; cited policy Q&A and acknowledgements; agent owner, review and cost records; a manager digest; MCP tools `bevy_person`, `bevy_request_leave`, `bevy_change_role` (staged), `bevy_org_chart`, `bevy_agent_roster`.
- **Scope (out):** payroll and benefits; recruiting; performance reviews; general IT/facilities request fulfilment (Butler); cross-app ownership handover of a leaver's work (Baton); access reviews (Badge); confidential ER cases (Brace).
- **Why build it:** HR core is the first essential on the whitespace list, and the suite has zero apps for it. BambooHR and Gusto are form-and-approval CRUD: a human still decides every leave request, and nothing downstream updates when someone's manager changes. Bevy wins on three axes. **Staffing:** routine decisions need no HR headcount. **Integration:** one change propagates to all 24 apps instead of being re-keyed. **First-mover:** no HRIS models AI agents as accountable workforce members, and the suite already has users.kind, agent_runners and agent_policies to build on. Every other people-lifecycle finalist (Baton, Badge, Brace, the learning app, recruiting) needs a person/manager/status record to key off, and Bevy is that record.
- **Reuses:** auth/users and users.kind, agent_runners, agent_policies, @bigbluebam/permissions, MCP catalog and internal /tools/call (the apply arm), agent_proposals, Beacon (policies), Book (availability), Bam (load and roles), Banter (intake and digest), Blank (forms), Bolt (lifecycle events), can_access, RLS.
- **Lens fit:** an agent decides and executes routine people operations, compiling each org change into autonomous, human-gated cross-app actions.
- **Closest existing app:** Bam /b3/people. That screen is account and membership CRUD for logins. Bevy is the HR system of record (employment, reporting lines, leave, policy, agent ownership), with an agent that decides and propagates. Butler is a neighbor rather than an overlap: Butler fulfils IT and ops requests, and it can front HR asks into Bevy.

*Why this one (Seat A):* Bevy is the only HR-core entry on the board and is uncontested, while my other four sit in clusters that have converged on other seats' survivors (Baton, Baseline, Boost/Bloom) or are now three-way contested (recruiting). It is also the record every other people-lifecycle finalist depends on.

**SUBMISSION - Seat B:**

### Baseline
- **Names:** Baseline · Attest · Bastion
- **One-line pitch:** Every night your SOC 2 / ISO 27001 controls are checked against what actually happened in the suite. The audit binder writes itself, and the controls nothing can prove are listed first, with the cheapest fix for each.
- **Description:** Baseline is a continuous internal-controls engine:
  - **Control compiler:** An LLM compiles a framework (SOC 2, ISO 27001, or a custom policy set) into typed, testable control assertions, and a human confirms each one.
  - **Evidence binding:** Each assertion is bound to an evidence query over data the suite already holds: `v_activity_unified`, `agent_audit`, permission grants, API-key age, `agent_policies` kill switches, login history, backup runs, Blip retention, Bolt executions, Beacon policy acknowledgements, and review-before-merge from the Bam GitHub integration.
  - **Nightly evaluation:** An evaluator freezes evidence snapshots as hashed Bin objects. Each snapshot cites the query that produced it. Every control gets a status of pass, fail, or **unprovable**.
  - **Evidence coverage graph (the data-lens core):** It shows which controls have native proof, which rely on manual uploads, and which have nothing. It ranks the gaps by audit risk and drafts the cheapest fix for each into `agent_proposals`: a Bolt rule, a policy draft, or an evidence request to a named owner.
  - **Questionnaire autofill:** The same evidence graph answers inbound security questionnaires, citing evidence for every answer. Questions it cannot answer go to a human for review.
- **Scope (in):** framework-to-assertion compiler (AI-proposed, human-confirmed); control library with owners; nightly evaluator with immutable cited snapshots; evidence coverage graph and gap ranking; drift alerts as Bolt `control.drifted`, plus remediation Bam tasks; Beacon policy attestation; ingest of evidence from sibling apps (training completions, incident-response records, access-review campaigns) when they are present; security-questionnaire autofill with citations; token-gated read-only auditor room and export packet; MCP tools `baseline_control_status`, `baseline_evidence_for`, `baseline_coverage_gaps`.
- **Scope (out):** customer and vendor contract obligations (Bulwark); outbound vendor-risk questionnaires (Bursar's territory); acting as a certification body, or giving legal opinions; pentest, CSPM, and endpoint scanning (it accepts uploaded evidence instead); running access reviews or training itself (it consumes their records as evidence).
- **Why build it:** The axis is **cost + evidence trust**. Vanta and Drata cost $10-40k/yr, need a connector per tool, and still collect much of their evidence as screenshots. Baseline's evidence source is the system of record itself, and every snapshot is immutable and cites its query. The "unprovable" list tells a 15-person firm facing its first enterprise security review exactly what to fix, in priority order, at near-zero marginal cost.
- **Reuses:** shared DB + RLS, `v_activity_unified`, `agent_audit`, @bigbluebam/permissions, `api_keys`, `agent_policies`, the Bam GitHub integration, Bin + @bigbluebam/storage (immutable evidence), Beacon (policies and attestations), Blip, Bam (remediation tasks), Bolt, `agent_proposals`, Bay-style token-gated guest links, MCP catalog.
- **Closest existing app:** Bulwark. Bulwark tracks clauses owed to outside counterparties under signed contracts. Baseline proves the org's own internal controls to an auditor. The object, the buyer, and the evidence source are all different.
- **Lens fit:** Compliance becomes a continuously evaluated query over the suite's operational data. Its main output is a measured coverage map, not a document checklist.

*Why this one (Seat B):* After debate, Baseline is the agreed survivor of the largest cluster (A, D and E conceded to it, and F offered its pieces). That makes it the least likely to be cut or forced into a failed merge. The other four are still contested: Badge on where JML stops and access governance starts, Boost on learning, and Billet in a three-way recruiting cluster. Bellwether is co-owned with C.

**SUBMISSION - Seat C:**

### Bellman: announcements that confirm they were understood
- **Names:** Bellman · Clarion · Broadcast
- **One-line pitch:** Send a company announcement once, and Bellman makes sure each person got it, understood it, and did what it asked.
- **Description:** A leader, or a Bolt event, provides one source message: a policy change, reorg, office closure, incident notice or an internal briefing on a shipped release. An agent rewrites it for each audience by role, team and locale, and picks each person's channel (Banter, email or digest). Each recipient answers a one- or two-question understanding check instead of clicking "I read it." The agent then groups the follow-up questions that arrive through Banter threads and Helpdesk, finds which sentences confused which teams, and drafts a targeted clarification for the sender to approve. Required acknowledgments get deadlines and escalating nudges, and each completed acknowledgment produces a signed understanding record.
- **Scope (in):** one source message, rewritten per audience; targeting from org, team and role; source triggers: manual, Bolt event (for example a sprint close, an incident, or a Beacon policy version), or an agent call through MCP; understanding checks; required acknowledgments with deadlines and nudges; grouping of confusion signals and drafted clarifications, routed to agent_proposals; a team-by-section understanding heatmap; signed acknowledgment records published as Bolt events, so compliance and training apps can use them as evidence; MCP tools `bellman_draft`, `bellman_target`, `bellman_status`, `bellman_ack_record`.
- **Scope (out):** chat (Banter); external email marketing (Blast); public social and PR (Bullhorn); policy and wiki storage (Beacon); skill training paths (the learning app); control testing (Baseline); customer-facing changelogs.
- **Why build it:** The axis is **closed-loop proof that a message landed.** Small firms post in a channel and hope people read it. Staffbase and Simpplr are enterprise-priced and stop at open rates. No tool at SMB price measures understanding by section and team and then drafts the fix. It is also the one delivery and attestation rail that the GRC, learning and handover finalists would otherwise each rebuild ("did everyone acknowledge and understand the new policy?").
- **Reuses:** auth/RLS, org and team membership, @bigbluebam/permissions, Banter channels and `banter_schedule_post`, the worker email queue, Helpdesk (inbound questions), Beacon versions as a trigger, Bolt (`announcement.published`, `ack.overdue`, `ack.recorded`), agent_proposals, can_access, Bench.
- **Lens fit:** internal communication from the company to employees, which is the communication category the suite does not cover.
- **Closest existing app:** Banter. Banter is many-to-many conversation. Bellman is one-to-many communication that is tracked per person, has deadlines and verifies understanding. It is a different job, not a better chat. The same argument separates it from Blast, which sends one-way email to external lists and stops at opens and clicks.

*Why this one (Seat C):* It is the only app in my five with no rival in the field. Barometer is merging into Bellwether, Baton belongs to the handover cluster, and Bouquet and Bonfire are narrower. That means Bellman can survive the Phase 4 overlap screen on its own merits. I also folded in Seat F's internal release-briefing angle, so a merge with Bulletin, if one is forced, is already compatible.

**SUBMISSION - Seat D:**

### Brace (workplace incident, speak-up and employee-relations case desk)
- **Names:** Brace · Buoy · Casebook
- **One-line pitch:** One confidential intake for injuries, near-misses, harassment, grievances and whistleblower reports. An agent classifies each one, starts the legal clocks it triggers, and drives the case to a documented close.
- **Description:** Reports come in through a Blank form, a Banter DM to a bot, a voice note, or an anonymous tokenized link that gives the reporter a two-way channel without revealing who they are. An agent classifies each report and cites the rule text it relied on. **Injury cases:** whether the injury is recordable under OSHA 300/301-style criteria, and whether a short regulator-notification window applies (8 hours for a fatality; 24 hours for an in-patient hospitalization, an amputation or loss of an eye). **Whistleblower cases:** for EU employers with 50 or more staff, the 7-day acknowledgement duty and the 3-month feedback duty. **Other cases:** near-miss, harassment, policy breach or grievance. Brace then limits visibility to people who need to know and auto-excludes the accused and their management chain. It starts deadline clocks and drafts an investigation plan, interview questions and corrective actions, which become Bam tasks. Across cases it detects patterns that no single case shows, such as the same location, manager or hazard recurring, or retaliation timing. Every conclusion, notification and closure is a HITL proposal. Nothing goes to a regulator or an accused party unattended.
- **Scope (in):** multi-channel and anonymous intake, with an anonymous two-way mailbox; classification with citations; statutory and policy clocks that depend on jurisdiction; a confidentiality access list per case, stricter than org RLS, with conflict-of-interest exclusion; an investigation workspace and a hashed evidence locker in Bin; corrective actions linked to Bam, with effectiveness checks; incident-log export in 300/300A form; alerts for patterns and retaliation across cases; MCP tools `brace_case_status`, `brace_clock_due`, `brace_pattern_scan`.
- **Scope (out):** filing workers' comp claims; legal advice (it flags the case for counsel instead); hazard modules for a single industry; customer complaints (Helpdesk); general employee requests (Butler).
- **Why build it:** Axis: **trustworthy legal deadlines at SMB cost**. Every employer owes duty-of-care reporting and an investigation trail, including office-only firms. Small firms handle this in email, miss the 8-hour and 24-hour windows, and later cannot show that the process was free of retaliation. Enterprise tools (Intelex, HR Acuity, NAVEX) are priced for compliance departments.
- **Reuses:** intake and evidence: Blank (intake forms), Banter (bot intake), voice-agent, Bin with @bigbluebam/storage (evidence); access control: @bigbluebam/permissions (the per-case access list), the can_access preflight; workflow: Bam (corrective actions), Bolt (`case.clock_due`, `case.pattern_detected`), agent_proposals, the MCP catalog; downstream: incident-response evidence feeds the GRC app (Baseline).
- **Closest existing app:** Helpdesk. Helpdesk answers external customers' requests in a shared queue. Brace handles internal duty-of-care cases where confidentiality, conflict exclusion and statutory clocks are the product, which a ticket queue structurally cannot offer.
- **Lens fit:** Health and safety plus employee relations is the people-risk function the law requires of every employer, and small firms improvise it.

*Why this one (Seat D):* Brace is the only health-and-safety/ER proposal of the 35, so it has no rival to merge with. Another seat endorsed it in debate as horizontal and AI-native. Beckon, by contrast, became a three-seat recruiting cluster, and my remaining apps sit in clusters I have conceded.

**SUBMISSION - Seat E:**

### Brick: agent-native spreadsheet
- **Names:** Brick · Bento · Grid
- **One-line pitch:** A spreadsheet where any cell can be a live, permission-correct query into the suite, any column can be filled in by an agent, and any row can take a real action. Trackers stop going stale, and simple internal tools no longer need a builder.
- **Description:** Brick is a collaborative grid built on `@bigbluebam/structured-data` (Yjs CRDT, CSV/XLSX codecs). It adds three kinds of cell that no other spreadsheet has: `=SUITE()` formulas call read-only MCP tools or certified Basis metrics, with results filtered per viewer through `can_access`, so one sheet can be shared safely with different audiences; agent columns take a plain-language instruction per row ("summarize this deal's last touch", "classify churn risk"), and each value is cached with its source attached and recomputes when the relevant Bolt event fires; action cells bind a row to an MCP write tool and run as the clicking user, with bulk writes staged into `agent_proposals`. Brick itself is fully agent-operable: agents can read, write and fill columns through MCP. That makes the sheet a shared staging surface between people and agents. It also covers Seat F's internal-tools use case (PTO log, inventory checklist, approval tracker) without generating any code.
- **Scope (in):** grid, formulas and multiplayer editing; CSV/XLSX import and export; live suite-query cells with per-viewer scoping; agent columns with provenance and event-driven recompute; action cells and staged bulk writes through HITL; sheet templates (tracker, checklist, approval log, roster); MCP `brick_read`, `brick_write`, `brick_fill_column`, `brick_apply_staged`.
- **Scope (out):** charts and dashboards (Bench); metric definitions (Basis); presentations (Backdrop); file and asset storage (Bin); event-rule automation (Bolt); VBA or macro parity; free-form app UIs; external database connectors in v1.
- **Why build it:** The spreadsheet is the most-used operational tool in every small firm, and it is the main office-suite gap in BigBlueBam. Today teams paste exports from their tools into Google Sheets, so the numbers are wrong by Tuesday and the sheet shows rows some viewers should never see. Retool and Airtable fix staleness only with a builder plus connectors. Brick's cells are live and its agent columns replace hours of copy-paste triage. Axis: **trust** (permission-correct live data for each viewer) plus **integration** (no connectors and no export/import loop, because the suite's MCP catalog is the data layer).
- **Reuses:** `@bigbluebam/structured-data` (Yjs, codecs, shape inference), the MCP tool catalog plus internal `/tools/call`, Basis certified metrics, the `can_access` visibility preflight, Bolt events (recompute triggers), `agent_proposals` (staged writes), `agent_policies`, @bigbluebam/permissions, Bin (file import), auth/RLS.
- **Closest existing app:** Bin. Bin's structured-data editor edits stored data files. Brick is a computational sheet (formulas, live suite queries, agent columns, action cells), which puts it in the office/productivity whitespace. Bench and Basis chart and govern metrics; Brick is where people work with rows.
- **Lens fit:** the tool operators actually run the business in, wired into the platform's tool catalog instead of exported from it.

*Why this one (Seat E):* I chose Brick over Butler because it is the only spreadsheet entry and the spreadsheet is a core office tool every firm needs. In the debate, C and G backed it, F offered to merge Bespoke into it, and nobody opposed it. Butler drew a near-duplicate objection (Helpdesk pointed inward, plus overlap with the access cluster).

**SUBMISSION - Seat F:**

### Bulletin: customer-facing change communication, closed-loop
- **Names:** Bulletin · Broadcast · Herald
- **One-line pitch:** Whenever something your customers rely on changes (a feature ships, a service goes down, a price or policy moves), Bulletin tells exactly the right people in the right words, fixes the help articles that just went stale, and lets the customers who asked for it know it was delivered.
- **Description:** Bulletin watches the suite for *customer-affecting changes*. Sources: completed Bam work and merged PRs (via Bam's existing GitHub integration), Blip watch alerts (incidents), Bill price/plan changes, and Beacon policy/terms revisions. An agent clusters the signals into change events, classifies each item's audience impact, and drafts tiered artifacts: a public changelog / "what's new" feed, a hosted status page with incident updates, an internal support/sales brief, and line-level edit proposals for every Beacon and Helpdesk KB article the change made wrong. The core mechanism is the closed loop. It traces Helpdesk tickets, Bond deals and feature requests through `entity_links` to the change and drafts a notice only to the customers who asked for it or are affected. Every artifact passes the `agent_proposals` queue before it publishes.
- **Scope (in):** change ingest from Bam/GitHub, Blip, Bill, and Beacon; clustering and audience-impact classification; changelog with embeddable widget, and status page with incident timeline; internal brief; stale-doc detection with proposed edits; requester and affected-account matching with targeted notices; HITL publish; Bolt events `change.published` and `incident.updated`; MCP tools `bulletin_draft_change`, `bulletin_stale_docs`, `bulletin_incident_update`, `bulletin_who_to_tell`.
- **Scope (out):** public social and press (it emits `change.published` for Bullhorn to consume); bulk email delivery (sent via Blast); all-hands internal announcements (Bugle); uptime probing (Blip owns the signal); feature flags and deployment.
- **Why build it:** Every company that has customers changes things and communicates it badly. Help articles stay wrong for months, outages get a vague tweet, and the customer who asked for a fix is never told it shipped. LaunchNotes, Beamer, and Statuspage are three separate editors, and none of them can see tickets, CRM, KB, and work items together, so none can close the loop. The axis is **closed-loop customer communication** (who asked, who is affected, which doc is now wrong) plus **speed**, from cross-app data only a single-tenant suite holds.
- **Reuses:** Bam tasks/sprints and the GitHub integration, Blip watches, Bill plans, Beacon and Helpdesk KB, Helpdesk tickets, Bond contacts/deals, `entity_links`, `can_access` preflight on every cited entity, Blast (delivery), `agent_proposals`, Bolt, @bigbluebam/permissions, RLS.
- **Closest existing app:** Blast. Blast sends campaigns a human composes to a list. Bulletin *derives* change messaging from what actually changed, selects recipients by evidence of request or impact, and repairs stale docs. That is product and service communication, not an email tool, and it is neither social publishing (Bullhorn) nor internal announcements (Bugle).
- **Lens fit:** It turns the engineering and operations change stream into customer communication that stays accurate.

*Why this one (Seat F):* It is my only uncontested singleton. My other four fold into clusters that already have owners (GRC to Baseline, access to Badge, learning to Boost/Brevet/Bloom, internal tools to Brick). I have re-aimed it from release notes to all customer-affecting changes, which answers the "software-only near-vertical" objection raised in Phase 2.

**SUBMISSION - Seat G:**

### Bullhorn: brand-governed social and PR desk that drafts from what the business actually did
- **Names:** Bullhorn · Byline · Broadside
- **One-line pitch:** Your company's real wins, like releases, deals, events and hires, become on-brand social posts and press pitches whose every claim is checked against live proof, with a holding statement ready before a crisis lands. You approve; you don't write.
- **Description:** An agent subscribes to Bolt events across the suite (a Bam release, a Bond win with publicity consent, a Book webinar, a Bearing milestone, a Blip outage) and turns each one into a story candidate. It writes channel-native social variants and, when the story is newsworthy enough, a press release plus personalized pitches to journalists, scored by how relevant each journalist's recent coverage is. Every draft passes a **brand and claims gate** (my Blazon folded in as a core module). The brand policy covers voice, terminology, disclaimers and logo/palette vision checks. A claims register binds each public statement of fact ("40% faster", "trusted by Acme") to its proof (a Basis metric, a Bond consent flag, a Bin document) and invalidates the claim when that proof moves or the consent is revoked. Passing drafts land in `agent_proposals`. Replies and mentions are routed: complaints to Helpdesk, buying signals to Bond. Incident events trigger drafted holding statements for human sign-off. Nothing is published unattended.
- **Scope (in):** an event-to-story feed; social variants per channel (LinkedIn, X, Bluesky, Threads, Meta) with a schedule and publish worker; a message house and spokesperson registry; release and pitch drafts; a media list stored as Bond contacts with a press role; brand policy with version lineage plus the claims register with proof bindings and expiry; `brand_check` exposed as an MCP tool that Blast, Bay and any agent can call before sending; an approval queue; a mention inbox with AI routing; crisis drafts triggered by Bolt events; engagement metrics written to Bench; MCP tools `bullhorn_draft_from_entity`, `bullhorn_schedule`, `bullhorn_crisis_draft`, `brand_check`, `claim_verify`.
- **Scope (out):** paid ads and boosting; newswire distribution (export only); buying journalist databases; broad web listening; email sending (Blast); internal announcements; asset storage (Bin) and human creative review (Bay); generating images or video.
- **Why build it:** Small teams know they should post and pitch, and they don't. The bottleneck is knowing what to say and being sure it is safe to say, not scheduling. Buffer, Hootsuite and Sprout ($99 to $400 per seat per month) give you an empty calendar. Cision and Muck Rack ($7k to $20k+ a year) and Frontify or Acrolinx ($20k+) are priced for departments. The axis is **content supply plus trust**: the suite already knows every win and sees an outage first, and only the suite can tie a public claim to the live metric or consent that backs it. That matters more every month as agents start writing outbound content at machine speed.
- **Reuses:** Bolt (event ingest, plus `claim.expired` and `brand.violation` events), `agent_proposals`, Bin (assets, brand book), Bay (visual sign-off), Bond (consent, press contacts), Braid (who an engaging account is), Basis (proof metrics), Helpdesk and Blip (routing and crisis triggers), Beacon (facts), Bench, the worker, the internal llm-provider, `can_access`, permissions, the MCP register-tool pattern for the `brand_check` gate.
- **Closest existing app:** Blast. Blast sends owned email to a consented list. Bullhorn covers public social and earned media, with two-way conversations, brand and claims governance, and a crisis loop. It is a different channel, audience and risk profile, and Blast becomes one of the callers of Bullhorn's `brand_check`.
- **Lens fit:** This is the external marketing-comms, PR and brand function that large firms staff three teams for and small firms improvise.

*Why this one (Seat G):* Bullhorn is the agreed survivor of a three-seat cluster (A and C withdrew in its favor), so it carries the broadest support and the widest customer need. Folding Blazon's claims register into it as the brand gate gives it the innovation edge that a plain social scheduler would lack, without opening a second front for a merge negotiation.

## Phase 4 - Overlap resolution

### Screen against the existing suite

| Submission | Closest existing app | Judgement |
|---|---|---|
| Bevy (A) | Bam `/b3/people` | **Survives.** `/b3/people` is login/membership CRUD with no employment record, reporting lines, leave or policy decisions. HR core is census whitespace #1. |
| Baseline (B) | Bulwark | **Survives.** Bulwark's object is a clause owed to a counterparty; Baseline's is an internal control proven to an auditor. Compliance/GRC is whitespace. |
| Bellman (C) | Banter | **Survives.** Banter is many-to-many chat; Bellman is tracked one-to-many delivery with understanding checks and deadlines. Internal comms is whitespace, though it sits beside the dense chat category, which voters should weigh. |
| Brace (D) | Helpdesk | **Survives.** Helpdesk is an external, shared queue; Brace is internal confidential casework with conflict exclusion and statutory clocks. Health & safety / ER is whitespace. |
| Brick (E) | Bin (structured-data editor) | **Survives, flagged.** Bin already edits tabular files collaboratively on the same `@bigbluebam/structured-data` package, so the grid itself is not new. The formula engine, live `=SUITE()` cells, agent columns and action cells are the new category (computational spreadsheet). Office/productivity is partial whitespace. |
| Bulletin (F) | Blast / Helpdesk | **Survives.** Blast sends composed campaigns; Bulletin derives change notices and selects recipients by evidence, plus status page and stale-doc repair. Customer communications sits next to the covered email category. |
| Bullhorn (G) | Blast | **Survives.** Public social, earned media and brand/claims governance are whitespace; Blast is owned email only. |

No submission is cut for near-duplication of an existing app.

### Pairwise screen between submissions

- **Bellman (C) vs Bulletin (F):** both turn one change into per-audience drafts. Judged **distinct**: Bellman's audience is employees, its success metric is verified understanding and acknowledgement, and its channels are Banter/email/digest; Bulletin's audience is customers, selected by evidence of request or impact, with a public changelog and status page. The only shared piece is Bulletin's "internal support/sales brief", which overlaps Bellman's internal-briefing trigger. Boundary recorded: if both were built, Bulletin's internal brief would be delivered through Bellman. Not enough overlap to force a merge.
- **Bulletin (F) vs Bullhorn (G):** both consume release/incident events and write outward. Judged **distinct**: Bullhorn owns public social, press and brand/claims governance; Bulletin owns the changelog, status page, stale-doc repair and targeted notices to specific customers. Both seats already drew this boundary in debate (Bulletin emits `change.published` for Bullhorn).
- **Bevy (A) vs Brace (D):** both are people apps. Distinct: Bevy is the employment record and routine decisions; Brace is confidential casework. Brace's conflict-of-interest exclusion would key off Bevy's reporting lines (an adjacency, not an overlap).
- **Baseline (B) vs Bevy (A), Brace (D), Bellman (C):** distinct; each of those three is a potential evidence source for Baseline, not a competitor.
- **Brick (E):** no overlap with any other submission.

No perfect overlaps and no very-similar pairs, so no merge negotiations were opened. **Seven apps advance to the final vote.**

Orchestrator note: the debate round did the collapsing that Phase 4 would otherwise have done. Each of the three five-seat clusters produced at most one submission (GRC to Baseline; joiner/mover/leaver and learning produced none, because their seats submitted uncontested singletons instead), and social publishing produced exactly one (Bullhorn). The cost of that is that joiner/mover/leaver (Badge/Baton) and learning (Boost/Bloom), both strong essentials, did not reach the slate at all; they remain recorded in Phase 2 as candidates for a future session.

## Phase 5 - Voting

All seven seats scored every finalist 1-5 and abstained on their own. Each finalist was tagged with its census category: Bevy (people/HR core, whitespace), Baseline (compliance & GRC, whitespace), Bellman (internal comms, whitespace next to dense chat), Brace (health & safety / ER, whitespace), Brick (spreadsheet, partial whitespace), Bulletin (customer change comms, next to covered), Bullhorn (social/PR/brand, whitespace). Coverage contribution was an explicit scoring dimension.

### Round 1 matrix (seat x app)

| Seat | Bevy | Baseline | Bellman | Brace | Brick | Bulletin | Bullhorn |
|---|---|---|---|---|---|---|---|
| A | abstain | 5 | 3 | 4 | 3 | 2 | 4 |
| B | 4 | abstain | 3 | 5 | 3 | 2 | 4 |
| C | 5 | 5 | abstain | 4 | 3 | 3 | 4 |
| D | 4 | 5 | 4 | abstain | 4 | 3 | 4 |
| E | 5 | 4 | 3 | 4 | abstain | 3 | 4 |
| F | 5 | 5 | 3 | 4 | 3 | abstain | 4 |
| G | 5 | 5 | 3 | 4 | 4 | 3 | abstain |
| **Total** | **28** | **29** | **19** | **25** | **20** | **16** | **24** |

Every app received exactly six scores, so totals are directly comparable. No tie at the top; one round decided it.

### Scorecard reasons (verbatim)

**Seat A:** Baseline 5: "It opens compliance and GRC, an essential the suite has no app for. The evidence comes from the suite's own records, and the ranked list of controls nothing can prove is something a tool that collects screenshots through connectors cannot match. It has a clear cost wedge against Vanta and Drata." Brace 4: "It opens health and safety plus employee relations, which every employer is legally obliged to handle. The statutory clocks and cross-case pattern detection are AI-native. I marked it down because an office-only small firm opens these cases rarely, and an AI deciding whether an injury is recordable carries liability that needs firm human gating." Bullhorn 4: "It opens the advertising, social and brand whitespace. Checking every public claim against live proof and consent is a trust wedge that Buffer and Hootsuite cannot copy. I marked it down because the scope stretches across social, press and brand governance at once." Brick 3: "The spreadsheet is a real office-suite gap, and cells that run live, permission-correct queries are clever. Bin's structured-data editor already covers part of the surface, Google Sheets is deeply entrenched, and the internal-tools layer makes the scope sprawl." Bellman 3: "Checking that people actually understood an announcement is a novel mechanism. Internal communications is a thin need at 2-50 people, where Banter plus a required acknowledgement covers most of it, and the app sits right next to the dense chat category." Bulletin 2: "Repairing help articles that a change made stale and closing the loop with customers who asked for a fix are good ideas. It thickens areas the suite already covers (Blast, Helpdesk, Beacon) rather than opening an essential, and changelog and status pages lean toward software companies."

**Seat B:** Bevy 4: "It opens the top whitespace essential (people/HR core) and is the record every other lifecycle app keys off. Agent-executed requests and modeling AI agents as part of the workforce make it more than a BambooHR clone, though the time-off and org-chart core still leans toward CRUD." Bellman 3: "Checking that people understood an announcement, not just opened it, and repairing confusion automatically is truly AI-native. But internal comms sits next to the dense Banter/Bureau category and is a lower-urgency need for 2-50 person firms." Brace 5: "Every employer has these legal duties, and it is uncontested health-and-safety/ER whitespace. Statutory clocks and cross-case pattern detection make the AI's value measurable. The wedge is real: small firms miss reporting windows in email, and the EHS/ER tools are priced for enterprises." Brick 3: "Live, per-viewer-scoped suite cells and agent columns are a real trust wedge no spreadsheet vendor has. It only partly opens whitespace, because it sits on the same `@bigbluebam/structured-data` package as Bin's existing collaborative editor, and a spreadsheet is the hardest category to win against free incumbents." Bulletin 2: "The 'you asked, we shipped' loop is clever, but it mainly serves software companies (close to a vertical). It also thickens the covered email/Helpdesk area rather than opening an essential." Bullhorn 4: "It opens the advertising/social/brand whitespace. Drafting from internal events fixes the real bottleneck (knowing what to say), and routing replies into Helpdesk and Bond is something standalone schedulers cannot do. The risk is its dependence on social-network APIs."

**Seat C:** Bevy 5: "It opens the most essential whitespace on the list (HR core). It is AI-native because routine HR decisions are made within policy and each change is propagated across all 24 apps. Its record covering both staff and AI agents has no counterpart anywhere." Baseline 5: "It has the clearest wedge on cost and evidence trust against Vanta and Drata, because the suite itself is the evidence source. The ranked 'unprovable controls' list is output that no screenshot-based tool can produce." Brace 4: "It is a real legal-duty essential that every employer has, and it opens new whitespace. The statutory clocks and the conflict-of-interest exclusion are a strong wedge. It loses a point because it is used episodically, so value at 2-50 seats is lumpy, and because it carries high classification and legal-liability risk." Brick 3: "Live permission-checked cells plus agent columns is an innovative office primitive. Coverage is only partial because it shares a package and a surface with Bin's structured-data editor, and it is in Retool/Airtable territory." Bulletin 3: "It closes a sharp loop between tickets, the KB and requesters. However, it thickens covered ground (Blast, Helpdesk, the Beacon KB) rather than opening an essential category." Bullhorn 4: "It opens the advertising/social/brand whitespace with a real content-supply wedge, and it checks every claim against live proof. It sits close to Blast's marketing buyer and leans on third-party network APIs."

**Seat D:** Bevy 4: "It opens HR core, the top whitespace essential, and it is the record the other people apps key off. Change-impact compilation and agent-workforce governance are genuinely new, but auto-deciding leave requests is a thin AI wedge, and an HRIS risks being judged a BambooHR clone if the propagation layer slips." Baseline 5: "Compliance and GRC is a staffed department in large firms and a panic spreadsheet in small ones. Its evidence comes from the system of record itself rather than from per-tool connectors, which beats Vanta and Drata on cost and trust. The ranked 'unprovable' list is something no competitor produces." Bellman 4: "Checking that a message was understood, then auto-drafting clarifications, is a real AI-native loop that no SMB-priced tool offers, and it doubles as the attestation rail for the GRC and training apps. Internal comms sits next to the dense chat category, which lowers its coverage score." Brick 4: "Live `=SUITE()` cells filtered per viewer, agent columns and action cells make a genuinely new kind of spreadsheet, and the spreadsheet is a core office tool. It is partial whitespace only, because Bin already ships a collaborative grid on the same package, so the coverage gain is smaller than the pitch suggests." Bulletin 3: "The closed loop of telling the customers who asked and repairing the help articles the change made wrong is clever. But it thickens the covered email/Helpdesk area, skews toward software companies, and is the least essential slot on the slate." Bullhorn 4: "Social, PR and brand is census whitespace that small firms improvise. The claims register that ties each public claim to live proof is the innovative core, beyond a scheduler. It is broad for one v1, since it bundles three products, which adds execution risk."

**Seat E:** Bevy 5: "It opens HR core, the first essential on the whitespace list. Agents decide and apply routine HR changes, and treating AI agents as accountable workforce members has no comparable product. Every other people app needs its person, manager and status record." Baseline 4: "GRC is a high-value whitespace and the 'unprovable controls' list is a real wedge. Its core loop is still Vanta's continuous monitoring, and much SOC 2 evidence (cloud, MDM, HR systems) lives outside the suite, so its native-evidence advantage covers only part of the audit." Bellman 3: "Checking understanding instead of counting opens is a real step up, and the signed acknowledgment records would feed compliance. It is a narrower job that sits beside the dense chat category, so it adds less coverage." Brace 4: "It covers a legally required function that SMBs handle badly in email, and the statutory clocks plus per-case conflict exclusion are hard to fake with a ticket queue. Cases are infrequent in a 2-50 person firm, and an AI recordability call carries liability that keeps the product heavily human-gated." Bulletin 3: "The closed loop (requester matching plus stale-doc repair) is clever. The category is next to covered ones (Blast, Helpdesk), the changelog and status page are well-served product categories, and fit is strongest for software firms." Bullhorn 4: "Marketing, social and brand is an essential whitespace. Its strongest idea is the claims register that ties every public claim to live proof, and drafting from suite events solves content supply. It still depends on platform publishing APIs, and the market is crowded."

**Seat F:** Bevy 5: "It opens the top-ranked whitespace (HR core) and is the record that every people-lifecycle app keys off. Modelling AI agents as workforce members is something no HRIS does, and the existing `users.kind` / `agent_runners` / `agent_policies` give it real platform reuse." Baseline 5: "GRC is a whitespace essential that small firms hit at their first enterprise deal. Immutable, query-cited evidence from the system of record beats Vanta/Drata on cost and trust, and the 'unprovable controls first' ranking gives a team without a compliance hire a clear order of work." Bellman 3: "Proving that people understood a message is a real step beyond open rates. But it is the narrowest essential on the slate, it sits right next to the dense chat category (Banter), and for a 2-50 person firm it reads more like a strong feature than a department-replacing app." Brace 4: "It covers whitespace (health and safety plus employee relations) where missed legal clocks carry real liability, and its per-case confidentiality and conflict exclusion are well designed. Cases are infrequent at 2-50 people, so the usage pull is lower than an always-on app." Brick 3: "The spreadsheet is the biggest office gap, and permission-correct live cells are a real wedge. But it partly overlaps Bin's structured-data editor on the same package, so its coverage contribution is diluted, and 'spreadsheet' invites clone comparisons." Bullhorn 4: "Social, PR and brand is a clear whitespace, and checking every public claim against live proof is a new mechanism that matters as agents write outbound content. It still competes in a crowded scheduler/PR-tool market where the drafting half is easy to copy."

**Seat G:** Bevy 5: "It opens the most essential whitespace (HR core) that the suite lacks. Change-impact compilation and agent-workforce governance make it AI-native rather than BambooHR CRUD, and it is the record that the other people apps depend on." Baseline 5: "It is a horizontal essential with a clear cost wedge against Vanta and Drata. Evidence comes from the system of record rather than through connectors, and its 'unprovable controls' list is something no screenshot collector can produce." Bellman 3: "Checking understanding instead of opens is a real idea. But in a 2-50 person firm most announcements already reach everyone through Banter, so the need is weaker and it thickens an area next to chat rather than opening new ground." Brace 4: "It covers a legally mandated whitespace (health and safety, employee relations) and wins on trust through cited statutory clocks and conflict exclusion. It loses a point because small firms rarely use it, which makes adoption episodic." Brick 4: "Live cells scoped to each viewer and agent columns are new, and the spreadsheet is an office essential. It loses a point on coverage because it partly overlaps Bin's structured-data editor and has to compete with entrenched Google Sheets habits." Bulletin 3: "The closed loop of 'who asked, who is affected, and which doc is now wrong' is a real wedge. But it sits next to covered ground (Blast, Helpdesk), leans toward software companies, and splits customer communication three ways with Bellman and Bullhorn."

### Result

**Winner: Seat B's compliance & GRC app (29 points).** Runner-up: Bevy, agent-run HR core (28). Then Brace 25, Bullhorn 24, Brick 20, Bellman 19, Bulletin 16.

The only reservation any voter recorded against the winner (Seat E, 4 points) is that much SOC 2 evidence (cloud infrastructure, device management, HR systems) lives outside the suite, so native evidence covers only part of an audit. The spec must answer that directly: an uploaded/manual-evidence path with the same immutability and citation rules, and an honest coverage graph that shows which controls depend on it.

### Naming decision (orchestrator)

The winning seat's first-choice name, "Baseline", collides with Bursar's core vocabulary ("frozen baseline", `bursar_baseline_items`, `BURSAR_BASELINE_IMMUTABLE`) and with 63 other source files, which would make MCP tool names, help docs and search ambiguous across two money/compliance-adjacent apps. Its third-choice name, **Bastion**, has zero hits in the repo, is in the B-family, and is the name four of the five seats independently gave this same app in Phase 1. The app is therefore named **Bastion** (id `bastion`). Seat B's mechanisms (evidence coverage graph, "unprovable" ranking, cited immutable snapshots, questionnaire autofill) are carried into the spec unchanged.

## Phase 6 - Spec hardening

The `brainstorm-spec-writer` drafted `2026_11_25_20_03_APP_DESIGN_bastion.md` (commit 5f95f37c): 16 sections, 28 tables, 91 REST endpoints (30 with MCP tools, 61 deliberate skips), 22 MCP tools, 18 Bolt events, 47 permission actions, 14 worker jobs, migrations 0260-0266, internal port 4024. Grounding the draft in the code changed the design in several places: the platform has no MFA (so the MFA control is always manual evidence), the GitHub webhook records no reviews and drops PRs that mention no task (so review-before-merge needs an additive core-api change), Beacon has no read acknowledgements (Bastion keeps its own version-pinned attestations), and backups are platform-wide.

### Round 1

Five adversaries reviewed the draft in parallel. Full findings: `2026_11_25_20_03_SPEC_REVIEW_bastion_round1.md`.

| Focus | Blocker | Major | Minor |
|---|---|---|---|
| Design | 1 | 7 | 1 |
| Stability | 2 | 6 | 1 |
| Security | 2 | 7 | 1 |
| Best practices | 2 | 5 | 2 |
| Infrastructure | 2 | 6 | 1 |
| **Total** | **9** | **31** | **6** |

The blockers: the flagship "can't prove yet" ranking had unmapped cases and would open on 60+ setup rows (design); evaluator slice, probe, engine and lease timeouts contradict each other, and nothing marks evidence stale, so infrastructure blips would read as compliance drift (stability); any signed-in user can download evidence through the shared `/files/*` route, and probes would report false passes once RLS enforcement is switched on (security); every Bastion Bolt event would be silently rejected at ingest, and registering on the Launchpad at M0 keeps CI red for nine milestones (best practices); Railway never gives existing services the new env vars, and the shared-bucket exposure again (infrastructure).

The review also surfaced seven pre-existing platform defects, each confirmed against the code and filed: #121 (Bursar's SPA connects to a WebSocket bursar-api never serves), #122 (Bay guest tokens stored in plaintext), #123 (`GET /files/*` serves any object in the shared bucket to any signed-in user), #124 (the Bolt source list is encoded in four places and `'bursar'` is missing from the ingest enum, so Bursar's events are silently dropped), #125 (`publishBoltEvent` has no timeout), #126 (Railway `syncNew` never adds new env vars to existing services), #127 (the index.html no-cache rule omits five apps).

Orchestrator direction for the fold-in: accept the scope trim (public trust page and custom-document frameworks move to v1.1), prefer org-level controls with a framework crosswalk over per-framework copies, register on the Launchpad only in the final milestone, and schedule platform fixes for #123, #124, #125, #126 and #127 as "fix the fact" changes in early milestones rather than Bastion-local workarounds.

**Round 1 dispositions:** 43 accepted, 3 adapted, 0 rejected (per-finding lines in the spec's section 16). The adaptations: personal data moved to a separate editable table with only a keyed hash in the ledger, and auditor access logs pruned only through one guarded database function (security-9, best-practices-6); per-org LLM fairness through Redis semaphores in bastion-api rather than BullMQ grouping, which is a paid BullMQ Pro feature (infrastructure-8). After the fold-in the spec has 33 tables, 97 REST endpoints (34 with tools), 24 MCP tools, 48 permission actions, 23 Bolt events through an outbox, 19 worker jobs, migrations 0260-0268 plus the M10 permission files, and twelve milestones (M0 platform prerequisites through M11 Launchpad registration). Probes now run as reviewed database functions so RLS enforcement cannot hide rows from them.

### Round 2

The same five reviewers re-reviewed the revision, first checking each of their own round-1 findings against the text (not the changelog), then hunting for new problems in what the fold-in added. Full findings: `2026_11_25_20_03_SPEC_REVIEW_bastion_round2.md`.

Round-1 verification: 40 of 46 confirmed resolved in the text. Six were only partly resolved and carried forward: security-4 (proposal re-verification read a column that does not exist), best-practices-1 and -5, and infrastructure-2, -7, -8.

| Focus | Blocker | Major | Minor |
|---|---|---|---|
| Design | 0 | 7 | 4 |
| Stability | 0 | 7 | 7 |
| Security | 1 | 2 | 10 |
| Best practices | 1 | 4 | 5 |
| Infrastructure | 1 | 6 | 5 |
| **Total** | **3** | **26** | **31** |

The blockers: proposal decisions cannot be verified as human because `agent_proposals` records no decider (security; platform gap filed as #128); publishing only through the outbox hides every Bastion event from the Bolt catalog check (best practices); the runtime-resolved nginx block passes through the Railway config generator unchanged, so every Bastion API call would 502 in production (infrastructure). Three reviewers independently found that restore detection compared the ledger against seals stored in the same database, so it could never fire. Two found that accepted exceptions were being counted as proof.

Orchestrator direction for the fold-in: fix #128 at the platform level in M0 and also decide Bastion's status-changing proposals inside Bastion; give exceptions a distinct effective status that never counts as proven; store seals outside the database and never mark a restore benign automatically; send the off-site evidence mirror to a separately configured destination.

**Round 2 dispositions:** of the 29 blockers and majors, 26 accepted and 3 adapted, none rejected; 29 minors folded in and 2 adapted, none deferred. The adaptations: secret hints marked stable with `<generate>` and a what-breaks note, compose uses `:-` and bastion-api refuses to start with a plain message (best-practices-3); #126 variable propagation is opt-in per hint and applied to every app's internal URL hints, never overwriting a set value (N6); the LLM permits copy the proxy's leased, fail-open pattern, and the throughput is restated at about 9 to 18 calls per minute (N7). The access-log purge guard was reworded: every service connects as the same database role, so "only the definer function can purge" was unenforceable; the two-year age rule is the stated guard, with a test. After round 2 the spec has 35 tables, 106 REST endpoints (34 with tools), 24 MCP tools, 50 permission actions, 24 Bolt events, 19 jobs, migrations 0260-0269 plus the M10 permission files. Milestone changes: M0 also carries #128, the Railway generator fix for runtime-resolved upstreams, the stable-secret class and the enum-vs-`BOLT_SOURCES` CI check; Bolt events register at M4 with the outbox; tool registration, docs catalog, published counts and the Launchpad entry ship together at M11.

<!-- ROUND 3 -->

## Outcome

_(pending)_
