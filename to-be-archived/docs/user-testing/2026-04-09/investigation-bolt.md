# Bolt Investigation — Trigger Sources & Action Catalog

**Issue:** The Bolt automation builder only exposes 6 trigger sources (Bam, Banter, Beacon, Brief, Helpdesk, Schedule) and 6 action sources (Bam, Banter, Beacon, Brief, Helpdesk, System). The user is correct that we have many more events being emitted and many more MCP tools available across the platform; the catalog has not been kept in sync as new apps were added.

This is a research-only document. Findings, root cause, and recommendations below — no fixes applied.

---

## 1. Root cause

The catalog Bolt shows the user is a hand-maintained static list in:

- `apps/bolt-api/src/services/event-catalog.ts` — defines `getAllEvents()` and `getAvailableActions()` consumed by `GET /events` and `GET /actions` in `apps/bolt-api/src/routes/event.routes.ts`. Frontend pulls these via `useEventCatalog` / `useActionCatalog` in `apps/bolt/src/hooks/use-event-catalog.ts`.

The catalog has never been extended past the original Phase-1 set of apps. Meanwhile, ten apps now publish Bolt events (`apps/api`, `banter-api`, `beacon-api`, `bearing-api`, `bill-api`, `blank-api`, `blast-api`, `board-api`, `bond-api`, `book-api`, `brief-api`).

But fixing the static catalog alone is **not sufficient** — the trigger source is constrained by `pgEnum` and Zod schemas in **at least seven other places** that all hardcode the same 6-value list:

| Location | What it constrains |
|---|---|
| `apps/bolt-api/src/db/schema/bolt-automations.ts:15` | `boltTriggerSourceEnum` PG enum — DB-level rejection of any new source |
| `apps/bolt-api/src/routes/event-ingestion.routes.ts:23` | `ingestEventSchema.source` — **rejects inbound events from bond/blast/board/bill/book/blank/bearing with HTTP 400** |
| `apps/bolt-api/src/routes/event.routes.ts:5` | `VALID_SOURCES` set — `GET /events/:source` 400s on unknown sources |
| `apps/bolt-api/src/routes/automation.routes.ts:12` | `TRIGGER_SOURCES` — automation create/update validation |
| `apps/bolt-api/src/services/automation.service.ts:197,743` | `TriggerSource` type + stats SQL |
| `apps/bolt-api/src/lib/publish-event.ts:24,58` | `BoltEventSource` type used by Bolt's own internal publisher |
| `apps/bolt-api/test/security.test.ts:210` | Test fixture |
| `apps/bolt/src/hooks/use-automations.ts:7` | Frontend `TriggerSource` type |
| `apps/bolt/src/components/builder/trigger-selector.tsx:11-18` | UI dropdown options (the immediate cause of the symptom the user sees) |
| `apps/mcp-server/src/tools/bolt-tools.ts:66,96,118,216` | MCP tool zod enums for `trigger_source` |

**Operational consequence:** every `publishBoltEvent('bond.deal.created', ...)` from bond-api currently posts a body with `source: 'bond'` to `/v1/events/ingest`, which the Zod schema rejects with 400. Because `publishBoltEvent` is fire-and-forget and swallows errors, **no one has noticed that those events have been silently dropped**. Every event from bond, blast, board, bill, book, blank, and bearing is currently a no-op.

---

## 2. Current trigger sources & event counts (in `event-catalog.ts`)

| Source | Events | Event types |
|---|---|---|
| `bam` | 10 | `task.created`, `task.updated`, `task.moved`, `task.assigned`, `task.completed`, `task.overdue`, `task.commented`, `epic.completed`, `sprint.started`, `sprint.completed` |
| `banter` | 4 | `message.posted`, `message.mentioned`, `channel.created`, `reaction.added` |
| `beacon` | 4 | `beacon.published`, `beacon.expired`, `beacon.challenged`, `beacon.verified` |
| `brief` | 4 | `document.created`, `document.promoted`, `document.status_changed`, `document.commented` |
| `helpdesk` | 4 | `ticket.created`, `ticket.replied`, `ticket.status_changed`, `ticket.sla_breach` |
| `schedule` | 1 | `cron.fired` |
| **Total** | **27** | |

