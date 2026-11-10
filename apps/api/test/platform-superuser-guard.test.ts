import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type InjectOptions,
} from 'fastify';

// These tests run in the production posture: requireCan is a no-op, which is
// what BBB_PERMISSIONS_ENFORCE=off (the default) does. The SuperUser-only
// route files must still refuse non-SuperUsers in that posture.

const { failingDb } = vi.hoisted(() => {
  const fail = (): never => {
    throw new Error('db not available in this test');
  };
  const failingDb: unknown = new Proxy(fail, { get: () => fail, apply: fail });
  return { failingDb };
});

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));
vi.mock('../src/db/index.js', () => ({ db: failingDb, connection: { end: vi.fn() } }));
vi.mock('../src/services/session.service.js', () => ({
  setActiveOrgId: vi.fn(),
  clearActiveOrgId: vi.fn(),
}));
vi.mock('../src/services/superuser-audit.service.js', () => ({ logSuperuserAction: vi.fn() }));
vi.mock('../src/services/permissions.service.js', () => ({ invalidatePermissionsForUser: vi.fn() }));
vi.mock('../src/services/priorities.service.js', () => ({ seedDefaultPriorities: vi.fn() }));
vi.mock('../src/services/role-resolver.js', () => ({
  resolveOrgUserRoles: vi.fn(),
  resolveUserOrgRole: vi.fn(),
}));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
  },
}));

import { requirePlatformSuperuser } from '../src/middleware/require-platform-superuser.js';
import platformRoutes from '../src/routes/platform.routes.js';
import superuserRoutes from '../src/routes/superuser.routes.js';
import permissionsAdminRoutes from '../src/routes/permissions-admin.routes.js';
import permissionsDivergencesRoutes from '../src/routes/permissions-divergences.routes.js';
import deploySettingsRoutes from '../src/routes/deploy-settings.routes.js';

type Caller = 'none' | 'member' | 'superuser-session' | 'superuser-apikey' | 'impersonating';

// Synthetic auth, standing in for the real auth plugin's global preHandler.
function installAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('isImpersonating', false);
  app.decorateRequest('impersonator', null);
  app.addHook('preHandler', async (req) => {
    // Loose view of the request so the synthetic identities can be partial.
    const request = req as unknown as Record<string, unknown> & { headers: FastifyRequest['headers'] };
    const who = request.headers['x-test-caller'] as Caller | undefined;
    if (who === 'member') {
      request.user = { id: 'member-1', is_superuser: false };
      request.sessionId = 'sess-member';
    } else if (who === 'superuser-session') {
      request.user = { id: 'su-1', is_superuser: true };
      request.sessionId = 'sess-su';
    } else if (who === 'superuser-apikey') {
      // API-key auth: a user, but no browser session.
      request.user = { id: 'su-1', is_superuser: true };
      request.sessionId = null;
    } else if (who === 'impersonating') {
      // During impersonation request.user is the impersonated (normal) user.
      request.user = { id: 'member-1', is_superuser: false };
      request.sessionId = 'sess-su';
      request.isImpersonating = true;
      request.impersonator = { id: 'su-1', is_superuser: true };
    }
  });
}

const as = (caller: Caller) => (caller === 'none' ? {} : { 'x-test-caller': caller });

describe('requirePlatformSuperuser (unit)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    installAuth(app);
    await app.register(async (scoped) => {
      scoped.addHook('preHandler', requirePlatformSuperuser);
      scoped.get('/v1/platform/probe', async () => ({ ok: true }));
      scoped.post('/v1/platform/stop-impersonation', async () => ({ ok: true }));
    });
    // Outside the guarded plugin: must not be affected (encapsulation).
    app.get('/v1/me', async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(() => app.close());

  it('returns 401 with no authenticated user', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/platform/probe', headers: as('none') });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a non-SuperUser', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/platform/probe', headers: as('member') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('allows a SuperUser signed in with a browser session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/platform/probe', headers: as('superuser-session') });
    expect(res.statusCode).toBe(200);
  });

  it('allows a SuperUser authenticated with an API key (no session)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/platform/probe', headers: as('superuser-apikey') });
    expect(res.statusCode).toBe(200);
  });

  it('keeps stop-impersonation reachable while impersonating a normal user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/platform/stop-impersonation',
      headers: as('impersonating'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not leak to routes registered outside the guarded plugin', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: as('member') });
    expect(res.statusCode).toBe(200);
  });
});

describe('SuperUser route files are guarded with requireCan as a no-op (prod posture)', () => {
  let app: FastifyInstance;
  const routes: Array<{ method: string; url: string }> = [];

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // BBB_PERMISSIONS_ENFORCE=off: requireCan never blocks.
    app.decorate('requireCan', () => async () => {});
    installAuth(app);
    app.addHook('onRoute', (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) if (m !== 'HEAD') routes.push({ method: m, url: r.url });
    });
    await app.register(platformRoutes);
    await app.register(superuserRoutes, { prefix: '/superuser' });
    await app.register(permissionsAdminRoutes);
    await app.register(permissionsDivergencesRoutes);
    await app.register(deploySettingsRoutes);
    await app.ready();
  });
  afterAll(() => app.close());

  // Fill path params with a valid-looking UUID so param validation passes.
  const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, '11111111-1111-4111-8111-111111111111');

  it('registers the expected SuperUser routes', () => {
    // 11 platform + 24 superuser + 13 permissions admin + 2 divergences + 3 deploy.
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  it('returns 403 to a non-SuperUser on every route except stop-impersonation', async () => {
    const notBlocked: string[] = [];
    for (const r of routes) {
      if (r.url === '/v1/platform/stop-impersonation') continue;
      const res = await app.inject({ method: r.method as InjectOptions['method'], url: concrete(r.url), headers: as('member'), payload: {} });
      if (res.statusCode !== 403) notBlocked.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(notBlocked).toEqual([]);
  });

  it('lets a SuperUser API key past the guard on every route', async () => {
    const blocked: string[] = [];
    for (const r of routes) {
      const res = await app.inject({
        method: r.method as InjectOptions['method'],
        url: concrete(r.url),
        headers: as('superuser-apikey'),
        payload: {},
      });
      const body = res.body.includes('SuperUser access required');
      if (res.statusCode === 401 || body) blocked.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(blocked).toEqual([]);
  });

  it('still lets an impersonating SuperUser call stop-impersonation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/platform/stop-impersonation',
      headers: as('impersonating'),
      payload: {},
    });
    expect(res.body).not.toContain('SuperUser access required');
    expect(res.statusCode).not.toBe(401);
  });
});
