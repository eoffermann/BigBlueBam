# Blank — Forms & Surveys for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Blank (Forms & Surveys)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Blank is the form builder and survey platform for the BigBlueBam suite. It lets teams create public or internal forms — lead capture forms, customer feedback surveys, bug report forms, onboarding questionnaires, event registration, feature request intake — and routes submissions into the appropriate B-product via Bolt automations.

Blank is the **front door of the suite.** Many user journeys begin with a form: a prospect fills out an interest form (→ Bond contact), a customer reports a bug (→ Helpdesk ticket), an employee submits a feature request (→ Bam task), a conference attendee registers (→ Book event + Bond contact). Before Blank, each of these required custom code or a third-party form tool with webhook plumbing. Blank brings form creation inside the suite and connects submissions natively.

The name "Blank" is literal: you start with a blank canvas and build what you need. No assumptions about form type or destination.

### 1.2 Core Principles

1. **Forms are the suite's public API.** Any process that needs external or internal input should start with a Blank form. Submissions are the trigger; Bolt routes them to the right destination.
2. **Drag-and-drop builder.** Creating a form is visual. Drag field types onto the canvas, configure validation, set conditional logic, preview, publish. No code required.
3. **Conditional logic.** Show/hide fields, skip sections, or branch to different pages based on previous answers. This enables a single form to handle multiple workflows.
4. **Bolt-native routing.** Form submissions emit events that Bolt can react to. One form can create a Bond contact AND a Helpdesk ticket AND post to Banter — all through Bolt automations, not form-specific configuration.
5. **Public and internal.** Forms can be public (no auth, embeddable, shareable via link) or internal (requires BigBlueBam login, org-scoped).
6. **AI-assisted form creation.** MCP tools allow agents to generate forms from natural-language descriptions, analyze submission patterns, and summarize results.

### 1.3 Non-Goals

- Blank is **not** a quiz or exam platform. No scoring, grading, or timed assessments.
- Blank does **not** include payment collection (credit card fields). Use external payment links in form confirmation pages.
- Blank does **not** include advanced survey analytics (cross-tabulation, statistical significance, NPS benchmarking). Basic response aggregation is provided; advanced analysis is done in Bench.
- Blank does **not** include offline form submission at launch.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  blank-api/          → Fastify REST API (form CRUD, submission handling, response aggregation)
  blank/              → React SPA (form builder, form renderer, response viewer)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **blank-api** (Fastify :4011) | REST API for forms, fields, submissions, response analytics |
| **PostgreSQL 16** | Form definitions, submissions (shared DB, `blank_` prefix) |
| **Redis 7** | Rate limiting for public form submissions, submission count caching |
| **BullMQ Worker** | Submission confirmation emails, file upload processing, Bolt event emission |
| **MCP Server** | Form creation and submission analysis tools for AI agents |
| **MinIO** | File upload storage for form file attachment fields |

### 2.3 nginx Routing

```nginx
location /blank/ {
    alias /usr/share/nginx/html/blank/;
    try_files $uri $uri/ /blank/index.html;
}

location /blank/api/ {
    proxy_pass http://blank-api:4011/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Public form renderer (no auth)
location /forms/ {
    proxy_pass http://blank-api:4011/forms/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.4 Docker Service

```yaml
blank-api:
  build:
    context: .
    dockerfile: apps/blank-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
    - MINIO_ENDPOINT=minio:9000
    - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
    - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    - PUBLIC_URL=${PUBLIC_URL}
  ports:
    - "4011:4011"
  depends_on:
    - postgres
    - redis
    - mcp-server
    - minio
```

---

## 3. Data Model

### 3.1 PostgreSQL Schema

```sql
-- ============================================================
-- BLANK: Forms & Surveys
-- ============================================================

