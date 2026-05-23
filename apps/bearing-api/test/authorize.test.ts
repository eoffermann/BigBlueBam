import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4007,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    MCP_INTERNAL_URL: 'http://mcp-server:3001',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
  },
}));

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const GOAL_ID = '00000000-0000-0000-0000-000000000020';

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: GOAL_ID,
    organization_id: ORG_ID,
    period_id: '00000000-0000-0000-0000-000000000010',
    scope: 'organization',
    project_id: null,
    team_name: null,
    title: 'Increase Revenue',
    description: null,
    icon: null,
    color: null,
    status: 'on_track',
    status_override: false,
    progress: '50.00',
    owner_id: USER_ID,
    created_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake request/reply builders
// ---------------------------------------------------------------------------

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req_test123',
    user: {
      id: USER_ID,
      org_id: ORG_ID,
      role: 'member',
      is_superuser: false,
    },
    params: { id: GOAL_ID },
    ...overrides,
  };
}

function fakeReply() {
  const reply: any = {};
  reply.status = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

// ---------------------------------------------------------------------------
// requireMinOrgRole — removed in Wave E.E; the resolver enforces org-level
// permission decisions now (catalog entry + fastify.requireCan). The bearing
// authorize middleware no longer exports a generic role gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// requireGoalAccess
// ---------------------------------------------------------------------------

describe('requireGoalAccess', () => {
  let requireGoalAccess: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/middleware/authorize.js');
    requireGoalAccess = mod.requireGoalAccess;
  });

  it('should return 401 when user is not authenticated', async () => {
    const handler = requireGoalAccess();
    const req = fakeRequest({ user: undefined });
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(401);
  });

  it('should return 400 for invalid goal id', async () => {
    const handler = requireGoalAccess();
    const req = fakeRequest({ params: { id: 'not-a-uuid' } });
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(400);
    expect(rep.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'BAD_REQUEST' }),
      }),
    );
  });

  it('should load goal and attach to request', async () => {
    const goal = makeGoal();
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalAccess();
    const req = fakeRequest() as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
    expect(req.goal).toBeDefined();
    expect(req.goal.id).toBe(GOAL_ID);
  });

  it('should return 404 when goal not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const handler = requireGoalAccess();
    const req = fakeRequest();
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(404);
  });

  it('should return 404 on org mismatch (cross-org isolation)', async () => {
    const goal = makeGoal({ organization_id: ORG_ID_2 });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'admin', is_superuser: false },
    });
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(404);
  });

  it('should allow superuser even with org mismatch', async () => {
    const goal = makeGoal({ organization_id: ORG_ID_2 });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'viewer', is_superuser: true },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
    expect(req.goal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// requireGoalEditAccess
// ---------------------------------------------------------------------------

describe('requireGoalEditAccess', () => {
  let requireGoalEditAccess: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/middleware/authorize.js');
    requireGoalEditAccess = mod.requireGoalEditAccess;
  });

  it('should return 401 when user is not authenticated', async () => {
    const handler = requireGoalEditAccess();
    const req = fakeRequest({ user: undefined });
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(401);
  });

  it('should allow admin to edit any goal in org', async () => {
    const goal = makeGoal({ created_by: 'other-user', owner_id: 'other-user' });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'admin', is_superuser: false },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
  });

  it('should allow goal creator to edit', async () => {
    const goal = makeGoal({ created_by: USER_ID, owner_id: 'other-user' });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'member', is_superuser: false },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
  });

  it('should allow goal owner to edit', async () => {
    const goal = makeGoal({ created_by: 'other-user', owner_id: USER_ID });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'member', is_superuser: false },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
  });

  it('should block viewer who is neither creator nor owner', async () => {
    const goal = makeGoal({ created_by: 'other-user', owner_id: 'another-user' });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'viewer', is_superuser: false },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(403);
    expect(rep.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }),
    );
  });

  it('should block member who is neither creator nor owner', async () => {
    const goal = makeGoal({ created_by: 'other-user', owner_id: 'another-user' });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'member', is_superuser: false },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(403);
  });

  it('should allow superuser to edit regardless of role or ownership', async () => {
    const goal = makeGoal({ created_by: 'other-user', owner_id: 'another-user', organization_id: ORG_ID_2 });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'viewer', is_superuser: true },
    }) as any;
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).not.toHaveBeenCalled();
  });

  it('should return 404 on org mismatch for non-superuser', async () => {
    const goal = makeGoal({ organization_id: ORG_ID_2 });
    mockSelect.mockReturnValue(chainable([goal]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest({
      user: { id: USER_ID, org_id: ORG_ID, role: 'admin', is_superuser: false },
    });
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(404);
  });

  it('should return 404 when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const handler = requireGoalEditAccess();
    const req = fakeRequest();
    const rep = fakeReply();

    await handler(req, rep);

    expect(rep.status).toHaveBeenCalledWith(404);
  });
});
