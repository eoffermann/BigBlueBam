/**
 * People Manager v2 — scoped, permission-graded, multi-org people list
 * (plan §6, milestone M1).
 *
 * `listScopedPeople` returns the people a caller is allowed to see — the
 * union of members across every org the caller belongs to — and attaches,
 * per (person, org), a set of capability flags computed server-side from
 * the caller's role IN THAT org plus `checkRankAbove`. SuperUsers see every
 * non-deleted org.
 *
 * SECURITY INVARIANT (the highest-risk part of M1): a caller must NEVER see
 * a person who shares no org with them. The org set is derived strictly from
 * `caller.orgMemberships` (or, for SuperUsers, all non-deleted orgs) and the
 * person list is the union of members of exactly those orgs. There is no
 * code path that reaches a person outside that union.
 *
 * The capability flags are advisory hints for the UI; every mutation
 * re-checks server-side via the existing /org/members/* endpoints (defense
 * in depth — see plan §9).
 *
 * Testability: the orchestration (visibility union, dedup, caps, filters,
 * sort, cursor pagination) is pure given a small data-access surface
 * (`PeopleDataAccess`). The default surface is DB-backed; tests inject a
 * fake so the scoping/caps logic can be exercised without a live database.
 */

import { eq, isNull, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { listOrgMembers, checkRankAbove } from './org.service.js';
import { listOrgsAdministeredBy, listOrgsUserBelongsTo } from './user-deletion.service.js';

/** Roles that confer org-admin authority (rank ≥ admin). */
const ADMIN_ROLES = new Set(['admin', 'owner']);

export interface PeopleCaller {
  id: string;
  isSuperuser: boolean;
  /** The caller's membership + per-org role for EVERY org they belong to.
   *  This is exactly `request.user.org_memberships` from the auth plugin. */
  orgMemberships: { org_id: string; role: string }[];
}

export interface ListScopedPeopleOptions {
  search?: string;
  isActive?: boolean;
  /** Filter to people who hold this role in at least one in-scope org. */
  role?: string;
  /** Restrict the scan to a single org (must be one the caller can see). */
  orgId?: string;
  cursor?: string;
  /** Default 50, hard max 200. */
  limit?: number;
}

/** Per-(person, org) capability flags. See plan §5/§6 for the rules. */
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

export interface PersonUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  last_seen_at: string | null;
}

export interface ScopedPerson {
  user: PersonUser;
  memberships: PersonMembership[];
}

export interface ListScopedPeopleResult {
  data: ScopedPerson[];
  next_cursor: string | null;
}

/** A single org's roster as consumed by the orchestration. */
export interface OrgRosterMember {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  last_seen_at: Date | string | null;
  /** The member's resolved role in this org. */
  role: string;
}

/**
 * Injectable data-access surface so `listScopedPeople` is unit-testable
 * without a live DB. The default implementation (`defaultPeopleDataAccess`)
 * delegates to the existing org/user services.
 */
export interface PeopleDataAccess {
  /** All non-deleted org ids (SuperUser scope). */
  listAllOrgIds(): Promise<string[]>;
  /** org_id → display name, for the orgs passed in. */
  getOrgNames(orgIds: string[]): Promise<Map<string, string>>;
  /** The members (with per-org role) of a single org. */
  listOrgMembers(orgId: string): Promise<OrgRosterMember[]>;
  /** Every org_id the target user belongs to (for delete_account eligibility). */
  listOrgsUserBelongsTo(userId: string): Promise<string[]>;
  /** Whether the target user is a SuperUser (delete_account guard). */
  isSuperuser(userId: string): Promise<boolean>;
}

export const defaultPeopleDataAccess: PeopleDataAccess = {
  async listAllOrgIds() {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(isNull(organizations.deleted_at));
    return rows.map((r) => r.id);
  },
  async getOrgNames(orgIds) {
    const out = new Map<string, string>();
    if (orgIds.length === 0) return out;
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));
    for (const r of rows) out.set(r.id, r.name);
    return out;
  },
  async listOrgMembers(orgId) {
    // listOrgMembers already resolves each member's per-org role and the
    // identity columns we need.
    const rows = await listOrgMembers(orgId);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      is_active: r.is_active,
      last_seen_at: r.last_seen_at,
      role: r.role,
    }));
  },
  listOrgsUserBelongsTo,
  async isSuperuser(userId) {
    const [row] = await db
      .select({ is_superuser: users.is_superuser })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(row?.is_superuser);
  },
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Opaque cursor: base64url of the last emitted sort key (`display|email|id`). */
interface PeopleCursor {
  display_name: string;
  email: string;
  id: string;
}

