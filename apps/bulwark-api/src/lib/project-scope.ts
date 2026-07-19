import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { projectMemberships } from '../db/schema/index.js';
import { isAdminViewer, type Viewer } from '../services/types.js';

// Project-membership scoping for Bulwark reads AND writes (spec 2.5 SH1/SH3/SK3).
//
// Obligations/deadlines/waivers/contracts are project-scoped: a caller may read or mutate a
// contract's ledger only when they are a member of the owning project, with an org-admin
// override. The SAME predicate is applied on both the read query builder and the mutating
// guard so they can never disagree (SH1). A contract with a NULL project_id has no project
// to be a member of, so it falls back to an org-membership check (SK3): every caller
// authenticated in the org passes, which keeps the manual-trigger safety net usable by
// ordinary members. This is deliberately NOT owner/admin-only.

// The project ids the viewer is a direct member of (cached per request would be nicer, but
// the call is a single indexed lookup).
export async function memberProjectIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  return rows.map((r) => r.project_id);
}

// A Drizzle WHERE predicate that restricts a project_id column to the rows the viewer may
// see: everything for an admin, else (project_id IN memberProjects OR project_id IS NULL).
// The NULL branch is the SK3 org-membership fallback (org-scoping is enforced separately by
// the surrounding organization_id equality). Returns undefined for admins (no restriction).
export async function projectScopePredicate(
  viewer: Viewer,
  projectIdColumn: PgColumn,
): Promise<SQL | undefined> {
  if (isAdminViewer(viewer)) return undefined;
  const ids = await memberProjectIds(viewer.id);
  if (ids.length === 0) return isNull(projectIdColumn);
  return or(inArray(projectIdColumn, ids), isNull(projectIdColumn));
}

// Combine an org filter with the project-scope predicate for a list query.
export async function orgAndProjectScope(
  viewer: Viewer,
  orgIdColumn: PgColumn,
  projectIdColumn: PgColumn,
): Promise<SQL | undefined> {
  const orgPred = eq(orgIdColumn, viewer.org_id);
  const scope = await projectScopePredicate(viewer, projectIdColumn);
  return scope ? and(orgPred, scope) : orgPred;
}

// The write/detail guard: may this viewer act on a contract with this project_id? Admins
// pass unconditionally; a null project_id passes via the org-membership fallback (SK3, the
// caller has already been org-scoped); otherwise the viewer must be a project member.
export async function canAccessContractProject(
  viewer: Viewer,
  projectId: string | null,
): Promise<boolean> {
  if (isAdminViewer(viewer)) return true;
  if (projectId === null) return true; // SK3 org-membership fallback
  const [row] = await db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.project_id, projectId),
        eq(projectMemberships.user_id, viewer.id),
      ),
    )
    .limit(1);
  return !!row;
}
