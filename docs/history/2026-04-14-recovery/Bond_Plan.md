# Bond Implementation Plan (2026-04-14)

## Scope

Bond is 88% complete at `f5fb079`. Core backend and frontend pages are functional. Four areas need closure: express-interest migration infrastructure (P0), cross-product integration scaffolding (P0-P1), additional API sub-routes (P0), frontend and UX refinements (P1-P2).

**In scope:** `POST /import/express-interest` endpoint + `bond_import_mappings` table; cross-product integration scaffolding (Blast lead sync, Helpdesk ticket linking, Bam task creation, Banter notifications, Blank form routing); `GET /companies/:id/deals` sub-route; soft-delete for contacts/deals/companies; CSV import with column mapping; deal detail drawer overlay; bulk lead score recalculation job; swimlane grouping; scoring rule visual builder UI.

**Out of scope:** Motion spring physics alignment, performance review integration, territory management, advanced sales forecasting models.

**Event naming note:** The `bond-stale-deals.job.ts` worker's rename from `bond.deal.rotting` to `deal.rotting` is owned by `Bolt_Plan.md` (G3), not this plan. Bond does not touch the event name here.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | Express-interest migration: endpoint + `bond_import_mappings` table |
| G2 | P0 | audit §Missing P0 item 2 | Cross-product integration scaffolding (Blast, Helpdesk, Bam, Banter, Blank) |
| G3 | P0 | audit §Missing P0 item 3 | `GET /companies/:id/deals` sub-route with pagination |
| G4 | P1 | audit §Missing P1 item 1 | Soft-delete with `deleted_at` column for contacts, deals, companies |
| G5 | P1 | audit §Missing P1 item 2 | CSV import for contacts with column mapping |
| G6 | P1 | audit §Missing P1 item 3 | Deal detail as drawer overlay on pipeline board |
| G7 | P1 | audit §Missing P1 item 4 | Bulk lead score recalculation BullMQ job |
| G8 | P1 | audit §Missing P1 item 5 | Swimlane grouping on pipeline board |
| G9 | P2 | audit §Missing P2 item | Scoring rule visual builder UI in settings |

## Migrations

**Reserved slots: 0099, 0100.**

### 0099_bond_import_mappings.sql

**Body:**
```sql
-- 0099_bond_import_mappings.sql
-- Why: Support express-interest data migration by tracking source-to-Bond entity mappings. Prevents duplicate imports, enables audit trail, allows future import-from-other-systems workflows.
-- Client impact: additive only. New table for import tracking.

CREATE TABLE IF NOT EXISTS bond_import_mappings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_system       VARCHAR(60) NOT NULL,
    source_id           VARCHAR(255) NOT NULL,
    bond_entity_type    VARCHAR(20) NOT NULL,
    bond_entity_id      UUID NOT NULL,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, source_system, source_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bond_import_mappings_entity_type_check') THEN
    ALTER TABLE bond_import_mappings
      ADD CONSTRAINT bond_import_mappings_entity_type_check
      CHECK (bond_entity_type IN ('contact', 'company', 'deal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bond_import_mappings_org ON bond_import_mappings(organization_id);
CREATE INDEX IF NOT EXISTS idx_bond_import_mappings_source ON bond_import_mappings(organization_id, source_system, source_id);
CREATE INDEX IF NOT EXISTS idx_bond_import_mappings_entity ON bond_import_mappings(bond_entity_type, bond_entity_id);
```

### 0100_bond_soft_delete.sql

**Body:**
```sql
-- 0100_bond_soft_delete.sql
-- Why: Support soft-delete for contacts, deals, and companies with audit trail and 90-day restoration window. Aligns with design spec section 9.
-- Client impact: expand-contract step 1 of 2. Columns default NULL; queries must filter WHERE deleted_at IS NULL.

ALTER TABLE bond_contacts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE bond_deals
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE bond_companies
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bond_contacts_active
  ON bond_contacts(organization_id, deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bond_deals_active
  ON bond_deals(organization_id, deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bond_companies_active
  ON bond_companies(organization_id, deleted_at)
  WHERE deleted_at IS NULL;
```

## Schemas and shared types

- `apps/bond-api/src/db/schema/bond-contacts.ts` (update) — add `deleted_at: timestamp('deleted_at', { withTimezone: true })`.
- Same for `bond-deals.ts` and `bond-companies.ts`.
- `apps/bond-api/src/db/schema/bond-import-mappings.ts` (new) — Drizzle table matching migration 0099.
- `apps/bond-api/src/db/schema/index.ts` (update) — export new table.

## API routes and services

### New routes

- `POST /import/express-interest` (G1) — Multipart form with CSV file + JSON column mapping. Uses `import.service.ts` to parse, dedupe via mappings lookup, batch-insert contacts/companies, record mappings. Returns `{ imported, duplicates_skipped, errors }`.
- `GET /companies/:id/deals` (G3) — Paginated deals list. Accepts `?limit=50&offset=0&sort=-expected_close_date`. Filters `WHERE deleted_at IS NULL`. Returns `{ deals, total_count, total_value }`.
- `GET /contacts/:id/restore` and `GET /deals/:id/restore` and `GET /companies/:id/restore` (G4) — Unset `deleted_at`. Admin-only.

### Route updates

- `DELETE /contacts/:id`, `/deals/:id`, `/companies/:id` (G4) — change from hard DELETE to `UPDATE SET deleted_at = NOW()`.

### New services

- `apps/bond-api/src/services/import.service.ts` (new, G1) — `importExpressInterest(csvBuffer, columnMapping, orgId, userId)`. CSV parse via `csv-parse` library. Dedup via `bond_import_mappings` lookup by `(source_system, source_id)`. Batch inserts. Per-row error tolerance.

