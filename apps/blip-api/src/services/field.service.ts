/**
 * Blip field-catalog reads + promotions (Blip §7.3, §15). The catalog itself is
 * upserted by the ingest worker; this service lists it, queues a concurrent
 * expression-index build for a promoted field, and toggles the Bench-metric
 * flag. Every query is org-scoped.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipFieldCatalog } from '../db/schema/index.js';
import { enqueueFieldIndex } from '../lib/queue.js';
import { getApp } from './app.service.js';
import { NotFoundError } from './errors.js';

/** List the observed field catalog for one (app, report_type). */
export async function listFields(appId: string, orgId: string, reportType: string) {
  await getApp(appId, orgId);
  return db
    .select()
    .from(blipFieldCatalog)
    .where(
      and(
        eq(blipFieldCatalog.tracked_app_id, appId),
        eq(blipFieldCatalog.org_id, orgId),
        eq(blipFieldCatalog.report_type, reportType),
      ),
    )
    .orderBy(blipFieldCatalog.field_path);
}

async function getField(appId: string, orgId: string, reportType: string, fieldPath: string) {
  const rows = await db
    .select()
    .from(blipFieldCatalog)
    .where(
      and(
        eq(blipFieldCatalog.tracked_app_id, appId),
        eq(blipFieldCatalog.org_id, orgId),
        eq(blipFieldCatalog.report_type, reportType),
        eq(blipFieldCatalog.field_path, fieldPath),
      ),
    )
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Field not found in catalog');
  return rows[0]!;
}

/**
 * Promote a field to indexed. The concurrent btree expression index is built by
 * the blip-field-index worker, which flips `is_indexed` true on completion;
 * this endpoint validates the field and enqueues that job.
 */
export async function indexField(appId: string, orgId: string, reportType: string, fieldPath: string) {
  await getApp(appId, orgId);
  const field = await getField(appId, orgId, reportType, fieldPath);
  await enqueueFieldIndex({
    org_id: orgId,
    tracked_app_id: appId,
    report_type: reportType,
    field_path: fieldPath,
  });
  return {
    tracked_app_id: appId,
    report_type: reportType,
    field_path: fieldPath,
    is_indexed: field.is_indexed,
    index_status: 'pending' as const,
  };
}

/** Mark / unmark a catalog field as a Bench numeric rollup metric. */
export async function setMetric(
  appId: string,
  orgId: string,
  reportType: string,
  fieldPath: string,
  isMetric: boolean,
) {
  await getApp(appId, orgId);
  const rows = await db
    .update(blipFieldCatalog)
    .set({ is_metric: isMetric })
    .where(
      and(
        eq(blipFieldCatalog.tracked_app_id, appId),
        eq(blipFieldCatalog.org_id, orgId),
        eq(blipFieldCatalog.report_type, reportType),
        eq(blipFieldCatalog.field_path, fieldPath),
      ),
    )
    .returning();
  if (rows.length === 0) throw new NotFoundError('Field not found in catalog');
  return rows[0]!;
}
