# Bond Dossier (CRM)

Research dossier for the help writer. All claims are grounded in code; file paths
are cited inline. Items that come only from docs/marketing and are not confirmed
in code are flagged.

---

## 1. App identity

- **App key:** `bond`
- **Display name:** Bond
- **Category:** CRM (contacts, companies, deals, pipeline)
- **SPA path:** `/bond/` (React SPA in `apps/bond/src`)
- **API path:** `/bond/api/` -> bond-api Fastify service, internal port `:4009`,
  routes registered under prefix `/v1` (`apps/bond-api/src/server.ts:106-116`).
- **Backend dir:** `apps/bond-api/src`
- **Frontend dir:** `apps/bond/src`
- **MCP tools:** `apps/mcp-server/src/tools/bond-tools.ts` (22) plus
  `bond_find_duplicates` in `apps/mcp-server/src/tools/dedupe-tools.ts`.
- **Prerequisites:**
  - Authenticated to the platform. Unauthenticated SPA shows "Please log in to
    BigBlueBam first to access Bond." + "Go to BigBlueBam Login" -> `/b3/`
    (`apps/bond/src/app.tsx:143-155`).
  - At least one pipeline must exist before deals can be created; otherwise the
    board shows "No pipeline selected" + Create Pipeline button
    (`apps/bond/src/components/pipeline/pipeline-board.tsx:205-219`).
  - Org-scoped; the header OrgSwitcher changes org context.

### Roles and visibility (user-facing consequences)
- Per-action gates via `fastify.requireCan('bond.<entity>.<action>')`
  (`apps/bond-api/src/plugins/permissions.ts`, shared `@bigbluebam/permissions`).
- "Own only" visibility: roles `member` and `viewer` only see deals/contacts they
  own; admins/owners see the whole org. Applied on deal list/get/related/
  stage-history, contact list, and duplicates
  (`apps/bond-api/src/routes/deals.routes.ts:82-90,118-124,316-325`;
  `contacts.routes.ts:97-105`; `dedupe.routes.ts:31-39`).
- Scope tiers: most writes need `read_write`; pipeline/stage/scoring-rule/
  custom-field/import-mapping admin need `admin`; contact bulk import needs
  `admin`.

---

## 2. Key concepts and vocabulary

- **Contact** -- a person. Identity (first/last name, email, phone, title,
  avatar), classification (`lifecycle_stage`, `lead_source`, `lead_score`),
  address, custom fields, owner. `apps/bond-api/src/db/schema/bond-contacts.ts`.
- **Lifecycle stage** enum: `subscriber`, `lead`, `marketing_qualified`,
  `sales_qualified`, `opportunity`, `customer`, `evangelist`, `other` (default
  `lead`) (`contacts.routes.ts:11-14`). Create-contact UI labels
  marketing_qualified/sales_qualified as MQL/SQL
  (`create-contact-dialog.tsx:8-17`).
- **Lead score** -- integer cached on contact (default 0), clamped 0-100.
- **Company** -- name, domain, industry, `size_bucket`
  (`1-10`,`11-50`,`51-200`,`201-1000`,`1001-5000`,`5000+`), annual_revenue,
  phone, website, logo, address, custom fields, owner.
  `apps/bond-api/src/db/schema/bond-companies.ts`.
- **Pipeline** -- ordered stages + currency + optional `is_default`.
  `bond-pipelines.ts`.
- **Pipeline stage** -- name, `sort_order`, `stage_type`
  (`active`|`won`|`lost`, default `active`), `probability_pct` (0-100),
  `rotting_days` (nullable), `color`. `bond-pipeline-stages.ts`.
- **Deal** -- name, description, `value` (bigint cents), `currency` (default
  USD), `expected_close_date`, `probability_pct`, `weighted_value` (GENERATED =
  value*probability/100, read-only), outcome (`closed_at`, `close_reason`,
  `lost_to_competitor`), owner, company, custom fields, `stage_entered_at`,
  `last_activity_at`, `rotting_alerted_at`. `bond-deals.ts`.
