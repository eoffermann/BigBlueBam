# Blast Implementation Plan (2026-04-14)

## Scope

Blast is 85% complete at `a5147ce` with 7 core database tables, 27+ endpoints, 14 MCP tools, and full email delivery infrastructure via `blast-send.job.ts`. This plan closes 6 high-impact gaps that unblock downstream integrations and enhance product value.

**In scope (P0):** wire 4 missing engagement events to Bolt (opened, clicked, unsubscribed, bounced); wire `campaign.completed` event on send job finish. **In scope (P1):** segment filter evaluation in worker; Claude API integration for AI content generation; device/client breakdown analytics; email builder footer block validation.

**Out of scope:** tracking endpoint rate limiting, multi-language content, subscription send scheduling beyond current model, A/B testing, advanced deliverability monitoring beyond bounce/complaint webhooks.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing engagement events | Wire `engagement.opened`, `engagement.clicked`, `engagement.unsubscribed`, `engagement.bounced` to Bolt |
| G2 | P0 | audit §Missing campaign.completed | Publish `campaign.completed` event when worker finishes last send |
| G3 | P0 | audit §Event catalog coverage | Register 5 new event definitions in `apps/bolt-api/src/services/event-catalog.ts` |
| G4 | P1 | audit §Segment filter evaluation | Implement `segment.getMatchingContacts()` evaluating JSONB filter_criteria |
| G5 | P1 | audit §AI content generation | Replace stubbed `blast_draft_email_content` and `blast_suggest_subject_lines` with Claude API calls |
| G6 | P1 | audit §Device/client breakdown | Add device breakdown computation and analytics endpoint field |
| G7 | P1 | audit §Email builder block palette | Add footer block type for CAN-SPAM compliance; validate footer presence at send time |

## Migrations

**Reserved slots: 0091, 0092.**

### 0091_blast_engagement_event_indexes.sql

**Body:**
```sql
-- 0091_blast_engagement_event_indexes.sql
-- Why: Support fast engagement summary queries and device breakdown analytics. Denormalize client info for low-latency aggregation.
-- Client impact: additive only. New indexes and nullable column.

ALTER TABLE blast_engagement_events
  ADD COLUMN IF NOT EXISTS client_info VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_blast_engagement_campaign_contact_type
  ON blast_engagement_events (campaign_id, contact_id, event_type);

CREATE INDEX IF NOT EXISTS idx_blast_engagement_client_info
  ON blast_engagement_events (campaign_id, client_info)
  WHERE client_info IS NOT NULL;
```

**Verification:** scratch-DB apply + `\d blast_engagement_events`.

### 0092_blast_campaign_completion_tracking.sql

**Body:**
```sql
-- 0092_blast_campaign_completion_tracking.sql
-- Why: Track campaign.completed event emission for idempotency on worker retries. Prevent duplicate emission.
-- Client impact: additive only. New nullable column.

ALTER TABLE blast_campaigns
  ADD COLUMN IF NOT EXISTS completion_event_emitted BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_blast_campaigns_completion_pending
  ON blast_campaigns (status, completion_event_emitted)
  WHERE status = 'sent' AND completion_event_emitted = false;
```

## Schemas and shared types

No new shared schemas.

## API routes and services

### Service updates

**`apps/blast-api/src/services/tracking.service.ts`** (G1):

In `processOpen(token)`, after inserting into `blast_engagement_events`:
1. Load campaign via send_log.
2. Build enriched payload via `buildCampaignEventPayload(...)`.
3. Add `engagement.event_type: 'opened'`, `engagement.occurred_at: ISO8601`.
4. Parse `user_agent` to derive `client_info` and store it in the event row.
5. Call `publishBoltEvent('engagement.opened', 'blast', payload, orgId)`.

Same pattern in `processClick(token, url)` adding `clicked_url`, and `processUnsubscribe(token)` adding `unsubscribe_source`.

**`apps/blast-api/src/services/webhook.service.ts`** (G1):

In `processBounce()` and `processComplaint()`, after updating send_log and engagement event, publish `engagement.bounced` with `bounce_type` (hard/soft/complaint) in the payload.

**`apps/worker/src/jobs/blast-send.job.ts`** (G2):

After the final update to `blast_campaigns` setting status='sent' and completed_at:
1. Build enriched payload with totals (total_sent, total_delivered, total_bounced, total_opened, total_clicked).
2. Call `publishBoltEvent('campaign.completed', 'blast', payload, org_id, undefined, 'system')`.
3. Set `blast_campaigns.completion_event_emitted = true` for idempotency.

Requires importing `buildCampaignEventPayload` and `publishBoltEvent` into the worker (extract from blast-api to a shared module or export).

**`apps/blast-api/src/services/segment.service.ts`** (G4):

Add new function `getMatchingContacts(segmentId, orgId, limit?)`:
1. Load segment and its `filter_criteria` JSONB.
2. If filter_criteria is null or empty, return all org contacts (current behavior).
3. Otherwise, build Drizzle WHERE clause from filter_criteria:
   - `{ field, op: 'eq' | 'in' | 'older_than_days' | 'before' | 'after', value }` operators.
   - `match: 'all' | 'any'` for AND/OR combination.
4. Execute query and return contacts.

Update `blast-send.job.ts` line 215-223 to call this function if campaign has `segment_id`, otherwise fall back to all-org (current behavior).

**`apps/blast-api/src/services/analytics.service.ts`** (G6):

