/**
 * Helpers for interpreting a bureau floor's layout JSONB.
 */

/**
 * Zone ids defined in a floor's layout JSONB, or null when the floor has
 * no drawn zones yet (empty/bootstrap layout). Rooms whose zone_id is not
 * a layout zone never render in the floor editor — they exist on the
 * member floor list but cannot be selected, moved, or archived from the
 * canvas (the "invisible test rooms" incident, 2026-06-10). Room
 * create/update therefore reject unknown zone ids whenever the floor
 * actually has zones; zoneless floors skip the check so API-first
 * bootstrap flows still work.
 */
export function layoutZoneIds(layout: unknown): Set<string> | null {
  const zones = (layout as { zones?: unknown } | null)?.zones;
  if (!Array.isArray(zones) || zones.length === 0) return null;
  const ids = zones
    .map((zone) => (zone as { id?: unknown } | null)?.id)
    .filter((zid): zid is string => typeof zid === 'string' && zid.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}