-- Forms
CREATE TABLE blank_forms (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,

    -- Form metadata
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    slug                VARCHAR(60) NOT NULL,         -- URL path: /forms/:slug

    -- Visibility & access
    form_type           VARCHAR(20) NOT NULL DEFAULT 'public'
                        CHECK (form_type IN ('public', 'internal', 'embedded')),
    -- public: no auth, anyone with link can submit
    -- internal: requires BigBlueBam login
    -- embedded: public but also provides an iframe embed code
    requires_login      BOOLEAN NOT NULL DEFAULT false,
    allowed_domains     TEXT[],                        -- for embedded: restrict iframe origins

    -- Behavior
    accept_responses    BOOLEAN NOT NULL DEFAULT true,
    max_responses       INTEGER,                      -- NULL = unlimited
    one_per_email       BOOLEAN NOT NULL DEFAULT false, -- deduplicate by email field
    show_progress_bar   BOOLEAN NOT NULL DEFAULT false,
    shuffle_fields      BOOLEAN NOT NULL DEFAULT false, -- randomize field order (surveys)

    -- Confirmation
    confirmation_type   VARCHAR(20) NOT NULL DEFAULT 'message'
                        CHECK (confirmation_type IN ('message', 'redirect', 'page')),
    confirmation_message TEXT DEFAULT 'Thank you for your submission!',
    confirmation_redirect_url TEXT,

    -- Branding
    header_image_url    TEXT,
    theme_color         VARCHAR(7) DEFAULT '#3b82f6',
    custom_css          TEXT,                          -- advanced: custom CSS for public form

    -- Notification
    notify_on_submit    BOOLEAN NOT NULL DEFAULT false,
    notify_emails       TEXT[],                        -- email addresses to notify on submission
    notify_banter_channel_id UUID,                    -- Banter channel to post submissions

    -- Rate limiting (public forms)
    rate_limit_per_ip   INTEGER DEFAULT 10,            -- max submissions per IP per hour
    captcha_enabled     BOOLEAN NOT NULL DEFAULT false,

    -- Status
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'closed', 'archived')),
    published_at        TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,

    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX idx_blank_forms_org ON blank_forms(organization_id);
CREATE INDEX idx_blank_forms_slug ON blank_forms(slug) WHERE status = 'published';

