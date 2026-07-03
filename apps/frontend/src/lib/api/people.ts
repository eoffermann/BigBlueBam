import { api } from '@/lib/api';

// --- Types ---

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';
export type ProjectMemberRole = 'admin' | 'member' | 'viewer';

export interface PersonListItem {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: MemberRole | string;
  is_active: boolean;
  created_at: string;
  last_seen_at: string | null;
  // P1-25: optimistic-concurrency token bumped on every role/active edit.
  version: number;
}

export interface PersonProjectEntry {
  project_id: string;
  name: string;
  role: ProjectMemberRole | string;
  joined_at: string;
}

export interface PersonDisabledBy {
  id: string;
  email: string;
  display_name: string;
}

export interface PersonDetail {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string | null;
  role: MemberRole | string;
  is_active: boolean;
  disabled_at: string | null;
  disabled_by: PersonDisabledBy | null;
  joined_at: string;
  is_default_org: boolean;
  // P1-25: optimistic-concurrency token for role/active edits.
  version: number;
  created_at: string;
  last_seen_at: string | null;
  projects: PersonProjectEntry[];
}

export interface PersonProjectMembership {
  project_id: string;
  project_name: string;
  project_slug: string;
  role: ProjectMemberRole | string;
  joined_at: string;
  is_archived: boolean;
}

export interface ActiveStatusResult {
  user_id: string;
  is_active: boolean;
  disabled_at: string | null;
  last_owner_remaining: boolean;
  membership_version: number;
}

export interface TransferOwnershipResult {
  previous_owner_id: string;
  new_owner_id: string;
  org_id: string;
}

export interface AddProjectsResult {
  added: string[];
  skipped: string[];
}

export interface UpdateProfileBody {
  display_name?: string;
  timezone?: string;
}

export interface AssignProjectsBody {
  assignments: { project_id: string; role: ProjectMemberRole }[];
}

// --- API wrapper ---

