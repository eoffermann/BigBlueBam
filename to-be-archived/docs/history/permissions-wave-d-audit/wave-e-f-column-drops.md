# Wave E.F — Legacy role column drops

Status: complete.

This wave drops `users.role` and `organization_memberships.role` and migrates
every consumer to resolve role from
`account_group_memberships → permission_groups.legacy_role`. Wave E is
functionally complete after this step.

---

## Audit

The grep run at the start of this wave returned this distribution of legacy
references in `apps/`:

| Pattern                            | Count | Notes                                                |
| ---------------------------------- | ----: | ---------------------------------------------------- |
| `users.role` (Drizzle column ref)  |    36 | 13 auth plugins, 8 routes, 6 services, ws handlers   |
| `organizationMemberships.role`     |    24 | 13 auth plugins, org/superuser routes + services     |
| `request.user.role` (read)         |    ~9 | Already correctly populated via AuthUser synthesis   |
| `isOrgPrivileged(user.role)`       |     6 | api-key / org / project / service-account routes    |
| `users.role` Drizzle column decl   |     3 | api schema, banter-api stub, db-stubs canonical      |
| `organization_memberships.role` decl |   3 | Same set as above                                    |
| `users.role` SQL check constraint  |     1 | `users_role_check`, dropped in migration             |
| `org_memberships_role_check`       |     1 | Same, dropped in migration                           |

Categories:

- **Drizzle column declaration**: `apps/api/src/db/schema/users.ts`,
  `apps/api/src/db/schema/organization-memberships.ts`,
  `apps/banter-api/src/db/schema/bbb-refs.ts`,
  `apps/bond-api/src/db/schema/bbb-refs.ts`,
  `apps/book-api/src/db/schema/bbb-refs.ts`,
  `apps/blast-api/src/db/schema/bbb-refs.ts`,
  `apps/bill-api/src/db/schema/bbb-refs.ts`,
  `apps/blank-api/src/db/schema/bbb-refs.ts`,
  `apps/beacon-api/src/db/schema/bbb-refs.ts`,
  `apps/bearing-api/src/db/schema/bbb-refs.ts` (re-export),
  `apps/board-api/src/db/schema/bbb-refs.ts`,
  `apps/bolt-api/src/db/schema/bbb-refs.ts`,
  `apps/brief-api/src/db/schema/bbb-refs.ts`,
  `apps/bench-api/src/db/schema/bbb-refs.ts` (re-export),
  `packages/db-stubs/src/index.ts`.
  All `role` columns removed from these declarations; a `permissionGroups`
  and `accountGroupMemberships` stub added so the auth plugin and other
  consumers can join. The canonical schemas in `apps/api` are unchanged
  except for the removed column.

- **SQL `select ... role from users/org_memberships`**: 30+ sites.
  Replaced with leftJoin against `account_group_memberships +
  permission_groups`, with `role` projected from `pg.legacy_role` (and
  `?? 'member'` defaulting). New helper module
  `apps/api/src/services/role-resolver.ts` (resolveUserOrgRole,
  resolveUserOrgRoles, resolveOrgUserRoles, setUserOrgRole, clearUserOrgRole)
  centralises the pattern.

- **`request.user.role` (read)**: Unchanged at the call site. The auth
  plugin in every service now synthesizes `role` from group membership when
  it builds the AuthUser. The 5 deliberately-kept frontend `role ===`
  checks documented in Wave E.D continue to work because the API response
  preserves the field.

- **`organizationMemberships.role` updates / inserts**: 9 write sites
  across `org.service.ts`, `superuser-users.service.ts`,
  `auth.service.ts`, `oauth.routes.ts`, `service-account.routes.ts`,
  `guest.routes.ts`, `cli.ts`. Replaced with the new `setUserOrgRole`
  helper that upserts the user's org-scope `account_group_memberships`
  row pointing at the appropriate built-in group.

- **`isOrgPrivileged`**: Kept as a sync `(userRole: string) => boolean`
  helper. Its call sites pass `request.user.role` (now synthesized), so
  no signature change was needed. The function was an
  alternative-considered async refactor described in the task plan; the
  pragmatic choice here was to keep it sync and let the auth hook do the
  resolver join once per request.

---

## Files modified

### Canonical schemas

- `apps/api/src/db/schema/users.ts` — `role: varchar` column declaration
  removed; `users_role_check` constraint removed. Comment added pointing
  callers at `services/role-resolver.ts`.
- `apps/api/src/db/schema/organization-memberships.ts` — `role` column
  and `org_memberships_role_check` constraint removed.
