# Blank help.md - Review

## Verdict: APPROVED

The doc is accurate, complete, and code-backed. Every required negative claim is
correctly handled (no signature field, no builder conditional logic, no
completion-rate/drop-off analytics, Page Break correctly flagged as broken), and
the API-only actions (close, delete submission, embed) are documented accurately.
The issues below are optional polish, not blockers.

---

## Acceptance checklist

- [x] Template complete: Overview (with Key concepts, Where to find it), Feature
      reference (with Working with AI agents), User Stories, Related - all present
      and filled.
- [x] Feature coverage: Forms list, Form Builder, Field Settings, Form Settings
      dialog, Publish dialog, Preview, Responses, Analytics, per-form Settings
      page, app-level Blank Settings, Public form - every frontend view has
      how-to steps. Spot-grep of the builder palette, list overflow menu,
      responses filters, and settings controls all trace to documented steps.
- [x] Story coverage: setup ("Build and publish your first form"); core loop
      ("Collect and review responses"); collaboration/restriction ("Restrict a
      form to your organization or a project"); search/reporting ("Analyze
      results"); agent flow ("Have an agent draft, create, and publish a form").
      Plus duplicate-as-template, multi-page, and close-via-API. Steps are
      followable and name exact UI elements.
- [x] Accuracy: spot-checked UI labels and feature claims; all trace to code
      (details below).
- [x] Conventions: no em dashes (grep for both em and en dash returned nothing);
      11 MCP tools and all are code-backed; all 4 referenced screenshots exist.

---

## Accuracy findings (verified against code)

UI labels confirmed exact:
- Forms list: heading "Forms", subtitle "Build forms and surveys to capture
  responses from anyone.", "New Form", empty state "No forms yet" /
  "Create your first form to start collecting responses.", overflow items
  Preview/Responses/Duplicate/Delete (form-list.tsx:40-98).
- Builder palette: all 20 documented types plus "Page Break" present in
  FIELD_TYPE_PALETTE (form-builder.tsx:30-52); empty state "Click a field type
  on the left to add it".
- Field Settings panel: Label, Key, Description, Placeholder, Required, Options
  ("+ Add option"), Min/Max Length, Min/Max Value, Scale Min, Scale Max, Regex
  Pattern, Page Number - all match (form-builder.tsx:593-797).
- Form Settings dialog: title "Form Settings"; Public / Organization /
  "Project members" with the exact description strings quoted in the doc;
  "Project" picker; "Expires at"; "Clear"; "Cancel"; "Save" (Save disabled when
  project visibility chosen with no project) (form-builder.tsx:832-1022).
- Publish dialog: public URL is `${origin}/forms/<slug>` (form-builder.tsx:1040);
  "Copy"/"Copied", title "Your form is live" - consistent with the dossier.
- Responses: title "{name} - Responses", Analytics, "Export CSV", "Attachment
  status:" pills (all/pending/processing/complete/failed), columns #, Email,
  first 5 fields, Files, Date, "No responses yet.", export filename
  submissions.csv (form-responses.tsx:11-148, submissions.routes.ts:61).
- Analytics: "Total Submissions", "Active Fields", "Form Status",
  "Submissions (Last 30 Days)", "Per-Field Breakdown" (form-analytics.tsx:51-91).
- Per-form Settings page: Access (Form Type / Accept Responses / One per Email),
  Confirmation (Show Message / Redirect / Custom Page), Branding (Theme Color /
  Show Progress Bar), Notifications (Email on Submit) (form-settings.tsx).
- App-level Blank Settings: heading "Settings", default form type public, default
  theme color #3b82f6, rate limit 10 per hour, events listed
  (settings.tsx:9-72).

Required negative claims - all correctly handled:
- No signature field type: not in REST FIELD_TYPES enum (forms.routes.ts:12-20)
  or builder palette; not presented in help.md. Doc does NOT claim it. Correct.
- Builder conditional logic: not presented as a no-code builder feature.
  Routing/conditional data exists only at the API level, and the doc describes
  Bond/Helpdesk routing as "configured at the API level" (help.md:11,395-396).
  Correct.
- Completion-rate / drop-off analytics: analytics endpoint computes only total,
  daily trend, and per-field stats (submission.service.ts), and the doc's
  Analytics section lists exactly those. No completion/drop-off claim. Correct.
- Page Break: doc flags it twice (help.md:103 and the Multi-page story note
  help.md:357) as failing because the API rejects the page_break type, and
  steers users to Page Number instead. Matches code: page_break is in the
  palette (form-builder.tsx:51) but absent from the REST enum, so the POST is
  Zod-rejected. Correct.

API-only actions - documented accurately:
- Close form: doc gives `POST /blank/api/v1/forms/<id>/close`, notes no SPA
  button, states it sets status=closed and turns off Accept Responses and emits
  form.closed (help.md:359-372). Matches forms.routes.ts:207 (requireCan
  blank.form.close) and form.service.ts:426-435.
- Delete submission: doc lists it as API-only requiring blank.submission.delete
  (help.md:37); no SPA control claimed. Matches submissions.routes.ts:41.
- Embed: doc does not present an in-app embed UI; it does not claim a Share/embed
  button beyond the published-URL flow. The embed-code route is API-only
  (forms.routes.ts:259, no SPA caller), and the doc does not contradict this.
  Correct.

11 MCP tools - all present in apps/mcp-server/src/tools/blank-tools.ts and named
correctly in help.md:240-247: blank_list_forms, blank_get_form, blank_create_form,
blank_generate_form, blank_update_form, blank_publish_form, blank_list_submissions,
blank_get_submission, blank_summarize_responses, blank_export_submissions,
blank_get_form_analytics. Count "11" stated at help.md:248 matches.

No accuracy defects found. No label or feature claim failed to trace to code.

---

## Optional polish (non-blocking, author's discretion)

1. Feature reference > Field Settings (help.md:120). The doc says the Options
   editor is "for Single Select, Multi Select, and Dropdown." The code condition
   also includes `checkbox_group` (form-builder.tsx:648), but `checkbox_group`
   is not an addable palette type, so the three listed types are the only ones a
   user can reach. No change required; the current text is correct for what a
   user can actually do.

2. Feature reference > Field Settings (help.md:124). "Regex Pattern - an optional
   validation pattern applied to string answers." The panel hides the Regex
   Pattern control for section_header, paragraph, hidden, page_break, and
   file_upload (form-builder.tsx:771). The doc's phrasing ("string answers")
   already implies this, so no change is needed; flagging only for completeness.
