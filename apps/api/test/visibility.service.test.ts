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
import { preflightAccess } from '../src/services/visibility.service.js';

// ---------- constants ----------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_ASKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_OWNER = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_OTHER = 'cccccccc-0000-0000-0000-000000000003';
const PROJECT_ID = 'dddddddd-0000-0000-0000-000000000004';
const ENTITY_ID = 'eeeeeeee-0000-0000-0000-000000000005';

// ---------- chain helpers ----------
//
// preflightAccess always starts with:
//   loadAsker -> select from users where id -> row
// Then dispatches to the per-type helper which runs its own SELECTs.
// Each SELECT chain looks like: select({...}).from(table).where(...).limit(1).

function pushSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const innerJoin = vi.fn().mockReturnThis();
  // Provide both innerJoin (chainable) and direct .where on from()
  const fromWithJoin = {
    where,
    innerJoin: vi.fn().mockReturnValue({ where }),
  };
  mockDb.select.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue(fromWithJoin),
  }));
  // Suppress unused-variable lints
  void from;
  void innerJoin;
}

// Helper for an asker lookup (users WHERE id). Wave E.F: loadAsker now
// runs two SELECTs — the user row, then the role join against
// account_group_memberships → permission_groups.
function mockAsker(org_id: string, role: string) {
  pushSelect([{ id: USER_ASKER, org_id }]);
  pushSelect([{ legacy_role: role }]);
}

function mockAskerMissing() {
  pushSelect([]);
}

// ---------- tests ----------

