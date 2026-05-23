# Wave F — permissions editor API contract

_Stable interface spec for parallel backend + frontend agents. All endpoints under `/superuser/permissions/*` and gated by SuperUser (resolver short-circuit at step 1)._

All endpoints require `requireAuth` + `fastify.requireCan('bam.superuser_permission_<resource>.<verb>')` for the relevant catalog permission. If the permission doesn't exist in the catalog yet, the F.1 agent adds it via the delta migration mechanism.

All responses follow the standard envelope `{ data: T }` or `{ error: { code, message, details, request_id } }`.

## 1. Catalog browse

### `GET /superuser/permissions/catalog`

List or filter the static action catalog. Always-read-allowed for SuperUser.

**Query params**:
- `app` (string, optional) — filter by app namespace (`bam`, `banter`, `platform`, etc.)
- `resource` (string, optional) — filter by resource name
- `search` (string, optional) — substring match on permission `id` or `description`
- `is_destructive` (boolean, optional)
- `is_read` (boolean, optional)
- `requires_superuser` (boolean, optional)
- `limit` (number, default 200, max 2000)
- `cursor` (string, optional) — opaque continuation

**Response**:
```json
{ "data": {
    "items": [
      { "id": "bam.task.create", "app": "bam", "resource": "task", "verb": "create",
        "description": "...", "is_destructive": false, "is_read": false,
        "requires_confirmation": false, "requires_superuser": false }
    ],
    "next_cursor": "...|null",
    "total": 1047
  }
}
```

## 2. Group CRUD

### `GET /superuser/permissions/groups`

List all permission_groups (built-in + custom). Soft-deleted hidden by default.

**Query params**:
- `scope_type` (string, optional) — `global` | `org` | `project`
- `include_deleted` (boolean, default false)

**Response**:
```json
{ "data": [
    { "id": "11111111-...", "name": "Owner", "description": "...",
      "scope_type": "global", "scope_id": null,
      "is_builtin": true, "legacy_role": "owner",
      "created_by": "...|null", "created_at": "...", "updated_at": "...",
      "deleted_at": null,
      "member_count": 0,         // count of account_group_memberships where group_id = this
      "grant_count": 1020,       // count of permission_group_defaults where granted=true
      "deny_count": 27 }
  ]
}
```

### `POST /superuser/permissions/groups`

Create a custom group. `is_builtin = false` always. `legacy_role` always NULL.

**Body**:
```json
{ "name": "Channel Moderator", "description": "Can manage one banter channel",
  "scope_type": "project", "scope_id": "..." }
```

Validation:
- `name`: required, 1-100 chars, unique per (scope_type, scope_id) where deleted_at IS NULL
- `scope_type` in `('global', 'org', 'project')`
- `scope_id`: NULL if global, required for org/project
- For `scope_type='org'`, scope_id must be an org the SU has visibility into (always true for SU)
- For `scope_type='project'`, scope_id must be a project that exists

**Response**: created group row.

### `GET /superuser/permissions/groups/:id`

Group detail including FULL permission defaults map.

**Response**:
```json
{ "data": {
    "group": { ...as above... },
    "defaults": {
      "bam.task.create": true,
      "bam.task.delete": false,
      ...
    },
    "member_count": 17
  }
}
```

