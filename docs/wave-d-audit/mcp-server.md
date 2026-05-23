# Wave D Audit — MCP Server Per-Action Permission Coverage

**Scope:** `apps/mcp-server/src/tools/` (43 modules, 348 `registerTool(...)` calls) cross-referenced against `docs/permissions-action-manifest.json` (1083 permissions; 348 `sources[].source === 'mcp'` entries) and `packages/permissions/src/generated/permissions.ts::TOOL_TO_PERMISSION`.

**Branch:** `permissions` @ `b45a16f` (Wave C tip).

**Date:** 2026-05-17.

## 1. Summary

| Metric | Value |
| --- | --- |
| Tools registered (`registerTool` call sites under `apps/mcp-server/src/tools/`) | **348** |
| Unique tool names (no duplicates) | 348 |
| Manifest entries with `sources[].source === 'mcp'` | **348** |
| `TOOL_TO_PERMISSION` map entries (generated, `packages/permissions/src/generated/permissions.ts`) | **348** |
| Manifest entries flagged `requires_superuser: true` (mcp surface) | **7** |
| `OK` (in code + in map + in manifest + file matches) | **348** |
| `MAPPING_MISSING` (in code, not in `TOOL_TO_PERMISSION`) | **0** |
| `MANIFEST_MISSING` (in code, not in manifest) | **0** |
| `FILE_MISMATCH` (manifest `source.file` ≠ actual file) | **0** |
| `ORPHANED` (manifest mcp entry has no matching `registerTool` call) | **0** |

Coverage of MCP tools by both the catalog and the generated `TOOL_TO_PERMISSION` map is **100% (348/348)**. The Wave A catalog-generation pipeline + the Wave B map regeneration are in lockstep with the source. There is no per-tool drift to chase.

The remaining gap is *enforcement*, not *mapping* — see §3.

## 2. Per-Module Table

Columns: `module | tools | in_TOOL_TO_PERMISSION | mapping_missing | in_manifest | manifest_missing`.

| Module | tools | in map | missing | in manifest | missing |
| --- | ---: | ---: | ---: | ---: | ---: |
| activity-tools.ts | 2 | 2 | 0 | 2 | 0 |
| agent-policy-tools.ts | 3 | 3 | 0 | 3 | 0 |
| agent-tools.ts | 3 | 3 | 0 | 3 | 0 |
| agent-webhook-tools.ts | 4 | 4 | 0 | 4 | 0 |
| attachment-tools.ts | 2 | 2 | 0 | 2 | 0 |
| bam-resolver-tools.ts | 4 | 4 | 0 | 4 | 0 |
| banter-subscription-tools.ts | 3 | 3 | 0 | 3 | 0 |
| banter-tools.ts | 53 | 53 | 0 | 53 | 0 |
| beacon-tools.ts | 30 | 30 | 0 | 30 | 0 |
| bearing-tools.ts | 12 | 12 | 0 | 12 | 0 |
| bench-tools.ts | 11 | 11 | 0 | 11 | 0 |
| bill-tools.ts | 16 | 16 | 0 | 16 | 0 |
| blank-tools.ts | 11 | 11 | 0 | 11 | 0 |
| blast-tools.ts | 14 | 14 | 0 | 14 | 0 |
| board-tools.ts | 14 | 14 | 0 | 14 | 0 |
| bolt-observability-tools.ts | 2 | 2 | 0 | 2 | 0 |
| bolt-tools.ts | 13 | 13 | 0 | 13 | 0 |
| bond-tools.ts | 23 | 23 | 0 | 23 | 0 |
| book-tools.ts | 11 | 11 | 0 | 11 | 0 |
| brief-tools.ts | 18 | 18 | 0 | 18 | 0 |
| comment-tools.ts | 2 | 2 | 0 | 2 | 0 |
| composite-tools.ts | 3 | 3 | 0 | 3 | 0 |
| dedupe-tools.ts | 4 | 4 | 0 | 4 | 0 |
| entity-links-tools.ts | 3 | 3 | 0 | 3 | 0 |
| expertise-tools.ts | 1 | 1 | 0 | 1 | 0 |
| helpdesk-tools.ts | 11 | 11 | 0 | 11 | 0 |
| import-tools.ts | 2 | 2 | 0 | 2 | 0 |
| ingest-fingerprint-tools.ts | 1 | 1 | 0 | 1 | 0 |
| me-tools.ts | 10 | 10 | 0 | 10 | 0 |
| member-tools.ts | 4 | 4 | 0 | 4 | 0 |
| phrase-count-tools.ts | 2 | 2 | 0 | 2 | 0 |
| platform-tools.ts | 13 | 13 | 0 | 13 | 0 |
| project-tools.ts | 5 | 5 | 0 | 5 | 0 |
| proposal-tools.ts | 3 | 3 | 0 | 3 | 0 |
| report-tools.ts | 8 | 8 | 0 | 8 | 0 |
| resolve-tools.ts | 1 | 1 | 0 | 1 | 0 |
| search-tools.ts | 1 | 1 | 0 | 1 | 0 |
| sprint-tools.ts | 5 | 5 | 0 | 5 | 0 |
| task-tools.ts | 12 | 12 | 0 | 12 | 0 |
| template-tools.ts | 2 | 2 | 0 | 2 | 0 |
| user-resolver-tools.ts | 3 | 3 | 0 | 3 | 0 |
| utility-tools.ts | 2 | 2 | 0 | 2 | 0 |
| visibility-tools.ts | 1 | 1 | 0 | 1 | 0 |
| **TOTAL** | **348** | **348** | **0** | **348** | **0** |

