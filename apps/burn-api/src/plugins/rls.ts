import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { db, type DbTx } from '../db/index.js';
import { env } from '../env.js';

/**
 * Row-level security binding for burn-api (spec 2.4 point 14).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH MECHANISM WE CHOSE, AND WHY (this is the load-bearing comment).
 *
 * Burn deliberately does NOT copy the four existing rls plugins
 * (`apps/api/src/plugins/rls.ts:38`, basis `:29`, braid `:30`, bulwark `:30`). All four
 * issue, as a preHandler:
 *
 *     await db.execute(sql`SELECT set_config('app.current_org_id', $1, true)`)
 *
 * The third argument to `set_config` is `is_local`. `is_local = true` scopes the setting
 * to the CURRENT TRANSACTION. A standalone statement on a pooled connection is its own
 * implicit transaction, which commits the instant the statement returns, so the GUC is
 * discarded immediately and every subsequent query in that request runs with
 * `app.current_org_id` unset. Those plugins are inert today only because the app role
 * still has BYPASSRLS; the moment the platform flips BBB_RLS_ENFORCE=1 every policy
 * evaluates `NULL = organization_id` and each of those services returns zero rows.
 *
 * There were two honest fixes:
 *
 *   (A) `set_config(..., false)` (session-scoped) on a connection explicitly checked out
 *       for the request, reset on release.
 *   (B) Bind the request's queries into ONE transaction with `set_config(..., true)`
 *       inside it.
 *
 * Burn chooses (B). Option (A) requires holding a pooled connection for the whole request
 * lifetime and guaranteeing a reset on every exit path including thrown errors and client
 * disconnects; a single missed reset leaks one org's GUC onto a connection that the next
 * request for a different org then reuses, which is a cross-tenant read, silent and
 * intermittent. Option (B) cannot leak: the GUC dies with the transaction, on commit and
 * on rollback alike, with no cleanup path to forget. It also gives Burn's money reads a
 * consistent snapshot for free, which matters because a single financials response joins
 * work items, attributions, deliverables, and rollups and must not straddle a
 * `burn-revalue` write.
 *
 * The cost of (B) is that org-scoped DB work must go through `runInOrgScope`, rather than
 * "any query anywhere in the request is magically scoped". That is the correct trade:
 * it is visible in the code, and a route that forgets it reads zero rows under enforce
 * mode rather than reading everyone's rows.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Org-less paths are handled by the same primitive with an explicit org argument:
 *   - internal routes (`/v1/internal/*`) derive the org from the VALIDATED payload and
 *     call `runInOrgScope(orgId, ...)` directly;
 *   - org-iterating jobs (`burn-claim-reaper`, `burn-retention`,
 *     `burn-calibration-recompute`) take the per-org advisory lock and call it per org,
 *     rather than one global scan that would return zero rows under enforce mode.
 */

export class OrgScopeMissingError extends Error {
  constructor() {
    super(
      'runInOrgScope called with no organization id. Every burn-api query that touches a ' +
        'burn_* table must run inside an org-scoped transaction so the RLS policies bind.',
    );
    this.name = 'OrgScopeMissingError';
  }
}

/**
 * Runs `fn` inside a single transaction whose `app.current_org_id` GUC is set with
 * `is_local = true`, so the RLS policies on every `burn_*` table bind for the duration
 * and the setting is discarded on both commit and rollback.
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
  interface FastifyRequest {
    /**
     * Runs `fn` in a transaction bound to the caller's active org. Throws
     * OrgScopeMissingError on an unauthenticated request, which is deliberate: an
     * org-less caller must never reach an org-scoped query.
     */
    orgScope<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  }
  interface FastifyInstance {
    runInOrgScope: typeof runInOrgScope;
  }
}

const rlsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const enforce = env.BBB_RLS_ENFORCE === '1';

    fastify.decorate('runInOrgScope', runInOrgScope);

    fastify.decorateRequest('orgScope', function <T>(this: FastifyRequest, fn: (tx: DbTx) => Promise<T>) {
      return runInOrgScope(this.user?.active_org_id, fn);
    });

    fastify.log.info(
      { enforce, mechanism: 'transaction_scoped_set_config_local' },
      enforce
        ? 'burn-api rls binding registered (transaction-scoped GUC, NOBYPASSRLS enforce mode)'
        : 'burn-api rls binding registered (transaction-scoped GUC, advisory mode)',
    );
  },
  { name: 'rls' },
);

export default rlsPlugin;
