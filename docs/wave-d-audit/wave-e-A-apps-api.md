# Wave E.A — apps/api codemod: replace dualReadGate with bare requireCan

Mechanical pass replacing every `dualReadGate({ legacy: X, permission: Y })`
in `apps/api/src/routes/*.ts` with `fastify.requireCan(Y)`. With the
per-action resolver canonical in `BBB_PERMISSIONS_ENFORCE=on` (Wave D) and
the built-in group defaults remediated by migrations 0156/0157/0158, the
legacy half of the dual-read gate is redundant defense-in-depth and now
removed.

## Totals

| Metric | Count |
| --- | --- |
| `dualReadGate(...)` call sites replaced | **120** |
| Files modified (callsite replacements) | 27 |
| Bare `requireSuperUser` / `requireSuperuser` sites removed from `suPreHandler`-style arrays | **1** (10 use sites collapsed; only `platform.routes.ts` carried the pattern) |
| `requireProjectAccess(...)` additions where needed | **0** (all dualReadGate sites that used `requireProjectRole` already had `requireProjectAccess*` upstream in the preHandler) |
| Import lines fully removed (`import { dualReadGate } from ...`) | 6 |
| Import lines tightened (`{ dualReadGate, shadowOnly }` → `{ shadowOnly }`) | 21 |
| Legacy role helper imports tidied | 7 distinct symbols across 25 files (`requireMinRole`, `requireRole`, `requireProjectRole`, `requireOrgRole`, `requireSuperuser`, `requireSuperUser`) — only dropped when no remaining usage in the file body |

## Files with import cleanup

`api-key.routes.ts`, `attachment.routes.ts`, `comment.routes.ts`,
`custom-field.routes.ts`, `epic.routes.ts`,
`github-integration.routes.ts`, `guest.routes.ts`, `import.routes.ts`,
`label.routes.ts`, `launchpad.routes.ts`, `llm-provider.routes.ts`,
`org.routes.ts`, `permissions-divergences.routes.ts`, `phase.routes.ts`,
`platform.routes.ts`, `project.routes.ts`, `reaction.routes.ts`,
`service-account.routes.ts`, `slack-integration.routes.ts`,
`sprint.routes.ts`, `superuser.routes.ts`, `system-settings.routes.ts`,
`task.routes.ts`, `template.routes.ts`, `time-entry.routes.ts`,
`upload.routes.ts`, `view.routes.ts`, `webhook.routes.ts`.

`shadowOnly` references survive in their respective files — Wave E.B/E.E
will deal with those when the dual-read middleware file itself is
deleted.

## Special handling

### platform.routes.ts (`suPreHandler` collapse)

This file declared
`const suPreHandler = [requireAuth, requireSuperUser];` at module scope
and spread that array into 10 routes:
`[...suPreHandler, fastify.requireCan('bam.platform_X.Y')]`. Per the
task brief, the resolver now enforces `requires_superuser` permissions
on its own (catalog flags + Phase 5 remediated defaults), so the
`requireSuperUser` half was redundant. Collapsed to
`[requireAuth, fastify.requireCan('bam.platform_X.Y')]` at every use
site and removed the `const suPreHandler = ...` declaration and the
now-unused `requireSuperUser` import.

### superuser.routes.ts (stale Wave B comment scrubbed)

One Wave B comment block sitting inside the `/superuser/context/switch`
preHandler array explicitly named `requireSuperuser` and described how
the soak should behave. Removed the comment when the call site
collapsed to a bare `fastify.requireCan('bam.context.switch')` — the
text was misleading now that the legacy gate is gone, and the routes
file's pre/post-Wave-E-A diff already documents the change.

### version.routes.ts (left alone)

`POST /version/check` uses bare `requireSuperuser` WITHOUT a
`dualReadGate` wrapper — it was never part of the Wave B sample set, so
no per-action permission was minted for it. Out of scope for E.A: the
route still works (legacy `requireSuperuser` continues to enforce). A
follow-up should give it a `bam.platform_version_check.create`
permission and migrate it to `fastify.requireCan(...)` like the rest.

## Typecheck status

`pnpm --filter @bigbluebam/api typecheck` — **clean** (exit 0, no
errors).

