import { and, eq, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bayAssets, bayAssetVersions, bayAnnotations } from '../db/schema/index.js';
import { getVersion } from './version.service.js';
import { NotFoundError } from './errors.js';

export interface CreateAnnotationInput {
  anchor?: Record<string, unknown>;
  body: string;
  thread_parent_id?: string | null;
}

export async function listAnnotations(
  versionId: string,
  orgId: string,
  opts: { include_resolved?: boolean } = {},
) {
  // Org-scope via the version resolver (joins through bay_assets).
  await getVersion(versionId, orgId);
  const conditions = [eq(bayAnnotations.version_id, versionId)];
  if (!opts.include_resolved) {
    conditions.push(eq(bayAnnotations.resolved, false));
  }
  return db
    .select()
    .from(bayAnnotations)
    .where(and(...conditions))
    .orderBy(asc(bayAnnotations.created_at));
}

export async function createAnnotation(
  versionId: string,
  orgId: string,
  authorId: string,
  input: CreateAnnotationInput,
) {
  await getVersion(versionId, orgId);
  const rows = await db
    .insert(bayAnnotations)
    .values({
      version_id: versionId,
      author_id: authorId,
      anchor: input.anchor ?? {},
      body: input.body,
      thread_parent_id: input.thread_parent_id ?? null,
    })
    .returning();
  return rows[0]!;
}

/**
 * Resolve an annotation by id, org-scoped via a join through
 * bay_asset_versions -> bay_assets.
 */
async function getAnnotation(annotationId: string, orgId: string) {
  const rows = await db
    .select({ annotation: bayAnnotations, asset_org: bayAssets.org_id })
    .from(bayAnnotations)
    .innerJoin(bayAssetVersions, eq(bayAssetVersions.id, bayAnnotations.version_id))
    .innerJoin(bayAssets, eq(bayAssets.id, bayAssetVersions.asset_id))
    .where(eq(bayAnnotations.id, annotationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.asset_org !== orgId) throw new NotFoundError('Annotation not found');
  return row.annotation;
}

export async function resolveAnnotation(annotationId: string, orgId: string, resolved: boolean) {
  await getAnnotation(annotationId, orgId);
  const rows = await db
    .update(bayAnnotations)
    .set({ resolved })
    .where(eq(bayAnnotations.id, annotationId))
    .returning();
  return rows[0]!;
}
