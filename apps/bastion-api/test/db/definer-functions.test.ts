import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Hardened definer functions (spec 3.1, migrations 0274/0278/0279).
 *
 * Asserts, against a migrated database, on EVERY pg_proc row named bastion_%:
 *   - proconfig pins search_path = pg_catalog, public, pg_temp (pg_temp last);
 *   - proacl grants no PUBLIC execute: it is owner-only (today's real posture, because no
 *     bam_app role exists) or owner + bam_app when that role exists, and bam_app is granted
 *     only on SECURITY DEFINER functions;
 * and, for the probes, that each is SECURITY DEFINER and STABLE and that the org guard refuses a
 * call outside a matching app.current_org_id scope.
 *
 * CI's Vitest job runs this suite against the freshly migrated service container (see
 * .github/workflows/test.yml: the migrate-runner step and the job-level DATABASE_URL; db-drift.yml
 * runs no vitest). Locally, point DATABASE_URL at the compose postgres. Without
 * DATABASE_URL the suite SKIPS LOUDLY rather than silently passing.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bastion-api/definer-functions] SKIPPING: DATABASE_URL is not set, so the proconfig/proacl ' +
      'hardening of the bastion_% functions cannot be verified. Point DATABASE_URL at a migrated database.',
  );
}

const SEARCH_PATH = 'search_path=pg_catalog, public, pg_temp';
const ORG_A = '00000000-0000-0000-0000-0000ba570001';
const ORG_B = '00000000-0000-0000-0000-0000ba570002';

interface ProcRow {
  proname: string;
  signature: string;
  proconfig: string[] | null;
  acl: string[] | null;
  owner: string;
  prosecdef: boolean;
  provolatile: string;
}

describe.skipIf(!DATABASE_URL)('bastion_% definer-function hardening', () => {
  let sql: postgres.Sql;
  let procs: ProcRow[];
  let bamAppExists: boolean;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    procs = await sql<ProcRow[]>`
      SELECT p.proname,
             p.oid::regprocedure::text AS signature,
             p.proconfig,
             p.proacl::text[] AS acl,
             pg_get_userbyid(p.proowner) AS owner,
             p.prosecdef,
             p.provolatile
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname LIKE 'bastion\\_%'
       ORDER BY p.proname`;
    const roles = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'bam_app'`;
    bamAppExists = roles.length > 0;
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('finds the Bastion functions (a zero-row result would silently pass)', () => {
    // 20 probes + guard + result helper + 2 resolvers + purge + 2 trigger functions.
    expect(procs.length).toBeGreaterThanOrEqual(27);
  });

  it('pins search_path = pg_catalog, public, pg_temp on every bastion_% function', () => {
    const bad = procs.filter((p) => !(p.proconfig ?? []).includes(SEARCH_PATH)).map((p) => p.signature);
    expect(bad, `functions without the pinned search_path: ${bad.join(', ')}`).toEqual([]);
  });

  it('grants no PUBLIC execute: owner-only, or owner + bam_app on definer functions', () => {
    const problems: string[] = [];
    for (const p of procs) {
      // A NULL proacl means the DEFAULT privileges, which include EXECUTE to PUBLIC.
      if (!p.acl) {
        problems.push(`${p.signature}: proacl is NULL (default privileges grant PUBLIC execute)`);
        continue;
      }
      for (const entry of p.acl) {
        const grantee = entry.split('=')[0] ?? '';
        if (grantee === '') problems.push(`${p.signature}: PUBLIC entry ${entry}`);
        else if (grantee === p.owner) continue;
        else if (grantee === 'bam_app' && p.prosecdef) continue;
        else problems.push(`${p.signature}: unexpected grantee in ${entry}`);
      }
      const ownerEntry = p.acl.find((e) => e.startsWith(`${p.owner}=`));
      if (!ownerEntry || !ownerEntry.split('=')[1]?.includes('X')) {
        problems.push(`${p.signature}: owner has no execute`);
      }
      if (bamAppExists && p.prosecdef && !p.acl.some((e) => e.startsWith('bam_app=X'))) {
        problems.push(`${p.signature}: bam_app exists but has no execute on a definer function`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('makes every probe and resolver a STABLE SECURITY DEFINER function', () => {
    const entry = procs.filter(
      (p) => /^bastion_probe_.+_v\d+$/.test(p.proname) || p.proname.startsWith('bastion_resolve_'),
    );
    expect(entry.length).toBe(22);
    const bad = entry.filter((p) => !p.prosecdef || p.provolatile !== 's').map((p) => p.signature);
    expect(bad).toEqual([]);
  });

  it('org guard: a probe refuses a call with no org scope or another org in scope', async () => {
    const outcomes: string[] = [];
    for (const scope of [null, ORG_B]) {
      try {
        await sql.begin(async (tx) => {
          if (scope) await tx`SELECT set_config('app.current_org_id', ${scope}, true)`;
          await tx`SELECT bastion_probe_keys_max_age_v1(${ORG_A}::uuid, now(), '{}'::jsonb)`;
        });
        outcomes.push('ran');
      } catch (err) {
        outcomes.push((err as { code?: string }).code ?? String(err));
      }
    }
    expect(outcomes).toEqual(['42501', '42501']);
  });

  it('org guard: a probe runs inside a matching org scope and returns the result contract', async () => {
    let result: Record<string, unknown> | null = null;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${ORG_A}, true)`;
      const rows = await tx<Array<{ r: Record<string, unknown> }>>`
        SELECT bastion_probe_keys_max_age_v1(${ORG_A}::uuid, now(), '{"max_age_days": 30}'::jsonb) AS r`;
      result = rows[0]?.r ?? null;
    });
    expect(result).toMatchObject({
      probe_key: 'keys.max_age',
      probe_version: 1,
      cited_refs: [],
      cited_count: 0,
      overflow_count: 0,
      summary: { keys_checked: 0, max_age_days: 30 },
    });
  });

  it('resolvers return only (id, org_id) and nothing for an unknown credential', async () => {
    const cols = await sql`
      SELECT p.proname, pg_get_function_result(p.oid) AS result
        FROM pg_proc p WHERE p.proname IN ('bastion_resolve_feed_key', 'bastion_resolve_room')
       ORDER BY 1`;
    expect(cols.map((c) => c.result)).toEqual(['TABLE(id uuid, org_id uuid)', 'TABLE(id uuid, org_id uuid)']);
    const none = await sql`SELECT * FROM bastion_resolve_feed_key('bkf_does_not_exist')`;
    expect(none.length).toBe(0);
  });
});
