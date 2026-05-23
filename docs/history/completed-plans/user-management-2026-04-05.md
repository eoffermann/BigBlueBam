# User Management UI — Design Proposal

Status: COMPLETE (Phases 1–5 shipped 2026-04-05)
Date: 2026-04-05

> **Implementation status:** all five phases in §9 have landed on `main` via
> the `granular-permissions` branch. The People UI (`/b3/people`,
> `/b3/superuser/people`), the org-scoped member admin endpoints, the
> SuperUser user-management endpoints, the `force_password_change` gate, the
> email-change re-verification flow, and `login_history` are all in
> production. The plan below is preserved as a design record — read §9 for
> per-phase completion notes.

## 1. Why we need this

Today, user administration is scattered across Settings tabs and isn't discoverable:
- **Admins** can only invite members, change their org role, remove them, and (new) reset passwords — all buried in `/b3/settings` under the Members tab.
- **SuperUsers** can browse orgs via `/b3/superuser` but can't *act on individual users* from the UI (no project assignments, no impersonation UI, no session/API-key management). Everything SU-level beyond org overview lives in CLI or raw API calls.
- Project memberships are edited per-project from the project's own settings, making cross-project assignment tedious.

The goal is a **first-class people/user management surface** that:
- Lives at a top-level URL (not in Settings).
- Covers the full identity lifecycle (invite → edit → offboard) without shelling to SQL or CLI.
- Adapts to the caller's role so an admin sees org-scoped actions, while a SuperUser sees cross-org actions in the same UI.
- Exposes existing infrastructure (platform routes, impersonation, activity log) that is currently only reachable by API.

## 2. Placement & navigation

Add a top-level navigation entry in the sidebar + command palette:

| Item | URL | Audience | Scope |
|---|---|---|---|
| **People** | `/b3/people` | Admins + Owners + SuperUsers | Users in current org context |
| **People (global)** | `/b3/superuser/people` | SuperUsers only | All users across all orgs |

Non-admins (member/viewer/guest) still see their own profile under `/b3/settings` — they never see the **People** nav entry. The sidebar conditionally renders the link based on `user.role ∈ {owner, admin}` or `user.is_superuser === true`.

**Why a separate SuperUser route?** Mostly because cross-org bulk actions (e.g. "remove this user from every org they belong to") don't fit the org-scoped mental model. Keeping them on a distinct URL also makes permission gating at the route-guard layer explicit.

## 3. Feature inventory

### 3a. Identity (profile fields editable by admin)

| Field | Admin | SuperUser | Notes |
|---|---|---|---|
| `display_name` | ✓ | ✓ | |
| `avatar_url` / upload | ✓ | ✓ | Reuses existing S3 upload path |
| `timezone` | ✓ | ✓ | IANA zone picker |
| `is_active` (disable) | ✓ | ✓ | Soft-disable — login blocked, sessions invalidated, data kept. Allowed on the last owner of an org, but the org will show a persistent "no active owner" banner until someone is promoted. |
| `email` | — | ✓ | SU only. Reuses the existing `helpdesk_users` email-verification scaffold, extended to BBB users: changing the email sends a verification token to the new address; the change is committed (and `email_verified` flipped) only after the token is redeemed. Old address is notified that the change was initiated. |
| `is_superuser` | — | ✓ | Grant/revoke (exists via `/platform/users/:id/superuser`) |
| `notification_prefs` | — | — | User's own domain; admins don't touch |

### 3b. Org memberships

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| List orgs user belongs to | org-scoped only | all orgs | Current UI shows only current org |
| Change user's role in org | ✓ (target < caller) | ✓ | Already exists |
| Set user's default org | — | ✓ | Changes `is_default` flag on memberships |
| Add user to another org | — | ✓ | Insert `organization_memberships` row |
| Remove user from org | ✓ (target < caller) | ✓ | Already exists (drops membership, not user) |
| Transfer org ownership | owner only, or SU | ✓ | **Single-step.** "Transfer ownership" promotes target to owner AND demotes the initiating owner to admin, atomically. If you want a co-owner instead, use the ordinary role change (admin → owner) — that adds an owner without demoting anyone. |

