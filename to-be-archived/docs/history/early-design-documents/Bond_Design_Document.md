# Bond — CRM for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Bond (Customer Relationship Management)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Bond is the customer relationship management (CRM) platform for the BigBlueBam suite. It manages the full lifecycle of a customer relationship — from anonymous website visitor expressing interest, through prospect qualification and deal negotiation, to closed customer with ongoing account management.

Bond's origin story is practical: BigBlueBam already has an "express interest" signup flow that captures prospective user information into a separate database accessible only to SuperUser. Bond absorbs that flow and extends it into a proper CRM pipeline — one that lives inside the suite, shares its authentication and permission model, and can trigger Bolt automations, post to Banter channels, generate Brief documents, and send Blast email campaigns. The existing prospect data becomes the seed for Bond's contact database via a one-time migration.

Bond is deliberately **pipeline-centric, not contact-rolodex-centric.** The primary view is a Kanban board of deals flowing through stages — the same spatial, drag-and-drop metaphor that makes Bam intuitive for task management. Contacts and companies are supporting entities that provide context for deals, not the top-level organizing concept.

### 1.2 Core Principles

1. **Pipeline is the product.** The deal pipeline board is the primary interface. Everything else — contacts, companies, activities — exists to move deals forward.
2. **Suite-native.** Bond shares auth, database, Redis, and MCP infrastructure with every other B-product. A Bolt automation can react to a deal stage change. A Banter bot can post when a deal closes. An agent can draft a Brief proposal from deal context.
3. **AI-first prospecting.** MCP tools allow agents to score leads, enrich contacts, draft follow-ups, and flag stale deals. The same agent that triages Helpdesk tickets can qualify inbound interest signups.
4. **Express-interest absorption.** The existing external signup flow is replaced by a Bond-native capture form (or Blank form) that feeds directly into the Bond pipeline as a new lead.
5. **Blast integration.** Bond contacts can be segmented and pushed to Blast for email campaigns. Campaign engagement (opens, clicks) flows back to Bond as contact activity.
6. **Configurable, not prescribed.** Pipeline stages, deal fields, activity types, and lead scoring rules are all user-defined per organization. Bond does not assume a specific sales methodology.

### 1.3 Non-Goals

- Bond is **not** a full marketing automation platform. Campaign orchestration belongs in Blast. Bond provides the contact database and segmentation; Blast handles delivery and analytics.
- Bond is **not** a customer support tool. Post-sale support tickets belong in Helpdesk. Bond tracks the commercial relationship; Helpdesk tracks support interactions.
- Bond does **not** include built-in phone/VoIP integration at launch. Activity logging for calls is manual or via API. Banter voice channels are the suite's communication layer.
- Bond does **not** include territory management, commission tracking, or sales forecasting models at launch. These are future work.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  bond-api/           → Fastify REST API (contact/deal/pipeline CRUD, activity log, lead scoring)
  bond/               → React SPA (pipeline board, contact sheets, company profiles, activity feed)
```

Bond does **not** have its own database service or message queue. It uses the shared PostgreSQL, Redis, and BullMQ worker infrastructure.

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **bond-api** (Fastify :4007) | REST API for contacts, companies, deals, pipelines, activities, lead scoring |
| **PostgreSQL 16** | All CRM data (shared DB, `bond_` table prefix) |
| **Redis 7** | Session cache, deal pipeline real-time updates, lead score caching |
| **BullMQ Worker** | Background jobs: lead scoring recalculation, activity reminders, stale deal detection |
| **MCP Server** | Full CRM tool surface for AI agents |

### 2.3 nginx Routing

```nginx
location /bond/ {
    alias /usr/share/nginx/html/bond/;
    try_files $uri $uri/ /bond/index.html;
}