- **Deal outcome:** open = `closed_at IS NULL`. Won -> moved to a `won`-type
  stage, `closed_at` set, probability forced 100
  (`deal.service.ts:665-734`). Lost -> moved to a `lost`-type stage, probability
  forced 0 (analogous block). UI badge: closed + close_reason -> "Lost", closed
  without -> "Won", else "Open" (`deal-detail.tsx:73-79`).
- **Stage history** -- append-only `from_stage_id`/`to_stage_id`/`changed_by`/
  `changed_at`/`duration_in_stage`. `bond-deal-stage-history.ts`.
- **Activity** -- polymorphic timeline entry on contact and/or deal and/or
  company. Types: `note`, `email_sent`, `email_received`, `call`, `meeting`,
  `task`, `stage_change`, `deal_created`, `deal_won`, `deal_lost`,
  `contact_created`, `form_submission`, `campaign_sent`, `campaign_opened`,
  `campaign_clicked`, `custom` (`activities.routes.ts:10-14`).
  `bond-activities.ts`.
- **Rotting / stale deal** -- open deal whose days-in-stage exceeds the stage's
  `rotting_days`. Orange card (rotting) / red (severe, >1.5x)
  (`deal-card.tsx:30-31,45-46`); shown on Analytics; daily worker emits
  `deal.rotting`.
- **Lead scoring rule** -- `condition_field`/`condition_operator`/
  `condition_value` + `score_delta` + `enabled`. Operators: equals, not_equals,
  contains, gt, lt, gte, lte, exists, not_exists (`scoring.routes.ts:10-22`).
- **Custom field definition** -- per entity (`contact`|`company`|`deal`):
  `field_key`, `label`, `field_type`
  (text,number,date,select,multi_select,url,email,phone,boolean), `options`,
  `required`, `sort_order` (`custom-fields.routes.ts:10-31`).
- **Import mapping** -- `(source_system, source_id) -> (bond_entity_type,
  bond_entity_id)` dedup record (`imports.routes.ts`).
- **Dedupe / duplicate candidate** -- ranked likely-duplicate contacts with
  confidence + signals (email exact 0.8, phone exact 0.7, name trigram) + prior
  human decision (`dedupe.service.ts`).
- **Soft delete** -- contacts/companies/deals carry `deleted_at`; delete is soft
  and most entities restore (migration `0100_bond_soft_delete.sql`).

---

## 3. Backend REST routes (complete)

All under `/bond/api/v1`. Success returns `{ data }` (lists `{ data, meta }`
with `meta.total`); errors use the platform error envelope.

