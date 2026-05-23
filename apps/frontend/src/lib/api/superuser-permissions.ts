// Wave F.2 — SuperUser permissions API client.
// Mirrors the contract in `docs/wave-d-audit/wave-f-api-contract.md` §1, §2.
// Endpoints are under /superuser/permissions/* and gated by SU bypass.

import { api } from '@/lib/api';

// ─── Types (mirroring the F API contract) ───────────────────────────────────

export type ScopeType = 'global' | 'org' | 'project';

export interface PermissionCatalogItem {
  id: string;
  app: string;
  resource: string;
  verb: string;
  description: string;
  is_destructive: boolean;
  is_read: boolean;
  requires_confirmation: boolean;
  requires_superuser: boolean;
}

export interface PermissionCatalogResponse {
  data: {
    items: PermissionCatalogItem[];
    next_cursor: string | null;
    total: number;
  };
}

export interface PermissionGroupListItem {
  id: string;
  name: string;
  description: string | null;
  scope_type: ScopeType;
  scope_id: string | null;
  is_builtin: boolean;
  legacy_role: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  member_count: number;
  grant_count: number;
  deny_count: number;
}

export interface PermissionGroupListResponse {
  data: PermissionGroupListItem[];
}

export interface PermissionGroupDetail {
  group: PermissionGroupListItem;
  defaults: Record<string, boolean>;
  member_count: number;
}

export interface PermissionGroupDetailResponse {
  data: PermissionGroupDetail;
}

export interface CreateGroupInput {
  name: string;
  description?: string;
  scope_type: ScopeType;
  scope_id?: string | null;
  clone_from_group_id?: string;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
}

export interface SetDefaultsInput {
  set_true?: string[];
  set_false?: string[];
  reset_to_builtin?: boolean;
}

export interface SetDefaultsResponse {
  data: {
    group_id: string;
    changed: number;
    now_granted: number;
    now_denied: number;
  };
}

// ─── Catalog browse ─────────────────────────────────────────────────────────

export interface ListCatalogParams {
  app?: string;
  resource?: string;
  search?: string;
  is_destructive?: boolean;
  is_read?: boolean;
  requires_superuser?: boolean;
  limit?: number;
  cursor?: string;
}

// ─── Permission groups CRUD ─────────────────────────────────────────────────

export const superuserPermissionsApi = {
  listCatalog(params: ListCatalogParams = {}): Promise<PermissionCatalogResponse> {
    return api.get<PermissionCatalogResponse>('/superuser/permissions/catalog', {
      app: params.app,
      resource: params.resource,
      search: params.search,
      is_destructive: params.is_destructive,
      is_read: params.is_read,
      requires_superuser: params.requires_superuser,
      limit: params.limit,
      cursor: params.cursor,
    });
  },

  listGroups(params: { scope_type?: ScopeType; include_deleted?: boolean } = {}): Promise<PermissionGroupListResponse> {
    return api.get<PermissionGroupListResponse>('/superuser/permissions/groups', {
      scope_type: params.scope_type,
      include_deleted: params.include_deleted,
    });
  },

  getGroup(id: string): Promise<PermissionGroupDetailResponse> {
    return api.get<PermissionGroupDetailResponse>(`/superuser/permissions/groups/${id}`);
  },

  createGroup(body: CreateGroupInput): Promise<{ data: PermissionGroupListItem }> {
    return api.post<{ data: PermissionGroupListItem }>('/superuser/permissions/groups', body);
  },

  updateGroup(id: string, body: UpdateGroupInput): Promise<{ data: PermissionGroupListItem }> {
    return api.patch<{ data: PermissionGroupListItem }>(`/superuser/permissions/groups/${id}`, body);
  },

  deleteGroup(id: string): Promise<{ data: { success: true } }> {
    return api.delete<{ data: { success: true } }>(`/superuser/permissions/groups/${id}`);
  },

  setDefaults(id: string, body: SetDefaultsInput): Promise<SetDefaultsResponse> {
    return api.put<SetDefaultsResponse>(`/superuser/permissions/groups/${id}/defaults`, body);
  },

  resetGroup(id: string): Promise<SetDefaultsResponse> {
    return api.post<SetDefaultsResponse>(`/superuser/permissions/groups/${id}/reset`, {});
  },

  // ─── Wave F.3 — User permissions ──────────────────────────────────────────

  getUserPermissions(id: string): Promise<UserPermissionsResponse> {
    return api.get<UserPermissionsResponse>(`/superuser/permissions/users/${id}`);
  },

  setUserMembership(
    id: string,
    body: SetMembershipInput,
  ): Promise<{ data: UserMembership }> {
    return api.put<{ data: UserMembership }>(
      `/superuser/permissions/users/${id}/membership`,
      body,
    );
  },

  setUserOverride(
    id: string,
    permissionId: string,
    body: SetOverrideInput,
  ): Promise<{ data: UserOverride }> {
    return api.put<{ data: UserOverride }>(
      `/superuser/permissions/users/${id}/overrides/${encodeURIComponent(permissionId)}`,
      body,
    );
  },

  clearUserOverride(
    id: string,
    permissionId: string,
    body: ScopeRef,
  ): Promise<{ data: { success: true } }> {
    return api.delete<{ data: { success: true } }>(
      `/superuser/permissions/users/${id}/overrides/${encodeURIComponent(permissionId)}`,
      body,
    );
  },

  reattachUser(
    id: string,
    body: ScopeRef,
  ): Promise<{ data: { dropped_overrides: number } }> {
    return api.post<{ data: { dropped_overrides: number } }>(
      `/superuser/permissions/users/${id}/reattach`,
      body,
    );
  },
};

// ─── Wave F.3 user-permission types ───────────────────────────────────────────

export interface ScopeRef {
  scope_type: ScopeType;
  scope_id: string | null;
}

export interface UserSummary {
  id: string;
  email: string;
  display_name: string;
  is_superuser: boolean;
  kind: 'human' | 'agent' | 'service';
}

export interface UserMembershipGroup {
  id: string;
  name: string;
  legacy_role: string | null;
  is_builtin: boolean;
}

export interface UserMembership {
  scope_type: ScopeType;
  scope_id: string | null;
  scope_name?: string | null;
  group: UserMembershipGroup;
  detached_at: string | null;
  detached_by: string | null;
}

export interface UserOverride {
  scope_type: ScopeType;
  scope_id: string | null;
  scope_name?: string | null;
  permission_id: string;
  granted: boolean;
  is_snapshot: boolean;
  set_by: string | null;
  set_at: string;
  notes: string | null;
}

export type EffectiveSource =
  | 'superuser_bypass'
  | 'group_default'
  | 'override'
  | 'snapshot'
  | 'implicit_deny';

export interface EffectiveEntry {
  granted: boolean;
  source: EffectiveSource;
  group_id?: string | null;
  set_by?: string | null;
}

export interface UserPermissionsResponse {
  data: {
    user: UserSummary;
    memberships: UserMembership[];
    overrides: UserOverride[];
    effective_matrix: Record<string, EffectiveEntry>;
  };
}

export interface SetMembershipInput {
  scope_type: ScopeType;
  scope_id: string | null;
  group_id: string;
}

export interface SetOverrideInput {
  scope_type: ScopeType;
  scope_id: string | null;
  granted: boolean;
  notes?: string;
}
