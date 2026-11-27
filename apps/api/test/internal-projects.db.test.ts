import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * #364: the worker's Slack import (project mode create_new) inserted
 * projects(org_id, name, key, owner_id), columns the table does not have, so every such import
 * failed, and a raw insert would have skipped the creator membership and the template phases
 * and states anyway. It now calls POST /internal/projects/ensure, which runs createProject.
 *
 * Runs the REAL route, project service and rls plugin in enforce mode on the NOSUPERUSER
 * NOBYPASSRLS probe role, so the route's config.rlsOrgScope is what lets the org-gated writes
 * land. Same environment contract as rls-unauthenticated.db.test.ts: CI provides DATABASE_URL
 * (superuser, used to seed) and RLS_PROBE_DATABASE_URL (scripts/ci/create-rls-probe-role.sql).
 * Locally, point both at a throwaway migrated Postgres. Skips without them; fails in CI.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_URL = process.env.RLS_PROBE_DATABASE_URL;
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';
const usable =
  !!ADMIN_URL && !!PROBE_URL && !ADMIN_URL.includes('test:test@localhost:5432/test') && PROBE_URL !== ADMIN_URL;
const SECRET = 'internal-projects-test-secret-0123456789';

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.RLS_PROBE_DATABASE_URL ?? 'postgres://x@localhost:1/x',
    BBB_RLS_ENFORCE: true,
    NODE_ENV: 'test',
    INTERNAL_SERVICE_SECRET: 'internal-projects-test-secret-0123456789',
    INTERNAL_HELPDESK_SECRET: '',
  },
}));

if (IN_CI && !usable) {
  describe('POST /internal/projects/ensure (#364)', () => {
    it('has a superuser DATABASE_URL and a NOBYPASSRLS RLS_PROBE_DATABASE_URL in CI', () => {
      throw new Error('RLS_PROBE_DATABASE_URL / DATABASE_URL missing in CI; see scripts/ci/create-rls-probe-role.sql');
    });
  });
}