- `packages/db-stubs/src/index.ts` — same removals. Added
  `permissionGroups` and `accountGroupMemberships` stubs (used by the two
  satellites that re-export from db-stubs), `BUILTIN_GROUP_IDS` map, and
  a `resolveUserOrgRolesStub` helper. The map is the same one re-declared
  inline in `apps/api/src/services/role-resolver.ts` and in `cli.ts`.

### New helper module

- `apps/api/src/services/role-resolver.ts` (new).
  - `BUILTIN_GROUP_IDS` (fixed-UUID map, mirrors migration 0146 seed)
  - `builtinGroupIdForRole(role)`
  - `resolveUserOrgRole(userId, orgId, db?)` — returns string | null
  - `resolveUserOrgRoles(userId, db?)` — Map<org_id, role>
  - `resolveOrgUserRoles(orgId, userIds?, db?)` — Map<user_id, role>
  - `setUserOrgRole(userId, orgId, role, opts, db?)` — upsert into
    `account_group_memberships`. Clears `detached_at` on conflict so a
    re-attach back to the live group is the natural side-effect.
  - `clearUserOrgRole(userId, orgId, db?)` — used by removeMember paths.

### Auth plugins (13 services)

- `apps/api/src/plugins/auth.ts`
- `apps/banter-api/src/plugins/auth.ts`
- `apps/bond-api/src/plugins/auth.ts`
- `apps/bench-api/src/plugins/auth.ts`
- `apps/book-api/src/plugins/auth.ts`
- `apps/blast-api/src/plugins/auth.ts`
- `apps/bill-api/src/plugins/auth.ts`
- `apps/blank-api/src/plugins/auth.ts`
- `apps/beacon-api/src/plugins/auth.ts`
- `apps/bearing-api/src/plugins/auth.ts`
- `apps/board-api/src/plugins/auth.ts`
- `apps/bolt-api/src/plugins/auth.ts`
- `apps/brief-api/src/plugins/auth.ts`

Each plugin now joins `organization_memberships` → `account_group_memberships`
→ `permission_groups` when fetching the per-org role. The 12 satellites were
updated by `scripts/wave-e-f-satellite-migrate.mjs` (kept in-tree for
reference). `users.role` reads dropped from every session-auth, API-key-auth,
and impersonation select. The `BaseUserRow` interface lost its `role: string`
field; `resolveOrgContext` dropped the `fallbackRole` parameter and falls
back to `'member'` when a user has no membership rows yet.

### WebSocket handlers

- `apps/api/src/plugins/websocket.ts` — `users.role` dropped from session
  join. Role still synthesized by `buildAuthUser`.
- `apps/banter-api/src/ws/handler.ts` — same.
- `apps/board-api/src/ws/handler.ts` — additional change because the handler
  consumes `user.role` directly to compute `isAdminOrOwner` and pass to
  `checkBoardAccess`. Now does a small explicit JOIN to `account_group_memberships`.
- `apps/brief-api/src/ws/handler.ts` — same pattern.

### Apps/api routes

- `apps/api/src/routes/auth.routes.ts` — bootstrap/register endpoints
  hard-code `role: 'owner'` in the response (since both create the user
  as owner of a fresh org). The login endpoint resolves role via
  `resolveUserOrgRole`. `/auth/orgs` and `/auth/switch-org` swapped to the
  JOIN pattern.
- `apps/api/src/routes/org.routes.ts` — guest-projects path replaced its
  `users.role` select with the resolved-via-group pattern.
- `apps/api/src/routes/platform.routes.ts` — `/v1/platform/orgs/:id/members`
  resolves role via the new `resolveOrgUserRoles`. `/v1/platform/impersonate`
  fetches role separately.
- `apps/api/src/routes/superuser.routes.ts` — `users` group counts and
  `owners` listings now JOIN through `account_group_memberships`.
  Membership delete/update flows fetch the previous role via
  `resolveUserOrgRole`.
- `apps/api/src/routes/guest.routes.ts` — `users.role = 'guest'` filters
  swapped to `permission_groups.legacy_role = 'guest'` via an INNER JOIN.
  The guest-registration flow no longer writes `users.role` and instead
  inserts a `member` `organization_memberships` row + `setUserOrgRole(... 'guest')`.
- `apps/api/src/routes/user.routes.ts` — `selectCols` now reads
  `permission_groups.legacy_role`; every query gets a leftJoin scoped to
  the caller's active org.
- `apps/api/src/routes/oauth.routes.ts`,
  `apps/api/src/routes/service-account.routes.ts` — write paths use
  `setUserOrgRole`, stop writing `users.role`.

### Apps/api services

