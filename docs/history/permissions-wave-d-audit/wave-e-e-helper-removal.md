# Wave E.E — Legacy role-gate helper removal

Status: complete.

This wave deletes the unused legacy role-gate helpers and the `dualReadGate`
middleware now that Waves E.A (apps/api) and E.B (12 satellites) replaced
the call sites with bare `fastify.requireCan(...)`. It also discovered that
Waves E.A/E.B left several role-gate calls in apps/api routes; those have
been migrated as part of this wave (preferring `fastify.requireCan(...)`).

---

## Files deleted in full

1. `apps/api/test/dual-read.test.ts` — tested the removed `dualReadGate`
   wrapper. No replacement needed (the resolver and `useCan` have their own
   suites).
2. `apps/api/test/permissions-contract.test.ts` — Wave C contract test
   asserting every role-gated route had a `dualReadGate`. Both invariants
   (every gate has a dualReadGate; every dualReadGate uses a catalog
   permission_id) are gone now that `dualReadGate` has been removed and
   every gate is a `fastify.requireCan(...)`.
3. `apps/bond-api/src/middleware/authorize.ts` — contained only
   `requireMinOrgRole` (now gone) and an unused `requireOwnershipOrRole`
   helper. No route imports it; file removed.
4. `apps/book-api/src/middleware/authorize.ts` — contained only
   `requireMinOrgRole`. No route imports it.
5. `apps/blast-api/src/middleware/authorize.ts` — same as book-api.
6. `apps/bill-api/src/middleware/authorize.ts` — same as book-api.

---

## Functions deleted within retained files

### `apps/api/src/plugins/auth.ts`

- `requireMinRole(minRole)` — removed.
- `requireRole(roles)` — removed.
- `requireSuperUser` (capital U variant) — removed. Was never imported;
  `apps/api/src/middleware/require-superuser.ts::requireSuperuser`
  (lowercase) remains for `version.routes.ts`.

### `apps/api/src/middleware/authorize.ts`

- `requireProjectRole(...roles)` — removed.
- `requireOrgRole(...roles)` — removed.
- Kept: `requireProjectAccess`, `requireProjectAccessForEntity` (still in
  use — entity visibility checks, not role gates).

### `apps/api/src/middleware/dual-read.ts`

Rewritten as a one-line re-export of `shadowOnly` from
`@bigbluebam/permissions`, with a Wave E.E note. The full `dualReadGate`
implementation, the `AsyncPreHandler` type, the `DualReadOptions`
interface, and the `legacyPermissionDecision` declare-module block are all
deleted.

### `apps/api/src/middleware/require-superuser.ts`

Kept (not deleted as the task plan tentatively suggested). The
`/version/check` route in `version.routes.ts` still needs a SuperUser-only
gate, and `/version` is in `EXCLUDED_PATH_PREFIXES` (no catalog
permission, so no `fastify.requireCan(...)` equivalent). Keeping the
middleware costs ~25 lines and is the minimal correct fix.

### Satellite `apps/<sat>-api/src/plugins/auth.ts` (12 satellites)

For each of banter-api, bond-api, bench-api, book-api, blast-api, bill-api,
blank-api, beacon-api, bearing-api, board-api, bolt-api, brief-api:

- `requireRole(roles)` — removed.
- `requireMinRole(minRole)` — removed.
- `requireSuperUser()` — removed.
- The orphaned `const ROLE_HIERARCHY = ['viewer', ...] as const` line was
  also removed (TS6133 unused-const after the functions left).

### Satellite `apps/<sat>-api/src/middleware/authorize.ts` (remaining 6)

For beacon-api, bearing-api, board-api, bolt-api, brief-api, and
(briefly) bond-api: deleted only the `requireMinOrgRole(minRole)` export.
The rest of the file (per-entity ownership and read-access guards) is kept
intact. Re-added a small local `roleLevel(role)` helper to
`beacon-api/src/middleware/authorize.ts` because `requireBeaconEditAccess`
inlines a role-hierarchy comparison and the helper was otherwise orphaned.

### Satellite `apps/<sat>-api/src/middleware/dual-read.ts` (12 satellites)

Rewritten as a one-line re-export of `shadowOnly` from
`@bigbluebam/permissions`. `dualReadGate` is gone everywhere.

### `packages/permissions/src/index.ts`

- `dualReadGate({ legacy, permission })` — removed.
- Section heading updated: "Satellite plugin: HTTP-backed requireCan +
  dualReadGate" → "Satellite plugin: HTTP-backed requireCan".
- `shadowOnly` and the `legacyPermissionDecision` field on FastifyRequest
  are kept (still wired into warn-mode divergence telemetry; setting it to
  `'allow'` from `shadowOnly` is a no-op for routes that never had a
  legacy gate).

---

## Route call-sites migrated (Wave E.A/E.B leftovers)

These were `requireProjectRole(...)` / `requireMinRole(...)` /
`requireOrgRole(...)` calls in `preHandler` arrays that should have been
removed by Waves E.A but were missed. Migrated in this wave; each route
already had a sibling `fastify.requireCan(...)` so the legacy gate was
redundant.

Files touched in `apps/api/src/routes/`:

- `custom-field.routes.ts` — 1 `requireProjectRole` removed.
- `epic.routes.ts` — 1.
- `github-integration.routes.ts` — 3.
- `label.routes.ts` — 1.
- `import.routes.ts` — 4.
- `webhook.routes.ts` — 1.
- `view.routes.ts` — 1.
- `template.routes.ts` — 2.
- `task.routes.ts` — 1.
- `sprint.routes.ts` — 1.
- `slack-integration.routes.ts` — 3.
- `project.routes.ts` — 1 `requireProjectRole` + 2 `requireMinRole`
  removed.

