import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Scope-library visibility + immutability (spec 6.1 / M3 item 8). Two halves:
 *   1. GLOBALS ARE VISIBLE - the built-in rows seeded by migration 0253 exist as
 *      (organization_id IS NULL, is_global = true) and are readable.
 *   2. ORG CALLERS CANNOT MUTATE GLOBALS - the BEFORE trigger raises
 *      BURSAR_GLOBAL_LIBRARY_IMMUTABLE (insufficient_privilege) for any UPDATE/DELETE of a
 *      global row while app.current_org_id is bound (i.e. an org request). This is defense in
 *      depth behind the API's is_global = false write filter. The variant RLS policy shape is
 *      asserted separately in rls-coverage.test.ts.
 *
 * CI provides a migrated Postgres and DATABASE_URL. When it is absent the suite SKIPS LOUDLY.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bursar-api/library-visibility] SKIPPING: DATABASE_URL is not set, so the global-library ' +
      'visibility + immutability guarantees cannot be verified. Point DATABASE_URL at a migrated ' +
      'database (the compose stack or a CI service container) to exercise it.',
  );
}

const ORG = '00000000-0000-0000-0000-0000b012ab01';

describe.skipIf(!DATABASE_URL)('bursar_scope_library globals', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('half 1: the built-in globals are seeded and visible (organization_id NULL, is_global)', async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bursar_scope_library WHERE is_global AND organization_id IS NULL`;
    expect(rows[0]!.n).toBeGreaterThanOrEqual(12);
  });

  it('half 2a: an org caller cannot UPDATE a global row (trigger raises insufficient_privilege)', async () => {
    const [g] = await sql<Array<{ id: string }>>`
      SELECT id FROM bursar_scope_library WHERE is_global LIMIT 1`;
    expect(g).toBeTruthy();
    let raised: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${ORG}, true)`;
        await tx`UPDATE bursar_scope_library SET title = title || ' (tampered)' WHERE id = ${g!.id}`;
      });
    } catch (err) {
      raised = err;
    }
    expect(raised, 'org caller UPDATE of a global must be rejected').toBeTruthy();
    expect(String((raised as { message?: string })?.message ?? raised)).toMatch(/BURSAR_GLOBAL_LIBRARY_IMMUTABLE/);
  });

  it('half 2b: an org caller cannot DELETE a global row', async () => {
    const [g] = await sql<Array<{ id: string }>>`
      SELECT id FROM bursar_scope_library WHERE is_global LIMIT 1`;
    let raised: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${ORG}, true)`;
        await tx`DELETE FROM bursar_scope_library WHERE id = ${g!.id}`;
      });
    } catch (err) {
      raised = err;
    }
    expect(raised, 'org caller DELETE of a global must be rejected').toBeTruthy();
    expect(String((raised as { message?: string })?.message ?? raised)).toMatch(/BURSAR_GLOBAL_LIBRARY_IMMUTABLE/);
  });

  it('the globals survive the rejected mutations (nothing was tampered)', async () => {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bursar_scope_library WHERE is_global AND title LIKE '%(tampered)%'`;
    expect(rows[0]!.n).toBe(0);
  });
});
