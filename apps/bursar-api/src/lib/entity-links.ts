// entity_links upserts at award (spec 16.3).
//
// Bursar writes cross-app links so the platform's link graph knows a frozen award is about a
// particular request, offer, vendor, and contract document, and so the Bulwark handoff is a
// durable edge rather than a silent deep link. Bursar writes ZERO rows in Bill, Burn, or
// Bulwark and defines no obligation / notice-deadline / work-item / invoice table; the
// integration point is this entity_links edge plus a deep link the response carries.
//
// ON CONFLICT DO NOTHING throughout: the unique index is
// (src_type, src_id, dst_type, dst_id, link_kind), so re-recording (or amending onto an
// existing contract asset) is a no-op rather than a 23505 that aborts the enclosing award
// transaction.
//
// NOTE the column-name boundary: entity_links uses `org_id`, every bursar_* table uses
// `organization_id`. The local Drizzle view in db/schema/entity-links.ts makes getting it
// backwards a compile error.

import { entityLinks } from '../db/schema/index.js';
import type { DbTx } from '../db/index.js';

export type BursarLinkSrcType = 'bursar.award';

type LinkKind = 'related_to' | 'references' | 'derived_from';

export interface EntityLinkSpec {
  srcType: BursarLinkSrcType;
  srcId: string;
  dstType: string;
  dstId: string;
  linkKind?: LinkKind;
}

/**
 * Insert links, ignoring duplicates. Never throws on a conflict. Takes the transaction handle
 * so the links land in the SAME org-scoped transaction as the award row they describe: an
 * award that exists with no links, or links that outlive a rolled-back freeze, are both worse
 * than no links.
 */
export async function upsertBursarEntityLinks(
  tx: DbTx,
  orgId: string,
  createdBy: string | null,
  specs: EntityLinkSpec[],
): Promise<number> {
  const rows = specs
    .filter((s) => !!s.dstId)
    .map((s) => ({
      org_id: orgId,
      src_type: s.srcType,
      src_id: s.srcId,
      dst_type: s.dstType,
      dst_id: s.dstId,
      link_kind: (s.linkKind ?? 'references') as LinkKind,
      created_by: createdBy,
    }));
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(entityLinks)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: entityLinks.id });
  return inserted.length;
}

/**
 * The links an award freeze produces (spec 16.3):
 *   bursar.award -> bursar.request   (references)
 *   bursar.award -> bursar.offer     (derived_from)   the offer whose lines were frozen
 *   bursar.award -> bursar.vendor    (related_to)
 *   bursar.award -> bin.asset        (derived_from)   the contract document; also the Bulwark
 *                                                     handoff edge (a Bin asset Bulwark reads)
 */
export function awardLinkSpecs(args: {
  awardId: string;
  requestId: string;
  offerId: string | null;
  vendorId: string | null;
  contractBinAssetId: string | null;
}): EntityLinkSpec[] {
  const specs: EntityLinkSpec[] = [
    { srcType: 'bursar.award', srcId: args.awardId, dstType: 'bursar.request', dstId: args.requestId, linkKind: 'references' },
  ];
  if (args.offerId) {
    specs.push({ srcType: 'bursar.award', srcId: args.awardId, dstType: 'bursar.offer', dstId: args.offerId, linkKind: 'derived_from' });
  }
  if (args.vendorId) {
    specs.push({ srcType: 'bursar.award', srcId: args.awardId, dstType: 'bursar.vendor', dstId: args.vendorId, linkKind: 'related_to' });
  }
  if (args.contractBinAssetId) {
    specs.push({ srcType: 'bursar.award', srcId: args.awardId, dstType: 'bin.asset', dstId: args.contractBinAssetId, linkKind: 'derived_from' });
  }
  return specs;
}

/**
 * The Bulwark handoff deep link (spec 16.3). Bursar owns no Bulwark table, so the handoff is
 * this URL plus the bursar.award -> bin.asset entity_links edge above. Points Bulwark at the
 * frozen award (and its contract asset when present) so a human can stand up obligation
 * monitoring from the baseline.
 */
export function bulwarkHandoffDeepLink(args: { awardId: string; contractBinAssetId: string | null }): string {
  const params = new URLSearchParams({ award: args.awardId });
  if (args.contractBinAssetId) params.set('contract_asset', args.contractBinAssetId);
  return `/bulwark/?${params.toString()}`;
}
