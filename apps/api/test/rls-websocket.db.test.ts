import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * #344: under BBB_RLS_ENFORCE=1 the api WebSocket had no org binding. The rls plugin skips the
 * upgrade request (#102), so the handshake and every room-join read ran on an unbound pooled
 * connection: projects and project_memberships are org-gated, so every project room was
 * refused, or a read could ride a connection another request had bound. The handshake now
 * resolves identity outside any request scope, and each room join reads in the user's org
 * (runInOrgScope).
 *
 * Same environment contract as rls-auth-bootstrap.db.test.ts: DATABASE_URL is the seeding
 * superuser, RLS_PROBE_DATABASE_URL the NOSUPERUSER NOBYPASSRLS bbb_rls_probe role. Skips
 * without them; fails in CI.
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
    REDIS_URL: 'redis://127.0.0.1:1',
    CORS_ORIGIN: 'http://localhost',
    SESSION_TTL_SECONDS: 3600,
  },
}));

if (IN_CI && !usable) {
  describe('RLS enforce mode on the WebSocket (#344)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('RLS enforce mode on the WebSocket (#344)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skipper = randomUUID();
  const thurston = randomUUID();
  const projA = randomUUID();
  const projA2 = randomUUID();
  const projB = randomUUID();
  const sessionA = `rls-ws-${tag}-${randomUUID()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ws: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgA}, 'Gilligan Travel WS', ${`rls-ws-a-${tag}`}), (${orgB}, 'Howell Holdings WS', ${`rls-ws-b-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${skipper}, ${orgA}, ${`skipper-ws-${tag}@rls.test`}, 'Skipper', '!'),
      (${thurston}, ${orgB}, ${`thurston-ws-${tag}@rls.test`}, 'Thurston Howell', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES
      (${skipper}, ${orgA}, true), (${thurston}, ${orgB}, true)`;
    await admin`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES
      (${skipper}, '33333333-3333-4333-8333-333333333333', 'org', ${orgA}),
      (${thurston}, '33333333-3333-4333-8333-333333333333', 'org', ${orgB})`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix) VALUES
      (${projA}, ${orgA}, 'Rescue Signals', ${`ws-rescue-${tag}`}, 'WSA'),
      (${projA2}, ${orgA}, 'Coconut Radio', ${`ws-radio-${tag}`}, 'WSR'),
      (${projB}, ${orgB}, 'Howell Luau', ${`ws-luau-${tag}`}, 'WSB')`;
    await admin`INSERT INTO project_memberships (project_id, user_id, role) VALUES
      (${projA}, ${skipper}, 'member'), (${projB}, ${thurston}, 'member')`;
    await admin`INSERT INTO sessions (id, user_id, expires_at) VALUES (${sessionA}, ${skipper}, now() + interval '1 hour')`;

    dbModule = await import('../src/db/index.js');
    ws = await import('../src/plugins/websocket.js');
  });

  afterAll(async () => {
    await admin`DELETE FROM sessions WHERE user_id IN (${skipper}, ${thurston})`;
    await admin`DELETE FROM project_memberships WHERE project_id IN (${projA}, ${projA2}, ${projB})`;
    await admin`DELETE FROM projects WHERE id IN (${projA}, ${projA2}, ${projB})`;
    await admin`DELETE FROM account_group_memberships WHERE user_id IN (${skipper}, ${thurston})`;
    await admin`DELETE FROM organization_memberships WHERE user_id IN (${skipper}, ${thurston})`;
    await admin`DELETE FROM users WHERE id IN (${skipper}, ${thurston})`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  const upgrade = (session: string) => ({ cookies: { session }, headers: {} }) as never;

  it('runs on a connection that does not bypass RLS, where an unbound read sees no projects', async () => {
    const rows = await dbModule.queryClient`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // What the old inline room-join read saw: nothing, so every project room was refused.
    const unbound = await dbModule.queryClient`SELECT id FROM projects WHERE id = ${projA}`;
    expect(unbound).toHaveLength(0);
  });

  it('authenticates the upgrade from the session cookie and resolves the org', async () => {
    const user = await ws.authenticateWsRequest(upgrade(sessionA));
    expect(user?.id).toBe(skipper);
    expect(user?.active_org_id).toBe(orgA);
    expect(await ws.authenticateWsRequest(upgrade('nope'))).toBeNull();
  });

  it('lets a project member join the project room in their org', async () => {
    const user = await ws.authenticateWsRequest(upgrade(sessionA));
    expect(await ws.canJoinProjectRoom(user, projA)).toBe(true);
  });

  it('refuses a project the user is not a member of, and another org project', async () => {
    const user = await ws.authenticateWsRequest(upgrade(sessionA));
    expect(await ws.canJoinProjectRoom(user, projA2)).toBe(false);
    expect(await ws.canJoinProjectRoom(user, projB)).toBe(false);
  });

  it("ignores a connection some other request left bound to another org", async () => {
    const user = await ws.authenticateWsRequest(upgrade(sessionA));
    const reserved = await dbModule.queryClient.reserve();
    try {
      await reserved`select set_config('app.current_org_id', ${orgB}, false)`;
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const otherRequestDb = drizzle(Object.assign(reserved, { options: dbModule.queryClient.options }), {
        schema: dbModule.schema,
      });
      const result = await dbModule.rlsStorage.run({ db: otherRequestDb, reserved }, async () => ({
        auth: await ws.authenticateWsRequest(upgrade(sessionA)),
        join: await ws.canJoinProjectRoom(user, projA),
      }));
      expect(result.auth?.active_org_id).toBe(orgA);
      expect(result.join).toBe(true);
    } finally {
      await reserved`select set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', false)`;
      reserved.release();
    }
  });
});
