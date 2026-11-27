import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/**
 * #338: under BBB_RLS_ENFORCE=1 the rls plugin binds app.current_org_id from
 * request.user, so a request with no signed-in user bound nothing. Creating an
 * org at register failed its policy check, the iCal token feeds read no
 * projects or tasks, accepting a guest invite could not write the membership,
 * and server-to-server and webhook routes saw no org rows. Those paths now bind
 * the org they act in, per operation (runInOrgScope) or per route
 * (config.rlsOrgScope, resolved through the migration 0325 definer functions).
 *
 * Runs the REAL services, routes and rls plugin on a NOSUPERUSER NOBYPASSRLS
 * role. Same environment contract as rls-auth-bootstrap.db.test.ts: CI provides
 * DATABASE_URL (superuser, used to seed) and RLS_PROBE_DATABASE_URL (the
 * bbb_rls_probe role from scripts/ci/create-rls-probe-role.sql). Locally, point
 * both at a throwaway migrated Postgres. Skips without them; fails in CI.
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
    API_KEY_ROTATION_GRACE_MS: 7 * 24 * 3600_000,
  },
}));

if (IN_CI && !usable) {
  describe('RLS enforce mode without a signed-in user (#338)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('RLS enforce mode without a signed-in user (#338)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  // Upper-case: the Slack command upper-cases the task ref it is given.
  const tag = Date.now().toString(36).toUpperCase();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();
  const calToken = `bbam_cal_${tag}${randomUUID().replace(/-/g, '')}`;
  const apiKeyA = `bbam_${tag}${randomUUID().replace(/-/g, '')}`;
  const inviteToken = `invite-${tag}-${randomUUID()}`;
  const guestEmail = `mary-ann-${tag}@rls.test`;
  const slackToken = `slack-${tag}`;
  const registeredEmail = `gilligan-${tag}@rls.test`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;
  let registeredOrgId: string | null = null;

  beforeAll(async () => {
    const [posture] = await admin<Array<{ rolsuper: boolean }>>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(posture?.rolsuper, 'DATABASE_URL must be the seeding superuser').toBe(true);

    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgA}, 'Gilligan Travel RLS A', ${`rls-ua-${tag}`}), (${orgB}, 'Howell Holdings RLS B', ${`rls-ub-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${userA}, ${orgA}, ${`skipper-u-${tag}@rls.test`}, 'Skipper', '!'),
      (${userB}, ${orgB}, ${`thurston-u-${tag}@rls.test`}, 'Thurston Howell', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES
      (${userA}, ${orgA}, true), (${userB}, ${orgB}, true)`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix) VALUES
      (${projA}, ${orgA}, 'Rescue Signals', ${`rescue-u-${tag}`}, 'RSU'),
      (${projB}, ${orgB}, 'Howell Luau', ${`luau-u-${tag}`}, 'LUU')`;
    await admin`INSERT INTO tasks (id, project_id, org_id, human_id, title, due_date, assignee_id) VALUES
      (${taskA}, ${projA}, ${orgA}, ${`RSU-${tag}`}, 'Daily Coconut Count', '2026-12-01', ${userA}),
      (${taskB}, ${projB}, ${orgB}, ${`LUU-${tag}`}, 'Howell Luau RSVP', '2026-12-02', ${userB})`;
    await admin`INSERT INTO project_calendar_tokens (project_id, org_id, token_prefix, token_hash, name, created_by)
      VALUES (${projA}, ${orgA}, ${calToken.slice(0, 16)}, ${await argon2.hash(calToken)}, 'feed', ${userA})`;
    await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
      VALUES (${userA}, ${orgA}, 'ical', ${await argon2.hash(apiKeyA, { type: argon2.argon2id })}, ${apiKeyA.slice(0, 8)}, 'read')`;
    await admin`INSERT INTO guest_invitations (org_id, invited_by, email, token, expires_at, project_ids)
      VALUES (${orgA}, ${userA}, ${guestEmail}, ${inviteToken}, now() + interval '1 day', ${[projA]})`;
    await admin`INSERT INTO slack_integrations (project_id, webhook_url, slash_command_token)
      VALUES (${projA}, 'https://hooks.slack.invalid/x', ${slackToken})`;

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const authPlugin = (await import('../src/plugins/auth.js')).default;
    const rlsPlugin = (await import('../src/plugins/rls.js')).default;
    dbModule = await import('../src/db/index.js');
    const { projects } = await import('../src/db/schema/projects.js');
    const { inArray } = await import('drizzle-orm');
    const { orgOfTaskIn } = await import('../src/lib/rls-org-scope.js');

    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    await app.register(rlsPlugin);
    // guest.routes' authenticated routes use requireCan; only the public accept route runs here.
    app.decorate('requireCan', () => async () => {});
    await app.register((await import('../src/routes/ical.routes.js')).default);
    await app.register((await import('../src/routes/guest.routes.js')).default);
    await app.register((await import('../src/routes/slack-webhook.routes.js')).default);
    // A server-to-server shaped route: no user, org from the task the body names.
    app.post(
      '/probe/by-task',
      { config: { rlsOrgScope: orgOfTaskIn('body', 'task_id') } },
      async () => dbModule.db.select({ id: projects.id }).from(projects).where(inArray(projects.id, [projA, projB])),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    const orgs = [orgA, orgB, ...(registeredOrgId ? [registeredOrgId] : [])];
    await admin`DELETE FROM slack_integrations WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM guest_invitations WHERE org_id IN ${admin(orgs)}`;
    await admin`DELETE FROM project_calendar_tokens WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM api_keys WHERE org_id IN ${admin(orgs)}`;
    await admin`DELETE FROM project_memberships WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM tasks WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM projects WHERE id IN (${projA}, ${projB})`;
    await admin`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id IN ${admin(orgs)})`;
    await admin`DELETE FROM account_group_memberships WHERE scope_id IN ${admin(orgs)}`;
    await admin`DELETE FROM organization_memberships WHERE org_id IN ${admin(orgs)}`;
    await admin`DELETE FROM priorities WHERE org_id IN ${admin(orgs)}`;
    await admin`DELETE FROM users WHERE org_id IN ${admin(orgs)}`;
    await admin`DELETE FROM organizations WHERE id IN ${admin(orgs)}`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  it('runs on a connection that does not bypass RLS', async () => {
    const rows = await dbModule.queryClient`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('register creates the org, owner membership and role with no org bound beforehand', async () => {
    const { register } = await import('../src/services/auth.service.js');
    const result = await register({
      email: registeredEmail,
      password: 'coconut-radio-42',
      display_name: 'Gilligan',
      org_name: `Minnow Charters ${tag}`,
    });
    registeredOrgId = result.org.id;
    const [m] = await admin`SELECT count(*)::int AS n FROM organization_memberships WHERE org_id = ${result.org.id}`;
    const [r] = await admin`SELECT count(*)::int AS n FROM account_group_memberships WHERE scope_id = ${result.org.id}`;
    expect(m!.n).toBe(1);
    expect(r!.n).toBe(1);
  });

  it('serves the public project calendar for a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/projects/${projA}/calendar.ics?token=${calToken}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Daily Coconut Count');
  });

  it('serves the My Tasks feed for an API key in ?token=', async () => {
    const res = await app.inject({ method: 'GET', url: `/me/calendar.ics?token=${apiKeyA}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Daily Coconut Count');
    expect(res.body).not.toContain('Howell Luau RSVP');
  });

  it('accepts a guest invitation and writes the membership into the inviting org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/guests/accept/${inviteToken}`,
      payload: { email: guestEmail, display_name: 'Mary Ann', password: 'pie-baker-9000' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const [m] = await admin`SELECT count(*)::int AS n FROM organization_memberships om
      JOIN users u ON u.id = om.user_id WHERE u.email = ${guestEmail} AND om.org_id = ${orgA}`;
    expect(m!.n).toBe(1);
  });

  it('answers a Slack slash command for the integration org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${slackToken}&text=RSU-${tag}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().text).toContain('Daily Coconut Count');
  });

  it('binds a route-declared org (definer lookup of a task) and sees only that org', async () => {
    const res = await app.inject({ method: 'POST', url: '/probe/by-task', payload: { task_id: taskB } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ id: projB }]);
  });

  it('binds nothing when the route payload names no resolvable org (fail closed)', async () => {
    const res = await app.inject({ method: 'POST', url: '/probe/by-task', payload: { task_id: randomUUID() } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('leaves the pooled connection unbound after a scoped operation', async () => {
    const rows = await dbModule.queryClient`SELECT count(*)::int AS n FROM projects WHERE id IN (${projA}, ${projB})`;
    expect(rows[0].n).toBe(0);
  });
});
