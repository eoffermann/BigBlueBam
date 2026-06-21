# Remaining MCP Tool Gaps

Status: **Complete** | All 8 gaps implemented | Date: 2026-04-05

All 8 tools landed. MCP server reached 111 tools. Beacon tools (29) were subsequently added in the `beacon` branch, bringing the total to **140 tools**.

> Note: The original gap analysis listed 9 endpoints, but `GET /v1/me/unread`
> is already covered by `banter_get_unread` in `banter-tools.ts` (line 801).

---

## P1 -- User-facing (any MCP caller would want these)

### 1. `banter_get_preferences`

| Field | Value |
|---|---|
| Endpoint | `GET /v1/me/preferences` |
| Permission | user |
| Effort | trivial |
| File | `banter-tools.ts` (extend, add after existing `banter_get_unread`) |

No parameters. Returns the user's Banter notification/theme preferences.
Uses the existing `createBanterClient` -- single `banter.get()` call.

### 2. `banter_update_preferences`

| Field | Value |
|---|---|
| Endpoint | `PATCH /v1/me/preferences` |
| Permission | user |
| Effort | trivial |
| File | `banter-tools.ts` |

Accepts a flat object of preference keys (notification settings, theme, etc.).
Mirror the Zod schema from `preference.routes.ts` or accept `z.record(z.unknown())`
and let the server validate. Uses `banter.patch()`.

### 3. `banter_set_presence`

| Field | Value |
|---|---|
| Endpoint | `POST /v1/me/presence` |
| Permission | user |
| Effort | trivial |
| File | `banter-tools.ts` |

Parameters: `status` enum (`online | idle | dnd | offline`), optional `status_text`
and `status_emoji`. The route stores presence in Redis with a TTL and broadcasts
via WebSocket. Uses `banter.post()`.

Special consideration: Presence is ephemeral (Redis-backed with TTL). The MCP tool
should document that the status auto-expires, so callers understand it is not
persistent.

---

## P2 -- Admin tools for integration management

### 4. `test_slack_webhook`

| Field | Value |
|---|---|
| Endpoint | `POST /projects/:id/slack-integration/test` |
| Permission | admin (project admin or org admin) |
| Effort | trivial |
| File | `project-tools.ts` or new `integration-tools.ts` |

Parameters: `project_id` (uuid). No body needed -- the route sends a test message
to the configured Slack webhook URL and returns success/failure.

Uses the main `api.post()` client (Bam API, not Banter). Could go in
`project-tools.ts` alongside other project-scoped operations, but if we expect
more integration tools later, a dedicated `integration-tools.ts` is cleaner.

**Recommendation:** Add to `project-tools.ts` for now (only 1 tool, not worth a
new file). Move to a dedicated file when the integration surface grows.

### 5. `disconnect_github_integration`

| Field | Value |
|---|---|
| Endpoint | `DELETE /projects/:id/github-integration` |
| Permission | admin (project admin or org admin) |
| Effort | small |
| File | `project-tools.ts` (same location as #4) |

Parameters: `project_id` (uuid), `confirm` (boolean, for destructive action guard).

This is destructive -- it removes the GitHub integration and all webhook config.
Should follow the two-step confirmation pattern used by `banter_delete_channel`.
Uses `api.delete()`.

---

## P3 -- Helpdesk settings (niche, admin-only)

### 6. `helpdesk_get_public_settings`

| Field | Value |
|---|---|
| Endpoint | `GET /helpdesk/public-settings` |
| Permission | user (unauthenticated / public) |
| Effort | trivial |
| File | `helpdesk-tools.ts` |

No parameters. Returns public-safe fields: `require_email_verification`,
`categories`, `welcome_message`.

Special consideration: This endpoint is public (no auth required). The existing
`helpdeskRequest` helper does not forward auth tokens at all, so this works
out of the box.

### 7. `helpdesk_get_settings`

| Field | Value |
|---|---|
| Endpoint | `GET /helpdesk/settings` |
| Permission | admin |
| Effort | small |
| File | `helpdesk-tools.ts` |

No parameters. Returns the full helpdesk configuration including internal fields.

Special consideration: Requires `requireAdminAuth` on the server side. The
`helpdeskRequest` helper currently does **not** forward auth headers. This tool
will need the helper updated to pass the Bearer token (same pattern as
`createBanterClient`). This is the main implementation cost for the helpdesk
settings trio.

### 8. `helpdesk_update_settings`

| Field | Value |
|---|---|
| Endpoint | `PATCH /helpdesk/settings` |
| Permission | admin |
| Effort | small |
| File | `helpdesk-tools.ts` |

Accepts partial settings object. Same auth-forwarding prerequisite as #7.

Should accept known fields explicitly via Zod (categories, welcome_message,
default_project_id, etc.) rather than `z.record()` to give MCP callers good
schema documentation.

---

## Implementation approach

### Banter tools (P1: #1-3)

All three go into `banter-tools.ts` at the end, in a new comment section
`// User preference & presence tools (3)`. They follow the identical pattern
to every other tool in that file: call `banter.get/patch/post`, return
`ok()` or `err()`. No new infrastructure needed.

### Bam integration tools (P2: #4-5)

Add to the bottom of `project-tools.ts` in a new section
`// Integration tools (2)`. They use the standard `api` client. Tool #5
needs a confirmation guard (`confirm` boolean param).

### Helpdesk settings tools (P3: #6-8)

Add to `helpdesk-tools.ts`. **Before adding #7 and #8**, the
`helpdeskRequest` helper must be updated to forward the Bearer token from
`api` -- follow the same pattern as `createBanterClient` (extract `api.token`
and set the `Authorization` header). Tool #6 works without auth but should
still be added after the helper is fixed so all three land together.

### Registration

Each file's `register*Tools()` function already gets called from the central
`tools/index.ts`. No new registration wiring is needed -- just adding
`server.tool()` calls inside the existing functions.

### Estimated total effort

| Priority | Tools | Effort |
|---|---|---|
| P1 | 3 | ~30 min (copy-paste pattern) |
| P2 | 2 | ~30 min (confirmation guard + test) |
| P3 | 3 | ~45 min (auth-header fix + 3 tools) |
| **Total** | **8** | **~1.75 hours** |

The MCP server now has **140 tools** (64 Bam + 47 Banter + 29 Beacon).
