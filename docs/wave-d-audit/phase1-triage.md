# Wave D Phase 1 triage — apps/api NO_GATE classification

_Generated 2026-05-17, companion to `phase1-triage.json` and `apps-api.md`._

Triages every row in `apps-api.md` §3.3 NO_GATE (125 entries) plus the 1 INLINE_CHECK row at `api-key.routes.ts:24` into one of three buckets:

- **(a) REMOVE_FROM_CATALOG** — route is genuinely public / webhook / internal-service; not a user action.
- **(b) SHADOW_ONLY** — real user action, correct gate is uncertain or read-only; wrap with `shadowOnly('<id>')` to collect resolver telemetry without enforcing.
- **(c) REQUIRE_CAN** — real user action, correct permission_id is known, missing gate is a bug; promote with `fastify.requireCan('<id>')`.

## 1. Counts

| Bucket | Count | Notes |
|---|---:|---|
| REMOVE_FROM_CATALOG | 29 | All 29 are NO_GATE rows. |
| SHADOW_ONLY | 83 | All 83 are NO_GATE rows. |
| REQUIRE_CAN | 14 | 13 from NO_GATE + 1 from INLINE_CHECK. |
| **Total decisions** | **126** | 125 NO_GATE + 1 INLINE_CHECK |

NO_GATE balance: 29 + 83 + 13 = 125. INLINE_CHECK (1) folded into require_can.

## 2. Per-file breakdown

