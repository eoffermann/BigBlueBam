# Blast Design Audit (2026-04-14)

## Summary

Blast is substantially complete and functional at commit a8fb19a. The codebase implements 7 of 7 core database tables, 7 route groups with 27+ endpoints, 2 frontend services with 12 pages, 14 MCP tools, 2 event catalog entries, 1 worker job handler, and critical infrastructure for tracking, webhooks, and analytics. Completion is approximately 85%. The implementation closely tracks the April 8 design document with minor deviations, primarily in event catalog coverage (4 missing engagement events), AI content generation (stubbed), and segment filter evaluation (worker currently loads all org contacts).

## Design sources consulted

- `docs/early-design-documents/Blast_Design_Document.md` (April 8 spec, 554 lines)
- `docs/design-audits/2026-04-09/Blast-Design-Audit-2026-04-09.md` if it exists (prior audit pass)
- `CLAUDE.md`

## Built and working

### Database schema

All 7 tables fully implemented in `infra/postgres/migrations/0034_blast_tables.sql`:
- `blast_templates` (email templates with reusable content, builder JSON, versioning)
- `blast_segments` (recipient filters with cached recipient counts)
- `blast_campaigns` (campaign definitions with status lifecycle and delivery aggregates)
- `blast_send_log` (per-recipient delivery record with unique tracking tokens)
- `blast_engagement_events` (opens, clicks, unsubscribes with metadata)
- `blast_unsubscribes` (org-level opt-out list with org+email uniqueness)
- `blast_sender_domains` (verified sending domains with DNS records)

Drizzle schema files match SQL. Status enums (draft, scheduled, sending, sent, paused, cancelled), bounce types (hard, soft, complaint), engagement event types (open, click, unsubscribe).

### API routes and endpoints

7 route groups, 27+ endpoints implemented.

Route registration in `apps/blast-api/src/server.ts`:
- `/v1/templates` (6 endpoints)
- `/v1/segments` (6 endpoints)
- `/v1/campaigns` (10 endpoints: CRUD, send, schedule, pause, cancel, analytics, recipients)
- `/t/o/:token` (GET open tracking pixel, 1x1 GIF)
- `/t/c/:token?url=...` (GET click tracking with redirect)
- `/unsub/:token` (GET form + POST unsubscribe)
- `/v1/webhooks/bounce` and `/v1/webhooks/complaint` (POST from SMTP providers)
- `/v1/sender-domains` (4 endpoints: list, add, verify, delete)
- `/v1/analytics/overview`, `/engagement-trend`, `/unsubscribe-check`

Auth patterns: authenticated endpoints require Bearer token via `requireAuth`, sensitive operations (send, delete) require `requireMinRole('admin')` or `requireMinRole('member')`, tracking/webhook routes have no auth. Rate limiting applied (20/min for writes, 60/min for webhooks).

### Services and business logic

7 service modules in `apps/blast-api/src/services/`:
- `template.service.ts` - CRUD templates, duplicate, preview with merge field rendering.
- `segment.service.ts` - CRUD segments, recalculate recipient counts, preview matching contacts.
- `campaign.service.ts` - CRUD campaigns, send, schedule, pause, cancel, fetch analytics and recipient lists.
- `tracking.service.ts` - process opens/clicks/unsubscribes, generate tracking tokens, validate redirects.
- `analytics.service.ts` - compute overview metrics, engagement trends, unsubscribe status checks.
- `webhook.service.ts` - process bounce and complaint notifications.
- `sender-domain.service.ts` - add/verify/list sender domains with DNS record generation.

`bolt-events.ts` publishes enriched events to Bolt automation engine with payload builders. Fire-and-forget pattern prevents Bolt unavailability from blocking Blast operations.

### Worker job processor

`apps/worker/src/jobs/blast-send.job.ts` fully implemented. Pipeline:
1. Load campaign and verify status is `sending`.
2. Load organization unsubscribe list into in-memory Set for O(1) filtering.
3. Load all eligible contacts.
4. For each contact: render template with merge fields, rewrite links for click tracking, inject open pixel.
5. Create send_log entry per recipient with unique tracking token.
6. Send via SMTP (configurable Postmark/SES/self-hosted via `getSmtpConfig`).
7. Update send_log with status, message ID, sent timestamp.
8. Update campaign with final status=sent, total_sent, total_delivered, completed_at.

Merge field support: `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{company}}`, `{{unsubscribe_url}}`. Link rewriting: all `href` rewritten to `/t/c/:token?url=...`. Open pixel: injected before `</body>`.

### Frontend routes and pages

12 pages at `apps/blast/src/pages/`: campaign-list, campaign-new, campaign-detail, template-gallery, template-editor, segment-list, segment-builder, analytics-dashboard, domain-settings, smtp-settings. Custom SPA router using manual history API (no React Router).

### MCP tools and agent integration

14 tools implemented in `apps/mcp-server/src/tools/blast-tools.ts`:

Templates (3): `blast_list_templates`, `blast_get_template`, `blast_create_template`.
Campaigns (4): `blast_draft_campaign`, `blast_get_campaign`, `blast_send_campaign`, `blast_get_campaign_analytics`.
Segments (3): `blast_list_segments`, `blast_create_segment`, `blast_preview_segment`.
AI content (2, stubbed): `blast_draft_email_content`, `blast_suggest_subject_lines`.
Analytics/compliance (2): `blast_get_engagement_summary`, `blast_check_unsubscribed`.

All tools include name-or-ID resolvers.

### Tracking and deliverability

