/**
 * Pure org-context resolution for the auth plugin.
 *
 * Extracted from `buildAuthUser` so the precedence rules are unit-testable in
 * isolation (no DB / env / redis import side effects). See
 * `apps/api/test/auth-org-precedence.test.ts`.
 *
 * Given the already-resolved candidates, decide the request's effective org +
 * role + the SuperUser-viewing banner flag. Precedence, highest first:
 *
 *   1. **API-key org pin** (`keyScopedOrgId`) — a non-SuperUser API key is
 *      bound to one org; that org is authoritative.
 *   2. **Explicit `X-Org-Id` header** (`requestedOrgId` set) — a deliberate
 *      per-request override. `resolveOrgContext` has already validated
 *      membership and folded the header into `activeOrgId`, so honoring
 *      `activeOrgId` here is correct, and we must NOT let the sticky session
 *      org clobber it (regression: People Manager multi-org requests; commit
 *      e6c9b731).
 *   3. **Sticky session `active_org_id`** (`sessionActiveOrgId`, set by
 *      `/auth/switch-org` or `/superuser/context/switch`) — honored only when
 *      no explicit header was sent. Regular users: only if still a member of
 *      that org. SuperUsers: any org (cross-org viewing), with the banner flag
 *      set when they aren't a native member.
 *   4. **Membership-resolved default** (`activeOrgId`).
 */

export interface OrgMembershipLike {
  org_id: string;
  role: string;
}

export interface ResolveEffectiveOrgInput {
  /** Non-null only for non-SuperUser API-key auth (pins the org). */
  keyScopedOrgId: string | null;
  keyScopedRole: string | null;
  /** From resolveOrgContext: the membership-resolved (or header-resolved) org. */
  activeOrgId: string;
  activeRole: string;
  /** The validated `X-Org-Id` header value, or undefined when none was sent. */
  requestedOrgId: string | undefined;
  /** The session's persisted active org, or null. */
  sessionActiveOrgId: string | null;
  memberships: OrgMembershipLike[];
  isSuperuser: boolean;
}

export interface ResolveEffectiveOrgResult {
  orgId: string;
  role: string;
  isSuperuserViewing: boolean;
}

export function resolveEffectiveOrg(opts: ResolveEffectiveOrgInput): ResolveEffectiveOrgResult {
  const {
    keyScopedOrgId,
    keyScopedRole,
    activeOrgId,
    activeRole,
    requestedOrgId,
    sessionActiveOrgId,
    memberships,
    isSuperuser,
  } = opts;

  let orgId = keyScopedOrgId ?? activeOrgId;
  let role = keyScopedRole ?? activeRole;
  let isSuperuserViewing = false;

  // An explicit X-Org-Id header is the highest-priority per-request override
  // (after a key pin) and must beat the sticky session org.
  const explicitOrgHeader = requestedOrgId !== undefined;
  if (!explicitOrgHeader && sessionActiveOrgId && sessionActiveOrgId !== activeOrgId) {
    const existingMembership = memberships.find((m) => m.org_id === sessionActiveOrgId);
    if (isSuperuser) {
      orgId = sessionActiveOrgId;
      role = existingMembership?.role ?? 'owner';
      // Only light the cross-org banner when the SU is viewing an org they are
      // NOT a native member of — normal multi-org members who use the switcher
      // shouldn't see the "viewing as SuperUser" banner.
      isSuperuserViewing = !existingMembership;
    } else if (existingMembership) {
      orgId = sessionActiveOrgId;
      role = existingMembership.role;
    }
    // non-SU with no matching membership: leave orgId on the default.
  }

  return { orgId, role, isSuperuserViewing };
}
