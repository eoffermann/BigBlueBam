import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db, type DbTx } from '../db/index.js';
import { env } from '../env.js';

/**
 * Row-level security binding for bursar-api (spec 6.3).
 *
 * This is burn-api's `runInOrgScope` mechanism, adopted deliberately rather than the older
 * standalone form apps/api, basis-api, braid-api, and bulwark-api originally used. (Update, issue
 * #87: those four have since been fixed to bind correctly via a per-request reserved connection;
 * the description below is the historical inert state.) That older form issued, as a preHandler:
 *
 *     await db.execute(sql`SELECT set_config('app.current_org_id', $1, true)`)
 *
 * The third argument to `set_config` is `is_local`, which scopes the setting to the CURRENT
 * TRANSACTION. A standalone statement on a pooled connection is its own implicit transaction
 * and commits the instant it returns, so the GUC is discarded before the next query runs and
 * every subsequent statement in that request executes with `app.current_org_id` unset. Those
 * services are inert today only because the connecting role still bypasses RLS; the moment
 * the platform arms enforcement, each of them returns zero rows.
 *
 * Binding the request's org-scoped work into ONE transaction cannot leak: the GUC dies with
 * the transaction on commit and on rollback alike, with no cleanup path to forget. The cost
 * is that org-scoped DB work must go through `runInOrgScope` rather than being magically
 * scoped, which is the correct trade because it is visible in the code.
 *
 * WHAT THIS DOES NOT GUARANTEE TODAY. Every service connects as the only login role in the
 * cluster, which is a Postgres SUPERUSER, and superusers bypass RLS unconditionally. So the
 * mechanism below is correct and WILL be fail-closed once the platform posture allows it,
 * but today the backstop is absent and the explicit `organization_id` predicate in each
 * query is the ONLY tenant boundary. Write every Bursar query as if there were no RLS at
 * all, because right now there effectively is not. `boot/assert-rls-bound.ts` (M1) reports
 * the effective posture so this is observable rather than assumed.
 *
 * Org-less paths use the same primitive with an explicit org argument: internal routes
 * derive the org from the VALIDATED payload and call `runInOrgScope(orgId, ...)` directly,
 * and org-iterating jobs take the per-org advisory lock and call it once per org rather than
 * running one global scan that would return zero rows under enforce mode.
 */

export class OrgScopeMissingError extends Error {
  constructor() {
    super(
      'runInOrgScope called with no organization id. Every bursar-api query that touches a ' +
        'bursar_* table must run inside an org-scoped transaction so the RLS policies bind.',
    );
    this.name = 'OrgScopeMissingError';
  }
}

/**
 * Runs `fn` inside a single transaction whose `app.current_org_id` GUC is set with
 * `is_local = true`, so the RLS policies on every `bursar_*` table bind for the duration and
 * the setting is discarded on both commit and rollback.
 */
export async function runInOrgScope<T>(
  orgId: string | null | undefined,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (!orgId) throw new OrgScopeMissingError();
  return db.transaction(async (tx) => {
    // is_local=true is correct HERE and only here: we are inside a real transaction.
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    runInOrgScope: typeof runInOrgScope;
  }
}

// M0 NOTE: the per-request `request.orgScope(fn)` convenience wrapper (which reads the
// caller's active org off `request.user`) lands with the auth plugin at M2. It is
// deliberately absent here rather than stubbed, because a stub would have to invent a
// `request.user` type that the real auth plugin then has to merge with. `runInOrgScope`
// itself is the primitive and is complete.

const rlsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const enforce = env.BBB_RLS_ENFORCE === '1';

    fastify.decorate('runInOrgScope', runInOrgScope);

    fastify.log.info(
      { enforce, mechanism: 'transaction_scoped_set_config_local' },
      enforce
        ? 'bursar-api rls binding registered (transaction-scoped GUC, NOBYPASSRLS enforce mode)'
        : 'bursar-api rls binding registered (transaction-scoped GUC, advisory mode)',
    );
  },
  { name: 'rls' },
);

export default rlsPlugin;
