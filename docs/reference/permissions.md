# Permissions & Authorization

This document defines the BigBlueBam permission model — the hierarchy of roles, what each role can do, and how permissions are enforced across the B3 project management app, Banter team messaging, and the Helpdesk portal.

> Request/response shapes for every enforcement surface described here live in the [API Reference](./api-reference.md) — in particular the **Auth**, **Org Member Management**, and **SuperUser User Management** sections.

---

## Role Hierarchy

BigBlueBam uses a layered permission model. Higher-scoped roles inherit authority over everything beneath them.

```
SuperUser                          ← Platform-wide. Above all organizations.
  └─ Organization                  ← A tenant boundary. Isolates all data.
       ├─ Owner                    ← Full org control. One per org (the creator).
       ├─ Admin                    ← Org management. Cannot delete org or demote owner.
       ├─ Member                   ← Standard user. Creates, edits, collaborates.
       ├─ Viewer                   ← Read-only. Cannot create or modify anything.
       └─ Guest                    ← Limited-scope. Invited to specific projects/channels.
            │
            ├─ Project (B3)
            │    ├─ Project Admin   ← Manages phases, sprints, members for this project.
            │    └─ Project Member  ← Creates/edits tasks, comments, time entries.
            │
            └─ Channel (Banter)
                 ├─ Channel Owner   ← Channel creator. Can archive, transfer ownership.
                 ├─ Channel Admin   ← Manages members, pins, can delete any message.
                 └─ Channel Member  ← Posts messages, reacts, manages own messages.
```

---

## 1. SuperUser

**Scope:** Platform-wide. Operates above the organization boundary.

A SuperUser is a platform administrator who manages the BigBlueBam deployment itself. In a self-hosted deployment, this is the person who runs `docker compose up`. In a managed/SaaS deployment, this is the platform operator.

### What SuperUsers can do

| Action | Description |
|--------|-------------|
| Create organizations | Provision new tenant organizations |
| Modify any organization | Change name, plan, settings, logo for any org |
| Delete organizations | Permanently remove an org and all its data |
| List all organizations | See every org on the platform |
| Impersonate any user | Act as any user for debugging/support (with audit trail) |
| View any org's data | Access projects, channels, tickets across all orgs |
| Manage platform settings | Configure global defaults, feature flags, SMTP, etc. |
| Create users in any org | Add users to any organization without an invite |
| Promote/demote org owners | Change who owns an organization |
| Access system health | View logs, metrics, queue status, storage usage |
| Manage API keys for any org | Create, revoke, or inspect any API key |

### How SuperUser is identified

SuperUser status is **not** an org-level role. It is a separate flag on the user record:

```
users.is_superuser: boolean (default: false)
```

A SuperUser must still belong to at least one organization (their "home org"), but their authority extends across all organizations. The `is_superuser` flag is checked in middleware **before** any org-scoped permission check, and bypasses org/project/channel role requirements.

### Creating the first SuperUser

The first SuperUser is created via the CLI during deployment:

```bash
docker compose exec api node dist/cli.js create-admin \
  --email admin@example.com \
  --password SecurePassword \
  --name "Platform Admin" \
  --org "Platform" \
  --superuser
```

Additional SuperUsers can only be created by an existing SuperUser through the platform admin panel or CLI. Org owners cannot promote themselves to SuperUser.

### SuperUser audit trail

All SuperUser actions that cross org boundaries are logged to a dedicated `superuser_audit_log` table:

| Field | Description |
|-------|-------------|
| `id` | UUID |
| `superuser_id` | The SuperUser performing the action |
| `action` | e.g., `org.created`, `org.deleted`, `user.impersonated` |
| `target_org_id` | The affected organization (nullable) |
| `target_user_id` | The affected user (nullable) |
| `details` | JSONB with action-specific metadata |
| `ip_address` | Request origin |
| `created_at` | Timestamp |

### SuperUser Cross-Organization Access

SuperUsers operate across tenant boundaries via a dedicated `/superuser/*` API namespace and a session-level "active org" context switch. The privilege escalation model is: the `users.is_superuser` flag unlocks (a) the `/superuser/*` routes, guarded by the `require-superuser` middleware, and (b) the ability to set `sessions.active_org_id`, which reroutes ordinary API calls into a target org.

**Three distinct operating modes:**