### Contacts -- `apps/bond-api/src/routes/contacts.routes.ts`
| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/contacts` | List/filter | filters: lifecycle_stage, lead_source, owner_id, company_id, lead_score_min/max, search, include_deleted, limit, offset, sort. Own-only member/viewer. |
| POST | `/contacts` | Create | bond.contact.create, read_write, 20/min. |
| GET | `/contacts/search` | Search name/email/phone | q, limit; 30/min; ranked by lead score. |
| POST | `/contacts/upsert` | Idempotent by email | bond.contact.upsert, read_write, 60/min. Key (org, lower(email)); resurrects soft-deleted. Returns {data, created, idempotency_key}; 201 insert / 200 update. Emits contact.upserted. |
| POST | `/contacts/import` | Bulk JSON import 1-5000 | bond.contact.import, admin, 5/min. |
| GET | `/contacts/export` | Export all | bond.contact.list. |
| GET | `/contacts/:id` | Detail | includes deal_count, company_name, owner_name. |
| PATCH | `/contacts/:id` | Update | bond.contact.update. |
| DELETE | `/contacts/:id` | Soft-delete | bond.contact.delete. |
| POST | `/contacts/:id/restore` | Undelete | bond.contact.restore. |
| POST | `/contacts/:id/merge` | Merge source_id into target | bond.contact.merge. Target absorbs deals/activities/companies; source soft-deleted. |
| GET | `/contacts/:id/duplicates` | Ranked duplicates | (dedupe.routes.ts) limit<=50, min_confidence 0-1 (default 0.3); 30/min; own-only member/viewer. |

### Companies -- `companies.routes.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/companies` | List/filter (industry, size_bucket, owner_id, search, include_deleted) |
| POST | `/companies` | Create (bond.company.create, 20/min) |
| GET | `/companies/search` | Search name/domain (q, limit, 30/min) |
| GET | `/companies/:id` | Detail (contact_count, deal_count, owner_name) |
| PATCH | `/companies/:id` | Update |
| DELETE | `/companies/:id` | Soft-delete |
| GET | `/companies/:id/contacts` | Contacts at company |
| GET | `/companies/:id/deals` | Paginated deals at company |
| POST | `/companies/:id/restore` | Undelete |

### Pipelines and stages -- `pipelines.routes.ts` (stage CRUD all require admin scope)
| Method | Path | Purpose |
|---|---|---|
| GET | `/pipelines` | List (with stages) |
| POST | `/pipelines` | Create (admin; optional stages[]) |
| GET | `/pipelines/:id` | Detail |
| PATCH | `/pipelines/:id` | Update (name, description, is_default, currency) |
| DELETE | `/pipelines/:id` | Delete |
| GET | `/pipelines/:id/stages` | List stages |
| POST | `/pipelines/:id/stages` | Create stage (name, sort_order, stage_type, probability_pct, rotting_days, color) |
| PATCH | `/pipelines/:id/stages/:stageId` | Update stage |
| DELETE | `/pipelines/:id/stages/:stageId` | Delete stage |
| POST | `/pipelines/:id/stages/reorder` | Reorder (stage_ids[]) |

### Deals -- `deals.routes.ts`
| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/deals` | List/filter | pipeline_id, stage_id, owner_id, company_id, value_min/max, expected_close_after/before, stale, search, include_deleted. Own-only member/viewer. |
| POST | `/deals` | Create | read_write, 20/min. Probability defaults to stage probability. Emits deal.created. |
| GET | `/deals/:id` | Detail | company_name, owner_name, weighted_value, stage_entered_at. |
| PATCH | `/deals/:id` | Update | Emits deal.updated. |
| DELETE | `/deals/:id` | Soft-delete | |
| POST | `/deals/:id/restore` | Undelete | |
| PATCH | `/deals/:id/stage` | Move stage (stage_id) | Records history; emits deal.stage_changed. |
| POST | `/deals/:id/won` | Close won (close_reason?) | Moves to won-type stage, probability=100. Emits deal.won. |
| POST | `/deals/:id/lost` | Close lost (close_reason?, lost_to_competitor?) | Moves to lost-type stage, probability=0. Emits deal.lost. |
| POST | `/deals/:id/duplicate` | Duplicate into first stage | bond.deal.duplicate. |
| GET | `/deals/:id/contacts` | List deal contacts | |
| POST | `/deals/:id/contacts` | Add contact (contact_id, role?) | |
| DELETE | `/deals/:id/contacts/:contactId` | Remove contact | |
| GET | `/deals/:id/stage-history` | Stage transitions | |
| GET | `/deals/:id/activities` | Deal activity timeline | |
| GET | `/deals/:id/related` | Cross-app: Bill invoices, Book events, Bam tasks | each best-effort/empty on failure. |

### Activities -- `activities.routes.ts`
GET `/activities` (filter contact_id/deal_id/company_id/activity_type), POST
`/activities` (emits activity.logged), GET/PATCH/DELETE `/activities/:id`.

### Lead scoring -- `scoring.routes.ts`
GET `/scoring-rules`, POST (admin), PATCH `/:id` (admin), DELETE `/:id` (admin),
POST `/scoring/recalculate` (contact_id; read_write, 10/min).

### Analytics -- `analytics.routes.ts` (read-only, auth)
| Path | Returns |
|---|---|
| `/analytics/pipeline-summary` | per-stage {deal_count,total_value,weighted_value} + totals (pipeline_id?) |
| `/analytics/conversion-rates` | stages + transition counts (pipeline_id REQUIRED, date range) |
| `/analytics/deal-velocity` | avg days per stage + avg cycle days (pipeline_id REQUIRED) |
| `/analytics/forecast` | total weighted + buckets next_30/60/90/beyond/no_date (pipeline_id?) |
| `/analytics/stale-deals` | {stale_deals[], count} (pipeline_id?) |
| `/analytics/win-loss` | win rate, won/lost counts and value, loss reasons, competitors |

