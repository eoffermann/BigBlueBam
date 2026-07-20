/**
 * The bursar-run-reaper CORE (spec 3.2, checklist M3 item 10). No db/env import so the M3 unit
 * suite can prove the transactional revert against an in-memory store. The DB store,
 * cross-org discovery, and the sweep-all entry point live in reaper.store.ts.
 *
 * WHY THIS IS LOAD-BEARING. A derivation that crashes between claim and finalize leaves the
 * extraction run 'running' with a stale lease AND the owning request pinned at
 * `scope_status='deriving'`. `POST /requests/:id/scope/confirm` returns 409 while `deriving`, so
 * without recovery the flagship is dead on that request forever, with no fix short of psql. The
 * reaper reverts the stale run to `partial` AND - in the SAME transaction - reverts the owning
 * request's `scope_status` back to `pending`. The same treatment unwedges
 * `bursar_offers.normalization_status='parsing'`.
 */

export const DEFAULT_REAPER_LEASE_MS = 5 * 60 * 1000;

export interface ReaperRun {
  id: string;
  status: string;
  heartbeat_at: Date | null;
}

export interface ReaperOffer {
  id: string;
  normalization_status: string | null;
  updated_at: Date | null;
}

/** Pure selector: a 'running' derivation whose lease has lapsed (or was never heartbeated). */
export function selectStaleRuns(runs: ReaperRun[], now: number, leaseMs: number): string[] {
  return runs
    .filter((r) => r.status === 'running' && (!r.heartbeat_at || now - r.heartbeat_at.getTime() >= leaseMs))
    .map((r) => r.id);
}

/** Pure selector: an offer stuck 'parsing' past the lease. */
export function selectStaleOffers(offers: ReaperOffer[], now: number, leaseMs: number): string[] {
  return offers
    .filter(
      (o) => o.normalization_status === 'parsing' && (!o.updated_at || now - o.updated_at.getTime() >= leaseMs),
    )
    .map((o) => o.id);
}

export interface ReaperSummary {
  runs_reverted: number;
  requests_reverted: number;
  offers_reverted: number;
}

/**
 * The persistence surface, injected so the M3 reaper unit test can prove the transactional
 * revert (run -> partial AND owning request -> pending, together) against an in-memory store.
 */
export interface ReaperStore {
  /** Revert stale runs to 'partial' AND their owning 'deriving' requests to 'pending', together. */
  reapStaleRuns(orgId: string, leaseMs: number): Promise<{ runs_reverted: number; requests_reverted: number }>;
  /** Revert offers stuck 'parsing' past the lease to 'failed'. */
  reapStaleOffers(orgId: string, leaseMs: number): Promise<number>;
}

export async function reapOrg(
  store: ReaperStore,
  orgId: string,
  leaseMs = DEFAULT_REAPER_LEASE_MS,
): Promise<ReaperSummary> {
  const runs = await store.reapStaleRuns(orgId, leaseMs);
  const offers = await store.reapStaleOffers(orgId, leaseMs);
  return { runs_reverted: runs.runs_reverted, requests_reverted: runs.requests_reverted, offers_reverted: offers };
}
