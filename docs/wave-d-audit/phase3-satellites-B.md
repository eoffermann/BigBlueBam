# Wave D Phase 3 — Satellites B wiring report

Wired the two remaining large plugin-style satellites (bond-api, banter-api)
to the shared `@bigbluebam/permissions` HTTP plugin, mirroring the blank-api
pilot and the Phase 3-A batch (bench-api, book-api, blast-api, bill-api).
Both builds clean, both runtimes report `permissions plugin registered`
(mode=warn), both `/<app>/api/health` endpoints return 200, and
`scripts/check-permission-catalog.mjs` shows no drift (`2 artifacts checked /
1047 rows checked`).

## Per-satellite summary

### bond-api

- **Files touched**
  - `apps/bond-api/package.json` — added `@bigbluebam/permissions` workspace dep
  - `apps/bond-api/Dockerfile` — added permissions COPY in deps/build/dev stages + build step
  - `apps/bond-api/src/env.ts` — added `BBB_PERMISSIONS_ENFORCE`
    (`BBB_API_INTERNAL_URL` and `INTERNAL_SERVICE_SECRET` already present)
  - `apps/bond-api/src/plugins/permissions.ts` — new, registers `httpPermissionsPlugin`
  - `apps/bond-api/src/middleware/dual-read.ts` — new, re-exports `dualReadGate`/`shadowOnly`
  - `apps/bond-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/bond-api/src/routes/activities.routes.ts` — dual-read import + 3 wraps
  - `apps/bond-api/src/routes/contacts.routes.ts` — dual-read import + 8 wraps
  - `apps/bond-api/src/routes/deals.routes.ts` — dual-read import + 10 wraps
  - `apps/bond-api/src/routes/companies.routes.ts` — dual-read import + 4 wraps
  - `apps/bond-api/src/routes/pipelines.routes.ts` — dual-read import + 7 wraps
  - `apps/bond-api/src/routes/scoring.routes.ts` — dual-read import + 4 wraps
  - `apps/bond-api/src/routes/custom-fields.routes.ts` — dual-read import + 3 wraps
  - `apps/bond-api/src/routes/imports.routes.ts` — dual-read import + 2 wraps
  - `docker-compose.yml` (bond-api block) — added `BBB_PERMISSIONS_ENFORCE` + `INTERNAL_SERVICE_SECRET` env entries
- **Gates wrapped (41 total across 8 route files)**
  - activities (3): POST /activities → `bond.activity.create`; PATCH /activities/:id → `bond.activity.update`; DELETE /activities/:id → `bond.activity.delete`
  - contacts (8): POST /contacts → `bond.contact.create`; POST /contacts/upsert → `bond.contact.upsert`; POST /contacts/import → `bond.contact.import`; GET /contacts/export → `bond.contact.list` (no `export` resource in the manifest — used closest semantic read match; tracked as a future manifest gap below); PATCH /contacts/:id → `bond.contact.update`; DELETE /contacts/:id → `bond.contact.delete`; POST /contacts/:id/restore → `bond.contact.restore`; POST /contacts/:id/merge → `bond.contact.merge`
  - deals (10): POST /deals → `bond.deal.create`; PATCH /deals/:id → `bond.deal.update`; DELETE /deals/:id → `bond.deal.delete`; POST /deals/:id/restore → `bond.deal.restore`; PATCH /deals/:id/stage → `bond.deal_stage.move`; POST /deals/:id/won → `bond.deal_won.close`; POST /deals/:id/lost → `bond.deal_lost.close`; POST /deals/:id/duplicate → `bond.deal.duplicate`; POST /deals/:id/contacts → `bond.deal_contact.create`; DELETE /deals/:id/contacts/:contactId → `bond.deal_contact.delete`
  - companies (4): POST /companies → `bond.company.create`; PATCH /companies/:id → `bond.company.update`; DELETE /companies/:id → `bond.company.delete`; POST /companies/:id/restore → `bond.company.restore`
  - pipelines (7): POST /pipelines → `bond.pipeline.create`; PATCH /pipelines/:id → `bond.pipeline.update`; DELETE /pipelines/:id → `bond.pipeline.delete`; POST /pipelines/:id/stages → `bond.pipeline_stage.create`; PATCH /pipelines/:id/stages/:stageId → `bond.pipeline_stage.update`; DELETE /pipelines/:id/stages/:stageId → `bond.pipeline_stage.delete`; POST /pipelines/:id/stages/reorder → `bond.pipeline_stage_reorder.create`
  - scoring (4): POST /scoring-rules → `bond.scoring_rule.create`; PATCH /scoring-rules/:id → `bond.scoring_rule.update`; DELETE /scoring-rules/:id → `bond.scoring_rule.delete`; POST /scoring/recalculate → `bond.scoring_recalculate.create`
  - custom-fields (3): POST /custom-field-definitions → `bond.custom_field_definition.create`; PATCH /custom-field-definitions/:id → `bond.custom_field_definition.update`; DELETE /custom-field-definitions/:id → `bond.custom_field_definition.delete`
  - imports (2): POST /imports/mappings → `bond.import_mapping.create`; GET /imports/mappings → `bond.import_mapping.list`
