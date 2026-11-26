// Issue #153: every Blueprint route is gated by a catalogued blueprint.* permission,
// and the built-in group defaults (migration 0268) let owners, admins and members
// through every route they could use before the gate existed.
//
// The route modules are registered for real. requireAuth is mocked to a header-driven
// user, and fastify.requireCan is a stand-in resolver that answers from the grant matrix
// in migration 0268 itself (the file that seeds production), read at test time. A
// granted request short-circuits with 204 before the handler, so no database is needed;
// a denied one gets the 403 the real plugin sends in enforce mode.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..', '..');

vi.mock('../src/env.js', () => ({
  env: new Proxy({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost' } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : undefined),
  }),
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.headers['x-test-role'];
    if (typeof role !== 'string') return reply.status(401).send({ error: { code: 'UNAUTHORIZED' } });
    (request as unknown as { user: unknown }).user = {
      id: '00000000-0000-0000-0000-000000000001',
      org_id: '00000000-0000-0000-0000-0000000000aa',
      role,
      is_superuser: false,
      api_key_scope: null,
    };
  },
  requireScope: () => async () => {},
}));

type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer', 'guest'];

/** Grant matrix read from the seeding migration, plus is_read from the manifest. */
function loadGrants(app: string) {
  const sql = readFileSync(
    resolve(REPO, 'infra/postgres/migrations/0268_blueprint_bureau_builtin_group_defaults.sql'),
    'utf8',
  );
  const listAfter = (marker: string) => {
    const at = sql.indexOf(marker);
    const open = sql.indexOf('(', sql.indexOf(' IN', at));
    const close = sql.indexOf(')', open);
    return new Set([...sql.slice(open, close).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!));
  };
  const memberDenied = listAfter("WHEN 'member'");
  const viewerExtra = listAfter("OR p.id IN");
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'docs/permissions-action-manifest.json'), 'utf8')) as {
    permissions: Array<{ id: string; app: string; is_read: boolean; requires_superuser: boolean }>;
  };
  const rows = new Map(manifest.permissions.filter((p) => p.app === app).map((p) => [p.id, p]));
  return {
    rows,
    granted(role: Role, id: string): boolean {
      const p = rows.get(id);
      if (!p || p.requires_superuser) return false;
      if (role === 'owner' || role === 'admin') return true;
      if (role === 'member') return !memberDenied.has(id);
      if (role === 'viewer') return p.is_read || viewerExtra.has(id);
      return false;
    },
  };
}

const grants = loadGrants('blueprint');
const routes: Array<{ method: string; url: string; ids: string[] }> = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.decorate('requireCan', (id: string) => {
    const gate = async (request: FastifyRequest, reply: FastifyReply) => {
      const role = (request as unknown as { user: { role: Role } }).user.role;
      if (!grants.granted(role, id)) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', permission: id } });
      }
      return reply.status(204).header('x-permission', id).send();
    };
    return Object.assign(gate, { permissionId: id });
  });
  app.addHook('onRoute', (opts) => {
    const handlers = ([] as unknown[]).concat(opts.preHandler ?? []);
    const ids = handlers
      .map((h) => (h as { permissionId?: string }).permissionId)
      .filter((x): x is string => typeof x === 'string');
    for (const method of ([] as string[]).concat(opts.method as string | string[])) {
      if (method === 'HEAD') continue;
      routes.push({ method, url: opts.url, ids });
    }
  });
  const modules = await Promise.all([
    import('../src/routes/diagrams.routes.js'),
    import('../src/routes/nodes.routes.js'),
    import('../src/routes/edges.routes.js'),
    import('../src/routes/templates.routes.js'),
    import('../src/routes/cross-product.routes.js'),
  ]);
  for (const mod of modules) await app.register(mod.default, { prefix: '/v1' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const publicRoutes = () => routes.filter((r) => !r.url.startsWith('/v1/internal/'));
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, (p) => (p === ':n' ? '1' : '00000000-0000-0000-0000-000000000002'));

describe('Blueprint route permission gates (issue #153)', () => {
  it('registers the full route surface', () => {
    expect(publicRoutes().length).toBeGreaterThanOrEqual(30);
  });

  it('gates every public route with exactly one catalogued blueprint.* id', () => {
    for (const r of publicRoutes()) {
      expect(r.ids, `${r.method} ${r.url}`).toHaveLength(1);
      expect(grants.rows.has(r.ids[0]!), `${r.method} ${r.url} -> ${r.ids[0]}`).toBe(true);
    }
  });

  it('uses every catalogued blueprint.* id somewhere', () => {
    const used = new Set(publicRoutes().flatMap((r) => r.ids));
    expect([...grants.rows.keys()].filter((id) => !used.has(id))).toEqual([]);
  });

  it.each(['owner', 'admin', 'member'] as const)('lets a %s through every route', async (role) => {
    for (const r of publicRoutes()) {
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url), headers: { 'x-test-role': role } });
      expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(204);
      expect(res.headers['x-permission']).toBe(r.ids[0]);
    }
  });

  it('lets a viewer read and star but not edit', async () => {
    const expectStatus = async (method: string, url: string, status: number) => {
      const res = await app.inject({ method: method as 'GET', url, headers: { 'x-test-role': 'viewer' } });
      expect(res.statusCode, `${method} ${url}`).toBe(status);
    };
    const id = '00000000-0000-0000-0000-000000000002';
    await expectStatus('GET', '/v1/diagrams', 204);
    await expectStatus('GET', `/v1/diagrams/${id}/graph`, 204);
    await expectStatus('POST', `/v1/diagrams/${id}/star`, 204);
    await expectStatus('PATCH', `/v1/diagrams/${id}`, 403);
    await expectStatus('POST', `/v1/diagrams/${id}/nodes`, 403);
    await expectStatus('POST', `/v1/diagrams/${id}/archive`, 403);
  });

  it('denies a guest everywhere and still requires a session first', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/diagrams', headers: { 'x-test-role': 'guest' } });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/v1/diagrams' });
    expect(anon.statusCode).toBe(401);
  });

  it('covers every built-in role in the matrix', () => {
    expect(ROLES.map((r) => grants.granted(r, 'blueprint.diagram.read'))).toEqual([true, true, true, true, false]);
  });
});
