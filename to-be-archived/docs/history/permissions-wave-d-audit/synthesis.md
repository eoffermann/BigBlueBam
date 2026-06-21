# Wave D synthesis — what blocks `BBB_PERMISSIONS_ENFORCE=on`

_Consolidates `apps-api.md`, `mcp-server.md`, `satellites.md`, `consistency.md` (all generated 2026-05-18)._

## TL;DR

We are not safe to flip yet. The catalog itself is in great shape (1083 IDs agree across manifest, generated TS, and DB; one one-line flag fix needed). What is not in shape is the **gate coverage** on the request paths:

| Surface | Permissions in scope | Actually gated by the new resolver | Action required |
|---|---:|---:|---|
| `apps/api` (Bam main) | 246 | 120 (48.8%) | Triage 125 ungated routes; many are public/system endpoints that should be removed from the catalog, not gated |
| `apps/mcp-server` | 348 | 0 enforced (348 mapped for telemetry only) | One code change in `register-tool.ts` to add a synchronous resolver call |
| 12 satellite APIs | 514 | 0 | Adopt `@bigbluebam/permissions`, run codemod variant; pilot on `blank-api` |
| `apps/helpdesk-api` | 37 (intentionally always-allow) | n/a | Verified exempt per design |
| Catalog consistency | 1083 IDs | 1083 IDs match across all 3 sources | One delta migration for a single `requires_superuser` flag drift, one typo fix |

Estimated work: **~410 codemod wraps** across satellites + ~125 route-triage decisions in `apps/api` + 1 register-tool.ts code change + 2 catalog fixups. None of it is open-ended; the audits enumerated every site.

## Recommended order

### Phase 0 — catalog hygiene (~30 min planned, ~75 min actual) — COMPLETE

These are tiny, isolated, and unlock honest "OK ratios" downstream. Execution log: `SYNTHESIS_PROGRESS.md`.

1. **Fix the requires_superuser flag drift.** Root cause turned out to be a silent flag-drop bug in `scripts/build-permission-delta.mjs` (the INSERT and ON CONFLICT DO UPDATE clauses both omitted `requires_superuser`). Patched the script AND fixed the surviving row via migration `0154_permissions_singularize_repair.sql`.
2. **Fix the `bill.expens.delete` "typo".** This was actually 11 IDs, not one: the manifest generator's `singularize()` over-stripped `es` from any `ses`-ending word, producing `expens`/`phas` for `expenses`/`phases`. Patched `singularize()` in `scripts/generate-permission-manifest.mjs` to use a sibilant-only `(?:ss|x|ch|sh|z)es$` regex; regenerated manifest + TS; renamed 11 IDs (12th merged with an existing MCP-source row) via the same migration `0154`. Two `apps/api/src/routes/phase.routes.ts` references updated.
3. **Extend `scripts/check-permission-catalog.mjs` to also compare against the live DB.** Added `checkDb()` that queries the catalog table and compares ID set + all four flag values against the manifest. Skips silently when Postgres is unreachable. Will catch any future silent drift like the requires_superuser case.

### Phase 0.5 — Plural→singular harmonization (DEFERRED to post-Phase-4)

The catalog has ~64 plural-resource IDs where MCP tool naming preserved plural verbs (`list_epics`, `merge_contacts`, `search_messages`) while REST equivalents produced singular resources. Not a correctness issue — same logical action just split across two IDs. Best handled after enforcement lands and stabilizes; the 0154 migration template is now a proven idiom for ID merges at scale.

### Phase 1 — `apps/api` triage (~1-2 days)

The audit found 125 routes without a permission gate. Almost all of them are not real misses — they're things that should never have been in the catalog:

- 11 `platform.routes.ts` — internal platform RPC, server-to-server only
- 9 `auth.routes.ts` — login/register/bootstrap, must be unauthenticated
- 12 across `agent*.routes.ts` — agent webhook receivers
- 4 `oauth.routes.ts` — public OAuth callback
- 5 `internal-helpdesk.routes.ts` — internal service-to-service
- 4 `notification.routes.ts` — public push receiver
- 2 `public-config.routes.ts`, 2 `ical.routes.ts`, 1 each `github-webhook`/`slack-webhook` — public webhooks
- ~15 more in `user.routes.ts`, `report.routes.ts`, `activity.routes.ts` etc. — some legit gaps

