import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  API_KEY_SCOPES,
  ORG_ADMIN_ROLES,
  MAX_VERIFY_CANDIDATES,
  SVC_BUCKET_MAX,
  apiKeyLookup,
  applyKeyOrgPin,
  bearerToken,
  candidateFromRow,
  isApiKeyUsable,
  keyRoleCapApplies,
  requireScope,
  resolveKeyOrgPin,
  scopeAtLeast,
  sqlApiKeyStore,
  verifyApiKeyToken,
  type ApiKeyCandidate,
  type ScopedUser,
} from './index.js';

const hour = 3600_000;
const now = new Date('2026-11-26T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe('isApiKeyUsable', () => {
  it('accepts a key with no expiry that was never rotated', () => {
    expect(isApiKeyUsable({ expires_at: null, rotated_at: null, rotation_grace_expires_at: null }, now)).toBe(true);
  });

  it('honours expires_at on an unrotated key', () => {
    expect(isApiKeyUsable({ expires_at: at(hour), rotated_at: null, rotation_grace_expires_at: null }, now)).toBe(true);
    expect(isApiKeyUsable({ expires_at: at(-hour), rotated_at: null, rotation_grace_expires_at: null }, now)).toBe(false);
  });

  // #343: a rotated predecessor whose expires_at is NULL authenticated forever.
  it('accepts a rotated key with a NULL expires_at inside its grace window', () => {
    expect(
      isApiKeyUsable({ expires_at: null, rotated_at: at(-2 * hour), rotation_grace_expires_at: at(hour) }, now),
    ).toBe(true);
  });

  it('refuses a rotated key with a NULL expires_at after its grace window closed', () => {
    expect(
      isApiKeyUsable({ expires_at: null, rotated_at: at(-8 * 24 * hour), rotation_grace_expires_at: at(-hour) }, now),
    ).toBe(false);
  });

  it('refuses a rotated key with no grace timestamp (fail closed)', () => {
    expect(isApiKeyUsable({ expires_at: null, rotated_at: at(-hour), rotation_grace_expires_at: null }, now)).toBe(false);
  });

  it('keeps an expired rotated key working while its grace window is open', () => {
    expect(
      isApiKeyUsable({ expires_at: at(-hour), rotated_at: at(-2 * hour), rotation_grace_expires_at: at(hour) }, now),
    ).toBe(true);
  });

  it('accepts ISO strings as well as Dates', () => {
    expect(
      isApiKeyUsable(
        { expires_at: null, rotated_at: at(-hour).toISOString(), rotation_grace_expires_at: at(-1).toISOString() },
        now,
      ),
    ).toBe(false);
  });
});

describe('scopes and roles', () => {
  it('orders scopes read < read_write < admin and rejects unknown scopes', () => {
    expect(API_KEY_SCOPES).toEqual(['read', 'read_write', 'admin']);
    expect(scopeAtLeast('admin', 'read_write')).toBe(true);
    expect(scopeAtLeast('read', 'read_write')).toBe(false);
    expect(scopeAtLeast('bogus', 'read')).toBe(false);
    expect(scopeAtLeast(null, 'read')).toBe(false);
  });

  it('treats admin and owner as org-admin roles', () => {
    expect([...ORG_ADMIN_ROLES].sort()).toEqual(['admin', 'owner']);
  });

  it('caps humans and unknown kinds, not service or agent accounts', () => {
    expect(keyRoleCapApplies('human')).toBe(true);
    expect(keyRoleCapApplies(undefined)).toBe(true);
    expect(keyRoleCapApplies('service')).toBe(false);
    expect(keyRoleCapApplies('agent')).toBe(false);
  });
});

