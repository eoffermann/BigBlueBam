import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Standing probe of burn-api's ROW-LEVEL-SECURITY backstop (issue #90).
 *
 * `plugins/rls.ts` binds `app.current_org_id` inside a real transaction, which is the
 * correct mechanism, and migrations 0239/0240/0241 put an org-isolation policy on all 14
 * `burn_*` tables. The question this file answers is whether any of that is ARMED.
 *
 * It is not, today, and the cause is not the one the env var suggests. Every service in
 * the compose stack connects with the `POSTGRES_USER` credentials (`bigbluebam`), the only
 * login role in the cluster, and that role has `rolsuper = true`. A Postgres SUPERUSER
 * bypasses RLS unconditionally: `rolbypassrls` is not consulted, and `ALTER ROLE ...
 * NOBYPASSRLS` has no effect while `rolsuper` is set. Separately, `BBB_RLS_ENFORCE` is set
 * nowhere in this repository, and `apps/api`'s `rls-boot.ts` targets `DATABASE_ROLE ||
 * 'bam_app'`, a role that does not exist, so it currently issues no ALTER at all and logs
 * "database role not found, skipping role flip". Under any of these the policies are not
 * evaluated and a bare select returns every organization's rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SUITE SKIPS UNDER THE CURRENT PLATFORM POSTURE, ON PURPOSE.
 *
 * It is not a broken test and it is not aspirational scaffolding. It is a probe with a
 * precise trigger: it starts running the moment the connecting role stops bypassing RLS.
 *
 * TO MAKE IT RUN, the role that `DATABASE_URL` connects as must be BOTH non-superuser AND
 * NOBYPASSRLS. Setting `BBB_RLS_ENFORCE=1` alone is NOT enough. Concretely:
 *
 *     CREATE ROLE bam_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
 *     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bam_app;
 *     GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bam_app;
 *
 * then point `DATABASE_URL` at `bam_app` and set `BBB_RLS_ENFORCE=1` so apps/api's
 * `rls-boot.ts` keeps it NOBYPASSRLS. Nothing in burn-api needs to change.
 *
 * If it runs and FAILS, the RLS policies are not doing what migrations 0239/0240/0241 say
 * they do, and every burn_* query is relying entirely on its own `organization_id`
 * predicate. That is a release blocker, not a flake.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_A = '00000000-0000-0000-0000-00000b0f0001';
const ORG_B = '00000000-0000-0000-0000-00000b0f0002';
const USER_A = '00000000-0000-0000-0000-00000b0f0003';
const USER_B = '00000000-0000-0000-0000-00000b0f0004';

/**
 * Reads the effective posture up front so the skip reason can name the actual cause
 * rather than lumping "no database" together with "bypass is on".
 */
async function readPosture(): Promise<{ skipReason: string | null }> {
  if (!DATABASE_URL) {
    return {
      skipReason:
        'DATABASE_URL is not set, so the RLS backstop cannot be probed. Point DATABASE_URL ' +
        'at a migrated database (compose stack or CI service container) to exercise it.',
    };
  }
  const probe = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await probe<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT current_user::text AS role, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`;
    const row = rows[0];
    if (!row) {
      return { skipReason: 'current_user was not found in pg_roles, so the posture is unknown.' };
    }
    if (row.rolsuper || row.rolbypassrls) {
      return {
        skipReason:
          `RLS BACKSTOP ABSENT: role '${row.role}' bypasses row-level security because ` +
          `${row.rolsuper ? 'it is a Postgres SUPERUSER' : 'it has BYPASSRLS'}, so the burn_* ` +
          'policies are not evaluated and this probe cannot prove anything. This is the ' +
          'platform default, not a burn-api misconfiguration. TO RUN THIS TEST: point ' +
          'DATABASE_URL at a role that is BOTH NOSUPERUSER and NOBYPASSRLS (see the header ' +
          'comment for the exact DDL). Setting BBB_RLS_ENFORCE=1 alone is NOT sufficient ' +
          'while the connecting role is a superuser. See issue #90.',
      };
    }
    return { skipReason: null };
  } catch (err) {
    return {
      skipReason: `Could not read pg_roles: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await probe.end({ timeout: 5 });
  }
}

const { skipReason } = await readPosture();

if (skipReason) {
  console.warn(`[burn-api/rls-backstop] SKIPPING: ${skipReason}`);
}

describe.skipIf(skipReason !== null)('burn_cost_rates RLS org isolation', () => {
  let sql: postgres.Sql;

  /**
   * Mirrors runInOrgScope: one transaction, GUC set with is_local = true inside it.
   *
   * EVERY statement here runs through this, including the organizations/users fixtures.
   * That is not ceremony: under a genuinely NOBYPASSRLS role those tables carry their own
   * org-isolation policies, and an unscoped fixture insert fails with "new row violates
   * row-level security policy for table organizations" before the probe ever runs. Each
   * org's rows must also be written under its OWN scope, because the burn_* policies are
   * FOR ALL with a USING clause and no separate WITH CHECK, so Postgres reuses USING as
   * the insert check.
   */
  async function inOrgScope<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 4, onnotice: () => {} });
    for (const [org, user, slug] of [
      [ORG_A, USER_A, 'burn-rls-org-a'],
      [ORG_B, USER_B, 'burn-rls-org-b'],
    ] as const) {
      await inOrgScope(org, async (tx) => {
        await tx`
          INSERT INTO organizations (id, name, slug)
          VALUES (${org}, ${`Burn RLS ${slug}`}, ${slug})
          ON CONFLICT (id) DO NOTHING`;
        await tx`
          INSERT INTO users (id, org_id, email, display_name, password_hash,
                             is_active, is_superuser, email_verified, kind)
          VALUES (${user}, ${org}, ${`${slug}@bigbluebam.internal`}, ${slug}, '!',
                  true, false, true, 'service')
          ON CONFLICT (id) DO NOTHING`;
      });
    }
  });

  afterAll(async () => {
    if (!sql) return;
    for (const [org, user] of [
      [ORG_A, USER_A],
      [ORG_B, USER_B],
    ] as const) {
      await inOrgScope(org, async (tx) => {
        await tx`DELETE FROM burn_cost_rates WHERE organization_id = ${org}`;
        await tx`DELETE FROM users WHERE id = ${user}`;
        await tx`DELETE FROM organizations WHERE id = ${org}`;
      });
    }
    await sql.end({ timeout: 5 });
  });

  it('returns only the scoped org rows from a bare select with no organization_id predicate', async () => {
    await inOrgScope(ORG_A, async (tx) => {
      await tx`
        INSERT INTO burn_cost_rates (organization_id, user_id, cost_amount, created_by)
        VALUES (${ORG_A}, ${USER_A}, 19500, ${USER_A})`;
    });
    await inOrgScope(ORG_B, async (tx) => {
      await tx`
        INSERT INTO burn_cost_rates (organization_id, user_id, cost_amount, created_by)
        VALUES (${ORG_B}, ${USER_B}, 47000, ${USER_B})`;
    });

    // Deliberately NO `where organization_id = ...`. The policy is the only thing that
    // can keep org B out of this result set, which is the entire point of the probe.
    const rows = await inOrgScope(ORG_A, async (tx) => {
      return tx<Array<{ organization_id: string; cost_amount: string }>>`
        SELECT organization_id, cost_amount FROM burn_cost_rates`;
    });

    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);
    expect(Number(rows[0].cost_amount)).toBe(19500);
  });

  it('never leaks rows when the org scope is not bound', async () => {
    // The fail-closed half of the claim in plugins/rls.ts: a query that skips
    // runInOrgScope must not read everyone's rows.
    //
    // It resolves TWO ways, and both are fail-closed, so this asserts the invariant
    // rather than one of its shapes:
    //
    //   - On a connection that has never had the GUC set, current_setting(..., true)
    //     returns NULL, NULL::uuid is NULL, the predicate is NULL, and the read is empty.
    //   - On a POOLED connection that previously ran a scoped transaction, the
    //     transaction-local set_config resets to the session value, which is now the
    //     EMPTY STRING rather than unset. ''::uuid raises 22P02
    //     (invalid input syntax for type uuid: ""), so the read errors instead.
    //
    // The second case is the common one in a real request pool, and it means an unscoped
    // burn_* query surfaces as a 500 rather than an empty result. That is safe but noisy;
    // wrapping the policy predicate in NULLIF(current_setting('app.current_org_id', true), '')
    // would make it uniformly return zero rows. Doing so needs a NEW migration, since
    // 0239/0240/0241 are already applied and immutable.
    let rows: Array<{ organization_id: string }> = [];
    let errCode: string | undefined;
    try {
      rows = await sql<Array<{ organization_id: string }>>`
        SELECT organization_id FROM burn_cost_rates`;
    } catch (err) {
      errCode = (err as { code?: string }).code;
    }
    if (errCode) {
      expect(errCode).toBe('22P02');
    } else {
      expect(rows.length).toBe(0);
    }
  });
});
