# Blank - Forms and surveys

> Blank is the forms and surveys app in BigBlueBam. Build a form with drag-and-drop fields, publish it to a public URL, and collect and review responses without writing any code.

## Overview

Blank lets you build forms and surveys, publish them, and gather responses from anyone with the link. You start from the Forms list, design the form in a visual builder by adding fields from a palette, set who can see it, then publish to get a shareable public URL. Responses flow back into a Responses table and an Analytics view.

The core objects are **forms** and **submissions**. A form holds a set of ordered fields and a collection of behavior settings (visibility, confirmation, theming, response limits). A submission is one filled-in response, stored against the form. Forms move through a lifecycle from draft to published, and an author can later close a form to stop accepting responses.

Blank fits alongside the rest of the suite as the intake layer. Forms can be scoped to your organization or to a specific Bam project, and submitted responses can be routed into Bond (as a contact) or Helpdesk (as a ticket) when that routing is configured at the API level.

Authoring happens in the Blank SPA, which requires a BigBlueBam login. Filling out and submitting a published form does not require a login when the form is set to public visibility.

### Key concepts

- **Form** - the top-level object you build and share. It has a name, a slug (used in its public URL), a description, fields, and behavior settings.
- **Field** - a single input or element on the form. Fields are ordered, can be marked required, and each has a stable **field key** (letters, digits, and underscores; must start with a letter or underscore) used as the storage key for answers.
- **Field type** - what kind of input a field is, for example Short Text, Email, Rating, NPS, or Dropdown. You pick the type from the builder palette when you add a field. A few layout-only types (Section Header, Paragraph, Hidden Field, and Page Break) carry no submitted answer.
- **Form status** - the lifecycle state of a form: **draft** (still being built), **published** (live and accepting responses), or **closed** (no longer accepting responses). New forms start as draft.
- **Form type** - a label on the form (Public, Internal, or Embedded) found on the per-form Settings page.
- **Visibility** - who can reach the form through its URL: **Public** (anyone with the link), **Organization** (members of your org), or **Project members** (members of a chosen Bam project).
- **Logic (conditional display)** - a field can be configured to show only when another field meets a condition (for example, equals or contains a value). This is stored on the field and is available to agents through the MCP field tools; the visual builder does not yet expose a conditional editor.
- **Submission** - one response to a form. Submissions are listed in the Responses view and aggregated in Analytics.
- **Confirmation** - what a respondent sees after submitting: a message, a redirect, or a custom page.
- **Public form URL** - the shareable link to your published form, in the form `https://YOUR-DOMAIN/forms/<slug>`. This is the server-rendered page the Publish dialog hands you.

### Where to find it

Blank is served at `/blank/`. Reach it from the Launchpad app switcher in the top-left of the layout chrome, or go directly to `/blank/`.

The left sidebar has two items: **Forms** (the Forms list at `/blank/`) and **Blank Settings** (a read-only app information page at `/blank/settings`). Pressing the question-mark key opens this Help.

Prerequisites:

- A BigBlueBam session or a `bbam_` / `bbam_svc_` API key. Unauthenticated visitors to the authoring SPA see a "Please log in to BigBlueBam first" screen with a link to `/b3/`.
- Membership in an organization. All forms and submissions are scoped to your org.
- Publishing a form requires the `blank.form.publish` permission. Closing a form requires `blank.form.close`, and deleting a submission requires `blank.submission.delete`.

## Feature reference

### Forms list

The Forms list at `/blank/` is the home screen. It is headed **Forms** with the subtitle "Build forms and surveys to capture responses from anyone." Each form appears as a card showing its name, description, a status pill (draft, published, or closed), the field count, the submission count, and a relative "updated" time.

![Forms list](screenshots/light/01-form-list.png)

To create a form:

1. Click **New Form** (the button with the plus icon, top-right).
2. Blank creates a draft named "Untitled Form" with a generated slug and opens it in the builder.
3. Continue in the builder to rename it and add fields.

