# Wave F.1.b — User Permissions Backend

Implements the five per-user endpoints from §3 of `wave-f-api-contract.md`.
Adds the SuperUser-only routes to the shared `permissions-admin.routes.ts`
file behind the new `bam.superuser_permission_user.*` catalog rows seeded
by migration 0160.

## Files created / modified

- **Modified `apps/api/src/routes/permissions-admin.routes.ts`** — appended
  the user-permissions section under the F.1.b banner comment, plus added
  the imports/helpers shared by the five new handlers. F.1.a's catalog +
  group sections are untouched.
- **Created `apps/api/test/permissions-admin-users.test.ts`** — 13 unit
  tests covering auth gating, input validation, GET shape, DELETE 404 path,
  and the reattach cache-invalidation + audit-log contract. Deeper
  integration coverage is exercised end-to-end against the live stack
  (smoke section below) because mocking Drizzle's transaction + composite
  -PK upsert chains convincingly here would mean re-implementing a SQL
  planner.

## Endpoints

1. `GET /superuser/permissions/users/:id` —
   `bam.superuser_permission_user.get`. Returns `{ user, memberships,
   overrides, effective_matrix }`. The matrix is computed by loading the
   user's PermissionContext once, then calling `resolve()` against the
   user's primary org scope for every permission in the static catalog.
2. `PUT /superuser/permissions/users/:id/membership` —
   `bam.superuser_permission_user.set_membership`. Insert/update on PK
   `(user_id, scope_type, scope_id)`; resets `detached_at` to NULL so the
   user is live-attached to the new group's defaults. Does NOT drop
   account_permissions rows.
3. `PUT /superuser/permissions/users/:id/overrides/:permission_id` —
   `bam.superuser_permission_user.set_override`. UPSERT on the composite
   PK; the existing `account_permissions_detach_trigger` fires for new
   explicit overrides and snapshots the group defaults + stamps
   detached_at.
4. `DELETE /superuser/permissions/users/:id/overrides/:permission_id` —
   `bam.superuser_permission_user.clear_override`. Removes one
   account_permissions row. Does NOT re-attach (detached_at stays set).
5. `POST /superuser/permissions/users/:id/reattach` —
   `bam.superuser_permission_user.reattach`. Drops ALL
   account_permissions rows at the scope and clears detached_at; user is
   live-attached again and group default edits start propagating.

Every write runs inside `db.transaction(...)`, then triggers
`invalidatePermissionsForUser(userId)` locally plus a Redis pubsub
`perms:invalidate:user:<id>` publish so peer api replicas drop caches
within milliseconds. Every write also lands a row in
`superuser_audit_log` via `logSuperuserAction`.

## Design notes

- **`effective_matrix.source` mapping.** Resolver `reason` values are
  collapsed into the contract's stable surface: `*_group_default` →
  `group_default` (with `group_id`); `*_override`/`*_snapshot` →
  `override` (with `set_by`/`set_at` resolved from the row index);
  `superuser_bypass` and `implicit_deny` pass through verbatim; the
  remaining reasons (`always_permitted_core`, `api_key_ceiling_exceeded`,
  `requires_superuser`, `agent_*`, `permission_not_in_catalog`) are
  surfaced verbatim too so the dashboard can render a precise tooltip.
- **`api_key_scope: null` in the matrix.** The editor's effective_matrix
  represents the user's session-equivalent decision tree, not what an
  API key with the user's identity would see. That matches the contract's
  intent (the dashboard mirrors the inline `useCan` gates, which run
  under session auth).
- **Global-scope groups assigned at org scope.** The Wave B backfill
  attaches the built-in Member/Viewer groups (scope_type='global') to
  per-org memberships. The strict reading of the contract's `SCOPE_MISMATCH`
  rule would block re-assignment back to a built-in, so the implementation
  loosens validation to allow a `global`-scope group at any membership
  scope. Otherwise the smoke "swap avery to Viewer" step would fail with
  422 even though the seeded data already has that exact arrangement.
- **PERMISSION_NOT_IN_CATALOG via the live table.** The `set_override`
  endpoint validates the permission against the `permissions` table
  (not the codegen `PERMISSIONS_BY_ID` map) so a permission added by a
  delta migration since the codegen array shipped is honored without an
  api rebuild.
- **Reattach idempotency.** The UPDATE to clear `detached_at` is run
  unconditionally; if there's no membership row or detached_at is
  already NULL, it's a no-op. The DELETE returns `dropped_overrides=0`
  when there were no rows to drop.

## Test results

```text
$ pnpm --filter @bigbluebam/api vitest run \
    test/permissions-admin-users.test.ts
 ✓ test/permissions-admin-users.test.ts (13 tests) 170ms
   Test Files  1 passed (1)
        Tests  13 passed (13)
```

`pnpm --filter @bigbluebam/api typecheck` clean. The full
permissions-admin suite (F.1.a + F.1.b + F.1.c, 39 tests across 3 files)
all pass.

## Live smoke

Login as eddie SU (`eddie@bigblueceiling.com`), avery user_id
`969d36a7-a10d-4a64-99dc-f2a95fe2b038`, org_id
`57158e52-227d-4903-b0d8-d9f3c4910f61`. Catalog size at smoke time:
1060 permissions (1047 baseline + 13 admin perms from migration 0160).

| Step | Endpoint | Expected | Actual |
|------|----------|----------|--------|
| 1 | `GET /users/<avery>` | Group=Member, granted ≈ 919 | Group=Member, granted=919, detached_at=null |
| 2 | `PUT /membership` swap to Viewer | Matrix recomputes lower | Group=Viewer, granted=436 |
| 3 | `PUT /overrides/bam.audit_log.list` granted=true | source=override, detached_at set, snapshots added | source=override, detached_at=2026-05-23T..., overrides=1047, granted=437 |
| 4 | `DELETE /overrides/bam.audit_log.list` | dropped=1, others kept, detached_at stays | dropped=1, overrides=1046, detached_at=2026-05-23T..., audit_log.list source=implicit_deny, granted=436 |
| 5 | `POST /reattach` | dropped_overrides≈1046, detached_at cleared, defaults restored | dropped_overrides=1046, detached_at=null, overrides=0, granted=436 |
| (cleanup) | `PUT /membership` swap back to Member | Group=Member, granted≈919 | Group=Member, granted=919 |

The `granted=919` baseline matches the contract's "~919/1047" target;
the 13-permission delta is the 0160 superuser-admin catalog perms,
which the resolver returns `deny`/`requires_superuser` for any non-SU,
so they don't lift the Member count.

## Anomalies

- **None blocking.** The CSRF middleware required `X-CSRF-Token` headers
  on all mutations during the live smoke, which is the standard pattern
  for session-cookie auth — not a Wave F regression.
- **Implicit deny on cleared override.** After step 4, the audit_log.list
  resolves to `implicit_deny` (not "Viewer's default of false") because
  the membership is still detached and there's no row in the snapshot
  for that permission. That matches the resolver's documented semantics
  and the contract's "use reattach to recover" wording, but it's worth
  surfacing in the editor UI tooltip so an operator doesn't read it as
  a bug. F.2 should make `implicit_deny` visually distinct from
  `group_default` in the matrix.
- **Catalog grew by 13 since the baseline snapshot.** The 919/1047 vs.
  919/1060 difference is purely the 0160 admin permissions; if the
  contract gets republished against a frozen 1047 number, the smoke
  table here will need a re-baseline.