| Mode | How entered | Behavior |
|------|-------------|----------|
| **(a) Home org** | Default — `sessions.active_org_id` is null | SuperUser acts as themselves in their own org. Normal role bypasses apply, but no cross-org scoping. |
| **(b) Context-switched ("view-as-self")** | `POST /superuser/context/switch { org_id }` | All subsequent non-superuser API calls are scoped to the target org. The user identity stays the SuperUser's own (`actor_id = superuser.id`). Writes are tagged `via_superuser_context: true` in `activity_log.details`. |
| **(c) Impersonation ("act-as-target-user")** | `X-Impersonate-User` header (SuperUser-only) | The SuperUser acts as a specific target user — `request.user` becomes the target, `request.impersonator` holds the SuperUser. Writes attribute to the target user with `impersonator_id` set on activity_log. Time-limited (30min) with target notifications. |

Modes (b) and (c) are independent and composable: a SuperUser can context-switch into org X and then impersonate user Y within it.

**Impersonation flow (mode c) — two steps:**

1. `POST /v1/platform/impersonate` with the target `user_id`. The SuperUser middleware validates the caller, the target is checked for `is_active` and `!is_superuser` (SU→SU is forbidden), and a row is written to `impersonation_sessions` with a 30-minute `expires_at`. The target user receives a notification that they are being impersonated.
2. All subsequent requests include the `X-Impersonate-User: <target_user_id>` header. The auth plugin validates that an active (non-ended, non-expired) `impersonation_sessions` row exists for this `(superuser_id, target_user_id)` pair. If so, `request.user` becomes the target and `request.impersonator` holds the SuperUser's AuthUser.

`POST /v1/platform/stop-impersonation` ends all active impersonation sessions for the pair. `GET /v1/platform/impersonation-sessions` lists currently-active impersonations (SuperUser-only).

Responses from impersonated requests include `X-Impersonating: true` and `X-Impersonator: <superuser_id>` headers so clients can visually flag the session. Writes during impersonation attribute to the target user (`actor_id = target.id`) with `impersonator_id` set on `activity_log`. Self-impersonation is a no-op; malformed or missing header silently falls through to normal auth.

**Write attribution in switched context (mode b):** The activity_log row is written with `actor_id = superuser.id` (identity unchanged), plus `details.via_superuser_context = true`. This makes audit queries able to distinguish "org owner did X" from "SuperUser acting in this org did X" without conflating identities.

**Audit trail:** Every call to `/superuser/*` writes a row to `superuser_audit_log` with the `action` field (e.g. `org.list`, `org.view`, `overview.view`, `context.switch`, `context.clear`), the `superuser_id`, optional `target_org_id`/`target_user_id`, request `ip_address`, `user_agent`, and JSONB `details`. This is independent of the per-org `activity_log` — the superuser audit log is the authoritative trail for all cross-org actions.

**Non-SuperUser defense:** The `require-superuser` preHandler returns 401 if there is no authenticated session, and 403 if `request.user.is_superuser !== true`. `POST /superuser/context/switch` is itself guarded by this middleware, so non-SuperUsers cannot set `sessions.active_org_id` through the public API. If `active_org_id` were ever set on a non-SuperUser session (e.g. via a direct DB edit), the auth plugin's org-resolution step still validates membership in the target org before honoring it — a non-SuperUser with a planted `active_org_id` that doesn't match their memberships is fail-closed.

---

## 2. Organization Roles

**Scope:** All resources within a single organization.

Every user belongs to one or more organizations (via `organization_memberships`) and holds a role within each.

The `organization_memberships` table is the authoritative source for a user's org roles. Each row has `(user_id, org_id, role, is_default, joined_at, invited_by)` with:

- A unique index on `(user_id, org_id)` — a user cannot hold two rows for the same org.
- A partial unique index on `(user_id) WHERE is_default = true` — at most one default membership per user.
- A CHECK constraint pinning `role` to one of `owner`, `admin`, `member`, `viewer`, `guest`.

The active-org context for a request is resolved by `resolveOrgContext()` in `apps/api/src/plugins/auth.ts` with this precedence:

1. `X-Org-Id` request header (must be a valid UUID and the user must be a member of that org, otherwise 403).
2. The user's default membership (`is_default = true`).
3. The user's first membership by `joined_at` ascending.
4. Fallback to `users.org_id` if the user has no rows yet (pre-migration backfill path).