### Stale within existing sources

Even within the 6 listed sources, the catalog drifts from what's actually emitted:

- **bam**: catalog is missing `task.deleted` (emitted at `apps/api/src/services/task.service.ts:253`), and `comment.created` is emitted (`apps/api/src/routes/comment.routes.ts:172`) but listed in the catalog as `task.commented` — name mismatch means user-defined automations on `task.commented` will never fire.
- **banter**: catalog is missing `message.edited` (emitted at `apps/banter-api/src/routes/message.routes.ts:507`).
- **beacon**: catalog lists `beacon.published` (matches), but is missing `beacon.created` and `beacon.updated` (both emitted at `apps/beacon-api/src/routes/beacon.routes.ts:58,132`).
- **brief**: catalog lists `document.created` (matches) but is missing `document.updated` and `document.published` (`apps/brief-api/src/services/document.service.ts:340,344`); also lists `document.promoted` / `document.status_changed` / `document.commented` which are **not** currently emitted by brief-api at all.
- **helpdesk**: catalog lists 4 events but **helpdesk-api emits zero `publishBoltEvent` calls.** None of the 4 helpdesk events fire today.

---

## 3. Missing trigger sources & their events

These sources have a working `apps/<app>/src/lib/bolt-events.ts` and call `publishBoltEvent(...)`, but are absent from the catalog and are blocked at the ingest layer by the source-enum Zod schema. Every event listed below is currently being dropped.

### 3.1 `bond` (Bond CRM) — 6 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `bond.deal.created` | `apps/bond-api/src/services/deal.service.ts:285` |
| `bond.deal.updated` | `apps/bond-api/src/services/deal.service.ts:317` |
| `bond.deal.stage_changed` | `apps/bond-api/src/services/deal.service.ts:416` |
| `bond.deal.won` | `apps/bond-api/src/services/deal.service.ts:500` |
| `bond.deal.lost` | `apps/bond-api/src/services/deal.service.ts:581` |
| `bond.contact.created` | `apps/bond-api/src/services/contact.service.ts:231` |
| `bond.activity.logged` | `apps/bond-api/src/services/activity.service.ts:177` |

