# Blast Dossier

Research dossier for the **Blast** app (Email Campaigns). All paths are repo-relative
unless noted. Compiled from code in `apps/blast-api/src`, `apps/blast/src`,
`apps/mcp-server/src/tools/blast-tools.ts`, `apps/worker/src/jobs/blast-send.job.ts`,
existing docs in `docs/apps/blast`, and the Bolt event catalog.

---

## 1. App identity

- **app_key:** `blast`
- **Display name:** Blast
- **Category:** Email campaigns
- **SPA path:** `/blast/` (served by nginx; app base path `/blast` is hard-coded in
  `apps/blast/src/app.tsx` `BASE_PATH`)
- **API path:** `/blast/api/` -> blast-api (internal `:4010`). REST routes use prefix
  `/v1` (browser calls `/blast/api/v1/...`); tracking routes have NO prefix (`/t/...`,
  `/unsub/...`). See `apps/blast-api/src/server.ts` lines 102-108.
- **Tracking endpoints (separate nginx locations):** `/t/` (open pixel + click redirect)
  and `/unsub/` (unsubscribe page), both proxied to blast-api (per `CLAUDE.md`).
- **Backend dir:** `apps/blast-api/src`
- **Frontend dir:** `apps/blast/src`
- **MCP tools file:** `apps/mcp-server/src/tools/blast-tools.ts`
- **Docs dir:** `docs/apps/blast` (docs_exists = true)
- **Prerequisites / dependencies:**
  - **Auth shared with Bam.** Blast has no login. The auth store calls `/b3/api/auth/me`
    (`apps/blast/src/stores/auth.store.ts` line 29). Unauthenticated users get a "Please
    log in to BigBlueBam first" screen linking to `/b3/` (`app.tsx` lines 123-135).
  - **Bond CRM is the contact source.** Segments and the send job read `bond_contacts`.
    Filter fields map to `bond_contacts` columns (`segment.service.ts` `CONTACT_COLUMN_MAP`).
  - **SMTP is platform-wide, NOT in blast-api.** Delivery uses the platform relay from
    `system_settings.smtp_*`, configured in the Bam app under Account Settings ->
    Integrations. Worker resolves it via `apps/worker/src/utils/smtp-config.ts`
    (`getSmtpConfig`). Blast's "SMTP" page is a role-aware info card linking to `/b3/settings`
    (`apps/blast/src/pages/smtp-settings.tsx`); it stores no credentials.
  - **Sending is async via worker.** `POST /campaigns/:id/send` flips status to `sending`
    and enqueues a BullMQ `blast-send` job; the send loop runs in
    `apps/worker/src/jobs/blast-send.job.ts`.

---

## 2. Key concepts and vocabulary

**Campaign** (`blast_campaigns`, `apps/blast-api/src/db/schema/blast-campaigns.ts`)
A single bulk email send: subject, html_body, optional plain_text_body, optional
`template_id`, optional `segment_id`, from_name/from_email/reply_to_email, and rollup
counters (`total_sent`, `total_delivered`, `total_bounced`, `total_opened`,
`total_clicked`, `total_unsubscribed`, `total_complained`).

**Campaign status** (varchar(20), default `draft`). Full enum from
`campaign-list.tsx` line 29 + `utils.ts`:
- `draft` - editable, deletable, sendable, schedulable
- `scheduled` - editable, sendable, cancellable
- `sending` - pausable, cancellable (worker processing)
- `sent` - terminal success; counts toward org analytics
- `paused` - cancellable (from `sending`)
- `cancelled` - terminal (from scheduled/sending/paused)

Transition rules in `campaign.service.ts`: update only draft/scheduled; delete only draft;
send only draft/scheduled (CAN-SPAM check first); schedule only draft (future time, CAN-SPAM
check); pause only sending; cancel only scheduled/sending/paused. NO `archived` status
exists despite docs (see Sec 7).

**Template** (`blast_templates`): `name`, `description`, `subject_template`, `html_body`,
`json_design` (JSONB block array), `plain_text_body`, `template_type`, `thumbnail_url`,
`version` (auto-bumped on update). **template_type enum:** `campaign` (default),
`drip_step`, `transactional`, `system` (`templates.routes.ts` line 6).

