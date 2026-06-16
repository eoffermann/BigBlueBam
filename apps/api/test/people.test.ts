import { describe, it, expect, vi } from 'vitest';

// People Manager v2 (M1) tests. `listScopedPeople` takes an injectable
// data-access surface, so we drive the orchestration (visibility scoping,
// dedup, caps, delete_account eligibility, filters, pagination) with an
// in-memory fake instead of a live DB. This mirrors the suite convention of
// not requiring a running Postgres for unit tests.
//
// org.service.ts (imported transitively for checkRankAbove) pulls in the db
// module at import time, so we stub it the same way the other service tests
// do. `checkRankAbove` itself is pure and does not touch the db.

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

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
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

import {
  listScopedPeople,
  computeOrgCaps,
  type PeopleDataAccess,
  type OrgRosterMember,
} from '../src/services/people.service.js';

// ─── In-memory fixture + fake data-access ───────────────────────────────────

// Two orgs. Caller is admin of A only.
const ORG_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const ORG_C = '33333333-3333-4333-8333-cccccccccccc';

const ORG_NAMES: Record<string, string> = {
  [ORG_A]: 'Alpha Org',
  [ORG_B]: 'Bravo Org',
  [ORG_C]: 'Charlie Org',
};

interface FixturePerson {
  id: string;
  email: string;
  display_name: string;
  is_active?: boolean;
  is_superuser?: boolean;
  /** org_id -> role */
  orgs: Record<string, string>;
}

function buildDataAccess(people: FixturePerson[]): PeopleDataAccess {
  const membersByOrg = new Map<string, OrgRosterMember[]>();
  const allOrgIds = new Set<string>();
  for (const p of people) {
    for (const [orgId, role] of Object.entries(p.orgs)) {
      allOrgIds.add(orgId);
      const arr = membersByOrg.get(orgId) ?? [];
      arr.push({
        id: p.id,
        email: p.email,
        display_name: p.display_name,
        avatar_url: null,
        is_active: p.is_active ?? true,
        last_seen_at: null,
        role,
      });
      membersByOrg.set(orgId, arr);
    }
  }
  return {
    async listAllOrgIds() {
      return Array.from(allOrgIds);
    },
    async getOrgNames(orgIds) {
      const out = new Map<string, string>();
      for (const id of orgIds) out.set(id, ORG_NAMES[id] ?? id);
      return out;
    },
    async listOrgMembers(orgId) {
      return membersByOrg.get(orgId) ?? [];
    },
    async listOrgsUserBelongsTo(userId) {
      const p = people.find((x) => x.id === userId);
      return p ? Object.keys(p.orgs) : [];
    },
    async isSuperuser(userId) {
      return Boolean(people.find((x) => x.id === userId)?.is_superuser);
    },
  };
}

// Stable user ids.
const CALLER = 'caller00-0000-4000-8000-000000000001';
const ALICE = 'alice000-0000-4000-8000-000000000002'; // member of A only
const BOB = 'bob00000-0000-4000-8000-000000000003'; // member of B only
const CAROL = 'carol000-0000-4000-8000-000000000004'; // member of A and B
const DAVE = 'dave0000-0000-4000-8000-000000000005'; // admin of A
const OWNER = 'owner000-0000-4000-8000-000000000006'; // owner of A
const SU = 'super000-0000-4000-8000-000000000007'; // superuser, member of A

// ─── (a) Visibility scoping ──────────────────────────────────────────────────

