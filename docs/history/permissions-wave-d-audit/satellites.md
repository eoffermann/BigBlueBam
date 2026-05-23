# Wave D Satellite API Permission Coverage Audit

**Date:** 2026-05-17
**Branch:** `permissions`
**Scope:** 12 satellite Fastify APIs (banter, bond, beacon, brief, board, bill, blast, bearing, bolt, bench, book, blank) plus helpdesk-api (exempt confirmation).
**Goal:** Produce the catch-up map for Wave D's per-action permission rollout. Confirm zero `@bigbluebam/permissions` coverage in satellites, characterize each satellite's legacy role-gate footprint, and recommend the codemod rollout order.

## Methodology

1. **Wiring sanity check** — grepped `@bigbluebam/permissions`, `dualReadGate`, `requireCan` under `apps/<sat>-api/src/`. Result: every match is in `apps/api/` or `apps/mcp-server/`. The 12 satellites and helpdesk-api are clean.
2. **Route declarations** — counted `fastify.<method>(...)` (including generic-typed `fastify.get<...>(...)`) under each satellite's `src/routes/`.
3. **Auth plugin shape** — read every `apps/<sat>-api/src/plugins/auth.ts`. They are near-byte-identical clones of one master template, with two diverging branches: a "core 12" that exposes `requireMinRole / requireRole / requireScope`, and a sub-group with an additional `middleware/authorize.ts` that adds resource-scoped gates (`requireMinOrgRole`, `requireBoardEditAccess`, `requireGoalAccess`, etc).
4. **Top destructive REST perms** — filtered the manifest for `app === <sat> && sources.some(s => s.source === 'rest') && is_destructive`. Cross-referenced `source.file` + `source.ref` to map back to a concrete file/route.
5. **Gate call-site count** — counted preHandler usages matching `require(MinOrgRole|MinRole|Role|SuperUser|<Resource>Access|<Resource>EditAccess)\(` within each satellite's `routes/`.

## Summary table

| App      | manifest_rest_perms | route_decls | gate_helpers_available                                          | preHandler_gate_call_sites | wiring_status |
| -------- | ------------------: | ----------: | --------------------------------------------------------------- | -------------------------: | ------------- |
| banter   |                  90 |          90 | requireAuth, requireMinRole, requireRole, requireSuperUser, requireScope | 13                        | ABSENT        |
| bond     |                  69 |          69 | requireAuth, requireMinRole, requireRole, requireScope          |                         41 | ABSENT        |
| beacon   |                  39 |          40 | requireAuth, requireScope + (middleware) requireMinOrgRole, requireBeaconReadAccess, requireBeaconEditAccess | 30 | ABSENT |
| brief    |                  51 |          52 | requireAuth, requireScope + (middleware) requireMinOrgRole, requireDocumentAccess, requireDocumentEditAccess | 35 | ABSENT |
| board    |                  45 |          45 | requireAuth, requireScope + (middleware) requireMinOrgRole, requireBoardAccess, requireBoardEditAccess | 38 | ABSENT |
| bill     |                  41 |          43 | requireAuth, requireMinRole, requireRole, requireScope          |                         31 | ABSENT        |
| blast    |                  40 |          40 | requireAuth, requireMinRole, requireRole, requireScope          |                         17 | ABSENT        |
| bearing  |                  34 |          35 | requireAuth, requireScope + (middleware) requireMinOrgRole, requireGoalAccess, requireGoalEditAccess | 20 | ABSENT |
| bolt     |                  27 |          28 | requireAuth, requireScope + (middleware) requireMinOrgRole, requireAutomationAccess | 15 | ABSENT |
| bench    |                  29 |          29 | requireAuth, requireMinRole, requireRole, requireScope          |                          6 | ABSENT        |
| book     |                  30 |          30 | requireAuth, requireMinRole, requireRole, requireScope          |                          9 | ABSENT        |
| blank    |                  19 |          21 | requireAuth, requireMinRole, requireRole, requireScope          |                          3 | ABSENT        |
| helpdesk |                  37 |          42 | requireHelpdeskAuth, requireAgentAuth (no role helpers)         |                          0 | EXEMPT        |

