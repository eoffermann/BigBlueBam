// runInOrgScopeRead (spec 3.1): the read-pool twin of runInOrgScope. Probes are hardened
// SECURITY DEFINER functions that raise unless app.current_org_id names the same org, so the
// GUC must be bound on whichever connection actually runs the probe.
//
// Each call: measure replica lag on the read pool (as_of minus pg_last_xact_replay_timestamp();
// a NULL replay timestamp means the read URL is a primary, so lag is zero), fall back to the
// primary pool above MAX_REPLICA_LAG_MS, then BEGIN READ ONLY, bind the org, SET LOCAL
// statement_timeout, run the work. Built by a factory over raw postgres.js clients so the probe
// goldens can run it three ways (one pool, a separate read pool, and under a NOBYPASSRLS role).

import type postgres from 'postgres';
import { MAX_REPLICA_LAG_MS } from './budgets.js';

/** Typed as Sql for the same reason as engine/context.ts Tx (TransactionSql loses its call signature). */
export type ReadTx = postgres.Sql;

export interface OrgScopeReadOptions {
  primary: postgres.Sql;
  read: postgres.Sql;
  statementTimeoutMs: number;
  maxReplicaLagMs?: number;
  /** Test hook: runs first inside each transaction (e.g. SET LOCAL ROLE for the RLS-on golden). */
  onBegin?: (tx: ReadTx) => Promise<void>;
}

export interface OrgScopeReadResult<T> {
  value: T;
  replica_lag_ms: number;
  pool: 'read' | 'primary';
}

/** Lag in ms from a replay timestamp; NULL (not a replica) is zero lag. Pure; tested. */
export function replicaLagMs(asOf: Date, lastReplay: Date | null): number {
  if (lastReplay === null) return 0;
  return Math.max(0, asOf.getTime() - lastReplay.getTime());
}

export class OrgScopeReadMissingError extends Error {
  constructor() {
    super('runInOrgScopeRead called with no organization id.');
    this.name = 'OrgScopeReadMissingError';
  }
}

export function makeRunInOrgScopeRead(opts: OrgScopeReadOptions) {
  const maxLag = opts.maxReplicaLagMs ?? MAX_REPLICA_LAG_MS;
  return async function runInOrgScopeRead<T>(
    orgId: string,
    asOf: Date,
    fn: (tx: ReadTx) => Promise<T>,
  ): Promise<OrgScopeReadResult<T>> {
    if (!orgId) throw new OrgScopeReadMissingError();
    let pool: 'read' | 'primary' = 'primary';
    let lag = 0;
    if (opts.read !== opts.primary) {
      const rows = await opts.read`SELECT pg_last_xact_replay_timestamp() AS replay`;
      const replay = (rows[0]?.replay as Date | null | undefined) ?? null;
      lag = replicaLagMs(asOf, replay);
      pool = lag > maxLag ? 'primary' : 'read';
    }
    const client = pool === 'read' ? opts.read : opts.primary;
    const value = (await client.begin('read only', async (raw) => {
      const tx = raw as unknown as ReadTx;
      if (opts.onBegin) await opts.onBegin(tx);
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.statementTimeoutMs))}`);
      return fn(tx);
    })) as T;
    return { value, replica_lag_ms: lag, pool };
  };
}

export type RunInOrgScopeRead = ReturnType<typeof makeRunInOrgScopeRead>;