### 3c. Project memberships

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| List user's project memberships | org-scoped | defaults to active org; scope switcher to "all orgs" | Join projects + memberships |
| Add user to project (w/ role) | ✓ (target < caller) | ✓ | lead/member/viewer per project |
| Remove user from project | ✓ (target < caller) | ✓ | |
| Change role in project | ✓ (target < caller) | ✓ | |
| Bulk assign user to many projects | ✓ (target < caller) | ✓ | Checkbox multiselect. SU can span orgs by flipping the scope switcher. |

### 3d. Sessions & auth

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| List user's active sessions | — | ✓ | ip, user agent, last activity, current flag |
| Revoke single session | — | ✓ | `DELETE FROM sessions WHERE id = ?` |
| Sign out everywhere | ✓ (target < caller) | ✓ | Delete all of target's sessions. Admin-available because it's already implicit in password reset. |
| Force password change on next login | ✓ (target < caller) | ✓ | New `users.force_password_change` flag |
| Reset password (manual / generated) | ✓ (target < caller) | ✓ | Just shipped — **rule changed from ≤ to < as part of this plan**, see §6 note. |
| Require 2FA on next login | later | later | 2FA not shipped yet — deferred |

### 3e. API keys

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| List user's API keys | ✓ | ✓ | name, prefix, scope, last_used, expires. Does NOT reveal tokens. |
| Create key on user's behalf | ✓ | ✓ | Uses existing `/auth/api-keys` endpoint with target user_id |
| Revoke specific key | ✓ | ✓ | Same as CLI revoke-api-key |
| View helpdesk agent keys | — | ✓ | `helpdesk_agent_api_keys` is BBB-wide |

### 3f. Activity, audit, impersonation

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| View recent `activity_log` entries | ✓ | ✓ | Org-scoped for admin; all for SU |
| View `superuser_audit_log` filtered by target | — | ✓ | Existing table |
| View login history | — | ✓ | Needs new `login_history` table or log scrape |
| Start impersonation session | — | ✓ | Existing `/platform/impersonate` POST |
| View active impersonations | — | ✓ | Existing `/platform/impersonation-sessions` GET |
| End impersonation | — | ✓ | Existing `/platform/stop-impersonation` POST |

### 3g. Guest invitations

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| List pending invites sent by user | ✓ | ✓ | Existing `/v1/guests/invitations` filtered by invited_by |
| Revoke pending invite | ✓ | ✓ | Existing endpoint |
| Resend invitation email | ✓ | ✓ | Just shipped |

### 3h. Bulk & search

| Action | Admin | SuperUser | Notes |
|---|---|---|---|
| Search users by name/email | ✓ | ✓ | Typeahead — exists via org members list for admin; new cross-org for SU |
| Filter by role / is_active / is_superuser | ✓ | ✓ | |
| Bulk disable / enable | ✓ (target < caller) | ✓ | Confirmation required |
| Bulk role change | ✓ (target < caller) | ✓ | |
| Bulk remove from org | ✓ | ✓ | |
| Bulk add to project(s) | ✓ | ✓ | |
| Export members CSV | ✓ | ✓ | |

## 4. URL structure

```
/b3/people                          — org members list (admin view)
/b3/people/:userId                  — user detail (admin view)
/b3/people/:userId?tab=projects     — tab switches, query-param routed
/b3/people?filter=role:admin         — URL-encoded filters
/b3/people?search=eddie              — search term

/b3/superuser/people                — global users list (SU view)
/b3/superuser/people/:userId        — user detail (SU view, all orgs)
```

Tabs on a user detail page:
1. **Overview** — identity fields, org memberships, disable toggle
2. **Projects** — project memberships (current org for admin, all orgs for SU)
3. **Access** — API keys, sessions, force-password-change, reset password
4. **Activity** — recent activity_log + impersonation events + login history
5. **Admin** (SU only) — is_superuser flag, audit log filtered to this user