Malformed `X-Org-Id` headers are silently ignored; mismatched but well-formed ones fail closed with 403. Non-SuperUsers who somehow have `sessions.active_org_id` set that does not match a membership are also fail-closed — only SuperUsers can cross membership boundaries.

Org switching at runtime is done via `GET /auth/orgs` (list available orgs) and `POST /auth/switch-org` (change `sessions.active_org_id`). Session IDs are rotated on org switch to reduce blast radius of a stolen cookie across contexts. `sessions.active_org_id` is honoured for **all** users (not only SuperUsers); for non-SuperUsers the auth plugin validates membership in the target org on every request and fails closed with 403 otherwise. SuperUsers bypass the membership check and may view any org.

### Rank rule for admin actions on members

Every administrative action on another member (invite, remove, role change, reset password, force password change, sign-out-everywhere, profile edit, disable/enable, API key create/revoke, add/remove from project) enforces **strictly below** — `target_rank < caller_rank`, **not** `≤`. A peer admin cannot act on another admin; only an owner or SuperUser can. Same at the owner tier: one owner cannot modify another owner; that requires SuperUser. The motivation is containment — a single compromised admin credential cannot be used to lock every other admin out of the org. The rule is implemented in `apps/api/src/services/org.service.ts` and raises `InsufficientRankError` → HTTP 403. SuperUsers bypass the check entirely.

### Self-service and forced password change

`POST /auth/change-password` lets a logged-in user rotate their own password after presenting the current one. On success, all **other** sessions for that user are destroyed; the caller's current session is kept. Admins and SuperUsers can call `POST /org/members/:userId/force-password-change` (or equivalent SU action) to set `users.force_password_change = true`. On the user's next authenticated request, the auth plugin redirects them to `/b3/password-change` and refuses to serve other routes until the flag clears. The flag clears automatically after a successful `POST /auth/change-password`.

### Email change with re-verification

Admins cannot edit another user's email; SuperUsers can via `PATCH /superuser/users/:id/email`. Calling this endpoint stages the new address in `users.pending_email`, generates a `email_verification_token`, stamps `email_verification_sent_at`, and sends a verification link to the **new** address. The old address receives a notice email so a compromised SuperUser cannot silently steal an account. The change is finalised only when the user redeems the token via `POST /auth/verify-email/:token` (public, unauthenticated). Redemption promotes `pending_email → email`, sets `email_verified = true`, clears the token, and **revokes every session for that user**, forcing login with the new address. Tokens expire after 7 days; redeeming after expiry returns `410 TOKEN_EXPIRED`. This scaffold mirrors the original `helpdesk_users` verification flow, now extended to `users` (migration `0012_user_email_verification.sql`).

### Session metadata and login history

`sessions` rows now carry `created_at`, `last_used_at`, `ip_address`, and `user_agent` (migration `0013_access_activity_session_meta.sql`). The auth plugin populates these on session creation and updates `last_used_at` on subsequent requests, throttled to at most once per 60 seconds per session. These feed the Sessions tab on the SuperUser user detail page.

`login_history` records every `POST /auth/login` attempt (success or failure). Rows capture `user_id` (nullable — failed logins against non-existent emails still write a row with `user_id = NULL`), `email` (denormalized, so audit survives user deletion), `ip_address`, `user_agent`, `success`, and `failure_reason`. Exposed at `GET /superuser/users/:id/login-history` (SuperUser-only). The table has no TTL yet — a future trimmer job will prune old rows.

### Cross-org active toggle

`PATCH /superuser/users/:id/active` lets a SuperUser disable or re-enable any user globally. Disabling sets `users.is_active = false`, stamps `disabled_at = now()` and `disabled_by = <superuser_id>`, and deletes every session for the target. Re-enabling clears all three columns. The per-org equivalent is `PATCH /org/members/:userId/active`, also audit-stamped on the user row. Soft-disable is allowed even if the target is the last active owner of an org — the org surfaces a persistent no-active-owner banner instead of blocking the action.

### Role: Owner

The organization creator. Exactly one user holds this role per org.

| Action | Allowed |
|--------|---------|
| Update org name, logo, plan, settings | Yes |
| Delete / archive the organization | Yes |
| Invite members | Yes |
| Remove any member (including admins) | Yes |
| Promote member → admin | Yes |
| Demote admin → member | Yes |
| Transfer ownership to another user | Yes |
| All Admin, Member, Viewer abilities | Yes |