-- Form fields (ordered list of questions/inputs)
CREATE TABLE blank_form_fields (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id             UUID NOT NULL REFERENCES blank_forms(id) ON DELETE CASCADE,
    -- Field definition
    field_key           VARCHAR(60) NOT NULL,          -- programmatic key for submission data
    label               VARCHAR(500) NOT NULL,         -- display label
    description         TEXT,                          -- help text shown below the field
    placeholder         VARCHAR(255),
    field_type          VARCHAR(30) NOT NULL
                        CHECK (field_type IN (
                            'short_text', 'long_text', 'email', 'phone', 'url', 'number',
                            'single_select', 'multi_select', 'dropdown',
                            'date', 'time', 'datetime',
                            'file_upload', 'image_upload',
                            'rating', 'scale', 'nps',
                            'checkbox', 'toggle',
                            'section_header', 'paragraph',     -- display-only (no input)
                            'hidden'                           -- hidden field with default value
                        )),
    -- Validation
    required            BOOLEAN NOT NULL DEFAULT false,
    min_length          INTEGER,
    max_length          INTEGER,
    min_value           NUMERIC,
    max_value           NUMERIC,
    regex_pattern       VARCHAR(255),                  -- custom regex validation
    -- Options (for select/dropdown types)
    options             JSONB,
    -- e.g., [{"value": "opt1", "label": "Option 1"}, {"value": "opt2", "label": "Option 2"}]
    -- Rating/scale config
    scale_min           INTEGER DEFAULT 1,
    scale_max           INTEGER DEFAULT 5,
    scale_min_label     VARCHAR(100),                  -- e.g., "Not satisfied"
    scale_max_label     VARCHAR(100),                  -- e.g., "Very satisfied"
    -- File upload config
    allowed_file_types  TEXT[],                        -- e.g., ['.pdf', '.docx', '.png']
    max_file_size_mb    INTEGER DEFAULT 10,
    -- Conditional logic (show this field only when condition is met)
    conditional_on_field_id UUID REFERENCES blank_form_fields(id),
    conditional_operator VARCHAR(20) CHECK (conditional_operator IN ('equals', 'not_equals', 'contains', 'gt', 'lt', 'is_set', 'is_not_set')),
    conditional_value   TEXT,
    -- Layout
    sort_order          INTEGER NOT NULL DEFAULT 0,
    page_number         INTEGER NOT NULL DEFAULT 1,    -- for multi-page forms
    column_span         INTEGER NOT NULL DEFAULT 1     -- 1 = full width, 2 = half width (in 2-col layout)
                        CHECK (column_span IN (1, 2)),
    -- Default value (for hidden fields, pre-filled forms)
    default_value       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blank_fields_form ON blank_form_fields(form_id, sort_order);

-- Submissions
CREATE TABLE blank_submissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id             UUID NOT NULL REFERENCES blank_forms(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Response data (JSONB keyed by field_key)
    response_data       JSONB NOT NULL,
    -- e.g., {"name": "Alice", "email": "alice@co.com", "rating": 4, "feedback": "Great product!"}
    -- Submitter info
    submitted_by_user_id UUID REFERENCES users(id),   -- NULL for public (anonymous) forms
    submitted_by_email  VARCHAR(255),                  -- extracted from email field if present
    submitted_by_ip     INET,
    user_agent          TEXT,
    -- File attachments (references to MinIO objects)
    attachments         JSONB DEFAULT '[]',
    -- e.g., [{"field_key": "resume", "filename": "resume.pdf", "url": "minio://...", "size_bytes": 102400}]
    -- Processing status
    processed           BOOLEAN NOT NULL DEFAULT false, -- set true after Bolt events have been emitted
    -- Metadata
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blank_submissions_form ON blank_submissions(form_id, submitted_at DESC);
CREATE INDEX idx_blank_submissions_org ON blank_submissions(organization_id);
CREATE INDEX idx_blank_submissions_email ON blank_submissions(submitted_by_email);
CREATE INDEX idx_blank_submissions_data ON blank_submissions USING GIN (response_data);
```

---

## 4. API Endpoints

### 4.1 Forms

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blank/api/forms` | List forms (filterable by status, project) |
| `POST` | `/blank/api/forms` | Create a form with fields |
| `GET` | `/blank/api/forms/:id` | Get form definition with all fields |
| `PATCH` | `/blank/api/forms/:id` | Update form metadata |
| `DELETE` | `/blank/api/forms/:id` | Delete form |
| `POST` | `/blank/api/forms/:id/publish` | Publish form (set status to published) |
| `POST` | `/blank/api/forms/:id/close` | Close form (stop accepting responses) |
| `POST` | `/blank/api/forms/:id/duplicate` | Clone a form |
| `GET` | `/blank/api/forms/:id/embed-code` | Get HTML iframe embed snippet |

### 4.2 Fields

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/blank/api/forms/:id/fields` | Add a field |
| `PATCH` | `/blank/api/fields/:id` | Update a field |
| `DELETE` | `/blank/api/fields/:id` | Remove a field |
| `POST` | `/blank/api/forms/:id/fields/reorder` | Bulk reorder fields |

### 4.3 Submissions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/blank/api/forms/:id/submissions` | List submissions (paginated, filterable) |
| `GET` | `/blank/api/submissions/:id` | Get submission detail |
| `DELETE` | `/blank/api/submissions/:id` | Delete a submission |
| `GET` | `/blank/api/forms/:id/submissions/export` | Export all submissions as CSV |
| `GET` | `/blank/api/forms/:id/analytics` | Response aggregation (counts per option for selects, average for ratings, response-over-time trend) |

### 4.4 Public Form Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/forms/:slug` | Render public form HTML |
| `GET` | `/forms/:slug/definition` | Get form field definitions (for SPA rendering) |
| `POST` | `/forms/:slug/submit` | Submit a response (rate-limited, optionally CAPTCHA-protected) |

---

## 5. MCP Tools

| Tool | Description |
|------|-------------|
| `blank_list_forms` | List available forms |
| `blank_get_form` | Get form definition |
| `blank_create_form` | Create a form from a field specification |
| `blank_generate_form` | AI generates a form from a natural-language description (e.g., "customer feedback survey with NPS, product rating, and open comments") |
| `blank_update_form` | Update form fields or metadata |
| `blank_publish_form` | Publish a draft form |
| `blank_list_submissions` | List submissions for a form |
| `blank_get_submission` | Get a specific submission |
| `blank_summarize_responses` | AI summarizes submission data (aggregate stats, common themes in open text) |
| `blank_export_submissions` | Export submissions as CSV |
| `blank_get_form_analytics` | Get response aggregation data |

### 5.1 Agent Form Generation

Natural-language form creation:

> User: "Create a customer satisfaction survey with an NPS question, a rating for support quality, and an open feedback field"

1. Agent calls `blank_generate_form` with the description
2. Tool generates form with fields: NPS (scale 0-10), support quality (rating 1-5), open feedback (long_text)
3. Agent returns the form for user review
4. User approves → agent calls `blank_publish_form`

---

## 6. Frontend

### 6.1 Routes

| Route | View |
|-------|------|
| `/blank` | Form list (cards with name, status, response count, last submission date) |
| `/blank/forms/new` | Form builder (drag-and-drop field composer) |
| `/blank/forms/:id/edit` | Edit existing form in builder |
| `/blank/forms/:id/preview` | Form preview (renders as it would appear to respondents) |
| `/blank/forms/:id/responses` | Response viewer (table of submissions, individual detail view) |
| `/blank/forms/:id/analytics` | Response analytics (charts for each field, trends) |
| `/blank/forms/:id/settings` | Form settings (access, notifications, confirmation, branding) |

### 6.2 Form Builder

Drag-and-drop interface with three panels:
- **Left panel:** Field type palette (drag field types onto the canvas)
- **Center panel:** Form canvas (ordered list of fields, reorderable via drag)
- **Right panel:** Field configuration (selected field's properties, validation, conditional logic)

Multi-page support: tabs at the top of the canvas for page navigation. Drag fields between pages.

Live preview toggle: split-screen showing the builder on the left and the live rendered form on the right.

### 6.3 Public Form Renderer

The public form at `/forms/:slug` is a standalone React app (separate from the main Blank SPA) with minimal bundle size. It:
- Fetches the form definition from `/forms/:slug/definition`
- Renders fields dynamically based on field_type
- Applies conditional logic client-side (show/hide based on current answers)
- Validates inputs client-side before submission
- Shows progress bar for multi-page forms
- Submits to `/forms/:slug/submit`
- Displays confirmation message or redirects on success

The renderer is embeddable via `<iframe>` for use on external websites.

### 6.4 Response Analytics

Per-form analytics dashboard:
- **Response count over time:** Line chart of submission rate
- **Per-field breakdown:**
  - Single/multi select, dropdown: Bar chart of response counts per option
  - Rating/scale/NPS: Distribution histogram + average
  - Short/long text: Word cloud (optional), most recent responses
- **Completion rate:** Percentage of form views that result in submissions (requires tracking pixel on form load)
- **Export:** Full response data as CSV, or individual submission as JSON

---

## 7. Events (Bolt Integration)

| Event | Trigger | Payload |
|-------|---------|---------|
| `blank.form.published` | Form published | `{ form_id, slug, form_type }` |
| `blank.form.closed` | Form closed | `{ form_id, slug, total_submissions }` |
| `blank.submission.created` | New submission received | `{ submission_id, form_id, form_slug, response_data, submitted_by_email }` |

The `blank.submission.created` event is the primary integration point. Bolt automations react to this event to route submissions:

**Example Bolt automations:**
- "When form 'express-interest' receives a submission → create Bond contact with name/email from response_data → create Bond deal in default pipeline → post to Banter #sales"
- "When form 'bug-report' receives a submission → create Helpdesk ticket with description from response_data"
- "When form 'feature-request' receives a submission → create Bam task in Backlog phase with title and description from response_data"
- "When form 'meeting-request' receives a submission → create Book event with details from response_data"

---

## 8. Cross-Product Integration

### 8.1 Bond Integration
- Blank forms are the primary external lead capture mechanism. The "express interest" signup flow is a published Blank form whose submissions create Bond contacts via Bolt.
- Bond contact detail can show form submissions from that contact (matched by email).

### 8.2 Helpdesk Integration
- Public-facing support/bug report forms create Helpdesk tickets via Bolt automation.
- Form submissions include the submitter's email for Helpdesk follow-up.

### 8.3 Bam Integration
- Internal feature request or feedback forms create Bam tasks via Bolt.
- Form fields map to task title, description, priority, and labels.

### 8.4 Banter Integration
- Form submissions can post to a Banter channel (configurable per form or via Bolt).
- Banter messages render Blank form submission links as rich previews.

### 8.5 Book Integration
- Registration/booking forms can create Book events via Bolt.

### 8.6 Bench Integration
- Blank submission data is registered as a Bench data source for analytics widgets (e.g., "NPS score trend over time", "form submission volume by source").

---

## 9. Permissions

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View forms | ✓ | ✓ | ✓ | ✓ |
| Create/edit forms | ✓ | ✓ | ✓ | ✗ |
| Publish forms | ✓ | ✓ | ✗ | ✗ |
| Delete forms | ✓ | ✓ | Own only | ✗ |
| View submissions | ✓ | ✓ | ✓ | ✓ |
| Delete submissions | ✓ | ✓ | ✗ | ✗ |
| Export submissions | ✓ | ✓ | ✓ | ✗ |
| Configure form branding/CSS | ✓ | ✓ | ✗ | ✗ |