Add `getDeviceBreakdown(campaignId, orgId)`:
1. Query `blast_engagement_events` for the campaign, SELECT client_info.
2. GROUP BY client_info, COUNT(*).
3. Compute percentages.
4. Return array of `{ client, count, percentage }` sorted descending.

Update `/campaigns/:id/analytics` endpoint to include `device_breakdown` field in response.

### Event catalog (G3)

**`apps/bolt-api/src/services/event-catalog.ts`** (update):

Register 5 new event definitions:
- `engagement.opened` (source: blast): fields `campaign.id`, `campaign.name`, `contact.id`, `contact.email`, `engagement.event_type`, `engagement.occurred_at`, `engagement.client_info`
- `engagement.clicked` (source: blast): same + `engagement.clicked_url`
- `engagement.unsubscribed` (source: blast): same as opened
- `engagement.bounced` (source: blast): same + `engagement.bounce_type`
- `campaign.completed` (source: blast): fields `campaign.id`, `campaign.name`, `campaign.status`, `campaign.total_sent`, `campaign.total_delivered`, `campaign.total_bounced`, `campaign.completed_at`

## Frontend pages and components

**`apps/blast/src/pages/campaign-detail.tsx`** (G6) — add device breakdown visualization. Use existing charting library or Recharts. Render pie chart or bar chart with client names and percentages.

**`apps/blast/src/components/templates/block-types.ts`** (G7):
- Add `FooterBlock` type to the `BlockType` union with props: `address` (required), `unsubscribe_url` (auto-injected), `text`, `align`.
- Add footer entry to `PALETTE` export.

**`apps/blast/src/components/templates/blocks-to-html.ts`** (G7) — add footer block HTML renderer that outputs the address + unsubscribe link markup.

**Template validation (G7):** In `campaign.service.ts` or send-time validation, check that the email body contains a footer block or the `{{unsubscribe_url}}` merge field. Reject send with clear error if missing (CAN-SPAM compliance).

## Worker jobs

**`apps/worker/src/jobs/blast-send.job.ts`** (G2, G4) — update as described in services section above.

No new worker job files.

## MCP tools

**`apps/mcp-server/src/tools/blast-tools.ts`** (G5):

Replace stubbed `blast_draft_email_content` handler (lines 372-390) with Claude API call:
- Add `@anthropic-ai/sdk` dependency.
- Build system prompt describing email copywriting best practices.
- Call `anthropic.messages.create()` with model, max_tokens, system prompt with prompt caching, user message containing description + tone + audience.
- Parse response, extract subject and html_body.
- Return structured output.

Same pattern for `blast_suggest_subject_lines` (lines 392-411) — generate 5 realistic subject line variants via Claude, not hardcoded.

On API failure, fall back to hardcoded stubs with a warning in the response metadata.

## Tests

- `apps/blast-api/src/services/__tests__/tracking.service.test.ts` (update, G1) — verify each engagement event calls publishBoltEvent with correct payload shape.
- `apps/blast-api/src/services/__tests__/webhook.service.test.ts` (update, G1) — verify bounce and complaint webhooks publish events.
- `apps/blast-api/src/services/__tests__/segment.service.test.ts` (new, G4) — filter_criteria evaluation with various operators.
- `apps/blast-api/src/services/__tests__/analytics.service.test.ts` (update, G6) — device breakdown computation.
- `apps/worker/src/jobs/__tests__/blast-send.test.ts` (update, G2, G4) — verify campaign.completed event and segment filtering behavior.
- `apps/mcp-server/src/tools/__tests__/blast-tools.test.ts` (update, G5) — mock Anthropic SDK, verify prompt structure and fallback on error.
- `apps/blast/src/components/templates/__tests__/block-types.test.ts` (update, G7) — footer block serialization and rendering.

## Verification steps

```bash
pnpm --filter @bigbluebam/blast-api build
pnpm --filter @bigbluebam/blast-api typecheck
pnpm --filter @bigbluebam/blast-api test
pnpm --filter @bigbluebam/blast typecheck
pnpm --filter @bigbluebam/blast test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-blast-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55494:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55494/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55494/verify' pnpm db:check
docker rm -f bbb-blast-verify
```

**Live smoke tests:**
- Send test campaign to 3 test recipients.
- Simulate opens (request tracking pixel URLs) and clicks (follow tracked redirect URLs).
- Verify engagement events reach Bolt (check bolt_executions or Bolt UI).
- Verify `campaign.completed` event publishes on worker finish.
- Create segment with filter_criteria (e.g. `lifecycle_stage: 'lead'`), send campaign, verify only matching contacts received it.
- Call `blast_draft_email_content` MCP tool with a description, verify realistic Claude response.
- View campaign analytics endpoint, verify `device_breakdown` field with client counts.
- Build email template without footer, attempt to send, verify validation error.

## Out of scope

Tracking endpoint rate limiting, multi-language content, A/B testing, subscription scheduling beyond current model, advanced deliverability monitoring beyond bounce/complaint webhooks, campaign cloning/templates, per-contact send-time optimization.

## Dependencies

- **`@anthropic-ai/sdk`:** new dependency for G5.
- **Anthropic API key:** `ANTHROPIC_API_KEY` env var, already required by other Claude integrations.
- **ua-parser-js or similar:** for client_info parsing from user_agent strings in G6.
- **Bolt event ingest:** existing dependency, already working.
- **SMTP provider:** existing dependency (Postmark/SES/self-hosted).

**Migration numbers claimed: 0091, 0092.** No unused slots.
