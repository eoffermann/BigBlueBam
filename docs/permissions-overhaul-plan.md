# Per-action permissions migration

## Context

BigBlueBam currently authorizes every action through one of five org-scoped role strings (`owner | admin | member | viewer | guest`) plus an `is_superuser` boolean and a 3-level API-key scope (`read | read_write | admin`). That coarse model is enforced by ~210 distinct gate sites in `apps/api/src` (134 middleware decorators + ~64 inline comparisons + ~10 helper calls across 58 files), plus equivalent role-scoped checks in 12 of the 13 satellite APIs and ~100 inline `role ===` checks across 14 frontend SPAs. Every MCP tool (391 registered tools across 43 modules) is also gated only by the §15 `agent_policies` kill-switch + glob-prefix tool allowlist; the actual per-action authorization still falls through to the satellite's role check.

The user wants every individual MCP/UI/API action to be its own first-class permission identifier — granting or denying a single action without forcing the operator to invent a new role. The current 5 roles stay around as **default permission groups** (preserving today's UX so nothing breaks for existing customers), and operators get the ability to define new groups at global / org / project scope. Applying a group to an account seeds editable per-permission grants on that account; once applied, every individual permission is independently overridable. Migration must auto-upgrade every existing account so day-one of the new system matches today's behavior bit-for-bit.

This is a 4-6 week multi-wave rollout that touches every authenticated request, every MCP tool, and every UI action gate. The plan below is structured to expand-contract through proven idioms (RLS soft-rollout pattern from migration 0116, agent_policies pattern from 0139), with a feature flag, dual-read divergence telemetry, and per-wave rollback paths.

## What I learned from 6 parallel explorations

| Surface | Finding | Implication |
|---|---|---|
| **Main api role-gates** | ~210 sites across 58 files; 5 helpers (`requireMinRole`, `requireRole`, `requireOrgRole`, `requireProjectRole`, `requireScope`); ~64 inline comparisons | Replace `requireMinRole(role)` with `requireCan(permission)`; the inline checks need a `can(user, permission)` helper. |
| **Satellite apis** | 12 of 13 share an identical `ROLE_HIERARCHY` definition (copy-pasted); helpdesk-api is architecturally isolated (`helpdesk_users`/`helpdesk_sessions`, no role); only bolt-api respects `sessions.active_org_id` for org switching | Centralize in a new `@bigbluebam/permissions` package. Helpdesk-api needs an explicit decision (see "Open questions"). The other 11 satellites need to pick up the new shared package + active-org-id fix as a side-effect. |
| **MCP gating** | 391 tools wrapped 100% by `register-tool.ts::PolicyGate`; 5s decision cache; Redis pubsub invalidation; 3 always-permitted core tools (`get_server_info`, `get_me`, `agent_heartbeat`); `agent_policies` is per-`(agent_user_id, org_id)` with permissive default `allowed_tools=['*']` | Keep `agent_policies` as the coarse outer gate (kill-switch + tool allowlist); add per-action permission check *inside* the wrapper after policy passes. The 3 core tools stay always-on. |
| **`can_access` visibility** | Already covers 9 cross-app entity types (bam.task/project/sprint, helpdesk.ticket, bond.deal/contact/company, brief.document, beacon.entry); leak-safe `not_found` reasons | Compose; per-action permissions are *separate* from per-entity visibility. A user can have `bam.task.update` but still be blocked by visibility on a private project they're not a member of. |
| **Frontend gates** | ~100 inline checks: 53 in `apps/frontend`, 13 in `apps/banter`, 12 in `apps/beacon`, 2 each in 11 other SPAs, 0 in `apps/helpdesk` | One shared `useCan(permission)` hook + permission matrix served from `/auth/me`; per-app rollout in priority order frontend → banter → beacon → rest. |
| **Action surface** | 1,200 total: 391 MCP tools + 809 REST endpoints (340 read, 469 write). bam-core dominates at 30%. ~92% fit `<app>.<resource>.<verb>` cleanly | The naming convention scales. ~16 utility tools (`confirm_action`, `agent_heartbeat`, `search_everything`, `get_me`, etc.) get a `platform.system.*` and `shared.system.*` reserved namespace. |
| **Migration patterns** | 140-file idempotent + checksummed migration history; expand-contract pattern proven (0109/0110, 0113, 0124); RLS soft-rollout via `BBB_RLS_ENFORCE`; 2026-04-18 checksum incident sharpened the no-edit rule | Use a 5-wave expand-contract: add tables → backfill → dual-read with telemetry → enforce → contract. Feature flag is `BBB_PERMISSIONS_ENFORCE`. |

## Design

### A. Permission identifier convention

`<app>.<resource>.<verb>` — three lower-snake-case segments. Examples:

```
bam.task.create        bam.task.update        bam.task.delete       bam.task.list
banter.channel.archive banter.message.delete  banter.message.pin
bond.deal.move_stage   bond.deal.close_won    bond.contact.merge
bill.invoice.send      bill.invoice.finalize
platform.org.create    platform.org.delete    platform.system.get_info
shared.system.search_global   shared.system.resolve_references
agent.policy.set       agent.heartbeat        agent.audit.read
```

Reserved namespaces:
- `platform.*` — global / cross-org / SuperUser-territory actions (e.g. org CRUD, platform settings, launchpad defaults).
- `shared.system.*` — utility tools that apply across apps (search_everything, resolve_references).
- `agent.*` — agent identity / policy / webhook actions.

Wildcards in **default group definitions** (not in checks): a group's permission defaults can include `bam.task.*` to mean "every action in the bam.task resource at create-time"; the wildcard is expanded into individual rows on group-apply, then each row is independently editable per the user's spec.

The full action manifest is generated by static analysis — see "Action manifest strategy" below.

### B. Schema (5 new tables + 2 augmented)

```sql
-- 1. The static catalog of every permission identifier in the system.
--    Generated from the action manifest at build time and seeded into the
--    DB via a migration. Acts as a foreign-key target for everything else.
CREATE TABLE permissions (
    id              text PRIMARY KEY,             -- e.g. 'bam.task.create'
    app             text NOT NULL,                -- 'bam' | 'banter' | ... | 'platform' | 'shared'
    resource        text NOT NULL,                -- 'task' | 'channel' | ...
    verb            text NOT NULL,                -- 'create' | 'list' | ...
    description     text,                         -- human-readable
    is_destructive  boolean NOT NULL DEFAULT false,  -- delete/archive/transfer-style
    requires_confirmation boolean NOT NULL DEFAULT false,  -- mirrors MCP confirm_action gating
    introduced_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. Permission groups — both built-in (the legacy 5 roles) and operator-
--    defined custom groups at global, org, or project scope.
CREATE TABLE permission_groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,                -- 'Owner' | 'Admin' | 'Member' | 'Viewer' | 'Guest' | 'Channel Moderator' ...
    description     text,
    scope_type      text NOT NULL CHECK (scope_type IN ('global', 'org', 'project')),
    scope_id        uuid,                         -- NULL when scope_type='global'; org_id or project_id otherwise
    is_builtin      boolean NOT NULL DEFAULT false,  -- true for the 5 legacy roles; cannot be deleted
    legacy_role     text,                         -- 'owner'|'admin'|'member'|'viewer'|'guest' for builtins; NULL otherwise
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,                  -- soft delete (active groups still apply to existing accounts)
    UNIQUE (scope_type, scope_id, name) WHERE deleted_at IS NULL
);

-- 3. Default permission grants for a group. When an account is bound to a
--    group, these defaults seed account_permissions rows. Edits to this
--    table after a group has been applied DO propagate to any account
--    that has not yet overridden the specific permission (see resolution
--    algorithm below).
CREATE TABLE permission_group_defaults (
    group_id        uuid NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
    permission_id   text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted         boolean NOT NULL,             -- true = granted by default, false = denied by default
    PRIMARY KEY (group_id, permission_id)
);

-- 4. Per-account permission overrides. Stores ONLY explicit operator-set
--    grants/denies; rows that should fall through to a group default
--    don't exist. The first INSERT/UPDATE here for a (user, scope) pair
--    that has a live group membership triggers the snapshot-and-detach
--    flow described under "Group propagation" below.
CREATE TABLE account_permissions (
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type      text NOT NULL CHECK (scope_type IN ('global', 'org', 'project')),
    scope_id        uuid,                         -- same nullability rules as permission_groups
    permission_id   text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted         boolean NOT NULL,             -- explicit grant (true) or deny (false)
    is_snapshot     boolean NOT NULL DEFAULT false, -- true if this row was auto-frozen from a group default at detach time
    set_by          uuid REFERENCES users(id),
    set_at          timestamptz NOT NULL DEFAULT now(),
    notes           text,                         -- audit context (why an admin overrode)
    PRIMARY KEY (user_id, scope_type, scope_id, permission_id)
);

-- 5. Group memberships. Which accounts are in which group(s) at which
--    scope. An account has at most ONE group per (scope_type, scope_id);
--    builtin org-scope membership mirrors today's organization_memberships.
--    `detached_at` flips to NOT NULL the first time the account gets an
--    explicit override at that scope (see Group propagation). While
--    detached_at IS NULL the resolver reads the group's *live* defaults;
--    once detached, the account's permissions at that scope are entirely
--    governed by account_permissions rows (snapshot + overrides) and
--    future group-default edits no longer propagate.
CREATE TABLE account_group_memberships (
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id        uuid NOT NULL REFERENCES permission_groups(id) ON DELETE RESTRICT,
    scope_type      text NOT NULL,                -- denormalized from group, indexed for resolution
    scope_id        uuid,
    detached_at     timestamptz,                  -- NULL = live; non-NULL = snapshot taken at this time
    detached_by     uuid REFERENCES users(id),    -- set alongside detached_at for audit
    granted_by      uuid REFERENCES users(id),
    granted_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope_type, scope_id)   -- one group per scope per user
);

-- Indexes for hot-path resolution.
CREATE INDEX idx_acct_perm_user_scope ON account_permissions (user_id, scope_type, scope_id);
CREATE INDEX idx_acct_grp_user_scope  ON account_group_memberships (user_id, scope_type, scope_id);
CREATE INDEX idx_perm_app             ON permissions (app);
CREATE INDEX idx_perm_grp_scope       ON permission_groups (scope_type, scope_id) WHERE deleted_at IS NULL;
```

**RLS:** every new table gets policies binding to `current_setting('app.current_org_id')` for org/project scope rows; global-scope rows are visible to everyone (read) but only writeable by SuperUsers. Policies follow the exact pattern from migration 0116 + 0139.

**Augmented tables:**
- `organization_memberships` — `role` becomes a denormalized cache that the new system maintains for backward compat during waves B/C/D. In wave E the column is dropped after `db:check` confirms zero callers.
- `api_keys.scope` — read/read_write/admin stays as a coarse pre-filter on top of permissions (kept as a "max scope" ceiling). An `admin`-scope key with `bam.task.delete` denied still can't delete a task. A `read`-scope key can never call any non-`*.list`/`*.get`/`*.search`/`*.view` permission regardless of group. This composition is documented in the auth plugin.

### C. Resolution algorithm

For a request `(user, action_permission_id, scope = {org_id, project_id?})` decide ALLOW/DENY:

1. **SuperUser short-circuit.** `users.is_superuser = true` → ALLOW for everything except a tiny audited deny-list (e.g. you can't delete your own SuperUser flag without a confirm-action step). Mirrors today's behavior.
2. **Always-permitted core.** `permission_id` ∈ `{platform.system.get_info, platform.user.get_profile, agent.heartbeat}` → ALLOW. Mirrors the MCP `register-tool.ts` core set.
3. **API key scope ceiling.** If the request was authenticated via an API key, look up its `scope`:
   - `read` → permission must be a read action (resource verb in `{get, list, search, view, browse, query}`) or fall in `agent.heartbeat`. Otherwise DENY.
   - `read_write` → permission cannot be in the `*.delete | *.archive | *.transfer | *.set_role | *.invite | *.remove` admin-only set. Otherwise pass through.
   - `admin` → no ceiling; pass through.
4. **Agent policy gate.** If `users.kind ∈ {agent, service}`, check `agent_policies.enabled` and `agent_policies.allowed_tools` against the permission_id (using existing glob match). DENY if disabled or not in allowlist.
5. **Per-action resolution.** Walk scopes from narrowest to broadest (project → org → global). At each scope, ask "is the account currently *attached* to a group here, or detached?" and resolve from the appropriate source. First match wins:
   1. **Project scope.** Look up `account_group_memberships(user, 'project', project_id)`.
      - **No membership** → look for `account_permissions(... 'project', project_id, permission_id)`; if found use its `granted`. Otherwise fall through to step 5.2.
      - **Membership, `detached_at IS NULL` (live).** Resolve via `permission_group_defaults(group_id, permission_id)`. **But** if the user has an explicit `account_permissions` row at this scope/permission, that override wins (the override is what *triggered* detachment in the first place; this branch handles the brief window between INSERT and trigger firing).
      - **Membership, `detached_at IS NOT NULL` (detached).** Resolve only via `account_permissions(... 'project', project_id, permission_id)`. Snapshots written at detach time guarantee every previously-defaulted permission still has an answer here. Missing row → fall through to step 5.2 (extremely rare; see migration story).
   2. **Org scope.** Same three-branch shape but `('org', org_id)`.
   3. **Global scope.** Same three-branch shape but `('global', NULL)`.
   4. **Implicit deny.** Fall through to DENY.

Narrower scopes win over broader ones. Within a scope, an explicit override wins over a live group default; on a detached membership, the snapshot + override combination is canonical. This composition preserves the user's stated invariant: "if the permissions had been changed they would no longer be considered a member of the group and would not inherit that group's defaults" — the moment a single permission is overridden, the entire group attachment at that scope freezes (snapshot is taken so behavior doesn't change at the override boundary), and future group-default edits stop propagating.

#### Group propagation: snapshot-and-detach mechanics

This is the load-bearing rule. Implementation:

- **Apply group**: INSERT into `account_group_memberships` with `detached_at = NULL`. No `account_permissions` rows are written. Subsequent group-default edits propagate live to this account.
- **First override**: when an admin sets a single permission for the user at scope X, a SQL trigger `account_permissions_detach_trigger` fires `BEFORE INSERT OR UPDATE`. If the matching membership exists with `detached_at IS NULL`, the trigger:
  1. Snapshots every `permission_group_defaults` row for the membership's group into `account_permissions` for that user-scope, with `is_snapshot = true` and `granted` set to the group default's current value, but ONLY for permissions the user doesn't already have an `account_permissions` row for.
  2. Stamps `detached_at = now()` and `detached_by = current_user_id` on the membership.
  3. Then proceeds with the original INSERT/UPDATE; the operator's explicit override lands on top of the snapshot (`is_snapshot = false`, `granted` = whatever they set).
- **Re-attach UI** (operator opt-in): "Reset to group defaults" deletes every `account_permissions` row at this user-scope (snapshots + overrides) and clears `detached_at`. The account is back to live.
- **Rebase UI** (operator opt-in): "Pick up new group defaults but keep my customizations" deletes only the `is_snapshot = true` rows (preserving overrides), clears `detached_at`. Future resolution is live; explicit overrides still win.

The snapshot is conceptually a frozen copy of the group's effective defaults at the moment of detachment, so the user's effective permissions don't change at the boundary — the operator's override is additive, not destructive. This also means the resolver in the detached branch (step 5.1.c above) can rely on every previously-defaulted permission having an `account_permissions` row.

Edge cases:
- **Group's permission_group_defaults edited while users are attached.** Live-attached users get the new value on their next resolution. Detached users keep their snapshot. If the group is *deleted* (soft delete, `deleted_at IS NOT NULL`), live-attached users effectively lose all permissions at that scope (resolver finds nothing); detached users keep their snapshot and overrides. The editor surfaces this clearly: deleting a group prompts "X live-attached accounts will lose permissions; reattach them to a different group first."
- **Permission added to the catalog after some accounts are detached.** Detached accounts don't auto-snapshot the new permission; they implicit-deny it (or fall through to next scope). This is by design — a brand-new permission shouldn't retroactively grant itself to detached accounts. Operators wanting to reflect the new permission can use "Rebase to group defaults" to pick it up while preserving overrides.

### D. Default groups (the 5 legacy roles preserved)

Five built-in groups are seeded at scope `global` and **cannot be deleted or renamed**. Their permission defaults exactly recreate today's behavior:

| Builtin group | legacy_role | Defaults (informally) |
|---|---|---|
| Owner | `owner` | All permissions = granted, including `*.transfer`, `org.delete`, role-grant. |
| Admin | `admin` | All permissions except `org.delete` and `*.transfer_ownership`. |
| Member | `member` | All read + most write; not `org.*` admin actions, not `*.delete_member`, not API-key admin scope. |
| Viewer | `viewer` | All read actions only. |
| Guest | `guest` | Read on assigned projects; nothing org-wide. |

These defaults are computed by **inverting the existing 210 gate sites**: every `requireMinRole('admin')` site contributes `denied for member/viewer/guest, granted for admin/owner` to the corresponding action, etc. The first migration that seeds `permission_group_defaults` is generated programmatically from a static analysis pass over the 210 sites. The list is committed to the repo at `docs/permissions-action-manifest.json` so a code reviewer can audit the round-trip.

Operators can create custom groups at `org` or `project` scope (or `global` if SuperUser). New groups start with empty defaults; the operator picks individual permissions or `<app>.<resource>.*` wildcards and each picked permission becomes a row in `permission_group_defaults`. Soft-delete (`deleted_at`) preserves audit trail; deleted groups can no longer be applied but already-applied accounts retain their materialized state.

### E. Composition with existing systems

```
Request arrives
    ↓
auth plugin verifies cookie/API-key → resolves user, kind, org_id
    ↓
RLS plugin sets app.current_org_id GUC (existing migration 0116)
    ↓
[NEW] permissions plugin (only if BBB_PERMISSIONS_ENFORCE=1):
    ↓
    SuperUser bypass?
    ↓
    Core-tool bypass?
    ↓
    API-key scope ceiling check
    ↓
    Agent policy gate (existing §15 wrapper, unchanged for service accounts)
    ↓
    Per-action resolution (the 7-step algorithm above)
    ↓
Route handler. requireCan('bam.task.create') wrapper checks the cached
decision; if missing, performs resolution, caches in Redis with 5-min TTL
keyed by (user_id, permission_id, project_id, hash_of_group_memberships).
    ↓
Optional: visibility.service.can_access() for cross-app citation gating
(separate concern, unchanged).
```

The §15 `agent_policies` wrapper survives intact — it stays as the **coarse outer kill-switch** that runs *before* per-action resolution. A disabled agent fails closed without ever reaching the per-action layer; an agent with `allowed_tools=['banter.*']` can't even attempt `bond.deal.create`. Per-action permissions are a *narrower* gate inside the same agent's allowed tools.

### F. Caching + performance budget

Hot-path target: **<2 ms p99 added latency per request** (current auth plugin spends ~1 ms; budget is `current + 1 ms`).

Layers:
1. **Per-request memo** (`Map` on `request.permissionsCache`) — avoid repeated checks within a single handler.
2. **Redis cache** keyed `perms:{user_id}:{scope_hash}` → JSON of `{permission_id: bool}` for everything that user has been checked for in this scope, TTL 300 s.
3. **Postgres fallback** — on miss, single SQL query joins `account_group_memberships` + `permission_group_defaults` + `account_permissions` and returns the resolution for one or many permission_ids in one round-trip. The resolver function is a SQL view + helper function:

   ```sql
   CREATE OR REPLACE FUNCTION resolve_permission(
       p_user_id uuid, p_permission_id text, p_org_id uuid, p_project_id uuid
   ) RETURNS boolean ...
   ```

4. **Invalidation** — Redis pubsub channels `perms:invalidate:{user_id}` and `perms:invalidate:org:{org_id}` (the latter for group-default edits). Mirrors agent_policies invalidation pattern in `apps/mcp-server/src/server.ts:130`.

Materialized view considered and rejected for now — the join is cheap enough at the per-(user, permission) granularity, and a materialized view across millions of (user × permission × scope) rows would dominate write cost on every group edit.

## Implementation phases (5 waves)

The migration follows the project's expand-contract idiom. Each wave is its own merge to `main`; `stable` only takes wave A on day one and waves B–E only after each is validated in production for a week.

### Wave A — Foundation (additive, code-only changes work today)

Goal: schema + seed + an opt-in `requireCan` helper that defaults to allow. No behavior change.

1. **New migration `0141_permissions_catalog.sql`.** Creates the 5 new tables + RLS policies + indexes. Empty `permissions` table.
2. **New migration `0142_permissions_seed_actions.sql`.** Inserts the static action catalog (~1,200 rows) into `permissions`. The catalog is generated by `scripts/generate-permission-manifest.mjs` (new) which walks `apps/*/src/routes/`, `apps/mcp-server/src/tools/`, and the existing route helpers, producing `docs/permissions-action-manifest.json` + `apps/permissions-codegen/src/generated/permissions.ts` (TypeScript const enum mirror used by the resolver and `useCan`). The migration body literally INSERTs those rows so the SQL stays self-contained and idempotent.
3. **New migration `0143_permissions_builtin_groups.sql`.** Seeds the 5 built-in groups + their `permission_group_defaults` (the role inversion). Seeding is also idempotent (`ON CONFLICT DO NOTHING` keyed on `(scope_type, scope_id, name)`).
4. **New package `packages/permissions/`.** Houses:
   - `index.ts` — `requireCan(permissionId)` Fastify middleware factory; `can(user, permissionId, scope)` async helper; React `useCan(permissionId)` hook.
   - `resolver.ts` — the 7-step resolution algorithm; pure function over a fetched permission state object.
   - `cache.ts` — Redis-backed cache with the in-process `Map` fallback (mirrors `apps/mcp-server/src/lib/confirm-token-store.ts`).
   - `types.ts` — TypeScript types generated from the manifest.
5. **Module registration in api**. Wire the plugin into `apps/api/src/server.ts` after the auth plugin, gated on `BBB_PERMISSIONS_ENFORCE`. Default off.
6. **`scripts/check-permission-catalog.mjs`** — CI guard that fails the build if a new MCP tool / REST route is added without a corresponding entry in the manifest. Mirrors `scripts/check-bolt-catalog.mjs` for Bolt events.

Files created (~12): the 3 SQL migrations, the new package (4 .ts files), the codegen script, the catalog-drift CI script, the manifest JSON, plus `docs/permissions-overhaul-plan.md` (this plan, copied into the repo).

Files modified (~3): `apps/api/src/server.ts`, `package.json` workspace registration, `.github/workflows/db-drift.yml` to call `check-permission-catalog.mjs`.

**Verification**: `pnpm db:check` passes; `pnpm test --filter @bigbluebam/permissions`; `docker compose run --rm migrate` runs the 3 new migrations; `psql -c "select count(*) from permissions"` returns ~1200; `psql -c "select count(*) from permission_groups where is_builtin"` returns 5.

### Wave B — Backfill + dual-read instrumentation

Goal: every existing user gets a built-in group at every org membership; new resolver runs in shadow mode logging divergences against the legacy role check.

1. **New migration `0144_permissions_backfill_memberships.sql`.** For every row in `organization_memberships`, INSERT into `account_group_memberships` mapping `role` → `group_id`. SuperUsers also get a global-scope mapping to a synthetic "Platform SuperUser" built-in group (granted everything; mirrors today's bypass). Idempotent via `INSERT ... ON CONFLICT DO NOTHING`.
2. **Dual-read in the api auth plugin.** Behind `BBB_PERMISSIONS_ENFORCE=warn` (a third value alongside off/on), every request runs the legacy gate AND the new resolver, compares the two, and writes a `permissions.divergence` log line if they disagree. Decision-of-record stays the legacy gate during this wave.
3. **Dual-read in the MCP `register-tool.ts` wrapper.** Same shape. Cached decisions also keyed by mode so a divergence can be spotted in production telemetry.
4. **A new SuperUser-only diagnostic page** at `/b3/superuser/permissions/divergences` — paginates the divergence log, groups by `(permission_id, role)`, lets the operator audit before flipping enforcement.
5. **2-week minimum soak**. The user's incident-of-record (2026-04-18 checksum stall) demonstrates the cost of pulling the trigger early. Soak target: divergence rate < 0.1 % across ≥ 5 production orgs, ≥ 10 k requests sampled.

Files created (~3): the SQL migration, the divergences page, an `apps/api/src/services/permissions-telemetry.service.ts`.

Files modified (~5): `apps/api/src/plugins/auth.ts`, `apps/mcp-server/src/lib/register-tool.ts`, `apps/api/src/env.ts` (extend `BBB_PERMISSIONS_ENFORCE` enum), `apps/frontend/src/pages/superuser/index.tsx` (new tab), the plan / runbook doc.

**Verification**: every existing user has at least one `account_group_memberships` row; the divergences page shows zero or near-zero entries during the soak; load tests confirm <2 ms p99 added latency.

### Wave C — Backend enforcement (legacy gates retired in apps/api)

Goal: flip `BBB_PERMISSIONS_ENFORCE=1`; replace ~210 gate sites in `apps/api` with `requireCan(permission_id)`; preserve `requireScope` (still meaningful as the API-key ceiling).

1. **Codemod**. `scripts/codemod-replace-role-gates.mjs` walks `apps/api/src/routes/*.ts` and rewrites:
   - `requireMinRole('admin')` → `requireCan('<inferred-permission>')` based on the route's path + method.
   - `requireRole(['owner','admin'])` → same, picking the strictest matching permission.
   - Inline `if (request.user.role === 'owner') ...` patterns are flagged for manual review (they often gate sub-feature toggles, not whole routes).
   The codemod emits a diff and a TODO list; a human reviews every site. Estimated 134 mechanical replacements + ~64 manual reviews.
2. **Satellite api enforcement**. The 12 satellites that share the role pattern adopt `@bigbluebam/permissions` directly. The 13th (helpdesk-api) keeps its isolated auth — see open questions.
3. **MCP register-tool enforces.** Wrapper now uses the per-action permission as the inner gate after `agent_policies` passes.
4. **Roll forward in stages** — `apps/api` first, then satellites in priority order (banter-api, bolt-api, bond-api have the most surface), then MCP. Each stage is its own deploy + 24-hour bake.

Files created: 1 codemod script, 1 contract test (`apps/api/test/permissions-contract.test.ts`) that boots the new enforcement and exercises every route in the route registry.

Files modified: ~58 files in `apps/api/src/routes/`, 12 satellite `auth.ts` plugins, 12 satellite `routes/*.ts` directories (varies, ~30-100 sites each), `apps/mcp-server/src/lib/register-tool.ts`.

**Verification**: contract test passes (every route requires *some* permission, and that permission exists in the catalog); `pnpm test` green across all apps; manual smoke of the 10 critical UI gates from the UI investigation; divergence telemetry stays at zero.

### Wave D — UI integration

Goal: add `useCan(permission_id)` everywhere; keep `role ===` checks for one wave so the UI works against any backend version (forward-compat); ship the SuperUser permission editor.

1. **`useCan` in `@bigbluebam/ui`**. React Query hook, fetches permission matrix on session start, listens for invalidation events on the websocket. Backed by `/auth/me` augmented with `permissions: { [id]: bool }` (only the materialized set; checks for not-yet-fetched permissions trigger a one-shot RPC).
2. **Per-SPA rollout**. Frontend (53 sites, 1 week), Banter (13 sites, 2 days), Beacon (12 sites, 2 days), the rest (2 sites each, batched in 1 day). The codemod from Wave C has a frontend variant that flags `role ===` patterns and proposes `useCan` replacements.
3. **Permission editor UI**. New SuperUser page `/b3/superuser/permissions/groups` lets an admin:
   - View built-in groups (read-only).
   - Create/edit/delete custom groups at global / org / project scope.
   - Assign accounts to groups.
   - Override individual permissions per account.
   - Drag a `<app>.<resource>.*` glob into a group's defaults; the system expands it on save.
4. **Launchpad integration**. Open question: launchpad app visibility currently lives in `system_settings.launchpad_default_apps` + `organizations.settings.launchpad_apps`. Recommend keeping it as a separate concept (it's a UX visibility knob, not an authorization gate) and not mapping it to `platform.app.<x>.access` permissions. Adding it as a permission introduces one extra check on every app-render and complicates the org-admin workflow.

Files created: ~3 new pages + the `useCan` hook + a frontend codemod.

Files modified: ~14 SPA app shells + ~100 individual gate sites.

**Verification**: every UI element in the audit's "10 critical gates" list works correctly under each of the 5 built-in groups; the permission editor round-trips an org-admin custom group end-to-end; `pnpm --filter @bigbluebam/frontend test` green.

### Wave E — Contract (legacy role columns removed)

Goal: drop `organization_memberships.role`, `users.role`, the old `requireMinRole`/`requireRole` helpers; declare the migration done.

1. **Migration `0145_permissions_contract.sql`** drops `organization_memberships.role` (after 4 weeks of dual-read at 0 % divergence). The column was already de-canonicalized in Wave B; this just removes the storage.
2. **Code removal**. Delete the legacy helpers from `apps/api/src/plugins/auth.ts`. Delete `apps/api/src/lib/org-permissions.ts::isOrgPrivileged`. Remove the dual-read paths from satellite plugins.
3. **`db:check` passes**. Drizzle schema no longer references the dropped columns.
4. **Final docs sweep**. Update `CLAUDE.md`, `docs/agent-conventions.md`, and the deployment guide to reference the new permission model exclusively.

Files removed: ~6 helpers, ~2 services. Files modified: ~30 plugin files. One migration file.

**Verification**: schema drift guard happy; full test suite green; production has been on `BBB_PERMISSIONS_ENFORCE=1` for at least 4 weeks with zero rollback events.

## Sharp edges and mitigations

| Risk | Mitigation |
|---|---|
| **Backfill misses an edge case** (deleted user, partial membership, SuperUser without org) — leaves gates open or closed wrongly | Backfill migration runs in a single transaction; a post-migration audit query asserts `count(users.id) = count(distinct account_group_memberships.user_id where group is one of the 5 builtins)`. Failure aborts the deploy. |
| **The codemod introduces a regression on an obscure route** — a missing or wrong `requireCan` lets unauthorized writes through during Wave C | Contract test enumerates every route and confirms each declares a permission; route-registry drift fails CI. Manual review of every codemod-generated diff. Phased rollout (api first, satellites later, MCP last). |
| **Permission catalog drifts** — a developer adds a new MCP tool / REST route without registering its permission | `scripts/check-permission-catalog.mjs` in CI; same idiom as `check-bolt-catalog.mjs`. PR fails until the manifest updates. |
| **The `agent_policies` glob and the per-action permission disagree** — a service-account's `allowed_tools` includes `banter.message.create` but their group denies it | Documented as design intent: agent_policies is the *outer* envelope; per-action permission is the inner gate. Both must allow. The §15 audit log already captures denials at both layers. The MCP error responder includes which layer denied for triage. |
| **The 2026-04-18 incident** — adding an inline `-- noqa:` to an applied migration breaks every redeploy | Three migrations land in this plan (0141/0142/0143/0144/0145) — none of them get touched after deploy. If a lint false-positive appears post-deploy, register it in `OFF_FILE_SUPPRESSIONS` in `scripts/lint-migrations.mjs`. Rule explicit in the plan and in the migration headers. |
| **Helpdesk-api stays isolated** — its `helpdesk_users` table has no role, so per-action permissions can't apply meaningfully | See open question 1. Recommend keeping helpdesk-api on its current model (it's a customer-facing public portal, not an internal action surface) and making its tools the only ones in the catalog with a hardcoded `helpdesk.*` namespace that doesn't go through the permissions resolver. |
| **Group-default edits invalidate too aggressively** — editing one group default flushes every member's cache, causing a thundering herd on resolution | Invalidation is per-`(group_id, permission_id)` pair. The Redis pubsub event names that pair; subscribers only invalidate their cache entries that touch that group AND only for *live-attached* accounts (detached accounts are unaffected by group edits). Soak-tested under load before Wave C. |
| **Detach-trigger races on concurrent overrides** — two operators edit the same user's permissions simultaneously; both observe `detached_at IS NULL` and both attempt to snapshot, double-writing every group default | The trigger uses `INSERT ... ON CONFLICT DO NOTHING` for snapshot rows and an advisory lock keyed on `hashtext('detach:' || user_id || scope_id)`. The second transaction's snapshot becomes a no-op; only the membership-row UPDATE proceeds, and `detached_at` records whichever transaction committed first. |
| **Snapshot on detach is non-atomic vs. the operator's override** — operator sees their override succeed but the snapshot insert fails partway, leaving the account half-frozen | Trigger runs inside the same transaction as the operator's INSERT; failure rolls back both. The trigger uses simple `INSERT ... SELECT ... FROM permission_group_defaults` so failures are deterministic (FK violation only — defended by the FK from `account_permissions.permission_id` to `permissions.id`). |
| **Test database does not get seeded** — integration tests run against a fresh DB without the built-in groups, every gate fails | `apps/integration-tests` setup already runs migrations; the new migrations seed builtins; the test helper `seedTestUser(role)` is updated to also call `assignBuiltinGroup(user, role)`. |
| **Forward-compat for the UI** — UI still queries `user.role` during Wave D; if backend Wave E lands first the UI breaks | Wave E is gated on Wave D being shipped to all 14 SPAs and confirmed in production. The old role string survives Wave D as a synthetic field on `/auth/me` (computed from the user's builtin org-scope group); only Wave E removes it. |

## Critical files (paths + role)

**To create (~30 files):**
- `infra/postgres/migrations/0141_permissions_catalog.sql` — schema
- `infra/postgres/migrations/0142_permissions_seed_actions.sql` — action catalog seed
- `infra/postgres/migrations/0143_permissions_builtin_groups.sql` — built-in groups + defaults
- `infra/postgres/migrations/0144_permissions_backfill_memberships.sql` — backfill
- `infra/postgres/migrations/0145_permissions_contract.sql` — drop legacy `role` (Wave E only)
- `packages/permissions/{package.json,src/index.ts,src/resolver.ts,src/cache.ts,src/types.ts,src/__tests__/...}`
- `apps/permissions-codegen/{generate.mjs,src/generated/permissions.ts}` — manifest generator + emitted constants
- `scripts/generate-permission-manifest.mjs` — static analysis pass over routes + tools
- `scripts/check-permission-catalog.mjs` — CI drift guard
- `scripts/codemod-replace-role-gates.mjs` — code rewriter
- `apps/api/src/services/permissions.service.ts` — DB-backed resolver
- `apps/api/src/services/permissions-telemetry.service.ts` — divergence logger
- `apps/api/src/routes/permissions.routes.ts` — admin endpoints (group CRUD, account assignment)
- `apps/api/src/plugins/permissions.ts` — Fastify plugin
- `apps/frontend/src/pages/superuser/permissions/groups.tsx` + `divergences.tsx` + per-account editor
- `apps/api/test/permissions-contract.test.ts` — every-route check
- `docs/permissions-overhaul-plan.md` — durable copy of this plan in the repo (project memory rule)
- `docs/permissions-action-manifest.json` — committed source of truth for the catalog

**To modify (high blast radius):**
- `apps/api/src/plugins/auth.ts` — add permissions plugin invocation, dual-read during Wave B, remove legacy helpers in Wave E.
- `apps/api/src/env.ts` — new `BBB_PERMISSIONS_ENFORCE` env (`off | warn | on`).
- `apps/mcp-server/src/lib/register-tool.ts` — add per-action gate inside the existing PolicyGate.
- `apps/{banter,beacon,brief,bolt,bearing,board,bond,blast,bench,book,blank,bill}-api/src/plugins/auth.ts` — adopt `@bigbluebam/permissions`.
- `apps/{frontend,banter,beacon,brief,bolt,bearing,board,bond,blast,bench,book,blank,bill}/src/**/*.tsx` — `useCan` rollout (~100 sites).
- `packages/ui/src/...` — new `useCan` hook export.
- `CLAUDE.md` — reference the new model.

**Existing functions to reuse (don't reinvent):**
- `apps/mcp-server/src/lib/confirm-token-store.ts` — Redis-with-fallback pattern.
- `apps/api/src/services/agent-policies.service.ts` — glob match semantics for permission wildcards.
- `apps/api/src/services/visibility.service.ts` — hot-path resolution that joins many tables; copy the query pattern.
- `apps/mcp-server/src/server.ts:130` — Redis pubsub invalidation idiom.
- `scripts/check-bolt-catalog.mjs` — CI drift guard template.
- `infra/postgres/migrations/0116_rls.sql` — RLS policy template.
- `infra/postgres/migrations/0139_agent_runner_webhooks.sql` (or whichever introduces `agent_policies`) — table + RLS + backfill template.
- `apps/api/src/boot/rls-boot.ts` — feature-flag-gated boot pattern; mirror for `BBB_PERMISSIONS_ENFORCE`.

## Verification

End-to-end across waves:

1. **Catalog round-trip**: every MCP tool registered via `register-tool.ts` and every route declared via `fastify.<verb>(...)` resolves to exactly one row in the `permissions` table at build time. `pnpm exec node scripts/check-permission-catalog.mjs` exits 0.
2. **Backfill correctness**: SQL audit query `select * from organization_memberships m where not exists (select 1 from account_group_memberships agm where agm.user_id = m.user_id and agm.scope_type = 'org' and agm.scope_id = m.org_id and agm.group_id in (select id from permission_groups where is_builtin and legacy_role = m.role))` returns zero rows.
3. **Divergence soak (Wave B)**: 14 days at `BBB_PERMISSIONS_ENFORCE=warn` across all production orgs with `permissions.divergence` log line count = 0 for ≥ 7 consecutive days. Telemetry export query: `select count(*) from logs where event = 'permissions.divergence' and timestamp > now() - interval '7 days'`.
4. **Performance**: P99 added latency for `requireCan` measured by Pino timing logs ≤ 2 ms; cache hit ratio ≥ 95 % per org after 1-hour warmup.
5. **Wave C contract test**: `apps/api/test/permissions-contract.test.ts` boots the api with `BBB_PERMISSIONS_ENFORCE=1` and exercises every registered route under all 5 built-in groups, asserting expected ALLOW/DENY against a fixture. Same for MCP tools via the `tools-call` route.
6. **UI smoke (Wave D)**: 10 critical gates listed in the UI investigation report (frontend "Promote to Owner", Bill "Approve Invoice", etc.) work for owner/admin/member; deny correctly for viewer/guest; SuperUser bypasses everything.
7. **Permission editor**: SuperUser creates a new "Channel Moderator" custom group at the project scope, assigns it to a member, verifies they can `banter.message.delete` in that project but not elsewhere.
8. **Wave E drift**: `pnpm db:check` reports zero drift; `grep -r "requireMinRole\|requireRole\|isOrgPrivileged" apps/` returns zero results outside test fixtures.

## Decisions resolved

The user confirmed three load-bearing design choices:

1. **Helpdesk-api stays exempt.** Current `helpdesk_users` + `helpdesk_sessions` model is preserved. Its ~40 actions appear in the catalog under the `helpdesk.*` namespace and resolve as always-allowed for authenticated portal sessions; the resolver short-circuits the helpdesk namespace before per-action checks. No migration to the unified model in this work.
2. **SuperUser stays a boolean.** `users.is_superuser` continues to short-circuit the resolver at step 1 (ALLOW for everything except an audited deny-list). No "Platform SuperUser" group; SuperUser appears in the editor as a checkbox on the account page, not as a group membership.
3. **Group propagation: snapshot-and-detach on first override.** Documented in detail above under "Group propagation". A live-attached account picks up group-default edits; the moment any permission is explicitly overridden at a scope, the trigger snapshots the group's current defaults into `account_permissions` and stamps `detached_at` on the membership, freezing the account at that scope. The operator can rebase or fully reattach at any time via the editor UI.

## Operational policies (defaults; operator can override anytime)

- **Soak duration**: 14 days at `BBB_PERMISSIONS_ENFORCE=warn` before flipping to `=on`. Adjust based on production telemetry; the divergence dashboard makes the decision data-driven.
- **Wave C codemod review**: every codemod-generated diff is human-reviewed before merge. The contract test is the safety net but not the only one.
- **Launchpad app visibility**: stays as a separate visibility knob (today's behavior). Not modeled as `platform.app.<x>.access` permissions. The two systems compose: an app must be visible (launchpad config) AND the user must have the relevant `<app>.<resource>.<verb>` permissions to act inside it.
