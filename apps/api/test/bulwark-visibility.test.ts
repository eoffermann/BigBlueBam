import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- hoisted mocks ----------
const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
    },
  };
});

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
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

// Import AFTER mocks
import {
  preflightAccess,
  SUPPORTED_ENTITY_TYPES,
} from '../src/services/visibility.service.js';

// ---------- constants ----------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const PROJ = '33333333-3333-3333-3333-333333333333';
const USER_ASKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTITY_ID = 'eeeeeeee-0000-0000-0000-000000000005';

// ---------- chain helpers ----------
//
// Mirrors apps/api/test/braid-visibility.test.ts. Each SELECT chain looks like
// select({...}).from(table)[.innerJoin(...)].where(...).limit(1), and we queue
// one canned result set per SELECT in call order.

function pushSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const fromWithJoin = {
    where,
    innerJoin: vi.fn().mockReturnValue({ where }),
  };
  mockDb.select.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue(fromWithJoin),
  }));
}

// loadAsker runs two SELECTs: the user row, then the role join.
function mockAsker(org_id: string, role: string, is_superuser = false) {
  pushSelect([{ id: USER_ASKER, org_id, is_superuser }]);
  pushSelect([{ legacy_role: role }]);
}

// ---------- tests ----------

describe('bulwark visibility branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SUPPORTED_ENTITY_TYPES registration', () => {
    it('includes the three new Bulwark contract-monitor types', () => {
      expect(SUPPORTED_ENTITY_TYPES).toContain('bulwark.contract');
      expect(SUPPORTED_ENTITY_TYPES).toContain('bulwark.obligation');
      expect(SUPPORTED_ENTITY_TYPES).toContain('bulwark.deadline');
    });
  });

  describe('bulwark.contract', () => {
    it('allows an org admin to read any contract in their org', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: PROJ }]);
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('allows a project member (non-admin) on a job-scoped contract', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: PROJ }]);
      pushSelect([{ id: 'membership-row' }]); // isProjectMember -> true
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('denies a non-member (non-admin) on a job-scoped contract', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: PROJ }]);
      pushSelect([]); // isProjectMember -> false
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_project_member');
    });

    it('falls back to org-membership for a null-project contract (SK3)', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: null }]);
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('returns not_found for a cross-org contract', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B, project_id: PROJ }]);
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('returns not_found for a missing contract', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([]); // no contract row
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.contract',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('bulwark.obligation', () => {
    it('allows a project member via the parent contract join', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: PROJ }]);
      pushSelect([{ id: 'membership-row' }]); // isProjectMember -> true
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.obligation',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('returns not_found for a dangling obligation (contract gone)', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([]); // inner join yields no row
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.obligation',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('bulwark.deadline', () => {
    it('allows an org admin via the parent contract join', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A, project_id: PROJ }]);
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.deadline',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('returns not_found for a deadline whose contract is in another org', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B, project_id: PROJ }]);
      const result = await preflightAccess(
        USER_ASKER,
        'bulwark.deadline',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });
});