describe('listScopedPeople — visibility scoping', () => {
  it('a member of org A does NOT see a person who is only in org B', async () => {
    const people: FixturePerson[] = [
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'admin' } },
      { id: ALICE, email: 'alice@x.com', display_name: 'Alice', orgs: { [ORG_A]: 'member' } },
      { id: BOB, email: 'bob@x.com', display_name: 'Bob', orgs: { [ORG_B]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'admin' }] },
      {},
      da,
    );
    const ids = result.data.map((p) => p.user.id);
    expect(ids).toContain(ALICE);
    expect(ids).toContain(CALLER);
    expect(ids).not.toContain(BOB); // shares no org with the caller
  });

  it('a person in a shared org IS visible, with one membership row per shared org', async () => {
    const people: FixturePerson[] = [
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'admin' } },
      { id: CAROL, email: 'carol@x.com', display_name: 'Carol', orgs: { [ORG_A]: 'member', [ORG_B]: 'owner' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'admin' }] },
      {},
      da,
    );
    const carol = result.data.find((p) => p.user.id === CAROL);
    expect(carol).toBeDefined();
    // Caller only sees ORG_A, so Carol's ORG_B membership must NOT leak.
    expect(carol!.memberships.map((m) => m.org_id)).toEqual([ORG_A]);
  });

  it('org_id filter cannot widen scope to an org the caller is not in', async () => {
    const people: FixturePerson[] = [
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'admin' } },
      { id: BOB, email: 'bob@x.com', display_name: 'Bob', orgs: { [ORG_B]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'admin' }] },
      { orgId: ORG_B }, // caller is NOT in B
      da,
    );
    expect(result.data).toEqual([]); // empty, not BOB
  });

  it('SuperUser sees people across all non-deleted orgs', async () => {
    const people: FixturePerson[] = [
      { id: ALICE, email: 'alice@x.com', display_name: 'Alice', orgs: { [ORG_A]: 'member' } },
      { id: BOB, email: 'bob@x.com', display_name: 'Bob', orgs: { [ORG_B]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: SU, isSuperuser: true, orgMemberships: [] },
      {},
      da,
    );
    const ids = result.data.map((p) => p.user.id);
    expect(ids).toContain(ALICE);
    expect(ids).toContain(BOB);
  });
});

// ─── (b) Caps correctness ─────────────────────────────────────────────────────

describe('listScopedPeople — capability flags', () => {
  function callerAdminOfA() {
    return {
      id: CALLER,
      isSuperuser: false,
      orgMemberships: [{ org_id: ORG_A, role: 'admin' }],
    };
  }

  const baseFixture: FixturePerson[] = [
    { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'admin' } },
    { id: ALICE, email: 'alice@x.com', display_name: 'Alice', orgs: { [ORG_A]: 'member' } },
    { id: DAVE, email: 'dave@x.com', display_name: 'Dave', orgs: { [ORG_A]: 'admin' } },
    { id: OWNER, email: 'owner@x.com', display_name: 'Owner', orgs: { [ORG_A]: 'owner' } },
  ];

  it('an org admin can manage_role/disable/remove a lower-ranked member', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(callerAdminOfA(), {}, da);
    const alice = result.data.find((p) => p.user.id === ALICE)!;
    const caps = alice.memberships[0]!.caps;
    expect(caps.manage_role).toBe(true);
    expect(caps.disable).toBe(true);
    expect(caps.remove).toBe(true);
    expect(caps.reset_password).toBe(true);
    expect(caps.manage_projects).toBe(true);
    expect(caps.manage_keys).toBe(true);
    expect(caps.transfer_ownership).toBe(false); // admin, not owner
  });

  it('an org admin CANNOT act on an equal-rank admin or a higher-rank owner', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(callerAdminOfA(), {}, da);

    const dave = result.data.find((p) => p.user.id === DAVE)!;
    expect(dave.memberships[0]!.caps.manage_role).toBe(false); // equal rank
    expect(dave.memberships[0]!.caps.disable).toBe(false);
    expect(dave.memberships[0]!.caps.remove).toBe(false);

    const owner = result.data.find((p) => p.user.id === OWNER)!;
    expect(owner.memberships[0]!.caps.manage_role).toBe(false); // higher rank
    expect(owner.memberships[0]!.caps.transfer_ownership).toBe(false);
  });

  it('caps on self are all-false for the act-on-others verbs', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(callerAdminOfA(), {}, da);
    const self = result.data.find((p) => p.user.id === CALLER)!;
    const caps = self.memberships[0]!.caps;
    expect(caps.disable).toBe(false);
    expect(caps.remove).toBe(false);
    expect(caps.reset_password).toBe(false);
    expect(caps.transfer_ownership).toBe(false);
    expect(caps.delete_account).toBe(false);
    // manage_role is rank-only (no self guard); admin can't outrank self admin.
    expect(caps.manage_role).toBe(false);
  });

  it('a plain member gets all-false caps on everyone', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(
      { id: ALICE, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'member' }] },
      {},
      da,
    );
    for (const person of result.data) {
      for (const m of person.memberships) {
        expect(m.caps.manage_role).toBe(false);
        expect(m.caps.disable).toBe(false);
        expect(m.caps.remove).toBe(false);
        expect(m.caps.manage_projects).toBe(false);
        expect(m.caps.manage_keys).toBe(false);
        expect(m.caps.transfer_ownership).toBe(false);
        expect(m.caps.delete_account).toBe(false);
      }
    }
  });

  it('an org owner can transfer_ownership to a lower-ranked member but not to an owner or self', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(
      { id: OWNER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'owner' }] },
      {},
      da,
    );
    const alice = result.data.find((p) => p.user.id === ALICE)!;
    expect(alice.memberships[0]!.caps.transfer_ownership).toBe(true);

    const owner = result.data.find((p) => p.user.id === OWNER)!;
    expect(owner.memberships[0]!.caps.transfer_ownership).toBe(false); // self
  });

  it('a SuperUser gets broad true caps', async () => {
    const da = buildDataAccess(baseFixture);
    const result = await listScopedPeople(
      { id: SU, isSuperuser: true, orgMemberships: [] },
      {},
      da,
    );
    const owner = result.data.find((p) => p.user.id === OWNER)!;
    const caps = owner.memberships[0]!.caps;
    // SU outranks everyone, including an owner.
    expect(caps.manage_role).toBe(true);
    expect(caps.disable).toBe(true);
    expect(caps.remove).toBe(true);
    expect(caps.manage_projects).toBe(true);
    expect(caps.manage_keys).toBe(true);
    // transfer_ownership still respects "target is not already owner".
    expect(caps.transfer_ownership).toBe(false);
    const alice = result.data.find((p) => p.user.id === ALICE)!;
    expect(alice.memberships[0]!.caps.transfer_ownership).toBe(true);
  });
});

