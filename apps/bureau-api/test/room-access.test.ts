// Workstream 15 — unit tests for the room-access middleware.
//
// We test evaluateRoomAccess(room, user) for the four cases the design
// document calls out:
//   - org admin/owner: always allowed
//   - room owner: always allowed
//   - 'open' / 'knock' room: any org member admitted (knock UX happens elsewhere)
//   - 'private' room: gated on a bureau_room_acl row
//
// hasRoomAclEntry is exercised indirectly via the private-room path.
// We mock the drizzle db query chain (select().from().where().limit()).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// env.ts validates required env vars at module load time. We need it stubbed
// before any service code imports it; tests for room-access don't actually
// touch env beyond the db init path.
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    LIVEKIT_URL: 'ws://localhost:7880',
    BBB_PERMISSIONS_ENFORCE: 'off',
  },
}));

// Mock the db. The middleware only ever calls db.select(...) chains, so we
// hand back a chainable object whose .limit() resolves to whatever the test
// currently expects. vi.hoisted lets us share the spy with vi.mock's factory
// without tripping the "top-level variables in factory" error.
const { limitMock } = vi.hoisted(() => ({ limitMock: vi.fn() }));
vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: limitMock,
        }),
      }),
    }),
  },
  connection: { end: vi.fn() },
}));

import {
  evaluateRoomAccess,
  isOrgAdminOrOwner,
  roleLevel,
  hasRoomAclEntry,
  loadRoom,
  canSetDoorDecision,
  canLockRoomDecision,
  type RoomAccessRecord,
} from '../src/middleware/room-access.js';

function room(overrides: Partial<RoomAccessRecord> = {}): RoomAccessRecord {
  return {
    id: 'room-1',
    org_id: 'org-1',
    floor_id: 'floor-1',
    type: 'office',
    privacy_default: 'private',
    capacity: 4,
    owner_id: 'user-owner',
    archived_at: null,
    ...overrides,
  };
}

function user(role: string, opts: Partial<{ id: string; is_superuser: boolean }> = {}) {
  return {
    id: opts.id ?? 'user-x',
    role,
    is_superuser: opts.is_superuser ?? false,
  };
}

beforeEach(() => {
  limitMock.mockReset();
});

describe('roleLevel / isOrgAdminOrOwner', () => {
  it('orders viewer < member < admin < owner', () => {
    expect(roleLevel('viewer')).toBe(0);
    expect(roleLevel('member')).toBe(1);
    expect(roleLevel('admin')).toBe(2);
    expect(roleLevel('owner')).toBe(3);
    expect(roleLevel('nonsense')).toBe(-1);
  });

  it('admin and owner clear the bar; member/viewer do not', () => {
    expect(isOrgAdminOrOwner('admin')).toBe(true);
    expect(isOrgAdminOrOwner('owner')).toBe(true);
    expect(isOrgAdminOrOwner('member')).toBe(false);
    expect(isOrgAdminOrOwner('viewer')).toBe(false);
  });
});

describe('evaluateRoomAccess — admin/owner short-circuit', () => {
  it('superusers are always admitted, even into archived-style edge cases', async () => {
    limitMock.mockResolvedValue([]); // no ACL row
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private' }),
      user('viewer', { is_superuser: true }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('org admins are always admitted', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private' }),
      user('admin'),
    );
    expect(decision.allowed).toBe(true);
  });

  it('org owners are always admitted', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private' }),
      user('owner'),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluateRoomAccess — room owner', () => {
  it('admits the room owner regardless of privacy', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private', owner_id: 'user-owner' }),
      user('member', { id: 'user-owner' }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluateRoomAccess — open / knock', () => {
  it("admits any org member into an 'open' room", async () => {
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'someone-else' }),
      user('member'),
    );
    expect(decision.allowed).toBe(true);
  });

  it("admits any org member into a 'knock' room (the knock UX is gated elsewhere)", async () => {
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'knock', owner_id: 'someone-else' }),
      user('member'),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluateRoomAccess — private', () => {
  it('rejects strangers from private rooms', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private', owner_id: 'someone-else' }),
      user('member', { id: 'stranger' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/private/i);
  });

  it('admits a member with an ACL row', async () => {
    limitMock.mockResolvedValue([{ id: 'acl-row' }]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private', owner_id: 'someone-else' }),
      user('member', { id: 'managed-user' }),
    );
    expect(decision.allowed).toBe(true);
  });

  it("falls closed on an unknown privacy bucket", async () => {
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'sekrit-handshake' as unknown as string, owner_id: 'x' }),
      user('member'),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('evaluateRoomAccess — live door-state override (lock_room / set_door)', () => {
  it("a locked 'open' room (live privacy 'private') rejects non-ACL members", async () => {
    limitMock.mockResolvedValue([]); // no ACL row
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'someone-else' }),
      user('member', { id: 'stranger' }),
      'private',
    );
    expect(decision.allowed).toBe(false);
  });

  it("a locked room still admits ACL holders", async () => {
    limitMock.mockResolvedValue([{ id: 'acl-row' }]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'someone-else' }),
      user('member', { id: 'acl-user' }),
      'private',
    );
    expect(decision.allowed).toBe(true);
  });

  it('a locked room still admits the room owner (emergency entry)', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'user-owner' }),
      user('member', { id: 'user-owner' }),
      'private',
    );
    expect(decision.allowed).toBe(true);
  });

  it('a locked room still admits org admins (emergency entry)', async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'someone-else' }),
      user('admin'),
      'private',
    );
    expect(decision.allowed).toBe(true);
  });

  it("an unlocked door override back to 'open' admits members of a private-default room", async () => {
    limitMock.mockResolvedValue([]);
    const decision = await evaluateRoomAccess(
      room({ privacy_default: 'private', owner_id: 'someone-else' }),
      user('member'),
      'open',
    );
    expect(decision.allowed).toBe(true);
  });

  it('null / undefined override falls back to privacy_default', async () => {
    const open = await evaluateRoomAccess(
      room({ privacy_default: 'open', owner_id: 'someone-else' }),
      user('member'),
      null,
    );
    expect(open.allowed).toBe(true);
  });
});

