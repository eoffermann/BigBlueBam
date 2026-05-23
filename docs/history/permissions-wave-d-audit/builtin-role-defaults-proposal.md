# Proposed default permissions for built-in roles

_Draft for review. Once decisions are settled this becomes the input to a Wave A remediation migration that fixes `permission_group_defaults`._

## Why this exists

The Wave A migration `0146_permissions_builtin_groups.sql` defaulted **98.8 %** of permissions to **allow** for the `member` role (1007 of 1019 granted) and **100 %** for `owner` and `admin`. Wave D's resolver is now canonical for any route gated by pure `requireCan(...)`, so the over-permissive defaults are a real risk — defense-in-depth via dualReadGate is the only thing keeping member users out of admin surfaces today. Wave E (which removes the legacy role gates entirely) cannot ship until these defaults are correct.

## Catalog scale

1047 permissions across 17 app namespaces. Breakdown by app:

| App      | Total | Read | Destructive | SU-required |
|---|---:|---:|---:|---:|
| bam      | 248 | 105 | 26 | 4 |
| banter   | 131 | 52  | 13 | 0 |
| bond     | 84  | 38  | 9  | 0 |
| beacon   | 69  | 28  | 6  | 0 |
| brief    | 69  | 22  | 9  | 0 |
| board    | 59  | 27  | 6  | 0 |
| bill     | 51  | 20  | 6  | 0 |
| blast    | 49  | 22  | 5  | 0 |
| bearing  | 46  | 15  | 5  | 0 |
| bolt     | 41  | 16  | 2  | 0 |
| helpdesk | 41  | 21  | 2  | 0 |
| bench    | 39  | 18  | 4  | 0 |
| platform | 37  | 5   | 1  | 7 |
| book     | 35  | 16  | 5  | 0 |
| blank    | 25  | 12  | 3  | 0 |
| shared   | 13  | 4   | 1  | 0 |
| agent    | 10  | 3   | 0  | 0 |

Helpdesk is exempt by design (its own auth model). The 10 `agent.*` permissions are agentic-platform actions that mostly should land in admin/owner only.

## Role hierarchy and ground rules

```
   guest  <  viewer  <  member  <  admin  <  owner  <  superuser
```

- **SuperUser** is a boolean on `users.is_superuser`, NOT a built-in group. The resolver short-circuits at step 1 — SU bypasses everything. Not on this matrix.
- **Owner**: the org creator and anyone they transfer ownership to. Trusted with everything inside their org including destructive admin actions. Cross-org and platform-system actions are still SU-only.
- **Admin**: org configuration and member management. Cannot delete the org itself, cannot transfer ownership.
- **Member**: standard end-user. Can do day-to-day work; cannot touch org-level config, audit log, or other people's API keys.
- **Viewer**: read-only across the apps they have project access to. Cannot write anything.
- **Guest**: scoped to the entity they were invited to. Minimal everything.

The rules below interact with project-level access scoping (already implemented via `requireProjectAccess`). A member with `bam.task.update` granted at org scope still cannot edit a task in a project they aren't a member of — that's the visibility layer, not the permissions layer.

## High-level role principles

### Owner

Default: **allow everything within the org**, deny only cross-org / platform-system actions and a few hard limits (e.g. cannot self-grant SuperUser, cannot impersonate). Roughly 100 % allow within their own namespace; explicit denies for the `platform.*` namespace.

**Notable denies**:
- `platform.org.create` / `.delete` / `.update` — cross-org operations, SU-only
- `platform.system.list_beta_signups` / `.set_launchpad_defaults` / `.set_public_signup_disabled` — platform admin, SU-only
- `platform.system.test_slack_webhook` — platform diagnostic, SU-only
- `agent.policy.set` — agentic-platform configuration, deferred to admin or kept SU
- `platform_impersonate.*`, `platform_audit_log.*` — SU-only impersonation tooling

### Admin

Default: **allow read on everything in the org + allow write on org/membership/config surfaces**, deny destructive owner-only actions (delete org, transfer ownership) and platform/agent-policy surfaces.

