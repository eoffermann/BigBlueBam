import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn(),
    // transitionBeacon, verifyBeacon and createBeacon run in a transaction (#304);
    // the mock hands the callback a tx with the same query builders.
    transaction: vi.fn((cb: (tx: unknown) => unknown) =>
      cb({ select: mockSelect, insert: mockInsert, update: mockUpdate })),
    execute: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4004,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_BUCKET: 'beacon-uploads',
    S3_REGION: 'us-east-1',
    QDRANT_URL: 'http://qdrant:6333',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
  },
}));

// ---------------------------------------------------------------------------
// Chain helpers — produce a Drizzle-like chainable query builder mock.
// ---------------------------------------------------------------------------

function chainable(result: unknown[]) {
  const obj: any = {};
  // Make the object thenable so `await db.select().from().where()` resolves
  obj.then = (resolve: Function, reject?: Function) => Promise.resolve(result).then(resolve as any, reject as any);
  // Terminal methods return the result
  obj.returning = vi.fn().mockResolvedValue(result);
  // Intermediate methods return obj for chaining
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.fields = vi.fn().mockReturnValue(obj);
  // .limit(1).for('update') on the locked reads
  obj.limit = vi.fn().mockReturnValue(obj);
  obj.for = vi.fn().mockResolvedValue(result);
  return obj;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const BEACON_ID = '00000000-0000-0000-0000-000000000010';

function makeBeacon(overrides: Record<string, unknown> = {}) {
  return {
    id: BEACON_ID,
    slug: 'test-beacon',
    title: 'Test Beacon',
    summary: null,
    body_markdown: '# Test',
    body_html: null,
    version: 1,
    status: 'Active',
    visibility: 'Project',
    created_by: USER_ID,
    owned_by: USER_ID,
    project_id: PROJECT_ID,
    organization_id: ORG_ID,
    expires_at: new Date('2026-05-01'),
    last_verified_at: null,
    last_verified_by: null,
    verification_count: 0,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    retired_at: null,
    vector_id: null,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: assertTransition
// ---------------------------------------------------------------------------

describe('assertTransition', () => {
  let assertTransition: (from: string, to: string) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/services/lifecycle.service.js');
    assertTransition = mod.assertTransition as any;
  });

  // Valid transitions
  it('allows Draft → Active', () => {
    expect(() => assertTransition('Draft', 'Active')).not.toThrow();
  });

  it('allows Active → PendingReview', () => {
    expect(() => assertTransition('Active', 'PendingReview')).not.toThrow();
  });

  it('allows PendingReview → Active', () => {
    expect(() => assertTransition('PendingReview', 'Active')).not.toThrow();
  });

  it('allows PendingReview → Archived', () => {
    expect(() => assertTransition('PendingReview', 'Archived')).not.toThrow();
  });

  it('allows Archived → Active', () => {
    expect(() => assertTransition('Archived', 'Active')).not.toThrow();
  });

  it('allows Archived → Retired', () => {
    expect(() => assertTransition('Archived', 'Retired')).not.toThrow();
  });

  it('allows Active → Retired (any → Retired)', () => {
    expect(() => assertTransition('Active', 'Retired')).not.toThrow();
  });

  it('allows Draft → Retired (any → Retired)', () => {
    expect(() => assertTransition('Draft', 'Retired')).not.toThrow();
  });

  it('allows PendingReview → Retired (any → Retired)', () => {
    expect(() => assertTransition('PendingReview', 'Retired')).not.toThrow();
  });

  // Invalid transitions
  it('rejects Draft → Archived', () => {
    expect(() => assertTransition('Draft', 'Archived')).toThrow();
  });

  it('rejects Active → Draft', () => {
    expect(() => assertTransition('Active', 'Draft')).toThrow();
  });

  it('rejects Retired → Active (terminal state)', () => {
    expect(() => assertTransition('Retired', 'Active')).toThrow();
  });

  it('rejects Retired → Draft (terminal state)', () => {
    expect(() => assertTransition('Retired', 'Draft')).toThrow();
  });

  it('rejects Archived → PendingReview', () => {
    expect(() => assertTransition('Archived', 'PendingReview')).toThrow();
  });

  it('rejects Draft → PendingReview', () => {
    expect(() => assertTransition('Draft', 'PendingReview')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: transitionBeacon
// ---------------------------------------------------------------------------

describe('transitionBeacon', () => {
  let transitionBeacon: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/lifecycle.service.js');
    transitionBeacon = mod.transitionBeacon;
  });

  it('transitions Draft → Active and sets expires_at', async () => {
    const beacon = makeBeacon({ status: 'Draft' });
    const updatedBeacon = makeBeacon({ status: 'Active' });

    // getBeaconById select chain
    const selectChain = chainable([beacon]);
    mockSelect.mockReturnValue(selectChain);

    // resolveExpiryPolicy: system policy query, org query, project query
    // The function calls select 3 times for policy resolution + 1 for getBeaconById
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // getBeaconById
        return chainable([beacon]);
      }
      if (selectCallCount === 2) {
        // system policy
        return chainable([{
          min_expiry_days: 7,
          max_expiry_days: 365,
          default_expiry_days: 90,
          grace_period_days: 14,
        }]);
      }
      // org and project policy — not found
      return chainable([]);
    });

    const updateChain = chainable([updatedBeacon]);
    mockUpdate.mockReturnValue(updateChain);

    const result = await transitionBeacon(BEACON_ID, 'Active', USER_ID, undefined, ORG_ID);
    expect(result).toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('throws 404 when beacon not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(transitionBeacon(BEACON_ID, 'Active', USER_ID, undefined, ORG_ID)).rejects.toThrow(
      'Beacon not found',
    );
  });

  it('throws 409 on invalid transition', async () => {
    const beacon = makeBeacon({ status: 'Retired' });
    mockSelect.mockReturnValue(chainable([beacon]));

    await expect(
      transitionBeacon(BEACON_ID, 'Active', USER_ID, undefined, ORG_ID),
    ).rejects.toThrow("Cannot transition from 'Retired' to 'Active'");
  });

  // #304: the UPDATE is predicated on the status it was validated against, and a
  // row whose status moved underneath answers 409 instead of being overwritten.
  it('answers 409 when the status-guarded UPDATE matches no row (#304)', async () => {
    mockSelect.mockReturnValue(chainable([makeBeacon({ status: 'Active' })]));
    mockUpdate.mockReturnValue(chainable([]));

    await expect(
      transitionBeacon(BEACON_ID, 'Retired', USER_ID, undefined, ORG_ID),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('reads the row FOR UPDATE and bumps verification_count in SQL (#304)', async () => {
    const select = chainable([makeBeacon({ status: 'PendingReview', verification_count: 5 })]);
    mockSelect.mockReturnValueOnce(select).mockReturnValue(chainable([]));
    const update = chainable([makeBeacon({ status: 'Active', verification_count: 6 })]);
    mockUpdate.mockReturnValue(update);

    await transitionBeacon(BEACON_ID, 'Active', USER_ID, undefined, ORG_ID);

    expect(select.for).toHaveBeenCalledWith('update');
    const setArg = update.set.mock.calls[0][0];
    // A stale read-modify-write would write the literal 6.
    expect(typeof setArg.verification_count).not.toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Policy: resolveExpiryPolicy
// ---------------------------------------------------------------------------

describe('resolveExpiryPolicy', () => {
  let resolveExpiryPolicy: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/policy.service.js');
    resolveExpiryPolicy = mod.resolveExpiryPolicy;
  });

  it('returns fallback when no policies exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await resolveExpiryPolicy(null, ORG_ID);
    expect(result).toEqual({
      min_days: 7,
      max_days: 365,
      default_days: 90,
      grace_days: 14,
    });
  });

  it('narrows with System + Org policies', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // System policy
        return chainable([{
          min_expiry_days: 7,
          max_expiry_days: 365,
          default_expiry_days: 90,
          grace_period_days: 14,
        }]);
      }
      if (callCount === 2) {
        // Org policy
        return chainable([{
          min_expiry_days: 14,
          max_expiry_days: 180,
          default_expiry_days: 60,
          grace_period_days: 7,
        }]);
      }
      return chainable([]);
    });

    const result = await resolveExpiryPolicy(null, ORG_ID);
    expect(result).toEqual({
      min_days: 14,   // MAX(7, 14)
      max_days: 180,  // MIN(365, 180)
      default_days: 60,
      grace_days: 7,  // org overrides system
    });
  });

  it('narrows with System + Org + Project policies', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // System
        return chainable([{
          min_expiry_days: 7,
          max_expiry_days: 365,
          default_expiry_days: 90,
          grace_period_days: 14,
        }]);
      }
      if (callCount === 2) {
        // Org
        return chainable([{
          min_expiry_days: 14,
          max_expiry_days: 180,
          default_expiry_days: 60,
          grace_period_days: 7,
        }]);
      }
      if (callCount === 3) {
        // Project
        return chainable([{
          min_expiry_days: 14,
          max_expiry_days: 90,
          default_expiry_days: 30,
          grace_period_days: 7,
        }]);
      }
      return chainable([]);
    });

    const result = await resolveExpiryPolicy(PROJECT_ID, ORG_ID);
    expect(result).toEqual({
      min_days: 14,   // MAX(14, 14)
      max_days: 90,   // MIN(180, 90)
      default_days: 30,
      grace_days: 7,
    });
  });

  it('clamps default_days to effective range', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // System: narrow range
        return chainable([{
          min_expiry_days: 30,
          max_expiry_days: 60,
          default_expiry_days: 45,
          grace_period_days: 14,
        }]);
      }
      if (callCount === 2) {
        // Org: default outside effective range after narrowing
        return chainable([{
          min_expiry_days: 30,
          max_expiry_days: 50,
          default_expiry_days: 55, // above max after narrowing → clamp to 50
          grace_period_days: 7,
        }]);
      }
      return chainable([]);
    });

    const result = await resolveExpiryPolicy(null, ORG_ID);
    expect(result.default_days).toBe(50); // clamped to effective.max
  });

  it('throws POLICY_CONFLICT when child min > parent max', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // System: narrow range
        return chainable([{
          min_expiry_days: 7,
          max_expiry_days: 30,
          default_expiry_days: 14,
          grace_period_days: 14,
        }]);
      }
      if (callCount === 2) {
        // Org: min > system max after narrowing
        return chainable([{
          min_expiry_days: 50, // will become MAX(7, 50) = 50
          max_expiry_days: 20, // will become MIN(30, 20) = 20
          default_expiry_days: 15,
          grace_period_days: 7,
        }]);
      }
      return chainable([]);
    });

    await expect(resolveExpiryPolicy(null, ORG_ID)).rejects.toThrow('Policy conflict');
  });
});