(usable ? describe : describe.skip)('POST /internal/projects/ensure (#364)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skipper = randomUUID();
  const thurston = randomUUID();
  const slug = `castaway-rescue-${tag}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  const ensure = (body: Record<string, unknown>, secret = SECRET) =>
    app.inject({
      method: 'POST',
      url: '/internal/projects/ensure',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
      payload: body,
    });

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgA}, 'Gilligan Travel Ensure A', ${`ens-a-${tag}`}), (${orgB}, 'Howell Holdings Ensure B', ${`ens-b-${tag}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES
      (${skipper}, ${orgA}, ${`skipper-ens-${tag}@rls.test`}, 'Skipper', '!'),
      (${thurston}, ${orgB}, ${`thurston-ens-${tag}@rls.test`}, 'Thurston Howell', '!')`;
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES
      (${skipper}, ${orgA}, true), (${thurston}, ${orgB}, true)`;

    const Fastify = (await import('fastify')).default;
    const rlsPlugin = (await import('../src/plugins/rls.js')).default;
    dbModule = await import('../src/db/index.js');
    app = Fastify({ logger: false });
    await app.register(rlsPlugin);
    await app.register((await import('../src/routes/internal-projects.routes.js')).default, { prefix: '/internal' });
    // Transaction semantics on the request's reserved connection (withReservedTransactions):
    // an inner savepoint that throws is undone alone; an outer throw undoes everything.
    const { projects } = await import('../src/db/schema/projects.js');
    const { orgIdIn } = await import('../src/lib/rls-org-scope.js');
    app.post(
      '/probe/tx',
      { config: { rlsOrgScope: orgIdIn('body', 'org_id') } },
      async (request: { body: { org_id: string; prefix: string; failOuter: boolean } }) => {
        const { org_id, prefix, failOuter } = request.body;
        const row = (s: string) => ({ org_id, name: s, slug: `${prefix}-${s}`, task_id_prefix: 'TX' });
        try {
          await dbModule.db.transaction(async (tx: typeof dbModule.db) => {
            await tx.insert(projects).values(row('outer'));
            await tx
              .transaction(async (inner: typeof dbModule.db) => {
                await inner.insert(projects).values(row('inner'));
                throw new Error('inner fails');
              })
              .catch(() => undefined);
            await tx.insert(projects).values(row('after'));
            if (failOuter) throw new Error('outer fails');
          });
        } catch {
          return { ok: false };
        }
        return { ok: true };
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    const ids = admin`SELECT id FROM projects WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM phases WHERE project_id IN (${ids})`;
    await admin`DELETE FROM task_states WHERE project_id IN (${ids})`;
    await admin`DELETE FROM project_memberships WHERE project_id IN (${ids})`;
    await admin`DELETE FROM projects WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM organization_memberships WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM users WHERE id IN (${skipper}, ${thurston})`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin.end();
    await dbModule?.connection?.end?.();
  });

  const body = {
    org_id: orgA,
    created_by: skipper,
    name: 'Castaway Rescue',
    slug,
    task_id_prefix: 'RESCUE',
    ensure_key: `slack-import:imp-${tag}`,
  };

  it('creates the project with the creator membership and default phases and states', async () => {
    const res = await ensure(body);
    expect(res.statusCode, res.body).toBe(201);
    const json = res.json();
    expect(json.created).toBe(true);
    expect(json.data).toMatchObject({ org_id: orgA, slug, task_id_prefix: 'RESCUE', created_by: skipper });

    const [proj] = await admin`SELECT org_id, name, slug, task_id_prefix, created_by FROM projects WHERE id = ${json.data.id}`;
    expect(proj).toMatchObject({ org_id: orgA, name: 'Castaway Rescue', slug, task_id_prefix: 'RESCUE', created_by: skipper });
    const members = await admin`SELECT user_id, role FROM project_memberships WHERE project_id = ${json.data.id}`;
    expect(members.map((m) => ({ ...m }))).toEqual([{ user_id: skipper, role: 'admin' }]);
    const phases = await admin`SELECT name, is_start, is_terminal FROM phases WHERE project_id = ${json.data.id} ORDER BY position`;
    expect(phases.map((p) => p.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'Review', 'Done']);
    const states = await admin`SELECT name FROM task_states WHERE project_id = ${json.data.id} ORDER BY position`;
    expect(states).toHaveLength(5);
  });

  it('is idempotent on (org_id, ensure_key): a replay answers the same project and creates nothing', async () => {
    const res = await ensure({ ...body, name: 'Castaway Rescue (replay)' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created).toBe(false);
    const rows = await admin`SELECT id, name FROM projects WHERE org_id = ${orgA} AND slug = ${slug}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(res.json().data.id);
    expect(rows[0]!.name).toBe('Castaway Rescue');
    const [count] = await admin`SELECT count(*)::int AS n FROM phases WHERE project_id = ${rows[0]!.id}`;
    expect(count!.n).toBe(5);
  });

  it('never answers a project the caller did not create, even when it holds the slug (#373)', async () => {
    // A project the org already has under the slug a new import derives (created through the
    // normal UI path, so no ensure_key).
    const taken = `engineering-${tag}`;
    const [foreign] = await admin`INSERT INTO projects (org_id, name, slug, task_id_prefix)
      VALUES (${orgA}, 'Professor Lab Notes', ${taken}, 'LAB') RETURNING id`;

    const first = await ensure({ ...body, slug: taken, name: 'Engineering', ensure_key: `slack-import:eng1-${tag}` });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.id).not.toBe(foreign!.id);
    expect(first.json().data.slug).toBe(`${taken}-2`);

    // A second, unrelated import asking for the same slug gets its own project too.
    const second = await ensure({ ...body, slug: taken, name: 'Engineering', ensure_key: `slack-import:eng2-${tag}` });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().data.slug).toBe(`${taken}-3`);

    // The first import's retry answers the first import's project.
    const retry = await ensure({ ...body, slug: taken, name: 'Engineering', ensure_key: `slack-import:eng1-${tag}` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.id).toBe(first.json().data.id);

    const [foreignAfter] = await admin`SELECT name FROM projects WHERE id = ${foreign!.id}`;
    expect(foreignAfter!.name).toBe('Professor Lab Notes');
  });

  it('requires an ensure_key', async () => {
    const { ensure_key: _omit, ...noKey } = body;
    const res = await ensure({ ...noKey, slug: `nokey-${tag}` });
    expect(res.statusCode).toBe(400);
  });

  it('concurrent creates with one ensure_key yield one project', async () => {
    const raceSlug = `luau-race-${tag}`;
    const raceKey = `slack-import:race-${tag}`;
    const results = await Promise.all(
      [1, 2, 3].map(() => ensure({ ...body, slug: raceSlug, name: 'Howell Luau RSVP', ensure_key: raceKey })),
    );
    const ids = new Set(results.map((r: { json: () => { data: { id: string } } }) => r.json().data.id));
    expect(results.map((r: { statusCode: number }) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(ids.size).toBe(1);
    const rows = await admin`SELECT id FROM projects WHERE org_id = ${orgA} AND slug = ${raceSlug}`;
    expect(rows).toHaveLength(1);
  });

  it('refuses a creator who is not a member of the org', async () => {
    const res = await ensure({ ...body, created_by: thurston, slug: `intruder-${tag}` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CREATOR_NOT_IN_ORG');
    expect(await admin`SELECT 1 FROM projects WHERE slug = ${`intruder-${tag}`}`).toHaveLength(0);
  });

  it('rejects the old worker body shape (key, owner_id, no slug)', async () => {
    const res = await ensure({ org_id: orgA, name: 'Old shape', key: 'OLD', owner_id: skipper });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('transactions on the reserved connection commit, roll back, and nest as savepoints', async () => {
    const slugs = async (prefix: string) =>
      (await admin`SELECT slug FROM projects WHERE org_id = ${orgA} AND slug LIKE ${`${prefix}-%`} ORDER BY slug`).map(
        (r) => r.slug,
      );
    const ok = await app.inject({ method: 'POST', url: '/probe/tx', payload: { org_id: orgA, prefix: `txok-${tag}`, failOuter: false } });
    expect(ok.json()).toEqual({ ok: true });
    expect(await slugs(`txok-${tag}`)).toEqual([`txok-${tag}-after`, `txok-${tag}-outer`]);

    const bad = await app.inject({ method: 'POST', url: '/probe/tx', payload: { org_id: orgA, prefix: `txbad-${tag}`, failOuter: true } });
    expect(bad.json()).toEqual({ ok: false });
    expect(await slugs(`txbad-${tag}`)).toEqual([]);
  });

  it('refuses a wrong internal secret', async () => {
    const res = await ensure({ ...body, slug: `nosecret-${tag}` }, 'wrong-secret');
    expect(res.statusCode).toBe(401);
    expect(await admin`SELECT 1 FROM projects WHERE slug = ${`nosecret-${tag}`}`).toHaveLength(0);
  });
});