## 5. Screen sketches (text-based)

### 5a. `/b3/people` — list view

```
┌─ People ──────────────────────────────────────────────── [+ Invite] ┐
│                                                                     │
│  [Search: eddie_]   [Role ▼]   [Status: Active ▼]   [Projects ▼]    │
│                                                                     │
│  ☐  Name              Email                 Role    Projects  Last  │
│  ─────────────────────────────────────────────────────────────────  │
│  ☐  Eddie Offermann   eddie@…                Admin     3      1 min │
│  ☐  Alice Chen        alice@…                Member    2      2h    │
│  ☐  Bob Jones         bob@…                  Viewer    1      3d    │
│                                                                     │
│  [Selected: 2]  [Disable]  [Remove]  [Change role ▼]  [Add to…]     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5b. `/b3/people/:userId` — detail view

```
┌── Eddie Offermann ─────────────────── [Enable / ●Active] [⋯ Actions] ┐
│   eddie@bigblueceiling.com   ·   Owner in 2 orgs                    │
│                                                                     │
│  [Overview] [Projects] [Access] [Activity] [Admin]                  │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  IDENTITY                                                           │
│    Display name:  [Eddie Offermann         ]  [Save]                │
│    Timezone:      [America/New_York     ▼]                          │
│    Avatar:        [preview]  [Upload]  [Remove]                     │
│                                                                     │
│  ORG MEMBERSHIPS                                                    │
│  ┌────────────────────────┬────────┬─────────┬──────────┐           │
│  │ Organization           │ Role   │ Default │          │           │
│  ├────────────────────────┼────────┼─────────┼──────────┤           │
│  │ Big Blue Ceiling       │ Owner  │   ●     │ [Remove] │           │
│  │ Mage Inc               │ Admin  │   ○     │ [Remove] │           │
│  └────────────────────────┴────────┴─────────┴──────────┘           │
│  [+ Add to org] (SU only)                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 5c. Projects tab

```
  Current org: Mage Inc                      [+ Add to project ▼]
  
  ┌─────────────────────────────┬────────┬─────────────┐
  │ Project                     │ Role   │             │
  ├─────────────────────────────┼────────┼─────────────┤
  │ Q2 Roadmap                  │ Lead ▼ │ [Remove]    │
  │ Platform Migration          │ Member │ [Remove]    │
  │ Security Review             │ Viewer │ [Remove]    │
  └─────────────────────────────┴────────┴─────────────┘
```

### 5d. Access tab

```
  PASSWORD
    [Reset password] [Require change on next login: ☐]
    Last changed: 2026-02-14   ·   All sessions reset on last change
    
  API KEYS (3)
  ┌───────────────┬──────────────┬────────────┬──────────┬─────────────┐
  │ Name          │ Scope        │ Last used  │ Expires  │             │
  ├───────────────┼──────────────┼────────────┼──────────┼─────────────┤
  │ ci-bot        │ read_write   │ 2h ago     │ 88d      │ [Revoke]    │
  │ grafana       │ read         │ 14m ago    │ never    │ [Revoke]    │
  └───────────────┴──────────────┴────────────┴──────────┴─────────────┘
  [+ Create key on behalf of user]
  
  SESSIONS (SU only)
  ┌──────────────────┬──────────────────────┬────────────┬──────────┐
  │ IP               │ Device               │ Last seen  │          │
  ├──────────────────┼──────────────────────┼────────────┼──────────┤
  │ 73.48.12.x       │ Chrome on macOS      │ now (this) │          │
  │ 104.28.3.x       │ Firefox on Linux     │ 2 days ago │ [Revoke] │
  └──────────────────┴──────────────────────┴────────────┴──────────┘
  [Sign out everywhere]
```

## 6. Permissions matrix

Every action below is enforced server-side. The UI hides unavailable actions.