// ---------------------------------------------------------------------------
// Policy: validatePolicySave
// ---------------------------------------------------------------------------

describe('validatePolicySave', () => {
  let validatePolicySave: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/policy.service.js');
    validatePolicySave = mod.validatePolicySave;
  });

  it('rejects when min > default', async () => {
    await expect(
      validatePolicySave(
        { min_expiry_days: 30, max_expiry_days: 90, default_expiry_days: 20, grace_period_days: 14 },
        'System',
      ),
    ).rejects.toThrow('min_expiry_days must be <= default_expiry_days');
  });

  it('rejects when default > max', async () => {
    await expect(
      validatePolicySave(
        { min_expiry_days: 10, max_expiry_days: 30, default_expiry_days: 50, grace_period_days: 14 },
        'System',
      ),
    ).rejects.toThrow('default_expiry_days must be <= max_expiry_days');
  });

  it('rejects when min < 1', async () => {
    await expect(
      validatePolicySave(
        { min_expiry_days: 0, max_expiry_days: 90, default_expiry_days: 30, grace_period_days: 14 },
        'System',
      ),
    ).rejects.toThrow('min_expiry_days must be > 0');
  });

  it('rejects org policy below system min', async () => {
    // System policy query for parent
    mockSelect.mockReturnValue(
      chainable([{
        min_expiry_days: 14,
        max_expiry_days: 365,
        default_expiry_days: 90,
        grace_period_days: 14,
      }]),
    );

    await expect(
      validatePolicySave(
        { min_expiry_days: 7, max_expiry_days: 180, default_expiry_days: 60, grace_period_days: 7 },
        'Organization',
        ORG_ID,
      ),
    ).rejects.toThrow('Minimum (7) is below parent minimum (14)');
  });

  it('rejects org policy above system max', async () => {
    mockSelect.mockReturnValue(
      chainable([{
        min_expiry_days: 7,
        max_expiry_days: 180,
        default_expiry_days: 90,
        grace_period_days: 14,
      }]),
    );

    await expect(
      validatePolicySave(
        { min_expiry_days: 14, max_expiry_days: 365, default_expiry_days: 60, grace_period_days: 7 },
        'Organization',
        ORG_ID,
      ),
    ).rejects.toThrow('Maximum (365) exceeds parent maximum (180)');
  });

  it('passes valid system policy with no parent', async () => {
    // System scope has no parent, only checks children
    mockSelect.mockReturnValue(chainable([]));

    const warnings = await validatePolicySave(
      { min_expiry_days: 7, max_expiry_days: 365, default_expiry_days: 90, grace_period_days: 14 },
      'System',
    );
    expect(warnings).toEqual([]);
  });

  it('warns about out-of-range child policies', async () => {
    // System scope — select children (org policies)
    mockSelect.mockReturnValue(
      chainable([{
        id: 'child-1',
        scope: 'Organization',
        organization_id: ORG_ID,
        project_id: null,
        min_expiry_days: 5,  // below new system min of 10
        max_expiry_days: 200,
        default_expiry_days: 60,
        grace_period_days: 7,
      }]),
    );

    const warnings = await validatePolicySave(
      { min_expiry_days: 10, max_expiry_days: 365, default_expiry_days: 90, grace_period_days: 14 },
      'System',
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe('warn');
    expect(warnings[0].message).toContain('auto-clamped');
  });
});

