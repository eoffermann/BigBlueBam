# Blast Design Audit

**Date:** 2026-04-09
**Auditor:** Claude (automated design-vs-implementation audit)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Blast_Design_Document.md` v1.0
**Implementation:** `apps/blast-api/` (7 route files, 7 services, 7 schema tables) + `apps/blast/` (10 pages, 4 components, 4 hooks)

---

## Executive Summary

Blast is substantially implemented. The data model, API surface, frontend SPA, MCP tools, and tracking infrastructure are all present and closely follow the design document. The primary gaps are in runtime email delivery (BullMQ worker integration is stubbed), Bolt event integration (no events emitted), and some analytics visualization details (no hourly open curve, no device breakdown chart). Several items are implemented as stubs or placeholders that would need production hardening.

**Overall Completion: ~78%**

| Category | Items | Avg Rating | Notes |
|----------|-------|------------|-------|
| Data Model | 7 tables | P5 | All 7 tables match design exactly |
| API Endpoints | 26 endpoints | P4.2 | All endpoints exist; a few have simplified logic |
| MCP Tools | 14 tools | P4.0 | All 14 registered; 2 are placeholder stubs |
| Frontend Routes | 11 routes | P4.1 | All routes present; some analytics views simplified |
| Email Builder | 8 block types | P4.5 | All blocks implemented with properties + HTML renderer |
| Deliverability/Compliance | 6 features | P2.0 | Partially stubbed; no real SMTP, no BullMQ jobs |
| Bolt Integration | 6 events | P0 | No events emitted anywhere |
| Permissions | 8 rules | P3.5 | Role checks present but simplified |

---

## Feature Rating Table

Rating scale: **P0** = not implemented, **P1** = skeleton/stub only, **P2** = partial with major gaps, **P3** = functional with notable gaps, **P4** = mostly complete with minor gaps, **P5** = fully matches design.

### Data Model (Section 3)

| Feature | Rating | Notes |
|---------|--------|-------|
| `blast_templates` table | P5 | All columns, indexes, types match design |
| `blast_segments` table | P5 | All columns match; JSONB filter_criteria present |
| `blast_campaigns` table | P5 | All columns including all 7 delivery stat counters |
| `blast_send_log` table | P5 | All columns, tracking_token unique, all indexes |
| `blast_engagement_events` table | P5 | All columns, compound indexes match |
| `blast_unsubscribes` table | P5 | Unique constraint on (org, email), all columns |
| `blast_sender_domains` table | P5 | SPF/DKIM/DMARC booleans, dns_records JSONB, unique constraint |
| Migration file | P5 | `0034_blast_tables.sql` exists |

### API Endpoints (Section 4)

| Endpoint | Rating | Notes |
|----------|--------|-------|
| **Templates (4.1)** | | |
| `GET /templates` | P5 | List with type filter, search, pagination |
| `POST /templates` | P5 | Create with Zod validation, rate limiting |
| `GET /templates/:id` | P5 | Full detail retrieval |
| `PATCH /templates/:id` | P5 | Partial update, version auto-increment |
| `DELETE /templates/:id` | P5 | Org-scoped delete |
| `POST /templates/:id/preview` | P5 | Merge field substitution with sample data |
| `POST /templates/:id/duplicate` | P5 | Full clone with "(Copy)" suffix |
| **Segments (4.2)** | | |
| `GET /segments` | P5 | List with search, pagination |
| `POST /segments` | P5 | Create with structured filter_criteria |
| `GET /segments/:id` | P5 | Detail with cached count |
| `PATCH /segments/:id` | P5 | Partial update |
| `DELETE /segments/:id` | P5 | Org-scoped delete |
| `POST /segments/:id/count` | P3 | Recalculates but only applies lifecycle_stage filter; other filter ops ignored |
| `GET /segments/:id/preview` | P3 | Returns first 50 contacts but ignores filter_criteria entirely (returns all org contacts) |
| **Campaigns (4.3)** | | |
| `GET /campaigns` | P5 | List with status filter, pagination |
| `POST /campaigns` | P5 | Create with full field set |
| `GET /campaigns/:id` | P5 | Detail with all stat fields |
| `PATCH /campaigns/:id` | P5 | Only allows draft/scheduled updates (matches design) |
| `DELETE /campaigns/:id` | P5 | Only allows draft deletion (matches design) |
| `POST /campaigns/:id/send` | P3 | Transitions status correctly but does not enqueue BullMQ jobs; marks as sent immediately |
| `POST /campaigns/:id/schedule` | P5 | Sets scheduled_at, validates future time |
| `POST /campaigns/:id/pause` | P4 | Status transition correct; no actual BullMQ job cancellation |
| `POST /campaigns/:id/cancel` | P4 | Status transition correct; no actual job cancellation |
| `GET /campaigns/:id/analytics` | P4 | Returns rates, event breakdown, click URLs, delivery breakdown. Missing: hourly open curve, device/client breakdown |
| `GET /campaigns/:id/recipients` | P5 | Paginated recipient list with per-recipient status |
| **Tracking (4.4)** | | |
| `GET /t/o/:token` | P5 | Returns 1x1 GIF, logs open event, increments campaign counter |
| `GET /t/c/:token` | P5 | Validates safe redirect URL, logs click, 302 redirect. Rejects invalid tokens with 404 |
| `GET /unsub/:token` | P5 | Renders HTML confirmation page with escaped email |
| `POST /unsub/:token` | P5 | Processes unsubscribe, upserts to blast_unsubscribes, logs event |
| **Webhooks (4.5)** | | |
| `POST /webhooks/bounce` | P4 | Processes bounces, updates send_log + campaign counters. Rejects email-only fallback (security fix). Missing: soft bounce retry logic |
| `POST /webhooks/complaint` | P4 | Processes complaints, auto-unsubscribes. Same email-only rejection guard |
| **Sender Domains (4.6)** | | |
| `GET /sender-domains` | P5 | Lists all org domains |
| `POST /sender-domains` | P5 | Generates DNS records, handles duplicate conflict |
| `POST /sender-domains/:id/verify` | P2 | Stub: simulates verification (`domain.includes('.')` always true). No real DNS lookups |
| `DELETE /sender-domains/:id` | P5 | Org-scoped delete |
| **Analytics (4.7)** | | |
| `GET /analytics/overview` | P5 | Aggregates across all sent campaigns, computes avg rates, total unsubscribes |
| `GET /analytics/engagement-trend` | P5 | Supports daily/weekly/monthly truncation, returns open/click rates per period |

### MCP Tools (Section 5)

| Tool | Rating | Notes |
|------|--------|-------|
| `blast_list_templates` | P5 | Proxies to API with type/search/limit params |
| `blast_get_template` | P5 | Direct proxy |
| `blast_create_template` | P5 | Proxies create with all fields |
| `blast_draft_campaign` | P5 | Maps to POST /campaigns |
| `blast_get_campaign` | P5 | Direct proxy |
| `blast_send_campaign` | P4 | Implements require_human_approval flag (schedules 1hr out when true). Design mentions Banter DM notification -- not implemented |
| `blast_get_campaign_analytics` | P5 | Proxies to analytics endpoint |
| `blast_list_segments` | P5 | Proxies with search/limit |
| `blast_create_segment` | P5 | Full filter_criteria passthrough |
| `blast_preview_segment` | P5 | Proxies to preview endpoint |
| `blast_draft_email_content` | P2 | Stub: returns templated string, no actual LLM integration |
| `blast_suggest_subject_lines` | P2 | Stub: returns formulaic strings, no LLM |
| `blast_get_engagement_summary` | P5 | Proxies to analytics/overview |
| `blast_check_unsubscribed` | P1 | Stub: returns a note string instead of querying blast_unsubscribes. The service function `checkUnsubscribed` exists in analytics.service.ts but is not wired to an API endpoint or this tool |

### Email Builder (Section 6)

| Feature | Rating | Notes |
|---------|--------|-------|
| Block types: Header, Text, Image, Button, Divider, Columns, Social, Spacer | P5 | All 8 block types defined with full property sets |
| Footer block | P3 | Design lists "Footer" as its own block type. Implementation uses a Text block with unsubscribe link as default content. Functional but not a dedicated block |
| Drag-and-drop reorder | P5 | dnd-kit with sortable context, grip handles |
| Block property editor | P5 | Per-type property panels with alignment, colors, sizing |
| HTML output renderer | P5 | Table-based responsive layout, inline styles, 600px wrapper |
| Merge field support | P4 | `{{field}}` syntax supported in templates. Missing: merge field insertion UI (no picker/autocomplete) |
| Responsive preview | P5 | Desktop (600px), tablet (480px), mobile (320px) toggles |
| JSON design persistence | P5 | Saved as json_design column, restored on edit |
| HTML source view | P5 | Toggle between visual preview and raw HTML |
| Template from builder or raw HTML | P5 | Campaign editor supports visual, HTML, and template modes |

### Frontend Routes (Section 9)

| Route | Rating | Notes |
|-------|--------|-------|
| `/blast` (campaign list) | P5 | Table with status, sent date, open rate, click rate. Status filter tabs |
| `/blast/campaigns/new` | P5 | Template selection, segment selection, visual builder, HTML mode |
| `/blast/campaigns/:id` | P4 | Analytics dashboard with metrics grid and click URLs. Missing: delivery funnel chart, hourly open curve, device breakdown pie chart, recipient table |
| `/blast/templates` | P5 | Grid gallery with thumbnails, version badges, duplicate/delete actions |
| `/blast/templates/new` | P5 | Full visual builder with save |
| `/blast/templates/:id/edit` | P5 | Edit existing template, loads json_design |
| `/blast/segments` | P5 | List with cached counts, recalculate button, delete |
| `/blast/segments/new` | P5 | Visual filter builder with field/operator/value rows, AND/OR toggle |
| `/blast/analytics` | P4 | Overview metrics + weekly trend table. Missing: chart visualizations (design mentions no specific chart library requirement, table is functional) |
| `/blast/settings/domains` | P5 | Add/verify/delete domains, shows DNS records with SPF/DKIM/DMARC status |
| `/blast/settings/smtp` | P3 | Read-only display of env var placeholders. No actual SMTP config editing (by design -- env vars) |

### Deliverability & Compliance (Section 8)

| Feature | Rating | Notes |
|---------|--------|-------|
| SPF/DKIM/DMARC verification | P2 | DNS record generation is correct. Verification is stubbed (no actual DNS lookups) |
| Refuse to send from unverified domains | P0 | No check in sendCampaign that the from_email domain is verified |
| List-Unsubscribe headers (RFC 8058) | P0 | No header injection in sent emails (no actual email rendering in BullMQ worker) |
| Unsubscribe exclusion from sends | P3 | sendCampaign counts unsubscribes and subtracts from recipient count, but no actual per-recipient exclusion logic |
| Bounce processing: hard/soft/complaint | P3 | Hard and complaint processing works. Soft bounce retry (3x over 24h) not implemented |
| Rate limiting (Redis token bucket) | P0 | No send rate limiting implemented. BullMQ worker has no blast jobs |
| CAN-SPAM physical address in footer | P0 | No org address configuration or enforcement |
| Engagement feeds back to Bond | P0 | No Bond activity sync on open/click/bounce/unsubscribe |

### Bolt Integration Events (Section 7)

| Event | Rating | Notes |
|-------|--------|-------|
| `blast.campaign.sent` | P0 | No event emitted |
| `blast.campaign.completed` | P0 | No event emitted |
| `blast.engagement.opened` | P0 | No event emitted |
| `blast.engagement.clicked` | P0 | No event emitted |
| `blast.engagement.unsubscribed` | P0 | No event emitted |
| `blast.engagement.bounced` | P0 | No event emitted |

### Permissions (Section 10)

| Rule | Rating | Notes |
|------|--------|-------|
| View campaigns/analytics: all roles | P5 | requireAuth only (no role check) |
| Create/edit templates: Admin/Manager/Member | P5 | requireMinRole('member') |
| Create/edit campaigns: Admin/Manager/Member | P5 | requireMinRole('member') |
| Send campaigns: Admin/Manager only | P4 | Uses requireMinRole('admin') -- stricter than design (design says Manager can send) |
| Create/edit segments: Admin/Manager/Member | P5 | requireMinRole('member') |
| Configure sender domains: Admin only | P5 | requireMinRole('admin') + requireScope('admin') |
| Configure SMTP: Admin only | P5 | Page is read-only env display (appropriate) |
| Delete campaigns/templates: Admin/Manager | P4 | Uses requireMinRole('admin') -- stricter than design (design says Manager can delete) |

---

## Detailed Findings (P0-P3)

### P0 Items -- Not Implemented

1. **Bolt Integration Events (Section 7):** None of the 6 Blast events are emitted anywhere in the codebase. The Bolt API has no references to `blast.` events. This blocks any drip-sequence or automation-triggered workflows involving Blast engagement signals.

2. **Refuse to send from unverified domains (Section 8.1):** The design states "Blast refuses to send from unverified domains." The `sendCampaign` service performs no domain verification check against `blast_sender_domains` before transitioning to sending status.

3. **List-Unsubscribe headers (Section 8.2):** No email rendering occurs in the codebase. The BullMQ worker has no blast-related job handlers. RFC 8058 List-Unsubscribe and List-Unsubscribe-Post headers are not injected.

4. **Send rate limiting via Redis token bucket (Section 8.4):** No token-bucket rate limiter exists for SMTP send throughput. BullMQ batching (100 recipients per job) is not implemented.

5. **CAN-SPAM physical address (Section 8.5):** No organization address configuration exists. No enforcement that the email footer contains a physical address.

6. **Engagement feeds back to Bond (Section 1.2, principle 5):** Opens, clicks, bounces, and unsubscribes are recorded in Blast tables but never synced to Bond as activities on the contact.

### P1 Items -- Skeleton Only

7. **`blast_check_unsubscribed` MCP tool:** Returns a hardcoded note string. The actual `checkUnsubscribed()` function exists in `analytics.service.ts` but is not wired to any API endpoint or to this MCP tool.

### P2 Items -- Partial with Major Gaps

8. **DNS domain verification (`POST /sender-domains/:id/verify`):** The service stubs verification with `domain.includes('.')`, which always returns true. No actual `dns.resolveTxt()` or equivalent DNS lookups are performed.

9. **`blast_draft_email_content` MCP tool:** Returns a simple formatted string rather than calling an LLM. Design principle 6 states "AI drafts, humans approve" -- the approval flow works but the drafting is non-functional.

10. **`blast_suggest_subject_lines` MCP tool:** Same as above -- formulaic string concatenation instead of LLM-generated variants.

### P3 Items -- Functional with Notable Gaps

11. **Segment count recalculation (`POST /segments/:id/count`):** Only applies `lifecycle_stage IN (...)` from filter criteria. Other operators (equals, contains, greater_than, less_than, older_than_days) on other fields are silently ignored.

12. **Segment preview (`GET /segments/:id/preview`):** Returns the first 50 contacts from the org regardless of filter_criteria. The filter is not applied.

13. **Campaign send (`POST /campaigns/:id/send`):** Correctly transitions status draft->sending->sent and computes recipient count minus unsubscribes. However, no BullMQ jobs are enqueued, no per-recipient send_log entries are created, no actual emails are sent, and no tracking tokens are generated.

14. **Soft bounce retry logic:** Design specifies "retried up to 3 times over 24 hours." The webhook bounce handler records the bounce but has no retry mechanism.

15. **SMTP Settings page:** Read-only env var display. Adequate as designed (env-var-only config) but provides no feedback about whether SMTP is actually configured or functional. No connection test button.

16. **Footer block type:** Design lists Footer as a first-class block type (Section 6.2) with mandatory unsubscribe link and org address. Implementation uses a generic Text block with unsubscribe link as default content -- no enforcement that the footer exists or contains required elements.

---

## P4-P5 Summary (Well-Implemented)

These features closely match the design with only minor deviations:

- **All 7 database tables** (P5) -- perfect schema match
- **Template CRUD + preview + duplicate** (P5) -- full implementation with version auto-increment
- **Campaign CRUD** (P5) -- status guards on update (draft/scheduled only) and delete (draft only)
- **Campaign analytics endpoint** (P4) -- returns rates, click URLs, delivery breakdown; missing hourly curve and device breakdown
- **All 8 email block types** (P5) -- Header, Text, Image, Button, Divider, Columns, Social, Spacer with full property editors
- **Visual builder** (P5) -- drag-and-drop reorder, block palette, property panel, responsive device preview (3 sizes), HTML source toggle
- **Tracking pixel + click redirect + unsubscribe flow** (P5) -- complete with HTML escaping, safe-URL validation, idempotent unsubscribe upsert
- **Webhook bounce/complaint processing** (P4) -- correctly updates send_log and campaign counters, auto-unsubscribes on complaint, security fix for cross-org email-only mis-attribution
- **Sender domain management** (P5 for CRUD, P2 for verification)
- **Org-level analytics** (P5) -- overview metrics and engagement trend with daily/weekly/monthly periods
- **All 14 MCP tools registered** (P4 avg) -- 10 tools fully functional via API proxy, 2 AI content stubs, 1 stub, 1 with wrong wiring
- **Frontend SPA** (P4.1 avg) -- all 11 routes present, dark mode, auth gate, manual routing with pushState
- **Error response envelope** (P5) -- matches `{ error: { code, message, details, request_id } }` pattern
- **Zod validation** (P5) -- all route inputs validated with Zod schemas
- **Environment configuration** (P5) -- SMTP, tracking URL, webhook secret, all documented env vars present

---

## Recommendations

### High Priority (blocks core value proposition)

1. **Implement BullMQ blast:send job handler in worker.** This is the most critical gap. Without actual email delivery, Blast is a campaign management UI with no send capability. The handler should:
   - Accept batches of 100 recipient contact IDs
   - Render templates with per-contact merge fields
   - Send via configured SMTP relay
   - Create blast_send_log entries with tracking tokens
   - Inject tracking pixel and rewrite links for click tracking
   - Add List-Unsubscribe and List-Unsubscribe-Post headers
   - Respect send rate limits via Redis token bucket

2. **Wire segment filter_criteria to actual Bond contact queries.** The `recalculateSegmentCount` and `previewSegmentContacts` services need to translate all filter operators (equals, not_equals, in, contains, greater_than, less_than, older_than_days) into SQL conditions against bond_contacts columns and custom_fields JSONB.

3. **Add domain verification check to sendCampaign.** Before transitioning to sending status, verify that the campaign's from_email domain exists in blast_sender_domains and is verified (spf_verified AND dkim_verified).

### Medium Priority (compliance and integration)

4. **Emit Bolt events** from campaign send, tracking, and webhook services. This enables drip sequences and automation triggers.

5. **Sync engagement events to Bond activities.** After recording an open/click/bounce/unsubscribe in Blast tables, create a corresponding activity record on the Bond contact.

6. **Implement real DNS verification** in the sender domain verify service using Node.js `dns.promises.resolveTxt()` and `dns.promises.resolveCname()`.

7. **Fix `blast_check_unsubscribed` MCP tool** to call a dedicated API endpoint backed by the existing `checkUnsubscribed()` function in analytics.service.ts.

8. **Add CAN-SPAM physical address** as an org-level Blast setting (stored in a blast_settings table or as org metadata), enforced in the email footer.

### Lower Priority (polish)

9. **Campaign detail page enhancements:** Add delivery funnel visualization, hourly open-rate curve for first 72 hours, device/client breakdown, and embedded recipient table.

10. **Relax send/delete permissions** from requireMinRole('admin') to requireMinRole('manager') to match the design's permission matrix.

11. **Add dedicated Footer block type** with mandatory unsubscribe link and physical address fields, enforced as required in every template/campaign.

12. **Soft bounce retry:** Add retry logic (3 attempts over 24 hours) for soft bounces in the webhook handler or as a scheduled BullMQ job.
