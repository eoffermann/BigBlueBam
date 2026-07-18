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
const USER_ASKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTITY_ID = 'eeeeeeee-0000-0000-0000-000000000005';

// ---------- chain helpers ----------
//
// Mirrors apps/api/test/visibility.service.test.ts. Each SELECT chain looks
// like select({...}).from(table)[.innerJoin(...)].where(...).limit(1), and we
// queue one canned result set per SELECT in call order.

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

describe('braid visibility branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SUPPORTED_ENTITY_TYPES registration', () => {
    it('includes the four new Braid person-source + golden-profile types', () => {
      expect(SUPPORTED_ENTITY_TYPES).toContain('bill.client');
      expect(SUPPORTED_ENTITY_TYPES).toContain('book.event_attendee');
      expect(SUPPORTED_ENTITY_TYPES).toContain('braid.profile');
      expect(SUPPORTED_ENTITY_TYPES).toContain('braid.identity');
    });
  });

  describe('bill.client', () => {
    it('allows any org member to read a client (org-wide)', async () => {
      mockAsker(ORG_A, 'viewer');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      const result = await preflightAccess(USER_ASKER, 'bill.client', ENTITY_ID);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('returns not_found for a cross-org client', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B }]);
      const result = await preflightAccess(USER_ASKER, 'bill.client', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('book.event_attendee', () => {
    it('allows an attendee whose parent event is in the asker org', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]); // joined event org
      const result = await preflightAccess(
        USER_ASKER,
        'book.event_attendee',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('returns not_found for an attendee whose event is in another org', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B }]);
      const result = await preflightAccess(
        USER_ASKER,
        'book.event_attendee',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('braid.profile', () => {
    it('allows any org member to read a golden profile in their org', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      const result = await preflightAccess(
        USER_ASKER,
        'braid.profile',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('returns not_found for a cross-org profile', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B }]);
      const result = await preflightAccess(
        USER_ASKER,
        'braid.profile',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('braid.identity', () => {
    it('allows an identity whose parent profile is in the asker org', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]); // joined profile org
      const result = await preflightAccess(
        USER_ASKER,
        'braid.identity',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('returns not_found for an identity whose profile is in another org', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_B }]);
      const result = await preflightAccess(
        USER_ASKER,
        'braid.identity',
        ENTITY_ID,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });
});
