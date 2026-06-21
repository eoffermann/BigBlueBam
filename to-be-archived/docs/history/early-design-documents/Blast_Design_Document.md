# Blast — Email Campaigns & Marketing Automation for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Blast (Email Campaigns & Marketing Automation)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Blast is the email campaign and marketing automation engine for the BigBlueBam suite. It enables teams to design, send, and analyze email campaigns to Bond contacts — from one-off announcements to multi-step drip sequences triggered by contact behavior.

Blast occupies the space between "just send an email" (which Banter notifications and Bolt already handle for internal communication) and "full marketing cloud" (which would be scope creep). The target use case is a 2–50 person team that needs to communicate with prospects, customers, and subscribers without leaving the BigBlueBam ecosystem.

The architectural backbone is straightforward: Blast composes and schedules emails. Bond provides the contact database and segmentation. Bolt provides the automation triggers. Banter provides the internal notifications. Blast's unique contribution is **email template design, delivery management, and engagement analytics**.

### 1.2 Core Principles

1. **Bond is the source of truth for contacts.** Blast never maintains its own contact list. Every recipient comes from Bond, filtered by segments defined in Bond or Blast.
2. **Deliverability is non-negotiable.** Blast enforces sender authentication (SPF, DKIM, DMARC), automatic unsubscribe handling (RFC 8058 List-Unsubscribe), bounce processing, and complaint feedback loops. Sending reputation is actively managed.
3. **Templates are visual, not code.** A drag-and-drop email builder produces responsive HTML. Users never write HTML unless they want to.
4. **Drip sequences are Bolt workflows.** Multi-step email sequences are not a separate automation engine — they are Bolt automations that call Blast's send API at each step. One automation runtime, not two.
5. **Engagement feeds back to Bond.** Opens, clicks, bounces, and unsubscribes are recorded as Bond activities on the contact. This closes the loop: marketing engagement informs sales prioritization.
6. **AI drafts, humans approve.** MCP tools allow agents to draft email content, suggest subject lines, generate segment criteria, and analyze campaign performance — but sending always requires human confirmation (or an explicit Bolt automation with human-approved rules).

### 1.3 Non-Goals

- Blast is **not** a transactional email service. Password resets, ticket confirmations, and system notifications are handled by the suite's existing BullMQ email worker. Blast handles marketing and campaign email only.
- Blast does **not** include SMS, push notifications, or in-app messaging at launch. Email only.
- Blast does **not** include A/B testing with statistical significance calculators at launch. Manual variant comparison is supported (send variant A to segment 1, variant B to segment 2, compare metrics).
- Blast does **not** include a landing page builder. Use Blank forms for lead capture.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  blast-api/          → Fastify REST API (campaign CRUD, template management, send orchestration, analytics)
  blast/              → React SPA (template builder, campaign manager, analytics dashboard)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **blast-api** (Fastify :4008) | REST API for campaigns, templates, segments, send orchestration, analytics |
| **PostgreSQL 16** | Campaign definitions, templates, send logs, engagement events (shared DB, `blast_` prefix) |
| **Redis 7** | Send queue rate limiting, real-time engagement event buffering |
| **BullMQ Worker** | Email rendering, SMTP delivery, bounce/complaint processing, engagement aggregation |
| **MCP Server** | Full campaign tool surface for AI agents |
| **SMTP Relay** | External dependency: configurable SMTP provider (Postmark, SES, Mailgun, self-hosted) |

### 2.3 Email Delivery Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     Campaign Send Flow                          │
│                                                                 │
│  1. User clicks "Send" or Bolt automation triggers send         │
│  2. blast-api enqueues blast:send job per recipient batch       │
│  3. Worker renders template with contact merge fields           │
│  4. Worker sends via configured SMTP relay                      │
│  5. SMTP relay returns message ID                               │
│  6. Worker records send in blast_send_log                       │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                     Engagement Tracking                         │
│                                                                 │
│  Opens:  1x1 tracking pixel → blast-api /t/o/:token            │
│  Clicks: Link rewriting → blast-api /t/c/:token?url=...        │
│  Bounces: SMTP webhook → blast-api /webhooks/bounce             │
│  Complaints: FBL webhook → blast-api /webhooks/complaint        │
│  Unsubscribes: List-Unsubscribe header → blast-api /unsub/:token│
│                                                                 │
│  All events → blast_engagement_events → Bond activity sync      │
└────────────────────────────────────────────────────────────────┘
```

### 2.4 nginx Routing

```nginx
location /blast/ {
    alias /usr/share/nginx/html/blast/;
    try_files $uri $uri/ /blast/index.html;
}