### Role: Admin

Trusted managers who configure the org but don't own it.

| Action | Allowed |
|--------|---------|
| Update org settings | Yes |
| Invite members | Yes |
| Remove members (not owner) | Yes |
| Promote member → admin | Yes (cannot promote to owner) |
| Demote admin → member | Yes (cannot demote owner) |
| Delete the organization | **No** |
| Transfer ownership | **No** |
| All Member, Viewer abilities | Yes |

### Role: Member

Standard team member. The default role for invited users.

| Action | Allowed |
|--------|---------|
| View org details and member list | Yes |
| Create projects | Yes |
| Join public Banter channels | Yes |
| Start DMs | Yes |
| Use MCP tools (scoped to their projects) | Yes |
| Invite members | **No** |
| Change org settings | **No** |
| Remove members | **No** |

### Role: Viewer

Read-only access. For stakeholders who need visibility but shouldn't modify anything.

| Action | Allowed |
|--------|---------|
| View org details, members, projects | Yes |
| View tasks, comments, activity | Yes |
| View Banter channels they're a member of | Yes |
| Create tasks, comments, or messages | **No** |
| Modify any resource | **No** |
| Join channels or projects on their own | **No** |

### Role: Guest

Scoped external collaborator. Invited to specific projects or channels, with no org-wide visibility.

| Action | Allowed |
|--------|---------|
| View/edit in invited projects only | Yes |
| View/post in invited channels only | Yes |
| See org member list | **No** (only sees members of shared projects/channels) |
| Browse channels or projects | **No** |
| Create projects or channels | **No** |

---

## 3. Project Roles (B3)

**Scope:** A single project within an organization.

Assigned via `project_memberships`. A user can have different roles in different projects.

### Role: Project Admin

| Action | Allowed |
|--------|---------|
| Create/edit/delete/reorder phases | Yes |
| Create/start/complete sprints | Yes |
| Add/remove project members | Yes |
| Change project member roles | Yes |
| Update project settings | Yes |
| Archive/delete project | Yes |
| Create/edit/delete tasks | Yes |
| All Project Member abilities | Yes |

### Role: Project Member

| Action | Allowed |
|--------|---------|
| Create tasks | Yes |
| Edit tasks (any task in the project) | Yes |
| Move tasks between phases | Yes |
| Comment on tasks | Yes |
| Log time entries | Yes |
| Upload attachments | Yes |
| React to comments | Yes |
| Create/edit labels, epics, custom fields | **Proposed: No** (currently unguarded) |
| Manage phases or sprints | **No** |
| Add/remove project members | **No** |

---

## 4. Channel Roles (Banter)

**Scope:** A single Banter channel.

Assigned via `banter_channel_memberships`. Org-level Admin/Owner can override channel permissions.

### Role: Channel Owner

The channel creator. One per channel.

| Action | Allowed |
|--------|---------|
| Archive/delete channel | Yes |
| Transfer ownership | Yes |
| Change any member's role | Yes |
| All Channel Admin abilities | Yes |

### Role: Channel Admin

| Action | Allowed |
|--------|---------|
| Edit channel name, topic, description | Yes |
| Add/remove members | Yes |
| Pin/unpin messages | Yes |
| Delete any message | Yes |
| Change member → admin (not to owner) | Yes |
| All Channel Member abilities | Yes |

### Role: Channel Member

| Action | Allowed |
|--------|---------|
| View channel messages | Yes |
| Post messages | Yes |
| Reply in threads | Yes |
| React to messages | Yes |
| Upload files | Yes |
| Edit own messages | Yes |
| Delete own messages | Yes |
| Delete others' messages | **No** |
| Pin messages | **No** |
| Add/remove members | **No** |

---

## 5. API Key Scopes

API keys are issued per-user and carry a scope that restricts what operations the key can perform, independent of the user's role.

| Scope | Read | Create/Update | Delete | Admin |
|-------|------|---------------|--------|-------|
| **read** | Yes | No | No | No |
| **read_write** | Yes | Yes | Yes | No |
| **admin** | Yes | Yes | Yes | Yes |

API keys can also be restricted to specific projects via the `project_ids` array. When set, the key can only access resources within those projects.

