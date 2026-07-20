import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Standing probe of bursar-api's ROW-LEVEL-SECURITY backstop (spec 6.3).
 *
 * `plugins/rls.ts` binds `app.current_org_id` inside a real transaction, which is the correct
 * mechanism, and migration 0251 puts an org-isolation policy on every bursar_* table. The
 * question this file answers is whether any of that is ARMED.
 *
 * It is not, today, and the cause is not the one the env var suggests. Every service in the
 * compose stack connects with the `POSTGRES_USER` credentials (`bigbluebam`), the only login
 * role in the cluster, and that role has `rolsuper = true`. A Postgres SUPERUSER bypasses RLS
 * unconditionally: `rolbypassrls` is not consulted, and `ALTER ROLE ... NOBYPASSRLS` has no
 * effect while `rolsuper` is set. Separately, `BBB_RLS_ENFORCE` is set nowhere in this
 * repository. Under either the policies are not evaluated and a bare select returns every
 * organization's rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SUITE SKIPS UNDER THE CURRENT PLATFORM POSTURE, ON PURPOSE.
 *
 * It is a probe with a precise trigger: it starts running the moment the connecting role
 * stops bypassing RLS. TO MAKE IT RUN, the role that `DATABASE_URL` connects as must be BOTH
 * non-superuser AND NOBYPASSRLS:
 *
 *     CREATE ROLE bam_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
 *     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bam_app;
 *     GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bam_app;
 *
 * then point `DATABASE_URL` at `bam_app` and set `BBB_RLS_ENFORCE=1`. Nothing in bursar-api
 * needs to change. If it runs and FAILS, the RLS policies are not doing what migration 0251
 * says they do, and every bursar_* query is relying entirely on its own organization_id
 * predicate. That is a release blocker, not a flake.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_A = '00000000-0000-0000-0000-0000b0a50001';
const ORG_B = '00000000-0000-0000-0000-0000b0a50002';
const USER_A = '00000000-0000-0000-0000-0000b0a50003';
const USER_B = '00000000-0000-0000-0000-0000b0a50004';

/**
 * Reads the effective posture up front so the skip reason can name the actual cause rather
 * than lumping "no database" together with "bypass is on".
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
          `${row.rolsuper ? 'it is a Postgres SUPERUSER' : 'it has BYPASSRLS'}, so the bursar_* ` +
          'policies are not evaluated and this probe cannot prove anything. This is the ' +
          'platform default, not a bursar-api misconfiguration. TO RUN THIS TEST: point ' +
          'DATABASE_URL at a role that is BOTH NOSUPERUSER and NOBYPASSRLS (see the header ' +
          'comment for the exact DDL). Setting BBB_RLS_ENFORCE=1 alone is NOT sufficient ' +
          'while the connecting role is a superuser. See spec 6.3.',
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
  console.warn(`[bursar-api/rls-backstop] SKIPPING: ${skipReason}`);
}

describe.skipIf(skipReason !== null)('bursar_vendors RLS org isolation', () => {
  let sql: postgres.Sql;

  /**
   * Mirrors runInOrgScope: one transaction, GUC set with is_local = true inside it. Every
   * statement runs through this, including the organizations/users fixtures, because under a
   * genuinely NOBYPASSRLS role those tables carry their own org-isolation policies.
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
      [ORG_A, USER_A, 'bursar-rls-org-a'],
      [ORG_B, USER_B, 'bursar-rls-org-b'],
    ] as const) {
      await inOrgScope(org, async (tx) => {
        await tx`
          INSERT INTO organizations (id, name, slug)
          VALUES (${org}, ${`Bursar RLS ${slug}`}, ${slug})
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
        await tx`DELETE FROM bursar_vendors WHERE organization_id = ${org}`;
        await tx`DELETE FROM users WHERE id = ${user}`;
        await tx`DELETE FROM organizations WHERE id = ${org}`;
      });
    }
    await sql.end({ timeout: 5 });
  });

  it('returns only the scoped org rows from a bare select with no organization_id predicate', async () => {
    await inOrgScope(ORG_A, async (tx) => {
      await tx`
        INSERT INTO bursar_vendors (organization_id, display_name, created_by)
        VALUES (${ORG_A}, 'RLS Vendor A', ${USER_A})`;
    });
    await inOrgScope(ORG_B, async (tx) => {
      await tx`
        INSERT INTO bursar_vendors (organization_id, display_name, created_by)
        VALUES (${ORG_B}, 'RLS Vendor B', ${USER_B})`;
    });

    // Deliberately NO `where organization_id = ...`. The policy is the only thing that can
    // keep org B out of this result set.
    const rows = await inOrgScope(ORG_A, async (tx) => {
      return tx<Array<{ organization_id: string; display_name: string }>>`
        SELECT organization_id, display_name FROM bursar_vendors`;
    });

    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);
    expect(rows[0].display_name).toBe('RLS Vendor A');
  });

  it('never leaks rows when the org scope is not bound', async () => {
    // The fail-closed half of the claim in plugins/rls.ts. It resolves two ways and both are
    // fail-closed: an unset GUC yields NULL (empty read); a pooled connection that reset to
    // the empty string yields ''::uuid -> 22P02 (the read errors). Either is safe.
    let rows: Array<{ organization_id: string }> = [];
    let errCode: string | undefined;
    try {
      rows = await sql<Array<{ organization_id: string }>>`
        SELECT organization_id FROM bursar_vendors`;
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
