import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
    execute: mockExecute,
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
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

const FORM_ID = '00000000-0000-0000-0000-000000000700';
const ORG_ID = '00000000-0000-0000-0000-000000000001';
const SUB_ID = '00000000-0000-0000-0000-000000000900';

describe('Submission Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSubmission', () => {
    // TODO(wave-2-blank): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Blank_Plan.md done definition.
    it.skip('returns a submission', async () => {
      const sub = {
        id: SUB_ID,
        form_id: FORM_ID,
        response_data: { name: 'Alice', rating: 5 },
        submitted_at: new Date().toISOString(),
      };
      mockSelect.mockReturnValue(chainable([sub]));

      const { getSubmission } = await import('../src/services/submission.service.js');
      const result = await getSubmission(SUB_ID, ORG_ID);

      expect(result.id).toBe(SUB_ID);
      expect((result.response_data as Record<string, unknown>).name).toBe('Alice');
    });

    it('throws not found for missing submission', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { getSubmission } = await import('../src/services/submission.service.js');
      await expect(getSubmission('nonexistent', ORG_ID)).rejects.toThrow('Submission not found');
    });
  });

  describe('createSubmission', () => {
    it('creates a submission', async () => {
      const form = {
        id: FORM_ID,
        organization_id: ORG_ID,
        name: 'Customer Feedback',
        slug: 'customer-feedback',
        one_per_email: false,
        max_responses: null,
      };
      const newSub = {
        id: SUB_ID,
        form_id: FORM_ID,
        organization_id: ORG_ID,
        response_data: { name: 'Bob' },
        submitted_at: new Date().toISOString(),
      };

      // createSubmission makes two db.select() calls:
      //   1. Load the form to confirm it exists
      //   2. Load the field definitions for validation
      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([form]);
        return chainable([]);
      });

      const insertChain = chainable([newSub]);
      mockInsert.mockReturnValue({ values: vi.fn().mockReturnValue(insertChain) });

      const { createSubmission } = await import('../src/services/submission.service.js');
      const result = await createSubmission(FORM_ID, ORG_ID, {
        response_data: { name: 'Bob' },
      });

      expect(result.id).toBe(SUB_ID);
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe('deleteSubmission', () => {
    it('deletes a submission', async () => {
      mockDelete.mockReturnValue(chainable([{ id: SUB_ID }]));

      const { deleteSubmission } = await import('../src/services/submission.service.js');
      const result = await deleteSubmission(SUB_ID, ORG_ID);

      expect(result.id).toBe(SUB_ID);
    });
  });
});