- **Build status:** clean (`bigbluebam-bond-api Built`)
- **Runtime status:** `bond-api permissions plugin registered` (mode=warn); listening on 4009; health 200

### banter-api

- **Files touched**
  - `apps/banter-api/package.json` — added permissions workspace dep
  - `apps/banter-api/Dockerfile` — added permissions COPY in deps/build/dev stages + build step
  - `apps/banter-api/src/env.ts` — added `BBB_PERMISSIONS_ENFORCE`
    (`BBB_API_INTERNAL_URL` and `INTERNAL_SERVICE_SECRET` already present)
  - `apps/banter-api/src/plugins/permissions.ts` — new
  - `apps/banter-api/src/middleware/dual-read.ts` — new
  - `apps/banter-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/banter-api/src/routes/channel.routes.ts` — dual-read import + 2 wraps
  - `apps/banter-api/src/routes/dm.routes.ts` — dual-read import + 2 wraps
  - `apps/banter-api/src/routes/message.routes.ts` — dual-read import + 2 wraps
  - `apps/banter-api/src/routes/file.routes.ts` — dual-read import + 2 wraps
  - `apps/banter-api/src/routes/reaction.routes.ts` — dual-read import + 1 wrap
  - `apps/banter-api/src/routes/thread.routes.ts` — dual-read import + 1 wrap
  - `apps/banter-api/src/routes/call.routes.ts` — dual-read import + 1 wrap
  - `apps/banter-api/src/routes/admin.routes.ts` — dual-read import + converted shared `adminPreHandler` const into a factory `(permission) => [requireAuth, dualReadGate(...), requireScope('admin')]` so each of the 10 routes binds its own permission_id without duplicating the role check
  - `apps/banter-api/src/routes/user-group.routes.ts` — same factory pattern; 5 routes wrapped
  - `docker-compose.yml` (banter-api block) — added two env entries
- **Gates wrapped (26 total across 9 route files)**
  - channel (2): POST /v1/channels → `banter.channel.create`; POST /v1/channels/:id/join → `banter.channel.join`
  - dm (2): POST /v1/dm → `banter.dm.create`; POST /v1/group-dm → `banter.group_dm.create`
  - message (2): POST /v1/channels/:id/messages → `banter.channel_message.create`; PATCH /v1/messages/:id → `banter.message.edit`
  - file (2): POST /v1/files/upload → `banter.file_upload.create`; POST /v1/files/presigned-upload → `banter.file_presigned_upload.create`
  - reaction (1): POST /v1/messages/:id/reactions → `banter.message_reaction.create`
  - thread (1): POST /v1/messages/:id/thread → `banter.message_thread.create`
  - call (1): POST /v1/channels/:id/calls → `banter.channel_call.create`
  - admin (10): GET /v1/admin/settings → `banter.admin_setting.list`; PATCH /v1/admin/settings → `banter.admin_setting.update`; POST /v1/admin/settings/test-livekit → `banter.admin_setting_test_livekit.create`; POST /v1/admin/settings/test-stt → `banter.admin_setting_test_stt.create`; POST /v1/admin/settings/test-tts → `banter.admin_setting_test_tt.create`; POST /v1/admin/settings/push-voice-config → `banter.admin_setting_push_voice_config.create`; POST /v1/admin/channel-groups → `banter.admin_channel_group.create`; PATCH /v1/admin/channel-groups/:id → `banter.admin_channel_group.update`; DELETE /v1/admin/channel-groups/:id → `banter.admin_channel_group.delete`; POST /v1/admin/channel-groups/reorder → `banter.admin_channel_group_reorder.create`
  - user-group (5): POST /v1/user-groups → `banter.user_group.create`; PATCH /v1/user-groups/:id → `banter.user_group.update`; DELETE /v1/user-groups/:id → `banter.user_group.delete`; POST /v1/user-groups/:id/members → `banter.user_group_member.create`; DELETE /v1/user-groups/:id/members/:userId → `banter.user_group_member.delete`
