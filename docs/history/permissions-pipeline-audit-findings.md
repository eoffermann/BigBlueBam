# Permissions Pipeline Audit — Findings

Compiled from 10 parallel audits covering: auth flow, SuperUser bypass, API key scopes, viewer enforcement, guest role, Banter channel middleware, org permission settings, impersonation, multi-org resolution, and race conditions.

## Status Summary (as of granular-permissions branch, 2026-04-05)

- **Resolved:** 81 of 82
- **Partial / Documented:** 1 of 82
- **Open:** 0 of 82

---

## P0 — CRITICAL (Security vulnerabilities, exploitable today)

### Data leakage — any authenticated user can read any resource by UUID

| # | Status | Endpoint | File |
|---|--------|----------|------|
| P0-1 | RESOLVED | `GET /tasks/:id` — read any task | apps/api/src/routes/task.routes.ts:117 |
| P0-2 | RESOLVED | `GET /projects/:id` — read any project | apps/api/src/routes/project.routes.ts:45 |
| P0-3 | RESOLVED | `GET /projects/:id/members` — enumerate any project's members | apps/api/src/routes/project.routes.ts:138 |
| P0-4 | RESOLVED | `GET /v1/messages/:id` — read any message | apps/banter-api/src/routes/message.routes.ts:302 |
| P0-5 | RESOLVED | `GET /v1/messages/:id/thread` — read any channel's thread replies | apps/banter-api/src/routes/thread.routes.ts:19 |
| P0-6 | RESOLVED | `GET /v1/messages/:id/reactions` — read any message's reactions | apps/banter-api/src/routes/reaction.routes.ts:128 |
| P0-7 | RESOLVED | `GET /v1/channels/:id/pins` — read any channel's pins | apps/banter-api/src/routes/pin.routes.ts:19 |
| P0-8 | RESOLVED | `GET /v1/channels/:id/calls` — read any channel's call history | apps/banter-api/src/routes/call.routes.ts:209 |
| P0-9 | RESOLVED | `GET /v1/calls/:id/transcript` — read any call's transcript | apps/banter-api/src/routes/call.routes.ts:829 |
| P0-10 | RESOLVED | `GET /v1/search/channels` — returns private channels user isn't in | apps/banter-api/src/routes/search.routes.ts:153 |

**Fix:** Add membership check. For UUID-keyed resources, fetch parent's project_id or channel_id and verify membership before returning.

### Privilege escalation

| # | Status | Issue | File |
|---|--------|-------|------|
| P0-11 | RESOLVED | `POST /auth/api-keys` — viewers can create API keys; `read_write` key holders can create `admin` keys (escalation) | apps/api/src/routes/api-key.routes.ts:42 |
| P0-12 | RESOLVED | Guest accept: no email verification — attacker with stolen token can claim invitation as anyone | apps/api/src/routes/guest.routes.ts:159 |

**Fix P0-11:** Add `requireMinRole('member')` AND `requireScope('admin')` when requested scope is `admin`. Enforce `allowed_api_key_scopes` org permission on scope selection.
**Fix P0-12:** Require matching email on acceptance request body.

### Broken features (documented as done, silently fail)

| # | Status | Issue | File |
|---|--------|-------|------|
| P0-13 | RESOLVED | Impersonation is NOT implemented — no preHandler hook reads `X-Impersonate-User`, `isImpersonating` always false | apps/api/src/plugins/auth.ts:154-233 |
| P0-14 | RESOLVED | WebSocket `authenticateRequest` returns incomplete AuthUser (missing `org_memberships`, `active_org_id`) — runtime `undefined` on access | apps/api/src/plugins/websocket.ts:123 |

### Race conditions (TOCTOU, data corruption)

| # | Status | Issue | File |
|---|--------|-------|------|
| P0-15 | RESOLVED | Guest acceptance — two requests can both create accounts for same token; not wrapped in transaction | apps/api/src/routes/guest.routes.ts:161-258 |
| P0-16 | RESOLVED | `#general` channel auto-creation — two concurrent `GET /channels` create duplicates | apps/banter-api/src/routes/channel.routes.ts:56-100 |
| P0-17 | RESOLVED | Org owner demoted mid-request — in-flight owner-level request completes with stale role | apps/api/src/plugins/auth.ts + org.routes.ts |
| P0-18 | RESOLVED | Channel ownership deletion race — conditional UPDATE re-checks owner role at DB layer (channel.routes.ts DELETE handler) | apps/banter-api/src/middleware/channel-auth.ts:139-171 |

---

## P1 — HIGH (Exploitable with some conditions, or significant impact)

