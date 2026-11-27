import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * #352: an API key restricted to Bam projects (api_keys.project_ids) used to authenticate on
 * every satellite with its holder's whole org. Satellites have no Bam project context to confine
 * it to, so @bigbluebam/auth-core's refuseProjectRestrictedKey refuses it at authentication. An
 * unrestricted key, and a key whose restriction is an empty array (the create forms' "no
 * restriction"), still authenticate.
 *
 * Drives bond-api's REAL auth plugin on the probe role. Same environment contract as
 * auth-org-context.db.test.ts.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_URL = process.env.RLS_PROBE_DATABASE_URL;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const usable =
  !!ADMIN_URL && !!PROBE_URL && !ADMIN_URL.includes('test:test@localhost:5432/test') && PROBE_URL !== ADMIN_URL;

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.RLS_PROBE_DATABASE_URL ?? 'postgres://x@localhost:1/x',
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    BBB_PERMISSIONS_ENFORCE: 'off',
  },
}));

if (IN_CI && !usable) {
  describe('satellite API key project restriction (#352)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('satellite API key project restriction (#352)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const org = randomUUID();
  const maryAnn = randomUUID();
  const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  const mint = () => `bbam_${randomBytes(32).toString('base64url')}`;
  const restrictedKey = mint();
  const openKey = mint();
  const emptyKey = mint();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Gilligan Travel', ${`gt-proj-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${maryAnn}, ${org}, ${`maryann-${tag}@keyproject.test`}, 'Mary Ann', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES (${maryAnn}, ${org}, true)`;
    const insertKey = async (token: string, projectIds: string[] | null) => {
      await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, key_lookup, scope, project_ids)
        VALUES (${maryAnn}, ${org}, 'Coconut counter', ${await argon2.hash(token)}, ${token.slice(0, 8)},
                ${sha256(token)}, 'read_write', ${projectIds === null ? null : admin.array(projectIds)}::uuid[])`;
    };
    await insertKey(restrictedKey, [randomUUID()]);
    await insertKey(openKey, null);
    await insertKey(emptyKey, []);

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const { requireAuth } = await import('../src/plugins/auth.js');
    dbModule = await import('../src/db/index.js');
    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.get('/deals', { preHandler: [requireAuth] }, async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM api_keys WHERE user_id = ${maryAnn}`;
    await admin`DELETE FROM organization_memberships WHERE user_id = ${maryAnn}`;
    await admin`DELETE FROM users WHERE id = ${maryAnn}`;
    await admin`DELETE FROM organizations WHERE id = ${org}`;
    await admin.end();
    await dbModule?.connection?.end();
  });

  const bearer = (token: string) =>
    app.inject({ method: 'GET', url: '/deals', headers: { authorization: `Bearer ${token}` } });

  it('refuses a project-restricted key', async () => {
    const res = await bearer(restrictedKey);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_PROJECT_RESTRICTED');
  });

  it('admits an unrestricted key and an empty restriction', async () => {
    expect((await bearer(openKey)).statusCode).toBe(200);
    expect((await bearer(emptyKey)).statusCode).toBe(200);
  });
});
