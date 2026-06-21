# Wave D Phase 3 — Satellites C (beacon-api, bearing-api, board-api, bolt-api, brief-api)

Per-action permissions wired into the five middleware-style satellite APIs. These
satellites differ from plugin-style satellites (e.g. blank-api, bench-api) in that
they use a `src/middleware/authorize.ts` module with entity-level helpers
(`requireBoardAccess`, `requireGoalEditAccess`, etc.) in addition to the
role-only `requireMinOrgRole`. Wave D's per-action permission is orthogonal:
both the legacy gate and the resolver call run.

## Approach

| Pattern in route file | Edit applied |
|---|---|
| `requireMinOrgRole('member' \| 'admin')` (role-only) | Wrap with `dualReadGate({ legacy: requireMinOrgRole(...), permission: '<id>' })` |
| Entity-access helper like `requireBoardEditAccess()` | Keep entity check as canonical; append `shadowOnly('<id>')` to the preHandler array |
| Only `requireAuth` (no role gate) | Append `shadowOnly('<id>')` |
| Internal-only (`requireInternalSecret`) | Skip — no user context for the resolver |

Both helpers come from `@bigbluebam/permissions` re-exported via each app's
`src/middleware/dual-read.ts`.

## Boilerplate (identical across all five)

1. `package.json`: added `"@bigbluebam/permissions": "workspace:*"`.
2. `Dockerfile`: COPY permissions/package.json into deps stage; COPY permissions/ + `pnpm --filter @bigbluebam/permissions build` into build stage; COPY permissions/ into dev stage.
3. `src/env.ts`: added `BBB_PERMISSIONS_ENFORCE: z.enum(['off','warn','on']).default('warn')`.
4. `src/plugins/permissions.ts`: new file; registers `httpPermissionsPlugin` with `getCaller` returning `{ user_id, org_id }`. Depends on the `auth` plugin so `request.user` is populated.
5. `src/middleware/dual-read.ts`: new file; re-exports `dualReadGate, shadowOnly` from `@bigbluebam/permissions`.
6. `src/server.ts`: added `await fastify.register(permissionsPlugin)` after the auth plugin and before the health-check plugin (and route registration).
7. `docker-compose.yml`: each satellite gained `BBB_PERMISSIONS_ENFORCE=${BBB_PERMISSIONS_ENFORCE:-warn}` and `INTERNAL_SERVICE_SECRET=${INTERNAL_SERVICE_SECRET:-}` in its `environment:` block. bolt-api already had `INTERNAL_SERVICE_SECRET`; only `BBB_PERMISSIONS_ENFORCE` was added there.

## beacon-api

- Helpers: `requireMinOrgRole`, `requireBeaconReadAccess`, `requireBeaconEditAccess` from `src/middleware/authorize.ts`.
- Files touched:
  - `apps/beacon-api/src/routes/beacon.routes.ts` — 3 dualReadGate (entry_upsert.create, beacon.create, beacon_challenge.create) + 9 shadowOnly (beacon_stat.list, beacon.list, beacon_by_slug.get, beacon.get, beacon.update, beacon.delete, beacon.publish, beacon.restore, beacon.verify)
  - `apps/beacon-api/src/routes/attachments.routes.ts` — 3 shadowOnly
  - `apps/beacon-api/src/routes/comments.routes.ts` — 4 shadowOnly
  - `apps/beacon-api/src/routes/link.routes.ts` — 1 dualReadGate + 2 shadowOnly
  - `apps/beacon-api/src/routes/tag.routes.ts` — 3 shadowOnly
  - `apps/beacon-api/src/routes/version.routes.ts` — 2 shadowOnly (both refer to same permission `beacon.beacon_version.get`)
  - `apps/beacon-api/src/routes/policy.routes.ts` — 2 dualReadGate (policy.update, policy_resolve.list) + 1 shadowOnly (policy.list)
  - `apps/beacon-api/src/routes/graph.routes.ts` — 3 dualReadGate (graph_neighbor.list, graph_hub.list, graph_recent.list)
  - `apps/beacon-api/src/routes/search.routes.ts` — 1 dualReadGate (search_saved.create) + 6 shadowOnly (search.create, search_suggest.list, search_context.create, search_saved.list, search_saved.get, search_saved.delete)
- Totals: **10 dualReadGate + 30 shadowOnly**.

## bearing-api

