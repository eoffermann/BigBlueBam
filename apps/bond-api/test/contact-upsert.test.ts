import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock layer mirrors apps/bond-api/test/contact.test.ts (same chainable
// helper, same env stub) so the upsert tests slot into the suite cleanly.
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    transaction: mockTransaction,
    execute: mockExecute,
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4009,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
    PUBLIC_URL: 'http://localhost',
  },
}));

vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/bolt-enrichment.js', () => ({
  loadActor: vi.fn().mockResolvedValue(null),
  loadOrg: vi.fn().mockResolvedValue(null),
  contactUrl: (id: string) => `/bond/contacts/${id}`,
}));

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockReturnValue(obj);
  obj.offset = vi.fn().mockResolvedValue(result);
  obj.returning = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.fields = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.leftJoin = vi.fn().mockReturnValue(obj);
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  obj.onConflictDoUpdate = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const CONTACT_ID = '00000000-0000-0000-0000-000000000100';

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    organization_id: ORG_ID,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: null,
    title: null,
    avatar_url: null,
    lifecycle_stage: 'lead',
    lead_source: null,
    lead_score: 0,
    address_line1: null,
    address_line2: null,
    city: null,
    state_region: null,
    postal_code: null,
    country: null,
    custom_fields: {},
    owner_id: USER_ID,
    last_contacted_at: null,
    created_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    deleted_at: null,
    ...overrides,
  };
}

describe('upsertContactByEmail — validation', () => {
  let upsertContactByEmail: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact-upsert.service.js');
    upsertContactByEmail = mod.upsertContactByEmail;
  });

  it('rejects missing email with 400', async () => {
    await expect(
      upsertContactByEmail({ email: '' }, ORG_ID, USER_ID),
    ).rejects.toThrow(/email/);
  });
});

describe('upsertContactByEmail — create path', () => {
  let upsertContactByEmail: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact-upsert.service.js');
    upsertContactByEmail = mod.upsertContactByEmail;
  });

  it('returns created=true when no matching row exists', async () => {
    // Pre-check: empty.
    mockSelect.mockReturnValueOnce(chainable([]));
    // Insert path is raw SQL, not the Drizzle builder: the service issues
    // db.execute(`INSERT ... ON CONFLICT ... RETURNING *, (xmax = 0) AS
    // created`) and reads the result as a flat row array, destructuring
    // `created` off the contact columns. So the mock resolves db.execute() to
    // [{ ...contactColumns, created: true }] — NOT db.insert(), and NOT a
    // nested { contact, created } shape.
    mockExecute.mockResolvedValueOnce([{ ...makeContact(), created: true }]);

    const result = await upsertContactByEmail(
      { email: 'ada@example.com', first_name: 'Ada' },
      ORG_ID,
      USER_ID,
    );

    expect(result.created).toBe(true);
    expect(result.data.email).toBe('ada@example.com');
    expect(result.idempotency_key).toBe('email:ada@example.com');
  });
});

describe('upsertContactByEmail — update path', () => {
  let upsertContactByEmail: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact-upsert.service.js');
    upsertContactByEmail = mod.upsertContactByEmail;
  });

  it('returns created=false when a live row already exists', async () => {
    const existing = makeContact({ title: 'Old Title' });
    mockSelect.mockReturnValueOnce(chainable([existing]));
    mockUpdate.mockReturnValueOnce(
      chainable([{ ...existing, title: 'CTO' }]),
    );

    const result = await upsertContactByEmail(
      { email: 'ada@example.com', title: 'CTO' },
      ORG_ID,
      USER_ID,
    );

    expect(result.created).toBe(false);
    expect(result.data.title).toBe('CTO');
    expect(result.idempotency_key).toBe('email:ada@example.com');
  });

  it('case-insensitively matches email casing variations', async () => {
    const existing = makeContact({ email: 'ada@example.com' });
    mockSelect.mockReturnValueOnce(chainable([existing]));
    mockUpdate.mockReturnValueOnce(
      chainable([{ ...existing, email: 'Ada@EXAMPLE.com' }]),
    );

    const result = await upsertContactByEmail(
      { email: 'Ada@EXAMPLE.com' },
      ORG_ID,
      USER_ID,
    );

    expect(result.created).toBe(false);
    // Idempotency key is always lowercased so retries of the same webhook
    // from different case-variations collate in log aggregators.
    expect(result.idempotency_key).toBe('email:ada@example.com');
  });
});

describe('upsertContactByEmail — soft-delete resurrection', () => {
  let upsertContactByEmail: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact-upsert.service.js');
    upsertContactByEmail = mod.upsertContactByEmail;
  });

  it('resurrects a soft-deleted row and returns created=false', async () => {
    const softDeleted = makeContact({ deleted_at: new Date('2026-03-01') });
    mockSelect.mockReturnValueOnce(chainable([softDeleted]));
    // After update, deleted_at is cleared.
    mockUpdate.mockReturnValueOnce(
      chainable([{ ...softDeleted, deleted_at: null, title: 'Revived' }]),
    );

    const result = await upsertContactByEmail(
      { email: 'ada@example.com', title: 'Revived' },
      ORG_ID,
      USER_ID,
    );

    // Even though the row was soft-deleted, the caller sees it as an
    // update (created=false). This matches the semantic intent: the row
    // existed and is being replaced.
    expect(result.created).toBe(false);
    expect(result.data.deleted_at).toBeNull();
  });
});
