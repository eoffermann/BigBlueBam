# Wave F.3 — SuperUser per-user permissions UI

Scope: add a "Permissions" tab to the existing `/b3/superuser/people/:id` page
covering group memberships, explicit overrides, and the full effective-matrix
browser. Backend contract is `docs/wave-d-audit/wave-f-api-contract.md` §3.

## Files

- `apps/frontend/src/components/superuser/user-permissions-tab.tsx` — new
  component with all three sections (memberships, overrides, effective matrix).
  ~580 LOC, no per-row virtualization; lazy-renders accordion sections by app
  namespace and runs a single client-side filter pass on each keystroke.
- `apps/frontend/src/lib/api/superuser-permissions.ts` — extended with
  `getUserPermissions`, `setUserMembership`, `setUserOverride`,
  `clearUserOverride`, `reattachUser`, plus the F.3 type surface
  (`UserPermissionsResponse`, `UserMembership`, `UserOverride`,
  `EffectiveEntry`, `EffectiveSource`, `ScopeRef`, etc.).
- `apps/frontend/src/lib/api.ts` — `ApiClient.delete` now takes an optional
  `body` argument. The clear-override endpoint requires
  `{ scope_type, scope_id }` in the DELETE body per the contract.
- `apps/frontend/src/pages/superuser/people-detail.tsx` — new
  `'permissions'` member in `DetailTab`, new `TabButton`, and a
  `<UserPermissionsTab userId={userId} />` render branch.

### Incidental pre-existing fix

`apps/frontend/src/app.tsx` had a stale reference to a
`SuperuserPermissionsGroupDetailLayout` identifier from F.2 work in
progress; the typo was that the layout was defined further down the file
but typecheck cached an old order. Verified by running typecheck twice —
the second run resolved cleanly without editing app.tsx beyond a brief
detour. No app.tsx change is part of this commit.

## Design notes

- Section 1 (memberships) renders one `<li>` per membership scope. The
  group dropdown is populated from `listGroups()` filtered by
  `scope_type` and (when set) `scope_id`. The currently-assigned group
  is always selectable even if the listGroups query is still loading or
  filters it out, so the dropdown never shows a misleading "select…"
  while a real membership is in place.
- Section 2 (overrides) is a table. Snapshot rows get a `(snapshot)`
  hint next to the permission id (per the contract, these are the
  auto-frozen rows the detach trigger writes on first override).
- Section 3 (effective matrix) groups rows by `app` namespace and
  lazy-renders the open accordion sections only. With ~1047 perms and
  ~14 apps the average open-section body is ~75 rows, well under the
  size where virtualization would be worth it. Filter input keeps a
  single-pass `toLowerCase().includes(...)` over `id` + `description`.
- Toggle semantics:
  - `source='superuser_bypass'` → disabled with a tooltip explaining
    SU bypass is a global flag.
  - `source='group_default'` / `'implicit_deny'` → click writes the
    inverse override via `PUT /overrides/:permission_id` with notes
    "Manually allowed/denied via SuperUser console".
  - `source='override'` / `'snapshot'` → click clears the override via
    `DELETE /overrides/:permission_id`, falling back to whatever the
    group default emits.
- Override writes need a scope. The matrix UI picks a primary scope by
  preferring `org` > `global` > `project`. The chosen scope is surfaced
  in the section header so the operator knows where overrides land
  before clicking. Multi-scope writes (override at multiple scopes from
  one click) are out of scope for F.3.
- Optimistic update on toggle clicks updates `effective_matrix` in
  TanStack Query cache immediately so the row flips before the round
  trip; we invalidate on settle so the authoritative
  `source`/`granted` from the resolver lands. On error we restore the
  previous cache snapshot.

## Verification

- `pnpm --filter @bigbluebam/frontend typecheck` — clean.
- `pnpm --filter @bigbluebam/frontend build` — clean (vite, 7.87s).
- `docker compose build frontend && docker compose up -d
  --force-recreate frontend` — image rebuilt and re-started.

### Manual smoke (operator action required)

I could not authenticate as a SuperUser inside the sandbox (passwords
unknown), so the manual smoke checklist below is for the human reviewer.
Once logged in as `eddie@bigblueceiling.com` (id confirmed SU in DB):

1. Open `/b3/superuser/people` and click **Avery Singh**
   (`969d36a7-a10d-4a64-99dc-f2a95fe2b038`).
2. Click the **Permissions** tab.
3. Expected initial state per the spec:
   - Org membership row "Org: …" with group "Member", no detached
     badge, no Reattach button.
   - Overrides section empty.
   - Effective matrix header reads roughly "919 of 1047 permissions
     allowed" with a search box and accordion grouped by app.
4. Expand the `bam` accordion, find `bam.audit_log.list`, click the red
   "Denied" pill — it flips to "Allowed" with source badge
   `override`, and a new row appears in the Overrides section.
5. Find `bam.task.create`, click the green "Allowed" pill — it flips to
   "Denied" with source badge `override`; second override row appears.
6. Click **Reattach** on the org membership row. Both override rows
   disappear and the matrix recomputes (badges return to `group`).
7. Change the group dropdown from `Member` to `Viewer`. The matrix
   re-runs; the allowed-count drops dramatically (expected ~410).

If any of steps 3-7 fail with a 404 / 500 from the API, that's an F.4
backend follow-up — note it in the F.4 tracker.

## Anomalies / sharp edges

- The contract example response includes `scope_name` on memberships /
  overrides; if F.1's backend does not return it, the UI falls back to
  the first 8 chars of `scope_id` (e.g. `01970a3b`). Worth tightening
  in F.1.a if the backend adds it.
- F.2's "Users" sub-tab placeholder at
  `/b3/superuser/permissions/users` is still the F.2 stub — per the
  task brief, the people-detail page is the primary entry point.
  F.2 can convert the placeholder to a user-picker that links to
  `/b3/superuser/people/:id?tab=permissions` whenever they get there.
- `ApiClient.delete(path, body?)` is a soft signature widening — every
  existing call site (org delete, membership delete, etc.) keeps
  working without changes.
- Tests: the frontend codebase has no Vitest component tests today
  (`apps/frontend/src/**/*.test.*` returns zero files), so manual
  smoke is the path forward, per the task brief.

## Summary

Implemented the Wave F.3 SuperUser per-user permissions editor as a new
"Permissions" tab inside the existing `/b3/superuser/people/:id` page.
The tab renders three sections: a memberships list (with per-scope
group dropdown and Reattach button), an explicit-overrides table (with
remove button and snapshot hint), and an effective-matrix browser
(accordion grouped by app, source badge per row, per-row toggle with
optimistic updates and SuperUser-bypass disable). Wired the new
endpoints (`getUserPermissions`, `setUserMembership`, `setUserOverride`,
`clearUserOverride`, `reattachUser`) into the existing
`superuserPermissionsApi`, and added a `body` parameter to
`ApiClient.delete` so the DELETE-with-body shape from §3 of the
contract works. Frontend typechecks and builds clean; the
container has been rebuilt and is up. Manual smoke as the SU user is
the remaining verification step — checklist included above.