- Helpers: `requireMinOrgRole`, `requireGoalAccess`, `requireGoalEditAccess`.
- File-extension quirk: routes are named `goals.ts`, `key-results.ts`, `periods.ts`, `reports.ts` (no `.routes` infix).
- Files touched:
  - `apps/bearing-api/src/routes/goals.ts` — 1 dualReadGate (goal.create) + 11 shadowOnly
  - `apps/bearing-api/src/routes/key-results.ts` — 3 dualReadGate (goal_key_result.create, key_result.update, key_result.delete) + 7 shadowOnly
  - `apps/bearing-api/src/routes/periods.ts` — 5 dualReadGate (period.create/update/delete, period_activate.create, period_complete.create) + 2 shadowOnly (period.list, period.get)
  - `apps/bearing-api/src/routes/reports.ts` — 6 shadowOnly (report_period.get, report_at_risk.list, report_owner.get, report_generate.create, goal.list for goals export, key_result.list for kr export)
- Totals: **9 dualReadGate + 26 shadowOnly**.

## board-api

- Helpers: `requireMinOrgRole`, `requireBoardAccess`, `requireBoardEditAccess`.
- Files touched:
  - `apps/board-api/src/routes/board.routes.ts` — 1 dualReadGate (board.create) + 16 shadowOnly
  - `apps/board-api/src/routes/element.routes.ts` — 7 shadowOnly (3 GET frames/stickies/elements, sticky.create, text.create, board.export, board_export.get)
  - `apps/board-api/src/routes/scene.routes.ts` — 3 shadowOnly (board_scene.get, board_scene.update, board_scene_beacon.create)
  - `apps/board-api/src/routes/version.routes.ts` — 3 shadowOnly
  - `apps/board-api/src/routes/link.routes.ts` — 3 shadowOnly (board_element.promote, board_link.get, link.delete)
  - `apps/board-api/src/routes/collaborator.routes.ts` — 4 shadowOnly
  - `apps/board-api/src/routes/chat.routes.ts` — 2 shadowOnly
  - `apps/board-api/src/routes/audio.routes.ts` — 1 shadowOnly (board_audio_token.create)
  - `apps/board-api/src/routes/template.routes.ts` — 3 dualReadGate (template.create/update/delete) + 2 shadowOnly (template.list, template_instantiate.create)
- Totals: **4 dualReadGate + 41 shadowOnly**.

## bolt-api

- Helpers: `requireMinOrgRole`, `requireAutomationAccess`, `requireAutomationEditAccess`.
- Files touched:
  - `apps/bolt-api/src/routes/automation.routes.ts` — 1 dualReadGate (automation.create) + 13 shadowOnly (list, stats, by-name, get, update PUT, update PATCH (same id), delete, enable, disable, duplicate, test, versions.get, versions.restore)
  - `apps/bolt-api/src/routes/execution.routes.ts` — 2 dualReadGate (execution.list admin, execution_retry.create member) + 2 shadowOnly (automation_execution.get, execution.get)
  - `apps/bolt-api/src/routes/event.routes.ts` — 3 shadowOnly (event.list, event.get, action.list)
  - `apps/bolt-api/src/routes/observability.routes.ts` — 2 shadowOnly (event_trace.get, event_recent.list)
  - `apps/bolt-api/src/routes/template.routes.ts` — 1 dualReadGate (template_instantiate.create) + 1 shadowOnly (template.list)
  - `apps/bolt-api/src/routes/ai-assist.routes.ts` — 2 shadowOnly (ai_generate.create, ai_explain.create)
  - `apps/bolt-api/src/routes/event-ingestion.routes.ts` — **skipped on purpose**: `POST /events/ingest` uses `requireInternalSecret` only and is invoked service-to-service with no user context. The manifest still tracks `bolt.event_ingest.create` against it; we leave it unattached because the resolver call would lack a caller.
- Totals: **4 dualReadGate + 23 shadowOnly**.

## brief-api

- Helpers: `requireMinOrgRole`, `requireDocumentAccess`, `requireDocumentEditAccess`.
- Files touched:
  - `apps/brief-api/src/routes/document.routes.ts` — 2 dualReadGate (document.create, document.promote) + 17 shadowOnly
  - `apps/brief-api/src/routes/folder.routes.ts` — 3 dualReadGate (folder.create/update/delete) + 1 shadowOnly (folder.list)
  - `apps/brief-api/src/routes/version.routes.ts` — 5 shadowOnly (document_version.get x2, document_version.create, document_version.restore, document_version_diff.get)
  - `apps/brief-api/src/routes/comment.routes.ts` — 7 shadowOnly
  - `apps/brief-api/src/routes/embed.routes.ts` — 3 shadowOnly
  - `apps/brief-api/src/routes/link.routes.ts` — 2 dualReadGate (document_link_task.create, document_link_beacon.create) + 2 shadowOnly (document_link.get, link.delete)
  - `apps/brief-api/src/routes/template.routes.ts` — 3 dualReadGate (template.create/update/delete) + 1 shadowOnly (template.list)
  - `apps/brief-api/src/routes/collaborator.routes.ts` — 4 shadowOnly
  - `apps/brief-api/src/routes/export.routes.ts` — 2 shadowOnly (markdown, html)