**Notable denies vs. owner**:
- `bam.org.update` — owner-only (org name/slug change)
- `bam.org_member.transfer_ownership` — owner-only
- `bam.org.delete` — owner-only
- `bill.invoice.finalize` / `.void` — owner-only (financial finality; admin can draft, owner finalizes)
- `bam.system_setting.update` — owner-only by default; could be admin-level if "system" here is org-system not platform-system. Recommend keeping owner.
- All `platform.*` writes — same denies as owner

### Member

Default: **allow read + non-destructive write on user-action resources, deny org-config / admin / destructive admin actions**.

**Allowed write surfaces**:
- All `bam.task.*` / `bam.sprint.*` / `bam.comment.*` / `bam.reaction.*` / `bam.epic.*` (create/update; delete-own may be allowed, delete-others denied)
- `bam.attachment.create` / `bam.upload.create` / `bam.file.list`
- `bam.label.list` / `bam.phase.list` / `bam.view.*` / `bam.template.list`
- `bam.time_entry.*` (own)
- `bam.notification_pref.*` (own)
- All `banter.*` channel/message/thread basics (post, edit-own, delete-own; admin actions denied)
- `beacon.*` read; entry create/update if it's a wiki-style surface
- `brief.*` document create/update; delete-own
- `bond.*` contact/deal create/update (CRM is collaborative by nature)
- `blast.*` campaign drafts (send/finalize → owner/admin)
- `bench.*` dashboard create/update (own)
- `bolt.*` rule create/update (own)
- `book.*` schedule own events
- `blank.*` form_submission (anyone submits; admin sees results)
- `bearing.*` goal create/update (own)
- `board.*` board create/edit (own/shared)
- `shared.*` everything (these are utility tools)
- `platform.user.*` (own profile, notifications, switch_org, change_password, get_my_tasks, etc.)
- `platform.system.get_info` / `.get_public_config` / `.get_platform_settings` / `.get_launchpad_apps`
- `agent.self.heartbeat` / `.report` — but only for agent-kind users; the resolver should additionally gate on `users.kind = 'agent'` for these

**Notable denies**:
- All `*.org.*` writes, all `*.org_member.*` writes (cannot invite/remove org members)
- `bam.system_setting.update`, `bam.platform_setting.update`
- `bam.audit_log.list`, all `*.audit_log.*`
- `bam.auth_api_key.*` for OTHER users; own API keys are OK via `bam.auth_api_key.create` / `.list` / `.delete` at user scope (NOTE: this is a SCOPE issue, not a role issue — see "Scope vs. role" below)
- `bam.guest_invitation.*` — only admin/owner can invite guests
- `bam.import.*` — destructive bulk; admin/owner
- `bam.llm_provider.*` — org config; admin/owner
- `bam.org_launchpad_app.*` — admin/owner
- `bam.project.delete` — owner of the project or org admin/owner
- All `agent.*` except `self.heartbeat` / `self.report`
- All `platform.*` admin operations
- All `*.delete` on OTHER users' content (label.delete, phase.delete, custom_field.delete, etc.)

### Viewer

Default: **allow all read verbs, deny all writes**. Roughly 40 % allow (the read share of the catalog).

**Allowed**:
- Every `*.list`, `*.get`, `*.search`, `*.view`, `*.find`, `*.count`, `*.query`, `*.browse` permission within the org
- Personal `platform.user.*` actions (logout, get_profile, view, get_my_tasks, mark_notification_read, switch_org, change_password)
- `shared.*` read tools

**Denied**:
- Every write/create/update/delete
- `bam.comment.create` (viewers can read discussions but cannot participate — debatable; some products want viewers to comment)
- All `agent.*` (viewers should not be running automations)
- All admin / audit surfaces

### Guest

Default: **almost everything denied**. Only enough to interact with the single entity they were invited to.

