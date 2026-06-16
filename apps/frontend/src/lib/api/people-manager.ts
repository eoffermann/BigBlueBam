/**
 * People Manager v2 — frontend API client (plan §7, milestone M2).
 *
 * Two responsibilities:
 *
 * 1. `listPeople` — wraps the new M1 multi-org scoped people endpoint
 *    (`GET /b3/api/people`). The response mirrors the server types
 *    `ScopedPerson` / `PersonMembership` / `PersonOrgCaps` from
 *    `apps/api/src/services/people.service.ts`.
 *
 * 2. An `X-Org-Id` header injector + thin wrappers over the EXISTING org
 *    endpoints used by the rich invite flow. The linchpin of v2 (plan §6/§7)
 *    is that every mutation reuses an existing `/org/members/*` endpoint with
 *    the `x-org-id` header set to the org the action targets — so a single
 *    admin can fan an invite out across several orgs they administer without
 *    any new backend. The backend resolves the caller's role IN that org and
 *    re-checks rank server-side (defense in depth).
 *
 * The shared `api` client (`@/lib/api`) does not accept per-request headers,
 * so this module talks to `/b3/api` via `fetch` directly for the org-scoped
 * calls, replicating the client's CSRF + credentials behavior.
 */

import { api, ApiError } from '@/lib/api';

const BASE_URL = '/b3/api';

// --- Scoped people list (mirrors server people.service.ts types) ---

export interface PersonOrgCaps {
  manage_role: boolean;
  disable: boolean;
  remove: boolean;
  reset_password: boolean;
  manage_projects: boolean;
  manage_keys: boolean;
  transfer_ownership: boolean;
  delete_account: boolean;
}

export interface PersonMembership {
  org_id: string;
  org_name: string;
  role: string;
  caps: PersonOrgCaps;
}

export interface ScopedPersonUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  last_seen_at: string | null;
}

export interface ScopedPerson {
  user: ScopedPersonUser;
  memberships: PersonMembership[];
}

export interface ListPeopleParams {
  search?: string;
  is_active?: boolean;
  role?: string;
  org_id?: string;
  /** Fetch a single person by user id (narrowing only; never widens scope). */
  user_id?: string;
  cursor?: string;
  limit?: number;
}

export interface ListPeopleResult {
  data: ScopedPerson[];
  next_cursor: string | null;
}

/**
 * `GET /b3/api/people` — the M1 scoped, permission-graded, multi-org list.
 * Caller-scoped server-side; we just thread the query params through.
 */
export function listPeople(params: ListPeopleParams = {}): Promise<ListPeopleResult> {
  return api.get<ListPeopleResult>('/people', {
    search: params.search,
    is_active: params.is_active,
    role: params.role,
    org_id: params.org_id,
    user_id: params.user_id,
    cursor: params.cursor,
    limit: params.limit,
  });
}

/**
 * Fetch a single person (with their in-scope memberships + per-org caps) via
 * the M3 `user_id` filter on `GET /people`. Returns `null` when the person is
 * not in the caller's visible scope (the server returns an empty list).
 */
export async function getPerson(userId: string): Promise<ScopedPerson | null> {
  const res = await listPeople({ user_id: userId, limit: 1 });
  return res.data[0] ?? null;
}

// --- X-Org-Id-aware fetch helpers ---

