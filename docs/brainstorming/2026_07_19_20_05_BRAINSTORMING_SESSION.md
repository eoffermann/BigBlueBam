# Suite Brainstorming Session - 2026_07_19_20_05

**Purpose:** select the next app BigBlueBam should build, then produce a hardened,
build-ready design specification for it.

**Protocol:** seven ideator seats x five proposals each, one debate round, one
submission each, overlap resolution (near-duplication screen + merge negotiations),
a no-self-vote final ballot, then a spec drafted and hardened by five adversarial
reviewers.

---

## Coverage census

Roster read from `LAUNCHPAD_CATALOG` in `apps/api/src/routes/system-settings.routes.ts`
(23 apps) plus the app inventory in `CLAUDE.md`. The most recent cycle shipped **Burn**
(scope and margin), which is on the Launchpad and therefore counts as covered.

### Category map

| Category | App(s) | Density |
| --- | --- | --- |
| Analytics / metrics | Bench, Basis | **dense** |
| Contracts / scope / margin | Bulwark, Burn | **dense** |
| Visual collaboration | Board, Blueprint | **dense** |
| Knowledge / docs / chat cluster | Beacon, Brief, Banter | **dense** |
| Project / task management | Bam | covered |
| CRM | Bond | covered |
| Email / marketing | Blast | covered |
| Billing / invoicing | Bill | covered |
| Forms / surveys | Blank | covered |
| Scheduling / calendar | Book | covered |
| Workflow automation | Bolt | covered |
| Goals / OKRs | Bearing | covered |
| DAM / object storage | Bin | covered |
| Media review / approval | Bay | covered |
| Observability / telemetry | Blip | covered |
| Identity resolution / CDP | Braid | covered |
| Virtual office / presence | Bureau | covered |
| Customer support | Helpdesk | covered |

### Whitespace list

Categories a small-to-medium services firm genuinely needs that the suite has little
or nothing for today:

- **HR / people-ops** - onboarding and offboarding, PTO and leave, performance reviews, org chart
- **Recruiting / ATS** - req pipeline, candidate tracking, interview scorecards
- **Learning / enablement** - training paths, certifications, competency tracking
- **Resource planning / staffing** - who is allocated to what, utilization, bench management (note: "Bench" the app is analytics, not staffing)
- **Procurement / vendor spend** - purchase requests, vendor catalog, spend approval
- **IT / physical asset management** - device inventory, assignment, lifecycle, licenses
- **GRC / security compliance** - SOC 2 and ISO control evidence, risk register, security questionnaires (Bulwark is contract obligations, a different object)
- **Incident management / on-call** - paging, incident command, postmortems (Blip ingests telemetry but runs no incident lifecycle)
- **Customer feedback / voice-of-customer** - NPS and CSAT programs, feedback taxonomy (Blank is a generic form builder, not a VoC program)
- **Product management / roadmap** - feature request intake, prioritization, release notes
- **E-signature** - execution of the documents Bulwark and Burn later monitor
- **Expense and travel** - only partially touched by Bill
- **Community / external forum** - Banter is internal team chat
- **Legal matter management**
- **Partner / affiliate management**
- **Localization / translation ops**

### Per-session steer handed to every seat

> Prefer the whitespace categories. A near-duplicate of an existing app, or a third
> app in an already-dense category, is disfavored by construction. The currently
> **dense** categories are: **analytics/metrics** (Bench, Basis), **contracts/scope/
> margin** (Bulwark, Burn), **visual collaboration** (Board, Blueprint), and the
> **knowledge/docs/chat** cluster (Beacon, Brief, Banter). Do not pile onto these.
> At least three of your five proposals must land in a whitespace category, and every
> proposal must name its closest existing app and argue why it is a different
> category rather than a better version of that app.

### Seat lenses

| Seat | Lens |
| --- | --- |
| A | AI-native automation and autonomous agent workflows |
| B | Data, intelligence and analytics |
| C | Communication, collaboration and community |
| D | A vertical / industry wedge (under-served vertical) |
| E | Operator / developer experience and platform tooling |
| F | Engineering and software development |
| G | Creative and marketing |

