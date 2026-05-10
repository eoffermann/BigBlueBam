// The 7-step resolver. Pure function over a PermissionContext; no I/O.
// See docs/permissions-overhaul-plan.md "Resolution algorithm" for the
// full prose specification.

import { ALWAYS_PERMITTED, PERMISSIONS_BY_ID } from './generated/permissions.js';
import type {
  AccountGroupMembership,
  AccountPermissionRow,
  Decision,
  PermissionContext,
  PermissionScope,
  ResolveResult,
  ScopeType,
} from './types.js';

const READ_VERBS: ReadonlySet<string> = new Set([
  'list', 'get', 'search', 'view', 'browse', 'query', 'read', 'find', 'count',
  'preview', 'export', 'summarize', 'detail', 'graph', 'audit',
]);

// API-key `read_write` scope refuses anything marked is_destructive in the
// catalog (verbs like delete/archive/transfer/set_role/invite/remove). Used
// as a fallback verb-list when the permission isn't in the catalog yet.
//
// Wave A used this verb set as the source of truth; Wave B follow-up
// switched the *primary* check to the catalog's is_destructive column so
// the catalog can be extended without redeploying the resolver.
const FALLBACK_DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  'delete', 'archive', 'transfer', 'set_role', 'invite', 'remove',
  'destroy', 'purge', 'wipe', 'demote', 'promote', 'cancel',
]);

/**
 * Helpdesk namespace short-circuit. Per the user's design decision (see
 * docs/permissions-overhaul-plan.md "Decisions resolved"), helpdesk-api
 * keeps its isolated customer-portal auth model and its ~47 actions
 * always-resolve-allow for any authenticated session. The catalog still
 * lists them so the operator can audit the surface, but the resolver
 * short-circuits before any group/override logic kicks in. Mirrors the
 * always-permitted core idiom but applied to a whole namespace.
 */
const HELPDESK_NAMESPACE_PREFIX = 'helpdesk.';

/**
 * Glob-prefix match used for agent_policies allowed_tools. Mirrors the
 * semantics in apps/api/src/services/agent-policy.service.ts so the
 * resolver decision stays consistent with the §15 outer gate.
 */
function matchesGlob(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*') || pattern.endsWith('_*')) {
    const prefix = pattern.slice(0, -2);
    return toolName === prefix
        || toolName.startsWith(prefix + '.')
        || toolName.startsWith(prefix + '_');
  }
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

function isReadVerb(permissionId: string): boolean {
  const meta = PERMISSIONS_BY_ID.get(permissionId);
  if (meta) return meta.is_read;
  // Fallback for permissions added between codegen runs: parse the verb.
  const verb = permissionId.split('.').pop() ?? '';
  return READ_VERBS.has(verb);
}

function isDestructive(permissionId: string): boolean {
  const meta = PERMISSIONS_BY_ID.get(permissionId);
  if (meta) return meta.is_destructive;
  // Fallback for permissions added between codegen runs.
  const verb = permissionId.split('.').pop() ?? '';
  return FALLBACK_DESTRUCTIVE_VERBS.has(verb);
}

function findMembership(
  memberships: readonly AccountGroupMembership[],
  scopeType: ScopeType,
  scopeId: string | null,
): AccountGroupMembership | undefined {
  return memberships.find(
    (m) => m.scope_type === scopeType && (m.scope_id ?? null) === (scopeId ?? null),
  );
}

function findOverride(
  rows: readonly AccountPermissionRow[],
  scopeType: ScopeType,
  scopeId: string | null,
  permissionId: string,
): AccountPermissionRow | undefined {
  return rows.find(
    (r) =>
      r.scope_type === scopeType &&
      (r.scope_id ?? null) === (scopeId ?? null) &&
      r.permission_id === permissionId,
  );
}

function resolveAtScope(
  ctx: PermissionContext,
  scopeType: ScopeType,
  scopeId: string | null,
  permissionId: string,
): { decision: Decision; reason: ResolveResult['reason']; group_id?: string } | null {
  const membership = findMembership(ctx.memberships, scopeType, scopeId);
  const override = findOverride(ctx.account_overrides, scopeType, scopeId, permissionId);

  if (!membership) {
    // No group at this scope — only an explicit override counts.
    if (override) {
      return { decision: override.granted ? 'allow' : 'deny', reason: scopeReasonForOverride(scopeType, false) };
    }
    return null;
  }

  if (membership.detached_at == null) {
    // Live: an explicit override (race window, BEFORE the trigger fires)
    // wins; otherwise read the group default.
    if (override) {
      return { decision: override.granted ? 'allow' : 'deny', reason: scopeReasonForOverride(scopeType, false) };
    }
    const granted = ctx.group_defaults.get(`${membership.group_id}:${permissionId}`);
    if (typeof granted === 'boolean') {
      return { decision: granted ? 'allow' : 'deny', reason: scopeReasonForGroup(scopeType), group_id: membership.group_id };
    }
    // Group has no default for this permission (e.g. a custom group with
    // a sparse default set). Fall through to next scope.
    return null;
  }

  // Detached: only account_permissions count.
  if (override) {
    return {
      decision: override.granted ? 'allow' : 'deny',
      reason: override.is_snapshot ? scopeReasonForSnapshot(scopeType) : scopeReasonForOverride(scopeType, true),
      group_id: membership.group_id,
    };
  }
  return null;
}