**Concrete action**: walk the 125 NO_GATE rows in `apps-api.md` §3.3 and for each pick one of:
- (a) Remove from catalog (mark in manifest with a new `is_internal` or `is_public` flag; `scripts/generate-permission-manifest.mjs` skips them on regeneration). Best for auth/bootstrap/webhook/system endpoints.
- (b) Add `shadowOnly('<id>')` to start collecting telemetry without enforcing. Best for routes whose correct gate is genuinely uncertain.
- (c) Add `requireCan('<id>')` (no legacy gate) or `dualReadGate({...})` (if there's still a legacy check). Best for real, missed authorization checks.

The default for anything not classifiable in one pass is **(b) shadowOnly** — it costs nothing at runtime, and the divergence dashboard will tell us within a week whether the route needs a real gate.

### Phase 2 — MCP enforcement wiring (a few hours)

`apps/mcp-server/src/lib/register-tool.ts` has the right plumbing — PolicyGate + `TOOL_TO_PERMISSION` + `recordDualRead` — but enforcement is fire-and-forget telemetry only. The fix the audit recommends:

> Add a synchronous resolver call (or `POST /internal/permissions/check` await) between the PolicyGate accept and `opts.handler(args)` in the wrapped handler around `register-tool.ts:393`, gated on `BBB_PERMISSIONS_ENFORCE`. That one change folds `requires_superuser`, API-key scope ceilings, and account-permission overrides into the MCP layer for free, since the resolver already implements all three.

Also: the MCP server doesn't currently read `BBB_PERMISSIONS_ENFORCE` at all. Add it to `apps/mcp-server/src/env.ts` and thread it through.

### Phase 3 — satellite codemod (parallelizable, ~1 day for pilot + ~1 day per remaining wave)

Sequence per the satellites report:

1. **Adapt `scripts/codemod-add-dual-read.mjs`** to handle two patterns the audit surfaced:
   - 5 satellites (beacon, bearing, board, bolt, brief) gate via a `middleware/authorize.ts` module instead of an inline `requireMinRole` call. The codemod needs to recognize `requireMinOrgRole`, `requireBoardAccess`, `requireGoalEditAccess`, etc.
   - `bearing-api` files are `<name>.ts` not `<name>.routes.ts`. Fix the glob.
2. **Pilot on `blank-api`** (19 perms, 3 existing role-gate sites, ~21 routes; smallest blast radius and the routes are public forms so codemod misfires are low-impact).
3. **Roll out in waves** per `satellites.md` recommendation: blank → bench/book/blast → bill/bond → bolt/bearing/beacon/board/brief → banter (largest, last).
4. **Per satellite**: install `@bigbluebam/permissions`, register the plugin in `<app>-api/src/server.ts`, run the codemod, hand-review the diff, add `BBB_PERMISSIONS_ENFORCE: warn` to compose env.

### Phase 4 — flip enforcement (per-app, with rollback)

After Phases 0-3 land and the divergence dashboard sits at ~0 for 7+ days on the relevant surface:

1. **Flip `BBB_PERMISSIONS_ENFORCE=on` for `apps/api` first** (most coverage, lowest risk). Bake 24h.
2. **Then MCP.** Bake 24h.
3. **Then satellites, in pilot→large order.** Bake 24h between each.

If a divergence appears post-flip: the resolver fails closed (legacy + dual-read becomes wrong-answer telemetry; enforcement becomes 403). Rollback is `BBB_PERMISSIONS_ENFORCE=warn` + container restart, ~30s.

## Open questions to confirm before Phase 1

1. **Public/system endpoint policy.** Should the manifest carry an explicit `is_public: true` flag for /auth/login, webhook receivers, /healthz-adjacent? Or should they simply not appear in the catalog? The plan implies the latter but the manifest currently includes them with no special flag.
2. **Inline `is_superuser` checks.** `apps-api.md` flagged one route (`api-key.routes.ts:24`) where authorization happens inside the handler body, not in the preHandler array. There may be others not caught by the audit. Want a follow-up grep?
3. **MCP `requires_superuser` enforcement layer.** Today the 7 superuser-required tools are protected by the proxied REST routes, not by the MCP wrapper. Once Phase 2 adds resolver enforcement at the MCP layer, do we still need REST-side checks (defense in depth) or are they redundant?

## Files produced by the audit

- `docs/wave-d-audit/apps-api.md` — per-file table + 246-row detail
- `docs/wave-d-audit/mcp-server.md` — register-tool.ts line-by-line analysis
- `docs/wave-d-audit/satellites.md` — per-satellite breakdown + rollout recommendation
- `docs/wave-d-audit/consistency.md` — manifest/TS/DB three-way diff
- `docs/wave-d-audit/audit.mjs`, `scripts/wave-d-audit.mjs`, `scripts/wave-d-audit-report.mjs` — reusable auditors

All four reports plus this synthesis live under `docs/wave-d-audit/`. None of the audits modified source.
