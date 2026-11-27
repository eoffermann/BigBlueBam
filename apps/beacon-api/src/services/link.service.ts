import { eq, and, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconLinks, beaconEntries } from '../db/schema/index.js';
import { resolveBeaconAccess, type BeaconAccessSubject } from '../lib/beacon-access.js';
import { BeaconError } from './beacon.service.js';

/**
 * Link two beacons. The route has already applied the edit rule to the source
 * (requireBeaconEditAccess). The target must be one the caller can read
 * (lib/beacon-access.ts, #299): linking to a row you cannot see would both
 * confirm that its id exists and publish the link on the source's link list.
 * A missing, foreign-org or unreadable target is the same 404.
 *
 * Returns null only when the identical link already exists.
 */
export async function createLink(
  sourceId: string,
  targetId: string,
  linkType: 'RelatedTo' | 'Supersedes' | 'DependsOn' | 'ConflictsWith' | 'SeeAlso',
  actor: BeaconAccessSubject,
) {
  const [source] = await db
    .select({ org: beaconEntries.organization_id })
    .from(beaconEntries)
    .where(eq(beaconEntries.id, sourceId))
    .limit(1);
  const [target] = await db
    .select()
    .from(beaconEntries)
    .where(eq(beaconEntries.id, targetId))
    .limit(1);

  if (!source || source.org !== actor.org_id) {
    throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);
  }
  if (
    !target ||
    target.organization_id !== actor.org_id ||
    (await resolveBeaconAccess(actor, target)) === 'none'
  ) {
    throw new BeaconError('NOT_FOUND', 'Target beacon not found', 404);
  }

  const [link] = await db
    .insert(beaconLinks)
    .values({
      source_id: sourceId,
      target_id: targetId,
      link_type: linkType,
      created_by: actor.id,
    })
    .onConflictDoNothing({
      target: [beaconLinks.source_id, beaconLinks.target_id, beaconLinks.link_type],
    })
    .returning();

  return link ?? null;
}

export async function removeLink(linkId: string, beaconId: string) {
  const [deleted] = await db
    .delete(beaconLinks)
    .where(
      and(
        eq(beaconLinks.id, linkId),
        or(eq(beaconLinks.source_id, beaconId), eq(beaconLinks.target_id, beaconId)),
      ),
    )
    .returning();

  return deleted ?? null;
}

/**
 * Get all links for a beacon (both as source and target).
 */
export async function getLinks(beaconId: string) {
  const links = await db
    .select()
    .from(beaconLinks)
    .where(
      or(
        eq(beaconLinks.source_id, beaconId),
        eq(beaconLinks.target_id, beaconId),
      ),
    );

  return links;
}