### Custom fields -- `custom-fields.routes.ts`
GET `/custom-field-definitions` (filter entity_type), GET `/:id`, POST (admin),
PATCH `/:id` (admin), DELETE `/:id` (admin).

### Imports -- `imports.routes.ts`
POST `/imports/mappings` (admin), GET `/imports/mappings`. File comment notes
full CSV-upload-with-column-mapping is deferred (P1) -- this is a mapping
primitive only.

### Bolt events emitted (source `bond`)
`deal.created`, `deal.updated`, `deal.stage_changed`, `deal.won`, `deal.lost`
(`deal.service.ts`), `contact.created` (`contact.service.ts`),
`contact.upserted` (`contact-upsert.service.ts`), `activity.logged`
(`activity.service.ts`), `deal.rotting` (worker
`bond-stale-deals.job.ts:113-114`).

---

## 4. Frontend inventory (views, panels, dialogs, actions)

Custom history-pushState routing in `apps/bond/src/app.tsx` (base `/bond`).
Layout chrome (`bond-layout.tsx`): Launchpad app switcher, breadcrumbs,
OrgSwitcher, notifications bell, user menu. Sidebar logo reads "Bond".

### Sidebar nav (exact labels) -- `bond-sidebar.tsx:23-29`
- **Pipeline Board** -> `/`
- **Contacts** -> `/contacts`
- **Companies** -> `/companies`
- **Analytics** -> `/analytics`
- **Bond Settings** -> `/settings/pipelines`
- Top-of-sidebar **pipeline scope selector** dropdown (active pipeline name or
  "Default Pipeline"; "No pipelines found" empty). Sets global active pipeline.
- `?` key opens the in-app Help viewer (`app.tsx:117-128`).

### View: Pipeline Board (`/`, `/pipelines/:id`)
`pages/pipeline-board.tsx` -> `pipeline-board.tsx`, `stage-column.tsx`,
`deal-card.tsx`, `create-deal-dialog.tsx`.
- Header: pipeline name; summary "N deals | Total: $X | Weighted: $Y".
- **Group** control (swimlanes): label "Group" + buttons **None**, **Owner**,
  **Close month** (`pipeline-board.tsx:243-261`). Owner lanes by owner name
  ("Unassigned" last); Close-month lanes by YYYY-MM ("No close date").
- Search "Search deals..." (client filter on deal + company name).
- **Add Deal** (top-right) opens Create Deal at first stage.
- Stage column: color dot, stage name, deal count, stage total value, **+**
  button ("Add deal to <stage>"). Deals drag between columns (dnd-kit) ->
  PATCH `/deals/:id/stage`.
- Deal card: name, company, value, close date, days-in-stage (Nd), owner avatar.
  Rotting: `deal-rotting` orange, `deal-rotting-severe` red (>1.5x).
- Empty: "No pipeline selected" + **Create Pipeline**.

### Dialog: Create Deal (`create-deal-dialog.tsx`)
"Create Deal" / "Add a new deal to the pipeline." Fields: **Deal Name**
(required), **Value ($)** (x100 to cents), **Expected Close Date**. Buttons
**Cancel** / **Create Deal**. Does NOT collect company/owner/probability/
currency/contacts (API/MCP only).

### View: Deal Detail (`/deals/:id`, `deal-detail.tsx`)
- Header: back, deal name, status badge (Open/Won/Lost), PresenceChipStrip. Meta:
  value, company link, close date, "N days in stage", owner.
- Actions (open only): **Won** (Trophy) and **Lost** (XCircle); **Log Activity**
  toggle; overflow (**Edit Deal** [empty handler -- no edit dialog], **Delete
  Deal**).
- Left: Description, inline Log Activity form, **Activity** timeline.
- Right (Details): Probability, Weighted Value, Created, Closed, Close Reason,
  Lost To. **Related** panel (Bill invoices #number+status, Book events, Bam
  tasks by human_id) from `/deals/:id/related`. **Stage History** (from->to,
  relative time, who, duration).