Keys are prefixed with `bbam_`, stored as Argon2id hashes, and looked up via a short random prefix column (`key_prefix`) to bound the number of Argon2 verifications per request. Timing-attack mitigation: `argon2.verify` always runs before the `expires_at` check so that expired-but-valid-hash keys and invalid-hash keys take the same wall-clock time. If more than 3 candidates share a prefix, only the first is verified and a warning is logged (DoS mitigation, P2-11).

`requireScope(minScope)` in `apps/api/src/plugins/auth.ts` is the enforcement point. It is a no-op for session auth (`api_key_scope === null`) and for SuperUsers.

---

## 6. Org-Level Override Rules

Organization-level roles provide fallback authority over project and channel resources:

| Org Role | Can override project permissions? | Can override channel permissions? |
|----------|----------------------------------|----------------------------------|
| **SuperUser** | Yes — full access to everything | Yes — full access to everything |
| **Owner** | Yes — treated as project admin everywhere | Yes — can edit/archive any channel, delete any message |
| **Admin** | Yes — treated as project admin everywhere | Yes — can edit/archive any channel, delete any message |
| **Member** | No — must be explicitly added to projects | No — must be explicitly added to channels |
| **Viewer** | No | No |
| **Guest** | No | No |

---

## 7. Permission Check Order

Every API request follows this evaluation sequence:

```
1. Is the user authenticated? (session cookie or API key)
   └─ No → 401 Unauthorized

2. Is the user a SuperUser?
   └─ Yes → Granted (log to superuser_audit_log)

3. Does the API key scope allow this operation?
   └─ No → 403 Forbidden ("API key scope insufficient")

4. Is the user active? (is_active = true)
   └─ No → 403 Forbidden ("Account deactivated")

5. Does the org-level role allow this operation?
   └─ If org admin/owner and the action is within their org → Granted
   └─ If the action requires org admin/owner and user is member → 403

6. Does the resource-level role allow this operation?
   └─ Check project_memberships or banter_channel_memberships
   └─ If role insufficient → 403 Forbidden

7. Does ownership/authorship apply?
   └─ e.g., "can delete own message" even without channel admin role
```

---

## 8. Enforcement Points

