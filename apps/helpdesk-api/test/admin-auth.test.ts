import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The helpdesk admin routes (settings, admin/projects, helpdesk-user upsert,
// count-by-phrase) used to check only that some Bam session existed, while
// the org came from the client's X-Org-Slug header or an unscoped "first
// org" fallback. requireAdminAuth must tie the caller to the target org.

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

interface Person {
  activeOrg: string | null;
  homeOrg: string | null;
  superuser?: boolean;
  roles: Record<string, string | null>; // org -> role (null = member with no role row)
}
const people: Record<string, Person> = {};
const sessions: Record<string, string> = {};
const agentKeys: Record<string, string> = {};

const dialect = new PgDialect();
vi.mock('../src/db/index.js', () => ({
  db: {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      if (sql.includes('FROM sessions')) {
        const uid = sessions[params[0] as string];
        if (!uid) return [];
        const p = people[uid]!;
        return [{ user_id: uid, org_id: p.activeOrg ?? p.homeOrg }];
      }
      if (sql.includes('is_superuser')) return people[params[0] as string]?.superuser ? [{ ok: 1 }] : [];
      if (sql.includes('FROM organization_memberships')) {
        const p = people[params[0] as string];
        const org = params[1] as string;
        return p && org in p.roles ? [{ role: p.roles[org] }] : [];
      }
      if (sql.includes('FROM users')) return [{ org_id: people[params[0] as string]?.homeOrg ?? null }];
      throw new Error(`unexpected query: ${sql}`);
    },
  },
  connection: { end: vi.fn() },
}));
vi.mock('../src/lib/agent-auth.js', () => ({
  verifyAgentApiKey: async (_req: unknown, token: string | undefined) => (token ? (agentKeys[token] ?? null) : null),
}));

// Bam API keys (Bearer bbam_...), the credential the MCP server forwards (#325).
const bamKeys: Record<string, { userId: string; keyOrgId: string; scope: string; isSuperuser: boolean }> = {};
vi.mock('../src/lib/bam-api-key.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/bam-api-key.js')>();
  return {
    bamBearerToken: real.bamBearerToken,
    verifyBamApiKey: async (_req: unknown, token: string) => bamKeys[token] ?? null,
  };
});

import { requireAdminAuth } from '../src/lib/admin-auth.js';

