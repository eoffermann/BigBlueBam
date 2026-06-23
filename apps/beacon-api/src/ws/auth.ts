import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconEntries, projectMemberships } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// WebSocket-specific beacon access checker (Beacon T4 co-editing)
//
// The HTTP middleware (middleware/authorize.ts) couples tightly to
// FastifyRequest/Reply. This module provides the same access logic but returns a
// plain object so the WS handler can call it without fabricating a request
// envelope. Mirrors the shape of apps/brief-api/src/ws/auth.ts.
//
// Read (hasAccess) — derived from requireBeaconReadAccess:
//   - SuperUser: always.
//   - Org isolation: beacon must belong to the user's org.
//   - Public / Organization visibility: any org member.
//   - Project visibility: owner/creator, or a member of the beacon's project.
//   - Private visibility: owner/creator only.
//
// Edit (canEdit) — derived from requireBeaconEditAccess:
//   - SuperUser: always.
//   - Admin / Owner org role: any beacon in their org (project-scoped beacons
//     still require the editor to be a project member OR the owner/creator,
//     matching the middleware's project-membership gate).
//   - Member: only beacons they own (owned_by) or created (created_by).
// ---------------------------------------------------------------------------

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

export interface WsAccessResult {
  hasAccess: boolean;
  canEdit: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Determines whether the given user can connect to a beacon's collaboration
 * room and whether they have edit permissions.
 */
export async function checkBeaconAccessForWs(
  beaconIdOrSlug: string,
  userId: string,
  orgId: string,
  userRole: string,
  isSuperuser: boolean,
): Promise<WsAccessResult> {
  const deny: WsAccessResult = { hasAccess: false, canEdit: false };

  const isUuid = UUID_REGEX.test(beaconIdOrSlug);
  const condition = isUuid
    ? eq(beaconEntries.id, beaconIdOrSlug)
    : eq(beaconEntries.slug, beaconIdOrSlug);

  const [beacon] = await db
    .select({
      id: beaconEntries.id,
      organization_id: beaconEntries.organization_id,
      project_id: beaconEntries.project_id,
      visibility: beaconEntries.visibility,
      owned_by: beaconEntries.owned_by,
      created_by: beaconEntries.created_by,
    })
    .from(beaconEntries)
    .where(condition)
    .limit(1);

  if (!beacon) return deny;

  // Org isolation
  if (beacon.organization_id !== orgId && !isSuperuser) return deny;

  // SuperUsers always have full access
  if (isSuperuser) return { hasAccess: true, canEdit: true };

  const isOwnerOrCreator = beacon.owned_by === userId || beacon.created_by === userId;

  // Resolve project membership once if the beacon is project-scoped.
  let isProjectMember = false;
  if (beacon.project_id) {
    const [membership] = await db
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.project_id, beacon.project_id),
          eq(projectMemberships.user_id, userId),
        ),
      )
      .limit(1);
    isProjectMember = Boolean(membership);
  }

  // ---- READ gate (requireBeaconReadAccess) ----
  let hasAccess = false;
  switch (beacon.visibility) {
    case 'Public':
    case 'Organization':
      // Any org member (org already verified above).
      hasAccess = true;
      break;
    case 'Project':
      hasAccess = isOwnerOrCreator || (beacon.project_id ? isProjectMember : true);
      break;
    case 'Private':
      hasAccess = isOwnerOrCreator;
      break;
    default:
      hasAccess = false;
  }

  if (!hasAccess) return deny;

  // ---- EDIT gate (requireBeaconEditAccess) ----
  // For project-scoped beacons, the middleware first requires the editor to be
  // the owner/creator OR a project member; non-members can never edit even with
  // an admin/owner org role.
  if (beacon.project_id && !isOwnerOrCreator && !isProjectMember) {
    return { hasAccess: true, canEdit: false };
  }

  // Admin / Owner org role can edit any beacon in their org.
  if (roleLevel(userRole) >= roleLevel('admin')) {
    return { hasAccess: true, canEdit: true };
  }

  // Member can only edit beacons they own or created.
  if (isOwnerOrCreator) {
    return { hasAccess: true, canEdit: true };
  }

  return { hasAccess: true, canEdit: false };
}
