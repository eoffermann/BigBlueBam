import { sql, type SQL } from 'drizzle-orm';

/**
 * Per-org transaction-scoped advisory lock for the SQL-only sweeps (spec 4.0, R2-T1 / R2-B2 /
 * R3-T1).
 *
 * Burn does NOT copy the defective session-scoped `pg_try_advisory_lock` at
 * `apps/bulwark-api/src/services/sweeps.service.ts:41-52` (acquire and release split across
 * pooled connections, leak on failure). It uses `pg_try_advisory_xact_lock` acquired INSIDE
 * the sweep transaction, following the genuine precedent at
 * `apps/braid-api/src/lib/advisory-lock.ts:79`. A transaction-scoped lock is released by
 * commit or rollback, so it is immune to pool routing and cannot leak. There is no unlock
 * call to get wrong.
 *
 * HARD RULE (spec 4.0 point 4): no transaction holding this lock may contain an outbound HTTP
 * call. `pg_advisory_xact_lock` cannot outlive its transaction, so wrapping an LLM or bill-api
 * round trip in it would either run a whole chunked extraction in one transaction (defeating
 * the per-chunk checkpoint) or hold long idle-in-transaction sessions on the highest-churn
 * table. The extraction and attribution engines therefore use row CLAIMS, never this lock. The
 * only jobs that take it are the SQL-only sweeps: variance, silent-deliverable, rollup-refresh,
 * calibration, retention, revalue (revalue resolves rates BEFORE the lock, see
 * revaluation.engine.ts).
 *
 * ALL Burn SQL sweeps for one org share ONE lock (a single class hash), so two concurrent
 * sweeps for the same org serialize: the second `try` returns false and the caller emits a
 * counted skip log rather than blocking or silently no-op'ing (spec 4.0 point 3).
 */

// A single class token for every Burn SQL sweep, so all sweeps for one org contend on one lock.
const BURN_SWEEP_CLASS = 'burn.sweep';

// FNV-1a 32-bit -> signed int4 (matches braid-api/src/lib/advisory-lock.ts).
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export interface AdvisoryLockTx {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Try to acquire the per-org sweep advisory lock inside the current transaction. Returns true
 * when acquired (held until commit/rollback), false when another sweep for this org holds it.
 * NON-blocking: uses `pg_try_advisory_xact_lock` so a contended sweep skips rather than queues.
 */
export async function tryOrgSweepLock(tx: AdvisoryLockTx, orgId: string): Promise<boolean> {
  const classHash = hash32(BURN_SWEEP_CLASS);
  const keyHash = hash32(orgId);
  const raw = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(${classHash}, ${keyHash}) AS locked`,
  );
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Array<{
    locked: boolean;
  }>;
  return rows[0]?.locked === true;
}
