import { db } from '../db/index.js';
import { beaconEntries } from '../db/schema/index.js';
import { beaconRefLookup } from '../lib/beacon-ref.js';
import { resolveBeaconAccess } from '../lib/beacon-access.js';

// ---------------------------------------------------------------------------
// WebSocket-specific beacon access checker (Beacon T4 co-editing)
//
// The HTTP middleware couples to FastifyRequest/Reply; this returns a plain
// object so the WS handler can call it without fabricating a request envelope.
// The rule itself is lib/beacon-access.ts (#299), the same one the HTTP guards
// and the slug upsert apply: hasAccess is "can read", canEdit is "can edit".
// ---------------------------------------------------------------------------

export interface WsAccessResult {
  hasAccess: boolean;
  canEdit: boolean;
}

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
  // Slugs are unique per org (#246); see lib/beacon-ref.ts.
  const lookup = beaconRefLookup(beaconIdOrSlug, orgId, isSuperuser);

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
    .where(lookup.where)
    .orderBy(lookup.orderBy)
    .limit(1);

  if (!beacon) return { hasAccess: false, canEdit: false };

  const level = await resolveBeaconAccess(
    { id: userId, org_id: orgId, role: userRole, is_superuser: isSuperuser },
    beacon,
  );
  return { hasAccess: level !== 'none', canEdit: level === 'edit' };
}