function scopeReasonForOverride(scope: ScopeType, _detached: boolean): ResolveResult['reason'] {
  if (scope === 'project') return 'project_override';
  if (scope === 'org') return 'org_override';
  return 'global_override';
}
function scopeReasonForGroup(scope: ScopeType): ResolveResult['reason'] {
  if (scope === 'project') return 'project_group_default';
  if (scope === 'org') return 'org_group_default';
  return 'global_group_default';
}
function scopeReasonForSnapshot(scope: ScopeType): ResolveResult['reason'] {
  if (scope === 'project') return 'project_snapshot';
  if (scope === 'org') return 'org_snapshot';
  return 'global_snapshot';
}

/**
 * The full 7-step resolver. Returns ALLOW/DENY plus a structured reason
 * usable for telemetry. Pure function over the supplied context; no I/O.
 */
export function resolve(
  ctx: PermissionContext,
  permissionId: string,
  scope: PermissionScope,
): ResolveResult {
  // 1. SuperUser short-circuit.
  if (ctx.subject.is_superuser) {
    return { decision: 'allow', reason: 'superuser_bypass' };
  }

  // 2. Always-permitted core.
  if (ALWAYS_PERMITTED.has(permissionId)) {
    return { decision: 'allow', reason: 'always_permitted_core' };
  }

  // 2.5. Helpdesk namespace short-circuit. The customer-portal auth model
  // is preserved; helpdesk.* actions resolve allow for any authenticated
  // session because helpdesk-api enforces visibility at its own layer.
  if (permissionId.startsWith(HELPDESK_NAMESPACE_PREFIX)) {
    return { decision: 'allow', reason: 'always_permitted_core' };
  }

  // 3. API-key scope ceiling. Drives off the catalog's is_destructive
  // column (with a verb-set fallback) instead of a hardcoded list.
  const keyScope = ctx.subject.api_key_scope;
  if (keyScope != null) {
    if (keyScope === 'read' && !isReadVerb(permissionId)) {
      return { decision: 'deny', reason: 'api_key_ceiling_exceeded' };
    }
    if (keyScope === 'read_write' && isDestructive(permissionId)) {
      return { decision: 'deny', reason: 'api_key_ceiling_exceeded' };
    }
  }

  // 4. Agent policy gate (only for agent / service kinds).
  if (ctx.subject.kind === 'agent' || ctx.subject.kind === 'service') {
    const policy = ctx.agent_policy;
    if (!policy || !policy.enabled) {
      return { decision: 'deny', reason: 'agent_disabled' };
    }
    const allowed = policy.allowed_tools.some((p) => matchesGlob(permissionId, p));
    if (!allowed) {
      return { decision: 'deny', reason: 'agent_tool_not_allowed' };
    }
  }

  // 5. Per-action resolution: project → org → global.
  if (scope.project_id) {
    const result = resolveAtScope(ctx, 'project', scope.project_id, permissionId);
    if (result) return { ...result };
  }
  if (scope.org_id) {
    const result = resolveAtScope(ctx, 'org', scope.org_id, permissionId);
    if (result) return { ...result };
  }
  const globalResult = resolveAtScope(ctx, 'global', null, permissionId);
  if (globalResult) return { ...globalResult };

  // 6. Implicit deny — the catalog row exists but no scope produced an
  // answer. Different reason from "permission not in catalog" so
  // telemetry can distinguish these.
  if (PERMISSIONS_BY_ID.has(permissionId)) {
    return { decision: 'deny', reason: 'implicit_deny' };
  }
  return { decision: 'deny', reason: 'permission_not_in_catalog' };
}

/** Convenience boolean form for hooks and quick checks. */
export function can(
  ctx: PermissionContext,
  permissionId: string,
  scope: PermissionScope,
): boolean {
  return resolve(ctx, permissionId, scope).decision === 'allow';
}
