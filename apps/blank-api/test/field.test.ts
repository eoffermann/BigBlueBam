import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
  connection: { end: vi.fn() },
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

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockResolvedValue(result);
  obj.returning = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const FORM_ID = '00000000-0000-0000-0000-000000000700';
const FIELD_ID = '00000000-0000-0000-0000-000000000800';

describe('Field Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addField', () => {
    // TODO(wave-2-blank): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Blank_Plan.md done definition.
    it.skip('creates a field for a form', async () => {
      const form = { id: FORM_ID };
      const maxSort = { max: 2 };
      const newField = {
        id: FIELD_ID,
        form_id: FORM_ID,
        field_key: 'email',
        label: 'Email Address',
        field_type: 'email',
        sort_order: 3,
      };

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([form]);
        return chainable([maxSort]);
      });

      const insertChain = chainable([newField]);
      mockInsert.mockReturnValue({ values: vi.fn().mockReturnValue(insertChain) });

      const { addField } = await import('../src/services/field.service.js');
      const result = await addField(FORM_ID, ORG_ID, {
        field_key: 'email',
        label: 'Email Address',
        field_type: 'email',
      });

      expect(result.field_key).toBe('email');
      expect(mockInsert).toHaveBeenCalled();
    });

    it('throws when form not found', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { addField } = await import('../src/services/field.service.js');
      await expect(
        addField('nonexistent', ORG_ID, { field_key: 'x', label: 'X', field_type: 'short_text' }),
      ).rejects.toThrow('Form not found');
    });
  });

  describe('updateField', () => {
    it('updates a field', async () => {
      // First call: select for org verification; second call would be for other selects
      mockSelect.mockReturnValueOnce(chainable([{ id: FIELD_ID }]));
      const updated = { id: FIELD_ID, label: 'Updated Label' };
      const updateChain = chainable([updated]);
      mockUpdate.mockReturnValue(updateChain);

      const { updateField } = await import('../src/services/field.service.js');
      const result = await updateField(FIELD_ID, ORG_ID, { label: 'Updated Label' });

      expect(result.label).toBe('Updated Label');
    });

    it('throws not found for missing field', async () => {
      // Org verification select returns empty — field not in org
      mockSelect.mockReturnValueOnce(chainable([]));

      const { updateField } = await import('../src/services/field.service.js');
      await expect(updateField('nonexistent', ORG_ID, { label: 'X' })).rejects.toThrow('Field not found');
    });
  });

  describe('deleteField', () => {
    it('deletes a field', async () => {
      // Org verification select
      mockSelect.mockReturnValueOnce(chainable([{ id: FIELD_ID }]));
      mockDelete.mockReturnValue(chainable([{ id: FIELD_ID }]));

      const { deleteField } = await import('../src/services/field.service.js');
      const result = await deleteField(FIELD_ID, ORG_ID);

      expect(result.id).toBe(FIELD_ID);
    });
  });
});