describe('resolveKeyOrgPin', () => {
  const memberships = [
    { org_id: 'org-a', role: 'owner' },
    { org_id: 'org-b', role: 'member' },
  ];
  it('pins a non-SuperUser key to its org with the holder role there', () => {
    expect(resolveKeyOrgPin('org-b', false, memberships)).toEqual({ orgId: 'org-b', role: 'member' });
  });
  it('falls back to viewer when the holder left the key org', () => {
    expect(resolveKeyOrgPin('org-c', false, memberships)).toEqual({ orgId: 'org-c', role: 'viewer' });
  });
  it('does not pin SuperUser keys or NULL-org keys', () => {
    expect(resolveKeyOrgPin('org-a', true, memberships)).toBeNull();
    expect(resolveKeyOrgPin(null, false, memberships)).toBeNull();
  });
  it('applyKeyOrgPin rewrites the org and role of a built user', () => {
    const user = { org_id: 'org-a', active_org_id: 'org-a', role: 'owner', is_superuser: false, org_memberships: memberships };
    applyKeyOrgPin(user, 'org-b');
    expect(user).toMatchObject({ org_id: 'org-b', active_org_id: 'org-b', role: 'member' });
    const su = { ...user, org_id: 'org-a', active_org_id: 'org-a', role: 'owner', is_superuser: true };
    applyKeyOrgPin(su, 'org-b');
    expect(su.org_id).toBe('org-a');
  });
});

function candidate(over: Partial<ApiKeyCandidate['apiKey']> = {}, userOver: Partial<ApiKeyCandidate['user']> = {}) {
  return {
    apiKey: {
      id: 'k1',
      user_id: 'u1',
      org_id: 'org-a',
      scope: 'read',
      key_hash: '$argon2id$x',
      project_ids: null,
      expires_at: null,
      rotated_at: null,
      rotation_grace_expires_at: null,
      ...over,
    },
    user: {
      id: 'u1',
      org_id: 'org-a',
      email: 'skipper@gilligantravel.example',
      display_name: 'Skipper',
      avatar_url: null,
      timezone: 'UTC',
      is_active: true,
      is_superuser: false,
      kind: 'human' as const,
      ...userOver,
    },
  };
}