**Rank rule for admin actions: strictly below (`target < caller`).** A peer admin cannot reset, disable, demote, or kick another admin — only an owner or SuperUser can. Same at the owner tier: one owner cannot modify another owner; that requires SU. This is stricter than the "peer-allowed" rule the password-reset feature originally shipped with — as part of this plan, `resetMemberPassword` will be tightened to `<` to match. The motivation is containment: a single compromised admin credential cannot be used to lock every other admin out of the org.

| Action | Guest | Viewer | Member | Admin | Owner | SuperUser |
|---|---|---|---|---|---|---|
| View People list | — | — | — | ✓ | ✓ | ✓ |
| View other user's detail | — | — | — | ✓ (same org) | ✓ (same org) | ✓ (any) |
| Edit display_name / timezone | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Toggle is_active | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Edit email (w/ re-verification) | — | — | — | — | — | ✓ |
| Grant/revoke is_superuser | — | — | — | — | — | ✓ |
| Change role in org | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Remove from org | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Add to another org | — | — | — | — | — | ✓ |
| Reset password | — | — | — | ✓ (target < caller, admin+) | ✓ (target < caller) | ✓ |
| Force password change | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Revoke API keys on their behalf | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| View/revoke sessions | — | — | — | — | — | ✓ |
| Impersonate | — | — | — | — | — | ✓ (non-SU targets only) |
| Add/remove from project | — | — | — | ✓ (target < caller) | ✓ (target < caller) | ✓ |
| Transfer ownership (owner→admin + target→owner) | — | — | — | — | owner initiating | ✓ |

## 7. New API endpoints needed

Most capabilities already have endpoints. The gaps:

### Must add
- `GET /org/members/:userId` — single-user detail incl. project memberships for the current org. Currently there's only the list endpoint.
- `PATCH /org/members/:userId/profile` — edit display_name + timezone + avatar for an org member. Today you'd have to hit user's own profile endpoint.
- `PATCH /org/members/:userId/active` — body `{ is_active: boolean }`. Soft-disable/enable, invalidates sessions on disable. Does NOT block disabling the last owner, but the response includes a `last_owner_remaining: boolean` flag the UI uses to show a persistent "no active owner" banner at the org level.
- `POST /org/members/:userId/force-password-change` — flip a new `users.force_password_change` flag.
- `POST /org/members/:userId/transfer-ownership` — atomic: caller (owner) → admin, target → owner. Single transaction, rejects if caller is not currently owner.
- `GET /org/members/:userId/projects` — list their project memberships in this org.
- `POST /projects/:projectId/members` already exists (probably) — verify, make sure it's bulk-capable (array of user_ids with roles).
- `POST /org/members/:userId/sign-out-everywhere` — delete all sessions for target.
- `GET /org/members/:userId/api-keys` — list target's keys (prefix + metadata only, never the token).

### SuperUser must add
- `POST /superuser/users/:id/memberships` — add user to arbitrary org.
- `GET /superuser/users/:id/sessions` — list all sessions across any org.
- `DELETE /superuser/users/:id/sessions/:sessionId` — revoke one.
- `PATCH /superuser/users/:id/email` — change email. Reuses the `helpdesk_users` email-verification scaffold: issues a verification token to the NEW address, updates `users.email_verified = false` immediately, and the change only fully commits after the new address's token is redeemed. Old address receives a notification email so a compromised SU can't silently steal an account.
- `GET /superuser/users` — cross-org user list with search + filters. Currently only per-org listing.
- `GET /superuser/users/:id` — detail across orgs.
- `POST /superuser/users/:id/set-default-org` — flip `is_default` on memberships.
- `GET /superuser/users/:id/projects?scope=active|all` — cross-org project listing for the SU's project-assignment UI.

### Already have
- `/auth/api-keys` (GET list, POST create, DELETE revoke) — works for self; extend with `?user_id=` for admin on behalf.
- `/platform/users/:id/superuser` PATCH — already SU-gated.
- `/platform/impersonate` POST, `/platform/stop-impersonation` POST, `/platform/impersonation-sessions` GET.
- `/v1/guests/invitations/*` CRUD + resend.

