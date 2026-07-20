import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { runInOrgScope } from '../../plugins/rls.js';
import {
  reapOrg,
  DEFAULT_REAPER_LEASE_MS,
  type ReaperStore,
  type ReaperSummary,
} from './reaper.engine.js';

/**
 * The production reaper store + sweep entry points (spec 3.2). Split from reaper.engine.ts so the
 * core stays free of db/env imports. Each revert is one org-scoped transaction; both statements
 * commit or roll back together, so the run and its owning request never diverge.
 */

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export function makeDbReaperStore(): ReaperStore {
  return {
    async reapStaleRuns(orgId, leaseMs) {
      const leaseSql = `${Math.round(leaseMs)} milliseconds`;
      return runInOrgScope(orgId, async (tx) => {
        // 1. Revert the stale runs, capturing their owning requests.
        const reverted = pgRows<{ request_id: string }>(
          await tx.execute(sql`
            UPDATE bursar_extraction_runs
               SET status = 'partial',
                   claimed_by = NULL,
                   error = COALESCE(error, 'Reaped: derivation lease expired; run reverted to partial for re-derive.'),
                   finished_at = now()
             WHERE organization_id = ${orgId}
               AND status = 'running'
               AND (heartbeat_at IS NULL OR heartbeat_at < now() - ${leaseSql}::interval)
            RETURNING request_id
          `),
        );
        if (reverted.length === 0) return { runs_reverted: 0, requests_reverted: 0 };
        // 2. In the SAME transaction, revert the owning requests still pinned at 'deriving'.
        const requestIds = [...new Set(reverted.map((r) => r.request_id))];
        const requests = pgRows<{ id: string }>(
          await tx.execute(sql`
            UPDATE bursar_requests
               SET scope_status = 'pending', updated_at = now()
             WHERE organization_id = ${orgId}
               AND scope_status = 'deriving'
               AND id = ANY(${requestIds}::uuid[])
            RETURNING id
          `),
        );
        return { runs_reverted: reverted.length, requests_reverted: requests.length };
      });
    },

    async reapStaleOffers(orgId, leaseMs) {
      const leaseSql = `${Math.round(leaseMs)} milliseconds`;
      return runInOrgScope(orgId, async (tx) => {
        const r = pgRows<{ id: string }>(
          await tx.execute(sql`
            UPDATE bursar_offers
               SET normalization_status = 'failed', updated_at = now()
             WHERE organization_id = ${orgId}
               AND normalization_status = 'parsing'
               AND updated_at < now() - ${leaseSql}::interval
            RETURNING id
          `),
        );
        return r.length;
      });
    },
  };
}

/**
 * Discover the orgs with stale derivation runs or parsing offers, so the M8 worker can sweep
 * per-org. This is the one intentional cross-org maintenance read (see plugins/rls.ts): an
 * org-iterating sweep discovers its orgs, then does the actual work once per org under the org
 * GUC. Under armed RLS this needs the maintenance role; under the current superuser posture it
 * reads every org.
 */
export async function listOrgsWithStaleWork(leaseMs = DEFAULT_REAPER_LEASE_MS): Promise<string[]> {
  const leaseSql = `${Math.round(leaseMs)} milliseconds`;
  const raw = await db.execute(sql`
    SELECT DISTINCT organization_id FROM bursar_extraction_runs
     WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - ${leaseSql}::interval)
    UNION
    SELECT DISTINCT organization_id FROM bursar_offers
     WHERE normalization_status = 'parsing' AND updated_at < now() - ${leaseSql}::interval
  `);
  return pgRows<{ organization_id: string }>(raw).map((r) => r.organization_id);
}

/** Sweep every org with stale work. Returns the aggregate summary. */
export async function reapAllStale(leaseMs = DEFAULT_REAPER_LEASE_MS): Promise<ReaperSummary & { orgs: number }> {
  const orgs = await listOrgsWithStaleWork(leaseMs);
  const store = makeDbReaperStore();
  const total: ReaperSummary = { runs_reverted: 0, requests_reverted: 0, offers_reverted: 0 };
  for (const orgId of orgs) {
    const s = await reapOrg(store, orgId, leaseMs);
    total.runs_reverted += s.runs_reverted;
    total.requests_reverted += s.requests_reverted;
    total.offers_reverted += s.offers_reverted;
  }
  return { ...total, orgs: orgs.length };
}
