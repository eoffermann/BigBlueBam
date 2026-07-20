import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { BursarLibraryCreate, BursarLibraryUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { bursarScopeLibrary } from '../db/schema/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import type { Viewer } from './types.js';

// Org scope-library CRUD (spec 11, M8). Global built-in rows (is_global=true, organization_id NULL)
// are READ-ONLY to org callers: create/update/delete operate ONLY on the org's own rows. A write
// aimed at a global row is rejected, not silently ignored (the DB trigger from 0247 also blocks it;
// this is the friendly service-layer guard).

export async function listLibrary(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    // Reads see the org's rows AND the global built-ins (globals are admissible to apply into a tree).
    const rows = await tx
      .select()
      .from(bursarScopeLibrary)
      .where(or(eq(bursarScopeLibrary.is_global, true), eq(bursarScopeLibrary.organization_id, viewer.org_id)))
      .orderBy(desc(bursarScopeLibrary.is_global), bursarScopeLibrary.category, bursarScopeLibrary.title);
    return { data: rows };
  });
}

export async function createLibraryEntry(viewer: Viewer, body: BursarLibraryCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    // Always an ORG row: is_global forced false, organization_id set. A caller cannot mint a global.
    const [row] = await tx
      .insert(bursarScopeLibrary)
      .values({
        organization_id: viewer.org_id,
        is_global: false,
        category: body.category,
        title: body.title,
        description: body.description ?? null,
        node_kind: body.node_kind,
        normative_strength: body.normative_strength,
        unit: body.unit ?? null,
        default_quantity: body.default_quantity != null ? String(body.default_quantity) : null,
        unit_price_minor: body.unit_price_minor ?? null,
        currency: body.currency ?? null,
        tags: body.tags ?? [],
        created_by: viewer.id,
      })
      .returning();
    return { data: row };
  });
}

async function loadOrgOwnedEntry(tx: import('../db/index.js').DbTx, orgId: string, id: string) {
  const [row] = await tx.select().from(bursarScopeLibrary).where(eq(bursarScopeLibrary.id, id)).limit(1);
  if (!row) throw new NotFoundError('Library entry not found');
  // Reject a write aimed at a global built-in, or a cross-org row.
  if (row.is_global || row.organization_id === null) {
    throw new ValidationFailure('Global built-in library entries are read-only', 'LIBRARY_GLOBAL_READONLY');
  }
  if (row.organization_id !== orgId) throw new NotFoundError('Library entry not found');
  return row;
}

export async function updateLibraryEntry(viewer: Viewer, id: string, body: BursarLibraryUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadOrgOwnedEntry(tx, viewer.org_id, id);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (k === 'default_quantity') patch[k] = v != null ? String(v) : null;
      else patch[k] = v;
    }
    const [row] = await tx
      .update(bursarScopeLibrary)
      .set(patch)
      .where(and(eq(bursarScopeLibrary.id, id), eq(bursarScopeLibrary.organization_id, viewer.org_id)))
      .returning();
    return { data: row };
  });
}

export async function deleteLibraryEntry(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadOrgOwnedEntry(tx, viewer.org_id, id);
    await tx.execute(sql`DELETE FROM bursar_scope_library WHERE id = ${id} AND organization_id = ${viewer.org_id} AND is_global = false`);
    return { data: { id, deleted: true } };
  });
}