### Unauthorized writes / state manipulation

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-1 | RESOLVED | `POST /v1/messages/:id/reactions` — react in channels you're not in (no membership check after message fetch) | apps/banter-api/src/routes/reaction.routes.ts:19 |
| P1-2 | RESOLVED | `POST /v1/bookmarks` — bookmark any message across all channels | apps/banter-api/src/routes/bookmark.routes.ts:53 |
| P1-3 | RESOLVED | `POST /v1/channels/:id/mark-read` — update read cursor without membership | apps/banter-api/src/routes/channel.routes.ts:709 |
| P1-4 | RESOLVED | `POST /tasks/:id/comments` — guests/viewers can comment on any task | apps/api/src/routes/comment.routes.ts |
| P1-5 | RESOLVED | `POST /upload` — no role check, viewers can upload | apps/api/src/routes/upload.routes.ts:34 |
| P1-6 | RESOLVED | `POST /v1/channels/:id/leave` — no scope guard | apps/banter-api/src/routes/channel.routes.ts:518 |

### Missing SuperUser bypasses (SuperUsers get blocked)

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-7 | RESOLVED | `requireChannelMember` has no SuperUser bypass | apps/banter-api/src/middleware/channel-auth.ts:27 |
| P1-8 | RESOLVED | `POST /v1/channels` creation restriction check has no SuperUser bypass | apps/banter-api/src/routes/channel.routes.ts:178 |
| P1-9 | RESOLVED | Project PATCH/DELETE/member-add have inline membership checks without SuperUser bypass | apps/api/src/routes/project.routes.ts:65, 103, 147 |
| P1-10 | RESOLVED | `requireRole` in apps/api/src/plugins/auth.ts — missing `is_superuser` bypass | apps/api/src/plugins/auth.ts:348 |

### Permission settings unenforced

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-11 | RESOLVED | `members_can_delete_own_projects` never checked | apps/api/src/routes/project.routes.ts:103 |
| P1-12 | RESOLVED | `members_can_create_group_dms` never checked | apps/banter-api/src/routes/dm.routes.ts:120 |
| P1-13 | RESOLVED | `members_can_invite_members` ignored — still role-enforced only | apps/api/src/routes/org.routes.ts:125 |
| P1-14 | RESOLVED | `max_file_upload_mb` unenforced — hardcoded 25MB | apps/banter-api/src/routes/file.routes.ts:8 |
| P1-15 | RESOLVED | `members_can_create_private_channels` merged with public check — no separate enforcement | apps/banter-api/src/routes/channel.routes.ts:178 |
| P1-16 | RESOLVED | Type coercion bug: `!!perms[key]` treats string `"false"` as truthy | apps/api/src/services/org-permissions.ts:32 |

### Session/auth security

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-17 | RESOLVED | Silent X-Org-Id bypass — invalid org IDs fall through to default (fail-open) | apps/api/src/plugins/auth.ts:100 |
| P1-18 | RESOLVED | Zero-membership users fall back to NULL org_id — invalid auth context | apps/api/src/plugins/auth.ts:78 |
| P1-19 | RESOLVED | Deleted guests (`is_active=false`) keep access via existing session — no per-request recheck | apps/api/src/plugins/auth.ts:315 (JOIN on users + `row.user.is_active` check per request; documented at :284-288) |
| P1-20 | RESOLVED | `updateMemberRole()` only updates `users.role`, NOT `organization_memberships` → role drift | apps/api/src/services/org.service.ts:72 |
| P1-21 | RESOLVED | No partial unique index on `(user_id, is_default=true)` — data corruption possible | apps/api/src/db/schema/organization-memberships.ts |
| P1-22 | RESOLVED | X-Org-Id header not UUID-validated before DB query | apps/api/src/plugins/auth.ts:117 |

### Race conditions

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-23 | PARTIAL | API key scope cached at auth time — revocation doesn't take effect mid-request | apps/api/src/plugins/auth.ts:592-595 (documented tradeoff) |
| P1-24 | RESOLVED | User deactivation not re-checked per request | apps/api/src/plugins/auth.ts |
| P1-25 | RESOLVED | Concurrent role changes (last-write-wins) — no version column — fixed via migration 0017 (`version` column on `organization_memberships`) + service-layer optimistic-concurrency gate returning 409 `VERSION_CONFLICT` | apps/api/src/db/schema/organization-memberships.ts |
| P1-26 | RESOLVED | Channel member count desyncs (concurrent join/leave) | apps/banter-api/src/routes/channel.routes.ts:494-539 |
| P1-27 | RESOLVED | Argon2 verification on bad API keys = CPU DoS vector | apps/api/src/plugins/auth.ts:217 |
| P1-28 | RESOLVED | `last_used_at` update not awaited/error-handled | apps/api/src/plugins/auth.ts:224 |

