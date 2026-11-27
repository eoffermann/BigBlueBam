import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/**
 * #105: under BBB_RLS_ENFORCE=1 the api auth preHandler reads sessions, api_keys,
 * organization_memberships, organizations and the role tables to learn the request's org,
 * but those tables were gated on app.current_org_id, which is bound only AFTER
 * authentication. Every valid cookie and API key was rejected. This drives the REAL auth
 * plugin and the REAL rls plugin, on a connection that is NOSUPERUSER NOBYPASSRLS, and
 * proves that a session and an API key authenticate, that the request then sees only its own
 * org's rows, and that naming another org is refused.
 *
 * Needs a migrated database plus a non-bypassing role: CI's Test workflow provides both
 * (DATABASE_URL is the superuser used to seed; RLS_PROBE_DATABASE_URL is the
 * bbb_rls_probe role from scripts/ci/create-rls-probe-role.sql). Locally, point the same two
 * variables at a throwaway migrated Postgres. It skips when they are absent, and fails under
 * CI when the probe role cannot be used.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_URL = process.env.RLS_PROBE_DATABASE_URL;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const usable =
  !!ADMIN_URL && !!PROBE_URL && !ADMIN_URL.includes('test:test@localhost:5432/test') && PROBE_URL !== ADMIN_URL;

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.RLS_PROBE_DATABASE_URL ?? 'postgres://x@localhost:1/x',
    BBB_RLS_ENFORCE: true,
    NODE_ENV: 'test',
    SESSION_TTL_SECONDS: 3600,
  },
}));

if (IN_CI && !usable) {
  describe('RLS enforce-mode authentication (#105)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('RLS enforce-mode authentication (#105)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  const sessionA = `rls-auth-${tag}-${randomUUID()}`;
  const apiKeyA = `bbam_${tag}${randomUUID().replace(/-/g, '')}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    const [posture] = await admin<Array<{ rolsuper: boolean }>>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(posture?.rolsuper, 'DATABASE_URL must be the seeding superuser').toBe(true);

    const keyHash = await argon2.hash(apiKeyA, { type: argon2.argon2id });
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgA}, 'Gilligan Travel RLS A', ${`rls-a-${tag}`}), (${orgB}, 'Howell Holdings RLS B', ${`rls-b-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${userA}, ${orgA}, ${`skipper-${tag}@rls.test`}, 'Skipper', '!'),
      (${userB}, ${orgB}, ${`thurston-${tag}@rls.test`}, 'Thurston Howell', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES
      (${userA}, ${orgA}, true), (${userB}, ${orgB}, true)`;
    await admin`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES
      (${userA}, '22222222-2222-4222-8222-222222222222', 'org', ${orgA}),
      (${userB}, '22222222-2222-4222-8222-222222222222', 'org', ${orgB})`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix) VALUES
      (${projA}, ${orgA}, 'Rescue Signals', ${`rescue-${tag}`}, 'RSA'),
      (${projB}, ${orgB}, 'Howell Luau', ${`luau-${tag}`}, 'LUA')`;
    await admin`INSERT INTO sessions (id, user_id, expires_at) VALUES (${sessionA}, ${userA}, now() + interval '1 hour')`;
    await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
      VALUES (${userA}, ${orgA}, 'rls test', ${keyHash}, ${apiKeyA.slice(0, 8)}, 'read')`;

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const { requireAuth } = await import('../src/plugins/auth.js');
    const rlsPlugin = (await import('../src/plugins/rls.js')).default;
    dbModule = await import('../src/db/index.js');
    const { projects } = await import('../src/db/schema/projects.js');
    const { inArray } = await import('drizzle-orm');

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    await app.register(rlsPlugin);
    app.get('/me', { preHandler: [requireAuth] }, async (req: { user: { id: string; active_org_id: string } }) => ({
      id: req.user.id,
      org: req.user.active_org_id,
    }));
    // Deliberately NO org filter: under enforce, RLS alone must scope this.
    app.get('/projects', { preHandler: [requireAuth] }, async () =>
      dbModule.db.select({ id: projects.id }).from(projects).where(inArray(projects.id, [projA, projB])),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM api_keys WHERE user_id IN (${userA}, ${userB})`;
    await admin`DELETE FROM sessions WHERE user_id IN (${userA}, ${userB})`;
    await admin`DELETE FROM projects WHERE id IN (${projA}, ${projB})`;
    await admin`DELETE FROM account_group_memberships WHERE user_id IN (${userA}, ${userB})`;
    await admin`DELETE FROM organization_memberships WHERE user_id IN (${userA}, ${userB})`;
    await admin`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  it('runs on a connection that does not bypass RLS', async () => {
    const rows = await dbModule.queryClient`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('authenticates a session cookie and binds the org', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', cookies: { session: sessionA } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: userA, org: orgA });
  });

  it('authenticates a Bearer API key and binds the org', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${apiKeyA}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: userA, org: orgA });
  });

  it("returns only the caller's org rows from an unfiltered query", async () => {
    const res = await app.inject({ method: 'GET', url: '/projects', cookies: { session: sessionA } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ id: projA }]);
  });

  it("refuses to bind another org the caller does not belong to (X-Org-Id)", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      cookies: { session: sessionA },
      headers: { 'x-org-id': orgB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still rejects a bogus session and a bogus key', async () => {
    expect((await app.inject({ method: 'GET', url: '/me', cookies: { session: 'nope' } })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${apiKeyA}x` } });
    expect(bad.statusCode).toBe(401);
  });

  it('leaves org-scoped tables isolated for an unbound pooled connection', async () => {
    // Fail closed: with no org bound, the gated tables show nothing.
    const rows = await dbModule.queryClient`SELECT count(*)::int AS n FROM projects WHERE id IN (${projA}, ${projB})`;
    expect(rows[0].n).toBe(0);
  });
});