**Segment** (`blast_segments`): saved Bond-contact filter. `filter_criteria` JSONB =
`{ conditions: [{field,op,value}], match: 'all'|'any' }`, plus `cached_count`/`cached_at`.
- **Supported fields** (`CONTACT_COLUMN_MAP`): `lifecycle_stage`, `lead_source`,
  `lead_score`, `city`, `country`, `last_contacted_at`, `email`, `first_name`, `last_name`.
  (Builder UI exposes only the first six.)
- **Supported operators** (`buildConditionSql`): `equals`, `not_equals`, `in`, `contains`,
  `greater_than`, `less_than`, `older_than_days`, `is_set`, `is_not_set`. (UI exposes the
  first seven.)
- Evaluation excludes no-email contacts and unsubscribed emails (`evaluateSegmentRecipients`).

**Send log** (`blast_send_log`): one row per recipient per campaign. `to_email`,
`smtp_message_id`, `status` (`queued`->`sent`/`delivered`/`bounced`/`complained`/`failed`),
`bounce_type`, `bounce_reason`, unique 64-char `tracking_token`, timestamps. Drives the
per-recipient table on campaign detail.

**Engagement event** (`blast_engagement_events`): append-only. `event_type` (`open`,
`click`, `unsubscribe`, `bounce`, `complaint`), `clicked_url`, `ip_address`, `user_agent`,
`client_info` (denormalized device/client label e.g. Outlook/Gmail/Chrome/Bot via
`parseClientInfo` in `tracking.service.ts`).

**Unsubscribe** (`blast_unsubscribes`): org-scoped suppression keyed unique on
`(organization_id, email)`. Set by the unsubscribe link and auto-set on spam complaints
(`webhook.service.ts` `processComplaint`).

**Sender domain** (`blast_sender_domains`): per-org sending domain with SPF/DKIM/DMARC
verified booleans, `verified_at`, generated `dns_records` JSONB. Verification does live
`dns.resolveTxt`/`resolveCname` lookups (`sender-domain.service.ts`).

**Tracking token:** random 32-byte base64url per recipient, minted by the worker; embedded
in the open pixel (`/t/o/:token`), rewritten links (`/t/c/:token?url=...`), and unsubscribe
URL (`/unsub/:token`).

**Merge fields:** `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{company}}`,
`{{unsubscribe_url}}` (worker `renderTemplate`). Template preview also supports
`{{company.name}}`, `{{company.industry}}` with sample data (`template.service.ts`).

**Visual builder blocks** (`block-types.ts`): `header`, `text`, `image`, `button`,
`divider`, `columns`, `social`, `spacer`.

---

## 3. Feature inventory

Nav from `apps/blast/src/components/layout/blast-sidebar.tsx`: primary group **Campaigns**,
**Templates**, **Segments**, **Analytics**; a **Blast Settings** group with **Domains** and
**SMTP**. Header has Launchpad trigger, breadcrumbs, Org switcher, Notifications bell, User
menu (`blast-layout.tsx`). Pressing `?` opens in-app Help (`/blast/help`, `app.tsx` 96-108).
Routes are client-side (`parseRoute` in `app.tsx`); "URL" below is the browser path.

### 3.1 Campaigns - list (view: "Campaigns")
- **File:** `apps/blast/src/pages/campaign-list.tsx`. **URL:** `/blast/` (and `/blast/campaigns`).
- **Header label:** Campaigns; subtitle "Create and manage email campaigns".
- **Primary action:** **New Campaign** (top-right) navigates to `/campaigns/new`.
- **Filters:** search box "Search campaigns..." (client-side, name); status buttons **All**,
  **draft**, **scheduled**, **sending**, **sent**, **paused**, **cancelled**.
- **Table columns:** Campaign (name + subject), Status badge, Sent, Open Rate, Click Rate,
  Date. Row click goes to `/campaigns/:id`.
- **Route:** `GET /v1/campaigns?status=...` (`useCampaigns`).

### 3.2 Campaigns - create (view: "New Campaign")
- **File:** `apps/blast/src/pages/campaign-new.tsx`. **URL:** `/blast/campaigns/new`.
- **Header:** back arrow + New Campaign; button **Create Campaign** ("Creating..." while
  pending; disabled until name + subject).
- **Fields:** `Campaign Name *`, `Subject Line *`, `From` (Name + Email inputs), `Segment`
  select (default **All contacts**, then segments with cached counts).
