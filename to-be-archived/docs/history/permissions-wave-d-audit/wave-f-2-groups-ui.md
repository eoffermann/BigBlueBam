# Wave F.2 — SuperUser group editor UI

Status: frontend implementation complete; depends on Wave F.1/F.4 backend
endpoints for live behavior. Implementation follows the canonical API
contract in `wave-f-api-contract.md` §1, §2.

## Files created

| Path | Purpose |
| --- | --- |
| `apps/frontend/src/lib/api/superuser-permissions.ts` | Typed client for `/superuser/permissions/*` — catalog browse, group CRUD, defaults set/reset. (Wave F.3 user-permission types and methods were appended by the F.3 agent in parallel; both layers coexist in this file.) |
| `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` | Sortable table of all groups (built-in + custom). New Group modal with name/description/scope and optional clone-from selector. Built-ins show a BUILT-IN badge and the Delete button is hidden. |
| `apps/frontend/src/pages/superuser/permissions/group-detail.tsx` | Two-column editor: collapsible app → resource tree on the left; per-permission rows with toggles on the right. Dirty-state tracking, bulk grant/deny via glob input, batched `PUT /defaults` on save, `POST /reset` with confirmation modal, editable name/description (gated for built-ins). Search box + app/resource filter keep visible row count manageable; defers virtualization in favor of selective rendering since most operators work one app at a time. |
| `docs/wave-d-audit/wave-f-2-groups-ui.md` | This report. |

## Files modified

| Path | Change |
| --- | --- |
| `apps/frontend/src/pages/superuser/index.tsx` | Added `PermissionsTab` wrapper component with three sub-tab buttons (Groups / Users / Divergences). The existing `PermissionsDivergencesPage` now renders under the Divergences sub-tab (not deleted or modified). Groups sub-tab renders the new `PermissionsGroupsListPage`. Users sub-tab is a stub placeholder for Wave F.3. The top-level `Permissions` tab kept its name and slot in the tab strip. |
| `apps/frontend/src/app.tsx` | Added route `/superuser/permissions/groups/:id` → `PermissionsGroupDetailLayout` (inline wrapper providing the standard SuperUser console chrome — back button, shield badge). Added route discriminator `superuser-permissions-group-detail`. |

## Routes added

- `/b3/superuser` → opens the SuperUser console. Click **Permissions** tab → defaults to the **Groups** sub-tab (list).
- `/b3/superuser/permissions/groups/:id` → group detail editor (deep-linkable).

The groups list is **not** at its own URL; it lives inside the parent
SuperUser shell as a sub-tab so that switching between Groups / Users /
Divergences stays a single page transition. The detail page is its own
URL so an operator can deep-link to a specific group from audit logs etc.

## Typecheck

```
$ pnpm --filter @bigbluebam/frontend typecheck
> tsc --noEmit
(no errors)
```

Clean. One transient error on `user-permissions-tab.tsx:446:9` (F.3
territory) cleared on the second run — appears to have been a stale build
from a parallel edit.

## Build + deploy

```
$ docker compose build frontend
... bigbluebam-frontend Built

$ docker compose up -d --force-recreate frontend
... Container bigbluebam-frontend-1  Started

$ sleep 6 && docker compose restart frontend
... Container bigbluebam-frontend-1  Started
```

## Smoke results

