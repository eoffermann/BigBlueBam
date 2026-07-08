/**
 * Blip retention policy configuration (Blip §11.2, §15). Upserts the retention
 * policy for a (tracked_app, report_type) pair; a `report_type` of null is the
 * app-wide default. Limits are independent ceilings (age / row count / byte
 * size); a null limit means "no limit on this axis". Every query is org-scoped.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipRetentionPolicies } from '../db/schema/index.js';
import { getApp } from './app.service.js';

export interface SetRetentionInput {
  report_type?: string | null;
  max_age_days?: number | null;
  max_rows?: number | null;
  max_bytes?: number | null;
}

function toBigint(v: number | null | undefined): bigint | null {
  return v == null ? null : BigInt(Math.trunc(v));
}

/**
 * List every retention policy for an app (app-wide default + any per-report_type
 * overrides). The Blip SPA's retention page GETs /apps/:id/retention on load and
 * picks the app default via `.find(p => !p.report_type)`; without this the page
 * 404s and shows no policy. max_rows/max_bytes are bigint columns — coerced to
 * number so they serialize to JSON and match the frontend RetentionPolicy type.
 */
export async function listRetention(appId: string, orgId: string) {
  await getApp(appId, orgId);
  const rows = await db
    .select()
    .from(blipRetentionPolicies)
    .where(
      and(eq(blipRetentionPolicies.tracked_app_id, appId), eq(blipRetentionPolicies.org_id, orgId)),
    );
  return rows.map((r) => ({
    ...r,
    max_rows: r.max_rows == null ? null : Number(r.max_rows),
    max_bytes: r.max_bytes == null ? null : Number(r.max_bytes),
  }));
}

/** Upsert the retention policy for (app, report_type). Returns the stored row. */
export async function setRetention(appId: string, orgId: string, userId: string, input: SetRetentionInput) {
  // Org-scope the parent app (throws NotFoundError when it is not in this org).
  await getApp(appId, orgId);

  const reportType = input.report_type ?? null;
  const matchReportType =
    reportType === null
      ? isNull(blipRetentionPolicies.report_type)
      : eq(blipRetentionPolicies.report_type, reportType);

  const existing = await db
    .select()
    .from(blipRetentionPolicies)
    .where(
      and(
        eq(blipRetentionPolicies.tracked_app_id, appId),
        eq(blipRetentionPolicies.org_id, orgId),
        matchReportType,
      ),
    )
    .limit(1);

  const values = {
    max_age_days: input.max_age_days ?? null,
    max_rows: toBigint(input.max_rows),
    max_bytes: toBigint(input.max_bytes),
    updated_by: userId,
    updated_at: new Date(),
  };

  if (existing.length > 0) {
    const updated = await db
      .update(blipRetentionPolicies)
      .set(values)
      .where(eq(blipRetentionPolicies.id, existing[0]!.id))
      .returning();
    return updated[0]!;
  }

  const inserted = await db
    .insert(blipRetentionPolicies)
    .values({
      org_id: orgId,
      tracked_app_id: appId,
      report_type: reportType,
      ...values,
    })
    .returning();
  return inserted[0]!;
}