// ─── (c) delete_account ───────────────────────────────────────────────────────

describe('listScopedPeople — delete_account eligibility', () => {
  it('true only when the caller admins EVERY org the target belongs to', async () => {
    const people: FixturePerson[] = [
      // Caller admins A and B.
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'admin', [ORG_B]: 'admin' } },
      // Alice is in A only → caller admins all her orgs → deletable.
      { id: ALICE, email: 'alice@x.com', display_name: 'Alice', orgs: { [ORG_A]: 'member' } },
      // Carol is in A and C; caller does NOT admin C → NOT deletable.
      { id: CAROL, email: 'carol@x.com', display_name: 'Carol', orgs: { [ORG_A]: 'member', [ORG_C]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      {
        id: CALLER,
        isSuperuser: false,
        orgMemberships: [
          { org_id: ORG_A, role: 'admin' },
          { org_id: ORG_B, role: 'admin' },
        ],
      },
      {},
      da,
    );
    const alice = result.data.find((p) => p.user.id === ALICE)!;
    // delete_account is the same on every membership row for a person.
    expect(alice.memberships.every((m) => m.caps.delete_account === true)).toBe(true);

    const carol = result.data.find((p) => p.user.id === CAROL)!;
    expect(carol.memberships.every((m) => m.caps.delete_account === false)).toBe(true);
  });

  it('false for a SuperUser target and for self', async () => {
    const people: FixturePerson[] = [
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'owner' } },
      { id: SU, email: 'su@x.com', display_name: 'Su', is_superuser: true, orgs: { [ORG_A]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'owner' }] },
      {},
      da,
    );
    const su = result.data.find((p) => p.user.id === SU)!;
    expect(su.memberships.every((m) => m.caps.delete_account === false)).toBe(true);
    const self = result.data.find((p) => p.user.id === CALLER)!;
    expect(self.memberships.every((m) => m.caps.delete_account === false)).toBe(true);
  });

  it('a SuperUser caller can delete any non-superuser, non-self target', async () => {
    const people: FixturePerson[] = [
      { id: ALICE, email: 'alice@x.com', display_name: 'Alice', orgs: { [ORG_A]: 'member', [ORG_C]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const result = await listScopedPeople(
      { id: SU, isSuperuser: true, orgMemberships: [] },
      {},
      da,
    );
    const alice = result.data.find((p) => p.user.id === ALICE)!;
    expect(alice.memberships.every((m) => m.caps.delete_account === true)).toBe(true);
  });
});

// ─── (d) Filters ──────────────────────────────────────────────────────────────

describe('listScopedPeople — search / is_active / role filters', () => {
  const fixture: FixturePerson[] = [
    { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'owner' } },
    { id: ALICE, email: 'alice@acme.com', display_name: 'Alice Anders', orgs: { [ORG_A]: 'member' } },
    { id: BOB, email: 'bob@beta.com', display_name: 'Bob Brown', is_active: false, orgs: { [ORG_A]: 'admin' } },
  ];
  const caller = { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'owner' }] };

  it('search matches email and display name case-insensitively', async () => {
    const da = buildDataAccess(fixture);
    const byName = await listScopedPeople(caller, { search: 'anders' }, da);
    expect(byName.data.map((p) => p.user.id)).toEqual([ALICE]);

    const byEmail = await listScopedPeople(caller, { search: 'BETA.com' }, da);
    expect(byEmail.data.map((p) => p.user.id)).toEqual([BOB]);
  });

  it('is_active filters to active or disabled', async () => {
    const da = buildDataAccess(fixture);
    const disabled = await listScopedPeople(caller, { isActive: false }, da);
    expect(disabled.data.map((p) => p.user.id)).toEqual([BOB]);

    const active = await listScopedPeople(caller, { isActive: true }, da);
    expect(active.data.map((p) => p.user.id).sort()).toEqual([ALICE, CALLER].sort());
  });

  it('role keeps only people holding that role in an in-scope org', async () => {
    const da = buildDataAccess(fixture);
    const admins = await listScopedPeople(caller, { role: 'admin' }, da);
    expect(admins.data.map((p) => p.user.id)).toEqual([BOB]);
  });
});