### Token/invitation security

| # | Status | Issue | File |
|---|--------|-------|------|
| P1-29 | RESOLVED | Guest acceptance has no per-token rate limiting — brute force possible | apps/api/src/routes/guest.routes.ts:159 |
| P1-30 | RESOLVED | Guest invite response returns full token — log leakage risk | apps/api/src/routes/guest.routes.ts:139-144 (commit 71043bd gates raw-token echo on NODE_ENV !== 'production'; list responses never include token) |
| P1-31 | RESOLVED | Duplicate invitation prevention incomplete — silent scope escalation possible | apps/api/src/routes/guest.routes.ts:27 |

---

## P2 — MEDIUM (Design gaps, consistency issues, operational risk)

| # | Status | Issue | File |
|---|--------|-------|------|
| P2-1 | RESOLVED | Dual source of truth: `banter_settings` table vs `organizations.settings.permissions` JSONB | multiple |
| P2-2 | RESOLVED | No caching/invalidation on org settings reads — stale settings during updates | apps/api/src/services/org.service.ts |
| P2-3 | RESOLVED | UI now hides `admin` scope option for non-owners (settings.tsx Create API Key form + people/detail.tsx Access tab dialog) with helper text; backend hardened with explicit `ADMIN_SCOPE_OWNER_ONLY` 403 in both `/auth/api-keys` and `/org/members/:userId/api-keys` (admin scope requires owner or SuperUser) | apps/frontend/src/pages/settings.tsx, apps/frontend/src/pages/people/detail.tsx, apps/api/src/routes/api-key.routes.ts, apps/api/src/routes/org.routes.ts |
| P2-4 | RESOLVED | Audit confirmed all 9 toggles from the UI are enforced server-side: `members_can_create_projects` (project.routes.ts:24), `members_can_delete_own_projects` (project.routes.ts:149), `members_can_create_channels` + `members_can_create_private_channels` (channel.routes.ts:214,228), `members_can_create_group_dms` (dm.routes.ts:153), `members_can_invite_members` (org.routes.ts:716), `members_can_create_api_keys` + `allowed_api_key_scopes` (api-key.routes.ts:76,87), `max_file_upload_mb`. New unit coverage in apps/api/test/org-permissions.test.ts exercises member/admin/superuser bypass semantics per toggle. | multiple |
| P2-5 | RESOLVED | Session expiry check uses `>` vs `<=` inconsistently between HTTP and WS auth | apps/api/src/plugins/{auth,websocket}.ts |
| P2-6 | RESOLVED | `POST /auth/switch-org` doesn't rotate session (session fixation) | apps/api/src/routes/auth.routes.ts:151 |
| P2-7 | RESOLVED | `POST /auth/switch-org` doesn't signal frontend cache invalidation | apps/api/src/routes/auth.routes.ts:201 |
| P2-8 | RESOLVED | API keys aren't org-scoped — always use `users.org_id` in multi-org world | apps/api/src/plugins/auth.ts:191 |
| P2-9 | RESOLVED | DM creation doesn't validate target user is in same org / is_active | apps/banter-api/src/routes/dm.routes.ts:22 |
| P2-10 | RESOLVED | Timing attack: expiry check happens BEFORE argon2 verify — differential timing | apps/api/src/plugins/auth.ts:218 |
| P2-11 | RESOLVED | API key prefix = 8 chars → collision possible; iterates candidates (timing leak) | apps/api/src/plugins/auth.ts:213 |
| P2-12 | RESOLVED | No role `CHECK` constraint on `organization_memberships.role` | apps/api/src/db/schema/organization-memberships.ts:15 |
| P2-13 | RESOLVED | Archived channels still accessible — no `is_archived=false` in `requireChannelMember` | apps/banter-api/src/middleware/channel-auth.ts:43 |
| P2-14 | RESOLVED | Guest scope updates don't notify guest (silent removal) | apps/api/src/routes/guest.routes.ts:290 |
| P2-15 | RESOLVED | Re-audit found the original framing was inaccurate: `requireChannelAdmin`/`requireChannelOwner` are documented "must be called after `requireChannelMember`" and every route in banter-api composes them that way (channel/pin/message/call routes). `requireChannelMember` only lets org-level admin/owner through if they are already a channel member (SuperUsers are the sole bypass at line 76). The elevated moderation path at channel-auth.ts:141/179 is therefore only reachable for org admin/owner who are also channel members — by design, and consistent with SuperUser semantics. Intentional behaviour documented here + inline comments on the bypass lines. | apps/banter-api/src/middleware/channel-auth.ts:141,179 |
| P2-16 | RESOLVED | Migration script now detects both (a) `users.org_id IS NULL` and (b) users with zero `organization_memberships` rows, prints each affected email, and exits non-zero unless `--allow-orphans` (or `--dry-run`) is passed. Added `--dry-run` flag for safe preview. Live-DB dry-run against seed data found 1 orphan (`system-helpdesk@bigbluebam.internal`, a sentinel service user seeded by migration 0014) — re-running the migration will backfill it into its existing `users.org_id` (the Helpdesk System sentinel org). Users with NULL `org_id` remain skipped, but loudly. | scripts/migrate-org-memberships.js |
| P2-17 | RESOLVED | Scope schema mismatch: api-keys enum has `'write'`, defaults use `'read_write'` | apps/api/src/routes/api-key.routes.ts:48 uses canonical `['read','read_write','admin']`, matching `API_KEY_SCOPES` in packages/shared/src/constants/index.ts:13; no `'write'` scope value remains in API or shared code |
| P2-18 | RESOLVED | Guest cleanup not atomic (delete memberships then re-insert) — can leave guest orphaned | apps/api/src/routes/guest.routes.ts:326 |
| P2-19 | RESOLVED | No notification to target user when impersonation starts | apps/api/src/routes/platform.routes.ts:272 |
| P2-20 | RESOLVED | Impersonation has no time limit / expiration | apps/api/src/routes/platform.routes.ts |
| P2-21 | RESOLVED | Impersonated actions attributed only to target — no `impersonator_id` on activity_log | apps/api/src/db/schema/activity-log.ts |
| P2-22 | RESOLVED | Impersonation endpoint doesn't validate target `is_active` | apps/api/src/routes/platform.routes.ts:295 |
| P2-23 | RESOLVED | Fresh (cache-bypassing) re-read of banter_settings before channel INSERT; returns 403 SETTING_CHANGED on mid-request flip | apps/banter-api/src/routes/channel.routes.ts:178 |
| P2-24 | RESOLVED | Org deletion (SuperUser) doesn't invalidate active sessions for affected users | apps/api/src/routes/platform.routes.ts:182 |

