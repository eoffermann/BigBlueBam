import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { BulwarkCreateVendorTierInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { bulwarkContracts, bulwarkVendorTiers, entityLinks } from '../db/schema/index.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { resolveCounterpartyGoldenId } from '../lib/braid-resolve.client.js';
import { loadScopedContract } from './contracts.service.js';
import { isAdminViewer, type Viewer } from './types.js';
import { ProjectScopeError } from '../lib/errors.js';

type VendorTierRow = typeof bulwarkVendorTiers.$inferSelect;

// Vendor tiers are compliance-read scoped via contract_id -> contract.project_id (SH3). A
// null contract_id tier is owner/admin-only.
async function vendorTierScope(viewer: Viewer): Promise<SQL | undefined> {
  const orgPred = eq(bulwarkVendorTiers.organization_id, viewer.org_id);
  if (isAdminViewer(viewer)) return orgPred;
  const ids = await memberProjectIds(viewer.id);
  // A null contract_id tier is admin-only, so a non-admin sees ONLY tiers whose contract's
  // project they are a member of (never the null-contract tiers).
  const projPred =
    ids.length === 0
      ? sql`false`
      : or(sql`${bulwarkContracts.project_id} IN ${ids}`, isNull(bulwarkContracts.project_id));
  return and(orgPred, projPred);
}

export async function listVendorTiers(
  viewer: Viewer,
  opts: { contractId?: string; chaseStatus?: string },
) {
  const scope = await vendorTierScope(viewer);
  const conds: (SQL | undefined)[] = [scope];
  if (opts.contractId) conds.push(eq(bulwarkVendorTiers.contract_id, opts.contractId));
  if (opts.chaseStatus) conds.push(eq(bulwarkVendorTiers.chase_status, opts.chaseStatus));

  // Non-admins join through contracts to enforce the project predicate; admins do not need it
  // but the join is harmless (contract_id may be null -> use a left join).
  const rows = await db
    .select({ v: bulwarkVendorTiers })
    .from(bulwarkVendorTiers)
    .leftJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkVendorTiers.contract_id))
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    .orderBy(bulwarkVendorTiers.tier_level, bulwarkVendorTiers.created_at);
  return rows.map((r) => r.v);
}

// Add a vendor tier (spec 5.1). Project-scoped via the parent contract (SH1). required_doc_types
// is seeded empty here and RECOMPUTED from scratch by the coi-chase sweep (DI5). Braid unifies
// the vendor (soft dependency, IN7).
export async function createVendorTier(
  viewer: Viewer,
  input: BulwarkCreateVendorTierInput,
): Promise<VendorTierRow> {
  if (input.contract_id) {
    // Enforce the write project-scope on the parent contract (SH1).
    await loadScopedContract(viewer, input.contract_id);
  } else if (!isAdminViewer(viewer)) {
    // A null-contract tier is owner/admin-only (SH3).
    throw new ProjectScopeError('A vendor tier without a contract requires owner/admin');
  }

  if (input.vendor_type && input.vendor_id) {
    await resolveCounterpartyGoldenId({
      orgId: viewer.org_id,
      sourceType: input.vendor_type,
      sourceId: input.vendor_id,
      askerUserId: viewer.id,
    }).catch(() => null);
  }

  const [row] = await db
    .insert(bulwarkVendorTiers)
    .values({
      organization_id: viewer.org_id,
      contract_id: input.contract_id ?? null,
      parent_tier_id: input.parent_tier_id ?? null,
      vendor_type: input.vendor_type ?? null,
      vendor_id: input.vendor_id ?? null,
      tier_level: input.tier_level,
      required_doc_types: [],
      chase_status: 'idle',
    })
    .onConflictDoNothing({
      target: [
        bulwarkVendorTiers.organization_id,
        bulwarkVendorTiers.contract_id,
        bulwarkVendorTiers.vendor_type,
        bulwarkVendorTiers.vendor_id,
      ],
    })
    .returning();

  // If the tier already existed (conflict), fetch it.
  let tier = row as VendorTierRow | undefined;
  if (!tier) {
    const [existing] = await db
      .select()
      .from(bulwarkVendorTiers)
      .where(
        and(
          eq(bulwarkVendorTiers.organization_id, viewer.org_id),
          input.contract_id
            ? eq(bulwarkVendorTiers.contract_id, input.contract_id)
            : isNull(bulwarkVendorTiers.contract_id),
        ),
      )
      .limit(1);
    tier = existing as VendorTierRow;
  }

  if (tier && input.vendor_type && input.vendor_id) {
    await db
      .insert(entityLinks)
      .values({
        org_id: viewer.org_id,
        src_type: 'bulwark.vendor_tier',
        src_id: tier.id,
        dst_type: input.vendor_type,
        dst_id: input.vendor_id,
        link_kind: 'related_to',
        created_by: viewer.id,
      })
      .onConflictDoNothing();
  }

  return tier;
}
