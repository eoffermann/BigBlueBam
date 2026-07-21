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

_(pending)_

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