// ─── (e) Pagination ───────────────────────────────────────────────────────────

describe('listScopedPeople — cursor pagination', () => {
  it('pages through the full set without overlap or gaps, sorted by display_name', async () => {
    // 5 people in org A; caller is one of them.
    const people: FixturePerson[] = [
      { id: CALLER, email: 'caller@x.com', display_name: 'Caller', orgs: { [ORG_A]: 'owner' } },
      { id: ALICE, email: 'a@x.com', display_name: 'Aaron', orgs: { [ORG_A]: 'member' } },
      { id: BOB, email: 'b@x.com', display_name: 'Bianca', orgs: { [ORG_A]: 'member' } },
      { id: CAROL, email: 'c@x.com', display_name: 'Cyril', orgs: { [ORG_A]: 'member' } },
      { id: DAVE, email: 'd@x.com', display_name: 'Dahlia', orgs: { [ORG_A]: 'member' } },
    ];
    const da = buildDataAccess(people);
    const caller = { id: CALLER, isSuperuser: false, orgMemberships: [{ org_id: ORG_A, role: 'owner' }] };

    const page1 = await listScopedPeople(caller, { limit: 2 }, da);
    expect(page1.data.map((p) => p.user.display_name)).toEqual(['Aaron', 'Bianca']);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await listScopedPeople(caller, { limit: 2, cursor: page1.next_cursor! }, da);
    expect(page2.data.map((p) => p.user.display_name)).toEqual(['Caller', 'Cyril']);
    expect(page2.next_cursor).not.toBeNull();

    const page3 = await listScopedPeople(caller, { limit: 2, cursor: page2.next_cursor! }, da);
    expect(page3.data.map((p) => p.user.display_name)).toEqual(['Dahlia']);
    expect(page3.next_cursor).toBeNull();

    // No duplicates across pages.
    const allIds = [...page1.data, ...page2.data, ...page3.data].map((p) => p.user.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.length).toBe(5);
  });
});

// ─── computeOrgCaps — direct unit coverage of the pure rule ───────────────────

describe('computeOrgCaps (pure)', () => {
  it('admin over a member: outranks, manages projects/keys, not owner', () => {
    const caps = computeOrgCaps({
      callerRoleInOrg: 'admin',
      targetRoleInOrg: 'member',
      callerIsSuperuser: false,
      isSelf: false,
      callerIsOwnerOfOrg: false,
    });
    expect(caps).toEqual({
      manage_role: true,
      disable: true,
      remove: true,
      reset_password: true,
      manage_projects: true,
      manage_keys: true,
      transfer_ownership: false,
    });
  });

  it('member over a member: all false', () => {
    const caps = computeOrgCaps({
      callerRoleInOrg: 'member',
      targetRoleInOrg: 'member',
      callerIsSuperuser: false,
      isSelf: false,
      callerIsOwnerOfOrg: false,
    });
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });

  it('superuser with no membership row still outranks and can manage', () => {
    const caps = computeOrgCaps({
      callerRoleInOrg: undefined,
      targetRoleInOrg: 'owner',
      callerIsSuperuser: true,
      isSelf: false,
      callerIsOwnerOfOrg: false,
    });
    expect(caps.manage_role).toBe(true);
    expect(caps.disable).toBe(true);
    expect(caps.manage_projects).toBe(true);
    expect(caps.manage_keys).toBe(true);
    // target is owner → no transfer.
    expect(caps.transfer_ownership).toBe(false);
  });
});
