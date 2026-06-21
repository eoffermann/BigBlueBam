# Bond help.md Review

## Verdict: CHANGES REQUESTED

One accuracy defect: the Contacts list lifecycle filter pills are mislabeled.
The doc says one pill reads "Sales Qualified", but the code renders "SQL".
Everything else (template, feature coverage, story coverage, the critical
unwired-Edit-action handling, custom-fields/scoring per-entity-type framing,
counts, screenshots, no em dashes) verifies clean against the code.

---

## Fix list

1. **File:** `docs/apps/bond/help.md`
   **Section:** Feature reference -> "Contacts list", step 2 (line 138).
   **Wrong:** Lists the lifecycle pills as "**All**, **Lead**, **Subscriber**,
   **MQL**, **Sales Qualified**, **Opportunity**, **Customer**, or
   **Evangelist**".
   **Should be:** The `sales_qualified` pill renders "SQL", not "Sales
   Qualified". The pill labels come from `lifecycleStageLabel()` in
   `apps/bond/src/lib/utils.ts:68-80`, which maps `sales_qualified -> 'SQL'`
   (and `marketing_qualified -> 'MQL'`). The list order in
   `apps/bond/src/pages/contact-list.tsx:31-34` is: All, Lead, Subscriber, MQL,
   SQL, Opportunity, Customer, Evangelist. Change "Sales Qualified" to "SQL".
   (The Create Contact dialog already uses "SQL" and the doc is correct there;
   only the Contacts-list pill description is wrong.)

---

## Accuracy findings

### Defect (must fix)
- "Sales Qualified" lifecycle pill label does not trace to code. The rendered
  pill is "SQL" (`apps/bond/src/lib/utils.ts:73`,
  `apps/bond/src/pages/contact-list.tsx:84`). See fix #1.

### Verified accurate (spot-checked against code)
- **Unwired in-app Edit actions (the critical check): PASS.** `Edit Deal`
  (`deal-detail.tsx:160`), `Edit Contact` and the contact-menu `Create Deal`
  (`contact-detail.tsx:138,142`), and `Edit Company` (`company-detail.tsx:145`)
  all have empty `onSelect={() => {}}` handlers; there is no edit dialog wired.
  The Delete handlers, by contrast, call real mutations. The doc documents all
  four as not-working-in-app and points to the MCP tool / REST API in every
  place they appear (help.md lines 122, 171, 208, and the relevant stories).
  Correct.
- **Custom fields per entity type, org-wide (not per pipeline): PASS.** Code
  defines fields per `entity_type` (Contact/Company/Deal) in
  `apps/bond/src/pages/settings.tsx:236-240,446-457`; the create dialog
  description literally says "for a specific entity type". The doc states "per
  entity type ... org-wide for that type (not per pipeline)" (lines 26, 258,
  484). Correct. The dossier flagged the stale guide.md/_narrative.md
  "per pipeline" wording; help.md does not repeat that error.
- **Lead scoring rules org-wide (not per pipeline): PASS.** Doc lines 27, 277.
  Matches code; no pipeline scoping on `scoring_rules`.
- **MCP tool count: PASS.** Exactly 22 `bond_*` tools in
  `apps/mcp-server/src/tools/bond-tools.ts`; `bond_find_duplicates` is the
  cross-cutting 23rd in `dedupe-tools.ts`. Doc says "22 MCP tools ... plus the
  cross-cutting `bond_find_duplicates`" (line 309). Correct.
- **Bolt events: PASS.** All nine listed (`deal.created`, `deal.updated`,
  `deal.stage_changed`, `deal.won`, `deal.lost`, `contact.created`,
  `contact.upserted`, `activity.logged`, `deal.rotting`) confirmed across
  `apps/bond-api/src/services/*.ts` and the worker
  `apps/worker/src/jobs/bond-stale-deals.job.ts:114`.
- **Default pipeline stages: PASS.** Prospect(10), Qualified(25), Proposal(50),
  Negotiation(75), Closed Won(100, won), Closed Lost(0, lost) -
  `settings.tsx:49-54`. Matches doc lines 245, 343.
- **Field Types, Entity Types, scoring Operators, condition Fields: PASS.** All
  match `settings.tsx` (FIELD_TYPES 242-252, ENTITY_TYPES 236-240,
  CONDITION_OPERATORS 576-586, CONDITION_FIELDS 565-574). The doc's "Value box
  hides for Exists and Not Exists" matches the `needsValue` logic (line 678).
- **Deal status badge: PASS.** `close_reason ? 'Lost' : 'Won'` for closed, else
  "Open" (`deal-detail.tsx:75-78`). The in-app Lost button calls
  `closeDealLost.mutate({ dealId })` with no reason/competitor (line 142), so
  the doc's note that reason/competitor need REST/MCP (line 115) is correct;
  `bond_close_deal_lost` does accept `lost_to_competitor`
  (`bond-tools.ts:796`).
- **Board labels: PASS.** "N deals | Total | Weighted" (pipeline-board.tsx:232-
  236), Group buttons None/Owner/Close month (246-258, three real buttons),
  "Search deals..." (266), "Add Deal" (279), "No pipeline selected" /
  "Create Pipeline" (209-216).
- **Analytics labels: PASS.** Total Pipeline, Weighted Forecast, Win Rate,
  Stale Deals ("Needs attention"/"All healthy"), Pipeline Stages, Average Deal
  Velocity (days per stage), Stage Transitions, Revenue Forecast (weighted),
  Stale Deals (N), Top Loss Reasons, Top Competitors - all exact in
  `analytics.tsx`.
- **Detail tabs: PASS.** Contact = activity/details/deals
  (`contact-detail.tsx:41`); Company = activity/details/contacts/deals
  (`company-detail.tsx:38`).
- **Log Activity types: PASS.** Note, Email Sent, Email Received, Call, Meeting,
  Task (`log-activity-form.tsx:8-13`).
- **Sidebar nav: PASS.** Pipeline Board, Contacts, Companies, Analytics, Bond
  Settings; scope selector "Default Pipeline" / "No pipelines found"
  (`bond-sidebar.tsx:50,85`); `?` opens Help.
- **Endpoints referenced exist: PASS.** `/scoring/recalculate`
  (`scoring.routes.ts:86`), `/contacts/:id/duplicates`
  (`dedupe.routes.ts:24`), `/contacts/:id/merge` and `/contacts/:id/restore`
  (`contacts.routes.ts:235,248`).

### Conventions
- **Em dashes: PASS.** Zero em dashes in help.md (full-file scan).
- **Screenshots: PASS.** All five referenced light screenshots
  (`01-pipeline.png`, `02-contacts.png`, `03-deal-detail.png`,
  `04-analytics.png`, `05-companies.png`) exist under
  `docs/apps/bond/screenshots/light/` (dark variants also present).
- **Template completeness: PASS.** Overview (with Key concepts + Where to find
  it), Feature reference (with Working with AI agents), User Stories, Related -
  all present and filled.
- **Story coverage: PASS.** Setup (first pipeline), core loop (create/move/close
  a deal; add/qualify a contact), collaboration/cross-app (hand a deal off
  across the suite; manage companies), search/reporting (triage stale deals;
  forecast revenue), agent flow (deduplicate contacts, agent-assisted) all
  covered. 13 stories total; steps are followable.