export const peopleApi = {
  listMembers(): Promise<{ data: PersonListItem[] }> {
    return api.get<{ data: PersonListItem[] }>('/org/members');
  },

  getMember(userId: string): Promise<{ data: PersonDetail }> {
    return api.get<{ data: PersonDetail }>(`/org/members/${userId}`);
  },

  updateProfile(userId: string, body: UpdateProfileBody): Promise<{ data: PersonDetail }> {
    return api.patch<{ data: PersonDetail }>(`/org/members/${userId}/profile`, body);
  },

  // Stage an email change for a member. The swap is not applied here — a
  // confirmation link is emailed to the new address and the member must click
  // it to finalize (POST /auth/verify-email/:token).
  changeEmail(
    userId: string,
    newEmail: string,
  ): Promise<{ data: { user_id: string; pending_email: string; email_sent: boolean } }> {
    return api.patch<{ data: { user_id: string; pending_email: string; email_sent: boolean } }>(
      `/org/members/${userId}/email`,
      { new_email: newEmail },
    );
  },

  setActive(
    userId: string,
    isActive: boolean,
    version?: number,
  ): Promise<{ data: ActiveStatusResult }> {
    return api.patch<{ data: ActiveStatusResult }>(`/org/members/${userId}/active`, {
      is_active: isActive,
      ...(version !== undefined ? { version } : {}),
    });
  },

  transferOwnership(userId: string): Promise<{ data: TransferOwnershipResult }> {
    return api.post<{ data: TransferOwnershipResult }>(
      `/org/members/${userId}/transfer-ownership`,
    );
  },

  listMemberProjects(userId: string): Promise<{ data: PersonProjectMembership[] }> {
    return api.get<{ data: PersonProjectMembership[] }>(`/org/members/${userId}/projects`);
  },

  addMemberToProjects(userId: string, body: AssignProjectsBody): Promise<{ data: AddProjectsResult }> {
    return api.post<{ data: AddProjectsResult }>(`/org/members/${userId}/projects`, body);
  },

  updateMemberProjectRole(
    userId: string,
    projectId: string,
    role: ProjectMemberRole,
  ): Promise<{ data: PersonProjectMembership }> {
    return api.patch<{ data: PersonProjectMembership }>(
      `/org/members/${userId}/projects/${projectId}`,
      { role },
    );
  },

  removeMemberFromProject(userId: string, projectId: string): Promise<{ data: { removed: true } }> {
    return api.delete<{ data: { removed: true } }>(`/org/members/${userId}/projects/${projectId}`);
  },

  // Reused existing endpoints
  updateRole(
    userId: string,
    role: string,
    version?: number,
  ): Promise<{ data: PersonListItem & { membership_version: number } }> {
    return api.patch<{ data: PersonListItem & { membership_version: number } }>(
      `/org/members/${userId}`,
      { role, ...(version !== undefined ? { version } : {}) },
    );
  },

  removeMember(userId: string): Promise<void> {
    return api.delete<void>(`/org/members/${userId}`);
  },

  /** Eligibility probe used by the People detail UI to decide whether
   *  to render the "Delete account" button. Returns reason on `eligible:
   *  false` so the UI can show a helpful disabled-state tooltip. */
  deletionEligibility(userId: string): Promise<{
    data: {
      eligible: boolean;
      reason?: 'self' | 'is_superuser' | 'not_admin_everywhere' | 'target_not_found';
      target_orgs: string[];
      caller_admin_orgs: string[];
    };
  }> {
    return api.get(`/org/members/${userId}/deletion-eligibility`);
  },

  deleteAccount(userId: string, reason?: string): Promise<{
    data: { success: boolean; id: string; previous_email: string };
  }> {
    return api.post(`/org/members/${userId}/delete-account`, reason ? { reason } : {});
  },

  inviteMember(body: {
    email: string;
    display_name?: string;
    role: string;
    project_ids?: string[];
  }): Promise<{
    data: PersonListItem & {
      was_existing: boolean;
      email_sent: boolean;
    };
  }> {
    return api.post<{
      data: PersonListItem & {
        was_existing: boolean;
        email_sent: boolean;
      };
    }>('/org/members/invite', body);
  },

  bulkInviteMembers(
    invites: Array<{
      email: string;
      display_name?: string;
      role: string;
      project_ids?: string[];
    }>,
  ): Promise<{
    data: {
      succeeded: Array<
        PersonListItem & { was_existing: boolean; email_sent: boolean }
      >;
      failed: Array<{ email: string; code: string; message: string }>;
      total_requested: number;
      total_succeeded: number;
      total_failed: number;
    };
  }> {
    return api.post('/org/members/invite/bulk', { invites });
  },

  sendPasswordResetLink(
    userId: string,
  ): Promise<{
    data: {
      user_id: string;
      email: string;
      email_sent: boolean;
      smtp_configured: boolean;
      expires_in_minutes: number;
      message: string;
    };
  }> {
    return api.post(`/org/members/${userId}/send-password-reset`);
  },

  resetPassword(
    userId: string,
    password?: string,
  ): Promise<{ data: { user_id: string; email: string; password: string; generated: boolean } }> {
    return api.post<{ data: { user_id: string; email: string; password: string; generated: boolean } }>(
      `/org/members/${userId}/reset-password`,
      password ? { password } : {},
    );
  },

  forcePasswordChange(
    userId: string,
  ): Promise<{ data: { user_id: string; force_password_change: true } }> {
    return api.post<{ data: { user_id: string; force_password_change: true } }>(
      `/org/members/${userId}/force-password-change`,
    );
  },

  signOutEverywhere(userId: string): Promise<{ data: { revoked: number } }> {
    return api.post<{ data: { revoked: number } }>(
      `/org/members/${userId}/sign-out-everywhere`,
    );
  },

  listApiKeys(userId: string): Promise<{ data: ApiKeyRecord[] }> {
    return api.get<{ data: ApiKeyRecord[] }>(`/org/members/${userId}/api-keys`);
  },

  createApiKey(
    userId: string,
    body: CreateApiKeyBody,
  ): Promise<{ data: ApiKeyRecord & { token: string } }> {
    return api.post<{ data: ApiKeyRecord & { token: string } }>(
      `/org/members/${userId}/api-keys`,
      body,
    );
  },

  revokeApiKey(userId: string, keyId: string): Promise<void> {
    return api.delete<void>(`/org/members/${userId}/api-keys/${keyId}`);
  },

  getActivity(
    userId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ data: ActivityEntry[]; next_cursor: string | null }> {
    const params: Record<string, string | number> = {};
    if (opts?.limit != null) params.limit = opts.limit;
    if (opts?.cursor) params.cursor = opts.cursor;
    return api.get<{ data: ActivityEntry[]; next_cursor: string | null }>(
      `/org/members/${userId}/activity`,
      params,
    );
  },
};

// --- API keys ---

export type ApiKeyScope = 'read' | 'read_write' | 'admin';

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scope: ApiKeyScope | string;
  project_ids: string[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface CreateApiKeyBody {
  name: string;
  scope: ApiKeyScope;
  project_ids?: string[];
  expires_days?: number;
}

// --- Activity ---

export interface ActivityEntry {
  id: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
  impersonator_id: string | null;
}

// --- Auth (self) ---

export interface ChangePasswordBody {
  current_password: string;
  new_password: string;
}

export function changePassword(
  body: ChangePasswordBody,
): Promise<{ data: { success: true } }> {
  return api.post<{ data: { success: true } }>('/auth/change-password', body);
}

// --- Rank helpers (mirrors backend) ---

export const ROLE_HIERARCHY: readonly string[] = ['guest', 'viewer', 'member', 'admin', 'owner'];

export function roleLevel(role: string | null | undefined): number {
  return ROLE_HIERARCHY.indexOf(role ?? '');
}

/**
 * Strict rank: caller must OUTRANK target (peer disallowed), unless caller is SuperUser.
 * Use for every action on a target member in the People UI.
 */
export function canActOn(
  caller: { role?: string; is_superuser?: boolean; id?: string } | null | undefined,
  target: { role?: string; id?: string },
): boolean {
  if (!caller) return false;
  if (caller.is_superuser) return true;
  if (caller.id && target.id && caller.id === target.id) return false;
  const callerLvl = roleLevel(caller.role);
  const targetLvl = roleLevel(target.role);
  if (callerLvl < 0 || targetLvl < 0) return false;
  // Must be an admin-or-higher to act at all
  const adminLvl = roleLevel('admin');
  if (callerLvl < adminLvl) return false;
  return callerLvl > targetLvl;
}
