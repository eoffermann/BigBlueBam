import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * #350: satellite auth plugins used to carry their own resolveOrgContext, which read
 * organization_memberships directly. That copy (1) never excluded soft-deleted orgs, so a member
 * of a deleted org kept acting in it through every satellite, and (2) under BBB_RLS_ENFORCE=1
 * read org-gated tables before any org was bound, saw zero rows, and silently fell back to
 * users.org_id with role 'member'. Org context now comes from @bigbluebam/auth-core's
 * resolveOrgContext over migration 0311's SECURITY DEFINER functions.
 *
 * This drives bond-api's REAL auth plugin on a connection that is NOSUPERUSER NOBYPASSRLS (the CI
 * probe role) and checks the fact where it is consumed: what request.user says.
 *
 * Needs a migrated database plus the probe role: CI's Test workflow provides both (DATABASE_URL is
 * the seeding superuser, RLS_PROBE_DATABASE_URL is bbb_rls_probe from
 * scripts/ci/create-rls-probe-role.sql). Skips when they are absent; fails under CI when unusable.
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
  describe('satellite org context (#350)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('satellite org context (#350)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgLive = randomUUID();
  const orgDead = randomUUID();
  const skipper = randomUUID(); // admin of the live org
  const howell = randomUUID(); // only member of the soft-deleted org
  const ginger = randomUUID(); // member of both; the deleted one is her default
  const orphan = randomUUID(); // no membership rows; users.org_id is the deleted org
  const users = [skipper, howell, ginger, orphan];
  const sess = (u: string) => `org-ctx-${tag}-${u}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    const [posture] = await admin<Array<{ rolsuper: boolean }>>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(posture?.rolsuper, 'DATABASE_URL must be the seeding superuser').toBe(true);

    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgLive}, 'Gilligan Travel', ${`gt-${tag}`}), (${orgDead}, 'Howell Holdings', ${`hh-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${skipper}, ${orgLive}, ${`skipper-${tag}@orgctx.test`}, 'Skipper', '!'),
      (${howell}, ${orgDead}, ${`howell-${tag}@orgctx.test`}, 'Thurston Howell', '!'),
      (${ginger}, ${orgDead}, ${`ginger-${tag}@orgctx.test`}, 'Ginger', '!'),
      (${orphan}, ${orgDead}, ${`lovey-${tag}@orgctx.test`}, 'Lovey Howell', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default, joined_at) VALUES
      (${skipper}, ${orgLive}, true, now()),
      (${howell}, ${orgDead}, true, now()),
      (${ginger}, ${orgDead}, true, now() - interval '2 days'),
      (${ginger}, ${orgLive}, false, now() - interval '1 day')`;
    await admin`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES
      (${skipper}, ${GROUP_ADMIN}, 'org', ${orgLive})`;
    for (const u of users) {
      await admin`INSERT INTO sessions (id, user_id, expires_at) VALUES (${sess(u)}, ${u}, now() + interval '1 hour')`;
    }
    // Soft-delete the Howell org AFTER its memberships exist: the rows linger, as they do in prod.
    await admin`UPDATE organizations SET deleted_at = now() WHERE id = ${orgDead}`;

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
      async (req: { user: { id: string; active_org_id: string; role: string; org_memberships: Array<{ org_id: string }> } }) => ({
        id: req.user.id,
        org: req.user.active_org_id,
        role: req.user.role,
        orgs: req.user.org_memberships.map((m) => m.org_id),
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM sessions WHERE user_id IN ${admin(users)}`;
    await admin`DELETE FROM account_group_memberships WHERE user_id IN ${admin(users)}`;
    await admin`DELETE FROM organization_memberships WHERE user_id IN ${admin(users)}`;
    await admin`DELETE FROM users WHERE id IN ${admin(users)}`;
    await admin`DELETE FROM organizations WHERE id IN (${orgLive}, ${orgDead})`;
    await admin.end();
    await dbModule?.connection?.end();
  });

  const me = (u: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/me', cookies: { session: sess(u) }, headers });

  it('runs on a connection that does not bypass RLS', async () => {
    const rows = await dbModule.connection`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  // Enforce mode: the membership read must work before any org is bound. The old direct read saw
  // zero rows here and fell back to users.org_id with role 'member'.
  it('authenticates a session under enforce mode with the real org role', async () => {
    const res = await me(skipper);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: skipper, org: orgLive, role: 'admin', orgs: [orgLive] });
  });

  it('refuses a user whose only org is soft-deleted', async () => {
    const res = await me(howell);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('refuses a user with no memberships whose users.org_id is soft-deleted', async () => {
    const res = await me(orphan);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('drops a soft-deleted default org and resolves the live one', async () => {
    const res = await me(ginger);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ org: orgLive, orgs: [orgLive] });
  });

  it('refuses X-Org-Id naming a soft-deleted org the user was a member of', async () => {
    const res = await me(ginger, { 'x-org-id': orgDead });
    expect(res.statusCode, res.body).toBe(403);
  });
});
