import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import {
  createSatelliteAuth,
  sqlSatelliteAuthStore,
  type ApiKeyCandidate,
  type ApiKeyStore,
  type LiveMembershipRow,
  type OrgContextStore,
  type SatelliteAuthOptions,
  type SatelliteAuthStore,
  type SatelliteUserRow,
} from './index.js';

// #369: the satellites' auth plugin, driven through Fastify with in-memory stores.

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = '33333333-3333-4333-8333-333333333333';
const SU = '44444444-4444-4444-8444-444444444444';
const SKIPPER = '55555555-5555-4555-8555-555555555555';
const GINGER = '66666666-6666-4666-8666-666666666666';
const KEY = 'bbam_svc_testkeytestkeytestkey';

const user = (id: string, over: Partial<SatelliteUserRow> = {}): SatelliteUserRow => ({
  id,
  org_id: ORG_A,
  email: `${id}@example.test`,
  display_name: id,
  avatar_url: null,
  timezone: 'UTC',
  is_active: true,
  is_superuser: false,
  ...over,
});

const USERS: Record<string, SatelliteUserRow> = {
  [SU]: user(SU, { is_superuser: true }),
  [SKIPPER]: user(SKIPPER),
  [GINGER]: user(GINGER),
};

// SKIPPER: admin of A (default), member of B. GINGER: member of A. SU: member of A only.
const MEMBERSHIPS: Record<string, LiveMembershipRow[]> = {
  [SKIPPER]: [
    { org_id: ORG_A, is_default: true, joined_at: new Date('2026-01-01') },
    { org_id: ORG_B, is_default: false, joined_at: new Date('2026-02-01') },
  ],
  [GINGER]: [{ org_id: ORG_A, is_default: true, joined_at: new Date('2026-01-01') }],
  [SU]: [{ org_id: ORG_A, is_default: true, joined_at: new Date('2026-01-01') }],
};
const ROLES: Record<string, Record<string, string>> = { [SKIPPER]: { [ORG_A]: 'admin', [ORG_B]: 'member' } };

const orgContext: OrgContextStore = {
  loadLiveMemberships: async (u) => MEMBERSHIPS[u] ?? [],
  loadOrgRoles: async (u) => new Map(Object.entries(ROLES[u] ?? {})),
  isLiveOrg: async (o) => [ORG_A, ORG_B, ORG_C].includes(o),
};

interface Fixture {
  sessions?: Record<string, { user: string; expires_at?: Date; active_org_id?: string | null }>;
  impersonations?: Array<[string, string]>;
  key?: { owner: string; org_id: string | null; scope?: string; project_ids?: string[] | null };
}

function stores(f: Fixture) {
  const auth: SatelliteAuthStore = {
    findSession: async (id) => {
      const s = f.sessions?.[id];
      if (!s) return null;
      return {
        expires_at: s.expires_at ?? new Date(Date.now() + 3_600_000),
        active_org_id: s.active_org_id ?? null,
        user: USERS[s.user] as SatelliteUserRow,
      };
    },
    findUser: async (id) => USERS[id] ?? null,
    hasActiveImpersonation: async (su, target) =>
      (f.impersonations ?? []).some(([a, b]) => a === su && b === target),
  };
  const touch = vi.fn(async () => {});
  const apiKeys: ApiKeyStore = {
    findCandidates: async () => {
      if (!f.key) return [];
      const owner = USERS[f.key.owner] as SatelliteUserRow;
      const c: ApiKeyCandidate = {
        apiKey: {
          id: 'key-1',
          user_id: owner.id,
          org_id: f.key.org_id,
          scope: f.key.scope ?? 'read',
          key_hash: 'h',
          project_ids: f.key.project_ids ?? null,
          expires_at: null,
          rotated_at: null,
          rotation_grace_expires_at: null,
        },
        user: { ...owner, kind: 'human' },
      };
      return [c];
    },
    verifyHash: async (_h, token) => token === KEY,
    touch,
  };
  return { auth, apiKeys, touch };
}

