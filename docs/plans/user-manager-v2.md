# People Manager v2 — Design Plan (for approval)

**Status:** Draft for Eddie's approval. Nothing is built yet.
**Author:** Claude (research-backed; see the three surface dossiers summarized in §2).
**Scope of this doc:** a unified, permission-graded "People Manager" presented to any sufficiently-privileged user, at a new dedicated URL, coexisting with the current `/b3/people` and `/b3/superuser/people` for now.

---

## 1. Goal

One screen that adapts to the accessor's level and lets them manage people across **every org they can see**, doing — within the limits of their permissions — everything the two existing people surfaces do today, plus multi-org reach:

- Invite users (single, bulk, CSV import) — **assigning them at invite time to specific org(s), project(s), and group(s)**, so a couple dozen people can be invited at once and start working the moment they join (no per-user fix-up afterward).
- Enable / disable (individually and in bulk).
- Delete (soft-delete / account tombstone, with re-invite freeing the email).
- Add / remove to/from **orgs** (only orgs the accessor administers).
- Add / remove to/from **projects** (+ project role).
- Assign to permission **group(s)** and drive the **permission matrix** (the one in `superuser/permissions`).
- Reset password — both flows: generate-and-show, or send reset-link email.
- Change email, display name, timezone, org membership role(s).
- Bulk: enable / disable / remove-from-org / role-change / CSV export.

**Capabilities degrade by the accessor's level**, and **visibility is scoped**: you see only people in orgs you belong to; you can only act on orgs where you're an admin, and only on people you outrank.

---

## 2. Key findings (what already exists vs. what's missing)

Backed by three read-only code surveys (Bam `/b3/people`, SuperUser people+permissions, and the authorization model) plus `docs/reference/mcp-endpoint-mapping.md`.

**Almost all per-member actions already exist** as `/org/members/:userId/*` endpoints (invite, role, active toggle, remove, delete-account + eligibility, projects add/role/remove, profile edit, reset-password both flows, send-reset-link, force-password-change, sign-out-everywhere, API keys, activity). They are scoped to the caller's **active org**.

**The active org is selectable per-request via the `x-org-id` header** (`apps/api/src/plugins/auth.ts` `getRequestedOrgId` + `resolveOrgContext`). For a browser/session caller it validates membership and resolves the caller's role *in that org*, so `checkRankAbove` enforces correctly. (For non-SuperUser **API-key** callers the key's org is pinned and `x-org-id` is ignored — irrelevant for the browser UI.)
**→ This is the linchpin: v2 reuses every existing member endpoint by setting `x-org-id` to the relevant org. No per-action endpoint rebuild.**

**The permission matrix is fully built** (`apps/frontend/src/components/superuser/user-permissions-tab.tsx` + `pages/superuser/permissions/group-detail.tsx`, backed by `/superuser/permissions/*`) — but SuperUser-only, and the catalog rows behind it are mostly `requires_superuser:false` (SU-exclusivity rests on SU-bypass + group-default discipline, not a hard catalog gate).

**The one real backend gap:** there is **no permission-graded, multi-org people list.** Today you get either single-active-org (`GET /org/members`) or all-orgs-SU-only (`GET /superuser/users`). Nothing returns "people across the orgs I belong to, with per-row capability flags." v2 must add exactly this.

**Authorization model (must honor both):**
- **Legacy rank gate** — `checkRankAbove(callerRole, targetRole, isSU)` in `org.service.ts`: caller must be **admin or owner** AND **strictly outrank** the target (equal rank denied; SU bypasses). Roles: `owner > admin > member > viewer > guest`, stored in `account_group_memberships → permission_groups.legacy_role` (the `role` columns were dropped, migration 0159).
- **Per-action resolver** — `requireCan('bam.<resource>.<action>')` via `@bigbluebam/permissions`, enforcement `BBB_PERMISSIONS_ENFORCE` ∈ `off|warn|on` (code default off, compose `warn`, prod target `on`). v2 must work under both `warn` and `on`.

**Reuse-ready frontend building blocks:** `peopleApi` + `canActOn`/`roleLevel` (`lib/api/people.ts`), `superuserUsersApi`, `superuserPermissionsApi` + all permission types, `UserPermissionsTab` and the group editor, the `runBulk` engine + bulk toolbar + progress toast, `lib/csv.ts`, `useCan` (`packages/ui/use-can.tsx`), and the common component kit. Routing is a hand-rolled string router in `apps/frontend/src/App.tsx` (register the route + thread `onNavigate`).

