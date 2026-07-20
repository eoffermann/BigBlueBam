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

One full debate round was run. Every seat received the complete field of 35 proposals,
its own direct collisions named explicitly, and a pointed question tailored to the
weakest part of its own position.

### The headline result: the incident convergence collapsed under its own proposers

All seven seats were asked whether the five-way convergence on incident management was a
signal or a herd. **All seven answered herd.** More decisively, four of the five seats that
had proposed an incident app withdrew or folded it in the same reply:

- **Seat A** kept Blaze alive only as a merge anchor contributing one mechanism (the
  pre-page diagnostic agent) and stated plainly it would not spend its submission there.
- **Seat B** withdrew its Blaze outright: "I am not going to spend a slot defending the
  fifth-best copy of the most-copied idea in the room."
- **Seat C** de-escalated Brace to a contribution rather than a claim: "I have argued that
  the incident cluster's other mechanisms need volume an SMB does not generate, and I am
  not exempting myself."
- **Seat F** folded Blaze under Seat E's Brigade and kept only two mechanisms it wanted
  preserved.
- **Seat E** retained Brigade in its block but stated explicitly that it was not its
  selection.

The arguments that produced this, which are worth preserving because they are a critique
of this session's own method:

**Seat D identified an orchestration flaw.** The coverage census handed every seat the same
list and named incident management as whitespace. Five seats reaching for the most legible
item on a shared prompt is *correlated sampling, not corroboration*. In Seat D's framing,
"genuine convergence would be five seats landing on something the census did not name."
This critique is accepted and recorded as a real defect in the Setup step.

**Seat C supplied the disqualifying mechanism argument.** Every AI mechanism the five seats
proposed requires incident volume a 2-50 person team does not generate: recurrence
clustering needs repeat incidents, precedent scoring needs a corpus, responder ranking needs
a surface-touch history. A twelve-person agency produces roughly six incidents a year. Seat
C then inverted the test: Bazaar's mechanism gets *more* valuable as volume falls, because
the failure mode AI fixes there is silence. That inversion became the round's most-cited
argument.

**Seats B, E, F, and G converged on the same structural read.** Each seat's differentiator
was a different primitive the suite already ships (A: diagnosis, B: correlation, C: comms,
E: the closed loop, F: routing). Five people describing one product, each claiming a
distinct core, is the signature of one obvious idea rather than five good ones. Seat G added
an ICP argument: an incident commander role, an on-call rotation, and a blameless postmortem
ritual are artifacts of orgs with a dedicated SRE function, which begins around 150
engineers.

The seats' own recommendation was that exactly one incident app survive, built on the only
two mechanisms a standalone incumbent structurally cannot copy: Seat E's closed loop from
accepted postmortem action item to a proposed Blip watch, and Seat F's responder ranking
from the audit log of the thing that broke. In the event, no seat submitted one.

### Second-order consolidations

- **Bastion (3 seats) consolidated to one and then vanished.** Seats A and F both withdrew
  and conceded to Seat E, each naming the other's framing as sharper than its own. Seat E
  then did not submit it either.
- **The JML/HR cluster (3 seats) merged.** Seats A and E combined Berth and Badge; Seat C
  conceded the access-lifecycle half and narrowed to ramp, and Seat E agreed with Seat C
  that access lifecycle and human ramp are different categories that should not be fused.
