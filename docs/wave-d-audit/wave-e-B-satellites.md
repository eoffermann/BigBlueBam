# Wave E.B — Satellite `dualReadGate` removal

Wave D Phase 3 wired all 12 satellite APIs with `dualReadGate(...)` middleware that
ran both the legacy role gate AND the new resolver in parallel. With
`BBB_PERMISSIONS_ENFORCE=on` (Wave D Phase 4) and Phase 5 role-default
remediation complete, the resolver is canonical and the legacy half is
redundant. This step replaces every `dualReadGate(...)` call with a bare
`fastify.requireCan(...)` and tidies the now-unused legacy imports.

`shadowOnly(...)` calls are functionally equivalent to `requireCan` at mode `on`
(both call the resolver and enforce). They are left untouched as a deliberate
no-op marker; Wave E.E will delete the wrapper and the `shadowOnly` aliases at
the same time.

## Per-satellite replacement counts

| Satellite    | dualReadGate replaced | fastify.requireCan calls | shadowOnly (untouched) | Files modified |
|---|---:|---:|---:|---:|
| banter-api   | 13  | 13  | 0    | 9   |
| bond-api     | 41  | 41  | 0    | 8   |
| bench-api    | 6   | 6   | 0    | 2   |
| book-api     | 9   | 9   | 0    | 3   |
| blast-api    | 17  | 17  | 0    | 4   |
| bill-api     | 31  | 31  | 0    | 7   |
| blank-api    | 3   | 3   | 0    | 2   |
| beacon-api   | 10  | 10  | ~30  | 5   |
| bearing-api  | 9   | 9   | ~26  | 3   |
| board-api    | 4   | 4   | ~41  | 2   |
| bolt-api     | 4   | 4   | ~23  | 3   |
| brief-api    | 10  | 10  | ~42  | 4   |
| **Total**    | **157** | **157** | — | **52** |

All 157 replacements followed the mechanical pattern documented in the task
brief — no route-handler logic was changed, only `preHandler` arrays and the
imports above them. The two `adminPreHandler` factories in banter-api
(`admin.routes.ts`, `user-group.routes.ts`) were collapsed from a
`dualReadGate({ legacy: requireRole(['owner', 'admin']), permission })` wrapper
to `fastify.requireCan(permission)` directly inside the factory closure; call
sites were untouched.

## Files where imports were tidied

Every replaced file lost the `import { dualReadGate } from
'../middleware/dual-read.js'` line. Files that still import `shadowOnly` from
the same module had `dualReadGate` stripped from the import binding list (e.g.
`import { dualReadGate, shadowOnly } from '...'` → `import { shadowOnly } from
'...'`). Files where the legacy role-gate helper (`requireMinRole`,
`requireRole`, or `requireMinOrgRole`) was no longer referenced after the
replacement had it removed from the auth/authorize imports.

Files where role helpers were removed from imports (changed file count == 52):

- **banter-api**: `admin.routes.ts`, `call.routes.ts`, `channel.routes.ts`,
  `dm.routes.ts`, `file.routes.ts`, `message.routes.ts`, `reaction.routes.ts`,
  `thread.routes.ts`, `user-group.routes.ts`
- **bond-api**: `activities.routes.ts`, `companies.routes.ts`,
  `contacts.routes.ts`, `custom-fields.routes.ts`, `deals.routes.ts`,
  `imports.routes.ts`, `pipelines.routes.ts`, `scoring.routes.ts`
- **bench-api**: `materialized-views.routes.ts`, `reports.routes.ts`
- **book-api**: `booking-pages.routes.ts`, `calendars.routes.ts`,
  `events.routes.ts`
- **blast-api**: `campaigns.routes.ts`, `segments.routes.ts`,
  `sender-domains.routes.ts`, `templates.routes.ts`
- **bill-api**: `clients.routes.ts`, `expenses.routes.ts`,
  `invoices.routes.ts`, `payments.routes.ts`, `rates.routes.ts`,
  `reports.routes.ts`, `settings.routes.ts`
- **blank-api**: `forms.routes.ts`, `submissions.routes.ts`
- **beacon-api**: `beacon.routes.ts`, `graph.routes.ts`, `link.routes.ts`,
  `policy.routes.ts`, `search.routes.ts`
