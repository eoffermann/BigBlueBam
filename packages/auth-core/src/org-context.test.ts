import { describe, it, expect, vi } from 'vitest';
import {
  OrgMembershipError,
  requestedOrgIdFromHeader,
  resolveOrgContext,
  sqlOrgContextStore,
  type LiveMembershipRow,
  type OrgContextStore,
} from './index.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_DEAD = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

function store(opts: {
  rows?: LiveMembershipRow[];
  roles?: Record<string, string>;
  live?: string[];
}): OrgContextStore {
  return {
    loadLiveMemberships: vi.fn(async () => opts.rows ?? []),
    loadOrgRoles: vi.fn(async () => new Map(Object.entries(opts.roles ?? {}))),
    isLiveOrg: vi.fn(async (id: string) => (opts.live ?? []).includes(id)),
  };
}

const row = (org_id: string, is_default: boolean, joined: string): LiveMembershipRow => ({
  org_id,
  is_default,
  joined_at: new Date(joined),
});

describe('resolveOrgContext', () => {
  it('picks the default membership and its grouped role', async () => {
    const s = store({
      rows: [row(ORG_A, false, '2026-01-01'), row(ORG_B, true, '2026-02-01')],
      roles: { [ORG_A]: 'viewer', [ORG_B]: 'admin' },
    });
    const ctx = await resolveOrgContext(s, USER, ORG_A, undefined);
    expect(ctx.activeOrgId).toBe(ORG_B);
    expect(ctx.activeRole).toBe('admin');
    expect(ctx.memberships.map((m) => m.org_id)).toEqual([ORG_A, ORG_B]);
  });

  it('honours X-Org-Id for a member org and refuses a non-member org', async () => {
    const s = store({ rows: [row(ORG_A, true, '2026-01-01'), row(ORG_B, false, '2026-02-01')] });
    expect((await resolveOrgContext(s, USER, ORG_A, ORG_B)).activeOrgId).toBe(ORG_B);
    await expect(resolveOrgContext(s, USER, ORG_A, ORG_DEAD)).rejects.toBeInstanceOf(OrgMembershipError);
  });

  it('defaults a membership with no group row to member', async () => {
    const s = store({ rows: [row(ORG_A, true, '2026-01-01')] });
    expect((await resolveOrgContext(s, USER, ORG_A, undefined)).activeRole).toBe('member');
  });

  // #350: the store only returns live-org memberships, so a user whose only org was
  // soft-deleted reaches the users.org_id fallback, which must be liveness-checked.
  it('refuses the users.org_id fallback when that org is soft-deleted', async () => {
    const s = store({ rows: [], live: [] });
    await expect(resolveOrgContext(s, USER, ORG_DEAD, undefined)).rejects.toThrow(/no active organization/);
    expect(s.isLiveOrg).toHaveBeenCalledWith(ORG_DEAD);
  });

  it('uses a live users.org_id fallback with the grouped role there', async () => {
    const s = store({ rows: [], live: [ORG_A], roles: { [ORG_A]: 'owner' } });
    const ctx = await resolveOrgContext(s, USER, ORG_A, undefined);
    expect(ctx).toEqual({
      memberships: [{ org_id: ORG_A, role: 'owner', is_default: true }],
      activeOrgId: ORG_A,
      activeRole: 'owner',
    });
  });

  it('refuses a user with no memberships and no fallback org', async () => {
    await expect(resolveOrgContext(store({}), USER, '', undefined)).rejects.toBeInstanceOf(OrgMembershipError);
  });

  it('prefers a live session org, and falls through a stale one', async () => {
    const s = store({ rows: [row(ORG_A, true, '2026-01-01'), row(ORG_B, false, '2026-02-01')] });
    expect((await resolveOrgContext(s, USER, ORG_A, undefined, { sessionActiveOrgId: ORG_B })).activeOrgId).toBe(ORG_B);
    expect((await resolveOrgContext(s, USER, ORG_A, undefined, { sessionActiveOrgId: ORG_DEAD })).activeOrgId).toBe(ORG_A);
  });

  it('lets an opted-in SuperUser view a live non-member org, never a deleted one', async () => {
    const s = store({ rows: [row(ORG_A, true, '2026-01-01')], live: [ORG_A, ORG_B] });
    const su = { superuserMayViewAnyOrg: true, isSuperuser: true };
    expect(await resolveOrgContext(s, USER, ORG_A, ORG_B, su)).toMatchObject({ activeOrgId: ORG_B, activeRole: 'owner' });
    await expect(resolveOrgContext(s, USER, ORG_A, ORG_DEAD, su)).rejects.toBeInstanceOf(OrgMembershipError);
    expect((await resolveOrgContext(s, USER, ORG_A, undefined, { ...su, sessionActiveOrgId: ORG_DEAD })).activeOrgId).toBe(ORG_A);
    // Without the opt-in a SuperUser is held to membership like anyone else.
    await expect(resolveOrgContext(s, USER, ORG_A, ORG_B, { isSuperuser: true })).rejects.toBeInstanceOf(OrgMembershipError);
  });
});

describe('requestedOrgIdFromHeader', () => {
  it('accepts a UUID and ignores anything else', () => {
    expect(requestedOrgIdFromHeader(ORG_A)).toBe(ORG_A);
    expect(requestedOrgIdFromHeader([ORG_B, ORG_A])).toBe(ORG_B);
    expect(requestedOrgIdFromHeader('not-a-uuid')).toBeUndefined();
    expect(requestedOrgIdFromHeader(undefined)).toBeUndefined();
    expect(requestedOrgIdFromHeader('')).toBeUndefined();
  });
});

describe('sqlOrgContextStore', () => {
  it('reads through the 0311 identity functions', async () => {
    const seen: string[] = [];
    const sql = (strings: TemplateStringsArray) => strings.join('?');
    const execute = vi.fn(async (q: string) => {
      seen.push(q);
      if (q.includes('auth_user_live_memberships')) {
        return [{ org_id: ORG_A, is_default: true, joined_at: '2026-01-01T00:00:00Z' }];
      }
      if (q.includes('auth_user_org_roles')) return { rows: [{ org_id: ORG_A, legacy_role: 'admin' }] };
      return [{ live: true }];
    });
    const s = sqlOrgContextStore({ sql, execute: execute as never });
    expect(await s.loadLiveMemberships(USER)).toEqual([
      { org_id: ORG_A, is_default: true, joined_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    expect((await s.loadOrgRoles(USER)).get(ORG_A)).toBe('admin');
    expect(await s.isLiveOrg(ORG_A)).toBe(true);
    expect(seen.join('\n')).toMatch(/auth_user_live_memberships[\s\S]*auth_user_org_roles[\s\S]*auth_org_is_live/);
    expect(seen.join('\n')).not.toMatch(/organization_memberships/);
  });
});