---

## Phase 1 - Initial proposals

Seven seats returned five proposals each (35 total). The orchestrator's immediate
observation: **massive convergence on incident management** - five of the seven seats
(A, B, C, E, F) independently proposed an incident-command app under the names Blaze,
Brace, or Brigade, with no coordination between them. Three further clusters formed on
GRC / compliance evidence (Bastion: seats A, E, F), voice-of-customer (Bellwether: seats
B, C, G), and HR joiner/mover/leaver lifecycle (Berth / Badge: seats A, C, E).

Distinctive non-converged ideas worth protecting through the debate: Seat A's Bridle
(agent workforce console), Seat E's Bunker (agent rehearsal sandbox), Seat D's entire
field-services vertical, and Seat G's Burnish (brand governance as a callable gate),
Babel (localization ops), and Bounty (partner/affiliate attribution).

### Cluster map after Phase 1

| Cluster | Seats proposing | Names offered |
| --- | --- | --- |
| Incident command / on-call / postmortems | A, B, C, E, F | Blaze, Brace, Brigade, Bell, Bellow |
| GRC / compliance evidence + questionnaires | A, E, F | Bastion, Buckler, Attest |
| Voice-of-customer / feedback mining | B, C, G | Bellwether, Barometer, Groundswell |
| HR lifecycle (joiner/mover/leaver) | A, C, E | Berth, Badge, Baton |
| Staffing / capacity / utilization | A, B, D | Ballast, Billet, Brigade |
| Product roadmap / demand intake | B, F | Bellwether, Beam |
| Learning / enablement | F, G | Boot, Belt |
| Vendor spend / procurement | B, E | Bursar, Ballast |
| Agent governance / rehearsal | A, E | Bridle, Bunker |
| Field-services vertical (unique) | D | Badge, Brigade, Brace, Bid, Barrow |
| Brand governance (unique) | G | Burnish |
| Localization ops (unique) | G | Babel |
| Partner / affiliate (unique) | G | Bounty |
| Client portal (unique) | C | Bridge |
| Release risk (unique) | F | Brink |
| External community forum (unique) | C | Bazaar |

### Seat A - AI-native automation and autonomous agent workflows

Proposed: **Blaze** (autonomous first responder and incident command), **Bridle** (agent
workforce console - hire, scope, budget, evaluate and promote AI agents like staff),
**Berth** (joiner/mover/leaver executed by an agent, with exhaustive cross-app footprint
teardown), **Ballast** (continuous staffing and capacity agent with a nightly re-solve and
a "can we take this deal?" simulation), **Bastion** (continuous compliance evidence and
security-questionnaire agent).

Seat A's throughline: every proposal is an agent loop whose UI exists mainly to approve and
audit what the agent already concluded. Its strongest original framing was Bridle's axis of
"trust under nondeterminism" - the platform has 865 MCP tools and agent_policies, and today
nothing measures whether delegated authority is being used competently. Its Berth entry
argued the sharpest single wedge in the HR cluster: offboarding completeness, where the AI
advantage is exhaustive cross-app enumeration a human provably cannot do by hand.

### Seat B - Data, intelligence and analytics

Proposed: **Billet** (skill graph inferred from delivered work, plus a forward allocation
solver), **Blaze** (alert-storm correlation into one narrated incident with a self-writing
postmortem), **Bellwether** (mines customer signal into a ranked deduped demand list with
dollars attached), **Bolster** (performance reviews assembled from shipped artifacts with a
bias check), **Bursar** (vendor spend graph with duplicate/underuse/price-drift detection).

Seat B correctly applied its lens as mechanism rather than subject, keeping clear of the
dense analytics category. Bursar was its sharpest whitespace entry: money-out vendor spend
is genuinely uncovered, and it deliberately hands clause extraction to Bulwark instead of
duplicating it.

### Seat C - Communication, collaboration and community

