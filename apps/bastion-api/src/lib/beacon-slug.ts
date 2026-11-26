// A pasted Beacon link names the article by its slug (/beacon/<slug>), the address Beacon itself
// navigates to (#232, #239). Resolve it to the article id in this org; the caller then runs the
// same can_access and sharing checks it runs for an id, so a slug opens nothing an id would not.

import type { Tx } from '../engine/context.js';

/** The id of the org's Beacon article with this slug, or null (no such article here). */
export async function beaconEntryIdBySlug(tx: Tx, orgId: string, slug: string): Promise<string | null> {
  const r = await tx`SELECT id FROM beacon_entries WHERE organization_id = ${orgId} AND slug = ${slug} LIMIT 1`;
  return r[0] ? String(r[0].id) : null;
}