describe('helpdesk requireAdminAuth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // Stand-ins for @fastify/cookie and the resolve-tenant plugin.
    app.decorateRequest('cookies', null as unknown as FastifyRequest['cookies']);
    app.decorateRequest('tenantContext', null as unknown as FastifyRequest['tenantContext']);
    app.addHook('onRequest', async (req) => {
      const cookie = req.headers.cookie?.match(/session=([^;]+)/)?.[1];
      (req as unknown as { cookies: Record<string, string> }).cookies = cookie ? { session: cookie } : {};
      const slug = req.headers['x-org-slug'];
      (req as unknown as { tenantContext: { orgId: string | null } }).tenantContext = {
        orgId: slug === 'org-a' ? ORG_A : slug === 'org-b' ? ORG_B : null,
      };
    });
    app.get('/admin', { preHandler: [requireAdminAuth] }, async (req) => ({ org: req.tenantContext.orgId }));
    app.patch('/admin', { preHandler: [requireAdminAuth] }, async (req) => ({ org: req.tenantContext.orgId }));
    await app.ready();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    for (const k of Object.keys(people)) delete people[k];
    for (const k of Object.keys(sessions)) delete sessions[k];
    for (const k of Object.keys(agentKeys)) delete agentKeys[k];
    for (const k of Object.keys(bamKeys)) delete bamKeys[k];
    bamKeys.bbam_admin_a = { userId: 'adminA', keyOrgId: ORG_A, scope: 'admin', isSuperuser: false };
    bamKeys.bbam_admin_a_read = { userId: 'adminA', keyOrgId: ORG_A, scope: 'read', isSuperuser: false };
    bamKeys.bbam_viewer_a = { userId: 'viewerA', keyOrgId: ORG_A, scope: 'admin', isSuperuser: false };
    bamKeys.bbam_superuser = { userId: 'su', keyOrgId: ORG_A, scope: 'admin', isSuperuser: true };
    people.adminA = { activeOrg: ORG_A, homeOrg: ORG_A, roles: { [ORG_A]: 'admin' } };
    people.viewerA = { activeOrg: ORG_A, homeOrg: ORG_A, roles: { [ORG_A]: 'viewer' } };
    people.su = { activeOrg: ORG_A, homeOrg: ORG_A, superuser: true, roles: {} };
    people.agentA = { activeOrg: null, homeOrg: ORG_A, roles: { [ORG_A]: 'member' } };
    sessions.s_admin = 'adminA';
    sessions.s_viewer = 'viewerA';
    sessions.s_su = 'su';
    agentKeys.hdag_a = 'agentA';
  });

  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/admin', headers });

  it('401s without a session or agent key', async () => {
    expect((await get({})).statusCode).toBe(401);
  });

  it("refuses an admin of org A who names org B's slug", async () => {
    const res = await get({ cookie: 'session=s_admin', 'x-org-slug': 'org-b' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a viewer of the org', async () => {
    expect((await get({ cookie: 'session=s_viewer', 'x-org-slug': 'org-a' })).statusCode).toBe(403);
  });

  it("lets an org admin through and defaults a header-less call to the caller's own org", async () => {
    const res = await get({ cookie: 'session=s_admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org).toBe(ORG_A);
  });

  it('lets a SuperUser administer any org', async () => {
    expect((await get({ cookie: 'session=s_su', 'x-org-slug': 'org-b' })).statusCode).toBe(200);
  });

  describe('Bam API key as Bearer (#325, what the MCP helpdesk tools send)', () => {
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

    it("accepts an org admin's key and defaults to the key's org", async () => {
      const res = await get(bearer('bbam_admin_a'));
      expect(res.statusCode).toBe(200);
      expect(res.json().org).toBe(ORG_A);
    });

    it('rejects an unknown key with 401', async () => {
      expect((await get(bearer('bbam_nope_nope'))).statusCode).toBe(401);
    });

    it("refuses a non-admin's key", async () => {
      expect((await get(bearer('bbam_viewer_a'))).statusCode).toBe(403);
    });

    it('pins a non-SuperUser key to its own org', async () => {
      expect((await get({ ...bearer('bbam_admin_a'), 'x-org-slug': 'org-b' })).statusCode).toBe(403);
    });

    it("requires 'admin' scope for a write, any scope for a read", async () => {
      expect((await get(bearer('bbam_admin_a_read'))).statusCode).toBe(200);
      const patch = (k: string) => app.inject({ method: 'PATCH', url: '/admin', headers: bearer(k), payload: {} });
      expect((await patch('bbam_admin_a_read')).statusCode).toBe(403);
      expect((await patch('bbam_admin_a')).statusCode).toBe(200);
    });

    it('lets a SuperUser key administer any org', async () => {
      expect((await get({ ...bearer('bbam_superuser'), 'x-org-slug': 'org-b' })).statusCode).toBe(200);
    });
  });

  it("accepts an agent key in its own org and refuses it in another", async () => {
    expect((await get({ 'x-agent-key': 'hdag_a' })).statusCode).toBe(200);
    expect((await get({ 'x-agent-key': 'hdag_a', 'x-org-slug': 'org-b' })).statusCode).toBe(403);
  });
});

describe('helpdesk admin route files', () => {
  const routes = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'routes');
  it.each(['settings.routes.ts', 'users.routes.ts', 'analytics.routes.ts'])(
    '%s uses the shared guard and never falls back to an arbitrary org',
    (file) => {
      const src = readFileSync(join(routes, file), 'utf8');
      expect(src).toMatch(/import \{ requireAdminAuth \} from '\.\.\/lib\/admin-auth\.js'/);
      expect(src).not.toMatch(/function requireAdminAuth/);
      // The old fallbacks: an unscoped settings row or "the first org".
      expect(src).not.toMatch(/\.from\(organizations\)\s*\.limit\(1\)/);
      expect(src).not.toMatch(/orgId\s*\?\s*await db/);
    },
  );
});