describe('visibility.service preflightAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('asker resolution', () => {
    it('returns not_found when asker does not exist', async () => {
      mockAskerMissing();
      const result = await preflightAccess(USER_ASKER, 'bam.task', ENTITY_ID);
      expect(result).toEqual({ allowed: false, reason: 'not_found' });
    });

    it('returns unsupported_entity_type for unknown entity types', async () => {
      mockAsker(ORG_A, 'member');
      const result = await preflightAccess(USER_ASKER, 'nope.nope', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('unsupported_entity_type');
    });
  });

  describe('bam.project', () => {
    it('allows when asker is project member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: PROJECT_ID, org_id: ORG_A }]); // project exists, same org
      pushSelect([{ id: 'pm-1' }]); // membership found
      const result = await preflightAccess(USER_ASKER, 'bam.project', PROJECT_ID);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.entity_org_id).toBe(ORG_A);
    });

    it('allows when asker is org admin even without project membership', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([{ id: PROJECT_ID, org_id: ORG_A }]);
      // no membership query required for admin
      const result = await preflightAccess(USER_ASKER, 'bam.project', PROJECT_ID);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('denies not_project_member for member with no membership', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: PROJECT_ID, org_id: ORG_A }]);
      pushSelect([]); // no membership
      const result = await preflightAccess(USER_ASKER, 'bam.project', PROJECT_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_project_member');
    });

    it('returns not_found when project is in a different org', async () => {
      mockAsker(ORG_A, 'owner');
      pushSelect([{ id: PROJECT_ID, org_id: ORG_B }]);
      const result = await preflightAccess(USER_ASKER, 'bam.project', PROJECT_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('returns not_found when project does not exist', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([]); // project missing
      const result = await preflightAccess(USER_ASKER, 'bam.project', PROJECT_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('bam.task', () => {
    it('allows project member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, project_id: PROJECT_ID, org_id: ORG_A }]);
      pushSelect([{ id: 'pm-1' }]);
      const result = await preflightAccess(USER_ASKER, 'bam.task', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies not_project_member when asker is not in project', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, project_id: PROJECT_ID, org_id: ORG_A }]);
      pushSelect([]);
      const result = await preflightAccess(USER_ASKER, 'bam.task', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_project_member');
    });
  });

  describe('bam.sprint', () => {
    it('allows project member on the sprint project', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, project_id: PROJECT_ID, org_id: ORG_A }]);
      pushSelect([{ id: 'pm-1' }]);
      const result = await preflightAccess(USER_ASKER, 'bam.sprint', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });
  });

  describe('helpdesk.ticket', () => {
    it('allows any authenticated caller when ticket has no project_id', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, project_id: null }]); // inbound ticket
      const result = await preflightAccess(USER_ASKER, 'helpdesk.ticket', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies not_project_member when ticket has a project and asker is not a member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([{ id: ENTITY_ID, project_id: PROJECT_ID }]);
      pushSelect([{ id: PROJECT_ID, org_id: ORG_A }]); // project lookup
      pushSelect([]); // membership missing
      const result = await preflightAccess(USER_ASKER, 'helpdesk.ticket', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_project_member');
    });

    it('returns not_found when ticket does not exist', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([]);
      const result = await preflightAccess(USER_ASKER, 'helpdesk.ticket', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('bond.deal', () => {
    it('allows when member is the owner', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          owner_id: USER_ASKER,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.deal', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies bond_restricted_role_not_owner when member is not the owner', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          owner_id: USER_OTHER,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.deal', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('bond_restricted_role_not_owner');
    });

    it('allows admin to see any deal in the org even without ownership', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          owner_id: USER_OWNER,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.deal', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('returns not_found for cross-org deal', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_B,
          owner_id: USER_OWNER,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.deal', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('treats soft-deleted deals as not_found', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          owner_id: USER_ASKER,
          deleted_at: new Date(),
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.deal', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('bond.contact', () => {
    it('denies member viewing someone else\'s contact', async () => {
      mockAsker(ORG_A, 'viewer');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          owner_id: USER_OTHER,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.contact', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('bond_restricted_role_not_owner');
    });
  });

  describe('bond.company', () => {
    it('allows any org member to see a company', async () => {
      mockAsker(ORG_A, 'viewer');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.company', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies cross-org company with not_found', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_B,
          deleted_at: null,
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'bond.company', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('brief.document', () => {
    it('allows organization-visibility documents to any org member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_A,
          project_id: PROJECT_ID,
          created_by: USER_OTHER,
          visibility: 'organization',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies private documents with no collaborator', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_A,
          project_id: null,
          created_by: USER_OTHER,
          visibility: 'private',
        },
      ]);
      pushSelect([]); // not a collaborator
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('private_document_no_collaborator');
    });

    it('allows private documents when asker is the creator', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_A,
          project_id: null,
          created_by: USER_ASKER,
          visibility: 'private',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('allows project documents when asker is a project member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_A,
          project_id: PROJECT_ID,
          created_by: USER_OTHER,
          visibility: 'project',
        },
      ]);
      pushSelect([]); // not a collaborator
      pushSelect([{ id: 'pm-1' }]); // is a project member
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies project documents with no project membership and no collaborator', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_A,
          project_id: PROJECT_ID,
          created_by: USER_OTHER,
          visibility: 'project',
        },
      ]);
      pushSelect([]); // not a collaborator
      pushSelect([]); // not a project member
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_project_member');
    });

    it('returns not_found for cross-org documents', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          org_id: ORG_B,
          project_id: null,
          created_by: USER_OTHER,
          visibility: 'organization',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'brief.document', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('beacon.entry', () => {
    it('allows Organization visibility to org members', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          project_id: null,
          created_by: USER_OTHER,
          owned_by: USER_OTHER,
          visibility: 'Organization',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('allows Private to owned_by', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          project_id: null,
          created_by: USER_OTHER,
          owned_by: USER_ASKER,
          visibility: 'Private',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies Private to non-owner/non-creator with beacon_private_not_owner', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          project_id: null,
          created_by: USER_OTHER,
          owned_by: USER_OTHER,
          visibility: 'Private',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('beacon_private_not_owner');
    });

    it('allows Project visibility to project members', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          project_id: PROJECT_ID,
          created_by: USER_OTHER,
          owned_by: USER_OTHER,
          visibility: 'Project',
        },
      ]);
      pushSelect([{ id: 'pm-1' }]); // is a project member
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(true);
    });

    it('denies Project visibility with beacon_project_not_member when not a member', async () => {
      mockAsker(ORG_A, 'member');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_A,
          project_id: PROJECT_ID,
          created_by: USER_OTHER,
          owned_by: USER_OTHER,
          visibility: 'Project',
        },
      ]);
      pushSelect([]); // not a project member
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('beacon_project_not_member');
    });

    it('returns not_found for cross-org beacon', async () => {
      mockAsker(ORG_A, 'admin');
      pushSelect([
        {
          id: ENTITY_ID,
          organization_id: ORG_B,
          project_id: null,
          created_by: USER_OTHER,
          owned_by: USER_OTHER,
          visibility: 'Organization',
        },
      ]);
      const result = await preflightAccess(USER_ASKER, 'beacon.entry', ENTITY_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });
});