- **Content mode toggle:** **Visual Builder** / **HTML** / **From Template**.
  - Visual Builder uses the drag-and-drop `VisualBuilder` (3.4).
  - HTML uses a raw textarea "HTML Body" + live iframe **Preview**.
  - From Template uses a select "Choose a template..." + iframe preview; a link
    "create a new template" navigates to `/templates/new`.
- **Behavior:** creates a draft only; returns to the list. No send/schedule here.
- **Route:** `POST /v1/campaigns` (`useCreateCampaign`).

### 3.3 Campaigns - detail (view: "Campaign")
- **File:** `apps/blast/src/pages/campaign-detail.tsx`. **URL:** `/blast/campaigns/:id`.
- **Header:** back arrow, name + subject, status badge.
- **Primary action:** **Send Now** - rendered only for draft/scheduled ("Sending...").
  `POST /v1/campaigns/:id/send` (`useSendCampaign`).
- **Primary metrics:** Total Sent, Delivered, Opened (+open rate), Clicked (+click rate).
- **Secondary metrics:** Bounced, Unsubscribed, Complaints.
- **Top Clicked Links** table (analytics `click_urls`).
- **Campaign Details:** From, Sent Date, Scheduled, Recipients, Created.
- **Recipients** table (25/page, Prev/Next): Email, Status icon (Delivered/Sent/Bounced/
  Failed/Pending), Sent, Delivered, Bounced.
- **Routes:** `GET /v1/campaigns/:id`, `/analytics`, `/recipients`; `POST .../send`.
- **GAP:** no UI for schedule/pause/cancel/edit/delete though backend routes exist
  (`useScheduleCampaign` defined but unused). See Sec 7.

### 3.4 Visual template builder (shared component)
- **Files:** `apps/blast/src/components/templates/visual-builder.tsx`, `block-types.ts`,
  `block-props-editor.tsx`, `blocks-to-html.ts`. Used by Campaign-new and Template editor.
- **Layout:** left **palette** (click-to-add: Heading, Text, Image, Button, Divider,
  Columns, Social, Spacer); center sortable block list with drag handles + per-block
  Duplicate/Remove; right property editor; bottom live preview with **desktop/tablet/mobile**
  width toggles (600/480/320 px) and a Code/Eye source toggle.
- **Output:** `blocksToHtml(blocks)` produces email-safe inline HTML; block array saved as
  `json_design`.

### 3.5 Templates - gallery (view: "Templates")
- **File:** `apps/blast/src/pages/template-gallery.tsx`. **URL:** `/blast/templates`.
- **Header:** Templates; subtitle "Reusable email templates for your campaigns".
- **Primary action:** **New Template** navigates to `/templates/new`.
- **Search:** "Search templates..." (server `?search=`).
- **Cards:** name, subject_template, version badge `v{n}`, description, relative updated time.
  Hover: **Duplicate** (copy) and **Delete** (trash, confirm dialog "Delete this template?").
  Click goes to `/templates/:id/edit`.
- **Routes:** `GET /v1/templates`, `POST /v1/templates/:id/duplicate`, `DELETE /v1/templates/:id`.

### 3.6 Templates - editor (view: "New Template" / "Edit Template")
- **File:** `apps/blast/src/pages/template-editor.tsx`. **URL:** `/blast/templates/new`,
  `/blast/templates/:id/edit`.
- **Header:** back arrow, title; **Visual / HTML** toggle; **Save Template** ("Saving...";
  disabled until name + subject).
- **Meta fields:** `Template Name *`, `Subject Line *` (with live merge preview), `Description`.
- **Body:** visual builder (3.4) or raw HTML + live iframe preview.
- **Default new-template blocks** include a footer with an `{{unsubscribe_url}}` link.
- **Routes:** `POST /v1/templates`, `PATCH /v1/templates/:id` (bumps version),
  `GET /v1/templates/:id`.
- **NOTE:** `POST /v1/templates/:id/preview` exists (server-side merge render) but the
  editor previews client-side and never calls it.

### 3.7 Segments - list (view: "Segments")
- **File:** `apps/blast/src/pages/segment-list.tsx`. **URL:** `/blast/segments`.
- **Header:** Segments; subtitle "Target specific groups of contacts for your campaigns".
- **Primary action:** **New Segment** navigates to `/segments/new`.
- **Search:** "Search segments..." (server `?search=`).
- **Table columns:** Segment (name + description), Contacts (cached_count), Conditions
  ("N condition(s), match all|any"), Last Updated, Actions.