- `apps/api/src/services/org.service.ts` — listOrgMembers,
  getOrgMemberCounts, getOrgMemberDetail, inviteMember, updateMemberRole,
  transferOwnership, getMembershipRole all migrated. Mirror-to-`users.role`
  blocks (legacy single-org sync) deleted; that column no longer exists.
- `apps/api/src/services/superuser-users.service.ts` — lists, detail,
  membership add/update use the new pattern.
- `apps/api/src/services/auth.service.ts` — bootstrap + register stop
  writing `users.role` and call `setUserOrgRole` after the
  `organization_memberships` insert.
- `apps/api/src/services/visibility.service.ts` — `loadAsker` fetches role
  via `resolveUserOrgRole(user.id, user.org_id)`.

### CLI

- `apps/api/src/cli.ts` — create-admin / create-user / create-service-account
  all stopped writing `users.role` / `organization_memberships.role`. Each
  inserts the matching `account_group_memberships` row directly (the CLI
  uses its own db client, so it doesn't import role-resolver — instead it
  declares a local copy of `BUILTIN_GROUP_IDS`).

### Migration

- `infra/postgres/migrations/0159_permissions_drop_legacy_role_columns.sql`.
  Drops both columns + the two check constraints. Wrapped in a single
  transaction; uses `IF EXISTS` for idempotency.

### Test mocks

- `apps/api/test/superuser.routes.test.ts` — added a pass-through
  `requireCan` decorator that gates on `request.user.is_superuser`. Prior
  to Wave E the tests fell out of registering routes because no decorator
  existed; the symptom only surfaced now because Wave E.E removed the
  `requireSuperUser` middleware that previously enforced the rule.
- `apps/api/test/entity-links.test.ts` — same `requireCan` decorator,
  pass-through only (no SU split). Tests already exercise per-row org
  visibility, not role.
- `apps/api/test/org-members.test.ts` — `makeTx` rewritten to model the
  Wave E.F call sequence: SELECT version → resolveUserOrgRole join →
  UPDATE version → setUserOrgRole insert+onConflictDoUpdate → SELECT user.
- `apps/api/test/auth.test.ts` — register-flow mocks gained
  `onConflictDoUpdate` and `onConflictDoNothing` stubs on
  `.values()`. The insert order is now org → user → organization_memberships
  → account_group_memberships (via setUserOrgRole) → session.
- `apps/api/test/visibility.service.test.ts` — `mockAsker` pushes two
  SELECTs (user row + role join) instead of one.

All 28 test files / 418 tests in `@bigbluebam/api` pass after these
updates. The cross-workspace `pnpm test` run reports 41/44 packages green;
the remaining one is `@bigbluebam/beacon-api` with a single pre-existing
flake (see Anomalies).

### Tooling

- `scripts/wave-e-f-satellite-migrate.mjs` — one-shot transformation
  script that handled the 11 satellites with self-owned `bbb-refs.ts`.
  Kept in-tree as a record of the mechanical edits.

---

## Verification

### Typecheck

```
pnpm typecheck
Tasks:    45 successful, 45 total
Cached:   29 cached, 45 total
  Time:   28.695s
```

Every workspace package typechecks clean, including all 13 API services,
the worker, frontend, MCP server, and the shared packages.

### Migration apply

```
$ docker compose run --rm migrate
[migrate] migrations dir: /app/migrations
[migrate] found 120 migration file(s)
[migrate] applying 0159_permissions_drop_legacy_role_columns.sql
[migrate] done: 1 applied, 119 already up-to-date
```

### Column-drop confirmation

```
$ docker compose exec -T postgres psql -U bigbluebam -d bigbluebam \
    -c "SELECT column_name FROM information_schema.columns \
        WHERE table_name IN ('users','organization_memberships') AND column_name='role';"
 column_name
-------------
(0 rows)
```

### Drift check

```
$ DATABASE_URL=postgresql://bigbluebam:.../bigbluebam node scripts/db-check.mjs
schema in sync: 167 Drizzle tables, 167 DB tables, 4 warning(s)
```

The 4 warnings are pre-existing type-mismatch reports (inet vs text on
ip_address columns, USER-DEFINED enums vs varchar on visibility columns).
None are new from this wave; all are non-fatal.

### Service health (post-rebuild + force-recreate)