location /blast/api/ {
    proxy_pass http://blast-api:4008/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Tracking endpoints (short paths, no /api/ prefix for brevity in emails)
location /t/ {
    proxy_pass http://blast-api:4008/t/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Unsubscribe endpoint
location /unsub/ {
    proxy_pass http://blast-api:4008/unsub/;
}
```

### 2.5 Docker Service

```yaml
blast-api:
  build:
    context: .
    dockerfile: apps/blast-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
    - SMTP_HOST=${SMTP_HOST}
    - SMTP_PORT=${SMTP_PORT:-587}
    - SMTP_USER=${SMTP_USER}
    - SMTP_PASS=${SMTP_PASS}
    - SMTP_FROM_EMAIL=${SMTP_FROM_EMAIL}
    - SMTP_FROM_NAME=${SMTP_FROM_NAME}
    - TRACKING_BASE_URL=${PUBLIC_URL}    # for tracking pixel and click URLs
  ports:
    - "4008:4008"
  depends_on:
    - postgres
    - redis
    - mcp-server
```

---

## 3. Data Model

### 3.1 PostgreSQL Schema

```sql
-- ============================================================
-- BLAST: Email Campaigns & Marketing Automation
-- ============================================================

-- Email templates (reusable, versioned)
CREATE TABLE blast_templates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    -- Template content
    subject_template    VARCHAR(500) NOT NULL,        -- supports {{merge_field}} syntax
    html_body           TEXT NOT NULL,                 -- rendered HTML with merge fields
    json_design         JSONB,                        -- drag-and-drop builder state (for re-editing)
    plain_text_body     TEXT,                          -- auto-generated or manual plain-text fallback
    -- Template type
    template_type       VARCHAR(20) NOT NULL DEFAULT 'campaign'
                        CHECK (template_type IN ('campaign', 'drip_step', 'transactional', 'system')),
    -- Thumbnail preview (rendered on save)
    thumbnail_url       TEXT,
    -- Versioning
    version             INTEGER NOT NULL DEFAULT 1,
    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    updated_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blast_templates_org ON blast_templates(organization_id);

-- Segments: saved filters over Bond contacts
CREATE TABLE blast_segments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    -- Filter definition (evaluated against Bond contacts)
    filter_criteria     JSONB NOT NULL,
    -- e.g., {
    --   "conditions": [
    --     {"field": "lifecycle_stage", "op": "in", "value": ["lead", "marketing_qualified"]},
    --     {"field": "custom_fields.industry", "op": "equals", "value": "technology"},
    --     {"field": "last_contacted_at", "op": "older_than_days", "value": 30}
    --   ],
    --   "match": "all"  -- "all" = AND, "any" = OR
    -- }
    cached_count        INTEGER,                      -- last-calculated recipient count
    cached_at           TIMESTAMPTZ,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blast_segments_org ON blast_segments(organization_id);

-- Campaigns: a specific email send
CREATE TABLE blast_campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    -- Content (snapshot of template at send time, or inline)
    template_id         UUID REFERENCES blast_templates(id) ON DELETE SET NULL,
    subject             VARCHAR(500) NOT NULL,
    html_body           TEXT NOT NULL,
    plain_text_body     TEXT,
    -- Recipients
    segment_id          UUID REFERENCES blast_segments(id) ON DELETE SET NULL,
    recipient_count     INTEGER,                      -- frozen at send time
    -- Sender
    from_name           VARCHAR(100),
    from_email          VARCHAR(255),
    reply_to_email      VARCHAR(255),
    -- Scheduling
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
    scheduled_at        TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    -- Delivery stats (aggregated from send_log)
    total_sent          INTEGER DEFAULT 0,
    total_delivered     INTEGER DEFAULT 0,
    total_bounced       INTEGER DEFAULT 0,
    total_opened        INTEGER DEFAULT 0,
    total_clicked       INTEGER DEFAULT 0,
    total_unsubscribed  INTEGER DEFAULT 0,
    total_complained    INTEGER DEFAULT 0,
    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blast_campaigns_org ON blast_campaigns(organization_id);
CREATE INDEX idx_blast_campaigns_status ON blast_campaigns(status);
CREATE INDEX idx_blast_campaigns_sent ON blast_campaigns(sent_at DESC);

-- Send log: per-recipient delivery record
CREATE TABLE blast_send_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES blast_campaigns(id) ON DELETE CASCADE,
    contact_id          UUID NOT NULL REFERENCES bond_contacts(id) ON DELETE CASCADE,
    -- Delivery
    to_email            VARCHAR(255) NOT NULL,
    smtp_message_id     VARCHAR(255),
    status              VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
    bounce_type         VARCHAR(20) CHECK (bounce_type IN ('hard', 'soft', 'complaint')),
    bounce_reason       TEXT,
    -- Tracking tokens (unique per recipient for open/click attribution)
    tracking_token      VARCHAR(64) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    -- Timestamps
    sent_at             TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    bounced_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blast_send_campaign ON blast_send_log(campaign_id);
CREATE INDEX idx_blast_send_contact ON blast_send_log(contact_id);
CREATE INDEX idx_blast_send_token ON blast_send_log(tracking_token);
CREATE INDEX idx_blast_send_status ON blast_send_log(status);

-- Engagement events: opens, clicks, unsubscribes
CREATE TABLE blast_engagement_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    send_log_id         UUID NOT NULL REFERENCES blast_send_log(id) ON DELETE CASCADE,
    campaign_id         UUID NOT NULL REFERENCES blast_campaigns(id) ON DELETE CASCADE,
    contact_id          UUID NOT NULL REFERENCES bond_contacts(id) ON DELETE CASCADE,
    event_type          VARCHAR(20) NOT NULL
                        CHECK (event_type IN ('open', 'click', 'unsubscribe')),
    -- Click-specific
    clicked_url         TEXT,
    -- Metadata
    ip_address          INET,
    user_agent          TEXT,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blast_engage_campaign ON blast_engagement_events(campaign_id, event_type);
CREATE INDEX idx_blast_engage_contact ON blast_engagement_events(contact_id, occurred_at DESC);
CREATE INDEX idx_blast_engage_send ON blast_engagement_events(send_log_id);

-- Unsubscribe list (organization-level opt-out, legally binding)
CREATE TABLE blast_unsubscribes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email               VARCHAR(255) NOT NULL,
    contact_id          UUID REFERENCES bond_contacts(id) ON DELETE SET NULL,
    reason              TEXT,
    unsubscribed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, email)
);

