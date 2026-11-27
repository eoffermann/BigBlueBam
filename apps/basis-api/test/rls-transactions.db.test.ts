import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * #365: under BBB_RLS_ENFORCE=1 the rls plugin pins one reserved postgres.js connection per
 * request, and a bare reserved connection has no begin()/savepoint(), so every db.transaction in
 * an org-bound request failed with "this.client.begin is not a function" (metric.service.ts
 * createMetric / addVersion). The plugin now binds through @bigbluebam/rls-connection.
 *
 * Runs the REAL rls plugin and db proxy in enforce mode on the NOSUPERUSER NOBYPASSRLS probe role,
 * so the insert's RLS WITH CHECK only passes if the org GUC is in force inside the transaction.
 * CI provides DATABASE_URL (superuser, used to seed and inspect) and RLS_PROBE_DATABASE_URL
 * (scripts/ci/create-rls-probe-role.sql). Locally, point both at a throwaway migrated Postgres.
 * Skips without them; fails in CI.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_URL = process.env.RLS_PROBE_DATABASE_URL;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const usable =
  !!ADMIN_URL && !!PROBE_URL && !ADMIN_URL.includes('test:test@localhost:5432/test') && PROBE_URL !== ADMIN_URL;

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.RLS_PROBE_DATABASE_URL ?? 'postgres://x@localhost:1/x',
    DATABASE_READ_URL: undefined,
    BBB_RLS_ENFORCE: true,
    NODE_ENV: 'test',
  },
}));

if (IN_CI && !usable) {
  describe('basis-api transactions under RLS enforce (#365)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('basis-api transactions under RLS enforce (#365)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgOk = randomUUID();
  const orgBad = randomUUID();
  let app: FastifyInstance | undefined;
  let dbModule: typeof import('../src/db/index.js') | undefined;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgOk}, 'Gilligan Travel Basis Tx', ${`basis-tx-ok-${tag}`}),
      (${orgBad}, 'Howell Holdings Basis Tx', ${`basis-tx-bad-${tag}`})`;

    const Fastify = (await import('fastify')).default;
    const rlsPlugin = (await import('../src/plugins/rls.js')).default;
    const mod = await import('../src/db/index.js');
    dbModule = mod;
    const { basisOrgSettings } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const server = Fastify({ logger: false });
    app = server;
    // Stands in for the auth plugin: the rls plugin binds request.user.active_org_id.
    server.addHook('onRequest', async (request) => {
      (request as unknown as { user: unknown }).user = {
        id: randomUUID(),
        active_org_id: request.headers['x-test-org'],
      };
    });
    await server.register(rlsPlugin);
    // The transaction shape of createMetric: one outer transaction on the request's connection,
    // with a nested savepoint that fails alone and an outer failure that undoes everything.
    server.post<{ Body: { failOuter: boolean } }>('/probe/tx', async (request) => {
      const orgId = String(request.headers['x-test-org']);
      const where = eq(basisOrgSettings.organization_id, orgId);
      try {
        await mod.db.transaction(async (tx) => {
          await tx.insert(basisOrgSettings).values({ organization_id: orgId, default_dimension: 'outer' });
          await tx
            .transaction(async (inner) => {
              await inner.update(basisOrgSettings).set({ default_dimension: 'inner' }).where(where);
              throw new Error('inner fails');
            })
            .catch(() => undefined);
          await tx.update(basisOrgSettings).set({ snapshot_max_age_days: 7 }).where(where);
          if (request.body.failOuter) throw new Error('outer fails');
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      return { ok: true };
    });
    await server.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM basis_org_settings WHERE organization_id IN (${orgOk}, ${orgBad})`;
    await admin`DELETE FROM organizations WHERE id IN (${orgOk}, ${orgBad})`;
    await admin.end();
    await dbModule?.connection?.end?.();
  });

  const probe = (org: string, failOuter: boolean) =>
    (app as FastifyInstance).inject({ method: 'POST', url: '/probe/tx', headers: { 'x-test-org': org }, payload: { failOuter } });

  it('commits, and a failed nested savepoint is undone alone', async () => {
    const res = await probe(orgOk, false);
    expect(res.json()).toEqual({ ok: true });
    const rows = await admin`SELECT default_dimension, snapshot_max_age_days FROM basis_org_settings WHERE organization_id = ${orgOk}`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ default_dimension: 'outer', snapshot_max_age_days: 7 }]);
  });

  it('rolls the whole transaction back when it throws', async () => {
    const res = await probe(orgBad, true);
    expect(res.json()).toEqual({ ok: false, error: 'outer fails' });
    expect(await admin`SELECT 1 FROM basis_org_settings WHERE organization_id = ${orgBad}`).toHaveLength(0);
  });
});
