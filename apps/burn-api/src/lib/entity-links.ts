// entity_links upserts (spec 8.4).
//
// Burn writes cross-app links so the platform's link graph knows a chain is about a
// particular company, contract document, and billing client, and so a confirmed attribution
// records which source record funds which deliverable.
//
//   engagement register  -> burn.engagement -> bond.company | bin.asset | bill.client
//   confirmed attribution -> burn.deliverable -> <source_type>
//
// ON CONFLICT DO NOTHING throughout: the unique index is
// (src_type, src_id, dst_type, dst_id, link_kind), re-registering an engagement or
// re-confirming an attribution must be a no-op rather than a 23505 that aborts the
// enclosing transaction.
//
// NOTE the column name boundary: entity_links uses `org_id`, every burn_* table uses
// `organization_id`. Getting this backwards is a compile error, which is the point of the
// local Drizzle view in db/schema/entity-links.ts.

import { sql } from 'drizzle-orm';
import { entityLinks } from '../db/schema/index.js';
import type { DbTx } from '../db/index.js';

export type BurnLinkSrcType = 'burn.engagement' | 'burn.deliverable';

export interface EntityLinkSpec {
  srcType: BurnLinkSrcType;
  srcId: string;
  dstType: string;
  dstId: string;
  linkKind?: 'related_to' | 'references' | 'derived_from';
}

/**
 * Insert links, ignoring duplicates. Never throws on a conflict.
 *
 * Takes the transaction handle rather than the pooled `db` so the links land in the SAME
 * org-scoped transaction as the row they describe: an engagement that exists with no links,
 * or links that outlive a rolled-back create, are both worse than no links.
 */
export async function upsertEntityLinks(
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
      link_kind: (s.linkKind ?? 'references') as 'related_to' | 'references' | 'derived_from',
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

/** The links an engagement register produces (spec 8.4). */
export function engagementLinkSpecs(args: {
  engagementId: string;
  accountType: string | null;
  accountId: string | null;
  binAssetId: string | null;
  billClientId: string | null;
}): EntityLinkSpec[] {
  const specs: EntityLinkSpec[] = [];
  if (args.accountId && args.accountType) {
    specs.push({
      srcType: 'burn.engagement',
      srcId: args.engagementId,
      dstType: args.accountType,
      dstId: args.accountId,
      linkKind: 'related_to',
    });
  }
  if (args.binAssetId) {
    specs.push({
      srcType: 'burn.engagement',
      srcId: args.engagementId,
      dstType: 'bin.asset',
      dstId: args.binAssetId,
      linkKind: 'derived_from',
    });
  }
  if (args.billClientId) {
    specs.push({
      srcType: 'burn.engagement',
      srcId: args.engagementId,
      dstType: 'bill.client',
      dstId: args.billClientId,
      linkKind: 'related_to',
    });
  }
  return specs;
}

/** The link a confirmed attribution produces: deliverable -> the funding source record. */
export function attributionLinkSpec(args: {
  deliverableId: string;
  sourceType: string;
  sourceId: string;
}): EntityLinkSpec {
  return {
    srcType: 'burn.deliverable',
    srcId: args.deliverableId,
    dstType: args.sourceType,
    dstId: args.sourceId,
    linkKind: 'references',
  };
}

/** Escape hatch for callers outside a transaction (none today; kept for the worker). */
export const ENTITY_LINK_CONFLICT_CLAUSE = sql`ON CONFLICT DO NOTHING`;
