import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { BursarVendorCreate, BursarVendorUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bursarVendors, bursarPayeeAliases } from '../db/schema/index.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import { normalizePayee } from '../lib/payee-normalize.js';
import { resolveVendorGoldenId } from '../lib/braid-resolve.client.js';
import type { Viewer } from './types.js';

// EVERY query below carries an explicit organization_id predicate. The RLS backstop is absent
// today (the connecting role bypasses RLS), so the predicate is the ONLY tenant boundary (spec
// 6.3). runInOrgScope binds app.current_org_id so the policies also bind the day a
// non-superuser role is armed.

export interface VendorListParams {
  cursor?: string;
  limit: number;
  status?: string;
}

export async function listVendors(viewer: Viewer, params: VendorListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cur = decodeCursor(params.cursor);
    const conds = [eq(bursarVendors.organization_id, viewer.org_id)];
    if (params.status) conds.push(eq(bursarVendors.status, params.status));
    if (cur) {
      conds.push(
        or(
          lt(bursarVendors.created_at, new Date(cur.createdAt)),
          and(eq(bursarVendors.created_at, new Date(cur.createdAt)), lt(bursarVendors.id, cur.id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(bursarVendors)
      .where(and(...conds))
      .orderBy(desc(bursarVendors.created_at), desc(bursarVendors.id))
      .limit(params.limit + 1);
    const { items, next_cursor } = paginate(rows, params.limit);
    return { data: items, next_cursor };
  });
}

async function loadVendor(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bursarVendors)
    .where(and(eq(bursarVendors.organization_id, orgId), eq(bursarVendors.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Vendor not found');
  return row;
}

export async function getVendor(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => ({ data: await loadVendor(tx, viewer.org_id, id) }));
}

/** Reject a duplicate on (org, lower(display_name)) before the DB unique index does, so the
 *  caller gets a clean 409 rather than a raw constraint error. The unique index is still the
 *  race backstop (a 23505 is mapped to ConflictError by the caller). */
async function assertNameFree(tx: DbTx, orgId: string, name: string, excludeId?: string) {
  const conds = [
    eq(bursarVendors.organization_id, orgId),
    sql`lower(${bursarVendors.display_name}) = lower(${name})`,
  ];
  if (excludeId) conds.push(sql`${bursarVendors.id} <> ${excludeId}`);
  const [existing] = await tx
    .select({ id: bursarVendors.id })
    .from(bursarVendors)
    .where(and(...conds))
    .limit(1);
  if (existing) {
    throw new ConflictError(`A vendor named "${name}" already exists in this organization`);
  }
}

export async function createVendor(viewer: Viewer, data: BursarVendorCreate, askerUserId: string | null) {
  // Braid resolve (bond_company_id -> golden id) happens OUTSIDE the transaction: it is a soft
  // network dependency that degrades to null and must never hold a DB transaction open or fail
  // the create (spec 6.1).
  let braidProfileId: string | null = null;
  if (data.bond_company_id) {
    braidProfileId = await resolveVendorGoldenId({
      orgId: viewer.org_id,
      bondCompanyId: data.bond_company_id,
      askerUserId,
    });
  }
  return runInOrgScope(viewer.org_id, async (tx) => {
    await assertNameFree(tx, viewer.org_id, data.display_name);
    try {
      const [row] = await tx
        .insert(bursarVendors)
        .values({
          organization_id: viewer.org_id,
          display_name: data.display_name,
          category: data.category ?? null,
          criticality: data.criticality,
          owner_user_id: data.owner_user_id ?? null,
          bond_company_id: data.bond_company_id ?? null,
          braid_profile_id: braidProfileId,
          notes: data.notes ?? null,
          created_by: viewer.id,
        })
        .returning();
      return { data: row };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A vendor named "${data.display_name}" already exists in this organization`,
        );
      }
      throw err;
    }
  });
}

export async function updateVendor(viewer: Viewer, id: string, patch: BursarVendorUpdate, askerUserId: string | null) {
  // Resolve a changed bond_company_id to a golden id before the transaction (same soft-dep
  // contract as create). A patch that clears bond_company_id also clears braid_profile_id.
  let braidUpdate: { braid_profile_id: string | null } | null = null;
  if (patch.bond_company_id !== undefined) {
    braidUpdate = {
      braid_profile_id: patch.bond_company_id
        ? await resolveVendorGoldenId({
            orgId: viewer.org_id,
            bondCompanyId: patch.bond_company_id,
            askerUserId,
          })
        : null,
    };
  }
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadVendor(tx, viewer.org_id, id);
    if (patch.display_name !== undefined) {
      await assertNameFree(tx, viewer.org_id, patch.display_name, id);
    }
    const values: Record<string, unknown> = { updated_at: new Date() };
    for (const k of [
      'display_name',
      'category',
      'criticality',
      'owner_user_id',
      'bond_company_id',
      'notes',
      'status',
    ] as const) {
      if (patch[k] !== undefined) values[k] = patch[k];
    }
    if (braidUpdate) values.braid_profile_id = braidUpdate.braid_profile_id;
    try {
      const [row] = await tx
        .update(bursarVendors)
        .set(values)
        .where(and(eq(bursarVendors.organization_id, viewer.org_id), eq(bursarVendors.id, id)))
        .returning();
      return { data: row };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A vendor with that name already exists in this organization');
      }
      throw err;
    }
  });
}

/** DELETE archives (spec 11 / 13): status -> 'archived', never a hard delete. */
export async function archiveVendor(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadVendor(tx, viewer.org_id, id);
    const [row] = await tx
      .update(bursarVendors)
      .set({ status: 'archived', updated_at: new Date() })
      .where(and(eq(bursarVendors.organization_id, viewer.org_id), eq(bursarVendors.id, id)))
      .returning();
    return { data: row };
  });
}

/* ------------------------------------------------------------------ */
/*  Aliases                                                           */
/* ------------------------------------------------------------------ */

export async function listAliases(viewer: Viewer, vendorId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadVendor(tx, viewer.org_id, vendorId);
    const rows = await tx
      .select()
      .from(bursarPayeeAliases)
      .where(
        and(
          eq(bursarPayeeAliases.organization_id, viewer.org_id),
          eq(bursarPayeeAliases.vendor_id, vendorId),
        ),
      )
      .orderBy(desc(bursarPayeeAliases.last_seen_at));
    return { data: rows };
  });
}

/**
 * A HUMAN confirmation of a payee->vendor link. Always source='human' at confidence 1.0; a
 * caller can never assert a machine confidence. Upserts on (org, normalized_payee) so a human
 * decision overrides a prior auto/pending row rather than colliding with the unique index.
 */
export async function createAlias(viewer: Viewer, vendorId: string, rawPayee: string) {
  const normalized = normalizePayee(rawPayee);
  if (!normalized) {
    throw new ConflictError('The payee string normalizes to empty and cannot be linked');
  }
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadVendor(tx, viewer.org_id, vendorId);
    const [row] = await tx
      .insert(bursarPayeeAliases)
      .values({
        organization_id: viewer.org_id,
        vendor_id: vendorId,
        raw_payee: rawPayee,
        normalized_payee: normalized,
        source: 'human',
        confidence: '1.0000',
        resolved_by: viewer.id,
        last_seen_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [bursarPayeeAliases.organization_id, bursarPayeeAliases.normalized_payee],
        set: {
          vendor_id: vendorId,
          raw_payee: rawPayee,
          source: 'human',
          confidence: '1.0000',
          resolved_by: viewer.id,
          last_seen_at: new Date(),
        },
      })
      .returning();
    return { data: row };
  });
}

export async function deleteAlias(viewer: Viewer, vendorId: string, aliasId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .delete(bursarPayeeAliases)
      .where(
        and(
          eq(bursarPayeeAliases.organization_id, viewer.org_id),
          eq(bursarPayeeAliases.vendor_id, vendorId),
          eq(bursarPayeeAliases.id, aliasId),
        ),
      )
      .returning({ id: bursarPayeeAliases.id });
    if (!row) throw new NotFoundError('Alias not found');
    return { data: { id: row.id, deleted: true } };
  });
}

/**
 * The human-review queue: payee aliases sitting in the between-thresholds band (source
 * 'pending'), which the ingest path writes but NEVER auto-joins (spec 6.1). At M2 the ingest
 * path does not exist yet, so this returns an empty set until spend import lands; the endpoint
 * exists now so the review UI has a stable contract.
 */
export async function listAliasReview(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(bursarPayeeAliases)
      .where(
        and(
          eq(bursarPayeeAliases.organization_id, viewer.org_id),
          eq(bursarPayeeAliases.source, 'pending'),
        ),
      )
      .orderBy(desc(bursarPayeeAliases.last_seen_at))
      .limit(200);
    return { data: rows };
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
