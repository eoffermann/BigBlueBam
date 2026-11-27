// Bin asset ownership check, the write-time half of Bay's org gate on Bin
// bytes.
//
// Bay stores a pointer (bin_asset_id) into Bin's bin_assets table and later
// streams those bytes itself, including on the anonymous public review
// surface. The pointer arrives from the client (POST /review/resolve, POST
// /assets/:id/versions). Bay checked that the Bay asset was in the caller's
// org but never that the Bin asset was, so a caller could link a Bay asset in
// their own org to another org's Bin asset and mint a public link that
// streamed it. lib/bin-media.ts scopes the read to the link's org as well,
// which also makes any pointer written before this check inert.
//
// Bay reads bin_assets with raw SQL on the shared database (no Drizzle schema
// for Bin's tables, no bin-api HTTP hop), so this is a local query.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * True when binAssetId exists and belongs to orgId. A missing row and a
 * foreign row look the same, so this cannot probe other orgs' asset ids.
 */
export async function binAssetBelongsToOrg(binAssetId: string, orgId: string): Promise<boolean> {
  const raw = await db.execute(sql`
    SELECT 1 AS ok FROM bin_assets
    WHERE id = ${binAssetId} AND org_id = ${orgId}
    LIMIT 1
  `);
  const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as unknown[];
  return list.length > 0;
}