- **Row actions:** **Recalculate count** (refresh -> `POST /v1/segments/:id/count`) and
  **Delete** (trash, confirm dialog "Delete this segment?").
- **Routes:** `GET /v1/segments`, `POST /v1/segments/:id/count`, `DELETE /v1/segments/:id`.

### 3.8 Segments - builder (view: "New Segment")
- **File:** `apps/blast/src/pages/segment-builder.tsx`. **URL:** `/blast/segments/new`.
- **Header:** back arrow + New Segment.
- **Fields:** `Segment Name`, `Description`.
- **Match toggle:** **ALL conditions (AND)** / **ANY condition (OR)**.
- **Conditions:** field select (Lifecycle Stage, Lead Source, Lead Score, City, Country,
  Last Contacted), operator select (equals, does not equal, is one of, contains, greater
  than, less than, older than (days)), value input; **Add Condition** link; per-row trash.
  The "is one of" operator splits the value on commas.
- **Footer:** **Create Segment** ("Saving...") + **Cancel**.
- **Route:** `POST /v1/segments` (`useCreateSegment`).
- **GAP:** create-only; no segment edit page though `PATCH /v1/segments/:id` exists. UI omits
  3 backend fields + 2 operators (Sec 7).

### 3.9 Analytics dashboard (view: "Analytics" / title "Email Analytics")
- **File:** `apps/blast/src/pages/analytics-dashboard.tsx`. **URL:** `/blast/analytics`.
- **Stat cards:** Total Sent, Delivered, Avg Open Rate (+opens), Avg Click Rate (+clicks),
  Bounce Rate (+bounced).
- **Tiles:** Campaigns Sent, Unsubscribes.
- **Weekly Engagement Trend** table: Period, Campaigns, Sent, Open Rate, Click Rate.
- **Routes:** `GET /v1/analytics/overview`, `GET /v1/analytics/engagement-trend?period=weekly`.
  Both count only `sent` campaigns.
- **NOTE:** `GET /v1/campaigns/:id/analytics/devices` exists but is unused by the SPA.

### 3.10 Settings - Sender Domains (view: "Domains" / title "Sender Domains")
- **File:** `apps/blast/src/pages/domain-settings.tsx`. **URL:** `/blast/settings/domains`.
- **Subtitle:** "Verify your sending domains for better deliverability".
- **Add row:** domain input ("e.g., company.com") + **Add Domain**.
- **Per-domain card:** name; **Verify DNS** (refresh) and **Remove** (trash, confirm dialog
  "Remove this domain?"); SPF / DKIM / DMARC check/x icons; "Required DNS Records" list
  (type/name/value).
- **Routes:** `GET /v1/sender-domains`, `POST /v1/sender-domains`,
  `POST /v1/sender-domains/:id/verify`, `DELETE /v1/sender-domains/:id`.
- **Permissions:** add/delete need `admin` scope (`blast.sender_domain.create|delete`);
  verify needs `blast.sender_domain.verify`.

### 3.11 Settings - SMTP (view: "SMTP" / title "SMTP Settings")
- **File:** `apps/blast/src/pages/smtp-settings.tsx`. **URL:** `/blast/settings/smtp`.
- **Content:** informational "Platform SMTP" card - Blast keeps no SMTP creds; the relay lives
  in `system_settings`, configured in Bam Account Settings -> Integrations.
- **Role-aware CTA** (reads `user.is_superuser` / `user.role`):
  - SuperUser: blue box + **Open Account Settings** -> `/b3/settings`.
  - Org admin/owner: amber box + **View in Account Settings** -> `/b3/settings`.
  - Other roles: neutral "contact your admin" box (no button).
- **No backend route** - static deep-link card (replaced a former fake SMTP form).

### 3.12 In-app Help
- `/blast/help` renders shared `HelpViewer` with `appSlug="blast"` (`app.tsx` 137-139),
  opened via the `?` key.

### 3.13 Tracking & unsubscribe (no UI, no auth)
- **Files:** `tracking.routes.ts`, `tracking.service.ts`. No `/v1` prefix.
- `GET /t/o/:token` - open pixel. Records `open`, increments `total_opened`, emits
  `engagement.opened`, returns a 1x1 GIF. Unknown token still returns a pixel.
- `GET /t/c/:token?url=...` - click redirect. Validates http/https (rejects javascript:/data:),
  records `click` + `clicked_url`, increments `total_clicked`, emits `engagement.clicked`,
  then 302-redirects. Unknown token -> 404. Bad/missing url -> 400 `INVALID_REDIRECT_URL`.
