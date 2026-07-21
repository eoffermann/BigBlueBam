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
 * (Update, issue #87: api/basis/braid/bulwark have SINCE been fixed to bind correctly - they now
 * reserve a connection per request and set the GUC on it via a transparent db proxy. The
 * description below is the historical inert state that motivated Burn's choice; Burn still prefers
 * the transaction primitive for the leak-proofing and snapshot reasons given.)
 *
 * Burn deliberately does NOT copy the older standalone rls plugin form the four services above
 * originally used. That form issued, as a preHandler:
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
 * "any query anywhere in the request is magically scoped". That is the correct trade: it
 * is visible in the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES *NOT* GUARANTEE TODAY (issue #90). READ THIS BEFORE RELYING ON IT.
 *
 * An earlier version of this comment claimed that "a route that forgets `runInOrgScope`
 * reads zero rows rather than reading everyone's rows." That is fail-closed language and
 * it is NOT currently true. It holds only when the CONNECTING ROLE does not bypass RLS, and
 * in every environment this repository can produce it does:
 *
 *   - Every service connects with the `POSTGRES_USER` credentials (`bigbluebam`), the only
 *     login role in the cluster, and that role is a Postgres SUPERUSER. Superusers bypass
 *     RLS unconditionally: `rolbypassrls` is not consulted and `ALTER ROLE ... NOBYPASSRLS`
 *     cannot change it. Arming RLS needs a separate non-superuser application role in
 *     `DATABASE_URL`, which is a platform change, not an env-var flip.
 *   - `BBB_RLS_ENFORCE` is set in no compose file, no .env.example, no deploy adapter, and
 *     no service catalog entry in this repository. `apps/api`'s `rls-boot.ts` is doubly
 *     inert as a result: it targets `DATABASE_ROLE || 'bam_app'`, no such role exists, and
 *     it logs "database role not found, skipping role flip" without issuing any ALTER.
 *
 * So the real position is: the mechanism below is correct and WILL be fail-closed once the
 * platform posture allows it, but today the backstop is absent. All 14 `burn_*` policies
 * are present and unevaluated, and the app-level `organization_id` predicate in each query
 * is the ONLY tenant boundary. Write every query as if there were no RLS at all, because
 * right now there effectively is not.
 *
 * `boot/assert-rls-bound.ts` reads the effective posture out of `pg_roles` at boot and logs
 * `rls_backstop: 'absent'` at fatal level, so this is observable rather than assumed, and
 * `test/rls-backstop.test.ts` is a standing probe that starts passing the day the platform
 * flips. Neither refuses to start, because the bypass is the platform default and not a
 * burn-api misconfiguration.
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