async function app(f: Fixture, opts: Partial<SatelliteAuthOptions> = {}) {
  const s = stores(f);
  const auth = createSatelliteAuth({
    sql: () => {
      throw new Error('SQL must not run with injected stores');
    },
    execute: async () => [],
    verifyHash: async () => false,
    stores: { auth: s.auth, apiKeys: s.apiKeys, orgContext },
    ...opts,
  });
  const fastify = Fastify({ logger: false });
  // Stand-in for @fastify/cookie: only the `session` cookie is read.
  fastify.addHook('onRequest', async (req) => {
    const m = /(?:^|;\s*)session=([^;]+)/.exec(String(req.headers.cookie ?? ''));
    (req as unknown as { cookies: Record<string, string> }).cookies = m?.[1] ? { session: m[1] } : {};
  });
  // Services wrap the plugin with fastify-plugin (no encapsulation); applying it to the root
  // instance directly is the same thing without that dependency here.
  await auth.plugin(fastify);
  fastify.get('/me', { preHandler: [auth.requireAuth] }, async (req: FastifyRequest) => {
    const r = req as unknown as {
      user: { id: string; active_org_id: string; org_id: string; role: string; api_key_scope: string | null; kind?: string };
      sessionId: string | null;
      impersonator: { id: string } | null;
      isImpersonating: boolean;
    };
    return {
      id: r.user.id,
      org: r.user.active_org_id,
      org_id: r.user.org_id,
      role: r.user.role,
      scope: r.user.api_key_scope,
      kind: r.user.kind ?? null,
      sessionId: r.sessionId,
      impersonator: r.impersonator?.id ?? null,
      impersonating: r.isImpersonating,
      orgHeader: req.headers['x-org-id'] ?? null,
    };
  });
  await fastify.ready();
  return { fastify, touch: s.touch };
}

const get = (f: Awaited<ReturnType<typeof app>>, headers: Record<string, string> = {}) =>
  f.fastify.inject({ method: 'GET', url: '/me', headers });

