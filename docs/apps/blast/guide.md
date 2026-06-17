---
title: "Blast (Email Campaigns) Guide"
app: blast
generated: "2026-06-17T20:37:35.161Z"
---

# Blast (Email Campaigns) Guide


# Blast - Email Campaigns

Blast is BigBlueBam's email campaign manager for creating, sending, and analyzing bulk email to your Bond CRM contacts. You design an email once (in a drag-and-drop visual builder, raw HTML, or from a saved template), pick who should receive it, send through the platform's shared SMTP relay, and watch opens, clicks, bounces, and unsubscribes roll up per campaign and across the org.

## Key Features

- **Campaign Manager** with six states: draft, scheduled, sending, paused, sent, and cancelled. The in-app detail page sends a draft with **Send Now**; scheduling, pausing, cancelling, editing, and deleting are available through the API and the Blast MCP tools.
- **Visual Builder** for designing email-safe HTML with drag-and-drop blocks (Heading, Text, Image, Button, Divider, Columns, Social, Spacer), plus a raw HTML mode with live preview and a From Template mode.
- **Templates** that are reusable email designs with subject templates, merge fields, and an automatically incrementing version number on every save.
- **Segment Builder** that saves filters over Bond contact fields (lifecycle stage, lead source, lead score, city, country, last contacted), joined with ALL conditions (AND) or ANY condition (OR), with a cached match count you can recalculate.
- **Analytics** with org-wide rollups (total sent, delivered, average open rate, average click rate, bounce rate, unsubscribes) and a weekly engagement trend, plus per-campaign metrics and a per-recipient delivery table.
- **CAN-SPAM compliance gate** that blocks a send or schedule unless the email body carries both an unsubscribe mechanism and a physical mailing address.
- **Sender Domains** for verifying SPF, DKIM, and DMARC so mailbox providers trust your mail.
- **Automatic tracking and suppression**: open pixels, click redirects, an unsubscribe confirmation page, and provider bounce/complaint webhooks all run without any operator action and feed the counters.

## Integrations

Blast pulls its audience from Bond CRM: segments filter on Bond contact fields, and campaign engagement flows back to Bond contact activity timelines. Every send and engagement event is published to Bolt from source `blast` (`campaign.created`, `campaign.sent`, `campaign.completed`, `engagement.opened`, `engagement.clicked`, `engagement.unsubscribed`, `engagement.bounced`), so automation rules can react. Blast shares its login and its single platform-wide SMTP relay with the rest of the suite; the relay is configured once by a SuperUser in the Bam app under Account Settings -> Integrations. Open-pixel tracking and click redirects are served via dedicated short-path endpoints (/t/ and /unsub/). Agents drive Blast through 28 MCP tools and the cross-cutting agentic platform (identity and heartbeat, approval-queue proposals, unified activity and search, visibility preflight, agent policies, and outbound webhooks).

## Getting Started

Open Blast from the Launchpad at /blast/ (sign in to BigBlueBam first; Blast has no separate login). Make sure a SuperUser has configured the platform SMTP relay, and optionally verify a sending domain under Blast Settings -> Domains. Build a template in the visual editor, save a segment over your Bond contacts, then create a campaign, choose its content, and review the body for an unsubscribe link and a physical mailing address. Open the new draft and click Send Now; the CAN-SPAM check runs before anything leaves the system.

## Walkthrough

### Campaigns

![Campaigns](screenshots/light/01-campaigns.png)

### Campaign New

![Campaign New](screenshots/light/02-campaign-new.png)

### Templates

![Templates](screenshots/light/03-templates.png)

### Template Editor

![Template Editor](screenshots/light/04-template-editor.png)

### Segments

![Segments](screenshots/light/05-segments.png)

### Segment Builder

![Segment Builder](screenshots/light/06-segment-builder.png)

### Analytics

![Analytics](screenshots/light/07-analytics.png)


## MCP Tools


# blast MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `blast_cancel_campaign` | Cancel a scheduled or in-progress campaign so it will not (continue to) send.  | `id` |
| `blast_check_unsubscribed` | Check if an email address is on the organization unsubscribe list. | `email` |
| `blast_create_segment` | Define a segment from Bond contact filter criteria. | `filter_criteria`, `conditions`, `field`, `op`, `value`, `match` |
| `blast_create_template` | Create a new email template from HTML and subject line. | `subject_template`, `html_body`, `template_type` |
| `blast_draft_campaign` | Create a campaign in draft status with template, segment, and schedule.  | `subject`, `html_body`, `template_id`, `segment_id`, `from_name`, `from_email` |
| `blast_draft_email_content` | AI-generate email subject and body from a brief description and tone. | `tone`, `audience` |
| `blast_duplicate_template` | Duplicate an email template into a new copy.  | `id` |
| `blast_evaluate_segment` | Run the full recipient evaluation for a segment (the resolved send list a campaign would target). Read-only — does not send anything.  | `id` |
| `blast_get_campaign` | Get campaign detail and delivery stats.  | `id` |
| `blast_get_campaign_analytics` | Get engagement metrics for a sent campaign: open rate, click rate, click map, delivery breakdown.  | `id` |
| `blast_get_campaign_device_analytics` | Get the device/client breakdown of opens and clicks for a campaign.  | `id` |
| `blast_get_engagement_summary` | Get org-level engagement trends: total sent, avg open rate, avg click rate, unsubscribe rate. | none |
| `blast_get_engagement_trend` | Get org-level engagement metrics over time, bucketed daily, weekly, or monthly. | `period` |
| `blast_get_segment` | Get a single segment with its filter criteria and cached recipient count.  | `id` |
| `blast_get_template` | Get email template content and builder state by ID. | `id` |
| `blast_list_campaign_recipients` | List the recipients of a campaign with per-recipient delivery status.  | `id`, `limit`, `offset` |
| `blast_list_campaigns` | List email campaigns with optional status filter and pagination. | `status`, `limit`, `offset` |
| `blast_list_segments` | List contact segments with cached recipient counts. | `search`, `limit` |
| `blast_list_templates` | List available email templates with optional type filter and search. | `template_type`, `search`, `limit` |
| `blast_pause_campaign` | Pause an in-progress campaign send.  | `id` |
| `blast_preview_segment` | Preview the first 50 matching contacts for a segment. | `id` |
| `blast_preview_template` | Render a template with sample merge data to preview the resulting subject and HTML. Read-only — does not send anything.  | `id`, `merge_data` |
| `blast_recalculate_segment_count` | Recalculate and cache the recipient count for a segment by re-running its filter against current Bond contacts.  | `id` |
| `blast_send_campaign` | Send a campaign immediately. Requires human approval by default.  | `id`, `require_human_approval` |
| `blast_suggest_subject_lines` | Generate 5 subject line variants for A/B comparison. | `topic`, `tone` |
| `blast_update_campaign` | Update a draft campaign. Provide only the fields to change.  | `id`, `subject`, `html_body`, `plain_text_body`, `template_id`, `segment_id`, `from_name`, `from_email`, `reply_to_email` |
| `blast_update_segment` | Update a segment\ | `id`, `filter_criteria`, `conditions`, `field`, `op`, `value`, `match` |
| `blast_update_template` | Update an email template. Provide only the fields to change.  | `id`, `subject_template`, `html_body`, `plain_text_body`, `template_type`, `thumbnail_url` |

## Related Apps

- [Bench (Analytics)](../bench/guide.md)
- [Bolt (Workflow Automation)](../bolt/guide.md)
- [Bond (CRM)](../bond/guide.md)
