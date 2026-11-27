import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { keyProjectAccessChecked } from '@bigbluebam/auth-core';
import { httpPermissionsPlugin, permissionsPlugin, type EnforcementMode, type PermissionContext } from '../index.js';

// #352: an API key's project restriction (api_keys.project_ids) is enforced by requireCan and
// canResolve in every enforcement mode, and fails closed when the check has no project.

const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type TestUser = { id: string; api_key_project_ids: string[] | null };

const ALLOW_ALL_CTX = {
  subject: { id: 'u', is_superuser: true, kind: 'human', api_key_scope: null },
  memberships: [],
  account_overrides: [],
  group_defaults: new Map(),
} as unknown as PermissionContext;

async function build(kind: 'local' | 'http', mode: EnforcementMode): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers['x-test-projects'];
    (req as unknown as { user: TestUser }).user = {
      id: 'u',
      api_key_project_ids: typeof h === 'string' ? (h === 'none' ? null : h === 'empty' ? [] : h.split(',')) : null,
    };
  });
  const projectOf = (req: FastifyRequest) => (req.params as { projectId?: string }).projectId ?? null;
  if (kind === 'local') {
    await app.register(permissionsPlugin, {
      mode,
      contextLoader: async () => ALLOW_ALL_CTX,
      scopeLoader: (req) => ({ org_id: 'o', project_id: projectOf(req) }),
    });
  } else {
    await app.register(httpPermissionsPlugin, {
      mode,
      apiInternalUrl: 'http://127.0.0.1:1',
      internalSecret: 'x'.repeat(32),
      getCaller: () => ({ user_id: 'u', org_id: 'o' }),
      getProjectId: projectOf,
      timeoutMs: 50,
    });
  }
  app.get('/projects/:projectId/tasks', { preHandler: [app.requireCan('bam.task.list')] }, async (req) => ({
    checked: keyProjectAccessChecked(req),
  }));
  app.get('/org-wide', { preHandler: [app.requireCan('bam.project.list')] }, async () => ({ ok: true }));
  app.get('/probe/:projectId', async (req) => ({
    here: await app.canResolve(req, 'bam.task.list'),
    other: await app.canResolve(req, 'bam.task.list', { org_id: 'o', project_id: PROJ_B }),
    checked: keyProjectAccessChecked(req),
  }));
  await app.ready();
  return app;
}

for (const kind of ['local', 'http'] as const) {
  for (const mode of ['off', 'warn'] as const) {
    describe(`${kind} plugin, mode ${mode}: API key project restriction (#352)`, () => {
      it('admits a key restricted to the route project and records the check', async () => {
        const app = await build(kind, mode);
        const res = await app.inject({ url: `/projects/${PROJ_A}/tasks`, headers: { 'x-test-projects': PROJ_A } });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ checked: true });
        await app.close();
      });

      it('refuses a key restricted to another project', async () => {
        const app = await build(kind, mode);
        const res = await app.inject({ url: `/projects/${PROJ_B}/tasks`, headers: { 'x-test-projects': PROJ_A } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('API_KEY_PROJECT_RESTRICTED');
        await app.close();
      });

      it('refuses a restricted key on a check with no project (fails closed)', async () => {
        const app = await build(kind, mode);
        const res = await app.inject({ url: '/org-wide', headers: { 'x-test-projects': PROJ_A } });
        expect(res.statusCode).toBe(403);
        await app.close();
      });

      it('leaves unrestricted keys, empty restrictions and sessions alone', async () => {
        const app = await build(kind, mode);
        for (const h of ['none', 'empty']) {
          const res = await app.inject({ url: '/org-wide', headers: { 'x-test-projects': h } });
          expect(res.statusCode, `${h}: ${res.body}`).toBe(200);
        }
        await app.close();
      });

      it('answers canResolve per project without recording a check', async () => {
        const app = await build(kind, mode);
        const res = await app.inject({ url: `/probe/${PROJ_A}`, headers: { 'x-test-projects': PROJ_A } });
        expect(res.json()).toEqual({ here: true, other: false, checked: false });
        await app.close();
      });
    });
  }
}