| Layer | Mechanism | File(s) | Status |
|-------|-----------|---------|--------|
| **Authentication** | `requireAuth` Fastify preHandler | `apps/api/src/plugins/auth.ts`, `apps/banter-api/src/plugins/auth.ts` | Implemented |
| **SuperUser check** | `requireSuperUser` middleware | `apps/api/src/plugins/auth.ts`, `apps/banter-api/src/plugins/auth.ts` | Implemented |
| **Minimum role** | `requireMinRole(role)` middleware (viewer < member < admin < owner) | `apps/api/src/plugins/auth.ts`, `apps/banter-api/src/plugins/auth.ts` | Implemented |
| **API key scope** | `requireScope(scope)` middleware (read < read_write < admin) | `apps/api/src/plugins/auth.ts`, `apps/banter-api/src/plugins/auth.ts` | Implemented |
| **Org role** | `requireOrgRole(...roles)` middleware | `apps/api/src/middleware/authorize.ts` | Implemented (SuperUser bypass added) |
| **Project role** | `requireProjectRole(...roles)` middleware | `apps/api/src/middleware/authorize.ts` | Implemented (SuperUser bypass added) |
| **Channel role** | Inline checks in route handlers | `apps/banter-api/src/routes/channel.routes.ts` | Implemented |
| **Authorship** | Inline `author_id === user.id` checks | Various route files | Implemented |
| **MCP scope errors** | `formatScopeError()` utility | `apps/mcp-server/src/middleware/scope-check.ts` | Implemented |
| **Platform admin** | SuperUser-only org CRUD routes | `apps/api/src/routes/platform.routes.ts` | Implemented |
| **SuperUser audit** | `superuser_audit_log` table | `apps/api/src/db/schema/superuser-audit-log.ts` | Implemented |
| **SuperUser console** | Cross-org routes (list/detail/overview, context switch/clear) | `apps/api/src/routes/superuser.routes.ts` | Implemented |
| **Impersonation** | `impersonation_sessions` table + `X-Impersonate-User` header | `apps/api/src/db/schema/impersonation-sessions.ts`, `apps/api/src/plugins/auth.ts`, `apps/api/src/routes/platform.routes.ts` | Implemented |
| **Org permissions** | Org-settings permission toggles + cache | `apps/api/src/services/org-permissions.ts` | Implemented |
| **Banter ↔ B3 bridge** | Maps `banter_settings` flat columns onto `organizations.settings.permissions` with cache | `apps/banter-api/src/services/org-permissions-bridge.ts`, `apps/banter-api/src/services/settings-cache.ts` | Implemented |
| **Session invalidation on org delete** | Cascade delete of all sessions for users in deleted org | `apps/api/src/routes/platform.routes.ts` | Implemented |
| **Org member admin** | `/org/members/:userId/*` — detail, profile, active toggle, transfer ownership, reset/force password, sign-out-everywhere, API keys, activity, project assignments. All guarded by `requireOrgRole('admin','owner') + requireScope('admin')` and the `target < caller` rank rule. | `apps/api/src/routes/org.routes.ts`, `apps/api/src/services/org.service.ts` | Implemented |
| **SuperUser user admin** | `/superuser/users/*` — list, detail, memberships CRUD, set-default-org, sessions list/revoke/revoke-all, email change (w/ verification), projects, active toggle, login-history. | `apps/api/src/routes/superuser.routes.ts`, `apps/api/src/services/superuser-users.service.ts` | Implemented |
| **Forced password change** | `users.force_password_change` flag checked in auth plugin; blocks all routes except `/auth/change-password` and `/auth/me` until cleared. | `apps/api/src/plugins/auth.ts`, `apps/api/src/routes/auth.routes.ts` | Implemented |
| **Self password change** | `POST /auth/change-password` — re-verifies current password, rotates, revokes all other sessions. | `apps/api/src/routes/auth.routes.ts`, `apps/api/src/services/org.service.ts` (`changeOwnPassword`) | Implemented |
| **Email re-verification** | `PATCH /superuser/users/:id/email` → token → `POST /auth/verify-email/:token` (public). TTL 7 days; all sessions revoked on redeem. | `apps/api/src/routes/superuser.routes.ts`, `apps/api/src/routes/email-verify.routes.ts` | Implemented |
| **Login history** | Every `/auth/login` writes to `login_history`. Read via `GET /superuser/users/:id/login-history`. | `apps/api/src/routes/auth.routes.ts`, `apps/api/src/db/schema/login-history.ts` | Implemented |
| **Session metadata tracking** | `sessions.created_at / last_used_at / ip_address / user_agent` populated by auth plugin; `last_used_at` throttled to 60s. | `apps/api/src/plugins/auth.ts` | Implemented |

### Org-level permission settings

Every toggle surfaced in the **Settings → Permissions** UI is enforced server-side. Org admins/owners and SuperUsers bypass these toggles; members (and lower roles) are subject to them. Defaults live in `apps/api/src/services/org-permissions.ts`.

| Toggle | Default | Enforcement site | Notes |
|--------|---------|------------------|-------|
| `members_can_create_projects` | `true` | `POST /projects` — `apps/api/src/routes/project.routes.ts` | 403 if a non-privileged user creates a project while toggle=false |
| `members_can_delete_own_projects` | `false` | `DELETE /projects/:id` — `apps/api/src/routes/project.routes.ts` | Combined with `created_by === user.id` check — members can only delete their own, and only if the toggle is on |
| `members_can_create_channels` | `true` | `POST /banter/channels` — `apps/banter-api/src/routes/channel.routes.ts` | Applies to public channels; private channels also require the next toggle |
| `members_can_create_private_channels` | `true` | `POST /banter/channels` — `apps/banter-api/src/routes/channel.routes.ts` | Checked separately when `type === 'private'` |
| `members_can_create_group_dms` | `true` | `POST /banter/dms` — `apps/banter-api/src/routes/dm.routes.ts` | Only for group DMs (3+ participants); 1:1 DMs unaffected |
| `members_can_invite_members` | `false` | `POST /org/members/invite` — `apps/api/src/routes/org.routes.ts` | Admins/owners can always invite; members need this flag on |
| `members_can_create_api_keys` | `true` | `POST /auth/api-keys` — `apps/api/src/routes/api-key.routes.ts` | Gates API key creation entirely for members |
| `allowed_api_key_scopes` | `['read','read_write']` | `POST /auth/api-keys` — `apps/api/src/routes/api-key.routes.ts` | Restricts which scopes members may request. Admin scope is ALSO gated by an owner-only check (see below). |
| `max_file_upload_mb` | `25` | File upload handlers in Banter + B3 | Enforced at upload time |

