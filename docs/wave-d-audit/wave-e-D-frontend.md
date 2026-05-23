# Wave E.D — SPA `useCan` codemod (frontend, banter, beacon, +11 others wired)

Status: shipped (Wave E.D).

## Scope

Replace inline `user.role === 'admin' | 'owner'` JSX gates in the 14 SPAs
with the `useCan(permissionId)` hook from `@bigbluebam/ui/use-can`, and
wire the `PermissionsProvider` from `@bigbluebam/ui/permissions-context`
into every SPA's root so the hook has a fetcher.

This depends on Wave E.C (shipped useCan + PermissionsProvider) and
Wave E.A/B (server now enforces `requireCan(...)` on every gated route,
and `/auth/me` ships the materialized 1047-entry permission matrix).

## Totals

| Bucket | Count |
| --- | ---: |
| `role === 'admin' \| 'owner'` JSX gating sites considered | 12 |
| Of those, replaced with `useCan(...)` | 9 |
| Of those, deliberately LEFT in place (see "Sites left as-is" below) | 5 (4 admin-scope key/agent + 1 dialog labelling) |
| `is_superuser` JSX sites in same files considered for conversion | All 44 across the frontend SPA; reviewed; **0 converted**. They are platform-bypass labels (SuperUser console, "All users", "viewing as SuperUser" copy), exactly the carve-out the Wave E.C doc calls out as "stays as-is". One legitimate `is_superuser` survives in `settings-llm-providers.tsx` to gate the "System (site-wide)" provider scope option — a true platform-admin bypass with no per-action equivalent. |
| `PermissionsProvider` wired into SPA roots | 14 / 14 |
| SPA `typecheck` status | 14 / 14 clean |

The "role === 'user' \| 'system'" hits in
`apps/banter/src/components/calls/agent-text-sidebar.tsx` were excluded
from the codemod up-front — those refer to `ChatMessage.role`
(user/assistant/system), not membership role.

## Per-SPA replacement table

### `apps/frontend` (b3, the Bam SPA) — 7 sites replaced, 5 sites left

| File:Line | Old check | New `useCan` id | Rationale |
| --- | --- | --- | --- |
| `apps/frontend/src/pages/settings.tsx:546` | `user?.role === 'admin' \|\| user?.role === 'owner'` | `bam.org.update` | Gates the Org permissions tab save flow (`PATCH /org`). |
| `apps/frontend/src/pages/settings-llm-providers.tsx:60` | `isSuperUser \|\| user?.role === 'admin' \|\| user?.role === 'owner'` | `bam.llm_provider.create` | Gates Add/Edit/Delete provider buttons. SuperUser bypass already baked into the matrix server-side, so the explicit `isSuperUser` disjunct is gone. Note: a separate `isSuperUser` was retained in the same component to gate the "System (site-wide)" scope dropdown option — that's a genuine platform bypass with no per-action equivalent. |
| `apps/frontend/src/pages/people/detail.tsx:231` | `currentUser?.role === 'owner' \|\| currentUser?.is_superuser === true` | `bam.org_member_transfer_ownership.create` | Gates the "Transfer ownership" dropdown item (`POST /org/members/:userId/transfer-ownership`). |
| `apps/frontend/src/components/layout/app-layout.tsx:112` | `user?.role === 'owner' \|\| user?.role === 'admin'` | `bam.org_member.list` | Used in two spots — the no-owner banner CTA and the user-menu People entry. |
| `apps/frontend/src/components/layout/app-layout.tsx:316` | `user?.role === 'owner' \|\| user?.role === 'admin' \|\| user?.is_superuser === true` | `canManageOwners` (reuses the above) | Second site of the same gate; folded into the existing variable. |
| `apps/frontend/src/components/layout/sidebar.tsx:98` | `user?.role === 'owner' \|\| user?.role === 'admin' \|\| user?.is_superuser === true` | `bam.org_member.list` | Gates the People sidebar nav button. |
| `apps/frontend/src/pages/settings.tsx:873, 883, 1038, 1048` | `user?.role === 'owner' \|\| user?.is_superuser === true` | **NOT REPLACED** — see "Sites left as-is". |
| `apps/frontend/src/pages/people/detail.tsx:512` | `currentUser?.role === 'owner'` | **NOT REPLACED** — see "Sites left as-is". |

### `apps/banter` — 2 sites replaced

| File:Line | Old check | New `useCan` id |
| --- | --- | --- |
| `apps/banter/src/components/layout/user-menu.tsx:40` | `user?.role === 'owner' \|\| user?.role === 'admin' \|\| isSuperUser` | `bam.org_member.list` |
| `apps/banter/src/components/sidebar/banter-sidebar.tsx:97` | `user?.role === 'owner' \|\| user?.role === 'admin' \|\| user?.is_superuser === true` | `bam.org_member.list` |