To open an existing form:

1. Click the form's card. The builder opens at `/blank/forms/<id>/edit`.

Each card has an overflow menu (the three-dot icon that appears on hover). It contains:

- **Preview** - opens the full-page Form Preview.
- **Responses** - opens the Responses table for the form.
- **Duplicate** - clones the form and its fields into a new draft. The copy's name gets "(Copy)" appended and it starts as a draft.
- **Delete** - permanently removes the form. This also removes its fields and submissions. This action is destructive and cannot be undone.

If you have no forms yet, the list shows an empty state: "No forms yet" with "Create your first form to start collecting responses."

### Form Builder

The builder at `/blank/forms/<id>/edit` is where you design a form. It has a left field palette, a center canvas, an optional right field-config panel, and an optional live-preview panel.

![Form builder](screenshots/light/02-form-builder.png)

The left palette is headed **Add Field**. Click any type to append a field of that type to the canvas. The available types are:

Short Text, Long Text, Email, Phone, URL, Number, Single Select, Multi Select, Dropdown, Date, Time, Rating, Scale, NPS, Checkbox, Toggle, File Upload, Section Header, Paragraph, Hidden Field, and Page Break.

To name the form:

1. In the center canvas, edit the form Title input at the top.
2. Edit the Description input below it. Both save automatically as you type.

To add a field:

1. Click a type in the **Add Field** palette on the left.
2. The new field appears at the bottom of the canvas. Click it to configure it in the Field Settings panel on the right.

To reorder fields:

1. Drag a field row by its grip handle and drop it in the new position. The order is saved automatically.

To delete a field:

1. Click the trash icon on the field row in the canvas.

The top-right action bar of the builder has these controls:

- **Preview** (eye icon) - toggles the live-preview panel on the right.
- **Settings** (gear icon) - opens the Form Settings dialog (visibility, expiration, and project).
- **Share** (external-link icon) - appears only after the form is published. It reopens the "Your form is live" dialog with the public URL.
- **Publish** (send icon) - publishes the form. It is disabled once the form is already published.

If the form has no fields, the canvas shows "Click a field type on the left to add it".

The palette's **Page Break** item splits a form into pages. Adding one inserts a layout-only divider in the builder rather than a stray input, and the public form pages at that boundary. See "Multi-page forms" below. You can also page a form by setting the **Page Number** on individual fields in Field Settings.

### Field Settings

When you select a field in the canvas, the right panel is headed **Field Settings**. The controls available depend on the field's type. Every control saves to the field when you change it or leave the input.

Common controls:

- **Label** - the visible question text.
- **Key** - the field key (shown in a monospace font). This is the storage key for the answer.
- **Description** - helper text shown under the label.
- **Placeholder** - placeholder text inside the input.
- **Required** - a checkbox that makes the field mandatory.
- **Page Number** - which page the field belongs to in a multi-page form.

Type-specific controls:

- **Options editor** - for Single Select, Multi Select, and Dropdown. Use "+ Add option" to add choices.
- **Min Length** and **Max Length** - for text fields.
- **Min Value** and **Max Value** - for numeric fields.
- **Scale Min** and **Scale Max** - for Scale fields.
- **Regex Pattern** - an optional validation pattern applied to string answers.

Layout-only fields (Section Header, Paragraph, Hidden Field, and Page Break) do not show validation controls like the regex pattern, because they collect no answer.

### Form Settings dialog

The **Settings** button in the builder action bar opens the Form Settings dialog, titled **Form Settings**. It covers visibility, expiration, project scoping, who may submit (sign-in and allowed email domains), and submission notifications (email and Banter).

![Form settings](screenshots/light/06-form-settings-dialog.png)

To set visibility:

1. Click **Settings** in the builder.
2. Under Visibility, choose one of the radio options:
   - **Public** - "Anyone with the link can view and submit this form."
   - **Organization** - "Only members of your organization can view this form."
   - **Project members** - "Only members of the chosen project can view this form."