## 8. Data model additions

Minimal schema changes required for this plan:

1. **`users.force_password_change boolean NOT NULL DEFAULT false`** — checked at login; redirects to password-change form.
2. **`users.disabled_at timestamptz NULL`** — audit timestamp for when soft-disable happened (complements `is_active`).
3. **`users.disabled_by uuid REFERENCES users(id)`** — who disabled them.
4. **`users.email_verified boolean NOT NULL DEFAULT true`** + **`users.email_verification_token text NULL`** + **`users.email_verification_sent_at timestamptz NULL`** — mirror of the existing `helpdesk_users` columns, reused for the SU email-change flow. Existing users backfill with `email_verified = true` so the change is invisible to them.
5. **(Later, not MVP)** `login_history(id, user_id, ip, user_agent, success, failure_reason, created_at)` for Activity tab surfacing.
6. **(Later, not MVP)** `admin_audit_log(id, org_id, actor_id, target_user_id, action, details jsonb, created_at)` for admin password resets, disables, forced password changes — currently these only hit pino logs.

### Nice-to-have (later)
4. `login_history(id, user_id, ip, user_agent, success, failure_reason, created_at)` — currently login failures are only in pino logs. A table lets us surface this in the UI.
5. `admin_audit_log` — separate from `activity_log` (project-scoped) and `superuser_audit_log` (SU-specific). For admin actions like password resets, force-password-change, disable/enable. Right now they log to pino only.

## 9. MVP phasing

### Phase 1 — Replace current Settings Members tab (≈1 week) — SHIPPED 2026-04-05
- `/b3/people` list with search + role/status filters
- User detail page: Overview tab only
- Edit display_name + timezone
- Toggle is_active (add `disabled_at` + `disabled_by` columns + "no active owner" org-level banner)
- Tighten rank rule from ≤ to < across invite/remove/role-change/reset-password/force-password-change. This is a behavior change — document in the audit docs + changelog.
- Transfer ownership action (single-step, owner-initiated)
- Integrate existing: invite, remove, change role, reset password
- Sidebar nav entry
- Hide Members tab in Settings (redirect link → /b3/people)

> **Completed 2026-04-05.** `GET /org/members/:userId`,
> `PATCH /org/members/:userId/profile`, `PATCH /org/members/:userId/active`,
> `POST /org/members/:userId/transfer-ownership`, and the `disabled_at` /
> `disabled_by` columns (migration `0011_user_disable_tracking.sql`) all
> landed. The rank rule was tightened from `≤` to `<` across every admin
> action in `apps/api/src/services/org.service.ts`. `GET /org` now returns
> `active_owner_count` so the SPA can render the no-active-owner banner.

### Phase 2 — Project assignments (≈3 days) — SHIPPED 2026-04-05
- Projects tab on user detail
- Add to project, change project role, remove from project
- Bulk-assign modal (multi-select projects)
- `GET /org/members/:userId/projects` endpoint

> **Completed 2026-04-05.** `GET /org/members/:userId/projects`,
> `POST /org/members/:userId/projects` (bulk add),
> `PATCH /org/members/:userId/projects/:projectId`, and
> `DELETE /org/members/:userId/projects/:projectId` shipped with the
> `target < caller` rank check and a cross-org project-id guard
> (`CrossOrgProjectError`) that fails a bulk assignment if any project_id
> doesn't belong to the caller's current org.

### Phase 3 — Access & sessions (≈4 days) — SHIPPED 2026-04-05
- Access tab: API keys list (read-only metadata, revoke)
- Create-key-on-behalf-of
- Force-password-change flag + login-side enforcement
- Sign-out-everywhere action
- Sessions panel (SU only for now)