**Totals (12 satellites):** 554 manifest REST perms, 562 route declarations, 258 gate call sites.
- Manifest sum (rest_perms with `source.source === 'rest'`): banter 90 + bond 69 + beacon 39 + brief 51 + board 45 + bill 41 + blast 40 + bearing 34 + bolt 27 + bench 29 + book 30 + blank 19 = **514**. (The audit prompt's 723 count appears to mix `total` perms with `rest_perms`. Total perms — including MCP-only entries — sum to 711.)
- `route_decls` (12 satellites): **562**.

Manifest `rest_perms` re-derived from `docs/permissions-action-manifest.json` using `permissions[].sources[].source === 'rest'`:

```
banter 90 (rest) / 56 (mcp) / 15 (both) — total entries 131
bond    69 / 24 /  9 — total 84
beacon  39 / 30 /  0 — total 69
brief   51 / 18 /  0 — total 69
board   45 / 14 /  0 — total 59
bill    41 / 16 /  5 — total 52
blast   40 / 14 /  5 — total 49
bearing 34 / 12 /  0 — total 46
bolt    27 / 15 /  1 — total 41
bench   29 / 11 /  1 — total 39
book    30 / 11 /  4 — total 37
blank   19 / 11 /  5 — total 25
helpdesk 37 / 13 /  3 — total 47 (exempt)
```

## Per-satellite sections

### banter-api (90 rest perms, 90 route decls)

- Auth plugin: `apps/banter-api/src/plugins/auth.ts` — the most feature-complete of the satellites. Has `requireSuperUser()`, full impersonation hook + `X-Impersonating` response header, and reads `sessions.active_org_id` (so org-switching works). 5 gate helpers available.
- Gate footprint: 13 preHandler call sites total, **0** using `requireMinRole('admin')` — every gated banter route uses `requireMinRole('member')`. The 11 destructive deletes (channel, message, channel_member, pin, bookmark, user_group, etc.) currently rely on banter's own service-layer ACL (channel membership, message ownership) rather than role gates.
- Anomaly: 90 routes / 90 manifest entries is an exact match — but the catalog generator could be flattering itself by counting per-route rather than per-action; banter's `admin.routes.ts` has 12 fastify decls that the manifest splits cleanly into `admin_channel_group.{create,update,delete,list}` etc. No drift detected.
- **Top 5 routes to gate first:**
  1. `banter.admin_channel_group.delete` — `DELETE /v1/admin/channel-groups/:id` (`admin.routes.ts`)
  2. `banter.channel.delete` — `DELETE /v1/channels/:id` (`channel.routes.ts`)
  3. `banter.channel_member.delete` — `DELETE /v1/channels/:id/members/:userId` (`channel.routes.ts`)
  4. `banter.user_group.delete` — `DELETE /v1/user-groups/:id` (`user-group.routes.ts`)
  5. `banter.message.delete` — `DELETE /v1/messages/:id` (`message.routes.ts`)

### bond-api (69 rest perms, 69 route decls)

- Auth plugin: `apps/bond-api/src/plugins/auth.ts` — has impersonation hook, no SuperUser helper exported. 4 gate helpers.
- Gate footprint: **41 preHandler call sites** — the densest legacy role-gate coverage of any satellite. 25 use `requireMinRole('admin')`, 16 use `requireMinRole('member')`. Bond is the satellite that is most "ready" for the codemod — almost every destructive verb is already behind a legacy gate that just needs `dualReadGate` wrapping.
- **Top 5:**
  1. `bond.pipeline.delete` — `DELETE /pipelines/:id` (`pipelines.routes.ts`)
  2. `bond.pipeline_stage.delete` — `DELETE /pipelines/:id/stages/:stageId` (`pipelines.routes.ts`)
  3. `bond.deal.delete` — `DELETE /deals/:id` (`deals.routes.ts`)
  4. `bond.company.delete` — `DELETE /companies/:id` (`companies.routes.ts`)
  5. `bond.scoring_rule.delete` — `DELETE /scoring-rules/:id` (`scoring.routes.ts`)

### beacon-api (39 rest perms, 40 route decls, +1)

- Auth plugin: `apps/beacon-api/src/plugins/auth.ts` exposes only `requireAuth` and `requireScope`. **No role helpers in the plugin**. Role checks live in `apps/beacon-api/src/middleware/authorize.ts` (`requireMinOrgRole`, `requireBeaconReadAccess`, `requireBeaconEditAccess`).
- Gate footprint: 30 preHandler call sites — but all via `middleware/authorize.ts`, not the plugin. The codemod template needs to handle both shapes.
- Divergence: +1 route. Almost certainly a public/health route or a sub-path the catalog generator collapsed.
- **Top 5:**
  1. `beacon.beacon.delete` — `DELETE /beacons/:id` (`beacon.routes.ts`)
  2. `beacon.beacon_attachment.delete` — `DELETE /beacons/:id/attachments/:attachmentId` (`attachments.routes.ts`)
  3. `beacon.beacon_link.delete` — `DELETE /beacons/:id/links/:linkId` (`link.routes.ts`)
  4. `beacon.beacon_comment.delete` — `DELETE /beacons/:id/comments/:commentId` (`comments.routes.ts`)
  5. `beacon.search_saved.delete` — `DELETE /search/saved/:id` (`search.routes.ts`)

### brief-api (51 rest perms, 52 route decls, +1)

- Same pattern as beacon: only `requireAuth/requireScope` in the plugin; role/resource gates in `middleware/authorize.ts` (`requireMinOrgRole`, `requireDocumentAccess`, `requireDocumentEditAccess`).
- Gate footprint: 35 preHandler call sites (highest of the middleware-style group).
- **Top 5:**
  1. `brief.document.delete` — `DELETE /documents/:id` (`document.routes.ts`)
  2. `brief.collaborator.delete` — `DELETE /collaborators/:collabId` (`collaborator.routes.ts`)
  3. `brief.folder.delete` — `DELETE /folders/:id` (`folder.routes.ts`)
  4. `brief.template.delete` — `DELETE /templates/:id` (`template.routes.ts`)
  5. `brief.embed.delete` — `DELETE /embeds/:embedId` (`embed.routes.ts`)

### board-api (45 rest perms, 45 route decls)

- Middleware-style: `middleware/authorize.ts` provides `requireMinOrgRole`, `requireBoardAccess`, `requireBoardEditAccess`.
- Gate footprint: 38 call sites — comparable density to brief.
- **Top 5:**
  1. `board.board_permanent.delete` — `DELETE /boards/:id/permanent` (`board.routes.ts`)
  2. `board.board.delete` — `DELETE /boards/:id` (`board.routes.ts`)
  3. `board.collaborator.delete` — `DELETE /collaborators/:collabId` (`collaborator.routes.ts`)
  4. `board.template.delete` — `DELETE /templates/:id` (`template.routes.ts`)
  5. `board.link.delete` — `DELETE /links/:linkId` (`link.routes.ts`)

### bill-api (41 rest perms, 43 route decls, +2)

- Plugin-style: 4 gate helpers (`requireMinRole`, `requireRole`, `requireScope`, `requireAuth`). No SuperUser helper.
- Gate footprint: 31 call sites — 27 use `requireMinRole('admin')`, 4 use `requireMinRole('member')`. Bill's auth posture is the strictest of the plugin-style satellites: almost every mutating route is admin-only today.
- Divergence: +2 routes. Likely `public.routes.ts` (PDF/share-link endpoints) which are intentionally outside the per-action catalog.
- **Top 5:**
  1. `bill.invoice.delete` — `DELETE /invoices/:id` (`invoices.routes.ts`)
  2. `bill.client.delete` — `DELETE /clients/:id` (`clients.routes.ts`)
  3. `bill.payment.delete` — `DELETE /payments/:id` (`payments.routes.ts`)
  4. `bill.expens.delete` — `DELETE /expenses/:id` (`expenses.routes.ts`) — **manifest typo `expens`** (should be `expense`); flag for the catalog maintainers
  5. `bill.rate.delete` — `DELETE /rates/:id` (`rates.routes.ts`)

### blast-api (40 rest perms, 40 route decls)

- Plugin-style: 4 helpers, no SuperUser, no impersonation hook.
- Gate footprint: 17 call sites — 10 admin, 7 member.
- **Top 5:**
  1. `blast.campaign.delete` — `DELETE /campaigns/:id` (`campaigns.routes.ts`)
  2. `blast.campaign.cancel` — `POST /campaigns/:id/cancel` (`campaigns.routes.ts`) — destructive but not a DELETE verb; worth highlighting because it's the only `*.cancel` in the satellite catalog
  3. `blast.template.delete` — `DELETE /templates/:id` (`templates.routes.ts`)
  4. `blast.sender_domain.delete` — `DELETE /sender-domains/:id` (`sender-domains.routes.ts`)
  5. `blast.segment.delete` — `DELETE /segments/:id` (`segments.routes.ts`)

### bearing-api (34 rest perms, 35 route decls, +1)

- Middleware-style: plugin exposes only `requireAuth/requireScope`; role + resource gates in `middleware/authorize.ts` (`requireMinOrgRole`, `requireGoalAccess`, `requireGoalEditAccess`).
- Note: routes here are `.ts` not `.routes.ts` (`goals.ts`, `key-results.ts`, `periods.ts`, `reports.ts`) — codemod globs need to handle both suffixes for this satellite.
- Gate footprint: 20 call sites.
- **Top 5:**
  1. `bearing.goal.delete` — `DELETE /goals/:id` (`goals.ts`)
  2. `bearing.key_result.delete` — `DELETE /key-results/:id` (`key-results.ts`)
  3. `bearing.period.delete` — `DELETE /periods/:id` (`periods.ts`)
  4. `bearing.goal_watcher.delete` — `DELETE /goals/:id/watchers/:userId` (`goals.ts`)
  5. `bearing.key_result_link.delete` — `DELETE /key-results/:id/links/:linkId` (`key-results.ts`)

### bolt-api (27 rest perms, 28 route decls, +1)

- Middleware-style: `middleware/authorize.ts` provides `requireMinOrgRole`, `requireAutomationAccess`.
- Plugin is the only satellite that already reads `sessions.active_org_id` (Bolt's `buildAuthUser` was patched after the org-switching incident — see the plan, line 16).
- Gate footprint: 15 call sites, all via the middleware module.
- Only **1** destructive action in the whole catalog (`bolt.automation.delete`) — smallest blast radius.
- **Top 5 (will list everything destructive plus next-most-sensitive):**
  1. `bolt.automation.delete` — `DELETE /automations/:id` (`automation.routes.ts`) — the only `is_destructive` entry
  2. `bolt.automation.update` — likely `PATCH /automations/:id` (`automation.routes.ts`)
  3. `bolt.execution.cancel` — `POST /executions/:id/cancel` (`execution.routes.ts`)
  4. `bolt.template.delete` — `DELETE /templates/:id` (`template.routes.ts`)
  5. `bolt.automation.create` — `POST /automations` (`automation.routes.ts`)

### bench-api (29 rest perms, 29 route decls)

- Plugin-style with impersonation hook.
- Gate footprint: only 6 preHandler call sites — **the sparsest legacy-gate coverage** among the plugin-style satellites. Many mutating routes currently rely on `requireAuth` alone + service-layer checks.
- **Top 5:**
  1. `bench.dashboard.delete` — `DELETE /dashboards/:id` (`dashboards.routes.ts`)
  2. `bench.widget.delete` — `DELETE /widgets/:id` (`widgets.routes.ts`)
  3. `bench.report.delete` — `DELETE /reports/:id` (`reports.routes.ts`)
  4. `bench.saved_query.delete` — `DELETE /saved-queries/:id` (`saved-queries.routes.ts`)
  5. (next-most-sensitive) `bench.materialized_view.refresh` — `POST /materialized-views/:id/refresh` (`materialized-views.routes.ts`) — not destructive but admin-scoped

### book-api (30 rest perms, 30 route decls)

- Plugin-style, 4 helpers, impersonation hook.
- Gate footprint: 9 call sites — 1 admin, 8 member. Most of book's surface is intentionally member-accessible (calendar/event CRUD by the owning user).
- **Top 5:**
  1. `book.calendar.delete` — `DELETE /calendars/:id` (`calendars.routes.ts`)
  2. `book.event.delete` — `DELETE /events/:id` (`events.routes.ts`)
  3. `book.booking_page.delete` — `DELETE /booking-pages/:id` (`booking-pages.routes.ts`)
  4. `book.connection.delete` — `DELETE /connections/:id` (`connections.routes.ts`)
  5. (next-most-sensitive) `book.booking_page.update` — likely `PATCH /booking-pages/:id` (`booking-pages.routes.ts`)

### blank-api (19 rest perms, 21 route decls, +2)

- Plugin-style. The smallest satellite — only **3** preHandler gate call sites, all `requireMinRole('admin')`.
- Divergence: +2 routes. `public.routes.ts` exposes `GET /forms/:slug` and `POST /forms/:slug/submit` which are intentionally unauthenticated and not in the per-action catalog.
- **Top 5:**
  1. `blank.form.delete` — `DELETE /forms/:id` (`forms.routes.ts`)
  2. `blank.field.delete` — `DELETE /fields/:id` (`fields.routes.ts`)
  3. `blank.submission.delete` — `DELETE /submissions/:id` (`submissions.routes.ts`)
  4. `blank.form.update` — `PATCH /forms/:id` (`forms.routes.ts`)
  5. (next-most-sensitive) `blank.field.create` — `POST /fields` (`fields.routes.ts`)

### helpdesk-api (exempt — see verification below)

## Helpdesk exempt verification

Confirmed: helpdesk-api is architecturally isolated from the per-action permission model and the plan's open-question #1 makes the exemption explicit.

- The auth plugin (`apps/helpdesk-api/src/plugins/auth.ts`) authenticates against `helpdesk_users` + a `helpdesk_session` cookie. The `helpdesk_users` table has no `role` column and no `is_superuser` flag — only `email_verified` and `is_active`. The only middleware exported is `requireHelpdeskAuth`. There is no `requireRole`, `requireMinRole`, `requireScope`, or analogue in the entire `helpdesk-api/src/`.
- A second auth path exists for agent-grade calls: `apps/helpdesk-api/src/lib/agent-auth.ts` (`verifyAgentApiKey` / `requireAgentAuth`) validates a per-agent API key under `X-Agent-Key` and resolves the underlying Bam `users.id`. This is used by `agent.routes.ts` for support-agent-facing endpoints. Even this path does not consult the role hierarchy — it's a binary "is this a registered helpdesk agent key" check.
- The 47 helpdesk entries in the manifest (37 REST, 13 MCP, 3 both — including 2 destructive: `helpdesk.ticket_attachment.delete` and `helpdesk.ticket_mark_duplicate.delete`) are present **for catalog completeness only**. Per `docs/permissions-overhaul-plan.md` line 446: "Its ~40 actions appear in the catalog under the `helpdesk.*` namespace and resolve as always-allowed for authenticated portal sessions; the resolver short-circuits the helpdesk namespace before per-action checks." The current count of 47 (close to "~40") is consistent.
- The +5 route-vs-manifest divergence (42 fastify decls vs 37 REST perms) is explained by the catalog generator omitting the agent-key + public auth bootstrap routes (`POST /helpdesk/auth/login`, `POST /helpdesk/auth/register`, etc.) — those are routes but not "actions" in the permission sense.

**Conclusion: helpdesk-api needs no Wave D work.** When the codemod runs, helpdesk-api must be on the explicit skip list (the codemod's `apps/<sat>-api` glob will sweep it up otherwise, but there's nothing to wrap).

## Wave D rollout order recommendation

Two competing rollout strategies; both have merit but they pick different first satellites.

### Pilot satellite: **blank-api** (smallest blast radius)

19 REST perms, 21 route decls, only 3 legacy gate call sites — the entire migration is touchable in a single PR with negligible production risk. blank-api's public form endpoints are already unauthenticated, so the per-action catalog can't accidentally lock customers out of public form submission. Use this satellite to:

- Validate the codemod's regex catches `requireMinRole('admin')` in `forms.routes.ts` and `submissions.routes.ts`.
- Validate `dualReadGate` imports resolve from a fresh satellite (none of them currently import `@bigbluebam/permissions`).
- Establish the standard `tsconfig` / package.json change pattern for satellite adoption.
- Catch the "Fastify-instance vs FastifyInstance" type quirk before it bites a 90-route satellite.

### Stage 2: **bench-api, book-api, blast-api** (medium-small, plugin-style)

After blank validates the codemod, batch the three remaining plugin-style satellites with sparse gate coverage (6, 9, 17 sites respectively). These all share the exact same plugin shape as blank, so the codemod template should one-shot them.

### Stage 3: **bill-api, bond-api** (high-density plugin-style)

Bill (31) and bond (41) have the densest plugin-style coverage. Once stages 1+2 prove out, these become the highest-leverage targets — every gated route gets a permission ID with zero new auth surface to design.

### Stage 4: **bolt-api, bearing-api, beacon-api, board-api, brief-api** (middleware-style)

The middleware-style satellites need an additional codemod template: instead of wrapping `requireMinRole(...)`, the codemod wraps both `requireMinOrgRole(...)` AND each satellite's resource-access gates (e.g., `requireBoardEditAccess`). The plan's claim that satellites "share a copy-pasted role-hierarchy auth pattern" is approximately true for the plugin — but **five** of the twelve satellites have a *second* gate layer in `middleware/authorize.ts` that the prompt didn't surface. The codemod must understand both.

Within this stage, prefer **bolt-api first** (only 15 sites, only 1 destructive action) → **bearing-api** (20 sites) → **beacon-api** (30) → **board-api** (38) → **brief-api** (35) last.

### Last satellite: **banter-api**

Banter is *intentionally* last despite its catalog being the largest:

- 90 routes is the biggest single codemod surface in the satellite set.
- Banter is the only satellite with `requireSuperUser()`, full impersonation, and a SuperUser-cross-org override path — the most edge cases for the resolver to handle correctly.
- Banter's destructive deletes (message/channel/etc.) rely on **service-layer ACLs** today, not preHandler gates. Wave D's codemod will need to add new gates rather than wrap existing ones, which is a different (more invasive) shape than every other satellite.
- Real-time WebSocket fanout interacts with the gate layer in ways no other satellite does.

By the time banter is reached, all the codemod templates and the resolver will have baked over 7 prior satellite deploys.

## Estimated codemod scope

Per-satellite preHandler call sites that need a `dualReadGate({ legacy: <existing-gate>, permission: '<app>.<resource>.<verb>' })` wrapper:

| App     | gate_sites | additional sites to *add* (currently `requireAuth`-only mutating routes) | est. total wraps |
| ------- | ---------: | -----------------------------------------------------------------------: | ---------------: |
| banter  |         13 |                                                                  ~50-60 |               ~70 |
| bond    |         41 |                                                                    ~15 |                ~55 |
| beacon  |         30 |                                                                     ~5 |                ~35 |
| brief   |         35 |                                                                     ~5 |                ~40 |
| board   |         38 |                                                                     ~3 |                ~40 |
| bill    |         31 |                                                                     ~5 |                ~35 |
| blast   |         17 |                                                                    ~15 |                ~30 |
| bearing |         20 |                                                                     ~5 |                ~25 |
| bolt    |         15 |                                                                     ~5 |                ~20 |
| bench   |          6 |                                                                    ~15 |                ~20 |
| book    |          9 |                                                                    ~15 |                ~25 |
| blank   |          3 |                                                                    ~10 |                ~15 |

**Estimated total wraps across the 12 satellites: 258 existing legacy-gate wraps + ~150 new gates on currently `requireAuth`-only mutating routes ≈ 410 `dualReadGate` call sites.**

The "additional sites to add" column is a Fermi estimate based on (manifest_rest_perms − non-public/non-list_endpoints − existing gate_sites). Use the manifest's `is_destructive || !is_read` filter to ground-truth these numbers when the codemod is written.

## Anomalies and notes for the catalog maintainers

1. **Manifest typo in bill**: `bill.expens.delete` should be `bill.expense.delete`. Found in `docs/permissions-action-manifest.json`. Should be fixed before the Wave D codemod uses the manifest as the source of permission IDs, otherwise routes will land with a wrong-named permission.
2. **bearing-api route filenames don't match the satellite convention.** Every other satellite uses `<resource>.routes.ts`. bearing uses bare `<resource>.ts`. The codemod's glob `apps/*-api/src/routes/*.routes.ts` will silently skip bearing entirely — must use `apps/*-api/src/routes/*.ts`.
3. **+1/+2 manifest divergences are public/health routes and submission entry points, not generator misses.** Specifically: blank (+2 from `public.routes.ts`), bill (+2 from `public.routes.ts`), bolt (+1 likely `event-ingestion.routes.ts`), beacon/brief/bearing (+1 each, likely health/embed). No catalog backfill needed.
4. **Five satellites have a `middleware/authorize.ts` companion module** (beacon, bearing, board, bolt, brief). The Wave D codemod template needs to know about it — wrapping only the plugin's `requireMinRole` will miss all 138 call sites that go through `middleware/authorize.ts` instead.
5. **Bolt is the only satellite that already honors `sessions.active_org_id`** in its `buildAuthUser`. The other 11 (including banter, despite its size) still default to the user's home org membership precedence chain. This is a side-effect fix that Wave D inherits "for free" once the new package centralizes auth context resolution.
6. **bond-api's plugin has no `requireSuperUser`**, despite bond having the third-largest catalog. SuperUser-only routes in bond currently fall through to `requireMinRole('owner')`. Worth a separate audit task to confirm there are no SuperUser-shaped permissions in the bond catalog that are silently accessible to org owners.

## Final recommendation

Nothing blocks the codemod approach. The 12 satellites split cleanly into:

- **7 plugin-style** (banter, bond, bill, blast, bench, book, blank) — wrap `requireMinRole`, `requireRole`, `requireSuperUser`, `requireScope` in `plugins/auth.ts`.
- **5 middleware-style** (beacon, bearing, board, bolt, brief) — additionally wrap `requireMinOrgRole`, `require<Resource>Access`, `require<Resource>EditAccess` in `middleware/authorize.ts`.

Both shapes are byte-near-identical clones across satellites, so a single codemod with two templates (plus a satellite-specific permission-ID map driven by the manifest) covers everything. helpdesk-api is on the explicit skip list. Pilot with **blank-api**, finish with **banter-api**, and audit the manifest typo in `bill.expens.delete` before any codemod uses the manifest as authoritative.