- **The Bellwether cluster (4 seats, counting Seat F's Beam) consolidated without a fight.**
  Seats F and G both conceded the intake and clustering half to Seat B. Seat C's per-golden-
  profile fatigue budget was adopted by both rivals and named the best single mechanism in
  the cluster. Seat F retained only the post-rejection half (reopening conditions).
- **The capacity-solver cluster (3 seats) dissolved.** Seat D withdrew to credentialed field
  dispatch; Seats A and B aligned on Seat B's inferred-skill-graph-from-delivered-work as
  the supply model and Seat A's deal-intake simulation as the demand side.
- **Procurement consolidated to two seats.** Seat E conceded Ballast to Seat B's Bursar and
  withdrew it, explicitly to avoid splitting the category three ways.

### Two seats materially improved their own proposals under pressure

**Seat E killed its own riskiest design before adversarial review could.** Asked whether
Bunker was buildable in one cycle, it answered that the shadow-org fork was the wrong v1
and named the failure modes itself: pseudonymization cannot preserve referential integrity
across 38-plus schema modules; a faithful fork needs Bin object bytes or every attachment
flow diverges; partial-provision cleanup leaks rows for a year. "A half-built sandbox is
worse than none, because people trust it and then it is wrong." It replaced the fork with a
copy-on-write overlay at the two chokepoints every agent write already passes through, and
stated the boundary honestly: writes bypassing those chokepoints are not rehearsed and the
UI says so; aggregate and DB-computed reads are marked unrehearsed rather than silently
approximated. This was the single most valuable contribution of the round.

**Seat G conceded its own framing and revised upward.** Asked whether Burnish was a real app
or a package, it answered: "As a brand-voice checker, Burnish is a package. A lexicon, a
tone model, and a brand_check tool is a library with a settings page. I am not going to
defend that version." It revised to a claim substantiation register - every public assertion,
its evidence, its expiry, its permitted jurisdictions, and every live surface still carrying
it - with the expiry radar as the daily queue and the callable gate demoted to enforcement
arm rather than identity.

**Seat F corrected its own dependency claim.** It had conceded in Phase 1 that Brink's
precedent corpus required an incident app to exist first. In debate it withdrew that,
naming six bootstrap corpora already on disk (Blip watch firings, Bolt execution failures,
the agent-webhook DLQ auto-disable, `schema_migrations` applied-order timing, `activity_log`
and `v_activity_unified`) plus an entirely history-free structural analysis over schema
declarations, routes, the MCP tool catalog, Bolt subscriptions, and permission actions.

**Seat D pivoted its flagship off its own premise.** Asked whether a licensed-trades vertical
was too far from the suite's center of gravity, it conceded the objection was correct as
stated, and moved Bid to horizontal services procurement while keeping the mechanism the
vertical exercise had found: absence detection. It kept its three remaining vertical bets in
its block, honestly labeled as such, on the argument that a 35-proposal field with nothing
physical in it has a blind spot worth someone being on record about.

## Phase 3 - Submissions

Seven submissions were returned.

| Seat | Submission | Note |
| --- | --- | --- |
| A | **Bunker** | Named Seat E as primary author, unprompted |
| B | **Bursar**, merged with Seat D's Bid | Merge accepted in the submission itself |
| C | **Bazaar** | |
| D | **Bid** | Standalone, with the Bursar merge offer open and unwithdrawn |
| E | **Bunker** | Merged entry; co-authors Seats A and F named |
| F | **Bequest** | Brink withdrawn; conceded Seat E's design as better |
| G | **Burnish** | The revised claim-register version, not the superseded checker |

Three seats declined to submit the app they had argued hardest for in Phase 1, on the
grounds that a rival's version was better. Seat A on Bunker: "Seat E is the primary author.
Its copy-on-write overlay is the mechanism that makes this shippable, and killing the
shadow-org fork was the single best call anyone made in this session. Take Seat E's name."
Seat F on Brink: "Seat E's input-domain objection is correct, and I was wrong to bundle
them." Seat G on Babel: "Zero collisions read as an advantage in Phase 2; after a full round
in which nobody supported it or attacked it, I read the silence correctly now as nobody
wanting it, which is a worse signal than opposition."

## Phase 4 - Overlap resolution

### Near-duplication screen against the existing suite

Every submission was first screened against the 23-app roster rather than only against its
rivals. No submission was cut. The boundaries each seat drew:

| Submission | Closest existing app | Boundary |
| --- | --- | --- |
| Bunker | Bolt | Bolt is the production execution plane; Bunker is the counterfactual plane that answers what a rule would do before Bolt is permitted to run it. Bunker is useless without Bolt to promote into. Not a better Bolt. |
| Bursar / Bid | Bill, Burn, Bulwark | All three are money-in and client-facing (Bill bills customers, Burn defends margin against client scope creep, Bulwark tracks obligations owed under a signed contract). This is money-out and vendor-facing, which none of them touch. |
| Bazaar | Helpdesk | Helpdesk is 1:1, private, and discards each resolution on close; Bazaar is many-to-many, public, and compounds each resolution into a durable asset. Helpdesk's economics are linear in headcount; Bazaar's are not. |
| Bequest | Beacon | Beacon stores what is true now (mutable current-state); Bequest stores what was believed and why (immutable append-and-supersede). Beacon rots into inaccuracy; detecting that rot is Bequest's entire design. |
| Burnish | Bulwark | Bulwark's ledger is contract-derived with a named counterparty who can enforce; Burnish's is publication-derived with no contract, no counterparty, and no signature, triggered by evidence expiry and jurisdiction. Different corpus, trigger, owner, and remediation. |

### Pairwise resolution

**Perfect overlap - collapsed.** Seat A's Bunker and Seat E's Bunker are the same app.
Seat A named Seat E primary author in its own submission and asked that Seat E's name be
used. Collapsed to a single entry, co-owned by Seats A and E with contributions accepted
from Seat F. Seats A, E, and F all abstain from voting on it.

**Very similar but not identical - merge negotiation opened.** Seat B's Bursar and Seat D's
Bid. Seat B submitted pre-merged and accepted Seat D's non-negotiable; Seat D submitted
standalone, declining to concede scope unilaterally to an offer that had not yet been
answered. On inspection the two positions had no remaining gap: Seat D asked to keep
exclusion-diff-with-citations, which Seat B granted explicitly; Seat D conceded naming and
the reporting surface, which Seat B took; Seat B held Braid-resolved vendor normalization as
the shared ingestion path, which Seat D had never contested and in fact listed among its own
reuses. One relayed turn was sufficient; the negotiation did not approach the ten-turn limit.

**Distinct - continue unchanged.** Bazaar (Seat C), Bequest (Seat F), Burnish (Seat G).

### Surviving slate

Four apps went to the vote: **Bunker**, the merged **Bursar/Bid** entry, **Bazaar**,
**Bequest**, and **Burnish** - five entries from seven submissions after one collapse and
one merge.

## Phase 5 - Voting

### Method note

Abstention counts differ across entries: merged apps carry two or three abstentions
(co-owners plus named contributors) while solo apps carry one. Scoring on raw total would
therefore structurally penalize exactly the entries that consolidated the field, which is
the opposite of what this session should reward. The tally was announced to all seats in
advance as **mean score per eligible voter**, with seats told to score honestly on merit
rather than compensate.

Abstentions applied: Seats A and E on Bunker (co-owners) plus Seat F (named contributor,
its structural blast-radius predictor and calibration ledger were accepted into Bunker's v1
scope); Seats B and D on Bursar (co-owners); Seat C on Bazaar; Seat F on Bequest; Seat G on
Burnish.

### Round 1 matrix

| App | A | B | C | D | E | F | G | Eligible | Mean | Raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Bursar** | 5 | abs | 5 | abs | 5 | 5 | 4 | 5 | **4.80** | 24 |
| **Bunker** | abs | 5 | 4 | 5 | abs | abs | 5 | 4 | **4.75** | 19 |
| Bazaar | 4 | 4 | abs | 4 | 3 | 4 | 4 | 6 | 3.83 | 23 |
| Bequest | 3 | 3 | 4 | 4 | 4 | abs | 3 | 6 | 3.50 | 21 |
| Burnish | 3 | 4 | 2 | 3 | 4 | 4 | abs | 6 | 3.33 | 20 |

### Result

**Winner: Bursar (4.80). Runner-up: Bunker (4.75).**

The margin is 0.05, so the result was checked for robustness three ways before being
declared, and all three agree:

1. **Mean score** (the announced method): Bursar 4.80, Bunker 4.75.
2. **Raw total**, despite its bias against merged entries: Bursar 24, Bazaar 23, Bunker 19.
   Bursar still leads.
3. **Free-text "should win" sentences**, which each seat wrote independently of its numeric
   scores: Bursar 4 (Seats A, C, E, F), Bunker 3 (Seats B, D, G).

No tiebreak round was required. Had one been needed, the rubric tiebreak would also have
favored Bursar: it lands in a category the census explicitly named as whitespace, while
Bunker's category, though genuinely uncovered, was not on the list.

### What the voters actually argued

Bursar won on a single mechanism that every eligible seat named independently: **the
exclusion diff is absence detection rather than summarization.** Seat F: "the one thing a
human reader reliably fails at and no procurement tool sells." Seat A: "a genuinely hard AI
mechanism that no summarizer can fake." Seat C: "the hardest thing to fake and the thing no
incumbent does." The second recurring theme was the frozen award-time scope tree, which
several seats identified as the structural keystone: it is what converts the post-purchase
half from a spend dashboard into citable divergence. Seat C added the argument that likely
decided the margin: unlike most of the field, Bursar's value "does not require the customer
to first generate a corpus they do not have" - the quotes and invoices already exist on day
one.

Bunker lost by a fraction on a single consistent reservation. The three seats that scored it
below 5 all raised the same point from different angles: a 2-50 person team running a
handful of agents feels this pain far less than a large agent fleet would, and the app gets
better as the customer outgrows the suite's stated target. Seats C and D both noted they
were applying the same customer-size test they had used to reject the incident cluster, and
declined to exempt an app they otherwise admired. Seat D scored it 5 anyway and called the
chokepoint insight "the whole thing"; Seat G scored it 5 and argued its absence "gets more
dangerous every month the suite ships more agents."

Notably, Seat E - Bunker's primary author - voted Bursar 5 and named it the app that should
win, writing that the exclusion-diff-plus-frozen-baseline pairing "is a mechanism I could
not beat with my own proposal in that space, which is why I withdrew it."

### Runner-up disposition

Bunker is recorded as the strongest unbuilt idea of this session and the clear candidate to
open the next cycle. Its v1 design survived debate in better shape than it entered: the
shadow-org fork was cut by its own author, and the copy-on-write overlay at the MCP
`/tools/call` and Bolt-executor chokepoints is a genuinely buildable boundary. Seat F's
post-v1 request (weight a journaled write set against precedent from Blip watch firings and
`schema_migrations` timing) was accepted by Seat E and should carry forward with it.

---

## Winner

**BURSAR** - vendor-side procurement and spend, spanning the full money-out lifecycle.

Co-authors: Seat B (data and intelligence lens) and Seat D (vertical wedge lens). Seat E
withdrew its competing Ballast entry outright in Bursar's favor and contributed two
detectors by name.

One canonical Braid-resolved record joins a vendor identity to a canonical scope tree.
Pre-award, the model derives that scope tree from the buyer's own request, normalizes every
incompatible inbound offer onto it, and produces the exclusion diff: scope items present in
the request or in a rival offer but absent from this one, each cited to the source line that
should have covered it. Award freezes that scope tree as a durable baseline. Post-award, the
same spine drives the mismatch set: price drift against the frozen baseline,
contracted-versus-invoiced divergence, duplicate tools, paid seats with no observed activity
in ninety days, and renewal cliffs with lead time to act.

The category boundary, stated plainly because it is the one voters probed: Bill is money-in
and customer-facing; Burn defends project margin in the relationship where the customer is
the supplier; Bulwark tracks clause obligations arising from executed contracts. All three
look at the relationship where BigBlueBam's customer is the party being paid. Bursar is the
only app in the suite that looks at the relationship where the customer is the party paying,
and the only one that operates pre-counterparty, on offers from parties who have not signed
anything and therefore produce no clause, no obligation, and no ledger row anyone else can
read.

## Phase 6 - Spec hardening

_Pending._
