# Docs-refresh findings (2026-06-17)

While re-authoring `docs/apps/*` from code (the help-doc-authoring agent pipeline,
all 16 apps), the writers verified every claim against the source and surfaced a
batch of **pre-existing code defects** and **stale catalog counts**. The docs
document these honestly as "Known limitation" notes; this file is the durable
backlog so they are not lost. None were introduced by the docs work.

## Stale MCP tool counts (CLAUDE.md + docs/reference/mcp-endpoint-mapping.md)

The MCP-parity expansion grew the per-app catalogs well beyond what CLAUDE.md's
architecture summary states. Actual `registerTool` counts in
`apps/mcp-server/src/tools/<app>-tools.ts` (+ shared tool files) as of this refresh:

| App | CLAUDE.md says | Actual | App | CLAUDE.md says | Actual |
|-----|----|----|-----|----|----|
| banter | 53 | 69 | bond | 13 | 69 (+dedupe) |
| beacon | 30 | 30+ | brief | 18 | 48 |
| bearing | 14 | 31 | board | 14 | 40 |
| bench | 14 | 32 | bolt | 13 | 26 |
| bill | 16 | 39 | book | 11 | 24 |
| blank | 11 | 20 | blueprint | 20 | 36 |
| blast | 14 | 28 | bureau | 16 | 36 |

`mcp-tools.md` now regenerates from code (correct). **CLAUDE.md's per-app counts
and `docs/reference/mcp-endpoint-mapping.md` should be reconciled to code.**

## Per-app pre-existing bugs (documented as limitations)

- **Banter**: in-app Search page calls `/search` (only `/v1/search/messages` exists) so it returns nothing; channel-settings add-member posts `{identifier}` vs expected `{user_ids:[]}`; compose attach reads a missing `id` field; create-channel permission enum mismatch (frontend `everyone|admins|org_owners` vs backend `members|admins`); some Preferences toggles do not round-trip; voice/video call endpoints retired (HTTP 410).
- **Bearing**: inline KR Update posts `/key-results/:id/set-value` but the route is `/key-results/:id/value`; dashboard stats + "Progress Over Time" call `GET /periods/:id/report` which has no route; Period **Activate** guard checks `draft` while new periods are stored `planning` (Activate may not appear); add-watcher always adds the caller regardless of input. (Progress *storage* fixed by migration 0192.)
- **Bench**: `bam.tasks` + `helpdesk.tickets` data sources return nothing (registry fix 4429f244 stops the 42703 but `tasks.org_id` is NULL - see task #33); scheduled-report delivery is a logging stub; dashboard date-range picker not passed into widget queries; widget rows do not drag-reorder; the Explorer runs one fixed query shape; the Saved Queries dialog stores an empty config; several Widget Template presets reference fields/sources absent from the registry.
- **Bill**: `bill_create_invoice_from_time` sends `date_from`/`date_to` but the route requires `time_entry_ids[]`; the in-app "Invoice from Time Entries" wizard is a non-functional stub; the `overdue` invoice status + `reimbursed` expense status have no write path (dead Dashboard tile / filter pills); no recurring/subscription billing exists despite prior marketing copy.
- **Blank**: the `page_break` palette item sends a `field_type` the `FIELD_TYPES` enum rejects; file-upload processing is a simulated state-advancer; confirmation/notify emails only log (no SMTP); `requires_login` / `allowed_domains` are stored but not enforced on the public submit path.
- **Blast**: segment-targeted sending is not honored by the sender; `blast_draft_email_content` + `blast_suggest_subject_lines` return hard-coded strings (not LLM output); email uses a single platform-wide SMTP relay, not per-org credentials.
- **Board**: the Share button and the two Export menu items have no `onClick` handler (dead UI); `board_update` does not accept a `locked` field.
- **Bolt**: `bolt_test` description says "test-fire with a simulated event payload" + returns `actions_executed`, but `/test` only evaluates conditions; the in-app Test Run may 400.
- **Bond**: in-app Edit Deal / Edit Contact / Edit Company + "Create Deal" from the contact menu are empty handlers (MCP/REST is the workaround); the Lost button omits the close reason.
- **Book**: Meet page reads `{start_at,end_at}` but `getPublicSlots` returns `{start,end}` (slots render invalid); Timeline reads `item.date` + sources `book|bam|bond` while the service returns `start_at` + `book|bam_task|bond_deal`, and sends `start_after`/`start_before` vs required `start_date`/`end_date`; booking-page editor calls `GET /booking-pages/:id` which has no route; on-booking Bond-contact creation POSTs with only `x-internal-secret`, which bond-api `requireAuth` does not accept (401, swallowed); Connections page is a disabled placeholder.
- **Blueprint**: the layout dropdown's **Tree** / **Grid** send algorithm names the backend rejects ("Unknown algorithm"); SVG/PNG export is rejected in-process; template content is never seeded; comments / collaborators / versions have full API + MCP support but no editor UI panel.
- **Bureau**: three tools are genuine stubs (`bureau_locate_user`, `bureau_get_presence`, `bureau_set_status`); room booking + org settings are API/MCP-only (no SPA screen).
- **Helpdesk**: dead status-filter chips on the ticket list; a stale `waiting_on_client` MCP enum value; a hardcoded 4h SLA badge; `hdag_` agent-key minting/rotation has no CLI or route.

## Capture / recipe notes

- `bolt-execution-detail` is not in the doc set (needs a real execution to open; the demo automations have no run history).
- Several apps lack `data-testid` on card grids; capture selectors rely on CSS classes (works, but brittle).
