# Blast help.md Review

## Verdict: APPROVED

`docs/apps/blast/help.md` is accurate, complete, and code-backed. Every UI label,
feature claim, count, and screenshot reference traced to code or disk. The three
adversarial checks all pass: the doc does NOT present "archived", A/B testing, or
bring-your-own SMTP as working, and it documents the worker's segment-blind sending
and the Send-Now-only detail page truthfully.

---

## Template completeness

All sections present and filled: Overview (with Key concepts, Where to find it,
Prerequisites), Feature reference (every view), Working with AI agents, User Stories
(9 stories), Related. Matches the help-doc-authoring skeleton.

## Feature coverage (every frontend view has how-to steps)

Verified one-to-one against `apps/blast/src/pages/` and shared components:

- campaign-list.tsx -> "Campaigns list"
- campaign-new.tsx -> "Create a campaign"
- campaign-detail.tsx -> "Campaign detail and Send Now"
- visual-builder.tsx -> "Visual builder"
- template-gallery.tsx -> "Template gallery"
- template-editor.tsx -> "Template editor"
- segment-list.tsx -> "Segment list"
- segment-builder.tsx -> "Segment builder and preview"
- analytics-dashboard.tsx -> "Analytics"
- domain-settings.tsx -> "Sender Domains"
- smtp-settings.tsx -> "SMTP (platform relay)"
- tracking/unsubscribe (no UI) -> "Tracking and unsubscribe"
- webhooks (no UI) -> "Provider webhooks"

No frontend view or user-facing action is omitted.

## Story coverage

- Setup: "Set up outbound email before your first send" (SMTP).
- Core loop: "Send a one-off campaign from scratch", "Reuse a saved template", "Author and version a reusable template", "Build a targeted segment".
- Collaboration / cross-app: "Nurture a Bond contact group, then react in Bolt" (Bond -> Blast -> Bolt).
- Search / reporting: "Review campaign performance" (campaign + org analytics).
- Agent flow: agent actions are woven into Related blocks and the dedicated "Working with AI agents" section; the cross-app story explicitly gates the send behind `require_human_approval`.

All stories are followable from their steps alone.

## Accuracy findings (labels / claims traced to code)

Spot-checked and CONFIRMED in code (no failures):

- Status enum `draft, scheduled, sending, sent, paused, cancelled`; "no archived state" - `campaign-list.tsx:29`; `archived` absent from all of `apps/blast-api/src`.
- Status filter buttons order (All, draft, scheduled, sending, sent, paused, cancelled) - `campaign-list.tsx:29,68`.
- Send Now rendered only for draft/scheduled - `campaign-detail.tsx:109`.
- No schedule/pause/cancel/edit/delete in detail UI, but routes exist server-side - `campaigns.routes.ts:159-190` (schedule/pause/cancel) confirm API-only.
- CAN-SPAM gate (unsubscribe token: `unsub`/`opt-out`/`opt out`/`{{unsubscribe_url}}`/`%unsubscribe_url%`; address: street regex/`{{physical_address}}`/`%physical_address%`/`p.o. box`/`po box`) - `campaign.service.ts:200-232`.
- Content toggle "Visual Builder / HTML / From Template", "Choose a template...", "create a new template", "All contacts", "Create Campaign"/"Creating...", Campaign Name */Subject Line * - `campaign-new.tsx`.
- Segment builder 6 fields + 7 operators, exact labels including "older than (days)" and "is one of" splitting on commas - `segment-builder.tsx:15-32,67`.
- Segment list columns and "N condition(s), match all|any", "Recalculate count", "Delete this segment?" - `segment-list.tsx`.
- Analytics title "Email Analytics" and all stat cards/tiles/trend columns; counts only `status='sent'` - `analytics-dashboard.tsx` + `analytics.service.ts:29,97`.
- SMTP page: "SMTP Settings", "Platform SMTP", role-aware "Open Account Settings" (SuperUser) / "View in Account Settings" (org admin) / neutral box; stores no credentials - `smtp-settings.tsx`.
- Sender Domains: title/subtitle, "Add Domain", "Verify DNS", "Remove this domain?", SPF/DKIM/DMARC, "Required DNS Records" - `domain-settings.tsx`.
- Merge fields `{{first_name}} {{last_name}} {{email}} {{company}} {{unsubscribe_url}}` - worker `renderTemplate` `blast-send.job.ts:132-143`.
- Worker segment-blind send: loads ALL org contacts regardless of `segment_id`, excludes empty-email and unsubscribed - `blast-send.job.ts:219-236`. Doc states this in two places (Create-campaign segment caveat line 78; Send story recipient-scope caveat line 315). TRUTHFUL.
- 14 MCP tools, names match; `blast_send_campaign` defaults `require_human_approval: true` -> schedules +1h instead of sending - `blast-tools.ts:271-298`.
- `blast_draft_email_content` and `blast_suggest_subject_lines` return hard-coded strings, not LLM output; doc flags them as stubs ("not wired to a model") - `blast-tools.ts:372-412`.
- 7 Bolt events from source `blast` - all present in `event-catalog.ts:1165,1193,1842,1854,1867,1879,1892`.
- "Please log in to BigBlueBam first" screen linking to `/b3/` - `app.tsx:128-129`; `?` opens help `app.tsx:101-103`.

## Conventions

- Em dashes: none in help.md (grep clean).
- Tool count: "14 MCP tools" matches the registered tools in `blast-tools.ts`.
- Screenshots: all 7 referenced files exist under `docs/apps/blast/screenshots/light/`
  (01-campaigns, 02-campaign-new, 03-templates, 04-template-editor, 05-segments,
  06-segment-builder, 07-analytics). The doc correctly notes "no screenshot exists"
  for campaign detail/Send Now, Sender Domains, SMTP, and the unsubscribe page,
  matching the actual screenshot gaps.

## Adversarial checks (required)

- "archived" state NOT presented as working: PASS (key-concepts line 18 says "There is no archived state"; Related line 446 flags the guide's stale "archived" claim).
- A/B testing NOT presented as working: PASS (not claimed anywhere; line 446 flags guide.md's A/B claim as unimplemented).
- Bring-your-own SMTP NOT presented as working: PASS (SMTP section and setup story state Blast keeps no SMTP credentials; relay is platform-wide, SuperUser-configured in Bam).
- Worker segment-blind sending documented truthfully: PASS (lines 78 and 315).
- Send-Now-only detail page documented truthfully: PASS (lines 95-102; schedule/pause/cancel/edit/delete called out as API/MCP-only).

## Minor observations (non-blocking, no fix required)

1. Doc line 216 says the per-domain card shows the Required DNS Records list; the
   component only renders it when `dns_records.length > 0` (`domain-settings.tsx:123`).
   Generated records are always populated on create, so this is effectively always
   true. Not worth a change.
2. The "campaign.completed" payload uses a flat `campaign.*` shape rather than the
   catalog's `org: object` enrichment shape (`blast-send.job.ts:409-432`). The doc
   does not assert a payload shape, so nothing to correct; noted for completeness.