- `GET /unsub/:token` - HTML confirmation page (recipient email + "Confirm Unsubscribe" form
  that POSTs the same path). Bad token -> "Invalid Link" page.
- `POST /unsub/:token` - upserts into `blast_unsubscribes`, records `unsubscribe`, increments
  `total_unsubscribed`, emits `engagement.unsubscribed`, renders "You have been unsubscribed".

### 3.14 Provider webhooks (no UI)
- **Files:** `webhooks.routes.ts`, `webhook.service.ts`. Under `/v1`. Optional
  `X-Webhook-Secret` header (`BLAST_WEBHOOK_SECRET`; if unset, allowed with a one-time warning).
- `POST /v1/webhooks/bounce` - body has message_id?, email?, bounce_type (hard|soft|complaint),
  reason?. Marks send_log `bounced`, records a `bounce` row, increments `total_bounced`, emits
  `engagement.bounced`. **Email-only (no message_id) is rejected** (BLAST-012 cross-org safety).
- `POST /v1/webhooks/complaint` - body has message_id?, email?. Marks `complained`, records a
  `complaint` row, increments `total_complained`, **auto-unsubscribes** the email, emits
  `engagement.bounced` (complaint variant). Same email-only rejection.

---

## 4. Full REST route reference (blast-api)

Browser-facing prefix is `/blast/api`. Authenticated `/v1` routes need a Bam session
(`requireAuth`); write routes also need `read_write` scope plus a per-action `requireCan(...)`
permission; sender-domain mutations need `admin` scope. Tracking and webhook routes are
unauthenticated.

**Campaigns** (`campaigns.routes.ts`, all `/v1`):

| Method | Path | Permission / scope | Purpose |
|---|---|---|---|
| GET | `/campaigns` | auth | List (`?status`, `?limit`<=100, `?offset`). Returns `{data,total,limit,offset}`. |
| POST | `/campaigns` | `blast.campaign.create` + read_write, 20/min | Create draft. Emits `campaign.created`. |
| GET | `/campaigns/:id` | auth | Get one. |
| PATCH | `/campaigns/:id` | `blast.campaign.update` + read_write | Update (draft/scheduled only). |
| DELETE | `/campaigns/:id` | `blast.campaign.delete` + read_write | Delete (draft only). |
| POST | `/campaigns/:id/send` | `blast.campaign.send` + read_write | CAN-SPAM check, status to sending, enqueue worker, emit `campaign.sent`. |
| POST | `/campaigns/:id/schedule` | `blast.campaign_schedule.create` + read_write | Body scheduled_at (future). CAN-SPAM check, status to scheduled. |
| POST | `/campaigns/:id/pause` | `blast.campaign_pause.create` + read_write | sending to paused. |
| POST | `/campaigns/:id/cancel` | `blast.campaign.cancel` + read_write | scheduled/sending/paused to cancelled. |
| GET | `/campaigns/:id/analytics` | auth | Rates + event/click/delivery breakdowns. |
| GET | `/campaigns/:id/recipients` | auth | Per-recipient send-log page. |
| GET | `/campaigns/:id/analytics/devices` | auth | Client/device breakdown (UNUSED by UI). |

**Templates** (`templates.routes.ts`, `/v1`): GET `/templates`; POST `/templates`
(`blast.template.create`, 20/min); GET `/templates/:id`; PATCH `/templates/:id`
(`blast.template.update`, bumps version); DELETE `/templates/:id` (`blast.template.delete`);
POST `/templates/:id/preview` (auth, UNUSED by UI); POST `/templates/:id/duplicate`
(`blast.template.duplicate`).

**Segments** (`segments.routes.ts`, `/v1`): GET `/segments`; POST `/segments`
(`blast.segment.create`, 20/min); GET `/segments/:id`; PATCH `/segments/:id`
(`blast.segment.update`, UNUSED by UI); DELETE `/segments/:id` (`blast.segment.delete`);
POST `/segments/:id/count` (auth, recalc cache); GET `/segments/:id/preview` (auth, first 50);
POST `/segments/:id/evaluate` (auth, full recipient list used at send time).

**Sender domains** (`sender-domains.routes.ts`, `/v1`): GET `/sender-domains`; POST
`/sender-domains` (`blast.sender_domain.create` + admin); POST `/sender-domains/:id/verify`
(`blast.sender_domain.verify`); DELETE `/sender-domains/:id` (`blast.sender_domain.delete`
+ admin).

