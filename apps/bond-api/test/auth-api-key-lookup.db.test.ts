import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * #353: every service-account key shared the 8-char prefix 'bbam_svc', so one unauthenticated
 * 'Bearer bbam_svc...' header cost an Argon2id verify per service-account key on the platform (up
 * to 64). Keys now carry api_keys.key_lookup = sha256(token) (migration 0345), found through
 * auth_api_key_by_lookup; a legacy key without one is found by prefix (at most 3 verifies) and is
 * given its lookup id the first time it authenticates.
 *
 * This drives bond-api's REAL auth plugin on the NOSUPERUSER NOBYPASSRLS probe role (the lookup
 * and adopt functions must work before any org is bound). Same environment contract as
 * auth-org-context.db.test.ts: skips without DATABASE_URL + RLS_PROBE_DATABASE_URL, fails in CI.
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
  describe('satellite API key lookup id (#353)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('satellite API key lookup id (#353)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const org = randomUUID();
  const professor = randomUUID();
  const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  const lookupKey = `bbam_svc_${randomBytes(32).toString('base64url')}`;
  const legacyKey = `bbam_svc_${randomBytes(32).toString('base64url')}`;
  let legacyKeyId = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Gilligan Travel', ${`gt-key-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash, kind) VALUES
      (${professor}, ${org}, ${`radio-${tag}@lookup.test`}, 'Radio Relay', '!', 'service')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES (${professor}, ${org}, true)`;
    await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, key_lookup, scope) VALUES
      (${professor}, ${org}, 'Radio relay', ${await argon2.hash(lookupKey)}, ${lookupKey.slice(0, 8)}, ${sha256(lookupKey)}, 'read')`;
    const [legacy] = await admin<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
      VALUES (${professor}, ${org}, 'Old radio', ${await argon2.hash(legacyKey)}, ${legacyKey.slice(0, 8)}, 'read')
      RETURNING id`;
    legacyKeyId = legacy!.id;

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const { requireAuth } = await import('../src/plugins/auth.js');
    dbModule = await import('../src/db/index.js');
    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.get('/me', { preHandler: [requireAuth] }, async (req: { user: { id: string; active_org_id: string } }) => ({
      id: req.user.id,
      org: req.user.active_org_id,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM api_keys WHERE user_id = ${professor}`;
    await admin`DELETE FROM organization_memberships WHERE user_id = ${professor}`;
    await admin`DELETE FROM users WHERE id = ${professor}`;
    await admin`DELETE FROM organizations WHERE id = ${org}`;
    await admin.end();
    await dbModule?.connection?.end();
  });

  const bearer = (token: string) =>
    app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });

  it('authenticates a lookup-id service key on the probe role', async () => {
    const res = await bearer(lookupKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: professor, org });
  });

  it('authenticates a legacy key and records its lookup id on first use', async () => {
    const res = await bearer(legacyKey);
    expect(res.statusCode, res.body).toBe(200);
    let stored: string | null = null;
    for (let i = 0; i < 50 && !stored; i++) {
      const [row] = await admin<Array<{ key_lookup: string | null }>>`
        SELECT key_lookup FROM api_keys WHERE id = ${legacyKeyId}`;
      stored = row?.key_lookup ?? null;
      if (!stored) await new Promise((r) => setTimeout(r, 100));
    }
    expect(stored).toBe(sha256(legacyKey));
    // Next request takes the lookup path.
    expect((await bearer(legacyKey)).statusCode).toBe(200);
  });

  it('refuses an unknown bbam_svc token', async () => {
    const res = await bearer(`bbam_svc_${randomBytes(32).toString('base64url')}`);
    expect(res.statusCode).toBe(401);
  });
});
