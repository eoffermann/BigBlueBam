import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db, type DbTx } from '../db/index.js';
import { env } from '../env.js';

/**
 * Row-level security binding for bastion-api, the transaction-scoped `runInOrgScope` form used
 * by bursar-api and burn-api. `set_config(..., true)` is only meaningful inside a real
 * transaction, so org-scoped work runs in one and the GUC dies with it on commit or rollback.
 *
 * Today every service connects as a Postgres superuser, which bypasses RLS, so the explicit
 * organization_id predicate in each query is the only tenant boundary. Write every Bastion
 * query as if there were no RLS. boot/assert-rls-bound.ts reports the real posture at boot.
 */

export class OrgScopeMissingError extends Error {
  constructor() {
    super(
      'runInOrgScope called with no organization id. Every bastion-api query that touches a ' +
        'bastion_* table must run inside an org-scoped transaction so the RLS policies bind.',
    );
    this.name = 'OrgScopeMissingError';
  }
}

export async function runInOrgScope<T>(
  orgId: string | null | undefined,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (!orgId) throw new OrgScopeMissingError();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    runInOrgScope: typeof runInOrgScope;
  }
}

const rlsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const enforce = env.BBB_RLS_ENFORCE === '1';
    fastify.decorate('runInOrgScope', runInOrgScope);
    fastify.log.info(
      { enforce, mechanism: 'transaction_scoped_set_config_local' },
      enforce
        ? 'bastion-api rls binding registered (transaction-scoped GUC, NOBYPASSRLS enforce mode)'
        : 'bastion-api rls binding registered (transaction-scoped GUC, advisory mode)',
    );
  },
  { name: 'rls' },
);

export default rlsPlugin;