**Analytics** (`analytics.routes.ts`, `/v1`): GET `/analytics/overview` (org rollup, sent
campaigns only); GET `/analytics/engagement-trend?period=daily|weekly|monthly`; GET
`/analytics/unsubscribe-check?email=`.

**Tracking** (no prefix): `GET /t/o/:token`, `GET /t/c/:token`, `GET /unsub/:token`,
`POST /unsub/:token`.

**Webhooks** (`/v1`): `POST /webhooks/bounce`, `POST /webhooks/complaint`.

**Error envelope / not-found:** standard `{error:{code,message,details,request_id}}`
(`server.ts`). Security headers on every response: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Cache-Control: no-store`.

---

## 5. CAN-SPAM compliance gate (user-facing rule)

`validateCanSpamCompliance` in `campaign.service.ts` runs on **send** and **schedule** and
rejects the campaign (HTTP 400) unless the HTML body contains BOTH:
1. an unsubscribe mechanism: substring `unsub`, `opt-out`, `opt out`, `{{unsubscribe_url}}`,
   or `%unsubscribe_url%`; and
2. a physical mailing address: a street-address regex match, `{{physical_address}}`,
   `%physical_address%`, `p.o. box`, or `po box`.

That is why the default new-template footer includes an `{{unsubscribe_url}}` link. There is
no front-end warning before Send Now; the error surfaces from the API mutation. Worth a
"why did my send fail" note in help.md.

---

## 6. Candidate user stories

1. **Send a one-off campaign from scratch.** Campaigns -> **New Campaign** -> fill Name +
   Subject + From -> pick **Segment** (or All contacts) -> build body in **Visual Builder**
   (or **HTML**) ensuring an unsubscribe link + physical address are present -> **Create
   Campaign** -> open the campaign -> **Send Now**. Routes: `POST /campaigns`, then
   `POST /campaigns/:id/send`.

2. **Reuse a saved template for a campaign.** New Campaign -> content mode **From Template**
   -> choose a template (subject + body prefill) -> adjust -> **Create Campaign** -> **Send
   Now**.

3. **Author and version a reusable template.** Templates -> **New Template** -> name + subject
   + design blocks -> **Save Template**. Later: open template -> edit -> **Save Template**
   (version bumps). Or **Duplicate** to fork. Routes: `POST /templates`, `PATCH
   /templates/:id`, `POST /templates/:id/duplicate`.

4. **Build a targeted segment from CRM data.** Segments -> **New Segment** -> name -> choose
   **ALL/ANY** match -> add field/operator/value conditions (e.g. Lifecycle Stage equals
   "customer") -> **Create Segment**. On the list, **Recalculate count** to see how many Bond
   contacts match. Routes: `POST /segments`, `POST /segments/:id/count`.

5. **Review campaign performance.** Open a sent campaign for Opened/Clicked rates, Top Clicked
   Links, per-recipient delivery table. Or Analytics for org-wide Avg Open/Click/Bounce +
   Weekly Engagement Trend.

6. **Verify a sending domain for deliverability.** Settings -> **Domains** -> **Add Domain**
   -> copy the shown SPF/DKIM/DMARC records into your DNS host -> **Verify DNS**. Needs
   `admin` scope.

7. **Configure outbound email (SMTP).** Settings -> **SMTP** -> (SuperUser/admin) **Open
   Account Settings** -> Bam Account Settings -> Integrations -> enter the platform SMTP relay.
   Prerequisite for any real send.

8. **A recipient unsubscribes / a message bounces (automatic).** Recipient clicks unsubscribe
   -> `/unsub/:token` page -> confirms -> suppressed org-wide. Provider posts to
   `/v1/webhooks/bounce|complaint` -> counters update, complaints auto-unsubscribe. No operator
   action; visible in campaign metrics.

9. **Cross-app: nurture a Bond contact group, then react in Bolt.** Build a segment over Bond
   contacts -> send a campaign -> opens/clicks/unsubs/bounces emit `engagement.*` events and
   `campaign.sent`/`campaign.completed` -> a Bolt rule can create a Bam task or update the Bond
   contact. (See Sec 8.)

---

## 7. Discrepancies (docs/marketing vs. code)

1. **"archived" campaign state does not exist.** `guide.md`, `marketing.md`, `_narrative.md`
   claim "draft, scheduled, sent, and archived states". Code has
   draft/scheduled/sending/paused/sent/cancelled - NO `archived` (and docs omit sending,
   paused, cancelled). Source: `campaign.service.ts`, `utils.ts`, `campaign-list.tsx`.

2. **"A/B testing" is not implemented.** `guide.md`/`marketing.md` claim "A/B testing support".
   No split/variant/winner logic exists in blast-api or the frontend. The only adjacent thing
   is the MCP `blast_suggest_subject_lines` stub returning 5 templated strings.

3. **"SMTP Configuration for bring-your-own email infrastructure"** is misleading. SMTP is
   platform-wide in `system_settings`; the Blast SMTP page is read-only/informational and
   stores nothing (`smtp-settings.tsx`). No per-org BYO-SMTP in Blast.

4. **Segment builder under-exposes backend capability.** Backend supports fields `email`,
   `first_name`, `last_name` and operators `is_set`, `is_not_set` (`segment.service.ts`), but
   the builder UI offers only 6 fields and 7 operators. Agents (via MCP `blast_create_segment`)
   can use the full set; humans cannot via the UI.

5. **Segment "tags"/"activity" targeting claimed but absent.** Docs say segments filter "by
   attributes, tags, activity, and custom conditions". `CONTACT_COLUMN_MAP` only covers Bond
   contact scalar columns - no tags, activity, or custom fields.

6. **Worker does not honor segments yet (REAL BUG).** `blast-send.job.ts` loads ALL org
   contacts (minus unsubscribed/empty-email) regardless of `segment_id` (comment lines 219-222:
   "Segment filter_criteria evaluation is a future enhancement"). The API has a working
   `/segments/:id/evaluate`, but the send job ignores it - so a segmented campaign still blasts
   the whole org.

7. **Campaign detail offers only Send Now.** Backend + a `useScheduleCampaign` hook exist for
   schedule/pause/cancel; update/delete routes exist; but no detail-page UI wires them.
   Scheduling, pausing, cancelling, editing, deleting are API/MCP-only today. (The MCP
   `blast_send_campaign` with `require_human_approval=true` actually calls `/schedule`.)

8. **`blast_draft_email_content` / `blast_suggest_subject_lines` are stubs.** Descriptions say
   "AI-generate", but the handlers return hard-coded templated strings - no LLM call (comment:
   "This would integrate with an LLM in production"). `mcp-tools.md` presents them as working
   AI features.

9. **`campaign.completed` payload shape drift.** The completion event payload is built inline
   in the worker (not via the enrichment helper), so it carries a flat `campaign.*` shape
   rather than the catalog `org: object` shape. Minor; registers fine in the catalog.

---

## 8. Agent flows (MCP)

Tools live in `apps/mcp-server/src/tools/blast-tools.ts` (14 tools). All hit the same
blast-api `/v1` REST surface with a bearer token; name-or-ID resolvers let agents reference
campaigns/templates/segments by human name (UUID is a fast path; exact name preferred, single
fuzzy match acceptable, multiple matches -> error).

| Tool | Maps to feature | Backing call | Notes |
|---|---|---|---|
| `blast_list_templates` | Template gallery | `GET /templates` | type/search/limit. |
| `blast_get_template` | Template editor (load) | `GET /templates/:id` | |
| `blast_create_template` | Template editor (create) | `POST /templates` | |
| `blast_draft_campaign` | New Campaign (create) | `POST /campaigns` | Resolves template/segment by name or UUID. |
| `blast_get_campaign` | Campaign detail | `GET /campaigns/:id` | Name-or-id resolver. |
| `blast_send_campaign` | Send Now | `POST /campaigns/:id/send` OR `/schedule` | **require_human_approval defaults true** -> schedules +1h "for review" instead of sending; only false sends now. HITL gate. |
| `blast_get_campaign_analytics` | Campaign analytics | `GET /campaigns/:id/analytics` | |
| `blast_list_segments` | Segment list | `GET /segments` | |
| `blast_create_segment` | Segment builder | `POST /segments` | Full field/operator set available. |
| `blast_preview_segment` | (no direct UI button) | `GET /segments/:id/preview` | First 50 contacts. |
| `blast_draft_email_content` | helper (stub) | none | Returns templated subject+html. |
| `blast_suggest_subject_lines` | helper (stub) | none | Returns 5 subject variants. |
| `blast_get_engagement_summary` | Analytics overview | `GET /analytics/overview` | |
| `blast_check_unsubscribed` | compliance | `GET /analytics/unsubscribe-check` | Suppression check before targeting. |

**Typical agent flow:** `blast_suggest_subject_lines` / `blast_draft_email_content` to draft
-> `blast_create_template` -> `blast_create_segment` / `blast_preview_segment` ->
`blast_draft_campaign` -> `blast_send_campaign` (which by default **schedules for human
review** rather than sending). Agents are expected to gate the actual dispatch behind a human.
`blast_check_unsubscribed` lets an agent honor suppression before adding a recipient.

**MCP agent-policy allowlist:** `blast.campaign.send` is registered as a proposable action in
the Bolt catalog (`apps/bolt-api/src/services/event-catalog.ts` ~line 2755).

### Bolt event integration (cross-app, source `blast`)
Registered in `apps/bolt-api/src/services/event-catalog.ts` (`blastEvents`, plus
`engagement.*` later in the file):
- `campaign.created` (POST /campaigns), `campaign.sent` (POST /campaigns/:id/send),
  `campaign.completed` (worker, idempotent via `completion_event_emitted`).
- `engagement.opened` (open pixel), `engagement.clicked` (click redirect),
  `engagement.unsubscribed` (unsub POST), `engagement.bounced` (bounce + complaint webhooks).
All published via `publishBoltEvent(event, 'blast', payload, orgId, actorId, actorType)`.
These let Bolt automations react to email activity. Confirmed cross-app references:
`docs/apps/bolt/guide.md` ("Blast (email opens)" in the event catalog) and
`docs/apps/bond/guide.md` ("Bond contacts feed into Blast email campaign segments; campaign
events flow back to Bond activity timelines").

---

## 9. Screenshots available

In `docs/apps/blast/screenshots/light/` and `.../dark/` (identical set per theme; 1440x900).
Catalogued in `docs/apps/blast/meta.json`.

| File | Label | Depicts | Illustrates |
|---|---|---|---|
| `light/01-campaigns.png` (+dark) | Campaign list | Campaigns table + status filters | Stories 1/5, Sec 3.1 |
| `light/02-campaign-new.png` (+dark) | New campaign form | Create form + content modes | Stories 1/2, Sec 3.2 |
| `light/03-templates.png` (+dark) | Template gallery | Template cards grid | Story 3, Sec 3.5 |
| `light/04-template-editor.png` (+dark) | Template editor | Visual builder editor | Story 3, Sec 3.6/3.4 |
| `light/05-segments.png` (+dark) | Segment list | Segments table | Story 4, Sec 3.7 |
| `light/06-segment-builder.png` (+dark) | Segment builder | Condition rows + match toggle | Story 4, Sec 3.8 |
| `light/07-analytics.png` (+dark) | Analytics dashboard | Stat cards + trend table | Story 5, Sec 3.9 |

**No screenshots exist for:** Campaign detail (Sec 3.3, incl. Send Now), Sender Domains
(3.10), SMTP settings (3.11), or the unsubscribe page. Flag these as screenshot gaps -
campaign detail / Send Now is the most important missing one.

---

## 10. Open questions

1. **Will the worker ever honor `segment_id`?** Currently every send targets the whole org
   (`blast-send.job.ts` 219-222). Known/tracked bug or intended interim behavior?
2. **Delivered counting.** Worker sets `total_delivered = sentCount` immediately (line 366,
   "actual delivery confirmation comes from webhooks"), but there is no `/webhooks/delivered`
   route - only bounce/complaint. So Delivered is "attempted minus failed", corrected only by
   bounces. Intended?
3. **No delivery webhook.** Bounce/complaint exist; is a delivery webhook expected, from which
   provider?
4. **Schedule/pause/cancel/edit/delete UI.** Intentionally MCP/API-only, or just not built?
   `useScheduleCampaign` is defined but unused.
5. **`/templates/:id/preview` and `/campaigns/:id/analytics/devices`** are implemented but
   unused by the SPA. Reserved for a future UI (device breakdown chart, server-side preview)?
6. **`BLAST_WEBHOOK_SECRET` default-open.** When unset, webhook endpoints accept unsigned posts
   (with a warning). Acceptable in production, or should docs warn operators to set it?
7. **A/B testing & AI drafting** are marketed but not real (Sec 7). Should help.md document
   them as roadmap, or omit them?