location /bond/api/ {
    proxy_pass http://bond-api:4007/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.4 Docker Service

```yaml
bond-api:
  build:
    context: .
    dockerfile: apps/bond-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
  ports:
    - "4007:4007"
  depends_on:
    - postgres
    - redis
    - mcp-server
```

---

## 3. Data Model

### 3.1 Entity Relationship Overview

```
organizations ──1:N──► bond_pipelines ──1:N──► bond_pipeline_stages
                │
                ├──1:N──► bond_contacts ──N:N──► bond_companies (via bond_contact_companies)
                │              │
                │              ├──1:N──► bond_activities
                │              │
                │              └──N:N──► bond_deals (via bond_deal_contacts)
                │
                └──1:N──► bond_deals ──────────► bond_pipeline_stages (current stage)
                               │
                               ├──1:N──► bond_activities
                               │
                               └──1:N──► bond_deal_custom_field_values
```

### 3.2 PostgreSQL Schema

```sql
-- ============================================================
-- BOND: Customer Relationship Management
-- ============================================================

-- Contacts: Individual people (leads, prospects, customers)
CREATE TABLE bond_contacts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Identity
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    email               VARCHAR(255),
    phone               VARCHAR(50),
    title               VARCHAR(150),           -- job title
    avatar_url          TEXT,

    -- Classification
    lifecycle_stage     VARCHAR(30) NOT NULL DEFAULT 'lead'
                        CHECK (lifecycle_stage IN (
                            'subscriber', 'lead', 'marketing_qualified',
                            'sales_qualified', 'opportunity', 'customer',
                            'evangelist', 'other'
                        )),
    lead_source         VARCHAR(60),            -- e.g., 'express_interest', 'website', 'referral', 'campaign'
    lead_score          INTEGER DEFAULT 0,      -- computed score, cached here for query performance

    -- Address
    address_line1       VARCHAR(255),
    address_line2       VARCHAR(255),
    city                VARCHAR(100),
    state_region        VARCHAR(100),
    postal_code         VARCHAR(20),
    country             VARCHAR(2),             -- ISO 3166-1 alpha-2

    -- Custom fields (schemaless JSONB for org-specific data)
    custom_fields       JSONB DEFAULT '{}',

    -- Ownership
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Metadata
    last_contacted_at   TIMESTAMPTZ,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_contacts_org ON bond_contacts(organization_id);
CREATE INDEX idx_bond_contacts_email ON bond_contacts(organization_id, email);
CREATE INDEX idx_bond_contacts_lifecycle ON bond_contacts(organization_id, lifecycle_stage);
CREATE INDEX idx_bond_contacts_owner ON bond_contacts(owner_id);
CREATE INDEX idx_bond_contacts_score ON bond_contacts(organization_id, lead_score DESC);
CREATE INDEX idx_bond_contacts_custom ON bond_contacts USING GIN (custom_fields);

-- Companies: Organizations that contacts belong to
CREATE TABLE bond_companies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    name                VARCHAR(255) NOT NULL,
    domain              VARCHAR(255),           -- e.g., 'acme.com' for enrichment matching
    industry            VARCHAR(100),
    size_bucket         VARCHAR(30)
                        CHECK (size_bucket IN ('1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+')),
    annual_revenue      BIGINT,                 -- stored in cents (USD)
    phone               VARCHAR(50),
    website             TEXT,
    logo_url            TEXT,

    address_line1       VARCHAR(255),
    address_line2       VARCHAR(255),
    city                VARCHAR(100),
    state_region        VARCHAR(100),
    postal_code         VARCHAR(20),
    country             VARCHAR(2),

    custom_fields       JSONB DEFAULT '{}',
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,

    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_companies_org ON bond_companies(organization_id);
CREATE INDEX idx_bond_companies_domain ON bond_companies(organization_id, domain);
CREATE INDEX idx_bond_companies_name ON bond_companies(organization_id, name);

-- Many-to-many: contacts ↔ companies
CREATE TABLE bond_contact_companies (
    contact_id          UUID NOT NULL REFERENCES bond_contacts(id) ON DELETE CASCADE,
    company_id          UUID NOT NULL REFERENCES bond_companies(id) ON DELETE CASCADE,
    role_at_company     VARCHAR(100),           -- e.g., 'CTO', 'Decision Maker', 'End User'
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, company_id)
);

-- Pipelines: configurable deal funnels
CREATE TABLE bond_pipelines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    is_default          BOOLEAN NOT NULL DEFAULT false,
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_pipelines_org ON bond_pipelines(organization_id);

-- Pipeline stages: ordered columns in the deal board
CREATE TABLE bond_pipeline_stages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES bond_pipelines(id) ON DELETE CASCADE,
    name                VARCHAR(100) NOT NULL,  -- e.g., 'Prospect', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'
    sort_order          INTEGER NOT NULL DEFAULT 0,
    stage_type          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (stage_type IN ('active', 'won', 'lost')),
    probability_pct     INTEGER DEFAULT 0       -- default win probability at this stage (0-100)
                        CHECK (probability_pct BETWEEN 0 AND 100),
    rotting_days        INTEGER,                -- days without activity before deal is flagged stale
    color               VARCHAR(7),             -- hex color for visual indicator
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_stages_pipeline ON bond_pipeline_stages(pipeline_id, sort_order);

-- Deals: the core object that flows through pipeline stages
CREATE TABLE bond_deals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pipeline_id         UUID NOT NULL REFERENCES bond_pipelines(id) ON DELETE RESTRICT,
    stage_id            UUID NOT NULL REFERENCES bond_pipeline_stages(id) ON DELETE RESTRICT,

    -- Deal info
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    value               BIGINT,                 -- deal value in cents
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    expected_close_date DATE,
    probability_pct     INTEGER                 -- override of stage default
                        CHECK (probability_pct BETWEEN 0 AND 100),
    weighted_value      BIGINT GENERATED ALWAYS AS (
                            CASE WHEN value IS NOT NULL AND probability_pct IS NOT NULL
                                 THEN (value * probability_pct) / 100
                                 ELSE NULL END
                        ) STORED,

    -- Outcome (set when deal reaches won/lost stage)
    closed_at           TIMESTAMPTZ,
    close_reason        TEXT,                   -- free-text explanation for win/loss
    lost_to_competitor  VARCHAR(255),           -- if lost, who won?

    -- Ownership
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Company association (primary company for this deal)
    company_id          UUID REFERENCES bond_companies(id) ON DELETE SET NULL,

    -- Custom fields
    custom_fields       JSONB DEFAULT '{}',

    -- Stage tracking
    stage_entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at    TIMESTAMPTZ,

    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_deals_org ON bond_deals(organization_id);
CREATE INDEX idx_bond_deals_pipeline ON bond_deals(pipeline_id, stage_id);
CREATE INDEX idx_bond_deals_owner ON bond_deals(owner_id);
CREATE INDEX idx_bond_deals_company ON bond_deals(company_id);
CREATE INDEX idx_bond_deals_close ON bond_deals(expected_close_date) WHERE closed_at IS NULL;
CREATE INDEX idx_bond_deals_stale ON bond_deals(stage_entered_at) WHERE closed_at IS NULL;

-- Many-to-many: deals ↔ contacts
CREATE TABLE bond_deal_contacts (
    deal_id             UUID NOT NULL REFERENCES bond_deals(id) ON DELETE CASCADE,
    contact_id          UUID NOT NULL REFERENCES bond_contacts(id) ON DELETE CASCADE,
    role                VARCHAR(60),            -- 'decision_maker', 'champion', 'influencer', 'end_user', 'blocker'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (deal_id, contact_id)
);

-- Activities: the shared activity log for contacts and deals
CREATE TABLE bond_activities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Polymorphic association: an activity relates to a contact, a deal, or both
    contact_id          UUID REFERENCES bond_contacts(id) ON DELETE CASCADE,
    deal_id             UUID REFERENCES bond_deals(id) ON DELETE CASCADE,
    company_id          UUID REFERENCES bond_companies(id) ON DELETE CASCADE,

    -- Activity data
    activity_type       VARCHAR(30) NOT NULL
                        CHECK (activity_type IN (
                            'note', 'email_sent', 'email_received',
                            'call', 'meeting', 'task', 'stage_change',
                            'deal_created', 'deal_won', 'deal_lost',
                            'contact_created', 'form_submission',
                            'campaign_sent', 'campaign_opened', 'campaign_clicked',
                            'custom'
                        )),
    subject             VARCHAR(255),
    body                TEXT,
    metadata            JSONB DEFAULT '{}',     -- activity-type-specific data

    -- Who performed the activity
    performed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    performed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Metadata
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_activities_contact ON bond_activities(contact_id, performed_at DESC);
CREATE INDEX idx_bond_activities_deal ON bond_activities(deal_id, performed_at DESC);
CREATE INDEX idx_bond_activities_company ON bond_activities(company_id, performed_at DESC);
CREATE INDEX idx_bond_activities_org ON bond_activities(organization_id, performed_at DESC);
CREATE INDEX idx_bond_activities_type ON bond_activities(activity_type);

-- Stage change history for deals (for pipeline analytics)
CREATE TABLE bond_deal_stage_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id             UUID NOT NULL REFERENCES bond_deals(id) ON DELETE CASCADE,
    from_stage_id       UUID REFERENCES bond_pipeline_stages(id),
    to_stage_id         UUID NOT NULL REFERENCES bond_pipeline_stages(id),
    changed_by          UUID REFERENCES users(id),
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_in_stage   INTERVAL                -- how long the deal was in the previous stage
);

CREATE INDEX idx_bond_stage_history_deal ON bond_deal_stage_history(deal_id, changed_at DESC);

-- Lead scoring rules (configurable per org)
CREATE TABLE bond_lead_scoring_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    -- Rule definition
    condition_field     VARCHAR(100) NOT NULL,   -- e.g., 'lifecycle_stage', 'lead_source', 'custom_fields.company_size'
    condition_operator  VARCHAR(20) NOT NULL
                        CHECK (condition_operator IN ('equals', 'not_equals', 'contains', 'gt', 'lt', 'gte', 'lte', 'exists', 'not_exists')),
    condition_value     TEXT NOT NULL,
    score_delta         INTEGER NOT NULL,        -- points to add (positive) or subtract (negative)
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bond_scoring_org ON bond_lead_scoring_rules(organization_id) WHERE enabled = true;

-- Custom field definitions (schema for org-specific fields)
CREATE TABLE bond_custom_field_definitions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity_type         VARCHAR(20) NOT NULL CHECK (entity_type IN ('contact', 'company', 'deal')),
    field_key           VARCHAR(60) NOT NULL,
    label               VARCHAR(100) NOT NULL,
    field_type          VARCHAR(20) NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'select', 'multi_select', 'url', 'email', 'phone', 'boolean')),
    options             JSONB,                   -- for select/multi_select: [{"value": "...", "label": "..."}]
    required            BOOLEAN NOT NULL DEFAULT false,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, entity_type, field_key)
);

-- Express-interest migration mapping (tracks legacy prospect imports)
CREATE TABLE bond_import_mappings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_system       VARCHAR(60) NOT NULL,    -- 'express_interest', 'csv', 'hubspot', etc.
    source_id           VARCHAR(255) NOT NULL,   -- ID in the source system
    bond_entity_type    VARCHAR(20) NOT NULL CHECK (bond_entity_type IN ('contact', 'company', 'deal')),
    bond_entity_id      UUID NOT NULL,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, source_system, source_id)
);
```

---

## 4. API Endpoints

### 4.1 Contacts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/contacts` | List contacts (paginated, filterable by lifecycle_stage, owner, company, lead_score range, custom_fields) |
| `POST` | `/bond/api/contacts` | Create a contact |
| `GET` | `/bond/api/contacts/:id` | Get contact detail (includes companies, deals, recent activities) |
| `PATCH` | `/bond/api/contacts/:id` | Update contact fields |
| `DELETE` | `/bond/api/contacts/:id` | Soft-delete a contact |
| `POST` | `/bond/api/contacts/:id/merge` | Merge duplicate contacts (target absorbs source's deals, activities, and company associations) |
| `POST` | `/bond/api/contacts/import` | Bulk import from CSV with column mapping |
| `GET` | `/bond/api/contacts/:id/activities` | Activity timeline for a contact |
| `GET` | `/bond/api/contacts/:id/deals` | Deals associated with a contact |

### 4.2 Companies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/companies` | List companies (paginated, filterable) |
| `POST` | `/bond/api/companies` | Create a company |
| `GET` | `/bond/api/companies/:id` | Company detail (includes contacts, deals, activities) |
| `PATCH` | `/bond/api/companies/:id` | Update company fields |
| `DELETE` | `/bond/api/companies/:id` | Soft-delete a company |
| `GET` | `/bond/api/companies/:id/contacts` | Contacts at this company |
| `GET` | `/bond/api/companies/:id/deals` | Deals with this company |

### 4.3 Pipelines & Stages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/pipelines` | List pipelines for the org |
| `POST` | `/bond/api/pipelines` | Create a pipeline with stages |
| `GET` | `/bond/api/pipelines/:id` | Pipeline detail including stages |
| `PATCH` | `/bond/api/pipelines/:id` | Update pipeline metadata |
| `POST` | `/bond/api/pipelines/:id/stages` | Add a stage |
| `PATCH` | `/bond/api/pipelines/:id/stages/:stageId` | Update stage (name, order, probability, rotting_days) |
| `DELETE` | `/bond/api/pipelines/:id/stages/:stageId` | Remove stage (must reassign deals first) |
| `POST` | `/bond/api/pipelines/:id/stages/reorder` | Bulk reorder stages |

### 4.4 Deals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/deals` | List deals (filterable by pipeline, stage, owner, value range, expected_close_date range, stale flag) |
| `POST` | `/bond/api/deals` | Create a deal |
| `GET` | `/bond/api/deals/:id` | Deal detail (includes contacts, activities, stage history) |
| `PATCH` | `/bond/api/deals/:id` | Update deal fields |
| `PATCH` | `/bond/api/deals/:id/stage` | Move deal to a new stage (records stage history, emits `deal.stage_changed` event for Bolt) |
| `POST` | `/bond/api/deals/:id/won` | Mark deal as won (sets closed_at, moves to won stage) |
| `POST` | `/bond/api/deals/:id/lost` | Mark deal as lost (sets closed_at, close_reason, lost_to_competitor) |
| `DELETE` | `/bond/api/deals/:id` | Soft-delete a deal |
| `GET` | `/bond/api/deals/:id/activities` | Activity timeline for a deal |
| `GET` | `/bond/api/deals/:id/stage-history` | Stage transition history |
| `POST` | `/bond/api/deals/:id/contacts` | Associate a contact with a deal |
| `DELETE` | `/bond/api/deals/:id/contacts/:contactId` | Remove contact association |

### 4.5 Activities

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bond/api/activities` | Log an activity (note, call, meeting, email, task) |
| `GET` | `/bond/api/activities/:id` | Get activity detail |
| `PATCH` | `/bond/api/activities/:id` | Update an activity |
| `DELETE` | `/bond/api/activities/:id` | Delete an activity |

### 4.6 Lead Scoring

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/scoring-rules` | List lead scoring rules |
| `POST` | `/bond/api/scoring-rules` | Create a scoring rule |
| `PATCH` | `/bond/api/scoring-rules/:id` | Update a rule |
| `DELETE` | `/bond/api/scoring-rules/:id` | Delete a rule |
| `POST` | `/bond/api/scoring/recalculate` | Trigger full recalculation of all contact lead scores (BullMQ job) |

### 4.7 Pipeline Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bond/api/analytics/pipeline-summary` | Pipeline value by stage, count, weighted value |
| `GET` | `/bond/api/analytics/conversion-rates` | Stage-to-stage conversion rates over time range |
| `GET` | `/bond/api/analytics/deal-velocity` | Average time in each stage, average deal cycle length |
| `GET` | `/bond/api/analytics/win-loss` | Win/loss ratio, reasons, competitor analysis |
| `GET` | `/bond/api/analytics/forecast` | Revenue forecast based on weighted pipeline value |
| `GET` | `/bond/api/analytics/stale-deals` | Deals exceeding rotting_days threshold per stage |

### 4.8 Express-Interest Migration

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bond/api/import/express-interest` | One-time migration of existing prospect database into Bond contacts |

---

## 5. MCP Tools

Bond exposes the following tools to AI agents via the shared MCP server:

| Tool | Description |
|------|-------------|
| `bond_list_contacts` | Search/filter contacts with pagination |
| `bond_get_contact` | Get full contact detail including companies, deals, activities |
| `bond_create_contact` | Create a new contact |
| `bond_update_contact` | Update contact fields |
| `bond_merge_contacts` | Merge duplicate contacts |
| `bond_list_companies` | Search/filter companies |
| `bond_get_company` | Get company detail |
| `bond_create_company` | Create a company |
| `bond_update_company` | Update company fields |
| `bond_list_deals` | Search/filter deals |
| `bond_get_deal` | Get deal detail with contacts, activities, stage history |
| `bond_create_deal` | Create a deal in a pipeline |
| `bond_update_deal` | Update deal fields |
| `bond_move_deal_stage` | Move a deal to a new pipeline stage |
| `bond_close_deal_won` | Mark a deal as won |
| `bond_close_deal_lost` | Mark a deal as lost with reason |
| `bond_log_activity` | Log an activity against a contact, deal, or both |
| `bond_get_pipeline_summary` | Get pipeline value/count summary |
| `bond_get_stale_deals` | List deals that have rotted in their current stage |
| `bond_score_lead` | Trigger lead score recalculation for a specific contact |
| `bond_get_forecast` | Get revenue forecast from weighted pipeline |
| `bond_search_contacts` | Full-text search across contact/company name, email, custom fields |

### 5.1 Agent Workflows

These MCP tools enable the following high-value agent-driven workflows:

**Inbound Lead Qualification:**
1. Blank form submission → Bolt triggers `bond_create_contact` with `lifecycle_stage: 'lead'`
2. Agent calls `bond_score_lead` using scoring rules
3. If score exceeds threshold → agent calls `bond_update_contact` to promote to `marketing_qualified`
4. Agent calls `bond_create_deal` in the default pipeline
5. Agent posts to Banter `#sales` channel with lead summary

**Stale Deal Follow-Up:**
1. Scheduled Bolt automation calls `bond_get_stale_deals` daily
2. For each stale deal, agent drafts a follow-up email via `blast_draft_email`
3. Agent logs activity via `bond_log_activity` with type `email_sent`
4. Posts summary to deal owner's Banter DM

**Pipeline Reporting:**
1. Weekly Bolt automation triggers agent
2. Agent calls `bond_get_pipeline_summary` and `bond_get_forecast`
3. Agent creates a Brief document with pipeline status report
4. Agent posts Brief link to Banter `#leadership` channel

---

## 6. Frontend

### 6.1 Routes

| Route | View |
|-------|------|
| `/bond` | Pipeline board (default pipeline, deal Kanban) |
| `/bond/pipelines/:id` | Specific pipeline board |
| `/bond/deals/:id` | Deal detail drawer (overlays pipeline board) |
| `/bond/contacts` | Contact list (table view with search, filter, sort) |
| `/bond/contacts/:id` | Contact detail page (profile, companies, deals, activity timeline) |
| `/bond/companies` | Company list (table view) |
| `/bond/companies/:id` | Company detail page (profile, contacts, deals, activity timeline) |
| `/bond/analytics` | Pipeline analytics dashboard (conversion funnel, velocity, forecast, win/loss) |
| `/bond/settings/pipelines` | Pipeline & stage configuration |
| `/bond/settings/fields` | Custom field definitions |
| `/bond/settings/scoring` | Lead scoring rule builder |

### 6.2 Pipeline Board

The primary view is a Kanban board identical in interaction model to Bam's task board:

- **Columns** = pipeline stages (ordered left to right)
- **Cards** = deals (showing name, value, company, owner avatar, days-in-stage indicator)
- **Drag-and-drop** = move deal between stages (records stage history, emits Bolt event)
- **Rotting indicator** = orange/red glow on card border when days-in-stage exceeds stage threshold
- **Column totals** = deal count and total value per stage
- **Pipeline-level** = weighted forecast total displayed in board header
- **Swimlanes** (optional) = group by owner, company, expected close month

Cards use the same dnd-kit + Motion spring physics as Bam task cards for consistent UX across the suite.

### 6.3 Contact Detail Page

- **Header:** name, title, company, lifecycle stage badge, lead score indicator, owner avatar
- **Sidebar tabs:** Details (all fields + custom fields), Companies, Deals
- **Main area:** Activity timeline (reverse chronological, filterable by type) with inline note/email/call logging
- **Actions:** Edit, Merge, Create Deal, Log Activity, Send to Blast Segment

### 6.4 Analytics Dashboard

- **Conversion funnel:** Stage-to-stage flow visualization
- **Deal velocity:** Average days per stage (bar chart)
- **Revenue forecast:** Weighted pipeline value over next 30/60/90 days
- **Win/loss ratio:** Trend line with drill-down to lost reasons
- **Stale deal alert:** Count + list of rotting deals

---

## 7. Events (Bolt Integration)

Bond emits the following events to Redis PubSub channel `bolt:events` for Bolt automation consumption:

| Event | Trigger | Payload |
|-------|---------|---------|
| `bond.contact.created` | New contact added | `{ contact_id, lifecycle_stage, lead_source, lead_score }` |
| `bond.contact.lifecycle_changed` | Lifecycle stage updated | `{ contact_id, from_stage, to_stage }` |
| `bond.deal.created` | New deal created | `{ deal_id, pipeline_id, stage_id, value, owner_id }` |
| `bond.deal.stage_changed` | Deal moved between stages | `{ deal_id, from_stage_id, to_stage_id, value, days_in_previous_stage }` |
| `bond.deal.won` | Deal closed-won | `{ deal_id, value, pipeline_id, cycle_days }` |
| `bond.deal.lost` | Deal closed-lost | `{ deal_id, value, close_reason, lost_to_competitor }` |
| `bond.deal.rotting` | Deal exceeds stage rotting threshold | `{ deal_id, stage_id, days_in_stage, rotting_days_threshold }` |
| `bond.activity.logged` | Activity recorded | `{ activity_id, activity_type, contact_id, deal_id }` |

---

## 8. Cross-Product Integration

### 8.1 Blast Integration
- Bond contact segments can be exported to Blast as recipient lists
- Blast campaign engagement events (open, click, bounce, unsubscribe) flow back to Bond as activities on the contact
- Bond provides the `blast_segment_contacts` API for Blast to pull contacts matching a filter

### 8.2 Helpdesk Integration
- When a Helpdesk ticket is created by an email that matches a Bond contact, the ticket is linked to the contact and a `form_submission` activity is logged
- Bond contact detail shows related Helpdesk tickets in a sidebar tab

### 8.3 Bam Integration
- Deals can be linked to Bam projects (e.g., an implementation project created when a deal closes)
- Bolt automation: `bond.deal.won` → create Bam project from template

### 8.4 Banter Integration
- Bond events can post to Banter channels via Bolt (deal won/lost notifications, stale deal alerts, daily pipeline summaries)
- Bond deal links shared in Banter render as rich previews (deal name, value, stage, company)

### 8.5 Blank Integration
- Blank form submissions can create Bond contacts and/or deals via Bolt automation
- The "express interest" flow is implemented as a public Blank form → Bolt → Bond contact creation

---

## 9. Permissions

Bond uses the same RBAC model as the rest of the suite. CRM-specific permissions:

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View all contacts/deals | ✓ | ✓ | Own only | Own only |
| Create contacts/deals | ✓ | ✓ | ✓ | ✗ |
| Edit any contact/deal | ✓ | ✓ | Own only | ✗ |
| Delete contacts/deals | ✓ | ✓ | ✗ | ✗ |
| Merge contacts | ✓ | ✓ | ✗ | ✗ |
| Configure pipelines/stages | ✓ | ✗ | ✗ | ✗ |
| Configure custom fields | ✓ | ✗ | ✗ | ✗ |
| Configure scoring rules | ✓ | ✓ | ✗ | ✗ |
| View analytics | ✓ | ✓ | ✓ | ✓ |
| Import/export contacts | ✓ | ✓ | ✗ | ✗ |

The "Own only" restriction means a Member/Viewer can see contacts and deals where they are the `owner_id`. Admin and Manager see all.

---

## 10. Migration: Express-Interest Absorption

The existing "express interest" signup flow stores prospective user information in a separate database shared only with SuperUser. Bond absorbs this:

### 10.1 Migration Steps

1. **Schema mapping:** Map express-interest fields to Bond contact fields (name, email, any custom data → custom_fields)
2. **One-time import:** `POST /bond/api/import/express-interest` reads the legacy database, creates Bond contacts with `lead_source: 'express_interest'` and `lifecycle_stage: 'lead'`
3. **Dedup:** Match on email. If contact already exists in Bond, merge activity history.
4. **Redirect signup flow:** Replace the external signup endpoint with a public Blank form that submits to Bond via Bolt automation.
5. **Deprecate legacy DB:** Once migration is confirmed, the legacy prospect database is read-only, then retired.

### 10.2 SuperUser Visibility

SuperUser retains the same visibility they had before — Bond contacts imported from express-interest are scoped to the SuperUser's organization and visible only to users with appropriate Bond permissions in that org.