// ---------------------------------------------------------------------------
// Verification: verifyBeacon
// ---------------------------------------------------------------------------

describe('verifyBeacon', () => {
  let verifyBeacon: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/verification.service.js');
    verifyBeacon = mod.verifyBeacon;
  });

  it('inserts verification and updates beacon metadata', async () => {
    const beacon = makeBeacon({ status: 'PendingReview' });
    const verificationRow = {
      id: 'ver-1',
      beacon_id: BEACON_ID,
      verified_by: USER_ID,
      verification_type: 'Manual',
      outcome: 'Confirmed',
      confidence_score: null,
      notes: null,
      created_at: new Date(),
    };

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // getBeaconById for verifyBeacon
        return chainable([beacon]);
      }
      if (selectCallCount === 2) {
        // getBeaconById for transitionBeacon
        return chainable([beacon]);
      }
      // Policy resolution queries (system, org, project)
      if (selectCallCount === 3) {
        return chainable([{
          min_expiry_days: 7,
          max_expiry_days: 365,
          default_expiry_days: 90,
          grace_period_days: 14,
        }]);
      }
      return chainable([]);
    });

    mockInsert.mockReturnValue(chainable([verificationRow]));

    const updatedBeacon = makeBeacon({ status: 'Active', verification_count: 1 });
    mockUpdate.mockReturnValue(chainable([updatedBeacon]));

    const result = await verifyBeacon(BEACON_ID, USER_ID, {
      type: 'Manual',
      outcome: 'Confirmed',
    }, ORG_ID);

    expect(result.verification).toBeDefined();
    expect(mockInsert).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('throws 404 when beacon does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      verifyBeacon(BEACON_ID, USER_ID, { type: 'Manual', outcome: 'Confirmed' }, ORG_ID),
    ).rejects.toThrow('Beacon not found');
  });

  it('increments verification_count in SQL, not from a pre-read (#304)', async () => {
    mockSelect.mockReturnValue(chainable([makeBeacon({ status: 'Active', verification_count: 3 })]));
    mockInsert.mockReturnValue(chainable([{ id: 'ver-1' }]));
    const update = chainable([makeBeacon({ status: 'Active', verification_count: 4 })]);
    mockUpdate.mockReturnValue(update);

    await verifyBeacon(BEACON_ID, USER_ID, { type: 'Manual', outcome: 'Confirmed' }, ORG_ID);

    const setArg = update.set.mock.calls[0][0];
    expect(typeof setArg.verification_count).not.toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Agent verification: processAgentVerification
// ---------------------------------------------------------------------------

describe('processAgentVerification', () => {
  let processAgentVerification: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/verification.service.js');
    processAgentVerification = mod.processAgentVerification;
  });

  it('auto-confirms when confidence >= auto_confirm_threshold', async () => {
    const beacon = makeBeacon({ status: 'PendingReview' });
    const agentRow = {
      id: 'agent-1',
      user_id: USER_ID,
      name: 'Test Agent',
      model_identifier: 'claude-sonnet-4-20250514',
      organization_id: ORG_ID,
      agent_config: { auto_confirm_threshold: 0.85, assisted_threshold: 0.50 },
      is_active: true,
    };

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // agent lookup
        return chainable([agentRow]);
      }
      if (selectCallCount === 2) {
        // getBeaconById for verifyBeacon
        return chainable([beacon]);
      }
      if (selectCallCount === 3) {
        // getBeaconById for transitionBeacon
        return chainable([beacon]);
      }
      // Policy
      if (selectCallCount === 4) {
        return chainable([{
          min_expiry_days: 7, max_expiry_days: 365,
          default_expiry_days: 90, grace_period_days: 14,
        }]);
      }
      return chainable([]);
    });

    mockInsert.mockReturnValue(chainable([{ id: 'ver-1' }]));
    mockUpdate.mockReturnValue(chainable([makeBeacon({ status: 'Active' })]));

    const result = await processAgentVerification(BEACON_ID, USER_ID, 0.92, ORG_ID);
    expect(result).toBeDefined();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('escalates below assisted threshold', async () => {
    const beacon = makeBeacon({ status: 'PendingReview' });
    const agentRow = {
      id: 'agent-1',
      user_id: USER_ID,
      name: 'Test Agent',
      model_identifier: null,
      organization_id: ORG_ID,
      agent_config: { auto_confirm_threshold: 0.85, assisted_threshold: 0.50 },
      is_active: true,
    };

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return chainable([agentRow]);
      }
      // getBeaconById for the escalation path
      return chainable([beacon]);
    });

    mockInsert.mockReturnValue(chainable([{ id: 'ver-esc' }]));

    const result = await processAgentVerification(BEACON_ID, USER_ID, 0.30, ORG_ID);
    expect(result.escalated).toBe(true);
  });

  it('throws when agent not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      processAgentVerification(BEACON_ID, USER_ID, 0.90, ORG_ID),
    ).rejects.toThrow('Agent not found');
  });

  it('throws when agent is deactivated', async () => {
    mockSelect.mockReturnValue(
      chainable([{
        id: 'agent-1',
        user_id: USER_ID,
        name: 'Disabled Agent',
        agent_config: {},
        is_active: false,
      }]),
    );

    await expect(
      processAgentVerification(BEACON_ID, USER_ID, 0.90, ORG_ID),
    ).rejects.toThrow('Agent is deactivated');
  });
});
