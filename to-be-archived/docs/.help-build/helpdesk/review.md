# Helpdesk help.md - Review

## Verdict

**APPROVED**

The doc is accurate, complete against the template, and code-backed. Every UI
label, MCP tool, status/priority value, and flagged-behavior claim I spot-checked
traces to code. The three required negative checks all pass:

- It does NOT document a Helpdesk Knowledge Base. It explicitly states there is
  none and points to Beacon (Overview line 39, feature line 497, Related line 506).
- It does NOT reference `05-knowledge-base.png`. The only screenshots referenced
  are `01-portal`, `02-login`, `03-ticket-list`, `04-ticket-detail`, `05-new-ticket`,
  all of which exist on disk.
- It documents the canonical statuses including `waiting_on_customer`, and it
  truthfully flags the dead filter chips and the stale MCP `waiting_on_client` enum.

No fixes required.

## Verification performed

### Template completeness
All four required sections present and filled: Overview (with Key concepts +
Where to find it), Feature reference (with Working with AI agents), User Stories,
Related. Plus an extra "Flagged behavior" section that adds value without
violating the template.

### MCP tools - all 13 code-backed
- 11 in `apps/mcp-server/src/tools/helpdesk-tools.ts`: `list_tickets`, `get_ticket`,
  `helpdesk_get_ticket_by_number`, `helpdesk_search_tickets`, `reply_to_ticket`,
  `update_ticket_status`, `helpdesk_get_public_settings`, `helpdesk_get_settings`,
  `helpdesk_update_settings`, `helpdesk_set_default_project`, `helpdesk_upsert_user`.
- `helpdesk_find_similar_tickets` in `apps/mcp-server/src/tools/dedupe-tools.ts`
  (line 121).
- `helpdesk_ticket_count_by_phrase` in
  `apps/mcp-server/src/tools/phrase-count-tools.ts` (line 88).
Count of 13 stated in the doc (lines 259, 508) is correct.

### Screenshots
All 5 referenced files exist under `docs/apps/helpdesk/screenshots/light/`.
`05-knowledge-base.png` exists on disk but is correctly NOT referenced.

### Conventions
No em dashes and no en dashes in the doc body (grep clean). Spaced hyphens used
throughout.

### Accuracy spot-checks (label -> code)
- Statuses Open / In Progress / Waiting on Customer / Resolved / Closed:
  `apps/helpdesk/src/components/common/badge.tsx` lines 14-20. Match.
- Priorities Low / Medium / High / Critical (customer capped at high via header
  dropdown `['low','medium','high']`): badge.tsx lines 29-34; ticket-detail.tsx
  line 311. Match.
- Dead filter chips "awaiting customer" / "awaiting internal":
  `tickets-list.tsx` line 36 `STATUS_FILTERS` includes `awaiting_customer` /
  `awaiting_internal`, neither of which is a real status. Match.
- Stale MCP enum: `update_ticket_status` advertises `waiting_on_client`
  (helpdesk-tools.ts line 232); agent route schema only accepts
  `waiting_on_customer`. `helpdesk_search_tickets` lists both (line 154). Doc's
  claim is exactly correct.
- Agent-queue SLA badge hardcoded 4h / 0.75 imminent: `agent.routes.ts` lines
  1396-1397 (`SLA_TARGET_MS = 4 * 60 * 60 * 1000`, `SLA_IMMINENT_THRESHOLD = 0.75`),
  vs per-org defaults 480/2880 min. Doc's claim is correct.
- Page labels verified in code: "Choose your support portal", "Create your
  account", "Min. 12 characters", "Create Account", "Welcome back", "Sign In",
  "Create one", "Email Verification", "Go to Login", "My Tickets", "New Ticket",
  "Brief summary of your issue", "Select a category...", "Submit Ticket",
  "Mark as duplicate", "Close Ticket", "Close this ticket?", "Share to Banter",
  "Select a channel...", "Add a note...", "e.g. #123", "Duplicates of this
  ticket", "This ticket has been resolved/closed.", "Reopen", "Unmark",
  "No messages yet.", "Type your reply...", "Send Reply",
  "Get notified when agents respond to your tickets.", "Enable notifications".
  All match.
- `hdag_` agent key auth, `X-Agent-Key`, Bam session alone not accepted on
  /agents/* routes: consistent with dossier section 3.5. Match.

### Story coverage
- Setup: "Set up a new support portal" (admin).
- Core loop: "File your first support ticket", "Track a ticket and reply".
- Collaboration: "Share a ticket to a Banter channel", "Merge duplicate tickets".
- Search/reporting: "Report on ticket trends" (helpdesk_ticket_count_by_phrase).
- Agent flow: "Work the agent queue", "Reconcile a customer from an external
  system" (helpdesk_upsert_user).
All present and followable.

## Accuracy findings (non-blocking)

1. (Cosmetic, not a fix) The live ticket-detail header renders the separator as
   a true em dash: `ticket-detail.tsx` line 286 `{' — '}` (also lines 294 in the
   presence label). The doc represents this as `"#{number} - {subject}"` (line
   136) using a spaced hyphen. This is the correct convention for the doc body
   (no em dashes in our prose) and an acceptable rendering of the label, so no
   change is needed. Noting only so a future label-fidelity pass is aware the
   actual on-screen glyph is an em dash.

2. (Confirmed accurate, not a finding) The doc's My Tickets filter-chip list
   (line 104) enumerates only the working chips (all, open, in progress,
   resolved, closed) and separately flags the two dead chips - this is the
   honest framing and matches `STATUS_FILTERS` in code.