Manifest `source.file` matches the actual registering module for all 348 tools — no `FILE_MISMATCH` rows.

## 3. Enforcement-Path Analysis (`apps/mcp-server/src/lib/register-tool.ts`)

### What the wrapper does today

The wrapped handler (lines 387–396) runs exactly two gating steps before the original tool body:

1. **PolicyGate.check** (`register-tool.ts:388–393`):
   - Always-permitted core (`get_server_info`, `get_me`, `agent_heartbeat`) → `allow` (line 189).
   - Caller is `human` → `allow` (line 198).
   - Caller is `agent`/`service` → consult cache, else hit `POST /v1/agent-policies/:agent_user_id/check?tool=...` (line 224). Result is the §15 agent_policies decision (kill switch + glob-prefix `allowed_tools`).
   - On `allow` returned by the gate, control falls through to `opts.handler(args)` (line 395).
2. **`recordDualRead(toolName, decision, callerId)`** is invoked *inside* the gate at three call sites (lines 219, 241, 252) after the §15 decision is computed. It:
   - Looks up `TOOL_TO_PERMISSION.get(toolName)` (line 293). Unknown tools → `return` silently.
   - Fires an unawaited `fetch` (line 298: `void (async () => { ... })()`) to `POST <api>/internal/permissions/dual-read` carrying `{ user_id, permission_id, agent_policy_decision: 'allow'|'deny', tool_name, scope: {} }`.
   - **Never reads the response. Never blocks. Never produces a `PolicyDecision`. Never short-circuits the handler.**

### What this means for `BBB_PERMISSIONS_ENFORCE`

- The string `BBB_PERMISSIONS_ENFORCE` does not appear anywhere in `apps/mcp-server`. Grep across the whole tree finds it only in `apps/api/src/env.ts`, `apps/api/src/server.ts`, `apps/api/src/plugins/permissions.ts`, the divergence dashboard, and infra. The MCP wrapper is not env-driven; flipping the flag on the API side has **no effect** on what `registerTool` accepts or rejects.
- The §7 resolver (`packages/permissions/src/resolver.ts::resolve`) — including the `requires_superuser` short-circuit (line 196–198), API-key scope ceiling (line 200–210), agent_policy step (line 213–222), and account-permissions / group-defaults walk — **is never called from the MCP wrapper**. The wrapper neither imports `resolve` nor calls the `/internal/permissions/check` resolver endpoint as a *gating* request.
- Result: when `BBB_PERMISSIONS_ENFORCE=on` lands, MCP tools whose `agent_policies` row says `allow` will proceed regardless of whether the per-action resolver would have denied them. The dual-read row will record the divergence in `permissions_divergence_log`, but the caller still gets the response from the tool body.

### What Wave D must add to flip `=on`

A second, blocking call after the PolicyGate accepts. Concretely the wrapped handler needs a third clause between lines 393 and 395 along the lines of:

1. Look up `permissionId = TOOL_TO_PERMISSION.get(opts.name)`. If missing, log + decide policy (catalog drift fail-closed vs. legacy fall-through is a Wave D design choice).
2. Issue a *synchronous* `POST /internal/permissions/check` (or call the resolver directly inside MCP if the context is hydrated locally) with `user_id`, `permission_id`, and the relevant scope, await the result.
3. If `decision !== 'allow'`, return `buildPolicyDenialResult(...)` with a new reason code (something like `PERMISSION_DENIED` to distinguish from `AGENT_DISABLED` / `TOOL_NOT_ALLOWED`).
4. Gate the whole new path on the `BBB_PERMISSIONS_ENFORCE` env var (off → keep today's dual-read-only behavior; warn → log a structured warning when divergence is detected but proceed; on → fail the call).

This is the change `docs/permissions-overhaul-plan.md` Wave C-D crossover describes as "MCP register-tool enforces". The plan was completed for the *API* side (the `apps/api/src/plugins/permissions.ts` enforcement plugin is in place and reads `BBB_PERMISSIONS_ENFORCE`); the **MCP side has only the telemetry leg of the dual-read**.

## 4. `requires_superuser` Audit

Tools flagged `requires_superuser: true` in the catalog whose source is MCP (7 total):

| tool | permission | file |
| --- | --- | --- |
| `platform_create_org` | `platform.org.create` | `platform-tools.ts` |
| `platform_delete_org` | `platform.org.delete` | `platform-tools.ts` |
| `platform_update_org` | `platform.org.update` | `platform-tools.ts` |
| `list_beta_signups` | `platform.system.list_beta_signups` | `platform-tools.ts` |
| `set_platform_launchpad_defaults` | `platform.system.set_launchpad_defaults` | `platform-tools.ts` |
| `set_public_signup_disabled` | `platform.system.set_public_signup_disabled` | `platform-tools.ts` |
| `test_slack_webhook` | `platform.system.test_slack_webhook` | `project-tools.ts` |

### Where the check fires

- `packages/permissions/src/resolver.ts:188–198`: the resolver itself short-circuits with `decision: 'deny'`, `reason: 'requires_superuser'` when the catalog row's `requires_superuser` is set and the subject is not a SuperUser. SuperUsers bypass at step 1 (`superuser_bypass`, line 171–174).
- Grep across the MCP server: **0 references to `requires_superuser`** anywhere under `apps/mcp-server/`. The wrapper does not branch on it. The flag is invisible to `register-tool.ts`.

### What this means

The 7 tools above are protected today only because the underlying REST routes they call (`/platform/orgs`, `/platform/system/*`, `/projects/:id/slack-webhook/test`) enforce SuperUser in the API layer. **The MCP wrapper itself does not enforce the flag.** If any of these tools were ever refactored to skip the proxied REST call (or if a future tool with `requires_superuser=true` chose to talk to the DB directly), nothing in the MCP wrapper would notice.

Wave D should fold this into the same per-action gate it adds for the resolver:

- When `BBB_PERMISSIONS_ENFORCE=on` and the catalog's `requires_superuser` is true and the caller is not a SuperUser, deny at the MCP layer regardless of what the §15 PolicyGate said. The resolver already does this; calling the resolver from MCP gives this for free.
- The agent_policy step in `resolver.ts:213–222` *also* covers the agent/service case, so once the wrapper consults the resolver, agent kill switches + tool allowlists collapse into one decision path.

Note: the §10 `'human'` (a.k.a. SuperUser) bypass is per the spec ("human SuperUsers bypass everything") — that behavior comes for free from the resolver's step-1 short-circuit. The MCP wrapper does not need separate SuperUser logic; once it calls the resolver, the bypass is automatic.

## 5. Orphan + Drift Report

- **Manifest entries with no matching `registerTool` call:** 0.
- **`registerTool` calls with no manifest entry:** 0.
- **Tools in code whose `source.file` disagrees with their actual file:** 0.
- **Duplicate tool names in code:** 0.
- **Duplicate mcp-source entries in manifest (same `ref` mapped to two permissions):** 0.

The Wave A regeneration script + the Wave C codemod left the catalog, the generated map, and the source tree in perfect agreement. There is no orphaned/renamed/deleted tool noise to clean up before flipping enforcement.

## 6. Recommended Next Step

The MCP server is **not yet ready** for `BBB_PERMISSIONS_ENFORCE=on`. Mapping coverage is 100% — every tool has a catalog permission and a `TOOL_TO_PERMISSION` entry — but the wrapper's per-action work is telemetry only: `recordDualRead` POSTs to `/internal/permissions/dual-read` as a fire-and-forget side effect (`register-tool.ts:298`) and never produces a blocking decision. To make `=on` actually deny unauthorized tool calls, Wave D needs to add a synchronous resolver call to the wrapped handler between the PolicyGate decision and `opts.handler(args)` (around `register-tool.ts:393–395`), gated on the same `BBB_PERMISSIONS_ENFORCE` env var the API plugin already reads. That single change (one new call, one new env branch, one new `PERMISSION_DENIED` denial result) folds `requires_superuser`, API-key scope ceilings, and account-permission overrides into the MCP layer for free, since the resolver already implements all three. Until it lands, MCP-side enforcement is `agent_policies` only, regardless of what the API-side flag says.