> **Completed 2026-04-05.** API-key surface (`GET`/`POST`/`DELETE
> /org/members/:userId/api-keys[/:keyId]`),
> `POST /org/members/:userId/sign-out-everywhere`,
> `POST /org/members/:userId/force-password-change`, and
> `POST /auth/change-password` (self-service) landed alongside migration
> `0013_access_activity_session_meta.sql`, which added
> `users.force_password_change` plus `sessions.created_at /
> last_used_at / ip_address / user_agent`. The auth plugin now throttles
> `last_used_at` writes to once per 60s and redirects any user with
> `force_password_change=true` into `/b3/password-change`.

### Phase 4 — SuperUser global view (≈1 week) — SHIPPED 2026-04-05
- `/b3/superuser/people` cross-org list
- User detail in SU mode (all orgs, sessions, audit)
- Add/remove from orgs, change default org
- Edit email (with re-verification side effect)
- Impersonation controls inline
- SU audit log filtered to target

> **Completed 2026-04-05.** All SuperUser user-management endpoints
> shipped under `/superuser/users/*` (list, detail, memberships add/
> patch/delete, set-default-org, sessions list/revoke/revoke-all, email
> change with re-verification, projects, active toggle, login-history)
> plus `GET /superuser/audit-log` and `POST /auth/verify-email/:token`
> (public token redemption). Migration
> `0012_user_email_verification.sql` added `users.email_verified`,
> `pending_email`, `email_verification_token`, and
> `email_verification_sent_at`. `POST /auth/switch-org` now persists
> `sessions.active_org_id` for every user (not just SU) and the auth
> plugin honours it gated on membership.

### Phase 5 — Activity, bulk ops, export (≈1 week) — SHIPPED 2026-04-05
- Activity tab with activity_log + superuser_audit_log
- Bulk select + bulk actions on list view
- CSV export
- `login_history` table + UI surface

> **Completed 2026-04-05.** Bulk select and CSV export live on
> `/b3/people`. `GET /org/members/:userId/activity` surfaces filtered
> `activity_log` rows per member. The `login_history` table (migration
> `0013_access_activity_session_meta.sql`) records every
> `POST /auth/login` attempt (success or failure, email denormalized)
> and is exposed at `GET /superuser/users/:id/login-history` for the
> SU Activity tab.

## 10. Non-goals (this iteration)

- **Groups / teams** — no group abstraction. Users are assigned to projects individually. (Later: add a `teams` table + `team_memberships`, make project membership accept either user or team.)
- **SSO / SCIM provisioning** — still username+password only.
- **Permission templates** — roles are fixed enums; no per-permission toggles.
- **2FA management** — 2FA isn't shipped yet.
- **Self-service profile editing via People screen** — users edit their own profile in `/b3/settings` as today.
- **Customer (helpdesk_users) management** — helpdesk customers are a separate identity pool. If needed, build a parallel `/b3/helpdesk/customers` screen later.

## 11. Decisions locked in during review

- **Rank rule is strictly below (`target < caller`)** for every admin action. Peer-admin-on-admin is not allowed — a compromised admin cannot lock out other admins. Escalation to an owner or SuperUser is required to act on a peer. Same at the owner tier. The password-reset feature shipped with `≤` and will be tightened to `<` as part of Phase 1.
- **Ownership transfer is single-step.** One button: current owner becomes admin, target becomes owner, atomically. Co-owner model remains available via the ordinary "change role → owner" action for orgs that want multiple owners without any demotion.
- **Disabling the last owner is allowed.** Rather than blocking the action, the org surfaces a persistent "this organization has no active owner" banner until a new owner is promoted. Prevents lockout scenarios where every owner account needs to be rotated.
- **Project assignment for SU defaults to active-org scope** with a one-click switcher to "all orgs" when cross-org bulk assignment is actually needed. Keeps the common case fast, allows the rare case.
- **Email change reuses the `helpdesk_users` email-verification scaffold**, extended to BBB `users` (adds `email_verified`, `email_verification_token`, `email_verification_sent_at` columns). The verification token is sent to the NEW address and the old address is notified. Existing users backfill with `email_verified = true` so nothing breaks for them.
