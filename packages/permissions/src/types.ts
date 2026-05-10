// Types shared across the permissions package and its consumers.

export type ScopeType = 'global' | 'org' | 'project';

export interface PermissionScope {
  /** The org context the request runs in. NULL only for SuperUser global ops. */
  readonly org_id: string | null;
  /** Project context if the action is project-scoped. */
  readonly project_id?: string | null;
}

export interface AuthSubject {
  readonly id: string;
  readonly is_superuser: boolean;
  readonly kind: 'human' | 'agent' | 'service';
  /**
   * The api-key scope ceiling — `read | read_write | admin` for an API-key
   * authenticated request, or `null` for session auth (no ceiling).
   */
  readonly api_key_scope: 'read' | 'read_write' | 'admin' | null;
}

export interface PermissionGroup {
  readonly id: string;
  readonly name: string;
  readonly is_builtin: boolean;
  readonly legacy_role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest' | null;
}

export interface AccountGroupMembership {
  readonly group_id: string;
  readonly scope_type: ScopeType;
  readonly scope_id: string | null;
  /** NULL = live (read group defaults); non-NULL = detached (read account_permissions only). */
  readonly detached_at: string | null;
}

export interface AccountPermissionRow {
  readonly scope_type: ScopeType;
  readonly scope_id: string | null;
  readonly permission_id: string;
  readonly granted: boolean;
  readonly is_snapshot: boolean;
}

/**
 * The full per-user permission state needed by the resolver. The actual
 * service implementation in apps/api fetches and shapes this from the
 * database; the package's resolver is a pure function over this object so
 * it can be unit-tested without a DB and re-used in the React `useCan`
 * hook (which receives a serialized version over /auth/me).
 */
export interface PermissionContext {
  readonly subject: AuthSubject;
  readonly memberships: readonly AccountGroupMembership[];
  readonly account_overrides: readonly AccountPermissionRow[];
  /**
   * Group default lookup. The service pre-fetches every default for every
   * group the user is a member of and packs them keyed by `${group_id}:${permission_id}`.
   */
  readonly group_defaults: ReadonlyMap<string, boolean>;
  /**
   * Agent policy state for `kind in (agent, service)`. The resolver
   * defers to this layer BEFORE per-action resolution; mirrors the §15
   * wrapper in apps/mcp-server/src/lib/register-tool.ts.
   */
  readonly agent_policy?: {
    readonly enabled: boolean;
    readonly allowed_tools: readonly string[];
  };
}

export type Decision = 'allow' | 'deny';

export interface ResolveResult {
  readonly decision: Decision;
  /**
   * Why the resolver decided this — useful for telemetry and debugging.
   * Mirrors the divergence-log fields in Wave B.
   */
  readonly reason:
    | 'superuser_bypass'
    | 'always_permitted_core'
    | 'api_key_ceiling_exceeded'
    | 'agent_disabled'
    | 'agent_tool_not_allowed'
    | 'project_override'
    | 'project_group_default'
    | 'project_snapshot'
    | 'org_override'
    | 'org_group_default'
    | 'org_snapshot'
    | 'global_override'
    | 'global_group_default'
    | 'global_snapshot'
    | 'implicit_deny'
    | 'permission_not_in_catalog';
  /** The scope at which the decision was made, if applicable. */
  readonly scope_type?: ScopeType;
  /** The group id, if the decision came from a group default. */
  readonly group_id?: string;
}
