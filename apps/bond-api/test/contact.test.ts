import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
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
    PORT: 4007,
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

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const CONTACT_ID = '00000000-0000-0000-0000-000000000100';
const CONTACT_ID_2 = '00000000-0000-0000-0000-000000000101';
const COMPANY_ID = '00000000-0000-0000-0000-000000000200';

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    organization_id: ORG_ID,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: '+1-555-0100',
    title: 'CTO',
    avatar_url: null,
    lifecycle_stage: 'lead',
    lead_source: 'website',
    lead_score: 42,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BondError
// ---------------------------------------------------------------------------

describe('BondError', () => {
  it('should create error with code, message, and status', async () => {
    const { BondError } = await import('../src/lib/utils.js');
    const error = new BondError(404, 'NOT_FOUND', 'Contact not found');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Contact not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('BondError');
  });

  it('notFound helper should return 404 BondError', async () => {
    const { notFound } = await import('../src/lib/utils.js');
    const error = notFound('Contact not found');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('badRequest helper should return 400 BondError', async () => {
    const { badRequest } = await import('../src/lib/utils.js');
    const error = badRequest('Bad data');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// listContacts
// ---------------------------------------------------------------------------

describe('listContacts', () => {
  let listContacts: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    listContacts = mod.listContacts;
  });

  it('should return paginated list with limit/offset pagination', async () => {
    const c1 = makeContact({ id: 'c-1', created_at: new Date('2026-04-01') });
    const c2 = makeContact({ id: 'c-2', created_at: new Date('2026-04-02') });

    mockSelect.mockReturnValue(chainable([c1, c2]));

    const result = await listContacts({ organization_id: ORG_ID, limit: 1 });

    // Returns data/total/limit/offset shape
    expect(result.data).toBeDefined();
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(0);
  });

  it('should filter by lifecycle_stage', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listContacts({
      organization_id: ORG_ID,
      lifecycle_stage: 'customer',
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should search with escaped ILIKE', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listContacts({
      organization_id: ORG_ID,
      search: '100%_complete',
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should cap limit to 100', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listContacts({ organization_id: ORG_ID, limit: 500 });

    expect(result.data).toEqual([]);
    expect(result.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// getContact
// ---------------------------------------------------------------------------

describe('getContact', () => {
  let getContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    getContact = mod.getContact;
  });

  it('should return contact with companies, deals, and recent activities', async () => {
    const contact = makeContact();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([contact]);
      if (selectCount === 2) return chainable([{ company_id: COMPANY_ID, name: 'Acme Corp' }]);
      if (selectCount === 3) return chainable([{ deal_id: 'deal-1', name: 'Deal' }]);
      return chainable([{ id: 'act-1', activity_type: 'email_sent' }]);
    });

    const result = await getContact(CONTACT_ID, ORG_ID);

    expect(result).toBeDefined();
    expect(result.id).toBe(CONTACT_ID);
    expect(result.companies).toHaveLength(1);
    expect(result.recent_activities).toHaveLength(1);
  });

  it('should throw NOT_FOUND when contact not found', async () => {
    const { BondError } = await import('../src/lib/utils.js');
    mockSelect.mockReturnValue(chainable([]));

    await expect(getContact('nonexistent', ORG_ID)).rejects.toThrow(BondError);
    await expect(getContact('nonexistent', ORG_ID)).rejects.toThrow('Contact not found');
  });
});

// ---------------------------------------------------------------------------
// createContact
// ---------------------------------------------------------------------------

describe('createContact', () => {
  let createContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    createContact = mod.createContact;
  });

  it('should create a contact with required fields', async () => {
    const contact = makeContact();
    mockInsert.mockReturnValue(chainable([contact]));

    const result = await createContact(
      { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      ORG_ID,
      USER_ID,
    );

    expect(result).toBeDefined();
    expect(result.first_name).toBe('Ada');
    expect(result.email).toBe('ada@example.com');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should create a contact with custom fields', async () => {
    const contact = makeContact({ custom_fields: { department: 'Engineering' } });
    mockInsert.mockReturnValue(chainable([contact]));

    const result = await createContact(
      {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        custom_fields: { department: 'Engineering' },
      },
      ORG_ID,
      USER_ID,
    );

    expect(result.custom_fields).toEqual({ department: 'Engineering' });
  });
});

// ---------------------------------------------------------------------------
// updateContact
// ---------------------------------------------------------------------------

describe('updateContact', () => {
  let updateContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    updateContact = mod.updateContact;
  });

  it('should update contact fields', async () => {
    const updated = makeContact({ first_name: 'Augusta', title: 'CEO' });

    mockUpdate.mockReturnValue(chainable([updated]));

    const result = await updateContact(
      CONTACT_ID,
      ORG_ID,
      { first_name: 'Augusta', title: 'CEO' },
    );

    expect(result.first_name).toBe('Augusta');
    expect(result.title).toBe('CEO');
  });

  it('should throw NOT_FOUND when contact does not exist', async () => {
    mockUpdate.mockReturnValue(chainable([]));

    await expect(
      updateContact(CONTACT_ID, ORG_ID, { first_name: 'X' }),
    ).rejects.toThrow('Contact not found');
  });
});

// ---------------------------------------------------------------------------
// deleteContact
// ---------------------------------------------------------------------------

describe('deleteContact', () => {
  let deleteContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    deleteContact = mod.deleteContact;
  });

  it('should delete an existing contact', async () => {
    // deleteContact is a soft-delete: db.update(...).set({ deleted_at })
    // with .returning({ id }). Uses mockUpdate, not mockDelete.
    mockUpdate.mockReturnValue(chainable([{ id: CONTACT_ID }]));

    const result = await deleteContact(CONTACT_ID, ORG_ID);
    expect(result.id).toBe(CONTACT_ID);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when contact does not exist', async () => {
    mockUpdate.mockReturnValue(chainable([]));

    await expect(deleteContact(CONTACT_ID, ORG_ID)).rejects.toThrow('Contact not found');
  });
});

// ---------------------------------------------------------------------------
// mergeContacts
// ---------------------------------------------------------------------------

describe('mergeContacts', () => {
  let mergeContacts: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    mergeContacts = mod.mergeContacts;
  });

  it('should merge source into target contact', async () => {
    const target = makeContact({ id: CONTACT_ID });
    const source = makeContact({
      id: CONTACT_ID_2,
      phone: '+1-555-0200',
      lead_score: 10,
    });
    const merged = makeContact({ id: CONTACT_ID });

    // Sequence of db.select calls:
    //   1. target lookup
    //   2. source lookup
    //   3. sourceDealLinks (bondDealContacts)
    //   4. sourceCompanyLinks (bondContactCompanies)
    //   5+. getContact(targetId): contact, companies, deals, activities
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([target]);
      if (selectCount === 2) return chainable([source]);
      if (selectCount === 3) return chainable([]); // no deal links
      if (selectCount === 4) return chainable([]); // no company links
      if (selectCount === 5) return chainable([merged]); // getContact: contact row
      return chainable([]); // getContact: companies/deals/activities
    });

    mockInsert.mockReturnValue(chainable([]));
    mockUpdate.mockReturnValue(chainable([]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await mergeContacts(CONTACT_ID, CONTACT_ID_2, ORG_ID);

    expect(result).toBeDefined();
    expect(result.id).toBe(CONTACT_ID);
    // Source is soft-deleted via db.update(...).set({ deleted_at }),
    // not db.delete. Assert mockUpdate was called instead.
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw when merging same contact into itself', async () => {
    await expect(
      mergeContacts(CONTACT_ID, CONTACT_ID, ORG_ID),
    ).rejects.toThrow('Cannot merge a contact with itself');
  });

  it('should throw NOT_FOUND when target contact does not exist', async () => {
    // Target lookup empty, source lookup returns something
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([]); // target missing
      return chainable([makeContact({ id: CONTACT_ID_2 })]); // source exists
    });

    await expect(
      mergeContacts('nonexistent', CONTACT_ID_2, ORG_ID),
    ).rejects.toThrow('Target contact not found');
  });
});

// ---------------------------------------------------------------------------
// searchContacts
// ---------------------------------------------------------------------------

describe('searchContacts', () => {
  let searchContacts: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    searchContacts = mod.searchContacts;
  });

  it('should return contacts matching search query', async () => {
    const c1 = makeContact({ first_name: 'Ada' });
    mockSelect.mockReturnValue(chainable([c1]));

    const result = await searchContacts(ORG_ID, 'Ada');

    expect(result).toHaveLength(1);
    expect(result[0].first_name).toBe('Ada');
  });

  it('should return empty array for no matches', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await searchContacts(ORG_ID, 'zzzznonexistent');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-org contact access
// ---------------------------------------------------------------------------

describe('cross-org contact access', () => {
  let getContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    getContact = mod.getContact;
  });

  it('should throw NOT_FOUND when contact belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getContact(CONTACT_ID, ORG_ID_2)).rejects.toThrow('Contact not found');
  });
});