- **Build status:** clean (`bigbluebam-banter-api Built`)
- **Runtime status:** `banter-api permissions plugin registered` (mode=warn); listening on 4002; health 200

## Anomalies and notes

- **Initial gate count.** The task brief said "bond-api has 41 existing gate sites and banter-api has 13". 41 matches bond-api exactly. The 13-figure for banter-api appears to have been the count of distinct `requireMinRole|requireRole` source lines (admin.routes.ts and user-group.routes.ts each share a single `adminPreHandler` array that's referenced from many routes). Expanded to per-route gates the real number is 26 — we wrapped all of them.
- **`adminPreHandler` factory rewrite (banter-api admin + user-group).** Both files defined a shared `const adminPreHandler = [requireAuth, requireRole(['owner', 'admin']), requireScope('admin')]` array used as the `preHandler` value for every admin route. Replicating the inline pattern from the other satellites would have meant inlining `requireAuth`, `requireRole(...)`, and `requireScope('admin')` 15 times. Instead the const is now a factory `(permission: string) => [requireAuth, dualReadGate({ legacy: requireRole(['owner','admin']), permission }), requireScope('admin')]` invoked per route. Behaviour is byte-identical for the legacy role check; only the resolver call gets the per-route permission ID.
- **Manifest gap: `GET /contacts/export` (bond-api).** No `bond.contact.export` (or `bond.contacts.export`) entry in `docs/permissions-action-manifest.json`. The route is still gated with `requireMinRole('admin')` and we wrapped it against `bond.contact.list` (the closest semantic read match). Resolver responses for this route will be reasonable but slightly off — defer a manifest entry for the export resource to the catalog-extension pass.
- **Catalog drift guard.** `scripts/check-permission-catalog.mjs` exits 0 after both builds:
  `permission catalog up to date (2 artifacts checked)` and
  `permission catalog also in sync with DB (1047 rows checked)`.
- **No business logic touched.** Only `preHandler` arrays were rewritten in route files; service modules, request handlers, validation schemas, and Bolt event publish sites were not modified.
- **Gateless routes deferred.** Per the brief, `shadowOnly` was not added to currently gateless routes (e.g. `GET /v1/channels`, `GET /pipelines`, etc.). Those will be picked up in a later pass once the warn-mode soak window confirms the wrapped routes are quiet in the divergence dashboard.
- **`requireMinRole|requireRole` import lines.** Each route file still imports `requireMinRole` (or `requireRole`) from `../plugins/auth.js` because `dualReadGate({ legacy: requireMinRole('...') })` still calls the legacy handler. The new `dualReadGate` import was added alongside it in every touched file (the failure mode flagged in the brief — "easy miss" — was avoided).

## Verification commands

```sh
# Build status
docker compose build bond-api banter-api

# Health checks via nginx ingress
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost/bond/api/health    # 200
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost/banter/api/health  # 200

# Plugin registration in logs
docker compose logs --tail=200 bond-api banter-api | grep "permissions plugin registered"
# bond-api: bond-api permissions plugin registered (mode=warn)
# banter-api: banter-api permissions plugin registered (mode=warn)

# Catalog drift guard
node scripts/check-permission-catalog.mjs
# ✓ permission catalog up to date (2 artifacts checked)
# ✓ permission catalog also in sync with DB (1047 rows checked)
```
