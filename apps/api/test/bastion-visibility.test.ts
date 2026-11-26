import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VISIBILITY_ENTITY_TYPES } from '@bigbluebam/shared';

// Bastion can_access branches (APP_DESIGN_bastion.md 5.5, 8.3, 8.4; M6). Mirrors
// bulwark-visibility.test.ts: each SELECT chain is select().from().where().limit(1).

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));

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

import { preflightAccess, SUPPORTED_ENTITY_TYPES } from '../src/services/visibility.service.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_ASKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'aaaaaaaa-0000-0000-0000-000000000009';
const ENTITY_ID = 'eeeeeeee-0000-0000-0000-000000000005';

function pushSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const fromWithJoin = { where, innerJoin: vi.fn().mockReturnValue({ where }) };
  mockDb.select.mockImplementationOnce(() => ({ from: vi.fn().mockReturnValue(fromWithJoin) }));
}

function mockAsker(org_id: string, role: string, is_superuser = false) {
  pushSelect([{ id: USER_ASKER, org_id, is_superuser }]);
  pushSelect([{ legacy_role: role }]);
}

const SIX = ['bastion.control', 'bastion.manual_evidence', 'bastion.policy', 'bastion.questionnaire', 'bastion.fix_draft', 'bastion.exception'];

describe('bastion visibility branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the six bastion.* types from the one shared list', () => {
    for (const t of SIX) expect(SUPPORTED_ENTITY_TYPES).toContain(t);
    expect([...SUPPORTED_ENTITY_TYPES]).toEqual([...VISIBILITY_ENTITY_TYPES]);
  });

  for (const t of ['bastion.control', 'bastion.policy', 'bastion.exception']) {
    it(`${t}: a viewer in the org may see it; a guest may not; another org reads not_found`, async () => {
      mockAsker(ORG_A, 'viewer');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      expect(await preflightAccess(USER_ASKER, t, ENTITY_ID)).toMatchObject({ allowed: true, reason: 'ok', entity_org_id: ORG_A });

      mockAsker(ORG_A, 'guest');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      expect(await preflightAccess(USER_ASKER, t, ENTITY_ID)).toMatchObject({ allowed: false, reason: 'bastion_role_not_granted' });

      mockAsker(ORG_B, 'owner');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      expect(await preflightAccess(USER_ASKER, t, ENTITY_ID)).toMatchObject({ allowed: false, reason: 'not_found' });
    });
  }

  for (const t of ['bastion.questionnaire', 'bastion.fix_draft']) {
    it(`${t}: members may see it, viewers may not (spec 5.5 grants no viewer read)`, async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      expect((await preflightAccess(USER_ASKER, t, ENTITY_ID)).allowed).toBe(true);

      mockAsker(ORG_A, 'viewer');
      pushSelect([{ id: ENTITY_ID, organization_id: ORG_A }]);
      expect(await preflightAccess(USER_ASKER, t, ENTITY_ID)).toMatchObject({ allowed: false, reason: 'bastion_role_not_granted' });
    });
  }

  it('bastion.manual_evidence: restricted items only for admins, the owner and the uploader', async () => {
    const restricted = { id: ENTITY_ID, organization_id: ORG_A, sensitivity: 'restricted', owner_user_id: OTHER, uploaded_by: OTHER };
    mockAsker(ORG_A, 'member');
    pushSelect([restricted]);
    expect(await preflightAccess(USER_ASKER, 'bastion.manual_evidence', ENTITY_ID)).toMatchObject({ allowed: false, reason: 'bastion_restricted_evidence' });

    mockAsker(ORG_A, 'admin');
    pushSelect([restricted]);
    expect((await preflightAccess(USER_ASKER, 'bastion.manual_evidence', ENTITY_ID)).allowed).toBe(true);

    mockAsker(ORG_A, 'member');
    pushSelect([{ ...restricted, owner_user_id: USER_ASKER }]);
    expect((await preflightAccess(USER_ASKER, 'bastion.manual_evidence', ENTITY_ID)).allowed).toBe(true);

    mockAsker(ORG_A, 'viewer');
    pushSelect([{ ...restricted, sensitivity: 'standard' }]);
    expect((await preflightAccess(USER_ASKER, 'bastion.manual_evidence', ENTITY_ID)).allowed).toBe(true);

    mockAsker(ORG_A, 'member');
    pushSelect([]);
    expect(await preflightAccess(USER_ASKER, 'bastion.manual_evidence', ENTITY_ID)).toMatchObject({ allowed: false, reason: 'not_found' });
  });
});