(Note: bond's `publishBoltEvent` calls use a 3-arg signature `(eventType, payload, orgId)` while every other app uses `(eventType, source, payload, orgId)`. Worth verifying signature consistency when fixing — see `apps/bond-api/src/lib/bolt-events.ts:7` which hardcodes `source: 'bond'` server-side, so the call sites omit it. This is internally consistent but inconsistent across apps.)

### 3.2 `blast` (Email Campaigns) — 2 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `campaign.created` | `apps/blast-api/src/routes/campaigns.routes.ts:65` |
| `campaign.sent` | `apps/blast-api/src/routes/campaigns.routes.ts:123` |

Likely additions (not yet emitted but obvious from the schema/use cases): `campaign.scheduled`, `campaign.opened`, `campaign.clicked`, `campaign.bounced`, `campaign.unsubscribed`.

### 3.3 `board` (Whiteboards) — 2 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `board.created` | `apps/board-api/src/routes/board.routes.ts:87` |
| `board.updated` | `apps/board-api/src/routes/board.routes.ts:189` |

### 3.4 `bearing` (Goals & OKRs) — 4 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `goal.created` | `apps/bearing-api/src/routes/goals.ts:97` |
| `goal.updated` | `apps/bearing-api/src/routes/goals.ts:134` |
| `key_result.updated` | `apps/bearing-api/src/routes/key-results.ts:148` |
| `key_result.updated` (progress) | `apps/bearing-api/src/routes/key-results.ts:183` |

### 3.5 `bill` (Invoicing) — 5 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `invoice.created` | `apps/bill-api/src/routes/invoices.routes.ts:74` |
| `invoice.created` (from second route) | `apps/bill-api/src/routes/invoices.routes.ts:262` |
| `invoice.finalized` | `apps/bill-api/src/routes/invoices.routes.ts:159` |
| `invoice.paid` | `apps/bill-api/src/services/payment.service.ts:77` |
| `payment.recorded` | `apps/bill-api/src/routes/payments.routes.ts:30` |

### 3.6 `book` (Calendar/Events) — 3 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `event.created` | `apps/book-api/src/routes/events.routes.ts:96` |
| `event.updated` | `apps/book-api/src/routes/events.routes.ts:132` |
| `booking.created` | `apps/book-api/src/routes/public-booking.routes.ts:57` |

### 3.7 `blank` (Form Builder) — 2 events emitted, 0 in catalog
| Event | Source location |
|---|---|
| `form.published` | `apps/blank-api/src/routes/forms.routes.ts:172` |
| `submission.created` | `apps/blank-api/src/routes/public.routes.ts:131` |

### 3.8 `bench` (Analytics)
No `bolt-events.ts` and no `publishBoltEvent` calls. Bench doesn't currently emit anything. Candidates worth adding once we wire it up: `dashboard.created`, `dashboard.shared`, `widget.threshold_breached`, `report.scheduled.delivered`, `anomaly.detected`.

### Summary
Adding the seven missing sources (`bond`, `blast`, `board`, `bearing`, `bill`, `book`, `blank`) brings the catalog from 6 → 13 sources and adds **24 new event types** that are *already being emitted today* but currently dropped.

---

## 4. Current actions in `getAvailableActions()` (per source)

| Source | Count | Tools |
|---|---|---|
| `bam` | 7 | `bam_create_task`, `bam_update_task`, `bam_assign_task`, `bam_move_task`, `bam_add_comment`, `bam_add_label`, `bam_set_due_date` |
| `banter` | 3 | `banter_send_message`, `banter_send_dm`, `banter_create_channel` |
| `beacon` | 3 | `beacon_create_entry`, `beacon_update_entry`, `beacon_flag_for_review` |
| `brief` | 2 | `brief_create_document`, `brief_update_status` |
| `helpdesk` | 4 | `helpdesk_create_ticket`, `helpdesk_reply_ticket`, `helpdesk_assign_ticket`, `helpdesk_update_priority` |
| `system` | 2 | `send_email_notification`, `send_webhook` |
| **Total** | **21** | |

### Naming drift in current actions
The action names listed in `getAvailableActions()` **do not match the actual MCP tool names** registered in `apps/mcp-server/src/tools/*-tools.ts`. The Bolt action runner is going to fail when it tries to invoke any of these. Examples:

| Catalog says | Actual MCP tool name |
|---|---|
| `bam_create_task` | `create_task` (in `task-tools.ts`) |
| `bam_update_task` | `update_task` |
| `bam_assign_task` | (no such tool — assignment is via `update_task`) |
| `bam_move_task` | `move_task` |
| `bam_add_comment` | `add_comment` (in `comment-tools.ts`) |
| `bam_add_label` | (no such tool — done via `update_task`) |
| `bam_set_due_date` | (no such tool — done via `update_task`) |
| `banter_send_message` | `banter_post_message` |
| `banter_send_dm` | `banter_send_dm` ✓ |
| `banter_create_channel` | `banter_create_channel` ✓ |
| `beacon_create_entry` | `beacon_create` |
| `beacon_update_entry` | `beacon_update` |
| `beacon_flag_for_review` | `beacon_challenge` (closest match) |
| `brief_create_document` | `brief_create` |
| `brief_update_status` | (no such tool — done via `brief_update`) |
| `helpdesk_create_ticket` | (no such tool — helpdesk-tools.ts only has `list_tickets`, `get_ticket`, `reply_to_ticket`, `update_ticket_status`, `helpdesk_get_public_settings`, `helpdesk_get_settings`, `helpdesk_update_settings`) |
| `helpdesk_reply_ticket` | `reply_to_ticket` |
| `helpdesk_assign_ticket` | (no such tool) |
| `helpdesk_update_priority` | (no such tool) |

So roughly **half** of the currently exposed Bolt actions point at tools that don't exist. This is independent of the missing-app problem and needs to be cleaned up at the same time.

---

## 5. Missing actions (real MCP tools that should be exposed)

The MCP server now registers tools across **24 modules**. The actionable subset that should be exposed in Bolt's action catalog is below. These are all real, currently-registered tool names (verified by grepping `server.tool(\n    '<name>'` in each module).

### 5.1 `bam` — fix existing entries + add missing
Currently registered in `apps/mcp-server/src/tools/task-tools.ts`, `comment-tools.ts`, `sprint-tools.ts`, `project-tools.ts`:
`search_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `delete_task`, `bulk_update_tasks`, `log_time`, `duplicate_task`, `import_csv`, `list_comments`, `add_comment`, `list_sprints`, `create_sprint`, `start_sprint`, `complete_sprint`, `get_sprint_report`, `list_projects`, `get_project`, `create_project`.
Recommended Bolt-action subset (mutating tools only): `create_task`, `update_task`, `move_task`, `delete_task`, `bulk_update_tasks`, `add_comment`, `log_time`, `duplicate_task`, `create_sprint`, `start_sprint`, `complete_sprint`, `create_project`.

### 5.2 `banter` — add missing
Registered in `apps/mcp-server/src/tools/banter-tools.ts` (47 tools). Recommended action subset:
`banter_post_message`, `banter_send_dm`, `banter_send_group_dm`, `banter_create_channel`, `banter_archive_channel`, `banter_add_channel_members`, `banter_react`, `banter_pin_message`, `banter_share_task`, `banter_share_sprint`, `banter_share_ticket`, `banter_start_call`, `banter_end_call`, `banter_invite_agent_to_call`.

### 5.3 `beacon` — fix existing + add missing
Registered in `apps/mcp-server/src/tools/beacon-tools.ts` (29 tools). Recommended action subset:
`beacon_create`, `beacon_update`, `beacon_publish`, `beacon_verify`, `beacon_challenge`, `beacon_retire`, `beacon_restore`, `beacon_tag_add`, `beacon_tag_remove`, `beacon_link_create`, `beacon_link_remove`, `beacon_policy_set`.

### 5.4 `brief` — fix existing + add missing
Registered in `apps/mcp-server/src/tools/brief-tools.ts` (18 tools). Recommended action subset:
`brief_create`, `brief_update`, `brief_update_content`, `brief_append_content`, `brief_archive`, `brief_restore`, `brief_duplicate`, `brief_promote_to_beacon`, `brief_link_task`, `brief_comment_add`, `brief_comment_resolve`, `brief_version_restore`.

### 5.5 `helpdesk` — fix existing
Registered in `apps/mcp-server/src/tools/helpdesk-tools.ts` (7 tools). The current catalog claims 4 helpdesk actions; only 2 actually exist:
`reply_to_ticket`, `update_ticket_status` (and `helpdesk_update_settings` for org-level workflow).

### 5.6 `bond` (NEW) — add 22 actions
Registered in `apps/mcp-server/src/tools/bond-tools.ts`. Recommended:
`bond_create_contact`, `bond_update_contact`, `bond_merge_contacts`, `bond_create_company`, `bond_update_company`, `bond_create_deal`, `bond_update_deal`, `bond_move_deal_stage`, `bond_close_deal_won`, `bond_close_deal_lost`, `bond_log_activity`, `bond_score_lead`.

### 5.7 `blast` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/blast-tools.ts`. Recommended:
`blast_create_template`, `blast_draft_campaign`, `blast_send_campaign`, `blast_create_segment`, `blast_draft_email_content`.

### 5.8 `board` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/board-tools.ts`. Recommended:
`board_create`, `board_update`, `board_archive`, `board_add_sticky`, `board_add_text`, `board_promote_to_tasks`, `board_export`.

### 5.9 `bearing` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/bearing-tools.ts`. Recommended:
`bearing_goal_create`, `bearing_goal_update`, `bearing_kr_create`, `bearing_kr_update`, `bearing_kr_link`, `bearing_update_post`.

### 5.10 `bill` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/bill-tools.ts`. Recommended:
`bill_create_invoice`, `bill_create_invoice_from_time`, `bill_create_invoice_from_deal`, `bill_add_line_item`, `bill_finalize_invoice`, `bill_send_invoice`, `bill_record_payment`, `bill_create_expense`.

### 5.11 `book` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/book-tools.ts`. Recommended:
`book_create_event`, `book_update_event`, `book_cancel_event`, `book_find_meeting_time`, `book_create_booking_page`, `book_rsvp_event`.

### 5.12 `blank` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/blank-tools.ts`. Recommended:
`blank_create_form`, `blank_generate_form`, `blank_update_form`, `blank_publish_form`, `blank_export_submissions`.

### 5.13 `bench` (NEW) — add actions
Registered in `apps/mcp-server/src/tools/bench-tools.ts`. Recommended:
`bench_query_widget`, `bench_query_ad_hoc`, `bench_summarize_dashboard`, `bench_detect_anomalies`, `bench_generate_report`, `bench_compare_periods`.

### 5.14 `system` — keep
`send_email_notification`, `send_webhook` — verify these are actually wired up in the action runner; they don't appear in any `*-tools.ts` module so they may be Bolt-internal action types rather than MCP tool calls. Worth confirming when fixing.

### Action totals
- **Current:** 21 actions across 6 sources, ~10 of which point at non-existent tool names.
- **Proposed:** ~110 actions across 13 sources, all backed by real registered MCP tools.

---

## 6. Recommended approach

This is a multi-layer fix, not just an event-catalog edit. The minimum-viable correct fix is:

1. **Add a new numbered migration** in `infra/postgres/migrations/` that does `ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS 'bond'` (and the same for `blast`, `board`, `bearing`, `bill`, `book`, `blank`, `bench`). Postgres `ALTER TYPE ... ADD VALUE` is idempotent-friendly with `IF NOT EXISTS`. Must be in a separate transaction from any subsequent use of the new value, so this should be its own migration file.
2. **Update the Drizzle enum** in `apps/bolt-api/src/db/schema/bolt-automations.ts` to match.
3. **Update every Zod/TypeScript hardcoded list** noted in section 1 (all 10+ locations) to include the new sources. Consider extracting `BOLT_TRIGGER_SOURCES` as a single shared const exported from `@bigbluebam/shared` so this never drifts again.
4. **Extend `event-catalog.ts`** with:
   - The 24 missing events from sections 3.1–3.7.
   - Fix the existing-source drift noted in section 2 (rename `task.commented` → `comment.created`, add `task.deleted`, `message.edited`, `beacon.created`, `beacon.updated`, `document.updated`, `document.published`; remove the helpdesk events that don't actually fire — or, better, add the missing `publishBoltEvent` calls inside helpdesk-api so the catalog matches reality).
   - The corrected/expanded action list in section 5 (~110 entries with real MCP tool names).
5. **Update `apps/bolt/src/components/builder/trigger-selector.tsx`** to add UI labels for the new sources, OR — better — drive the dropdown from the `/events` API response so it auto-discovers sources from the catalog and never needs editing again.
6. **Verify the action runner** in bolt-api actually invokes MCP tools by the names exposed in the catalog. If the runner currently expects the old fake names (`bam_create_task` etc.), the rename in step 4 will break existing automations and they'll need a data migration too.
7. **Long-term**: replace the static catalog with a per-app event-manifest pattern, where each `apps/<app>/src/lib/bolt-events.ts` exports both `publishBoltEvent` *and* a typed `BOLT_EVENT_DEFINITIONS` array, and bolt-api aggregates them at startup. This makes drift impossible because adding an event in code requires updating the manifest in the same file.

The fix is large (touches 10+ files plus a DB migration plus the catalog plus the action runner) but the underlying motion is mechanical once the design decision in step 7 is made.

---

## 7. Files referenced

- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\services\event-catalog.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\routes\event.routes.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\routes\event-ingestion.routes.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\routes\automation.routes.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\services\automation.service.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\db\schema\bolt-automations.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt-api\src\lib\publish-event.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt\src\hooks\use-automations.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt\src\hooks\use-event-catalog.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\bolt\src\components\builder\trigger-selector.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\mcp-server\src\tools\bolt-tools.ts`
- All `apps/*/src/lib/bolt-events.ts` (11 files) and their call sites listed inline above.