---

## 3. Scope

**In scope (v1 of People Manager v2):**
- New page at a dedicated URL (see §4), coexisting with the two existing surfaces.
- New scoped multi-org people-list endpoint with per-row capability flags.
- Roster (search/filter/select) + detail (tabbed) reusing existing endpoints via `x-org-id`.
- All capabilities in §1 that are reachable by **reusing existing endpoints** (invite, enable/disable, delete, projects, profile incl. display name/timezone, role, password both flows, bulk, CSV).
- Permission-graded rendering driven by server-emitted per-row flags + `useCan`.
- **Invite-time assignment**: invite (single + bulk, a couple dozen at once) with simultaneous add to specific org(s) + project(s), and the built-in **role group** per org. (Assigning *custom* permission groups at invite is SU-only in v1, riding with the rest of org-scoped group management — see §7 and M6.)

**Deferred to a later phase (need new backend or policy decisions — see §11):**
- Org-admin (non-SU) management of **custom permission groups** and the **per-user matrix** scoped to their org (today SU-only; catalog flags under-applied).
- Org-admin **cross-org membership** management (add/remove a user to/from a *different* org) — today SU-only (`/superuser/users/:id/memberships`). v1 covers orgs the admin administers via `x-org-id`; truly arbitrary cross-org membership stays SU-only until new org-admin endpoints exist.
- Email change for non-SU (today only self-serve verify flow + SU `PATCH /superuser/users/:id/email`).
- Server-side bulk endpoints (v1 uses resilient client-side fan-out like today).
- Hardening last-owner protection into a server block.

**Out of scope:** replacing/removing the existing `/b3/people` and `/b3/superuser/people` pages (explicitly "separately for now"); sessions inventory redesign; avatar editing.

---

## 4. Placement

