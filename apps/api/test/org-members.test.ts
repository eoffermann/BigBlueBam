import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1-25: optimistic-concurrency tests for updateMemberRole. We mock the
// db.transaction to hand the callback a scripted `tx` object whose
// select/update return values can be tuned per-test — this lets us
// exercise (1) happy path, (2) version mismatch, (3) backward compat
// without spinning up a real database.

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
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

/**
 * Build a minimal tx object whose chain methods return pre-scripted rows.
 * Wave E.F: updateMemberRole now issues three SELECTs (membership version,
 * resolveUserOrgRole join, users row), one UPDATE (bump version), and one
 * INSERT-onConflictDoUpdate (setUserOrgRole into account_group_memberships).
 *
 * - `existing`: the row returned by `tx.select({ version })` on
 *               the membership lookup.
 * - `updatedMembership`: the row returned by the `update(...).returning`
 *               on the membership UPDATE (null to simulate 0 rows affected).
 * - `user`: the row returned by the `select().from(users)` lookup.
 */
function makeTx(opts: {
  existing: { role: string; version: number } | null;
  updatedMembership: { version: number } | null;
  user: { id: string; org_id: string; role: string } | null;
}) {
  // Wave E.F: the call order is:
  //   1. SELECT version FROM organization_memberships ...
  //   2. SELECT legacy_role FROM account_group_memberships INNER JOIN ... (resolveUserOrgRole)
  //   3. UPDATE organization_memberships ... RETURNING version
  //   4. INSERT INTO account_group_memberships ... ON CONFLICT DO UPDATE (setUserOrgRole)
  //   5. SELECT * FROM users WHERE id = ...
  let selectCall = 0;

  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => {
      const thisSelect = selectCall++;
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => {
          if (thisSelect === 0) {
            // SELECT version FROM organization_memberships
            return Promise.resolve(
              opts.existing ? [{ version: opts.existing.version }] : [],
            );
          }
          if (thisSelect === 1) {
            // resolveUserOrgRole join
            return Promise.resolve(
              opts.existing ? [{ legacy_role: opts.existing.role }] : [],
            );
          }
          // users row
          return Promise.resolve(opts.user ? [opts.user] : []);
        }),
      };
      return chain;
    }),
    update: vi.fn(() => {
      const chain = {
        set: vi.fn(() => chain),
        where: vi.fn(() => chain),
        returning: vi.fn(() =>
          Promise.resolve(opts.updatedMembership ? [opts.updatedMembership] : []),
        ),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    }),
    insert: vi.fn(() => {
      const chain: any = {
        values: vi.fn(() => chain),
        onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
        onConflictDoNothing: vi.fn(() => Promise.resolve(undefined)),
        returning: vi.fn(() => Promise.resolve([])),
      };
      return chain;
    }),
  };
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateMemberRole — optimistic concurrency (P1-25)', () => {
  it('succeeds and returns new version when expected_version matches', async () => {
    const tx = makeTx({
      existing: { role: 'member', version: 4 },
      updatedMembership: { version: 5 },
      user: { id: 'u1', org_id: 'org1', role: 'member' },
    });
    mockDb.transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    const svc = await import('../src/services/org.service.js');
    const result = await svc.updateMemberRole('org1', 'u1', 'admin', {
      callerRole: 'owner',
      callerIsSuperuser: false,
      expectedVersion: 4,
    });

    expect(result).not.toBeNull();
    expect(result?.membership_version).toBe(5);
  });

  it('throws VersionConflictError when expected_version does not match', async () => {
    const tx = makeTx({
      existing: { role: 'member', version: 7 },
      updatedMembership: { version: 8 },
      user: { id: 'u1', org_id: 'org1', role: 'member' },
    });
    mockDb.transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    const svc = await import('../src/services/org.service.js');

    await expect(
      svc.updateMemberRole('org1', 'u1', 'admin', {
        callerRole: 'owner',
        callerIsSuperuser: false,
        expectedVersion: 4, // stale — server is at 7
      }),
    ).rejects.toMatchObject({
      name: 'VersionConflictError',
      code: 'VERSION_CONFLICT',
      currentVersion: 7,
    });
  });

  it('still succeeds (and still bumps version) when expected_version is omitted', async () => {
    const tx = makeTx({
      existing: { role: 'member', version: 3 },
      updatedMembership: { version: 4 },
      user: { id: 'u1', org_id: 'org1', role: 'member' },
    });
    mockDb.transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    const svc = await import('../src/services/org.service.js');
    const result = await svc.updateMemberRole('org1', 'u1', 'admin', {
      callerRole: 'owner',
      callerIsSuperuser: false,
      // no expectedVersion
    });

    expect(result).not.toBeNull();
    expect(result?.membership_version).toBe(4);
  });
});

describe('VersionConflictError', () => {
  it('carries code and currentVersion', async () => {
    const svc = await import('../src/services/org.service.js');
    const err = new svc.VersionConflictError(42);
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.currentVersion).toBe(42);
    expect(err.name).toBe('VersionConflictError');
  });
});