API endpoint probes (logged in as eddie / SU):

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /superuser/permissions/catalog` | 200 | Returns the full catalog with 1047-ish permissions. The F.1 work for the catalog endpoint has landed. |
| `GET /superuser/permissions/groups` | **404** | Not yet implemented. Wave F.1/F.4 owes this endpoint. The frontend handles the failure with a styled error row in the table; no crash. |
| `GET /superuser/permissions/divergences/summary` | 200 | Existing endpoint still works under the new Divergences sub-tab. |

UI smoke (described, no screenshots harness):

1. Navigate to `/b3/superuser` → SuperUser Console renders. Click **Permissions** tab.
2. Three sub-tab pills appear: Groups (default selected), Users, Divergences.
3. **Groups** sub-tab renders the page chrome (heading "Permission groups", "New Group" button, sortable table). Until F.1/F.4 lands the groups endpoint, the table shows the error row: "Failed to load groups: Route GET /superuser/permissions/groups not found".
4. **Users** sub-tab shows the F.3 stub: dashed border with "User permissions editor lands in Wave F.3" placeholder.
5. **Divergences** sub-tab renders the unmodified `PermissionsDivergencesPage` — divergence summary table populated from the existing log.
6. Group detail page (manually navigating to `/b3/superuser/permissions/groups/<uuid>`) shows the SU console chrome + back button + the two-column editor; loads via `groupQuery` (which will 404 until backend ships) and falls back to the styled error card with a Back button.

When the backend endpoints land, the operator flow will be:

- **Groups list:** all 5 built-ins (Owner, Admin, Member, Viewer, Guest) appear with their member counts, grant/deny counts, and a BUILT-IN badge. Click any row → group detail.
- **Group detail:** for the Member group, the left tree expands to show all 17 apps with their permission counts; right pane lists every permission with a green toggle for grants, gray for denies. Toggle counter ("47 changes pending") appears as soon as any toggle differs from the original default.
- **Bulk:** entering `bam.task.*` and clicking Grant flips all 17 matching perms to allow; Deny does the opposite. Diff counter updates live.
- **Save:** click "Save Changes" → `PUT /defaults` with `set_true` + `set_false` arrays. On success the query invalidates and the new counts render.
- **Reset:** "Reset to defaults" button → confirmation modal → `POST /reset`.
- **Create custom:** "New Group" modal accepts name, description, scope (global / org / project), scope ID (if applicable), and optional clone-from selector pre-populated with every live group.
- **Delete:** trash icon on non-built-in rows opens a confirmation dialog; 409 responses surface inline in the dialog.

## Anomalies / notes for F.4

1. **Backend endpoint not live yet.** `GET /superuser/permissions/groups` returns 404 in the current container build. The catalog endpoint works, divergences endpoint works, but the group CRUD surface (`/groups`, `/groups/:id`, `/groups/:id/defaults`, `/groups/:id/reset`) is missing. Once F.4 lands these, no frontend changes are needed — the queries will just succeed.
2. **`scope_id` create-group input is a raw UUID input.** Operator UX for picking an org/project ID is intentionally minimal because the design doc declares project-scope group CRUD editing out of scope. If F.4 decides to surface org-scope groups in the UI, this dialog should swap the freeform input for a dropdown sourced from `/superuser/organizations`.
3. **No virtualization.** The 1047-permission catalog is rendered via app/resource filter (the right pane shows at most the perms for one app, ≈100-150 rows). This is fine for current scale; if the catalog grows past ~5k rows, swap the right pane for `react-window`.
4. **Render of "save header" vs "save defaults".** The header edits (name/description) and the defaults edits use separate mutations and separate Save buttons. Combining them would require backend support for a single PATCH that accepts both, which is not in the contract. Keeping them separate matches the contract exactly.
5. **`api.delete` body argument.** The Wave F.3 client uses `api.delete(path, body)` with a body argument that the original `api.delete` signature lacked. The F.3 agent appended `body?: unknown` to the `delete` method in `lib/api.ts`. My code does not depend on this change, but call it out so the F.4 code review notices both deltas landed together.
6. **No URL persistence of sub-tab.** Sub-tab state (`groups | users | divergences`) is local React state. Switching sub-tabs does not change the URL. The page-detail view is URL-routed (deep-linkable). This matches the design-doc suggestion ("Sub-tab state can be local to the parent component or in the URL — your call.").

## Out of scope (deferred to F.4 / future)

- Project-scope group editor surfacing (contract calls this out as out of scope for the UI).
- Glob editing UI for sub-resource patterns — the current implementation expands globs to explicit IDs at save time.
- Audit-log dashboard for permission changes.
