import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkKeyProjectAccess, requireKeyProjectChecked } from './key-project.js';

/**
 * #367: the fail-closed final gate (#352) refused a project-restricted key on GET /auth/me, which
 * the MCP policy gate uses to identify its caller, so every restricted agent lost every tool. An
 * identity-only route can now declare `config.keyProjectExempt` (true, or a predicate).
 */
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROJ = '33333333-3333-4333-8333-333333333333';

describe('requireKeyProjectChecked and keyProjectExempt', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      const restricted = request.headers['x-restricted'] === '1';
      (request as unknown as { user: unknown }).user = {
        id: ME,
        api_key_project_ids: restricted ? [PROJ] : null,
      };
    });
    // Same wiring as apps/api/src/plugins/auth.ts: the gate is the LAST preHandler of every route.
    app.addHook('onRoute', (route) => {
      const existing = route.preHandler;
      const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
      route.preHandler = [...list, requireKeyProjectChecked];
    });
    app.get('/auth/me', { config: { keyProjectExempt: true } }, async () => ({ ok: true }));
    app.patch('/auth/me', async () => ({ ok: true }));
    app.get('/projects', async () => ({ ok: true }));
    app.get<{ Params: { id: string } }>(
      '/projects/:id/tasks',
      {
        preHandler: async (request, reply) => {
          if (!checkKeyProjectAccess(request, request.params.id)) return reply.status(404).send({});
        },
      },
      async () => ({ ok: true }),
    );
    app.post<{ Params: { agent_user_id: string } }>(
      '/v1/agent-policies/:agent_user_id/check',
      {
        config: {
          keyProjectExempt: (req) =>
            (req.params as { agent_user_id?: string }).agent_user_id ===
            (req as unknown as { user?: { id?: string } }).user?.id,
        },
      },
      async () => ({ ok: true }),
    );
    app.get('/throws', { config: { keyProjectExempt: () => { throw new Error('boom'); } } }, async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, restricted: boolean) =>
    app.inject({ method, url, headers: restricted ? { 'x-restricted': '1' } : {} });

  it('lets a restricted key read GET /auth/me', async () => {
    expect((await call('GET', '/auth/me', true)).statusCode).toBe(200);
  });

  it('still refuses a restricted key on PATCH /auth/me and other org-wide routes', async () => {
    for (const [m, u] of [['PATCH', '/auth/me'], ['GET', '/projects']] as const) {
      const res = await call(m, u, true);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('API_KEY_PROJECT_RESTRICTED');
    }
  });

  it('still admits a restricted key to its own project only', async () => {
    expect((await call('GET', `/projects/${PROJ}/tasks`, true)).statusCode).toBe(200);
    expect((await call('GET', `/projects/${OTHER}/tasks`, true)).statusCode).toBe(404);
  });

  it('applies a predicate exemption only when it returns true (self-only policy check)', async () => {
    expect((await call('POST', `/v1/agent-policies/${ME}/check`, true)).statusCode).toBe(200);
    expect((await call('POST', `/v1/agent-policies/${OTHER}/check`, true)).statusCode).toBe(403);
  });

  it('treats a throwing predicate as not exempt (fail closed)', async () => {
    expect((await call('GET', '/throws', true)).statusCode).toBe(403);
  });

  it('leaves unrestricted callers alone', async () => {
    for (const [m, u] of [['PATCH', '/auth/me'], ['GET', '/projects'], ['POST', `/v1/agent-policies/${OTHER}/check`]] as const) {
      expect((await call(m, u, false)).statusCode).toBe(200);
    }
  });
});