- **bearing-api**: `goals.ts`, `key-results.ts`, `periods.ts`
- **board-api**: `board.routes.ts`, `template.routes.ts`
- **bolt-api**: `automation.routes.ts`, `execution.routes.ts`,
  `template.routes.ts`
- **brief-api**: `document.routes.ts`, `folder.routes.ts`, `link.routes.ts`,
  `template.routes.ts`

For middleware-style satellites (beacon, bearing, board, bolt, brief), the
entity-access helpers (`requireBoardAccess`, `requireGoalEditAccess`,
`requireBeaconReadAccess`, `requireDocumentEditAccess`,
`requireAutomationAccess`, etc.) were preserved as separate `preHandler`
entries — they are visibility helpers, not role gates, and remain orthogonal
to the resolver.

`apps/<app>-api/src/middleware/dual-read.ts` and
`apps/<app>-api/src/plugins/permissions.ts` are unchanged; deletion of the
former is deferred to Wave E.E.

## Typecheck status per satellite

`pnpm --filter @bigbluebam/<app>-api typecheck` — all 12 satellites pass clean:

| Satellite    | Typecheck |
|---|---|
| banter-api   | PASS |
| bond-api     | PASS |
| bench-api    | PASS |
| book-api     | PASS |
| blast-api    | PASS |
| bill-api     | PASS |
| blank-api    | PASS |
| beacon-api   | PASS |
| bearing-api  | PASS |
| board-api    | PASS |
| bolt-api     | PASS |
| brief-api    | PASS |

A few files needed a follow-up manual edit beyond the bulk sed pass to remove
`requireMinOrgRole` from multi-line `import { ... } from
'../middleware/authorize.js'` blocks that the single-line regex did not match:

- `apps/bearing-api/src/routes/goals.ts`
- `apps/board-api/src/routes/board.routes.ts`
- `apps/bolt-api/src/routes/automation.routes.ts`
- `apps/bill-api/src/routes/reports.routes.ts` (single-import line variant
  `import { requireAuth, requireMinRole } from '../plugins/auth.js'` without a
  trailing `requireScope`)
- `apps/bench-api/src/routes/materialized-views.routes.ts`
- `apps/blank-api/src/routes/submissions.routes.ts`

## Build status

`docker compose build banter-api bond-api bench-api book-api blast-api bill-api
blank-api beacon-api bearing-api board-api bolt-api brief-api` — all 12
images built successfully.

## Restart + health status

`docker compose up -d --force-recreate <12 apis>` — all 12 containers reached
the healthy state.

Health check via `curl -sk https://localhost/<app>/api/health`:

| Satellite    | HTTP status |
|---|---|
| banter   | 200 |
| bond     | 200 |
| bench    | 200 |
| book     | 200 |
| blast    | 200 |
| bill     | 200 |
| blank    | 200 |
| beacon   | 200 |
| bearing  | 200 |
| board    | 200 |
| bolt     | 200 |
| brief    | 200 |

## Anomalies

1. **nginx DNS cache.** After `docker compose up -d --force-recreate` rotated
   all 12 satellite container IPs, the running `frontend` (nginx) kept its
   resolved upstream IPs and returned 502s on every `/.../api/health` until
   `docker compose restart frontend`. This is not new to this wave — any
   compose recreate of an upstream container has the same effect — but worth
   flagging for the next operator. The fix is a one-shot frontend restart, not
   a code change.

2. **Pre-existing `dual-read.ts` / `permissions.ts`.** The shared satellite
   helpers in `apps/<app>-api/src/middleware/dual-read.ts` (re-exports from
   `@bigbluebam/permissions`) and `apps/<app>-api/src/plugins/permissions.ts`
   (the HTTP plugin registration) were left untouched as scoped out. Wave E.E
   should delete them along with the unused `shadowOnly` aliases.

3. **`@bigbluebam/permissions` package not in the frozen lockfile.** A
   `pnpm install` at the start of this wave failed with
   `ERR_PNPM_OUTDATED_LOCKFILE` because the satellite `package.json` files
   reference `@bigbluebam/permissions: workspace:*` which had not been
   reflected in `pnpm-lock.yaml` from prior waves. Re-running without
   `--frozen-lockfile` resolved it. The Wave D Phase 3 commit that introduced
   the dependency should have updated the lockfile; this is a flagged carry-
   over for tracking, no blocker for this wave.
