// Org-context resolution: which orgs an authenticated user belongs to, with which role, and
// which one the request acts in (#350).
//
// Every Fastify service used to carry its own copy of resolveOrgContext. The copies read
// organization_memberships / account_group_memberships directly, so they (1) never excluded
// soft-deleted orgs, letting a member of a deleted org keep acting in it through every
// satellite, and (2) under BBB_RLS_ENFORCE=1 read org-gated tables before any org was bound,
// saw zero rows, and silently fell back to users.org_id with role 'member'. The api had
// already fixed both (migration 0311's SECURITY DEFINER identity functions) in its own copy
// only. The rule now lives here, once, and runs against an injected store (sqlOrgContextStore)
// backed by those functions, the same driver-agnostic injection sqlApiKeyStore uses.

import { rowsOf } from './rows.js';

/** One org the user belongs to, with their org-scope role there. */
export interface OrgMembership {
  org_id: string;
  role: string;
  is_default: boolean;
}

/** A membership row in a live (not soft-deleted) org. */
export interface LiveMembershipRow {
  org_id: string;
  is_default: boolean;
  joined_at: Date;
}

/** Raised when the user has no usable org context; every service answers it with a 403. */
export class OrgMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgMembershipError';
  }
}

/** The role a membership resolves to when no org-scope group row exists for it. */
export const DEFAULT_MEMBERSHIP_ROLE = 'member';

/** The role a SuperUser holds while viewing an org they are not a native member of. */
export const SUPERUSER_VIEWING_ROLE = 'owner';

/** Identity data access a host supplies. sqlOrgContextStore() builds one from drizzle. */
export interface OrgContextStore {
  /** The user's memberships in live (not soft-deleted) orgs. */
  loadLiveMemberships(userId: string): Promise<LiveMembershipRow[]>;
  /** org_id -> legacy role for every org the user is grouped into at org scope. */
  loadOrgRoles(userId: string): Promise<Map<string, string>>;
  /** True when the org exists and is not soft-deleted. */
  isLiveOrg(orgId: string): Promise<boolean>;
}