| File | REMOVE | SHADOW_ONLY | REQUIRE_CAN | Notes |
|---|---:|---:|---:|---|
| `activity-unified.routes.ts` | 0 | 2 | 0 | Cross-app activity reads. |
| `activity.routes.ts` | 0 | 2 | 0 | Project/task activity reads. |
| `agent-policies.routes.ts` | 0 | 4 | 0 | Real admin actions; collect telemetry first. |
| `agent-webhooks.routes.ts` | 0 | 4 | 0 | Webhook config (admin-ish); SHADOW_ONLY first. |
| `agent.routes.ts` | 1 | 3 | 0 | Heartbeat REMOVE; self_report/audit/list SHADOW. |
| `api-key.routes.ts` | 0 | 0 | 1 | INLINE_CHECK row; heuristic false positive — promote to requireCan. |
| `approval.routes.ts` | 0 | 1 | 0 | Approval publish write. |
| `attachment-meta.routes.ts` | 0 | 3 | 0 | Federated attachment reads w/ built-in visibility preflight. |
| `attachment.routes.ts` | 0 | 1 | 0 | Task attachment list (read). |
| `auth.routes.ts` | 9 | 0 | 0 | Whole file REMOVE — authentication lifecycle. |
| `comment.routes.ts` | 0 | 1 | 0 | Task comment list (read). |
| `custom-field.routes.ts` | 0 | 1 | 0 | Project custom field list (read). |
| `dedupe-decisions.routes.ts` | 0 | 2 | 0 | Dedupe decision write + pending list. |
| `email-verify.routes.ts` | 1 | 0 | 0 | Whole file REMOVE — public token verification. |
| `entity-links.routes.ts` | 0 | 2 | 1 | DELETE is destructive → requireCan; create/list SHADOW. |
| `epic.routes.ts` | 0 | 1 | 0 | Project epic list (read). |
| `expertise.routes.ts` | 0 | 1 | 0 | POST-shaped read. |
| `export.routes.ts` | 0 | 1 | 0 | Project export (POST-shaped read). |
| `github-integration.routes.ts` | 0 | 1 | 0 | Task GitHub refs read. |
| `github-webhook.routes.ts` | 1 | 0 | 0 | Whole file REMOVE — HMAC-authed receiver. |
| `guest.routes.ts` | 1 | 0 | 0 | Single REMOVE row (guest_accept.create token flow); other routes in file already have dualReadGate. |
| `ical.routes.ts` | 2 | 0 | 0 | Whole file REMOVE — calendar feed surface. |
| `internal-helpdesk.routes.ts` | 5 | 0 | 0 | Whole file REMOVE — /internal/helpdesk prefix, requireServiceAuth. |
| `internal-llm.routes.ts` | 1 | 0 | 0 | Whole file REMOVE — /internal/llm prefix, requireInternalAuth. |
| `label.routes.ts` | 0 | 2 | 0 | Label lists (reads). |
| `launchpad.routes.ts` | 0 | 1 | 0 | Resolved launchpad list (read). |
| `notification.routes.ts` | 0 | 4 | 0 | User-self notification feed + mark-read variants. |
| `oauth.routes.ts` | 4 | 0 | 0 | Whole file REMOVE — OAuth handshake. |
| `org.routes.ts` | 0 | 4 | 0 | org.list, org_member.list/invite/invite_bulk. |
| `phase.routes.ts` | 0 | 2 | 1 | DELETE is destructive → requireCan; get/update SHADOW. |
| `platform.routes.ts` | 0 | 0 | 11 | All 11 are SuperUser-gated by legacy `requireSuperUser`; promote every one. |
| `project.routes.ts` | 0 | 3 | 0 | list/get/member.get reads. |
| `proposals.routes.ts` | 0 | 3 | 0 | create/list/decide. |
| `public-config.routes.ts` | 2 | 0 | 0 | Whole file REMOVE — unauthenticated public endpoints. |
| `reaction.routes.ts` | 0 | 1 | 0 | Comment reactions read. |
| `report.routes.ts` | 0 | 8 | 0 | All 8 project reports (reads). |
| `service-account.routes.ts` | 0 | 1 | 0 | Service-account list (read). |
| `slack-integration.routes.ts` | 0 | 1 | 0 | Slack integration config read. |
| `slack-webhook.routes.ts` | 1 | 0 | 0 | Whole file REMOVE — Slack token auth. |
| `sprint.routes.ts` | 0 | 3 | 0 | Sprint reads. |
| `system-settings.routes.ts` | 1 | 1 | 0 | root_redirect REMOVE; system_setting.get SHADOW. |
| `task-analytics.routes.ts` | 0 | 1 | 0 | Cross-project analytic read. |
| `task-state.routes.ts` | 0 | 1 | 0 | Project task-states read. |
| `task.routes.ts` | 0 | 4 | 0 | list/board/by-ref/get reads. |
| `template.routes.ts` | 0 | 1 | 0 | Task template list (read). |
| `time-entry.routes.ts` | 0 | 2 | 0 | Task and me-time-entry reads. |
| `upload.routes.ts` | 0 | 1 | 0 | Authenticated /files/* proxy. |
| `user.routes.ts` | 0 | 6 | 0 | list/get/by-email (x2)/search (x2). Two double-claims with banter.* — see anomalies. |
| `view.routes.ts` | 0 | 1 | 0 | Saved views list (read). |
| `visibility.routes.ts` | 0 | 1 | 0 | Visibility preflight (candidate for is_core later). |
| `webhook.routes.ts` | 0 | 1 | 0 | Project webhook config list. |

## 3. Ten highest-stakes decisions

Sorted by priority weight = `requires_superuser*4 + destructive*3 + non_read*2 + 1`.

| # | permission_id | method+path | file:line | decision | rationale |
|---|---|---|---|---|---|
| 1 | `bam.platform_org.delete` | DELETE /v1/platform/orgs/:id | platform.routes.ts:188 | require_can | SU + destructive; legacy SU gate present, promote to requireCan. |
| 2 | `bam.platform_user_superuser.update` | PATCH /v1/platform/users/:id/superuser | platform.routes.ts:254 | require_can | SU grant — extremely sensitive write, legacy SU gate present. |
| 3 | `bam.platform_impersonate.create` | POST /v1/platform/impersonate | platform.routes.ts:287 | require_can | SU impersonation start, legacy SU gate present. |
| 4 | `bam.platform_org.create` | POST /v1/platform/orgs | platform.routes.ts:96 | require_can | SU-only cross-org create. |
| 5 | `bam.platform_org.update` | PATCH /v1/platform/orgs/:id | platform.routes.ts:153 | require_can | SU-only cross-org update. |
| 6 | `bam.platform_stop_impersonation.create` | POST /v1/platform/stop-impersonation | platform.routes.ts:367 | require_can | SU impersonation stop. |
| 7 | `bam.platform_org.list` | GET /v1/platform/orgs | platform.routes.ts:65 | require_can | SU-only cross-org list. |
| 8 | `bam.platform_org.get` | GET /v1/platform/orgs/:id | platform.routes.ts:123 | require_can | SU-only cross-org read. |
| 9 | `bam.platform_org_member.get` | GET /v1/platform/orgs/:id/members | platform.routes.ts:228 | require_can | SU-only cross-org member roster. |
| 10 | `bam.platform_impersonation_session.list` | GET /v1/platform/impersonation-sessions | platform.routes.ts:406 | require_can | SU-only audit read. |

All 11 `platform.routes.ts` rows are require_can; only 10 fit in the table. The 11th is `bam.platform_audit_log.list` (GET /v1/platform/audit-log, line 442), same justification.

**Other destructive require_can decisions (not SU-flagged):**
- `bam.entity_link.delete` (entity-links.routes.ts:161) — DELETE on cross-app linkage.
- `bam.phas.delete` (phase.routes.ts:94) — DELETE on a project phase; today only gated by entity-visibility.

**Uncertainty calls flagged for re-review:**
- `bam.agent.heartbeat` REMOVE: aligns with MCP "always-permitted core" set. If the permissions team prefers to keep heartbeats catalogued for resolver-side audit, reclassify to SHADOW_ONLY (non-disruptive — requireAuth + requireServiceKind already present).
- `bam.visibility_can_access.create` SHADOW_ONLY: also a candidate for "always-permitted core" given every cross-app agent calls it. Left as SHADOW for now to collect data on call patterns first.

## 4. Recommended generator changes

To make every (a) REMOVE_FROM_CATALOG row disappear from the next manifest run, `scripts/generate-permission-manifest.mjs::EXCLUDED_PATH_PREFIXES` (currently `['/internal/', '/health', '/healthz', '/readyz', '/version']`) needs to grow, AND a file-level exclusion list should be introduced.

### Proposed `EXCLUDED_PATH_PREFIXES` additions

```js
const EXCLUDED_PATH_PREFIXES = [
  '/internal/', '/health', '/healthz', '/readyz', '/version',
  // Phase 1 additions:
  '/auth/',                      // authentication lifecycle (all of auth.routes.ts + oauth.routes.ts)
  '/public/',                    // unauthenticated public-config endpoints
  '/webhooks/github',            // HMAC-authed inbound webhook
  '/webhooks/slack',             // Slack-token-authed inbound webhook
  '/files/',                     // authenticated MinIO download proxy (per-file authz is entity-level, not per-action)
  '/root-redirect',              // unauthenticated nginx redirect resolver
  '/v1/agents/heartbeat',        // always-permitted-core agent heartbeat (REST mirror of MCP agent_heartbeat)
  '/v1/guests/accept/',          // public guest-invite acceptance via single-use token
];
```

`/projects/:id/calendar.ics` and `/me/calendar.ics` are best handled via the file-level exclusion list below since the route shape varies.

### Proposed new file-level exclusion list

Add a new `EXCLUDED_FILE_BASENAMES` set so that whole files of non-action endpoints can be opted out without enumerating each path:

```js
const EXCLUDED_FILE_BASENAMES = new Set([
  'auth.routes.ts',
  'oauth.routes.ts',
  'email-verify.routes.ts',
  'public-config.routes.ts',
  'github-webhook.routes.ts',
  'slack-webhook.routes.ts',
  'internal-helpdesk.routes.ts',  // also caught by /internal/ but be safe — see anomaly below
  'internal-llm.routes.ts',       // ditto
  'ical.routes.ts',
]);
```

### Anomaly: internal-* routes evade the `/internal/` prefix filter

The audit lists 5 routes in `internal-helpdesk.routes.ts` and 1 in `internal-llm.routes.ts` as NO_GATE. The audit's `isPathExcluded` checks the route's _declared_ path (e.g. `POST /tasks`) and not the mount-prefixed path (e.g. `POST /internal/helpdesk/tasks` after `fastify.register(internalHelpdeskRoutes, { prefix: '/internal/helpdesk' })` in `server.ts`). Two viable fixes:

1. **Short-term (Phase 1):** add the two file basenames to `EXCLUDED_FILE_BASENAMES` above. Cheap, safe, lands today.
2. **Long-term:** teach the generator to read `apps/api/src/server.ts` (or equivalent for each app) and resolve the mount prefix per route file before applying `isPathExcluded`. Higher leverage but a bigger change.

### Proposed in-route opt-out marker

Some legitimately public/internal routes will continue to be added one at a time, and updating the global allowlist for each is friction. Suggest a magic comment:

```ts
// BBB_NO_PERMISSION: reason text here
fastify.post('/some/public/thing', async (req, reply) => { ... });
```

The generator already has the full file text in memory at parse time; matching `/BBB_NO_PERMISSION/` on the line above a `fastify.<verb>` call is a 4-line change. This keeps Phase 2+ exclusions self-documenting and review-friendly.

### Double-claimed routes (NOT a generator issue, but blocks =on)

`user.routes.ts:142` and `:186` are each claimed by **two** manifest entries (`bam.*` plus a `banter.*` namespaced duplicate). The resolver fires exactly one check per request, so only one wins. Recommended fix: drop the `banter.user_by_email.list` and `banter.user_search.list` rows from the manifest catalog and keep the `bam.*` IDs as canonical. These handlers live in `apps/api/src/routes/user.routes.ts` (Bam api), not in the Banter app, so the `bam.*` namespace is correct.

## 5. Recommendations for the rollout

Based on this triage, the Phase 1 → enforce-on path is:

1. **Apply the generator changes** (EXCLUDED_PATH_PREFIXES + EXCLUDED_FILE_BASENAMES additions above). Re-run `pnpm db:check`-style manifest regen and confirm the 29 REMOVE rows drop from the audit's NO_GATE total in the next `wave-d-audit.mjs` run.
2. **Add `shadowOnly('<id>')` to the 83 routes** flagged for SHADOW_ONLY in `phase1-triage.json`. Mechanical mass edit; the new gate is non-enforcing and only adds an entry to `permissions_divergence_log`. Recommend doing this in 5-7 commits grouped by file family (reads vs writes) for review hygiene.
3. **Add `fastify.requireCan('<id>')` to the 14 REQUIRE_CAN routes**, with the 11 platform.routes.ts SU-flagged routes prioritized. These ARE enforcement changes — must be paired with manifest verification that each permission_id maps to a SuperUser-builtin group before the commit lands.
4. **Resolve the two double-claimed manifest entries** (banter.user_by_email.list, banter.user_search.list) before flipping `=on`.
5. **Soak SHADOW_ONLY data for one enforcement window** (one week or one full sprint, whichever is longer). The audit dashboard (`bam.superuser_permission_divergence.list`) should be quiet — any resolver-allows-but-legacy-denies or resolver-denies-but-legacy-allows row needs to be reconciled.
6. **Then flip `BBB_PERMISSIONS_ENFORCE=on`**.
