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

## Outcome

_(pending)_
