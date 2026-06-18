import { api } from '@/lib/api';

// --- Types ---

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

export interface SuperuserUserOrgMembership {
  org_id: string;
  name: string;
  slug: string;
  role: OrgRole | string;
  is_default: boolean;
}

export interface SuperuserUserListItem {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  last_seen_at: string | null;
  orgs: SuperuserUserOrgMembership[];
}

export interface SuperuserUserListResponse {
  data: SuperuserUserListItem[];
  next_cursor: string | null;
}

export interface SuperuserUserDisabledBy {
  id: string;
  email: string;
  display_name: string;
}

export interface SuperuserUserFullMembership {
  org_id: string;
  org_name: string;
  org_slug: string;
  role: OrgRole | string;
  is_default: boolean;
  joined_at: string;
}

export interface SuperuserUserAuditEntry {
  action: string;
  created_at: string;
  details: Record<string, unknown> | null;
}

export interface SuperuserUserDetail {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string | null;
  is_active: boolean;
  is_superuser: boolean;
  email_verified: boolean;
  pending_email: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
  disabled_by: SuperuserUserDisabledBy | null;
  memberships: SuperuserUserFullMembership[];
  recent_audit: SuperuserUserAuditEntry[];
}

export interface SuperuserUserSession {
  id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  active_org_id: string | null;
}

export interface SuperuserUserProject {
  project_id: string;
  project_name: string;
  project_slug: string;
  org_id: string;
  org_name: string;
  role: string;
  joined_at: string;
  is_archived: boolean;
}

export interface SuperuserAuditLogEntry {
  id: string;
  superuser_id: string;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface SuperuserAuditLogResponse {
  data: SuperuserAuditLogEntry[];
  next_cursor: string | null;
}

export interface ListSuperuserUsersParams {
  search?: string;
  limit?: number;
  cursor?: string | null;
  is_active?: boolean;
  is_superuser?: boolean;
}

// --- API wrapper ---

export const superuserUsersApi = {
  listUsers(params: ListSuperuserUsersParams = {}): Promise<SuperuserUserListResponse> {
    return api.get<SuperuserUserListResponse>('/superuser/users', {
      search: params.search,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
      is_active: params.is_active,
      is_superuser: params.is_superuser,
    });
  },

  getUser(id: string): Promise<{ data: SuperuserUserDetail }> {
    return api.get<{ data: SuperuserUserDetail }>(`/superuser/users/${id}`);
  },

  addMembership(
    id: string,
    body: { org_id: string; role: OrgRole },
  ): Promise<{ data: { org_id: string; role: OrgRole } }> {
    return api.post<{ data: { org_id: string; role: OrgRole } }>(
      `/superuser/users/${id}/memberships`,
      body,
    );
  },

  removeMembership(id: string, orgId: string): Promise<void> {
    return api.delete<void>(`/superuser/users/${id}/memberships/${orgId}`);
  },

  /** SuperUser-only account-level soft delete. The server refuses to act
   *  on self or another SuperUser; demote `is_superuser` first if that
   *  needs to happen. */
  deleteAccount(id: string, reason?: string): Promise<{
    data: { success: boolean; id: string; previous_email: string };
  }> {
    return api.delete(`/superuser/users/${id}`, reason ? { reason } : undefined);
  },

  updateMembershipRole(
    id: string,
    orgId: string,
    role: OrgRole,
  ): Promise<{ data: { role: OrgRole } }> {
    return api.patch<{ data: { role: OrgRole } }>(
      `/superuser/users/${id}/memberships/${orgId}`,
      { role },
    );
  },

  setDefaultOrg(
    id: string,
    orgId: string,
  ): Promise<{ data: { is_default: true; org_id: string } }> {
    return api.post<{ data: { is_default: true; org_id: string } }>(
      `/superuser/users/${id}/set-default-org`,
      { org_id: orgId },
    );
  },

  listSessions(id: string): Promise<{ data: SuperuserUserSession[] }> {
    return api.get<{ data: SuperuserUserSession[] }>(`/superuser/users/${id}/sessions`);
  },

  revokeSession(id: string, sessionId: string): Promise<void> {
    return api.delete<void>(`/superuser/users/${id}/sessions/${sessionId}`);
  },

  revokeAllSessions(id: string): Promise<{ data: { revoked: number } }> {
    return api.post<{ data: { revoked: number } }>(
      `/superuser/users/${id}/sessions/revoke-all`,
    );
  },

  changeEmail(
    id: string,
    newEmail: string,
  ): Promise<{ data: { user_id: string; pending_email: string; email_sent: boolean } }> {
    return api.patch<{ data: { user_id: string; pending_email: string; email_sent: boolean } }>(
      `/superuser/users/${id}/email`,
      { new_email: newEmail },
    );
  },

  listUserProjects(
    id: string,
    scope: 'active' | 'all' = 'active',
  ): Promise<{ data: SuperuserUserProject[] }> {
    return api.get<{ data: SuperuserUserProject[] }>(`/superuser/users/${id}/projects`, {
      scope,
    });
  },

  getAuditLog(params: {
    target_user_id?: string;
    action?: string;
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<SuperuserAuditLogResponse> {
    return api.get<SuperuserAuditLogResponse>('/superuser/audit-log', {
      target_user_id: params.target_user_id,
      action: params.action,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
    });
  },

  /**
   * Cross-org active toggle (SuperUser only). Enables or disables a user
   * server-wide — does NOT touch org memberships.
   */
  setActive(
    userId: string,
    isActive: boolean,
  ): Promise<{
    data: {
      id: string;
      is_active: boolean;
      disabled_at: string | null;
      disabled_by: string | null;
    };
  }> {
    return api.patch<{
      data: {
        id: string;
        is_active: boolean;
        disabled_at: string | null;
        disabled_by: string | null;
      };
    }>(`/superuser/users/${userId}/active`, { is_active: isActive });
  },

  // Status toggle — reuses the org-scoped set-active via /platform which we don't have;
  // SuperUsers disable users directly via set-default/memberships mutations plus
  // org-scoped disable. For the cross-org disable, we call platform/users toggle.
  setSuperuserFlag(
    id: string,
    isSuperuser: boolean,
  ): Promise<{ data: { id: string; is_superuser: boolean } }> {
    return api.patch<{ data: { id: string; is_superuser: boolean } }>(
      `/v1/platform/users/${id}/superuser`,
      { is_superuser: isSuperuser },
    );
  },

  impersonate(
    targetUserId: string,
    reason?: string,
  ): Promise<{ data: { id: string } }> {
    // Server expects { user_id }; reason is accepted for audit and ignored if
    // unused server-side.
    return api.post<{ data: { id: string } }>('/v1/platform/impersonate', {
      user_id: targetUserId,
      reason,
    });
  },

  stopImpersonation(): Promise<{ data: { success: boolean } }> {
    return api.post<{ data: { success: boolean } }>('/v1/platform/stop-impersonation', {});
  },
};