The `defaults` object includes EVERY permission in the catalog. Missing keys are not allowed — every catalog id is present with `true` or `false`. For built-in groups this is just the existing `permission_group_defaults` rows. For freshly-created custom groups the defaults are computed: copy from a sensible base group (default: Member's defaults) — the create flow can optionally take a `clone_from_group_id` param if specified.

### `PATCH /superuser/permissions/groups/:id`

Edit a group's name/description. Cannot change scope or builtin-ness.

**Body**:
```json
{ "name": "...", "description": "..." }
```

Validation: built-in groups can have description edited but NOT name (built-in name maps to legacy_role for UI rendering).

### `DELETE /superuser/permissions/groups/:id`

Soft-delete a custom group. Returns 409 if any live (detached_at IS NULL) memberships still reference it — the operator must reassign first. Built-in groups cannot be deleted (returns 422).

### `PUT /superuser/permissions/groups/:id/defaults`

Bulk-replace defaults for one group. Accepts both explicit permission IDs and glob patterns.

**Body**:
```json
{ "set_true": ["bam.task.create", "bam.task.update", "banter.message.*"],
  "set_false": ["bam.audit_log.*", "platform.org.delete"],
  "reset_to_builtin": false }
```

Semantics:
- Glob `<app>.<resource>.*` expands to every catalog row matching that prefix
- Glob `<app>.*` matches every row in the app
- Explicit IDs not in the catalog return 422 with the offending ids
- `set_true` and `set_false` must not overlap after expansion (422)
- Any catalog id not mentioned in either list is **left unchanged**
- For built-in groups, the operation is allowed but bumps `updated_at`
- If `reset_to_builtin = true`, ignore set_true/set_false and instead recompute defaults from the original Wave A seed logic (see "Reset semantics" below)

**Response**:
```json
{ "data": { "group_id": "...", "changed": 47, "now_granted": 920, "now_denied": 127 } }
```

After the write, fire a Redis pubsub invalidation on `perms:invalidate:group:<group_id>` so every replica drops cached PermissionContexts that join through this group.

### `POST /superuser/permissions/groups/:id/reset`

Reset a built-in group to the migration-seeded defaults (the post-0156/0157/0158 state). For custom groups, resets to the group's clone-source's current defaults (or Member's defaults if no clone source).

**Response**: same shape as `PUT /defaults`.

## 3. User permissions

### `GET /superuser/permissions/users/:id`

A user's complete permission picture: group at each scope, every explicit override.

**Response**:
```json
{ "data": {
    "user": { "id": "...", "email": "...", "display_name": "...",
              "is_superuser": false, "kind": "human" },
    "memberships": [
      { "scope_type": "org", "scope_id": "...",
        "group": { "id": "...", "name": "Member", "legacy_role": "member", "is_builtin": true },
        "detached_at": null,
        "detached_by": null }
    ],
    "overrides": [
      { "scope_type": "org", "scope_id": "...",
        "permission_id": "bam.audit_log.list",
        "granted": true,
        "is_snapshot": false,
        "set_by": "...", "set_at": "...",
        "notes": "Granted for compliance review 2026-05-22" }
    ],
    "effective_matrix": {
      "bam.task.create": { "granted": true, "source": "group_default", "group_id": "..." },
      "bam.audit_log.list": { "granted": true, "source": "override", "set_by": "..." },
      ...
    }
  }
}
```

The `effective_matrix` is computed by running the resolver for every catalog permission at the user's primary org scope. `source` is one of: `superuser_bypass` (only when is_superuser=true), `group_default`, `override`, `implicit_deny`.

### `PUT /superuser/permissions/users/:id/membership`

Assign a user to a group at a scope. Inserts or updates `account_group_memberships`. Resets `detached_at` to NULL (re-attaches the membership).

**Body**:
```json
{ "scope_type": "org", "scope_id": "...", "group_id": "..." }
```

Validation:
- `group.scope_type` must equal `scope_type` (can't assign a project-scope group to an org scope, etc.)
- For `scope_type='org'`, `scope_id` must be an org the target user is a member of
- Cannot assign a soft-deleted group

**Response**: updated membership row.

### `PUT /superuser/permissions/users/:id/overrides/:permission_id`

Set an explicit grant/deny override on a single permission at a given scope. Fires the existing detach trigger (snapshots group defaults + stamps detached_at on first override).

**Body**:
```json
{ "scope_type": "org", "scope_id": "...", "granted": true, "notes": "..." }
```

**Response**: created/updated account_permissions row + updated effective_matrix entry.

### `DELETE /superuser/permissions/users/:id/overrides/:permission_id`

Remove one explicit override. If it was the only override at that scope, the user is NOT auto-reattached (use the `reattach` endpoint for that) — detached_at stays set, and the user retains all the auto-snapshot rows.

**Body**:
```json
{ "scope_type": "org", "scope_id": "..." }
```

### `POST /superuser/permissions/users/:id/reattach`

Drop ALL overrides (both explicit and is_snapshot) at a scope and clear `detached_at`. The user becomes live-attached to their current group again — group default edits will start propagating.

**Body**:
```json
{ "scope_type": "org", "scope_id": "..." }
```

**Response**: `{ data: { dropped_overrides: 47 } }`

## Auth + RLS

- All routes preHandler: `[requireAuth, fastify.requireCan('bam.superuser_permission_admin.<verb>')]` (one umbrella permission for the whole admin surface — to be added to catalog by F.1.a). The resolver enforces SU bypass at step 1, so non-SU users hit `PERMISSION_DENIED`.
- RLS: the permission tables already have RLS policies from migration 0144 that respect `app.current_org_id`. SuperUser sessions skip RLS via the existing role-flip mechanism. No new RLS work.

## New catalog permissions to add (delta migration in F.1)

```
bam.superuser_permission_catalog.list        is_read=true
bam.superuser_permission_group.list          is_read=true
bam.superuser_permission_group.create        is_destructive=false
bam.superuser_permission_group.get           is_read=true
bam.superuser_permission_group.update        is_destructive=false
bam.superuser_permission_group.delete        is_destructive=true
bam.superuser_permission_group.set_defaults  is_destructive=false
bam.superuser_permission_group.reset         is_destructive=false
bam.superuser_permission_user.get            is_read=true
bam.superuser_permission_user.set_membership is_destructive=false
bam.superuser_permission_user.set_override   is_destructive=false
bam.superuser_permission_user.clear_override is_destructive=true
bam.superuser_permission_user.reattach       is_destructive=true
```

All `requires_superuser: true`.

## Cache invalidation

After every write that changes group defaults, group membership, or per-account overrides:

1. Direct cache eviction in `apps/api/src/services/permissions.service.ts` via the existing `invalidatePermissionsForUser` / `invalidatePermissionsForOrg` helpers.
2. Redis pubsub publish on the existing channels: `perms:invalidate:user:<id>`, `perms:invalidate:org:<id>`, `perms:invalidate:group:<id>`. Subscribers (api replicas, mcp-server) drop their in-process caches.

## Reset semantics (for the `reset` endpoint)

The post-0158 state of `permission_group_defaults` IS the canonical seed. The reset endpoint copies from a stored snapshot. F.1.a should:
- Add a new migration `0160_permissions_baseline_snapshot.sql` that copies the current `permission_group_defaults` rows into a new table `permission_group_defaults_baseline` (same columns plus `snapshot_at`). This becomes the "factory reset" target.
- The `reset` endpoint deletes the group's current defaults and re-inserts from the baseline.

## Frontend URLs

- `/b3/superuser/permissions/groups` — list
- `/b3/superuser/permissions/groups/:id` — detail
- `/b3/superuser/permissions/users/:id` — user permissions tab (or as a tab inside `/b3/superuser/people/:id`)

The existing SuperUser shell at `apps/frontend/src/pages/superuser/index.tsx` uses tab state. F.2 should add a "Permissions" top-level tab in the Console + push the divergence-dashboard into a sub-tab under it.

## Error codes

- `VALIDATION_ERROR` — body schema fails
- `NOT_FOUND` — group/user/permission missing
- `FORBIDDEN_BUILTIN` — attempt to delete/rename a built-in
- `GROUP_HAS_MEMBERS` — attempt to delete a group with live memberships
- `PERMISSION_NOT_IN_CATALOG` — explicit ID not found
- `SCOPE_MISMATCH` — group scope_type doesn't match assignment scope_type
- `PERMISSION_DENIED` — non-SU calling these endpoints

## Out of scope for Wave F

- Project-scope groups beyond CRUD (UI does not need to render project-scope group editor in detail)
- Glob editing UI for sub-resource patterns
- Audit-log dashboard for permission changes (consider for future wave)
