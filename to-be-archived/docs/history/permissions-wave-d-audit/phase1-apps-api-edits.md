# Wave D Phase 1 — route edits log

_Generated as part of the permissions overhaul (Wave D Phase 1)._

## 1. Summary

- **Routes touched (decisions processed):** 97 (83 `shadow_only` + 14 `require_can`).
- **Routes edited in code:** 95 (the two `banter.*` duplicate-claim decisions on `user.routes.ts:142` and `:186` share a route line with their `bam.*` siblings and are gated with the canonical `bam.*` permission_id only, per spec).
- **Files touched:** 39 route files under `apps/api/src/routes/`.
- **Imports added:** `shadowOnly` was added in 39 files. Of those, 22 files already imported `dualReadGate` from `../middleware/dual-read.js` and the existing import was extended to `{ dualReadGate, shadowOnly }`; the remaining 17 files added a fresh `import { shadowOnly } from '../middleware/dual-read.js';` line. `fastify.requireCan(...)` calls require no import (provided by the permissions plugin).
- **Verification:** `pnpm --filter @bigbluebam/api typecheck` passes with zero errors. `node scripts/wave-d-audit.mjs` now reports `NO_GATE: 0` for `apps/api` (down from 125), `OK: 215 / 217`, `MISMATCH: 2` (the documented `banter.*` double-claim caveat on `user.routes.ts`).
- **Stale permission_id renames applied during edit:**
  - `bam.project_phas.get` → `bam.project_phase.get`
  - `bam.phas.update` → `bam.phase.update`
  - `bam.phas.delete` → `bam.phase.delete`
  - `bam.file_*.list` → `bam.file.list`

## 2. Per-file breakdown

| File | `requireCan` adds | `shadowOnly` adds | Total |
|---|---:|---:|---:|
| `activity-unified.routes.ts` | 0 | 2 | 2 |
| `activity.routes.ts` | 0 | 2 | 2 |
| `agent-policies.routes.ts` | 0 | 4 | 4 |
| `agent-webhooks.routes.ts` | 0 | 4 | 4 |
| `agent.routes.ts` | 0 | 3 | 3 |
| `api-key.routes.ts` | 1 | 0 | 1 |
| `approval.routes.ts` | 0 | 1 | 1 |
| `attachment-meta.routes.ts` | 0 | 3 | 3 |
| `attachment.routes.ts` | 0 | 1 | 1 |
| `comment.routes.ts` | 0 | 1 | 1 |
| `custom-field.routes.ts` | 0 | 1 | 1 |
| `dedupe-decisions.routes.ts` | 0 | 2 | 2 |
| `entity-links.routes.ts` | 1 | 2 | 3 |
| `epic.routes.ts` | 0 | 1 | 1 |
| `expertise.routes.ts` | 0 | 1 | 1 |
| `export.routes.ts` | 0 | 1 | 1 |
| `github-integration.routes.ts` | 0 | 1 | 1 |
| `label.routes.ts` | 0 | 2 | 2 |
| `launchpad.routes.ts` | 0 | 1 | 1 |
| `notification.routes.ts` | 0 | 4 | 4 |
| `org.routes.ts` | 0 | 4 | 4 |
| `phase.routes.ts` | 1 | 2 | 3 |
| `platform.routes.ts` | 11 | 0 | 11 |
| `project.routes.ts` | 0 | 3 | 3 |
| `proposals.routes.ts` | 0 | 3 | 3 |
| `reaction.routes.ts` | 0 | 1 | 1 |
| `report.routes.ts` | 0 | 8 | 8 |
| `service-account.routes.ts` | 0 | 1 | 1 |
| `slack-integration.routes.ts` | 0 | 1 | 1 |
| `sprint.routes.ts` | 0 | 3 | 3 |
| `system-settings.routes.ts` | 0 | 1 | 1 |
| `task-analytics.routes.ts` | 0 | 1 | 1 |
| `task-state.routes.ts` | 0 | 1 | 1 |
| `task.routes.ts` | 0 | 4 | 4 |
| `template.routes.ts` | 0 | 1 | 1 |
| `time-entry.routes.ts` | 0 | 2 | 2 |
| `upload.routes.ts` | 0 | 1 | 1 |
| `user.routes.ts` | 0 | 4 | 4 |
| `view.routes.ts` | 0 | 1 | 1 |
| `visibility.routes.ts` | 0 | 1 | 1 |
| `webhook.routes.ts` | 0 | 1 | 1 |
| **TOTAL** | **14** | **81** | **95** |

