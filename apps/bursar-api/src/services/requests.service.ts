import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { BursarRequestCreate, BursarRequestUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bursarRequests } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import { assertBinAssetReadable } from '../lib/bin-asset-access.js';
import { makeBinAssetAccessDeps } from '../lib/bin-asset-access.db.js';
import type { Viewer } from './types.js';

// Every query carries an explicit organization_id predicate (spec 6.3). A request that names a
// Bin source document has that document access-checked (spec 5.8) and the resolved version
// PINNED before the row is written, inside the same org-scoped transaction.

export interface RequestListParams {
  cursor?: string;
  limit: number;
  status?: string;
}

export async function listRequests(viewer: Viewer, params: RequestListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cur = decodeCursor(params.cursor);
    const conds = [eq(bursarRequests.organization_id, viewer.org_id)];
    if (params.status) conds.push(eq(bursarRequests.status, params.status));
    if (cur) {
      conds.push(
        or(
          lt(bursarRequests.created_at, new Date(cur.createdAt)),
          and(eq(bursarRequests.created_at, new Date(cur.createdAt)), lt(bursarRequests.id, cur.id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(bursarRequests)
      .where(and(...conds))
      .orderBy(desc(bursarRequests.created_at), desc(bursarRequests.id))
      .limit(params.limit + 1);
    const { items, next_cursor } = paginate(rows, params.limit);
    return { data: items, next_cursor };
  });
}

async function loadRequest(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bursarRequests)
    .where(and(eq(bursarRequests.organization_id, orgId), eq(bursarRequests.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Request not found');
  return row;
}

export async function getRequest(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => ({ data: await loadRequest(tx, viewer.org_id, id) }));
}

export async function createRequest(viewer: Viewer, data: BursarRequestCreate, actingUserId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    let binAssetId: string | null = null;
    let binAssetVersionId: string | null = null;
    if (data.bin_asset_id) {
      // §5.8: four-check gate, 404 on any failure, then PIN the resolved version.
      const { bin_asset_version_id } = await assertBinAssetReadable(
        makeBinAssetAccessDeps(tx),
        actingUserId,
        viewer.org_id,
        data.bin_asset_id,
      );
      binAssetId = data.bin_asset_id;
      binAssetVersionId = bin_asset_version_id;
    }
    const [row] = await tx
      .insert(bursarRequests)
      .values({
        organization_id: viewer.org_id,
        title: data.title,
        description: data.description ?? null,
        currency: data.currency,
        bin_asset_id: binAssetId,
        bin_asset_version_id: binAssetVersionId,
        created_by: viewer.id,
      })
      .returning();
    return { data: row };
  });
}

export async function updateRequest(viewer: Viewer, id: string, patch: BursarRequestUpdate, actingUserId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadRequest(tx, viewer.org_id, id);
    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.bin_asset_id !== undefined) {
      if (patch.bin_asset_id) {
        // Re-run the §5.8 gate on attach/replace and re-pin the version.
        const { bin_asset_version_id } = await assertBinAssetReadable(
          makeBinAssetAccessDeps(tx),
          actingUserId,
          viewer.org_id,
          patch.bin_asset_id,
        );
        values.bin_asset_id = patch.bin_asset_id;
        values.bin_asset_version_id = bin_asset_version_id;
      } else {
        values.bin_asset_id = null;
        values.bin_asset_version_id = null;
      }
    }
    const [row] = await tx
      .update(bursarRequests)
      .set(values)
      .where(and(eq(bursarRequests.organization_id, viewer.org_id), eq(bursarRequests.id, id)))
      .returning();
    return { data: row };
  });
}
