import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * #363: every RLS policy compared org_id with current_setting('app.current_org_id', true)::uuid.
 * After a pooled connection ran a transaction-local set_config (runInOrgScope), the setting
 * exists on that connection and reads as '' once the transaction ends, so ''::uuid raised 22P02
 * on the next query with no org bound instead of matching no rows. rls-unauthenticated.db.test.ts
 * only passed by which pooled connection it happened to get. Migration 0355 rewrites every policy
 * to NULLIF(current_setting(...), '')::uuid.
 *
 * Same environment contract as rls-unauthenticated.db.test.ts: CI provides DATABASE_URL
 * (superuser, used to seed) and RLS_PROBE_DATABASE_URL (the NOSUPERUSER NOBYPASSRLS bbb_rls_probe
 * role from scripts/ci/create-rls-probe-role.sql). Locally, point both at a throwaway migrated
 * Postgres. Skips without them; fails in CI.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_URL = process.env.RLS_PROBE_DATABASE_URL;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const usable =
  !!ADMIN_URL && !!PROBE_URL && !ADMIN_URL.includes('test:test@localhost:5432/test') && PROBE_URL !== ADMIN_URL;

// The api's pool (db/index.ts) opens at most this many connections.
const POOL_MAX = 20;

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.RLS_PROBE_DATABASE_URL ?? 'postgres://x@localhost:1/x',
    BBB_RLS_ENFORCE: true,
    NODE_ENV: 'test',
  },
}));

if (IN_CI && !usable) {
  describe('RLS with an emptied org GUC on a pooled connection (#363)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('RLS with an emptied org GUC on a pooled connection (#363)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 1, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgA = randomUUID();
  const projA = randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${orgA}, 'Gilligan Travel GUC', ${`rls-guc-${tag}`})`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix)
      VALUES (${projA}, ${orgA}, 'Coconut Radio', ${`coconut-guc-${tag}`}, 'CRG')`;
    dbModule = await import('../src/db/index.js');
  });

  afterAll(async () => {
    await admin`DELETE FROM projects WHERE id = ${projA}`;
    await admin`DELETE FROM organizations WHERE id = ${orgA}`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  it('runs on a role that does not bypass RLS', async () => {
    const rows = await dbModule.queryClient`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('an unbound query on a connection that ran a transaction-local set_config sees no rows, not 22P02', async () => {
    const one = postgres(PROBE_URL ?? '', { max: 1, onnotice: () => {} });
    try {
      // max: 1, so BEGIN, the scoped read and COMMIT all run on the one connection.
      await one`BEGIN`;
      await one`SELECT set_config('app.current_org_id', ${orgA}, true)`;
      const inside = await one`SELECT count(*)::int AS n FROM projects WHERE id = ${projA}`;
      await one`COMMIT`;
      expect(inside[0]!.n).toBe(1);
      const [guc] = await one`SELECT current_setting('app.current_org_id', true) AS v`;
      expect(guc!.v).toBe('');
      const after = await one`SELECT count(*)::int AS n FROM projects WHERE id = ${projA}`;
      expect(after[0]!.n).toBe(0);
    } finally {
      await one.end();
    }
  });

  it('after runInOrgScope has run on every pooled connection, unbound queries see no org rows and do not error', async () => {
    // Hold POOL_MAX scopes open at once so each one runs on its own pooled connection; every
    // connection in the pool has then carried the transaction-local GUC.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    let allIn!: () => void;
    const allEntered = new Promise<void>((r) => (allIn = r));
    const scopes = Array.from({ length: POOL_MAX }, () =>
      dbModule.runInOrgScope(orgA, async () => {
        const rows = await dbModule.db.execute(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (await import('drizzle-orm')).sql`SELECT count(*)::int AS n FROM projects WHERE id = ${projA}`,
        );
        if (++entered === POOL_MAX) allIn();
        await gate;
        return rows[0].n as number;
      }),
    );
    await allEntered;
    release();
    expect(await Promise.all(scopes)).toEqual(Array(POOL_MAX).fill(1));

    const unbound = await Promise.all(
      Array.from({ length: POOL_MAX }, () => dbModule.queryClient`SELECT count(*)::int AS n FROM projects WHERE id = ${projA}`),
    );
    expect(unbound.map((r: Array<{ n: number }>) => r[0]!.n)).toEqual(Array(POOL_MAX).fill(0));
  });

  it('no RLS policy casts the raw org GUC to uuid (a new policy must use NULLIF)', async () => {
    const bad = await admin<Array<{ tablename: string; policyname: string }>>`
      SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public'
         AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
             ~ '\\(current_setting\\(''app\\.current_org_id''::text, true\\)\\)::uuid'
       ORDER BY tablename, policyname`;
    expect(bad, 'policies still casting current_setting(app.current_org_id)::uuid without NULLIF').toEqual([]);
    const [guarded] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'NULLIF\\(current_setting'`;
    expect(guarded!.n).toBeGreaterThan(100);
  });
});