### View: Contacts list (`/contacts`, `contact-list.tsx`)
- Header: "Contacts", "N total", "Search contacts...", **Include deleted**,
  **Add Contact**.
- Lifecycle pills: All, Lead, Subscriber, MQL, Sales Qualified, Opportunity,
  Customer, Evangelist.
- Columns: Name (avatar+title), Email, Company, Stage badge, Score (star+num),
  Owner, Last Contact, [Status]. Deleted rows struck-through + **Restore**.
- Empty: "No contacts found" + **Add Contact**.

### Dialog: Create Contact (`create-contact-dialog.tsx`)
"Create Contact" / "Add a new contact to your CRM." Fields: First Name, Last
Name, Email, Phone, Job Title, Lifecycle Stage (Lead/Subscriber/MQL/SQL/
Opportunity/Customer/Evangelist/Other). Requires >=1 of first/last/email.
Buttons **Cancel** / **Create Contact**.

### View: Contact Detail (`/contacts/:id`, `contact-detail.tsx`)
- Header: back, avatar, name, title, company link, lifecycle badge, score star.
  Row: email (mailto), phone (tel), "N deals". Actions: **Log Activity**,
  overflow (**Edit Contact** [empty], **Create Deal** [empty], **Delete
  Contact**).
- Tabs: activity / details / deals. Details = Lead Source, Owner, City,
  State/Region, Country, Created, Last Contacted. Deals tab = text summary only.

### View: Companies list (`/companies`, `company-list.tsx`)
- Header: "Companies", "N total", "Search companies...", **Include deleted**,
  **Add Company**.
- Columns: Company (logo+name), Domain, Industry, Size, Revenue, Contacts, Deals,
  Owner, [Status]. Restore for deleted.
- Empty: "No companies found" + **Add Company**.

### Dialog: Create Company (`create-company-dialog.tsx`)
"Create Company". Fields: **Company Name** (required), Domain, Industry, Company
Size (bucket select), Website. Buttons **Cancel** / **Create Company**.

### View: Company Detail (`/companies/:id`, `company-detail.tsx`)
- Header: back, logo, name, industry badge, "<size> employees". Row: domain link,
  phone, location, "N contacts", "N deals", revenue. Actions: **Log Activity**,
  overflow (**Edit Company** [empty], **Delete Company**).
- Tabs: activity / details / contacts / deals. Details = Website, Owner, Address,
  Created. Contacts/Deals tabs are text summaries only.

### View: Analytics (`/analytics`, `analytics.tsx`)
Header "Analytics" / "<pipeline> overview". Effective pipeline = active ->
default -> first. Sections:
- Stat cards: **Total Pipeline**, **Weighted Forecast**, **Win Rate** (X%,
  "won won / lost lost"), **Stale Deals** ("Needs attention"/"All healthy").
- **Pipeline Stages** bars (active stages, count+value).
- **Average Deal Velocity (days per stage)** cards (avg days + sample count).
- **Stage Transitions** (from->to + count badge).
- **Revenue Forecast (weighted)**: Next 30/60/90 days, Beyond 90 days, No close
  date (non-zero only).
- **Stale Deals (N)** clickable rows (name, stage, Xd/Yd badge, value) -> deal.
- **Top Loss Reasons**, **Top Competitors**.
(Recently repaired; a real, working feature.)