### Service updates

- `contact.service.ts`, `deal.service.ts`, `company.service.ts` (G4) — add `WHERE deleted_at IS NULL` to all list/get queries. Update delete functions to soft-delete. Add restore functions.
- `company.service.ts getCompanyDeals(companyId, orgId, limit, offset)` (G3).
- `scoring.service.ts recalculateAllLeadScores(orgId)` (G7) — load all rules, iterate contacts, evaluate rules via `evalCondition()`, batch update `lead_score`.

## Frontend pages and components

### New components and pages

- `apps/bond/src/pages/ImportPage.tsx` (G5) — Drag-and-drop CSV upload. Preview first 3 rows. Visual column mapper (dropdowns to map CSV columns to contact fields). Submit to `/import/express-interest`. Progress bar + result summary.
- `apps/bond/src/components/DealDetailDrawer.tsx` (G6) — Refactor existing deal-detail page into right-side 500px drawer. Close on ESC or click outside. Overlay on pipeline board. Same content (contacts tab, activities tab, stage history tab).
- `apps/bond/src/components/ScoringRuleBuilder.tsx` (G9) — Visual form editor in `/bond/settings/scoring`: rule name input, condition field dropdown, operator dropdown, value input, score delta spinner. Preview line. Save/update/delete.

### Page updates

- `apps/bond/src/pages/PipelineBoard.tsx` (G6, G8) — Click deal opens `DealDetailDrawer` instead of routing to full-page detail. Add swimlane grouping radio buttons (None, Owner, Company, Close Month). Group cards per selection.
- `apps/bond/src/pages/CompanyDetailPage.tsx` (G3) — Add "Deals" tab that calls paginated `/companies/:id/deals` endpoint.
- `apps/bond/src/pages/ContactListPage.tsx`, `CompanyListPage.tsx` (G4) — Add "Include deleted" toggle. Default off. When on, show soft-deleted with muted styling + restore button.

## Worker jobs

### `apps/worker/src/jobs/bond-bulk-lead-scoring.job.ts` (new, G7)

Payload: `{ org_id?: string }`.

Pipeline:
1. If org_id provided, scope to that org; otherwise iterate all orgs.
2. For each org: load all active scoring rules, load all non-deleted contacts.
3. For each contact: evaluate all rules via `evalCondition()`, sum score deltas into new `lead_score`.
4. Batch UPDATE `bond_contacts SET lead_score = ..., updated_at = NOW()` if score changed.
5. Log summary: scored count, changed count, avg score.

Trigger: daily at 01:00 UTC via BullMQ repeating job, or on-demand from `POST /scoring/recalculate-all` endpoint.

## MCP tools

No new tools required. Existing 22 Bond tools remain. Optional:
- `bond_import_contacts_csv(file, mapping, dryRun?)` — wraps import endpoint with optional preview.
- `bond_restore_contact(contactId)`, `bond_restore_deal`, `bond_restore_company` — undelete soft-deleted entities.

## Tests

- `apps/bond-api/src/routes/__tests__/import.test.ts` (new, G1) — CSV parsing, dedup, mapping storage, batch insert, error tolerance.
- `apps/bond-api/src/services/__tests__/import.service.test.ts` (new, G1).
- `apps/bond-api/src/routes/__tests__/companies.test.ts` (update, G3) — `/companies/:id/deals` pagination and sorting.
- `apps/bond-api/src/services/__tests__/contact.service.test.ts` (update, G4) — soft-delete, restore, list filter, include_deleted flag.
- `apps/bond-api/src/jobs/__tests__/bond-bulk-lead-scoring.test.ts` (new, G7) — rule evaluation, score accumulation, batch update, org scoping.
- `apps/bond/src/pages/__tests__/ImportPage.test.tsx` (new, G5).
- `apps/bond/src/components/__tests__/DealDetailDrawer.test.tsx` (new, G6).
- `apps/bond/src/components/__tests__/PipelineBoard.test.tsx` (update, G8) — swimlane grouping.
- `apps/bond/src/components/__tests__/ScoringRuleBuilder.test.tsx` (new, G9).

## Verification steps

```bash
pnpm --filter @bigbluebam/bond-api build
pnpm --filter @bigbluebam/bond-api typecheck
pnpm --filter @bigbluebam/bond-api test
pnpm --filter @bigbluebam/bond typecheck
pnpm --filter @bigbluebam/bond test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-bond-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55491:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55491/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55491/verify' pnpm db:check
docker rm -f bbb-bond-verify
```

**Live smoke tests:** upload express-interest CSV with 5 contacts (3 existing, 2 new), verify 2 imported; navigate to company detail, click "Deals" tab, verify paginated list; soft-delete a contact, verify hidden from list, toggle "Include deleted", verify shown, restore, verify back; click deal on pipeline board, verify drawer opens; toggle swimlane to Owner, verify grouping; create scoring rule "lifecycle_stage = lead, +10 points", verify saved and applied.

## Out of scope

Motion spring physics, territory management, commission tracking, advanced forecasting, custom field formula/roll-up types, Bond listening to Bam `task.completed` for deal progress, mobile app, real-time WebSocket push.

## Dependencies

- **`csv-parse` library:** for G1 CSV parsing.
- **Blast API client:** for G2 list-segmentation (Blast team provides endpoint).
- **Banter API client:** for G2 channel-post integration.
- **Bam API:** already integrated.
- **Bolt event ingest:** already working.
- **Blank form builder:** G2 cross-team coordination.

**Migration numbers claimed: 0099, 0100.** No unused slots.