function encodeCursor(c: PeopleCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): PeopleCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PeopleCursor>;
    if (
      typeof parsed.display_name === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return { display_name: parsed.display_name, email: parsed.email, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Stable sort key for a person: display_name (folded), then email, then id. */
function sortKey(p: { display_name: string; email: string; id: string }): PeopleCursor {
  return {
    display_name: (p.display_name ?? '').toLowerCase(),
    email: (p.email ?? '').toLowerCase(),
    id: p.id,
  };
}

function compareKey(a: PeopleCursor, b: PeopleCursor): number {
  if (a.display_name !== b.display_name) return a.display_name < b.display_name ? -1 : 1;
  if (a.email !== b.email) return a.email < b.email ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Compute the per-(person, org) capability flags from the caller's role in
 * that org. Pure — no I/O. `deleteAccount` is decided separately (it needs
 * the target's full org set) and folded in by the caller.
 */
export function computeOrgCaps(opts: {
  callerRoleInOrg: string | undefined;
  targetRoleInOrg: string;
  callerIsSuperuser: boolean;
  isSelf: boolean;
  callerIsOwnerOfOrg: boolean;
}): Omit<PersonOrgCaps, 'delete_account'> {
  const { callerRoleInOrg, targetRoleInOrg, callerIsSuperuser, isSelf, callerIsOwnerOfOrg } = opts;

  // checkRankAbove already encodes "caller must be admin/owner AND strictly
  // outrank the target" (SU bypasses). For a SuperUser, callerRoleInOrg may
  // be undefined (they need not be a member) — checkRankAbove short-circuits
  // to allowed for SUs regardless.
  const outranks = checkRankAbove(
    callerRoleInOrg ?? '',
    targetRoleInOrg,
    callerIsSuperuser,
  ).allowed;

  const callerIsAdminOfOrg =
    callerIsSuperuser || (callerRoleInOrg !== undefined && ADMIN_ROLES.has(callerRoleInOrg));
  const callerIsOwner = callerIsSuperuser || callerIsOwnerOfOrg;

  return {
    // Role change: must strictly outrank.
    manage_role: outranks,
    // Disable / remove / reset-password: outrank AND not self.
    disable: outranks && !isSelf,
    remove: outranks && !isSelf,
    reset_password: outranks && !isSelf,
    // Projects / keys: admin/owner of the org (no strict-outrank for projects).
    // Admin-scope keys remain owner-only at the route; the flag here only
    // signals "can manage this member's keys at all".
    manage_projects: callerIsAdminOfOrg,
    manage_keys: callerIsAdminOfOrg,
    // Transfer ownership: owner (or SU), not self, target isn't already owner.
    transfer_ownership: callerIsOwner && !isSelf && targetRoleInOrg !== 'owner',
  };
}

/**
 * Resolve the scoped, permission-graded, deduped people list for a caller.
 */
export async function listScopedPeople(
  caller: PeopleCaller,
  opts: ListScopedPeopleOptions = {},
  dataAccess: PeopleDataAccess = defaultPeopleDataAccess,
): Promise<ListScopedPeopleResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // 1. Resolve the caller's visible org set. SuperUser → every non-deleted
  //    org; everyone else → strictly the orgs they belong to. This union is
  //    the ONLY source of people, so a caller can never see someone outside
  //    their orgs.
  const callerRoleByOrg = new Map<string, string>();
  for (const m of caller.orgMemberships) callerRoleByOrg.set(m.org_id, m.role);

  let visibleOrgIds: string[];
  if (caller.isSuperuser) {
    visibleOrgIds = await dataAccess.listAllOrgIds();
  } else {
    visibleOrgIds = caller.orgMemberships.map((m) => m.org_id);
  }

  // Optional single-org filter — but ONLY if it's an org the caller can see.
  if (opts.orgId) {
    visibleOrgIds = visibleOrgIds.filter((id) => id === opts.orgId);
  }
  // Dedup org ids.
  visibleOrgIds = Array.from(new Set(visibleOrgIds));

  if (visibleOrgIds.length === 0) {
    return { data: [], next_cursor: null };
  }

  const orgNames = await dataAccess.getOrgNames(visibleOrgIds);

  // 2. List members of each in-scope org and group by person. We also track
  //    each person's role per org so we can compute caps + apply the role
  //    filter.
  interface Accum {
    user: PersonUser;
    // org_id → role in that org (within the caller's visible scope)
    rolesByOrg: Map<string, string>;
  }
  const byUser = new Map<string, Accum>();

  for (const orgId of visibleOrgIds) {
    const members = await dataAccess.listOrgMembers(orgId);
    for (const m of members) {
      let acc = byUser.get(m.id);
      if (!acc) {
        acc = {
          user: {
            id: m.id,
            email: m.email,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            is_active: m.is_active,
            last_seen_at:
              m.last_seen_at instanceof Date
                ? m.last_seen_at.toISOString()
                : (m.last_seen_at ?? null),
          },
          rolesByOrg: new Map(),
        };
        byUser.set(m.id, acc);
      }
      acc.rolesByOrg.set(orgId, m.role);
    }
  }

  // 3. Apply person-level filters (search, is_active, role) before we do the
  //    (potentially expensive) delete_account eligibility probe.
  const search = opts.search?.trim().toLowerCase();
  const roleFilter = opts.role;
  let people = Array.from(byUser.values()).filter((acc) => {
    if (typeof opts.isActive === 'boolean' && acc.user.is_active !== opts.isActive) {
      return false;
    }
    if (search) {
      const hay = `${acc.user.email} ${acc.user.display_name}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (roleFilter) {
      let hasRole = false;
      for (const role of acc.rolesByOrg.values()) {
        if (role === roleFilter) {
          hasRole = true;
          break;
        }
      }
      if (!hasRole) return false;
    }
    return true;
  });

  // 4. Sort by the stable key (display_name, email, id).
  people.sort((a, b) => compareKey(sortKey(a.user), sortKey(b.user)));

  // 5. Cursor pagination: drop everything at or before the cursor key.
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    people = people.filter((p) => compareKey(sortKey(p.user), cursor) > 0);
  }

  const pageHasMore = people.length > limit;
  const page = pageHasMore ? people.slice(0, limit) : people;

  // 6. For the page, compute delete_account eligibility. This is the only
  //    cap that needs the target's FULL org set (not just the caller's
  //    visible scope), so it's resolved per-person via the existing helper
  //    semantics: caller must administer EVERY org the target belongs to
  //    (SU bypasses; never self; never a SuperUser target).
  const callerAdminOrgs = caller.isSuperuser
    ? null
    : new Set(
        caller.orgMemberships
          .filter((m) => ADMIN_ROLES.has(m.role))
          .map((m) => m.org_id),
      );

  const data: ScopedPerson[] = [];
  for (const acc of page) {
    const isSelf = acc.user.id === caller.id;

    // delete_account eligibility.
    let deleteAccount = false;
    if (!isSelf) {
      const targetIsSuperuser = await dataAccess.isSuperuser(acc.user.id);
      if (!targetIsSuperuser) {
        if (caller.isSuperuser) {
          deleteAccount = true;
        } else if (callerAdminOrgs) {
          const targetOrgs = await dataAccess.listOrgsUserBelongsTo(acc.user.id);
          deleteAccount =
            targetOrgs.length > 0 &&
            targetOrgs.every((orgId) => callerAdminOrgs.has(orgId));
        }
      }
    }

    const memberships: PersonMembership[] = [];
    // Emit one membership row per org IN the caller's visible scope, sorted
    // by org name for stable output.
    const orgIds = Array.from(acc.rolesByOrg.keys()).sort((a, b) =>
      (orgNames.get(a) ?? '').localeCompare(orgNames.get(b) ?? ''),
    );
    for (const orgId of orgIds) {
      // orgId comes from acc.rolesByOrg's own keys, so the role is always
      // present; default-guard to satisfy the no-non-null-assertion rule.
      const targetRoleInOrg = acc.rolesByOrg.get(orgId) ?? 'member';
      const callerRoleInOrg = callerRoleByOrg.get(orgId);
      const callerIsOwnerOfOrg = callerRoleInOrg === 'owner';
      const baseCaps = computeOrgCaps({
        callerRoleInOrg,
        targetRoleInOrg,
        callerIsSuperuser: caller.isSuperuser,
        isSelf,
        callerIsOwnerOfOrg,
      });
      memberships.push({
        org_id: orgId,
        org_name: orgNames.get(orgId) ?? '',
        role: targetRoleInOrg,
        caps: { ...baseCaps, delete_account: deleteAccount },
      });
    }

    data.push({ user: acc.user, memberships });
  }

  const lastOnPage = page.length > 0 ? page[page.length - 1] : undefined;
  const next_cursor =
    pageHasMore && lastOnPage ? encodeCursor(sortKey(lastOnPage.user)) : null;

  return { data, next_cursor };
}

// Re-export for callers/tests that want the admin-org helper alongside the
// service (keeps the delete_account rule co-located with its source).
export { listOrgsAdministeredBy };