CREATE INDEX idx_blast_unsub_org ON blast_unsubscribes(organization_id, email);

-- Sender domains: verified sending domains with auth status
CREATE TABLE blast_sender_domains (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain              VARCHAR(255) NOT NULL,
    -- Verification status
    spf_verified        BOOLEAN NOT NULL DEFAULT false,
    dkim_verified       BOOLEAN NOT NULL DEFAULT false,
    dmarc_verified      BOOLEAN NOT NULL DEFAULT false,
    verified_at         TIMESTAMPTZ,
    -- DNS records to configure (generated on domain add)
    dns_records         JSONB,
    -- e.g., [
    --   {"type": "TXT", "name": "@", "value": "v=spf1 include:..."},
    --   {"type": "CNAME", "name": "blast._domainkey", "value": "..."},
    --   {"type": "TXT", "name": "_dmarc", "value": "v=DMARC1; p=quarantine; ..."}
    -- ]
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, domain)
);
```

---

## 4. API Endpoints

### 4.1 Templates

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blast/api/templates` | List templates |
| `POST` | `/blast/api/templates` | Create template (from builder JSON or raw HTML) |
| `GET` | `/blast/api/templates/:id` | Get template detail |
| `PATCH` | `/blast/api/templates/:id` | Update template |
| `DELETE` | `/blast/api/templates/:id` | Delete template |
| `POST` | `/blast/api/templates/:id/preview` | Render template with sample merge data, return HTML |
| `POST` | `/blast/api/templates/:id/duplicate` | Clone a template |

### 4.2 Segments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blast/api/segments` | List segments |
| `POST` | `/blast/api/segments` | Create a segment |
| `GET` | `/blast/api/segments/:id` | Get segment detail with cached count |
| `PATCH` | `/blast/api/segments/:id` | Update segment filter |
| `DELETE` | `/blast/api/segments/:id` | Delete segment |
| `POST` | `/blast/api/segments/:id/count` | Recalculate recipient count (queries Bond contacts) |
| `GET` | `/blast/api/segments/:id/preview` | Preview first 50 matching contacts |

