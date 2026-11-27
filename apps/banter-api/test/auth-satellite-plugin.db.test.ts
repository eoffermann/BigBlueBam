import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * #369: the satellites' auth plugin now lives once, as @bigbluebam/auth-core's
 * createSatelliteAuth, and banter-api's plugins/auth.ts only binds it (with banter's two options:
 * the session's switched org, and SuperUser viewing of any live org). bond-api's DB tests drive
 * the default binding; this drives banter's REAL binding on the NOSUPERUSER NOBYPASSRLS probe
 * role, so session auth, API-key auth and impersonation are checked through a second satellite
 * against the real sessions / api_keys / impersonation_sessions tables.
 *
 * Same environment contract as bond-api's auth-*.db.test.ts: skips without DATABASE_URL +
 * RLS_PROBE_DATABASE_URL, fails in CI when they are unusable.
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

// The builtin org-scope permission groups seeded by the permissions catalog migrations.
const GROUP_ADMIN = '22222222-2222-4222-8222-222222222222';

if (IN_CI && !usable) {
  describe('banter-api satellite auth plugin (#369)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('banter-api satellite auth plugin (#369)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgIsland = randomUUID();
  const orgMainland = randomUUID();
  const orgOther = randomUUID(); // nobody below is a member
  const skipper = randomUUID(); // admin of island (default), member of mainland
  const gilligan = randomUUID(); // member of island only
  const su = randomUUID(); // platform SuperUser, member of island
  const people = [skipper, gilligan, su];
  const sess = (name: string) => `sat-auth-${tag}-${name}`;
  const key = `bbam_${randomBytes(32).toString('base64url')}`;
  const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgIsland}, 'Gilligan Travel', ${`gt-sat-${tag}`}),
      (${orgMainland}, 'Minnow Charters', ${`mc-sat-${tag}`}),
      (${orgOther}, 'Howell Holdings', ${`hh-sat-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash, is_superuser) VALUES
      (${skipper}, ${orgIsland}, ${`skipper-${tag}@sat.test`}, 'Skipper', '!', false),
      (${gilligan}, ${orgIsland}, ${`gilligan-${tag}@sat.test`}, 'Gilligan', '!', false),
      (${su}, ${orgIsland}, ${`professor-${tag}@sat.test`}, 'The Professor', '!', true)`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default, joined_at) VALUES
      (${skipper}, ${orgIsland}, true, now() - interval '2 days'),
      (${skipper}, ${orgMainland}, false, now() - interval '1 day'),
      (${gilligan}, ${orgIsland}, true, now()),
      (${su}, ${orgIsland}, true, now())`;
    await admin`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES
      (${skipper}, ${GROUP_ADMIN}, 'org', ${orgIsland})`;
    await admin`INSERT INTO sessions (id, user_id, expires_at, active_org_id) VALUES
      (${sess('skipper')}, ${skipper}, now() + interval '1 hour', NULL),
      (${sess('skipper-switched')}, ${skipper}, now() + interval '1 hour', ${orgMainland}),
      (${sess('gilligan-stale')}, ${gilligan}, now() + interval '1 hour', ${orgMainland}),
      (${sess('skipper-expired')}, ${skipper}, now() - interval '1 minute', NULL),
      (${sess('su')}, ${su}, now() + interval '1 hour', NULL)`;
    // A key minted in the mainland org: pinned there whatever X-Org-Id says (P2-8).
    await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, key_lookup, scope) VALUES
      (${skipper}, ${orgMainland}, 'Radio', ${await argon2.hash(key)}, ${key.slice(0, 8)}, ${sha256(key)}, 'read_write')`;
    await admin`INSERT INTO impersonation_sessions (superuser_id, target_user_id, expires_at) VALUES
      (${su}, ${skipper}, now() + interval '30 minutes')`;
    await admin`INSERT INTO impersonation_sessions (superuser_id, target_user_id, expires_at, ended_at) VALUES
      (${su}, ${gilligan}, now() + interval '30 minutes', now())`;

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const { requireAuth } = await import('../src/plugins/auth.js');
    dbModule = await import('../src/db/index.js');

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.get(
      '/me',
      { preHandler: [requireAuth] },
      async (req: {
        user: { id: string; active_org_id: string; role: string; api_key_scope: string | null };
        impersonator: { id: string } | null;
        isImpersonating: boolean;
      }) => ({
        id: req.user.id,
        org: req.user.active_org_id,
        role: req.user.role,
        scope: req.user.api_key_scope,
        impersonator: req.impersonator?.id ?? null,
        impersonating: req.isImpersonating,
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM impersonation_sessions WHERE superuser_id = ${su}`;
    await admin`DELETE FROM api_keys WHERE user_id IN ${admin(people)}`;
    await admin`DELETE FROM sessions WHERE user_id IN ${admin(people)}`;
    await admin`DELETE FROM account_group_memberships WHERE user_id IN ${admin(people)}`;
    await admin`DELETE FROM organization_memberships WHERE user_id IN ${admin(people)}`;
    await admin`DELETE FROM users WHERE id IN ${admin(people)}`;
    await admin`DELETE FROM organizations WHERE id IN (${orgIsland}, ${orgMainland}, ${orgOther})`;
    await admin.end();
    await dbModule?.connection?.end();
  });

  const me = (headers: Record<string, string> = {}, session?: string) =>
    app.inject({ method: 'GET', url: '/me', headers, ...(session ? { cookies: { session: sess(session) } } : {}) });

  it('runs on a connection that does not bypass RLS', async () => {
    const rows = await dbModule.connection`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('authenticates a session cookie with the default org and the real role', async () => {
    const res = await me({}, 'skipper');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: skipper, org: orgIsland, role: 'admin', scope: null, impersonating: false });
  });

  it('refuses an expired session and no credentials', async () => {
    expect((await me({}, 'skipper-expired')).statusCode).toBe(401);
    expect((await me()).statusCode).toBe(401);
  });

  it("honors the session's switched org, and falls through a stale one", async () => {
    expect((await me({}, 'skipper-switched')).json()).toMatchObject({ org: orgMainland, role: 'member' });
    const stale = await me({}, 'gilligan-stale');
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().org).toBe(orgIsland);
  });

  it('lets a SuperUser view a non-member org, and refuses that org to anyone else', async () => {
    expect((await me({ 'x-org-id': orgOther }, 'su')).json()).toMatchObject({ id: su, org: orgOther, role: 'owner' });
    expect((await me({ 'x-org-id': orgOther }, 'skipper')).statusCode).toBe(403);
  });

  it('authenticates an API key pinned to its own org whatever X-Org-Id says', async () => {
    const res = await me({ authorization: `Bearer ${key}`, 'x-org-id': orgIsland });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: skipper, org: orgMainland, role: 'member', scope: 'read_write' });
    expect((await me({ authorization: `Bearer ${key}x` })).statusCode).toBe(401);
  });

  it('impersonates only with an active impersonation session', async () => {
    const res = await me({ 'x-impersonate-user': skipper }, 'su');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: skipper, impersonator: su, impersonating: true });
    expect(res.headers['x-impersonator']).toBe(su);
    // The Gilligan impersonation session was ended: fail closed, stay the SuperUser.
    expect((await me({ 'x-impersonate-user': gilligan }, 'su')).json()).toMatchObject({ id: su, impersonating: false });
    // A non-SuperUser cannot impersonate even with a valid target.
    expect((await me({ 'x-impersonate-user': gilligan }, 'skipper')).json().id).toBe(skipper);
  });
});