3. If you choose **Project members**, a **Project** picker appears. Select a Bam project.
4. Click **Save**. Save is disabled if you chose Project members without picking a project.

To set an expiration:

1. In the Form Settings dialog, use the **Expires at** datetime field to set when the form stops accepting responses.
2. Use the **Clear** button next to it to remove an expiration.
3. Click **Save**.

Use **Cancel** to close the dialog without saving.

#### Access control and notifications

Below visibility and expiration, the Form Settings dialog has controls for who may submit and what happens when they do. These are enforced and delivered for real.

![Access control and notifications](screenshots/light/07-access-and-notifications.png)

- **Require sign-in to submit** - a checkbox. When on, a visitor must be signed in to a BigBlueBam account before they can submit (or upload a file). An anonymous attempt is rejected with a "You must be signed in to submit this form" error.
- **Allowed email domains** - a comma-separated list, for example `acme.com, example.org`. When set, only a submitter whose email is on one of these domains may submit; everyone else is rejected with a "Submissions from ... are not allowed" error. The submitter's email is taken from their signed-in account, the form's email field, or an explicit email in the response, in that order. Leave the field blank to allow any domain. A leading `@` is tolerated and stripped.
- **Email me on new submissions** - a checkbox that turns on notification emails for this form.
- **Notification recipients** - a comma-separated list of email addresses to notify on each new submission. Used together with **Email me on new submissions**.
- **Post to Banter channel** - an optional picker. When a channel is chosen, each new submission also posts a short message to that Banter channel.

To gate who can submit:

1. Click **Settings** in the builder.
2. Check **Require sign-in to submit** to force authentication, and/or enter one or more domains under **Allowed email domains**.
3. Click **Save**.

To get notified of submissions:

1. Click **Settings** in the builder.
2. Check **Email me on new submissions** and enter one or more addresses under **Notification recipients**.
3. (Optional) Pick a **Post to Banter channel** target.
4. Click **Save**.

> Note: the sign-in and allowed-domain gates are enforced on the public submit and file-upload paths. Combine them with **Visibility** (org or project membership) for layered access control. Notification and confirmation emails are dispatched through your deployment's SMTP transport; where SMTP is not configured, the worker logs the message instead of delivering it.

### Publish dialog

When you click **Publish** in the builder, Blank publishes the form (it must have at least one field) and opens the publish-result dialog, titled **Your form is live**.

The dialog shows:

- A read-only public URL of the shape `https://YOUR-DOMAIN/forms/<slug>`.
- A **Copy** button that copies the URL (the button text changes to "Copied").
- An **Open in new tab** link.
- The form's current visibility label.
- A **Done** button to close the dialog.

To share a published form:

1. Click **Publish** (or **Share**, if the form is already published) in the builder.
2. In the **Your form is live** dialog, click **Copy** to copy the public URL, or **Open in new tab** to view it.
3. Click **Done**.

> Note: the URL handed out here is the server-rendered page at `/forms/<slug>`. That is the canonical public form. This is the link to share with respondents.

### Preview

Preview shows the form exactly as a respondent would see it, without accepting input.

![Live preview](screenshots/light/03-form-preview.png)

There are two ways to preview:

- In the builder, click **Preview** (eye icon) to toggle the live-preview panel on the right. The panel renders the form as you edit and splits a multi-page form at page boundaries with Previous and Next controls and a progress bar.
- From the Forms list overflow menu, click **Preview**, or go to `/blank/forms/<id>/preview`, for the full-page Form Preview. The header has a "Back to Builder" link and a "PREVIEW MODE" label, and all inputs are disabled.

### Responses

The Responses view lists every submission for a form. Open it from a form card's overflow menu (**Responses**) or at `/blank/forms/<id>/responses`. The page is titled "<form name> - Responses" and shows the submission count. The back chevron returns you to the builder.