### 4.3 Campaigns

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blast/api/campaigns` | List campaigns (filterable by status) |
| `POST` | `/blast/api/campaigns` | Create a campaign |
| `GET` | `/blast/api/campaigns/:id` | Get campaign detail with delivery stats |
| `PATCH` | `/blast/api/campaigns/:id` | Update campaign (only in draft/scheduled status) |
| `DELETE` | `/blast/api/campaigns/:id` | Delete campaign (only in draft status) |
| `POST` | `/blast/api/campaigns/:id/send` | Send immediately (enqueues delivery jobs) |
| `POST` | `/blast/api/campaigns/:id/schedule` | Schedule for future send |
| `POST` | `/blast/api/campaigns/:id/pause` | Pause a sending campaign |
| `POST` | `/blast/api/campaigns/:id/cancel` | Cancel a scheduled or sending campaign |
| `GET` | `/blast/api/campaigns/:id/analytics` | Detailed engagement analytics (open rate, click rate, click map, device breakdown) |
| `GET` | `/blast/api/campaigns/:id/recipients` | List recipients with per-recipient delivery/engagement status |

### 4.4 Tracking Endpoints (No Auth — Token-Based)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/t/o/:token` | Open tracking pixel (returns 1x1 transparent GIF, logs open event) |
| `GET` | `/t/c/:token` | Click tracking redirect (logs click event, 302 redirects to original URL) |
| `GET` | `/unsub/:token` | Unsubscribe page (renders confirmation form) |
| `POST` | `/unsub/:token` | Process unsubscribe (adds to blast_unsubscribes, logs event) |

### 4.5 Webhooks (Inbound from SMTP Provider)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/blast/api/webhooks/bounce` | Process bounce notification from SMTP relay |
| `POST` | `/blast/api/webhooks/complaint` | Process spam complaint from FBL |

### 4.6 Sender Domains

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blast/api/sender-domains` | List sender domains with verification status |
| `POST` | `/blast/api/sender-domains` | Add a domain (generates required DNS records) |
| `POST` | `/blast/api/sender-domains/:id/verify` | Check DNS records and update verification status |
| `DELETE` | `/blast/api/sender-domains/:id` | Remove a sender domain |

### 4.7 Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blast/api/analytics/overview` | Org-level metrics: total sent, avg open rate, avg click rate, unsubscribe rate over time |
| `GET` | `/blast/api/analytics/engagement-trend` | Open/click rates over time (daily/weekly/monthly) |

---

## 5. MCP Tools

| Tool | Description |
|------|-------------|
| `blast_list_templates` | List available email templates |
| `blast_get_template` | Get template content and builder state |
| `blast_create_template` | Create a template from HTML + subject |
| `blast_draft_campaign` | Create a campaign in draft status with template, segment, and schedule |
| `blast_get_campaign` | Get campaign detail and stats |
| `blast_send_campaign` | Send a campaign (requires explicit human approval flag or pre-authorized Bolt automation) |
| `blast_get_campaign_analytics` | Get engagement metrics for a campaign |
| `blast_list_segments` | List contact segments |
| `blast_create_segment` | Define a segment from Bond contact filter criteria |
| `blast_preview_segment` | Preview matching contacts for a segment |
| `blast_draft_email_content` | AI-generate email subject + body from a brief description and tone |
| `blast_suggest_subject_lines` | Generate 5 subject line variants for A/B comparison |
| `blast_get_engagement_summary` | Org-level engagement trends |
| `blast_check_unsubscribed` | Check if an email is on the unsubscribe list |

### 5.1 Agent Safety: Send Authorization

The `blast_send_campaign` MCP tool includes a `require_human_approval` flag that defaults to `true`. When called by an AI agent:
- If `require_human_approval: true` → the campaign is set to `scheduled` status and a Banter DM is sent to the campaign creator asking for confirmation. The agent does not send.
- If `require_human_approval: false` → the agent sends immediately. This flag can only be set to `false` by a Bolt automation rule that has been explicitly configured and enabled by an Admin.

This prevents AI agents from sending unsolicited mass email without human oversight.

---

## 6. Email Builder

### 6.1 Approach

Blast uses a block-based drag-and-drop email builder that produces responsive HTML. The builder stores its state as a JSON tree (`json_design` column) and renders to HTML on save/send.

### 6.2 Block Types

| Block | Description |
|-------|-------------|
| **Header** | Logo image + optional navigation links |
| **Text** | Rich text with merge field insertion (`{{first_name}}`, `{{company.name}}`) |
| **Image** | Single image with optional link, alt text, alignment |
| **Button** | CTA button with configurable text, URL, colors, border radius |
| **Divider** | Horizontal rule with configurable color, thickness, margin |
| **Columns** | 1–4 column layout, each column contains nested blocks |
| **Spacer** | Empty vertical space with configurable height |
| **Social** | Social media icon row (configurable platforms + URLs) |
| **Footer** | Unsubscribe link (mandatory), org address (CAN-SPAM), custom text |

### 6.3 Merge Fields

Merge fields pull from Bond contact and company data:
- `{{first_name}}`, `{{last_name}}`, `{{email}}`
- `{{company.name}}`, `{{company.industry}}`
- `{{custom_fields.KEY}}`
- `{{unsubscribe_url}}` (auto-generated, required in footer)
- `{{tracking_pixel}}` (auto-injected, invisible)

