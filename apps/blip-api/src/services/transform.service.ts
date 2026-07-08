/**
 * Blip PII / payload transform configuration (Blip §9, §15). Upserts the ordered
 * redaction ruleset for a (tracked_app, report_type) pair. A `report_type` of
 * null applies the rules to every report type for the app. On every change we
 * bump `blip_tracked_apps.transform_version` so the ingest-key cache reloads and
 * the edge applies the current ruleset, and drop the in-process compiled-
 * transform cache. Every query is org-scoped.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipTransforms, blipTrackedApps } from '../db/schema/index.js';
import { getApp } from './app.service.js';
import { invalidateTransformCache } from './ingest.service.js';

export interface SetTransformInput {
  report_type?: string | null;
  enabled?: boolean;
  rules: unknown[];
}

/**
 * Read the app-wide (report_type = null) transform ruleset for the editor.
 * The Blip SPA's transform editor GETs /apps/:id/transform on load; without this
 * the page 404s and can never show or edit the existing rules. Returns an empty
 * default when no ruleset has been saved yet so the editor renders cleanly.
 */
export async function getTransform(appId: string, orgId: string) {
  await getApp(appId, orgId);
  const rows = await db
    .select()
    .from(blipTransforms)
    .where(
      and(
        eq(blipTransforms.tracked_app_id, appId),
        eq(blipTransforms.org_id, orgId),
        isNull(blipTransforms.report_type),
      ),
    )
    .limit(1);
  if (rows.length > 0) return rows[0]!;
  return { report_type: null, enabled: true, rules: [] as unknown[], version: 0 };
}

/**
 * Upsert the transform ruleset for (app, report_type) and bump the app's
 * transform_version so the edge picks up the change. Returns the stored row.
 */
export async function setTransform(
  appId: string,
  orgId: string,
  userId: string,
  input: SetTransformInput,
) {
  // Org-scope the parent app (throws NotFoundError when it is not in this org).
  await getApp(appId, orgId);

  const reportType = input.report_type ?? null;
  const matchReportType =
    reportType === null
      ? isNull(blipTransforms.report_type)
      : eq(blipTransforms.report_type, reportType);

  const existing = await db
    .select()
    .from(blipTransforms)
    .where(
      and(
        eq(blipTransforms.tracked_app_id, appId),
        eq(blipTransforms.org_id, orgId),
        matchReportType,
      ),
    )
    .limit(1);

  let row;
  if (existing.length > 0) {
    const patch: Record<string, unknown> = {
      rules: input.rules,
      version: existing[0]!.version + 1,
      updated_by: userId,
      updated_at: new Date(),
    };
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const updated = await db
      .update(blipTransforms)
      .set(patch)
      .where(eq(blipTransforms.id, existing[0]!.id))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await db
      .insert(blipTransforms)
      .values({
        org_id: orgId,
        tracked_app_id: appId,
        report_type: reportType,
        enabled: input.enabled ?? true,
        rules: input.rules,
        updated_by: userId,
      })
      .returning();
    row = inserted[0]!;
  }

  // Bump the app's active transform version so the ingest-key cache (which
  // carries the version) reloads and the edge applies the new ruleset.
  await db
    .update(blipTrackedApps)
    .set({
      transform_version: sql`${blipTrackedApps.transform_version} + 1`,
      updated_at: new Date(),
    })
    .where(and(eq(blipTrackedApps.id, appId), eq(blipTrackedApps.org_id, orgId)));

  // Drop the in-process compiled-transform cache for this app.
  invalidateTransformCache(appId);

  return row;
}
