/**
 * Braid candidate retention sweep (Braid design spec §4.6, ST8). Daily cron '50 3 * * *'.
 *
 * Purges terminal-status match candidates (merged / rejected / superseded) older than the
 * per-org rescan_max_age_days. NEVER touches braid_merge_decisions (the immutable audit
 * trail). Bounded ranged DELETEs per org so one org's short window can't delete another's
 * rows. Modeled on basis-retention-sweep.job.ts.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BraidCandidateRetentionJobData {
  organization_id?: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function processBraidCandidateRetentionJob(
  job: Job<BraidCandidateRetentionJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const started = Date.now();
  const scopeOrg = job.data?.organization_id;

  // Per-org windows. rescan_max_age_days NULL = never expire a candidate (spec 3.1).
  const policies = rows<{ organization_id: string; rescan_max_age_days: number | null }>(
    await db.execute(sql`
      SELECT organization_id, rescan_max_age_days FROM braid_org_settings
       ${scopeOrg ? sql`WHERE organization_id = ${scopeOrg}` : sql``}
    `),
  );

  let deleted = 0;
  let orgsSwept = 0;
  for (const p of policies) {
    if (p.rescan_max_age_days == null) continue;
    const res = await db.execute(sql`
      DELETE FROM braid_match_candidates
       WHERE organization_id = ${p.organization_id}
         AND status IN ('merged', 'rejected', 'superseded')
         AND created_at < now() - (${p.rescan_max_age_days} || ' days')::interval
    `);
    deleted += (res as { count?: number }).count ?? 0;
    orgsSwept += 1;
  }

  logger.info(
    { jobId: job.id, orgsSwept, deleted, elapsedMs: Date.now() - started },
    'braid-candidate-retention: done',
  );
}