Note: 81 distinct `shadowOnly(...)` call sites land for 83 `shadow_only` decisions because two decisions in `user.routes.ts` (lines 142 and 186) are double-claimed between `bam.*` and `banter.*`, and the spec instructs us to gate with the canonical `bam.*` id for both — so two decisions collapse into one route edit at each of those two lines (97 decisions → 95 route edits; 83 shadow_only → 81 actual `shadowOnly(...)` insertions).

## 3. Skipped decisions

No `shadow_only` or `require_can` decision was found in any of the skip-listed files (`auth.routes.ts`, `oauth.routes.ts`, `email-verify.routes.ts`, `public-config.routes.ts`, `github-webhook.routes.ts`, `slack-webhook.routes.ts`, `internal-helpdesk.routes.ts`, `internal-llm.routes.ts`, `ical.routes.ts`) or under the skip-listed path prefixes (`/internal/`, `/health`, `/version`, `/public/`, `/webhooks/`, `/me/calendar.ics`, `/projects/:id/calendar.ics`, `/root-redirect`, `/v1/agents/heartbeat`, `/v1/guests/accept/`).

The `agent.routes.ts:67` `POST /v1/agents/heartbeat` decision (`bam.agent.heartbeat`) is correctly classified `remove_from_catalog` in the triage and was not touched — only the three `shadow_only` agent routes (`/self-report`, `/:id/audit`, `/`) were edited.

The `system-settings.routes.ts:229` `GET /root-redirect` row is `remove_from_catalog`. The only `shadow_only` decision in `system-settings.routes.ts` is `bam.system_setting.get` at line 117, which was edited.

## 4. Anomalies

1. **Double-claim caveat on `user.routes.ts`** (triage anomaly §5.1). The audit re-run reports two MISMATCH rows:
   - `banter.user_by_email.list` at line 142 (gated by `shadowOnly('bam.user_by_email.list')`)
   - `banter.user_search.list` at line 186 (gated by `shadowOnly('bam.user_search.list')`)

   Both are expected per spec — the `banter.*` duplicates need to be dropped from the manifest in a Phase 1 catalog-cleanup follow-up. Two distinct gates cannot fire on the same route at runtime.

2. **`platform.routes.ts` uses a shared `suPreHandler` array.** Rather than duplicating `[requireAuth, requireSuperUser, fastify.requireCan('...')]` for every route, the eleven require_can adds are spread-merged: `{ preHandler: [...suPreHandler, fastify.requireCan('...')] }`. This preserves the existing `requireAuth + requireSuperUser` legacy gate while appending the resolver as the last preHandler. The single exception is `POST /v1/platform/stop-impersonation`, which uses `[requireAuth]` only (no `requireSuperUser`) because the user must be in impersonation mode — for that one we appended directly to the inline `[requireAuth]` array.

3. **Stale permission_ids in triage corrected during edits** (`bam.project_phas.get` → `bam.project_phase.get`, `bam.phas.update` → `bam.phase.update`, `bam.phas.delete` → `bam.phase.delete`, `bam.file_*.list` → `bam.file.list`). The manifest already carries the corrected ids; the triage JSON predates the Phase 0 rename.

4. **`bam.entity_link.delete` is destructive.** It is the only destructive route in the `require_can` set outside of `platform.routes.ts`; gated with `fastify.requireCan('bam.entity_link.delete')` as the last entry of its preHandler. `bam.phase.delete` and `bam.platform_org.delete` are the two other destructive promotions; both are present.

5. **`bam.attachment__meta.list` permission_id has a double underscore** (originates from the static `/v1/attachments/_meta` path). Recorded as-is; flagged for a manifest cleanup pass since it does not match the `<resource>.<verb>` convention.

6. **`bam.agent_runner_webhook.rotate` uses an unconventional verb** (`rotate` instead of `create`/`update`). Recorded as-is; consistent with the actual semantics (atomic secret rotation, not a generic upsert).

## 5. Verification commands run

```bash
pnpm --filter @bigbluebam/api typecheck      # exit 0, zero errors
node scripts/wave-d-audit.mjs                # NO_GATE: 0 (was 125), MISMATCH: 2 (documented)
```
