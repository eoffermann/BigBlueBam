// Burn's project predicate. Spec 2.4 point 6 (round-2 R2-S6).
//
// ── WHY THIS IS A DISTINCT IMPLEMENTATION AND NOT A PORT ─────────────────────────────
//
// apps/bulwark-api/src/lib/project-scope.ts operates on a single nullable `project_id`
// column, and its documented SK3 fallback is that a NULL project passes for EVERY org
// member. That is correct for Bulwark: a contract with no project has no project to be a
// member of, and the manual-trigger safety net has to stay reachable.
//
// Burn engagements HAVE NO project_id COLUMN AT ALL. They reach projects through the
// burn_engagement_projects join table, and spec 3.1 defines a zero-project chain as
// `read_all`-only. Ported literally, Bulwark's null fallback would turn "this chain is
// linked to no project" into "every org member can read this chain", inverting the D4 fix
// and making the most sensitive chains (the ones nobody has scoped yet) the most visible.
//
// So: THERE IS NO NULL OR EMPTY FALLBACK HERE. A chain with zero linked projects is
// reachable only by an org admin / read_all holder, by construction:
//
//   EXISTS (SELECT 1 FROM burn_engagement_projects ep
//           JOIN project_memberships pm ON pm.project_id = ep.project_id
//           WHERE ep.engagement_id = :engagement AND pm.user_id = :viewer)
//
// ── THE SECOND HALF, WHICH IS EASY TO MISS ──────────────────────────────────────────
//
// Work-item and attribution rows are scoped by THE ROW'S OWN project_id, not by chain
// reachability. In a multi-project chain, a member of the low-sensitivity project must not
// read items sourced from the project they are not in; chain reachability would grant
// exactly that. Two different predicates, two different functions, both exported here so
// neither route can quietly pick the wrong one.

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { burnEngagementProjects, projectMemberships } from '../db/schema/index.js';
import { isAdminViewer, type Viewer } from '../services/types.js';
import { ProjectScopeError } from './errors.js';

/** The project ids the viewer is a direct member of. One indexed lookup. */
export async function memberProjectIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(eq(projectMemberships.user_id, userId));
  return rows.map((r) => r.project_id);
}

/**
 * A WHERE predicate restricting an ENGAGEMENT id column to chains the viewer can reach
 * through at least one linked project. Returns undefined for an admin (no restriction).
 *
 * Note the shape: an EXISTS correlated subquery, not an IN list, so a firm with thousands
 * of chains does not materialize a giant id array per request, and so the zero-project case
 * falls out naturally as "no row satisfies EXISTS" rather than as an explicit branch an
 * implementer could later "fix" into a null fallback.
 */
export function engagementScopePredicate(
  viewer: Viewer,
  engagementIdColumn: PgColumn,
): SQL | undefined {
  if (isAdminViewer(viewer)) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM ${burnEngagementProjects} ep
    JOIN ${projectMemberships} pm ON pm.project_id = ep.project_id
    WHERE ep.engagement_id = ${engagementIdColumn} AND pm.user_id = ${viewer.id}
  )`;
}

/**
 * A WHERE predicate restricting a ROW-LEVEL project_id column (work items, attributions,
 * prechecks) to the viewer's own projects.
 *
 * A NULL project_id does NOT pass. A work item with no project is, by definition, work that
 * is not inside any project the viewer could be a member of; letting it through would leak
 * the "outside any tracked contract" bucket org-wide, which is precisely the bucket most
 * likely to contain unsold work against a client the viewer has no business seeing.
 */
export function rowProjectScopePredicate(
  viewer: Viewer,
  projectIdColumn: PgColumn,
  memberProjects: string[],
): SQL | undefined {
  if (isAdminViewer(viewer)) return undefined;
  if (memberProjects.length === 0) {
    // No projects, no rows. `FALSE` rather than IS NULL: see the doc comment above.
    return sql`false`;
  }
  return inArray(projectIdColumn, memberProjects);
}

/** Combine an org equality filter with an engagement-reachability predicate. */
export function orgAndEngagementScope(
  viewer: Viewer,
  orgIdColumn: PgColumn,
  engagementIdColumn: PgColumn,
): SQL | undefined {
  const orgPred = eq(orgIdColumn, viewer.org_id);
  const scope = engagementScopePredicate(viewer, engagementIdColumn);
  return scope ? and(orgPred, scope) : orgPred;
}

/**
 * The write/detail guard: may this viewer act on this engagement?
 *
 * Admins pass. Everyone else must be a member of at least one LINKED project. A chain with
 * zero links fails for every non-admin, with no exception path.
 */
export async function canAccessEngagement(viewer: Viewer, engagementId: string): Promise<boolean> {
  if (isAdminViewer(viewer)) return true;
  const [row] = await db
    .select({ id: burnEngagementProjects.id })
    .from(burnEngagementProjects)
    .innerJoin(
      projectMemberships,
      eq(projectMemberships.project_id, burnEngagementProjects.project_id),
    )
    .where(
      and(
        eq(burnEngagementProjects.engagement_id, engagementId),
        eq(projectMemberships.user_id, viewer.id),
      ),
    )
    .limit(1);
  return !!row;
}

/** Throwing form of canAccessEngagement. */
export async function assertEngagementAccess(viewer: Viewer, engagementId: string): Promise<void> {
  if (!(await canAccessEngagement(viewer, engagementId))) {
    throw new ProjectScopeError();
  }
}

/** The write guard for a row that carries its own project_id (work item, precheck). */
export async function canAccessRowProject(
  viewer: Viewer,
  projectId: string | null,
): Promise<boolean> {
  if (isAdminViewer(viewer)) return true;
  if (!projectId) return false; // no null fallback; see the header comment
  const [row] = await db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.project_id, projectId), eq(projectMemberships.user_id, viewer.id)),
    )
    .limit(1);
  return !!row;
}