export interface SqlOrgContextStoreDeps {
  /** The host's drizzle `sql` tag (see SqlApiKeyStoreDeps.sql). */
  // biome-ignore lint/suspicious/noExplicitAny: accepts any drizzle sql tag signature
  sql: (strings: TemplateStringsArray, ...values: any[]) => unknown;
  /** The host's `db.execute`; returns a row array or `{ rows }`. */
  execute: (query: never) => Promise<unknown>;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

/**
 * The OrgContextStore every service uses. Reads go through migration 0311's SECURITY DEFINER
 * functions: they run before the request's org is known, so under BBB_RLS_ENFORCE=1 a plain
 * read of the org-gated membership tables would return nothing (#105), and the functions are
 * where the soft-deleted-org rule (o.deleted_at IS NULL) lives.
 */
export function sqlOrgContextStore(deps: SqlOrgContextStoreDeps): OrgContextStore {
  const tag = deps.sql;
  const execute = deps.execute as (query: unknown) => Promise<unknown>;
  return {
    async loadLiveMemberships(userId) {
      const raw = await execute(tag`SELECT org_id, is_default, joined_at FROM auth_user_live_memberships(${userId}::uuid)`);
      return rowsOf(raw).map((r) => ({
        org_id: String(r.org_id),
        is_default: r.is_default === true,
        joined_at: toDate(r.joined_at),
      }));
    },
    async loadOrgRoles(userId) {
      const raw = await execute(tag`SELECT org_id, legacy_role FROM auth_user_org_roles(${userId}::uuid)`);
      const out = new Map<string, string>();
      for (const r of rowsOf(raw)) out.set(String(r.org_id), String(r.legacy_role));
      return out;
    },
    async isLiveOrg(orgId) {
      const raw = await execute(tag`SELECT auth_org_is_live(${orgId}::uuid) AS live`);
      return rowsOf(raw)[0]?.live === true;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The org a request names in its X-Org-Id header, or undefined. Malformed values are ignored
 * (not rejected), so a bad header behaves like no header.
 */
export function requestedOrgIdFromHeader(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length !== 36 || !UUID_RE.test(value)) return undefined;
  return value;
}

export interface OrgContext {
  memberships: OrgMembership[];
  activeOrgId: string;
  activeRole: string;
}

export interface ResolveOrgContextOptions {
  /**
   * The org the session last switched to (sessions.active_org_id). Preferred over the default
   * membership when it is still one of the user's live orgs. Services that apply the sticky
   * session org themselves (apps/api's resolveEffectiveOrg) leave this unset.
   */
  sessionActiveOrgId?: string | null;
  /**
   * When true, a SuperUser may act in a requested (or session) org they are not a member of,
   * with SUPERUSER_VIEWING_ROLE, provided the org is live. Off by default: a non-member org is
   * refused even for a SuperUser unless the host opts in.
   */
  superuserMayViewAnyOrg?: boolean;
}

/**
 * Resolve an authenticated user's org context.
 *
 * Precedence:
 *   1. requestedOrgId (X-Org-Id), when the user is a member of that live org. A request naming
 *      any other org is refused (OrgMembershipError), except a live org for an opted-in SuperUser.
 *   2. opts.sessionActiveOrgId, when still one of the user's live orgs (or, for an opted-in
 *      SuperUser, any live org). A stale value falls through.
 *   3. The default membership (is_default), then the earliest joined.
 *   4. users.org_id when the user has no membership rows at all, and only if that org is live.
 *
 * Memberships in soft-deleted orgs never count (auth_user_live_memberships), and the users.org_id
 * fallback is liveness-checked, so a member of a deleted org is refused rather than resolved
 * into it.
 */
export async function resolveOrgContext(
  store: OrgContextStore,
  userId: string,
  fallbackOrgId: string | null | undefined,
  requestedOrgId: string | undefined,
  opts: ResolveOrgContextOptions & { isSuperuser?: boolean } = {},
): Promise<OrgContext> {
  const [rows, rolesByOrg] = await Promise.all([store.loadLiveMemberships(userId), store.loadOrgRoles(userId)]);
  const suViewing = opts.superuserMayViewAnyOrg === true && opts.isSuperuser === true;

  if (rows.length === 0) {
    if (!fallbackOrgId) {
      throw new OrgMembershipError('User has no organization memberships and no fallback org_id');
    }
    if (!(await store.isLiveOrg(fallbackOrgId))) {
      throw new OrgMembershipError('User has no active organization memberships');
    }
    const role = rolesByOrg.get(fallbackOrgId) ?? DEFAULT_MEMBERSHIP_ROLE;
    const memberships = [{ org_id: fallbackOrgId, role, is_default: true }];
    // A user with no membership rows acts in users.org_id; a header naming another org is
    // ignored here (as it always was), except for an opted-in SuperUser viewing a live org.
    if (requestedOrgId && requestedOrgId !== fallbackOrgId && suViewing && (await store.isLiveOrg(requestedOrgId))) {
      return { memberships, activeOrgId: requestedOrgId, activeRole: SUPERUSER_VIEWING_ROLE };
    }
    return { memberships, activeOrgId: fallbackOrgId, activeRole: role };
  }

  const sorted = [...rows].sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime());
  const memberships: OrgMembership[] = sorted.map((r) => ({
    org_id: r.org_id,
    role: rolesByOrg.get(r.org_id) ?? DEFAULT_MEMBERSHIP_ROLE,
    is_default: r.is_default,
  }));

  let active: OrgMembership | undefined;
  if (requestedOrgId) {
    active = memberships.find((m) => m.org_id === requestedOrgId);
    if (!active) {
      if (suViewing && (await store.isLiveOrg(requestedOrgId))) {
        return { memberships, activeOrgId: requestedOrgId, activeRole: SUPERUSER_VIEWING_ROLE };
      }
      throw new OrgMembershipError(`User is not a member of the requested organization: ${requestedOrgId}`);
    }
  }
  if (!active && opts.sessionActiveOrgId) {
    active = memberships.find((m) => m.org_id === opts.sessionActiveOrgId);
    if (!active && suViewing && (await store.isLiveOrg(opts.sessionActiveOrgId))) {
      return { memberships, activeOrgId: opts.sessionActiveOrgId, activeRole: SUPERUSER_VIEWING_ROLE };
    }
  }
  if (!active) active = memberships.find((m) => m.is_default);
  if (!active) active = memberships[0] as OrgMembership;
  return { memberships, activeOrgId: active.org_id, activeRole: active.role };
}