describe('verifyApiKeyToken', () => {
  it('returns the matching candidate for a valid token', async () => {
    const c = candidate();
    const store = { findCandidates: vi.fn(async () => [c]), verifyHash: vi.fn(async () => true) };
    expect(await verifyApiKeyToken('bbam_abcdef123', store)).toBe(c);
    expect(store.findCandidates).toHaveBeenCalledWith('bbam_abc', 10);
  });

  it('refuses a rotated predecessor with a NULL expires_at after grace (#343)', async () => {
    const c = candidate({ rotated_at: at(-8 * 24 * hour), rotation_grace_expires_at: at(-hour) });
    const store = { findCandidates: async () => [c], verifyHash: async () => true };
    expect(await verifyApiKeyToken('bbam_abcdef123', store, undefined, () => now)).toBeNull();
  });

  it('accepts a rotated predecessor inside grace', async () => {
    const c = candidate({ rotated_at: at(-hour), rotation_grace_expires_at: at(hour) });
    const store = { findCandidates: async () => [c], verifyHash: async () => true };
    expect(await verifyApiKeyToken('bbam_abcdef123', store, undefined, () => now)).toBe(c);
  });

  it('refuses an inactive owner and a wrong secret', async () => {
    expect(
      await verifyApiKeyToken('bbam_x1234567', {
        findCandidates: async () => [candidate({}, { is_active: false })],
        verifyHash: async () => true,
      }),
    ).toBeNull();
    expect(
      await verifyApiKeyToken('bbam_x1234567', { findCandidates: async () => [candidate()], verifyHash: async () => false }),
    ).toBeNull();
  });

  it('treats a throwing hash verify as a mismatch', async () => {
    const warn = vi.fn();
    const store = {
      findCandidates: async () => [candidate()],
      verifyHash: async () => {
        throw new Error('bad hash');
      },
    };
    expect(await verifyApiKeyToken('bbam_x1234567', store, { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('collapses more than 3 candidates for a random prefix to the first (P2-11)', async () => {
    const cs = [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' }), candidate({ id: 'd' })];
    const verifyHash = vi.fn(async () => false);
    await verifyApiKeyToken('bbam_x1234567', { findCandidates: async () => cs, verifyHash }, { warn: vi.fn() });
    expect(verifyHash).toHaveBeenCalledTimes(1);
  });

  // #353: the bbam_svc bucket used to verify up to 64 legacy keys per request.
  it('verifies at most 3 legacy bbam_svc keys per request and logs the overflow', async () => {
    const cs = Array.from({ length: 4 }, (_, i) => candidate({ id: `s${i}` }, { kind: 'service' }));
    const verifyHash = vi.fn(async (_h: string, _t: string) => false);
    verifyHash.mockImplementationOnce(async () => false).mockImplementation(async () => true);
    const findCandidates = vi.fn(async () => cs);
    const warn = vi.fn();
    const got = await verifyApiKeyToken('bbam_svc_xyz', { findCandidates, verifyHash }, { warn });
    expect(findCandidates).toHaveBeenCalledWith('bbam_svc', MAX_VERIFY_CANDIDATES + 1);
    expect(got?.apiKey.id).toBe('s1');
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/DEPRECATED/));
  });

  it('caps an unauthenticated bbam_svc probe at 3 Argon2 verifies even with 64 legacy keys', async () => {
    const cs = Array.from({ length: SVC_BUCKET_MAX }, (_, i) => candidate({ id: `s${i}` }, { kind: 'service' }));
    const verifyHash = vi.fn(async () => false);
    const got = await verifyApiKeyToken(
      'bbam_svc_attacker',
      { findCandidates: async () => cs, findByLookup: async () => [], verifyHash },
      { warn: vi.fn() },
    );
    expect(got).toBeNull();
    expect(verifyHash).toHaveBeenCalledTimes(MAX_VERIFY_CANDIDATES);
  });

  it('costs zero Argon2 verifies once no legacy bbam_svc keys remain', async () => {
    const verifyHash = vi.fn(async () => true);
    const got = await verifyApiKeyToken('bbam_svc_attacker', {
      findCandidates: async () => [],
      findByLookup: async () => [],
      verifyHash,
    });
    expect(got).toBeNull();
    expect(verifyHash).not.toHaveBeenCalled();
  });

  it('finds a lookup-id key with one verify and never reads the prefix bucket', async () => {
    const c = candidate({ id: 'new' }, { kind: 'service' });
    const findByLookup = vi.fn(async () => [c]);
    const findCandidates = vi.fn(async () => []);
    const verifyHash = vi.fn(async () => true);
    const token = 'bbam_svc_0123456789abcdef';
    const got = await verifyApiKeyToken(token, { findByLookup, findCandidates, verifyHash });
    expect(got?.apiKey.id).toBe('new');
    expect(findByLookup).toHaveBeenCalledWith(apiKeyLookup(token));
    expect(findCandidates).not.toHaveBeenCalled();
    expect(verifyHash).toHaveBeenCalledTimes(1);
  });

  it('refuses a lookup hit whose Argon2 verify fails, without falling back to the bucket', async () => {
    const findCandidates = vi.fn(async () => [candidate()]);
    const got = await verifyApiKeyToken('bbam_abcdefgh', {
      findByLookup: async () => [candidate()],
      findCandidates,
      verifyHash: async () => false,
    });
    expect(got).toBeNull();
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it('gives a legacy key that authenticates its lookup id', async () => {
    const adoptLookup = vi.fn(async () => {});
    const token = 'bbam_svc_legacy';
    const got = await verifyApiKeyToken(token, {
      findByLookup: async () => [],
      findCandidates: async () => [candidate({ id: 'old' })],
      adoptLookup,
      verifyHash: async () => true,
    });
    expect(got?.apiKey.id).toBe('old');
    expect(adoptLookup).toHaveBeenCalledWith('old', apiKeyLookup(token));
  });

  it('derives the lookup id as hex sha256 of the full token', () => {
    expect(apiKeyLookup('bbam_svc_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKeyLookup('bbam_svc_abc')).not.toBe(apiKeyLookup('bbam_svc_abd'));
  });
});

describe('sqlApiKeyStore', () => {
  it('queries the identity function joined to users and maps the row', async () => {
    const seen: string[] = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(strings.join('?'));
      return { strings, values };
    };
    const execute = vi.fn(async () => [
      {
        id: 'k1',
        user_id: 'u1',
        org_id: 'org-a',
        scope: 'admin',
        key_hash: 'h',
        project_ids: null,
        expires_at: null,
        rotated_at: '2026-11-20T00:00:00Z',
        rotation_grace_expires_at: '2026-11-27T00:00:00Z',
        owner_org_id: 'org-a',
        owner_email: 'professor@gilligantravel.example',
        owner_display_name: 'The Professor',
        owner_avatar_url: null,
        owner_timezone: 'Pacific/Honolulu',
        owner_is_active: true,
        owner_is_superuser: false,
        owner_kind: 'agent',
      },
    ]);
    const store = sqlApiKeyStore({ sql, execute, verifyHash: async () => true });
    const [c] = await store.findCandidates('bbam_abc', 10);
    expect(seen[0]).toContain('auth_api_key_legacy_candidates(');
    expect(seen[0]).toContain('JOIN users u');
    expect(c?.apiKey.rotated_at).toBeInstanceOf(Date);
    expect(c?.user.kind).toBe('agent');
    await store.touch('k1');
    expect(seen[1]).toContain('auth_touch_api_key(');
    await store.findByLookup?.('abc');
    expect(seen[2]).toContain('auth_api_key_by_lookup(');
    await store.adoptLookup?.('k1', 'abc');
    expect(seen[3]).toContain('auth_adopt_api_key_lookup(');
  });

  it('maps an unknown kind to human (role cap applies)', () => {
    expect(candidateFromRow({ owner_kind: 'weird' }).user.kind).toBe('human');
  });
});

describe('bearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(bearerToken('Bearer bbam_abc')).toBe('bbam_abc');
    expect(bearerToken('Basic x')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('requireScope', () => {
  async function call(user: ScopedUser | null, min: 'read' | 'read_write' | 'admin') {
    const app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      (req as unknown as { user: ScopedUser | null }).user = user;
    });
    app.get('/x', { preHandler: [requireScope(min)] }, async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/x' });
    await app.close();
    return res;
  }
  const base = { id: 'u1', is_superuser: false };

  it('401s without a user', async () => {
    expect((await call(null, 'read')).statusCode).toBe(401);
  });

  it('lets an owner session through admin but not a member session', async () => {
    expect((await call({ ...base, role: 'owner', api_key_scope: null }, 'admin')).statusCode).toBe(200);
    const res = await call({ ...base, role: 'member', api_key_scope: null }, 'admin');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Organization admin privileges required');
    expect((await call({ ...base, role: 'member', api_key_scope: null }, 'read_write')).statusCode).toBe(200);
  });

  it('enforces the key scope order', async () => {
    expect((await call({ ...base, role: 'owner', api_key_scope: 'read' }, 'read_write')).statusCode).toBe(403);
    expect((await call({ ...base, role: 'member', api_key_scope: 'read_write' }, 'read_write')).statusCode).toBe(200);
  });

  // #336 / #340: the role cap now holds in every service, not only apps/api.
  it('refuses an admin-scope key whose human holder is no longer an org admin', async () => {
    const res = await call({ ...base, role: 'member', api_key_scope: 'admin', kind: 'human' }, 'admin');
    expect(res.statusCode).toBe(403);
    expect((await call({ ...base, role: 'admin', api_key_scope: 'admin', kind: 'human' }, 'admin')).statusCode).toBe(200);
  });

  it('lets a service account admin key through with role member', async () => {
    expect((await call({ ...base, role: 'member', api_key_scope: 'admin', kind: 'service' }, 'admin')).statusCode).toBe(200);
  });

  it('lets SuperUsers through', async () => {
    expect((await call({ ...base, is_superuser: true, role: 'viewer', api_key_scope: 'read' }, 'admin')).statusCode).toBe(200);
  });
});
