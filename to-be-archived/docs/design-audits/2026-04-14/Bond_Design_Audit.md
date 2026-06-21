# Bond Design Audit (2026-04-14)

## Summary

Bond's implementation has matured significantly since the 2026-04-09 audit. The core gaps that existed have been addressed: Bolt event emission is now fully integrated, the three missing MCP tools have been wired, custom field settings UI is functional, and the stale-deal detection worker with proper idempotency is in place. Overall completion has improved from approximately 78% to approximately 88%.

## Design sources consulted

- `docs/early-design-documents/Bond_Design_Document.md` (v1.0)
- `docs/design-audits/2026-04-09/Bond-Design-Audit-2026-04-09.md`
- `CLAUDE.md`

## Built and working

### Data model

All 11 core tables present and correctly structured:
- `bond_contacts`, `bond_companies`, `bond_contact_companies`
- `bond_pipelines`, `bond_pipeline_stages`
- `bond_deals`, `bond_deal_contacts`, `bond_deal_stage_history`
- `bond_activities`
- `bond_lead_scoring_rules`
- `bond_custom_field_definitions`

**Missing:** `bond_import_mappings` (express-interest migration target table).

Migrations: `0033_bond_tables.sql` (main schema), `0045_bond_deal_rotting_alerted.sql` (idempotency column for stale-deal worker).

Drizzle schema files in `apps/bond-api/src/db/schema/` match migrations exactly.

### API routes

**Contacts:** 6 routes all implemented.
**Companies:** 4 routes implemented.
**Pipelines and Stages:** All 9 routes implemented.
**Deals:** 10 routes implemented.
**Activities:** POST/GET/PATCH/DELETE.
**Lead Scoring:** CRUD for rules; single-contact score recalculation.
**Analytics:** All 6 endpoints functional.
**Custom Fields:** Full CRUD (new since 2026-04-09).

### Services

7 service modules in `apps/bond-api/src/services/`:
- `activity.service.ts`, `analytics.service.ts`, `company.service.ts`, `contact.service.ts`, `custom-field.service.ts`, `deal.service.ts`, `pipeline.service.ts`, `scoring.service.ts`

### Frontend

8 pages at `apps/bond/src/pages/`: analytics, company-detail, company-list, contact-detail, contact-list, deal-detail, pipeline-board, settings.

| Route | Status | Notes |
|---|---|---|
| `/bond` | working | Pipeline board with Kanban |
| `/bond/deals/:id` | working | Full page detail (not drawer as spec says) |
| `/bond/contacts/:id` | working | Detail with activity, details, deals tabs |
| `/bond/companies/:id` | working | Detail with activity, contacts, deals |
| `/bond/analytics` | working | Full dashboard |
| `/bond/settings/pipelines` | working | Pipeline/stage config |
| `/bond/settings/fields` | working | Custom field management (new) |
| `/bond/settings/scoring` | backend only | Rule builder UI missing |

### Worker

`apps/worker/src/jobs/bond-stale-deals.job.ts` fully implemented:
- Runs daily at 02:00 UTC
- Finds deals exceeding `bond_pipeline_stages.rotting_days`
- Query filters on `rotting_alerted_at IS NULL OR rotting_alerted_at < stage_entered_at`
- Emits `bond.deal.rotting` events to Bolt ingest (note: still prefixed name, not bare `deal.rotting`)
- Updates `rotting_alerted_at` AFTER emit
- Per-deal error logging

### MCP tools

All 22 tools registered in `apps/mcp-server/src/tools/bond-tools.ts`, including the three added since 2026-04-09:
- `bond_score_lead` (single-contact scoring)
- `bond_get_forecast` (analytics)
- `bond_search_contacts`

### Bolt event emission

Events now published throughout bond-api:
- `contact.created`, `contact.updated`
- `deal.created`, `deal.updated`, `deal.stage_changed`, `deal.won`, `deal.lost`
- `activity.logged`

Fire-and-forget HTTP POST to Bolt ingest endpoint with 5-second timeout. Implementation at `apps/bond-api/src/lib/bolt-events.ts`, call sites in contact.service.ts, deal.service.ts, activity.service.ts.

### Permissions

Member and viewer "own only" visibility implemented. Members and viewers only see contacts and deals where they are `owner_id`. Filter applied at SQL query level via `visibility_owner_id` parameter.

## Partial or divergent

### Event naming convention divergence

