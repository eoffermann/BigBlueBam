// Small org-scoped helpers the M3 services share.

import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DbTx } from '../db/index.js';
import { bastionFrameworks, bastionOrgSettings } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import type { ConnectedPopulations } from '../library/compile-plan.js';

/** A stable 0-59 minute offset per org so nightly runs spread across the hour (0274 comment). */
export function evaluationMinuteOffset(orgId: string): number {
  return createHash('sha256').update(orgId).digest().readUInt16BE(0) % 60;
}

/** The org's settings row, created on first use. */
export async function ensureSettings(tx: DbTx, orgId: string) {
  await tx
    .insert(bastionOrgSettings)
    .values({ organization_id: orgId, evaluation_minute_offset: evaluationMinuteOffset(orgId) })
    .onConflictDoNothing();
  const [row] = await tx.select().from(bastionOrgSettings).where(eq(bastionOrgSettings.organization_id, orgId)).limit(1);
  return row!;
}

export async function loadFramework(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bastionFrameworks)
    .where(and(eq(bastionFrameworks.id, id), eq(bastionFrameworks.organization_id, orgId)))
    .limit(1);
  if (!row) throw new NotFoundError('We could not find that framework.');
  return row;
}

/** Non-archived frameworks: the default "all frameworks" view. */
export async function liveFrameworks(tx: DbTx, orgId: string) {
  return tx
    .select()
    .from(bastionFrameworks)
    .where(and(eq(bastionFrameworks.organization_id, orgId), ne(bastionFrameworks.status, 'archived')))
    .orderBy(bastionFrameworks.created_at);
}

/**
 * The connected sets the deterministic compile proposes as populations (spec 2.1 step 5):
 * enabled GitHub integrations on the org's projects, and the org's Blip tracked apps. Values are
 * what the 0279 probe functions compare (lower-cased `owner/repo`, tracked-app id); labels are
 * what people see.
 */
export async function connectedPopulations(tx: DbTx, orgId: string): Promise<ConnectedPopulations> {
  const repos = (await tx.execute(sql`
    SELECT DISTINCT lower(gi.repo_owner || '/' || gi.repo_name) AS value, gi.repo_owner || '/' || gi.repo_name AS label
      FROM github_integrations gi
      JOIN projects p ON p.id = gi.project_id
     WHERE p.org_id = ${orgId} AND gi.enabled
     ORDER BY 1
  `)) as unknown as Array<{ value: string; label: string }>;
  const apps = (await tx.execute(sql`
    SELECT a.id::text AS value, a.name AS label
      FROM blip_tracked_apps a
     WHERE a.org_id = ${orgId}
     ORDER BY a.name
  `)) as unknown as Array<{ value: string; label: string }>;
  return {
    github_repos: repos.map((r) => ({ value: r.value, label: r.label })),
    blip_apps: apps.map((a) => ({ value: a.value, label: a.label })),
  };
}

/** True when the error is a unique violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