**Additional admin-scope API key rule (P2-3):** regardless of `allowed_api_key_scopes`, requests for `scope='admin'` are rejected with `403 ADMIN_SCOPE_OWNER_ONLY` unless the caller is an **org owner or SuperUser**. Org admins cannot grant admin-scope keys — not even on-behalf-of another member via `/org/members/:userId/api-keys`. The frontend hides the "Admin" option for non-owners in both the settings Create API Key form and the people detail Access tab dialog.

---

## 9. Known Gaps

| # | Gap | Severity | Status | Description |
|---|-----|----------|--------|-------------|
| 1 | ~~No SuperUser role~~ | ~~High~~ | **Resolved** | `is_superuser` column, `requireSuperUser` middleware, CLI `--superuser` flag, platform admin routes, audit log table. |
| 2 | ~~API key scopes not enforced~~ | ~~High~~ | **Resolved** | `requireScope(scope)` middleware enforced on all write/admin endpoints in B3 and Banter APIs. MCP server surfaces user-friendly scope errors. |
| 3 | ~~Viewer role not enforced~~ | ~~Medium~~ | **Resolved** | `requireMinRole('member')` added to all POST/PATCH/DELETE endpoints. Viewers get read-only access. |
| 4 | ~~Guest role not implemented~~ | ~~Medium~~ | **Resolved** | `guest_invitations` table, invitation API, auto-provisioning of guest users with scoped project/channel access. |
| 5 | ~~Many B3 endpoints unguarded~~ | ~~Medium~~ | **Resolved** | All 9 remaining route files (labels, epics, custom-fields, webhooks, views, templates, attachments, time-entries, reactions) now guarded with viewer/scope/project-role checks. |
| 6 | ~~Single org_id on users~~ | ~~Medium~~ | **Resolved** | `organization_memberships` is the authoritative source of roles, with unique indexes, partial default-membership index, and role CHECK constraint. Auth resolves active org from `X-Org-Id` header → default membership → first-joined, falling back to `users.org_id` only for un-backfilled users. `GET /auth/orgs` and `POST /auth/switch-org` expose runtime switching; session IDs rotate on switch. |
| 7 | **No resource-level isolation in B3** | Medium | Partial | Project-scoped URLs (`/projects/:id/*`) now check `requireProjectRole`. Non-scoped endpoints (`/labels/:id`, `/epics/:id`, etc.) still rely on scope/role only — cross-project access possible if UUID known. |
| 8 | ~~Banter channel role checks are inline~~ | ~~Low~~ | **Resolved** | Extracted into `requireChannelMember`/`requireChannelAdmin`/`requireChannelOwner` middleware. Applied to channel, pin, message routes. |
| 9 | ~~No impersonation support~~ | ~~Low~~ | **Resolved** | `X-Impersonate-User` header support in both auth plugins. SuperUser-only. All actions audit-logged. |
| 10 | ~~No permission change audit~~ | ~~Low~~ | **Resolved** | SuperUser actions logged to `superuser_audit_log`. Banter admin actions logged to `banter_audit_log`. |
| 11 | **UI permission mismatch (P2-3)** | Low | Open | Frontend surfaces actions (buttons, menu items) that the API rejects for viewers/guests. Server-side enforcement is correct; UI should hide/disable actions based on the caller's role to avoid 403s after click. |
| 12 | **UI permission mismatch (P2-4)** | Low | Open | Banter channel admin/owner-only controls (e.g. archive, rename, member management) are visible to regular channel members. API blocks the mutation, but the UI should gate these controls on `channelMembership.role` / org role. |
| 13 | **Org admin/owner moderate channels without membership (P2-15)** | Info | **By Design** | Org-level owners and admins can edit/archive channels, delete messages, and manage members on any channel in their org even if they are not a member of that channel. This is the documented override rule in Section 6 — org admins have override power over all channel-level roles. The server treats org role as a fallback authority throughout Banter moderation routes. |

---

## 10. Implementation Status