### 6.4 Responsive Rendering

Templates render to responsive HTML using a table-based layout for email client compatibility. The builder uses MJML-like semantics internally, compiled to HTML at render time. Rendering is done server-side in the BullMQ worker, not in the browser.

---

## 7. Events (Bolt Integration)

| Event | Trigger | Payload |
|-------|---------|---------|
| `blast.campaign.sent` | Campaign begins sending | `{ campaign_id, segment_id, recipient_count }` |
| `blast.campaign.completed` | All emails delivered/bounced | `{ campaign_id, total_sent, total_delivered, total_bounced }` |
| `blast.engagement.opened` | Recipient opened email | `{ campaign_id, contact_id, send_log_id }` |
| `blast.engagement.clicked` | Recipient clicked a link | `{ campaign_id, contact_id, clicked_url }` |
| `blast.engagement.unsubscribed` | Recipient unsubscribed | `{ campaign_id, contact_id, email }` |
| `blast.engagement.bounced` | Email bounced | `{ campaign_id, contact_id, bounce_type }` |

---

## 8. Deliverability & Compliance

### 8.1 Sender Authentication
- SPF, DKIM, and DMARC records are generated per sender domain and verified via DNS lookup
- Blast refuses to send from unverified domains

### 8.2 Unsubscribe Handling
- Every campaign email includes RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers
- Unsubscribe link is mandatory in the email footer
- Unsubscribed contacts are permanently excluded from future sends (org-level `blast_unsubscribes` table)
- Bond contact `lifecycle_stage` is not changed on unsubscribe (they may still be a customer — they just don't want marketing email)

### 8.3 Bounce Processing
- Hard bounces: email marked as invalid on Bond contact, auto-excluded from future sends
- Soft bounces: retried up to 3 times over 24 hours, then treated as delivery failure
- Complaint (FBL): treated as unsubscribe + flagged for review

### 8.4 Rate Limiting
- Send rate is configurable per SMTP provider (e.g., SES = 14/sec, Postmark = 10/sec)
- BullMQ worker respects rate limits via Redis-backed token bucket
- Campaign sends are batched (100 recipients per job) and processed in parallel within rate limits

### 8.5 CAN-SPAM / GDPR Compliance
- Physical address required in email footer (configured per org in Blast settings)
- Unsubscribe must be honored within 1 business day (Blast processes immediately)
- Blast does not sell or share contact data outside the suite
- GDPR data export: Bond handles this (Blast engagement events are included in Bond's contact data export)

---

## 9. Frontend

### 9.1 Routes

| Route | View |
|-------|------|
| `/blast` | Campaign list (table with status, sent date, open rate, click rate) |
| `/blast/campaigns/new` | Campaign editor (template selection, segment selection, scheduling) |
| `/blast/campaigns/:id` | Campaign detail (analytics dashboard, recipient list) |
| `/blast/templates` | Template gallery (grid of thumbnail previews) |
| `/blast/templates/new` | Drag-and-drop email builder |
| `/blast/templates/:id/edit` | Edit existing template in builder |
| `/blast/segments` | Segment list with cached counts |
| `/blast/segments/new` | Segment filter builder (visual query builder over Bond contact fields) |
| `/blast/analytics` | Org-level engagement trends |
| `/blast/settings/domains` | Sender domain management and DNS verification |
| `/blast/settings/smtp` | SMTP provider configuration |

### 9.2 Campaign Analytics View

Per-campaign analytics dashboard:
- **Delivery funnel:** Sent → Delivered → Opened → Clicked (horizontal funnel chart)
- **Open rate over time:** Hourly curve for the first 72 hours post-send
- **Click map:** Visual heatmap of which links were clicked and how many times
- **Device/client breakdown:** Pie chart of email clients (Gmail, Outlook, Apple Mail, etc.)
- **Recipient table:** Searchable list with per-recipient status (delivered, opened, clicked, bounced, unsubscribed)

---

## 10. Permissions

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View campaigns/analytics | ✓ | ✓ | ✓ | ✓ |
| Create/edit templates | ✓ | ✓ | ✓ | ✗ |
| Create/edit campaigns | ✓ | ✓ | ✓ | ✗ |
| Send campaigns | ✓ | ✓ | ✗ | ✗ |
| Create/edit segments | ✓ | ✓ | ✓ | ✗ |
| Configure sender domains | ✓ | ✗ | ✗ | ✗ |
| Configure SMTP settings | ✓ | ✗ | ✗ | ✗ |
| Delete campaigns/templates | ✓ | ✓ | ✗ | ✗ |