describe('hasRoomAclEntry', () => {
  it('returns true when a row is present', async () => {
    limitMock.mockResolvedValue([{ id: 'acl-1' }]);
    expect(await hasRoomAclEntry('room-1', 'user-1')).toBe(true);
  });
  it('returns false when no row is present', async () => {
    limitMock.mockResolvedValue([]);
    expect(await hasRoomAclEntry('room-1', 'user-1')).toBe(false);
  });
});

describe('loadRoom', () => {
  it('returns null when no row matches', async () => {
    limitMock.mockResolvedValue([]);
    expect(await loadRoom('room-x', 'org-x')).toBeNull();
  });

  it('returns null when the room is archived', async () => {
    limitMock.mockResolvedValue([
      { ...room(), archived_at: new Date() } as RoomAccessRecord,
    ]);
    expect(await loadRoom('room-x', 'org-x')).toBeNull();
  });

  it('returns the row when the room exists and is not archived', async () => {
    const row = room();
    limitMock.mockResolvedValue([row]);
    const got = await loadRoom('room-1', 'org-1');
    expect(got).toEqual(row);
  });
});

describe('canSetDoorDecision', () => {
  const office = { type: 'office', owner_id: 'user-owner' };
  const shared = { type: 'huddle', owner_id: null };

  it('superuser may set any door', () => {
    expect(
      canSetDoorDecision({ isSuperuser: true, role: 'viewer', room: shared, userId: 'u', hasAclManagerRole: false }),
    ).toBe(true);
  });

  it('org admin/owner may set any door', () => {
    expect(canSetDoorDecision({ isSuperuser: false, role: 'admin', room: shared, userId: 'u', hasAclManagerRole: false })).toBe(true);
    expect(canSetDoorDecision({ isSuperuser: false, role: 'owner', room: office, userId: 'u', hasAclManagerRole: false })).toBe(true);
  });

  it('office door: only the owner', () => {
    expect(canSetDoorDecision({ isSuperuser: false, role: 'member', room: office, userId: 'user-owner', hasAclManagerRole: false })).toBe(true);
    expect(canSetDoorDecision({ isSuperuser: false, role: 'member', room: office, userId: 'someone-else', hasAclManagerRole: true })).toBe(false);
  });

  it('shared room: only an ACL manager', () => {
    expect(canSetDoorDecision({ isSuperuser: false, role: 'member', room: shared, userId: 'u', hasAclManagerRole: true })).toBe(true);
    expect(canSetDoorDecision({ isSuperuser: false, role: 'member', room: shared, userId: 'u', hasAclManagerRole: false })).toBe(false);
  });

  it('office with no owner_id rejects everyone non-privileged', () => {
    expect(canSetDoorDecision({ isSuperuser: false, role: 'member', room: { type: 'office', owner_id: null }, userId: 'u', hasAclManagerRole: false })).toBe(false);
  });
});

describe('canLockRoomDecision', () => {
  const office = { type: 'office', owner_id: 'user-owner' };
  const shared = { type: 'huddle', owner_id: null };

  it('superuser and admin/owner may lock any room', () => {
    expect(canLockRoomDecision({ isSuperuser: true, role: 'viewer', room: shared, userId: 'u', isInRoom: false, hasAclEntry: false })).toBe(true);
    expect(canLockRoomDecision({ isSuperuser: false, role: 'admin', room: shared, userId: 'u', isInRoom: false, hasAclEntry: false })).toBe(true);
  });

  it('office: only the owner', () => {
    expect(canLockRoomDecision({ isSuperuser: false, role: 'member', room: office, userId: 'user-owner', isInRoom: false, hasAclEntry: false })).toBe(true);
    expect(canLockRoomDecision({ isSuperuser: false, role: 'member', room: office, userId: 'else', isInRoom: true, hasAclEntry: true })).toBe(false);
  });

  it('shared room: anyone currently inside may lock', () => {
    expect(canLockRoomDecision({ isSuperuser: false, role: 'member', room: shared, userId: 'u', isInRoom: true, hasAclEntry: false })).toBe(true);
  });

  it('shared room: an ACL holder may lock even when not currently inside', () => {
    expect(canLockRoomDecision({ isSuperuser: false, role: 'member', room: shared, userId: 'u', isInRoom: false, hasAclEntry: true })).toBe(true);
  });

  it('shared room: a member neither inside nor ACL-listed is rejected', () => {
    expect(canLockRoomDecision({ isSuperuser: false, role: 'member', room: shared, userId: 'u', isInRoom: false, hasAclEntry: false })).toBe(false);
  });
});
