// ---------------------------------------------------------------------------
// One rule for turning a caller-supplied "id or slug" into a beacon_entries
// predicate (issue #246, BCN-1).
//
// Slugs are unique per organization (beacon_entries_org_slug_key on
// (organization_id, slug), migration 0289), not globally. Two orgs may hold the
// same slug, so an unscoped `slug = $1 LIMIT 1` can pick another tenant's row:
// the caller's org check then 404s a beacon they own, or (in a write path)
// touches the wrong tenant. Every slug lookup goes through this helper.
//
// UUIDs are globally unique, so an id lookup stays unscoped here and the
// caller's own org check still gates it. SuperUsers may read across orgs, so
// their slug lookup is not narrowed to one org; it prefers their own org's row
// so the result is deterministic when several orgs share the slug.
// ---------------------------------------------------------------------------

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { beaconEntries } from '../db/schema/index.js';

export const BEACON_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBeaconUuid(idOrSlug: string): boolean {
  return BEACON_UUID_REGEX.test(idOrSlug);
}

export interface BeaconRefLookup {
  where: SQL;
  /** ORDER BY that puts the caller's own org first. Harmless for id lookups. */
  orderBy: SQL;
}

export function beaconRefLookup(
  idOrSlug: string,
  orgId: string,
  isSuperuser = false,
): BeaconRefLookup {
  const orderBy = sql`(${beaconEntries.organization_id} = ${orgId}) DESC`;
  if (isBeaconUuid(idOrSlug)) {
    return { where: eq(beaconEntries.id, idOrSlug), orderBy };
  }
  if (isSuperuser) {
    return { where: eq(beaconEntries.slug, idOrSlug), orderBy };
  }
  return {
    where: and(eq(beaconEntries.slug, idOrSlug), eq(beaconEntries.organization_id, orgId)) as SQL,
    orderBy,
  };
}