---

## P3 — LOW (Nice-to-have, cleanup, consistency)

| # | Status | Issue | File |
|---|--------|-------|------|
| P3-1 | RESOLVED | Role hierarchy defined as array in apps/api and Record in banter-api — duplication | both auth.ts plugins |
| P3-2 | RESOLVED | No impersonation dashboard / active sessions view for SuperUsers | — |
| P3-3 | RESOLVED | Last-owner guard on /leave returns 400 LAST_OWNER_CANNOT_LEAVE when caller is sole owner and other members remain | apps/banter-api/src/routes/channel.routes.ts:518 |
| P3-4 | RESOLVED | No minimum-owner enforcement on channel role changes (channel can become ownerless) | apps/banter-api/src/routes/channel.routes.ts:650 |
| P3-5 | RESOLVED | Participants endpoint verifies org match + channel membership (org owner/admin/superuser bypass); 404 on miss | apps/banter-api/src/routes/call.routes.ts:602-625 |
| P3-6 | RESOLVED | Channel member list doesn't mark guests as `is_guest: true` for admins | apps/api/src/services/project.service.ts:239 |
| P3-7 | RESOLVED | Rate limit on `POST /auth/switch-org` — org ID enumeration possible | apps/api/src/routes/auth.routes.ts:151 |
| P3-8 | RESOLVED | No index on `(user_id, is_default)` for organization_memberships | apps/api/src/db/schema/organization-memberships.ts |
| P3-9 | RESOLVED | Clock skew tolerance not added to session expiry check | apps/api/src/plugins/auth.ts:184 |

---

## Summary

| Severity | Count |
|----------|-------|
| P0 CRITICAL | 18 |
| P1 HIGH | 31 |
| P2 MEDIUM | 24 |
| P3 LOW | 9 |
| **Total** | **82** |

### Most urgent categories
1. **GET endpoints leak data cross-project/cross-channel** (10 issues) — any authed user can read any task/message/project/call-transcript by UUID
2. **Impersonation feature doesn't work** — documented as done but server-side hook was never registered
3. **Guest invitation security** — no email verification, no rate limiting, TOCTOU race on acceptance
4. **Permission settings that are unenforced** — 5+ settings are decorative-only UI
5. **Session/role changes don't propagate mid-request** — stale auth state is pervasive