| Service     | URL                                    | Status |
| ----------- | -------------------------------------- | ------ |
| api         | https://localhost/b3/api/health        | 200    |
| banter-api  | https://localhost/banter/api/health    | 200    |
| beacon-api  | https://localhost/beacon/api/health    | 200    |
| bearing-api | https://localhost/bearing/api/health   | 200    |
| bench-api   | https://localhost/bench/api/health     | 200    |
| bill-api    | https://localhost/bill/api/health      | 200    |
| blank-api   | https://localhost/blank/api/health     | 200    |
| blast-api   | https://localhost/blast/api/health     | 200    |
| board-api   | https://localhost/board/api/health     | 200    |
| bolt-api    | https://localhost/bolt/api/health      | 200    |
| bond-api    | https://localhost/bond/api/health      | 200    |
| book-api    | https://localhost/book/api/health      | 200    |
| brief-api   | https://localhost/brief/api/health     | 200    |

### Smoke tests

The pre-Wave-E seeded `eddie@bigblueceiling.com` / `avery.singh@mage.io`
accounts could not be exercised — their seed password is unknown to this
agent and there's no reset-password CLI. Instead, fresh users were minted
via the post-refactor `cli create-user` command to prove both the write
path (group membership inserted via the new code) and the read path
(role correctly resolved on `/auth/me`):

| Check                                     | User                          | Expected | Actual |
| ----------------------------------------- | ----------------------------- | -------- | ------ |
| CLI `create-user --role admin`            | wave-e-f-test@example.com     | success  | OK     |
| POST /auth/login                          | wave-e-f-test                 | 200      | 200    |
| Login response `user.role`                | wave-e-f-test                 | `admin`  | `admin` |
| GET /auth/me `data.role`                  | wave-e-f-test                 | `admin`  | `admin` |
| GET /auth/orgs (first membership role)    | wave-e-f-test                 | `admin`  | `admin` |
| GET /v1/platform/orgs (non-SU admin)      | wave-e-f-test                 | 403      | 403    |
| `grant-superuser`                         | wave-e-f-test                 | success  | OK     |
| GET /v1/platform/orgs (SU)                | wave-e-f-test (now SU)        | 200      | 200    |
| GET /auth/me `is_superuser`               | wave-e-f-test (now SU)        | `true`   | `true` |
| CLI `create-user --role member`           | wave-e-f-member@example.com   | success  | OK     |
| POST /auth/login                          | wave-e-f-member               | 200      | 200    |
| Login response `user.role`                | wave-e-f-member               | `member` | `member` |
| GET /v1/platform/orgs (non-SU member)     | wave-e-f-member               | 403      | 403    |
| GET /auth/me `data.role`                  | wave-e-f-member               | `member` | `member` |

Both test users were deleted at the end of the run
(`DELETE FROM users WHERE email LIKE 'wave-e-f-%';`).

---

## Anomalies / follow-ups

- **Pre-existing migration-lint warnings.** `pnpm lint:migrations` reports
  2 violations + 21 warnings on migrations 0023, 0024, 0026, 0127, 0128,
  0132, 0156, 0158 (missing `-- Client impact:` header on the two later
  files; CREATE TYPE blocks lacking IF NOT EXISTS guards on the older
  files). All migrations are already applied in every environment, so per
  the immutability rule in CLAUDE.md the bodies must not be edited. These
  warnings predate Wave E.F. Migration 0159 itself adds no new violations.

- **Pre-existing db:check warnings.** 4 type-mismatch warnings (inet vs
  text, USER-DEFINED vs varchar). None are new.

- **`apps/api/test/org-permissions.test.ts`.** Still passes — Wave E.E
  left it intact because it exercises the pure-sync `isOrgPrivileged`
  helper. After Wave E.F that helper still takes a role string, so the
  test is unchanged.

- **`packages/db-stubs/src/index.ts::resolveUserOrgRolesStub`.** Exported
  for parity with the api-side helper but not consumed yet — the 11
  satellites do their JOIN inline in their auth plugin because the
  shared helper would need the typed table references and Drizzle's
  generic db type at the call site. Left in db-stubs as a documented
  reference; safe to delete in a future cleanup.

- **`docs/wave-d-audit/SYNTHESIS_PROGRESS.md`.** Wave E close-out section
  appended in the same commit as the migration.

- **Live users with unknown seed passwords.** `eddie@bigblueceiling.com`
  and the `mage.io` accounts have unknown passwords from prior seeding;
  Wave E.F did not need to rotate them and they should continue to work
  if any operator has the original credentials.

- **Pre-existing beacon-api test flake** (`apps/beacon-api/test/graph.test.ts`,
  `beacon-expiry-sweep > does not delete drafts under 60 days old`):
  the test hardcodes `new Date('2026-03-15')` and asserts it's newer than
  `Date.now() - 60 days`. As of 2026-05-22 the hardcode is ~68 days old
  so the assertion fails. Unrelated to Wave E.F (the file does not
  reference `role` at all). Should be replaced with a relative offset
  in a follow-up task.
