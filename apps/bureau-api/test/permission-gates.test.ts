// Issue #153: every Bureau route is gated by a catalogued bureau.* permission, and the
// built-in group defaults (migration 0268) let owners, admins and members through every
// route they could use before the gate existed. Members are held back only from the four
// admin-only actions whose handlers already refuse non-admins.
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
      active_org_id: '00000000-0000-0000-0000-0000000000aa',
      role,
      is_superuser: false,
      api_key_scope: null,
    };
  },
  requireScope: () => async () => {},
}));

type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

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
  const viewerExtra = listAfter('OR p.id IN');
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'docs/permissions-action-manifest.json'), 'utf8')) as {
    permissions: Array<{ id: string; app: string; is_read: boolean; requires_superuser: boolean }>;
  };
  const rows = new Map(manifest.permissions.filter((p) => p.app === app).map((p) => [p.id, p]));
  return {
    rows,
    memberDenied,
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

const grants = loadGrants('bureau');
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
    import('../src/routes/bookings.routes.js'),
    import('../src/routes/chat.routes.js'),
    import('../src/routes/floors.routes.js'),
    import('../src/routes/knocks.routes.js'),
    import('../src/routes/livekit.routes.js'),
    import('../src/routes/me-status.routes.js'),
    import('../src/routes/offices.routes.js'),
    import('../src/routes/presence-here.routes.js'),
    import('../src/routes/presence-where.routes.js'),
    import('../src/routes/ring.routes.js'),
    import('../src/routes/rooms.routes.js'),
    import('../src/routes/settings.routes.js'),
    import('../src/routes/summons.routes.js'),
  ]);
  for (const mod of modules) await app.register(mod.default, { prefix: '/v1' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const concrete = (url: string) =>
  url.replace(/:roomKey/g, 'room-1').replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000002');

async function hit(role: Role, method: string, url: string) {
  return app.inject({ method: method as 'GET', url, headers: { 'x-test-role': role } });
}

describe('Bureau route permission gates (issue #153)', () => {
  it('registers the full route surface', () => {
    expect(routes.length).toBeGreaterThanOrEqual(40);
  });

  it('gates every route with exactly one catalogued bureau.* id', () => {
    for (const r of routes) {
      expect(r.ids, `${r.method} ${r.url}`).toHaveLength(1);
      expect(grants.rows.has(r.ids[0]!), `${r.method} ${r.url} -> ${r.ids[0]}`).toBe(true);
    }
  });

  it('uses every catalogued bureau.* id somewhere', () => {
    const used = new Set(routes.flatMap((r) => r.ids));
    expect([...grants.rows.keys()].filter((id) => !used.has(id))).toEqual([]);
  });

  it.each(['owner', 'admin'] as const)('lets an %s through every route', async (role) => {
    for (const r of routes) {
      const res = await hit(role, r.method, concrete(r.url));
      expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(204);
    }
  });

  it('lets a member through every route except the four admin-only actions', async () => {
    expect([...grants.memberDenied].sort()).toEqual(
      ['bureau.chat.configure', 'bureau.floor.write', 'bureau.office.assign', 'bureau.settings.write'],
    );
    for (const r of routes) {
      const res = await hit('member', r.method, concrete(r.url));
      const expected = grants.memberDenied.has(r.ids[0]!) ? 403 : 204;
      expect(res.statusCode, `member ${r.method} ${r.url}`).toBe(expected);
    }
  });

  it('keeps the member flows the product depends on open', async () => {
    const id = '00000000-0000-0000-0000-000000000002';
    for (const [method, url] of [
      ['GET', '/v1/floors'],
      ['GET', '/v1/rooms'],
      ['POST', `/v1/rooms/${id}/token`],
      ['POST', '/v1/knocks'],
      ['PATCH', `/v1/knocks/${id}`],
      ['POST', '/v1/summon'],
      ['POST', '/v1/ring'],
      ['PATCH', '/v1/me/status'],
      ['POST', `/v1/rooms/${id}/bookings`],
      ['PATCH', `/v1/rooms/${id}/door`],
    ] as const) {
      expect((await hit('member', method, url)).statusCode, `${method} ${url}`).toBe(204);
    }
  });

  it('lets a viewer read, set status and join a call, but not write', async () => {
    const id = '00000000-0000-0000-0000-000000000002';
    expect((await hit('viewer', 'GET', '/v1/presence/here')).statusCode).toBe(204);
    expect((await hit('viewer', 'PATCH', '/v1/me/status')).statusCode).toBe(204);
    expect((await hit('viewer', 'POST', `/v1/rooms/${id}/token`)).statusCode).toBe(204);
    expect((await hit('viewer', 'POST', '/v1/rooms')).statusCode).toBe(403);
    expect((await hit('viewer', 'POST', '/v1/knocks')).statusCode).toBe(403);
  });

  it('denies a guest and still requires a session first', async () => {
    expect((await hit('guest', 'GET', '/v1/rooms')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/rooms' })).statusCode).toBe(401);
  });
});
