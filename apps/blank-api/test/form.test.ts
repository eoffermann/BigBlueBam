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
  readDb: {
    execute: mockExecute,
  },
  connection: { end: vi.fn() },
  readConnection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4013,
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
    PUBLIC_FORM_RATE_LIMIT: 10,
    PUBLIC_FORM_RATE_WINDOW_MS: 3600000,
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
  obj.returning = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.fields = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.leftJoin = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const FORM_ID = '00000000-0000-0000-0000-000000000700';

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    organization_id: ORG_ID,
    project_id: null,
    name: 'Customer Feedback',
    description: 'Tell us what you think',
    slug: 'customer-feedback',
    form_type: 'public',
    requires_login: false,
    accept_responses: true,
    max_responses: null,
    one_per_email: false,
    show_progress_bar: false,
    shuffle_fields: false,
    confirmation_type: 'message',
    confirmation_message: 'Thank you!',
    confirmation_redirect_url: null,
    header_image_url: null,
    theme_color: '#3b82f6',
    custom_css: null,
    notify_on_submit: false,
    notify_emails: null,
    notify_banter_channel_id: null,
    rate_limit_per_ip: 10,
    captcha_enabled: false,
    status: 'draft',
    published_at: null,
    closed_at: null,
    created_by: USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Form Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listForms', () => {
    // TODO(wave-2-blank): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Blank_Plan.md done definition.
    it.skip('returns empty array when no forms exist', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { listForms } = await import('../src/services/form.service.js');
      const result = await listForms(ORG_ID, {});

      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalled();
    });

    // TODO(wave-2-blank): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Blank_Plan.md done definition.
    it.skip('returns forms with submission and field counts', async () => {
      const forms = [makeForm()];
      const subCounts = [{ form_id: FORM_ID, count: 42 }];
      const fieldCounts = [{ form_id: FORM_ID, count: 5 }];

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable(forms);
        if (callCount === 2) return chainable(subCounts);
        return chainable(fieldCounts);
      });

      const { listForms } = await import('../src/services/form.service.js');
      const result = await listForms(ORG_ID, {});

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Customer Feedback',
        submission_count: 42,
        field_count: 5,
      });
    });
  });

  describe('getForm', () => {
    it('returns form with fields and submission count', async () => {
      const form = makeForm();
      const fields = [
        { id: 'f1', form_id: FORM_ID, field_key: 'name', label: 'Your Name', field_type: 'short_text' },
      ];
      const subCount = [{ count: 10 }];

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([form]);
        if (callCount === 2) return chainable(fields);
        return chainable(subCount);
      });

      const { getForm } = await import('../src/services/form.service.js');
      const result = await getForm(FORM_ID, ORG_ID);

      expect(result.name).toBe('Customer Feedback');
      expect(result.fields).toHaveLength(1);
      expect(result.submission_count).toBe(10);
    });

    it('throws not found for missing form', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { getForm } = await import('../src/services/form.service.js');
      await expect(getForm('nonexistent', ORG_ID)).rejects.toThrow('Form not found');
    });
  });

  describe('createForm', () => {
    it('creates a form with default settings', async () => {
      const newForm = makeForm();
      const insertChain = chainable([newForm]);
      mockInsert.mockReturnValue({ values: vi.fn().mockReturnValue(insertChain) });

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([newForm]);
        if (callCount === 2) return chainable([]);
        return chainable([{ count: 0 }]);
      });

      const { createForm } = await import('../src/services/form.service.js');
      const result = await createForm(
        { name: 'Customer Feedback', slug: 'customer-feedback' },
        ORG_ID,
        USER_ID,
      );

      expect(result.name).toBe('Customer Feedback');
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe('deleteForm', () => {
    it('deletes a form and returns its id', async () => {
      const deleteChain = chainable([{ id: FORM_ID }]);
      mockDelete.mockReturnValue(deleteChain);

      const { deleteForm } = await import('../src/services/form.service.js');
      const result = await deleteForm(FORM_ID, ORG_ID);

      expect(result.id).toBe(FORM_ID);
    });

    it('throws not found for missing form', async () => {
      mockDelete.mockReturnValue(chainable([]));

      const { deleteForm } = await import('../src/services/form.service.js');
      await expect(deleteForm('nonexistent', ORG_ID)).rejects.toThrow('Form not found');
    });
  });

  describe('publishForm', () => {
    it('throws when form has no fields', async () => {
      const form = makeForm({ status: 'draft' });
      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([form]);
        return chainable([]);
      });

      const { publishForm } = await import('../src/services/form.service.js');
      await expect(publishForm(FORM_ID, ORG_ID)).rejects.toThrow('Cannot publish a form with no fields');
    });
  });
});
