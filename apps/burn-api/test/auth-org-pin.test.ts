import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * P2-8 regression suite: an API key minted in org A must stay confined to org A.
 *
 * The failure this pins (issue #91): burn-api's auth plugin was a trimmed copy of
 * apps/api's and the trim dropped the key-org argument to `buildAuthUser`, so a user
 * belonging to orgs A and B could mint a key in org A, hand it to an integration, and
 * anyone holding that token could add `X-Org-Id: <org B>` and read org B's
 * `burn_cost_rates` (per-person compensation) with it.
 *
 * These tests drive the REAL `buildAuthUser` with a stubbed membership query rather than
 * asserting on a pure helper, so a future refactor that keeps `isApiKeyOrgPinned` intact
 * but stops calling it still fails here.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  membershipRows: [] as Array<{
    org_id: string;
    role: string | null;
    is_default: boolean;
    joined_at: string;
  }>,
}));

vi.mock('../src/db/index.js', () => {
  // The membership lookup is `db.select({...}).from().leftJoin().leftJoin().where()`,
  // awaited as a thenable. A proxy that returns itself for every method and resolves to
  // the current fixture rows covers the whole chain without pinning its exact shape.
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve(state.membershipRows).then(resolve);
        }
        return () => chain;
      },
    },
  );
  return {
    db: {
      select: () => chain,
      update: () => chain,
    },
  };
});

const { buildAuthUser, isApiKeyOrgPinned } = await import('../src/plugins/auth.js');

function userRow(overrides: Partial<{ is_superuser: boolean; org_id: string }> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    org_id: ORG_A,
    email: 'castaway@gilligantravel.example',
    display_name: 'Castaway',
    avatar_url: null,
    timezone: 'UTC',
    is_active: true,
    is_superuser: false,
    ...overrides,
  };
}

function requestWithOrgHeader(orgId?: string) {
  return {
    headers: orgId ? { 'x-org-id': orgId } : {},
    log: { warn: () => {} },
  } as unknown as Parameters<typeof buildAuthUser>[2];
}

describe('API key org pinning (P2-8, issue #91)', () => {
  beforeEach(() => {
    // The user is a member of BOTH orgs. That is the whole point: without the pin,
    // resolveOrgContext happily honors an X-Org-Id naming any org the user belongs to.
    state.membershipRows = [
      { org_id: ORG_A, role: 'member', is_default: true, joined_at: '2026-01-01T00:00:00Z' },
      { org_id: ORG_B, role: 'admin', is_default: false, joined_at: '2026-02-01T00:00:00Z' },
    ];
  });

  it('pins a non-SuperUser key to the key org, ignoring an X-Org-Id for a different org', async () => {
    const user = await buildAuthUser(userRow(), 'read', requestWithOrgHeader(ORG_B), ORG_A);

    expect(user.active_org_id).toBe(ORG_A);
    expect(user.org_id).toBe(ORG_A);
    // The role must come from the KEY's org, not from the org the header selected.
    expect(user.role).toBe('member');
    // The full membership list is still exposed for downstream code.
    expect(user.org_memberships.map((m) => m.org_id).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('does not 403 on an X-Org-Id naming an org the user is not in when pinned', async () => {
    // A pinned key must DISCARD the header rather than validate it: validating turns the
    // header into a membership probe (403 for a non-member org, 200 otherwise).
    const stranger = '99999999-9999-4999-8999-999999999999';
    const user = await buildAuthUser(userRow(), 'read', requestWithOrgHeader(stranger), ORG_A);
    expect(user.active_org_id).toBe(ORG_A);
  });

  it('falls back to viewer when the user has lost membership in the key org', async () => {
    state.membershipRows = [
      { org_id: ORG_B, role: 'admin', is_default: true, joined_at: '2026-02-01T00:00:00Z' },
    ];
    const user = await buildAuthUser(userRow(), 'admin', requestWithOrgHeader(ORG_B), ORG_A);
    expect(user.active_org_id).toBe(ORG_A);
    expect(user.role).toBe('viewer');
  });

  it('still honors X-Org-Id for a SuperUser key, which legitimately crosses orgs', async () => {
    const user = await buildAuthUser(
      userRow({ is_superuser: true }),
      'admin',
      requestWithOrgHeader(ORG_B),
      ORG_A,
    );
    expect(user.active_org_id).toBe(ORG_B);
    expect(user.role).toBe('admin');
  });

  it('still honors X-Org-Id for session auth, which carries no key org', async () => {
    const user = await buildAuthUser(userRow(), null, requestWithOrgHeader(ORG_B), null);
    expect(user.active_org_id).toBe(ORG_B);
  });

  it('never pins to an undefined org: a null key org falls through to the header path', () => {
    expect(isApiKeyOrgPinned(null, false)).toBe(false);
    expect(isApiKeyOrgPinned(null, true)).toBe(false);
    expect(isApiKeyOrgPinned(ORG_A, true)).toBe(false);
    expect(isApiKeyOrgPinned(ORG_A, false)).toBe(true);
  });
});