### View: Bond Settings (`/settings/:tab`, `settings.tsx`)
Tabs: **Pipelines**, **Custom Fields**, **Lead Scoring**.
- Pipelines: list (expand to stages). **New Pipeline** ("Create Pipeline", field
  **Pipeline Name") seeds 6 default stages: Prospect(10), Qualified(25),
  Proposal(50), Negotiation(75), Closed Won(100, won), Closed Lost(0, lost).
  Stage rows: color dot, name, type badge Active/Won/Lost, probability%, "Nd rot"
  if set, delete. Inline **Add stage** (name + type select + **Add**). Drag
  handle shown but reorder NOT wired in UI (API only).
- Custom Fields: entity filter (All/Contact/Company/Deal), **New Field**
  ("Create Custom Field": Entity Type, Field Type, Label, Field Key [auto],
  Required, Options builder for select/multi_select). Grouped by entity; type
  badge, key code, options count, delete.
- Lead Scoring: explainer (scores clamped 0-100), **New Rule** ("Create Scoring
  Rule": Rule Name, Description, Condition [Field/Operator/Value], Score Delta
  [-100..100], Enabled). Rule rows = human sentence + +/-N pts + edit/delete.
  **Edit Scoring Rule** ("Save Changes"). No in-UI "recalculate" button.

### Inline form: Log Activity (`log-activity-form.tsx`)
Type select (Note/Email Sent/Email Received/Call/Meeting/Task), Subject input,
"Add details..." textarea, **Log Activity** button. On contact/company/deal
detail. Timeline renders icons+labels per activity type
(`activity-timeline.tsx`).

---

## 5. MCP tools

### In `bond-tools.ts` (22 tools, via registerBondTools)
Most write tools accept name-or-UUID (pipeline/stage name, contact email/name,
company name/domain, deal title fragment, owner email); ambiguous/missing matches
return a clean error instead of mutating.

- Contacts (5): `bond_list_contacts`, `bond_get_contact`, `bond_create_contact`,
  `bond_update_contact`, `bond_merge_contacts`.
- Upsert (1): `bond_upsert_contact` (-> `/contacts/upsert`).
- Companies (4): `bond_list_companies`, `bond_get_company`,
  `bond_create_company`, `bond_update_company`.
- Deals (7): `bond_list_deals`, `bond_get_deal`, `bond_create_deal`,
  `bond_update_deal`, `bond_move_deal_stage`, `bond_close_deal_won`,
  `bond_close_deal_lost`.
- Activities (1): `bond_log_activity`.
- Analytics (2): `bond_get_pipeline_summary`, `bond_get_stale_deals`.
- Lead scoring (1): `bond_score_lead` (-> `/scoring/recalculate`).
- Forecast (1): `bond_get_forecast`.
- Search (1): `bond_search_contacts`.

### Cross-cutting Bond tool
`bond_find_duplicates` (`dedupe-tools.ts:73`) -> GET `/contacts/:id/duplicates`;
also listed in `utility-tools.ts` catalog.

### Human-feature mapping
- create/move/close-deal tools <-> board card actions + deal-detail Won/Lost.
- create/update/merge/upsert contact <-> contact list/detail (merge has NO UI;
  tool/duplicate flow only).
- `bond_log_activity` <-> Log Activity form.
- `bond_score_lead` <-> scoring (no UI button).
- pipeline-summary/stale-deals/forecast <-> Analytics page.
- `bond_find_duplicates` <-> dedupe (no UI; backend+tool only).
- NO MCP tools for pipeline/stage CRUD, custom-field CRUD, scoring-rule CRUD,
  company delete, or contact/deal delete/restore -- those are UI/REST-only.

### Agent platform notes
- `bond_upsert_contact` is in the §14 idempotent write plane (emits
  contact.upserted with `created`).
- `bond_find_duplicates` + platform `dedupe_record_decision`/`dedupe_list_pending`
  form the §7 dedup loop (entity_type `bond.contact`).
- Cross-app read tools (search_everything, account_view, expertise_for_topic,
  bam_task_count_by_phrase, etc.) span Bond data but live outside this app.

---

## 6. Candidate user stories

1. **Set up a sales pipeline.** Settings -> Pipelines -> New Pipeline -> 6
   default stages -> expand to add/delete/tune stages.
2. **Add and qualify a contact.** Contacts -> Add Contact -> set lifecycle ->
   detail -> Log Activity (edit-lifecycle in UI is not wired; use API/tool).
3. **Create and progress a deal.** Board -> Add Deal -> drag across stages ->
   detail -> log activities -> mark Won/Lost (reason/competitor via API/tool).
4. **Work the board with swimlanes.** Group by Owner or Close month; search;
   spot orange/red rotting cards.
5. **Triage stale deals.** Analytics -> Stale Deals (or `bond_get_stale_deals`)
   -> open a deal -> log follow-up. Worker also emits `deal.rotting` to Bolt.
6. **Forecast revenue.** Analytics -> Weighted Forecast + 30/60/90/beyond
   buckets + win rate + loss reasons.
7. **Manage companies.** Companies -> Add Company -> detail (linked counts) ->
   log activities.
8. **Configure lead scoring.** Settings -> Lead Scoring -> New Rule -> recalc via
   `bond_score_lead` / `/scoring/recalculate`.
9. **Dedupe contacts.** `bond_find_duplicates` / `/contacts/:id/duplicates` ->
   review -> `bond_merge_contacts` / `/contacts/:id/merge`.
10. **Extend the schema.** Settings -> Custom Fields -> New Field per entity.
11. **Restore a delete.** List -> "Include deleted" -> **Restore**.
12. **Cross-app handoff.** Deal Related panel (Bill invoices, Book events, Bam
    tasks); Blast pulls Bond contacts into segments; Bench reports query Bond.

---

## 7. Agent flows
- Agents drive deal/contact/company CRUD, stage moves, won/lost, activity
  logging, lead scoring, analytics reads via bond-tools (name-or-UUID friendly).
- Idempotent ingestion via `bond_upsert_contact` (email natural key).
- Dedup loop: `bond_find_duplicates` -> decision -> `bond_merge_contacts`.
- Event-driven: Bond emits deal.*, contact.*, activity.logged, deal.rotting Bolt
  events for downstream rules.
- Own-only visibility enforced server-side for member/viewer service accounts.

---

## 8. Screenshots available
Light + dark pairs under `docs/apps/bond/screenshots/{light,dark}/` (1440x900;
metadata `docs/apps/bond/meta.json`):
- `01-pipeline.png` -- Pipeline board (stories 3-4).
- `02-contacts.png` -- Contacts list (story 2).
- `03-deal-detail.png` -- Deal detail / Won-Lost (story 3).
- `04-analytics.png` -- Analytics dashboard (stories 5-6).
- `05-companies.png` -- Companies list (story 7).

---

## 9. Discrepancies (docs/marketing vs code)
1. **Tool count.** CLAUDE.md says "23 Bond" tools; bond-tools.ts has **22**, the
   23rd (`bond_find_duplicates`) lives in dedupe-tools.ts. "23" only counts if
   the cross-cutting tool is included.
2. **`bond_upsert_contact` missing from docs.** Exists in code/tools but absent
   from `docs/apps/bond/mcp-tools.md` and `guide.md` (generated tables stale).
3. **Truncated merge description** in generated docs (`bond_merge_contacts` row
   cut off mid-sentence). Cosmetic generation artifact.
4. **"per pipeline" framing wrong.** guide.md/_narrative.md say custom fields and
   scoring rules are "configurable per pipeline". In code custom fields are per
   entity_type (org-wide) and scoring rules are org-wide -- NOT per pipeline.
5. **UI edit gaps (broken-feature flags).** "Edit Deal", "Edit Contact",
   "Create Deal" (contact menu), "Edit Company" have empty onSelect handlers --
   no edit dialog wired despite PATCH endpoints + update tools. Do not document
   as working UI.
6. **Import system.** Platform CLAUDE.md describes CSV/Trello/Jira/GitHub import;
   bond-api imports.routes.ts only exposes mapping primitives (full CSV deferred).
   Bond bulk import in-product is JSON `POST /contacts/import` only.
7. **Stage reorder + rotting-days/color editing** exist in the API but the
   Settings UI only supports stage create + delete; the drag handle is
   non-functional.

---

## 10. Open questions
1. Is in-app edit of deal/contact/company intended, or tool/REST-only for now?
   (Empty handlers suggest unfinished UI.)
2. Where is the dedupe/duplicate-review experience surfaced to humans? Only API
   + MCP tool exist; no Bond SPA screen consumes `/contacts/:id/duplicates`.
3. Contact/company "deals"/"contacts" tabs show counts but no lists -- planned,
   or document as "summary-only"?
4. Lead-score recalculation has no UI trigger; a worker `bond-bulk-score.job.ts`
   exists -- confirm whether scoring auto-runs vs only via `/scoring/recalculate`.
5. Does Create Deal intentionally omit company/owner/probability/contacts, or is
   that a UI gap vs the create endpoint?