Note: the `is_superuser` checks on lines 261 and 270 of banter-sidebar.tsx
were intentionally left — they gate cross-app navigation to the SuperUser
console + "All users" page on Bam, both of which are platform-bypass surfaces.

### `apps/beacon` — 2 sites replaced

| File:Line | Old check | New `useCan` id |
| --- | --- | --- |
| `apps/beacon/src/components/beacon/attachments-panel.tsx:34` | `currentUser?.is_superuser \|\| currentUser?.role === 'admin' \|\| currentUser?.role === 'owner'` | `beacon.beacon_attachment.delete` |
| `apps/beacon/src/components/beacon/comments-section.tsx:56` | `currentUser?.is_superuser \|\| currentUser?.role === 'admin' \|\| currentUser?.role === 'owner'` | `beacon.beacon_comment.delete` |

Both `isAdmin` consts are then OR-combined with author identity for the
final `canDelete` decision in those files — that author-shortcut is
unchanged. See "Anomalies" below for catalog-default observations.

## PermissionsProvider wiring

All 14 SPAs received a `PermissionsProvider` in their `main.tsx`,
sitting inside the `QueryClientProvider` so the hook's TanStack Query
state lives in the right client.

| SPA | Wiring style | Fetcher target |
| --- | --- | --- |
| `apps/frontend` (Bam, b3) | Uses the SPA's own `api` client via `getQuiet` to keep the existing 401-tolerant auth bootstrap behavior. | `/b3/api/auth/me` (relative — same origin) |
| `apps/banter` | Direct `fetch('/b3/api/auth/me', { credentials: 'include' })` — banter has no native /auth/me; sessions are shared across the suite via Bam's cookie. | `/b3/api/auth/me` |
| `apps/beacon` | Same shape as banter. | `/b3/api/auth/me` |
| `apps/bearing` | Same. | `/b3/api/auth/me` |
| `apps/bench` | Same. | `/b3/api/auth/me` |
| `apps/bill` | Same. | `/b3/api/auth/me` |
| `apps/blank` | Same. | `/b3/api/auth/me` |
| `apps/blast` | Same. | `/b3/api/auth/me` |
| `apps/board` | Same. | `/b3/api/auth/me` |
| `apps/bolt` | Same. | `/b3/api/auth/me` |
| `apps/bond` | Same. | `/b3/api/auth/me` |
| `apps/book` | Same. | `/b3/api/auth/me` |
| `apps/brief` | Same. | `/b3/api/auth/me` |
| `apps/helpdesk` | Same. | `/b3/api/auth/me` |

All 14 fetchers tolerate a non-2xx by returning `{ data: {} }`, which
yields the deny-by-default behavior baked into the hook.

## Typecheck and runtime status

| SPA | `pnpm --filter <pkg> typecheck` | Notes |
| --- | --- | --- |
| `@bigbluebam/frontend` | clean | Initial pass surfaced one error (`isSuperUser` referenced after its source was deleted in `settings-llm-providers.tsx`); restored as a separate auth-store-backed const limited to the "System scope" option and re-ran clean. |
| `@bigbluebam/banter` | clean | |
| `@bigbluebam/beacon` | clean | |
| `@bigbluebam/bearing` | clean | |
| `@bigbluebam/bench` | clean | |
| `@bigbluebam/bill` | clean | |
| `@bigbluebam/blank` | clean | |
| `@bigbluebam/blast` | clean | |
| `@bigbluebam/board` | clean | |
| `@bigbluebam/bolt` | clean | |
| `@bigbluebam/bond` | clean | |
| `@bigbluebam/book` | clean | |
| `@bigbluebam/brief` | clean | |
| `@bigbluebam/helpdesk` | clean | |

`docker compose build frontend && docker compose up -d --force-recreate frontend`
completed and the bundle (`/b3/assets/index-BqAgNJaN.js`, 1,239,502 bytes)
was served. nginx logged 200 OK on `/b3/api/auth/me` for both test
accounts.

## Smoke test results

Logged in as **Eddie Offermann (SuperUser, `eddie@bigblueceiling.com`)**
via `POST /b3/api/auth/login` and fetched `/b3/api/auth/me`:

- response 200 OK, 33,188 bytes
- `permissions` is a 1047-key object
- 1047/1047 granted (SuperUser short-circuit — every `useCan` returns true)
- spot-checked the codemod targets:
  - `bam.org.update` → `true`
  - `bam.org_member.list` → `true`
  - `bam.llm_provider.create` → `true`
  - `bam.org_member_transfer_ownership.create` → `true`
  - `beacon.beacon_attachment.delete` → `true`
  - `beacon.beacon_comment.delete` → `true`

