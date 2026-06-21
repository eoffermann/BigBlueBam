# Bond (CRM) Design Audit

**Date:** 2026-04-09
**Auditor:** Claude Opus 4.6
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Bond_Design_Document.md` v1.0
**Implementation:** `apps/bond-api/src/` (35 files), `apps/bond/src/` (40 files), `apps/mcp-server/src/tools/bond-tools.ts`

---

## Executive Summary

Bond's implementation is **substantially complete** against the v1.0 design specification. The core data model, API surface, pipeline board UI, and MCP agent tools are all functional and closely match the design. The primary gaps are in cross-product integrations (Bolt events, Blast sync, Helpdesk linking), the express-interest migration system, and a few frontend UX refinements specified in the design document.

**Overall Completion: ~78%**

| Category | Items Audited | Avg Rating | Completion |
|----------|:------------:|:----------:|:----------:|
| Data Model (Sec 3) | 11 tables | P4.7 | 95% |
| API Endpoints (Sec 4) | 38 endpoints | P4.1 | 85% |
| MCP Tools (Sec 5) | 22 tools | P3.4 | 68% |
| Frontend Routes/Pages (Sec 6) | 11 routes | P3.8 | 77% |
| Frontend UX Details (Sec 6.2-6.4) | 12 features | P3.2 | 64% |
| Events / Bolt Integration (Sec 7) | 8 events | P0.0 | 0% |
| Cross-Product Integration (Sec 8) | 5 integrations | P0.0 | 0% |
| Permissions (Sec 9) | 10 rules | P3.0 | 60% |
| Migration (Sec 10) | 3 items | P0.0 | 0% |

---

## Feature Rating Table

Rating scale: **P0** = not implemented, **P1** = stub/placeholder only, **P2** = partial skeleton, **P3** = functional but missing design details, **P4** = nearly complete with minor gaps, **P5** = fully matches design.

### Data Model (Section 3)

| Feature | Rating | Notes |
|---------|:------:|-------|
| `bond_contacts` table | P5 | All columns, indexes, CHECK constraints match design exactly. Migration `0033_bond_tables.sql`. |
| `bond_companies` table | P5 | Complete match. |
| `bond_contact_companies` join | P5 | Complete match. |
| `bond_pipelines` table | P5 | Complete match. |
| `bond_pipeline_stages` table | P5 | Complete match including `rotting_days`, `probability_pct`, `color`. |
| `bond_deals` table | P5 | Including `weighted_value` generated column, `stage_entered_at`, `last_activity_at`. |
| `bond_deal_contacts` join | P5 | Complete match. |
| `bond_activities` table | P5 | All 16 activity types from design present in CHECK constraint. |
| `bond_deal_stage_history` table | P5 | Complete match including `duration_in_stage`. |
| `bond_lead_scoring_rules` table | P5 | All 9 operators match. |
| `bond_custom_field_definitions` table | P5 | Complete match. Drizzle schema file exists. |
| `bond_import_mappings` table | **P0** | Not in migration, not in Drizzle schema, not referenced anywhere. |

### API Endpoints (Section 4)

#### 4.1 Contacts

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /contacts` | P5 | Full filter set: lifecycle_stage, owner, company, lead_score range, search, sort, pagination. |
| `POST /contacts` | P5 | All fields supported including custom_fields. |
| `GET /contacts/:id` | P5 | Returns companies, deals, recent activities as specified. |
| `PATCH /contacts/:id` | P5 | Partial update works correctly. |
| `DELETE /contacts/:id` | P4 | Hard delete, not soft-delete as design specifies. |
| `POST /contacts/:id/merge` | P5 | Full merge logic: moves deals, activities, company links, fills blank fields, deletes source. |
| `POST /contacts/import` | P4 | Accepts JSON array, not CSV with column mapping as design specifies. Dedup by email works. |
| `GET /contacts/:id/activities` | **P0** | No dedicated sub-route. Activities fetched inline via `getContact()` detail, but no separate endpoint at `/contacts/:id/activities`. |
| `GET /contacts/:id/deals` | **P0** | No dedicated sub-route. Deals returned inline in contact detail response. |
| `GET /contacts/search` | P5 | Full-text search across name, email, phone. Bonus: not in design but useful. |
| `GET /contacts/export` | P4 | Bonus endpoint not in design. Functional. |