- **Design says:** `bond.contact.created`, `bond.deal.stage_changed`, etc. (prefixed by product)
- **Code emits:** `contact.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `deal.updated`, `activity.logged` (bare)
- **Worker emits:** `bond.deal.rotting` (prefixed, as documented in CLAUDE.md)

Bare names align with the Wave 0.4 naming-sweep direction (though the Wave 0.4 sweep itself was rolled back and is not at a8fb19a). The `bond.deal.rotting` exception in the worker is a known divergence.

### Scoring rule builder UI

Backend CRUD for `bond_lead_scoring_rules` is complete, but the frontend settings page lacks a visual rule builder. Users can manage rules only via direct API calls.

### Deal detail as full page

Design says `/bond/deals/:id` should be a drawer overlay on the pipeline board. Implementation shows a full detail page. UX simplification, not a functional regression.

### Hard delete

Contacts, deals, and companies use hard DELETE. Design specifies soft-delete with `deleted_at` column. May be intentional for simplicity.

## Missing

### P0

1. **Express-interest migration** (Sec 10). `POST /import/express-interest` endpoint and `bond_import_mappings` table absent. Blocks legacy prospect data absorption.
2. **Cross-product integrations** (Sec 8). Zero integration with Blast, Helpdesk, Bam, Banter, or Blank. All five integration points deferred. Acceptable for current phase but blocks full suite automation.
3. **`GET /companies/:id/deals` sub-route.** Company detail fetches deals inline but no paginated sub-endpoint.

### P1

4. **Soft-delete** with `deleted_at` column on contacts, deals, companies. Implementation diverges from spec.
5. **CSV import for contacts** with column mapping. Implementation accepts only JSON array import.
6. **Deal detail drawer overlay** on pipeline board. Implementation shows full page.
7. **Bulk lead score recalculation** BullMQ job. API only scores single contact synchronously.
8. **Swimlane grouping** on pipeline board (by owner, company, close month).

### P2

9. **Motion spring physics** on deal cards (align with Bam task drag animation).
10. **Scoring rule visual builder** UI in settings.

## Architectural guidance

### Express-interest migration

Create `bond_import_mappings` table with columns for source system name, source ID, target entity type, target UUID, imported_at, imported_by, status. Add `POST /import/express-interest` route that accepts a CSV file and column mapping JSON. The handler batch-inserts contacts/companies, records mappings, handles duplicates via email lookup. Worker job can run this async for large imports.

### Cross-product integrations

Each integration depends on the consuming app emitting the right events and Bolt having rules to process them:
- **Bond to Blast:** When contact is created/updated, emit `contact.created` (already done). Blast subscribes to this event for list-segmentation updates.
- **Bond to Helpdesk:** When Helpdesk ticket is created for a contact with bond_contact_id, link to Bond. Requires Helpdesk to store bond_contact_id.
- **Bond to Bam:** When deal reaches a certain stage, create a Bam task for follow-up. Bolt automation template.
- **Bond to Banter:** When deal is won, post to Banter channel. Bolt automation template.
- **Bond to Blank:** Form submissions create contacts. Requires Blank form settings to route submissions to Bond.

### Soft-delete

Add `deleted_at` column to `bond_contacts`, `bond_deals`, `bond_companies`. Update all list queries to filter `WHERE deleted_at IS NULL`. Update DELETE routes to `UPDATE ... SET deleted_at = NOW()` instead. Add `GET /contacts/:id/restore` endpoint for undelete.

### Bulk lead scoring job

Add `apps/worker/src/jobs/bond-bulk-lead-scoring.job.ts` that runs nightly at 01:00 UTC. The job:
1. Loads all active scoring rules for the org.
2. Loads all contacts in org.
3. For each contact, evaluates each rule and updates `lead_score`.
4. Logs per-contact score changes.

Alternatively, enqueue on-demand from `POST /scoring/recalculate-all` endpoint.

## Dependencies

### Inbound (other apps depend on Bond)

- Bolt subscribes to all bond events for cross-product automation.
- Bill creates invoices linked to bond_company_id and bond_deal_id.
- Bench registers bond_deals and pipeline_stages as analytics data sources.
- MCP tools expose 22 Bond operations to AI agents.

### Outbound (Bond depends on other apps)

- Bolt API for event publishing (internal :4006).
- Bam API if deal-to-task integration is added.
- Banter API if deal-won notification is added.

## Open questions

1. **Express-interest data source format:** What are the legacy prospect data sources? CSV export from where? Are there specific columns that need mapping?
2. **Cross-product integration priority:** Which integration should land first? Blast segmentation is probably highest value, followed by Helpdesk ticket linking.
3. **Soft-delete retention:** Should deleted records be purged after a retention period (e.g., 90 days) or kept indefinitely for audit?
4. **Bulk scoring frequency:** Nightly is probably sufficient. Should there also be an on-demand button in the scoring settings page?
5. **Scoring rule builder UI complexity:** Simple form or drag-and-drop condition builder?
6. **Event naming:** Should the Wave 0.4 bare-name convention be finalized for Bond going forward, with `bond.deal.rotting` being the one exception, or should the worker be updated to emit `deal.rotting` for consistency?