**`/b3/people-manager`** (clear, unambiguous, doesn't shadow `/b3/people`).
- Register in `apps/frontend/src/App.tsx` route matcher (+ a `:userId` detail route, e.g. `/b3/people-manager/:userId`), threading `onNavigate`.
- Entry point: a nav/command-palette item gated by "can the caller manage anyone?" (see §5). Plain members with no management rights either don't see it or see a read-only directory (decision in §11).

---

## 5. Accessor levels & capability matrix

The page renders the **union of what the accessor can do across their visible orgs**. Each capability is gated by (a) the accessor's role in the relevant org, (b) rank vs. the target, and (c) `useCan` where a per-action permission exists. The server is always authoritative; the UI mirrors it via per-row flags (§6).

| Capability | Min level (in the relevant org) | Extra guards |
|---|---|---|
| See a person | Member of an org the person is also in | Visibility = union of your orgs |
| Invite to an org | Admin/owner (or member if org setting `members_can_invite_members`) | Invite role ≤ admin |
| Change org role | Admin/owner, must outrank target | Can't set `owner` (use transfer); can't touch equal/higher rank |
| Enable / disable | Admin/owner, must outrank target | Can't disable self; last-owner advisory |
| Remove from org | Admin/owner, must outrank target | Can't remove self |
| Delete account (soft) | Admin/owner **of every org the target is in** (SU bypasses) | Eligibility probe; can't delete self or a SuperUser |
| Add/remove projects, project role | Admin/owner of the org (project-admin for own projects — see §11) | — |
| Edit profile (display name, timezone) | Admin/owner over target, or self | — |
| Reset password (generate / send-link) | Admin/owner, must outrank target | Can't reset self via admin path (`CANNOT_RESET_SELF`) |
| Force password change / sign-out-everywhere | Admin/owner, must outrank target | — |
| Create/revoke API keys for a member | Admin/owner; **admin-scope keys owner-only** | `ADMIN_SCOPE_OWNER_ONLY` |
| Transfer ownership | Owner (or SU) | Demotes caller; not to self |
| Assign permission **groups** / edit per-user **matrix** | **SuperUser** in v1 (org-admin scoped = deferred, §11) | — |
| Change email | **SuperUser** (`PATCH /superuser/users/:id/email`) in v1 | — |
| Cross-org membership add/remove (arbitrary org) | **SuperUser** in v1 | — |
| Toggle SuperUser, impersonate | **SuperUser** | Can't toggle self |
| CSV export of visible roster | Any accessor who can see the roster | Exports what's visible |

Five effective tiers: **plain member** (read-only directory, maybe hidden) → **project admin** (project membership for own projects) → **org admin** → **org owner** (+ transfer, admin-scope keys) → **SuperUser** (cross-org everything + matrix + impersonation + email + superuser toggle).

---

## 6. Visibility scoping & the new list endpoint

**Visibility rule:** the accessor sees people who are members of any org the accessor is also a member of (union across their memberships). **Action rule:** for each (person, org) the accessor can only act where they are admin/owner of that org and outrank the person. SuperUsers see/act everywhere.

**New endpoint (the core backend work):** `GET /people` (name TBD; under the Bam api, e.g. `/b3/api/people`).
- **Behavior:** resolve the caller's org set (reuse `listOrgsUserBelongsTo`; SU → all orgs or a chosen scope), list members across those orgs, dedup people, and attach **per-person, per-org capability flags** computed server-side from `checkRankAbove` + the caller's role in each org + relevant `requireCan` checks.
- **Response shape (sketch):**
  ```jsonc
  { "data": [ {
      "user": { "id", "email", "display_name", "avatar_url", "is_active", "last_seen_at" },
      "memberships": [ { "org_id", "org_name", "role",
        "caps": { "manage_role": true, "disable": true, "remove": true,
                  "delete_account": false, "manage_projects": true,
                  "reset_password": true, "manage_keys": true, "transfer_ownership": false } } ]
    } ], "next_cursor": null }
  ```
- **Why server-side caps:** today the UI re-derives "can I act" client-side (`canActOn`). For multi-org that must be server-authoritative per org. The UI uses the flags directly to enable/disable controls; the backend still re-checks on every mutation (defense in depth).
- **Search / filter / pagination:** server-side `search`, `is_active`, `role`, `org_id` filters + cursor pagination (the current single-org page is fully client-side; multi-org needs server paging).
- **Reuses:** `listOrgsUserBelongsTo`, `listOrgsAdministeredBy`, `getMembershipRole`, `resolveUserOrgRoles`, `checkRankAbove`, `listOrgMembers`. SU path can fall back to `listUsers` (`superuser-users.service.ts`).

**All mutations** then reuse existing endpoints, called with `x-org-id` set to the org context of the action (the org whose row the operator clicked). No new mutation endpoints in v1.

---

## 7. Frontend architecture

**New page** (`apps/frontend/src/pages/people-manager/`): `index.tsx` (roster) + `detail.tsx` (tabbed person view), plus a thin `lib/api/people-manager.ts` that wraps the new list endpoint and re-exports the existing `peopleApi` / `superuserUsersApi` / `superuserPermissionsApi` calls with an `x-org-id` injector.

**Roster (`index.tsx`):**
- Server-paged table across the accessor's visible orgs; columns include an **Org(s)** column (people can appear in several visible orgs).
- Search + filters (active/disabled, role, org) hit the server.
- Multi-select + the lifted **`runBulk`** engine + floating toolbar (extract the duplicated copies from `people/index.tsx` and `superuser/people-list.tsx` into one shared component). Bulk verbs: enable, disable, remove-from-org, role-change, CSV export — each fanned out with per-row rank-skip (using the server caps).
- Invite (single), bulk-invite, and CSV import dialogs lifted from the existing page; invite targets a chosen org the accessor administers.
- CSV export via `lib/csv.ts` (now includes project counts if the new list endpoint returns them — closes a current gap).

**Detail (`detail.tsx`)** — tabbed, permission-driven:
- **Overview / Identity:** display name + timezone edit (`PATCH …/profile`), status, disabled-by banner; email read-only except SU (SU → `PATCH /superuser/users/:id/email`).
- **Memberships:** the person's memberships **across the accessor's visible orgs**, with per-org role select, enable/disable, remove, and (orgs the accessor administers) add-to-another-such-org. Arbitrary cross-org add stays SU-only in v1.
- **Projects:** per-org project membership (add/role/remove) via existing endpoints with `x-org-id`.
- **Permissions (matrix):** mount the existing `UserPermissionsTab`. **Shown only to SuperUsers in v1.** Org-scoped matrix for org admins = deferred (§11).
- **Access:** reset password (extract ONE shared `<ResetPasswordDialog>` — generate/manual), send reset-link, force-password-change (wire the currently-dead header stub), sign-out-everywhere, API keys (admin scope owner-only).
- **Activity:** existing member activity feed.

**Permission-driven rendering:** controls are enabled/disabled from the server `caps` per (person, org) + `useCan` for action-permission'd buttons. No client-only rank math as the source of truth (we keep `canActOn` only as an optimistic pre-check).

**Shared-component extractions (also pays down existing debt):** `<ResetPasswordDialog>`, `<RevealOnceSecret>` (used by reset ×2 + API-key create), and a `<BulkActionBar>`/`runBulk` primitive — all currently duplicated across the two people pages.

### Invite flow — assigning to orgs, projects & groups (single + bulk)

A first-class part of v2: invite from one place and set everything a new person needs to start working, so nobody has to be fixed up afterward. One action handles 1 → a couple dozen invitees.

**Inputs (one "invite recipe" per batch, with optional per-row override):**
- **Invitees** — paste a list of emails (optionally `Name <email>`) or use a small grid; dedup + validate by reusing `parseImportMembers` + `lib/csv.ts`. Built for ~24+ at once (the bulk path already chunks at 100/request).
- **Org(s)** — multi-select, limited to orgs the inviter administers; each chosen org carries an invite **role** (`member`/`admin` — owner isn't invitable).
- **Project(s)** — multi-select, grouped under the chosen orgs (only projects belonging to those orgs); each carries a **project role** (`member`/`viewer`/`admin`). **This is the gap being closed** — today invitees land with no project and can't work until someone adds them one-by-one; here they're on their projects on day one.
- **Group(s)** — v1: the built-in **role group** per org (i.e. the org role above; built-in groups *are* the role system). Assigning *custom* permission groups at invite is SU-only in v1 (rides with org-scoped group management, M6); a SuperUser can do it immediately via the existing SU group-assign endpoint as a fast-follow.

**Mechanism (reuse-first — no new mutation endpoint for v1):**
- **Single org + its projects:** one call to the existing `POST /org/members/invite/bulk`, which already accepts a batch-wide `default_project_ids` and per-row `project_ids` (and single `POST /org/members/invite` takes `project_ids` too). The capability has existed server-side; the old UI simply never exposed project selection — v2 does. This directly fixes "previously you couldn't add users to a project when you invited them."
- **Multiple orgs:** fan out one bulk-invite call **per selected org**, with `x-org-id` set to that org and only that org's `project_ids` (a project must belong to its invite org or `inviteMember` throws `CrossOrgProjectError`). A person invited into several orgs is reused by email (`was_existing` on later orgs) and gets a membership + projects in each. Per-org rank/permission is enforced normally — the inviter must administer each chosen org.
- **Results:** an aggregated per-invitee × per-org panel showing created/was_existing, **`email_sent`** (so the operator sees delivery status — closing the current bulk-path gap where it's hidden), and projects_added/skipped. Failures are per-row, not all-or-nothing (reuse the `runBulk` resilience pattern).

**Optional later:** a single server-side `POST /people/invite-batch` taking the whole multi-org/project/group recipe and fanning out atomically (one round-trip, consolidated result). Not required for v1 — client-side per-org fan-out covers it.

---

## 8. Guard rules to preserve (non-negotiable)

Carried verbatim from the backend (the server enforces; UI mirrors):
- Strict rank: admin/owner only, must strictly outrank target (`InsufficientRankError` → 403).
- Can't disable/remove/reset-password **self** via admin paths; `CANNOT_RESET_SELF`.
- Delete-account requires admin in **every** org the target belongs to (SU bypass); can't delete self or a SuperUser.
- Admin-scope API keys: owner-only (`ADMIN_SCOPE_OWNER_ONLY`).
- Transfer ownership: owner/SU only, not to self.
- Soft-delete tombstones email (frees it for re-invite), clears password/sessions/keys/all memberships; row retained for FK integrity.
- SuperUser-only: matrix, superuser toggle, impersonation, cross-org membership, email change (v1).

---

## 9. Security & enforcement notes

- The new list endpoint and all reused mutations must behave under `BBB_PERMISSIONS_ENFORCE=warn` **and** `=on`. The list endpoint gates with `requireCan('bam.org_member.list')`-style checks but its real scoping is the membership-union logic.
- **Catalog hardening watch:** the `bam.user.*` / `bam.platform_org.*` perms behind SU surfaces are mostly `requires_superuser:false`. v1 keeps those surfaces SU-only by NOT exposing them to org admins. **Before** any phase exposes cross-org/matrix to org admins (§11), set the catalog `requires_superuser` flags and built-in group defaults deliberately, or an org owner could reach platform perms under `on` enforcement.
- All capability flags are advisory hints for the UI; every mutation re-checks server-side.

---

## 10. Phasing / milestones

- **M1 — Scoped list endpoint + caps** (backend): `GET /people` with membership-union scoping + per-(person,org) capability flags + search/filter/cursor. Unit + security tests (a member of org A must not see org-B-only people).
- **M2 — Roster page + rich invite** (frontend): new route, server-paged table, search/filter, CSV export, and the **invite flow with org / project / (built-in) group assignment** — single + bulk, a couple dozen at once (§7) — reusing components and the existing `invite[/bulk]` endpoints.
- **M3 — Detail page**: Overview/Identity, Memberships (within accessor's orgs), Projects, Access (incl. shared ResetPasswordDialog; wire the dead force-password-change stub) — all via `x-org-id` reuse.
- **M4 — Permissions tab (SU-only)**: mount existing `UserPermissionsTab`; add the missing "Add membership" affordance and per-scope override selection noted in the SU dossier.
- **M5 — Bulk**: lift `runBulk` + toolbar; enable/disable/remove/role/export.
- **(Later) M6 — Org-admin permission/group + cross-org membership**: new org-scoped endpoints + catalog hardening (the §11 decisions). Unlocks **custom-group assignment for org admins, including at invite time**; SuperUsers can assign custom groups at invite earlier via the existing SU endpoint.

Each milestone is independently shippable behind the new URL; existing pages untouched.

---

## 11. Decisions needed for your approval

1. **URL** — go with `/b3/people-manager`.
2. **Plain members** — see a read-only directory of their orgs' people.
3. **Permission matrix for org admins** — v1 keeps the matrix **SuperUser-only** (reuse as-is). We can look into additional scoping in the future.
4. **Cross-org membership by org admins** — An admin manages memberships only in orgs they administer (via `x-org-id`); "add this person to org X" stays SU-only.
5. **Email change** — SU-only in v1 (Implement verified-change flow in a future iteration).
6. **Bulk** — v1 uses client-side fan-out but we need to be able to individually assign to orgs/projects.
7. **Last-owner protection** — harden into a server block now.
8. **Relationship to existing pages** — coexist now (confirmed). We want a stated intent to replace `/b3/people` + `/b3/superuser/people` with this. Those pages should get a "go to the new people manager" button.

---

## 12. Risks & rough edges (surfaced during research)

- **No multi-org list today** — M1 is genuinely new code (and the security tests around visibility scoping are the highest-risk part).
- **`x-org-id` reuse** depends on browser/session auth; correct for the SPA, but any future API-key-driven automation of v2 would need different plumbing (non-SU keys ignore `x-org-id`).
- **Two parallel authz systems** (rank vs. resolver) — v2 leans on the server to reconcile; the UI must not present a control the server will reject under `on`.
- **Existing debt this cleans up:** duplicated reset-password dialog, triplicated show-once secret, dead force-password-change header stub, blank CSV `projects_count`, SU console "Permissions → Users" dead stub.
- **Doc to keep current:** when M1 adds the new endpoint and any tools, update `docs/reference/mcp-endpoint-mapping.md` per its maintenance rule.

---

## 13. Reuse inventory (quick reference)

**Backend (reuse via `x-org-id`):** all `/org/members/:userId/*`; `/org/members/invite` (+ `project_ids`) and `/org/members/invite/bulk` (+ batch `default_project_ids` / per-row `project_ids` — already supports invite-time project assignment); SU `/superuser/users/*` + `/superuser/permissions/*` (SU paths). Services: `checkRankAbove`, `getMembershipRole`, `resolveUserOrgRole(s)`, `listOrgsUserBelongsTo`, `listOrgsAdministeredBy`, `getOrgMemberCounts`, `listOrgMembers`, `listUsers`, `softDeleteUser`, `checkAdminDeletionEligibility`.
**Frontend:** `peopleApi`, `superuserUsersApi`, `superuserPermissionsApi`, `UserPermissionsTab` + group editor, `runBulk` + toolbar, `lib/csv.ts`, `useCan`, common component kit, the existing invite/import/add-projects/create-api-key dialogs.
**New:** `GET /people` (scoped list + caps) service+route+tests; `pages/people-manager/{index,detail}.tsx`; `lib/api/people-manager.ts`; extracted `<ResetPasswordDialog>` / `<RevealOnceSecret>` / `<BulkActionBar>`.