// HB-52: mirror the shared ApiClient's CSRF behavior — read the csrf_token
// cookie and echo it on mutating requests.
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  const value = match?.[1];
  return value ? decodeURIComponent(value) : null;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Issue a request to `/b3/api{path}` with the `X-Org-Id` header set so the
 * server resolves the caller's role in `orgId` (plan §6 "linchpin"). When
 * `orgId` is omitted the request behaves exactly like the shared `api`
 * client (caller's active org).
 */
async function orgScopedRequest<T>(
  method: string,
  path: string,
  orgId: string | undefined,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (orgId) headers['X-Org-Id'] = orgId;
  if (MUTATING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorData: {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>[];
        request_id?: string;
      };
    } = {};
    try {
      errorData = await response.json();
    } catch {
      // ignore parse errors
    }
    throw new ApiError(
      response.status,
      errorData.error?.code ?? 'UNKNOWN',
      errorData.error?.message ?? `Request failed with status ${response.status}`,
      errorData.error?.details,
      errorData.error?.request_id,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Admin orgs (from /auth/orgs) ---

export interface AdminOrg {
  org_id: string;
  name: string;
  slug: string;
  role: string;
}

interface AuthOrgsResponse {
  data: {
    active_org_id: string;
    organizations: Array<{
      org_id: string;
      name: string;
      slug: string;
      logo_url: string | null;
      role: string;
      is_default: boolean;
      joined_at: string;
    }>;
  };
}

const ADMIN_ROLES = new Set(['admin', 'owner']);

/**
 * The orgs the caller can invite into: their memberships filtered to roles
 * admin/owner. SuperUsers keep ALL their memberships (v1 — arbitrary cross-org
 * invite into orgs they do not belong to stays out of scope per plan §3/§5,
 * and `/auth/orgs` only returns native memberships anyway).
 */
export async function listMyAdminOrgs(): Promise<AdminOrg[]> {
  const res = await api.get<AuthOrgsResponse>('/auth/orgs');
  const orgs = res.data.organizations ?? [];
  return orgs
    .filter((o) => ADMIN_ROLES.has(o.role))
    .map((o) => ({ org_id: o.org_id, name: o.name, slug: o.slug, role: o.role }));
}

// --- Projects for a given org (GET /projects with X-Org-Id) ---

export interface OrgProject {
  id: string;
  name: string;
  slug: string;
  task_id_prefix: string;
}

interface ProjectsResponse {
  data: Array<{
    id: string;
    name: string;
    slug: string;
    task_id_prefix: string;
  }>;
}

/**
 * `GET /projects` scoped to `orgId` via the `X-Org-Id` header so the invite
 * dialog can offer only that org's projects (a project must belong to its
 * invite org or `inviteMember` throws CrossOrgProjectError).
 */
export async function listOrgProjects(orgId: string): Promise<OrgProject[]> {
  const res = await orgScopedRequest<ProjectsResponse>('GET', '/projects', orgId);
  return (res.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    task_id_prefix: p.task_id_prefix,
  }));
}

// --- Bulk invite into a specific org (POST /org/members/invite/bulk + X-Org-Id) ---

export interface BulkInviteRow {
  email: string;
  display_name?: string;
  role: 'member' | 'admin';
  project_ids?: string[];
}

export interface BulkInviteSucceeded {
  id: string;
  email: string;
  display_name: string;
  was_existing: boolean;
  email_sent: boolean;
  projects_added: string[];
  projects_skipped: string[];
}

export interface BulkInviteResult {
  succeeded: BulkInviteSucceeded[];
  failed: Array<{ email: string; code: string; message: string }>;
  total_requested: number;
  total_succeeded: number;
  total_failed: number;
}

/**
 * Invite a batch into a SINGLE org. The org is set via `X-Org-Id`; the
 * caller must administer it. `default_project_ids` is applied to every row
 * that doesn't carry its own `project_ids` (matches the backend convenience
 * field). Invitees land on those projects as project `member` (the invite
 * endpoint's behavior — no per-project role at invite in v1).
 */
export async function inviteBulkToOrg(
  orgId: string,
  body: { invites: BulkInviteRow[]; default_project_ids?: string[] },
): Promise<BulkInviteResult> {
  const res = await orgScopedRequest<{ data: BulkInviteResult }>(
    'POST',
    '/org/members/invite/bulk',
    orgId,
    {
      invites: body.invites,
      ...(body.default_project_ids && body.default_project_ids.length > 0
        ? { default_project_ids: body.default_project_ids }
        : {}),
    },
  );
  return res.data;
}

// ─── X-Org-Id-scoped member ops (M3 detail page) ────────────────────────────
//
// Every mutation below reuses an existing `/org/members/*` endpoint with the
// `X-Org-Id` header set to the org the action targets (plan §6 "linchpin").
// The server resolves the caller's role in THAT org and re-checks rank, so a
// single admin can act across several orgs they administer with no new
// backend. These mirror `peopleApi` (`@/lib/api/people`) one-for-one but carry
// the org scope explicitly.

export type ProjectMemberRole = 'admin' | 'member' | 'viewer';
export type ApiKeyScope = 'read' | 'read_write' | 'admin';

export interface MemberDetail {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string | null;
  role: string;
  is_active: boolean;
  disabled_at: string | null;
  disabled_by: { id: string; email: string; display_name: string } | null;
  joined_at: string;
  is_default_org: boolean;
  version: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface ProjectMembership {
  project_id: string;
  project_name: string;
  project_slug: string;
  role: ProjectMemberRole | string;
  joined_at: string;
  is_archived: boolean;
}

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

/**
 * All member ops scoped to a specific org via `X-Org-Id`. The first argument
 * of every call is the org the action is happening IN — the org whose
 * membership row the operator clicked in the detail page.
 */
export const peopleManagerApi = {
  // --- Memberships ---
  getMemberInOrg(orgId: string, userId: string): Promise<{ data: MemberDetail }> {
    return orgScopedRequest<{ data: MemberDetail }>('GET', `/org/members/${userId}`, orgId);
  },

  updateProfile(
    orgId: string,
    userId: string,
    body: { display_name?: string; timezone?: string },
  ): Promise<{ data: MemberDetail }> {
    return orgScopedRequest<{ data: MemberDetail }>(
      'PATCH',
      `/org/members/${userId}/profile`,
      orgId,
      body,
    );
  },

  /**
   * Soft-delete (tombstone) the account. The server's delete-account endpoint
   * is cross-org; `orgId` (X-Org-Id) just needs to be an org where the caller
   * has rights. Gate the UI on `caps.delete_account`, which M1 already computes
   * as full eligibility (admin in EVERY org the target belongs to, not self,
   * not a SuperUser). The server re-checks.
   */
  deleteAccount(
    orgId: string,
    userId: string,
    reason?: string,
  ): Promise<{ data: { success: boolean; id: string; previous_email: string } }> {
    return orgScopedRequest(
      'POST',
      `/org/members/${userId}/delete-account`,
      orgId,
      reason ? { reason } : {},
    );
  },

  updateRole(
    orgId: string,
    userId: string,
    role: string,
    version?: number,
  ): Promise<{ data: { membership_version: number } }> {
    return orgScopedRequest('PATCH', `/org/members/${userId}`, orgId, {
      role,
      ...(version !== undefined ? { version } : {}),
    });
  },

  setActive(
    orgId: string,
    userId: string,
    isActive: boolean,
    version?: number,
  ): Promise<{ data: { user_id: string; is_active: boolean; membership_version: number } }> {
    return orgScopedRequest('PATCH', `/org/members/${userId}/active`, orgId, {
      is_active: isActive,
      ...(version !== undefined ? { version } : {}),
    });
  },

  removeFromOrg(orgId: string, userId: string): Promise<void> {
    return orgScopedRequest<void>('DELETE', `/org/members/${userId}`, orgId);
  },

  // --- Projects ---
  listMemberProjects(orgId: string, userId: string): Promise<{ data: ProjectMembership[] }> {
    return orgScopedRequest<{ data: ProjectMembership[] }>(
      'GET',
      `/org/members/${userId}/projects`,
      orgId,
    );
  },

  addMemberToProjects(
    orgId: string,
    userId: string,
    assignments: { project_id: string; role: ProjectMemberRole }[],
  ): Promise<{ data: { added: string[]; skipped: string[] } }> {
    return orgScopedRequest('POST', `/org/members/${userId}/projects`, orgId, { assignments });
  },

  updateMemberProjectRole(
    orgId: string,
    userId: string,
    projectId: string,
    role: ProjectMemberRole,
  ): Promise<{ data: ProjectMembership }> {
    return orgScopedRequest(
      'PATCH',
      `/org/members/${userId}/projects/${projectId}`,
      orgId,
      { role },
    );
  },

  removeMemberFromProject(
    orgId: string,
    userId: string,
    projectId: string,
  ): Promise<{ data: { removed: true } }> {
    return orgScopedRequest(
      'DELETE',
      `/org/members/${userId}/projects/${projectId}`,
      orgId,
    );
  },

  // --- Access: password / sessions ---
  resetPassword(
    orgId: string,
    userId: string,
    password?: string,
  ): Promise<{ data: { user_id: string; email: string; password: string; generated: boolean } }> {
    return orgScopedRequest(
      'POST',
      `/org/members/${userId}/reset-password`,
      orgId,
      password ? { password } : {},
    );
  },

  sendResetLink(
    orgId: string,
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
    return orgScopedRequest('POST', `/org/members/${userId}/send-password-reset`, orgId);
  },

  forcePasswordChange(
    orgId: string,
    userId: string,
  ): Promise<{ data: { user_id: string; force_password_change: true } }> {
    return orgScopedRequest('POST', `/org/members/${userId}/force-password-change`, orgId);
  },

  signOutEverywhere(orgId: string, userId: string): Promise<{ data: { revoked: number } }> {
    return orgScopedRequest('POST', `/org/members/${userId}/sign-out-everywhere`, orgId);
  },

  // --- Access: API keys ---
  listApiKeys(orgId: string, userId: string): Promise<{ data: ApiKeyRecord[] }> {
    return orgScopedRequest<{ data: ApiKeyRecord[] }>(
      'GET',
      `/org/members/${userId}/api-keys`,
      orgId,
    );
  },

  createApiKey(
    orgId: string,
    userId: string,
    body: { name: string; scope: ApiKeyScope; project_ids?: string[]; expires_days?: number },
  ): Promise<{ data: ApiKeyRecord & { token: string } }> {
    return orgScopedRequest('POST', `/org/members/${userId}/api-keys`, orgId, body);
  },

  revokeApiKey(orgId: string, userId: string, keyId: string): Promise<void> {
    return orgScopedRequest<void>(
      'DELETE',
      `/org/members/${userId}/api-keys/${keyId}`,
      orgId,
    );
  },

  // --- Activity ---
  getActivity(
    orgId: string,
    userId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ data: ActivityEntry[]; next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return orgScopedRequest(
      'GET',
      `/org/members/${userId}/activity${qs ? `?${qs}` : ''}`,
      orgId,
    );
  },
};