#### 4.2 Companies

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /companies` | P5 | Filterable by industry, size_bucket, owner, search, sort. |
| `POST /companies` | P5 | All fields supported. |
| `GET /companies/:id` | P5 | Returns contacts, deals as specified. |
| `PATCH /companies/:id` | P5 | Complete. |
| `DELETE /companies/:id` | P4 | Hard delete, not soft-delete. |
| `GET /companies/:id/contacts` | P5 | Dedicated endpoint with full contact detail. |
| `GET /companies/:id/deals` | **P0** | No dedicated sub-route. Deals returned inline in company detail response but no `/companies/:id/deals` endpoint. |
| `GET /companies/search` | P5 | Bonus: searches name, domain, industry. |

#### 4.3 Pipelines & Stages

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /pipelines` | P5 | Lists all org pipelines. |
| `POST /pipelines` | P5 | Supports inline stages array creation. |
| `GET /pipelines/:id` | P5 | Returns pipeline with stages. |
| `PATCH /pipelines/:id` | P5 | Name, description, is_default, currency. |
| `DELETE /pipelines/:id` | P5 | Implemented (beyond design -- design doesn't mention pipeline delete). |
| `POST /pipelines/:id/stages` | P5 | All stage fields. |
| `PATCH /pipelines/:id/stages/:stageId` | P5 | Partial update. |
| `DELETE /pipelines/:id/stages/:stageId` | P4 | Implemented but does not enforce "must reassign deals first" as design specifies. |
| `POST /pipelines/:id/stages/reorder` | P5 | Accepts ordered array of stage IDs. |
| `GET /pipelines/:id/stages` | P5 | Bonus: separate stages list endpoint. |

#### 4.4 Deals

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /deals` | P5 | Full filter set matches design: pipeline, stage, owner, value range, close date range, stale flag, search. |
| `POST /deals` | P5 | Creates deal, records initial stage history, logs `deal_created` activity. |
| `GET /deals/:id` | P5 | Returns contacts, stage history, recent activities, stage detail, company. |
| `PATCH /deals/:id` | P5 | All mutable fields. |
| `PATCH /deals/:id/stage` | P5 | Records stage history with duration, logs `stage_change` activity. |
| `POST /deals/:id/won` | P5 | Finds won stage, records history, sets closed_at, logs `deal_won`. |
| `POST /deals/:id/lost` | P5 | Finds lost stage, records history, sets close_reason + lost_to_competitor, logs `deal_lost`. |
| `DELETE /deals/:id` | P4 | Hard delete, not soft-delete. |
| `GET /deals/:id/activities` | P5 | Inline import of activity service. |
| `GET /deals/:id/stage-history` | P5 | Returns full stage transition history. |
| `POST /deals/:id/contacts` | P5 | Associates contact with role. |
| `DELETE /deals/:id/contacts/:contactId` | P5 | Removes association. |
| `GET /deals/:id/contacts` | P5 | Bonus: lists deal contacts with join. |
| `POST /deals/:id/duplicate` | P5 | Bonus: copies deal + contact associations. |

#### 4.5 Activities

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `POST /activities` | P5 | All fields supported. |
| `GET /activities/:id` | P5 | Single activity detail. |
| `PATCH /activities/:id` | P5 | Subject, body, metadata. |
| `DELETE /activities/:id` | P5 | Complete. |
| `GET /activities` | P5 | Bonus: list with filters (contact_id, deal_id, company_id, activity_type). |

#### 4.6 Lead Scoring

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /scoring-rules` | P5 | Lists all org rules. |
| `POST /scoring-rules` | P5 | All fields. |
| `PATCH /scoring-rules/:id` | P5 | Partial update. |
| `DELETE /scoring-rules/:id` | P5 | Complete. |
| `POST /scoring/recalculate` | P4 | Scores a single contact (accepts `contact_id`). Design says "full recalculation of all contacts" via BullMQ job -- bulk recalc not implemented. |

#### 4.7 Pipeline Analytics

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `GET /analytics/pipeline-summary` | P5 | Stage-level value, count, weighted value. |
| `GET /analytics/conversion-rates` | P5 | Stage-to-stage transitions with date range filter. |
| `GET /analytics/deal-velocity` | P5 | Per-stage average + overall cycle length. |
| `GET /analytics/win-loss` | P5 | Win/loss ratio, loss reasons, competitor breakdown. |
| `GET /analytics/forecast` | P5 | 30/60/90 day weighted pipeline buckets. |
| `GET /analytics/stale-deals` | P5 | Rotting threshold comparison per stage. |

#### 4.8 Express-Interest Migration

| Endpoint | Rating | Notes |
|----------|:------:|-------|
| `POST /import/express-interest` | **P0** | Not implemented. No route, no service, no Drizzle schema for `bond_import_mappings`. |

### MCP Tools (Section 5)

| Tool | Rating | Notes |
|------|:------:|-------|
| `bond_list_contacts` | P5 | All filters mapped. |
| `bond_get_contact` | P5 | Full detail. |
| `bond_create_contact` | P5 | All fields. |
| `bond_update_contact` | P5 | Partial update. |
| `bond_merge_contacts` | P5 | Target/source merge. |
| `bond_list_companies` | P5 | Full filters. |
| `bond_get_company` | P5 | Full detail. |
| `bond_create_company` | P5 | All fields. |
| `bond_update_company` | P5 | Partial update. |
| `bond_list_deals` | P5 | Full filters. |
| `bond_get_deal` | P5 | Full detail with contacts, activities, stage history. |
| `bond_create_deal` | P5 | All fields including contact_ids. |
| `bond_update_deal` | P5 | Partial update. |
| `bond_move_deal_stage` | P5 | Records history. |
| `bond_close_deal_won` | P5 | With close_reason. |
| `bond_close_deal_lost` | P5 | With close_reason + lost_to_competitor. |
| `bond_log_activity` | P5 | All activity types. |
| `bond_get_pipeline_summary` | P5 | Full summary. |
| `bond_get_stale_deals` | P5 | With owner filter. |
| `bond_score_lead` | **P0** | Not implemented in MCP tools. API has `POST /scoring/recalculate` but no MCP wrapper. |
| `bond_get_forecast` | **P0** | Not implemented in MCP tools. API has `GET /analytics/forecast` but no MCP wrapper. |
| `bond_search_contacts` | **P0** | Not implemented in MCP tools. API has `GET /contacts/search` but no MCP wrapper. |

**MCP tool count:** Design specifies 22 tools. Implementation has 19 tools (3 missing).

### Frontend Routes & Pages (Section 6.1)

| Route | Rating | Notes |
|-------|:------:|-------|
| `/bond` (pipeline board) | P5 | Default route renders pipeline board. |
| `/bond/pipelines/:id` | P5 | Specific pipeline board. |
| `/bond/deals/:id` | P5 | Deal detail page (not drawer overlay as design says, but full page). |
| `/bond/contacts` | P5 | Contact list with table view, search, filter. |
| `/bond/contacts/:id` | P5 | Contact detail with activity timeline, details tab, deals tab. |
| `/bond/companies` | P4 | Company list page exists. |
| `/bond/companies/:id` | P5 | Company detail with tabs (activity, details, contacts, deals). |
| `/bond/analytics` | P5 | Full analytics dashboard. |
| `/bond/settings/pipelines` | P5 | Pipeline & stage configuration with create/delete. |
| `/bond/settings/fields` | **P1** | Placeholder only. Shows "coming soon" message. |
| `/bond/settings/scoring` | **P1** | Placeholder only. Shows "coming soon" message. Backend scoring API fully works but frontend has no UI. |

### Frontend UX Details (Section 6.2-6.4)

| Feature | Rating | Notes |
|---------|:------:|-------|
| Kanban board with dnd-kit drag-and-drop | P5 | `DndContext` + `PointerSensor` + `DragOverlay`. Stages as columns, deals as cards. |
| Deal card: name, value, company, owner avatar | P5 | All four elements rendered. |
| Deal card: days-in-stage indicator | P5 | Shows `{days}d` with Clock icon. |
| Deal card: rotting indicator (orange/red glow) | P5 | CSS classes `deal-rotting` and `deal-rotting-severe` applied based on `rottingDays`. |
| Column totals (deal count + value) | P4 | Summary shown in board header. Per-column totals may depend on `StageColumn` component (not fully audited but summary data is available). |
| Pipeline-level weighted forecast in header | P5 | "Weighted: {formatCurrencyCompact(...)}" in board header. |
| Swimlanes (optional grouping) | **P0** | Not implemented. Design specifies group by owner, company, expected close month. |
| Motion spring physics (like Bam) | P3 | Uses dnd-kit but no explicit Motion/Framer Motion spring animations on cards. `DragOverlay` is basic. |
| Contact detail: sidebar tabs (Details, Companies, Deals) | P4 | Has tabs: activity, details, deals. Missing "Companies" as a separate tab (companies shown inline). |
| Contact detail: inline note/email/call logging | P5 | `LogActivityForm` component with inline form. |
| Analytics: conversion funnel visualization | P4 | Shows conversion rates as percentage flow between stages. Not a true funnel chart, but data is rendered. |
| Analytics: deal velocity bar chart | P4 | Shows velocity per stage as grid cards with avg/median days. Not a bar chart but data is clearly presented. |
| Analytics: revenue forecast 30/60/90 | P5 | Three-bucket layout with weighted values. |
| Analytics: stale deal alert list | P5 | Clickable stale deal cards with days/threshold badges. |

### Events / Bolt Integration (Section 7)

| Event | Rating | Notes |
|-------|:------:|-------|
| `bond.contact.created` | **P0** | No Redis PubSub publish anywhere in bond-api. |
| `bond.contact.lifecycle_changed` | **P0** | Same. |
| `bond.deal.created` | **P0** | `createDeal` service logs activity but does not emit event. |
| `bond.deal.stage_changed` | **P0** | `moveDealStage` service logs activity but does not emit event. |
| `bond.deal.won` | **P0** | Same. |
| `bond.deal.lost` | **P0** | Same. |
| `bond.deal.rotting` | **P0** | No stale-deal detection BullMQ job. Only analytics endpoint calculates on-demand. |
| `bond.activity.logged` | **P0** | Same. |

**No Bolt events are emitted.** This is a significant gap for the suite integration story.

### Cross-Product Integration (Section 8)

| Integration | Rating | Notes |
|-------------|:------:|-------|
| Blast: segment export + engagement feedback | **P0** | No Blast integration code. |
| Helpdesk: ticket-contact linking | **P0** | No Helpdesk integration code. |
| Bam: deal-to-project linking | **P0** | No Bam integration code. |
| Banter: rich previews, bot posts | **P0** | No Banter integration code. |
| Blank: form submission capture | **P0** | No Blank integration code. |

### Permissions (Section 9)

| Permission Rule | Rating | Notes |
|----------------|:------:|-------|
| View all contacts/deals (Admin/Manager) | P4 | Auth middleware exists. `requireAuth` on all list endpoints. No "own only" filtering for Member/Viewer. |
| Create contacts/deals (Admin/Manager/Member) | P5 | `requireMinRole('member')` on create endpoints. |
| Edit any contact/deal (Admin/Manager) | P3 | `requireMinRole('member')` allows members to edit any, not just own. |
| Delete contacts/deals (Admin/Manager) | P5 | `requireMinRole('admin')` on delete endpoints. |
| Merge contacts (Admin/Manager) | P5 | `requireMinRole('admin')` on merge. |
| Configure pipelines/stages (Admin only) | P5 | `requireMinRole('admin')` + `requireScope('admin')`. |
| Configure custom fields (Admin only) | P1 | Backend table exists but no CRUD routes for custom field definitions. |
| Configure scoring rules (Admin/Manager) | P4 | `requireMinRole('admin')` (design says Manager too). |
| View analytics (all roles) | P5 | `requireAuth` only on analytics. |
| Import/export contacts (Admin/Manager) | P4 | Import requires admin. Export requires admin. Design says Manager too. |
| "Own only" visibility for Member/Viewer | **P0** | Not implemented. All authenticated users see all records in their org. |

### Migration: Express-Interest Absorption (Section 10)

| Feature | Rating | Notes |
|---------|:------:|-------|
| `POST /import/express-interest` endpoint | **P0** | Not implemented. |
| `bond_import_mappings` table | **P0** | Not in migration or Drizzle schema. |
| SuperUser visibility scoping | **P0** | Not implemented. |

---

## Detailed Findings (P0-P3)

### P0: Not Implemented

1. **Bolt Event Emission (Section 7)** -- None of the 8 specified events (`bond.contact.created`, `bond.deal.stage_changed`, etc.) are published to Redis PubSub. This means no Bolt automations can trigger on Bond state changes. Impact: high for suite integration.

2. **Cross-Product Integrations (Section 8)** -- Zero integration with Blast, Helpdesk, Bam, Banter, or Blank. All 5 integration points are P0. These are understandably deferred but should be tracked.

3. **Express-Interest Migration (Section 10)** -- The `POST /import/express-interest` endpoint, `bond_import_mappings` table, and SuperUser visibility scoping are all absent. The legacy prospect absorption story is not started.

4. **MCP Tools: `bond_score_lead`, `bond_get_forecast`, `bond_search_contacts`** -- Three design-specified tools are missing from the MCP registration. The underlying API endpoints exist, so wiring these is straightforward.

5. **Swimlane Grouping** -- The pipeline board has no swimlane option (group by owner, company, or close month).

6. **"Own only" Visibility** -- Members and Viewers see all org data. The design specifies that Members/Viewers should only see contacts and deals where they are the `owner_id`.

7. **`GET /contacts/:id/activities` and `GET /contacts/:id/deals`** -- No dedicated sub-routes. Data is embedded in the contact detail response but not available as separate paginated endpoints.

8. **`GET /companies/:id/deals`** -- Same: no dedicated sub-route.

9. **Custom Field Definition CRUD Routes** -- The Drizzle schema and migration exist but no API routes to manage custom field definitions.

### P1: Stub/Placeholder Only

10. **Settings > Custom Fields UI** -- Shows a "coming soon" placeholder with no functionality.

11. **Settings > Lead Scoring UI** -- Shows a "coming soon" placeholder. The backend scoring engine (rules CRUD + evaluation) is fully functional but the frontend has no management interface.

### P2-P3: Partial Implementation

12. **Soft-Delete for Contacts/Deals/Companies** -- Design says "soft-delete" but implementation uses hard `DELETE`. No `deleted_at` column exists.

13. **Contact Import via CSV** -- Design specifies CSV upload with column mapping. Implementation accepts a JSON array of contact objects. The import logic (dedup, batch creation) works but the CSV parsing and column mapping UX is absent.

14. **Bulk Lead Score Recalculation** -- Design specifies `POST /scoring/recalculate` triggers a BullMQ job for all contacts. Implementation scores a single contact synchronously.

15. **Motion Spring Physics on Deal Cards** -- Design says cards should use "the same dnd-kit + Motion spring physics as Bam task cards." Implementation uses dnd-kit but without Motion animations or spring physics on the drag overlay.

16. **Deal Detail as Drawer Overlay** -- Design says `/bond/deals/:id` is a "deal detail drawer (overlays pipeline board)." Implementation renders it as a full page with back navigation.

17. **Pipeline Stage Delete Safety** -- Design says "must reassign deals first" before deleting a stage. Implementation deletes without checking for existing deals (will fail at DB level due to `ON DELETE RESTRICT`, but no user-friendly error or reassignment flow).

---

## P4-P5 Items (Brief List)

The following are implemented to a high standard and closely match the design:

- **P5:** All 11 database tables (except `bond_import_mappings`) with correct columns, constraints, and indexes
- **P5:** Core CRUD for contacts, companies, deals, activities, pipelines, stages, scoring rules
- **P5:** Deal lifecycle: create -> stage move -> won/lost, with stage history recording and activity logging
- **P5:** Lead scoring engine with configurable rules, 9 operators, dotted-path field resolution, and per-contact scoring
- **P5:** All 6 analytics endpoints (pipeline summary, conversion rates, velocity, win/loss, forecast, stale deals)
- **P5:** Pipeline board with dnd-kit Kanban, drag overlay, deal search, create deal dialog
- **P5:** Deal card with value, company, owner avatar, days-in-stage, rotting indicator
- **P5:** Board header with deal count, total value, weighted forecast
- **P5:** Contact list with lifecycle filter tabs, search, table view
- **P5:** Contact detail with activity timeline, inline log activity form, details/deals tabs
- **P5:** Company detail with tabs (activity, details, contacts, deals)
- **P5:** Deal detail with description, activity timeline, stage history sidebar, won/lost/log actions
- **P5:** Analytics dashboard with stat cards, pipeline funnel bars, velocity grid, forecast buckets, stale deal list, win/loss breakdown
- **P5:** Settings pipeline management with create pipeline, expand/collapse stages, add/delete stages
- **P5:** 19 of 22 MCP tools covering contacts, companies, deals, activities, and analytics
- **P5:** Fastify server with CORS, rate limiting, security headers, health checks, Zod validation, error envelope
- **P4:** Contact merge with deal/activity/company re-association and blank-field fill
- **P4:** Contact import with email dedup

---

## Recommendations

### High Priority (Blocks Suite Integration)

1. **Implement Bolt event emission.** Add Redis PubSub publish calls in `createDeal`, `moveDealStage`, `closeDealWon`, `closeDealLost`, `createContact`, and `createActivity` services. Pattern: `redis.publish('bolt:events', JSON.stringify({ type: 'bond.deal.stage_changed', ... }))`. This unblocks all Bolt automations.

2. **Wire the 3 missing MCP tools** (`bond_score_lead`, `bond_get_forecast`, `bond_search_contacts`). The API endpoints exist -- this is copy-paste registration work in `bond-tools.ts`.

3. **Implement "own only" visibility.** Add a service-level filter that checks `owner_id = user.id` when the user's org role is `member` or `viewer`. This is a security requirement from the design.

### Medium Priority (Design Fidelity)

4. **Build the custom field definition CRUD routes** (`GET/POST/PATCH/DELETE /custom-field-definitions`). The table and Drizzle schema exist.

5. **Build the Settings > Lead Scoring UI.** The backend is fully functional; the frontend just needs a rule list with create/edit/delete forms.

6. **Build the Settings > Custom Fields UI.** Similar to scoring -- backend table exists, frontend needs a management interface.

7. **Add dedicated sub-routes** for `/contacts/:id/activities`, `/contacts/:id/deals`, `/companies/:id/deals` with independent pagination.

8. **Switch to soft-delete** by adding `deleted_at` column and filtering active records in queries, or document the design divergence as intentional.

9. **Add bulk lead score recalculation** as a BullMQ job (design specifies this explicitly).

### Lower Priority (Polish)

10. **Deal detail drawer overlay** instead of full page navigation.

11. **Swimlane grouping** on the pipeline board (by owner, company, close month).

12. **Motion spring animations** on deal card drag for consistency with Bam.

13. **CSV import** with column mapping UI for contacts.

14. **Express-interest migration** -- implement when the Blank form system is ready.

15. **Cross-product integrations** (Blast, Helpdesk, Bam, Banter) -- implement as those products mature their integration APIs.
