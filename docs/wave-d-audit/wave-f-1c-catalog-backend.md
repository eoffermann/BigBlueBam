# Wave F.1.c — permission catalog browse backend

## Summary

Added `GET /superuser/permissions/catalog` to a new shared routes file
`apps/api/src/routes/permissions-admin.routes.ts` that will host F.1.a
(group CRUD) and F.1.b (user editor) alongside this catalog browse. Endpoint
queries the `permissions` Drizzle table directly (not the in-memory
`PERMISSIONS` array) so the editor stays consistent with whatever the live
catalog contains. Filters: `app`, `resource`, `search` (substring on id),
`is_destructive`, `is_read`, `requires_superuser`. Cursor pagination uses
the raw permission id as the opaque token; default limit 200, capped at
2000. Gated on `bam.superuser_permission_catalog.list` (already seeded in
the db). Smoke and unit tests pass; the resolver correctly denies non-SU
callers with `requires_superuser` at step 1.

## Files

- `apps/api/src/routes/permissions-admin.routes.ts` — new file. Contains
  the `// ─── Catalog browse section ───` block as the boundary marker for
  F.1.a and F.1.b to add their endpoints in the same plugin.
- `apps/api/src/server.ts` — register the new plugin alongside the existing
  permissions-divergences plugin.
- `apps/api/test/permissions-admin-catalog.test.ts` — new file. Eight
  tests covering access control, no-filter pagination, and each filter.

## Test results

```
$ pnpm --filter @bigbluebam/api test -- permissions-admin-catalog
 ✓ test/permissions-admin-catalog.test.ts (8 tests) 157ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Full api suite (29 files, 426 tests) also still passes — no regressions
from the new file.

## Typecheck

`pnpm --filter @bigbluebam/api typecheck` is clean for my own file as
authored. See the **Anomaly** section below — the file is being modified
in parallel by another agent (F.1.a or F.1.b), which has introduced a
transient set of unused-imports + a `INVALIDATION_CHANNELS` symbol that
isn't in the package's built `.d.ts`. That parallel work needs its own
follow-up (or a package rebuild) to fully typecheck cleanly. My catalog
endpoint code itself compiles in isolation.

## Smoke (against running stack)

Authenticated as `eddie@bigblueceiling.com` (SuperUser) via an active
session cookie:

```
$ curl -sk -b "session=$SESSION" \
    "https://localhost/b3/api/superuser/permissions/catalog?app=bam&limit=10"
{"data":{"items":[
  {"id":"bam.account.view","app":"bam","resource":"account","verb":"view",...},
  {"id":"bam.activity_unified.list","app":"bam",...},
  ... (10 rows) ...
]}}
```

Filter behavior verified:

| Filter                             | Total | Page Size | Notes                                        |
|------------------------------------|-------|-----------|----------------------------------------------|
| (none, default limit)              | 1060  | 200       | `next_cursor` present                        |
| `app=bam&limit=3`                  | 261   | 3         | every item has `app === "bam"`               |
| `search=task&limit=5`              | 37    | 5         | every id contains substring `task`           |
| `is_destructive=true&limit=5`      | 106   | 5         | every item has `is_destructive: true`        |

Authenticated as `avery.singh@mage.io` (non-SU):

```
$ curl -sk -b "session=$AVERY_SESSION" \
    "https://localhost/b3/api/superuser/permissions/catalog?limit=2" -w "%{http_code}"
{"error":{"code":"PERMISSION_DENIED",
  "message":"Permission denied: bam.superuser_permission_catalog.list",
  "details":[{"permission_id":"bam.superuser_permission_catalog.list",
              "reason":"requires_superuser"}]}}
HTTP: 403
```

Non-SU correctly hits the resolver's step 1 `requires_superuser` deny,
since the new perm is seeded with `requires_superuser=true`.

## Anomalies

1. **Shared file is being co-edited in real time.** Multiple `system-reminder`
   notes flagged that another agent (presumably F.1.a or F.1.b running in
   parallel) is injecting imports for group/user schema tables,
   `INVALIDATION_CHANNELS`, helper functions, etc. The system reminders
   explicitly say "this change was intentional, do not revert", so I have
   left the imports in place where they don't break my section. However at
   the time of last write, the file's import block referenced
   `INVALIDATION_CHANNELS` from `@bigbluebam/permissions`, which exists in
   the package source but is **not exported in the built `.d.ts`**:

   ```
   $ grep INVALIDATION_CHANNELS packages/permissions/dist/index.d.ts
   (no match)
   ```

   The parallel agent owning that import needs to either rebuild
   `@bigbluebam/permissions` (`pnpm --filter @bigbluebam/permissions build`)
   or remove the unused import. This is not in my scope per the F.1.c
   boundaries ("ONE endpoint only"); flagging it here so F.1.a / F.1.b
   can pick it up.

2. **F.1.a's catalog migration already landed in the live DB.** All 13 of
   the new `bam.superuser_permission_*` catalog rows from the F.1
   delta migration are already seeded:

   ```
   SELECT id FROM permissions WHERE id LIKE 'bam.superuser_permission%';
     -> bam.superuser_permission_catalog.list                (is_read=t, requires_superuser=t)
     -> bam.superuser_permission_group.list / create / get / update / delete / set_defaults / reset
     -> bam.superuser_permission_user.get / set_membership / set_override / clear_override / reattach
     -> bam.superuser_permission_divergence_summary.list  (pre-existing from Wave B)
     -> bam.superuser_permission_divergence.list          (pre-existing from Wave B)
   ```

   So the resolver is already enforcing the new perm at runtime in `on`
   mode — the catalog endpoint is gated for real, not fail-open via
   `permission_not_in_catalog`.

## Boundaries respected

- Exactly one new endpoint.
- All changes confined to `permissions-admin.routes.ts`, the test file,
  and one `server.ts` register line.
- No catalog perms added, no migration files written.