**Allowed (~20 total)**:
- `platform.user.get_profile` / `.view` / `.logout` / `.change_password` (self only)
- `bam.task.get` / `.list` (limited by project visibility)
- `bam.comment.list` / `.create` (so they can join the conversation on the entity they were invited to)
- `bam.reaction.create` / `.delete` (emoji reactions on comments)
- `bam.attachment.get` / `.list`
- `bam.file.list`
- `bam.project.get`
- `bam.phase.list`, `bam.label.list`, `bam.epic.list` (so the task they see has rendering context)
- `platform.user.list_notifications` / `.mark_notification_read`
- `platform.system.get_info` / `.get_public_config`
- `shared.attachment.get` / `.list`

**Everything else denied**, including the 121 currently-granted guest permissions (most of which are over-broad).

## Per-app summary table

The proposed approximate allow-ratio per role per app:

| App      | Owner | Admin | Member | Viewer | Guest |
|---|---:|---:|---:|---:|---:|
| bam      | ~95 % | ~85 % | ~55 % | ~42 % (reads only) | ~6 %  |
| banter   | 100 % | ~90 % | ~80 % | ~40 % | ~2 %  |
| bond     | 100 % | 100 % | ~75 % | ~45 % | 0 %   |
| beacon   | 100 % | 100 % | ~75 % | ~40 % | ~5 %  |
| brief    | 100 % | 100 % | ~75 % | ~32 % | ~10 % |
| board    | 100 % | 100 % | ~75 % | ~45 % | ~10 % |
| bill     | 100 % | ~85 % | ~50 % | ~40 % | 0 %   |
| blast    | 100 % | ~85 % | ~60 % | ~45 % | 0 %   |
| bearing  | 100 % | 100 % | ~70 % | ~32 % | ~5 %  |
| bolt     | 100 % | ~85 % | ~60 % | ~40 % | 0 %   |
| bench    | 100 % | 100 % | ~70 % | ~45 % | 0 %   |
| book     | 100 % | 100 % | ~70 % | ~45 % | ~30 % (self-service booking) |
| blank    | 100 % | 100 % | ~50 % | ~50 % | ~20 % (form submission) |
| platform | ~70 % | ~70 % | ~50 % (mostly user-self) | ~30 % | ~10 % |
| agent    | ~30 % | ~30 % | ~20 % (self only) | 0 %   | 0 %   |
| shared   | 100 % | 100 % | 100 % | 100 % | ~15 % |

Total grants per role (current Wave A vs. proposed):

| Role | Current granted | Proposed granted | Delta |
|---|---:|---:|---:|
| owner  | 1019 | ~990  | -29 (deny platform.* and a few impersonation/audit) |
| admin  | 1015 | ~870  | -145 |
| member | 1007 | ~580  | -427 (the big swing) |
| viewer | 403  | ~420  | +17 (some additions, mostly correct already) |
| guest  | 121  | ~22   | -99 |

## Cross-cutting categories worth special attention

### A. The "self-vs-others" axis

