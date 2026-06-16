import { describe, it, expect } from 'vitest';
import { resolveEffectiveOrg } from '../src/plugins/org-context.js';

/**
 * Regression for commit e6c9b731: an explicit `X-Org-Id` header must take
 * precedence over the session's sticky `active_org_id`. The People Manager
 * issues per-org requests via `X-Org-Id`; the bug let the sticky session org
 * (set by /auth/switch-org) silently clobber the header, so every per-org
 * request resolved back to the session's active org (e.g. the invite project
 * picker always showed the active org's projects).
 *
 * `resolveEffectiveOrg` is the pure precedence core lifted out of
 * `buildAuthUser`. When an `X-Org-Id` header is present, `resolveOrgContext`
 * has already validated membership and set `activeOrgId === requestedOrgId`,
 * so these inputs mirror that contract.
 */

const ORG_A = '0fea63fe-0f9c-402d-a3ae-601c337135a4';
const ORG_B = '57158e52-227d-4903-b0d8-d9f3c4910f61';
const m = (org_id: string, role: string) => ({ org_id, role });

describe('resolveEffectiveOrg — X-Org-Id vs sticky session org', () => {
  it('explicit X-Org-Id header WINS over a different sticky session org (the bug)', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_B, // resolveOrgContext already applied the header → B
      activeRole: 'member',
      requestedOrgId: ORG_B, // header present
      sessionActiveOrgId: ORG_A, // sticky session is a DIFFERENT org
      memberships: [m(ORG_A, 'owner'), m(ORG_B, 'member')],
      isSuperuser: false,
    });
    expect(r.orgId).toBe(ORG_B); // pre-fix this returned ORG_A
    expect(r.role).toBe('member');
    expect(r.isSuperuserViewing).toBe(false);
  });

  it('explicit X-Org-Id header WINS for a SuperUser too', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_B,
      activeRole: 'admin',
      requestedOrgId: ORG_B,
      sessionActiveOrgId: ORG_A,
      memberships: [m(ORG_A, 'owner'), m(ORG_B, 'admin')],
      isSuperuser: true,
    });
    expect(r.orgId).toBe(ORG_B);
    expect(r.isSuperuserViewing).toBe(false);
  });

  it('WITHOUT a header, the sticky session org is honored (member still)', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_A, // membership default
      activeRole: 'owner',
      requestedOrgId: undefined, // no header
      sessionActiveOrgId: ORG_B, // switched to B
      memberships: [m(ORG_A, 'owner'), m(ORG_B, 'member')],
      isSuperuser: false,
    });
    expect(r.orgId).toBe(ORG_B);
    expect(r.role).toBe('member');
  });

  it('WITHOUT a header, a non-member sticky org is ignored for a regular user', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_A,
      activeRole: 'owner',
      requestedOrgId: undefined,
      sessionActiveOrgId: ORG_B, // not a member of B
      memberships: [m(ORG_A, 'owner')],
      isSuperuser: false,
    });
    expect(r.orgId).toBe(ORG_A); // falls back to the default
  });

  it('WITHOUT a header, a SuperUser views a non-member sticky org with the banner', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_A,
      activeRole: 'owner',
      requestedOrgId: undefined,
      sessionActiveOrgId: ORG_B, // SU switched into B (not a member)
      memberships: [m(ORG_A, 'owner')],
      isSuperuser: true,
    });
    expect(r.orgId).toBe(ORG_B);
    expect(r.role).toBe('owner');
    expect(r.isSuperuserViewing).toBe(true);
  });

  it('a non-SuperUser API-key org pin wins (session is null for key auth)', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: ORG_A,
      keyScopedRole: 'member',
      activeOrgId: ORG_A,
      activeRole: 'member',
      requestedOrgId: undefined,
      sessionActiveOrgId: null,
      memberships: [m(ORG_A, 'member')],
      isSuperuser: false,
    });
    expect(r.orgId).toBe(ORG_A);
    expect(r.role).toBe('member');
    expect(r.isSuperuserViewing).toBe(false);
  });

  it('no header and no sticky session → membership-resolved default', () => {
    const r = resolveEffectiveOrg({
      keyScopedOrgId: null,
      keyScopedRole: null,
      activeOrgId: ORG_A,
      activeRole: 'owner',
      requestedOrgId: undefined,
      sessionActiveOrgId: null,
      memberships: [m(ORG_A, 'owner')],
      isSuperuser: false,
    });
    expect(r.orgId).toBe(ORG_A);
    expect(r.role).toBe('owner');
  });
});