- Totals: **10 dualReadGate + 42 shadowOnly**.

## Aggregate

| Satellite | dualReadGate | shadowOnly | Total gates |
|---|---|---|---|
| beacon-api | 10 | 30 | 40 |
| bearing-api | 9 | 26 | 35 |
| board-api | 4 | 41 | 45 |
| bolt-api | 4 | 23 | 27 |
| brief-api | 10 | 42 | 52 |
| **Total** | **37** | **162** | **199** |

The high shadow:dual ratio reflects the design intent: most of the
middleware-style satellites already enforce visibility through entity-access
helpers, so the per-action layer is initially attached as a telemetry-only
shadow alongside the canonical entity check. Routes whose only legacy check
was a role-only `requireMinOrgRole` (rare in these satellites — concentrated
in periods, policies, templates, folders, and one-off creates) are the ones
where dualReadGate actually wraps the role gate.

## Build & runtime verification

All five satellites rebuilt cleanly under `docker compose build` and started
under `docker compose up -d --force-recreate`. Logs show the expected
`<satellite>-api permissions plugin registered` line at boot. Health endpoint
verifications (post-nginx restart):

```
$ curl -sk https://localhost/beacon/api/health
{"status":"ok","service":"beacon-api",...}
$ curl -sk https://localhost/bearing/api/health
{"status":"ok","service":"bearing-api",...}
$ curl -sk https://localhost/board/api/health
{"status":"ok","service":"board-api",...}
$ curl -sk https://localhost/bolt/api/health
{"status":"ok","service":"bolt-api",...}
$ curl -sk https://localhost/brief/api/health
{"status":"ok","service":"brief-api",...}
```

Catalog drift check:

```
$ node scripts/check-permission-catalog.mjs
✓ permission catalog up to date (2 artifacts checked)
✓ permission catalog also in sync with DB (1047 rows checked)
```

## Anomalies / notes

- **bolt-api `POST /events/ingest`**: deliberately not gated. Service-to-service
  endpoint protected by `requireInternalSecret` only; resolver call would have
  no caller context. The manifest entry `bolt.event_ingest.create` stays
  registered against the route ref for catalog completeness; enforcement
  happens via `INTERNAL_SERVICE_SECRET` instead of per-action permissions.
- **beacon-api `version.routes.ts`**: both `GET /beacons/:id/versions` and
  `GET /beacons/:id/versions/:v` collapse to the same manifest id
  `beacon.beacon_version.get` (the manifest entry lists both refs under one id).
  Both routes were independently annotated with `shadowOnly('beacon.beacon_version.get')`.
- **bolt-api `PUT /automations/:id` and `PATCH /automations/:id`**: both refs
  share the manifest id `bolt.automation.update`. Both routes were annotated
  with `shadowOnly('bolt.automation.update')`.
- **bolt-api `POST /automations`**: legacy required `requireMinOrgRole('member')`,
  wrapped with dualReadGate. Body schema validates a graph mode that compiles to
  trigger/conditions/actions; the permission gate runs before the body is parsed
  so the resolver-deny path will reject without touching `compileGraphToRows`.
- **bearing-api file extension quirk**: routes live in `src/routes/<name>.ts`
  (no `.routes.ts` infix). Handled the same as plugin-style satellites otherwise.
- **board-api `requireBoardEditAccess` on element-promote**: the legacy chain
  already enforces edit access via the entity helper. The shadowOnly was added
  in `link.routes.ts` (where the route lives), not `element.routes.ts`, because
  the route registration is in link.routes.ts (`POST /boards/:id/elements/promote`
  shares a file with `/links` / `/boards/:id/links`).
- **No business logic was modified** in any route handler. All edits are confined
  to import lines and preHandler array entries.
- **Every route file that adds a `dualReadGate` or `shadowOnly` call also imports
  the helper from `'../middleware/dual-read.js'`** — verified by grep across all
  five satellites; no missing imports.

## Files touched (summary)

- 5 × `apps/<satellite>-api/package.json`
- 5 × `apps/<satellite>-api/Dockerfile`
- 5 × `apps/<satellite>-api/src/env.ts`
- 5 × `apps/<satellite>-api/src/plugins/permissions.ts` (new)
- 5 × `apps/<satellite>-api/src/middleware/dual-read.ts` (new)
- 5 × `apps/<satellite>-api/src/server.ts`
- 1 × `docker-compose.yml`
- 35 route files across the five satellites (counts shown per-satellite above)