### Phase 1: SuperUser + API Key Enforcement + Viewer — COMPLETE
- [x] `is_superuser` column on `users` table
- [x] `requireSuperUser` middleware in both B3 and Banter APIs
- [x] `requireMinRole(role)` middleware with hierarchy: owner > admin > member > viewer
- [x] `requireScope(scope)` middleware with hierarchy: admin > read_write > read
- [x] SuperUsers bypass all role and scope checks
- [x] Session auth bypasses scope checks (scope only applies to API keys)
- [x] SuperUser CLI flag (`--superuser`) on `create-admin` command
- [x] `superuser_audit_log` table with IP tracking
- [x] Platform admin routes: CRUD orgs, list org members, toggle SuperUser status, audit log
- [x] All POST/PATCH/DELETE endpoints guarded with `requireMinRole('member')` — viewers are read-only
- [x] All write endpoints guarded with `requireScope('read_write')` — read-only API keys blocked
- [x] All admin endpoints guarded with `requireScope('admin')` — non-admin API keys blocked
- [x] MCP server surfaces user-friendly scope error messages for 403 responses
- [x] `requireOrgRole` and `requireProjectRole` bypass for SuperUsers

### Phase 2: Guest Role — COMPLETE
- [x] `guest_invitations` table with token-based accept flow
- [x] Guest invitation API: invite, list, revoke, accept, update scope, remove guest
- [x] Guests auto-provisioned with `role='guest'` on acceptance
- [x] Auto-added to specified projects (as member) and channels on accept
- [x] Guest visibility restrictions on `GET /org/members` (only see members sharing a project)
- [x] Invitation expiry support
- [ ] Guest-specific frontend UI restrictions (deferred — UI stubs needed)

### Phase 3: Resource Isolation — COMPLETE
- [x] All 9 remaining B3 route files guarded with project-role + viewer + scope checks
- [x] Centralized Banter channel permission middleware (`requireChannelMember`, `requireChannelAdmin`, `requireChannelOwner`)
- [x] `organization_memberships` table with unique constraint + migration script
- [x] Auth plugins read active org context from `X-Org-Id` header or default membership
- [x] `GET /auth/orgs` and `POST /auth/switch-org` endpoints for org switching
- [ ] Frontend org switcher UI (deferred — backend ready)

### Phase 4: Fine-Grained Permissions — MOSTLY COMPLETE
- [x] Org permission settings service (`getOrgPermissions`, `checkOrgPermission`)
- [x] All 9 permission toggles enforced: `members_can_create_projects`, `members_can_delete_own_projects`, `members_can_create_channels`, `members_can_create_private_channels`, `members_can_create_group_dms`, `members_can_invite_members`, `members_can_create_api_keys`, `max_file_upload_mb`, `allowed_api_key_scopes`
- [x] Type coercion bug fixed (string "false" no longer treated as truthy)
- [x] 30-second in-memory cache with invalidation on updates
- [x] SuperUser impersonation with X-Impersonate-User header, time-limited sessions (30min), active sessions dashboard, target notifications, impersonator_id on activity_log
- [x] Guest role security: rate-limited token acceptance, atomic TOCTOU-free claim, email verification, duplicate prevention, scope update notifications
- [x] DM target validation (same-org + is_active)
- [x] Session rotation on org switch
- [x] Archived channels hidden from members
- [x] Last-owner protection on channel ownership demotion
- [x] DoS protection on API key verification
- [x] Transactional role updates with row-level locks
- [ ] Admin UI for editing permission toggles (backend ready; some UI in place)
- [ ] Per-project permission overrides
- [ ] Field-level permissions for sensitive data

### Phase 5: Security Hardening — COMPLETE (from 82-finding audit)
- [x] 10 GET endpoints fixed: cross-resource UUID enumeration data leakage closed (tasks, projects, project members, messages, threads, reactions, pins, call history, call transcripts, private channel search)
- [x] API key privilege escalation blocked (scope hierarchy check + org policy enforcement)
- [x] All race conditions addressed (guest accept TOCTOU, #general auto-create, org owner demotion, channel ownership, member count desync)
- [x] SuperUser bypasses added to all middlewares and inline checks
- [x] Fail-closed X-Org-Id validation (UUID regex + membership enforcement)
- [x] Clock skew tolerance on session expiry
- [x] WebSocket auth unified with buildAuthUser()
- [x] CHECK constraints on all role columns
- [x] Partial unique index on (user_id, is_default)
- [x] Timing-safe API key verification (argon2.verify before expiry check)
- [x] Session invalidation on org delete (cascade-delete sessions for org members)
- [x] Banter ↔ B3 permission bridge + 30s in-memory cache
- [ ] Permission templates / presets