Also cleaned stale Wave-B comment block headers in `project.routes.ts`,
`llm-provider.routes.ts`, and `guest.routes.ts` so the source no longer
points at deleted code.

Total: 21 `requireProjectRole` + 2 `requireMinRole` call sites removed
from `apps/api/src/routes/**`. Zero remaining (excluding the deliberate
`requireSuperuser` in `version.routes.ts`).

---

## Test files deleted or updated

Deleted:
- `apps/api/test/dual-read.test.ts`
- `apps/api/test/permissions-contract.test.ts`

Updated:
- `apps/bearing-api/test/authorize.test.ts` — removed the entire
  `describe('requireMinOrgRole', ...)` block (the function no longer
  exists). The remaining 15 tests (requireGoalAccess, requireGoalEditAccess)
  still pass.

Kept untouched:
- `apps/api/test/org-permissions.test.ts` — exercises `isOrgPrivileged`
  from `apps/api/src/services/org-permissions.ts`, which is **out of
  scope** for Wave E.E (this is a business-logic helper that gates org
  settings like `members_can_create_projects`, not a route-level role
  gate; it will be revisited when the `users.role` column itself drops in
  Wave E.F).
- `apps/banter-api/test/permissions-races.test.ts` — its `isOrgPrivileged`
  is a local `const`, name-collision only.

---

## Typecheck status per service

```
pnpm typecheck
Tasks:    45 successful, 45 total
Cached:    0 cached, 45 total
  Time:    1m9.516s
```

All 45 workspace packages typecheck clean, including:
- `@bigbluebam/api` ✓
- `@bigbluebam/banter-api` ✓
- `@bigbluebam/bond-api` ✓
- `@bigbluebam/bench-api` ✓
- `@bigbluebam/book-api` ✓
- `@bigbluebam/blast-api` ✓
- `@bigbluebam/bill-api` ✓
- `@bigbluebam/blank-api` ✓
- `@bigbluebam/beacon-api` ✓
- `@bigbluebam/bearing-api` ✓
- `@bigbluebam/board-api` ✓
- `@bigbluebam/bolt-api` ✓
- `@bigbluebam/brief-api` ✓
- `@bigbluebam/permissions` ✓

---

## Health check status per service

After `docker compose build` + `up -d --force-recreate` of all 13 services
and a `docker compose restart frontend`:

| Service  | URL                                    | Status |
| -------- | -------------------------------------- | ------ |
| api      | https://localhost/b3/api/health        | 200    |
| banter   | https://localhost/banter/api/health    | 200    |
| bond     | https://localhost/bond/api/health      | 200    |
| bench    | https://localhost/bench/api/health     | 200    |
| book     | https://localhost/book/api/health      | 200    |
| blast    | https://localhost/blast/api/health     | 200    |
| bill     | https://localhost/bill/api/health      | 200    |
| blank    | https://localhost/blank/api/health     | 200    |
| beacon   | https://localhost/beacon/api/health    | 200    |
| bearing  | https://localhost/bearing/api/health   | 200    |
| board    | https://localhost/board/api/health     | 200    |
| bolt     | https://localhost/bolt/api/health      | 200    |
| brief    | https://localhost/brief/api/health     | 200    |

---

## Smoke test results

Both logins succeed and return the expected user objects.

| Check                            | User  | Expected | Actual |
| -------------------------------- | ----- | -------- | ------ |
| POST /b3/api/auth/login          | eddie | 200      | 200    |
| POST /b3/api/auth/login          | avery | 200      | 200    |
| GET  /b3/api/auth/me             | eddie | 200      | 200    |
| GET  /b3/api/auth/me             | avery | 200      | 200    |
| GET  /b3/api/v1/platform/orgs    | eddie | 200      | 200    |
| GET  /b3/api/v1/platform/orgs    | avery | 403      | 403    |

Eddie (SuperUser) gets the platform org list; Avery (member) is denied
with 403 by the resolver via `fastify.requireCan('platform.org.list')`,
confirming the `requires_superuser` flag in the catalog is enforced and
the migrated `requireSuperUser` sites (where applicable) still produce
correct decisions.

---

## References that resisted removal

None of the targeted helpers remain referenced in production code:

- `requireMinRole`, `requireRole`, `requireMinOrgRole`, `requireOrgRole`,
  `requireProjectRole`: **zero** non-comment matches under `apps/`.
- `dualReadGate`: **zero** production matches; one comment in
  `packages/permissions/src/index.ts` documenting that it was removed in
  Wave E.E.
- `requireSuperuser` middleware: still imported by
  `apps/api/src/routes/version.routes.ts` (intentional — see note above).
- `requireSuperuser` in `apps/mcp-server/src/tools/platform-tools.ts`:
  unrelated local async function (MCP-side check against the api). Out of
  scope; not a route preHandler.
- `isOrgPrivileged` in `apps/api/src/services/org-permissions.ts`: kept.
  Used inside route handler bodies (api-key, org, project,
  service-account) to gate **org-setting toggles** like
  `members_can_create_projects` — not a route-level role gate. This will
  be revisited as part of Wave E.F when `users.role` itself drops.
- `isOrgPrivileged` local consts in `apps/banter-api/src/routes/channel.
  routes.ts` and `apps/banter-api/test/permissions-races.test.ts`: name
  collisions only, not the imported function.

No other references resisted removal.
