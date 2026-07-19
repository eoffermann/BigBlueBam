import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bulwarkComplianceDocs,
  bulwarkContracts,
  bulwarkVendorTiers,
} from '../db/schema/index.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { isAdminViewer, type Viewer } from './types.js';
import { NotFoundError } from '../lib/errors.js';

type ComplianceDocRow = typeof bulwarkComplianceDocs.$inferSelect;

// Compliance docs are project-scoped through vendor_tier.contract_id -> contract.project_id
// (SH3). A tier with a null contract is owner/admin-only.
async function complianceScope(viewer: Viewer): Promise<SQL | undefined> {
  const orgPred = eq(bulwarkComplianceDocs.organization_id, viewer.org_id);
  if (isAdminViewer(viewer)) return orgPred;
  const ids = await memberProjectIds(viewer.id);
  const projPred =
    ids.length === 0
      ? sql`false`
      : or(sql`${bulwarkContracts.project_id} IN ${ids}`, isNull(bulwarkContracts.project_id));
  return and(orgPred, projPred);
}

export async function listComplianceDocs(
  viewer: Viewer,
  opts: { vendorTierId?: string; validityStatus?: string; docType?: string },
) {
  const scope = await complianceScope(viewer);
  const conds: (SQL | undefined)[] = [scope];
  if (opts.vendorTierId) conds.push(eq(bulwarkComplianceDocs.vendor_tier_id, opts.vendorTierId));
  if (opts.validityStatus) conds.push(eq(bulwarkComplianceDocs.validity_status, opts.validityStatus));
  if (opts.docType) conds.push(eq(bulwarkComplianceDocs.doc_type, opts.docType));

  const rows = await db
    .select({ c: bulwarkComplianceDocs })
    .from(bulwarkComplianceDocs)
    .innerJoin(bulwarkVendorTiers, eq(bulwarkVendorTiers.id, bulwarkComplianceDocs.vendor_tier_id))
    .leftJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkVendorTiers.contract_id))
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    .orderBy(bulwarkComplianceDocs.created_at);
  return rows.map((r) => r.c);
}

// Load a compliance doc with the vendor tier + contract, applying the project-scope guard.
export async function loadScopedComplianceDoc(
  viewer: Viewer,
  id: string,
): Promise<{
  doc: ComplianceDocRow;
  tier: typeof bulwarkVendorTiers.$inferSelect;
  contractProjectId: string | null;
}> {
  const [row] = await db
    .select({
      c: bulwarkComplianceDocs,
      t: bulwarkVendorTiers,
      contract_project_id: bulwarkContracts.project_id,
    })
    .from(bulwarkComplianceDocs)
    .innerJoin(bulwarkVendorTiers, eq(bulwarkVendorTiers.id, bulwarkComplianceDocs.vendor_tier_id))
    .leftJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkVendorTiers.contract_id))
    .where(
      and(
        eq(bulwarkComplianceDocs.organization_id, viewer.org_id),
        eq(bulwarkComplianceDocs.id, id),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('Compliance doc not found');

  const projectId = row.contract_project_id ?? null;
  if (!isAdminViewer(viewer)) {
    // Null-contract tier is admin-only; else the viewer must be a member of the project.
    if (row.t.contract_id === null) throw new NotFoundError('Compliance doc not found');
    const ids = await memberProjectIds(viewer.id);
    if (projectId !== null && !ids.includes(projectId))
      throw new NotFoundError('Compliance doc not found');
  }
  return { doc: row.c, tier: row.t, contractProjectId: projectId };
}