Proposed: **Brace** (comms-first AI incident commander that runs the war room and drafts
every stakeholder artifact), **Bazaar** (AI-seeded external community forum that survives
low volume), **Bellwether** (VoC program whose core is ask-timing plus a fatigue budget per
Braid golden profile), **Berth** (AI ramp choreography with ramp-stall detection from
observed participation), **Bridge** (per-client portal composed via can_access preflight
rather than authored).

Seat C reported 4 of 5 in whitespace and verified via repo grep that incident management and
VoC are genuinely uncovered - a repo-wide grep of every db/schema for
`nps|csat|survey|escalat|on_call|postmortem|incident` returned exactly one unrelated hit.
Its Bazaar entry is notable as the suite's first genuinely customer-facing front door.

### Seat D - Vertical wedge: licensed field-services and specialty-trade contractors

Chose the vertical of licensed field-services and specialty-trade contractors (20-200 people:
environmental/industrial testing, MEP and electrical, restoration, inspection, facilities
trades), on the argument that the suite already sells the office half of that business (Bond,
Book, Bill, Burn, Bay, Bin) and owns nothing of the field half.

Proposed: **Badge** (jurisdictional credential eligibility engine that blocks a dispatch when
a worker is not licensed for that scope in that jurisdiction), **Brigade** (constraint solver
that continuously re-solves crew dispatch on disruption with a dollar delta per repair
option), **Brace** (voice/photo near-miss intake with an OSHA-300 recordability classifier and
leading-indicator clustering), **Bid** (subcontractor bid leveling whose product is the
exclusion diff - what each bidder quietly left out), **Barrow** (photo-based tool and
equipment custody with usage-based maintenance prediction and idle-cost detection).

Seat D was the only seat to open a genuinely physical-world category. Its grep evidence: no
domain code for credential/dispatch/crew/equipment/work_order/purchase_order exists anywhere
in apps/.

### Seat E - Operator / developer experience and platform tooling

Proposed: **Brigade** (incident command and postmortem loop whose closed loop turns each
accepted postmortem action item into a Bam task plus a proposed Blip watch), **Bastion**
(continuous control evidence and security questionnaires), **Ballast** (asset, license and
estate reconciliation - the product is the mismatch between what you pay for and what you
own), **Badge** (joiner/mover/leaver with AI-derived role templates from observed permission
usage and a completeness proof on departure), **Bunker** (agent rehearsal sandbox: fork the
org into an RLS-isolated shadow with egress hard-stubbed, replay a candidate change, and
render a semantic diff plus an AI risk narrative).

Bunker was the session's most structurally original idea: it converts an unbounded trust
question into a bounded reviewable diff, which is arguably the precondition for the rest of
the suite's agent features shipping.

### Seat F - Engineering and software development

Proposed: **Blaze** (incident command with reasoned on-call routing by who most recently
touched the implicated surface), **Beam** (evidence-backed roadmap and feature-request
intake priced via Braid + Bill + Bond), **Boot** (codebase-aware onboarding that generates
scenario assessments from real past incidents and detects lesson staleness against the live
schema), **Bastion** (continuous compliance evidence and questionnaire autofill), **Brink**
(change risk and release readiness scored against the org's own incident precedent corpus).

Seat F's Brink is a notable dependency case: its precedent corpus is prior incidents, which
only exists if an incident app is built first.

### Seat G - Creative and marketing

Proposed: **Bellwether** (VoC that mines the unsolicited corpus and only surveys when
genuinely uncertain), **Burnish** (machine-readable brand and legal constitution exposed as
a callable brand_check gate every agent must clear), **Babel** (continuous localization ops
driven by Bolt change events with visual context frames), **Bounty** (partner and affiliate
management with AI influence attribution replacing last-click), **Belt** (learning that
synthesizes units from the org's own artifacts and coaches at the moment work is rejected).

Seat G reported 5 of 5 in whitespace. Burnish is the only proposal in the entire session that
other apps' AI would be required to call, which makes it infrastructure rather than a
destination app - a distinctive argument that shaped the debate round.

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