Full implementation:
- Open tracking (`/t/o/:token`): 1x1 transparent GIF, no auth, logs `engagement_events` row with type=open.
- Click tracking (`/t/c/:token?url=...`): validates URL, logs `engagement_events` row with type=click and clicked_url, returns 302.
- Unsubscribe (`/unsub/:token`): GET renders HTML form, POST processes unsubscribe, logs event, adds to `blast_unsubscribes`.
- Webhooks: POST `/v1/webhooks/bounce` and `/complaint` process provider notifications.
- RFC 8058 headers: `List-Unsubscribe: <https://DOMAIN/unsub/:token>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- Unsubscribe list enforced in worker: eligibleContacts filtered against `blast_unsubscribes` set.

## Partial or divergent

### Event catalog coverage

Only 2 of 6 designed events implemented in `apps/bolt-api/src/services/event-catalog.ts`:

Implemented (2 events):
- `campaign.created` - fired in campaigns.routes.ts POST handler with enriched payload.
- `campaign.sent` - fired in campaigns.routes.ts POST /send handler.

Missing (4 events from spec section 7):
- `campaign.completed` - no event fired when all sends complete.
- `engagement.opened` - open tracking pixel records event but does not publish to Bolt.
- `engagement.clicked` - click tracking logs but does not publish to Bolt.
- `engagement.unsubscribed` - unsubscribe processed but no Bolt event.
- `engagement.bounced` - bounce webhook processed but no Bolt event.

### AI content generation

`blast_draft_email_content` and `blast_suggest_subject_lines` MCP tools are stubbed with hardcoded templates, not integrated with Claude API or any LLM. Spec section 1.2 calls for "AI drafts, humans approve" but LLM integration deferred.

### Segment filter evaluation

`filter_criteria` stored in JSONB but segment targeting in worker job currently loads all org contacts. `segment_id` filtering is a future enhancement per worker code comment at line 213.

### Campaign analytics device/client breakdown

`/campaigns/:id/analytics` endpoint exists but no device/client breakdown heatmap (spec 9.2 lists this as required).

## Missing

### P0 Blocks downstream

- **Wire engagement events to Bolt.** The 4 missing events (opened, clicked, unsubscribed, bounced) block cross-product integrations that want to act on engagement data (lead scoring in Bond, workflow automation in Bolt, analytics in Bench).
- **Campaign completion event.** `campaign.completed` should fire when the worker job finishes the last send.

### P1 High value

- **Segment filter evaluation in worker.** Currently loads all org contacts; should evaluate JSONB `filter_criteria` to target only matching contacts.
- **AI content generation LLM integration.** Replace hardcoded stubs in `blast_draft_email_content` and `blast_suggest_subject_lines` with real Claude API calls.
- **Device/client breakdown analytics.** Heatmap visualization in campaign-detail.tsx and analytics service.
- **Email builder block palette verification.** `block-types.ts` exists but exact palette (header, text, image, button, divider, columns, spacer, social, footer per spec 6.2) not verified.

### P2 Nice-to-have

- **Rate limiting on tracking endpoints.** Unusual for high-volume pixels but design allows.
- **Segment size optimization.** Current O(n) contact filtering with O(m) unsubscribe check is fine for typical org sizes but scales linearly.
- **Multi-currency or multi-language content.** Not in scope of spec but common ask.

## Architectural guidance

### Wiring engagement events

In `tracking.service.ts processOpen()`, after logging to `engagement_events`, call:
```typescript
publishBoltEvent('engagement.opened', 'blast', { campaign_id, contact_id, token, ... }, orgId);
```

Same pattern for `processClick()`, `processUnsubscribe()`. In `webhook.service.ts` bounce/complaint handlers, emit `engagement.bounced`.

In `blast-send.job.ts`, after updating campaign to `status=sent`, emit `campaign.completed` with total_sent, total_delivered, total_bounced, total_opened, total_clicked aggregates.

Register each event in `apps/bolt-api/src/services/event-catalog.ts` as a new `EventDefinition` entry with the appropriate field list.

### Segment filter evaluation

Move segment query from blast-send.job.ts to `segment.service.ts getMatchingContacts(segmentId, orgId)`. The function reads `filter_criteria` from the segment row and builds a SQL WHERE clause (or uses a query builder) against the `contacts` or `bond_contacts` table. Worker calls this function to get the eligible contact list.

### LLM integration for AI content

Replace stubs in `blast-tools.ts` with real Claude API calls. Add `@anthropic-ai/sdk` as a dependency. Use prompt caching for the system prompt. Return drafted content with structured output.

## Dependencies

### Inbound (other apps depend on Blast)

- Bolt subscribes to `campaign.created`, `campaign.sent`, and future engagement events.
- Bench data source registry includes Blast campaigns (engagement metrics for analytics dashboards).
- Bond may use Blast to send outreach campaigns tied to deal stages.

### Outbound (Blast depends on other apps)

- **Bolt API** (internal :4006) for event publishing.
- **Organization contacts** from Bond or a shared contacts table (exact integration not verified in this audit).
- **SMTP provider** (Postmark, SES, or self-hosted) for delivery.
- **Claude API** (future, for AI content generation).

## Open questions

1. **Contacts table location:** Worker loads "all eligible contacts" - are these from a shared `contacts` table, `bond_contacts`, or a blast-specific contacts table? Need to verify.
2. **SMTP provider choice:** `getSmtpConfig()` supports Postmark/SES/self-hosted - what is the production configuration?
3. **Segment filter JSONB shape:** `filter_criteria` has a defined shape in the TypeScript types but no documented validation schema for the JSONB payload.
4. **Engagement event priority:** Should opened/clicked events fire on every open/click or be deduplicated per contact per campaign? Current implementation fires on every event.
5. **Webhook authentication:** Bounce/complaint webhooks have optional `X-Webhook-Secret` validation. What is the production secret rotation policy?
