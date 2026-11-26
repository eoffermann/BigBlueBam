import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VISIBILITY_ENTITY_TYPES } from '@bigbluebam/shared';

// can_access branches for the platform rows compliance probes cite (#227): bam.github_pr_event
// follows the event's Bam project, bam.api_key is admins plus the key's holder, bam.user is the
// /b3/people rule (admins plus the person). Same harness as bastion-visibility.test.ts: each
// SELECT chain is select().from().where().limit(1).

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
const ASKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'aaaaaaaa-0000-0000-0000-000000000009';
const ID = 'eeeeeeee-0000-0000-0000-000000000005';
const PROJECT = 'bbbbbbbb-0000-0000-0000-000000000001';

function pushSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const fromWithJoin = { where, innerJoin: vi.fn().mockReturnValue({ where }) };
  mockDb.select.mockImplementationOnce(() => ({ from: vi.fn().mockReturnValue(fromWithJoin) }));
}

function mockAsker(org_id: string, role: string, is_superuser = false) {
  pushSelect([{ id: ASKER, org_id, is_superuser }]);
  pushSelect([{ legacy_role: role }]);
}

describe('platform ref visibility (#227)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReset();
  });

  it('registers the three types in the one shared list', () => {
    for (const t of ['bam.github_pr_event', 'bam.api_key', 'bam.user']) expect(SUPPORTED_ENTITY_TYPES).toContain(t);
    expect([...SUPPORTED_ENTITY_TYPES]).toEqual([...VISIBILITY_ENTITY_TYPES]);
  });

  describe('bam.github_pr_event', () => {
    it('a member who is not in the PR event project is refused (the #227 leak)', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, project_id: PROJECT }]);
      pushSelect([{ id: PROJECT, org_id: ORG_A }]); // projects
      pushSelect([]); // project_memberships: not a member
      expect(await preflightAccess(ASKER, 'bam.github_pr_event', ID)).toMatchObject({ allowed: false, reason: 'not_project_member' });
    });

    it('a project member may see it', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, project_id: PROJECT }]);
      pushSelect([{ id: PROJECT, org_id: ORG_A }]);
      pushSelect([{ id: 'membership' }]);
      expect(await preflightAccess(ASKER, 'bam.github_pr_event', ID)).toMatchObject({ allowed: true, reason: 'ok' });
    });

    it('an event with no project is org-admin only', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, project_id: null }]);
      expect(await preflightAccess(ASKER, 'bam.github_pr_event', ID)).toMatchObject({ allowed: false, reason: 'not_project_member' });

      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ID, org_id: ORG_A, project_id: null }]);
      expect((await preflightAccess(ASKER, 'bam.github_pr_event', ID)).allowed).toBe(true);
    });

    it('another org reads not_found', async () => {
      mockAsker(ORG_B, 'owner');
      pushSelect([{ id: ID, org_id: ORG_A, project_id: PROJECT }]);
      expect(await preflightAccess(ASKER, 'bam.github_pr_event', ID)).toMatchObject({ allowed: false, reason: 'not_found' });
    });
  });

  describe('bam.api_key', () => {
    it("a member never sees someone else's key", async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, user_id: OTHER, project_ids: null }]);
      expect(await preflightAccess(ASKER, 'bam.api_key', ID)).toMatchObject({ allowed: false, reason: 'not_key_holder' });
    });

    it('the holder sees their own key, unless it is restricted to a project they left', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, user_id: ASKER, project_ids: null }]);
      expect((await preflightAccess(ASKER, 'bam.api_key', ID)).allowed).toBe(true);

      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ID, org_id: ORG_A, user_id: ASKER, project_ids: [PROJECT] }]);
      pushSelect([]); // not a member of the key's project any more
      expect(await preflightAccess(ASKER, 'bam.api_key', ID)).toMatchObject({ allowed: false, reason: 'not_project_member' });
    });

    it('org admins and SuperUsers see every key in the org; another org reads not_found', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: ID, org_id: ORG_A, user_id: OTHER, project_ids: [PROJECT] }]);
      expect((await preflightAccess(ASKER, 'bam.api_key', ID)).allowed).toBe(true);

      mockAsker(ORG_A, 'member', true);
      pushSelect([{ id: ID, org_id: ORG_A, user_id: OTHER, project_ids: null }]);
      expect((await preflightAccess(ASKER, 'bam.api_key', ID)).allowed).toBe(true);

      mockAsker(ORG_B, 'owner');
      pushSelect([{ id: ID, org_id: ORG_A, user_id: OTHER, project_ids: null }]);
      expect(await preflightAccess(ASKER, 'bam.api_key', ID)).toMatchObject({ allowed: false, reason: 'not_found' });
    });
  });

  describe('bam.user', () => {
    it('a member sees themselves but not other people', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ user_id: OTHER }]);
      expect(await preflightAccess(ASKER, 'bam.user', OTHER)).toMatchObject({ allowed: false, reason: 'people_admin_only' });

      mockAsker(ORG_A, 'member');
      pushSelect([{ user_id: ASKER }]);
      expect((await preflightAccess(ASKER, 'bam.user', ASKER)).allowed).toBe(true);
    });

    it('an org admin sees members of their org; a non-member reads not_found', async () => {
      mockAsker(ORG_A, 'owner');
      pushSelect([{ user_id: OTHER }]);
      expect((await preflightAccess(ASKER, 'bam.user', OTHER)).allowed).toBe(true);

      mockAsker(ORG_A, 'owner');
      pushSelect([]);
      expect(await preflightAccess(ASKER, 'bam.user', OTHER)).toMatchObject({ allowed: false, reason: 'not_found' });
    });
  });
});
