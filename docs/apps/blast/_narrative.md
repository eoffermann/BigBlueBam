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

## Working together

Like every app, Blast carries the persistent Bureau presence dock, so you can see who is around and start a voice or video huddle from anywhere in it; deeper per-record co-editing lives on the document, board, and task surfaces.