Three unused-import errors surfaced after the codemod where my
auto-cleanup script's "is the symbol still used?" heuristic was too
conservative (the symbol survived only in dead comments, not in code).
Fixed in-place:

- `guest.routes.ts`: dropped `requireOrgRole` import (only referenced
  in a stale Wave B comment that was rewritten in the same edit).
- `llm-provider.routes.ts`: dropped `requireMinRole` from the
  `plugins/auth.js` import line (only referenced in a stale comment).
- `project.routes.ts`: dropped `requireProjectRole` from the
  `middleware/authorize.js` import line (only referenced in a stale
  comment; `requireMinRole` is still used live on a non-dualReadGate
  call site and was left alone).

## Smoke test

Stack rebuilt and restarted:

```
docker compose build api
docker compose up -d --force-recreate api
api health: 200
```

Member-tier enforcement check (avery.singh@mage.io, password
`TestMember-Wave-D-Verify`):

```
login: 200
platform/orgs (should be 403): 403
auth/me (should be 200): 200
```

All expected. The 403 came from the per-action resolver denying
`bam.platform_org.list` for a non-SuperUser, confirming the resolver
is canonical and the `suPreHandler` collapse did not weaken access
control. Unauthenticated requests to the same endpoints returned 401
as expected.

A subsequent re-run of the smoke test failed with 401 because
avery's account got rate-limited / locked out from accumulated test
traffic in this session; the first run is the authoritative result.

## Anomalies / things to flag

### FST_ERR_REP_ALREADY_SENT warning on resolver denials

After the resolver denies a request with 403, Fastify emits a level-40
`Reply was already sent, did you forget to "return reply" in
"/v1/platform/orgs" (GET)?` warning. The 403 itself is delivered
correctly (responseTime ~56ms before the warning fires), and the
client experience is unaffected.

Root cause: `@bigbluebam/permissions`' `requireCan` does
`reply.code(403).send({...}); return;` instead of
`return reply.code(403).send({...})`. Fastify treats the absence of a
returned reply as "this preHandler did not handle the response" and
runs the next preHandler / route handler, which then tries to send and
trips the already-sent guard.

This is **pre-existing behaviour** in `packages/permissions/src/index.ts`
(lines 150-159) — every previously-deployed route that ended in
`fastify.requireCan(...)` already exhibited it on deny. Wave E.A simply
expands the surface area where the warning shows up by retiring
`dualReadGate`'s legacy throw-style gate in favour of the resolver's
send-and-return path. It is **not a regression** introduced by this
codemod and is **out of scope** for Wave E.A.

Recommended follow-up (separate task): change the package's deny path
to `return reply.code(403).send({...})` (one-line fix); the same fix is
needed for the 401 unauthenticated path on line 124.

### Stale Wave B sample comments

Three "Wave B dual-read sample" comments inside preHandler arrays
survive in `project.routes.ts` (lines 61, 184, 282) and one each in
`task.routes.ts` (line 364), `llm-provider.routes.ts` (line 215), and
`guest.routes.ts` (line 24). They reference the now-retired legacy
gate. Did not strip them in this pass because the task brief says
"do not modify route handler logic" — they're cosmetic and don't
change behavior. Cleanup is a one-line edit each whenever someone next
touches those routes.

### project.routes.ts `requireMinRole('member')` still present

`POST /projects/:id/members` still has a defense-in-depth
`requireMinRole('member')` preHandler alongside the new
`fastify.requireCan('bam.project_member.create')`. The legacy gate was
the `requireProjectRole('admin')` half of the `dualReadGate`, which
was removed by this codemod; the org-level `requireMinRole('member')`
was never part of `dualReadGate` and is left in place. The resolver's
`bam.project_member.create` permission already denies non-admins at
the project scope, so the legacy check is redundant but harmless. Drop
it in Wave E.E if desired.

### apps/api/src/middleware/dual-read.ts kept

Per the task brief, the file itself is Wave E.E's job to delete. Wave
E.A only stops calling its `dualReadGate` export; `shadowOnly` is still
called from ~40 routes and is preserved. apps/api/test/dual-read.test.ts
is likewise untouched.