![Responses table](screenshots/light/04-responses.png)

Actions on the Responses page:

- **Analytics** - opens the Analytics view for this form.
- **Export CSV** - downloads all submissions for the form as a CSV file named `submissions.csv`.

To filter by attachment processing state:

1. Use the **Attachment status:** filter pills above the table: all, pending, processing, complete, or failed. This filters the visible rows.

The table columns are: a row number (#), **Email**, the first five display fields' answers, **Files** (a processing-status pill), and **Date**. If there are no submissions, the table shows "No responses yet."

File uploads are real. When a respondent attaches a file to a File Upload field, the bytes are uploaded to object storage (MinIO/S3) before the form is submitted, and the submission carries a stored-object reference. A background worker then validates each stored file (extension and MIME allowlist, confirming the object actually landed in storage), records the verified file on the submission, and mints a short-lived download link. The **Files** pill reflects that real outcome: **pending** (awaiting the worker), **processing**, **complete** (every file validated and stored), or **failed** (a file was rejected, for example a disallowed type or a missing object). Uploads are constrained to a size cap and an allowlist of image, document, spreadsheet, CSV, plain-text, and zip types; SVG is always blocked.

To export responses:

1. Open the Responses view for the form.
2. Click **Export CSV**. The browser downloads `submissions.csv` with every submission.

### Analytics

The Analytics view aggregates the responses to a form. Open it with the **Analytics** button on the Responses page or at `/blank/forms/<id>/analytics`. The page is titled "<form name> - Analytics" and shows the total submission count.

![Form analytics](screenshots/light/05-analytics.png)

It contains:

- Summary cards: **Total Submissions**, **Active Fields**, and **Form Status**.
- A **Submissions (Last 30 Days)** bar chart driven by the daily submission trend.
- A **Per-Field Breakdown** section. For each non-decorative field, this shows aggregated values: option counts for select, multi-select, and dropdown fields; numeric statistics (average, minimum, maximum, and count) for rating, scale, NPS, and number fields; and a text count for other fields.

### Per-form Settings page

Each form has a settings page at `/blank/forms/<id>/settings` with additional toggles. Reach it by entering the URL directly. The builder's **Settings** button opens the in-builder Form Settings dialog instead, which covers only visibility, expiration, and project.

The per-form Settings page has these sections:

- **Access** - **Form Type** (Public, Internal, Embedded), **Accept Responses** (whether new submissions are accepted), and **One per Email** (limit to one submission per email address).
- **Confirmation** - **Type** (Show Message, Redirect, or Custom Page) and a **Confirmation Message** textarea.
- **Branding** - a **Theme Color** picker and a **Show Progress Bar** checkbox for multi-page forms.
- **Notifications** - an **Email on Submit** checkbox to be notified when someone submits.

Each control saves immediately when you change it.

Email on submit is real. When a form has **Email on Submit** turned on (with recipients configured) or a respondent supplies their email, a background worker sends two kinds of message: a confirmation email to the respondent (using the form's confirmation message) and a notification email to each configured recipient summarizing the new submission. Delivery goes out through the configured SMTP transport; if SMTP is not configured in your deployment, the worker logs the message it would have sent instead of dropping it silently, so the wiring is the same whether or not mail is delivered. The richer access and notification controls (recipient list, Banter channel, sign-in requirement, allowed domains) live in the in-builder **Form Settings** dialog described above; this page exposes the single **Email on Submit** toggle.

### Multi-page forms

A longer form can be split across pages so respondents work through it a section at a time.

There are two ways to page a form:

- **Page Break field.** In the builder, click **Page Break** in the **Add Field** palette wherever you want a page boundary. It appears as a divider in the builder (it collects no answer) and the public form starts a new page there.
- **Page Number.** Select a field in the canvas and set its **Page Number** in Field Settings, assigning each field to the page you want it on.

To show a progress bar across the pages, open the per-form Settings page at `/blank/forms/<id>/settings` and enable **Show Progress Bar** under Branding. Use **Preview** to confirm the pages before you publish.

### Blank Settings (app-level)

The **Blank Settings** item in the sidebar opens a read-only information page at `/blank/settings`, headed **Settings**. It displays the app defaults (default form type Public, default theme color #3b82f6), the rate-limiting policy (10 submissions per hour), and the events Blank emits. Nothing on this page is editable.

### Public form

A published form is served as a self-contained HTML page at `https://YOUR-DOMAIN/forms/<slug>`. This is the page the Publish dialog gives you and the one respondents fill out. It renders the form's fields, splits a multi-page form across pages with Back and Next controls and a progress bar, optionally collects the respondent's email, and shows the confirmation (message, redirect, or page) after a successful submission.

Public submission is anonymous for forms set to Public visibility. Forms set to Organization or Project members visibility check that the caller belongs to the org or the chosen project before rendering or accepting a submission. The public submit endpoint is rate-limited to 10 submissions per hour per IP, and a form can also enforce a per-email limit, a maximum response count, and an expiration date.

A form can additionally require sign-in and restrict submitters to an allowed set of email domains, both enforced on the public submit and file-upload paths (see "Access control and notifications" under Form Settings dialog). With **Require sign-in to submit** on, an unauthenticated submit or upload is rejected. With **Allowed email domains** set, a submitter whose email is not on an allowed domain is rejected. These gates stack with visibility, the per-email limit, the maximum response count, and the expiration date.

File Upload fields are accepted on the public form: the respondent's file is uploaded to object storage before the form is submitted, the submission references the stored object, and a background worker validates the file (type allowlist, and confirming the object landed) and records it with a download link. The **Files** pill on the Responses table reflects that real outcome.

### Working with AI agents

Agents drive Blank through MCP tools that proxy to the same API the SPA uses. The tools share your permissions, so an agent can only do what you could do. There are 20 Blank MCP tools, and together they cover the full authoring lifecycle: generate, create, edit fields, publish, close, duplicate, delete, and read or export responses.

Generate and create:

- Draft a form from a description with **`blank_generate_form`**, which returns a suggested form specification (it does not save anything). Its heuristics seed fields when the description mentions name, email, phone, NPS, rating or satisfaction, feedback or comment, and bug or issue.
- Create the draft with **`blank_create_form`**, which accepts inline field definitions.

Edit structure:

- Add a field with **`blank_add_field`** (it accepts the conditional-display arguments `conditional_on_field_id`, `conditional_operator`, and `conditional_value`).
- Change a field with **`blank_update_field`**, remove one with **`blank_delete_field`**, and reorder them with **`blank_reorder_fields`**.

Inspect, publish, and manage lifecycle:

- List and read forms with **`blank_list_forms`** and **`blank_get_form`**.
- Update form metadata with **`blank_update_form`**.
- Publish a draft with **`blank_publish_form`** and stop new responses with **`blank_close_form`**.
- Clone a form with **`blank_duplicate_form`**, get its iframe snippet with **`blank_get_embed_code`**, and remove a form with **`blank_delete_form`** (destructive).

Read and report on responses:

- List and read submissions with **`blank_list_submissions`** and **`blank_get_submission`**.
- Summarize and report on results with **`blank_summarize_responses`** and **`blank_get_form_analytics`** (both return the same analytics payload the Analytics view uses).
- Export raw responses with **`blank_export_submissions`** (returns CSV text), and remove a single response with **`blank_delete_submission`** (destructive).

Some tools have no matching screen in the SPA: `blank_generate_form` (the builder has no AI-draft entry point), `blank_get_submission` (the Responses table has no per-submission detail view), `blank_add_field` / `blank_update_field` / `blank_delete_field` / `blank_reorder_fields` (an agent can edit fields directly, whereas a person does the same work in the builder canvas), `blank_close_form`, `blank_get_embed_code`, and `blank_delete_submission`. When reviewing agent work, check the form's fields and visibility in the builder before publishing, and confirm the public URL from the **Your form is live** dialog.

Blank also participates in the suite-wide agent platform. Agent activity is attributed to an agent identity and surfaced in the unified activity feed; long-running agents send heartbeats. Destructive or sensitive steps (publishing, closing, or deleting) can be routed through the approval-queue tools so a human decides before the action lands. Per-agent policies (kill switch plus a `blank.*` tool allowlist) gate which Blank tools a service account may call, and subscribed Blank events can be pushed to agent runners through signed outbound webhooks. Before an agent quotes a submission's contents into a shared surface it should call the visibility preflight (`can_access`) for that entity and drop anything the asker is not allowed to see.

For the full tool catalog and argument shapes, see the MCP-tools reference in `docs/apps/blank/mcp-tools.md`.

## Working together (live presence)

Like every BigBlueBam app, Blank carries the persistent Bureau presence dock, so collaboration is ambient rather than scheduled. From anywhere in Blank you can see who is around and ring, knock, or invite a teammate into a live voice or video huddle that follows you in a floating window as you both move through the suite. Voice and video here are the digital equivalent of bumping into someone in the hallway or stopping by their desk, not a booked meeting. The deeper per-record collaboration (a presence strip showing who is on a specific item, and real-time co-editing of the same record) lives on the document, board, diagram, and task surfaces, described in the Introduction; in Blank, the shared layer is the always-on Bureau dock.

## User Stories

### Story: Build and publish your first form

**Who:** A team member collecting feedback or intake.
**Goal:** Create a form, add a few fields, and get a shareable public URL.
**Before you start:** You are logged in to BigBlueBam and have the `blank.form.publish` permission.

**Steps**

1. Go to `/blank/`. On the **Forms** list, click **New Form**.
2. The builder opens with an "Untitled Form" draft. Click the form Title input in the center canvas and type a name. Add a Description below it.
3. In the **Add Field** palette on the left, click the field types you want, for example **Rating**, **NPS**, and **Long Text**. Each appears in the canvas.
4. Click a field in the canvas to open the **Field Settings** panel on the right. Set its **Label**, mark it **Required** if needed, and adjust type-specific options.
5. Reorder fields by dragging their grip handles. Remove a field with its trash icon.
6. Click **Settings** in the top-right action bar. Choose a **Visibility** option, set an **Expires at** date if you want one, and click **Save**.
7. Click **Publish**. In the **Your form is live** dialog, click **Copy** to copy the public URL.

**Result:** The form's status pill reads "published" on the Forms list, and you have a `https://YOUR-DOMAIN/forms/<slug>` URL to share.

**Related:** "Collect and review responses." An agent can do the same with `blank_create_form` then `blank_publish_form`.

### Story: Collect and review responses

**Who:** The form author after sharing the link.
**Goal:** Let people submit the form and review what came in.
**Before you start:** The form is published and set to a visibility that lets your respondents reach it.

**Steps**

1. Share the public URL (from the **Your form is live** dialog) with respondents. They open `/forms/<slug>`, fill out the fields, and submit. After submitting they see the confirmation you configured.
2. Back in Blank, go to the **Forms** list and open the form's overflow menu (three-dot icon).
3. Click **Responses**.
4. Review the table. Each row shows the row number, **Email**, the first five fields' answers, the **Files** status, and the **Date**.
5. To narrow the list by attachment processing state, click a pill under **Attachment status:** (all, pending, processing, complete, or failed).
6. Click **Export CSV** to download every submission as `submissions.csv`.

**Result:** You have reviewed the responses in the table and, if you exported, a CSV file of all submissions.

**Related:** "Analyze results." An agent can pull the same data with `blank_list_submissions` and `blank_export_submissions`.

### Story: Analyze results

**Who:** The form author wanting aggregate numbers.
**Goal:** See totals, the recent trend, and per-field breakdowns.
**Before you start:** The form has at least one submission.

**Steps**

1. Open the form's **Responses** view.
2. Click **Analytics**.
3. Read the summary cards: **Total Submissions**, **Active Fields**, and **Form Status**.
4. Review the **Submissions (Last 30 Days)** bar chart for the recent trend.
5. Scroll to **Per-Field Breakdown** to see option counts for choice fields and numeric statistics (average, minimum, maximum, count) for rating, scale, NPS, and number fields.

**Result:** You understand how many responses arrived, when, and how each field was answered.

**Related:** An agent can request the same payload with `blank_summarize_responses` or `blank_get_form_analytics` and write a summary.

### Story: Duplicate a form as a template

**Who:** Someone who reuses a form structure for a new round.
**Goal:** Start a new form from an existing one without rebuilding it.
**Before you start:** You have an existing form to copy.

**Steps**

1. On the **Forms** list, open the source form's overflow menu (three-dot icon).
2. Click **Duplicate**.
3. A new draft appears in the list with "(Copy)" in its name and the same fields.
4. Open the copy, adjust its title, fields, and settings, then click **Publish** when ready.

**Result:** A new draft form with the same fields, ready to edit and publish independently of the original.

**Related:** An agent can clone a form with `blank_duplicate_form`.

### Story: Restrict a form to your organization or a project

**Who:** An author who wants the form limited to internal people.
**Goal:** Stop people outside your org or project from viewing or submitting the form.
**Before you start:** You are editing the form in the builder.

**Steps**

1. Click **Settings** in the builder action bar.
2. Under Visibility, choose **Organization** to limit to your org, or **Project members** to limit to a Bam project.
3. If you chose **Project members**, select a project in the **Project** picker that appears.
4. Click **Save**.

**Result:** People who are not in the org (or not members of the chosen project) get a forbidden response when they open the public URL. Members can view and submit as normal.

**Related:** "Gate a public form by sign-in and email domain" covers the complementary `requires_login` and `allowed_domains` gates, which are enforced on the public submit and file-upload paths and stack with visibility.

### Story: Gate a public form by sign-in and email domain, and get notified

**Who:** An author who wants only known people to submit and wants to hear about each response.
**Goal:** Require sign-in and an allowed email domain to submit, and email the right people when a submission arrives.
**Before you start:** You are editing the form in the builder.

**Steps**

1. Click **Settings** in the builder action bar.
2. Check **Require sign-in to submit** to force authentication (optional but recommended for internal forms).
3. Under **Allowed email domains**, enter the domains you accept, comma separated, for example `acme.com, example.org`. Leave it blank to allow any domain.
4. Check **Email me on new submissions** and, under **Notification recipients**, enter the addresses to notify, comma separated.
5. (Optional) Pick a **Post to Banter channel** target to also post each submission to a channel.
6. Click **Save**, then **Publish**.

**Result:** An unauthenticated visitor is turned away with a sign-in error, a submitter on a disallowed domain is rejected, and every accepted submission triggers a confirmation email to the submitter plus a notification email to your recipients (and a Banter post if configured). Where SMTP is not configured, the worker logs the messages instead of delivering them.

**Related:** "Restrict a form to your organization or a project" covers the visibility gate that stacks with these. An agent can set the same fields with `blank_update_form` (`requires_login`, `allowed_domains`, `notify_on_submit`, `notify_emails`).

### Story: Collect file uploads on a form

**Who:** An author who needs respondents to attach a document or image.
**Goal:** Add a file-upload field and review the stored files that come in.
**Before you start:** You are editing the form in the builder.

**Steps**

1. In the **Add Field** palette, click **File Upload**. The field appears in the canvas; set its **Label** and mark it **Required** if needed.
2. Publish the form and share the public URL.
3. A respondent attaches a file; it is uploaded to object storage before they submit, and the submission references the stored object.
4. Open the form's **Responses** view. Watch the **Files** pill move from **pending** to **complete** as the background worker validates and stores each file (or to **failed** if a file is rejected).
5. Use the **Attachment status:** filter pills to find submissions whose files are still pending or that failed validation.

**Result:** Respondents can attach files, the files are stored for real, and the Responses table tells you which submissions have validated attachments.

**Related:** Uploads are limited to a size cap and an allowlist of image, document, spreadsheet, CSV, plain-text, and zip types (SVG is always blocked).

### Story: Build a multi-page survey

**Who:** An author with a longer survey to split across pages.
**Goal:** Group fields onto separate pages so respondents page through them.
**Before you start:** The form has several fields.

**Steps**

1. In the builder, click **Page Break** in the **Add Field** palette wherever you want a page boundary. It appears as a divider in the canvas.
2. Add or arrange the fields for each page around the page breaks. (Alternatively, select a field, open **Field Settings**, and set its **Page Number**.)
3. (Optional) Open the per-form Settings page at `/blank/forms/<id>/settings` and enable **Show Progress Bar** under Branding.
4. Click **Preview** to confirm the pages, then **Publish**.

**Result:** The public form shows fields grouped by page with Back and Next controls and, if enabled, a progress bar.

**Related:** Page breaks and per-field Page Number both page a form; use whichever fits how you build.

### Story: Close a form to stop accepting responses

**Who:** An author or agent wrapping up a collection.
**Goal:** Stop new submissions on a published form.
**Before you start:** You have the `blank.form.close` permission. There is no Close button in the SPA; closing is done through the API or an agent.

**Steps**

1. Call `POST /blank/api/v1/forms/<id>/close` with your session cookie or API key, or have an agent call `blank_close_form`.
2. Blank sets the form's status to closed, turns off **Accept Responses**, and emits a `form.closed` event (source `blank`).

**Result:** The form's public page no longer accepts submissions, and its status pill reads "closed" on the Forms list. There is no in-app control to reopen or un-publish a form.

**Related:** To pause without closing, an author can turn off **Accept Responses** on the per-form Settings page instead.

### Story: Have an agent draft, create, and publish a form

**Who:** A user delegating form creation to an AI agent.
**Goal:** Go from a plain-language description to a published, shareable form.
**Before you start:** The agent runs with your credentials and your publish permission. Its `blank.*` policy allowlist must permit the tools below.

**Steps**

1. Ask the agent to draft the form. It calls `blank_generate_form` with your description and returns a suggested specification of fields. Nothing is saved yet.
2. Review the suggested fields with the agent and adjust.
3. The agent calls `blank_create_form` with the field definitions inline to create the draft. It can refine the structure further with `blank_add_field`, `blank_update_field`, `blank_delete_field`, and `blank_reorder_fields`.
4. The agent calls `blank_publish_form` to publish it. If publishing is routed through the approval queue, you approve the proposal first.
5. Open the form in the builder to confirm the fields and visibility, then copy the public URL from the **Your form is live** dialog (open it with the **Share** button).
6. Later, ask the agent to report on results with `blank_summarize_responses`.

**Result:** A published form created from a description, with a public URL you can share and an agent that can summarize responses on demand.

**Related:** "Build and publish your first form" covers the same flow by hand.

## Related

- **Bond** - submissions can be routed to create a Bond contact when routing is configured for the form at the API level.
- **Helpdesk** - submissions can be routed to create a Helpdesk ticket when routing is configured for the form at the API level.
- **Bam** - forms can be scoped to a Bam project through Project members visibility, and the Form Settings dialog loads your Bam projects to choose from.
- **Bolt** - Blank emits `form.published`, `form.closed`, and `submission.created` events (source `blank`) that Bolt automations can react to.
- MCP tools reference: `docs/apps/blank/mcp-tools.md`.
- App guide: `docs/apps/blank/guide.md`.
