import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * #352: api_keys.project_ids was stored and advertised ("the key can only access resources within
 * those projects") but never enforced. This drives the REAL api auth plugin, rls plugin and
 * project guards on the NOSUPERUSER NOBYPASSRLS probe role and checks the restriction where it
 * is consumed:
 *   - a key restricted to Project A reaches Project A routes (project param and entity guards),
 *   - is refused (404, like a non-member) on Project B,
 *   - is refused (403) on an org-wide route that establishes no project (fail closed),
 *   - while a session and an unrestricted key of the same user reach all of them.
 *
 * Same environment contract as rls-auth-bootstrap.db.test.ts.
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
  describe('API key project restriction (#352)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('API key project restriction (#352)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const org = randomUUID();
  const skipper = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  const phaseA = randomUUID();
  const phaseB = randomUUID();
  const session = `key-proj-${tag}-${randomUUID()}`;
  const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  const restrictedKey = `bbam_${randomBytes(32).toString('base64url')}`;
  const openKey = `bbam_${randomBytes(32).toString('base64url')}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Gilligan Travel', ${`gt-kp-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${skipper}, ${org}, ${`skipper-${tag}@keyproject.test`}, 'Skipper', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES (${skipper}, ${org}, true)`;
    await admin`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES
      (${skipper}, '22222222-2222-4222-8222-222222222222', 'org', ${org})`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix) VALUES
      (${projA}, ${org}, 'Rescue Signals', ${`rescue-${tag}`}, 'RSK'),
      (${projB}, ${org}, 'Howell Luau', ${`luau-${tag}`}, 'LUK')`;
    await admin`INSERT INTO project_memberships (project_id, user_id, role) VALUES
      (${projA}, ${skipper}, 'admin'), (${projB}, ${skipper}, 'admin')`;
    await admin`INSERT INTO phases (id, project_id, name, position) VALUES
      (${phaseA}, ${projA}, 'Signal fire', 1), (${phaseB}, ${projB}, 'Tiki torches', 1)`;
    await admin`INSERT INTO sessions (id, user_id, expires_at) VALUES (${session}, ${skipper}, now() + interval '1 hour')`;
    for (const [token, projects] of [
      [restrictedKey, [projA]],
      [openKey, null],
    ] as const) {
      await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, key_lookup, scope, project_ids)
        VALUES (${skipper}, ${org}, 'CI radio', ${await argon2.hash(token)}, ${token.slice(0, 8)}, ${sha256(token)},
                'read_write', ${projects === null ? null : admin.array([...projects])}::uuid[])`;
    }

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const { requireAuth } = await import('../src/plugins/auth.js');
    const rlsPlugin = (await import('../src/plugins/rls.js')).default;
    const { requireProjectAccess, requireProjectAccessForEntity } = await import('../src/middleware/authorize.js');
    dbModule = await import('../src/db/index.js');

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    await app.register(rlsPlugin);
    app.get('/projects/:id/tasks', { preHandler: [requireAuth, requireProjectAccess()] }, async () => ({ ok: true }));
    app.get('/phases/:id', { preHandler: [requireAuth, requireProjectAccessForEntity('phase')] }, async () => ({ ok: true }));
    // Org-wide: establishes no project.
    app.get('/projects', { preHandler: [requireAuth] }, async () => ({ ok: true }));
    // #367: identity-only route declared exempt, like the real GET /auth/me.
    app.get('/auth/me', { preHandler: [requireAuth], config: { keyProjectExempt: true } }, async (request: { user: { id: string } }) => ({
      id: request.user.id,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM api_keys WHERE user_id = ${skipper}`;
    await admin`DELETE FROM sessions WHERE user_id = ${skipper}`;
    await admin`DELETE FROM phases WHERE id IN (${phaseA}, ${phaseB})`;
    await admin`DELETE FROM project_memberships WHERE user_id = ${skipper}`;
    await admin`DELETE FROM projects WHERE id IN (${projA}, ${projB})`;
    await admin`DELETE FROM account_group_memberships WHERE user_id = ${skipper}`;
    await admin`DELETE FROM organization_memberships WHERE user_id = ${skipper}`;
    await admin`DELETE FROM users WHERE id = ${skipper}`;
    await admin`DELETE FROM organizations WHERE id = ${org}`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  const get = (url: string, auth: { key?: string; session?: string }) =>
    app.inject({
      method: 'GET',
      url,
      ...(auth.key ? { headers: { authorization: `Bearer ${auth.key}` } } : {}),
      ...(auth.session ? { cookies: { session: auth.session } } : {}),
    });

  it('admits a restricted key to its own project, by project id and by entity', async () => {
    expect((await get(`/projects/${projA}/tasks`, { key: restrictedKey })).statusCode).toBe(200);
    expect((await get(`/phases/${phaseA}`, { key: restrictedKey })).statusCode).toBe(200);
  });

  it('refuses a restricted key on another project as not found', async () => {
    expect((await get(`/projects/${projB}/tasks`, { key: restrictedKey })).statusCode).toBe(404);
    expect((await get(`/phases/${phaseB}`, { key: restrictedKey })).statusCode).toBe(404);
  });

  it('refuses a restricted key on an org-wide route (fails closed)', async () => {
    const res = await get('/projects', { key: restrictedKey });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_PROJECT_RESTRICTED');
  });

  it('lets a restricted key identify itself on an exempt identity route (#367)', async () => {
    const res = await get('/auth/me', { key: restrictedKey });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().id).toBe(skipper);
  });

  it('leaves sessions and unrestricted keys alone', async () => {
    for (const auth of [{ session }, { key: openKey }]) {
      expect((await get(`/projects/${projB}/tasks`, auth)).statusCode).toBe(200);
      expect((await get(`/phases/${phaseB}`, auth)).statusCode).toBe(200);
      expect((await get('/projects', auth)).statusCode).toBe(200);
    }
  });
});