Several `bam.*` permissions today don't distinguish between operating on your own record and operating on someone else's. Examples:
- `bam.auth_api_key.list` — should be allowed for everyone (their own keys) but the route handler scopes by `request.user.id` so the permission is fine to grant
- `bam.org_member_api_key.list` — admin/owner only (view other users' keys)
- `bam.comment.delete` — should be allow-own, deny-others; the resolver doesn't have ownership awareness so we grant it and rely on the route handler to enforce ownership

**Recommendation**: keep the current resolver model (permission grants by role) but acknowledge that ownership-aware authorization remains at the route-handler layer. Document this in `docs/agent-conventions.md` so the boundary is clear.

### B. Destructive actions

103 permissions are flagged `is_destructive`. The recommended rule:
- **Owner**: all destructive actions in their org
- **Admin**: destructive actions on shared org resources (labels, phases, custom_fields, templates, members) — but not on "owner-only" surfaces like org.delete or transfer_ownership
- **Member**: destructive only on their own creations (delete-own task/comment/file/attachment). Most destructive grants → deny.
- **Viewer**: zero destructive
- **Guest**: zero destructive

### C. SuperUser-required permissions

The 4 currently-flagged `requires_superuser: true` permissions:
- `bam.platform_org.create` / `.delete` / `.update` (in the `bam` namespace; same as `platform.org.*` below)
- `bam.superuser_permission_divergence.list`

And the 7 in `platform.*`:
- `platform.org.create`, `.delete`, `.update`
- `platform.system.list_beta_signups`, `.set_launchpad_defaults`, `.set_public_signup_disabled`, `.test_slack_webhook`

All of these should be DENY for owner/admin/member/viewer/guest. The resolver respects `requires_superuser=true` at a higher precedence than group defaults, so this is belt-and-suspenders.

### D. Agent-platform permissions

The 10 `agent.*` permissions interact with the §15 PolicyGate (kill-switch + tool allowlist) and the agent_runner_webhooks system:
- `agent.audit.read` — admin / owner
- `agent.policy.get` / `.list` — admin / owner
- `agent.policy.set` — owner (was already denied for member in Wave A)
- `agent.self.heartbeat` / `.report` — agent users only; should default-allow for member because agent users have role=member, but the route handler should additionally gate on `users.kind = 'agent'`
- `agent.webhook.configure` / `.list_deliveries` / `.redeliver` / `.rotate_secret` — admin / owner

### E. The 18 `agentic` bam permissions

`agent_policy.*`, `agent_runner_webhook.*`, `agent_webhook_delivery.*`, `proposal.*`, `approval.*`, `dedupe_decision.*`, `expertise_*` — these are cross-cutting agentic platform surfaces and should follow the same rules as their `agent.*` counterparts: admin/owner write, member read where applicable.

## Recommended decision process

1. **Approve the role-level principles above.** (Owner trusts everything inside org; admin trusts everything except org-delete/transfer/billing-finalize; member is collaborative-write; viewer is read-only; guest is scoped-to-invite.)

2. **Confirm the per-app summary table directionally.** If any app needs a different shape (e.g. blast campaigns should be admin-only write), note it.

3. **Confirm the cross-cutting rulings**: `platform.*` deny for everyone, `agent.*` for admin/owner, destructive denies for member, etc.

4. **I author a remediation migration** (`015N_permissions_remediate_builtin_defaults.sql`) that:
   - Replaces every row in `permission_group_defaults` for `is_builtin = true` groups with values derived from these rules
   - Uses CASE expressions on the catalog's existing `is_read` / `is_destructive` / `requires_superuser` flags + explicit per-resource overrides
   - Is idempotent (DELETE + INSERT, or UPSERT)
   - Includes a verification query at the bottom that prints the new totals per role for spot-checking

5. **Apply, re-verify Wave D enforcement**: re-run the `avery.singh@mage.io` (member) test from `SYNTHESIS_PROGRESS.md` §4.6 and confirm the resolver now denies admin-shaped actions.

## Questions to settle before I write the migration

1. **`bam.system_setting.*` and `bam.platform_setting.*`** — are these org-level config (admin can write) or platform-level (owner-only or even SU-only)? The names overlap with `platform.system.*` so it's confusing.

2. **`bam.org_member.invite`** — admin level, or owner-only? Today's UI lets admins invite.

3. **`bill.invoice.finalize` / `.void` / `.send`** — admin level or owner-only? Financial finality often gets owner-locked.

4. **Project-level admin**: the matrix above treats project admin as a special case of org admin. Should we add a "project_admin" role concept later, or keep it implicit via per-project memberships?

5. **`bam.template.*`** — templates that ship with the org. Admin-write, member-read? Or member-write (anyone can author a personal template)?

6. **Guest comment posting (`bam.comment.create`)** — recommended allow above. Confirm this matches product intent (some products treat guests as strictly view-only).

7. **`agent.self.heartbeat` / `.report`** — recommended member-allow with kind-gating at the handler. Confirm.

---

Once you've read this, point me at items to change and I'll either revise the proposal or jump straight to the migration.