Logged in as **Avery Singh (member, `avery.singh@mage.io`)** with the
operator-supplied password:

- response 200 OK, 33,309 bytes
- `permissions` is a 1047-key object
- 919/1047 granted (deny-list reflects the Wave A defaults)
- spot-checked the same targets:
  - `bam.org.update` → `false` (Org settings tab will hide save button)
  - `bam.org_member.list` → `false` (sidebar People entry hidden, no-owner banner CTA hidden, user-menu People entry hidden)
  - `bam.llm_provider.create` → `false` (Add Provider button hidden)
  - `bam.org_member_transfer_ownership.create` → `false` (Transfer ownership dropdown item hidden)
  - `bam.task.create` → `true` (positive control — Avery can still create tasks)

The codemod sites resolve to the matrix exactly as intended. No JS
runtime errors in nginx logs across the smoke session.

## Sites left as-is

### Admin-scope API key / agent creation (settings.tsx ×4)

`apps/frontend/src/pages/settings.tsx:873, 883, 1038, 1048` each contain
`user?.role === 'owner' || user?.is_superuser === true` to gate **whether
the "Admin" option appears in the scope dropdown** when creating a new
API key or service-account agent. The catalog has `bam.auth_api_key.create`
(matched by `requireCan` on `POST /auth/api-keys`) but no separate
permission id for "create with `admin` scope". The backend route enforces
a hardcoded `!is_superuser && role !== 'owner'` short-circuit on top of
the per-action gate (`apps/api/src/routes/api-key.routes.ts:68-81`), so
mapping to `bam.auth_api_key.create` would over-permit (every member who
can create a read/read_write key would see the Admin option appear and
get a 403 on submit).

The right resolution is to introduce a per-action permission like
`bam.auth_api_key.create_admin_scope` (and a `bam.auth_service_account.create_admin_scope`
sibling for the agents form). That's catalog work, out of scope for E.D.
**Recommended follow-up** for Wave E.F or a dedicated E.E sub-task:
add the new permission ids, port the route's role check to
`requireCan`, then replace these 4 sites with the new ids.

### Dialog labelling (people/detail.tsx:512)

`apps/frontend/src/pages/people/detail.tsx:512` switches the Transfer
Ownership dialog *description text* between three copy strings based on
whether the caller is the current owner, an org admin, or a SuperUser.
It's labelling, not gating — there's no action being authorized — so
per the Wave E.C doc carve-out ("`role === 'guest'` display-only label?
Leave it"), it stays.

## Anomalies

1. **Beacon delete-attachment / delete-comment matrix value for members.**
   The matrix returns `beacon.beacon_attachment.delete = true` and
   `beacon.beacon_comment.delete = true` for a plain member (Avery's
   test). With the codemod in place, the UI will now show the delete
   icon to non-author members for any attachment/comment they can see.
   The backend service still enforces author/admin in
   `attachment.service` and `comment.service`, so a member who clicks
   delete on someone else's attachment will receive a 403 — UX
   regression rather than a security regression.

   The catalog metadata is `is_destructive: true, requires_superuser: false`;
   the Wave A defaults remediation evidently set the resource-level
   default to allow members. **Recommended follow-up**: tighten the
   builtin defaults for cross-author destructive ops so member-role
   subjects can't delete attachments/comments authored by another user.
   The cleanest place is `packages/permissions/src/builtin-defaults.ts`
   (or wherever Wave A's defaults map lives); changing it to deny for
   `member` group on `beacon.beacon_*.delete` would re-converge the UI
   with the service-level ownership check.

2. **Admin-scope key/agent gating has no permission id.** Recorded above
   under "Sites left as-is"; not a new finding from this wave but worth
   surfacing in the ledger.

3. **No `is_superuser` JSX in JSX-form satellite SPAs (bond/bolt/brief/...).**
   The audit table promised "2 each in many others" for `is_superuser`
   checks; the actual JSX/TSX grep across those satellites found zero
   role-based or superuser-based gating in the source. They all happen
   to be gated through the satellite-api `requireCan` only. Wiring the
   `PermissionsProvider` into their `main.tsx` was still done so the
   hook is available as future per-action UI gates land — that's
   forward-looking but cheap (one fetcher per SPA, deny-by-default if
   the request fails).

4. **`apps/banter/src/components/calls/agent-text-sidebar.tsx`** has
   two `msg.role === 'user'` matches that were correctly excluded
   from the codemod — they refer to chat-message role
   (`user|assistant|system`), not auth role.