describe('createSatelliteAuth: session cookie', () => {
  it('authenticates a live session with the default org and its role', async () => {
    const a = await app({ sessions: { s1: { user: SKIPPER } } });
    const res = await get(a, { cookie: 'session=s1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: SKIPPER, org: ORG_A, role: 'admin', scope: null, sessionId: 's1' });
  });

  it('refuses an expired session and a session of an inactive user', async () => {
    USERS.inactive = user('inactive', { is_active: false });
    const a = await app({
      sessions: { old: { user: SKIPPER, expires_at: new Date(Date.now() - 1000) }, gone: { user: 'inactive' } },
    });
    expect((await get(a, { cookie: 'session=old' })).statusCode).toBe(401);
    expect((await get(a, { cookie: 'session=gone' })).statusCode).toBe(401);
    expect((await get(a, { cookie: 'session=missing' })).statusCode).toBe(401);
    expect((await get(a)).json().error.code).toBe('UNAUTHORIZED');
  });

  it('honors X-Org-Id for a member org and answers 403 FORBIDDEN for a non-member org', async () => {
    const a = await app({ sessions: { s1: { user: SKIPPER } } });
    expect((await get(a, { cookie: 'session=s1', 'x-org-id': ORG_B })).json()).toMatchObject({ org: ORG_B, role: 'member' });
    const res = await get(a, { cookie: 'session=s1', 'x-org-id': ORG_C });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('ignores sessions.active_org_id unless the service opts in', async () => {
    const f: Fixture = { sessions: { s1: { user: SKIPPER, active_org_id: ORG_B } } };
    expect((await get(await app(f), { cookie: 'session=s1' })).json().org).toBe(ORG_A);
    expect((await get(await app(f, { sessionActiveOrg: true }), { cookie: 'session=s1' })).json().org).toBe(ORG_B);
  });

  // bolt-api used to fold the session org into X-Org-Id, so a session org the user had since
  // left answered 403 on every request. It now falls through to the default, as banter-api did.
  it('falls through a stale session org instead of refusing the request', async () => {
    const a = await app({ sessions: { s1: { user: GINGER, active_org_id: ORG_B } } }, { sessionActiveOrg: true });
    const res = await get(a, { cookie: 'session=s1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().org).toBe(ORG_A);
  });

  it('lets a SuperUser view a non-member live org only when the service opts in', async () => {
    const f: Fixture = { sessions: { s1: { user: SU } } };
    expect((await get(await app(f), { cookie: 'session=s1', 'x-org-id': ORG_C })).statusCode).toBe(403);
    const res = await get(await app(f, { superuserMayViewAnyOrg: true }), { cookie: 'session=s1', 'x-org-id': ORG_C });
    expect(res.json()).toMatchObject({ org: ORG_C, role: 'owner' });
  });
});

describe('createSatelliteAuth: API key', () => {
  it('authenticates a bearer key with its scope and kind, and bumps last_used_at', async () => {
    const a = await app({ key: { owner: SKIPPER, org_id: null, scope: 'read_write' } });
    const res = await get(a, { authorization: `Bearer ${KEY}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: SKIPPER, scope: 'read_write', kind: 'human', sessionId: null });
    expect(a.touch).toHaveBeenCalledWith('key-1');
  });

  it('refuses a wrong secret', async () => {
    const a = await app({ key: { owner: SKIPPER, org_id: null } });
    expect((await get(a, { authorization: 'Bearer bbam_svc_wrongwrongwrong' })).statusCode).toBe(401);
  });

  it('pins a key to its org with the holder role there, dropping X-Org-Id (P2-8)', async () => {
    const a = await app({ key: { owner: SKIPPER, org_id: ORG_B } });
    const res = await get(a, { authorization: `Bearer ${KEY}`, 'x-org-id': ORG_A });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ org: ORG_B, org_id: ORG_B, role: 'member', orgHeader: null });
  });

  it('pins a key whose holder left its org to role viewer, and never probes a header org', async () => {
    const a = await app({ key: { owner: GINGER, org_id: ORG_B } });
    const res = await get(a, { authorization: `Bearer ${KEY}`, 'x-org-id': ORG_C });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ org: ORG_B, role: 'viewer' });
  });

  it('refuses a project-restricted key (#352)', async () => {
    const a = await app({ key: { owner: SKIPPER, org_id: ORG_A, project_ids: [ORG_C] } });
    const res = await get(a, { authorization: `Bearer ${KEY}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_PROJECT_RESTRICTED');
  });

  it('prefers a valid session cookie over a bearer key', async () => {
    const a = await app({ sessions: { s1: { user: GINGER } }, key: { owner: SKIPPER, org_id: null } });
    const res = await get(a, { cookie: 'session=s1', authorization: `Bearer ${KEY}` });
    expect(res.json()).toMatchObject({ id: GINGER, scope: null });
  });
});

describe('createSatelliteAuth: impersonation', () => {
  const f: Fixture = {
    sessions: { su: { user: SU }, sk: { user: SKIPPER } },
    impersonations: [[SU, SKIPPER]],
  };

  it('swaps to the target with an active impersonation session and marks the reply', async () => {
    const res = await get(await app(f), { cookie: 'session=su', 'x-impersonate-user': SKIPPER });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: SKIPPER, impersonator: SU, impersonating: true, role: 'admin' });
    expect(res.headers['x-impersonating']).toBe('true');
    expect(res.headers['x-impersonator']).toBe(SU);
  });

  it('fails closed without an impersonation session, for a non-SuperUser, a SuperUser target or a bad id', async () => {
    const a = await app(f);
    const noSession = await get(a, { cookie: 'session=su', 'x-impersonate-user': GINGER });
    expect(noSession.json()).toMatchObject({ id: SU, impersonating: false });
    expect(noSession.headers['x-impersonating']).toBeUndefined();
    expect((await get(a, { cookie: 'session=sk', 'x-impersonate-user': GINGER })).json().id).toBe(SKIPPER);
    expect((await get(a, { cookie: 'session=su', 'x-impersonate-user': SU })).json().id).toBe(SU);
    expect((await get(a, { cookie: 'session=su', 'x-impersonate-user': 'not-a-uuid' })).json().id).toBe(SU);
  });

  it('refuses an inactive target', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    USERS[id] = user(id, { is_active: false });
    const a = await app({ sessions: { su: { user: SU } }, impersonations: [[SU, id]] });
    expect((await get(a, { cookie: 'session=su', 'x-impersonate-user': id })).json().id).toBe(SU);
  });
});

describe('sqlSatelliteAuthStore', () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values });

  it('maps the session join and reads it through the host executor', async () => {
    const execute = vi.fn(async () => [
      {
        expires_at: '2030-01-01T00:00:00Z',
        active_org_id: ORG_B,
        u_id: SKIPPER,
        u_org_id: ORG_A,
        u_email: 'skipper@example.test',
        u_display_name: 'Skipper',
        u_avatar_url: null,
        u_timezone: 'UTC',
        u_is_active: true,
        u_is_superuser: false,
      },
    ]);
    const s = sqlSatelliteAuthStore({ sql: tag, execute });
    const row = await s.findSession('s1');
    expect(row?.expires_at.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(row).toMatchObject({ active_org_id: ORG_B, user: { id: SKIPPER, org_id: ORG_A, is_active: true } });
    const q = (execute.mock.calls[0] as unknown as [{ text: string; values: unknown[] }])[0];
    expect(q.text).toMatch(/FROM sessions s\s+JOIN users u/);
    expect(q.values).toEqual(['s1']);
  });

  it('requires an un-ended, unexpired impersonation row', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const s = sqlSatelliteAuthStore({ sql: tag, execute });
    expect(await s.hasActiveImpersonation(SU, SKIPPER)).toBe(false);
    const q = (execute.mock.calls[0] as unknown as [{ text: string }])[0];
    expect(q.text).toMatch(/ended_at IS NULL/);
    expect(q.text).toMatch(/expires_at > now\(\)/);
  });
});
