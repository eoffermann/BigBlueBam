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
